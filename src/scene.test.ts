/** 场景目录（L3 派生索引）单测。运行：node --test src/scene.test.ts */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, type Embedder } from "./store.ts";
import type { RememberBody } from "./l2.ts";
import type { Chat } from "./llm.ts";
import { brief, BRIEF_MAX_CHARS, sceneDirectory } from "./brief.ts";
import { buildScenes, cleanTitle, groupScenes, resolveScenes, sceneRebuildReason, SCENE_MIN_ENTRIES, SCENE_PROMPT_VERSION } from "./scene.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "ab-scene-")));
const repos = join(dir, "pm/repos");
const alpha = join(dir, "alpha");
for (const d of [repos, alpha]) mkdirSync(d, { recursive: true });
writeFileSync(join(repos, "alpha.md"), `- 路径：\`${alpha}\`\n`);
process.env.AB_REGISTRY = repos;

const src: RememberBody["source"] = { host: "pi", session_id: "s", transcript: null, anchor: null, summary: "讨论" };
/** 按关键词给方向：编译 / 导出 / 其他，各自带一点按长度的扰动。 */
const fakeEmbed: Embedder = Object.assign(async (texts: string[]) =>
  texts.map((t) => {
    const e = t.length % 7 / 100;
    if (t.includes("编译")) return Float32Array.from([1, e, 0]);
    if (t.includes("导出")) return Float32Array.from([e, 1, 0]);
    return Float32Array.from([0, e, 1]);
  }), { model: "fake" });

function fakeChat(titles: Record<string, string>, calls: string[] = []): { chat: Chat; model: string } {
  return {
    model: "fake-model",
    chat: async (messages) => {
      calls.push(String(messages[1].content));
      return { message: { role: "assistant", content: JSON.stringify({ titles }) }, tokens: 10 };
    },
  };
}

async function seeded(): Promise<{ s: Store; pid: string; ids: string[] }> {
  const s = new Store(":memory:", ":memory:");
  const pid = s.ensureProject("alpha");
  const ids: string[] = [];
  for (let i = 0; i < 8; i++) ids.push(s.remember(pid, "s", false, { kind: "pitfall", text: `编译坑 ${i}${"x".repeat(i)}`, confirmed: true, source: src, trigger: "当本地编译时" }));
  for (let i = 0; i < 8; i++) ids.push(s.remember(pid, "s", false, { kind: "decision", text: `导出决定 ${i}${"y".repeat(i)}`, confirmed: true, source: src }));
  ids.push(s.remember(pid, "s", false, { kind: "note", text: "孤立事实", confirmed: true, source: src }));
  await s.syncVectors(fakeEmbed, "fake");
  return { s, pid, ids };
}

test("groupScenes：确定性；相似的合成一组，孤立的不成组", () => {
  const v = (a: number, b: number) => Float32Array.from([a, b]);
  const items = [
    { id: "c", vec: v(1, 0.05), scenario: null },
    { id: "a", vec: v(1, 0), scenario: null },
    { id: "b", vec: v(1, 0.1), scenario: null },
    { id: "d", vec: v(0, 1), scenario: null },
  ];
  const g1 = groupScenes(items, { linkMin: 0.9, minSize: 2 });
  const g2 = groupScenes([...items].reverse(), { linkMin: 0.9, minSize: 2 });
  assert.deepEqual(g1, [["a", "b", "c"]]);
  assert.deepEqual(g2, g1);
  assert.deepEqual(groupScenes(items, { linkMin: 0.9, minSize: 2, maxSize: 2 }).map((g) => g.length), [2]);
});

test("场景描述（当…时）重叠会加分，把向量稍远的拉进同组", () => {
  const items = [
    { id: "a", vec: Float32Array.from([1, 0]), scenario: "当本地编译 data-asset 时" },
    { id: "b", vec: Float32Array.from([0.7, 0.71]), scenario: "当本地编译 data-asset 时" },
  ];
  assert.equal(groupScenes(items, { linkMin: 0.75, minSize: 2, scenarioWeight: 0 }).length, 0);
  assert.equal(groupScenes(items, { linkMin: 0.75, minSize: 2, scenarioWeight: 0.15 }).length, 1);
});

