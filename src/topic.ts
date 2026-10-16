/**
 * 话题结束时一步式沉淀（设计 §8.6，2026-10-16 用户批准；新触发默认关闭）。
 *
 * 这里放：开关、话题边界（压缩标记）、按话题切窗口、运行报告与整次撤销。
 * 处理流程（读窗口 → 一步式子模型 → 写 L1）在 work.ts 的 processTopicSession，和旧的 48000 字窗口共用
 * 会话登记、处理进度（checkpoint）、窗口队列（capture_windows）和单实例租约，所以两种模式之间不会重抽。
 *
 * 话题结束的三个触发（§8.6 第 2 点）：
 * - idle：transcript 里相邻两轮的时间差 ≥ TOPIC_IDLE_MS（20 分钟）就是话题边界；会话最后一轮之后 20 分钟没动也算。
 *   hook 只负责"该看看了"：下一轮 UserPromptSubmit 时距上次登记超过 20 分钟，拉起分离的 ab work --session（候选 B）。
 * - compact：PreCompact / session_before_compact 时记一个时间标记（work_meta，不改表结构），压缩前最后一轮是边界。
 * - session_end：会话结束，剩下的全部是一个话题。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Host } from "./l2.ts";
import type { Turn } from "./transcript.ts";
import type { Store } from "./store.ts";
import { ONE_PASS_SYSTEM, ONE_PASS_WORKER_NOTE } from "./onepass.ts";
import type { Chat, WorkError } from "./llm.ts";
import { cliChat, type CliHost, type Runner } from "./clireviewer.ts";
import { loadReviewConfig, REVIEW_FILE, type ReviewConfig } from "./review.ts";
import { hostReviewerDefault } from "./setup.ts";

/** 静置多久算话题结束（用户 2026-10-16 定 20 分钟）。代码常量，不加配置键（§2.2）。 */
export const TOPIC_IDLE_MS = 20 * 60_000;
/** 话题太长时按轮次边界拆开（兜底，不是常态）。 */
export const TOPIC_MAX_CHARS = 120_000;
/** 话题前附的背景：最多几轮、最多多少字（只供理解，放 <context_only>）。 */
export const TOPIC_CONTEXT_TURNS = 8;
export const TOPIC_CONTEXT_MAX_CHARS = 6_000;
/** 单轮超长时截断（和旧窗口同一个数）。 */
export const TOPIC_TURN_MAX_CHARS = 48_000;
/** 一步式子模型单次调用超时（Haiku max 实测每窗口约 4.5 分钟，长话题留余量）。 */
export const TOPIC_CALL_TIMEOUT_MS = 15 * 60_000;
/** 调用子模型期间续租约的间隔（租约 10 分钟，调用可能更久）。 */
export const TOPIC_HEARTBEAT_MS = 60_000;
/** 话题标记保留多久（会话坐标是 90 天；标记只在没处理时有用）。 */
const MARK_RETENTION_DAYS = 30;

export type TopicTrigger = "idle" | "compact" | "session_end";

// ---------- 开关 ----------

/**
 * 开关：<home>/extract.json 里 "topic": true 才启用话题触发与一步式（默认关闭）。
 * 关着时 capture 的压缩事件、下一轮静置判断都不做任何事，ab work 走原来的 48000 字窗口 + 抽取器。
 * 只读这一个键，extract.json 其他字段有没有、对不对都不影响开关判断。
 */
export function topicEnabled(home: string): boolean {
  try {
    return (JSON.parse(readFileSync(join(home, "extract.json"), "utf8")) as { topic?: unknown })?.topic === true;
  } catch {
    return false;
  }
}

/** 提示词版本：一步式系统提示 + 子代理说明全文的短哈希，提示词一改就变。 */
export const PROMPT_VERSION = createHash("sha256").update(`${ONE_PASS_SYSTEM}\n${ONE_PASS_WORKER_NOTE}`).digest("hex").slice(0, 12);

// ---------- 压缩标记（存 work_meta，不加表） ----------

export interface TopicMark {
  cut_at: string;
  trigger: "compact";
}

const markKey = (host: Host, sessionId: string) => `topic_marks:${host}:${sessionId}`;

export function topicMarks(db: DatabaseSync, host: Host, sessionId: string): TopicMark[] {
  const row = db.prepare("SELECT value FROM work_meta WHERE key=?").get(markKey(host, sessionId)) as { value: string } | undefined;
  if (!row) return [];
  try {
    const v = JSON.parse(row.value);
    return Array.isArray(v) ? v.filter((m) => typeof m?.cut_at === "string" && m.trigger === "compact") : [];
  } catch {
    return [];
  }
}

