/**
 * 三宿主 transcript 展开。运行：node --test src/source.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expandSource, latestAnchor } from "./source.ts";
import type { SourcePointer } from "./store.ts";

const dir = mkdtempSync(join(tmpdir(), "ab-src-"));
const ptr = (over: Partial<SourcePointer>): SourcePointer => ({
  host: null,
  session_id: null,
  transcript: null,
  anchor: null,
  summary: "",
  ...over,
});

test("pi：沿 parentId 回溯，按时间顺序；跳过非 user/assistant；其他分支不读", () => {
  const f = join(dir, "pi.jsonl");
  const lines = [
    { type: "session", version: 3, id: "x" },
    { type: "message", id: "e1", parentId: null, message: { role: "user", content: "我们用 SQLite 还是文件？" } },
    { type: "message", id: "e2", parentId: "e1", message: { role: "assistant", content: [{ type: "text", text: "SQLite，理由是事务。" }] } },
    { type: "message", id: "e3", parentId: "e2", message: { role: "toolResult", content: [{ type: "text", text: "noise" }] } },
    { type: "message", id: "e4", parentId: "e3", message: { role: "user", content: "好，就这么定。" } },
    { type: "message", id: "other", parentId: "e1", message: { role: "user", content: "另一个分支" } },
  ];
  writeFileSync(f, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const out = expandSource(ptr({ host: "pi", transcript: f, anchor: "e4" }))!;
  assert.match(out, /^\[user\] 我们用 SQLite/);
  assert.ok(out.indexOf("SQLite，理由") < out.indexOf("就这么定"));
  assert.ok(!out.includes("noise"));
  assert.ok(!out.includes("另一个分支"));
  assert.equal(expandSource(ptr({ host: "pi", transcript: f, anchor: "missing" })), null);
  assert.equal(latestAnchor("pi", f), "other");
  assert.equal(expandSource(ptr({ host: "pi", transcript: f, anchor: "no-such-id" })), null, "anchor 不在 transcript 里");
});

test("claude：沿 parentUuid 回溯；没有文本的条目跳过；字符串与数组 content 都读", () => {
  const f = join(dir, "claude.jsonl");
  const lines = [
    { type: "queue-operation", sessionId: "s" },
    { uuid: "u1", parentUuid: null, type: "user", message: { content: "第一条" } },
    { uuid: "a1", parentUuid: "u1", type: "assistant", message: { content: [{ type: "text", text: "回复一" }] } },
    { uuid: "a2", parentUuid: "a1", type: "assistant", message: { content: [{ type: "tool_use", id: "t", name: "Bash", input: {} }] } },
    { uuid: "u2", parentUuid: "a2", type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t", content: "工具输出" }] } },
    { uuid: "a3", parentUuid: "u2", type: "assistant", message: { content: [{ type: "text", text: "回复二" }] } },
    { uuid: "side", parentUuid: "u1", type: "user", message: { content: "旁支" } },
  ];
  writeFileSync(f, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const out = expandSource(ptr({ host: "claude", transcript: f, anchor: "a3" }))!;
  assert.deepEqual(
    out.split("\n\n").map((l) => l.replace(/^\[[a-z]+\] /, "")),
    ["第一条", "回复一", "回复二"],
  );
  assert.ok(!out.includes("工具输出"));
  assert.ok(!out.includes("旁支"));
  assert.equal(latestAnchor("claude", f), "side");
  assert.equal(expandSource(ptr({ host: "claude", transcript: f, anchor: "no-such-uuid" })), null, "anchor 不在 transcript 里");
});

test("codex：只取 response_item 消息；跳过宿主注入；ordinal 不大于 anchor 的最后若干条", () => {
  const f = join(dir, "codex.jsonl");
  const msg = (ordinal: number, role: string, text: string) => ({
    timestamp: "t",
    ordinal,
    type: "response_item",
    payload: { type: "message", role, content: [{ type: "input_text", text }] },
  });
  const lines = [
    { timestamp: "t", ordinal: 1, type: "session_meta", payload: { id: "s" } },
    msg(2, "user", "# AGENTS.md instructions for /tmp"),
    msg(3, "user", "<environment_context>cwd</environment_context>"),
    msg(4, "developer", "<permissions>sandbox</permissions>"),
    msg(5, "user", "真实问题"),
    msg(6, "assistant", "真实回答"),
    { timestamp: "t", ordinal: 7, type: "response_item", payload: { type: "function_call", name: "bash" } },
    msg(8, "assistant", "anchor 之后的回答"),
  ];
  writeFileSync(f, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const out = expandSource(ptr({ host: "codex", transcript: f, anchor: "6" }))!;
  assert.deepEqual(out.split("\n\n"), ["[user] 真实问题", "[assistant] 真实回答"]);
  assert.ok(!out.includes("AGENTS.md"));
  assert.ok(!out.includes("environment_context"));
  assert.ok(!out.includes("anchor 之后"));
  assert.equal(expandSource(ptr({ host: "codex", transcript: f, anchor: "0" })), null, "anchor 之前没有任何行");
  assert.equal(expandSource(ptr({ host: "codex", transcript: f, anchor: "999" })), null, "anchor 对不上任何一行");
  assert.equal(latestAnchor("codex", f), "8");
});

test("codex：只丢已知宿主注入，<task> 开头的用户消息保留", () => {
  const f = join(dir, "codex-task.jsonl");
  const msg = (ordinal: number, text: string) => ({
    timestamp: "t",
    ordinal,
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
  });
  writeFileSync(f, [msg(1, "<task>做这件事"), msg(2, "<environment_context>cwd</environment_context>")].map((l) => JSON.stringify(l)).join("\n") + "\n");
  const out = expandSource(ptr({ host: "codex", transcript: f, anchor: "2" }))!;
  assert.match(out, /<task>做这件事/);
  assert.ok(!out.includes("environment_context"));
});

test("jsonl 里夹一行 null 不抛错", () => {
  const f = join(dir, "null-line.jsonl");
  writeFileSync(f, 'null\n{"type":"message","id":"e1","parentId":null,"message":{"role":"user","content":"还在"}}\n');
  assert.match(expandSource(ptr({ host: "pi", transcript: f, anchor: "e1" }))!, /还在/);
});

test("文件不存在返回 null", () => {
  const f = join(dir, "nope.jsonl");
  assert.equal(expandSource(ptr({ host: "pi", transcript: f, anchor: "e1" })), null);
  assert.equal(latestAnchor("claude", f), null);
  rmSync(dir, { recursive: true, force: true });
});
