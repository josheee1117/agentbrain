/**
 * 切片 3 后台 worker（设计 §19.3 关闭形态）：`ab work` 是短命进程，单实例租约。
 * 会话坐标由 `ab capture` 登记；本文件切窗口 → 去噪 → 脱敏 → 抽取 → 校验 → 近邻复查 → 准入 → 一个事务写 L1。
 * 另做三件定期事：按代码核验未确认的坑/事实、跨会话印证、过期提议归档。
 */
import { closeSync, existsSync, mkdirSync, openSync, writeFileSync, readdirSync, readFileSync, readSync, realpathSync, statSync, type Dirent } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { VEC_MIN_SIM, type Store, type Embedder, type PendingAppend } from "./store.ts";
import type { Basis, ConfirmBody, EvidenceBody, Host, Proposition, RememberBody, SourcePointer, VerifyBody } from "./l2.ts";
import { applyVerdict, buildRelateMessages, parseRelate, type RelateItem, type RelateOutcome } from "./relate.ts";
import { WorkFailure, parseJsonLoose, type Chat, type WorkError } from "./llm.ts";
import { addHits, sanitize } from "./sanitize.ts";
import { cleanTranscript, isCodexSubagent, type Turn } from "./transcript.ts";
import { locateTranscript } from "./host.ts";
import { buildMessages, KIND_FOR_BASIS, MAX_EVIDENCE, validate, type Candidate, type ExtractWindow, type ProjectContext } from "./extract.ts";
import { RepoTools, verifyProposition } from "./codeverify.ts";
import * as intake from "./intake.ts";
import type { RegistryEntry } from "./registry.ts";

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
}

// ---------- 会话登记 ----------

const TRANSCRIPT_ROOTS: Record<Host, string[]> = {
  claude: [".claude/projects"],
  codex: [".codex/sessions", ".codex/archived_sessions"],
  pi: [".pi/agent/sessions"],
};

/** transcript 必须在该宿主自己的会话目录下、以 .jsonl 结尾：防止借 capture 把任意文件送出本机。 */
export function allowedTranscript(host: Host, path: string): string | null {
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    real = resolve(path); // Claude 的 transcript 可能晚于第一次 hook 才落盘
  }
  if (!real.endsWith(".jsonl")) return null;
  const ok = TRANSCRIPT_ROOTS[host].some((r) => {
    const root = join(homedir(), r);
    let rootReal = root;
    try {
      rootReal = realpathSync(root);
    } catch {
      /* 目录不存在时按字面比较 */
    }
    return real.startsWith(rootReal + sep);
  });
  return ok ? real : null;
}

/** Pi 文件名是 <时间>_<session id>.jsonl。 */
export function piSessionId(file: string): string | null {
  const m = /_([^_/]+)\.jsonl$/.exec(file);
  return m ? m[1] : null;
}

function headLines(file: string): any[] {
  const buf = Buffer.alloc(SCAN_HEAD_BYTES);
  let n = 0;
  try {
    const fd = openSync(file, "r");
    try {
      n = readSync(fd, buf, 0, SCAN_HEAD_BYTES, 0);
    } finally {
      closeSync(fd);
    }
  } catch {
    return [];
  }
  return buf.subarray(0, n).toString("utf8").split("\n").slice(0, 50).flatMap((l) => {
    try {
      return [JSON.parse(l)];
    } catch {
      return [];
    }
  });
}

/** 会话开始时间：头部第一条带 timestamp 的记录；没有就用文件创建时间。 */
export function sessionStart(file: string, head: any[] = headLines(file)): number | null {
  for (const e of head) {
    const t = typeof e?.timestamp === "string" ? e.timestamp : typeof e?.payload?.timestamp === "string" ? e.payload.timestamp : null;
    const ms = t ? Date.parse(t) : NaN;
    if (Number.isFinite(ms)) return ms;
  }
  try {
    const st = statSync(file);
    return st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs;
  } catch {
    return null;
  }
}

function walk(dir: string, depth: number, out: string[]): void {
  let ents: Dirent[];
  try {
    ents = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of ents) {
    const p = join(dir, e.name);
    if (e.isDirectory() && depth > 0) walk(p, depth - 1, out);
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
  }
}

