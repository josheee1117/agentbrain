/**
 * 切片 3 后台 worker（设计 §19.3 关闭形态）：`ab work` 是短命进程，单实例租约。
 * 会话坐标由 `ab capture` 登记；本文件切窗口 → 去噪 → 脱敏 → 抽取 → 校验 → 近邻复查 → 准入 → 一个事务写 L1。
 * 另做三件定期事：按代码核验未确认的坑/事实、跨会话印证、过期提议归档。
 */
import { prune as pruneTelemetry, stripAbUsed } from "./telemetry.ts";
import type { DatabaseSync } from "node:sqlite";
import { closeSync, existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync, readSync, realpathSync, statSync, type Dirent } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { checkAlternatives, checkBodyField, checkRememberBody, sameAlternatives, sameBody } from "./l2.ts";
import { VEC_MIN_SIM, vectorTextOf, type Store, type Embedder, type PendingAppend } from "./store.ts";
import type { Basis, ConfirmBody, EvidenceBody, Host, Proposition, RememberBody, SourcePointer, TopicProvenance, VerifyBody } from "./l2.ts";
import { applyVerdict, buildRelateMessages, parseRelate, type RelateItem, type RelateOutcome } from "./relate.ts";
import { WorkFailure, parseJsonLoose, type Chat, type WorkError, authFailed, failureDetail } from "./llm.ts";
import { addHits, sanitize, secretKinds } from "./sanitize.ts";
import { cleanTranscript, isCodexSubagent, type Turn } from "./transcript.ts";
import { locateTranscript } from "./host.ts";
import { opencodeId, opencodeRef, opencodeSession, recentOpencodeSessions } from "./opencode.ts";
import { agyDiscover, agyRoots } from "./agy.ts";
import { allowedTranscript, readTranscript, resolveTranscript } from "./transcript-file.ts";
import { EXTRACT_PROMPT_VERSION, buildMessages, hasExtractableSignal, KIND_FOR_BASIS, MAX_EVIDENCE, sha256, validate, type Candidate, type ExtractWindow, type ProjectContext } from "./extract.ts";
import { RepoTools, VERIFY_PROMPT_VERSION, verifyProposition } from "./codeverify.ts";
import * as intake from "./intake.ts";
import type { RegistryEntry } from "./registry.ts";
import { buildOnePassMessages, parseOnePass } from "./onepass.ts";
import { bindTopicMarks, PROMPT_VERSION, pruneTopicMarks, TOPIC_HEARTBEAT_MS, TOPIC_IDLE_MS, topicChunks, topicMarks, type TopicChunk, type TopicRunReport, type TopicWindowReport } from "./topic.ts";

export const SETTLE_IDLE_MS = 30 * 60_000;
export const WINDOW_MAX_CHARS = 48_000;
export const CONTEXT_OVERLAP_TURNS = 4;
export const MAX_WINDOWS_PER_SESSION_RUN = 6;
/** 候选与已有条目的近重复门槛。2026-10-12 用 17 条真实提议复核后维持 0.80（数字见设计 §21）。 */
export const DUP_CHECK_SIM = 0.8;
/** 同一窗口内两条候选余弦 ≥ 此值视为同一件事，只留一条（§21 2026-10-12）。 */
export const SAME_WINDOW_DUP_SIM = 0.8;
/** 每次 sweep 最多给扫描/补登记来的会话处理的窗口数；hook 登记的会话不受限（§21 2026-10-12）。 */
export const BACKLOG_WINDOWS_PER_SWEEP = 10;
const NEIGHBOR_QUERIES = 8;
const NEIGHBOR_QUERY_CHARS = 500;
const NEIGHBORS_PER_QUERY = 4;
const MAX_NEIGHBORS = 12;
const RECHECK_TOP = 3;
const DOC_MAX_CHARS = 3000;
const PROJECT_DOCS_MAX_CHARS = 6000;
const REGISTRY_MAX_CHARS = 3000;
const CONFIRMED_MAX_CHARS = 3000;
export const MAX_VERIFY_PER_RUN = 3;
const VERIFY_RECHECK_MS = 24 * 3_600_000;
/** 证据不足后再核的间隔：第 1 次 1 天，然后 2、4 天，之后保持 8 天（§12.6.12）。 */
export const VERIFY_BACKOFF_DAYS = [1, 2, 4, 8];
const SCAN_DAYS = 7;
const SCAN_HEAD_BYTES = 64 * 1024;
const CODE_VERIFIABLE = new Set(["pitfall", "note"]);
/** 关系判定第 2 层（§21 2026-10-13）：近邻余弦下限、每条最多给几个近邻、一次调用判几条、每次运行最多几次调用。 */
export const RELATE_SIM = 0.7;
export const RELATE_TOP = 3;
export const RELATE_BATCH = 6;
const MAX_RELATE_CALLS_PER_RUN = 10;
const CORROBORATE_KINDS = new Set(["rule", "decision"]);
const USER_BASES = new Set<Basis | undefined>(["user_directive", "user_confirmed"]);

export interface WorkDeps {
  store: Store;
  now: () => Date;
  /** 模型不可用时为 { error }，worker 把窗口延后，不当成"没有可记的"。 */
  chat: { chat: Chat; model: string } | { error: WorkError; message: string };
  embedder: Embedder | null;
  registry: RegistryEntry[];
  registryDir: string;
  resolveProject: (cwd: string) => { name: string; path: string } | null;
  projectId: (name: string) => string;
  /** 设了就把每个窗口送模型的轮次与模型原始回复（脱敏后）写到这里，排查证据对不上用；默认不设（AB_DEBUG=1 时 cli 设为 ~/.agentbrain/debug）。 */
  debugDir?: string;
  /** 设了就走话题结束时一步式沉淀（§8.6，开关 extract.json "topic": true）；不设是原来的 48000 字窗口 + 抽取器。 */
  topic?: TopicDeps;
}

/** 话题模式的依赖：每个宿主用它自己的命令行子模型和额度（§8.6 第 6 点），不跨宿主借额度。 */
export interface TopicDeps {
  run: string;
  chatFor: (host: Host) => { chat: Chat; model: string } | { error: WorkError; message: string };
  /** 每处理完一个窗口落盘一次运行报告（审计记录）。 */
  save?: (r: TopicRunReport) => void;
}

export interface WorkOptions {
  session?: { host: Host; session_id: string };
  sweep: boolean;
  dryRun: boolean;
  /** 只配合 session：清掉该会话的处理进度从头重跑。 */
  redo?: boolean;
}

export interface WorkReport {
  busy: boolean;
  scanned: number;
  windows: { done: number; deferred: number; failed: number; skipped: number };
  /** 本次 sweep 因补登记上限留到下次的会话数。 */
  backlogLeft: number;
  receipt: intake.Receipt;
  verify: { verified: number; contradicted: number; not_verifiable: number; inconclusive: number; errors: number };
  relate: Record<RelateOutcome | "corroborated" | "errors", number>;
  dry: { session: string; windows: number; chars: number }[];
  /** 这次运行里拆开重试的窗口数（§12.6.6）。 */
  split: number;
  /** 出错明细：窗口、关系判定、代码核验各自的失败原因（脱敏、截短），每类最多 PROBLEMS_PER_KIND 行。 */
  problems: string[];
  /** 话题模式的运行报告（审计记录，可 ab work --undo <run> 整次撤销）。 */
  topic?: TopicRunReport;
}

// ---------- 会话登记 ----------

/** Pi 文件名是 <时间>_<session id>.jsonl。 */
export function piSessionId(file: string): string | null {
  const m = /_([^_/]+)\.jsonl$/.exec(file);
  return m ? m[1] : null;
}

function headLines(file: string): any[] {
  let raw: string;
  try {
    raw = readTranscript(file, SCAN_HEAD_BYTES);
  } catch {
    return []; // 读不了就跳过这一项，不能拖垮整个扫描
  }
  return raw.split("\n").slice(0, 50).flatMap((l) => {
    try {
      return [JSON.parse(l)];
    } catch {
      return [];
    }
  });
}

/** 会话开始时间：头部第一条带 timestamp 的记录；没有就用文件创建时间。 */
export function sessionStart(file: string, head?: any[]): number | null {
  if (file.startsWith("opencode://")) {
    try {
      return opencodeSession(file)?.time_created ?? null;
    } catch {
      return null;
    }
  }
  for (const e of head ?? headLines(file)) {
    const t = typeof e?.timestamp === "string" ? e.timestamp : typeof e?.payload?.timestamp === "string" ? e.payload.timestamp : typeof e?.created_at === "string" ? e.created_at : null;
    const ms = t ? Date.parse(t) : NaN;
    if (Number.isFinite(ms)) return ms;
  }
  try {
    const st = statSync(resolveTranscript(file)!);
    return st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs;
  } catch {
    return null;
  }
}

function walk(host: Host, dir: string, depth: number, out: string[]): void {
  let ents: Dirent[];
  try {
    ents = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of ents) {
    const p = join(dir, e.name);
    if (e.isDirectory() && depth > 0) walk(host, p, depth - 1, out);
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
    else if (e.isFile() && e.name.endsWith(".jsonl.zst") && host === "codex") out.push(p);
  }
}

