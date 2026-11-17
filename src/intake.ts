/**
 * Durable intake（设计 §19.2、§8.1）：store.db 里的 work store。只存坐标（宿主、会话、transcript 路径、处理到的定位点），
 * 不存对话正文。窗口 id = sha256(host|session|from|to)，不含墙钟，重试天然幂等。
 */
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { Host } from "./l2.ts";
import type { WorkError } from "./llm.ts";

export const LEASE_TTL_MS = 10 * 60_000;
export const MAX_ATTEMPTS = 4;
const BACKOFF_MIN = [1, 5, 30, 120];
/** 一次延后最多等一小时：429 的 Retry-After 会报“额度 8 天后重置”这种远超实际的等待，等太久窗口就几天不重试。 */
export const MAX_DEFER_MS = 60 * 60_000;
const WINDOW_RETENTION_DAYS = 30;
const SESSION_RETENTION_DAYS = 90;

export type WindowState = "deferred" | "done" | "failed";

/** 窗口的未完成原因：模型/资源的错误码，加上进度越过后的 superseded（不是抽取失败）。 */
export type WindowErrorCode = WorkError | "superseded" | "split";
/** 这两种 failed 不是抽取失败：superseded 是进度越过后的旧积压，split 是拆成两个小窗口重试（§12.6.6）。 */
export const NOT_A_FAILURE = "('superseded','split')";
/** 窗口用完重试次数时，多于一轮且超过这么多字就对半拆开重试，不直接跳过。 */
export const SPLIT_MIN_CHARS = 8000;

export interface SessionRow {
  host: Host;
  session_id: string;
  transcript: string | null;
  cwd: string | null;
  project: string | null;
  first_seen: string;
  last_touch: string;
  ended_at: string | null;
  ephemeral: number;
  processed_anchor: string | null;
  /** scan：hook 生效后仍靠扫描才登记（疑似漏登记）；backfill：装 hook 之前就开始的历史会话。 */
  via: "hook" | "scan" | "backfill" | "manual";
  error_code: string | null;
}

export interface WindowRow {
  window_id: string;
  host: Host;
  session_id: string;
  from_anchor: string | null;
  to_anchor: string;
  state: WindowState;
  attempts: number;
  next_at: string | null;
  error_code: WindowErrorCode | null;
  receipt: string | null;
  updated_at: string;
  /** 失败或延后的原因：HTTP 状态码加脱敏后的上游报错（§12.6.6）。完成的窗口为 null。 */
  error_detail: string | null;
}

/** 只有计数，没有正文（§13.2）。 */
export interface Receipt {
  turns: number;
  chars: number;
  truncated: number;
  stripped: number;
  sanitizer: Record<string, number>;
  candidates: number;
  /** 候选级丢弃。 */
  dropped: Record<string, number>;
  /** 证据级丢弃（候选可能仍保留）。 */
  evidence_dropped: Record<string, number>;
  /** 同窗口近重复合并掉的候选数。 */
  merged: number;
  proposals: number;
  attached: number;
  corrections: number;
  unreconciled: number;
  corroborated: number;
  /** 预检判定没有可抽取内容、未调模型的窗口数。 */
  no_signal: number;
  tokens: number;
}

export interface Registration {
  host: Host;
  session_id: string;
  transcript: string | null;
  cwd: string | null;
  ended: boolean;
  ephemeral: boolean;
  via: SessionRow["via"];
}

