/** 记忆看板的统计（§11.8）：store.db 里的工作表，不进 L1、不参与投影，写失败由调用方吞掉。 */
import type { DatabaseSync } from "node:sqlite";
import { linesOf } from "./source.ts";
import { opencodeModel } from "./opencode.ts";
import type { Host } from "./l2.ts";
import type { Turn } from "./transcript.ts";
import { agyLocate } from "./agy.ts";

export const RETENTION_DAYS = 90;
/** 标题与条目正文的字面重合低于此值记为"标题不符"（只做提示，不丢引用）。 */
export const TITLE_MATCH_MIN = 0.3;
export const CITE_KEY = "cite";
export const CITE_INSTRUCTION = "每个最终回答末尾单独一行写「记忆：简短标题 (8位id)；…」，只列实际影响结论或做法的记忆，包括常驻偏好、brief、主动查询和前几轮所得；看过、提到或驳斥的不算。没用上写「记忆：本轮未用」。";
export const RECALL_REMINDER = "要不要查历史记忆由你判断：涉及以前的决定、陌生模块或可能踩过的坑时，先 ab search；上下文已经够了就不用查。";

export type InjectPath = "recall" | "brief" | "search" | "get";
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

export function logQuery(db: DatabaseSync, ctx: Ctx, path: "search" | "get", now: Date): void {
  db.prepare("INSERT INTO memory_queries(ts,host,session_id,transcript,project_id,path) VALUES(?,?,?,?,?,?)")
    .run(now.toISOString(), ctx.host, ctx.session_id, ctx.transcript, ctx.project_id, path);
}

export function logRecallRun(db: DatabaseSync, ctx: Ctx, outcome: RecallOutcome, nHits: number, ms: number, cite: boolean, now: Date): void {
  db.prepare("INSERT INTO recall_runs(ts,host,session_id,project_id,outcome,n_hits,ms,cite,transcript) VALUES(?,?,?,?,?,?,?,?,?)")
    .run(now.toISOString(), ctx.host, ctx.session_id, ctx.project_id, outcome, nHits, Math.round(ms), cite ? 1 : 0, ctx.transcript);
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
  n += Number(db.prepare("DELETE FROM memory_reports WHERE ts<?").run(cut).changes);
  n += Number(db.prepare("DELETE FROM memory_queries WHERE ts<?").run(cut).changes);
  return n;
}

export interface Citation {
  id: string;
  title: string;
}

const AB_USED = /^\s*`?\s*(?:ab-used|记忆)\s*[:：]\s*(.*?)`?\s*$/i;
const ID_IN_PARENS = /[(（]\s*([0-9a-f]{8})\s*[)）][\s。．.，,、；;！!？?]*$/i;
/** 分号总是分隔；顿号和逗号只在紧跟"(id)"时才算分隔，标题里的不切开。 */
const SEGMENT_END = /[；;]|(?<=[)）])\s*[，,、]/;

/** null 表示明确未用，空数组表示没有可解析的采用报告。 */
export function parseAbUsed(text: string): Citation[] | null {
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = AB_USED.exec(lines[i]);
    if (!m) continue;
    if (/^本轮未用[。.!！]?\s*$/.test(m[1])) return null;
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
      host === "agy" ? (e?.type === "PLANNER_RESPONSE" ? e?.model : undefined)
      : host === "claude" ? (e?.type === "assistant" ? e?.message?.model : undefined)
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

interface UserRound {
  user: Turn;
  before?: string;
  firstReply?: string;
  final?: Turn;
}

function userRounds(turns: readonly Turn[]): UserRound[] {
  const rounds: UserRound[] = [];
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    if (t.role === "user") rounds.push({ user: t, before: turns[i - 1]?.ts });
    const round = rounds.at(-1);
    if (round && t.role === "assistant") {
      round.firstReply ??= t.ts;
      if (t.final === true && (t.reply ?? t.text).trim()) round.final = t;
    }
  }
  return rounds;
}

/** 钩子可能先于用户消息落盘。只在相邻消息边界内匹配，失败或未完成的轮也占用自己的钩子。 */
function matchRuns(rounds: readonly UserRound[], runs: readonly { id: number; ts: string; cite: number; outcome: string }[]) {
  const matches = new Map<UserRound, (typeof runs)[number]>();
  const used = new Set<number>();
  const candidates = rounds.flatMap((round, i) => {
    if (!round.user.ts || round.user.text.trimStart().startsWith("/")) return [];
    const end = round.firstReply ?? rounds[i + 1]?.user.ts;
    return runs.filter((r) => (!round.before || r.ts > round.before) && (!end || r.ts <= end))
      .map((run) => ({ round, run, distance: Math.abs(Date.parse(run.ts) - Date.parse(round.user.ts!)) }));
  }).sort((a, b) => a.distance - b.distance);
  for (const { round, run } of candidates) {
    if (matches.has(round) || used.has(run.id)) continue;
    matches.set(round, run);
    used.add(run.id);
  }
  return matches;
}

