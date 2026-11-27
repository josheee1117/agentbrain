/** 场景标签（设计 §11.10）：投影与 brief。运行：node --test src/scene.test.ts */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.ts";
import type { RememberBody } from "./l2.ts";
import { brief, BRIEF_MAX_CHARS, BRIEF_SCENE_MAX_CHARS, SEARCH_HINT } from "./brief.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "ab-scene-")));
const repos = join(dir, "pm/repos");
const alpha = join(dir, "alpha");
const beta = join(dir, "beta");
const pm = join(dir, "pm");
const nowhere = join(dir, "nowhere");
for (const d of [repos, alpha, beta, pm, nowhere]) mkdirSync(d, { recursive: true });
writeFileSync(join(repos, "alpha.md"), `- 路径：\`${alpha}\`\n`);
writeFileSync(join(repos, "beta.md"), `- 路径：\`${beta}\`\n`);
process.env.AB_REGISTRY = repos;

const src: RememberBody["source"] = { host: "pi", session_id: "s", transcript: null, anchor: null, summary: "讨论" };

test("投影：remember 带 scenes；tag 整组替换；没给字段不动；[] 清空；旧数据缺省 []", () => {
  const s = new Store(":memory:", ":memory:");
  try {
    const id = s.remember(null, "s", false, { kind: "rule", text: "规则", confirmed: true, scenes: ["design", "code"], source: src });
    assert.deepEqual(s.project().props.get(id)!.scenes, ["design", "code"]);
    s.lifecycle("tag", id, null, { guidance: false }); // 没给 scenes：不动
    assert.deepEqual(s.project().props.get(id)!.scenes, ["design", "code"]);
    const guid = s.remember(null, "s", false, { kind: "rule", text: "偏好", confirmed: true, guidance: true, source: src });
    s.lifecycle("tag", guid, null, { scenes: [] }); // 只写 scenes：guidance 不动
    assert.equal(s.project().props.get(guid)!.guidance, true);
    s.lifecycle("tag", id, null, { scenes: ["review"] }); // 整组替换
    assert.deepEqual(s.project().props.get(id)!.scenes, ["review"]);
    s.lifecycle("tag", id, null, { scenes: [] }); // [] 才清空
    assert.deepEqual(s.project().props.get(id)!.scenes, []);
    const old = s.remember(null, "s", false, { kind: "rule", text: "旧数据", confirmed: true, source: src });
    assert.deepEqual(s.project().props.get(old)!.scenes, []);
  } finally {
    s.close();
  }
});

interface Seeded {
  s: Store;
  ids: Record<string, string>;
}

function seeded(): Seeded {
  const s = new Store(":memory:", ":memory:");
  const ap = s.ensureProject("alpha");
  const bp = s.ensureProject("beta");
  const ids: Record<string, string> = {};
  ids.plain = s.remember(null, "s", false, { kind: "rule", text: "通用规则 G0", confirmed: true, source: src });
  ids.gDesign = s.remember(null, "s", false, { kind: "rule", text: "全局设计规范 D1", confirmed: true, scenes: ["design"], source: src });
  ids.gCodeWorker = s.remember(null, "s", false, { kind: "rule", text: "全局开发规范 C1", confirmed: true, for_workers: true, scenes: ["code"], source: src });
  ids.gCodeMain = s.remember(null, "s", false, { kind: "rule", text: "全局开发规范 C2 主会话专用", confirmed: true, scenes: ["code"], source: src });
  ids.aCode = s.remember(ap, "s", false, { kind: "rule", text: "alpha 开发规范 CA", confirmed: true, scenes: ["code"], source: src });
  ids.aDesign = s.remember(ap, "s", false, { kind: "rule", text: "alpha 设计规范 DA", confirmed: true, scenes: ["design"], source: src });
  ids.aPit = s.remember(ap, "s", false, { kind: "pitfall", text: "alpha 坑 P", confirmed: true, source: src });
  ids.bReview = s.remember(bp, "s", false, { kind: "rule", text: "beta review 规范 RB", confirmed: true, scenes: ["review"], source: src });
  // 乙也有一条同场景（code）的规则：范围筛选漏了就会串到甲
  ids.bCode = s.remember(bp, "s", false, { kind: "rule", text: "beta 开发规范 CB", confirmed: true, scenes: ["code"], source: src });
  return { s, ids };
}