/** 读改写放在一个写事务里（hook 和 ab work 是不同进程，防止互相覆盖丢标记）；已在事务里就直接跑。 */
function inWriteTx(db: DatabaseSync, f: () => void): void {
  if (db.isTransaction) return f();
  db.exec("BEGIN IMMEDIATE");
  try {
    f();
    db.exec("COMMIT");
  } catch (e) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw e;
  }
}

/**
 * 记一个压缩边界。同一时刻重复记只留一个。
 * 标记处理完也不删（只按保留期清理）：ab work --session --redo 清掉进度重切时还要用它，切出来的窗口和 window_id 才和第一次一样。
 */
export function addTopicMark(db: DatabaseSync, host: Host, sessionId: string, cutAt: Date): void {
  inWriteTx(db, () => {
    const marks = topicMarks(db, host, sessionId);
    const iso = cutAt.toISOString();
    if (marks.some((m) => m.cut_at === iso)) return;
    marks.push({ cut_at: iso, trigger: "compact" });
    marks.sort((a, b) => a.cut_at.localeCompare(b.cut_at));
    db.prepare("INSERT OR REPLACE INTO work_meta(key,value) VALUES(?,?)").run(markKey(host, sessionId), JSON.stringify(marks));
  });
}

/** 有界保留：会话坐标已删的、或最新标记早于保留期的，整组删掉。 */
export function pruneTopicMarks(db: DatabaseSync, now: Date): void {
  const cutoff = new Date(now.getTime() - MARK_RETENTION_DAYS * 86_400_000).toISOString();
  inWriteTx(db, () => {
    const rows = db.prepare("SELECT key,value FROM work_meta WHERE key LIKE 'topic_marks:%'").all() as { key: string; value: string }[];
    for (const r of rows) {
      const [, host, ...rest] = r.key.split(":");
      const sid = rest.join(":");
      const known = db.prepare("SELECT 1 AS x FROM capture_sessions WHERE host=? AND session_id=?").get(host, sid);
      let latest = "";
      try {
        latest = (JSON.parse(r.value) as TopicMark[]).reduce((a, m) => (m.cut_at > a ? m.cut_at : a), "");
      } catch {
        /* 坏数据直接删 */
      }
      if (!known || latest < cutoff) db.prepare("DELETE FROM work_meta WHERE key=?").run(r.key);
    }
  });
}

// ---------- 按话题切窗口 ----------

export interface TopicChunk {
  id: string;
  from: string | null;
  to: string;
  turns: Turn[];
  context: Turn[];
  chars: number;
  truncated: number;
  trigger: TopicTrigger;
  /** 话题太长拆开时为 "k/n"，否则 null。 */
  part: string | null;
  /** 在本窗口结束的压缩标记（窗口处理完就删）。 */
  marks: string[];
}

export function windowId(host: Host, sessionId: string, from: string | null, to: string): string {
  return createHash("sha256").update(`${host}|${sessionId}|${from ?? ""}|${to}`).digest("hex");
}

/** 话题前的背景：从紧挨着的那轮往前取，最多 TOPIC_CONTEXT_TURNS 轮、TOPIC_CONTEXT_MAX_CHARS 字；超出时最远那轮只留结尾。 */
export function topicContext(all: readonly Turn[], begin: number): Turn[] {
  const out: Turn[] = [];
  let room = TOPIC_CONTEXT_MAX_CHARS;
  for (let i = begin - 1; i >= 0 && out.length < TOPIC_CONTEXT_TURNS && room > 0; i--) {
    const t = all[i];
    if (t.text.length <= room) {
      out.unshift(t);
      room -= t.text.length;
    } else {
      out.unshift({ ...t, text: "…" + t.text.slice(t.text.length - room) });
      room = 0;
    }
  }
  return out;
}

export interface TopicCutInput {
  /** 压缩标记。 */
  marks: readonly TopicMark[];
  /** 会话已结束（剩下的全是一个话题）。 */
  ended: boolean;
  /** transcript 最后一次修改距现在 ≥ TOPIC_IDLE_MS（最后一个话题静置结束）。 */
  idleTail: boolean;
}

/**
 * 从处理进度之后切出已经结束的话题。没结束的最后一段（还在聊）不切。
 * 返回窗口和"已失效的标记"（落在处理进度之前，或没有新轮次可切的），调用方删掉它们。
 */
