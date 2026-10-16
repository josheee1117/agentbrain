/** brief 直接单测（不起子进程）。运行：node --test src/brief.test.ts */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.ts";
import type { RememberBody } from "./l2.ts";
import { brief, BriefError, BRIEF_MAX_CHARS, SEARCH_HINT } from "./brief.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "ab-brief-")));
const repos = join(dir, "pm/repos");
const alpha = join(dir, "alpha");
const elsewhere = join(dir, "elsewhere");
for (const d of [repos, alpha, elsewhere]) mkdirSync(d, { recursive: true });
writeFileSync(join(repos, "alpha.md"), `- 路径：\`${alpha}\`\n`);
process.env.AB_REGISTRY = repos;

const src: RememberBody["source"] = { host: "pi", session_id: "s", transcript: null, anchor: null, summary: "讨论" };
function seeded(): Store {
  const s = new Store(":memory:", ":memory:");
  const pid = s.ensureProject("alpha");
  s.remember(null, "s", false, { kind: "rule", text: "全局规则 G1", confirmed: true, source: src });
  s.remember(null, "s", false, { kind: "rule", text: "全局未确认 G2", confirmed: false, source: src });
  s.remember(null, "s", false, { kind: "rule", text: "子代理规则 W1", confirmed: true, for_workers: true, source: src });
  s.remember(pid, "s", false, { kind: "pitfall", text: "alpha 坑 P1", confirmed: true, source: src });
  s.remember(pid, "s", false, { kind: "decision", text: "alpha 决定 D1", confirmed: true, source: src });
  return s;
}

test("项目目录：全局规则 + 本项目坑；未确认不列出只计数；决定只给数量", () => {
  const out = brief(seeded(), alpha, undefined, false);
  assert.match(out, /^<agentbrain project="alpha">/);
  assert.match(out, /全局规则 G1/);
  assert.match(out, /alpha 坑 P1/);
  assert.doesNotMatch(out, /G2|alpha 决定 D1/);
  assert.match(out, /决定 1 条、事实 0 条/);
  assert.match(out, /另有 1 条 agent 自记未确认/);
});

test("未登记目录只给全局；--worker 只给 for_workers 全局规则，不提示写记忆", () => {
  const s = seeded();
  const un = brief(s, elsewhere, undefined, false);
  assert.match(un, /scope="unregistered"/);
  assert.doesNotMatch(un, /P1/);
  const w = brief(s, alpha, undefined, true);
  assert.match(w, /worker>/);
  assert.match(w, /W1/);
  assert.doesNotMatch(w, /G1/);
  assert.match(w, /不写记忆/);
});

test("用法错误抛 BriefError（CLI 负责打印退出）", () => {
  assert.throws(() => brief(seeded(), alpha, "nope", false), (e) => e instanceof BriefError && /清单里没有项目: nope/.test(e.message));
  assert.throws(() => brief(seeded(), elsewhere, undefined, true), BriefError);
});

test("超出预算：整条跳过并提示 ab search，总长不超上限", () => {
  const s = seeded();
  const pid = s.ensureProject("alpha");
  for (let i = 0; i < 80; i++) s.remember(pid, "s", false, { kind: "rule", text: `规则 ${i} ${"x".repeat(60)}`, confirmed: true, source: src });
  const out = brief(s, alpha, undefined, false);
  assert.ok(out.length <= BRIEF_MAX_CHARS);
  assert.match(out, /还有 \d+ 条放不下，用 ab search 查。/);
  assert.ok(out.endsWith("</agentbrain>\n"));
});

test("§11.5 (i)：主会话和子代理的 brief 都点出该先 ab search 的几类情况；条目超预算时先截条目，这行不截", () => {
  const s = seeded();
  const pid = s.ensureProject("alpha");
  for (const kind of ["main", "worker"] as const) {
    const out = brief(seeded(), alpha, undefined, kind === "worker");
    assert.ok(out.includes(SEARCH_HINT), kind);
    assert.match(out, /用户提到"上次\/之前\/我们定过"；要改不熟悉的模块或配置；报错看不出原因；要做设计取舍。看一条的来龙去脉用 ab get。/);
  }
  for (let i = 0; i < 80; i++) s.remember(pid, "s", false, { kind: "pitfall", text: `alpha 很长的坑 ${i} ${"细节".repeat(20)}`, confirmed: true, source: src });
  const full = brief(s, alpha, undefined, false);
  assert.ok(full.length <= BRIEF_MAX_CHARS);
  assert.match(full, /还有 \d+ 条放不下/);
  assert.ok(full.includes(SEARCH_HINT), "超预算时提示行仍在");
});
