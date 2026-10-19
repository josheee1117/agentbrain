/**
 * 评测 12（召回漏检）：在 eval 07/11 同一批 38 个原窗口上做两种只读探针，不写正式库、不改产品代码。
 *   --mode judge   ：同一个一步式提示词 + 同一窗口，追加一段"评测追问"，让模型逐条说它会把每条标签条目 new / merge / skip（skip 给理由）。
 *                    用来区分漏检是"标准/提示词让它不记"还是"它也认为该记、只是没挑出来"。
 *   --mode base    ：同一批原窗口跑现提示词（不替换），给换模型后的同模型基线用（输出格式同 variant）。
 *   --mode variant ：把一步式提示词换成召回版（V1：去掉"宁缺毋滥 / 大多数会话没东西"的偏置、加按类清单、上限 5→8），原窗口重跑，
 *                    匹配员与 eval 11 相同，和 eval 11 的 astra L 结果（eval/topic-windows/runs/astra1.jsonl）直接比。
 * 用法（Mac，在含 src/topic.ts 的 agentbrain 工作区跑；AB_HOME 是库副本）：
 *   AB_REPO=<工作区> AB_HOME=<库副本> node probe.ts <labels.json> <out.jsonl> --mode judge|variant [--model pi:openai-codex/gpt-6-astra@max] [--conc 2]
 * 逐窗口追加写 out.jsonl，可断点续跑；额度用完写 QUOTA 行并退出 3。默认不用 Claude（用 claude 要加 --allow-claude）。
 */
import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    mode: { type: "string" },
    conc: { type: "string", default: "2" },
    limit: { type: "string" },
    model: { type: "string", default: "pi:openai-codex/gpt-6-astra@max" },
    matcher: { type: "string", default: "pi:openai-codex/gpt-6-astra@high" },
    "allow-claude": { type: "boolean", default: false },
    reverse: { type: "boolean", default: false },
    "done-from": { type: "string" },
  },
});
const R = process.env.AB_REPO!;
if (!R) throw new Error("AB_REPO 指向 agentbrain 工作区");
const mode = values.mode;
if (mode !== "judge" && mode !== "variant" && mode !== "base") throw new Error("--mode judge|variant|base");
const { Store, VEC_MIN_SIM } = await import(R + "/src/store.ts");
const { cleanTranscript, isWorkerTranscript } = await import(R + "/src/transcript.ts");
const { sanitize } = await import(R + "/src/sanitize.ts");
const { chunk, projectContext } = await import(R + "/src/work.ts");
const { hasExtractableSignal } = await import(R + "/src/extract.ts");
const { parseJsonLoose } = await import(R + "/src/llm.ts");
const { loadEmbedConfig, embed, readKey } = await import(R + "/src/embed.ts");
const { loadRegistry, registryDir } = await import(R + "/src/registry.ts");
const { cliChat, CLI_HOSTS } = await import(R + "/src/clireviewer.ts");
const { buildOnePassMessages, parseOnePass, ONE_PASS_SYSTEM } = await import(R + "/src/onepass.ts");
const { parseMatchRefs } = await import(R + "/src/evalmatch.ts");
const { JUDGE_RULES } = await import(R + "/src/review.ts");

