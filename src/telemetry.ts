/** 记忆看板的统计（§11.8）：store.db 里的工作表，不进 L1、不参与投影，写失败由调用方吞掉。 */
import type { DatabaseSync } from "node:sqlite";
import { linesOf } from "./source.ts";
import { opencodeModel } from "./opencode.ts";
import type { Host } from "./l2.ts";
import type { Turn } from "./transcript.ts";

export const RETENTION_DAYS = 90;
/** 标题与条目正文的字面重合低于此值记为"标题不符"（只做提示，不丢引用）。 */
export const TITLE_MATCH_MIN = 0.3;
export const CITE_KEY = "cite";
export const CITE_INSTRUCTION = "（本轮回答若实际依据了上面某条，在回复最后单独一行写：ab-used: 简短标题 (id)，多条用；分隔。没用上就不写。）";

export type InjectPath = "recall" | "brief";
export type RecallOutcome = "hit" | "nohit" | "error";

export interface Ctx {
  host: Host | null;
  session_id: string | null;
  transcript: string | null;
  project_id: string | null;
}

export function citeEnabled(db: DatabaseSync): boolean {
  const r = db.prepare("SELECT value FROM work_meta WHERE key=?").get(CITE_KEY) as { value: string } | undefined;
  return r?.value === "on";
}

