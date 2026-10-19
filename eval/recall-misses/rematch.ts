/**
 * 评测 12：只重跑匹配员（不重抽）。probe.ts 某个窗口匹配员输出不合法（match_invalid）时，用同一份产出、同一组参考记忆、
 * 同一匹配提示词再问一次（最多 3 次），原始输出写进 raw_match 便于复核。校验仍用 parseMatchRefs；唯一的归一化是把字符串 "null" 当成 null（见下）。
 * 用法：AB_REPO=<工作区> AB_HOME=<库副本> node rematch.ts <in.jsonl> <out.jsonl> --matcher pi:cpa/deepseek-v4-pro@max
 * 输出：in 的每一行原样或修好后写到 out（match_invalid 修好的行加 rematched: 次数）。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
const { values, positionals } = parseArgs({ allowPositionals: true, options: { matcher: { type: "string" }, tries: { type: "string", default: "3" } } });
const R = process.env.AB_REPO!;
const { Store } = await import(R + "/src/store.ts");
const { parseJsonLoose } = await import(R + "/src/llm.ts");
const { cliChat, CLI_HOSTS } = await import(R + "/src/clireviewer.ts");
const { parseMatchRefs } = await import(R + "/src/evalmatch.ts");
const MATCH_SYSTEM = `你是评测里的匹配员。给你一组"参考记忆"（r1…）和一组"产出"（o1…）。对每条参考记忆，判断产出里有没有一条表达了同一条核心知识：同一个规则/偏好、同一个事实或设计理由、同一个坑。
算匹配：核心意思相同，哪怕措辞、详略、概括程度不同；产出比参考更泛或更细，只要下一个 agent 读了会做出同样的事，也算。
不算匹配：只是同一话题或同一模块，但讲的是另一件事。
一条产出可以对应多条参考。只输出 JSON：{"refs":{"r1":"o2 或 null"}}`; // 与 probe.ts / scripts/topic-eval.ts 相同
const m = /^(\w+):(.+?)(?:@(\w+))?$/.exec(values.matcher!);
if (!m || !(CLI_HOSTS as readonly string[]).includes(m[1]) || m[1] === "claude") throw new Error("--matcher host:model@effort（不用 claude）");
const chat = cliChat({ host: m[1] as any, model: m[2], effort: m[3], timeoutMs: 600_000 });
const home = process.env.AB_HOME!;
const store = new Store(join(home, "store.db"), join(home, "index.db"));
const all = store.project().props;
const [inp, outp] = positionals;
const lines = readFileSync(inp, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
for (const o of lines) {
  if (!o.match_invalid) continue;
  const keys = Object.keys(o.match);
  const refs = keys.map((k) => ({ key: k, text: all.get(k)!.text }));
  const prompt = `<参考记忆>\n${refs.map((r, i) => `r${i + 1}: ${r.text}`).join("\n")}\n</参考记忆>\n<产出>\n${o.outs.map((x: any, i: number) => `o${i + 1}: ${x.text}`).join("\n")}\n</产出>`;
  o.raw_match = [];
  for (let t = 1; t <= Number(values.tries); t++) {
    let text: string | null = null;
    try { text = (await chat([{ role: "system", content: MATCH_SYSTEM }, { role: "user", content: prompt }])).message.content ?? null; } catch (e) { text = "ERROR " + String((e as Error).message).slice(0, 200); }
    o.raw_match.push((text ?? "").slice(0, 1500));
    // 唯一的归一化：提示词示例写的是 "o2 或 null"（带引号），deepseek 偶尔照抄成字符串 "null"——含义无歧义，按 JSON null 处理；其余仍严格校验。
    const j = parseJsonLoose(text) as any;
    let nullStr = false;
    if (j?.refs && typeof j.refs === "object") for (const k of Object.keys(j.refs)) if (typeof j.refs[k] === "string" && j.refs[k].trim().toLowerCase() === "null") { j.refs[k] = null; nullStr = true; }
    const parsed = parseMatchRefs(j, refs.length, o.outs.length);
    if (parsed && nullStr) o.match_null_string = true;
    console.log(`${o.window_id.slice(0, 10)} try ${t} ${parsed ? "ok" : "INVALID"}`);
    if (parsed) { refs.forEach((ref, i) => (o.match[ref.key] = parsed[i] === null ? null : o.outs[parsed[i]!].key)); delete o.match_invalid; o.rematched = t; break; }
  }
}
writeFileSync(outp, lines.map((o) => JSON.stringify(o)).join("\n") + "\n");
store.close();
