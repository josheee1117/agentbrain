import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scan, runWork, type WorkDeps } from "./work.ts";
import { agyDiscover, agyRoots } from "./agy.ts";
import { allowedTranscript } from "./transcript-file.ts";
import { Store } from "./store.ts";
import * as intake from "./intake.ts";

function fixture(t: TestContext) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "ab-agy-roots-")));
  const keys = ["HOME", "AB_HOME", "AGENTBRAIN_HOME", "AB_REGISTRY"];
  const old = keys.map((key) => process.env[key]);
  process.env.HOME = home;
  process.env.AB_HOME = process.env.AGENTBRAIN_HOME = join(home, "ab");
  process.env.AB_REGISTRY = join(home, "repos");
  t.after(() => {
    store.close();
    keys.forEach((key, i) => { if (old[i] === undefined) delete process.env[key]; else process.env[key] = old[i]; });
    rmSync(home, { recursive: true, force: true });
  });
  const repo = join(home, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  const apps = [join(home, ".gemini/antigravity-cli"), join(home, ".gemini/antigravity"), join(home, ".t3/userdata/providers/antigravity/new-instance/antigravity-acp")];
  const now = new Date();
  const log = (app: string, id: string, modifiedAt = now.getTime() - 3_600_000) => {
    const path = join(app, "brain", id, ".system_generated/logs/transcript_full.jsonl");
    mkdirSync(join(app, "brain", id, ".system_generated/logs"), { recursive: true });
    writeFileSync(path, [
      { step_index: 0, type: "USER_INPUT", status: "DONE", created_at: new Date(modifiedAt).toISOString(), content: "<USER_REQUEST>以后修改接线先跑隔离验收，因为正式目录里试错会污染记忆。</USER_REQUEST>" },
      { step_index: 1, type: "PLANNER_RESPONSE", status: "DONE", created_at: new Date(modifiedAt).toISOString(), content: "会先隔离验证。" },
    ].map((row) => JSON.stringify(row)).join("\n") + "\n");
    utimesSync(path, new Date(modifiedAt), new Date(modifiedAt));
    return path;
  };
  const summaries = (app: string, rows: { id: string; parent?: string; modifiedAt?: string; workspace?: string }[]) => {
    mkdirSync(app, { recursive: true });
    const db = new DatabaseSync(join(app, "conversation_summaries.db"));
    db.exec("CREATE TABLE conversation_summaries(conversation_id TEXT PRIMARY KEY, workspace_uris TEXT, parent_conversation_id TEXT, last_modified_time TEXT, raw_summary BLOB)");
    for (const row of rows) db.prepare("INSERT INTO conversation_summaries VALUES(?,?,?,?,?)").run(row.id, row.workspace ?? JSON.stringify([`file://${repo}`]), row.parent ?? "", row.modifiedAt ?? now.toISOString(), Buffer.from([0xff]));
    db.close();
  };
  const store = new Store(join(home, "scan-store.db"), join(home, "scan-index.db"));
  const deps: WorkDeps = { store, now: () => now, chat: { error: "no_config", message: "隔离验收无模型" }, embedder: null, registry: [{ name: "repo", path: repo }], registryDir: home, resolveProject: (cwd) => cwd === repo ? { name: "repo", path: repo } : null, projectId: (name) => store.ensureProject(name) };
  return { home, apps, repo, now, log, summaries, store, deps };
}

test("agy sweep 按实际完整日志补登记 CLI、IDE、新 T3 实例，不把同步摘要当对话", (t) => {
  const f = fixture(t);
  const expected = f.apps.map((app, i) => {
    const id = `root-${i}`;
    const transcript = f.log(app, id);
    f.summaries(app, [{ id }, { id: "synced-only" }]);
    return [id, transcript, f.repo];
  });
  assert.equal(scan(f.deps), 3);
  assert.deepEqual(intake.sessions(f.store.workDb).map((s) => [s.session_id, s.transcript, s.cwd]).sort(), expected.sort());
  assert.equal(scan(f.deps), 0);
  for (const [id, transcript] of expected) assert.equal(allowedTranscript("agy", transcript, id), transcript);
});

