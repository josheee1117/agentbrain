/**
 * 数据安全（设计 §12.6.1–§12.6.5）：库版本号与未知事件、操作者和机器、清除、备份恢复、文件权限。
 * 走真实 Store 和真实 ab 子进程，库都在临时目录。运行：node --test src/admin.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { hostname, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { SCHEMA_VERSION, Store } from "./store.ts";
import { BACKUP_KEEP, backup, inspectDb, listBackups, purge, purgePlan, restore } from "./admin.ts";
import type { SourcePointer } from "./l2.ts";

const CLI = join(import.meta.dirname, "cli.ts");
const src = (session: string | null = null): SourcePointer => ({ host: session ? "claude" : null, session_id: session, transcript: null, anchor: null, summary: "测试" });
const scratch = () => realpathSync(mkdtempSync(join(tmpdir(), "ab-admin-")));
const open = (dir: string) => new Store(join(dir, "store.db"), join(dir, "index.db"));
const mode = (p: string) => statSync(p).mode & 0o777;
const occurrences = (file: string, needle: string) => {
  const buf = readFileSync(file);
  const n = Buffer.from(needle);
  let c = 0;
  for (let i = buf.indexOf(n); i !== -1; i = buf.indexOf(n, i + 1)) c++;
  return c;
};
const rawInsert = (dir: string, kind: string, target: string | null, body = "{}") => {
  const raw = new DatabaseSync(join(dir, "store.db"));
  raw.prepare("INSERT INTO events(id,ts,kind,project_id,session_id,ephemeral,target_id,body,body_hash) VALUES(?,?,?,?,?,?,?,?,?)").run(randomUUID(), new Date().toISOString(), kind, null, null, 0, target, body, "x");
  raw.close();
};

// ---------- §12.6.1 未知事件与库版本 ----------

test("不认识的事件种类不改条目状态，只计数", () => {
  const dir = scratch();
  let s = open(dir);
  const id = s.remember(null, null, false, { kind: "rule", text: "这条被用户归档了", confirmed: true, source: src() });
  s.lifecycle("archive", id, null);
  s.close();
  rawInsert(dir, "forget", id); // 更新版本的代码写下的、本版本不认识的种类
  rawInsert(dir, "rescope", null);
  s = open(dir);
  const p = s.project();
  assert.equal(p.props.get(id)!.state, "archived", "归档的条目不能被未知事件恢复生效");
  assert.equal(p.unknown, 2);
  assert.equal(p.orphans, 0, "未知种类不算成 orphan");
  assert.equal(s.search("这条被用户归档了", { projects: [], includeGlobal: true }).length, 0);
  s.close();
});

test("新库带版本号；旧库打开时补列，旧事件照常投影", () => {
  const dir = scratch();
  const raw = new DatabaseSync(join(dir, "store.db"));
  // 这次改动之前的 events 表：没有 actor / machine，user_version 是 0
  raw.exec(`CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, ts TEXT NOT NULL, kind TEXT NOT NULL,
    project_id TEXT, session_id TEXT, ephemeral INTEGER NOT NULL DEFAULT 0, target_id TEXT, body TEXT, body_hash TEXT)`);
  raw.exec(`CREATE TABLE capture_windows(window_id TEXT PRIMARY KEY, host TEXT NOT NULL, session_id TEXT NOT NULL, from_anchor TEXT, to_anchor TEXT NOT NULL,
    state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at TEXT, error_code TEXT, receipt TEXT, updated_at TEXT NOT NULL)`);
  const old = randomUUID();
  raw.prepare("INSERT INTO events(id,ts,kind,body,body_hash) VALUES(?,?,?,?,?)").run(old, "2026-10-10T00:00:00.000Z", "remember", JSON.stringify({ kind: "rule", text: "旧事件", confirmed: true, source: src() }), "x");
  raw.close();

  const s = open(dir);
  assert.deepEqual(s.schema, { version: SCHEMA_VERSION, supported: SCHEMA_VERSION, readOnly: false });
  const before = s.project().props.get(old)!;
  assert.equal(before.text, "旧事件");
  assert.deepEqual(before.written_by, { actor: null, machine: null }, "旧事件没有操作者，照常投影");
  const neu = s.remember(null, null, false, { kind: "rule", text: "新事件", confirmed: true, source: src() });
  assert.deepEqual(s.project().props.get(neu)!.written_by, { actor: userInfo().username, machine: hostname() });
  s.close();
  const check = new DatabaseSync(join(dir, "store.db"), { readOnly: true });
  assert.equal((check.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, SCHEMA_VERSION);
  assert.ok((check.prepare("PRAGMA table_info(capture_windows)").all() as { name: string }[]).some((c) => c.name === "error_detail"));
  check.close();
});

test("库比代码新：能读，拒绝写入，报出原因", () => {
  const dir = scratch();
  let s = open(dir);
  const id = s.remember(null, null, false, { kind: "rule", text: "先写一条", confirmed: true, source: src() });
  s.close();
  const raw = new DatabaseSync(join(dir, "store.db"));
  raw.exec(`PRAGMA user_version=${SCHEMA_VERSION + 1}`);
  raw.close();
  s = open(dir);
  assert.equal(s.schema.readOnly, true);
  assert.equal(s.project().props.get(id)!.text, "先写一条");
  assert.throws(() => s.remember(null, null, false, { kind: "rule", text: "不该写进去", confirmed: true, source: src() }), /库版本 2 比代码支持的 1 新，拒绝写入/);
  assert.throws(() => s.lifecycle("archive", id, null), /拒绝写入/);
  assert.throws(() => s.workDb.prepare("INSERT INTO work_meta(key,value) VALUES('k','v')").run(), /readonly/i, "统计表和后台队列的写入同样被拒");
  assert.equal(s.eventCount(), 1);
  s.close();
  const r = spawnSync(process.execPath, [CLI, "remember", "--global", "--kind", "rule", "--text", "x", "--summary", "y"], { env: { ...process.env, AB_HOME: dir, AB_REGISTRY: join(dir, "repos"), HOME: dir }, encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /拒绝写入/);
});

// ---------- §12.6.2 操作者和机器 ----------

test("每条新事件带操作者和机器；转正的那条事件也查得到", () => {
  const dir = scratch();
  const s = new Store(join(dir, "store.db"), join(dir, "index.db"), { actor: "alice", machine: "mac-a" });
  const id = s.remember(null, "sess-1", false, { kind: "rule", text: "未确认的一条", confirmed: false, source: src("sess-1") });
  assert.equal(s.project().props.get(id)!.confirmed_event, null);
  s.close();
  const t = new Store(join(dir, "store.db"), join(dir, "index.db"), { actor: "bob", machine: "mac-b" });
  t.lifecycle("confirm", id, "sess-2");
  const p = t.project().props.get(id)!;
  assert.deepEqual(p.written_by, { actor: "alice", machine: "mac-a" });
  assert.equal(p.confirmed_by, "user");
  assert.deepEqual({ ...p.confirmed_event, ts: undefined }, { actor: "bob", machine: "mac-b", session_id: "sess-2", ts: undefined });
  const rows = t.workDb.prepare("SELECT kind, actor, machine FROM events ORDER BY seq").all();
  assert.deepEqual(rows.map((r) => ({ ...r })), [{ kind: "remember", actor: "alice", machine: "mac-a" }, { kind: "confirm", actor: "bob", machine: "mac-b" }]);
  t.close();
});

// ---------- §12.6.3 清除 ----------

test("清除：两个库文件里搜不到明文；后续事件、统计表一起清；别的会话不受影响；重跑不重复声明", () => {
  const dir = scratch();
  const MARK = "ZXQ机密标记7731";
  const s = open(dir);
  const gone = s.remember(null, "sess-P", false, { kind: "note", text: `${MARK} 这句话要被清除`, body: `正文里也有 ${MARK}`, confirmed: true, source: src("sess-P") });
  const keep = s.remember(null, "sess-K", false, { kind: "note", text: "别的会话写的，要留下", confirmed: true, source: src("sess-K") });
  // 指向被清除记忆的后续事件（没有会话 id，像后台的关系判定）：理由里抄了原文
  s.commit([{ kind: "relate", project_id: null, session_id: null, target_id: gone, body: { outcome: "unrelated", target: null, reason: `和 ${MARK} 无关`, model: "m" } }], () => {});
  // 别的会话写的纠正指向它：纠正本身留下，但不能因为目标被清除而算成损坏
  const fix = s.remember(null, "sess-K", false, { kind: "note", text: "纠正后的说法", confirmed: true, supersedes: gone, source: src("sess-K") });
  s.search(MARK, { projects: [], includeGlobal: true });
  s.markUsed([gone, keep], new Date());
  s.workDb.prepare("INSERT INTO inject_log(ts,host,session_id,prop_id,path,cited_title) VALUES(?,?,?,?,?,?)").run(new Date().toISOString(), "claude", "sess-other", gone, "search", `${MARK} 标题`);
  writeFileSync(join(dir, "view.html"), `<html>${MARK}</html>`);
  mkdirSync(join(dir, "debug"));
  writeFileSync(join(dir, "debug", "claude-sess-P-abc.json"), JSON.stringify({ session: "sess-P", text: MARK }));
  mkdirSync(join(dir, "curate"));
  writeFileSync(join(dir, "curate", "run-1.json"), JSON.stringify({ items: [gone] }));
  const copy = backup(s, dir, new Date("2026-11-01T00:00:00Z")).path; // 清除前做的备份里还有这段正文

  const plan = purgePlan(s, "sess-P");
  assert.deepEqual({ events: plan.events, props: plan.props.map((p) => p.id), already: plan.already }, { events: 2, props: [gone], already: false });

  const r = purge(s, dir, "sess-P", { dropBackups: false });
  assert.equal(r.result.enumerated.length, 2, "枚举含 remember 和指向它的 relate");
  assert.deepEqual(r.result.props, [gone]);
  const p = s.project();
  assert.equal(p.props.has(gone), false);
  assert.equal(p.props.get(keep)!.text, "别的会话写的，要留下");
  assert.equal(p.props.get(fix)!.state, "active");
  assert.equal(p.orphans, 0, "合法清除不算 unknown parent");
  assert.equal(p.purged, 2);
  assert.equal(s.search(MARK, { projects: [], includeGlobal: true }).length, 0);
  assert.equal(s.search("要留下", { projects: [], includeGlobal: true }).length, 1);
  for (const [table, col] of [["prop_usage", "prop_id"], ["inject_log", "prop_id"]]) {
    assert.equal((s.workDb.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${col}=?`).get(gone) as { n: number }).n, 0, `${table} 不留被清除记忆的行`);
  }
  assert.equal((s.workDb.prepare("SELECT count(*) AS n FROM prop_usage WHERE prop_id=?").get(keep) as { n: number }).n, 1);
  assert.throws(() => s.remember(null, "sess-P", false, { kind: "note", text: "迟到的写入", confirmed: true, source: src("sess-P") }), /已清除/);
  const face = (name: string) => r.faces.find((f) => f.name === name)!;
  for (const name of ["L1 正文", "统计表", "全文索引与向量", "store.db 空闲页", "index.db 空闲页", "看板 view.html"]) assert.equal(face(name).status, "成功", name);
  assert.equal(existsSync(join(dir, "view.html")), false);
  assert.equal(existsSync(join(dir, "debug", "claude-sess-P-abc.json")), false, "这个会话的调试文件被删");
  assert.equal(face("备份与库副本").status, "部分");
  assert.deepEqual(face("备份与库副本").paths, [copy]);
  assert.equal(face("报告与调试文件").status, "部分");
  assert.deepEqual(face("报告与调试文件").paths, [join(dir, "curate", "run-1.json")]);
  assert.equal(r.complete, false);

  // 重跑：不写第二条声明；--drop-backups 把含这个会话的备份删掉
  const again = purge(s, dir, "sess-P", { dropBackups: true });
  assert.equal(again.result.purge_event, null);
  assert.equal((s.workDb.prepare("SELECT count(*) AS n FROM events WHERE kind='purge'").get() as { n: number }).n, 1);
  assert.equal(existsSync(copy), false);
  assert.equal(again.faces.find((f) => f.name === "备份与库副本")!.status, "成功");
  s.close();
  for (const f of readdirSync(dir).filter((n) => /\.db(-wal|-shm)?$/.test(n))) assert.equal(occurrences(join(dir, f), MARK), 0, `${f} 里不能再有明文`);
});

test("ab purge：不是终端时只打印范围，不执行", () => {
  const dir = scratch();
  const s = open(dir);
  const id = s.remember(null, "sess-X", false, { kind: "note", text: "还在的内容", confirmed: true, source: src("sess-X") });
  s.close();
  const env = { ...process.env, AB_HOME: dir, AB_REGISTRY: join(dir, "repos"), HOME: dir };
  const r = spawnSync(process.execPath, [CLI, "purge", "--session", "claude:sess-X"], { env, encoding: "utf8", input: "sess-X\n" });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /将清除会话 sess-X/);
  assert.match(r.stdout, /事件 1 条/);
  assert.match(r.stdout, /没有执行：清除只能由人在终端里发起/);
  const t = open(dir);
  assert.equal(t.project().props.get(id)!.text, "还在的内容");
  assert.equal(t.sessionPurged("sess-X"), false);
  t.close();
});

// ---------- §12.6.4 备份与恢复 ----------

test("备份后恢复：事件数和投影回到备份时；恢复前的库另存；清除过的内容不跟着备份回来", () => {
  const dir = scratch();
  const s = open(dir);
  const a = s.remember(null, "sess-A", false, { kind: "rule", text: "备份时就有的规则", confirmed: true, source: src("sess-A") });
  const secret = s.remember(null, "sess-S", false, { kind: "note", text: "QWZ之后会被清除的内容", confirmed: true, source: src("sess-S") });
  s.lifecycle("archive", a, null);
  const snapshot = JSON.stringify([...s.project().props.values()].map((p) => [p.id, p.state, p.text, p.confirmed_by]));
  const b = backup(s, dir, new Date("2026-11-02T00:00:00Z"));
  assert.equal(b.events, 3);
  assert.equal(mode(b.path), 0o600);
  assert.equal(mode(join(dir, "backups")), 0o700);
  assert.deepEqual({ ok: inspectDb(b.path).ok, events: inspectDb(b.path).events, version: inspectDb(b.path).version }, { ok: true, events: 3, version: SCHEMA_VERSION });

  // 备份之后：恢复了那条规则、又写了一条。恢复后这两步都应该没发生过
  s.lifecycle("reactivate", a, null);
  const later = s.remember(null, "sess-B", false, { kind: "rule", text: "备份之后才写的", confirmed: true, source: src("sess-B") });
  const seqBefore = Number((s.workDb.prepare("SELECT max(seq) AS n FROM events").get() as { n: number }).n);
  const r = restore(s, dir, b.path, new Date("2026-11-03T00:00:00Z"));
  assert.equal(r.events, 3);
  assert.equal(JSON.stringify([...s.project().props.values()].map((p) => [p.id, p.state, p.text, p.confirmed_by])), snapshot, "投影与备份时逐条一致");
  assert.equal(s.project().props.has(later), false);
  assert.equal(s.search("备份之后才写的", { projects: [], includeGlobal: true }).length, 0, "索引跟着换");
  assert.equal(s.search("会被清除的内容", { projects: [], includeGlobal: true }).length, 1);
  assert.equal(inspectDb(r.saved).events, 5, "恢复前的库另存了一份，含备份之后的两条");
  const next = s.remember(null, null, false, { kind: "rule", text: "恢复后新写的", confirmed: true, source: src() });
  assert.ok(s.project().props.get(next)!.seq > seqBefore, "事件序号只进不退");

  // 清除在备份之后做：从那份备份恢复，被清除的内容不能回来
  purge(s, dir, "sess-S", { dropBackups: false });
  const r2 = restore(s, dir, b.path, new Date("2026-11-04T00:00:00Z"));
  assert.deepEqual(r2.repurged, ["sess-S"]);
  assert.equal(s.project().props.has(secret), false);
  assert.equal(s.search("会被清除的内容", { projects: [], includeGlobal: true }).length, 0);
  assert.equal(s.sessionPurged("sess-S"), true);
  s.close();
  assert.equal(occurrences(join(dir, "store.db"), "QWZ之后会被清除的内容"), 0);
  assert.equal(occurrences(join(dir, "index.db"), "QWZ之后会被清除的内容"), 0);
});

test("备份只留最近几份自己命名的，手工复制的文件不动；坏文件不能拿来恢复", () => {
  const dir = scratch();
  const s = open(dir);
  s.remember(null, null, false, { kind: "rule", text: "一条", confirmed: true, source: src() });
  mkdirSync(join(dir, "backups"));
  writeFileSync(join(dir, "backups", "store-manual-20261014.db"), "手工复制的，不归 ab 管");
  for (let i = 0; i < BACKUP_KEEP + 2; i++) backup(s, dir, new Date(Date.UTC(2026, 10, 1, 0, 0, i)));
  assert.equal(listBackups(dir).length, BACKUP_KEEP);
  assert.ok(listBackups(dir)[0].path.endsWith(`T0000${String(BACKUP_KEEP + 1).padStart(2, "0")}Z.db`), "留下的是最新的");
  assert.ok(existsSync(join(dir, "backups", "store-manual-20261014.db")));
  const before = s.eventCount();
  assert.throws(() => restore(s, dir, join(dir, "backups", "store-manual-20261014.db"), new Date()), /备份文件不能用/);
  assert.equal(s.eventCount(), before);
  s.close();
});

test("ab backup / ab restore：不加 --yes 只预览；加了才换库", () => {
  const dir = scratch();
  const env = { ...process.env, AB_HOME: join(dir, "store"), AB_REGISTRY: join(dir, "repos"), HOME: dir };
  const ab = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { env, encoding: "utf8", cwd: dir });
  assert.equal(ab("remember", "--global", "--confirmed", "--kind", "rule", "--text", "第一条", "--summary", "测试").status, 0);
  const b = ab("backup");
  assert.equal(b.status, 0, b.stderr);
  const file = /已备份 (\S+\.db)（1 条事件，已核对完整性）/.exec(b.stdout)?.[1];
  assert.ok(file, b.stdout);
  assert.equal(ab("remember", "--global", "--confirmed", "--kind", "rule", "--text", "第二条", "--summary", "测试").status, 0);
  const preview = ab("restore", file);
  assert.equal(preview.status, 1);
  assert.match(preview.stdout, /没有执行。恢复会把现库换成备份的内容，备份之后写入的 1 条事件会从现库消失/);
  assert.match(ab("search", "第二条").stdout, /第二条/);
  const done = ab("restore", file, "--yes");
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, /已恢复：现库 1 条事件。恢复前的库另存在 \S+pre-restore-\S+\.db/);
  assert.match(ab("search", "第二条").stdout, /没有匹配的记忆/);
  assert.match(ab("search", "第一条").stdout, /第一条/);
  assert.match(ab("backup", "--list").stdout, /ab-backup-/);
});

// ---------- §12.6.5 文件权限 ----------

test("数据目录 0700，库文件和日志 0600；原来放宽的会被收紧", () => {
  const dir = scratch();
  const home = join(dir, "store");
  const env = { ...process.env, AB_HOME: home, AB_REGISTRY: join(dir, "repos"), HOME: dir };
  execFileSync(process.execPath, [CLI, "remember", "--global", "--confirmed", "--kind", "rule", "--text", "一条", "--summary", "测试"], { env, cwd: dir });
  assert.equal(mode(home), 0o700);
  assert.equal(mode(join(home, "store.db")), 0o600);
  assert.equal(mode(join(home, "index.db")), 0o600);
  // 模拟这次改动之前建的库：目录 755，文件 644
  chmodSync(home, 0o755);
  for (const f of ["store.db", "index.db"]) chmodSync(join(home, f), 0o644);
  writeFileSync(join(home, "work.log"), "旧日志\n", { mode: 0o644 });
  chmodSync(join(home, "work.log"), 0o644);
  execFileSync(process.execPath, [CLI, "status", "--line"], { env, cwd: dir });
  assert.equal(mode(home), 0o700);
  for (const f of ["store.db", "index.db", "work.log"]) assert.equal(mode(join(home, f)), 0o600, f);
});
