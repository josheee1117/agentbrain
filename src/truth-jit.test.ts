/** Truth Maintenance & Progressive Disclosure 测试。运行：node --test src/truth-jit.test.ts */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, SCHEMA_VERSION } from "./store.ts";
import { SCENES, type RememberBody } from "./l2.ts";
import { brief, BRIEF_SCENE_MAX_RULES } from "./brief.ts";
import { collectNoiseRules } from "./inbox.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "ab-truth-jit-")));
const repos = join(dir, "pm/repos");
const alpha = join(dir, "alpha");
mkdirSync(repos, { recursive: true });
mkdirSync(alpha, { recursive: true });
writeFileSync(join(repos, "alpha.md"), `- 路径：\`${alpha}\`\n`);
process.env.AB_REGISTRY = repos;

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

const CLI = join(import.meta.dirname, "cli.ts");
const src: RememberBody["source"] = { host: "pi", session_id: "s", transcript: null, anchor: null, summary: "原型测试" };

function runCli(abHome: string, ...args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: alpha,
    env: { ...process.env, AB_HOME: abHome, AGENTBRAIN_HOME: abHome, AB_REGISTRY: repos },
    encoding: "utf8",
  });
}

test("SCENES 扩展支持 test 阶段，且 SCHEMA_VERSION 保持 1 不变", () => {
  assert.equal(SCHEMA_VERSION, 1);
  assert.ok(SCENES.includes("test"));
  const s = new Store(":memory:", ":memory:");
  try {
    const id = s.remember(null, "s", false, {
      kind: "rule",
      text: "测试优先跑 L0 基础端到端场景并遵守单需求预算",
      confirmed: true,
      for_workers: true,
      scenes: ["test"],
      source: src,
    });
    const out = brief(s, alpha, undefined, true, [], ["test"]);
    assert.match(out, /scene="test"/);
    assert.match(out, /场景规则（测试）：/);
    assert.match(out, new RegExp(id.slice(0, 8)));
    assert.match(out, /按需触发器：本地起实例防串流/);
  } finally {
    s.close();
  }
});

test("Truth Maintenance：ab relate --coexist / --refines 解除误报冲突且保留关联，不升库版本", () => {
  const abHome = join(dir, "relate-home");
  mkdirSync(abHome, { recursive: true });
  const s = new Store(join(abHome, "store.db"), join(abHome, "index.db"));
  const pid = s.ensureProject("alpha");
  const a1 = s.remember(pid, "s", false, { kind: "pitfall", text: "快照放独立临时目录", confirmed: true, source: src });
  const a2 = s.remember(pid, "s", false, {
    kind: "pitfall",
    text: "重放对比前先冻结输入快照",
    confirmed: false,
    relation: { type: "conflicts", target: a1 },
    source: src,
  });
  const b1 = s.remember(pid, "s", false, { kind: "pitfall", text: "加载前设 sys.dont_write_bytecode", confirmed: true, source: src });
  const b2 = s.remember(pid, "s", false, {
    kind: "pitfall",
    text: "动态加载入口如 tools/board 也要在 import 前设 sys.dont_write_bytecode",
    confirmed: true,
    relation: { type: "conflicts", target: b1 },
    source: src,
  });
  assert.equal(s.project().conflict_pairs.length, 2);
  s.close();

  const r1 = runCli(abHome, "relate", a2.slice(0, 8), a1.slice(0, 8), "--coexist", "--reason", "分别管冻结与存放位置");
  assert.equal(r1.status, 0, r1.stderr);
  assert.match(r1.stdout, /互补共存（冲突已解除）/);

  const r2 = runCli(abHome, "relate", b2.slice(0, 8), b1.slice(0, 8), "--refines", "--reason", "动态入口细化补充");
  assert.equal(r2.status, 0, r2.stderr);
  assert.match(r2.stdout, /补充了.*（冲突已解除）/);

  const check = new Store(join(abHome, "store.db"), join(abHome, "index.db"));
  try {
    assert.equal(check.schema.version, 1);
    assert.equal(check.project().conflict_pairs.length, 0);
  } finally {
    check.close();
  }

  const getOut = runCli(abHome, "get", b1.slice(0, 8));
  assert.equal(getOut.status, 0, getOut.stderr);
  assert.match(getOut.stdout, /被它补充/);
  assert.doesNotMatch(getOut.stdout, /冲突（关系判定）/);
});