test("无场景：场景规则不进通用段，只多一行按范围计数的索引", () => {
  const { s } = seeded();
  try {
    const out = brief(s, alpha, undefined, false);
    assert.match(out, /场景规则：设计 2 \/ 开发 3 条；进入该场景先 ab search --scene <场景>/);
    assert.doesNotMatch(out, /全局设计规范 D1|全局开发规范 C1|alpha 开发规范 CA|beta review 规范 RB/);
    assert.match(out, /通用规则 G0/);
    assert.match(out, /alpha 坑 P/);
  } finally {
    s.close();
  }
});

test("有场景：带场景规则移出通用段，按场景单独成段；项目甲的不出现在项目乙", () => {
  const { s, ids } = seeded();
  try {
    const used: string[] = [];
    const out = brief(s, alpha, undefined, false, used, ["code"]);
    assert.match(out, /^<agentbrain project="alpha" scene="code">/);
    assert.match(out, /场景规则（开发）：/);
    assert.match(out, /全局开发规范 C1/);
    assert.match(out, /全局开发规范 C2 主会话专用/);
    assert.match(out, /alpha 开发规范 CA/);
    assert.doesNotMatch(out, /设计规范|beta review 规范 RB/);
    const general = out.split("场景规则（")[0];
    assert.doesNotMatch(general, /全局开发规范|alpha 开发规范/);
    // used 只收最终实际输出的 id
    assert.deepEqual(new Set(used), new Set([ids.plain, ids.aPit, ids.gCodeWorker, ids.gCodeMain, ids.aCode]));
    for (const id of used) assert.ok(out.includes(`[${id.slice(0, 8)}]`), id);
  } finally {
    s.close();
  }
});

test("--worker：全局场景规则要 for_workers，本项目场景规则不要求", () => {
  const { s } = seeded();
  try {
    const out = brief(s, alpha, undefined, true, [], ["code"]);
    assert.match(out, /^<agentbrain project="alpha" worker scene="code">/);
    assert.match(out, /全局开发规范 C1/);
    assert.doesNotMatch(out, /全局开发规范 C2 主会话专用/);
    assert.match(out, /alpha 开发规范 CA/);
  } finally {
    s.close();
  }
});

test("pm 目录与未登记目录只给全局场景规则", () => {
  const { s } = seeded();
  try {
    const outer = brief(s, pm, undefined, false, [], ["code"]);
    assert.match(outer, /^<agentbrain scope="pm" scene="code">/);
    assert.match(outer, /全局开发规范 C1/);
    assert.doesNotMatch(outer, /alpha 开发规范 CA|beta review 规范 RB/);
    const un = brief(s, nowhere, undefined, false, [], ["code"]);
    assert.match(un, /^<agentbrain scope="unregistered" scene="code">/);
    assert.match(un, /全局开发规范 C1/);
    assert.doesNotMatch(un, /alpha 开发规范 CA|beta review 规范 RB/);
  } finally {
    s.close();
  }
});