/** 兜底：hook 没触发（Codex 未信任等）时，从三宿主会话目录补登记 cwd 落在已登记项目里的近期会话。 */
export function scan(deps: WorkDeps, agy = agyDiscover(agyRoots(), deps.now(), (id) => intake.knownSession(deps.store.workDb, "agy", id))): number {
  const db = deps.store.workDb;
  const since = deps.now().getTime() - SCAN_DAYS * 86_400_000;
  const hook = intake.firstHookAt(db);
  const hookMs = hook ? Date.parse(hook) : null;
  let added = 0;
  const hosts: [Host, string, number][] = [
    ["claude", ".claude/projects", 1],
    ["codex", ".codex/sessions", 3],
    ["pi", ".pi/agent/sessions", 1],
  ];
  for (const [host, rel, depth] of hosts) {
    const files: string[] = [];
    walk(host, join(homedir(), rel), depth, files);
    for (const f of files) {
      let mtime: number;
      try {
        mtime = statSync(resolveTranscript(f)!).mtimeMs;
      } catch {
        continue;
      }
      if (mtime < since) continue;
      const id =
        host === "claude" ? f.split(sep).pop()!.replace(/\.jsonl$/, "")
        : host === "codex" ? (/-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(?:\.zst)?$/.exec(f)?.[1] ?? null)
        : piSessionId(f);
      if (!id || intake.knownSession(db, host, id)) continue;
      const head = headLines(f);
      const cwd = head.map((e) => e?.cwd ?? e?.payload?.cwd).find((c) => typeof c === "string") as string | undefined;
      if (!cwd || head.some((e) => e?.isSidechain === true) || isCodexSubagent(head)) continue;
      let project: { name: string } | null = null;
      try {
        project = deps.resolveProject(cwd);
      } catch {
        project = null;
      }
      // 未登记目录的会话也记下坐标（不抽取），下次扫描不再为它跑 git。
      // 开始时间早于第一次 hook 登记的是装 hook 前的历史会话（backfill），不算漏登记
      const started = sessionStart(f, head);
      const via = hookMs !== null && started !== null && started >= hookMs ? "scan" : "backfill";
      intake.upsertSession(db, { host, session_id: id, transcript: realpathSync(f), cwd, ended: false, ephemeral: false, via }, () => project?.name ?? null, deps.now());
      if (project) added++;
    }
  }
  // 缺元数据不猜 cwd；冲突已由发现入口排除，子会话不补登记（§7.8.2）。
  for (const c of agy.conversations) {
    if (c.parent || !c.cwd || intake.knownSession(db, "agy", c.id)) continue;
    let project: { name: string } | null = null;
    try {
      project = deps.resolveProject(c.cwd);
    } catch {
      project = null;
    }
    const started = sessionStart(c.transcript);
    const via = hookMs !== null && started !== null && started >= hookMs ? "scan" : "backfill";
    const result = intake.upsertSession(db, { host: "agy", session_id: c.id, transcript: c.transcript, cwd: c.cwd, ended: false, ephemeral: false, via }, () => project?.name ?? null, deps.now());
    if (result !== "conflict" && project) added++;
  }
  try {
    for (const s of recentOpencodeSessions(since)) {
      if (intake.knownSession(db, "opencode", s.id)) continue;
      const project = deps.resolveProject(s.directory);
      if (!project) continue;
      const via = hookMs !== null && s.time_created >= hookMs ? "scan" : "backfill";
      intake.upsertSession(db, { host: "opencode", session_id: s.id, transcript: opencodeRef(s.id), cwd: s.directory, ended: false, ephemeral: false, via }, () => project.name, deps.now());
      added++;
    }
  } catch {
    // opencode 未安装或库不可读时不影响其他宿主的扫描。
  }
  return added;
}

// ---------- 窗口 ----------

interface Chunk {
  id: string;
  from: string | null;
  to: string;
  turns: Turn[];
  context: Turn[];
  chars: number;
  truncated: number;
}

function ordinalOf(anchor: string | null | undefined): number | null {
  if (!anchor || !/^\d+$/.test(anchor)) return null;
  const n = Number(anchor);
  return Number.isSafeInteger(n) ? n : null;
}

/** Codex 换文件后旧 ordinal 不在新文件里。新文件第一轮更大，说明内容接在旧进度之后，可以从第一轮接着切。
 * 注意这不等于“新内容”：用户编辑旧消息也会换文件，新文件首轮会把已抽过的原话再送一遍。
 * 重复的原话由 admit 按“同条目 + 同宿主同会话 + 同 quote_sha256”挡住，这里只管接上进度。 */
function codexContinues(host: Host, all: Turn[], from: string): boolean {
  if (host !== "codex") return false;
  const progress = ordinalOf(from);
  const first = ordinalOf(all[0]?.anchor);
  return progress !== null && first !== null && first > progress;
}

/** 进度已经越过这个窗口的终点。Codex 两个锚点都是数字时直接比大小，换文件后两者都不在新文件里也能判。 */
function progressPassed(host: Host, turns: Turn[], processed: string, to: string): boolean {
  if (host === "codex") {
    const progress = ordinalOf(processed);
    const end = ordinalOf(to);
    if (progress !== null && end !== null) return end <= progress;
  }
  const at = turns.findIndex((t) => t.anchor === processed);
  const end = turns.findIndex((t) => t.anchor === to);
  if (at < 0 || end < 0) return false;
  return end <= at;
}

/** 出错明细每类最多记几行。 */
const PROBLEMS_PER_KIND = 10;

function problem(report: WorkReport, kind: string, text: string): void {
  if (report.problems.filter((p) => p.startsWith(`${kind} `)).length < PROBLEMS_PER_KIND) report.problems.push(`${kind} ${text}`);
}

/** 拆窗口的切点：前一半最后一轮的定位点，按字数对半。只有一轮或不够大时不拆，返回 null。 */
export function splitPoint(c: Pick<Chunk, "turns" | "chars">): string | null {
  if (c.turns.length < 2 || c.chars <= intake.SPLIT_MIN_CHARS) return null;
  let sum = 0;
  for (let i = 0; i < c.turns.length - 1; i++) {
    sum += c.turns[i].text.length;
    if (sum >= c.chars / 2) return c.turns[i].anchor;
  }
  return c.turns[c.turns.length - 2].anchor;
}

/**
 * 从 checkpoint 之后按轮次边界切块，每块 ≤ WINDOW_MAX_CHARS；单轮超长时截断并计数（不静默）。
 * cuts 是拆过的窗口留下的切点：到这些定位点一定切一刀，拆出来的小窗口才不会又被拼回大窗口。
 */
export function chunk(host: Host, sessionId: string, all: Turn[], from: string | null, settled: boolean, cuts: ReadonlySet<string> = new Set()): Chunk[] | "anchor_missing" {
  let start = 0;
  if (from !== null) {
    const i = all.findIndex((t) => t.anchor === from);
    if (i >= 0) start = i + 1;
    else if (!codexContinues(host, all, from)) return "anchor_missing";
    // 接上新文件时 start 仍是 0，窗口 from 保持旧进度，finishWindow 的 CAS 才能通过
  }
  const chunks: Chunk[] = [];
  let cur: Turn[] = [];
  let chars = 0;
  let truncated = 0;
  let prev = from;
  let begin = start;
  const flush = (end: number) => {
    if (!cur.length) return;
    const to = cur[cur.length - 1].anchor;
    chunks.push({
      id: windowId(host, sessionId, prev, to),
      from: prev,
      to,
      turns: cur,
      context: all.slice(Math.max(0, begin - CONTEXT_OVERLAP_TURNS), begin),
      chars,
      truncated,
    });
    prev = to;
    begin = end;
    cur = [];
    chars = 0;
    truncated = 0;
  };
  for (let i = start; i < all.length; i++) {
    let t = all[i];
    if (t.text.length > WINDOW_MAX_CHARS) {
      t = { ...t, text: t.text.slice(0, WINDOW_MAX_CHARS) + "…（超长已截断）" };
      truncated++;
    }
    if (cur.length && chars + t.text.length > WINDOW_MAX_CHARS) flush(i);
    cur.push(t);
    chars += t.text.length;
    if (cuts.has(t.anchor)) flush(i + 1);
  }
  if (settled) flush(all.length);
  return chunks;
}

function windowId(host: Host, sessionId: string, from: string | null, to: string): string {
  return createHash("sha256").update(`${host}|${sessionId}|${from ?? ""}|${to}`).digest("hex");
}

// ---------- 项目背景（业务理解，§21 2026-10-12） ----------

function readBounded(path: string, max: number): string {
  try {
    const t = readFileSync(path, "utf8");
    return t.length > max ? t.slice(0, max) + "\n…（截断）" : t;
  } catch {
    return "";
  }
}

export function projectContext(deps: WorkDeps, projectName: string | null, projectId: string | null): ProjectContext {
  const entry = projectName ? deps.registry.find((e) => e.name === projectName) : undefined;
  const docs: string[] = [];
  let used = 0;
  if (entry?.path) {
    const seen = new Set<string>();
    for (const name of ["AGENTS.md", "CLAUDE.md", "README.md"]) {
      const text = readBounded(join(entry.path, name), DOC_MAX_CHARS);
      if (!text || seen.has(text)) continue;
      seen.add(text);
      const room = PROJECT_DOCS_MAX_CHARS - used;
      if (room <= 0) break;
      const part = `## ${name}\n${text.slice(0, room)}`;
      docs.push(part);
      used += part.length;
    }
  }
  const registry = projectName ? readBounded(join(deps.registryDir, `${projectName}.md`), REGISTRY_MAX_CHARS) : "";
  // 已登记项目清单（名字 + ~ 路径，与窗口同口径，§8.11.3）
  const projects = deps.registry
    .map((e) => `- ${e.name}${e.path ? ` ${e.path.replace(new RegExp(`^${homedir()}`), "~")}` : ""}`)
    .join("\n");
  const rows = [...deps.store.project().props.values()]
    .filter((p) => p.state === "active" && p.confirmed && p.kind !== "note" && (p.project_id === null || p.project_id === projectId))
    .sort((a, b) => b.seq - a.seq);
  let confirmed = "";
  for (const p of rows) {
    const line = `- [${p.kind}${p.project_id === null ? "，全局" : ""}] ${p.text.replace(/\s+/g, " ")}\n`;
    if (confirmed.length + line.length > CONFIRMED_MAX_CHARS) break;
    confirmed += line;
  }
  return {
    name: projectName,
    docs: sanitize(docs.join("\n\n")).text,
    registry: sanitize(registry).text,
    confirmed: sanitize(confirmed).text.trim(),
    projects: sanitize(projects).text,
  };
}

