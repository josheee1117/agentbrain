/** 运行：node --test src/transcript.test.ts */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanTranscript, isAbCommand, stripInjected } from "./transcript.ts";

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
    { anchor: "a1", role: "assistant", text: "好的\n调用 ab（agentbrain 自身的命令，已省略）", reply: "好的<system-reminder>别泄露</system-reminder>" },
    { anchor: "a2", role: "assistant", text: "调用 Bash: npm test", reply: "" },
    { anchor: "r2", role: "tool", text: "Error: node:sqlite not found" },
    { anchor: "a3", role: "assistant", text: "调用 Read: /repo/a.ts", reply: "" },
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
    { anchor: "2", role: "assistant", text: "调用 ab（agentbrain 自身的命令，已省略）", reply: "" },
    { anchor: "5", role: "assistant", text: "好", reply: "好" },
  ]);
});

test("Codex 子 agent 会话（guardian / thread_spawn）标为 subagent；普通会话不是", () => {
  const msg = { ordinal: 1, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "[#3 user] 嵌套的另一份记录" }] } };
  const g = cleanTranscript("codex", file("g.jsonl", [{ type: "session_meta", payload: { cwd: "/r", source: { subagent: { other: "guardian" } } } }, msg]));
  const t = cleanTranscript("codex", file("t.jsonl", [{ type: "session_meta", payload: { cwd: "/r", source: { subagent: { thread_spawn: { depth: 1 } } } } }, msg]));
  const v = cleanTranscript("codex", file("v.jsonl", [{ type: "session_meta", payload: { cwd: "/r", source: "vscode" } }, msg]));
  assert.deepEqual([g.subagent, t.subagent, v.subagent], [true, true, false]);
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

test("剥掉宿主注入噪声：skill 正文、task-notification、Codex app 页面事件、Subagent updates above.", () => {
  const cases: [string, string][] = [
    ['<skill name="show-me" location="/x/SKILL.md">\n# Show me\n很长的说明\n</skill>\n给我直接浏览器打开', "给我直接浏览器打开"],
    ["<task-notification> <task-id>a9</task-id> <status>completed</status> </task-notification>", ""],
    ['<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>', ""],
    ["Subagent updates above.", ""],
    ["Subagent updates above.\n为什么超时", "为什么超时"],
    ["说明里提到 Subagent updates above. 这句话", "说明里提到 Subagent updates above. 这句话"],
    ["我写了 <skill> 标签吗", "我写了 <skill> 标签吗"],
  ];
  for (const [inp, out] of cases) assert.equal(stripInjected(inp).text, out, inp);
});

test("轮次带上宿主记录的时间戳（到期复审起算用）", () => {
  const f = join(mkdtempSync(join(tmpdir(), "ab-ts-")), "c.jsonl");
  writeFileSync(f, [
    { type: "user", uuid: "u1", timestamp: "2026-09-01T08:00:00Z", message: { role: "user", content: "以后都用中文" } },
    { type: "assistant", uuid: "a1", message: { role: "assistant", content: [{ type: "text", text: "好" }] } },
  ].map((l) => JSON.stringify(l)).join("\n"));
  const t = cleanTranscript("claude", f).turns;
  assert.equal(t[0].ts, "2026-09-01T08:00:00.000Z");
  assert.equal(t[1].ts, undefined);
});

test("Claude：上下文压缩后写进来的摘要（isCompactSummary）不当成用户的一轮", () => {
  const p = file("compact.jsonl", [
    { type: "user", uuid: "u1", timestamp: "2026-10-16T01:00:00Z", message: { role: "user", content: "改完 UI 先重启 dev server" } },
    { type: "system", subtype: "compact_boundary", uuid: "b1", timestamp: "2026-10-16T01:10:00Z" },
    { type: "user", uuid: "s1", isCompactSummary: true, timestamp: "2026-10-16T01:10:01Z", message: { role: "user", content: "This session is being continued from a previous conversation. 改完 UI 先重启 dev server" } },
    { type: "user", uuid: "u2", timestamp: "2026-10-16T01:11:00Z", message: { role: "user", content: "下一个问题" } },
  ]);
  const r = cleanTranscript("claude", p);
  assert.deepEqual(r.turns.map((t) => t.anchor), ["u1", "u2"]);
  assert.equal(r.stripped, 1);
});

test("Claude：额度用尽等 API 错误时宿主写的 <synthetic> 提示不算助手回复", () => {
  const p = file("c-err.jsonl", [
    { type: "user", uuid: "u1", timestamp: "2026-10-21T07:51:20.000Z", message: { role: "user", content: "问题" } },
    { type: "assistant", uuid: "a1", timestamp: "2026-10-21T07:51:23.317Z", error: "rate_limit", isApiErrorMessage: true, message: { model: "<synthetic>", content: [{ type: "text", text: "You've hit your session limit · resets 7:10pm (Asia/Singapore)" }] } },
  ]);
  assert.deepEqual(cleanTranscript("claude", p).turns.map((t) => t.role), ["user"]);
});

test("回答里提到但没闭合的 <agentbrain-recall> 不删后文；闭合的注入块照删", () => {
  const p = file("mention.jsonl", [
    { type: "session", id: "h", cwd: "/repo" },
    { type: "message", id: "u", parentId: "h", message: { role: "user", content: "<agentbrain-recall>\n- [abcd1234] 坑: 旧记忆\n</agentbrain-recall>\n召回输出有几行？" } },
    { type: "message", id: "a", parentId: "u", message: { role: "assistant", content: [{ type: "text", text: "正常输出里 `<agentbrain-recall>` 块只有 1~3 行。\n所以别断言第 4 条。" }] } },
  ]);
  assert.deepEqual(cleanTranscript("pi", p).turns.map((t) => t.text), [
    "召回输出有几行？",
    "正常输出里 `<agentbrain-recall>` 块只有 1~3 行。\n所以别断言第 4 条。",
  ]);
});