/** 已存在时只刷新 last_touch / transcript / ended_at，不重新解析项目（hook 的热路径要快）。 */
export function upsertSession(db: DatabaseSync, r: Registration, resolveProject: () => string | null, now: Date): "new" | "touched" {
  const ts = now.toISOString();
  // 记下第一次 hook 登记的时间（只写一次）。旧库没有这个键时，以已有 hook 行的最早登记时间为准
  if (r.via === "hook") db.prepare("INSERT OR IGNORE INTO work_meta(key,value) VALUES('first_hook_at',?)").run(firstHookAt(db) ?? ts);
  const row = db.prepare("SELECT 1 AS x FROM capture_sessions WHERE host=? AND session_id=?").get(r.host, r.session_id);
  if (row) {
    db.prepare(
      // hook 碰到了扫描登记的会话，说明 hook 在这个会话上是生效的
      "UPDATE capture_sessions SET last_touch=?, transcript=COALESCE(?,transcript), ended_at=CASE WHEN ? THEN ? ELSE ended_at END, ephemeral=MAX(ephemeral,?), via=CASE WHEN ?='hook' THEN 'hook' ELSE via END WHERE host=? AND session_id=?",
    ).run(ts, r.transcript, r.ended ? 1 : 0, ts, r.ephemeral ? 1 : 0, r.via, r.host, r.session_id);
    return "touched";
  }
  db.prepare(
    "INSERT OR IGNORE INTO capture_sessions(host,session_id,transcript,cwd,project,first_seen,last_touch,ended_at,ephemeral,processed_anchor,via) VALUES(?,?,?,?,?,?,?,?,?,NULL,?)",
  ).run(r.host, r.session_id, r.transcript, r.cwd, r.ephemeral ? null : resolveProject(), ts, ts, r.ended ? ts : null, r.ephemeral ? 1 : 0, r.via);
  return "new";
}

export function sessions(db: DatabaseSync, only?: { host: Host; session_id: string }): SessionRow[] {
  if (only) return db.prepare("SELECT * FROM capture_sessions WHERE host=? AND session_id=?").all(only.host, only.session_id) as unknown as SessionRow[];
  return db.prepare("SELECT * FROM capture_sessions ORDER BY last_touch").all() as unknown as SessionRow[];
}

/** 有已到期延后窗口的会话（不含 except）。 */
export function dueDeferredSessions(db: DatabaseSync, now: Date, except: { host: Host; session_id: string }): SessionRow[] {
  return db
    .prepare(
      `SELECT DISTINCT s.* FROM capture_sessions s JOIN capture_windows w ON w.host=s.host AND w.session_id=s.session_id
       WHERE w.state='deferred' AND (w.next_at IS NULL OR w.next_at <= ? OR (w.error_code='http_429' AND w.updated_at <= ?)) AND NOT (s.host=? AND s.session_id=?) ORDER BY s.last_touch`,
    )
    .all(now.toISOString(), new Date(now.getTime() - MAX_DEFER_MS).toISOString(), except.host, except.session_id) as unknown as SessionRow[];
}

/** 延后窗口现在到期了吗。429 的历史行里存过远超上限的 next_at，按延后时间封顶算，不用一次性改库。 */
export function deferDue(w: Pick<WindowRow, "next_at" | "error_code" | "updated_at">, now: Date): boolean {
  if (!w.next_at || Date.parse(w.next_at) <= now.getTime()) return true;
  return w.error_code === "http_429" && now.getTime() - Date.parse(w.updated_at) >= MAX_DEFER_MS;
}

/**
 * 宿主冷却（话题模式 429）到期了吗。新版本写入时已按 MAX_DEFER_MS 封顶，比这更远的截止时间只可能来自旧版本未封顶的写入，
 * 无须查库核对来源，按到期处理；不必为此改库。
 */
export function cooldownDue(until: string, now: Date): boolean {
  if (until <= now.toISOString()) return true;
  return Date.parse(until) > now.getTime() + MAX_DEFER_MS;
}

export function deferredWindows(db: DatabaseSync, host: Host, sessionId: string): WindowRow[] {
  return db.prepare("SELECT * FROM capture_windows WHERE host=? AND session_id=? AND state='deferred'").all(host, sessionId) as unknown as WindowRow[];
}

/** 进度已越过的延后行不会再被切出来。标 failed 留痕，不删、不推进 checkpoint：finishWindow 的 CAS 要求进度仍停在窗口 from 上，这里对不上。 */
export function failSuperseded(db: DatabaseSync, windowId: string, now: Date): void {
  db.prepare("UPDATE capture_windows SET state='failed', next_at=NULL, error_code='superseded', updated_at=? WHERE window_id=? AND state='deferred'").run(now.toISOString(), windowId);
}

