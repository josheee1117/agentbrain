/**
 * 切片 3 后台 worker（设计 §19.3 关闭形态）：`ab work` 是短命进程，单实例租约。
 * 会话坐标由 `ab capture` 登记；本文件切窗口 → 去噪 → 脱敏 → 抽取 → 校验 → 近邻复查 → 准入 → 一个事务写 L1。
 * 另做三件定期事：按代码核验未确认的坑/事实、跨会话印证、过期提议归档。
 */
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync, type Dirent } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { VEC_MIN_SIM, type Store, type Embedder, type PendingAppend } from "./store.ts";
import type { Basis, ConfirmBody, EvidenceBody, Host, Proposition, RememberBody, SourcePointer, VerifyBody } from "./l2.ts";
import { WorkFailure, parseJsonLoose, type Chat, type WorkError } from "./llm.ts";
import { addHits, sanitize } from "./sanitize.ts";
import { cleanTranscript, type Turn } from "./transcript.ts";
import { buildMessages, validate, type Candidate, type ExtractWindow, type ProjectContext } from "./extract.ts";
import { RepoTools, verifyProposition } from "./codeverify.ts";
import * as intake from "./intake.ts";
import type { RegistryEntry } from "./registry.ts";

export const SETTLE_IDLE_MS = 30 * 60_000;
export const WINDOW_MAX_CHARS = 48_000;
export const CONTEXT_OVERLAP_TURNS = 4;
export const MAX_WINDOWS_PER_SESSION_RUN = 6;
export const DUP_CHECK_SIM = 0.8;
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
export const PROPOSAL_EXPIRE_DAYS = 90;
const SCAN_DAYS = 7;
const SCAN_HEAD_BYTES = 64 * 1024;
const CODE_VERIFIABLE = new Set(["pitfall", "note"]);
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
}

export interface WorkOptions {
  session?: { host: Host; session_id: string };
  sweep: boolean;
  dryRun: boolean;
}