// ---------- 召回版提示词 V1（只在评测里用；逐处替换，替换不到就报错，保证差异可审） ----------
function sub(s: string, from: string, to: string): string {
  if (!s.includes(from)) throw new Error(`V1 替换失败：找不到「${from.slice(0, 30)}」`);
  return s.replace(from, to);
}
const CHECKLIST = `## 先逐类过一遍（只在心里过，不输出过程）
从头到尾把会话扫一遍，下面每一类都要找，不要只挑最显眼的一两条：
1. 用户对干活方式的要求和纠正：汇报、验证、测试写法、改动范围、沟通方式。子代理会话里，派活提示中的通用干活方法照常算，只丢一次性任务限制。
2. 本项目的设计决定和理由、模块职责、跨多处的契约和对外接口约定。
3. 工具输出里的失败或意外：原因不是报错一眼能看出、换个任务还会撞上的坑（包括环境、分支、构建来源、宿主差异这类排查陷阱）。
4. 用户机器和测试环境的具体事实（怎么连、哪个端口、哪个目录、用哪个命令）。
每一类找到的都按标准过一遍：合格的都给出，不合格的不给。同一件事只给一条。

`;
const V1_MAX = 8;
let V1 = ONE_PASS_SYSTEM as string;
// §8.7 实现后（PR #54 / #59），产品提示词本身就是 V1：此时不再替换，直接用（版本号应仍是 eea066fc04d0，启动行会打印）。
// 注意：那时 --mode judge 的"基线"也变成了 V1，不再是评测 12 里的 b1067fc1e85a。
const ALREADY_V1 = V1.includes(CHECKLIST) && V1.includes(`0 到 ${V1_MAX} 条结论`) && !V1.includes("宁缺毋滥");
if (!ALREADY_V1) {
V1 = sub(V1, "你的结论会直接写进记忆库（可撤销），没有第二个审稿人，所以宁缺毋滥。", "你的结论会直接写进记忆库（可撤销，状态是未确认）。漏记和错记一样有代价：合格的记忆没记下来，下一个 agent 就会再踩一次。");
V1 = sub(V1, "对这段会话给出 0 到 5 条结论", `对这段会话给出 0 到 ${V1_MAX} 条结论`);
V1 = sub(V1, "大多数会话没有值得记的东西，这时 items 给空数组——这是正常结论，不要为了有产出硬凑。", "没有合格内容时 items 给空数组，不要为了有产出硬凑；但一段长会话里常常有好几条合格的，不要只给最显眼的一两条。");
V1 = sub(V1, "## 你的任务", CHECKLIST + "## 你的任务");
}
// --mode base：同一窗口、同一模型跑"现提示词"（V1 之前的 b1067fc1e85a，上限 5，按产品 parseOnePass 解析），作为换模型后的同模型基线。
// 产品提示词已经是 V1 时没有旧提示词可跑，直接报错（AB_REPO 要指向 §8.7 之前的工作区，如 agentbrain-topicx 4bce25c）。
if (mode === "base" && ALREADY_V1) throw new Error("--mode base 需要 §8.7 之前的提示词：AB_REPO 里 ONE_PASS_SYSTEM 已经是 V1");
const ver = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);

const JUDGE_PROBE = (refs: { text: string; why: string | null }[]) => `

<eval_probe>
这是评测追问，不是正常任务：这次不要输出 items。下面几条候选记忆（r1…）都声称来自上面这段会话。按《好记忆的标准》和上面的任务规则，逐条说你会怎么处理：
- new：会记成新记忆；
- merge：和 <existing_memories> 里某条是同一件事（into 填 m 编号）；
- skip：不记。skip 时 why_skip 选一个：not_in_session（会话里找不到依据）、already_known（confirmed_memories / repo_docs / project_profile 里已经有）、one_off（一次性、流水账或现状描述）、findable（代码或报错一眼可见）、common_knowledge（通用技术常识）、dispatch_only（只是派活提示里的一次性限制）、no_scenario（说不出常驻适用场景）、other。
${refs.map((r, i) => `r${i + 1}: ${r.text}${r.why ? `\n    背景：${r.why}` : ""}`).join("\n")}
只输出 JSON：{"refs":{"r1":{"verdict":"new|merge|skip","into":null,"why_skip":null,"reason":"一句话"}}}
</eval_probe>`;

const JUDGE_TASK = `## 你的任务（评测追问）
用户消息里先给一段已经结束的编码会话和背景，最后的 <eval_probe> 里列出几条候选记忆。逐条判断：如果你是这段会话的记忆员，你会怎么处理它。不要另外提新记忆。

${(JUDGE_RULES as string).replace(/- 格式硬要求[\s\S]*$/, "").trim()}
<context_only> 里的内容只供理解，不能当依据。<confirmed_memories> 里已经有的算 already_known。`;

const MATCH_SYSTEM = `你是评测里的匹配员。给你一组"参考记忆"（r1…）和一组"产出"（o1…）。对每条参考记忆，判断产出里有没有一条表达了同一条核心知识：同一个规则/偏好、同一个事实或设计理由、同一个坑。
算匹配：核心意思相同，哪怕措辞、详略、概括程度不同；产出比参考更泛或更细，只要下一个 agent 读了会做出同样的事，也算。
不算匹配：只是同一话题或同一模块，但讲的是另一件事。
一条产出可以对应多条参考。只输出 JSON：{"refs":{"r1":"o2 或 null"}}`; // 与 scripts/topic-eval.ts 相同