test("agy 根枚举动态新增实例，只取实例直接一层", (t) => {
  const f = fixture(t);
  mkdirSync(f.apps[2], { recursive: true });
  assert.deepEqual(agyRoots().map((r) => r.kind), ["cli", "ide", "t3"]);
  const another = join(f.home, ".t3/userdata/providers/antigravity/second-instance");
  mkdirSync(join(another, "nested/antigravity-acp"), { recursive: true });
  const roots = agyRoots();
  assert.deepEqual(roots.filter((r) => r.kind === "t3").map((r) => r.instance).sort(), ["new-instance", "second-instance"]);
  assert.equal(roots.find((r) => r.instance === "second-instance")?.appData, join(another, "antigravity-acp"));
});

test("agy 空实例和缺元数据分别报告，缺元数据保留日志但不猜 cwd", (t) => {
  const f = fixture(t);
  mkdirSync(f.apps[2], { recursive: true });
  let result = agyDiscover(agyRoots(), f.now, () => false);
  assert.deepEqual(result.conversations, []);
  assert.deepEqual(result.problems, [{ root: join(f.apps[2], ".."), kind: "no_summaries", count: 0 }]);
  const transcript = f.log(f.apps[1], "missing-db");
  result = agyDiscover(agyRoots(), f.now, () => false);
  assert.deepEqual(result.conversations.map((c) => [c.id, c.cwd, c.transcript]), [["missing-db", null, transcript]]);
  assert.ok(result.problems.some((p) => p.root === f.apps[1] && p.kind === "missing_meta" && p.count === 1));
  f.summaries(f.apps[1], [{ id: "synced" }]);
  result = agyDiscover(agyRoots(), f.now, () => false);
  assert.equal(result.conversations[0].cwd, null);
  assert.ok(result.problems.some((p) => p.kind === "missing_meta" && p.count === 1));
  assert.equal(scan(f.deps), 0);
  assert.deepEqual(intake.sessions(f.store.workDb), []);
});

test("agy 坏库、无权限报告无法读取，不影响其他根且不丢日志计数", (t) => {
  const f = fixture(t);
  f.log(f.apps[0], "healthy");
  f.summaries(f.apps[0], [{ id: "healthy" }]);
  f.log(f.apps[1], "bad-db");
  writeFileSync(join(f.apps[1], "conversation_summaries.db"), "broken database");
  f.log(f.apps[2], "denied-db");
  f.summaries(f.apps[2], [{ id: "denied-db" }]);
  chmodSync(join(f.apps[2], "conversation_summaries.db"), 0);
  const result = agyDiscover(agyRoots(), f.now, () => false);
  assert.deepEqual(result.problems.map((p) => [p.root, p.kind]), [[f.apps[1], "unreadable"], [join(f.apps[2], ".."), "unreadable"]]);
  assert.equal(result.conversations.length, 3, "坏库不是 0 日志");
  assert.equal(result.conversations.find((c) => c.id === "bad-db")?.cwd, null);
  assert.equal(scan(f.deps), 1);
});

for (const suffix of ["", "-wal", "-shm"]) test(`agy 摘要${suffix || "库"}逃逸软链在复制前拒绝，原文件保持不变`, (t) => {
  const f = fixture(t);
  f.log(f.apps[1], "escaped-db");
  f.summaries(f.apps[1], [{ id: "escaped-db" }]);
  const dbPath = join(f.apps[1], "conversation_summaries.db");
  const outsideDb = join(f.home, "outside.db");
  writeFileSync(outsideDb, readFileSync(dbPath));
  const live = suffix ? new DatabaseSync(outsideDb) : null;
  try {
    live?.exec("PRAGMA journal_mode=WAL; UPDATE conversation_summaries SET raw_summary=NULL");
    const outside = outsideDb + suffix;
    const path = dbPath + suffix;
    const before = readFileSync(outside);
    if (!suffix) rmSync(path);
    symlinkSync(outside, path);
    const result = agyDiscover(agyRoots(), f.now, () => false);
    assert.deepEqual(result.problems, [{ root: f.apps[1], kind: "unreadable", summariesUnreadable: true }]);
    assert.equal(result.conversations[0].cwd, null);
    assert.deepEqual(readFileSync(outside), before);
  } finally { live?.close(); }
});

