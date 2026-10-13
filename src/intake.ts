/**
 * Durable intake（设计 §19.2、§8.1）：store.db 里的 work store。只存坐标（宿主、会话、transcript 路径、处理到的定位点），
 * 不存对话正文。窗口 id = sha256(host|session|from|to)，不含墙钟，重试天然幂等。
 */
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { Host } from "./l2.ts";
import type { WorkError } from "./llm.ts";

export const LEASE_TTL_MS = 10 * 60_000;
export const DAILY_MAX_CALLS = 60;
export const DAILY_MAX_TOKENS = 2_500_000;
/** 日预算里留给代码核验的部分：抽取用到 (上限 - 保留) 即停，核验可用满（§21 2026-10-12 质量修正）。 */
export const VERIFY_RESERVED_CALLS = 12;
export const VERIFY_RESERVED_TOKENS = 300_000;
export const MAX_ATTEMPTS = 4;
const BACKOFF_MIN = [1, 5, 30, 120];
const WINDOW_RETENTION_DAYS = 30;
const SESSION_RETENTION_DAYS = 90;

export type WindowState = "deferred" | "done" | "failed";

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
  error_code: WorkError | null;
  receipt: string | null;
  updated_at: string;
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
export function finishWindow(db: DatabaseSync, s: SessionRow, w: { id: string; from: string | null; to: string }, state: "done" | "failed", code: WorkError | null, receipt: Receipt | null, now: Date): void {
  db.prepare(
    `INSERT INTO capture_windows(window_id,host,session_id,from_anchor,to_anchor,state,attempts,next_at,error_code,receipt,updated_at)
     VALUES(?,?,?,?,?,?,1,NULL,?,?,?)
     ON CONFLICT(window_id) DO UPDATE SET state=excluded.state, attempts=attempts+1, next_at=NULL, error_code=excluded.error_code, receipt=excluded.receipt, updated_at=excluded.updated_at`,
  ).run(w.id, s.host, s.session_id, w.from, w.to, state, code, receipt ? JSON.stringify(receipt) : null, now.toISOString());
  const moved = db
    .prepare("UPDATE capture_sessions SET processed_anchor=?, error_code=NULL WHERE host=? AND session_id=? AND processed_anchor IS ?")
    .run(w.to, s.host, s.session_id, w.from);
  if (moved.changes !== 1) throw new Error("checkpoint 已被别的进程推进"); // 回滚整个事务，不会重复写 L1
}

/** 失败或延后。attempts 用完转 failed（终态，checkpoint 跳过这个窗口），返回是否终态。 */
export function deferWindow(db: DatabaseSync, s: SessionRow, w: { id: string; from: string | null; to: string }, code: WorkError, now: Date, countAttempt: boolean, until?: Date): boolean {
  const prev = getWindow(db, w.id);
  const attempts = (prev?.attempts ?? 0) + (countAttempt ? 1 : 0);
  if (attempts >= MAX_ATTEMPTS) return true;
  const next = until ?? new Date(now.getTime() + BACKOFF_MIN[Math.min(attempts, BACKOFF_MIN.length - 1)] * 60_000);
  db.prepare(
    `INSERT INTO capture_windows(window_id,host,session_id,from_anchor,to_anchor,state,attempts,next_at,error_code,receipt,updated_at)
     VALUES(?,?,?,?,?,'deferred',?,?,?,NULL,?)
     ON CONFLICT(window_id) DO UPDATE SET state='deferred', attempts=excluded.attempts, next_at=excluded.next_at, error_code=excluded.error_code, updated_at=excluded.updated_at`,
  ).run(w.id, s.host, s.session_id, w.from, w.to, attempts, next.toISOString(), code, now.toISOString());
  return false;
}

export function knownCandidates(db: DatabaseSync, keys: string[]): Set<string> {
  const got = new Set<string>();
  const q = db.prepare("SELECT 1 AS x FROM capture_candidates WHERE candidate_key=?");
  for (const k of keys) if (q.get(k)) got.add(k);
  return got;
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

export function budget(db: DatabaseSync, now: Date): { calls: number; tokens: number } {
  const row = db.prepare("SELECT calls,tokens FROM work_budget WHERE day=?").get(localDay(now)) as { calls: number; tokens: number } | undefined;
  return row ?? { calls: 0, tokens: 0 };
}

export function budgetLeft(db: DatabaseSync, now: Date, purpose: "extract" | "verify"): boolean {
  const b = budget(db, now);
  const calls = purpose === "extract" ? DAILY_MAX_CALLS - VERIFY_RESERVED_CALLS : DAILY_MAX_CALLS;
  const tokens = purpose === "extract" ? DAILY_MAX_TOKENS - VERIFY_RESERVED_TOKENS : DAILY_MAX_TOKENS;
  return b.calls < calls && b.tokens < tokens;
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

/** §13.4：终态窗口与久未活动的会话坐标有界保留。 */
export function prune(db: DatabaseSync, now: Date): void {
  const w = new Date(now.getTime() - WINDOW_RETENTION_DAYS * 86_400_000).toISOString();
  const s = new Date(now.getTime() - SESSION_RETENTION_DAYS * 86_400_000).toISOString();
  db.prepare("DELETE FROM capture_candidates WHERE window_id IN (SELECT window_id FROM capture_windows WHERE state IN ('done','failed') AND updated_at < ?)").run(w);
  db.prepare("DELETE FROM capture_windows WHERE state IN ('done','failed') AND updated_at < ?").run(w);
  db.prepare("DELETE FROM capture_sessions WHERE last_touch < ?").run(s);
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
  return { turns: 0, chars: 0, truncated: 0, stripped: 0, sanitizer: {}, candidates: 0, dropped: {}, evidence_dropped: {}, merged: 0, proposals: 0, attached: 0, corrections: 0, unreconciled: 0, corroborated: 0, tokens: 0 };
}

export function addReceipt(into: Receipt, r: Receipt): void {
  for (const k of ["turns", "chars", "truncated", "stripped", "candidates", "merged", "proposals", "attached", "corrections", "unreconciled", "corroborated", "tokens"] as const) into[k] += r[k] ?? 0;
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
    if (w.error_code && w.state !== "done") werr[w.error_code] = (werr[w.error_code] ?? 0) + 1;
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
      failed: wins.filter((w) => w.state === "failed").length,
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
