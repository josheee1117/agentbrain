/** ab setup 的纯逻辑：hooks 合并、钥匙串条目名、连通探测。运行：node --test src/setup.test.ts */
import { test } from "node:test";
import assert from "node:assert/strict";
import { keyServiceFor, mergeHooks, probe } from "./setup.ts";

test("mergeHooks：补齐缺的命令、保留原有内容、重复运行不再改；路径写法不同视为同一条", () => {
  const orig = { model: "x", hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "/opt/homebrew/bin/node /Users/u/.local/bin/ab recall --hook", timeout: 5 }] }], Stop: [{ hooks: [{ type: "command", command: "other" }] }] } };
  const { next, added } = mergeHooks(orig, "claude", "/n/node /a/ab");
  assert.deepEqual(added, ["UserPromptSubmit: /n/node /a/ab capture --hook --host claude", "SessionEnd: /n/node /a/ab capture --hook --host claude", "PreCompact: /n/node /a/ab capture --hook --host claude"]);
  assert.equal(next.model, "x");
  assert.deepEqual(next.hooks.Stop, orig.hooks.Stop);
  assert.equal(orig.hooks.UserPromptSubmit.length, 1, "不改入参");
  assert.deepEqual(mergeHooks(next, "claude", "ab").added, []);
  assert.equal(mergeHooks({}, "codex", "ab").next.hooks.SessionEnd[0].hooks[0].timeout, 3);
  assert.equal(mergeHooks({}, "codex", "ab").next.hooks.PreCompact[0].hooks[0].command, "ab capture --hook --host codex", "话题结束触发（§8.6）：压缩前登记边界");
});

test("keyServiceFor", () => {
  assert.equal(keyServiceFor("Sol"), "agentbrain-sol");
  assert.equal(keyServiceFor("ark deepseek!"), "agentbrain-ark-deepseek");
});

test("probe：通、401、超时都给出原文", async () => {
  const cfg = { baseUrl: "http://x/v1", model: "m", keyService: "k" };
  const ok = await probe(cfg, "k", (async () => new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: '{"ok":true}' } }] }))) as any);
  assert.equal(ok.ok, true);
  const bad = await probe(cfg, "k", (async () => new Response(JSON.stringify({ error: { message: "invalid key" } }), { status: 401 })) as any);
  assert.equal(bad.ok, false);
  assert.match(bad.detail, /401: invalid key/);
});