// ---------- 近邻 ----------

const QUOTA = /\b429\b|quota|rate.?limit|too many requests/i;

/** embedding 出错：额度/限流归成 http_429（窗口延后、不算失败），其余是 embed_unavailable。 */
function embedFailure(e: unknown, prefix: string): WorkFailure {
  const msg = (e as Error).message ?? String(e);
  return new WorkFailure(QUOTA.test(msg) ? "http_429" : "embed_unavailable", `${prefix}：${msg}`);
}

async function embedOrDefer(embedder: Embedder | null, texts: string[]): Promise<Float32Array[]> {
  if (!embedder) throw new WorkFailure("embed_unavailable", "未配置 embedding");
  try {
    const v = await embedder(texts);
    if (v.length !== texts.length) throw new Error("条数不一致");
    return v;
  } catch (e) {
    throw embedFailure(e, "embedding 不可用");
  }
}

async function prefetchNeighbors(deps: WorkDeps, turns: Turn[], projectIds: string[]): Promise<Proposition[]> {
  const embedder = deps.embedder;
  if (!embedder) throw new WorkFailure("embed_unavailable", "未配置 embedding");
  try {
    await deps.store.syncVectors(embedder, embedder.model!);
  } catch (e) {
    throw embedFailure(e, "向量未更新");
  }
  const queries = turns.filter((t) => t.role === "user").slice(0, NEIGHBOR_QUERIES).map((t) => t.text.slice(0, NEIGHBOR_QUERY_CHARS));
  if (!queries.length) return [];
  const vecs = await embedOrDefer(embedder, queries);
  const best = new Map<string, { prop: Proposition; similarity: number }>();
  for (const v of vecs) {
    for (const projectId of projectIds) {
      for (const n of deps.store.nearestByVector(v, projectId, NEIGHBORS_PER_QUERY, VEC_MIN_SIM)) {
        const prev = best.get(n.prop.id);
        if (!prev || prev.similarity < n.similarity) best.set(n.prop.id, n);
      }
    }
  }
  return [...best.values()].sort((a, b) => b.similarity - a.similarity).slice(0, MAX_NEIGHBORS).map((n) => n.prop);
}

function cosine(a: Float32Array, b: Float32Array): number {
  let d = 0;
  let x = 0;
  let y = 0;
  for (let i = 0; i < a.length; i++) {
    d += a[i] * b[i];
    x += a[i] * a[i];
    y += b[i] * b[i];
  }
  return x && y ? d / Math.sqrt(x * y) : 0;
}

/** 同窗口近重复：余弦 ≥ SAME_WINDOW_DUP_SIM 的只留一条。kind 与 basis 对得上的优先，其次证据多的；证据取并集。 */
export function mergeSameWindow(cands: Candidate[], vecs: Float32Array[]): { cand: Candidate; vec: Float32Array }[] {
  const score = (c: Candidate) => (KIND_FOR_BASIS[c.basis] === c.kind ? 10 : 0) + c.evidence.length;
  // 正文和否掉的方案不同就是不同的事（§8.11.3）：向量相近也不能合并，否则一份正文被丢掉
  const sameDetail = (a: Candidate, b: Candidate) => sameBody(a.body, b.body) && sameAlternatives(a.alternatives, b.alternatives);
  const kept: { cand: Candidate; vec: Float32Array }[] = [];
  for (let i = 0; i < cands.length; i++) {
    const cur = { cand: cands[i], vec: vecs[i] };
    // 关系不同（比如一条是对旧条目的纠正、一条是新提议）不合并，免得丢掉纠正信号
    const j = kept.findIndex(
      (k) =>
        k.cand.project === cur.cand.project &&
        k.cand.relation.type === cur.cand.relation.type &&
        k.cand.relation.target === cur.cand.relation.target &&
        sameDetail(k.cand, cur.cand) &&
        cosine(k.vec, cur.vec) >= SAME_WINDOW_DUP_SIM,
    );
    if (j < 0) {
      kept.push(cur);
      continue;
    }
    const [win, lose] = score(cur.cand) > score(kept[j].cand) ? [cur, kept[j]] : [kept[j], cur];
    const seen = new Set(win.cand.evidence.map((e) => `${e.anchor}|${e.quote_sha256}`));
    const evidence = [...win.cand.evidence, ...lose.cand.evidence.filter((e) => !seen.has(`${e.anchor}|${e.quote_sha256}`))].slice(0, MAX_EVIDENCE);
    kept[j] = { cand: { ...win.cand, evidence }, vec: win.vec };
  }
  return kept;
}

// ---------- 准入（§7.2 矩阵，没有一行直接转正） ----------

interface Admission {
  appends: PendingAppend[];
  keys: string[];
  /** 与 keys 配对：候选的旧版（main）候选键；旧键已在库时这条事件算已处理，不写入（§21 2026-11-03）。 */
  legacyKeys: (string | undefined)[];
  receipt: Pick<intake.Receipt, "proposals" | "attached" | "corrections" | "unreconciled" | "corroborated" | "dropped">;
}

function distinctUserSessions(p: Proposition, extra: { host: Host | null; session_id: string | null; basis: Basis; quote_sha256: string[] } | null): string[] {
  const list: { key: string; quotes: string[] }[] = [];
  const add = (host: Host | null, sid: string | null, basis: Basis | undefined, quotes: string[]) => {
    if (!sid || !USER_BASES.has(basis)) return;
    list.push({ key: `${host}:${sid}`, quotes });
  };
  add(p.source.host, p.source.session_id, p.basis, p.evidence.filter((e) => e.role === "user").map((e) => e.quote_sha256));
  for (const s of p.extra_sources) add(s.host, s.session_id, s.basis, s.evidence.map((e) => e.quote_sha256));
  if (extra) add(extra.host, extra.session_id, extra.basis, extra.quote_sha256);
  // 同一句原话出现在两个会话里多半是 resume/fork 复制的历史：后出现的那个会话不算独立
  const quotesBy = new Map<string, Set<string>>();
  for (const x of list) {
    const set = quotesBy.get(x.key) ?? new Set<string>();
    x.quotes.forEach((q) => set.add(q));
    quotesBy.set(x.key, set);
  }
  const seen = new Set<string>();
  const independent: string[] = [];
  for (const [key, quotes] of quotesBy) {
    if (![...quotes].some((q) => seen.has(q))) independent.push(key);
    quotes.forEach((q) => seen.add(q));
  }
  return independent;
}

function corroborationConfirm(target: Proposition, extra: Pick<EvidenceBody, "source" | "basis" | "evidence">): ConfirmBody | null {
  if (!CORROBORATE_KINDS.has(target.kind) || target.project_id === null || target.confirmed || target.demoted || target.unreconciled || target.conflicts.length || target.pending_corrections.length || target.supersedes) return null;
  const sessions = distinctUserSessions(target, {
    host: extra.source.host,
    session_id: extra.source.session_id,
    basis: extra.basis,
    quote_sha256: extra.evidence.filter((e) => e.role === "user").map((e) => e.quote_sha256),
  });
  return sessions.length >= 2 ? { by: "corroboration", sessions } : null;
}

/** 同一条目、同宿主同会话里已经记过的原话哈希。用于挡住 Codex 编辑旧消息后换文件造成的重放。 */
function quotesIn(p: Proposition, host: Host, sessionId: string): Set<string> {
  const out = new Set<string>();
  if (p.source.host === host && p.source.session_id === sessionId) {
    for (const e of p.evidence) out.add(e.quote_sha256);
  }
  for (const s of p.extra_sources) {
    if (s.host !== host || s.session_id !== sessionId) continue;
    for (const e of s.evidence) out.add(e.quote_sha256);
  }
  return out;
}