/** 报告、引用和旧召回统计共用同一组已完成回答，重扫在一个事务中重建派生值。 */
export function scanSession(db: DatabaseSync, host: Host, sessionId: string, turns: readonly Turn[], textOf: (propId: string) => string | null, model: string | null, now: Date, preferences: readonly string[] = []): ScanResult {
  const res: ScanResult = { marked_turns: 0, cited: 0, dropped: 0, mismatched: 0 };
  const rounds = userRounds(turns);
  const runs = db.prepare("SELECT id,ts,cite,outcome FROM recall_runs WHERE host=? AND session_id=? ORDER BY ts,id").all(host, sessionId) as { id: number; ts: string; cite: number; outcome: string }[];
  const matches = matchRuns(rounds, runs);
  const find = db.prepare("SELECT id,prop_id FROM inject_log WHERE host=? AND session_id=? AND substr(prop_id,1,8)=? AND ts<=? ORDER BY ts DESC,id DESC LIMIT 1");
  const query = db.prepare("SELECT 1 FROM memory_queries WHERE host=? AND session_id=? AND ts>=? AND ts<=? UNION ALL SELECT 1 FROM inject_log WHERE host=? AND session_id=? AND path IN ('search','get') AND ts>=? AND ts<=? LIMIT 1");
  const report = db.prepare("INSERT INTO memory_reports(host,session_id,anchor,ts,cite,status,queried) VALUES(?,?,?,?,?,?,?)");
  const idRow = db.prepare("INSERT INTO memory_report_ids(host,session_id,anchor,short_id,prop_id,verified,title_mismatch) VALUES(?,?,?,?,?,?,?)");
  const mark = db.prepare("UPDATE inject_log SET cited=1,cited_at=?,cited_title=?,title_mismatch=? WHERE id=?");
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 86_400_000).toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE inject_log SET cited=0,cited_at=NULL,cited_title=NULL,title_mismatch=0 WHERE host=? AND session_id=?").run(host, sessionId);
    db.prepare("UPDATE recall_runs SET marked=0 WHERE host=? AND session_id=?").run(host, sessionId);
    db.prepare("DELETE FROM memory_reports WHERE host=? AND session_id=?").run(host, sessionId);
    for (const round of rounds) {
      const t = round.final;
      if (!t?.ts || t.ts < cutoff) continue;
      const run = matches.get(round);
      const parsed = parseAbUsed(t.reply ?? t.text);
      const status = parsed === null ? "unused" : parsed.length ? "used" : "unreported";
      const begin = run?.ts ?? round.user.ts;
      const queried = begin ? !!query.get(host, sessionId, begin, t.ts, host, sessionId, begin, t.ts) : false;
      report.run(host, sessionId, t.anchor, t.ts, run?.cite ?? 0, status, queried ? 1 : 0);
      let cited = false;
      for (const c of parsed ?? []) {
        const delivery = find.get(host, sessionId, c.id, t.ts) as { id: number; prop_id: string } | undefined;
        const pref = preferences.filter((id) => id.startsWith(c.id));
        const propId = delivery?.prop_id ?? (pref.length === 1 ? pref[0] : null);
        const bad = propId !== null && c.title !== "" && titleOverlap(c.title, textOf(propId) ?? "") < TITLE_MATCH_MIN;
        idRow.run(host, sessionId, t.anchor, c.id, propId, propId ? 1 : 0, bad ? 1 : 0);
        if (!propId) { res.dropped++; continue; }
        if (delivery) mark.run(t.ts, c.title, bad ? 1 : 0, delivery.id);
        res.cited++;
        if (bad) res.mismatched++;
        cited = true;
      }
      if (cited && run?.outcome === "hit") {
        db.prepare("UPDATE recall_runs SET marked=1 WHERE id=?").run(run.id);
        res.marked_turns++;
      }
    }
    markFailedTurns(db, host, sessionId, turns);
    db.prepare("INSERT INTO cite_scan(host,session_id,model,scanned_at) VALUES(?,?,?,?) ON CONFLICT(host,session_id) DO UPDATE SET model=excluded.model, scanned_at=excluded.scanned_at")
      .run(host, sessionId, model, now.toISOString());
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  return res;
}

// ponytail: 保留 90 天会话全量重扫，约千会话实测 12.5 秒；超出可接受耗时时跳过 transcript 未变化的会话。
export function sessionsToScan(db: DatabaseSync): { host: Host; session_id: string; transcript: string | null }[] {
  const rows = db.prepare(`SELECT host,session_id,CASE WHEN host='agy' THEN
    (SELECT c.transcript FROM capture_sessions c WHERE c.host='agy' AND c.session_id=s.session_id)
    ELSE MAX(transcript) END AS transcript FROM (
    SELECT host,session_id,transcript FROM inject_log
    UNION ALL SELECT host,session_id,transcript FROM memory_queries
    UNION ALL SELECT host,session_id,transcript FROM recall_runs
    UNION ALL SELECT host,session_id,transcript FROM capture_sessions WHERE ephemeral=0
    UNION ALL SELECT host,session_id,NULL AS transcript FROM memory_reports
  ) s WHERE host IS NOT NULL AND session_id IS NOT NULL GROUP BY host,session_id`).all() as { host: Host; session_id: string; transcript: string | null }[];
  return rows.flatMap((s) => {
    if (s.host !== "agy" || s.transcript) return [s];
    const located = agyLocate(s.session_id);
    if (located.conflict.length) {
      console.error(`agy 会话 ${s.session_id} 在多处有完整日志，引用扫描已跳过：${located.conflict.map((root) => root.root).join("，")}`);
      return [];
    }
    return located.path ? [{ ...s, transcript: located.path }] : [];
  });
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