/** 兜底：hook 没触发（Codex 未信任等）时，从三宿主会话目录补登记 cwd 落在已登记项目里的近期会话。 */
export function scan(deps: WorkDeps): number {
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
    walk(join(homedir(), rel), depth, files);
    for (const f of files) {
      let mtime: number;
      try {
        mtime = statSync(f).mtimeMs;
      } catch {
        continue;
      }
      if (mtime < since) continue;
      const id =
        host === "claude" ? f.split(sep).pop()!.replace(/\.jsonl$/, "")
        : host === "codex" ? (/-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(f)?.[1] ?? null)
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

/** 从 checkpoint 之后按轮次边界切块，每块 ≤ WINDOW_MAX_CHARS；单轮超长时截断并计数（不静默）。 */
export function chunk(host: Host, sessionId: string, all: Turn[], from: string | null, settled: boolean): Chunk[] | "anchor_missing" {
  let start = 0;
  if (from !== null) {
    const i = all.findIndex((t) => t.anchor === from);
    if (i < 0) return "anchor_missing";
    start = i + 1;
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
  };
}

// ---------- 近邻 ----------

async function embedOrDefer(embedder: Embedder | null, texts: string[]): Promise<Float32Array[]> {
  if (!embedder) throw new WorkFailure("embed_unavailable", "未配置 embedding");
  try {
    const v = await embedder(texts);
    if (v.length !== texts.length) throw new Error("条数不一致");
    return v;
  } catch (e) {
    throw new WorkFailure("embed_unavailable", `embedding 不可用：${(e as Error).message}`);
  }
}

async function prefetchNeighbors(deps: WorkDeps, turns: Turn[], projectId: string | null): Promise<Proposition[]> {
  const embedder = deps.embedder;
  if (!embedder) throw new WorkFailure("embed_unavailable", "未配置 embedding");
  try {
    await deps.store.syncVectors(embedder, embedder.model!);
  } catch (e) {
    throw new WorkFailure("embed_unavailable", `向量未更新：${(e as Error).message}`);
  }
  const queries = turns.filter((t) => t.role === "user").slice(0, NEIGHBOR_QUERIES).map((t) => t.text.slice(0, NEIGHBOR_QUERY_CHARS));
  if (!queries.length) return [];
  const vecs = await embedOrDefer(embedder, queries);
  const best = new Map<string, { prop: Proposition; similarity: number }>();
  for (const v of vecs) {
    for (const n of deps.store.nearestByVector(v, projectId, NEIGHBORS_PER_QUERY, VEC_MIN_SIM)) {
      const prev = best.get(n.prop.id);
      if (!prev || prev.similarity < n.similarity) best.set(n.prop.id, n);
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
  const kept: { cand: Candidate; vec: Float32Array }[] = [];
  for (let i = 0; i < cands.length; i++) {
    const cur = { cand: cands[i], vec: vecs[i] };
    // 关系不同（比如一条是对旧条目的纠正、一条是新提议）不合并，免得丢掉纠正信号
    const j = kept.findIndex(
      (k) =>
        k.cand.scope === cur.cand.scope &&
        k.cand.relation.type === cur.cand.relation.type &&
        k.cand.relation.target === cur.cand.relation.target &&
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
  receipt: Pick<intake.Receipt, "proposals" | "attached" | "corrections" | "unreconciled" | "corroborated">;
}

function distinctUserSessions(p: Proposition, extra: { host: Host | null; session_id: string | null; basis: Basis; quote_sha256: string[] } | null): string[] {
  const list: { key: string; quotes: string[] }[] = [];
  const add = (host: Host | null, sid: string | null, basis: Basis | undefined, quotes: string[]) => {
    if (!sid || !USER_BASES.has(basis)) return;
    list.push({ key: `${host}:${sid}`, quotes });
  };
  add(p.source.host, p.source.session_id, p.basis, p.evidence.filter((e) => e.role === "user").map((e) => e.quote_sha256));
  for (const s of p.extra_sources) add(s.host, s.session_id, s.basis, s.quote_sha256);
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

export function admit(
  candidates: (Candidate & { unreconciled: boolean })[],
  s: intake.SessionRow,
  projectId: string,
  windowId: string,
  props: Map<string, Proposition>,
): Admission {
  const out: Admission = { appends: [], keys: [], receipt: { proposals: 0, attached: 0, corrections: 0, unreconciled: 0, corroborated: 0 } };
  for (const c of candidates) {
    const source: SourcePointer = {
      host: s.host,
      session_id: s.session_id,
      transcript: s.transcript,
      anchor: c.evidence[c.evidence.length - 1].anchor,
      summary: `自动沉淀（ab work）：${c.trigger ?? c.text}`.slice(0, 120),
    };
    const target = c.relation.target ? props.get(c.relation.target) : undefined;
    const pid = c.scope === "global" ? null : projectId;
    if (!c.unreconciled && c.relation.type === "duplicate" && target && target.state === "active") {
      const body: EvidenceBody = { source, basis: c.basis, evidence: c.evidence, window_id: windowId };
      out.appends.push({ kind: "evidence", project_id: target.project_id, session_id: s.session_id, target_id: target.id, body });
      out.keys.push(c.key);
      out.receipt.attached++;
      if (CORROBORATE_KINDS.has(target.kind) && target.project_id !== null && !target.confirmed && !target.conflicts_with && !target.pending_corrections.length && !target.supersedes) {
        const sessions = distinctUserSessions(target, { host: s.host, session_id: s.session_id, basis: c.basis, quote_sha256: c.evidence.filter((e) => e.role === "user").map((e) => e.quote_sha256) });
        if (sessions.length >= 2) {
          const cb: ConfirmBody = { by: "corroboration", sessions };
          out.appends.push({ kind: "confirm", project_id: target.project_id, session_id: null, target_id: target.id, body: cb });
          out.keys.push(`${c.key}:confirm`);
          out.receipt.corroborated++;
        }
      }
      continue;
    }
    const body: RememberBody = {
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
      relation: { type: c.relation.type, target: target ? target.id : null },
      ...(c.valid_days ? { valid_days: c.valid_days } : {}),
      ...(c.said_at ? { said_at: c.said_at } : {}),
    };
    if (c.unreconciled || c.relation.type === "unsure" || (c.relation.type !== "new" && !target)) {
      body.unreconciled = true;
      out.receipt.unreconciled++;
    } else if ((c.relation.type === "conflicts" || c.relation.type === "supersedes") && target && target.state === "active") {
      body.supersedes = target.id; // 未确认的纠正：只标"有待确认的纠正"，不盖掉旧条目（§9.2）
      body.kind = target.kind === "note" ? c.kind : target.kind;
      out.receipt.corrections++;
    } else {
      out.receipt.proposals++;
    }
    out.appends.push({ kind: "remember", project_id: pid, session_id: s.session_id, target_id: null, body });
    out.keys.push(c.key);
  }
  return out;
}

// ---------- 主流程 ----------

function settled(s: intake.SessionRow, now: Date): boolean {
  if (s.ended_at && s.ended_at >= s.last_touch) return true; // 结束后又有新 prompt（resume）就不算结束
  try {
    return now.getTime() - statSync(s.transcript!).mtimeMs >= SETTLE_IDLE_MS;
  } catch {
    return false;
  }
}

async function extractWindow(deps: WorkDeps, c: Chunk, s: intake.SessionRow, projectId: string, receipt: intake.Receipt): Promise<Admission> {
  if ("error" in deps.chat) throw new WorkFailure(deps.chat.error, deps.chat.message);
  const neighbors = await prefetchNeighbors(deps, c.turns, projectId);
  const win: ExtractWindow = { turns: c.turns, context: c.context };
  const messages = buildMessages(win, projectContext(deps, s.project, projectId), neighbors);
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
  const v = validate(parsed, win, neighbors, c.id);
  if (deps.debugDir) dumpDebug(deps.debugDir, s, c, r.message.content ?? "", v);
  receipt.candidates += Array.isArray((parsed as any).candidates) ? (parsed as any).candidates.length : 0;
  for (const [k, n] of Object.entries(v.dropped)) receipt.dropped[k] = (receipt.dropped[k] ?? 0) + (n ?? 0);
  for (const [k, n] of Object.entries(v.evidenceDropped)) receipt.evidence_dropped[k] = (receipt.evidence_dropped[k] ?? 0) + (n ?? 0);
  const vecs = v.candidates.length ? await embedOrDefer(deps.embedder, v.candidates.map((x) => x.text)) : [];
  const merged = mergeSameWindow(v.candidates, vecs);
  receipt.merged += v.candidates.length - merged.length;
  // 每条候选单独复查已有条目（§9.4.4 → unreconciled）：
  // 没给模型看过的高相似近邻，说明邻居检查不完整；给模型看过、模型仍说 new，说明模型与向量意见相左。
  // 两种都不由向量自动合并，交给用户裁决（§21 2026-10-12）。
  const shown = new Set(neighbors.map((n) => n.id));
  const checked = merged.map(({ cand, vec }) => {
    const hits = deps.store.nearestByVector(vec, projectId, RECHECK_TOP, DUP_CHECK_SIM);
    const handled = new Set([cand.relation.target].filter(Boolean));
    return {
      ...cand,
      unreconciled: hits.some((n) => !shown.has(n.prop.id)) || (cand.relation.type === "new" && hits.some((n) => !handled.has(n.prop.id))),
    };
  });
  return admit(checked, s, projectId, c.id, deps.store.project().props);
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
    const ok = found ? allowedTranscript(s.host, found) : null;
    if (ok) {
      intake.setTranscript(db, s, ok);
      s = { ...s, transcript: ok };
    }
  }
  if (s.ephemeral || !s.project || !s.transcript) {
    report.windows.skipped++;
    return;
  }
  if (deps.store.sessionPurged(s.session_id)) {
    intake.setSessionError(db, s, "purged");
    report.windows.skipped++;
    return;
  }
  if (!deps.registry.some((e) => e.name === s.project)) {
    intake.setSessionError(db, s, "unregistered_project");
    report.windows.skipped++;
    return;
  }
  let turns: Turn[];
  let stripped = 0;
  try {
    const cleaned = cleanTranscript(s.host, s.transcript);
    if (cleaned.subagent) {
      intake.markEphemeral(db, s);
      report.windows.skipped++;
      return;
    }
    turns = cleaned.turns;
    stripped = cleaned.stripped;
  } catch {
    intake.setSessionError(db, s, "source_unavailable");
    return;
  }
  const hitsByAnchor = new Map<string, Record<string, number>>();
  turns = turns.map((t) => {
    const r = sanitize(t.text);
    hitsByAnchor.set(t.anchor, r.hits as Record<string, number>);
    return { ...t, text: r.text };
  });
  const chunks = chunk(s.host, s.session_id, turns, s.processed_anchor, settled(s, now));
  if (chunks === "anchor_missing") {
    intake.setSessionError(db, s, "source_unavailable");
    return;
  }
  if (opts.dryRun) {
    report.dry.push({ session: `${s.host}:${s.session_id}`, windows: chunks.length, chars: chunks.reduce((n, c) => n + c.chars, 0) });
    return;
  }
  const projectId = deps.projectId(s.project);
  let row = s;
  const capped = opts.sweep && isBacklog(s);
  if (capped && chunks.length && backlog.left <= 0) {
    report.backlogLeft++;
    return;
  }
  for (const c of chunks.slice(0, MAX_WINDOWS_PER_SESSION_RUN)) {
    const prev = intake.getWindow(db, c.id);
    // 旧版日预算留下的 budget_exhausted 延后已无意义，立即重做
    if (prev?.state === "deferred" && prev.error_code !== "budget_exhausted" && prev.next_at && prev.next_at > deps.now().toISOString()) break;
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
      adm = await extractWindow(deps, c, row, projectId, receipt);
    } catch (e) {
      const code: WorkError = e instanceof WorkFailure ? e.code : "network";
      const config = code === "no_config" || code === "no_key";
      const terminal = intake.deferWindow(db, row, c, code, deps.now(), !config);
      if (terminal) {
        deps.store.commit([], (tx) => intake.finishWindow(tx, row, c, "failed", code, receipt, deps.now()));
        report.windows.failed++;
        row = { ...row, processed_anchor: c.to };
        continue;
      }
      report.windows.deferred++;
      break;
    }
    const known = intake.knownCandidates(db, adm.keys);
    const appends = adm.appends.filter((_, i) => !known.has(adm.keys[i]));
    const keys = adm.keys.filter((k) => !known.has(k));
    Object.assign(receipt, adm.receipt);
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

/**
 * 待判关系的条目：自动沉淀、未确认、active、还没判过，且有余弦 ≥ RELATE_SIM 的近邻。
 * 每对只从一侧判：近邻须比它早，或是已确认 / 非自动沉淀（这些自己不会被判）。
 */
export function relateTodo(store: Store): RelateItem[] {
  const props = [...store.project().props.values()]
    .filter((p) => p.state === "active" && p.origin === "extract" && !p.confirmed && !p.related)
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
  } catch {
    report.relate.errors++;
    return;
  }
  const todo = relateTodo(deps.store);
  for (let i = 0, calls = 0; i < todo.length && calls < MAX_RELATE_CALLS_PER_RUN; i += RELATE_BATCH, calls++) {
    const batch = todo.slice(i, i + RELATE_BATCH);
    let verdicts;
    try {
      const r = await deps.chat.chat(buildRelateMessages(batch), { json: true });
      intake.spend(db, deps.now(), 1, r.tokens);
      verdicts = parseRelate(parseJsonLoose(r.message.content), batch);
    } catch {
      report.relate.errors++;
      break;
    } finally {
      intake.renewLease(db, holder, deps.now());
    }
    for (let k = 0; k < batch.length; k++) {
      const v = verdicts[k];
      if (!v) {
        report.relate.errors++;
        continue;
      }
      // 同一批里前面的结论可能已经归档了本条或目标：以当前投影为准，目标不在了就留到下次
      const props = deps.store.project().props;
      const p = props.get(batch[k].prop.id);
      const target = v.target ? props.get(v.target.id) : null;
      // 同一次运行里前面的并入可能已让本条被印证转正：已确认的条目一律不再自动改
      if (!p || p.state !== "active" || p.confirmed || p.related || (v.target && target?.state !== "active")) continue;
      const { appends, corroborated } = applyVerdict(p, target ?? null, v, deps.chat.model, {
        mode: "absorb-new",
        corroborate: (np, t, basis) => {
          if (!CORROBORATE_KINDS.has(t.kind) || t.project_id === null || t.confirmed || t.unreconciled || t.conflicts_with || t.pending_corrections.length || t.supersedes) return null;
          const userQuotes = np.evidence.filter((e) => e.role === "user").map((e) => e.quote_sha256);
          const sessions = distinctUserSessions(t, { host: np.source.host, session_id: np.source.session_id, basis, quote_sha256: userQuotes });
          return sessions.length >= 2 ? { by: "corroboration", sessions } : null;
        },
      });
      if (corroborated) report.relate.corroborated++;
      deps.store.commit(appends, () => {});
      report.relate[v.outcome]++;
    }
  }
}

/** 按代码核验：只核验项目范围、未确认、可由代码证明的种类（坑、事实），且不是待确认的纠正。 */
async function verifyPass(deps: WorkDeps, report: WorkReport, holder: string): Promise<void> {
  if ("error" in deps.chat) return;
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
      .filter((p) => p.state === "active" && !p.confirmed && p.project_id !== null && CODE_VERIFIABLE.has(p.kind) && !p.unreconciled && !p.supersedes && !p.stale)
      .sort((a, b) => a.seq - b.seq),
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
    } else if (last && (last.head === head || deps.now().getTime() - Date.parse(last.at) < VERIFY_RECHECK_MS)) continue;
    done++;
    let result;
    try {
      result = await verifyProposition(deps.chat.chat, tools, p);
    } catch (e) {
      intake.recordVerify(db, p.id, head, `error:${e instanceof WorkFailure ? e.code : "network"}`, deps.now());
      report.verify.errors++;
      continue;
    } finally {
      intake.renewLease(db, holder, deps.now());
    }
    // 核验有了结果才出队；出错时留在队里，下次 ab work 再试
    intake.dequeueReverify(db, p.id);
    intake.spend(db, deps.now(), result.rounds, result.tokens);
    report.verify[result.verdict]++;
    if (result.verdict === "verified" || result.verdict === "contradicted") {
      const body: VerifyBody = { outcome: result.verdict, head, refs: result.refs, model: deps.chat.model };
      deps.store.commit([{ kind: "verify", project_id: p.project_id, session_id: null, target_id: p.id, body }], (tx) =>
        intake.recordVerify(tx, p.id, head, result.verdict, deps.now()),
      );
    } else {
      intake.recordVerify(db, p.id, head, result.verdict, deps.now());
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
  };
  const db = deps.store.workDb;
  const holder = opts.dryRun ? "dry-run" : intake.acquireLease(db, deps.now());
  if (!holder) {
    report.busy = true;
    return report;
  }
  try {
    if (opts.sweep && !opts.dryRun) {
      intake.reclassifyScanned(db, (t) => sessionStart(t));
      report.scanned = scan(deps);
    }
    if (opts.redo && opts.session && !opts.dryRun) intake.resetSession(db, opts.session.host, opts.session.session_id);
    // hook / 手动登记的会话先处理；扫描补登记的排后面，并受 BACKLOG_WINDOWS_PER_SWEEP 限制
    const list = intake.sessions(db, opts.session);
    const ordered = [...list.filter((x) => !isBacklog(x)), ...list.filter(isBacklog)];
    const backlog: Backlog = { left: BACKLOG_WINDOWS_PER_SWEEP };
    for (const s of ordered) await processSession(deps, s, opts, report, holder, backlog);
    if (!opts.dryRun) await relatePass(deps, report, holder);
    if (opts.sweep && !opts.dryRun) {
      await verifyPass(deps, report, holder);
      intake.prune(db, deps.now());
    }
    if (!opts.dryRun) intake.setMeta(db, "last_run", deps.now().toISOString());
  } finally {
    if (!opts.dryRun) intake.releaseLease(db, holder);
  }
  return report;
}
