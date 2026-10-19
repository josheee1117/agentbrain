import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMatchRefs } from "./evalmatch.ts";

test("评测匹配员输出：键齐全且值为 null 或存在的产出编号才算有效", () => {
  assert.deepEqual(parseMatchRefs({ refs: { r1: "o2", r2: null } }, 2, 2), [1, null]);
  assert.deepEqual(parseMatchRefs({ refs: { r1: " o1 " } }, 1, 1), [0]);
  assert.equal(parseMatchRefs(null, 1, 1), null);
  assert.equal(parseMatchRefs({ refs: { r1: null } }, 2, 1), null, "缺键");
  assert.equal(parseMatchRefs({ refs: { r1: false } }, 1, 1), null, "值类型错误");
  assert.equal(parseMatchRefs({ refs: { r1: "null" } }, 1, 1), null, "字符串 null 不是 JSON null");
  assert.equal(parseMatchRefs({ refs: { r1: "o3" } }, 1, 2), null, "编号越界");
  assert.equal(parseMatchRefs({ refs: { r1: "o0" } }, 1, 2), null, "编号越界");
  assert.equal(parseMatchRefs({ refs: ["o1"] }, 1, 1), null);
});
