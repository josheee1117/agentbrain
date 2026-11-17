/**
 * 数据安全的三个操作（设计 §12.6.3、§12.6.4）：清除一个会话、备份、恢复。
 * 只做编排和文件面；L1、统计表、索引的事务在 store.ts。数字都是代码常量，没有配置键。
 */
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { SCHEMA_VERSION, tighten, type PurgeResult, type Store } from "./store.ts";

/** 自己命名的备份留最近几份；手工复制的文件不动。 */
export const BACKUP_KEEP = 14;
/** ab work --sweep 发现距上次备份超过这么久就做一次。 */
export const BACKUP_EVERY_MS = 24 * 3_600_000;
const BACKUP_PREFIX = "ab-backup-";
/** 清除后找残留时，单个非数据库文件超过这个大小就不读（只报告没查）。 */
const SCAN_MAX_BYTES = 32 * 1024 * 1024;
const SCAN_DEPTH = 4;

export function backupDir(home: string): string {
  return join(home, "backups");
}

function stamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

export interface DbInfo {
  ok: boolean;
  reason?: string;
  events: number;
  maxSeq: number;
  version: number;
}

/** 只读打开一个库文件，查完整性、版本和事件数。打不开或不是 agentbrain 的库时 ok=false。 */
export function inspectDb(path: string): DbInfo {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const check = (db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check;
    const version = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
    const row = db.prepare("SELECT count(*) AS n, coalesce(max(seq),0) AS m FROM events").get() as { n: number; m: number };
    return { ok: check === "ok", ...(check === "ok" ? {} : { reason: `完整性检查没过：${check}` }), events: Number(row.n), maxSeq: Number(row.m), version };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e), events: 0, maxSeq: 0, version: 0 };
  } finally {
    try {
      db?.close();
    } catch {
      // 已经打不开的库
    }
  }
}

/** 自己命名的备份，新的在前。 */
export function listBackups(home: string): { path: string; at: Date; bytes: number }[] {
  let names: string[];
  try {
    names = readdirSync(backupDir(home));
  } catch {
    return [];
  }
  return names
    .filter((n) => n.startsWith(BACKUP_PREFIX) && n.endsWith(".db"))
    .sort()
    .reverse()
    .flatMap((n) => {
      const path = join(backupDir(home), n);
      try {
        const st = statSync(path);
        return [{ path, at: st.mtime, bytes: st.size }];
      } catch {
        return [];
      }
    });
}

export function backupDue(home: string, now: Date): boolean {
  const last = listBackups(home)[0];
  return !last || now.getTime() - last.at.getTime() >= BACKUP_EVERY_MS;
}

/** 写一份备份并核对；只留最近 BACKUP_KEEP 份自己命名的。核对不过就删掉这份并抛错。 */
export function backup(store: Store, home: string, now: Date, prefix = BACKUP_PREFIX): { path: string; events: number; removed: string[] } {
  const dir = backupDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  tighten(dir, 0o700);
  let path = join(dir, `${prefix}${stamp(now)}.db`);
  for (let i = 2; existsSync(path); i++) path = join(dir, `${prefix}${stamp(now)}-${i}.db`);
  const before = store.eventCount();
  store.backupTo(path);
  tighten(path, 0o600);
  const info = inspectDb(path);
  if (!info.ok || info.events < before) {
    rmSync(path, { force: true });
    throw new Error(`备份没通过核对（${info.reason ?? `事件 ${info.events} 条，少于备份前的 ${before} 条`}），已删除这份`);
  }
  const removed: string[] = [];
  if (prefix === BACKUP_PREFIX) {
    for (const old of listBackups(home).slice(BACKUP_KEEP)) {
      rmSync(old.path, { force: true });
      removed.push(old.path);
    }
  }
  return { path, events: info.events, removed };
}

export interface RestoreReport {
  from: string;
  saved: string;
  events: number;
  emptied: string[];
  /** 现库里声明过清除、恢复后重做了一遍的会话。 */
  repurged: string[];
  /** 没做完的面（库文件空闲页等）。 */
  partial: string[];
}