export function topicChunks(host: Host, sessionId: string, all: readonly Turn[], from: string | null, cut: TopicCutInput): { chunks: TopicChunk[]; staleMarks: string[] } | "anchor_missing" {
  let start = 0;
  if (from !== null) {
    const i = all.findIndex((t) => t.anchor === from);
    if (i < 0) return "anchor_missing";
    start = i + 1;
  }
  // 时间：缺时间戳的轮次沿用前一轮的时间
  const ts: number[] = [];
  let last = NaN;
  for (const t of all) {
    const v = t.ts ? Date.parse(t.ts) : NaN;
    if (Number.isFinite(v)) last = v;
    ts.push(last);
  }
  const ends = new Map<number, TopicTrigger>();
  const marksAt = new Map<number, string[]>();
  for (let i = start; i < all.length - 1; i++) {
    if (Number.isFinite(ts[i]) && Number.isFinite(ts[i + 1]) && ts[i + 1] - ts[i] >= TOPIC_IDLE_MS) ends.set(i, "idle");
  }
  const staleMarks: string[] = [];
  for (const m of cut.marks) {
    const at = Date.parse(m.cut_at);
    let j = -1;
    for (let i = all.length - 1; i >= 0; i--) {
      if (Number.isFinite(ts[i]) && ts[i] <= at) {
        j = i;
        break;
      }
    }
    // 整份 transcript 都没时间戳：只能把当前最后一轮当边界
    if (j < 0 && !ts.some(Number.isFinite)) j = all.length - 1;
    if (j < start) staleMarks.push(m.cut_at);
    else {
      ends.set(j, "compact");
      marksAt.set(j, [...(marksAt.get(j) ?? []), m.cut_at]);
    }
  }
  if (all.length > start && (cut.ended || cut.idleTail) && !ends.has(all.length - 1)) ends.set(all.length - 1, cut.ended ? "session_end" : "idle");
  const chunks: TopicChunk[] = [];
  let begin = start;
  let prev = from;
  for (const end of [...ends.keys()].sort((a, b) => a - b)) {
    const trigger = ends.get(end)!;
    const parts = splitTopic(all.slice(begin, end + 1));
    let partBegin = begin;
    parts.forEach((p, k) => {
      const to = p.turns[p.turns.length - 1].anchor;
      chunks.push({
        id: windowId(host, sessionId, prev, to),
        from: prev,
        to,
        turns: p.turns,
        context: topicContext(all, partBegin),
        chars: p.chars,
        truncated: p.truncated,
        trigger,
        part: parts.length > 1 ? `${k + 1}/${parts.length}` : null,
        marks: k === parts.length - 1 ? (marksAt.get(end) ?? []) : [],
      });
      prev = to;
      partBegin += p.turns.length;
    });
    begin = end + 1;
  }
  return { chunks, staleMarks };
}

function splitTopic(turns: readonly Turn[]): { turns: Turn[]; chars: number; truncated: number }[] {
  const out: { turns: Turn[]; chars: number; truncated: number }[] = [];
  let cur: Turn[] = [];
  let chars = 0;
  let truncated = 0;
  for (let t of turns) {
    if (t.text.length > TOPIC_TURN_MAX_CHARS) {
      t = { ...t, text: t.text.slice(0, TOPIC_TURN_MAX_CHARS) + "…（超长已截断）" };
      truncated++;
    }
    if (cur.length && chars + t.text.length > TOPIC_MAX_CHARS) {
      out.push({ turns: cur, chars, truncated });
      cur = [];
      chars = 0;
      truncated = 0;
    }
    cur.push(t);
    chars += t.text.length;
  }
  if (cur.length) out.push({ turns: cur, chars, truncated });
  return out;
}

// ---------- 运行报告（审计记录）与整次撤销 ----------

export interface TopicWindowReport {
  window_id: string;
  session: string;
  trigger: TopicTrigger;
  part: string | null;
  from: string | null;
  to: string;
  turns: number;
  chars: number;
  model: string;
  prompt_version: string;
  ms: number;
  outcome: "done" | "no_signal" | "deferred" | "failed";
  error?: string;
  invalid?: Record<string, number>;
  /** 写进正式库的条目。 */
  created: { id: string; kind: string; text: string; scenario: string; reason: string; unreconciled: boolean }[];
  /** 模型判"并入已有某条"：不改目标、不写库，只记在这里给用户看（§8.6 第 7 点，见实现说明）。 */
  merges: { into: string; into_confirmed_by_user: boolean; text: string; reason: string }[];
  /** 同窗口重跑时幂等键已存在、没再写的条数。 */
  skipped_known: number;
}