export function knownSession(db: DatabaseSync, host: Host, sessionId: string): boolean {
  return !!db.prepare("SELECT 1 AS x FROM capture_sessions WHERE host=? AND session_id=?").get(host, sessionId);
}

export function setSessionError(db: DatabaseSync, s: SessionRow, code: string | null): void {
  db.prepare("UPDATE capture_sessions SET error_code=? WHERE host=? AND session_id=?").run(code, s.host, s.session_id);
}

/** 事后才认出的 ephemeral 会话（如 Codex 子 agent）：标记后不再抽取。 */
export function markEphemeral(db: DatabaseSync, s: SessionRow): void {
  db.prepare("UPDATE capture_sessions SET ephemeral=1 WHERE host=? AND session_id=?").run(s.host, s.session_id);
}

/** hook 登记时 transcript 还没落盘的会话，事后补上路径。 */
export function setTranscript(db: DatabaseSync, s: SessionRow, transcript: string): void {
  db.prepare("UPDATE capture_sessions SET transcript=? WHERE host=? AND session_id=? AND transcript IS NULL").run(transcript, s.host, s.session_id);
}

export function getWindow(db: DatabaseSync, id: string): WindowRow | undefined {
  return db.prepare("SELECT * FROM capture_windows WHERE window_id=?").get(id) as unknown as WindowRow | undefined;
}

/** 窗口完成：写窗口终态 + 推进 checkpoint。必须在 Store.commit 的事务里调用。 */
export function finishWindow(db: DatabaseSync, s: SessionRow, w: { id: string; from: string | null; to: string }, state: "done" | "failed", code: WorkError | null, receipt: Receipt | null, now: Date, detail: string | null = null): void {
  db.prepare(
    `INSERT INTO capture_windows(window_id,host,session_id,from_anchor,to_anchor,state,attempts,next_at,error_code,receipt,updated_at,error_detail)
     VALUES(?,?,?,?,?,?,1,NULL,?,?,?,?)
     ON CONFLICT(window_id) DO UPDATE SET state=excluded.state, attempts=attempts+1, next_at=NULL, error_code=excluded.error_code, receipt=excluded.receipt, updated_at=excluded.updated_at, error_detail=excluded.error_detail`,
  ).run(w.id, s.host, s.session_id, w.from, w.to, state, code, receipt ? JSON.stringify(receipt) : null, now.toISOString(), state === "done" ? null : detail);
  const moved = db
    .prepare("UPDATE capture_sessions SET processed_anchor=?, error_code=NULL WHERE host=? AND session_id=? AND processed_anchor IS ?")
    .run(w.to, s.host, s.session_id, w.from);
  if (moved.changes !== 1) throw new Error("checkpoint 已被别的进程推进"); // 回滚整个事务，不会重复写 L1
}

/** 把处理进度从 from 换成 to（只在进度仍是 from 时换；别的进程推进过就不动）。用于旧锚点在新版转录里被跳过的情形。 */
export function remapCheckpoint(db: DatabaseSync, s: SessionRow, from: string, to: string | null): boolean {
  return db.prepare("UPDATE capture_sessions SET processed_anchor=? WHERE host=? AND session_id=? AND processed_anchor IS ?").run(to, s.host, s.session_id, from).changes === 1;
}