/**
 * 用备份文件换掉现库的内容。先核对备份，把现库另存一份，再在一个事务里换；
 * 现库里已有的清除声明对恢复出来的内容重做一遍，清除过的东西不会跟着备份回来。
 */
export function restore(store: Store, home: string, file: string, now: Date): RestoreReport {
  const info = inspectDb(file);
  if (!info.ok) throw new Error(`备份文件不能用：${info.reason}`);
  if (info.version > SCHEMA_VERSION) throw new Error(`备份的库版本 ${info.version} 比代码支持的 ${SCHEMA_VERSION} 新，先更新 ab 的代码`);
  const purged = store.purgedSessions();
  const saved = backup(store, home, now, "pre-restore-").path;
  const r = store.restoreFrom(file);
  const repurged: string[] = [];
  const partial: string[] = [];
  for (const s of purged) {
    if (!store.sessionHasBodies(s) && store.sessionPurged(s)) continue;
    const res = store.purgeSession(s);
    repurged.push(s);
    partial.push(...res.surfaces.filter((x) => !x.ok).map((x) => `${x.name}: ${x.detail}`));
  }
  if (!repurged.length) partial.push(...store.compact());
  return { from: file, saved, events: r.events, emptied: r.emptied, repurged, partial };
}

// ---------- 清除 ----------

export type FaceStatus = "成功" | "部分" | "失败" | "不在范围";

export interface PurgeFace {
  name: string;
  status: FaceStatus;
  detail: string;
  paths?: string[];
}

export interface PurgeReport {
  session: string;
  result: PurgeResult;
  faces: PurgeFace[];
  /** 所有受控面都清干净了。 */
  complete: boolean;
}

function isSqlite(path: string): boolean {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const head = Buffer.alloc(16);
    readSync(fd, head, 0, 16, 0);
    return head.toString("latin1").startsWith("SQLite format 3");
  } catch {
    return false;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function walk(dir: string, depth: number, out: string[]): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names) {
    const path = join(dir, n);
    let st;
    try {
      st = lstatSync(path);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      if (depth > 0) walk(path, depth - 1, out);
    } else if (st.isFile()) out.push(path);
  }
}

/** 一个库副本里这个会话还有没有带正文的事件。读不了返回 null。 */
function sessionBodiesIn(path: string, sessionId: string): number | null {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    if (!db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='events'").get()) return 0;
    const members = "kind!='purge' AND body IS NOT NULL AND (session_id=?1 OR target_id IN (SELECT id FROM events WHERE session_id=?1 AND kind='remember'))";
    return Number((db.prepare(`SELECT count(*) AS n FROM events WHERE ${members}`).get(sessionId) as { n: number }).n);
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // 打不开的文件
    }
  }
}

/** 清除前给人看的范围：多少事件、哪些记忆、之前是否已清除过。只读。 */
export function purgePlan(store: Store, sessionId: string): { events: number; props: { id: string; kind: string; text: string }[]; already: boolean; transcripts: string[] } {
  const members = store.purgeMembers(sessionId);
  const live = store.project().props;
  return {
    events: members.events,
    props: members.props.flatMap((id) => {
      const p = live.get(id);
      return p ? [{ id, kind: p.kind, text: p.text.split("\n")[0].slice(0, 60) }] : [];
    }),
    already: store.sessionPurged(sessionId),
    transcripts: store.sessionTranscripts(sessionId),
  };
}

