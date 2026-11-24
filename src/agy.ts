/**
 * Antigravity（agy）的会话布局（设计 §7.8）：CLI、IDE、T3 实例共用 `brain/<id>`，
 * 完整记录在 `.system_generated/logs/transcript_full.jsonl`（同目录 `transcript.jsonl` 会截断长字段）。
 * cwd 不在记录里，sweep 从 `conversation_summaries.db` 只读取。
 */
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { accessSync, constants, copyFileSync, lstatSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ID = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const TAIL = /\/brain\/([^/]+)\/\.system_generated\/logs\/transcript(?:_full)?\.jsonl$/;

export function agyAppDir(): string {
  return join(homedir(), ".gemini/antigravity-cli");
}

/** 会话 id 的完整记录路径；id 不合法（含 `/`、`..`）返回 null。 */
export function agyTranscriptPath(id: string, root?: AgyRoot): string | null {
  if (!ID.test(id)) return null;
  const appData = root ? root.appData : agyAppDir();
  const full = join(appData, "brain", id, ".system_generated/logs/transcript_full.jsonl");
  try {
    if (root) validateRoot(root);
    return canonicalPath(full) === full ? full : null;
  } catch {
    return null;
  }
}

/** 从 `brain/<id>/.system_generated/logs/transcript{,_full}.jsonl` 取 id。 */
export function agySessionId(path: string): string | null {
  const m = TAIL.exec(path);
  return m && ID.test(m[1]) ? m[1] : null;
}

export interface AgyRoot {
  kind: "cli" | "ide" | "t3";
  root: string;
  appData: string;
  brain: string;
  summaries: string;
  instance?: string;
}

export interface AgyConversation {
  id: string;
  cwd: string | null;
  parent: string | null;
  transcript: string;
  modifiedAt: number;
  root: AgyRoot;
}

function application(kind: AgyRoot["kind"], root: string, instance?: string): AgyRoot {
  const appData = kind === "t3" ? join(root, "antigravity-acp") : root;
  return { kind, root, appData, brain: join(appData, "brain"), summaries: join(appData, "conversation_summaries.db"), ...(instance === undefined ? {} : { instance }) };
}

/** 固定两处应用根，T3 只枚举实例这一层。 */
export function agyRoots(): AgyRoot[] {
  const roots = [application("cli", agyAppDir()), application("ide", join(homedir(), ".gemini/antigravity"))];
  const providers = join(homedir(), ".t3/userdata/providers/antigravity");
  try {
    for (const entry of readdirSync(providers, { withFileTypes: true })) {
      if (entry.isDirectory() || entry.isSymbolicLink()) roots.push(application("t3", join(providers, entry.name), entry.name));
    }
  } catch {
    // 枚举失败仍保留 CLI、IDE；发现入口单独报告实例目录无法读取。
  }
  return roots;
}

export interface AgyLocateResult {
  path: string | null;
  conflict: AgyRoot[];
}

/** 只检查指定 id 的完整版，冲突先于根提示；合法提示允许保留未落盘坐标。 */
export function agyLocate(id: string, hints: { appDataDir?: string | null; geminiHome?: string | null } = {}): AgyLocateResult {
  const candidates = agyRoots().flatMap((root) => {
    const path = agyTranscriptPath(id, root);
    return path ? [{ root, path }] : [];
  });
  const hits = candidates.filter(({ path }) => {
    try { return statSync(path).isFile(); } catch { return false; }
  });
  if (hits.length > 1) return { path: null, conflict: hits.map(({ root }) => root) };
  const appDataDir = hints.appDataDir ? resolve(hints.appDataDir) : null;
  const geminiHome = hints.geminiHome ? resolve(hints.geminiHome) : null;
  const hint = appDataDir ? candidates.find(({ root }) => root.appData === appDataDir)
    : geminiHome ? candidates.find(({ root }) => root.kind === "t3" && root.root === geminiHome) : undefined;
  return { path: hint?.path ?? hits[0]?.path ?? null, conflict: [] };
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** 未落盘的日志也核验已有父目录，不能让晚写文件绕过软链边界。 */
function canonicalPath(path: string): string {
  try {
    lstatSync(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
    return join(canonicalPath(dirname(path)), basename(path));
  }
  return realpathSync(path);
}

function validateRoot(root: AgyRoot): void {
  const expected = root.kind === "cli" ? agyAppDir()
    : root.kind === "ide" ? join(homedir(), ".gemini/antigravity")
    : root.instance && root.instance !== "." && root.instance !== ".." && basename(root.instance) === root.instance
      ? join(homedir(), ".t3/userdata/providers/antigravity", root.instance) : null;
  const appData = expected && (root.kind === "t3" ? join(expected, "antigravity-acp") : expected);
  if (!expected || !appData) throw new Error("agy root escapes application layout");
  if (root.root !== expected || root.appData !== appData || root.brain !== join(appData, "brain") || root.summaries !== join(appData, "conversation_summaries.db")
      || canonicalPath(root.root) !== expected || canonicalPath(root.appData) !== appData) throw new Error("agy root escapes application layout");
}

/** 先核验活库及边车的原路径，再复制；SQLite 只在副本上打开。 */
function summaryRows(root: AgyRoot): Record<string, SQLOutputValue>[] | null {
  const sources: string[] = [];
  for (const suffix of ["", "-wal", "-shm"]) {
    const source = root.summaries + suffix;
    try {
      lstatSync(source);
    } catch (error) {
      if (!isMissing(error)) throw error;
      if (!suffix) return null;
      continue;
    }
    if (!realpathSync(source).startsWith(root.appData + sep) || !statSync(source).isFile()) throw new Error("agy summaries escape application root");
    accessSync(source, constants.R_OK);
    sources.push(source);
  }
  const scratch = mkdtempSync(join(tmpdir(), "ab-agy-summaries-"));
  let db: DatabaseSync | undefined;
  try {
    for (const source of sources) copyFileSync(source, join(scratch, basename(source)));
    db = new DatabaseSync(join(scratch, basename(root.summaries)), { readOnly: true });
    return db.prepare("SELECT conversation_id, workspace_uris, parent_conversation_id, last_modified_time FROM conversation_summaries").all();
  } finally {
    db?.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}

function workspaceCwd(value: unknown): string | null {
  try {
    const uris: unknown = JSON.parse(String(value));
    return Array.isArray(uris) && typeof uris[0] === "string" && uris[0].startsWith("file://") ? fileURLToPath(uris[0]) : null;
  } catch {
    return null;
  }
}

/** 实际完整日志决定本处对话数，摘要只补元数据。冲突先于发现窗口过滤。 */
export function agyDiscover(roots: AgyRoot[], now: Date, known: (id: string) => boolean): {
  conversations: AgyConversation[];
  conflicts: { id: string; roots: string[] }[];
  problems: { root: string; kind: "no_summaries" | "missing_meta" | "unreadable"; count?: number; summariesUnreadable?: boolean }[];
} {
  const all: AgyConversation[] = [];
  const problems: ReturnType<typeof agyDiscover>["problems"] = [];
  const providers = join(homedir(), ".t3/userdata/providers/antigravity");
  try {
    const st = statSync(providers);
    if (!st.isDirectory() || realpathSync(providers) !== providers) throw new Error("agy instances escape application layout");
    accessSync(providers, constants.R_OK | constants.X_OK);
  } catch (error) {
    if (!isMissing(error)) problems.push({ root: providers, kind: "unreadable" });
  }
  for (const root of roots) {
    const logs: { id: string; transcript: string; mtime: number }[] = [];
    let unreadable = 0;
    try {
      validateRoot(root);
      // 尚未安装的固定应用不显示空实例；T3 的新实例仍报告尚无摘要库。
      if (root.kind !== "t3") {
        try { lstatSync(root.appData); } catch (error) { if (isMissing(error)) continue; throw error; }
      }
      if (canonicalPath(root.brain) !== root.brain) throw new Error("agy brain escapes application layout");
      let entries: string[] = [];
      try { entries = readdirSync(root.brain); } catch (error) { if (!isMissing(error)) throw error; }
      for (const id of entries) {
        if (!ID.test(id)) continue;
        const path = join(root.brain, id, ".system_generated/logs/transcript_full.jsonl");
        try {
          lstatSync(path);
          const transcript = agyTranscriptPath(id, root);
          const st = transcript ? statSync(transcript) : null;
          if (!transcript || !st?.isFile()) throw new Error("agy transcript escapes application layout");
          accessSync(transcript, constants.R_OK);
          logs.push({ id, transcript, mtime: st.mtimeMs });
        } catch (error) {
          if (!isMissing(error)) unreadable++;
        }
      }
    } catch {
      problems.push({ root: root.root, kind: "unreadable" });
      continue;
    }
    let rows: ReturnType<typeof summaryRows> = null;
    let summariesUnreadable = false;
    try { rows = summaryRows(root); } catch {
      summariesUnreadable = true;
    }
    if (unreadable || summariesUnreadable) problems.push({ root: root.root, kind: "unreadable",
      ...(unreadable ? { count: unreadable } : {}), ...(summariesUnreadable ? { summariesUnreadable: true } : {}) });
    if (!rows && !summariesUnreadable && (logs.length || !unreadable)) problems.push({ root: root.root, kind: logs.length ? "missing_meta" : "no_summaries", count: logs.length });
    const metadata = new Map(rows?.flatMap((row) => typeof row.conversation_id === "string" ? [[row.conversation_id, row] as const] : []) ?? []);
    let missingMeta = 0;
    for (const log of logs) {
      const row = metadata.get(log.id);
      const cwd = row ? workspaceCwd(row.workspace_uris) : null;
      if (!cwd) missingMeta++;
      const modified = row ? Date.parse(String(row.last_modified_time)) : NaN;
      all.push({ id: log.id, cwd, parent: typeof row?.parent_conversation_id === "string" && row.parent_conversation_id ? row.parent_conversation_id : null,
        transcript: log.transcript, modifiedAt: Number.isFinite(modified) ? modified : log.mtime, root });
    }
    if (rows && missingMeta) problems.push({ root: root.root, kind: "missing_meta", count: missingMeta });
  }
  const byId = new Map<string, string[]>();
  for (const c of all) byId.set(c.id, [...(byId.get(c.id) ?? []), c.root.root]);
  const conflicts = [...byId].flatMap(([id, paths]) => paths.length > 1 ? [{ id, roots: paths }] : []);
  const conflictIds = new Set(conflicts.map((c) => c.id));
  const since = now.getTime() - 7 * 86_400_000;
  return { conversations: all.filter((c) => !conflictIds.has(c.id) && (known(c.id) || c.modifiedAt >= since)), conflicts, problems };
}