/** 失败或延后。attempts 用完转 failed（终态，checkpoint 跳过这个窗口），返回是否终态。 */
export function deferWindow(db: DatabaseSync, s: SessionRow, w: { id: string; from: string | null; to: string }, code: WorkError, now: Date, countAttempt: boolean, until?: Date, detail: string | null = null): boolean {
  const prev = getWindow(db, w.id);
  const attempts = (prev?.attempts ?? 0) + (countAttempt ? 1 : 0);
  if (attempts >= MAX_ATTEMPTS) return true;
  const next = until
    ? new Date(Math.min(until.getTime(), now.getTime() + MAX_DEFER_MS))
    : new Date(now.getTime() + BACKOFF_MIN[Math.min(attempts, BACKOFF_MIN.length - 1)] * 60_000);
  db.prepare(
    `INSERT INTO capture_windows(window_id,host,session_id,from_anchor,to_anchor,state,attempts,next_at,error_code,receipt,updated_at,error_detail)
     VALUES(?,?,?,?,?,'deferred',?,?,?,NULL,?,?)
     ON CONFLICT(window_id) DO UPDATE SET state='deferred', attempts=excluded.attempts, next_at=excluded.next_at, error_code=excluded.error_code, updated_at=excluded.updated_at, error_detail=excluded.error_detail`,
  ).run(w.id, s.host, s.session_id, w.from, w.to, attempts, next.toISOString(), code, now.toISOString(), detail);
  return false;
}

/**
 * 窗口用完重试次数后改成拆开重试（§12.6.6）：这一行记为 failed/split，进度不动；切点存在 receipt 里。
 * 之后切窗口时在 splitAt 和原终点各切一刀，得到两个新窗口，各自从 0 次开始重试。
 */
export function splitWindow(db: DatabaseSync, s: SessionRow, w: { id: string; from: string | null; to: string }, splitAt: string, detail: string | null, now: Date): void {
  db.prepare(
    `INSERT INTO capture_windows(window_id,host,session_id,from_anchor,to_anchor,state,attempts,next_at,error_code,receipt,updated_at,error_detail)
     VALUES(?,?,?,?,?,'failed',?,NULL,'split',?,?,?)
     ON CONFLICT(window_id) DO UPDATE SET state='failed', next_at=NULL, error_code='split', receipt=excluded.receipt, updated_at=excluded.updated_at, error_detail=excluded.error_detail`,
  ).run(w.id, s.host, s.session_id, w.from, w.to, MAX_ATTEMPTS, JSON.stringify({ split_at: splitAt }), now.toISOString(), detail);
}

/** 这个会话里拆过的窗口留下的切点：每个拆过的窗口给出它的中间切点和原终点。 */
export function sessionCuts(db: DatabaseSync, host: Host, sessionId: string): Set<string> {
  const rows = db.prepare("SELECT to_anchor, receipt FROM capture_windows WHERE host=? AND session_id=? AND state='failed' AND error_code='split'").all(host, sessionId) as { to_anchor: string; receipt: string | null }[];
  const cuts = new Set<string>();
  for (const r of rows) {
    cuts.add(r.to_anchor);
    try {
      const at = (JSON.parse(r.receipt ?? "{}") as { split_at?: unknown }).split_at;
      if (typeof at === "string") cuts.add(at);
    } catch {
      // 写坏的行只少一个切点
    }
  }
  return cuts;
}

export function knownCandidates(db: DatabaseSync, keys: string[]): Set<string> {
  const got = new Set<string>();
  const q = db.prepare("SELECT 1 AS x FROM capture_candidates WHERE candidate_key=?");
  for (const k of keys) if (q.get(k)) got.add(k);
  return got;
}

/**
 * 这一批里还能写入的下标：新键已记录，或没正文/方案的候选带着 main 的旧键且旧键已记录，都算已处理。
 * 抽取与一步式两条路径共用这一处判断，结果按批返回。
 */
export function freshAdmissions(db: DatabaseSync, keys: string[], legacyKeys: (string | undefined)[]): boolean[] {
  const known = knownCandidates(db, [...keys, ...legacyKeys.filter((k): k is string => !!k)]);
  return keys.map((k, i) => {
    const legacy = legacyKeys[i];
    return !known.has(k) && !(legacy !== undefined && known.has(legacy));
  });
}

export function recordCandidates(db: DatabaseSync, rows: { key: string; event_id: string; window_id: string }[]): void {
  const ins = db.prepare("INSERT INTO capture_candidates(candidate_key,event_id,window_id) VALUES(?,?,?)");
  for (const r of rows) ins.run(r.key, r.event_id, r.window_id);
}