export function admit(
  candidates: (Candidate & { unreconciled: boolean })[],
  s: intake.SessionRow,
  projectId: string,
  windowId: string,
  props: Map<string, Proposition>,
  model: string,
  projectIdOf?: (name: string) => string,
): Admission {
  const out: Admission = { appends: [], keys: [], legacyKeys: [], receipt: { proposals: 0, attached: 0, corrections: 0, unreconciled: 0, corroborated: 0, dropped: {} } };
  for (const c of candidates) {
    const source: SourcePointer = {
      host: s.host,
      session_id: s.session_id,
      transcript: s.transcript,
      anchor: c.evidence[c.evidence.length - 1].anchor,
      summary: `自动沉淀（ab work）：${c.trigger ?? c.text}`.slice(0, 120),
    };
    const target = c.relation.target ? props.get(c.relation.target) : undefined;
    // §8.11.3：候选归属最终项目（global → null，会话项目 → projectId，别的项目 → 该项目的 id）
    const pid = c.project === "global" ? null : c.project && c.project !== s.project ? projectIdOf?.(c.project) ?? projectId : projectId;
    // §8.11.3：所有关系目标必须在最终项目或全局里；越界关系清除，按新条目处理，交给第 2 层重新判
    const outOfScope = !!target && target.project_id !== null && target.project_id !== pid;
    let rel = outOfScope ? { type: "new" as const, target: null } : c.relation;
    let relTarget = outOfScope ? undefined : target;
    // §8.11.3：拒绝把候选当成别的项目条目的重复，这种情况按新条目处理
    const crossProjectDup = outOfScope && c.relation.type === "duplicate" && !!target;
    // §8.11.3：候选带详情而目标没有或详情不同，判重复会丢内容：清掉关系按新条目写入，交给第 2 层判
    const detailDiffers =
      (c.body !== undefined || !!c.alternatives?.length) &&
      (!relTarget || !sameBody(c.body, relTarget.body) || !sameAlternatives(c.alternatives, relTarget.alternatives));
    if (!c.unreconciled && !crossProjectDup && rel.type === "duplicate" && relTarget && relTarget.state === "active" && !detailDiffers) {
      // duplicate 追加的证据事件也带 quote 和 said_at（§8.11.2），密钥检查在 store.commit 前由 checkRememberBody 负责；
      // 证据事件不经过 checkRememberBody，这里用与 extract 相同的 secretKinds 自查，脏引文只丢该条证据
      const kept = c.evidence.filter((e) => !e.quote || secretKinds(e.quote).length === 0);
      // 同宿主同会话里已有的原话不再追另一份：Codex 编辑旧消息会换文件，新文件首轮把已抽过的原话再送一遍。
      // 只看同一会话（跨会话印证有意义）；不是重复关系的条目本来就不走这里。
      const known = quotesIn(relTarget, s.host, s.session_id);
      const evidence = kept.filter((e) => !known.has(e.quote_sha256));
      // 原话全在本会话里记过：整条来源跳掉，不写事件（keys 与 appends 按下标配对，不能只推键）
      if (!evidence.length) continue;
      const body: EvidenceBody = { source, basis: c.basis, evidence, window_id: windowId, model, prompt_version: EXTRACT_PROMPT_VERSION };
      out.appends.push({ kind: "evidence", project_id: relTarget.project_id, session_id: s.session_id, target_id: relTarget.id, body });
      out.keys.push(c.key);
      out.legacyKeys.push(c.legacyKey);
      out.receipt.attached++;
      const cb = corroborationConfirm(relTarget, body);
      if (cb) {
        out.appends.push({ kind: "confirm", project_id: relTarget.project_id, session_id: null, target_id: relTarget.id, body: cb });
        out.keys.push(`${c.key}:confirm`);
        // confirm 与这条证据同生共死：证据按旧键算已处理时，confirm 也不能单独写进去（§21 2026-11-03）
        out.legacyKeys.push(c.legacyKey);
        out.receipt.corroborated++;
      }
      continue;
    }
    if (detailDiffers && rel.type === "duplicate") {
      rel = { type: "new", target: null };
      relTarget = undefined;
    }
    const body: RememberBody = {
      model,
      prompt_version: EXTRACT_PROMPT_VERSION,
      kind: c.kind,
      text: c.text,
      why: c.why,
      trigger: c.trigger,
      source,
      confirmed: false,
      origin: "extract",
      basis: c.basis,
      evidence: c.evidence,
      window_id: windowId,
      relation: { type: rel.type, target: relTarget ? relTarget.id : null },
      ...(c.valid_days ? { valid_days: c.valid_days } : {}),
      ...(c.said_at ? { said_at: c.said_at } : {}),
      ...(c.guidance ? { guidance: true } : {}),
      ...(c.body ? { body: c.body } : {}),
      ...(c.alternatives ? { alternatives: c.alternatives } : {}),
      ...(c.value ? { value: c.value } : {}),
    };
    let bucket: "proposals" | "unreconciled" | "corrections";
    // 显式 duplicate 因详情不同被改成新条目：关系还没定，首次写入就标待判（§9.4.4）
    const demotedDup = detailDiffers && c.relation.type === "duplicate";
    if (crossProjectDup) {
      // §8.11.3：候选被判定为别的项目条目的重复，按新条目处理（不并、不标关系未判定）
      body.relation = { type: "new", target: null };
      bucket = "proposals";
    } else if (c.unreconciled || demotedDup || rel.type === "unsure" || (rel.type !== "new" && !relTarget)) {
      body.unreconciled = true;
      bucket = "unreconciled";
    } else if ((rel.type === "conflicts" || rel.type === "supersedes") && relTarget && relTarget.state === "active") {
      body.supersedes = relTarget.id; // 未确认的纠正：只标"有待确认的纠正"，不盖掉旧条目（§9.2）
      // 目标是 note 时保留候选自己的种类（§8.11.3 旧行为）；其他目标带详情的决定不强制改成目标种类
      if (relTarget.kind !== "note") {
        try {
          checkBodyField(relTarget.kind, c.body);
          checkAlternatives(relTarget.kind, c.alternatives);
          body.kind = relTarget.kind;
        } catch {
          // 保留候选自己的种类
        }
      }
      bucket = "corrections";
    } else {
      bucket = "proposals";
    }
    // 一条候选过不了写入口校验时只丢这一条（§8.11.3），不能拖垮整个窗口；被丢的不算进任何计数
    try {
      checkRememberBody(body);
    } catch {
      out.receipt.dropped.body_rejected = (out.receipt.dropped.body_rejected ?? 0) + 1;
      continue;
    }
    out.receipt[bucket]++;
    out.appends.push({ kind: "remember", project_id: pid, session_id: s.session_id, target_id: null, body });
    out.keys.push(c.key);
    out.legacyKeys.push(c.legacyKey);
  }
  return out;
}

// ---------- 主流程 ----------

function transcriptMtime(s: intake.SessionRow): number {
  if (s.host === "opencode") {
    const session = s.transcript ? opencodeSession(s.transcript) : null;
    if (!session) throw new Error("opencode session does not exist");
    return session.time_updated;
  }
  return statSync(resolveTranscript(s.transcript!)!).mtimeMs;
}

function settled(s: intake.SessionRow, now: Date): boolean {
  if (s.ended_at && s.ended_at >= s.last_touch) return true; // 结束后又有新 prompt（resume）就不算结束
  try {
    return now.getTime() - transcriptMtime(s) >= SETTLE_IDLE_MS;
  } catch {
    return false;
  }
}

async function extractWindow(deps: WorkDeps, c: Chunk, s: intake.SessionRow, projectId: string, receipt: intake.Receipt, worker = false): Promise<Admission> {
  if ("error" in deps.chat) throw new WorkFailure(deps.chat.error, deps.chat.message);
  if (!hasExtractableSignal(c.turns)) {
    receipt.no_signal += 1;
    return { appends: [], keys: [], legacyKeys: [], receipt: { proposals: 0, attached: 0, corrections: 0, unreconciled: 0, corroborated: 0, dropped: {} } };
  }
  const ctx = projectContext(deps, s.project, projectId);
  // §8.11.3：生成前给模型的已有记忆 = 会话项目 + 全局 + 窗口里出现名字或路径的已登记项目
  const mentioned = deps.registry
    .filter((e) => {
      const text = c.turns.map((t) => t.text).join("\n");
      return text.includes(e.name) || (e.path !== null && text.includes(e.path.replace(new RegExp(`^${homedir()}`), "~")));
    })
    .map((e) => deps.projectId(e.name));
  const neighbors = await prefetchNeighbors(deps, c.turns, [...new Set([projectId, ...mentioned])]);
  const win: ExtractWindow = { turns: c.turns, context: c.context, ...(worker ? { worker: true } : {}) };
  const messages = buildMessages(win, ctx, neighbors);
  const db = deps.store.workDb;
  let r = await deps.chat.chat(messages, { json: true });
  intake.spend(db, deps.now(), 1, r.tokens);
  receipt.tokens += r.tokens;
  let parsed = parseJsonLoose(r.message.content);
  if (!parsed) {
    messages.push({ role: "assistant", content: r.message.content ?? "" }, { role: "user", content: "上面的输出不是合法 JSON。只输出 JSON 对象。" });
    r = await deps.chat.chat(messages, { json: true });
    intake.spend(db, deps.now(), 1, r.tokens);
    receipt.tokens += r.tokens;
    parsed = parseJsonLoose(r.message.content);
    if (!parsed) throw new WorkFailure("invalid_output", "抽取输出两次都不是 JSON");
  }
  const v = validate(parsed, win, neighbors, c.id, ctx);
  if (deps.debugDir) dumpDebug(deps.debugDir, s, c, r.message.content ?? "", v);
  receipt.candidates += Array.isArray((parsed as any).candidates) ? (parsed as any).candidates.length : 0;
  for (const [k, n] of Object.entries(v.dropped)) receipt.dropped[k] = (receipt.dropped[k] ?? 0) + (n ?? 0);
  for (const [k, n] of Object.entries(v.evidenceDropped)) receipt.evidence_dropped[k] = (receipt.evidence_dropped[k] ?? 0) + (n ?? 0);
  const vecs = v.candidates.length
    // 去重看完整内容（§8.11.3）：同标题不同正文的候选不能因为标题向量相同被合并；向量输入与库里同口径截短
    ? await embedOrDefer(deps.embedder, v.candidates.map((x) => vectorTextOf(x.text, x.why, x.body)))
    : [];
  const merged = mergeSameWindow(v.candidates, vecs);
  receipt.merged += v.candidates.length - merged.length;
  // 每条候选单独复查已有条目（§9.4.4 → unreconciled）：
  // 没给模型看过的高相似近邻，说明邻居检查不完整；给模型看过、模型仍说 new，说明模型与向量意见相左。
  // 两种都不由向量自动合并，交给用户裁决（§21 2026-10-12）。
  // §8.11.3：归属解析成最终项目后，近邻去重和关系判定都在最终项目 + 全局里做
  const shown = new Set(neighbors.map((n) => n.id));
  const checked = merged.map(({ cand, vec }) => {
    const candProjectId = cand.project === "global" ? null : deps.projectId(cand.project);
    const hits = deps.store.nearestByVector(vec, candProjectId, RECHECK_TOP, DUP_CHECK_SIM);
    const handled = new Set([cand.relation.target].filter(Boolean));
    return {
      ...cand,
      unreconciled: hits.some((n) => !shown.has(n.prop.id)) || (cand.relation.type === "new" && hits.some((n) => !handled.has(n.prop.id))),
    };
  });
  return admit(checked, s, projectId, c.id, deps.store.project().props, r.model ?? deps.chat.model, deps.projectId);
}