test("agy 活库 WAL 中的摘要能从只读副本读取，源库及边车不变", (t) => {
  const f = fixture(t);
  f.log(f.apps[0], "wal-row");
  f.summaries(f.apps[0], []);
  const path = join(f.apps[0], "conversation_summaries.db");
  const live = new DatabaseSync(path);
  try {
    live.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
    live.prepare("INSERT INTO conversation_summaries VALUES(?,?,?,?,?)").run("wal-row", JSON.stringify([`file://${f.repo}`]), "", f.now.toISOString(), null);
    const paths = [path, path + "-wal", path + "-shm"];
    assert.ok(paths.every(existsSync));
    const before = paths.map((p) => readFileSync(p));
    const result = agyDiscover(agyRoots(), f.now, () => false);
    assert.deepEqual(result.problems, []);
    assert.equal(result.conversations[0].cwd, f.repo);
    assert.deepEqual(paths.map((p) => readFileSync(p)), before);
  } finally { live.close(); }
});

test("agy 应用根和日志逃逸软链均拒绝，chunks、scratch 不计", (t) => {
  const f = fixture(t);
  const outside = join(f.home, "outside");
  const transcript = f.log(outside, "escaped");
  const missing = join(f.apps[0], "brain/escaped/.system_generated/logs");
  mkdirSync(missing, { recursive: true });
  symlinkSync(transcript, join(missing, "transcript_full.jsonl"));
  const chunks = join(f.apps[0], "brain/chunks-only/.system_generated/logs/chunks/transcript_full");
  mkdirSync(chunks, { recursive: true });
  writeFileSync(join(chunks, "00000000.jsonl"), "{}\n");
  mkdirSync(join(f.apps[0], "brain/scratch-only/scratch"), { recursive: true });
  writeFileSync(join(f.apps[0], "brain/scratch-only/scratch/notes.jsonl"), "{}\n");
  mkdirSync(join(f.home, ".gemini"), { recursive: true });
  symlinkSync(outside, f.apps[1]);
  mkdirSync(join(f.apps[2], ".."), { recursive: true });
  symlinkSync(outside, f.apps[2]);
  const result = agyDiscover(agyRoots(), f.now, () => false);
  assert.deepEqual(result.conversations, []);
  assert.ok(result.problems.filter((p) => p.kind === "unreadable").length >= 3);
  assert.ok(!result.problems.some((p) => p.kind === "no_summaries"), "有不可读日志时不能报 0 对话");
  assert.equal(allowedTranscript("agy", join(missing, "transcript_full.jsonl"), "escaped"), null);
  assert.equal(allowedTranscript("agy", join(f.apps[1], "brain/escaped/.system_generated/logs/transcript_full.jsonl"), "escaped"), null);
  assert.equal(allowedTranscript("agy", join(f.apps[2], "brain/escaped/.system_generated/logs/transcript_full.jsonl"), "escaped"), null);
  // 未落盘文件不能通过已经逃逸的父目录。
  const late = join(f.apps[0], "brain/late");
  symlinkSync(outside, late);
  assert.equal(allowedTranscript("agy", join(late, ".system_generated/logs/transcript.jsonl"), "late"), null);
});

test("agy 无权限日志且无摘要库只报告无法读取，不报 0 对话", async (t) => {
  const f = fixture(t);
  const transcript = f.log(f.apps[0], "denied-log");
  chmodSync(transcript, 0);
  const result = agyDiscover(agyRoots(), f.now, () => false);
  assert.equal(result.problems.filter((p) => p.root === f.apps[0]).length, 1);
  assert.deepEqual(result.problems[0], { root: f.apps[0], kind: "unreadable", count: 1 });
  const report = await runWork(f.deps, { sweep: false, dryRun: true });
  assert.equal(report.problems.length, 1);
  assert.match(report.problems[0], /无法读取.*1 份完整日志/);
  assert.doesNotMatch(report.problems[0], /0 对话/);
});