test("跨项目隔离：同场景的规则只出现在自己的项目里（项目目录、pm、未登记目录、--worker）", () => {
  const { s } = seeded();
  try {
    const inAlpha = brief(s, alpha, undefined, false, [], ["code"]);
    assert.match(inAlpha, /alpha 开发规范 CA/);
    assert.doesNotMatch(inAlpha, /beta 开发规范 CB/);
    const inBeta = brief(s, beta, undefined, false, [], ["code"]);
    assert.match(inBeta, /beta 开发规范 CB/);
    assert.doesNotMatch(inBeta, /alpha 开发规范 CA/);
    for (const cwd of [pm, nowhere]) {
      const out = brief(s, cwd, undefined, false, [], ["code"]);
      assert.doesNotMatch(out, /alpha 开发规范 CA|beta 开发规范 CB/, cwd);
    }
    const w = brief(s, alpha, undefined, true, [], ["code"]);
    assert.match(w, /alpha 开发规范 CA/);
    assert.doesNotMatch(w, /beta 开发规范 CB/);
    // 显式项目名同样只看该项目
    assert.doesNotMatch(brief(s, nowhere, "alpha", true, [], ["code"]), /beta 开发规范 CB|beta review 规范 RB/);
  } finally {
    s.close();
  }
});

test("预算：通用段和场景段同时挤满，场景段正文不超场景预算；请求的场景没有条目时总上限仍是 2000", () => {
  const { s } = seeded();
  try {
    for (let i = 0; i < 80; i++) {
      s.remember(null, "s", false, { kind: "rule", text: `通用规则 ${i} ${"细节".repeat(20)}`, confirmed: true, source: src });
      s.remember(null, "s", false, { kind: "rule", text: `场景规则 ${i} ${"细节".repeat(20)}`, confirmed: true, scenes: ["code"], source: src });
    }
    const out = brief(s, alpha, undefined, false, [], ["code"]);
    const sceneBody = out
      .slice(out.indexOf("场景规则（"))
      .split("\n")
      .filter((l) => l.startsWith("- ["))
      .join("\n");
    assert.ok(sceneBody.length > 0 && sceneBody.length <= BRIEF_SCENE_MAX_CHARS, `场景段正文 ${sceneBody.length}`);
    assert.ok(out.length <= BRIEF_MAX_CHARS + BRIEF_SCENE_MAX_CHARS, `总长 ${out.length}`);
    assert.doesNotMatch(out, /已截断/);
    // 问一个没有条目的场景：场景段空，总上限不能因此放大到 4000
    const none = brief(s, alpha, undefined, false, [], ["review"]);
    assert.ok(none.length <= BRIEF_MAX_CHARS, `总长 ${none.length}`);
    assert.match(none, /scene="review"/);
    assert.doesNotMatch(none, /场景规则（review）：/);
  } finally {
    s.close();
  }
});

test("场景段有自己的预算，放不下给 ab search --scene 提示，总长不超两段之和", () => {
  const { s } = seeded();
  try {
    const text2id = new Map<string, string>();
    for (let i = 0; i < 80; i++) {
      const text = `开发规范 ${i} ${"细节".repeat(20)}`;
      text2id.set(text, s.remember(null, "s", false, { kind: "rule", text, confirmed: true, scenes: ["code"], source: src }));
    }
    const used: string[] = [];
    const out = brief(s, alpha, undefined, false, used, ["code"]);
    assert.ok(out.length <= BRIEF_MAX_CHARS + BRIEF_SCENE_MAX_CHARS, `长度 ${out.length}`);
    assert.ok(out.includes(SEARCH_HINT), "尾部提示还在");
    assert.match(out, /条放不下，用 ab search --scene code 查。/);
    assert.doesNotMatch(out, /已截断/);
    const sceneBody = out.split("场景规则（")[1] ?? "";
    assert.ok(sceneBody.length <= BRIEF_SCENE_MAX_CHARS + 200, `场景段 ${sceneBody.length}`);
    // markUsed 的 id 与输出里出现的 id 一致
    const printed = new Set([...out.matchAll(/\[([0-9a-f]{8})\]/g)].map((m) => m[1]));
    assert.deepEqual(printed, new Set(used.map((id) => id.slice(0, 8))));
    for (const [text, id] of text2id) {
      if (out.includes(text)) assert.ok(printed.has(id.slice(0, 8)), text);
    }
  } finally {
    s.close();
  }
});
