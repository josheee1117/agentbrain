/**
 * 重放评测的二次匹配：对 replay-eval 的结果重新判断"参考记忆在 A/B 产出里有没有同一条知识"。
 * 用法：AB_HOME=<库副本> node scripts/replay-rematch.ts <run.jsonl> <out.json> [--effort high]
 * 已有结果的窗口跳过（断点续跑）。额度/限流失败时打印 STOP 行（含恢复时间）并退出 3，已完成的窗口已逐个写盘。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Store } from "../src/store.ts";
import { parseJsonLoose } from "../src/llm.ts";
import { cliChat } from "../src/clireviewer.ts";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { effort: { type: "string", default: "high" } } });
const [runPath, outPath] = positionals;
const home = process.env.AB_HOME!;
const store = new Store(join(home, "store.db"), join(home, "index.db"));
const all = store.project().props;
const chat = cliChat({ host: "claude", model: "haiku", effort: values.effort, timeoutMs: 600_000 });
const SYSTEM = `你是评测里的匹配员。给你一组"参考记忆"（r1…）和一组"产出"（o1…）。对每条参考记忆，判断产出里有没有一条表达了同一条核心知识：同一个规则/偏好、同一个事实或设计理由、同一个坑。
算匹配：核心意思相同，哪怕措辞、详略、概括程度不同；产出比参考更泛或更细，只要下一个 agent 读了会做出同样的事，也算。
不算匹配：只是同一话题或同一模块，但讲的是另一件事。
一条产出可以对应多条参考。只输出 JSON：{"refs":{"r1":"o2 或 null"}}`;
const rows = readFileSync(runPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.window_id && !r.error);
const out: Record<string, any> = existsSync(outPath) ? JSON.parse(readFileSync(outPath, "utf8")) : {};
let usd = 0;
for (const r of rows) {
  if (out[r.window_id]) continue;
  const labelled = new Set(r.refs.map((x: any) => x.id));
  const sibs = Object.keys(r.matchA ?? r.matchB ?? {}).filter((id) => !labelled.has(id));
  const refs = [...r.refs.map((x: any) => x.id), ...sibs].map((id: string) => ({ key: id, text: all.get(id)?.text ?? "" }));
  const res: any = {};
  let invalid = false;
  for (const P of ["A", "B"]) {
    const outs = (r[`outs${P}`] ?? []) as { key: string; text: string }[];
    const m: Record<string, string | null> = Object.fromEntries(refs.map((x) => [x.key, null]));
    if (outs.length) {
      const prompt = `<参考记忆>\n${refs.map((x, i) => `r${i + 1}: ${x.text}`).join("\n")}\n</参考记忆>\n<产出>\n${outs.map((o, i) => `o${i + 1}: ${o.text}`).join("\n")}\n</产出>`;
      let c;
      try {
        c = await chat([{ role: "system", content: SYSTEM }, { role: "user", content: prompt }]);
      } catch (e) {
        const after = (e as any).retryAfterMs;
        const reset = typeof after === "number" ? `，预计 ${new Date(Date.now() + after).toISOString()} 恢复` : "";
        console.log(`STOP ${r.window_id.slice(0, 10)} ${(e as any).code ?? ""} ${(e as Error).message.slice(0, 200)}${reset}`);
        store.close();
        process.exit((e as any).code === "http_429" ? 3 : 1);
      }
      usd += c.costUsd ?? 0;
      const o = parseJsonLoose(c.message.content ?? null) as any;
      if (!o || typeof o.refs !== "object" || o.refs === null || refs.some((_, i) => !(`r${i + 1}` in o.refs))) {
        // 匹配员输出无效：不落盘这个窗口（下次续跑会重试），不能当成"全部没匹配上"
        console.log(`INVALID ${r.window_id.slice(0, 10)} ${P} 匹配员输出不完整，跳过`);
        invalid = true;
        break;
      }
      refs.forEach((x, i) => {
        const v = o?.refs?.[`r${i + 1}`];
        const mm = typeof v === "string" ? /^o(\d+)$/.exec(v.trim()) : null;
        m[x.key] = mm && outs[Number(mm[1]) - 1] ? outs[Number(mm[1]) - 1].key : null;
      });
    }
    res[`match${P}`] = m;
  }
  if (invalid) continue;
  out[r.window_id] = res;
  writeFileSync(outPath, JSON.stringify(out, null, 1));
  console.log(`${r.window_id.slice(0, 10)} done`);
}
console.log(`DONE usd=${usd.toFixed(3)}`);
store.close();
