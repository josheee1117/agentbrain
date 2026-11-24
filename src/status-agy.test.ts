import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.ts";
import { statusReport, type StatusContext } from "./status.ts";
import { resolveProject } from "./registry.ts";
import * as intake from "./intake.ts";

function fixture(t: TestContext) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "ab-agy-status-")));
  const registry = join(home, "repos");
  const repo = join(home, "repo");
  mkdirSync(registry);
  mkdirSync(repo);
  writeFileSync(join(registry, "repo.md"), `- 路径：\`${repo}\`\n`);
  const keys = ["HOME", "AB_HOME", "AGENTBRAIN_HOME", "AB_REGISTRY"];
  const old = keys.map((key) => process.env[key]);
  process.env.HOME = home;
  process.env.AB_HOME = process.env.AGENTBRAIN_HOME = join(home, "ab");
  process.env.AB_REGISTRY = registry;
  const store = new Store(join(home, "ab/store.db"), join(home, "ab/index.db"));
  t.after(() => {
    store.close();
    keys.forEach((key, i) => { if (old[i] === undefined) delete process.env[key]; else process.env[key] = old[i]; });
    rmSync(home, { recursive: true, force: true });
  });
  const apps = [join(home, ".gemini/antigravity-cli"), join(home, ".gemini/antigravity"),
    ...["60c7502f-first", "ac0a3dfd-second"].map((id) => join(home, ".t3/userdata/providers/antigravity", id, "antigravity-acp"))];
  for (const app of apps) mkdirSync(app, { recursive: true });
  const log = (app: string, id: string) => {
    const logs = join(app, "brain", id, ".system_generated/logs");
    mkdirSync(logs, { recursive: true });
    const path = join(logs, "transcript_full.jsonl");
    writeFileSync(path, JSON.stringify({ step_index: 0, type: "USER_INPUT", status: "DONE", content: "以后先跑隔离验证。" }) + "\n");
    return path;
  };
  const summaries = (app: string, rows: { id: string; cwd?: string; parent?: string; old?: boolean }[]) => {
    const db = new DatabaseSync(join(app, "conversation_summaries.db"));
    db.exec("CREATE TABLE conversation_summaries(conversation_id TEXT PRIMARY KEY, workspace_uris TEXT, parent_conversation_id TEXT, last_modified_time TEXT)");
    for (const row of rows) db.prepare("INSERT INTO conversation_summaries VALUES(?,?,?,?)").run(row.id, JSON.stringify([pathToFileURL(row.cwd ?? repo).href]), row.parent ?? "", new Date(Date.now() - (row.old ? 9 : 0) * 86_400_000).toISOString());
    db.close();
  };
  const context: StatusContext = { cwd: repo, userHome: home, storeHome: join(home, "ab"), host: { ok: true, detection: null },
    embedder: null, embedReason: "隔离验收", chatConfig: { error: "没有 extract.json" }, now: new Date() };
  const register = (id: string, transcript: string) => intake.upsertSession(store.workDb,
    { host: "agy", session_id: id, transcript, cwd: repo, ended: false, ephemeral: false, via: "hook" }, () => "repo", new Date());
  return { home, repo, apps, store, log, summaries, context, register };
}

const rootLines = (out: string) => out.split("\n").filter((line) => line.startsWith("agy "));
const todo = (out: string) => out.slice(0, out.indexOf("\n目录:"));

test("agy status 四根各一行：重新发现旧日志，按登记路径计数，0 登记进要处理", (t) => {
  const f = fixture(t);
  f.apps.forEach((app, i) => {
    const id = `root-${i}`;
    const path = f.log(app, id);
    f.summaries(app, [{ id, old: true }, ...(i === 0 ? [{ id: "child", parent: id }] : [])]);
    if (i === 0) { f.log(app, "child"); f.register(id, path); }
  });
  const plugin = join(f.home, ".gemini/config/plugins/agentbrain");
  mkdirSync(plugin, { recursive: true });
  writeFileSync(join(plugin, "hooks.json"), "{}");
  const out = statusReport(f.store, f.context);
  assert.deepEqual(rootLines(out), [
    "agy CLI: 日志 2（可抽 1），已登记 1，插件在位",
    "agy IDE: 日志 1（可抽 1），已登记 0，插件在位",
    "agy T3 60c7502f: 日志 1（可抽 1），已登记 0，只靠 sweep",
    "agy T3 ac0a3dfd: 日志 1（可抽 1），已登记 0，只靠 sweep",
  ]);
  for (const label of ["IDE", "T3 60c7502f", "T3 ac0a3dfd"]) assert.match(todo(out), new RegExp(`agy ${label}.*可抽取主会话 1.*已登记 0`));
  assert.doesNotMatch(todo(out), /agy CLI/);
});

