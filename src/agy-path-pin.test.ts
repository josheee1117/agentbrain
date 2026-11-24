import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Store } from "./store.ts";
import * as intake from "./intake.ts";
import { agyLocate } from "./agy.ts";
import { logInjections, logQuery, logRecallRun, sessionsToScan } from "./telemetry.ts";
import { scan, type WorkDeps } from "./work.ts";

const now = new Date("2026-11-24T00:00:00Z");
const later = new Date("2026-11-24T01:00:00Z");

function fixture(t: TestContext) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "ab-agy-path-pin-")));
  const keys = ["HOME", "AB_HOME", "AGENTBRAIN_HOME", "AB_REGISTRY", "ANTIGRAVITY_APP_DATA_DIR", "GEMINI_HOME"];
  const old = keys.map((key) => process.env[key]);
  process.env.HOME = home;
  process.env.AB_HOME = process.env.AGENTBRAIN_HOME = join(home, "ab");
  process.env.AB_REGISTRY = join(home, "repos");
  delete process.env.ANTIGRAVITY_APP_DATA_DIR;
  delete process.env.GEMINI_HOME;
  const apps = [join(home, ".gemini/antigravity-cli"), join(home, ".gemini/antigravity")];
  const path = (root: number, id: string) => join(apps[root], "brain", id, ".system_generated/logs/transcript_full.jsonl");
  const log = (root: number, id: string, text = `根 ${root} 的原话`) => {
    const file = path(root, id);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ step_index: 0, type: "USER_INPUT", status: "DONE", content: `<USER_REQUEST>${text}</USER_REQUEST>` }) + "\n");
    return file;
  };
  mkdirSync(process.env.AB_HOME, { recursive: true });
  mkdirSync(process.env.AB_REGISTRY, { recursive: true });
  writeFileSync(join(process.env.AB_REGISTRY, "repo.md"), `- 路径：\`${home}\`\n`);
  const store = new Store(join(process.env.AB_HOME, "store.db"), join(process.env.AB_HOME, "index.db"));
  t.after(() => {
    store.close();
    keys.forEach((key, i) => { if (old[i] === undefined) delete process.env[key]; else process.env[key] = old[i]; });
    rmSync(home, { recursive: true, force: true });
  });
  const cliFile = join(import.meta.dirname, "cli.ts");
  const cli = (...args: string[]) => spawnSync(process.execPath, [cliFile, ...args], { cwd: home, env: process.env, encoding: "utf8" });
  const hook = (id: string, file: string | null, event: string) => spawnSync(process.execPath, [cliFile, "capture", "--hook", "--host", "agy"], {
    cwd: home, env: process.env, input: JSON.stringify({ session_id: id, ...(file ? { transcript_path: file } : {}), cwd: home, hook_event_name: event }), encoding: "utf8",
  });
  const registration = (id: string, transcript: string | null): intake.Registration => ({ host: "agy", session_id: id, transcript, cwd: home, ended: false, ephemeral: false, via: "manual" });
  const row = (id: string) => intake.sessions(store.workDb, { host: "agy", session_id: id })[0];
  return { home, apps, path, log, store, cli, hook, registration, row };
}

test("agy upsert：new、空路径首次补齐和同根 touch / Stop 保持原语义", (t) => {
  const f = fixture(t);
  const file = f.log(0, "same");
  assert.equal(intake.upsertSession(f.store.workDb, f.registration("same", null), () => "repo", now), "new");
  const short = join(dirname(file), "transcript.jsonl");
  assert.equal(intake.upsertSession(f.store.workDb, f.registration("same", short), () => { throw new Error("不应重算项目"); }, later), "touched");
  assert.equal(f.row("same").transcript, file);
  assert.equal(f.row("same").last_touch, later.toISOString());
  assert.equal(intake.upsertSession(f.store.workDb, { ...f.registration("same", file), ended: true, via: "hook" }, () => null, later), "touched");
  assert.equal(f.row("same").ended_at, later.toISOString());
  assert.equal(f.row("same").via, "hook");
});

test("agy upsert：异根未落盘坐标和无法确认本根的 touch / Stop 不改任何字段", (t) => {
  const f = fixture(t);
  const file = f.log(0, "pinned");
  intake.upsertSession(f.store.workDb, f.registration("pinned", file), () => "repo", now);
  f.store.workDb.prepare("UPDATE capture_sessions SET processed_anchor='635', error_code='no_config' WHERE session_id='pinned'").run();
  const before = f.row("pinned");
  for (const transcript of [f.path(1, "pinned"), null]) {
    for (const ended of [false, true]) {
      const result = intake.upsertSession(f.store.workDb, { ...f.registration("pinned", transcript), cwd: "/other", ended, ephemeral: true, via: "hook" }, () => { throw new Error("冲突不得解析项目"); }, later);
      assert.equal(result, "conflict");
      assert.deepEqual(f.row("pinned"), before);
      assert.equal(intake.meta(f.store.workDb, "first_hook_at"), null, "冲突不写首次 hook 元数据");
      assert.equal(f.store.workDb.isTransaction, false);
    }
  }
});