function dumpDebug(dir: string, s: intake.SessionRow, c: Chunk, raw: string, v: ReturnType<typeof validate>): void {
  const body = {
    session: `${s.host}:${s.session_id}`,
    window: c.id,
    turns: c.turns.map((t, i) => ({ n: `#${i + 1}`, role: t.role, text: t.text })), // 已脱敏
    raw: sanitize(raw).text,
    dropped: v.dropped,
    evidenceDropped: v.evidenceDropped,
  };
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, `${s.host}-${s.session_id}-${c.id.slice(0, 12)}.json`), JSON.stringify(body, null, 1), { mode: 0o600 });
  } catch {
    /* 调试输出写不了不影响抽取 */
  }
}

/** 本次运行里补登记会话还能处理几个窗口（sweep 才有上限）。 */
interface Backlog {
  left: number;
}

const isBacklog = (s: intake.SessionRow) => s.via === "scan" || s.via === "backfill";

async function processSession(deps: WorkDeps, s: intake.SessionRow, opts: WorkOptions, report: WorkReport, holder: string, backlog: Backlog): Promise<void> {
  const db = deps.store.workDb;
  const now = deps.now();
  if (!s.ephemeral && s.project && !s.transcript) {
    // hook 来时 transcript 还没落盘（Codex 常见）：按 session id 再找一次
    const found = locateTranscript(s.host, s.session_id);
    const ok = found ? allowedTranscript(s.host, found, s.session_id) : null;
    if (ok) {
      if (!opts.dryRun) intake.setTranscript(db, s, ok); // dry-run 不写库，只在内存里继续
      s = { ...s, transcript: ok };
    }
  }
  if (s.ephemeral || !s.project || !s.transcript) {
    report.windows.skipped++;
    return;
  }
  if (deps.store.sessionPurged(s.session_id)) {
    if (!opts.dryRun) intake.setSessionError(db, s, "purged");
    report.windows.skipped++;
    return;
  }
  if (!deps.registry.some((e) => e.name === s.project)) {
    if (!opts.dryRun) intake.setSessionError(db, s, "unregistered_project");
    report.windows.skipped++;
    return;
  }
  // §7.6：每次读之前对所有宿主过准入，库里记的路径不算可信（登记后可能被换成目录外符号链接等）；不过关记 source_unavailable、进度不动
  const file = allowedTranscript(s.host, s.transcript, s.session_id);
  if (!file) {
    report.windows.skipped++;
    if (!opts.dryRun) intake.setSessionError(db, s, "source_unavailable");
    return;
  }
  // 不改写库里的 transcript：§7.6 第 1 条，capture_sessions.transcript 保持登记时的路径，下一次压缩/恢复也不失效
  let turns: Turn[];
  let stripped = 0;
  let worker = false;
  try {
    const cleaned = cleanTranscript(s.host, file);
    if (cleaned.subagent) {
      if (!opts.dryRun) intake.markEphemeral(db, s);
      report.windows.skipped++;
      return;
    }
    // 只去掉 ab-used 行、不删轮次：旧进度可能正停在只有这一行的回复上
    turns = cleaned.turns.map((t) => (t.role === "assistant" ? { ...t, text: stripAbUsed(t.text) } : t));
    stripped = cleaned.stripped;
    worker = cleaned.worker;
    // 旧版把 Claude 压缩摘要当成一轮，处理进度可能停在它上面；现在它被跳过，进度换成它前面那一轮（两种模式都适用）
    const a = s.processed_anchor;
    if (a !== null && cleaned.aliases?.has(a) && !turns.some((t) => t.anchor === a)) {
      const to = cleaned.aliases.get(a) ?? null;
      if (!opts.dryRun && !intake.remapCheckpoint(db, s, a, to)) return; // 别的进程刚推进过，下次再说；预览只在内存里换
      s = { ...s, processed_anchor: to };
    }
  } catch {
    if (!opts.dryRun) intake.setSessionError(db, s, "source_unavailable");
    return;
  }
  if (!opts.dryRun && s.error_code === "source_unavailable") intake.setSessionError(db, s, null);
  const hitsByAnchor = new Map<string, Record<string, number>>();
  turns = turns.map((t) => {
    const r = sanitize(t.text);
    hitsByAnchor.set(t.anchor, r.hits as Record<string, number>);
    return { ...t, text: r.text };
  });
  if (!opts.dryRun && s.processed_anchor && intake.deferredWindows(db, s.host, s.session_id).length) {
    // 清理“进度已越过”的旧延后行。上面的进度来自启动时读的会话列表，可能已经过时（旧进程暂停期间另一进程接管租约、
    // --redo 后重新延后）。所以租约和当前进度都在短写事务里重读再判；租约已不在自己手里就抛错中止，一个行也不改。
    db.exec("BEGIN IMMEDIATE");
    try {
      holdsLease(db, holder, deps.now());
      const behind = intake.sessions(db, { host: s.host, session_id: s.session_id })[0]?.processed_anchor;
      if (behind) {
        for (const w of intake.deferredWindows(db, s.host, s.session_id)) {
          if (progressPassed(s.host, turns, behind, w.to_anchor)) intake.failSuperseded(db, w.window_id, deps.now());
        }
      }
      db.exec("COMMIT");
    } catch (e) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw e;
    }
  }
  if (deps.topic && s.host !== "opencode" && s.host !== "agy") return processTopicSession(deps, deps.topic, s, turns, stripped, hitsByAnchor, worker, opts, report, holder, backlog);
  const chunks = chunk(s.host, s.session_id, turns, s.processed_anchor, settled(s, now), intake.sessionCuts(db, s.host, s.session_id));
  if (chunks === "anchor_missing") {
    if (!opts.dryRun) intake.setSessionError(db, s, "source_unavailable");
    return;
  }
  if (opts.dryRun) {
    report.dry.push({ session: `${s.host}:${s.session_id}`, windows: chunks.length, chars: chunks.reduce((n, c) => n + c.chars, 0) });
    return;
  }
  const projectId = deps.projectId(s.project!);
  let row = s;
  const capped = opts.sweep && isBacklog(s);
  if (capped && chunks.length && backlog.left <= 0) {
    report.backlogLeft++;
    return;
  }
  for (const c of chunks.slice(0, MAX_WINDOWS_PER_SESSION_RUN)) {
    const prev = intake.getWindow(db, c.id);
    // 旧版日预算留下的 budget_exhausted 延后已无意义，立即重做
    if (prev?.state === "deferred" && prev.error_code !== "budget_exhausted" && !intake.deferDue(prev, deps.now())) break;
    if (capped && backlog.left <= 0) {
      report.backlogLeft++;
      break;
    }
    if (capped) backlog.left--;
    const receipt = intake.emptyReceipt();
    receipt.turns = c.turns.length;
    receipt.chars = c.chars;
    receipt.truncated = c.truncated;
    receipt.stripped = row.processed_anchor === null ? stripped : 0; // 去噪计数是整份 transcript 的，只记在首个窗口
    for (const t of c.turns) addHits(receipt.sanitizer, hitsByAnchor.get(t.anchor) ?? {});
    let adm: Admission;
    try {
      adm = await extractWindow(deps, c, row, projectId, receipt, worker);
    } catch (e) {
      const code: WorkError = e instanceof WorkFailure ? e.code : "network";
      // 密钥失效（401/403）和没配密钥一样：重试没用，不计失败次数，否则所有窗口 4 次后都被永久跳过（§12.6.6）
      const config = code === "no_config" || code === "no_key" || authFailed(e);
      // 额度/限流不算一次失败尝试：额度要几小时才恢复，不能因此把窗口判成失败、跳过这段内容
      const limited = code === "http_429";
      const after = e instanceof WorkFailure ? e.retryAfterMs : undefined;
      const until = limited && typeof after === "number" ? new Date(deps.now().getTime() + after) : undefined;
      const detail = failureDetail(e);
      problem(report, "窗口", `${row.host}:${row.session_id.slice(0, 8)} ${c.chars} 字 ${code}: ${detail}`);
      const terminal = intake.deferWindow(db, row, c, code, deps.now(), !config && !limited, until, detail);
      if (terminal) {
        // 用完重试次数：够大就对半拆开各自重试，不直接跳过这段内容；拆到不能再拆仍失败才是终态
        const at = splitPoint(c);
        if (at) {
          intake.splitWindow(db, row, c, at, detail, deps.now());
          report.split++;
          return processSession(deps, row, opts, report, holder, backlog);
        }
        deps.store.commit([], (tx) => intake.finishWindow(tx, row, c, "failed", code, receipt, deps.now(), detail));
        report.windows.failed++;
        row = { ...row, processed_anchor: c.to };
        continue;
      }
      report.windows.deferred++;
      break;
    }
    const fresh = intake.freshAdmissions(db, adm.keys, adm.legacyKeys);
    const appends = adm.appends.filter((_, i) => fresh[i]);
    const keys = adm.keys.filter((_, i) => fresh[i]);
    // receipt.dropped 已在前面累加了抽取自己的丢弃原因，这里只并入准入阶段的，不能整体覆盖
    const { dropped: admDropped, ...admReceipt } = adm.receipt;
    Object.assign(receipt, admReceipt);
    for (const [k, n] of Object.entries(admDropped)) receipt.dropped[k] = (receipt.dropped[k] ?? 0) + n;
    deps.store.commit(appends, (tx, ids) => {
      intake.recordCandidates(tx, keys.map((key, i) => ({ key, event_id: ids[i], window_id: c.id })));
      intake.finishWindow(tx, row, c, "done", null, receipt, deps.now());
    });
    intake.addReceipt(report.receipt, receipt);
    intake.setMeta(db, "last_success", deps.now().toISOString());
    report.windows.done++;
    row = { ...row, processed_anchor: c.to };
    intake.renewLease(db, holder, deps.now());
  }
}

