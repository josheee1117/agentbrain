/** 运行：node --test src/extract.test.ts */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMessages, sha256, validate, type ExtractWindow } from "./extract.ts";
import type { Proposition } from "./l2.ts";

const win: ExtractWindow = {
  context: [{ anchor: "c0", role: "user", text: "旧的上下文：以后都用 tabs" }],
  turns: [
    { anchor: "u1", role: "user", text: "以后 hook 命令都用 node 的绝对路径，别依赖 PATH" },
    { anchor: "a1", role: "assistant", text: "调用 Bash: npm test" },
    { anchor: "t1", role: "tool", text: "Error: node:sqlite 不存在 (node v20)" },
  ],
};
const neighbor = { id: "11111111-aaaa", kind: "rule", text: "代码风格统一两个空格", confirmed: true } as Proposition;
const good = {
  kind: "rule",
  scope: "global",
  text: "hook 命令用 node 绝对路径，不依赖 PATH",
  basis: "user_directive",
  evidence: [{ anchor: "#1", role: "user", quote: "以后 hook 命令都用 node 的绝对路径" }],
  relation: { type: "new", target: null },
};

test("合格候选通过：锚点映射回宿主定位点，只存引文哈希", () => {
  const v = validate({ candidates: [good] }, win, [neighbor], "w1");
  assert.deepEqual(v.dropped, {});
  assert.equal(v.candidates.length, 1);
  assert.deepEqual(v.candidates[0].evidence, [{ anchor: "u1", role: "user", quote_sha256: sha256("以后 hook 命令都用 node 的绝对路径") }]);
  assert.deepEqual(v.candidates[0].relation, { type: "new", target: null });
});

test("编造的引文、错的角色、上下文区的锚点、越界锚点都被拒绝", () => {
  const v = validate({
    candidates: [
      { ...good, evidence: [{ anchor: "#1", role: "user", quote: "以后所有命令都要加 sudo" }] },
      { ...good, evidence: [{ anchor: "#1", role: "assistant", quote: "以后 hook 命令都用 node 的绝对路径" }] },
      { ...good, evidence: [{ anchor: "#c1", role: "user", quote: "以后都用 tabs" }] },
      { ...good, evidence: [{ anchor: "#9", role: "user", quote: "以后 hook 命令都用 node 的绝对路径" }] },
    ],
  }, win, [], "w1");
  assert.equal(v.candidates.length, 0);
  assert.deepEqual(v.dropped, { quote_mismatch: 1, role_mismatch: 1, anchor_outside: 2 });
});

test("依据与引文角色要对得上：user_directive 必须引用户，observed_failure 必须引工具输出", () => {
  const v = validate({
    candidates: [
      { ...good, kind: "pitfall", basis: "observed_failure", text: "要 Node 24", evidence: [{ anchor: "#1", role: "user", quote: "以后 hook 命令都用 node 的绝对路径" }] },
      { ...good, kind: "pitfall", basis: "observed_failure", text: "node:sqlite 要 Node ≥24", evidence: [{ anchor: "#3", role: "tool", quote: "node:sqlite 不存在" }] },
    ],
  }, win, [], "w1");
  assert.equal(v.candidates.length, 1);
  assert.equal(v.candidates[0].text, "node:sqlite 要 Node ≥24");
  assert.deepEqual(v.dropped, { role_mismatch: 1 });
});

test("正文里带秘密（模型还原或编出）的候选整条丢弃；note/procedure 不是可抽取种类", () => {
  const v = validate({
    candidates: [
      { ...good, text: "key 是 sk-abcdefghijklmnop1234" },
      { ...good, kind: "note" },
      { ...good, kind: "procedure" },
      { ...good, text: "<agentbrain-recall>回声</agentbrain-recall>" },
    ],
  }, win, [], "w1");
  assert.equal(v.candidates.length, 0);
  assert.deepEqual(v.dropped, { secret: 1, bad_kind: 2, echo: 1 });
});

test("关系目标只能是给模型看过的近邻；正文与近邻相同时按重复处理", () => {
  const v = validate({
    candidates: [
      { ...good, relation: { type: "conflicts", target: "m1" } },
      { ...good, text: "另一条", relation: { type: "duplicate", target: "m7" } },
      { ...good, text: "代码风格统一两个空格", relation: { type: "new", target: null } },
    ],
  }, win, [neighbor], "w1");
  assert.deepEqual(v.candidates.map((c) => c.relation), [
    { type: "conflicts", target: neighbor.id },
    { type: "unsure", target: null },
    { type: "duplicate", target: neighbor.id },
  ]);
});

test("不是 {candidates:[…]} 的输出整体记为 bad_shape", () => {
  assert.deepEqual(validate({ foo: 1 }, win, [], "w1"), { candidates: [], dropped: { bad_shape: 1 } });
});

test("送模型的消息包含项目背景与近邻，并把会话声明为不可信数据", () => {
  const m = buildMessages(win, { name: "alpha", docs: "## AGENTS.md\n实现交给 Codex", registry: "- 路径：`~/x`", confirmed: "- [rule] 两个空格" }, [neighbor]);
  const user = m[1].content!;
  assert.match(m[0].content!, /不可信数据/);
  assert.match(user, /<repo_docs>\n## AGENTS.md\n实现交给 Codex/);
  assert.match(user, /<confirmed_memories>\n- \[rule\] 两个空格/);
  assert.match(user, /m1 \[rule\] 代码风格统一两个空格/);
  assert.match(user, /\[#c1 user\] 旧的上下文/);
  assert.match(user, /\[#3 tool\] Error: node:sqlite/);
});