// ---------- 单实例租约 ----------

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function acquireLease(db: DatabaseSync, now: Date): string | null {
  const holder = `${process.pid}:${randomUUID()}`;
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.prepare("SELECT holder,pid,expires_at FROM work_lease WHERE name='work'").get() as { holder: string; pid: number; expires_at: string } | undefined;
    if (row && row.expires_at > now.toISOString() && alive(row.pid)) {
      db.exec("ROLLBACK");
      return null;
    }
    if (row) bumpMeta(db, "lease_takeovers");
    db.prepare("INSERT OR REPLACE INTO work_lease(name,holder,pid,expires_at) VALUES('work',?,?,?)").run(holder, process.pid, new Date(now.getTime() + LEASE_TTL_MS).toISOString());
    db.exec("COMMIT");
    return holder;
  } catch (e) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw e;
  }
}

export function renewLease(db: DatabaseSync, holder: string, now: Date): boolean {
  return db.prepare("UPDATE work_lease SET expires_at=? WHERE name='work' AND holder=?").run(new Date(now.getTime() + LEASE_TTL_MS).toISOString(), holder).changes === 1;
}

export function releaseLease(db: DatabaseSync, holder: string): void {
  db.prepare("DELETE FROM work_lease WHERE name='work' AND holder=?").run(holder);
}

// ---------- 预算、元数据 ----------

export function localDay(now: Date): string {
  const d = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 10);
}

/** 当日用量只做记录（doctor 显示），不再拦截：用户决定不设日上限（§21 2026-10-13）。 */
export function budget(db: DatabaseSync, now: Date): { calls: number; tokens: number } {
  const row = db.prepare("SELECT calls,tokens FROM work_budget WHERE day=?").get(localDay(now)) as { calls: number; tokens: number } | undefined;
  return row ?? { calls: 0, tokens: 0 };
}

export function spend(db: DatabaseSync, now: Date, calls: number, tokens: number): void {
  db.prepare("INSERT INTO work_budget(day,calls,tokens) VALUES(?,?,?) ON CONFLICT(day) DO UPDATE SET calls=calls+excluded.calls, tokens=tokens+excluded.tokens").run(localDay(now), calls, tokens);
}

export function tomorrow(now: Date): Date {
  const d = new Date(now);
  d.setHours(24, 0, 0, 0);
  return d;
}

export function bumpMeta(db: DatabaseSync, key: string, by = 1): void {
  db.prepare("INSERT INTO work_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=CAST(CAST(value AS INTEGER)+? AS TEXT)").run(key, String(by), by);
}

export function setMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare("INSERT OR REPLACE INTO work_meta(key,value) VALUES(?,?)").run(key, value);
}

export function meta(db: DatabaseSync, key: string): string | null {
  return (db.prepare("SELECT value FROM work_meta WHERE key=?").get(key) as { value: string } | undefined)?.value ?? null;
}

export function lastVerify(db: DatabaseSync, propId: string): { head: string; outcome: string; at: string } | undefined {
  return db.prepare("SELECT head,outcome,at FROM verify_attempts WHERE prop_id=?").get(propId) as { head: string; outcome: string; at: string } | undefined;
}

export function recordVerify(db: DatabaseSync, propId: string, head: string, outcome: string, now: Date): void {
  db.prepare("INSERT OR REPLACE INTO verify_attempts(prop_id,head,outcome,at) VALUES(?,?,?,?)").run(propId, head, outcome, now.toISOString());
}

/** 召回时引文核对失败而排队的条目（见 Store.queueReverify）。 */
export function queuedReverify(db: DatabaseSync): Set<string> {
  return new Set((db.prepare("SELECT prop_id FROM verify_queue").all() as { prop_id: string }[]).map((r) => r.prop_id));
}

export function dequeueReverify(db: DatabaseSync, propId: string): void {
  db.prepare("DELETE FROM verify_queue WHERE prop_id=?").run(propId);
}