// ---------- 话题结束时一步式沉淀（§8.6） ----------

const emptyAdmission = (): Admission => ({ appends: [], keys: [], legacyKeys: [], receipt: { proposals: 0, attached: 0, corrections: 0, unreconciled: 0, corroborated: 0, dropped: {} } });

/**
 * 写库事务里确认租约还在自己手里（顺便续期）。租约过期被别人接管（如 ab work --undo、另一个 ab work）后，
 * 暂停后恢复的旧进程不能再往库里写：抛错回滚整个窗口的写入。
 */
function holdsLease(tx: DatabaseSync, holder: string, now: Date): void {
  if (!intake.renewLease(tx, holder, now)) throw new Error("工作租约已被接管，本窗口不写库");
}

/** 本次运行里已经撞上额度/限流的宿主：同一次运行不再给它发请求（窗口照常延后，到时再跑）。 */
const hostCooldown = new WeakMap<TopicDeps, Map<Host, string>>();

async function processTopicSession(
  deps: WorkDeps,
  t: TopicDeps,
  s: intake.SessionRow,
  turns: Turn[],
  stripped: number,
  hitsByAnchor: Map<string, Record<string, number>>,
  worker: boolean,
  opts: WorkOptions,
  report: WorkReport,
  holder: string,
  backlog: Backlog,
): Promise<void> {
  const db = deps.store.workDb;
  const now = deps.now();
  const ended = !!(s.ended_at && s.ended_at >= s.last_touch); // 结束后又有新 prompt（resume）就不算结束
  let idleTail = false;
  try {
    idleTail = now.getTime() - transcriptMtime(s) >= TOPIC_IDLE_MS;
  } catch {
    idleTail = false;
  }
  const cut = topicChunks(s.host, s.session_id, turns, s.processed_anchor, { marks: topicMarks(db, s.host, s.session_id), ended, idleTail });
  if (cut === "anchor_missing") {
    if (!opts.dryRun) intake.setSessionError(db, s, "source_unavailable");
    return;
  }
  if (opts.dryRun) {
    report.dry.push({ session: `${s.host}:${s.session_id}`, windows: cut.chunks.length, chars: cut.chunks.reduce((n, c) => n + c.chars, 0) });
    return;
  }
  bindTopicMarks(db, s.host, s.session_id, cut.bindings);
  const projectId = deps.projectId(s.project!);
  let row = s;
  const capped = opts.sweep && isBacklog(s);
  if (capped && cut.chunks.length && backlog.left <= 0) {
    report.backlogLeft++;
    return;
  }
  let cooldown = hostCooldown.get(t);
  if (!cooldown) hostCooldown.set(t, (cooldown = new Map()));
  for (const c of cut.chunks.slice(0, MAX_WINDOWS_PER_SESSION_RUN)) {
    const prev = intake.getWindow(db, c.id);
    if (prev?.state === "deferred" && prev.error_code !== "budget_exhausted" && !intake.deferDue(prev, deps.now())) break;
    const cool = cooldown.get(s.host) ?? intake.meta(db, `topic_cooldown:${s.host}`);
    if (cool && !intake.cooldownDue(cool, deps.now())) {
      report.windows.deferred++;
      break;
    }
    if (capped && backlog.left <= 0) {
      report.backlogLeft++;
      break;
    }
    if (capped) backlog.left--;
    const receipt = intake.emptyReceipt();
    receipt.turns = c.turns.length;
    receipt.chars = c.chars;
    receipt.truncated = c.truncated;
    receipt.stripped = row.processed_anchor === null ? stripped : 0;
    for (const x of c.turns) addHits(receipt.sanitizer, hitsByAnchor.get(x.anchor) ?? {});
    const wr: TopicWindowReport = {
      window_id: c.id,
      session: `${s.host}:${s.session_id}`,
      trigger: c.trigger,
      part: c.part,
      from: c.from,
      to: c.to,
      turns: c.turns.length,
      chars: c.chars,
      model: "",
      prompt_version: PROMPT_VERSION,
      ms: 0,
      outcome: "done",
      created: [],
      merges: [],
      skipped_known: 0,
    };
    const saveReport = () => {
      if (!report.topic) return;
      const i = report.topic.windows.findIndex((w) => w.window_id === wr.window_id);
      if (i >= 0) report.topic.windows[i] = wr;
      else report.topic.windows.push(wr);
      try {
        t.save?.(report.topic);
      } catch {
        /* 报告写不了不影响写库；撤销以 L1 为准（body.topic.run） */
      }
    };
    let adm: Admission & { meta: Map<string, TopicWindowReport["created"][number]> };
    try {
      adm = await onePassWindow(deps, t, c, row, projectId, receipt, worker, holder, wr);
    } catch (e) {
      const code: WorkError = e instanceof WorkFailure ? e.code : "network";
      const config = code === "no_config" || code === "no_key" || authFailed(e);
      // 额度/限流不算一次失败尝试：额度用完要等几小时，不能因此把话题判成终态失败丢掉（§8.6 第 6 点）
      const limited = code === "http_429";
      const after = e instanceof WorkFailure ? e.retryAfterMs : undefined;
      const until = limited && typeof after === "number" ? new Date(deps.now().getTime() + after) : undefined;
      if (limited) {
        // 记到 work_meta：之后几次 ab work（别的会话、下一轮 hook 拉起的）在恢复前也不再给这个宿主发请求。
        // 截止时间与窗口延后共用一个封顶：429 报的“八天后重置”不能把这个宿主锁住几天；没给重试时间时按一分钟试
        const cap = deps.now().getTime() + intake.MAX_DEFER_MS;
        const wanted = until?.getTime() ?? deps.now().getTime() + 60_000;
        const iso = new Date(Math.min(wanted, cap)).toISOString();
        cooldown.set(s.host, iso);
        intake.setMeta(db, `topic_cooldown:${s.host}`, iso);
      }
      const detail = failureDetail(e);
      problem(report, "窗口", `${row.host}:${row.session_id.slice(0, 8)} ${c.chars} 字 ${code}: ${detail}`);
      const terminal = intake.deferWindow(db, row, c, code, deps.now(), !config && !limited, until, detail);
      wr.error = sanitize(`${code}: ${(e as Error).message ?? ""}`).text.slice(0, 300);
      wr.outcome = terminal ? "failed" : "deferred";
      saveReport();
      if (terminal) {
        deps.store.commit([], (tx) => {
          holdsLease(tx, holder, deps.now());
          intake.finishWindow(tx, row, c, "failed", code, receipt, deps.now(), detail);
        });
        report.windows.failed++;
        row = { ...row, processed_anchor: c.to };
        continue;
      }
      report.windows.deferred++;
      break;
    }
    const fresh = intake.freshAdmissions(db, adm.keys, adm.legacyKeys);
    const appends = adm.appends.filter((_, i) => fresh[i]);
    const keys = adm.keys.filter((_, i) => fresh[i]);
    wr.skipped_known = adm.keys.length - keys.length;
    // receipt.dropped 已在前面累加了抽取自己的丢弃原因，这里只并入准入阶段的，不能整体覆盖
    const { dropped: admDropped, ...admReceipt } = adm.receipt;
    Object.assign(receipt, admReceipt);
    for (const [k, n] of Object.entries(admDropped)) receipt.dropped[k] = (receipt.dropped[k] ?? 0) + n;
    const ids = deps.store.commit(appends, (tx, ids) => {
      holdsLease(tx, holder, deps.now());
      intake.recordCandidates(tx, keys.map((key, i) => ({ key, event_id: ids[i], window_id: c.id })));
      intake.finishWindow(tx, row, c, "done", null, receipt, deps.now());
    });
    keys.forEach((k, i) => {
      const m = adm.meta.get(k);
      if (m) wr.created.push({ ...m, id: ids[i] });
    });
    saveReport();
    intake.addReceipt(report.receipt, receipt);
    intake.setMeta(db, "last_success", deps.now().toISOString());
    report.windows.done++;
    row = { ...row, processed_anchor: c.to };
    intake.renewLease(db, holder, deps.now());
  }
}

