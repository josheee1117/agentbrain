/** recall 直接单测（不起子进程，只走全文检索）。运行：node --test src/recall.test.ts */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, type Embedder } from "./store.ts";
import type { RememberBody } from "./l2.ts";
import { recall, RECALL_MAX_CHARS } from "./recall.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "ab-recall-")));
const repos = join(dir, "pm/repos");
const alpha = join(dir, "alpha");
const elsewhere = join(dir, "elsewhere");
for (const d of [repos, alpha, elsewhere]) mkdirSync(d, { recursive: true });
writeFileSync(join(repos, "alpha.md"), `- 路径：\`${alpha}\`\n`);
process.env.AB_REGISTRY = repos;

const src: RememberBody["source"] = { host: "pi", session_id: "s", transcript: null, anchor: null, summary: "讨论" };
const noEmbed = () => null;

function seeded(): Store {
  const s = new Store(":memory:", ":memory:");
  const pid = s.ensureProject("alpha");
  s.remember(pid, "s", false, { kind: "pitfall", text: "lockfile pitfall in alpha", confirmed: true, source: src });
  s.remember(pid, "s", false, { kind: "pitfall", text: "lockfile unconfirmed guess", confirmed: false, source: src });
  s.remember(pid, "s", false, { kind: "note", text: "lockfile fact note", confirmed: true, source: src });
  s.remember(null, "s", false, { kind: "rule", text: "lockfile global plain", confirmed: true, source: src });
  s.remember(null, "s", false, { kind: "rule", text: "lockfile global for workers", confirmed: true, for_workers: true, source: src });
  return s;
}

test("短提示词、斜杠命令直接跳过，且不去取 embedder", async () => {
  let called = 0;
  const get = () => (called++, null);
  assert.equal(await recall(seeded(), "abc", alpha, get), "");
  assert.equal(await recall(seeded(), "/compact now", alpha, get), "");
  assert.equal(called, 0);
});

test("项目内：已确认坑 + for_workers 全局；排除未确认推断、事实、未标 for_workers 的全局", async () => {
  const out = await recall(seeded(), "lockfile", alpha, noEmbed);
  assert.match(out, /^<agentbrain-recall>\n/);
  assert.match(out, /坑: lockfile pitfall in alpha/);
  assert.match(out, /规则: lockfile global for workers/);
  assert.doesNotMatch(out, /unconfirmed guess|fact note|global plain/);
});

test("未登记目录只召回 for_workers 全局；没命中返回空串", async () => {
  const out = await recall(seeded(), "lockfile", elsewhere, noEmbed);
  assert.doesNotMatch(out, /pitfall in alpha/);
  assert.match(out, /for workers/);
  assert.equal(await recall(seeded(), "nothingmatcheshere", alpha, noEmbed), "");
});

test("总长不超 RECALL_MAX_CHARS，最多 3 条", async () => {
  const s = new Store(":memory:", ":memory:");
  const pid = s.ensureProject("alpha");
  for (let i = 0; i < 6; i++) s.remember(pid, "s", false, { kind: "pitfall", text: `lockfile ${i} ${"y".repeat(300)}`, confirmed: true, source: src });
  const out = await recall(s, "lockfile", alpha, noEmbed);
  assert.ok(out.length <= RECALL_MAX_CHARS, String(out.length));
  assert.ok(out.split("\n").filter((l) => l.startsWith("- [")).length <= 3);
});

/** 假向量：正文含 HOT 标记的与查询同向（相似度 1），其余正交（0，只能靠全文检索命中）。 */
function hotEmbedder(): Embedder {
  return Object.assign(async (texts: string[]) => texts.map((t) => Float32Array.from(/HOT|^lockfile$|^deploy$/.test(t) ? [1, 0] : [0, 1])), { model: "fake" });
}
async function withVectors(s: Store): Promise<() => Embedder> {
  const e = hotEmbedder();
  await s.syncVectors(e, "fake");
  return () => e;
}