function spec(s: string, timeoutMs: number) {
  const m = /^(\w+):(.+?)(?:@(\w+))?$/.exec(s);
  if (!m || !(CLI_HOSTS as readonly string[]).includes(m[1])) throw new Error(`模型写法应为 host:model@effort，收到 ${s}`);
  if (m[1] === "claude" && !values["allow-claude"]) throw new Error("用 claude 要加 --allow-claude");
  return { host: m[1] as any, model: m[2], effort: m[3], timeoutMs };
}
const modelChat = cliChat(spec(values.model!, 900_000));
const matcherChat = cliChat(spec(values.matcher!, 600_000));

const [labelsPath, outPath] = positionals;
const home = process.env.AB_HOME!;
if (!home || home === join(homedir(), ".agentbrain")) throw new Error("AB_HOME 必须指向库的副本");
const store = new Store(join(home, "store.db"), join(home, "index.db"));
const all = store.project().props;
const db = store.workDb;
const labels = JSON.parse(readFileSync(labelsPath, "utf8")) as { set: string; n: number; id: string; label: string }[];
const emb = loadEmbedConfig(join(homedir(), ".agentbrain"));
if ("error" in emb) throw new Error(emb.error);
const embKey = readKey();
if (typeof embKey !== "string") throw new Error(embKey.error);

class Quota extends Error {}
const LIMIT = /usage[ _]limit|rate.?limit|limit[ _]reached|hit your (?:\w+ )?limit|quota|too many requests|\b429\b|cooling down/i;
async function call(chat: any, msgs: any[]): Promise<{ text: string | null; ms: number }> {
  const waits = [30_000, 90_000, 180_000];
  for (let i = 0; ; i++) {
    const t0 = Date.now();
    try {
      const r = await chat(msgs);
      return { text: r.message.content ?? null, ms: Date.now() - t0 };
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      const limited = (e as any).code === "http_429" || LIMIT.test(msg);
      if (i >= waits.length) throw limited ? new Quota(msg) : e;
      await new Promise((r) => setTimeout(r, waits[i]));
    }
  }
}

// ---------- 原窗口（与 replay-eval / topic-eval 同一套找法） ----------
type Win = { window_id: string; host: string; session_id: string; transcript: string; from: string | null; to: string; project: string | null; project_id: string | null; refs: any[]; siblings: string[]; cutoff: number };
const wins = new Map<string, Win>();
for (const l of labels) {
  const p = all.get(l.id);
  if (!p || p.origin !== "extract") continue;
  const cc = db.prepare("SELECT window_id FROM capture_candidates WHERE event_id=?").get(l.id) as any;
  const w = cc && (db.prepare("SELECT * FROM capture_windows WHERE window_id=?").get(cc.window_id) as any);
  const s = w && (db.prepare("SELECT transcript, project FROM capture_sessions WHERE host=? AND session_id=?").get(w.host, w.session_id) as any);
  if (!w || !s?.transcript || !existsSync(s.transcript)) continue;
  let win = wins.get(w.window_id);
  if (!win) {
    const sib = (db.prepare("SELECT event_id FROM capture_candidates WHERE window_id=?").all(w.window_id) as any[]).map((r) => r.event_id as string).filter((id) => all.has(id));
    win = { window_id: w.window_id, host: w.host, session_id: w.session_id, transcript: s.transcript, from: w.from_anchor, to: w.to_anchor, project: s.project ?? null, project_id: p.project_id, refs: [], siblings: sib, cutoff: Math.min(...sib.map((id) => all.get(id)!.seq)) };
    wins.set(w.window_id, win);
  }
  win.refs.push({ id: l.id, set: l.set, n: l.n, label: l.label });
}
const done = new Set<string>();
if (existsSync(outPath)) for (const line of readFileSync(outPath, "utf8").split("\n").filter(Boolean)) { const o = JSON.parse(line); if (o.window_id && !o.error) done.add(o.window_id); }
for (const f of values["done-from"] ? values["done-from"].split(",") : []) /* 可给多个文件，逗号分隔 */ if (existsSync(f)) for (const line of readFileSync(f, "utf8").split("\n").filter(Boolean)) { const o = JSON.parse(line); if (o.window_id && !o.error) done.add(o.window_id); }
let todo = [...wins.values()].filter((w) => !done.has(w.window_id));
if (values.reverse) todo.reverse(); // 第二个进程从另一头跑（输出另写一个文件，打分时按窗口去重）
if (values.limit) todo = todo.slice(0, Number(values.limit));
console.log(`mode=${mode} windows=${wins.size} done=${done.size} todo=${todo.length} model=${values.model} base_prompt=${ver(ONE_PASS_SYSTEM)} v1_prompt=${ver(V1)}`);

