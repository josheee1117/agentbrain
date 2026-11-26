/** brief 直接单测（不起子进程）。运行：node --test src/brief.test.ts */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.ts";
import type { RememberBody } from "./l2.ts";
import { brief, BriefError, BRIEF_MAX_CHARS, SEARCH_HINT, conflictReminder, expiryReminder } from "./brief.ts";

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

test("§8.13.7：brief 末尾报范围内冲突对数与最老天数；无冲突、或冲突只在外项目时不报", () => {
  const s = seeded();
  const pid = s.ensureProject("alpha");
  const otherPid = s.ensureProject("other");
  // 没冲突：什么都不报
  assert.equal(conflictReminder(s, "alpha"), null);
  assert.doesNotMatch(brief(s, alpha, undefined, false), /冲突 \d+ 对未解决/);
  // 全局一对冲突：在 alpha 项目、未登记目录、worker 视图都报
  const g1 = s.remember(null, "s", false, { kind: "rule", text: "全局 G 甲", confirmed: true, source: src });
  s.remember(null, "s", false, { kind: "rule", text: "全局 G 乙", confirmed: false, source: src, relation: { type: "conflicts", target: g1 } });
  assert.match(conflictReminder(s, "alpha")!, /冲突 1 对未解决（最老 \d+ 天）/);
  assert.match(brief(s, alpha, undefined, false), /冲突 1 对未解决（最老 \d+ 天）：ab get 看双方，ab archive 错的一条；ab inbox --kind conflict 看清单。/);
  assert.match(brief(s, elsewhere, undefined, false), /冲突 1 对未解决/);
  assert.match(brief(s, alpha, undefined, true), /冲突 1 对未解决/);
  // alpha 项目内再添一对：alpha 看到 2 对，未登记目录仍只看全局的 1 对
  const a1 = s.remember(pid, "s", false, { kind: "pitfall", text: "alpha 甲", confirmed: true, source: src });
  s.remember(pid, "s", false, { kind: "pitfall", text: "alpha 乙", confirmed: false, source: src, relation: { type: "conflicts", target: a1 } });
  assert.match(conflictReminder(s, "alpha")!, /冲突 2 对未解决/);
  assert.match(conflictReminder(s, undefined)!, /冲突 1 对未解决/);
  // other 项目内的冲突不进 alpha 的范围
  const o1 = s.remember(otherPid, "s", false, { kind: "rule", text: "other 甲", confirmed: true, source: src });
  s.remember(otherPid, "s", false, { kind: "rule", text: "other 乙", confirmed: false, source: src, relation: { type: "conflicts", target: o1 } });
  assert.match(conflictReminder(s, "alpha")!, /冲突 2 对未解决/);
  assert.match(conflictReminder(s, "other")!, /冲突 2 对未解决/);
});

test("§8.14：brief 末尾报范围内到期未复审条数与最老超期天数；无到期、或只在外项目时不报", () => {
  const s = seeded();
  const pid = s.ensureProject("alpha");
  const otherPid = s.ensureProject("other");
  // 没到期：什么都不报
  assert.equal(expiryReminder(s, "alpha"), null);
  assert.doesNotMatch(brief(s, alpha, undefined, false), /到期未复审/);
  // 造一条到期条目：直接改 ts 和 said_at 到 200 天前（坑有效期 90 天）
  const old = s.remember(pid, "s", false, { kind: "pitfall", text: "alpha 老坑", confirmed: false, source: src });
  const oldTs = new Date(Date.now() - 200 * 86_400_000).toISOString();
  (s as unknown as { db: { prepare: (q: string) => { run: (...a: unknown[]) => void } } }).db.prepare("UPDATE events SET ts=? WHERE id=?").run(oldTs, old);
  // 重投影后 alpha 看到 1 条，未登记目录看不到（不是全局）
  assert.match(expiryReminder(s, "alpha")!, /到期未复审 1 条（最老超期 \d+ 天）/);
  assert.equal(expiryReminder(s, undefined), null);
  // other 项目内造一条到期的，不进 alpha 范围
  const otherOld = s.remember(otherPid, "s", false, { kind: "pitfall", text: "other 老坑", confirmed: false, source: src });
  (s as unknown as { db: { prepare: (q: string) => { run: (...a: unknown[]) => void } } }).db.prepare("UPDATE events SET ts=? WHERE id=?").run(oldTs, otherOld);
  assert.match(expiryReminder(s, "alpha")!, /到期未复审 1 条/);
  assert.match(expiryReminder(s, "other")!, /到期未复审 1 条/);
  // 完整 brief 输出里有这行，格式对
  assert.match(brief(s, alpha, undefined, false), /到期未复审 1 条（最老超期 \d+ 天）：ab review 看清单，ab confirm 留用，ab review --archive 归档。/);
});