/**
 * 一个话题窗口：宿主子模型读话题 + 背景 + 《好记忆的标准》 + 附近已有记忆，一次给出 new / merge / 不记。
 * new 直接写正式库（未确认、origin=extract、可撤销）；merge 不改目标、不写库，只进运行报告（见 §8.6 实现说明）。
 */
async function onePassWindow(
  deps: WorkDeps,
  t: TopicDeps,
  c: TopicChunk,
  s: intake.SessionRow,
  projectId: string,
  receipt: intake.Receipt,
  worker: boolean,
  holder: string,
  wr: TopicWindowReport,
): Promise<Admission & { meta: Map<string, TopicWindowReport["created"][number]> }> {
  const meta = new Map<string, TopicWindowReport["created"][number]>();
  if (!hasExtractableSignal(c.turns)) {
    receipt.no_signal += 1;
    wr.outcome = "no_signal";
    return { ...emptyAdmission(), meta };
  }
  const chat = t.chatFor(s.host);
  if ("error" in chat) throw new WorkFailure(chat.error, chat.message);
  wr.model = chat.model;
  const neighbors = await prefetchNeighbors(deps, c.turns, [projectId]);
  const win: ExtractWindow = { turns: c.turns, context: c.context, ...(worker ? { worker: true } : {}) };
  const messages = buildOnePassMessages(win, projectContext(deps, s.project, projectId), neighbors);
  const db = deps.store.workDb;
  const beat = setInterval(() => intake.renewLease(db, holder, deps.now()), TOPIC_HEARTBEAT_MS);
  beat.unref?.();
  const t0 = Date.now();
  let r;
  try {
    r = await chat.chat(messages, { json: true });
  } finally {
    clearInterval(beat);
    wr.ms = Date.now() - t0;
  }
  intake.spend(db, deps.now(), 1, r.tokens);
  receipt.tokens += r.tokens;
  const parsed = parseOnePass(r.message.content, neighbors);
  if (!parsed) throw new WorkFailure("invalid_output", "一步式输出不是合法 JSON（缺 items 数组）");
  const invalidN = Object.values(parsed.invalid).reduce((a, b) => a + (b ?? 0), 0);
  receipt.candidates += parsed.items.length + invalidN;
  for (const [k, n] of Object.entries(parsed.invalid)) receipt.dropped[k] = (receipt.dropped[k] ?? 0) + (n ?? 0);
  if (invalidN) wr.invalid = parsed.invalid as Record<string, number>;
  const props = deps.store.project().props;
  for (const it of parsed.items.filter((x) => x.action === "merge")) {
    const target = props.get(it.into!);
    wr.merges.push({ into: it.into!, into_confirmed_by_user: target?.confirmed_by === "user", text: sanitize(it.text).text, reason: sanitize(it.reason).text });
  }
  const news = parsed.items.filter((x) => x.action === "new").map((it) => ({ ...it, text: sanitize(it.text).text, scenario: sanitize(it.scenario).text, why: it.why ? sanitize(it.why).text : null, reason: sanitize(it.reason).text }));
  const vecs = news.length ? await embedOrDefer(deps.embedder, news.map((x) => x.text)) : [];
  const out = emptyAdmission();
  const kept: Float32Array[] = [];
  const lastTs = [...c.turns].reverse().find((x) => x.ts)?.ts;
  const prov: Omit<TopicProvenance, "class"> = { run: t.run, window_id: c.id, trigger: c.trigger, from: c.from, to: c.to, part: c.part };
  news.forEach((it, i) => {
    // 同一窗口两条讲同一件事只留第一条
    if (kept.some((v) => cosine(v, vecs[i]) >= SAME_WINDOW_DUP_SIM)) {
      receipt.merged++;
      return;
    }
    kept.push(vecs[i]);
    // 模型说 new，但库里有高相似条目（不论模型看没看过）：不由向量自动合并，标关系未判定交给用户（§9.4.4，与抽取器同规则）
    const hits = deps.store.nearestByVector(vecs[i], projectId, RECHECK_TOP, DUP_CHECK_SIM);
    const unreconciled = hits.length > 0;
    const body: RememberBody = {
      model: r.model ?? chat.model,
      prompt_version: PROMPT_VERSION,
      kind: it.kind,
      text: it.text,
      ...(it.why ? { why: it.why } : {}),
      trigger: it.scenario,
      source: {
        host: s.host,
        session_id: s.session_id,
        transcript: s.transcript,
        anchor: c.to,
        summary: `话题沉淀（ab work，${c.trigger}）：${it.scenario}`.slice(0, 120),
      },
      confirmed: false,
      origin: "extract",
      // 一步式输出没有逐字引文（eval 07 的原提示词和 §8.7 的 V1 都不要引文），不能声称"用户原话"：一律记 agent 推断
      basis: "agent_inference",
      evidence: [],
      window_id: c.id,
      relation: { type: "new", target: null },
      ...(lastTs ? { said_at: lastTs } : {}),
      ...(it.guidance ? { guidance: true } : {}),
      value: { scenario: it.scenario, flags: [] },
      topic: { ...prov, class: it.class },
      ...(unreconciled ? { unreconciled: true } : {}),
    };
    const key = sha256(`${c.id}|${it.kind}|${it.text.replace(/\s+/g, " ").trim()}`);
    out.appends.push({ kind: "remember", project_id: projectId, session_id: s.session_id, target_id: null, body });
    out.keys.push(key);
    out.legacyKeys.push(undefined);
    meta.set(key, { id: "", kind: it.kind, text: it.text, scenario: it.scenario, reason: it.reason, unreconciled });
    if (unreconciled) out.receipt.unreconciled++;
    else out.receipt.proposals++;
  });
  return { ...out, meta };
}

/**
 * 待判关系的条目：自动沉淀、未确认、active、还没判过，且有余弦 ≥ RELATE_SIM 的近邻。
 * 每对只从一侧判：近邻须比它早，或是已确认 / 非自动沉淀（这些自己不会被判）。
 */
export function relateTodo(store: Store): RelateItem[] {
  const props = [...store.project().props.values()]
    // 话题沉淀写的条目不进关系判定：判成重复会给旧条目追加来源并归档本条，这一步整次撤销撤不回（§8.6 第 12 点）；它们和库里高相似时已标"关系未判定"交给用户
    .filter((p) => p.state === "active" && p.origin === "extract" && !p.confirmed && !p.related && !p.topic_run)
    .sort((a, b) => a.seq - b.seq);
  const items: RelateItem[] = [];
  for (const p of props) {
    const ns = store.neighbors(p.id);
    if (!ns) continue;
    const near = ns.filter((n) => n.similarity >= RELATE_SIM && (n.prop.seq < p.seq || n.prop.confirmed || n.prop.origin !== "extract"));
    if (near.length) items.push({ prop: p, neighbors: near.slice(0, RELATE_TOP).map((n) => n.prop) });
  }
  return items;
}

/** 关系判定第 2 层：重复 → 来源并入旧条目并归档本条（可 reactivate 撤销）；补充 / 无关 → 解除关系未判定；冲突 → 待确认纠正；拿不准 → 照旧。 */
async function relatePass(deps: WorkDeps, report: WorkReport, holder: string): Promise<void> {
  if ("error" in deps.chat || !deps.embedder) return;
  const db = deps.store.workDb;
  try {
    await deps.store.syncVectors(deps.embedder, deps.embedder.model!);
  } catch (e) {
    report.relate.errors++;
    problem(report, "关系判定", `向量没更新，这一轮没判: ${failureDetail(e)}`);
    return;
  }
  const todo = relateTodo(deps.store);
  for (let i = 0, calls = 0; i < todo.length && calls < MAX_RELATE_CALLS_PER_RUN; i += RELATE_BATCH, calls++) {
    const batch = todo.slice(i, i + RELATE_BATCH);
    let verdicts;
    // 关系判定可能落到备用渠道：记下这一批真正回话的模型名
    let model = deps.chat.model;
    try {
      const r = await deps.chat.chat(buildRelateMessages(batch), { json: true });
      if (r.model) model = r.model;
      intake.spend(db, deps.now(), 1, r.tokens);
      verdicts = parseRelate(parseJsonLoose(r.message.content), batch);
    } catch (e) {
      report.relate.errors++;
      problem(report, "关系判定", `${batch.length} 条这一批没判（${batch.map((b) => b.prop.id.slice(0, 8)).join("、")}）: ${failureDetail(e)}`);
      break;
    } finally {
      intake.renewLease(db, holder, deps.now());
    }
    for (let k = 0; k < batch.length; k++) {
      const v = verdicts[k];
      if (!v) {
        report.relate.errors++;
        problem(report, "关系判定", `[${batch[k].prop.id.slice(0, 8)}] 模型的回复里没有这一条的结论`);
        continue;
      }
      // 同一批里前面的结论可能已经归档了本条或目标：以当前投影为准，目标不在了就留到下次
      const props = deps.store.project().props;
      const p = props.get(batch[k].prop.id);
      const target = v.target ? props.get(v.target.id) : null;
      // 同一次运行里前面的并入可能已让本条被印证转正：已确认的条目一律不再自动改
      if (!p || p.state !== "active" || p.confirmed || p.related || (v.target && target?.state !== "active")) continue;
      const { appends, corroborated, outcome } = applyVerdict(p, target ?? null, v, model, {
        mode: "absorb-new",
        corroborate: (np, t, basis) => corroborationConfirm(t, { source: np.source, basis, evidence: np.evidence }),
      });
      if (corroborated) report.relate.corroborated++;
      deps.store.commit(appends, () => {});
      report.relate[outcome]++;
    }
  }
}