export interface TopicRunReport {
  run: string;
  at: string;
  windows: TopicWindowReport[];
}

export function topicReportDir(home: string): string {
  return join(home, "topic");
}

export function saveTopicReport(home: string, r: TopicRunReport): string {
  const dir = topicReportDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${r.run}.json`);
  writeFileSync(path, JSON.stringify(r, null, 1), { mode: 0o600 });
  return path;
}

export function listTopicRuns(home: string): string[] {
  try {
    return readdirSync(topicReportDir(home)).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")).sort();
  } catch {
    return [];
  }
}

export function newTopicRun(now: Date): string {
  return `topic-${now.toISOString().replace(/[:.]/g, "-")}-${createHash("sha256").update(`${process.pid}|${Math.random()}`).digest("hex").slice(0, 6)}`;
}

/**
 * 撤销一次话题沉淀：把这次运行写进正式库的条目归档（可 ab archive --undo / reactivate 恢复）。
 * 以 L1 为准（每条 remember 带 topic.run），报告没落盘也能撤。
 * 只动"自写入后没人动过"的条目：用户确认过的、之后被归档/恢复/移进候选区过的一律不动。
 */
export function undoTopicRun(store: Store, run: string): { archived: string[]; kept: { id: string; why: string }[] } {
  const archived: string[] = [];
  const kept: { id: string; why: string }[] = [];
  for (const e of store.topicRunEvents(run)) {
    // 检查和归档在同一个写事务里：检查完到写入之间别的进程（如 ab confirm）改不了它
    const r = store.lifecycleIf("archive", e.id, null, { reason: "topic_undo", run, note: `undo ${run}` }, (p) => {
      if (p.confirmed_by === "user") return "用户已确认";
      if (p.confirmed) return `已自动转正（${p.confirmed_by}），请手动看`;
      if (p.state !== "active") return `状态已是 ${p.state}`;
      if (store.lastStateEvent(p.id) !== null) return "写入后被改过状态";
      if (p.extra_sources.length || p.related) return "写入后被关系判定动过（并入了别的来源或已判关系），请手动看";
      return null;
    });
    if ("skipped" in r) kept.push({ id: e.id, why: r.skipped });
    else archived.push(e.id);
  }
  return { archived, kept };
}

// ---------- 每个宿主的一步式子模型 ----------

/**
 * 哪个宿主的会话就用哪个宿主的子模型和它自己的额度（§8.6 第 6 点）：review.json 的 hostReviewers[宿主] 配了就用它，
 * 没配用 ab setup 的宿主默认（Claude haiku max；Codex review_model 或 gpt-6-astra max；Pi reviewer 子代理模型 max）。
 * review.json 存在但写错了：报 no_config（窗口延后），不悄悄换别的模型。
 */
export function topicChatFor(home: string, deps: { runner?: Runner } = {}): (host: Host) => { chat: Chat; model: string } | { error: WorkError; message: string } {
  let cfg: ReviewConfig | null = null;
  let cfgError: string | null = null;
  if (existsSync(join(home, REVIEW_FILE))) {
    const r = loadReviewConfig(home);
    if ("error" in r) cfgError = r.error;
    else cfg = r;
  }
  return (host) => {
    if (cfgError) return { error: "no_config", message: `一步式子模型配置有误：${cfgError}` };
    const m = cfg?.hostReviewers[host as CliHost];
    // §8.6 第 6 点：话题沉淀只用宿主自己的命令行子模型和它自己的额度。审稿配成 API 的不拿来用（数据会发给别的服务、用别的额度），
    // 也不悄悄换成宿主默认：报 no_config，窗口延后，等用户改配置或决定放开。
    if (m && m.type === "api") return { error: "no_config", message: `话题沉淀只用宿主命令行子模型；review.json 的 hostReviewers.${host} 是 API（${m.name}），请改成 cli 或删掉这一项用默认` };
    const spec = m ? { model: m.model || undefined, effort: m.effort, bin: m.bin } : (() => {
      const d = hostReviewerDefault(host as CliHost);
      return { model: d.model || undefined, effort: d.effort, bin: undefined };
    })();
    const chat = cliChat({ host: host as CliHost, model: spec.model, effort: spec.effort, bin: spec.bin, timeoutMs: TOPIC_CALL_TIMEOUT_MS }, deps.runner);
    return { chat, model: `${host}:${spec.model ?? "default"}@${spec.effort ?? "default"}` };
  };
}