/** 执行清除并逐面报告（§10.2.3 第 4 条）。调用方负责确认是人在终端里发起的。 */
export function purge(store: Store, home: string, sessionId: string, opts: { dropBackups: boolean }): PurgeReport {
  const transcripts = store.sessionTranscripts(sessionId);
  const result = store.purgeSession(sessionId);
  const faces: PurgeFace[] = result.surfaces.map((s) => ({ name: s.name, status: s.ok ? "成功" : "失败", detail: s.detail }));
  const add = (name: string, fn: () => PurgeFace | Omit<PurgeFace, "name">) => {
    try {
      faces.push({ name, ...fn() });
    } catch (e) {
      faces.push({ name, status: "失败", detail: e instanceof Error ? e.message : String(e) });
    }
  };

  add("看板 view.html", () => {
    const view = join(home, "view.html");
    if (!existsSync(view)) return { status: "成功", detail: "没有生成过" };
    rmSync(view, { force: true });
    return { status: "成功", detail: "已删除，要看板重跑 ab view" };
  });

  const files: string[] = [];
  walk(home, SCAN_DEPTH, files);
  const own = new Set([join(home, "store.db"), join(home, "index.db")]);
  const dbs = files.filter((f) => !own.has(f) && !/-(wal|shm)$/.test(f) && isSqlite(f));
  const dbSet = new Set(dbs);

  add("备份与库副本", () => {
    const hit: string[] = [];
    const unread: string[] = [];
    for (const f of dbs) {
      const n = sessionBodiesIn(f, sessionId);
      if (n === null) unread.push(f);
      else if (n > 0) hit.push(f);
    }
    if (opts.dropBackups) {
      for (const f of hit) for (const suffix of ["", "-wal", "-shm"]) rmSync(f + suffix, { force: true });
    }
    const left = opts.dropBackups ? unread : [...hit, ...unread];
    if (!left.length) return { status: "成功", detail: hit.length ? `删除了 ${hit.length} 个含这个会话的库副本` : `查了 ${dbs.length} 个库副本，都不含这个会话的正文` };
    return {
      status: "部分",
      detail: `${opts.dropBackups ? "" : `${hit.length} 个库副本仍含这个会话的正文，加 --drop-backups 删除；`}${unread.length ? `${unread.length} 个文件读不了，没法确认` : ""}`.replace(/；$/, ""),
      paths: left,
    };
  });

  add("报告与调试文件", () => {
    // 被清除的记忆 id 和会话 id 是找残留的唯一线索：正文已经不在库里了
    const needles = [sessionId, ...result.props].map((s) => Buffer.from(s));
    const hit: string[] = [];
    const skipped: string[] = [];
    let removed = 0;
    for (const f of files) {
      if (own.has(f) || dbSet.has(f) || /\.db-(wal|shm)$/.test(f) || f === join(home, "work.log")) continue;
      let buf: Buffer;
      try {
        if (statSync(f).size > SCAN_MAX_BYTES) {
          skipped.push(f);
          continue;
        }
        buf = readFileSync(f);
      } catch {
        continue; // 刚被删掉
      }
      if (!needles.some((n) => buf.includes(n))) continue;
      if (f.startsWith(join(home, "debug") + "/")) {
        rmSync(f, { force: true });
        removed++;
      } else hit.push(f);
    }
    const left = [...hit, ...skipped];
    if (!left.length) return { status: "成功", detail: removed ? `删除了 ${removed} 个调试文件` : "没有文件提到这个会话或被清除的记忆" };
    return {
      status: "部分",
      detail: `${hit.length ? `${hit.length} 个文件提到这个会话或被清除的记忆，看过后手动删除` : ""}${hit.length && skipped.length ? "；" : ""}${skipped.length ? `${skipped.length} 个文件太大没查` : ""}${removed ? `；另删除了 ${removed} 个调试文件` : ""}`,
      paths: left,
    };
  });

  faces.push({
    name: "宿主会话文件",
    status: "不在范围",
    detail: transcripts.length ? "原对话不归 agentbrain 管，还在宿主的会话目录里，要删请自己删" : "库里没有记这个会话的文件路径",
    ...(transcripts.length ? { paths: transcripts } : {}),
  });
  return { session: sessionId, result, faces, complete: faces.every((f) => f.status === "成功" || f.status === "不在范围") };
}

export function renderPurge(r: PurgeReport): string {
  const lines = [`清除会话 ${r.session}${r.result.purge_event ? "" : "（之前已声明过清除，这次只补做各面）"}：`];
  for (const f of r.faces) {
    lines.push(`  ${f.name}: ${f.status}（${f.detail}）`);
    for (const p of f.paths ?? []) lines.push(`    ${p}`);
  }
  lines.push(r.complete ? "结果: 受控的面都清干净了。" : "结果: 部分完成。上面标「部分」「失败」的面处理后重跑同一条命令。");
  return lines.join("\n");
}