export interface WorkReport {
  busy: boolean;
  scanned: number;
  windows: { done: number; deferred: number; failed: number; skipped: number };
  receipt: intake.Receipt;
  verify: { verified: number; contradicted: number; not_verifiable: number; inconclusive: number; errors: number };
  expired: number;
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
      if (!cwd || head.some((e) => e?.isSidechain === true)) continue;
      let project: { name: string } | null = null;
      try {
        project = deps.resolveProject(cwd);
      } catch {
        project = null;
      }
      if (!project) continue;
      intake.upsertSession(db, { host, session_id: id, transcript: realpathSync(f), cwd, ended: false, ephemeral: false, via: "scan" }, () => project!.name, deps.now());
      added++;
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
      if (CORROBORATE_KINDS.has(target.kind) && target.project_id !== null && !target.confirmed) {
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
  receipt.candidates += Array.isArray((parsed as any).candidates) ? (parsed as any).candidates.length : 0;
  for (const [k, n] of Object.entries(v.dropped)) receipt.dropped[k] = (receipt.dropped[k] ?? 0) + (n ?? 0);
  // 每条候选单独复查：出现没给模型看过的高相似近邻，说明邻居检查不完整（§9.4.4 → unreconciled）
  const shown = new Set(neighbors.map((n) => n.id));
  const vecs = v.candidates.length ? await embedOrDefer(deps.embedder, v.candidates.map((x) => x.text)) : [];
  const checked = v.candidates.map((cand, i) => ({
    ...cand,
    unreconciled: deps.store.nearestByVector(vecs[i], projectId, RECHECK_TOP, DUP_CHECK_SIM).some((n) => !shown.has(n.prop.id) && n.similarity >= DUP_CHECK_SIM),
  }));
  return admit(checked, s, projectId, c.id, deps.store.project().props);
}

async function processSession(deps: WorkDeps, s: intake.SessionRow, opts: WorkOptions, report: WorkReport, holder: string): Promise<void> {
  const db = deps.store.workDb;
  const now = deps.now();
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
    turns = cleaned.turns;
    stripped = cleaned.stripped;
  } catch {
    intake.setSessionError(db, s, "source_unavailable");
    return;
  }
  const hits: Record<string, number> = {};
  turns = turns.map((t) => {
    const r = sanitize(t.text);
    addHits(hits, r.hits);
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
  for (const c of chunks.slice(0, MAX_WINDOWS_PER_SESSION_RUN)) {
    const prev = intake.getWindow(db, c.id);
    if (prev?.state === "deferred" && prev.next_at && prev.next_at > deps.now().toISOString()) break;
    if (!intake.budgetLeft(db, deps.now())) {
      intake.deferWindow(db, row, c, "budget_exhausted", deps.now(), false, intake.tomorrow(deps.now()));
      report.windows.deferred++;
      break;
    }
    const receipt = intake.emptyReceipt();
    receipt.turns = c.turns.length;
    receipt.chars = c.chars;
    receipt.truncated = c.truncated;
    receipt.stripped = row === s ? stripped : 0;
    receipt.sanitizer = row === s ? hits : {};
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

/** 按代码核验：只核验项目范围、未确认、可由代码证明的种类（坑、事实），且不是待确认的纠正。 */
async function verifyPass(deps: WorkDeps, report: WorkReport, holder: string): Promise<void> {
  if ("error" in deps.chat) return;
  const db = deps.store.workDb;
  const names = new Map(deps.store.listProjects().map((p) => [p.id, p.name]));
  const todo = [...deps.store.project().props.values()]
    .filter((p) => p.state === "active" && !p.confirmed && p.project_id !== null && CODE_VERIFIABLE.has(p.kind) && !p.unreconciled && !p.supersedes && !p.stale)
    .sort((a, b) => a.seq - b.seq);
  let done = 0;
  for (const p of todo) {
    if (done >= MAX_VERIFY_PER_RUN || !intake.budgetLeft(db, deps.now())) break;
    const entry = deps.registry.find((e) => e.name === names.get(p.project_id!));
    if (!entry?.path || !existsSync(entry.path)) continue;
    const tools = new RepoTools(entry.path);
    const head = tools.head();
    if (!head) continue;
    const last = intake.lastVerify(db, p.id);
    if (last && (last.head === head || deps.now().getTime() - Date.parse(last.at) < VERIFY_RECHECK_MS)) continue;
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
    intake.spend(db, deps.now(), result.calls + 1, result.tokens);
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

/** 自动沉淀的提议 90 天没被确认，归档为 expired（§9.1 admission 终态）。 */
function expirePass(deps: WorkDeps, report: WorkReport): void {
  const cutoff = deps.now().getTime() - PROPOSAL_EXPIRE_DAYS * 86_400_000;
  const old = [...deps.store.project().props.values()].filter((p) => p.origin === "extract" && !p.confirmed && p.state === "active" && Date.parse(p.ts) < cutoff);
  if (!old.length) return;
  deps.store.commit(old.map((p) => ({ kind: "archive", project_id: p.project_id, session_id: null, target_id: p.id, body: { reason: "expired" } })), () => {});
  report.expired += old.length;
}

export async function runWork(deps: WorkDeps, opts: WorkOptions): Promise<WorkReport> {
  const report: WorkReport = {
    busy: false,
    scanned: 0,
    windows: { done: 0, deferred: 0, failed: 0, skipped: 0 },
    receipt: intake.emptyReceipt(),
    verify: { verified: 0, contradicted: 0, not_verifiable: 0, inconclusive: 0, errors: 0 },
    expired: 0,
    dry: [],
  };
  const db = deps.store.workDb;
  const holder = opts.dryRun ? "dry-run" : intake.acquireLease(db, deps.now());
  if (!holder) {
    report.busy = true;
    return report;
  }
  try {
    if (opts.sweep && !opts.dryRun) report.scanned = scan(deps);
    for (const s of intake.sessions(db, opts.session)) await processSession(deps, s, opts, report, holder);
    if (opts.sweep && !opts.dryRun) {
      await verifyPass(deps, report, holder);
      expirePass(deps, report);
      intake.prune(db, deps.now());
    }
    if (!opts.dryRun) intake.setMeta(db, "last_run", deps.now().toISOString());
  } finally {
    if (!opts.dryRun) intake.releaseLease(db, holder);
  }
  return report;
}
