/** 关系判定输出的确定性校验。运行：node --test src/relate.test.ts */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRelateMessages, parseRelate, type RelateItem } from "./relate.ts";
import type { Proposition } from "./l2.ts";

const prop = (id: string, text: string, confirmed = false) => ({ id, text, kind: "rule", confirmed }) as unknown as Proposition;
const items: RelateItem[] = [
  { prop: prop("n1", "新条目 sk-abcdefghijklmnopqrstuvwxyz0123456789"), neighbors: [prop("o1", "旧条目", true), prop("o2", "另一条")] },
  { prop: prop("n2", "第二条"), neighbors: [prop("o3", "旧")] },
];

test("prompt：题号 q、近邻编号 m、确认状态；正文脱敏", () => {
  const m = buildRelateMessages(items)[1].content!;
  assert.match(m, /## q1\nN: \[rule，未确认\] 新条目/);
  assert.match(m, /m1: \[rule，已确认\] 旧条目\nm2: \[rule，未确认\] 另一条/);
  assert.doesNotMatch(m, /sk-abcdefghij/);
});

test("校验：越界编号、缺 target、未知关系、重复题号都作废；unrelated 丢掉 target", () => {
  const v = parseRelate({ results: [
    { id: "q1", relation: "duplicate", target: "m3" },
    { id: "q1", relation: "refines", target: "m2", reason: "更具体" },
    { id: "q2", relation: "unrelated", target: "m1" },
  ] }, items);
  assert.deepEqual(v.map((x) => x && [x.outcome, x.target?.id ?? null]), [["refines", "o2"], ["unrelated", null]]);
  assert.deepEqual(parseRelate({ results: [{ id: "q1", relation: "conflicts", target: null }, { id: "q2", relation: "maybe" }] }, items), [null, null]);
  assert.deepEqual(parseRelate("x", items), [null, null]);
});