/** 这次改动之前留下的「证据不足」没有次数，按已经重复过算，等满 8 天。 */
function inconclusiveTries(outcome: string): number {
  if (outcome === "inconclusive") return VERIFY_BACKOFF_DAYS.length;
  return Number(/^inconclusive:(\d+)$/.exec(outcome)?.[1] ?? 0);
}

function verifyWaitMs(outcome: string): number {
  const n = inconclusiveTries(outcome);
  const days = VERIFY_BACKOFF_DAYS[Math.min(Math.max(n, 1), VERIFY_BACKOFF_DAYS.length) - 1];
  return days * 86_400_000;
}

/** 没出错的核验还要不要再花一次（§12.6.12）。出错的不跳过。 */
export function skipVerify(last: { head: string; outcome: string; at: string } | undefined, head: string, now: Date): boolean {
  if (!last || last.outcome.startsWith("error:")) return false;
  if (last.outcome === "not_verifiable" || last.outcome.startsWith("not_verifiable:")) return true;
  if (last.head === head) return true;
  if (last.outcome === "inconclusive" || last.outcome.startsWith("inconclusive:")) return now.getTime() - Date.parse(last.at) < verifyWaitMs(last.outcome);
  return now.getTime() - Date.parse(last.at) < VERIFY_RECHECK_MS;
}

/** 记下这次没结论的结果，次数加一。无法核验不记次数。 */
export function nextVerifyOutcome(previous: string | undefined, verdict: string): string {
  if (verdict !== "inconclusive") return verdict;
  const prev = previous && (previous === "inconclusive" || previous.startsWith("inconclusive:")) ? inconclusiveTries(previous) : 0;
  return `inconclusive:${prev + 1}`;
}

function seenVerify(db: DatabaseSync, id: string): boolean {
  const last = intake.lastVerify(db, id);
  return !!last && !last.outcome.startsWith("error:");
}

/** 按代码核验：只核验项目范围、未确认、可由代码证明的种类（坑、事实），且不是待确认的纠正。 */
async function verifyPass(deps: WorkDeps, report: WorkReport, holder: string): Promise<void> {
  if ("error" in deps.chat) return;
  const baseChat = deps.chat;
  const db = deps.store.workDb;
  const names = new Map(deps.store.listProjects().map((p) => [p.id, p.name]));
  const queued = intake.queuedReverify(db);
  const all = [...deps.store.project().props.values()];
  // 召回时引文核对失败的条目（已按代码确认过）排在最前，重新核验
  const requeued = all.filter((p) => queued.has(p.id) && p.state === "active" && p.project_id !== null && !!p.code_evidence && !p.stale);
  for (const id of queued) if (!requeued.some((p) => p.id === id)) intake.dequeueReverify(db, id);
  const todo = [
    ...requeued.sort((a, b) => a.seq - b.seq),
    ...all
      .filter((p) => p.state === "active" && !p.confirmed && !p.demoted && p.project_id !== null && CODE_VERIFIABLE.has(p.kind) && !p.unreconciled && !p.supersedes && !p.stale)
      // 从没核过（或上次只是出错）的排前面，别让反复重核的旧条目占住每次 3 条的名额
      .sort((a, b) => Number(seenVerify(db, a.id)) - Number(seenVerify(db, b.id)) || a.seq - b.seq),
  ];
  let done = 0;
  for (const p of todo) {
    if (done >= MAX_VERIFY_PER_RUN) break;
    const entry = deps.registry.find((e) => e.name === names.get(p.project_id!));
    if (!entry?.path || !existsSync(entry.path)) continue;
    const tools = new RepoTools(entry.path);
    const head = tools.head();
    if (!head) continue;
    const last = intake.lastVerify(db, p.id);
    if (queued.has(p.id)) {
      // 这个 HEAD 上已经有过确定结论，不重复花钱；上次是出错（限流/网络）的照样重试
      if (last && last.head === head && !last.outcome.startsWith("error:")) {
        intake.dequeueReverify(db, p.id);
        continue;
      }
    } else if (skipVerify(last, head, deps.now())) continue;
    done++;
    let result;
    // 核验可能落到备用渠道：记下最后一次真正回话的模型名
    let usedModel = baseChat.model;
    const chatOf: Chat = async (messages, opts) => {
      const r = await baseChat.chat(messages, opts);
      if (r.model) usedModel = r.model;
      return r;
    };
    try {
      result = await verifyProposition(chatOf, tools, p);
    } catch (e) {
      intake.recordVerify(db, p.id, head, `error:${e instanceof WorkFailure ? e.code : "network"}`, deps.now());
      report.verify.errors++;
      problem(report, "代码核验", `[${p.id.slice(0, 8)}] ${e instanceof WorkFailure ? e.code : "network"}: ${failureDetail(e)}`);
      // 额度用完：后面的条目也会撞上，本轮停下，下次 ab work 从这条接着核验
      if (e instanceof WorkFailure && e.code === "http_429") break;
      continue;
    } finally {
      intake.renewLease(db, holder, deps.now());
    }
    // 核验有了结果才出队；出错时留在队里，下次 ab work 再试
    intake.dequeueReverify(db, p.id);
    intake.spend(db, deps.now(), result.rounds, result.tokens);
    report.verify[result.verdict]++;
    if (result.verdict === "verified" || result.verdict === "contradicted") {
      const body: VerifyBody = { outcome: result.verdict, head, refs: result.refs, model: usedModel, prompt_version: VERIFY_PROMPT_VERSION };
      deps.store.commit([{ kind: "verify", project_id: p.project_id, session_id: null, target_id: p.id, body }], (tx) =>
        intake.recordVerify(tx, p.id, head, result.verdict, deps.now()),
      );
    } else {
      intake.recordVerify(db, p.id, head, nextVerifyOutcome(last?.outcome, result.verdict), deps.now());
    }
  }
}

export async function runWork(deps: WorkDeps, opts: WorkOptions): Promise<WorkReport> {
  const report: WorkReport = {
    busy: false,
    scanned: 0,
    windows: { done: 0, deferred: 0, failed: 0, skipped: 0 },
    backlogLeft: 0,
    receipt: intake.emptyReceipt(),
    verify: { verified: 0, contradicted: 0, not_verifiable: 0, inconclusive: 0, errors: 0 },
    relate: { duplicate: 0, refines: 0, conflicts: 0, unrelated: 0, unsure: 0, corroborated: 0, errors: 0 },
    dry: [],
    split: 0,
    problems: [],
    ...(deps.topic ? { topic: { run: deps.topic.run, at: deps.now().toISOString(), windows: [] } } : {}),
  };
  const db = deps.store.workDb;
  const holder = opts.dryRun ? "dry-run" : intake.acquireLease(db, deps.now());
  if (!holder) {
    report.busy = true;
    return report;
  }
  try {
    const agy = agyDiscover(agyRoots(), deps.now(), (id) => intake.knownSession(db, "agy", id));
    const conflictIds = new Set(agy.conflicts.map((c) => c.id));
    for (const c of agy.conflicts) report.problems.push(`agy 会话 ${c.id} 在多处有完整日志，已跳过：${c.roots.join("，")}`);
    for (const p of agy.problems) {
      let detail = p.kind === "no_summaries" ? "0 对话，尚无摘要库" : p.kind === "missing_meta" ? `缺会话元数据（${p.count} 份完整日志）` : "无法读取";
      if (p.kind === "unreadable") {
        if (p.count) detail += `（${p.count} 份完整日志）`;
        if (p.summariesUnreadable) detail += "，摘要库无法读取";
      }
      report.problems.push(`agy ${p.root}：${detail}`);
    }
    if (opts.sweep && !opts.dryRun) {
      intake.reclassifyScanned(db, (t) => sessionStart(t));
      report.scanned = scan(deps, agy);
    }
    if (opts.redo && opts.session && !opts.dryRun
        && !(opts.session.host === "agy" && conflictIds.has(opts.session.session_id))) {
      intake.resetSession(db, opts.session.host, opts.session.session_id);
    }
    // hook / 手动登记的会话先处理；扫描补登记的排后面，并受 BACKLOG_WINDOWS_PER_SWEEP 限制
    // 单会话运行（hook 拉起）也顺带重试别的会话里已到期的延后窗口：launchd 没开时它们没有别的机会重跑
    const list = opts.session ? [...intake.sessions(db, opts.session), ...intake.dueDeferredSessions(db, deps.now(), opts.session)] : intake.sessions(db);
    const ordered = [...list.filter((x) => !isBacklog(x)), ...list.filter(isBacklog)];
    const backlog: Backlog = { left: BACKLOG_WINDOWS_PER_SWEEP };
    for (const s of ordered) {
      if (s.host === "agy" && conflictIds.has(s.session_id)) continue;
      await processSession(deps, s, opts, report, holder, backlog);
    }
    if (!opts.dryRun) await relatePass(deps, report, holder);
    if (opts.sweep && !opts.dryRun) {
      await verifyPass(deps, report, holder);
      intake.prune(db, deps.now());
      pruneTopicMarks(db, deps.now());
    }
    if (!opts.dryRun) {
      pruneTelemetry(db, deps.now());
      intake.setMeta(db, "last_run", deps.now().toISOString());
    }
  } finally {
    if (!opts.dryRun) intake.releaseLease(db, holder);
  }
  return report;
}
