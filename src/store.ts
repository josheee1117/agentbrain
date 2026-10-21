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
import { randomUUID, createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { cosine, fromBlob, toBlob } from "./embed.ts";
import { fold, type EventKind, type EventRow, type PropKind, type PropState, type Projection, type Proposition, type RememberBody } from "./l2.ts";

const BUSY_TIMEOUT_MS = 5000;
export const MAX_EMBED_PER_SYNC = 200;
const HYBRID_FTS_K = 20;
const HYBRID_VEC_K = 20;
// 2026-10-10 测试集（53 条 / 121 查询）校准：0.45 召回 93%、负例误报 33%；每轮召回另用更严的 minSim。
export const VEC_MIN_SIM = 0.45;

export type Embedder = ((texts: string[]) => Promise<Float32Array[]>) & { model?: string };


export interface SearchHit {
  id: string;
  project_id: string | null;
  kind: PropKind;
  text: string;
  state: PropState;
  /** 向量相似度（只有向量命中才有；纯全文检索命中没有）。 */
  similarity?: number;
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
  body_hash TEXT);
CREATE INDEX IF NOT EXISTS events_session ON events(session_id);
CREATE TABLE IF NOT EXISTS capture_sessions(
  host TEXT NOT NULL, session_id TEXT NOT NULL, transcript TEXT, cwd TEXT, project TEXT,
  first_seen TEXT NOT NULL, last_touch TEXT NOT NULL, ended_at TEXT,
  ephemeral INTEGER NOT NULL DEFAULT 0, processed_anchor TEXT, via TEXT NOT NULL, error_code TEXT,
  PRIMARY KEY(host, session_id));
CREATE TABLE IF NOT EXISTS capture_windows(
  window_id TEXT PRIMARY KEY, host TEXT NOT NULL, session_id TEXT NOT NULL,
  from_anchor TEXT, to_anchor TEXT NOT NULL, state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, next_at TEXT, error_code TEXT, receipt TEXT, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS capture_candidates(candidate_key TEXT PRIMARY KEY, event_id TEXT NOT NULL, window_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS work_lease(name TEXT PRIMARY KEY, holder TEXT NOT NULL, pid INTEGER NOT NULL, expires_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS work_budget(day TEXT PRIMARY KEY, calls INTEGER NOT NULL, tokens INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS verify_attempts(prop_id TEXT PRIMARY KEY, head TEXT NOT NULL, outcome TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS work_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS verify_queue(prop_id TEXT PRIMARY KEY, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS prop_usage(prop_id TEXT PRIMARY KEY, last_used TEXT NOT NULL, uses INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS inject_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, host TEXT, session_id TEXT, transcript TEXT, project_id TEXT,
  prop_id TEXT NOT NULL, path TEXT NOT NULL, rank INTEGER NOT NULL,
  cited INTEGER NOT NULL DEFAULT 0, cited_at TEXT, cited_title TEXT, title_mismatch INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS inject_log_session ON inject_log(host, session_id);
CREATE INDEX IF NOT EXISTS inject_log_prop ON inject_log(prop_id);
CREATE TABLE IF NOT EXISTS recall_runs(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, host TEXT, session_id TEXT, project_id TEXT,
  outcome TEXT NOT NULL, n_hits INTEGER NOT NULL, ms INTEGER NOT NULL, cite INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS cite_scan(host TEXT NOT NULL, session_id TEXT NOT NULL, model TEXT, marked_turns INTEGER NOT NULL, scanned_at TEXT NOT NULL, PRIMARY KEY(host, session_id));
`;

/** 旧库补列（CREATE TABLE IF NOT EXISTS 不会给已有表加列）。 */
function addColumn(db: DatabaseSync, table: string, col: string, decl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
}

export interface PendingAppend {
  kind: EventKind;
  project_id: string | null;
  session_id: string | null;
  target_id: string | null;
  body: unknown;
}

const FTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS vecs(id TEXT PRIMARY KEY, text_hash TEXT NOT NULL, vec BLOB NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS props USING fts5(
  id UNINDEXED, project_id UNINDEXED, kind UNINDEXED, state UNINDEXED, text,
  tokenize='trigram');
`;

function openDb(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS}`);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
  return db;
}

function indexText(p: Proposition): string {
  return p.why ? `${p.text}\n${p.why}` : p.text;
}

function textHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export class Store {
  private db: DatabaseSync;
  private fts: DatabaseSync;
  private cache: Projection | null = null;
  private cacheSeq = -1;

  constructor(storePath: string, indexPath: string) {
    this.db = openDb(storePath);
    this.db.exec(SCHEMA);
    addColumn(this.db, "recall_runs", "failed", "INTEGER NOT NULL DEFAULT 0");
    addColumn(this.db, "inject_log", "failed", "INTEGER NOT NULL DEFAULT 0");
    this.fts = openDb(indexPath);
    this.fts.exec(FTS_SCHEMA);
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
    return this.append("remember", projectId, sessionId, ephemeral, null, body);
  }

  /** archive/reactivate/confirm/unconfirm/tag/stage/curate：目标必须是当前投影里存在的 proposition，否则 fail-closed 拒绝。 */
  lifecycle(kind: "archive" | "reactivate" | "confirm" | "unconfirm" | "tag" | "stage" | "curate", targetId: string, sessionId: string | null, body: object = {}): string {
    const p = this.project().props.get(targetId);
    if (!p) throw new Error(`unknown or purged proposition: ${targetId}`);
    return this.append(kind, p.project_id, sessionId, false, targetId, body); // body 非 null；null 一律表示已 purge
  }

  /**
   * 先检查再写去留事件，检查和写入在同一个写事务里（防止检查之后、写入之前被别的进程改了状态）。
   * check 返回 null 才写；返回原因字符串就不写，原样返回。目标不在投影里也不写。
   */
  lifecycleIf(kind: "archive" | "reactivate" | "confirm" | "unconfirm" | "tag" | "stage" | "curate", targetId: string, sessionId: string | null, body: object, check: (p: Proposition) => string | null): { id: string } | { skipped: string } {
    const id = randomUUID();
    const json = JSON.stringify(body);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const p = this.project().props.get(targetId);
      const why = p ? check(p) : "已不在库里";
      if (why !== null || !p) {
        this.db.exec("ROLLBACK");
        return { skipped: why ?? "已不在库里" };
      }
      this.assertSessionOpen(sessionId);
      this.db
        .prepare("INSERT INTO events(id,ts,kind,project_id,session_id,ephemeral,target_id,body,body_hash) VALUES(?,?,?,?,?,?,?,?,?)")
        .run(id, new Date().toISOString(), kind, p.project_id, sessionId, 0, targetId, json, createHash("sha256").update(json).digest("hex"));
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

  /** since 之后写入的 remember 事件（未 purge、非 ephemeral），按写入顺序。 */
  rememberEventsSince(since: string): { id: string; body: RememberBody }[] {
    const rows = this.db
      .prepare("SELECT id, body FROM events WHERE kind='remember' AND ephemeral=0 AND body IS NOT NULL AND ts >= ? ORDER BY seq")
      .all(since) as { id: string; body: string }[];
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
      if (!p || p.state !== "active") return [];
      if (p.project_id !== null && p.project_id !== projectId) return [];
      if (r.text_hash !== textHash(indexText(p))) return [];
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
    const ins = this.db.prepare(
      "INSERT INTO events(id,ts,kind,project_id,session_id,ephemeral,target_id,body,body_hash) VALUES(?,?,?,?,?,?,?,?,?)",
    );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      appends.forEach((a, i) => {
        this.assertSessionOpen(a.session_id);
        const json = JSON.stringify(a.body);
        ins.run(ids[i], new Date().toISOString(), a.kind, a.project_id, a.session_id, 0, a.target_id, json, createHash("sha256").update(json).digest("hex"));
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
    const hash = json === null ? null : createHash("sha256").update(json).digest("hex");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.assertSessionOpen(sessionId);
      this.db
        .prepare(
          "INSERT INTO events(id,ts,kind,project_id,session_id,ephemeral,target_id,body,body_hash) VALUES(?,?,?,?,?,?,?,?,?)",
        )
        .run(id, new Date().toISOString(), kind, projectId, sessionId, ephemeral ? 1 : 0, targetId, json, hash);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
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

  // ---------- Purge（§10.2.1/10.2.2：范围 = session；声明 + 枚举同一事务） ----------

  purgeSession(sessionId: string): { purge_event: string; enumerated: string[] } {
    this.db.exec("BEGIN IMMEDIATE");
    let result: { purge_event: string; enumerated: string[] };
    try {
      const ids = (
        this.db.prepare("SELECT id FROM events WHERE session_id=? AND kind!='purge' ORDER BY seq").all(sessionId) as {
          id: string;
        }[]
      ).map((r) => r.id);
      const purgeId = randomUUID();
      const decl = JSON.stringify({ range: { session_id: sessionId }, enumerated: ids });
      this.db
        .prepare("INSERT INTO events(id,ts,kind,project_id,session_id,ephemeral,target_id,body,body_hash) VALUES(?,?,?,?,?,?,?,?,?)")
        .run(purgeId, new Date().toISOString(), "purge", null, null, 0, null, decl, createHash("sha256").update(decl).digest("hex"));
      this.db.prepare("UPDATE events SET body=NULL, body_hash=NULL WHERE session_id=? AND kind!='purge'").run(sessionId);
      this.db.exec("COMMIT");
      result = { purge_event: purgeId, enumerated: ids };
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    this.syncIndex();
    return result;
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

  private indexedSeq(): number {
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
      const text = indexText(p);
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
        if (!p || textHash(indexText(p)) !== batch[i].text_hash) continue;
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
      if (p && r.text_hash === textHash(indexText(p))) out.set(r.id, fromBlob(r.vec));
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
    if (!own || own.text_hash !== textHash(indexText(p))) return null;
    const query = fromBlob(own.vec);
    return rows.flatMap((r) => {
      const n = props.get(r.id);
      if (!n || n.id === id || n.state !== "active") return [];
      if (n.project_id !== null && n.project_id !== p.project_id) return [];
      if (r.text_hash !== textHash(indexText(n))) return [];
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
      if (!p || textHash(indexText(p)) !== row.text_hash) continue;
      out.set(row.id, cosine(queryVec, fromBlob(row.vec)));
    }
    return out;
  }

  async searchHybrid(query: string, opts: SearchOpts, embedder: Embedder | null): Promise<{ hits: SearchHit[]; degraded: string | null }> {
    const limit = opts.limit ?? 8;
    const ftsHits = () => this.search(query, { ...opts, limit: HYBRID_FTS_K });
    if (!embedder) return { hits: ftsHits().slice(0, limit), degraded: "未配置 embedding" };
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
        if (!opts.includeArchived && p.state !== "active") continue;
        if (textHash(indexText(p)) !== row.text_hash) continue;
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
      const hits = [...fused.values()].sort((a, b) => b.score - a.score).slice(0, limit).map((p) => (sim.has(p.hit.id) ? { ...p.hit, similarity: sim.get(p.hit.id) } : p.hit));
      return { hits, degraded: reasons.length ? reasons.join("；") : null };
    } catch (e) {
      reasons.push(`向量检索不可用：${e instanceof Error ? e.message : String(e)}`);
      return { hits: ftsHits().slice(0, limit), degraded: reasons.join("；") };
    }
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
