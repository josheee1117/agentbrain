/**
 * agentbrain 切片 1 存储层（设计 §12.2 / §19.1 / §19.2 已裁决形态）。
 *
 * - store.db：L1 事件表（append-only，purge 只清正文留墓碑）+ projects/bindings 注册表
 * - index.db：L3 FTS5 trigram 索引，随时可删，打开即从 L2 重建
 * - L2：`project()` 是 L1 上的纯函数，不落盘（同一 L1 → 同一 L2）
 *
 * 预算类数字全部是代码常量（§2.2），本文件零配置键。
 */
import { DatabaseSync } from "node:sqlite";
import { randomUUID, createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type PropKind = "pitfall" | "decision" | "note";
export type EventKind = "remember" | "archive" | "reactivate" | "purge";

export interface SourcePointer {
  file: string | null; // Pi session 文件；ephemeral 会话为 null
  entry_id: string | null; // 记忆时的 leaf entry id
  summary: string; // 一句话：讨论了什么
}

export interface RememberBody {
  kind: PropKind;
  text: string;
  why?: string;
  source: SourcePointer;
}

export interface Proposition {
  id: string;
  seq: number;
  ts: string;
  project_id: string;
  session_id: string | null;
  kind: PropKind;
  text: string;
  why?: string;
  source: SourcePointer;
  state: "active" | "archived";
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
  kind: PropKind;
  text: string;
  state: "active" | "archived";
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects(
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS bindings(
  root TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id));
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
CREATE VIRTUAL TABLE IF NOT EXISTS props USING fts5(
  id UNINDEXED, project_id UNINDEXED, kind UNINDEXED, state UNINDEXED, text,
  tokenize='trigram');
`;

function openDb(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
  return db;
}

export class Store {
  private db: DatabaseSync;
  private fts: DatabaseSync;
  private cache: Projection | null = null;

  constructor(storePath: string, indexPath: string) {
    this.db = openDb(storePath);
    this.db.exec(SCHEMA);
    this.fts = openDb(indexPath);
    this.fts.exec(FTS_SCHEMA);
    this.reindex();
  }

  close(): void {
    this.db.close();
    this.fts.close();
  }

  // ---------- 项目绑定（§6.1：只认显式绑定，cwd 不授予身份） ----------

  bind(root: string, name: string): string {
    const now = new Date().toISOString();
    let row = this.db.prepare("SELECT id FROM projects WHERE name=?").get(name) as { id: string } | undefined;
    if (!row) {
      row = { id: randomUUID() };
      this.db.prepare("INSERT INTO projects(id,name,created_at) VALUES(?,?,?)").run(row.id, name, now);
    }
    this.db.prepare("INSERT OR REPLACE INTO bindings(root,project_id) VALUES(?,?)").run(root, row.id);
    return row.id;
  }

  projectFor(root: string): { id: string; name: string } | null {
    const row = this.db
      .prepare("SELECT p.id, p.name FROM bindings b JOIN projects p ON p.id=b.project_id WHERE b.root=?")
      .get(root) as { id: string; name: string } | undefined;
    return row ?? null;
  }

  // ---------- L1 追加 ----------

  remember(projectId: string, sessionId: string | null, ephemeral: boolean, body: RememberBody): string {
    return this.append("remember", projectId, sessionId, ephemeral, null, body);
  }

  /** archive/reactivate：目标必须是当前投影里存在的 proposition，否则 fail-closed 拒绝。 */
  lifecycle(kind: "archive" | "reactivate", targetId: string, sessionId: string | null): string {
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
    this.db
      .prepare(
        "INSERT INTO events(id,ts,kind,project_id,session_id,ephemeral,target_id,body,body_hash) VALUES(?,?,?,?,?,?,?,?,?)",
      )
      .run(id, new Date().toISOString(), kind, projectId, sessionId, ephemeral ? 1 : 0, targetId, json, hash);
    this.invalidate();
    return id;
  }

  // ---------- Purge（§10.2.1/10.2.2：范围 = session；声明 + 枚举同一事务） ----------

  purgeSession(sessionId: string): { purge_event: string; enumerated: string[] } {
    const ids = (
      this.db.prepare("SELECT id FROM events WHERE session_id=? AND kind!='purge' ORDER BY seq").all(sessionId) as {
        id: string;
      }[]
    ).map((r) => r.id);
    this.db.exec("BEGIN");
    try {
      const purgeId = randomUUID();
      const decl = JSON.stringify({ range: { session_id: sessionId }, enumerated: ids });
      this.db
        .prepare("INSERT INTO events(id,ts,kind,project_id,session_id,ephemeral,target_id,body,body_hash) VALUES(?,?,?,?,?,?,?,?,?)")
        .run(purgeId, new Date().toISOString(), "purge", null, null, 0, null, decl, createHash("sha256").update(decl).digest("hex"));
      this.db.prepare("UPDATE events SET body=NULL, body_hash=NULL WHERE session_id=? AND kind!='purge'").run(sessionId);
      this.db.exec("COMMIT");
      this.invalidate();
      return { purge_event: purgeId, enumerated: ids };
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  // ---------- L2：纯函数投影 ----------

  project(): Projection {
    if (this.cache) return this.cache;
    const rows = this.db.prepare("SELECT * FROM events ORDER BY seq").all() as unknown as EventRow[];
    this.cache = fold(rows);
    return this.cache;
  }

  private invalidate(): void {
    this.cache = null;
    this.reindex();
  }

  // ---------- L3：FTS 索引，整表重建 ----------

  // ponytail: 每次写入整表重建 FTS；超过 1 万条再改增量
  reindex(): void {
    const { props } = this.project();
    this.fts.exec("BEGIN");
    this.fts.exec("DELETE FROM props");
    const ins = this.fts.prepare("INSERT INTO props(id,project_id,kind,state,text) VALUES(?,?,?,?,?)");
    for (const p of props.values()) ins.run(p.id, p.project_id, p.kind, p.state, p.why ? `${p.text}\n${p.why}` : p.text);
    this.fts.exec("COMMIT");
  }

  search(projectId: string, query: string, opts: { kind?: PropKind; limit?: number; includeArchived?: boolean } = {}): SearchHit[] {
    const limit = Math.min(opts.limit ?? 8, 20);
    const terms = query.split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];
    const where: string[] = ["project_id=?"];
    const args: unknown[] = [projectId];
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
      sql = `SELECT id,kind,text,state FROM props WHERE ${where.join(" AND ")} LIMIT ?`;
    } else {
      where.push("props MATCH ?");
      args.push(terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR "));
      sql = `SELECT id,kind,text,state FROM props WHERE ${where.join(" AND ")} ORDER BY bm25(props) LIMIT ?`;
    }
    args.push(limit);
    return this.fts.prepare(sql).all(...(args as any[])) as unknown as SearchHit[];
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
        project_id: r.project_id!,
        session_id: r.session_id,
        kind: b.kind,
        text: b.text,
        why: b.why,
        source: b.source,
        state: "active",
      });
      continue;
    }
    const target = r.target_id ? props.get(r.target_id) : undefined;
    if (!target) {
      orphans++; // unknown parent / purged target：fail-closed 跳过
      continue;
    }
    target.state = r.kind === "archive" ? "archived" : "active";
  }
  return { props, orphans, ephemeral, purged };
}
