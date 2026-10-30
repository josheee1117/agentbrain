/** 关系判定输出的确定性校验。运行：node --test src/relate.test.ts */
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyVerdict, buildRelateMessages, parseRelate, RELATE_BODY_MAX_CHARS, type MergePolicy, type RelateItem } from "./relate.ts";
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

test("§8.11.3 关系判定：body 与 alternatives 进输入，正文有实质差异不能判 duplicate", () => {
  const withBody: RelateItem[] = [{
    prop: prop("n1", "final 只显示不拦截", false),
    neighbors: [prop("o1", "final 只显示不拦截", true)],
  }];
  (withBody[0].prop as any).body = "细节：只拦真实问题，误报放行。";
  (withBody[0].prop as any).alternatives = [{ option: "继续硬拦", rejected_because: "拦下的全是误报", evidence: 0 }];
  (withBody[0].neighbors[0] as any).body = "另一套细节：全部放行，不做任何拦截。";
  const m = buildRelateMessages(withBody)[1].content!;
  assert.match(m, /正文：细节：只拦真实问题，误报放行。/);
  assert.match(m, /否掉的方案：继续硬拦（拦下的全是误报）/);
  assert.match(m, /m1: \[rule，已确认\] final 只显示不拦截（正文：另一套细节：全部放行，不做任何拦截。）/);
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

// ---------- applyVerdict：两种并法必须原样保持 ----------

const full = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, text: id, kind: "rule", project_id: "P", confirmed: false, confirmed_by: null, basis: "user_quote",
     source: { host: "codex", session_id: `s-${id}` }, evidence: [{ role: "user", quote_sha256: `q-${id}` }], ...extra }) as unknown as Proposition;
const shape = (r: ReturnType<typeof applyVerdict>) => r.appends.map((a) => [a.kind, a.target_id, (a.body as any).into ?? (a.body as any).target ?? (a.body as any).window_id ?? (a.body as any).by ?? null]);

test("absorb-new（work）：新条并入已有条；证据挂已有条；corroborate 给出就写 confirm，否则不写", () => {
  const p = full("new"), t = full("old");
  const v = { outcome: "duplicate" as const, target: t, reason: "同一件事" };
  const seen: unknown[] = [];
  const yes: MergePolicy = { mode: "absorb-new", corroborate: (np, tt, basis) => (seen.push([np.id, tt.id, basis]), { by: "corroboration", sessions: [] } as any) };
  const r1 = applyVerdict(p, t, v, "m", yes);
  assert.deepEqual(shape(r1), [["relate", "new", "old"], ["evidence", "old", "relate:new"], ["confirm", "old", "corroboration"], ["archive", "new", "old"]]);
  assert.equal(r1.merge, "new-into-target");
  assert.equal(r1.corroborated, true);
  assert.deepEqual(seen, [["new", "old", "user_quote"]]);
  const r2 = applyVerdict(p, t, v, "m", { mode: "absorb-new", corroborate: () => null });
  assert.deepEqual(shape(r2), [["relate", "new", "old"], ["evidence", "old", "relate:new"], ["archive", "new", "old"]]);
  assert.equal(r2.corroborated, false);
  // 即便已有条是用户确认的，absorb-new 也是新条并入已有条（不反向）
  const r3 = applyVerdict(p, full("old", { confirmed: true, confirmed_by: "user" }), v, "m", { mode: "absorb-new", corroborate: () => null });
  assert.equal(r3.merge, "new-into-target");
});

test("user-confirmed-wins（pensieve）：已有条是用户确认的 → 导入条并进去且不动已有条；否则已有条并进导入条", () => {
  const p = full("imp");
  const confirmed = full("old", { confirmed: true, confirmed_by: "user" });
  const r1 = applyVerdict(p, confirmed, { outcome: "duplicate", target: confirmed, reason: "r" }, "m", { mode: "user-confirmed-wins" });
  assert.deepEqual(shape(r1), [["relate", "imp", "old"], ["archive", "imp", "old"]]);
  assert.ok(r1.appends.every((a) => a.target_id !== "old"));
  assert.equal(r1.merge, "new-into-target");
  // 被印证转正（confirmed_by 不是 user）的不算用户确认
  for (const t of [full("old"), full("old", { confirmed: true, confirmed_by: "corroboration" })]) {
    const r = applyVerdict(p, t, { outcome: "duplicate", target: t, reason: "r" }, "m", { mode: "user-confirmed-wins" });
    assert.deepEqual(shape(r), [["relate", "imp", "old"], ["evidence", "imp", "import:old"], ["relate", "old", "imp"], ["archive", "old", "imp"]]);
    assert.equal(r.merge, "target-into-new");
    assert.ok(r.appends.every((a) => a.kind !== "confirm"));
  }
});

test("非 duplicate：两种策略都只写一条 relate，不并、不转正", () => {
  const p = full("n"), t = full("o");
  for (const outcome of ["refines", "conflicts", "unrelated", "unsure"] as const) {
    for (const pol of [{ mode: "user-confirmed-wins" }, { mode: "absorb-new", corroborate: () => { throw new Error("不该调"); } }] as MergePolicy[]) {
      const target = outcome === "refines" || outcome === "conflicts" ? t : null;
      const r = applyVerdict(p, target, { outcome, target, reason: "r" }, "m", pol);
      assert.deepEqual(shape(r), [["relate", "n", target?.id ?? null]]);
      assert.equal(r.merge, null);
    }
  }
});

test("§8.11.3 关系判定输入：正文每条最多 2000 字，超长注明已截断；否掉的方案全给", () => {
  const item: RelateItem[] = [{ prop: prop("n1", "新条目"), neighbors: [prop("o1", "旧条目", true)] }];
  (item[0].prop as any).body = "甲".repeat(3500);
  (item[0].neighbors[0] as any).body = "乙".repeat(RELATE_BODY_MAX_CHARS);
  (item[0].prop as any).alternatives = Array.from({ length: 5 }, (_, i) => ({
    option: `方案 ${i + 1} ${"丙".repeat(150)}`,
    rejected_because: `理由 ${i + 1} ${"丁".repeat(150)}`,
  }));
  const m = buildRelateMessages(item)[1].content!;
  // 2500 字那条被截到 2000 字并注明；正好 2000 字的不注明
  assert.ok(m.includes(`正文：${"甲".repeat(RELATE_BODY_MAX_CHARS)}…（正文已截断）`), "N 的正文截到 2000 字");
  assert.ok(!m.includes("甲".repeat(RELATE_BODY_MAX_CHARS + 1)), "不超过 2000 字");
  assert.ok(m.includes(`正文：${"乙".repeat(RELATE_BODY_MAX_CHARS)}）`), "正好 2000 字不截断、不注明");
  assert.doesNotMatch(m, /乙…/, "正好 2000 字不加省略号、不写已截断");
  // alternatives 全给：第 5 项的尾部也必须在
  for (let i = 1; i <= 5; i++) {
    assert.ok(m.includes(`方案 ${i} `), `第 ${i} 项方案要在`);
    assert.ok(m.includes(`理由 ${i} `), `第 ${i} 项理由要在`);
  }
  assert.ok(m.includes("丁".repeat(150)), "理由不被截短");
  assert.ok(m.includes("丙".repeat(150)), "方案不被截短");
});