export function setCite(db: DatabaseSync, on: boolean): void {
  db.prepare("INSERT INTO work_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(CITE_KEY, on ? "on" : "off");
}

/** 指令行加在召回块之内、不计入召回的字数预算。 */
export function withCiteInstruction(block: string): string {
  const close = "\n</agentbrain-recall>";
  const i = block.lastIndexOf(close);
  return i < 0 ? block : block.slice(0, i) + "\n" + CITE_INSTRUCTION + block.slice(i);
}

export function logInjections(db: DatabaseSync, ctx: Ctx, path: InjectPath, ids: readonly string[], now: Date): void {
  const st = db.prepare("INSERT INTO inject_log(ts,host,session_id,transcript,project_id,prop_id,path) VALUES(?,?,?,?,?,?,?)");
  for (const id of ids) st.run(now.toISOString(), ctx.host, ctx.session_id, ctx.transcript, ctx.project_id, id, path);
}

export function logRecallRun(db: DatabaseSync, ctx: Ctx, outcome: RecallOutcome, nHits: number, ms: number, cite: boolean, now: Date): void {
  db.prepare("INSERT INTO recall_runs(ts,host,session_id,project_id,outcome,n_hits,ms,cite) VALUES(?,?,?,?,?,?,?,?)")
    .run(now.toISOString(), ctx.host, ctx.session_id, ctx.project_id, outcome, nHits, Math.round(ms), cite ? 1 : 0);
}

/** 召回 hook 已经输出之后调用：宿主要等 hook 进程退出，所以库被占着时宁可不记，也不按默认的 5 秒等锁。 */
export const HOOK_BUSY_TIMEOUT_MS = 30;

export function recordRecall(db: DatabaseSync, ctx: Ctx, outcome: RecallOutcome, ids: readonly string[], ms: number, cite: boolean, now: Date): void {
  db.exec(`PRAGMA busy_timeout=${HOOK_BUSY_TIMEOUT_MS}`);
  db.exec("BEGIN IMMEDIATE");
  try {
    logRecallRun(db, ctx, outcome, ids.length, ms, cite, now);
    logInjections(db, ctx, "recall", ids, now);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function prune(db: DatabaseSync, now: Date, days = RETENTION_DAYS): number {
  const cut = new Date(now.getTime() - days * 86_400_000).toISOString();
  let n = 0;
  n += Number(db.prepare("DELETE FROM inject_log WHERE ts<?").run(cut).changes);
  n += Number(db.prepare("DELETE FROM recall_runs WHERE ts<?").run(cut).changes);
  n += Number(db.prepare("DELETE FROM cite_scan WHERE scanned_at<?").run(cut).changes);
  return n;
}

export interface Citation {
  id: string;
  title: string;
}

const AB_USED = /^\s*`?\s*ab-used\s*[:：]\s*(.*?)`?\s*$/i;
const ID_IN_PARENS = /[(（]\s*([0-9a-f]{8})\s*[)）][\s。．.，,、；;！!？?]*$/i;
/** 分号总是分隔；顿号和逗号只在紧跟"(id)"时才算分隔，标题里的不切开。 */
const SEGMENT_END = /[；;]|(?<=[)）])\s*[，,、]/;

export function parseAbUsed(text: string): Citation[] {
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = AB_USED.exec(lines[i]);
    if (!m) continue;
    const out: Citation[] = [];
    for (const seg of m[1].split(SEGMENT_END)) {
      const s = seg.trim();
      const id = ID_IN_PARENS.exec(s);
      if (!id) continue;
      const cid = id[1].toLowerCase();
      if (out.some((c) => c.id === cid)) continue;
      out.push({ id: cid, title: s.slice(0, id.index).trim() });
    }
    return out;
  }
  return [];
}

/** 抽取输入里去掉 ab-used 行，免得被当成内容沉淀。 */
export function stripAbUsed(text: string): string {
  return text.split(/\r?\n/).filter((l) => !AB_USED.test(l)).join("\n").trim();
}

function bigrams(s: string): Set<string> {
  const t = s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const out = new Set<string>();
  for (let i = 0; i + 1 < t.length; i++) out.add(t.slice(i, i + 2));
  return out;
}

/** 标题里的二字组有多少出现在条目正文里（0–1）。标题为空返回 1（不算不符）。 */
export function titleOverlap(title: string, body: string): number {
  const a = bigrams(title);
  if (!a.size) return 1;
  const b = bigrams(body);
  let hit = 0;
  for (const g of a) if (b.has(g)) hit++;
  return hit / a.size;
}

function join2(p: unknown, m: unknown): string | undefined {
  return typeof m === "string" && m ? (typeof p === "string" && p ? `${p}/${m}` : m) : undefined;
}

export function modelOf(host: Host, file: string): string | null {
  if (host === "opencode") {
    try {
      return opencodeModel(file);
    } catch {
      return null;
    }
  }
  let model: string | null = null;
  let lines: any[];
  try {
    lines = linesOf(file) as any[];
  } catch {
    return null;
  }
  for (const e of lines) {
    const m =
      host === "claude" ? (e?.type === "assistant" ? e?.message?.model : undefined)
      : host === "codex" ? (e?.type === "turn_context" ? e?.payload?.model : undefined)
      : e?.type === "model_change" ? join2(e?.provider, e?.modelId) : e?.message?.role === "assistant" ? join2(e?.message?.provider, e?.message?.model) : undefined;
    if (typeof m === "string" && m && m !== "<synthetic>") model = m;
  }
  return model;
}

export interface ScanResult {
  marked_turns: number;
  cited: number;
  dropped: number;
  mismatched: number;
}

/**
 * 把 ab-used 里的 id 与本会话此前注入过的召回条目对上，标 cited；对不上的 id 丢弃（防编造），
 * 标题与正文重合低于 TITLE_MATCH_MIN 记 title_mismatch 但仍算引用。
 * 带有效引用的回复归到它之前最近的一次召回（不论命中与否）；那次是命中才把它记为已标注，
 * 所以一次召回最多算一轮，标注率不会超过 100%。
 */
export function scanSession(db: DatabaseSync, host: Host, sessionId: string, turns: readonly Turn[], textOf: (propId: string) => string | null, model: string | null, now: Date): ScanResult {
  const res: ScanResult = { marked_turns: 0, cited: 0, dropped: 0, mismatched: 0 };
  const find = db.prepare("SELECT id,prop_id FROM inject_log WHERE host=? AND session_id=? AND path='recall' AND substr(prop_id,1,8)=? AND (? IS NULL OR ts<=?) ORDER BY ts DESC, id DESC LIMIT 1");
  const mark = db.prepare("UPDATE inject_log SET cited=1, cited_at=?, cited_title=?, title_mismatch=? WHERE id=?");
  const runBefore = db.prepare("SELECT id,outcome FROM recall_runs WHERE host=? AND session_id=? AND ts<=? ORDER BY ts DESC, id DESC LIMIT 1");
  const marked = new Set<number>();
  for (const t of turns) {
    if (t.role !== "assistant") continue;
    const cites = parseAbUsed(t.reply ?? t.text);
    if (!cites.length) continue;
    let any = false;
    for (const c of cites) {
      const row = find.get(host, sessionId, c.id, t.ts ?? null, t.ts ?? null) as { id: number; prop_id: string } | undefined;
      if (!row) {
        res.dropped++;
        continue;
      }
      const body = textOf(row.prop_id) ?? "";
      const bad = c.title !== "" && titleOverlap(c.title, body) < TITLE_MATCH_MIN;
      mark.run(t.ts ?? now.toISOString(), c.title || null, bad ? 1 : 0, row.id);
      res.cited++;
      if (bad) res.mismatched++;
      any = true;
    }
    if (!any || !t.ts) continue;
    const run = runBefore.get(host, sessionId, t.ts) as { id: number; outcome: string } | undefined;
    if (run?.outcome === "hit") marked.add(run.id);
  }
  db.prepare("UPDATE recall_runs SET marked=0 WHERE host=? AND session_id=?").run(host, sessionId);
  const setMarked = db.prepare("UPDATE recall_runs SET marked=1 WHERE id=?");
  for (const id of marked) setMarked.run(id);
  res.marked_turns = marked.size;
  markFailedTurns(db, host, sessionId, turns);
  db.prepare("INSERT INTO cite_scan(host,session_id,model,scanned_at) VALUES(?,?,?,?) ON CONFLICT(host,session_id) DO UPDATE SET model=excluded.model, scanned_at=excluded.scanned_at")
    .run(host, sessionId, model, now.toISOString());
  return res;
}

export function sessionsToScan(db: DatabaseSync): { host: Host; session_id: string; transcript: string | null }[] {
  return db.prepare("SELECT host,session_id,MAX(transcript) AS transcript FROM inject_log WHERE path='recall' AND host IS NOT NULL AND session_id IS NOT NULL GROUP BY host,session_id").all() as any;
}

/**
 * 模型调用失败的回合（召回后到下一次召回前没有任何助手回复，如额度用尽）：recall_runs 与该次注入记 failed=1，
 * 看板的标注率分母和注入用量都不算它们。对话里一条带时间的助手回复都没有时判断不了，保持原样。
 */
export function markFailedTurns(db: DatabaseSync, host: Host, sessionId: string, turns: readonly Turn[]): number {
  const replies = turns.filter((t) => t.role === "assistant" && t.ts && (t.reply ?? t.text).trim()).map((t) => t.ts!);
  const timed = turns.some((t) => t.ts);
  if (!timed) return 0;
  const runs = db.prepare("SELECT id,ts,outcome FROM recall_runs WHERE host=? AND session_id=? ORDER BY ts, id").all(host, sessionId) as { id: number; ts: string; outcome: string }[];
  const setRun = db.prepare("UPDATE recall_runs SET failed=? WHERE id=?");
  const setInj = db.prepare("UPDATE inject_log SET failed=? WHERE host=? AND session_id=? AND ts=?");
  let n = 0;
  runs.forEach((r, i) => {
    if (r.outcome !== "hit") return;
    const end = runs[i + 1]?.ts;
    const t0 = Date.parse(r.ts);
    const answered = replies.some((ts) => Date.parse(ts) >= t0 && (end === undefined || Date.parse(ts) < Date.parse(end)));
    setRun.run(answered ? 0 : 1, r.id);
    setInj.run(answered ? 0 : 1, host, sessionId, r.ts);
    if (!answered) n++;
  });
  return n;
}
