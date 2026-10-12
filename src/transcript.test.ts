/** 运行：node --test src/transcript.test.ts */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanTranscript, isAbCommand } from "./transcript.ts";

const dir = mkdtempSync(join(tmpdir(), "ab-tr-"));
const file = (name: string, lines: object[]) => {
  const p = join(dir, name);
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return p;
};

test("Claude：剥掉 recall 注入、system-reminder 和 ab 调用及其输出；工具报错留首尾", () => {
  const p = file("c.jsonl", [
    { type: "user", uuid: "u1", cwd: "/repo", message: { role: "user", content: "<agentbrain-recall>\n- [abcd] 坑: 旧记忆\n</agentbrain-recall>\n以后 hook 都用绝对路径" } },
    { type: "assistant", uuid: "a1", message: { content: [{ type: "text", text: "好的<system-reminder>别泄露</system-reminder>" }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "ab search hook" } }] } },
    { type: "user", uuid: "r1", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "[abcd] 全局 坑: 旧记忆" }] } },
    { type: "assistant", uuid: "a2", message: { content: [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "npm test" } }] } },
    { type: "user", uuid: "r2", message: { content: [{ type: "tool_result", tool_use_id: "t2", content: "Error: node:sqlite not found", is_error: true }] } },
    { type: "assistant", uuid: "a3", message: { content: [{ type: "tool_use", id: "t3", name: "Read", input: { file_path: "/repo/a.ts" } }] } },
    { type: "user", uuid: "r3", message: { content: [{ type: "tool_result", tool_use_id: "t3", content: "x".repeat(50) }] } },
    { type: "user", uuid: "m1", isMeta: true, message: { content: "meta 注入" } },
    { type: "user", uuid: "s1", isSidechain: true, message: { content: "子代理" } },
  ]);
  const c = cleanTranscript("claude", p);
  assert.equal(c.cwd, "/repo");
  assert.deepEqual(c.turns, [
    { anchor: "u1", role: "user", text: "以后 hook 都用绝对路径" },
    { anchor: "a1", role: "assistant", text: "好的\n调用 ab（agentbrain 自身的命令，已省略）" },
    { anchor: "a2", role: "assistant", text: "调用 Bash: npm test" },
    { anchor: "r2", role: "tool", text: "Error: node:sqlite not found" },
    { anchor: "a3", role: "assistant", text: "调用 Read: /repo/a.ts" },
    { anchor: "r3", role: "tool", text: "（工具输出 50 字，已省略）" },
  ]);
  assert.equal(c.stripped, 4);
});

test("Codex：丢 environment_context 等宿主注入，function_call 压成一行", () => {
  const p = file("x.jsonl", [
    { type: "session_meta", payload: { cwd: "/repo2" } },
    { ordinal: 1, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>cwd</environment_context>" }, { type: "input_text", text: "修一下" }] } },
    { ordinal: 2, type: "response_item", payload: { type: "function_call", name: "shell", call_id: "c1", arguments: JSON.stringify({ command: ["bash", "-lc", "/opt/homebrew/bin/node /Users/x/.local/bin/ab brief"] }) } },
    { ordinal: 3, type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: "<agentbrain project=\"p\">…</agentbrain>" } },
    { ordinal: 4, type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "dev" }] } },
    { ordinal: 5, type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "好" }] } },
  ]);
  const c = cleanTranscript("codex", p);
  assert.equal(c.cwd, "/repo2");
  assert.deepEqual(c.turns, [
    { anchor: "1", role: "user", text: "修一下" },
    { anchor: "2", role: "assistant", text: "调用 ab（agentbrain 自身的命令，已省略）" },
    { anchor: "5", role: "assistant", text: "好" },
  ]);
});

test("Pi：沿当前分支（最后一条往回）读，自定义注入消息不读", () => {
  const p = file("p.jsonl", [
    { type: "session", id: "h", cwd: "/repo3" },
    { type: "message", id: "e1", parentId: "h", message: { role: "user", content: "开始" } },
    { type: "message", id: "old", parentId: "e1", message: { role: "assistant", content: [{ type: "text", text: "废弃分支" }] } },
    { type: "custom_message", id: "cm", parentId: "e1", customType: "agentbrain-recall", content: "<agentbrain-recall>x</agentbrain-recall>" },
    { type: "message", id: "e2", parentId: "cm", message: { role: "assistant", content: [{ type: "text", text: "当前分支" }, { type: "toolCall", id: "k1", name: "bash", arguments: { command: "ls" } }] } },
    { type: "message", id: "e3", parentId: "e2", message: { role: "toolResult", toolCallId: "k1", content: [{ type: "text", text: "a b" }] } },
  ]);
  const c = cleanTranscript("pi", p);
  assert.equal(c.cwd, "/repo3");
  assert.deepEqual(c.turns.map((t) => [t.anchor, t.role, t.text]), [
    ["e1", "user", "开始"],
    ["e2", "assistant", "当前分支\n调用 bash: ls"],
    ["e3", "tool", "（工具输出 3 字，已省略）"],
  ]);
});

test("识别 ab 自身命令（含绝对路径与 cli.ts），不误伤含 ab 的普通命令", () => {
  assert.equal(isAbCommand("ab recall --hook"), true);
  assert.equal(isAbCommand("cd x && /Users/h/.local/bin/ab get 1234"), true);
  assert.equal(isAbCommand("node src/cli.ts search foo"), true);
  assert.equal(isAbCommand("grep -r tab file"), false);
  assert.equal(isAbCommand("cat lab notes"), false);
});