test("buildScenes：只写 L3（不新增 L1 事件），记模型与提示词版本；标题不合格的组不进目录", async () => {
  const { s, pid } = await seeded();
  assert.ok(16 >= SCENE_MIN_ENTRIES);
  const seq = s.watermark();
  const calls: string[] = [];
  const r = await buildScenes({ store: s, chat: fakeChat({ g1: "本地编译", g2: "其他" }, calls), now: () => new Date("2026-10-15T00:00:00Z") }, pid);
  assert.equal(r.status, "built");
  assert.equal(s.watermark(), seq, "不写 L1");
  const set = s.readScenes(pid)!;
  assert.equal(set.model, "fake-model");
  assert.equal(set.prompt_version, SCENE_PROMPT_VERSION);
  assert.equal(set.scenes.length, 1, "“其他”这种空泛标题被丢弃");
  assert.equal(set.scenes[0].title, "本地编译");
  assert.equal(set.scenes[0].members.length, 8);
  assert.match(calls[0], /当本地编译时：编译坑/);
});

test("没有模型或条目太少时跳过，不写 L3", async () => {
  const { s, pid } = await seeded();
  assert.deepEqual(await buildScenes({ store: s, chat: null, now: () => new Date() }, pid), { status: "skipped", reason: "no_model" });
  assert.equal(s.readScenes(pid), null);
  const small = new Store(":memory:", ":memory:");
  const p2 = small.ensureProject("alpha");
  small.remember(p2, "s", false, { kind: "pitfall", text: "编译坑", confirmed: true, source: src });
  assert.deepEqual(await buildScenes({ store: small, chat: fakeChat({}), now: () => new Date() }, p2), { status: "skipped", reason: "too_few" });
});

test("成员跟着纠正与归档走；新条目进未归组；变化够多才提示重建", async () => {
  const { s, pid, ids } = await seeded();
  await buildScenes({ store: s, chat: fakeChat({ g1: "本地编译", g2: "指标导出" }), now: () => new Date("2026-10-15T00:00:00Z") }, pid);
  const now = new Date("2026-10-16T00:00:00Z");
  assert.equal(sceneRebuildReason(s, pid, now), null);
  const compile = resolveScenes(s, pid)!.scenes.find((x) => x.title === "本地编译")!;
  const oldId = compile.members[0].id;
  const fixed = s.remember(pid, "s", false, { kind: "pitfall", text: "编译坑（纠正后）", confirmed: true, source: src, supersedes: oldId });
  s.lifecycle("archive", compile.members[1].id, "s");
  const r = resolveScenes(s, pid)!;
  const after = r.scenes.find((x) => x.title === "本地编译")!;
  assert.ok(after.members.some((p) => p.id === fixed), "纠正后的条目替代旧成员");
  assert.ok(!after.members.some((p) => p.id === oldId));
  assert.equal(after.members.length, 7, "归档的掉出");
  assert.equal(r.dropped, 2);
  assert.ok(r.unassigned.some((p) => p.text === "孤立事实"));
  for (let i = 0; i < 4; i++) s.remember(pid, "s", false, { kind: "note", text: `新事实 ${i}`, confirmed: true, source: src });
  assert.equal(sceneRebuildReason(s, pid, now), "changed");
  assert.ok(ids.length > 0);
});

test("brief：有场景目录时列标题与条数，不放成员正文；总长不超上限；没建过退回原提示", async () => {
  const { s, pid } = await seeded();
  const before = brief(s, alpha, undefined, false);
  assert.match(before, /决定 8 条、事实 1 条/);
  assert.equal(sceneDirectory(s, pid), null);
  await buildScenes({ store: s, chat: fakeChat({ g1: "本地编译", g2: "指标导出" }), now: () => new Date() }, pid);
  const out = brief(s, alpha, undefined, false);
  assert.match(out, /本项目记忆按场景分组/);
  assert.match(out, /\] 指标导出（8 条）/);
  assert.doesNotMatch(out, /导出决定 0/, "目录不放成员正文");
  assert.match(out, /未归组 1 条/);
  assert.ok(out.length <= BRIEF_MAX_CHARS);
  assert.doesNotMatch(brief(s, alpha, undefined, true), /场景/, "--worker 不带目录");
});

test("cleanTitle：去换行、截长、拒绝空泛词", () => {
  assert.equal(cleanTitle("其他"), null);
  assert.equal(cleanTitle(42), null);
  assert.equal(cleanTitle("「本地\n编译」"), "本地 编译");
  assert.equal(cleanTitle("很".repeat(40))!.length, 24);
});
