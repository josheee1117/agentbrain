/**
 * §8.6 验收评测：话题窗口 vs 原 48000 字窗口（只读，不写正式库）。
 * 对有标签、且原抽取窗口和转录还在的条目（eval 07 的 42 条 / 38 个窗口），同一个一步式模型（src/onepass.ts 提示词）分别读：
 *   L 原窗口：按旧切法（chunk，48000 字）把当初那个窗口原样重切出来
 *   T 话题窗口：整份会话按 §8.6 切法（topicChunks：相邻两轮间隔 ≥20 分钟断开，会话结束收尾，超长拆分）切，取和原窗口有重叠的话题窗口，产出合并
 * 再用匹配员判断每条标签条目（及同窗口其他原抽取条目）在 L / T 的产出里有没有同一条知识。
 * 近邻只用"原窗口当初抽取之前就在库里、且不是同一会话"的条目（同 replay-eval；话题窗口跨多个原窗口时取最早的截止点）。
 * 历史转录没有当时的压缩标记，所以 T 只按时间间隔和会话结束切（压缩边界不在本评测内）。
 *
 * 用法（Mac，库的副本，不碰 ~/.agentbrain）：
 *   AB_HOME=<库副本> node scripts/topic-eval.ts <labels.json> <out.jsonl> [--model pi:openai-codex/gpt-6-astra@max] [--matcher pi:openai-codex/gpt-6-astra@high] [--conc 1] [--limit N] [--only L,T]
 *   node scripts/topic-eval.ts --score <out.jsonl> <labels.json>
 * 模型写法 host:model@effort（host = claude / codex / pi）。用 claude 必须加 --allow-claude（防止误耗 Claude 额度）。
 * 结果按会话逐行追加写 out.jsonl，可断点续跑；额度用完写 QUOTA 行并退出 3。
 */
import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    conc: { type: "string", default: "1" },
    limit: { type: "string" },
    only: { type: "string", default: "L,T" },
    model: { type: "string", default: "pi:openai-codex/gpt-6-astra@max" },
    matcher: { type: "string", default: "pi:openai-codex/gpt-6-astra@high" },
    "allow-claude": { type: "boolean", default: false },
    score: { type: "boolean", default: false },
  },
});

type Label = { set: string; n: number; id: string; label: string; admit: boolean };

