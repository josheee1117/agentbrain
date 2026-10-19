/**
 * 窗口重放评测（2026-10-15 一步式 vs 两步式）：只读，不写正式库。
 * 对有标签、且原始抽取窗口还在的条目，把原窗口原样重切出来，分别跑：
 *   A 两步：现抽取器（extract.json）→ validate → Haiku 审稿（curate 的审稿提示词）
 *   B 一步：Haiku 读窗口 + 标准 + 近邻，一次给出 new / merge / 不记
 * 近邻只用"该窗口当初抽取之前就在库里、且不是同一会话"的条目（不让标签条目自己当近邻）。
 * 然后用一个匹配模型判断：标签条目（及同窗口其他原抽取条目）在 A/B 的保留结果里有没有同义的。
 * 用法：AB_HOME=<库副本> node scripts/replay-eval.ts <labels.json> <out.jsonl> [--conc 2] [--limit N] [--review-home <含 review.json 的目录>]
 * 结果逐窗口追加写 out.jsonl，可断点续跑。遇到额度用完写 QUOTA 行并退出 3。
 */
import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { Store, VEC_MIN_SIM } from "../src/store.ts";
import { cleanTranscript, isWorkerTranscript } from "../src/transcript.ts";
import { sanitize } from "../src/sanitize.ts";
import { chunk, projectContext, type WorkDeps } from "../src/work.ts";
import { buildMessages, validate, type ExtractWindow } from "../src/extract.ts";
import { loadChatConfig, chatClient, parseJsonLoose, type Chat, type ChatMessage } from "../src/llm.ts";
import { loadEmbedConfig, embed, readKey } from "../src/embed.ts";
import { loadRegistry, registryDir } from "../src/registry.ts";
import { loadReviewConfig, QuotaExhausted, type CallStat, type CandidateInput } from "../src/review.ts";
import { connectPanel, runPanel } from "../src/curate.ts";
import { cliChat } from "../src/clireviewer.ts";
import { buildOnePassMessages, parseOnePass } from "../src/onepass.ts";
import type { Proposition } from "../src/l2.ts";
import { parseMatchRefs } from "../src/evalmatch.ts";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { conc: { type: "string", default: "2" }, limit: { type: "string" }, "review-home": { type: "string" }, only: { type: "string" } } });
const [labelsPath, outPath] = positionals;
const realHome = join(homedir(), ".agentbrain");
const home = process.env.AB_HOME!;
if (!home || home === realHome) throw new Error("AB_HOME 必须指向库的副本");
const reviewHome = values["review-home"] ?? home;

const store = new Store(join(home, "store.db"), join(home, "index.db"));
const all = store.project().props;
const db = store.workDb;
const names = new Map(store.listProjects().map((p) => [p.id, p.name]));
const labels = JSON.parse(readFileSync(labelsPath, "utf8")) as { set: string; n: number; id: string; label: string; admit: boolean }[];

// ---------- 模型 ----------
const ecfg = loadChatConfig(realHome);
if ("error" in ecfg) throw new Error(ecfg.error);
const ekey = readKey(ecfg.keyService);
if (typeof ekey !== "string") throw new Error(ekey.error);
const extractChat = chatClient(ecfg, ekey, 180_000);
const emb = loadEmbedConfig(realHome);
if ("error" in emb) throw new Error(emb.error);
const embKey = readKey();
if (typeof embKey !== "string") throw new Error(embKey.error);
const embedder = Object.assign((t: string[]) => embed(t, emb, embKey), { model: emb.model });
const rcfg0 = loadReviewConfig(reviewHome);
if ("error" in rcfg0) throw new Error(rcfg0.error);
const rcfg = rcfg0;
const { panel, arbiter, missing } = connectPanel(rcfg);
if (missing.length || !arbiter) throw new Error(missing.join("；"));
const haikuMax = cliChat({ host: "claude", model: "haiku", effort: "max", timeoutMs: 900_000 });
const haikuLow = cliChat({ host: "claude", model: "haiku", effort: "low", timeoutMs: 300_000 });