function allowed(w: Win) {
  return (p: any) => p.seq < w.cutoff && p.session_id !== w.session_id && p.state === "active";
}
async function neighbors(turns: any[], w: Win): Promise<any[]> {
  const qs = turns.filter((t) => t.role === "user").slice(0, 8).map((t) => t.text.slice(0, 500));
  if (!qs.length) return [];
  const vecs = await embed(qs, emb, embKey);
  const ok = allowed(w);
  const best = new Map<string, { p: any; s: number }>();
  for (const v of vecs) for (const n of store.nearestByVector(v, w.project_id, 60, VEC_MIN_SIM).filter((n: any) => ok(n.prop)).slice(0, 4)) {
    const prev = best.get(n.prop.id);
    if (!prev || prev.s < n.similarity) best.set(n.prop.id, { p: n.prop, s: n.similarity });
  }
  return [...best.values()].sort((a, b) => b.s - a.s).slice(0, 12).map((x) => x.p);
}
function parseMany(raw: string | null, nb: any[]) {
  const o = parseJsonLoose(raw) as { items?: unknown[] } | null;
  if (!o || !Array.isArray(o.items)) return null;
  const items: any[] = [];
  const invalid: Record<string, number> = {};
  for (let i = 0; i < Math.min(o.items.length, V1_MAX); i += 5) {
    const p = parseOnePass(JSON.stringify({ items: o.items.slice(i, Math.min(i + 5, V1_MAX)) }), nb)!;
    items.push(...p.items);
    for (const [k, v] of Object.entries(p.invalid)) invalid[k] = (invalid[k] ?? 0) + (v as number);
  }
  if (o.items.length > V1_MAX) invalid.too_many = o.items.length - V1_MAX;
  return { items, invalid };
}