test("§8.13.7：条目超预算时先截条目，冲突提醒行仍在且完整", () => {
  const s = seeded();
  const pid = s.ensureProject("alpha");
  const g = s.remember(null, "s", false, { kind: "rule", text: "全局冲突甲", confirmed: true, source: src });
  s.remember(null, "s", false, { kind: "rule", text: "全局冲突乙", confirmed: false, source: src, relation: { type: "conflicts", target: g } });
  for (let i = 0; i < 80; i++) s.remember(pid, "s", false, { kind: "pitfall", text: `alpha 很长的坑 ${i} ${"细节".repeat(20)}`, confirmed: true, source: src });
  const out = brief(s, alpha, undefined, false);
  assert.ok(out.length <= BRIEF_MAX_CHARS);
  assert.match(out, /还有 \d+ 条放不下/);
  assert.match(out, /冲突 1 对未解决（最老 \d+ 天）：ab get 看双方，ab archive 错的一条；ab inbox --kind conflict 看清单。/);
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

// ---------- §12.6.7 T1 / T7 ----------

test("§12.6.7 T1：代码核验转正的坑在 brief 里标出来，用户确认的不标；有这类条目才多一行说明", () => {
  const s = seeded();
  const plain = brief(s, alpha, undefined, false);
  assert.doesNotMatch(plain, /代码核验/, "全是用户确认的：不多说明行");
  const pid = s.ensureProject("alpha");
  const auto = s.remember(pid, "s2", false, { kind: "pitfall", text: "alpha 坑 P2 模型抽取的", confirmed: false, origin: "extract", source: src });
  assert.doesNotMatch(brief(s, alpha, undefined, false), /P2/, "未确认的不进 brief（门槛不变）");
  s.commit([{ kind: "verify", project_id: pid, session_id: null, target_id: auto, body: { outcome: "verified", head: "abc", refs: [], model: "m" } }], () => {});
  const out = brief(s, alpha, undefined, false);
  assert.match(out, /^- \[[0-9a-f]{8}\] alpha 坑 P2 模型抽取的（代码核验）$/m);
  assert.match(out, /^- \[[0-9a-f]{8}\] alpha 坑 P1$/m, "用户确认的照旧不带标注");
  assert.match(out, /^没标注的条目是用户确认过的；标（代码核验）的由模型核对代码后转正，没有人确认过。$/m);
  assert.ok(out.length <= BRIEF_MAX_CHARS);
});

test("§12.6.7 T7：未确认提示写明用户明确认可才能确认", () => {
  const out = brief(seeded(), alpha, undefined, false);
  assert.match(out, /另有 1 条 agent 自记未确认（ab search 可见）。用户明确说认可才执行 ab confirm <id>，不要自己确认。/);
});

test("§12.6.7 T1：条目很多时说明行和标注都算进预算，总长不超上限", () => {
  const s = new Store(":memory:", ":memory:");
  const pid = s.ensureProject("alpha");
  for (let i = 0; i < 80; i++) {
    const id = s.remember(pid, "s", false, { kind: "pitfall", text: `坑 ${i} ${"很长的一句说明".repeat(8)}`, confirmed: false, origin: "extract", source: src });
    s.commit([{ kind: "verify", project_id: pid, session_id: null, target_id: id, body: { outcome: "verified", head: "abc", refs: [], model: "m" } }], () => {});
  }
  const out = brief(s, alpha, undefined, false);
  assert.ok(out.length <= BRIEF_MAX_CHARS, `brief ${out.length} 字`);
  assert.match(out, /^没标注的条目是用户确认过的/m);
  assert.match(out, /（代码核验）$/m);
  assert.match(out, /还有 \d+ 条放不下/);
});