test("agy status 空实例、缺元数据、坏库和权限拒绝分别注明，不把无法读取报成 0", (t) => {
  const f = fixture(t);
  assert.deepEqual(rootLines(statusReport(f.store, f.context)).filter((line) => line.startsWith("agy T3")), [
    "agy T3 60c7502f: 日志 0（可抽 0），已登记 0，只靠 sweep，尚无对话",
    "agy T3 ac0a3dfd: 日志 0（可抽 0），已登记 0，只靠 sweep，尚无对话",
  ]);
  f.log(f.apps[1], "missing-meta");
  f.log(f.apps[2], "bad-db");
  writeFileSync(join(f.apps[2], "conversation_summaries.db"), "broken database");
  const denied = f.log(f.apps[3], "denied-log");
  chmodSync(denied, 0);
  const out = statusReport(f.store, f.context);
  assert.match(out, /^agy CLI: 日志 0（可抽 0），已登记 0，只靠 sweep，尚无对话$/m);
  assert.match(out, /^agy IDE: 日志 1（可抽 0），已登记 0，只靠 sweep，缺元数据$/m);
  assert.match(out, /^agy T3 60c7502f: 日志 1（可抽 0），已登记 0，只靠 sweep，无法读取$/m);
  assert.match(out, /^agy T3 ac0a3dfd: 日志 无法读取（可抽 0），已登记 0，只靠 sweep，无法读取$/m);
  assert.match(todo(out), /agy IDE.*缺元数据/);
  assert.match(todo(out), /agy T3 60c7502f.*摘要库无法读取/);
  assert.match(todo(out), /agy T3 ac0a3dfd.*1 份完整日志无法读取/);
});

test("agy status 已删 cwd 不崩且排除可抽数，未登记目录另计", (t) => {
  const f = fixture(t);
  const deleted = join(f.home, "deleted");
  const unregistered = join(f.home, "unregistered");
  mkdirSync(unregistered);
  for (const id of ["deleted", "unregistered", "registered"]) f.log(f.apps[1], id);
  f.summaries(f.apps[1], [{ id: "deleted", cwd: deleted }, { id: "unregistered", cwd: unregistered }, { id: "registered" }]);
  assert.equal(resolveProject(deleted), null);
  const out = statusReport(f.store, f.context);
  assert.match(out, /^agy IDE: 日志 3（可抽 1），已登记 0，只靠 sweep$/m);
  assert.match(todo(out), /agy IDE.*目录已删 1/);
  assert.match(todo(out), /agy IDE.*未登记项目 1/);
  assert.match(statusReport(f.store, { ...f.context, cwd: deleted }), /^目录: 未登记目录$/m);
});

test("agy status 同 id 跨根冲突单列，日志与登记均不重复计数", (t) => {
  const f = fixture(t);
  f.register("conflicting", f.log(f.apps[0], "conflicting"));
  f.summaries(f.apps[0], [{ id: "conflicting" }]);
  f.log(f.apps[1], "conflicting");
  f.summaries(f.apps[1], [{ id: "conflicting" }]);
  const out = statusReport(f.store, f.context);
  for (const label of ["CLI", "IDE"]) assert.match(out, new RegExp(`^agy ${label}: 日志 0（可抽 0），已登记 0，只靠 sweep，冲突$`, "m"));
  assert.equal(out.split("\n").filter((line) => /会话 conflicting 在多处/.test(line)).length, 1);
  assert.match(out, /会话 conflicting 在多处有完整日志.*已跳过/);
  assert.equal(intake.sessions(f.store.workDb).length, 1);
});

test("agy status/doctor 真实 CLI 四根输出相同，实例插件只影响本根，诊断不登记且 --line 字段不变", (t) => {
  const f = fixture(t);
  f.apps.forEach((app, i) => { f.log(app, `cli-${i}`); f.summaries(app, [{ id: `cli-${i}` }]); });
  const plugin = join(f.apps[2], "../config/plugins/agentbrain");
  mkdirSync(plugin, { recursive: true });
  writeFileSync(join(plugin, "hooks.json"), "{}");
  const paths = f.apps.flatMap((app, i) => [join(app, "conversation_summaries.db"), join(app, "brain", `cli-${i}`, ".system_generated/logs/transcript_full.jsonl")]);
  const before = paths.map((path) => readFileSync(path));
  const cli = (command: string, ...args: string[]) => {
    const result = spawnSync(process.execPath, [join(import.meta.dirname, "cli.ts"), command, ...args], { cwd: f.repo, env: process.env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const status = cli("status");
  assert.deepEqual(rootLines(status), rootLines(cli("doctor")));
  assert.equal(rootLines(status).length, 4);
  assert.match(status, /^agy T3 60c7502f: 日志 1（可抽 1），已登记 0，插件在位$/m);
  assert.match(status, /^agy CLI: 日志 1（可抽 1），已登记 0，只靠 sweep$/m);
  assert.match(status, /^agy T3 ac0a3dfd: 日志 1（可抽 1），已登记 0，只靠 sweep$/m);
  assert.deepEqual(JSON.parse(cli("status", "--line")), { review: 0, work_failed: 0 });
  assert.deepEqual(intake.sessions(f.store.workDb), []);
  assert.equal(f.store.eventCount(), 0);
  assert.equal(f.store.schema.version, 1);
  assert.deepEqual(paths.map((path) => readFileSync(path)), before);
  console.log(rootLines(status).join("\n"));
});