test("agy 日志和摘要库同时不可读合并一行，保留日志数量和摘要库原因", async (t) => {
  const f = fixture(t);
  const transcript = f.log(f.apps[0], "denied-log");
  chmodSync(transcript, 0);
  writeFileSync(join(f.apps[0], "conversation_summaries.db"), "broken database");
  const result = agyDiscover(agyRoots(), f.now, () => false);
  assert.equal(result.problems.filter((p) => p.root === f.apps[0] && p.kind === "unreadable").length, 1);
  assert.equal(result.problems[0].count, 1);
  assert.equal(result.problems[0].summariesUnreadable, true);
  const report = await runWork(f.deps, { sweep: false, dryRun: true });
  assert.equal(report.problems.length, 1);
  assert.match(report.problems[0], /无法读取.*1 份完整日志.*摘要库/);
  assert.doesNotMatch(report.problems[0], /0 对话/);
  const cli = spawnSync(process.execPath, [join(import.meta.dirname, "cli.ts"), "work", "--sweep"], { cwd: f.repo, env: { ...process.env }, encoding: "utf8", timeout: 30_000 });
  assert.equal(cli.status, 0, cli.stdout + cli.stderr);
  const lines = cli.stdout.split("\n").filter((line) => line.includes(f.apps[0]));
  assert.equal(lines.length, 1, cli.stdout);
  assert.match(lines[0], /无法读取.*1 份完整日志.*摘要库/);
  assert.doesNotMatch(cli.stdout, /0 对话/);
  console.log(JSON.stringify({ command: "node src/cli.ts work --sweep", unreadable: lines }));
});

test("agy 实例目录无权限不阻断 CLI，实例目录和 brain 软链逃逸报告无法读取", (t) => {
  const f = fixture(t);
  f.log(f.apps[0], "healthy");
  f.summaries(f.apps[0], [{ id: "healthy" }]);
  mkdirSync(f.apps[2], { recursive: true });
  const providers = join(f.home, ".t3/userdata/providers/antigravity");
  chmodSync(providers, 0);
  try {
    const result = agyDiscover(agyRoots(), f.now, () => false);
    assert.ok(result.problems.some((p) => p.root === providers && p.kind === "unreadable"));
    assert.equal(scan(f.deps), 1);
  } finally { chmodSync(providers, 0o700); }
  const instance = join(providers, "new-instance");
  rmSync(instance, { recursive: true });
  const outside = join(f.home, "outside-instance");
  mkdirSync(outside);
  symlinkSync(outside, instance);
  mkdirSync(f.apps[1], { recursive: true });
  symlinkSync(outside, join(f.apps[1], "brain"));
  const result = agyDiscover(agyRoots(), f.now, () => false);
  assert.ok(result.problems.some((p) => p.root === instance && p.kind === "unreadable"));
  assert.ok(result.problems.some((p) => p.root === f.apps[1] && p.kind === "unreadable"));
});

test("agy 七天只按摘要时间过滤，坏时间回退 mtime，已登记不受限，子会话不补登记", (t) => {
  const f = fixture(t);
  const old = f.now.getTime() - 9 * 86_400_000;
  for (const id of ["recent-summary", "old", "bad-time-old", "bad-time-new", "child"]) f.log(f.apps[0], id, id === "bad-time-new" || id === "child" ? undefined : old);
  f.summaries(f.apps[0], [{ id: "recent-summary" }, { id: "old", modifiedAt: new Date(old).toISOString() }, { id: "bad-time-old", modifiedAt: "bad" }, { id: "bad-time-new", modifiedAt: "bad" }, { id: "child", parent: "parent" }]);
  const result = agyDiscover(agyRoots(), f.now, (id) => id === "old");
  assert.deepEqual(result.conversations.map((c) => c.id).sort(), ["recent-summary", "old", "bad-time-new", "child"].sort());
  assert.equal(result.conversations.find((c) => c.id === "old")?.modifiedAt, old);
  assert.equal(scan(f.deps), 2, "近期摘要不再受旧文件 mtime 二次过滤，子会话不登记");
  assert.deepEqual(intake.sessions(f.store.workDb).map((s) => s.session_id).sort(), ["recent-summary", "bad-time-new"].sort());
});