test("Progressive Disclosure：--on-demand 移出被动 brief、专属性优先截 8 条 + 按需触发器，--noise 识别零引用高注入规则", () => {
  const abHome = join(dir, "jit-home");
  mkdirSync(abHome, { recursive: true });
  const s = new Store(join(abHome, "store.db"), join(abHome, "index.db"));
  s.ensureProject("alpha");

  const ids: string[] = [];
  for (let i = 0; i < 12; i++) {
    ids.push(
      s.remember(null, "s", false, {
        kind: "rule",
        text: `开发规则条目-${i} 唯一关键词KW${i}`,
        confirmed: true,
        for_workers: true,
        scenes: i >= 10 ? ["design", "code", "review"] : ["code"],
        source: src,
      }),
    );
  }
  const noiseId = s.remember(null, "s", false, {
    kind: "rule",
    text: "MySQL 767 字节唯一索引低频规则",
    confirmed: true,
    for_workers: true,
    source: src,
  });
  const prefId = s.remember(null, "s", false, {
    kind: "rule",
    text: "结论先行常驻偏好",
    confirmed: true,
    guidance: true,
    for_workers: true,
    source: src,
  });

  const nowIso = new Date().toISOString();
  const ins = s.workDb.prepare("INSERT INTO inject_log(ts,host,session_id,prop_id,path,cited,failed) VALUES(?,?,?,?,?,?,0)");
  for (let i = 0; i < 150; i++) {
    ins.run(nowIso, "pi", `sess-${i}`, noiseId, "brief", 0);
    ins.run(nowIso, "pi", `sess-${i}`, prefId, "brief", 0);
    ins.run(nowIso, "pi", `sess-${i}`, ids[9], "brief", i < 10 ? 1 : 0);
  }
  const noises = collectNoiseRules(s);
  assert.equal(noises.length, 1);
  assert.equal(noises[0].id, noiseId);
  s.close();

  const noiseCli = runCli(abHome, "inbox", "--noise");
  assert.equal(noiseCli.status, 0, noiseCli.stderr);
  assert.match(noiseCli.stdout, new RegExp(noiseId.slice(0, 8)));

  const tagOut = runCli(abHome, "tag", noiseId.slice(0, 8), "--on-demand");
  assert.equal(tagOut.status, 0, tagOut.stderr);

  const briefOut = runCli(abHome, "brief", "--worker", "--scene", "code");
  assert.equal(briefOut.status, 0, briefOut.stderr);
  assert.doesNotMatch(briefOut.stdout, /MySQL 767 字节/);
  // 单场景专属规则（KW9..KW2）优先于三场景跨标规则（KW11, KW10）
  assert.match(briefOut.stdout, /KW9/);
  assert.doesNotMatch(briefOut.stdout, /KW11/);
  const sceneLines = (briefOut.stdout.split("场景规则（开发）：")[1] ?? "")
    .split("\n")
    .filter((l) => l.startsWith("- ["));
  assert.equal(sceneLines.length, BRIEF_SCENE_MAX_RULES);
  assert.match(briefOut.stdout, /场景还有 4 条放不下，用 ab search --scene code 查。/);
  assert.match(briefOut.stdout, /按需触发器：跨层DTO/);

  const searchOut = runCli(abHome, "search", "MySQL 767");
  assert.equal(searchOut.status, 0, searchOut.stderr);
  assert.match(searchOut.stdout, /\[用户确认\]\[按需\].*MySQL 767 字节/);
});
