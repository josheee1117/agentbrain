// The Antigravity CLI (agy) plugin in integrations/agy: its hook script turns agy's hook payloads into `ab` calls and
// `ab`'s answers into agy's injectSteps. `ab` here is a stand-in that records what it was asked and answers fixed text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const plugin = join(import.meta.dirname, "../integrations/agy");
const script = join(plugin, "agentbrain-agy.mjs");

function fake() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ab-agy-")));
  const ab = join(dir, "ab.mjs");
  writeFileSync(ab, `import fs from "node:fs";
const args = process.argv.slice(2), input = fs.readFileSync(0, "utf8");
fs.appendFileSync(${JSON.stringify(join(dir, "calls.jsonl"))}, JSON.stringify({ args, input, cwd: process.cwd() }) + "\\n");
if (args[0] === "brief") console.log("全局规则：先结论后原因");
if (args[0] === "recall") console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "<agentbrain-prefs>简洁</agentbrain-prefs>" } }));
`);
  const hook = (payload: object, env: Record<string, string> = {}) => {
    const r = spawnSync(process.execPath, [script], { input: JSON.stringify(payload), encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: dir, AGENTBRAIN_AB: ab, PLUGIN_DATA: join(dir, "data"), ...env } });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  const calls = () => { try { return readFileSync(join(dir, "calls.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  return { dir, hook, calls };
}
const text = (out: any) => out.injectSteps?.map((s: any) => s.systemMessage.systemMessage).join("\n") ?? "";

test("agy SessionStart：在会话的工作目录跑 ab brief，结果作为系统消息注入", () => {
  const f = fake();
  const out = f.hook({ hookEventName: "SessionStart", conversationId: "c1", cwd: f.dir });
  assert.match(text(out), /<agentbrain-brief>[\s\S]*先结论后原因[\s\S]*<\/agentbrain-brief>/);
  assert.match(text(out), /ab search/, "顺带说清何时查、何时记");
  assert.deepEqual([f.calls()[0].args, f.calls()[0].cwd], [["brief"], f.dir]);
});

test("agy PreInvocation：用户每发一条新消息才跑一次 ab recall --hook；同一轮里多次调模型不重复注入", () => {
  const f = fake();
  const turn = { hookEventName: "PreInvocation", conversationId: "c1", cwd: f.dir, lastUserInput: "修一下登录" };
  assert.match(text(f.hook(turn)), /<agentbrain-prefs>简洁/);
  assert.deepEqual(JSON.parse(f.calls().find((c) => c.args[0] === "recall").input), { prompt: "修一下登录", cwd: f.dir, worker: false });
  assert.deepEqual(f.hook({ ...turn, invocationNum: 2 }), {}, "同一条消息的后续调用不再注入");
  assert.match(text(f.hook({ ...turn, lastUserInput: "再加个测试" })), /agentbrain-prefs/, "新消息再注入");
  assert.match(text(f.hook({ ...turn, conversationId: "c2" })), /agentbrain-prefs/, "另一个会话各算各的");
  assert.equal(f.calls().filter((c) => c.args[0] === "recall").length, 3);
});

test("agy 登记会话：新用户消息登记一次；Stop 且不再继续时按会话结束登记（拉起抽取），继续中不登记", () => {
  const f = fake();
  const tp = join(f.dir, "brain/c1/.system_generated/logs/transcript.jsonl");
  const turn = { hookEventName: "PreInvocation", conversationId: "c1", cwd: f.dir, transcriptPath: tp, lastUserInput: "修一下登录" };
  f.hook(turn);
  f.hook({ ...turn, invocationNum: 2 });
  const captures = () => f.calls().filter((c) => c.args[0] === "capture");
  assert.deepEqual(captures().map((c) => [c.args, JSON.parse(c.input), c.cwd]), [
    [["capture", "--hook", "--host", "agy"], { session_id: "c1", transcript_path: tp, cwd: f.dir, hook_event_name: "UserPromptSubmit" }, f.dir],
  ]);
  assert.deepEqual(f.hook({ hookEventName: "Stop", conversationId: "c1", cwd: f.dir, transcriptPath: tp, continuationActive: true }), {});
  assert.equal(captures().length, 1, "还会接着跑的 Stop 不算结束");
  assert.deepEqual(f.hook({ hookEventName: "Stop", conversationId: "c1", cwd: f.dir, transcriptPath: tp, continuationActive: false, terminationReason: "NO_TOOL_CALL" }), {});
  assert.deepEqual(JSON.parse(captures()[1].input), { session_id: "c1", transcript_path: tp, cwd: f.dir, hook_event_name: "SessionEnd" });
  f.hook({ hookEventName: "Stop", conversationId: "c1", cwd: f.dir, continuationActive: false }, { AGENTBRAIN_REVIEWER: "1" });
  assert.equal(captures().length, 2, "审稿子进程不登记");
});

test("agy 里跑的 pm 队列任务算被派活的子代理：brief 加 --worker，recall 传 worker", () => {
  const f = fake();
  f.hook({ hookEventName: "SessionStart", conversationId: "c1", cwd: f.dir }, { PM_JOB_ID: "lane-w1" });
  f.hook({ hookEventName: "PreInvocation", conversationId: "c1", cwd: f.dir, lastUserInput: "读 task.md" }, { PM_JOB_ID: "lane-w1" });
  assert.deepEqual(f.calls()[0].args, ["brief", "--worker"]);
  assert.equal(JSON.parse(f.calls().find((c) => c.args[0] === "recall").input).worker, true);
});

test("agy 钩子：ab 出错或没有输出、其他事件，一律回答空对象，不挡 agy", () => {
  const f = fake();
  assert.deepEqual(f.hook({ hookEventName: "SessionStart", cwd: f.dir }, { AGENTBRAIN_AB: join(f.dir, "missing.mjs") }), {});
  assert.deepEqual(f.hook({ hookEventName: "PostToolUse", conversationId: "c1", cwd: f.dir }), {});
  const r = spawnSync(process.execPath, [script], { input: "不是 JSON", encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: f.dir } });
  assert.deepEqual([r.status, JSON.parse(r.stdout)], [0, {}]);
});

test("agy 插件清单：hooks.json 在插件根目录，SessionStart、PreInvocation、Stop 都跑这个脚本", () => {
  const hooks = JSON.parse(readFileSync(join(plugin, "hooks.json"), "utf8")).agentbrain;
  for (const event of ["SessionStart", "PreInvocation", "Stop"]) assert.match(hooks[event][0].command, /agentbrain-agy\.mjs/, event);
  assert.equal(JSON.parse(readFileSync(join(plugin, "plugin.json"), "utf8")).name, "agentbrain");
});
