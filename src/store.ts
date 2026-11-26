/**
 * agentbrain 存储层（设计 §12.2 / §19.1 / §19.2，切片 1.5）。
 *
 * - store.db：L1 事件表（append-only，purge 只清正文留墓碑）+ projects 注册表
 * - index.db：L3 FTS5 trigram 索引，随时可删；水位与 store 不一致时重建
 * - L2：`project()` 调 `l2.ts` 的 `fold`，L1 上的纯函数，不落盘（同一 L1 → 同一 L2）
 *
 * 预算类数字全部是代码常量（§2.2），本文件零配置键。
 */
import { DatabaseSync } from "node:sqlite";
import { searchable } from "./visibility.ts";
import { randomUUID, createHash } from "node:crypto";
import { chmodSync, mkdirSync, statSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { dirname } from "node:path";
import { cosine, fromBlob, toBlob } from "./embed.ts";
import { fold, checkDetailBody, checkRememberBody, checkTagBody, type DetailBody, type EventKind, type EventRow, type PropKind, type PropState, type Projection, type Proposition, type RememberBody, type TagBody, type Who } from "./l2.ts";

/**
 * 库版本号（§12.6.1），存在 store.db 的 PRAGMA user_version。新增事件种类、表或列必须加一。
 * 库比代码新时这个连接只读。版本 1：events.actor / events.machine / capture_windows.error_detail。
 */
export const SCHEMA_VERSION = 1;

/** 权限不对就改（§12.6.5）；文件不存在或改不动时不报错。 */
export function tighten(path: string, mode: number): void {
  try {
    if ((statSync(path).mode & 0o777) !== mode) chmodSync(path, mode);
  } catch {
    // 不存在或不是自己的文件
  }
}

function localWho(): Who {
  let actor: string | null = null;
  try {
    actor = userInfo().username || null;
  } catch {
    actor = process.env.USER ?? null;
  }
  return { actor, machine: hostname() || null };
}

const BUSY_TIMEOUT_MS = 5000;
export const MAX_EMBED_PER_SYNC = 200;
const HYBRID_FTS_K = 20;
const HYBRID_VEC_K = 20;
// 2026-10-10 测试集（53 条 / 121 查询）校准：0.45 召回 93%、负例误报 33%；每轮召回另用更严的 minSim。
export const VEC_MIN_SIM = 0.45;
/** §8.11.4 跨项目段：只取与查询向量的余弦 ≥ 这个值的其他项目条目。 */
export const CROSS_PROJECT_MIN_SIM = 0.65;
/** §8.11.4 跨项目段最多列几条。 */
export const CROSS_PROJECT_MAX = 3;

export type Embedder = ((texts: string[]) => Promise<Float32Array[]>) & { model?: string };


export interface SearchHit {
  id: string;
  project_id: string | null;
  kind: PropKind;
  text: string;
  state: PropState;
  /** 向量相似度（只有向量命中才有；纯全文检索命中没有）。 */
  similarity?: number;
  /** 字面（全文检索）命中。和 similarity 可以同时有（§12.6.7 T3：结果要看得出为什么命中）。 */
  lexical?: boolean;
}

export interface SearchOpts {
  /** 项目 id 列表，或 "all" 搜全部项目。 */
  projects: readonly string[] | "all";
  includeGlobal: boolean;
  kind?: PropKind;
  includeArchived?: boolean;
  limit?: number;
  /** recall 用：向量缺了就降级，不在这次检索里补。 */
  skipSync?: boolean;
  /** 向量命中的最低余弦，默认 VEC_MIN_SIM。 */
  minSim?: number;
  /** 跨项目段（§8.11.4）：给了就在返回里多带 cross，排除给出的项目。 */
  crossProject?: { excludeProjectId: string };
}

/** 跨项目段的一条：项目一定有值（全局不进候选）。 */
export interface CrossProjectHit extends SearchHit {
  project_id: string;
  similarity: number;
}

export interface CrossProjectResult {
  hits: CrossProjectHit[];
  /** 其他项目里还没有当前向量的条目数：这些条目可能漏。 */
  pending: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects(
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
DROP TABLE IF EXISTS bindings;
CREATE TABLE IF NOT EXISTS events(
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  project_id TEXT,
  session_id TEXT,
  ephemeral INTEGER NOT NULL DEFAULT 0,
  target_id TEXT,
  body TEXT,
  body_hash TEXT,
  actor TEXT,
  machine TEXT);
CREATE INDEX IF NOT EXISTS events_session ON events(session_id);
CREATE TABLE IF NOT EXISTS capture_sessions(
  host TEXT NOT NULL, session_id TEXT NOT NULL, transcript TEXT, cwd TEXT, project TEXT,
  first_seen TEXT NOT NULL, last_touch TEXT NOT NULL, ended_at TEXT,
  ephemeral INTEGER NOT NULL DEFAULT 0, processed_anchor TEXT, via TEXT NOT NULL, error_code TEXT,
  PRIMARY KEY(host, session_id));
CREATE TABLE IF NOT EXISTS capture_windows(
  window_id TEXT PRIMARY KEY, host TEXT NOT NULL, session_id TEXT NOT NULL,
  from_anchor TEXT, to_anchor TEXT NOT NULL, state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, next_at TEXT, error_code TEXT, receipt TEXT, updated_at TEXT NOT NULL, error_detail TEXT);
CREATE TABLE IF NOT EXISTS capture_candidates(candidate_key TEXT PRIMARY KEY, event_id TEXT NOT NULL, window_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS work_lease(name TEXT PRIMARY KEY, holder TEXT NOT NULL, pid INTEGER NOT NULL, expires_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS work_budget(day TEXT PRIMARY KEY, calls INTEGER NOT NULL, tokens INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS verify_attempts(prop_id TEXT PRIMARY KEY, head TEXT NOT NULL, outcome TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS work_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS verify_queue(prop_id TEXT PRIMARY KEY, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS prop_usage(prop_id TEXT PRIMARY KEY, last_used TEXT NOT NULL, uses INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS inject_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, host TEXT, session_id TEXT, transcript TEXT, project_id TEXT,
  prop_id TEXT NOT NULL, path TEXT NOT NULL,
  cited INTEGER NOT NULL DEFAULT 0, cited_at TEXT, cited_title TEXT, title_mismatch INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS inject_log_session ON inject_log(host, session_id);
CREATE INDEX IF NOT EXISTS inject_log_prop ON inject_log(prop_id);
CREATE TABLE IF NOT EXISTS recall_runs(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, host TEXT, session_id TEXT, project_id TEXT,
  outcome TEXT NOT NULL, n_hits INTEGER NOT NULL, ms INTEGER NOT NULL, cite INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0, marked INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS recall_runs_session ON recall_runs(host, session_id);
CREATE TABLE IF NOT EXISTS cite_scan(host TEXT NOT NULL, session_id TEXT NOT NULL, model TEXT, scanned_at TEXT NOT NULL, PRIMARY KEY(host, session_id));
CREATE TABLE IF NOT EXISTS memory_queries(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, host TEXT, session_id TEXT, transcript TEXT, project_id TEXT,
  path TEXT NOT NULL CHECK(path IN ('search','get')));
CREATE INDEX IF NOT EXISTS memory_queries_session ON memory_queries(host,session_id);
CREATE TABLE IF NOT EXISTS memory_reports(
  host TEXT NOT NULL, session_id TEXT NOT NULL, anchor TEXT NOT NULL, ts TEXT NOT NULL,
  cite INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('used','unused','unreported')),
  queried INTEGER NOT NULL, PRIMARY KEY(host,session_id,anchor));
CREATE TABLE IF NOT EXISTS memory_report_ids(
  host TEXT NOT NULL, session_id TEXT NOT NULL, anchor TEXT NOT NULL, short_id TEXT NOT NULL,
  prop_id TEXT, verified INTEGER NOT NULL, title_mismatch INTEGER NOT NULL,
  PRIMARY KEY(host,session_id,anchor,short_id),
  FOREIGN KEY(host,session_id,anchor) REFERENCES memory_reports(host,session_id,anchor) ON DELETE CASCADE);
`;

/** 开发期的统计表（带 rank 列）结构不同，又只是可丢的 90 天统计：删掉重建，免得之后的写入和看板查询静默失败。 */
function dropPreviewTelemetry(db: DatabaseSync): void {
  const cols = db.prepare("PRAGMA table_info(inject_log)").all() as { name: string }[];
  if (cols.some((c) => c.name === "rank")) db.exec("DROP TABLE IF EXISTS inject_log; DROP TABLE IF EXISTS recall_runs; DROP TABLE IF EXISTS cite_scan;");
}

export interface PendingAppend {
  kind: EventKind;
  project_id: string | null;
  session_id: string | null;
  target_id: string | null;
  body: unknown;
}

/** 索引文本的口径改了（正文不再被向量上限截断），旧索引整表重建。 */
const INDEX_VERSION = "3";

const FTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS vecs(id TEXT PRIMARY KEY, text_hash TEXT NOT NULL, vec BLOB NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS props USING fts5(
  id UNINDEXED, project_id UNINDEXED, kind UNINDEXED, state UNINDEXED, text,
  tokenize='trigram');
`;

function openDb(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  if (path !== ":memory:") tighten(path, 0o600);
  db.exec(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS}`);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
  return db;
}

/** 向量输入上限：超出时只截 body（§8.11.2），text 和 why 全进。 */
export const VEC_TEXT_MAX_CHARS = 6000;

/**
 * 全文索引与字面召回的文本：text + why + 完整 body。
 * 6000 字上限是向量模型的限制，不能套到字面检索上（§8.11.2 最长存 40000 字正文）。
 */
export function indexText(p: Proposition): string {
  return p.body ? `${p.text}\n${p.why ?? ""}\n${p.body}` : p.why ? `${p.text}\n${p.why}` : p.text;
}

/** 向量输入：text + why + body，body 超出上限时截短。向量是否过期（text_hash）也按这个口径算。 */
export function vectorText(p: Proposition): string {
  return vectorTextOf(p.text, p.why, p.body);
}

/** text + why + body 的向量文本，body 超出上限时截短；抽取算候选向量也走这一份（§8.11.2）。 */
export function vectorTextOf(text: string, why?: string | null, body?: string | null): string {
  const head = why ? `${text}\n${why}` : text;
  if (!body) return head;
  const room = VEC_TEXT_MAX_CHARS - [...head].length - 1;
  if (room <= 0) return head;
  const chars = [...body];
  return `${head}\n${chars.length > room ? chars.slice(0, room).join("") : body}`;
}

function textHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** VACUUM 加 WAL 截断：把空闲页和日志里的旧内容从文件里去掉。返回空串表示做完，否则是没做完的原因。 */
function compact(db: DatabaseSync): string {
  db.exec("VACUUM");
  const r = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy?: number } | undefined;
  return r?.busy ? "WAL 没能截断（有别的进程正在读库），等它们结束后重跑 ab purge" : "";
}

export interface PurgeResult {
  /** 这次写下的清除声明；会话之前已声明过（重跑、恢复后重做）时为 null。 */
  purge_event: string | null;
  /** 被清掉正文的事件 id。 */
  enumerated: string[];
  /** 被清除的记忆 id。 */
  props: string[];
  /** 逐面结果（§10.2.3 第 4 条）：L1、统计表、索引、两个库文件的空闲页。 */
  surfaces: { name: string; ok: boolean; detail: string }[];
}

export class Store {
  private db: DatabaseSync;
  private fts: DatabaseSync;
  private cache: Projection | null = null;
  private cacheSeq = -1;
  private who: Who;
  /** 打开时库文件里的版本号；补完列之后等于 SCHEMA_VERSION，比它大说明库是更新的代码写的。 */
  private version: number;

  constructor(storePath: string, indexPath: string, who: Who = localWho()) {
    this.who = who;
    this.db = openDb(storePath);
    this.version = Number((this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
    if (this.version > SCHEMA_VERSION) {
      // §14.2：版本不兼容必须拒绝执行。不建表、不补列，这个连接上的写入全部失败
      this.db.exec("PRAGMA query_only=ON");
    } else {
      dropPreviewTelemetry(this.db);
      this.db.exec(SCHEMA);
      const recallCols = this.db.prepare("PRAGMA table_info(recall_runs)").all();
      if (!recallCols.some((c) => c.name === "transcript")) this.db.exec("ALTER TABLE recall_runs ADD COLUMN transcript TEXT");
      if (this.version < SCHEMA_VERSION) this.migrate();
    }
    this.fts = openDb(indexPath);
    this.fts.exec(FTS_SCHEMA);
  }

  /** 旧库补列并写版本号，一个写事务。并发打开时后到的进程在事务里重查列，不会重复加。 */
  private migrate(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const has = (table: string, col: string) => (this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === col);
      for (const [table, col] of [["events", "actor"], ["events", "machine"], ["capture_windows", "error_detail"]]) {
        if (!has(table, col)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} TEXT`);
      }
      this.db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
      this.db.exec("COMMIT");
    } catch (e) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw e;
    }
    this.version = SCHEMA_VERSION;
  }

  /** 库版本与代码支持的版本；readOnly 表示库比代码新、拒绝写入。 */
  get schema(): { version: number; supported: number; readOnly: boolean } {
    return { version: this.version, supported: SCHEMA_VERSION, readOnly: this.version > SCHEMA_VERSION };
  }

  private assertWritable(): void {
    if (this.version > SCHEMA_VERSION) throw new Error(`库版本 ${this.version} 比代码支持的 ${SCHEMA_VERSION} 新，拒绝写入：先更新 ab 的代码`);
  }

  /** 所有 L1 写入都经这里：统一带上操作者和机器（§12.6.2）。必须在写事务里调用。 */
  private insertEvent(id: string, kind: EventKind, projectId: string | null, sessionId: string | null, ephemeral: boolean, targetId: string | null, json: string | null): void {
    this.db
      .prepare("INSERT INTO events(id,ts,kind,project_id,session_id,ephemeral,target_id,body,body_hash,actor,machine) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, new Date().toISOString(), kind, projectId, sessionId, ephemeral ? 1 : 0, targetId, json, json === null ? null : createHash("sha256").update(json).digest("hex"), this.who.actor, this.who.machine);
  }

  close(): void {
    this.db.close();
    this.fts.close();
  }

  // ---------- 项目（§6.1：身份来自 registry，store 只按名字取或建） ----------

  ensureProject(name: string): string {
    const existing = () =>
      this.db.prepare("SELECT id FROM projects WHERE name=?").get(name) as { id: string } | undefined;
    const row = existing();
    if (row) return row.id;
    this.assertWritable();
    const id = randomUUID();
    try {
      this.db.prepare("INSERT INTO projects(id,name,created_at) VALUES(?,?,?)").run(id, name, new Date().toISOString());
    } catch (e) {
      const again = existing(); // 另一个进程刚建了同名项目
      if (again) return again.id;
      throw e;
    }
    return id;
  }

  listProjects(): { id: string; name: string }[] {
    return this.db.prepare("SELECT id, name FROM projects ORDER BY name").all() as { id: string; name: string }[];
  }

  // ---------- L1 追加 ----------

  remember(projectId: string | null, sessionId: string | null, ephemeral: boolean, body: RememberBody): string {
    checkRememberBody(body); // 种类、长度、密钥在入口一次查完（§8.11.2），内部不再重复判断
    return this.append("remember", projectId, sessionId, ephemeral, null, body);
  }

  /** detail 事件：给已有条目补上原来没有的正文和否掉的方案（§8.11.2）。不换 id、不改确认状态和关联。 */
  detail(targetId: string, sessionId: string | null, body: DetailBody): string {
    const p = this.project().props.get(targetId);
    if (!p) throw new Error(`unknown or purged proposition: ${targetId}`);
    checkDetailBody(p.kind, body, p.evidence.length);
    return this.append("detail", p.project_id, sessionId, false, targetId, body);
  }

  /**
   * 补详情（onlyIfNeeded）：条目已经有的字段不补，全都有就不写事件。
   * 导入重导用：只在正文、否掉的方案、原话都齐了说“不用补”。返回写入的事件 id 或 null。
   */
  detailIfMissing(targetId: string, sessionId: string | null, body: DetailBody): string | null {
    const p = this.project().props.get(targetId);
    if (!p) throw new Error(`unknown or purged proposition: ${targetId}`);
    const wantBody = body.body !== undefined && p.body === null;
    const wantAlt = !!body.alternatives?.length && !p.alternatives.length;
    if (!wantBody && !wantAlt) return null;
    return this.detail(targetId, sessionId, {
      ...(wantBody ? { body: body.body } : {}),
      ...(wantAlt ? { alternatives: body.alternatives } : {}),
    });
  }

  /** archive/reactivate/confirm/unconfirm/tag/stage/curate：目标必须是当前投影里存在的 proposition，否则 fail-closed 拒绝。 */
  lifecycle(kind: "archive" | "reactivate" | "confirm" | "unconfirm" | "tag" | "stage" | "curate", targetId: string, sessionId: string | null, body: object = {}): string {
    const p = this.project().props.get(targetId);
    if (!p) throw new Error(`unknown or purged proposition: ${targetId}`);
    if (kind === "tag") checkTagBody(body as TagBody);
    return this.append(kind, p.project_id, sessionId, false, targetId, body); // body 非 null；null 一律表示已 purge
  }

  /**
   * 先检查再写去留事件，检查和写入在同一个写事务里（防止检查之后、写入之前被别的进程改了状态）。
   * check 返回 null 才写；返回原因字符串就不写，原样返回。目标不在投影里也不写。
   */
  lifecycleIf(kind: "archive" | "reactivate" | "confirm" | "unconfirm" | "tag" | "stage" | "curate", targetId: string, sessionId: string | null, body: object, check: (p: Proposition) => string | null): { id: string } | { skipped: string } {
    if (kind === "tag") checkTagBody(body as TagBody);
    const id = randomUUID();
    const json = JSON.stringify(body);
    this.assertWritable();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const p = this.project().props.get(targetId);
      const why = p ? check(p) : "已不在库里";
      if (why !== null || !p) {
        this.db.exec("ROLLBACK");
        return { skipped: why ?? "已不在库里" };
      }
      this.assertSessionOpen(sessionId);
      this.insertEvent(id, kind, p.project_id, sessionId, false, targetId, json);
      this.db.exec("COMMIT");
    } catch (e) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw e;
    }
    return { id };
  }

  /** 目标条目最近一条去留类事件（archive/reactivate/curate/stage）的 id；没有为 null。ab curate --undo 据此确认这一步没被后来的操作取代。 */
  lastStateEvent(targetId: string): string | null {
    const r = this.db
      .prepare("SELECT id FROM events WHERE target_id=? AND kind IN ('archive','reactivate','curate','stage') AND body IS NOT NULL ORDER BY seq DESC LIMIT 1")
      .get(targetId) as { id: string } | undefined;
    return r?.id ?? null;
  }

  /** 目标条目最近一条改 guidance 的 tag 事件 id；没有为 null。撤销转正时据此确认 guidance 没被用户后来改过。 */
  lastGuidanceTag(targetId: string): string | null {
    const r = this.db
      .prepare("SELECT id FROM events WHERE target_id=? AND kind='tag' AND body IS NOT NULL AND json_extract(body,'$.guidance') IS NOT NULL ORDER BY seq DESC LIMIT 1")
      .get(targetId) as { id: string } | undefined;
    return r?.id ?? null;
  }

  /** 某次 ab curate --apply 写下的事件（body.run 或 body.curate.run 等于 run），按写入顺序。--undo 以 L1 为准，不全靠报告。 */
  curateRunEvents(run: string): { id: string; kind: EventKind; target_id: string | null; body: any }[] {
    const rows = this.db
      .prepare("SELECT id, kind, target_id, body FROM events WHERE body IS NOT NULL AND (json_extract(body,'$.run')=? OR json_extract(body,'$.curate.run')=?) ORDER BY seq")
      .all(run, run) as { id: string; kind: EventKind; target_id: string | null; body: string }[];
    return rows.map((r) => ({ ...r, body: JSON.parse(r.body) }));
  }

  /** 某次话题沉淀（ab work，§8.6）写进库的 remember 事件（body.topic.run 等于 run），按写入顺序。 */
  topicRunEvents(run: string): { id: string; body: RememberBody }[] {
    const rows = this.db
      .prepare("SELECT id, body FROM events WHERE kind='remember' AND body IS NOT NULL AND json_extract(body,'$.topic.run')=? ORDER BY seq")
      .all(run) as { id: string; body: string }[];
    return rows.map((r) => ({ id: r.id, body: JSON.parse(r.body) as RememberBody }));
  }

  /** 该会话已被 purge。 */
  sessionPurged(sessionId: string): boolean {
    return !!this.db
      .prepare("SELECT 1 AS x FROM events WHERE kind='purge' AND json_extract(body,'$.range.session_id')=? LIMIT 1")
      .get(sessionId);
  }

  /** 已存向量的最近邻（不发请求）。query 由调用方算好。只看 active，范围为给定项目加全局，余弦 ≥ minSim。 */
  nearestByVector(query: Float32Array, projectId: string | null, limit: number, minSim: number): { prop: Proposition; similarity: number }[] {
    const props = this.project().props;
    const rows = this.fts.prepare("SELECT id,text_hash,vec FROM vecs").all() as { id: string; text_hash: string; vec: Uint8Array }[];
    return rows.flatMap((r) => {
      const p = props.get(r.id);
      if (!p || !searchable(p)) return [];
      if (p.project_id !== null && p.project_id !== projectId) return [];
      if (r.text_hash !== textHash(vectorText(p))) return [];
      const v = fromBlob(r.vec);
      if (v.length !== query.length) return [];
      const similarity = cosine(query, v);
      return similarity >= minSim ? [{ prop: p, similarity }] : [];
    }).sort((a, b) => b.similarity - a.similarity).slice(0, limit);
  }

  /** work store（§19.2）与 L1 同库。只给 intake.ts 用。 */
  /** 记一次"被注入"（recall / brief 输出了这条）。不进 L1：只是运维统计，用于到期复审。 */
  markUsed(ids: readonly string[], now: Date): void {
    if (!ids.length) return;
    const st = this.db.prepare("INSERT INTO prop_usage(prop_id,last_used,uses) VALUES(?,?,1) ON CONFLICT(prop_id) DO UPDATE SET last_used=excluded.last_used, uses=uses+1");
    const at = now.toISOString();
    for (const id of ids) st.run(id, at);
  }

  /** 召回时引文核对失败的条目排队，下次 ab work 优先重新核验（verify_queue，运维表，不进 L1）。 */
  queueReverify(ids: readonly string[], now: Date): void {
    if (!ids.length) return;
    const st = this.db.prepare("INSERT OR IGNORE INTO verify_queue(prop_id,at) VALUES(?,?)");
    for (const id of ids) st.run(id, now.toISOString());
  }

  usage(): Map<string, { last_used: string; uses: number }> {
    const rows = this.db.prepare("SELECT prop_id,last_used,uses FROM prop_usage").all() as { prop_id: string; last_used: string; uses: number }[];
    return new Map(rows.map((r) => [r.prop_id, { last_used: r.last_used, uses: r.uses }]));
  }

  get workDb(): DatabaseSync {
    return this.db;
  }

  /**
   * 一个事务里追加若干 L1 事件，并执行 work store 的写入（§19.2：L1 追加、窗口完成、checkpoint 推进同生共死）。
   * work 抛错时整体回滚。返回各事件 id。
   */
  commit(appends: PendingAppend[], work: (db: DatabaseSync, ids: string[]) => void): string[] {
    const ids = appends.map(() => randomUUID());
    // 抽取和导入也走这个入口：remember/detail 的种类、长度、密钥检查在这里一并跑
    const props = this.project().props;
    for (const a of appends) {
      if (a.kind === "remember") checkRememberBody(a.body as RememberBody);
      else if (a.kind === "tag") checkTagBody(a.body as TagBody);
      else if (a.kind === "detail") {
        const target = a.target_id ? props.get(a.target_id) : undefined;
        if (!target) throw new Error(`unknown or purged proposition: ${a.target_id}`);
        checkDetailBody(target.kind, a.body as DetailBody, target.evidence.length);
      }
    }
    this.assertWritable();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      appends.forEach((a, i) => {
        this.assertSessionOpen(a.session_id);
        this.insertEvent(ids[i], a.kind, a.project_id, a.session_id, false, a.target_id, JSON.stringify(a.body));
      });
      work(this.db, ids);
      this.db.exec("COMMIT");
    } catch (e) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw e;
    }
    return ids;
  }

  private append(
    kind: EventKind,
    projectId: string | null,
    sessionId: string | null,
    ephemeral: boolean,
    targetId: string | null,
    body: unknown,
  ): string {
    const id = randomUUID();
    const json = body === null ? null : JSON.stringify(body);
    this.assertWritable();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.assertSessionOpen(sessionId);
      this.insertEvent(id, kind, projectId, sessionId, ephemeral, targetId, json);
      this.db.exec("COMMIT");
    } catch (e) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw e;
    }
    return id;
  }

  /** 写事务内调用。session_id 为 null 不受 purge 屏障影响。 */
  private assertSessionOpen(sessionId: string | null): void {
    if (sessionId === null) return;
    const hit = this.db
      .prepare("SELECT 1 AS x FROM events WHERE kind='purge' AND json_extract(body,'$.range.session_id')=? LIMIT 1")
      .get(sessionId) as { x: number } | undefined;
    if (hit) throw new Error("该会话已清除，不再接受写入");
  }

  // ---------- Purge（§10.2.1/10.2.2、§12.6.3：范围 = session；声明 + 枚举同一事务） ----------

  /**
   * 清除一个会话。成员是这个会话写的事件，加上指向这些记忆的后续事件（详情、关系判定、代码核验、去留）。
   * 同一事务清掉正文、哈希、操作者、机器和统计表里的相关行；之后删表重建全文索引，两个库各做 VACUUM 和 WAL 截断，
   * 否则明文还留在空闲页里。已声明过的会话再跑只补做各面，不重复写声明。
   */
  purgeSession(sessionId: string): PurgeResult {
    this.assertWritable();
    const members = "kind!='purge' AND (session_id=?1 OR target_id IN (SELECT id FROM events WHERE session_id=?1 AND kind='remember'))";
    let purgeId: string | null = null;
    let ids: string[];
    let props: string[];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      props = (this.db.prepare("SELECT id FROM events WHERE session_id=? AND kind='remember' ORDER BY seq").all(sessionId) as { id: string }[]).map((r) => r.id);
      ids = (this.db.prepare(`SELECT id FROM events WHERE ${members} ORDER BY seq`).all(sessionId) as { id: string }[]).map((r) => r.id);
      if (!this.sessionPurged(sessionId)) {
        purgeId = randomUUID();
        this.insertEvent(purgeId, "purge", null, null, false, null, JSON.stringify({ range: { session_id: sessionId }, enumerated: ids }));
      }
      this.db.prepare(`UPDATE events SET body=NULL, body_hash=NULL, actor=NULL, machine=NULL WHERE ${members}`).run(sessionId);
      // 统计表：按记忆 id 删（别的会话引用过它的行也删，inject_log.cited_title 是模型抄的标题），再按会话删
      for (const [table, col] of [["prop_usage", "prop_id"], ["inject_log", "prop_id"], ["verify_attempts", "prop_id"], ["verify_queue", "prop_id"], ["memory_report_ids", "prop_id"]]) {
        const del = this.db.prepare(`DELETE FROM ${table} WHERE ${col}=?`);
        for (const id of props) del.run(id);
      }
      const delCand = this.db.prepare("DELETE FROM capture_candidates WHERE event_id=?");
      for (const id of ids) delCand.run(id);
      this.db.prepare("DELETE FROM capture_candidates WHERE window_id IN (SELECT window_id FROM capture_windows WHERE session_id=?)").run(sessionId);
      for (const table of ["inject_log", "recall_runs", "memory_queries", "memory_report_ids", "memory_reports", "cite_scan", "capture_windows"]) {
        this.db.prepare(`DELETE FROM ${table} WHERE session_id=?`).run(sessionId);
      }
      // 坐标行留着并标记：扫描不会把它当成新会话再登记、再抽取
      this.db.prepare("UPDATE capture_sessions SET error_code='purged', processed_anchor=NULL WHERE session_id=?").run(sessionId);
      this.db.exec("COMMIT");
    } catch (e) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw e;
    }
    this.cache = null;
    const surfaces: PurgeResult["surfaces"] = [
      { name: "L1 正文", ok: true, detail: `${ids.length} 条事件，${props.length} 条记忆` },
      { name: "统计表", ok: true, detail: "使用计数、注入记录、核验记录、候选键、引用报告" },
    ];
    const face = (name: string, fn: () => string) => {
      try {
        const partial = fn();
        surfaces.push({ name, ok: !partial, detail: partial || "已完成" });
      } catch (e) {
        surfaces.push({ name, ok: false, detail: e instanceof Error ? e.message : String(e) });
      }
    };
    face("全文索引与向量", () => (this.rebuildIndex(), ""));
    face("store.db 空闲页", () => compact(this.db));
    face("index.db 空闲页", () => compact(this.fts));
    return { purge_event: purgeId, enumerated: ids, props, surfaces };
  }

  /** 清除范围里还带正文的事件数和记忆 id（给清除前的预览用，只读）。 */
  purgeMembers(sessionId: string): { events: number; props: string[] } {
    const members = "kind!='purge' AND body IS NOT NULL AND (session_id=?1 OR target_id IN (SELECT id FROM events WHERE session_id=?1 AND kind='remember'))";
    const n = this.db.prepare(`SELECT count(*) AS n FROM events WHERE ${members}`).get(sessionId) as { n: number };
    const props = this.db.prepare("SELECT id FROM events WHERE session_id=? AND kind='remember' AND body IS NOT NULL ORDER BY seq").all(sessionId) as { id: string }[];
    return { events: Number(n.n), props: props.map((r) => r.id) };
  }

  sessionHasBodies(sessionId: string): boolean {
    return this.purgeMembers(sessionId).events > 0;
  }

  /** 登记表里这个会话的对话文件路径（清除时只报告，不删）。 */
  sessionTranscripts(sessionId: string): string[] {
    const rows = this.db.prepare("SELECT DISTINCT transcript FROM capture_sessions WHERE session_id=? AND transcript IS NOT NULL").all(sessionId) as { transcript: string }[];
    return rows.map((r) => r.transcript);
  }

  eventCount(): number {
    return Number((this.db.prepare("SELECT count(*) AS n FROM events").get() as { n: number }).n);
  }

  /** 两个库文件各做 VACUUM 和 WAL 截断；返回没做完的原因，空数组表示都做完。 */
  compact(): string[] {
    const out: string[] = [];
    for (const [name, db] of [["store.db", this.db], ["index.db", this.fts]] as const) {
      try {
        const why = compact(db);
        if (why) out.push(`${name}: ${why}`);
      } catch (e) {
        out.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return out;
  }

  /** 库里已声明清除的会话（恢复备份后要对恢复出来的内容重做一遍，§12.6.4）。 */
  purgedSessions(): string[] {
    const rows = this.db.prepare("SELECT DISTINCT json_extract(body,'$.range.session_id') AS s FROM events WHERE kind='purge' AND body IS NOT NULL").all() as { s: string | null }[];
    return rows.flatMap((r) => (r.s ? [r.s] : []));
  }

  /** 删表重建全文索引：DELETE 只写删除标记，旧段里还留着词项。没有对应条目的向量在 writeIndex 里一并删掉。 */
  private rebuildIndex(): void {
    this.fts.exec("BEGIN IMMEDIATE");
    try {
      this.fts.exec("DROP TABLE IF EXISTS props");
      this.fts.exec(FTS_SCHEMA);
      this.fts.exec("DELETE FROM meta WHERE key='seq'");
      this.fts.exec("COMMIT");
    } catch (e) {
      if (this.fts.isTransaction) this.fts.exec("ROLLBACK");
      throw e;
    }
    this.writeIndex(this.watermark(), this.project());
  }

  // ---------- 备份与恢复（§12.6.4） ----------

  /** 把 store.db 写成一个独立文件（VACUUM INTO：一致快照，不含空闲页）。目标已存在会报错。 */
  backupTo(path: string): void {
    this.db.exec(`VACUUM INTO '${path.replaceAll("'", "''")}'`);
  }

  /**
   * 把各表内容换成备份文件里的，一个写事务：别的进程要么看到换之前的库，要么看到换之后的，不动库文件本身。
   * 只拷两边都有的列（旧备份缺的列留空）；备份里没有的表被清空。事件序号只进不退，索引整个重建。
   */
  restoreFrom(path: string): { copied: string[]; emptied: string[]; events: number } {
    this.assertWritable();
    const before = this.watermark();
    const copied: string[] = [];
    const emptied: string[] = [];
    this.db.exec(`ATTACH DATABASE '${path.replaceAll("'", "''")}' AS bk`);
    try {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.exec("PRAGMA defer_foreign_keys=ON");
        const tables = (schema: string) => (this.db.prepare(`SELECT name FROM ${schema}.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).all() as { name: string }[]).map((r) => r.name);
        const cols = (schema: string, table: string) => (this.db.prepare(`PRAGMA ${schema}.table_info("${table}")`).all() as { name: string }[]).map((c) => c.name);
        const inBackup = new Set(tables("bk"));
        for (const t of tables("main")) {
          if (t === "work_lease") continue; // 恢复期间自己拿着租约，不能被备份里的旧行换掉
          this.db.exec(`DELETE FROM main."${t}"`);
          if (!inBackup.has(t)) {
            emptied.push(t);
            continue;
          }
          const theirs = new Set(cols("bk", t));
          const common = cols("main", t).filter((c) => theirs.has(c)).map((c) => `"${c}"`).join(",");
          this.db.exec(`INSERT INTO main."${t}"(${common}) SELECT ${common} FROM bk."${t}"`);
          copied.push(t);
        }
        // 序号退回去会让新事件复用旧序号，索引水位就可能误判成“已是最新”
        this.db.prepare("UPDATE sqlite_sequence SET seq=MAX(seq, ?) WHERE name='events'").run(before);
        this.db.exec("COMMIT");
      } catch (e) {
        if (this.db.isTransaction) this.db.exec("ROLLBACK");
        throw e;
      }
    } finally {
      this.db.exec("DETACH DATABASE bk");
    }
    this.cache = null;
    this.rebuildIndex();
    return { copied, emptied, events: Number((this.db.prepare("SELECT count(*) AS n FROM events").get() as { n: number }).n) };
  }

  // ---------- L2：纯函数投影；缓存按 L1 水位校验（§7.3） ----------

  private watermark(): number {
    const row = this.db.prepare("SELECT max(seq) AS seq FROM events").get() as { seq: number | null };
    return row.seq ?? 0;
  }

  project(): Projection {
    const seq = this.watermark();
    if (this.cache && this.cacheSeq === seq) return this.cache;
    const rows = this.db.prepare("SELECT * FROM events ORDER BY seq").all() as unknown as EventRow[];
    this.cache = fold(rows);
    this.cacheSeq = seq;
    return this.cache;
  }

  // ---------- L3：水位不一致就整表重建 ----------

  /** 索引行的形状随投影规则变（§8.8 去掉候选区后 state 不再有 candidate）：版本不对就当没建过，整表重建。 */
  private indexedSeq(): number {
    const v = this.fts.prepare("SELECT value FROM meta WHERE key='index_version'").get() as { value: string } | undefined;
    if (v?.value !== INDEX_VERSION) return -1;
    const row = this.fts.prepare("SELECT value FROM meta WHERE key='seq'").get() as { value: string } | undefined;
    return row ? Number(row.value) : -1;
  }

  private syncIndex(): void {
    this.writeIndex(this.watermark(), this.project());
  }

  // ponytail: 水位变化时整表重建 FTS；超过 1 万条再改增量
  /** 事务内重读 meta：只有投影水位严格大于 meta 才覆盖，水位只能前进。测试可直接传入旧投影。 */
  writeIndex(seq: number, projection: Projection): boolean {
    this.fts.exec("BEGIN IMMEDIATE");
    try {
      if (seq <= this.indexedSeq()) {
        this.fts.exec("ROLLBACK");
        return false;
      }
      this.fts.exec("DELETE FROM props");
      const ins = this.fts.prepare("INSERT INTO props(id,project_id,kind,state,text) VALUES(?,?,?,?,?)");
      for (const p of projection.props.values()) {
        ins.run(p.id, p.project_id ?? "", p.kind, p.state, indexText(p));
      }
      this.fts.exec("DELETE FROM vecs WHERE id NOT IN (SELECT id FROM props)");
      this.fts.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('seq',?)").run(String(seq));
      this.fts.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('index_version',?)").run(INDEX_VERSION);
      this.fts.exec("COMMIT");
      return true;
    } catch (e) {
      if (this.fts.isTransaction) this.fts.exec("ROLLBACK");
      throw e;
    }
  }

  private embeddingModel(): string | null {
    const row = this.fts.prepare("SELECT value FROM meta WHERE key='embed_model'").get() as { value: string } | undefined;
    return row?.value ?? null;
  }

  vectorStatus(): { model: string | null; embedded: number; total: number } {
    const total = this.project().props.size;
    return { model: this.embeddingModel(), embedded: total - this.pendingVectors().length, total };
  }

  private pendingVectors(): { id: string; text: string; text_hash: string }[] {
    const hashes = new Map(
      (this.fts.prepare("SELECT id,text_hash FROM vecs").all() as { id: string; text_hash: string }[])
        .map((r) => [r.id, r.text_hash]),
    );
    return [...this.project().props.values()].map((p) => {
      const text = vectorText(p);
      return { id: p.id, text, text_hash: textHash(text) };
    }).filter((p) => hashes.get(p.id) !== p.text_hash);
  }

  async syncVectors(embedder: Embedder, model: string): Promise<{ embedded: number; pending: number }> {
    this.fts.exec("BEGIN IMMEDIATE");
    try {
      if (this.embeddingModel() !== model) {
        this.fts.exec("DELETE FROM vecs");
        this.fts.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('embed_model',?)").run(model);
      }
      this.fts.exec("COMMIT");
    } catch (e) {
      if (this.fts.isTransaction) this.fts.exec("ROLLBACK");
      throw e;
    }
    const batch = this.pendingVectors().slice(0, MAX_EMBED_PER_SYNC);
    if (!batch.length) return { embedded: 0, pending: 0 };
    const vectors = await embedder(batch.map((p) => p.text));
    if (vectors.length !== batch.length) throw new Error("embedding 返回的条数不一致");
    let embedded = 0;
    this.fts.exec("BEGIN IMMEDIATE");
    try {
      if (this.embeddingModel() !== model) throw new Error("embedding 模型在请求期间已变化");
      const current = this.project().props;
      const ins = this.fts.prepare("INSERT OR REPLACE INTO vecs(id,text_hash,vec) VALUES(?,?,?)");
      for (let i = 0; i < batch.length; i++) {
        const p = current.get(batch[i].id);
        if (!p || textHash(vectorText(p)) !== batch[i].text_hash) continue;
        ins.run(p.id, batch[i].text_hash, toBlob(vectors[i]));
        embedded++;
      }
      this.fts.exec("COMMIT");
    } catch (e) {
      if (this.fts.isTransaction) this.fts.exec("ROLLBACK");
      throw e;
    }
    return { embedded, pending: this.pendingVectors().length };
  }

  /** 所有与当前文本一致的已存向量（只读，不发网络请求）；供 ab view 画图和算近邻。 */
  currentVectors(): Map<string, Float32Array> {
    const props = this.project().props;
    const out = new Map<string, Float32Array>();
    for (const r of this.fts.prepare("SELECT id,text_hash,vec FROM vecs").all() as { id: string; text_hash: string; vec: Uint8Array }[]) {
      const p = props.get(r.id);
      if (p && r.text_hash === textHash(vectorText(p))) out.set(r.id, fromBlob(r.vec));
    }
    return out;
  }

  /** 用 index.db 里已存的向量找近邻，不发网络请求。范围限本条所在项目加全局，只看 active。本条没有当前向量时返回 null。 */
  neighbors(id: string): { prop: Proposition; similarity: number }[] | null {
    const props = this.project().props;
    const p = props.get(id);
    if (!p) return null;
    const rows = this.fts.prepare("SELECT id,text_hash,vec FROM vecs").all() as { id: string; text_hash: string; vec: Uint8Array }[];
    const own = rows.find((r) => r.id === id);
    if (!own || own.text_hash !== textHash(vectorText(p))) return null;
    const query = fromBlob(own.vec);
    return rows.flatMap((r) => {
      const n = props.get(r.id);
      if (!n || n.id === id || !searchable(n)) return [];
      if (n.project_id !== null && n.project_id !== p.project_id) return [];
      if (r.text_hash !== textHash(vectorText(n))) return [];
      const similarity = cosine(query, fromBlob(r.vec));
      return similarity >= VEC_MIN_SIM ? [{ prop: n, similarity }] : [];
    }).sort((a, b) => b.similarity - a.similarity);
  }

  /**
   * 每轮召回用：查询向量与给定条目的余弦。只算 ids 里的条目（资格过滤在调用方先做完，见坑 43150a18）；
   * 没有向量、或向量对应的正文已变（text_hash 不符）的条目不给值。
   */
  similarities(queryVec: Float32Array, ids: ReadonlySet<string>): Map<string, number> {
    const props = this.project().props;
    const out = new Map<string, number>();
    const rows = this.fts.prepare("SELECT id,text_hash,vec FROM vecs").all() as { id: string; text_hash: string; vec: Uint8Array }[];
    for (const row of rows) {
      if (!ids.has(row.id)) continue;
      const p = props.get(row.id);
      if (!p || textHash(vectorText(p)) !== row.text_hash) continue;
      out.set(row.id, cosine(queryVec, fromBlob(row.vec)));
    }
    return out;
  }

  async searchHybrid(query: string, opts: SearchOpts, embedder: Embedder | null): Promise<{ hits: SearchHit[]; cross?: CrossProjectResult; degraded: string | null }> {
    const limit = opts.limit ?? 8;
    const ftsHits = () => this.search(query, { ...opts, limit: HYBRID_FTS_K });
    const lex = (hs: SearchHit[]) => hs.map((h) => ({ ...h, lexical: true }));
    if (!embedder) return { hits: lex(ftsHits()).slice(0, limit), degraded: "未配置 embedding" };
    const reasons: string[] = [];
    const model = embedder.model ?? this.embeddingModel() ?? "未指定模型";
    if (!opts.skipSync) {
      try {
        await this.syncVectors(embedder, model);
      } catch (e) {
        reasons.push(`向量未更新：${e instanceof Error ? e.message : String(e)}`);
      }
    }
    try {
      const [queryVec] = await embedder([query]);
      if (!queryVec) throw new Error("embedding 未返回查询向量");
      if (this.embeddingModel() !== model) throw new Error("embedding 模型在请求期间已变化");
      const lexical = ftsHits();
      const props = this.project().props;
      const dense: { hit: SearchHit; similarity: number }[] = [];
      const rows = this.fts.prepare("SELECT id,text_hash,vec FROM vecs").all() as { id: string; text_hash: string; vec: Uint8Array }[];
      for (const row of rows) {
        const p = props.get(row.id);
        if (!p) continue;
        if (p.project_id === null ? !opts.includeGlobal : opts.projects !== "all" && !opts.projects.includes(p.project_id)) continue;
        if (opts.kind && p.kind !== opts.kind) continue;
        if (!opts.includeArchived && !searchable(p)) continue;
        if (textHash(vectorText(p)) !== row.text_hash) continue;
        const similarity = cosine(queryVec, fromBlob(row.vec));
        if (similarity >= (opts.minSim ?? VEC_MIN_SIM)) dense.push({ hit: { id: p.id, project_id: p.project_id, kind: p.kind, text: indexText(p), state: p.state }, similarity });
      }
      dense.sort((a, b) => b.similarity - a.similarity);
      // CANDIDATE：RRF k=60，切片 2 测试集校准融合方式。
      const fused = new Map<string, { hit: SearchHit; score: number }>();
      for (const list of [lexical, dense.slice(0, HYBRID_VEC_K).map((p) => p.hit)]) {
        list.forEach((hit, i) => {
          const entry = fused.get(hit.id) ?? { hit, score: 0 };
          entry.score += 1 / (60 + i + 1);
          fused.set(hit.id, entry);
        });
      }
      const sim = new Map(dense.map((d) => [d.hit.id, d.similarity]));
      const inLexical = new Set(lexical.map((h) => h.id));
      const hits = [...fused.values()].sort((a, b) => b.score - a.score).slice(0, limit).map((p) => ({
        ...p.hit,
        ...(sim.has(p.hit.id) ? { similarity: sim.get(p.hit.id) } : {}),
        ...(inLexical.has(p.hit.id) ? { lexical: true } : {}),
      }));
      const cross = opts.crossProject ? this.crossProjectHits(queryVec, opts.crossProject.excludeProjectId, opts.kind) : undefined;
      return { hits, ...(cross ? { cross } : {}), degraded: reasons.length ? reasons.join("；") : null };
    } catch (e) {
      reasons.push(`向量检索不可用：${e instanceof Error ? e.message : String(e)}`);
      return { hits: lex(ftsHits()).slice(0, limit), degraded: reasons.join("；") };
    }
  }

  /**
   * §8.11.4 跨项目段：候选先限定为其他项目的 active 条目，再按与查询向量的余弦排序、过门槛、取前几条。
   * 不从全库 top-N 里事后筛，否则本项目条目把位置占满时跨项目条目永远出不来。
   */
  private crossProjectHits(query: Float32Array, excludeProjectId: string, kind: PropKind | undefined): CrossProjectResult {
    const props = this.project().props;
    const stored = new Map(
      (this.fts.prepare("SELECT id,text_hash,vec FROM vecs").all() as { id: string; text_hash: string; vec: Uint8Array }[])
        .map((r) => [r.id, r]),
    );
    const hits: CrossProjectHit[] = [];
    let pending = 0;
    for (const p of props.values()) {
      if (p.project_id === null || p.project_id === excludeProjectId || !searchable(p)) continue;
      if (kind && p.kind !== kind) continue;
      const row = stored.get(p.id);
      const vec = row && row.text_hash === textHash(vectorText(p)) ? fromBlob(row.vec) : null;
      if (!vec || vec.length !== query.length) {
        pending++;
        continue;
      }
      const similarity = cosine(query, vec);
      if (similarity >= CROSS_PROJECT_MIN_SIM) hits.push({ id: p.id, project_id: p.project_id, kind: p.kind, text: indexText(p), state: p.state, similarity });
    }
    hits.sort((a, b) => b.similarity - a.similarity);
    return { hits: hits.slice(0, CROSS_PROJECT_MAX), pending };
  }

  search(query: string, opts: SearchOpts): SearchHit[] {
    const seq = this.watermark();
    // index 水位高于 store：store.db 被换过，旧索引作废
    if (this.indexedSeq() > seq) this.fts.exec("DELETE FROM meta WHERE key='seq'");
    if (this.indexedSeq() !== seq) this.writeIndex(seq, this.project());
    const limit = Math.min(opts.limit ?? 8, 20);
    const terms = query.split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];
    const where: string[] = [];
    const args: unknown[] = [];
    const scope: string[] = [];
    if (opts.projects === "all") scope.push("project_id != ''");
    else if (opts.projects.length) {
      scope.push(`project_id IN (${opts.projects.map(() => "?").join(",")})`);
      args.push(...opts.projects);
    }
    if (opts.includeGlobal) scope.push("project_id = ''");
    if (!scope.length) return [];
    where.push("(" + scope.join(" OR ") + ")");
    if (opts.kind) {
      where.push("kind=?");
      args.push(opts.kind);
    }
    if (!opts.includeArchived) where.push("state='active'");
    // trigram 需要 ≥3 个字符；短词退回 LIKE
    const shortTerm = terms.some((t) => [...t].length < 3);
    let sql: string;
    if (shortTerm) {
      where.push("(" + terms.map(() => "text LIKE ?").join(" OR ") + ")");
      for (const t of terms) args.push(`%${t}%`);
      sql = `SELECT id,project_id,kind,text,state FROM props WHERE ${where.join(" AND ")} LIMIT ?`;
    } else {
      where.push("props MATCH ?");
      args.push(terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR "));
      sql = `SELECT id,project_id,kind,text,state FROM props WHERE ${where.join(" AND ")} ORDER BY bm25(props) LIMIT ?`;
    }
    args.push(limit);
    const rows = this.fts.prepare(sql).all(...(args as any[])) as unknown as (SearchHit & { project_id: string })[];
    return rows.map((r) => ({ ...r, project_id: r.project_id === "" ? null : r.project_id }));
  }
}