class Quota extends Error {
  resetAt: string | null = null;
}
const LIMIT = /usage[ _]limit|rate.?limit|limit[ _]reached|hit your (?:\w+ )?limit|quota|too many requests|\b429\b|cooling down|overloaded_error/i;
async function call(chat: Chat, msgs: ChatMessage[], json = false): Promise<{ text: string | null; tokens: number; costUsd: number; ms: number }> {
  const waits = [30_000, 90_000, 180_000];
  for (let i = 0; ; i++) {
    const t0 = Date.now();
    try {
      const r = await chat(msgs, json ? { json: true } : undefined);
      return { text: r.message.content ?? null, tokens: r.tokens, costUsd: r.costUsd ?? 0, ms: Date.now() - t0 };
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      const limited = (e as any).code === "http_429" || LIMIT.test(msg);
      const after = (e as any).retryAfterMs;
      if (limited && typeof after === "number" && after > 10 * 60_000) {
        // 套餐额度（如 Claude weekly limit）要几小时后才恢复：不重试，整次停下并记下恢复时间
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

// ---------- 窗口 ----------
type Win = { window_id: string; host: string; session_id: string; transcript: string; from: string | null; to: string; project: string | null; project_id: string | null; refs: { id: string; set: string; n: number; label: string }[]; siblings: string[]; cutoff: number };
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
    const cutoff = Math.min(...sib.map((id) => all.get(id)!.seq));
    win = { window_id: w.window_id, host: w.host, session_id: w.session_id, transcript: s.transcript, from: w.from_anchor, to: w.to_anchor, project: s.project ?? null, project_id: p.project_id, refs: [], siblings: sib, cutoff };
    wins.set(w.window_id, win);
  }
  win.refs.push({ id: l.id, set: l.set, n: l.n, label: l.label });
}

const done = new Set<string>();
if (existsSync(outPath)) for (const line of readFileSync(outPath, "utf8").split("\n").filter(Boolean)) { const o = JSON.parse(line); if (o.window_id && !o.error) done.add(o.window_id); }
let todo = [...wins.values()].filter((w) => !done.has(w.window_id));
if (values.limit) todo = todo.slice(0, Number(values.limit));
const only = new Set((values.only ?? "A,B").split(","));
console.log(`windows=${wins.size} done=${done.size} todo=${todo.length}`);

function allowed(w: Win) {
  return (p: Proposition) => p.seq < w.cutoff && p.session_id !== w.session_id && p.state === "active";
}
function viewStore(ok: (p: Proposition) => boolean): Store {
  const props = new Map([...all].filter(([, p]) => ok(p)));
  return { project: () => ({ ...store.project(), props }) } as unknown as Store;
}
function near(vec: Float32Array, w: Win, k: number): Proposition[] {
  const ok = allowed(w);
  return store.nearestByVector(vec, w.project_id, 60, VEC_MIN_SIM).filter((n) => ok(n.prop)).slice(0, k).map((n) => n.prop);
}
async function windowNeighbors(turns: { role: string; text: string }[], w: Win): Promise<Proposition[]> {
  const qs = turns.filter((t) => t.role === "user").slice(0, 8).map((t) => t.text.slice(0, 500));
  if (!qs.length) return [];
  const vecs = await embedder(qs);
  const best = new Map<string, { p: Proposition; s: number }>();
  const ok = allowed(w);
  for (const v of vecs) for (const n of store.nearestByVector(v, w.project_id, 60, VEC_MIN_SIM).filter((n) => ok(n.prop)).slice(0, 4)) {
    const prev = best.get(n.prop.id);
    if (!prev || prev.s < n.similarity) best.set(n.prop.id, { p: n.prop, s: n.similarity });
  }
  return [...best.values()].sort((a, b) => b.s - a.s).slice(0, 12).map((x) => x.p);
}

const MATCH_SYSTEM = `你是评测里的匹配员。给你一组"参考记忆"（r1…）和一组"产出"（o1…），判断每条参考记忆在产出里有没有讲同一条知识的（同一个规则/事实/坑，措辞、详略可以不同；只沾边、只是同一话题不算）。一条产出可以对应多条参考。只输出 JSON：{"refs":{"r1":"o2 或 null"}}`;
/** 匹配员输出不合法（缺键、值不是 null/存在的 oK）时记为无效（不能当成"全部没匹配上"），用 replay-rematch 重跑。 */
let matchInvalid = false;
async function match(refs: { key: string; text: string }[], outs: { key: string; text: string }[], cost: { usd: number; ms: number }): Promise<Map<string, string | null>> {
  const res = new Map<string, string | null>(refs.map((r) => [r.key, null]));
  if (!refs.length || !outs.length) return res;
  const prompt = `<参考记忆>\n${refs.map((r, i) => `r${i + 1}: ${r.text}`).join("\n")}\n</参考记忆>\n<产出>\n${outs.map((o, i) => `o${i + 1}: ${o.text}`).join("\n")}\n</产出>`;
  const r = await call(haikuLow, [{ role: "system", content: MATCH_SYSTEM }, { role: "user", content: prompt }]);
  cost.usd += r.costUsd;
  cost.ms += r.ms;
  const parsed = parseMatchRefs(parseJsonLoose(r.text), refs.length, outs.length);
  if (!parsed) matchInvalid = true; // 整窗无效，结果全记 null 但打上 match_invalid
  else refs.forEach((ref, i) => res.set(ref.key, parsed[i] === null ? null : outs[parsed[i]!].key));
  return res;
}

async function runWindow(w: Win): Promise<any> {
  const raw = cleanTranscript(w.host as any, w.transcript);
  const turns = raw.turns.map((t) => ({ ...t, text: sanitize(t.text).text }));
  const chunks = chunk(w.host as any, w.session_id, turns, w.from, true);
  if (chunks === "anchor_missing") return { window_id: w.window_id, error: "anchor_missing" };
  const c = chunks.find((x) => x.id === w.window_id) ?? chunks.find((x) => x.to === w.to);
  if (!c) return { window_id: w.window_id, error: "chunk_not_found" };
  const worker = raw.worker || isWorkerTranscript(w.transcript);
  const win: ExtractWindow = { turns: c.turns, context: c.context, ...(worker ? { worker: true } : {}) };
  const deps = { registry: loadRegistry(), registryDir: registryDir(), store: viewStore(allowed(w)) } as unknown as WorkDeps;
  const ctx = projectContext(deps, w.project, w.project_id);
  const neighbors = await windowNeighbors(c.turns, w);
  const out: any = { window_id: w.window_id, project: w.project, chars: c.chars, turns: c.turns.length, worker, neighbors: neighbors.length, refs: w.refs, sibling_count: w.siblings.length };
  const outsA: { key: string; text: string; how: string }[] = [];
  const outsB: { key: string; text: string; how: string }[] = [];

  if (only.has("A")) {
    const t0 = Date.now();
    const msgs = buildMessages(win, ctx, neighbors);
    const r = await call(extractChat, msgs, true);
    const parsed = parseJsonLoose(r.text);
    const v = parsed ? validate(parsed, win, neighbors, c.id) : { candidates: [], dropped: {}, evidenceDropped: {} };
    const A: any = { extract_ms: r.ms, extract_tokens: r.tokens, extract_raw_n: Array.isArray((parsed as any)?.candidates) ? (parsed as any).candidates.length : null, valid_n: v.candidates.length, dropped: v.dropped, cands: [] as any[] };
    if (v.candidates.length) {
      const vecs = await embedder(v.candidates.map((x) => x.text));
      const inputs: CandidateInput[] = v.candidates.map((cd, k) => {
        const idx = c.turns.findIndex((t) => t.anchor === cd.evidence[cd.evidence.length - 1]?.anchor);
        const ctxText = idx >= 0 ? c.turns.slice(Math.max(0, idx - 1), idx + 1).map((t) => `[${t.role}] ${t.text}`).join("\n").slice(-1500) : null;
        return {
          id: `A${k + 1}`, kind: cd.kind as any, scope: cd.scope, project: cd.scope === "global" ? null : w.project, text: cd.text, why: cd.why, scenario: cd.value?.scenario ?? cd.trigger, basis: cd.basis,
          context: ctxText, worker, neighbors: near(vecs[k], w, 5).map((p) => ({ id: p.id, text: sanitize(p.text).text, confirmed_by_user: p.confirmed_by === "user" })),
        };
      });
      const stats: CallStat[] = [];
      const res = await runPanel(inputs, panel, arbiter!, rcfg.batchSize, stats, 1, rcfg.mode === "primary" ? rcfg.primary : null);
      A.judge_ms = stats.reduce((n, s) => n + s.ms, 0);
      A.judge_usd = stats.reduce((n, s) => n + (s.costUsd ?? 0), 0);
      res.forEach((rr, k) => {
        const f = rr.decision.final;
        const cand = { id: inputs[k].id, text: inputs[k].text, relation: v.candidates[k].relation.type, verdict: f?.verdict ?? null, final_text: f?.text ?? null, into: f?.into ?? null, reason: f?.reason ?? null };
        A.cands.push(cand);
        if (f && f.verdict !== "discard") outsA.push({ key: cand.id, text: f.verdict === "keep" ? cand.text : (f.text ?? cand.text), how: f.verdict });
      });
    }
    A.total_ms = Date.now() - t0;
    out.A = A;
  }
  if (only.has("B")) {
    const r = await call(haikuMax, buildOnePassMessages(win, ctx, neighbors));
    const p = parseOnePass(r.text, neighbors);
    out.B = { ms: r.ms, usd: r.costUsd, tokens: r.tokens, parse_ok: !!p, invalid: p?.invalid ?? null, items: p?.items ?? [], raw: p ? undefined : (r.text ?? "").slice(0, 2000) };
    (p?.items ?? []).forEach((it, k) => outsB.push({ key: `B${k + 1}`, text: it.text, how: it.action }));
  }
  // 匹配：参考 = 标签条目 + 同窗口其他原抽取条目
  const labelled = new Set(w.refs.map((r) => r.id));
  const refs = [...w.refs.map((r) => ({ key: r.id, text: all.get(r.id)!.text })), ...w.siblings.filter((id) => !labelled.has(id)).map((id) => ({ key: id, text: all.get(id)!.text }))];
  const mcost = { usd: 0, ms: 0 };
  matchInvalid = false;
  if (only.has("A")) out.matchA = Object.fromEntries(await match(refs, outsA, mcost));
  if (only.has("B")) out.matchB = Object.fromEntries(await match(refs, outsB, mcost));
  if (matchInvalid) out.match_invalid = true; // 打分前必须用 replay-rematch 重跑这个窗口的匹配
  out.match_usd = mcost.usd;
  out.outsA = outsA;
  out.outsB = outsB;
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
      console.log(`${new Date().toTimeString().slice(0, 8)} ${w.window_id.slice(0, 10)} A=${o.outsA?.length ?? "-"} B=${o.outsB?.length ?? "-"} ${o.error ?? ""}`);
    } catch (e) {
      if (e instanceof Quota || e instanceof QuotaExhausted) {
        quota = (e as Error).message;
        appendFileSync(outPath, JSON.stringify({ QUOTA: quota, at: new Date().toISOString(), resetAt: (e as any).resetAt ?? null }) + "\n");
      } else {
        appendFileSync(outPath, JSON.stringify({ window_id: w.window_id, error: String((e as Error).stack ?? e).slice(0, 800) }) + "\n");
        console.log(`ERR ${w.window_id.slice(0, 10)} ${(e as Error).message}`);
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