test("agy 同 id 多根完整日志冲突先于七天过滤，已登记也跳过抽取且原坐标不变", async (t) => {
  const f = fixture(t);
  const transcript = f.log(f.apps[0], "duplicate");
  f.log(f.apps[1], "duplicate", f.now.getTime() - 9 * 86_400_000);
  f.summaries(f.apps[0], [{ id: "duplicate" }]);
  f.summaries(f.apps[1], [{ id: "duplicate", modifiedAt: new Date(f.now.getTime() - 9 * 86_400_000).toISOString() }]);
  const result = agyDiscover(agyRoots(), f.now, () => false);
  assert.deepEqual(result.conflicts, [{ id: "duplicate", roots: f.apps.slice(0, 2) }]);
  assert.deepEqual(result.conversations, []);
  assert.equal(scan(f.deps), 0);
  intake.upsertSession(f.store.workDb, { host: "agy", session_id: "duplicate", transcript, cwd: f.repo, ended: false, ephemeral: false, via: "hook" }, () => "repo", f.now);
  const before = f.store.workDb.prepare("SELECT * FROM capture_sessions").all();
  const report = await runWork(f.deps, { sweep: false, dryRun: true });
  assert.deepEqual(report.dry, []);
  assert.ok(report.problems.some((p) => p.includes("duplicate") && p.includes("多处有完整日志")));
  assert.deepEqual(f.store.workDb.prepare("SELECT * FROM capture_sessions").all(), before);
});

test("agy 冲突加 redo 不重置既有处理进度和窗口", async (t) => {
  const f = fixture(t);
  const id = "redo-conflict";
  const transcript = f.log(f.apps[0], id);
  f.log(f.apps[1], id);
  f.apps.slice(0, 2).forEach((app) => f.summaries(app, [{ id }]));
  intake.upsertSession(f.store.workDb, { host: "agy", session_id: id, transcript, cwd: f.repo, ended: false, ephemeral: false, via: "hook" }, () => "repo", f.now);
  const session = intake.sessions(f.store.workDb)[0];
  intake.finishWindow(f.store.workDb, session, { id: "completed-window", from: null, to: "8" }, "done", null, null, f.now);
  const beforeSessions = f.store.workDb.prepare("SELECT * FROM capture_sessions").all();
  const beforeWindows = f.store.workDb.prepare("SELECT * FROM capture_windows").all();
  const report = await runWork(f.deps, { session: { host: "agy", session_id: id }, sweep: false, dryRun: false, redo: true });
  assert.ok(report.problems.some((p) => p.includes(id) && p.includes("多处有完整日志")));
  assert.deepEqual(f.store.workDb.prepare("SELECT * FROM capture_sessions").all(), beforeSessions, "冲突会话的处理进度和坐标不变");
  assert.deepEqual(f.store.workDb.prepare("SELECT * FROM capture_windows").all(), beforeWindows, "冲突会话的已完成窗口不变");
});

test("真实 CLI work --sweep 登记三处会话，dry-run 回读待处理窗口", (t) => {
  const f = fixture(t);
  f.apps.forEach((app, i) => { f.log(app, `cli-smoke-${i}`); f.summaries(app, [{ id: `cli-smoke-${i}` }]); });
  mkdirSync(process.env.AB_REGISTRY!, { recursive: true });
  writeFileSync(join(process.env.AB_REGISTRY!, "repo.md"), `- 路径：\`${f.repo}\`\n`);
  const cli = join(import.meta.dirname, "cli.ts");
  const run = (args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd: f.repo, env: { ...process.env }, encoding: "utf8", timeout:30_000 });
  const sweep = run(["work", "--sweep"]);
  assert.equal(sweep.status, 0, sweep.stdout + sweep.stderr);
  const db = new DatabaseSync(join(process.env.AB_HOME!, "store.db"), { readOnly: true });
  let rows;
  try { rows = db.prepare("SELECT session_id, transcript, cwd, project FROM capture_sessions WHERE host='agy' ORDER BY session_id").all(); } finally { db.close(); }
  assert.deepEqual(rows.map((row, i) => [row.session_id, row.transcript, row.cwd, row.project]), f.apps.map((app, i) => [`cli-smoke-${i}`, join(app, `brain/cli-smoke-${i}/.system_generated/logs/transcript_full.jsonl`), f.repo, "repo"]));
  const dry = run(["work", "--dry-run"]);
  assert.equal(dry.status, 0, dry.stdout + dry.stderr);
  for (let i = 0; i < 3; i++) assert.match(dry.stdout, new RegExp(`agy:cli-smoke-${i}.*待处理窗口 1`));
  console.log(JSON.stringify({ command: "node src/cli.ts work --sweep; node src/cli.ts work --dry-run", sweep: sweep.stdout, rows, dry: dry.stdout }));
});