async function runWindow(w: Win): Promise<any> {
  const raw = cleanTranscript(w.host as any, w.transcript);
  const turns = raw.turns.map((t: any) => ({ ...t, text: sanitize(t.text).text }));
  const chunks = chunk(w.host as any, w.session_id, turns, w.from, true);
  const c = chunks === "anchor_missing" ? undefined : chunks.find((x: any) => x.id === w.window_id) ?? chunks.find((x: any) => x.to === w.to);
  if (!c) return { window_id: w.window_id, error: "chunk_not_found" };
  const worker = raw.worker || isWorkerTranscript(w.transcript);
  const win = { turns: c.turns, context: c.context, ...(worker ? { worker: true } : {}) };
  const props = new Map([...all].filter(([, p]) => allowed(w)(p)));
  const deps = { registry: loadRegistry(), registryDir: registryDir(), store: { project: () => ({ ...store.project(), props }) } } as any;
  const ctx = projectContext(deps, w.project, w.project_id);
  const nb = await neighbors(c.turns, w);
  const msgs = buildOnePassMessages(win, ctx, nb);
  const out: any = { window_id: w.window_id, mode, model: values.model, refs: w.refs, chars: c.chars, turns: c.turns.length, worker, neighbors: nb.length };
  if (mode === "judge") {
    const refs = w.refs.map((r) => ({ text: all.get(r.id)!.text as string, why: (all.get(r.id)!.why as string) ?? null }));
    // 评测追问：系统提示保留一步式的开头和《好记忆的标准》全文，"## 你的任务"起换成逐条判断（判断要点同一步式，取自 review.ts JUDGE_RULES）
    const base = ONE_PASS_SYSTEM as string;
    msgs[0] = { ...msgs[0], content: base.slice(0, base.indexOf("## 你的任务")) + JUDGE_TASK };
    msgs[1] = { ...msgs[1], content: msgs[1].content + JUDGE_PROBE(refs) };
    const r = await call(modelChat, msgs);
    const o = parseJsonLoose(r.text) as any;
    out.ms = r.ms;
    out.prompt_version = ver(ONE_PASS_SYSTEM);
    out.judge = o?.refs ? Object.fromEntries(w.refs.map((ref, i) => [ref.id, o.refs[`r${i + 1}`] ?? null])) : null;
    if (!out.judge) out.raw = (r.text ?? "").slice(0, 2000);
    out.nb_labels = nb.map((p: any, i: number) => ({ m: `m${i + 1}`, id: p.id, text: String(p.text).slice(0, 200) }));
    return out;
  }
  // variant
  if (!hasExtractableSignal(c.turns)) { out.no_signal = true; out.items = []; }
  else {
    if (mode === "variant") msgs[0] = { ...msgs[0], content: V1 };
    const r = await call(modelChat, msgs);
    const p = mode === "base" ? parseOnePass(r.text, nb) : parseMany(r.text, nb);
    out.ms = r.ms; out.prompt_version = ver(mode === "base" ? ONE_PASS_SYSTEM : V1); out.parse_ok = !!p; out.invalid = p?.invalid ?? null; out.items = p?.items ?? [];
    if (!p) out.raw = (r.text ?? "").slice(0, 2000);
  }
  const labelled = new Set(w.refs.map((r) => r.id));
  const refs = [...w.refs.map((r) => ({ key: r.id, text: all.get(r.id)!.text })), ...w.siblings.filter((id) => !labelled.has(id)).map((id) => ({ key: id, text: all.get(id)!.text }))];
  out.outs = out.items.map((it: any, i: number) => ({ key: `V${i + 1}`, text: it.text, how: it.action }));
  out.match = Object.fromEntries(refs.map((r) => [r.key, null]));
  if (out.outs.length) {
    const prompt = `<参考记忆>\n${refs.map((r, i) => `r${i + 1}: ${r.text}`).join("\n")}\n</参考记忆>\n<产出>\n${out.outs.map((o: any, i: number) => `o${i + 1}: ${o.text}`).join("\n")}\n</产出>`;
    const mr = await call(matcherChat, [{ role: "system", content: MATCH_SYSTEM }, { role: "user", content: prompt }]);
    const parsed = parseMatchRefs(parseJsonLoose(mr.text), refs.length, out.outs.length);
    if (!parsed) out.match_invalid = true;
    else refs.forEach((ref, i) => (out.match[ref.key] = parsed[i] === null ? null : out.outs[parsed[i]!].key));
  }
  return out;
}

let quota: string | null = null;
let next = 0;
async function worker(): Promise<void> {
  while (!quota && next < todo.length) {
    const w = todo[next++];
    try {
      const o = await runWindow(w);
      appendFileSync(outPath, JSON.stringify(o) + "\n");
      console.log(`${new Date().toTimeString().slice(0, 8)} ${w.window_id.slice(0, 10)} ${o.error ?? (mode === "judge" ? (o.judge ? "ok" : "PARSE_FAIL") : `items=${o.items.length}${o.match_invalid ? " MATCH_INVALID" : ""}`)}`);
    } catch (e) {
      if (e instanceof Quota) {
        quota = (e as Error).message;
        appendFileSync(outPath, JSON.stringify({ QUOTA: quota.slice(0, 300), at: new Date().toISOString() }) + "\n");
      } else {
        appendFileSync(outPath, JSON.stringify({ window_id: w.window_id, error: String((e as Error).message ?? e).slice(0, 300) }) + "\n");
        console.log(`ERR ${w.window_id.slice(0, 10)} ${(e as Error).message}`);
      }
    }
  }
}
await Promise.all(Array.from({ length: Number(values.conc) }, worker));
store.close();
if (quota) { console.log(`QUOTA ${quota.slice(0, 200)}`); process.exit(3); }
console.log("DONE");
