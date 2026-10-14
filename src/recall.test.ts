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

/** 假向量：正文含 HOT 标记的与查询同向（相似度 1），含 WARM 的高度相关（0.95），其余正交（0，只能靠字面命中）。 */
function hotEmbedder(): Embedder {
  return Object.assign(async (texts: string[]) => texts.map((t) => Float32Array.from(/HOT|^lockfile$|^deploy$/.test(t) ? [1, 0] : /WARM/.test(t) ? [0.95, Math.sqrt(1 - 0.95 ** 2)] : [0, 1])), { model: "fake" });
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
  for (let i = 0; i < 4; i++) s.remember(pid, "s", false, { kind: "pitfall", text: `lockfile lockfile pitfall ${i} WARM`, confirmed: true, source: src });
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
  s.remember(pid, "s", false, { kind: "pitfall", text: "deploy script needs VPN WARM", confirmed: true, source: src });
  const id = s.remember(pid, "s", false, { kind: "rule", text: "deploy notes go to channel WARM", confirmed: false, source: src });
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

test("用前核对：代码引文还在照常输出；文件删了或片段没了标可能过时并收集 id", async () => {
  const { citationsStale } = await import("./citecheck.ts");
  const { rmSync } = await import("node:fs");
  writeFileSync(join(alpha, "lock.ts"), "// header\nexport const LOCK = 'pnpm-lock.yaml';\n");
  const s = new Store(":memory:", ":memory:");
  const pid = s.ensureProject("alpha");
  const id = s.remember(pid, "s", false, { kind: "pitfall", text: "lockfile citation pitfall", confirmed: false, source: src });
  const refs = [{ path: "lock.ts", line_start: 2, line_end: 2, quote: "export const LOCK = 'pnpm-lock.yaml';" }];
  s.commit([{ kind: "verify", project_id: pid, session_id: null, target_id: id, body: { outcome: "verified", head: "h", refs, model: "m" } }], () => {});
  const stale: string[] = [];
  let out = await recall(s, "lockfile", alpha, noEmbed, [], stale);
  assert.match(out, /坑: lockfile citation pitfall/);
  assert.deepEqual(stale, []);
  writeFileSync(join(alpha, "lock.ts"), "// moved\n\n\nexport const LOCK = 'pnpm-lock.yaml';\n");
  assert.equal(citationsStale(alpha, refs, performance.now() + 50), false, "行号漂移不算过时");
  writeFileSync(join(alpha, "lock.ts"), "export const LOCK = 'bun.lockb';\n");
  out = await recall(s, "lockfile", alpha, noEmbed, [], stale);
  assert.match(out, /坑（可能过时）: lockfile citation pitfall/);
  assert.deepEqual(stale, [id]);
  rmSync(join(alpha, "lock.ts"));
  assert.equal(citationsStale(alpha, refs, performance.now() + 50), true, "文件没了");
  assert.equal(citationsStale(alpha, refs, performance.now() - 1), false, "超预算放行");
  assert.equal(citationsStale(join(dir, "nope"), refs, performance.now() + 50), false, "仓库不在放行");
  s.queueReverify([id, id], new Date());
  assert.equal((s.workDb.prepare("SELECT count(*) n FROM verify_queue").get() as { n: number }).n, 1);
});

// ---- 召回准确度（2026-10-14 recall-eval 评测暴露的根因各补一条）----

test("中文提示词不带空格也能字面命中（旧 FTS 把整句当一个词 MATCH，永远不中）", async () => {
  const s = new Store(":memory:", ":memory:");
  const pid = s.ensureProject("alpha");
  s.remember(pid, "s", false, { kind: "pitfall", text: "本地编译 alpha 要用 JDK 11，默认 JDK 17 会编译失败", confirmed: true, source: src });
  s.remember(pid, "s", false, { kind: "pitfall", text: "发布前先跑架构守卫", confirmed: true, source: src });
  const out = await recall(s, "本地编译用JDK", alpha, noEmbed);
  assert.match(out, /JDK 11/);
  assert.doesNotMatch(out, /架构守卫/);
});

test("短词不再退回不排序的 LIKE：闲聊/无关英文不注入任何东西", async () => {
  const s = new Store(":memory:", ":memory:");
  const pid = s.ensureProject("alpha");
  s.remember(pid, "s", false, { kind: "pitfall", text: "a lockfile is in the root, 1 copy only", confirmed: true, source: src });
  assert.equal(await recall(s, "explain what a monad is in haskell", alpha, noEmbed), "");
  assert.equal(await recall(s, "结束了没，为什么都 1 个小时了", alpha, noEmbed), "");
});

test("资格过滤在截取前：大量不合格的高相似条目（归档、他项目、未标 for_workers 的全局）挤不掉合格的那条", async () => {
  const s = new Store(":memory:", ":memory:");
  const pid = s.ensureProject("alpha");
  const other = s.ensureProject("beta");
  for (let i = 0; i < 30; i++) {
    s.remember(other, "s", false, { kind: "pitfall", text: `lockfile HOT other ${i}`, confirmed: true, source: src });
    s.remember(null, "s", false, { kind: "pitfall", text: `lockfile HOT global ${i}`, confirmed: true, source: src });
  }
  const mine = s.remember(pid, "s", false, { kind: "pitfall", text: "lockfile WARM mine", confirmed: true, source: src });
  const out = await recall(s, "lockfile", alpha, await withVectors(s));
  assert.match(out, new RegExp(mine.slice(0, 8)));
  assert.doesNotMatch(out, /other|global/);
});

test("向量可用时，只靠字面沾边、向量不相关的已确认条目不进；最相关的用户原话未确认规则可占第 3 位但排在已确认之后", async () => {
  const s = new Store(":memory:", ":memory:");
  const pid = s.ensureProject("alpha");
  for (let i = 0; i < 3; i++) s.remember(pid, "s", false, { kind: "pitfall", text: `deploy unrelated note ${i}`, confirmed: true, source: src });
  const conf = s.remember(pid, "s", false, { kind: "pitfall", text: "deploy WARM needs VPN", confirmed: true, source: src });
  const said = s.remember(pid, "s", false, { kind: "rule", text: "deploy HOT only on weekdays", confirmed: false, origin: "extract", basis: "user_directive", evidence: [{ anchor: "u1", role: "user", quote_sha256: "x" }], source: src });
  const agent = s.remember(pid, "s", false, { kind: "pitfall", text: "deploy HOT agent guess", confirmed: false, origin: "extract", basis: "agent_inferred" as never, evidence: [{ anchor: "a1", role: "assistant", quote_sha256: "x" }], source: src });
  const rows = (await recall(s, "deploy", alpha, await withVectors(s))).split("\n").filter((l) => l.startsWith("- ["));
  assert.equal(rows.length, 2, rows.join("\n"));
  assert.match(rows[0]!, new RegExp(conf.slice(0, 8)));
  assert.match(rows[1]!, new RegExp(`${said.slice(0, 8)}\\] 规则（未确认）`));
  assert.ok(!rows.join("\n").includes(agent.slice(0, 8)), "agent 推断的未确认坑仍不进（D3）");
});

test("向量调用失败时 fail-open 到字面通道（更严的门槛），不抛异常", async () => {
  const s = seeded();
  const broken = Object.assign(async () => { throw new Error("timeout"); }, { model: "fake" }) as Embedder;
  const out = await recall(s, "lockfile", alpha, () => broken);
  assert.match(out, /lockfile pitfall in alpha/);
  assert.equal(await recall(s, "something else entirely", alpha, () => broken), "");
});

test("lexTokens：中文按二字切、英文去虚词、标识符拆开", async () => {
  const { lexTokens } = await import("./lexical.ts");
  const t = lexTokens("发布到 dev_jdk17 吧 how is it");
  for (const w of ["发布", "布到", "dev_jdk17", "jdk17", "dev"]) assert.ok(t.has(w), w);
  for (const w of ["how", "is", "it"]) assert.ok(!t.has(w), w);
});

test("向量可用但某条还没向量（刚写入、未同步）：这条退回字面通道照样能召回，不被永久漏掉", async () => {
  const s = new Store(":memory:", ":memory:");
  const pid = s.ensureProject("alpha");
  s.remember(pid, "s", false, { kind: "pitfall", text: "deploy unrelated note", confirmed: true, source: src });
  const get = await withVectors(s);
  const fresh = s.remember(pid, "s", false, { kind: "pitfall", text: "本地编译 alpha 要用 JDK 11", confirmed: true, source: src });
  const out = await recall(s, "本地编译用JDK", alpha, get);
  assert.match(out, new RegExp(fresh.slice(0, 8)));
});