test("用户纠正有保底位：向量相关的已确认纠正排第一、标出替代谁，不被 3 条已确认挤掉；被替代的旧条不出", async () => {
  const s = new Store(":memory:", ":memory:");
  const pid = s.ensureProject("alpha");
  const old = s.remember(pid, "s", false, { kind: "note", text: "lockfile lives in root", confirmed: true, source: src });
  for (let i = 0; i < 4; i++) s.remember(pid, "s", false, { kind: "pitfall", text: `lockfile lockfile pitfall ${i}`, confirmed: true, source: src });
  const fix = s.remember(pid, "s", false, { kind: "note", text: "lockfile actually lives in packages/app HOT, root copy is stale", confirmed: true, supersedes: old, source: src });
  const out = await recall(s, "lockfile", alpha, await withVectors(s));
  const rows = out.split("\n").filter((l) => l.startsWith("- ["));
  assert.equal(rows.length, 3);
  assert.match(rows[0], new RegExp(`^- \\[${fix.slice(0, 8)}\\] 事实（纠正，替代 \\[${old.slice(0, 8)}\\]）: lockfile actually`));
  assert.doesNotMatch(out, /lives in root/);
});

test("只有全文检索命中、向量不相关的纠正不占保底位（评估反例：worker 日志问题把弱相关纠正顶到第一）", async () => {
  const s = new Store(":memory:", ":memory:");
  const pid = s.ensureProject("alpha");
  const old = s.remember(pid, "s", false, { kind: "rule", text: "lockfile rule old", confirmed: true, source: src });
  s.remember(pid, "s", false, { kind: "rule", text: "lockfile weakly related correction", confirmed: true, supersedes: old, source: src });
  const top = s.remember(pid, "s", false, { kind: "pitfall", text: "lockfile HOT pitfall", confirmed: true, source: src });
  const out = await recall(s, "lockfile", alpha, await withVectors(s));
  assert.doesNotMatch(out, /纠正，替代/);
  assert.match(out.split("\n").filter((l) => l.startsWith("- ["))[0], new RegExp(top.slice(0, 8)));
  // 没有 embedder（降级为纯全文检索）时也不给保底位
  assert.doesNotMatch(await recall(s, "lockfile", alpha, noEmbed), /纠正，替代/);
});

test("自己有待确认更正或冲突的纠正不占保底位（评估反例 ab0ea66d / d01b442c）", async () => {
  const s = new Store(":memory:", ":memory:");
  const pid = s.ensureProject("alpha");
  const old = s.remember(pid, "s", false, { kind: "rule", text: "lockfile old rule", confirmed: true, source: src });
  const fix = s.remember(pid, "s", false, { kind: "rule", text: "lockfile corrected rule HOT", confirmed: true, supersedes: old, source: src });
  s.remember(pid, "s", false, { kind: "rule", text: "lockfile re-correction pending", confirmed: false, supersedes: fix, source: src });
  const out = await recall(s, "lockfile", alpha, await withVectors(s));
  assert.doesNotMatch(out, /纠正，替代/);
  assert.match(out, /有待确认的纠正/);
});

test("纠正保底不破坏 D3：纠正 + 1 条已确认时，agent 自记的未确认规则仍不进", async () => {
  const s = new Store(":memory:", ":memory:");
  const pid = s.ensureProject("alpha");
  const old = s.remember(pid, "s", false, { kind: "rule", text: "deploy on friday", confirmed: true, source: src });
  s.remember(pid, "s", false, { kind: "rule", text: "deploy never on friday HOT", confirmed: true, supersedes: old, source: src });
  s.remember(pid, "s", false, { kind: "pitfall", text: "deploy script needs VPN", confirmed: true, source: src });
  const id = s.remember(pid, "s", false, { kind: "rule", text: "deploy notes go to channel", confirmed: false, source: src });
  const out = await recall(s, "deploy", alpha, await withVectors(s));
  const rows = out.split("\n").filter((l) => l.startsWith("- ["));
  assert.match(rows[0], /纠正/);
  assert.ok(!out.includes(id.slice(0, 8)));
  assert.equal(rows.length, 2);
});

test("shown 收集实际输出的条目 id（到期复审记最近注入用）", async () => {
  const s = seeded();
  const shown: string[] = [];
  const out = await recall(s, "lockfile", alpha, noEmbed, shown);
  assert.ok(shown.length >= 2);
  for (const id of shown) assert.ok(out.includes(`[${id.slice(0, 8)}]`));
});