// ---------- 打分（不需要库，也不调模型） ----------
if (values.score) {
  const [runPath, labelsPath] = positionals;
  const lab = new Map((JSON.parse(readFileSync(labelsPath, "utf8")) as Label[]).map((l) => [l.id, l]));
  const rows = readFileSync(runPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const sess = rows.filter((r) => r.session && !r.error);
  const items: { id: string; set: string; label: string; L: boolean; T: boolean }[] = [];
  let invalid = 0;
  const cost = { L: { n: 0, outs: 0, ms: 0, calls: 0, chars: 0 }, T: { n: 0, outs: 0, ms: 0, calls: 0, chars: 0 } };
  for (const s of sess) {
    for (const w of s.windows) {
      if (w.match_invalid) { invalid++; continue; }
      if (!w.matchL || !w.matchT) continue; // 两边都跑完才计入，同一批条目
      for (const r of w.refs) items.push({ id: r.id, set: r.set, label: lab.get(r.id)!.label, L: !!w.matchL[r.id], T: !!w.matchT[r.id] });
      cost.L.n++; cost.L.outs += w.outsL.length; cost.L.ms += w.L.ms; cost.L.chars += w.L.chars; if (!w.L.no_signal) cost.L.calls++;
    }
    for (const t of s.topics ?? []) { cost.T.n++; cost.T.outs += t.items.length; cost.T.ms += t.ms; cost.T.chars += t.chars; if (!t.no_signal) cost.T.calls++; }
  }
  const model = sess[0]?.model ?? "?";
  console.log(`sessions=${sess.length} errored=${rows.filter((r) => r.error).length} labelled_items=${items.length} match_invalid_windows=${invalid} model=${model} matcher=${sess[0]?.matcher ?? "?"}`);
  const line = (name: string, key: "L" | "T", xs: typeof items) => {
    const u = xs.filter((i) => i.label === "有用"), pu = xs.filter((i) => i.label !== "没用"), x = xs.filter((i) => i.label === "没用");
    const f = (g: typeof items, want: boolean) => `${g.filter((i) => i[key] === want).length}/${g.length}`;
    const acc = xs.filter((i) => i[key] === (i.label !== "没用")).length;
    return `| ${name} | ${f(u, true)} | ${f(pu, true)} | ${f(x, false)} | ${acc}/${xs.length} |`;
  };
  for (const [scope, sel] of [["全部", () => true], ["s30", (i: any) => i.set === "s30"], ["s60", (i: any) => i.set === "s60"]] as const) {
    const xs = items.filter(sel as any);
    console.log(`\n### ${scope}\n| 窗口 | 有用留下 | 有用+部分有用留下 | 没用挡掉 | 总对 |\n|---|---|---|---|---|`);
    console.log(line("L 原 48000 字窗口", "L", xs));
    console.log(line("T 话题窗口", "T", xs));
  }
  console.log(`\n| 窗口 | 窗口数 | 模型调用次数（不含无信号跳过） | 产出条数 | 平均窗口字数 | 平均每次调用耗时（s） |\n|---|---|---|---|---|---|`);
  for (const k of ["L", "T"] as const) console.log(`| ${k} | ${cost[k].n} | ${cost[k].calls} | ${cost[k].outs} | ${Math.round(cost[k].chars / Math.max(1, cost[k].n))} | ${(cost[k].ms / Math.max(1, cost[k].calls) / 1000).toFixed(0)} |`);
  console.log("\n分歧（L 和 T 结论不同的条目）：");
  for (const i of items.filter((i) => i.L !== i.T)) console.log(`  ${i.set} ${i.id.slice(0, 8)} ${i.label} L=${i.L ? "留" : "挡"} T=${i.T ? "留" : "挡"}`);
  process.exit(0);
}

const { Store, VEC_MIN_SIM } = await import("../src/store.ts");
const { cleanTranscript, isWorkerTranscript } = await import("../src/transcript.ts");
const { sanitize } = await import("../src/sanitize.ts");
const { chunk, projectContext } = await import("../src/work.ts");
const { hasExtractableSignal } = await import("../src/extract.ts");
const { parseJsonLoose } = await import("../src/llm.ts");
const { loadEmbedConfig, embed, readKey } = await import("../src/embed.ts");
const { loadRegistry, registryDir } = await import("../src/registry.ts");
const { cliChat, CLI_HOSTS } = await import("../src/clireviewer.ts");
const { buildOnePassMessages, parseOnePass } = await import("../src/onepass.ts");
const { topicChunks, PROMPT_VERSION } = await import("../src/topic.ts");
const { parseMatchRefs } = await import("../src/evalmatch.ts");
type Proposition = import("../src/l2.ts").Proposition;
type Turn = import("../src/transcript.ts").Turn;
type Chat = import("../src/llm.ts").Chat;
type ChatMessage = import("../src/llm.ts").ChatMessage;

const [labelsPath, outPath] = positionals;
const realHome = join(homedir(), ".agentbrain");
const home = process.env.AB_HOME!;
if (!home || home === realHome) throw new Error("AB_HOME 必须指向库的副本");

function spec(s: string, timeoutMs: number) {
  const m = /^(\w+):(.+?)(?:@(\w+))?$/.exec(s);
  if (!m || !(CLI_HOSTS as readonly string[]).includes(m[1])) throw new Error(`模型写法应为 host:model@effort，收到 ${s}`);
  if (m[1] === "claude" && !values["allow-claude"]) throw new Error("用 claude 要加 --allow-claude（会耗 Claude 额度）");
  return { host: m[1] as "claude" | "codex" | "pi", model: m[2], effort: m[3], timeoutMs };
}
const modelSpec = spec(values.model!, 900_000);
const matcherSpec = spec(values.matcher!, 600_000);
const modelChat = cliChat(modelSpec);
const matcherChat = cliChat(matcherSpec);

const store = new Store(join(home, "store.db"), join(home, "index.db"));
const all = store.project().props;
const db = store.workDb;
const labels = JSON.parse(readFileSync(labelsPath, "utf8")) as Label[];
const emb = loadEmbedConfig(realHome);
if ("error" in emb) throw new Error(emb.error);
const embKey = readKey();
if (typeof embKey !== "string") throw new Error(embKey.error);
const embedder = (t: string[]) => embed(t, emb, embKey);

class Quota extends Error {
  resetAt: string | null = null;
}
const LIMIT = /usage[ _]limit|rate.?limit|limit[ _]reached|hit your (?:\w+ )?limit|quota|too many requests|\b429\b|cooling down/i;
async function call(chat: Chat, msgs: ChatMessage[], json = false): Promise<{ text: string | null; tokens: number; ms: number }> {
  const waits = [30_000, 90_000, 180_000];
  for (let i = 0; ; i++) {
    const t0 = Date.now();
    try {
      const r = await chat(msgs, json ? { json: true } : undefined);
      return { text: r.message.content ?? null, tokens: r.tokens, ms: Date.now() - t0 };
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      const limited = (e as any).code === "http_429" || LIMIT.test(msg);
      const after = (e as any).retryAfterMs;
      if (limited && typeof after === "number" && after > 10 * 60_000) {
        const q = new Quota(msg);
        q.resetAt = new Date(Date.now() + after).toISOString();
        throw q;
      }
      if (i >= waits.length || !limited) {
        if (limited) throw new Quota(msg);
        if (i >= 1) throw e;
      }
      await new Promise((r) => setTimeout(r, waits[Math.min(i, waits.length - 1)]));
    }
  }
}

// ---------- 原窗口（与 replay-eval 同一套找法） ----------
type Win = { window_id: string; from: string | null; to: string; refs: { id: string; set: string; n: number; label: string }[]; siblings: string[]; cutoff: number };
type Sess = { key: string; host: string; session_id: string; transcript: string; project: string | null; project_id: string | null; wins: Map<string, Win> };
const sessions = new Map<string, Sess>();
for (const l of labels) {
  const p = all.get(l.id);
  if (!p || p.origin !== "extract") continue;
  const cc = db.prepare("SELECT window_id FROM capture_candidates WHERE event_id=?").get(l.id) as any;
  const w = cc && (db.prepare("SELECT * FROM capture_windows WHERE window_id=?").get(cc.window_id) as any);
  const s = w && (db.prepare("SELECT transcript, project FROM capture_sessions WHERE host=? AND session_id=?").get(w.host, w.session_id) as any);
  if (!w || !s?.transcript || !existsSync(s.transcript)) continue;
  const key = `${w.host}|${w.session_id}`;
  let ss = sessions.get(key);
  if (!ss) sessions.set(key, (ss = { key, host: w.host, session_id: w.session_id, transcript: s.transcript, project: s.project ?? null, project_id: p.project_id, wins: new Map() }));
  let win = ss.wins.get(w.window_id);
  if (!win) {
    const sib = (db.prepare("SELECT event_id FROM capture_candidates WHERE window_id=?").all(w.window_id) as any[]).map((r) => r.event_id as string).filter((id) => all.has(id));
    win = { window_id: w.window_id, from: w.from_anchor, to: w.to_anchor, refs: [], siblings: sib, cutoff: Math.min(...sib.map((id) => all.get(id)!.seq)) };
    ss.wins.set(w.window_id, win);
  }
  win.refs.push({ id: l.id, set: l.set, n: l.n, label: l.label });
}
const done = new Set<string>();
if (existsSync(outPath)) for (const line of readFileSync(outPath, "utf8").split("\n").filter(Boolean)) { const o = JSON.parse(line); if (o.session && !o.error) done.add(o.session); }
let todo = [...sessions.values()].filter((s) => !done.has(s.key));
if (values.limit) todo = todo.slice(0, Number(values.limit));
const only = new Set(values.only!.split(","));
console.log(`sessions=${sessions.size} windows=${[...sessions.values()].reduce((n, s) => n + s.wins.size, 0)} done=${done.size} todo=${todo.length} model=${values.model} matcher=${values.matcher} prompt=${PROMPT_VERSION}`);

function allowed(s: Sess, cutoff: number) {
  return (p: Proposition) => p.seq < cutoff && p.session_id !== s.session_id && p.state === "active";
}
function viewStore(ok: (p: Proposition) => boolean) {
  const props = new Map([...all].filter(([, p]) => ok(p)));
  return { project: () => ({ ...store.project(), props }) } as unknown as InstanceType<typeof Store>;
}
async function neighbors(turns: readonly Turn[], s: Sess, cutoff: number): Promise<Proposition[]> {
  const qs = turns.filter((t) => t.role === "user").slice(0, 8).map((t) => t.text.slice(0, 500));
  if (!qs.length) return [];
  const vecs = await embedder(qs);
  const ok = allowed(s, cutoff);
  const best = new Map<string, { p: Proposition; s: number }>();
  for (const v of vecs) for (const n of store.nearestByVector(v, s.project_id, 60, VEC_MIN_SIM).filter((n) => ok(n.prop)).slice(0, 4)) {
    const prev = best.get(n.prop.id);
    if (!prev || prev.s < n.similarity) best.set(n.prop.id, { p: n.prop, s: n.similarity });
  }
  return [...best.values()].sort((a, b) => b.s - a.s).slice(0, 12).map((x) => x.p);
}
async function onePass(turns: Turn[], context: Turn[], s: Sess, cutoff: number, worker: boolean) {
  if (!hasExtractableSignal(turns)) return { ms: 0, tokens: 0, no_signal: true, parse_ok: true, items: [] as any[], invalid: null };
  const deps = { registry: loadRegistry(), registryDir: registryDir(), store: viewStore(allowed(s, cutoff)) } as any;
  const nb = await neighbors(turns, s, cutoff);
  const r = await call(modelChat, buildOnePassMessages({ turns, context, ...(worker ? { worker: true } : {}) }, projectContext(deps, s.project, s.project_id), nb), true);
  const p = parseOnePass(r.text, nb);
  return { ms: r.ms, tokens: r.tokens, neighbors: nb.length, parse_ok: !!p, invalid: p?.invalid ?? null, items: p?.items ?? [], raw: p ? undefined : (r.text ?? "").slice(0, 2000) };
}

const MATCH_SYSTEM = `你是评测里的匹配员。给你一组"参考记忆"（r1…）和一组"产出"（o1…）。对每条参考记忆，判断产出里有没有一条表达了同一条核心知识：同一个规则/偏好、同一个事实或设计理由、同一个坑。
算匹配：核心意思相同，哪怕措辞、详略、概括程度不同；产出比参考更泛或更细，只要下一个 agent 读了会做出同样的事，也算。
不算匹配：只是同一话题或同一模块，但讲的是另一件事。
一条产出可以对应多条参考。只输出 JSON：{"refs":{"r1":"o2 或 null"}}`;
async function match(refs: { key: string; text: string }[], outs: { key: string; text: string }[]): Promise<Record<string, string | null> | null> {
  const res: Record<string, string | null> = Object.fromEntries(refs.map((r) => [r.key, null]));
  if (!refs.length || !outs.length) return res;
  const prompt = `<参考记忆>\n${refs.map((r, i) => `r${i + 1}: ${r.text}`).join("\n")}\n</参考记忆>\n<产出>\n${outs.map((o, i) => `o${i + 1}: ${o.text}`).join("\n")}\n</产出>`;
  const r = await call(matcherChat, [{ role: "system", content: MATCH_SYSTEM }, { role: "user", content: prompt }]);
  const parsed = parseMatchRefs(parseJsonLoose(r.text), refs.length, outs.length);
  if (!parsed) return null; // 匹配无效：不能当成"全部没匹配上"
  refs.forEach((ref, i) => (res[ref.key] = parsed[i] === null ? null : outs[parsed[i]!].key));
  return res;
}

async function runSession(s: Sess): Promise<any> {
  const raw = cleanTranscript(s.host as any, s.transcript);
  const turns = raw.turns.map((t) => ({ ...t, text: sanitize(t.text).text }));
  const worker = raw.worker || isWorkerTranscript(s.transcript);
  const idx = new Map(turns.map((t, i) => [t.anchor, i]));
  const out: any = { session: s.key, model: values.model, matcher: values.matcher, prompt_version: PROMPT_VERSION, worker, turns: turns.length, windows: [], topics: [] };
  // 话题窗口：整份会话，当作已结束
  const tc = topicChunks(s.host as any, s.session_id, turns, null, { marks: [], ended: true, idleTail: false });
  if (tc === "anchor_missing") return { session: s.key, error: "anchor_missing" };
  const span = (from: string | null, to: string): [number, number] => [from === null ? 0 : idx.get(from)! + 1, idx.get(to)!];
  const tSpans = tc.chunks.map((c) => span(c.from, c.to));
  const overlap = (a: [number, number], b: [number, number]) => a[0] <= b[1] && b[0] <= a[1];
  const wins = [...s.wins.values()].filter((w) => idx.has(w.to) && (w.from === null || idx.has(w.from)));
  const missing = [...s.wins.values()].filter((w) => !wins.includes(w)).map((w) => w.window_id);
  if (missing.length) out.anchor_missing_windows = missing;
  // 需要跑的话题窗口：和任一原窗口重叠的；近邻截止点取重叠原窗口里最早的
  const need = new Map<number, number>();
  for (const w of wins) tSpans.forEach((sp, k) => { if (overlap(sp, span(w.from, w.to))) need.set(k, Math.min(need.get(k) ?? Infinity, w.cutoff)); });
  const topicOut = new Map<number, any>();
  if (only.has("T")) for (const [k, cutoff] of [...need].sort((a, b) => a[0] - b[0])) {
    const c = tc.chunks[k];
    const r = await onePass(c.turns, c.context, s, cutoff, worker);
    const rec = { k, window_id: c.id, from: c.from, to: c.to, trigger: c.trigger, part: c.part, turns: c.turns.length, chars: c.chars, truncated: c.truncated, ...r };
    topicOut.set(k, rec);
    out.topics.push(rec);
  }
  out.topic_count = tc.chunks.length;
  // 原窗口：重切
  const legacy = chunk(s.host as any, s.session_id, turns, null, true);
  for (const w of wins) {
    const wo: any = { window_id: w.window_id, refs: w.refs };
    const labelled = new Set(w.refs.map((r) => r.id));
    const refs = [...w.refs.map((r) => ({ key: r.id, text: all.get(r.id)!.text })), ...w.siblings.filter((id) => !labelled.has(id)).map((id) => ({ key: id, text: all.get(id)!.text }))];
    let invalid = false;
    if (only.has("L")) {
      const c = legacy === "anchor_missing" ? undefined : legacy.find((x) => x.id === w.window_id) ?? legacy.find((x) => x.to === w.to);
      if (!c) wo.L_error = "chunk_not_found";
      else {
        const r = await onePass(c.turns, c.context, s, w.cutoff, worker);
        wo.L = { ...r, chars: c.chars, turns: c.turns.length };
        wo.outsL = r.items.map((it: any, i: number) => ({ key: `L${i + 1}`, text: it.text, how: it.action }));
        const m = await match(refs, wo.outsL);
        if (m) wo.matchL = m; else invalid = true;
      }
    }
    if (only.has("T")) {
      const ks = tSpans.map((sp, k) => (overlap(sp, span(w.from, w.to)) ? k : -1)).filter((k) => k >= 0);
      wo.topic_ks = ks;
      wo.outsT = ks.flatMap((k) => (topicOut.get(k)?.items ?? []).map((it: any, i: number) => ({ key: `T${k}.${i + 1}`, text: it.text, how: it.action })));
      const m = await match(refs, wo.outsT);
      if (m) wo.matchT = m; else invalid = true;
    }
    if (invalid) wo.match_invalid = true;
    out.windows.push(wo);
  }
  return out;
}

let quota: string | null = null;
let next = 0;
async function worker(): Promise<void> {
  while (!quota && next < todo.length) {
    const s = todo[next++];
    try {
      const o = await runSession(s);
      appendFileSync(outPath, JSON.stringify(o) + "\n");
      console.log(`${new Date().toTimeString().slice(0, 8)} ${s.session_id.slice(0, 10)} wins=${o.windows?.length ?? "-"} topics=${o.topics?.length ?? "-"}/${o.topic_count ?? "-"} ${o.error ?? ""}`);
    } catch (e) {
      if (e instanceof Quota) {
        quota = e.message;
        appendFileSync(outPath, JSON.stringify({ QUOTA: quota, at: new Date().toISOString(), resetAt: e.resetAt }) + "\n");
      } else {
        appendFileSync(outPath, JSON.stringify({ session: s.key, error: String((e as Error).stack ?? e).slice(0, 800) }) + "\n");
        console.log(`ERR ${s.session_id.slice(0, 10)} ${(e as Error).message}`);
      }
    }
  }
}
await Promise.all(Array.from({ length: Number(values.conc) }, worker));
store.close();
if (quota) {
  console.log(`QUOTA_EXHAUSTED ${quota}`);
  process.exit(3);
}
console.log("DONE");
