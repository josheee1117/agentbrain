// Run the repository hook through stdin. Fake ab controls only the CLI boundary.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const plugin = join(import.meta.dirname, "../integrations/agy");
const script = join(plugin, "agentbrain-agy.mjs");
const prefs = "<agentbrain-prefs>简洁</agentbrain-prefs>";
type Output = { injectSteps?: { systemMessage: { systemMessage: string } }[] };
type Call = { args: string[]; input: string; cwd: string; env: Record<string, string> };
const text = (out: Output) => out.injectSteps?.map((s) => s.systemMessage.systemMessage).join("\n") ?? "";
const sessionKey = (root: string, id: string) => createHash("sha1").update(root + "\0" + id).digest("hex");

function fake(t: TestContext) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ab-agy-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ab = join(dir, "ab.mjs"), control = join(dir, "reply.json"), callsFile = join(dir, "calls.jsonl");
  const data = join(dir, "data");
  const env = { PATH: process.env.PATH ?? "", HOME: dir, AB_HOME: join(dir, "store"), AGENTBRAIN_HOME: join(dir, "store"), AB_REGISTRY: join(dir, "repos"), AGENTBRAIN_AB: ab, PLUGIN_DATA: data };
  mkdirSync(env.AB_REGISTRY);
  writeFileSync(ab, `import fs from "node:fs";
const args = process.argv.slice(2), input = fs.readFileSync(0, "utf8");
const env = Object.fromEntries(["HOME", "AB_HOME", "AB_REGISTRY", "ANTIGRAVITY_CONVERSATION_ID", "ANTIGRAVITY_APP_DATA_DIR"].filter(k => k in process.env).map(k => [k, process.env[k]]));
fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ args, input, cwd: process.cwd(), env }) + "\\n");
const reply = JSON.parse(fs.readFileSync(${JSON.stringify(control)}, "utf8"));
if (args[0] === "brief") { if (reply.brief === "fail") process.exit(1); console.log(reply.brief); }
if (args[0] === "recall") { if (reply.recall === "fail") process.exit(1); console.log(typeof reply.recall === "string" ? reply.recall : JSON.stringify(reply.recall)); }
`);
  const answer = (session: { worker: boolean | null; brief_present: boolean } | null = { worker: false, brief_present: false }, brief = "全局规则：先结论后原因", recall?: string) => {
    writeFileSync(control, JSON.stringify({ brief, recall: recall ?? { hookSpecificOutput: { additionalContext: prefs }, ...(session ? { agentbrain: { session } } : {}) } }));
  };
  answer();
  const hook = (payload: object, extraEnv: Record<string, string> = {}): Output => {
    const r = spawnSync(process.execPath, [script], { input: JSON.stringify(payload), encoding: "utf8", env: { ...env, ...extraEnv } });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  const calls = (): Call[] => existsSync(callsFile) ? readFileSync(callsFile, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
  const turn = { hookEventName: "PreInvocation", conversationId: "c1", cwd: dir, lastUserInput: "修一下登录" };
  const marker = (root = "", id = "c1") => join(data, "briefs", sessionKey(root, id));
  const state = (root = "", id = "c1") => readFileSync(marker(root, id), "utf8");
  return { dir, env, data, hook, calls, answer, turn, marker, state };
}

test("agy SessionStart：不调 ab、不注 brief", (t) => {
  const f = fake(t);
  assert.deepEqual(f.hook({ hookEventName: "SessionStart", conversationId: "c1", cwd: f.dir }), {});
  assert.deepEqual(f.calls(), []);
});

for (const worker of [true, false, null]) test(`agy PreInvocation：worker=${worker} 只按 session 三态选择 brief`, (t) => {
  const f = fake(t);
  f.answer({ worker, brief_present: false });
  const out = text(f.hook(f.turn, { PM_JOB_ID: "obsolete" }));
  assert.match(out, /agentbrain-prefs/);
  assert.deepEqual(f.calls().map((c) => c.args), [
    ["capture", "--hook", "--host", "agy"], ["recall", "--hook"], ...(worker === null ? [] : [worker ? ["brief", "--worker"] : ["brief"]]),
  ]);
  assert.equal(f.state(), worker === null ? "pending" : "done");
  if (worker === null) assert.doesNotMatch(out, /agentbrain-brief/);
  else {
    assert.match(out, /<agentbrain-brief>[\s\S]*先结论后原因[\s\S]*<\/agentbrain-brief>/);
    assert.match(out, /ab search/);
    assert.ok(out.indexOf("agentbrain-brief") < out.indexOf("agentbrain-prefs"));
  }
});

test("agy 首次 PreInvocation：capture 一次，recall stdin 与三个子进程都补会话坐标", (t) => {
  const f = fake(t);
  const root = join(f.dir, "app");
  mkdirSync(root);
  const tp = join(root, "brain/c1/.system_generated/logs/transcript.jsonl");
  f.hook({ ...f.turn, transcriptPath: tp }, { ANTIGRAVITY_CONVERSATION_ID: "wrong", ANTIGRAVITY_APP_DATA_DIR: join(f.dir, "wrong-app") });
  const calls = f.calls();
  assert.deepEqual(JSON.parse(calls[1].input), { prompt: f.turn.lastUserInput, cwd: f.dir, session_id: "c1", transcript_path: tp, want_session_state: true });
  assert.deepEqual(JSON.parse(calls[0].input), { session_id: "c1", transcript_path: tp, cwd: f.dir, hook_event_name: "UserPromptSubmit" });
  for (const call of calls) {
    assert.equal(call.cwd, f.dir);
    assert.equal(call.env.ANTIGRAVITY_CONVERSATION_ID, "c1");
    assert.equal(call.env.ANTIGRAVITY_APP_DATA_DIR, root);
    assert.equal(call.env.HOME, f.dir);
    assert.equal(call.env.AB_HOME, f.env.AB_HOME);
    assert.equal(call.env.AB_REGISTRY, f.env.AB_REGISTRY);
  }
  assert.equal(f.state(root), "done");
});

test("agy done 与 prompt seen 独立：同 prompt 不调 ab，新 prompt 只 capture 和 recall", (t) => {
  const f = fake(t);
  f.hook(f.turn);
  assert.deepEqual(f.hook({ ...f.turn, invocationNum: 2 }), {});
  assert.equal(f.calls().length, 3);
  assert.equal(text(f.hook({ ...f.turn, lastUserInput: "再加个测试" })), prefs);
  assert.deepEqual(f.calls().slice(3).map((c) => c.args[0]), ["capture", "recall"]);
  assert.equal(f.state(), "done");
});

for (const brief of ["fail", "", "   \n"]) test(`agy brief ${JSON.stringify(brief)} 后同 prompt 重试，不重复 capture 或 recall 上下文`, (t) => {
  const f = fake(t);
  f.answer({ worker: true, brief_present: false }, brief);
  assert.equal(text(f.hook(f.turn)), prefs);
  assert.equal(f.state(), "pending");
  f.answer({ worker: true, brief_present: false });
  const retry = text(f.hook({ ...f.turn, invocationNum: 2 }));
  assert.match(retry, /agentbrain-brief/);
  assert.doesNotMatch(retry, /agentbrain-prefs/);
  assert.equal(f.state(), "done");
  assert.deepEqual(f.calls().map((c) => c.args[0]), ["capture", "recall", "brief", "recall", "brief"]);
  assert.deepEqual(f.hook(f.turn), {});
  assert.equal(f.calls().length, 5);
});

test("agy 身份待定重试：只取 session，明确后补 brief，不补旧 prompt 的偏好", (t) => {
  const f = fake(t);
  f.answer({ worker: null, brief_present: false });
  assert.equal(text(f.hook(f.turn)), prefs);
  assert.deepEqual(f.hook(f.turn), {});
  assert.equal(f.state(), "pending");
  f.answer({ worker: false, brief_present: false });
  assert.match(text(f.hook(f.turn)), /agentbrain-brief/);
  assert.doesNotMatch(text(f.hook(f.turn)), /agentbrain-prefs/);
  assert.deepEqual(f.calls().map((c) => c.args[0]), ["capture", "recall", "recall", "recall", "brief"]);
  assert.equal(f.state(), "done");
});

for (const reply of ["fail", "", "{}", "not JSON"]) test(`agy recall ${JSON.stringify(reply)} 不猜身份，保留 pending 并重试`, (t) => {
  const f = fake(t);
  f.answer(null, "规则", reply);
  assert.deepEqual(f.hook(f.turn), {});
  assert.equal(f.state(), "pending");
  assert.deepEqual(f.calls().map((c) => c.args[0]), ["capture", "recall"]);
  f.answer({ worker: false, brief_present: false });
  const retry = text(f.hook(f.turn));
  assert.match(retry, /agentbrain-brief/);
  assert.doesNotMatch(retry, /agentbrain-prefs/);
  assert.equal(f.state(), "done");
});

test("agy 没有 session 元数据：不注 brief，仍返回 recall 上下文", (t) => {
  const f = fake(t);
  f.answer(null);
  assert.equal(text(f.hook(f.turn)), prefs);
  assert.equal(f.state(), "pending");
});

for (const worker of [true, false, null]) test(`agy 恢复会话：brief_present=true、worker=${worker} 时只信 ab，标记 done`, (t) => {
  const f = fake(t);
  f.answer({ worker, brief_present: true });
  assert.equal(text(f.hook(f.turn)), prefs);
  assert.deepEqual(f.calls().map((c) => c.args[0]), ["capture", "recall"]);
  assert.equal(f.state(), "done");
  rmSync(f.marker());
  assert.deepEqual(f.hook(f.turn), {});
  assert.deepEqual(f.calls().map((c) => c.args[0]), ["capture", "recall", "recall"]);
  assert.equal(f.state(), "done");
});

test("agy 规范根：transcript 先于 env，现有根 realpath，seen 与 briefs 同时按根和 id 隔离", (t) => {
  const f = fake(t);
  const a = join(f.dir, "app-a"), b = join(f.dir, "app-b"), alias = join(f.dir, "alias");
  mkdirSync(a); mkdirSync(b); symlinkSync(a, alias);
  const turn = (root: string, name = "transcript_full.jsonl") => ({ ...f.turn, transcriptPath: join(root, "brain/c1/.system_generated/logs", name) });
  f.hook(turn(alias), { ANTIGRAVITY_APP_DATA_DIR: b });
  assert.equal(f.state(a), "done");
  assert.deepEqual(f.hook(turn(a, "transcript.jsonl")), {});
  f.hook(turn(b));
  assert.equal(f.state(b), "done");
  assert.deepEqual(f.calls().map((c) => c.args[0]), ["capture", "recall", "brief", "capture", "recall", "brief"]);
  assert.equal(readFileSync(join(f.data, "seen", sessionKey(a, "c1")), "utf8"), readFileSync(join(f.data, "seen", sessionKey(b, "c1")), "utf8"));
  assert.match(text(f.hook({ ...f.turn, conversationId: "c2" }, { ANTIGRAVITY_APP_DATA_DIR: a })), /agentbrain-brief/);
  assert.equal(f.state(a, "c2"), "done");
});

test("agy 根兜底：env、GEMINI_HOME 下 acp、无根，不能硬塞空 APP_DATA_DIR", (t) => {
  const f = fake(t);
  const app = join(f.dir, "app"), gemini = join(f.dir, "gemini"), acp = join(gemini, "antigravity-acp");
  mkdirSync(app); mkdirSync(acp, { recursive: true });
  for (const [id, env, root] of [
    ["env", { ANTIGRAVITY_APP_DATA_DIR: app, GEMINI_HOME: gemini }, app],
    ["gemini", { GEMINI_HOME: gemini }, acp],
    ["none", { GEMINI_HOME: join(f.dir, "missing") }, ""],
  ] satisfies [string, Record<string, string>, string][]) {
    f.hook({ ...f.turn, conversationId: id, transcriptPath: join(f.dir, "unmatched.jsonl") }, env);
    assert.equal(f.state(root, id), "done");
    for (const call of f.calls().filter((c) => c.env.ANTIGRAVITY_CONVERSATION_ID === id)) {
      if (root) assert.equal(call.env.ANTIGRAVITY_APP_DATA_DIR, root);
      else assert.ok(!("ANTIGRAVITY_APP_DATA_DIR" in call.env));
    }
  }
});

test("agy Stop：继续中不登记，结束补坐标，审稿子进程不登记", (t) => {
  const f = fake(t), app = join(f.dir, "app");
  mkdirSync(app);
  const stop = { hookEventName: "Stop", conversationId: "c1", cwd: f.dir, transcriptPath: join(app, "brain/c1/.system_generated/logs/transcript.jsonl") };
  assert.deepEqual(f.hook({ ...stop, continuationActive: true }), {});
  assert.deepEqual(f.calls(), []);
  assert.deepEqual(f.hook({ ...stop, continuationActive: false }), {});
  const c = f.calls()[0];
  assert.deepEqual(c.args, ["capture", "--hook", "--host", "agy"]);
  assert.deepEqual(JSON.parse(c.input), { session_id: "c1", transcript_path: stop.transcriptPath, cwd: f.dir, hook_event_name: "SessionEnd" });
  assert.equal(c.env.ANTIGRAVITY_CONVERSATION_ID, "c1");
  assert.equal(c.env.ANTIGRAVITY_APP_DATA_DIR, app);
  f.hook(stop, { AGENTBRAIN_REVIEWER: "1" });
  assert.equal(f.calls().length, 1);
});

test("agy 钩子：缺少输入、其他事件、坏 JSON 不挡宿主", (t) => {
  const f = fake(t);
  assert.deepEqual(f.hook({ ...f.turn, lastUserInput: "" }), {});
  assert.deepEqual(f.hook({ ...f.turn, conversationId: "" }), {});
  assert.deepEqual(f.hook({ hookEventName: "PostToolUse", cwd: f.dir }), {});
  assert.deepEqual(f.calls(), []);
  const r = spawnSync(process.execPath, [script], { input: "不是 JSON", encoding: "utf8", env: f.env });
  assert.deepEqual([r.status, JSON.parse(r.stdout)], [0, {}]);
});

test("agy 插件真实 CLI：隔离 CLI、IDE 首轮三态、斜杠命令、待定重试与恢复，回读会话坐标", (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ab-agy-plugin-cli-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cli = join(import.meta.dirname, "cli.ts"), home = join(dir, "home"), repo = join(dir, "repo"), registry = join(dir, "repos"), store = join(dir, "store"), data = join(dir, "data");
  for (const path of [home, repo, registry]) mkdirSync(path);
  assert.equal(spawnSync("git", ["init", "-q", repo]).status, 0);
  writeFileSync(join(registry, "plugin.md"), `- 路径：\`${repo}\`\n`);
  const calls = join(dir, "cli-calls.jsonl"), tracedCli = join(dir, "traced-cli.mjs");
  writeFileSync(tracedCli, `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n');\nawait import(${JSON.stringify(cli)});\n`);
  const env = { PATH: process.env.PATH ?? "", HOME: home, AB_HOME: store, AGENTBRAIN_HOME: store, AB_REGISTRY: registry, AGENTBRAIN_AB: tracedCli, PLUGIN_DATA: data };
  const seed = spawnSync(process.execPath, [cli, "remember", "--global", "--confirmed", "--for-workers", "--kind", "rule", "--text", "插件真实验证规则", "--summary", "插件验收"], { cwd: repo, env, encoding: "utf8" });
  assert.equal(seed.status, 0, seed.stderr);
  // Replay the host process name without installing a plugin or starting a real IDE.
  const agy = join(dir, "agy");
  symlinkSync(process.execPath, agy);
  const run = (payload: object): Output => {
    const r = spawnSync(agy, ["-e", 'const {spawnSync}=require("node:child_process"); const r=spawnSync(process.execPath,process.argv.slice(1),{stdio:"inherit"}); process.exit(r.status ?? 1);', script], { cwd: repo, env, encoding: "utf8", input: JSON.stringify(payload) });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  for (const appName of ["antigravity-cli", "antigravity"]) for (const [worker, slash] of [[true, false], [false, false], [null, false], [false, true]] satisfies [boolean | null, boolean][]) {
    const app = join(home, ".gemini", appName), sid = `plugin-${appName}-${worker}${slash ? "-slash" : ""}`;
    const logs = join(app, "brain", sid, ".system_generated/logs"), full = join(logs, "transcript_full.jsonl");
    mkdirSync(logs, { recursive: true });
    const input = slash ? "/plan 做方案" : worker === true ? "ab brief --worker\n修复插件" : "修复插件";
    const transcript = JSON.stringify({ type: "USER_INPUT", step_index: 0, content: input }) + "\n";
    writeFileSync(full, worker === null ? "" : transcript);
    const turn = { hookEventName: "PreInvocation", conversationId: sid, transcriptPath: join(logs, "transcript.jsonl"), cwd: repo, lastUserInput: input };
    const marker = join(data, "briefs", sessionKey(app, sid));
    assert.deepEqual(run({ ...turn, hookEventName: "SessionStart" }), {});
    assert.ok(!existsSync(marker));
    let output = text(run(turn));
    if (worker === null) {
      assert.doesNotMatch(output, /agentbrain-brief/);
      assert.equal(readFileSync(marker, "utf8"), "pending");
      writeFileSync(full, transcript);
      output = text(run(turn));
      assert.doesNotMatch(output, /agentbrain-prefs|agentbrain-recall/);
    }
    assert.match(output, /<agentbrain-brief>[\s\S]*插件真实验证规则/);
    if (slash) assert.doesNotMatch(output, /agentbrain-prefs|agentbrain-recall/);
    assert.equal(/<agentbrain [^>]*\bworker/.test(output), worker === true);
    assert.equal(readFileSync(marker, "utf8"), "done");
    const called = readFileSync(calls, "utf8");
    assert.deepEqual(run({ ...turn, invocationNum: 2 }), {});
    assert.equal(readFileSync(calls, "utf8"), called, "同一 prompt 的第二次 PreInvocation 不调 ab");
    const restored = transcript + JSON.stringify({ type: "SYSTEM_MESSAGE", content: output }) + "\n";
    writeFileSync(full, restored);
    rmSync(marker);
    assert.deepEqual(run(turn), {});
    assert.equal(readFileSync(marker, "utf8"), "done");
    assert.doesNotMatch(text(run({ ...turn, lastUserInput: "补测试" })), /agentbrain-brief/);
    const db = new DatabaseSync(join(store, "store.db"));
    try {
      const captures = db.prepare("SELECT host,session_id,transcript,cwd FROM capture_sessions WHERE session_id=?").all(sid);
      assert.deepEqual(captures.map((row) => ({ ...row })), [{ host: "agy", session_id: sid, transcript: full, cwd: repo }]);
      const briefs = db.prepare("SELECT host,session_id,transcript FROM inject_log WHERE path='brief' AND session_id=?").all(sid);
      assert.deepEqual(briefs.map((row) => ({ ...row })), [{ host: "agy", session_id: sid, transcript: full }]);
      const recalls = db.prepare("SELECT host,session_id,transcript FROM recall_runs WHERE session_id=?").all(sid);
      assert.equal(recalls.length, slash ? 1 : worker === null ? 4 : 3);
      assert.ok(recalls.every((row) => row.host === "agy" && row.transcript === full));
      t.diagnostic(JSON.stringify({ appName, worker, sid, output, marker, state: "done", capture: captures[0], briefs, recall_count: recalls.length, transcript_unchanged: readFileSync(full, "utf8") === restored }));
    } finally { db.close(); }
    assert.equal(readFileSync(full, "utf8"), restored, "插件和 CLI 不改转录");
  }
});

test("agy 插件清单：原有三个事件不变", () => {
  const hooks = JSON.parse(readFileSync(join(plugin, "hooks.json"), "utf8")).agentbrain;
  assert.deepEqual(Object.keys(hooks).sort(), ["PreInvocation", "SessionStart", "Stop"]);
  for (const event of Object.keys(hooks)) assert.match(hooks[event][0].command, /agentbrain-agy\.mjs/);
  assert.equal(JSON.parse(readFileSync(join(plugin, "plugin.json"), "utf8")).name, "agentbrain");
});