test("agy upsert：多根完整版连同根钩子也冲突，首次登记同样不选一根", (t) => {
  const f = fixture(t);
  const file = f.log(0, "shared");
  intake.upsertSession(f.store.workDb, f.registration("shared", file), () => "repo", now);
  const before = f.row("shared");
  f.log(1, "shared");
  for (const root of [0, 1]) {
    assert.equal(intake.upsertSession(f.store.workDb, { ...f.registration("shared", f.path(root, "shared")), ended: true }, () => null, later), "conflict");
    assert.deepEqual(f.row("shared"), before);
  }
  f.log(0, "new-shared");
  f.log(1, "new-shared");
  assert.equal(intake.upsertSession(f.store.workDb, f.registration("new-shared", f.path(0, "new-shared")), () => "repo", now), "conflict");
  assert.equal(f.row("new-shared"), undefined);
});

test("agy upsert：已登记路径失效不替换，写入失败回滚短事务", (t) => {
  const f = fixture(t);
  const file = f.log(0, "lost");
  intake.upsertSession(f.store.workDb, f.registration("lost", file), () => "repo", now);
  const before = f.row("lost");
  rmSync(file);
  symlinkSync(f.log(1, "lost"), file);
  assert.equal(intake.upsertSession(f.store.workDb, f.registration("lost", f.path(1, "lost")), () => null, later), "conflict");
  assert.deepEqual(f.row("lost"), before);
  assert.throws(() => intake.upsertSession(f.store.workDb, { ...f.registration("rollback", f.path(0, "rollback")), via: "hook" }, () => { throw new Error("项目失败"); }, now), /项目失败/);
  assert.equal(f.store.workDb.isTransaction, false);
  assert.equal(f.row("rollback"), undefined);
  assert.equal(intake.meta(f.store.workDb, "first_hook_at"), null);
});

test("agy 真实 hook：异根 touch / Stop、同根多根冲突不刷新，也不创建 work.log", (t) => {
  const f = fixture(t);
  const file = f.log(0, "hook");
  const captured = f.hook("hook", file, "UserPromptSubmit");
  assert.deepEqual([captured.status, captured.stdout, captured.stderr], [0, "", ""]);
  f.store.workDb.prepare("UPDATE capture_sessions SET last_touch=?, processed_anchor='635', via='scan', error_code='no_config' WHERE session_id='hook'").run(now.toISOString());
  const before = f.row("hook");
  // 第二根先只有合法坐标，随后写出完整日志，分别覆盖 pin 冲突和定位冲突。
  for (const materialized of [false, true]) {
    if (materialized) f.log(1, "hook");
    for (const root of materialized ? [0, 1] : [1]) {
      for (const event of ["UserPromptSubmit", "SessionEnd"]) {
        const result = f.hook("hook", f.path(root, "hook"), event);
        assert.deepEqual([result.status, result.stdout, result.stderr], [0, "", ""]);
        assert.deepEqual(f.row("hook"), before);
        assert.equal(existsSync(join(process.env.AB_HOME!, "work.log")), false, "spawnWork 会先创建 work.log");
      }
    }
  }
  console.log("hook 冲突后逐字段回读", JSON.stringify(f.row("hook")), "work.log 不存在");
});

test("agy 真实 capture：合法根提示指向未落盘另一根，hook 跳过、手动失败", (t) => {
  const f = fixture(t);
  const file = f.log(0, "hint");
  assert.equal(f.cli("capture", "agy:hint", "--transcript", file).status, 0);
  const before = f.row("hint");
  process.env.ANTIGRAVITY_APP_DATA_DIR = f.apps[1];
  assert.deepEqual(agyLocate("hint", { appDataDir: f.apps[1] }), { path: f.path(1, "hint"), conflict: [] });
  const hook = f.hook("hint", null, "SessionEnd");
  assert.deepEqual([hook.status, hook.stdout, hook.stderr], [0, "", ""]);
  assert.deepEqual(f.row("hint"), before);
  assert.equal(existsSync(join(process.env.AB_HOME!, "work.log")), false);
  for (const args of [[], ["--transcript", f.path(1, "hint")]]) {
    const manual = f.cli("capture", "agy:hint", ...args, "--end");
    assert.equal(manual.status, 1);
    assert.match(manual.stderr, /冲突.*已登记.*不.*替换/);
    assert.equal(manual.stdout, "");
    assert.deepEqual(f.row("hint"), before);
  }
});

