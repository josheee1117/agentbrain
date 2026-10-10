/**
 * agentbrain 存储层（设计 §12.2 / §19.1 / §19.2，切片 1.5）。
 *
 * - store.db：L1 事件表（append-only，purge 只清正文留墓碑）+ projects 注册表
 * - index.db：L3 FTS5 trigram 索引，随时可删；水位与 store 不一致时重建
 * - L2：`project()` 是 L1 上的纯函数，不落盘（同一 L1 → 同一 L2）
 *
 * 预算类数字全部是代码常量（§2.2），本文件零配置键。
 */
import { DatabaseSync } from "node:sqlite";
import { randomUUID, createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type PropKind = "rule" | "decision" | "pitfall" | "note";
export type EventKind = "remember" | "archive" | "reactivate" | "confirm" | "purge";
export type Host = "claude" | "codex" | "pi";

const BUSY_TIMEOUT_MS = 5000;

export interface SourcePointer {
  host: Host | null;
  session_id: string | null;
  transcript: string | null; // transcript 文件；ephemeral 会话为 null
  anchor: string | null; // 记忆时的定位点：pi entry id / claude uuid / codex ordinal
  summary: string; // 一句话：讨论了什么
  /** 主会话转记子代理汇报时，记录当时的主会话。 */
  relayed_by?: { host: Host; session_id: string | null } | null;
}

export interface RememberBody {
  kind: PropKind;
  text: string;
  why?: string;
  source: SourcePointer;
  /** 子代理也要看。只对全局记忆有意义（§11.1）。 */
  for_workers?: boolean;
  /** 用户明确要求记的为 true。旧数据可缺，投影时缺字段按已确认。 */
  confirmed: boolean;
  /** 这条是对某条已有记忆的纠正。只有本条已确认时才会把目标标成 superseded。 */
  supersedes?: string;
}

export interface Proposition {
  id: string;
  seq: number;
  ts: string;
  project_id: string | null; // null = 全局
  session_id: string | null;
  kind: PropKind;
  text: string;
  why?: string;
  source: SourcePointer;
  for_workers: boolean;
  confirmed: boolean;
  state: "active" | "archived" | "superseded";
  supersedes?: string;
  superseded_by?: string;
}

export interface Projection {
  props: Map<string, Proposition>;
  /** 指向不存在/已清除目标的 meta-lifecycle 事件，fail-closed 跳过并计数（§14.2） */
  orphans: number;
  ephemeral: number;
  purged: number;
}

interface EventRow {
  seq: number;
  id: string;
  ts: string;
  kind: EventKind;
  project_id: string | null;
  session_id: string | null;
  ephemeral: number;
  target_id: string | null;
  body: string | null;
}

export interface SearchHit {
  id: string;
  project_id: string | null;
  kind: PropKind;
  text: string;
  state: "active" | "archived" | "superseded";
}

export interface SearchOpts {
  /** 项目 id 列表，或 "all" 搜全部项目。 */
  projects: string[] | "all";
  includeGlobal: boolean;
  kind?: PropKind;
  includeArchived?: boolean;
  limit?: number;
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
`;

const FTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
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

export class Store {
  private db: DatabaseSync;
  private fts: DatabaseSync;
  private cache: Projection | null = null;
  private cacheSeq = -1;

  constructor(storePath: string, indexPath: string) {
    this.db = openDb(storePath);
    this.db.exec(SCHEMA);
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

  /** archive/reactivate/confirm：目标必须是当前投影里存在的 proposition，否则 fail-closed 拒绝。 */
  lifecycle(kind: "archive" | "reactivate" | "confirm", targetId: string, sessionId: string | null): string {
    const p = this.project().props.get(targetId);
    if (!p) throw new Error(`unknown or purged proposition: ${targetId}`);
    return this.append(kind, p.project_id, sessionId, false, targetId, {}); // body 非 null；null 一律表示已 purge
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
        ins.run(p.id, p.project_id ?? "", p.kind, p.state, p.why ? `${p.text}\n${p.why}` : p.text);
      }
      this.fts.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('seq',?)").run(String(seq));
      this.fts.exec("COMMIT");
      return true;
    } catch (e) {
      if (this.fts.isTransaction) this.fts.exec("ROLLBACK");
      throw e;
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

/** 确定性投影：同一事件序列必然产生同一结果；不调用任何外部状态。 */
export function fold(rows: EventRow[]): Projection {
  const props = new Map<string, Proposition>();
  let orphans = 0;
  let ephemeral = 0;
  let purged = 0;
  for (const r of rows) {
    if (r.kind === "purge") continue;
    if (r.body === null) {
      purged++;
      continue;
    }
    if (r.ephemeral) {
      ephemeral++;
      continue; // §9.5：记录但默认不投影
    }
    if (r.kind === "remember") {
      const b = JSON.parse(r.body) as RememberBody;
      props.set(r.id, {
        id: r.id,
        seq: r.seq,
        ts: r.ts,
        project_id: r.project_id,
        session_id: r.session_id,
        kind: b.kind,
        text: b.text,
        why: b.why,
        source: b.source,
        for_workers: b.for_workers === true,
        confirmed: b.confirmed !== false,
        state: "active",
        supersedes: b.supersedes,
      });
      continue;
    }
    const target = r.target_id ? props.get(r.target_id) : undefined;
    if (!target) {
      orphans++; // unknown parent / purged target：fail-closed 跳过
      continue;
    }
    if (r.kind === "confirm") {
      target.confirmed = true;
      continue;
    }
    target.state = r.kind === "archive" ? "archived" : "active";
  }
  // 未确认的纠正不改旧条目：agent 的推断不能盖掉已确认的结论。
  for (const p of props.values()) {
    if (!p.confirmed || !p.supersedes || p.state !== "active") continue;
    const target = props.get(p.supersedes);
    if (!target) {
      orphans++;
      continue;
    }
    target.state = "superseded";
    target.superseded_by = p.id;
  }
  return { props, orphans, ephemeral, purged };
}