/** §13.4：终态窗口与久未活动的会话坐标有界保留。 */
export function prune(db: DatabaseSync, now: Date): void {
  const w = new Date(now.getTime() - WINDOW_RETENTION_DAYS * 86_400_000).toISOString();
  const s = new Date(now.getTime() - SESSION_RETENTION_DAYS * 86_400_000).toISOString();
  // 真正失败的窗口不跟着 30 天清掉：那段内容没抽取，记录要留到会话坐标过期（§12.6.6）。完成的、拆开的、被越过的照旧
  const old = `(state='done' OR (state='failed' AND error_code IN ${NOT_A_FAILURE})) AND updated_at < ?`;
  db.prepare(`DELETE FROM capture_candidates WHERE window_id IN (SELECT window_id FROM capture_windows WHERE ${old})`).run(w);
  db.prepare(`DELETE FROM capture_windows WHERE ${old}`).run(w);
  db.prepare("DELETE FROM capture_sessions WHERE last_touch < ?").run(s);
  const gone = "NOT EXISTS (SELECT 1 FROM capture_sessions s WHERE s.host=capture_windows.host AND s.session_id=capture_windows.session_id)";
  db.prepare(`DELETE FROM capture_candidates WHERE window_id IN (SELECT window_id FROM capture_windows WHERE state='failed' AND ${gone})`).run();
  db.prepare(`DELETE FROM capture_windows WHERE state='failed' AND ${gone}`).run();
}

export interface WindowProblem {
  host: Host;
  session_id: string;
  state: "failed" | "deferred";
  attempts: number;
  code: string | null;
  detail: string | null;
  at: string;
  next_at: string | null;
  chars: number | null;
}