test("agy sessionsToScan 和真实 get --expand 只用已登记根，不用其他表的 MAX 路径", (t) => {
  const f = fixture(t);
  const file = f.log(0, "citations", "登记根的原话");
  assert.equal(f.cli("capture", "agy:citations", "--transcript", file).status, 0);
  const remembered = f.cli("remember", "--global", "--kind", "note", "--text", "固定来源", "--summary", "路径", "--from-worker", "agy:citations");
  assert.equal(remembered.status, 0, remembered.stderr);
  const id = /已记住 \[([0-9a-f]+)\]/.exec(remembered.stdout)?.[1];
  assert.ok(id, remembered.stdout);
  const other = f.log(1, "citations", "另一根不可展开的原话");
  const ctx = { host: "agy", session_id: "citations", transcript: other, project_id: null } as const;
  logInjections(f.store.workDb, ctx, "brief", [id], now);
  logQuery(f.store.workDb, ctx, "get", now);
  logRecallRun(f.store.workDb, ctx, "hit", 1, 0, true, now);
  assert.deepEqual(sessionsToScan(f.store.workDb).map((s) => ({ ...s })), [{ host: "agy", session_id: "citations", transcript: file }]);
  process.env.ANTIGRAVITY_APP_DATA_DIR = f.apps[1];
  const expanded = f.cli("get", id, "--expand");
  assert.equal(expanded.status, 0, expanded.stderr);
  assert.match(expanded.stdout, /登记根的原话/);
  assert.doesNotMatch(expanded.stdout, /另一根不可展开的原话/);
  console.log("get --expand", expanded.stdout);
  rmSync(file);
  symlinkSync(other, file);
  const view = f.cli("view", "--no-open", "--out", join(f.home, "view.html"));
  assert.equal(view.status, 0, view.stderr);
  assert.match(view.stdout, /引用扫描：0 个会话.*会话读不到对话/);
  assert.equal(f.store.workDb.prepare("SELECT COUNT(*) AS n FROM cite_scan WHERE host='agy' AND session_id='citations'").get()?.n, 0);
  assert.equal(f.row("citations").transcript, file, "失效来源不换到另一根");
  console.log("失效登记路径的真实引用扫描", view.stdout);
});

test("agy sessionsToScan：无基线只补找唯一合法来源，冲突跳过；非 agy 保持 MAX 规则", (t) => {
  const f = fixture(t);
  const unique = f.log(1, "unique");
  const add = (host: "agy" | "codex", session_id: string, transcript: string | null) => logQuery(f.store.workDb, { host, session_id, transcript, project_id: null }, "get", now);
  add("agy", "unique", f.path(0, "unique"));
  add("agy", "absent", "/outside/transcript_full.jsonl");
  f.log(0, "conflict");
  f.log(1, "conflict");
  add("agy", "conflict", f.path(0, "conflict"));
  add("codex", "unchanged", "/a.jsonl");
  add("codex", "unchanged", "/z.jsonl");
  assert.deepEqual(sessionsToScan(f.store.workDb).map((s) => ({ ...s })), [
    { host: "agy", session_id: "unique", transcript: unique },
    { host: "codex", session_id: "unchanged", transcript: "/z.jsonl" },
  ]);
});

test("agy scan：发现后被另一 hook 登记的冲突不计数、不替换", (t) => {
  const f = fixture(t);
  const file = f.log(1, "scan-race");
  const summaries = new DatabaseSync(join(f.apps[1], "conversation_summaries.db"));
  summaries.exec("CREATE TABLE conversation_summaries(conversation_id TEXT, workspace_uris TEXT, parent_conversation_id TEXT, last_modified_time TEXT)");
  summaries.prepare("INSERT INTO conversation_summaries VALUES(?,?,?,?)").run("scan-race", JSON.stringify([`file://${f.home}`]), "", now.toISOString());
  summaries.close();
  const deps: WorkDeps = {
    store: f.store, now: () => now, chat: { error: "no_config", message: "test" }, embedder: null,
    registry: [{ name: "repo", path: f.home }], registryDir: process.env.AB_REGISTRY!, projectId: (name) => f.store.ensureProject(name),
    resolveProject: () => {
      intake.upsertSession(f.store.workDb, f.registration("scan-race", f.path(0, "scan-race")), () => "repo", now);
      return { name: "repo", path: f.home };
    },
  };
  assert.equal(scan(deps), 0);
  assert.equal(f.row("scan-race").transcript, f.path(0, "scan-race"));
  assert.notEqual(f.row("scan-race").transcript, file);
});

test("agy 并发首次登记：短事务只允许一个 new，另一根返回 conflict", async (t) => {
  const f = fixture(t);
  const script = `import { Store } from ${JSON.stringify(join(import.meta.dirname, "store.ts"))};
import { upsertSession } from ${JSON.stringify(join(import.meta.dirname, "intake.ts"))};
const store = new Store(process.env.AB_HOME + '/store.db', process.env.AB_HOME + '/index.db');
try { console.log(upsertSession(store.workDb, { host: 'agy', session_id: 'concurrent', transcript: process.argv[1], cwd: process.env.HOME, ended: false, ephemeral: false, via: 'hook' }, () => 'repo', new Date())); } finally { store.close(); }`;
  const run = (file: string) => new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, file], { env: process.env });
    let stdout = "", stderr = "";
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    child.on("error", reject);
    child.on("close", (code) => { if (code !== 0) reject(new Error(stderr)); else resolve(stdout.trim()); });
  });
  assert.deepEqual((await Promise.all([run(f.path(0, "concurrent")), run(f.path(1, "concurrent"))])).sort(), ["conflict", "new"]);
  assert.ok([f.path(0, "concurrent"), f.path(1, "concurrent")].includes(f.row("concurrent").transcript!));
});