/** 最近没做成的窗口（失败和延后，不含拆开的和被越过的），新的在前。ab status 和看板用。 */
export function windowProblems(db: DatabaseSync, limit: number): WindowProblem[] {
  const rows = db
    .prepare(
      `SELECT host, session_id, state, attempts, error_code AS code, error_detail AS detail, updated_at AS at, next_at, json_extract(receipt,'$.chars') AS chars
       FROM capture_windows WHERE state='deferred' OR (state='failed' AND (error_code IS NULL OR error_code NOT IN ${NOT_A_FAILURE})) ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(limit) as unknown as WindowProblem[];
  return rows.map((r) => ({ ...r }));
}

export interface IntakeStats {
  sessions: { total: number; unregistered: number; ephemeral: number; scanned: number; scannedByHost: Record<string, number>; backfill: number; errors: Record<string, number> };
  windows: { done: number; deferred: number; failed: number; errors: Record<string, number>; nextRetry: string | null };
  receipts7d: Receipt;
  budget: { calls: number; tokens: number };
  leaseTakeovers: number;
  lastRun: string | null;
  lastSuccess: string | null;
}

function emptyReceipt(): Receipt {
  return { turns: 0, chars: 0, truncated: 0, stripped: 0, sanitizer: {}, candidates: 0, dropped: {}, evidence_dropped: {}, merged: 0, proposals: 0, attached: 0, corrections: 0, unreconciled: 0, corroborated: 0, no_signal: 0, tokens: 0 };
}

export function addReceipt(into: Receipt, r: Receipt): void {
  for (const k of ["turns", "chars", "truncated", "stripped", "candidates", "merged", "proposals", "attached", "corrections", "unreconciled", "corroborated", "no_signal", "tokens"] as const) into[k] += r[k] ?? 0;
  for (const [k, n] of Object.entries(r.evidence_dropped ?? {})) into.evidence_dropped[k] = (into.evidence_dropped[k] ?? 0) + n;
  for (const [k, n] of Object.entries(r.sanitizer ?? {})) into.sanitizer[k] = (into.sanitizer[k] ?? 0) + n;
  for (const [k, n] of Object.entries(r.dropped ?? {})) into.dropped[k] = (into.dropped[k] ?? 0) + n;
}

export { emptyReceipt };

export function stats(db: DatabaseSync, now: Date): IntakeStats {
  const all = db.prepare("SELECT * FROM capture_sessions").all() as unknown as SessionRow[];
  const errors: Record<string, number> = {};
  for (const s of all) if (s.error_code) errors[s.error_code] = (errors[s.error_code] ?? 0) + 1;
  const week = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const missed = all.filter((s) => s.via === "scan" && s.project && !s.ephemeral && s.first_seen >= week);
  const wins = db.prepare("SELECT * FROM capture_windows").all() as unknown as WindowRow[];
  const werr: Record<string, number> = {};
  const r7 = emptyReceipt();
  let nextRetry: string | null = null;
  for (const w of wins) {
    // split 是拆成两个小窗口重试，内容没丢，不算未完成原因
    if (w.error_code && w.state !== "done" && w.error_code !== "split") werr[w.error_code] = (werr[w.error_code] ?? 0) + 1;
    if (w.state === "deferred" && w.next_at && (!nextRetry || w.next_at < nextRetry)) nextRetry = w.next_at;
    if (w.state === "done" && w.updated_at >= week && w.receipt) addReceipt(r7, JSON.parse(w.receipt) as Receipt);
  }
  return {
    sessions: {
      total: all.length,
      unregistered: all.filter((s) => !s.project && !s.ephemeral).length,
      ephemeral: all.filter((s) => s.ephemeral).length,
      scanned: missed.length,
      scannedByHost: missed.reduce<Record<string, number>>((m, s) => ((m[s.host] = (m[s.host] ?? 0) + 1), m), {}),
      backfill: all.filter((s) => s.via === "backfill" && s.project).length,
      errors,
    },
    windows: {
      done: wins.filter((w) => w.state === "done").length,
      deferred: wins.filter((w) => w.state === "deferred").length,
      // superseded 是进度越过后的旧积压清理，不是抽取失败；它照旧出现在 errors 里当未完成原因
      failed: wins.filter((w) => w.state === "failed" && w.error_code !== "superseded" && w.error_code !== "split").length,
      errors: werr,
      nextRetry,
    },
    receipts7d: r7,
    budget: budget(db, now),
    leaseTakeovers: Number(meta(db, "lease_takeovers") ?? 0),
    lastRun: meta(db, "last_run"),
    lastSuccess: meta(db, "last_success"),
  };
}

/** 第一次 hook 登记的时间（任一宿主）。之后开始、却只能靠扫描登记的会话才算疑似漏登记。 */
export function firstHookAt(db: DatabaseSync): string | null {
  const m = meta(db, "first_hook_at");
  if (m) return m;
  const row = db.prepare("SELECT MIN(first_seen) AS t FROM capture_sessions WHERE via='hook'").get() as { t: string | null } | undefined;
  return row?.t ?? null;
}

/** 把开始时间早于第一次 hook 登记的扫描会话改记为 backfill。只降级，不升级。 */
export function reclassifyScanned(db: DatabaseSync, startedAt: (transcript: string) => number | null): number {
  const hook = firstHookAt(db);
  const hookMs = hook ? Date.parse(hook) : null;
  const rows = db.prepare("SELECT host,session_id,transcript FROM capture_sessions WHERE via='scan'").all() as { host: string; session_id: string; transcript: string | null }[];
  let n = 0;
  for (const r of rows) {
    const t = r.transcript ? startedAt(r.transcript) : null;
    if (hookMs === null || t === null || t < hookMs) {
      db.prepare("UPDATE capture_sessions SET via='backfill' WHERE host=? AND session_id=?").run(r.host, r.session_id);
      n++;
    }
  }
  return n;
}

/** ab work --redo：从头重跑一个会话。删窗口记录、清 checkpoint；候选幂等键保留，同样的候选不会重复入库。 */
export function resetSession(db: DatabaseSync, host: Host, sessionId: string): boolean {
  const r = db.prepare("UPDATE capture_sessions SET processed_anchor=NULL, error_code=NULL WHERE host=? AND session_id=?").run(host, sessionId);
  db.prepare("DELETE FROM capture_windows WHERE host=? AND session_id=?").run(host, sessionId);
  return r.changes === 1;
}
