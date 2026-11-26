/** inbox 与 brief 高信号展开测试（先红后绿）。运行：node --test src/inbox.test.ts */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.ts";
import type { RememberBody } from "./l2.ts";
import { ownClock } from "./expiry.ts";
import { brief, BRIEF_MAX_CHARS, BriefError } from "./brief.ts";
import { statusReport, type StatusContext } from "./status.ts";
import {
  BRIEF_INBOX_MAX_CHARS,
  BRIEF_INBOX_MAX_ITEMS,
  INBOX_DEFAULT_LIMIT,
  briefInboxBlock,
  collectInbox,
  formatInboxText,
} from "./inbox.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "ab-inbox-")));
const repos = join(dir, "pm/repos");
const pmRoot = join(dir, "pm");
const alpha = join(dir, "alpha");
const beta = join(dir, "beta");
const gamma = join(dir, "gamma");
const elsewhere = join(dir, "elsewhere");
for (const d of [repos, pmRoot, alpha, beta, gamma, elsewhere]) mkdirSync(d, { recursive: true });
writeFileSync(join(repos, "alpha.md"), `- 路径：\`${alpha}\`\n`);
writeFileSync(join(repos, "beta.md"), `- 路径：\`${beta}\`\n`);
writeFileSync(join(repos, "gamma.md"), `- 路径：\`${gamma}\`\n`);

const oldEnv = {
  AB_HOME: process.env.AB_HOME,
  AGENTBRAIN_HOME: process.env.AGENTBRAIN_HOME,
  AB_REGISTRY: process.env.AB_REGISTRY,
};
process.env.AB_REGISTRY = repos;
after(() => {
  for (const [k, v] of Object.entries(oldEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

const CLI = join(import.meta.dirname, "cli.ts");
const src: RememberBody["source"] = { host: "pi", session_id: "s", transcript: null, anchor: null, summary: "讨论" };

function runCli(abHome: string, cwd: string, ...args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    env: { ...process.env, AB_HOME: abHome, AGENTBRAIN_HOME: abHome, AB_REGISTRY: repos },
    encoding: "utf8",
  });
}

test("5 类高信号收集与严格优先级排序（含已确认冲突优于双未确认冲突），排除普通未确认条目", () => {
  const s = new Store(":memory:", ":memory:");
  try {
    const pid = s.ensureProject("alpha");
    const now = new Date("2026-11-26T00:00:00Z");

    // 普通未确认 extract / manual 条目：绝对不能进 inbox
    for (let i = 0; i < 20; i++) {
      s.remember(pid, "s", false, { kind: "pitfall", text: `普通未确认extract-${i}`, confirmed: false, origin: "extract", source: src });
      s.remember(pid, "s", false, { kind: "note", text: `普通未确认manual-${i}`, confirmed: false, origin: "manual", source: src });
    }

    // 5. conflict（双未确认，最老）
    const cu1 = s.remember(pid, "s", false, { kind: "rule", text: "双未确认冲突A", confirmed: false, source: src });
    const cu2 = s.remember(pid, "s", false, { kind: "rule", text: "双未确认冲突B", confirmed: false, relation: { type: "conflicts", target: cu1 }, source: src });
    s.workDb.prepare("UPDATE events SET ts=? WHERE id=?").run("2026-11-10T00:00:00Z", cu2);

    // 5. conflict（含已确认，较新但应排在双未确认之前）
    const cc1 = s.remember(pid, "s", false, { kind: "rule", text: "含已确认冲突A", confirmed: true, source: src });
    const cc2 = s.remember(pid, "s", false, { kind: "rule", text: "含已确认冲突B", confirmed: false, relation: { type: "conflicts", target: cc1 }, source: src });
    s.workDb.prepare("UPDATE events SET ts=? WHERE id=?").run("2026-11-20T00:00:00Z", cc2);

    // 4. review（到期待复审）
    const revOld = s.remember(pid, "s", false, { kind: "pitfall", text: "复审超期更久", confirmed: false, origin: "extract", source: src });
    const revNew = s.remember(pid, "s", false, { kind: "pitfall", text: "复审超期较短", confirmed: false, origin: "extract", source: src });
    s.workDb.prepare("UPDATE events SET ts=? WHERE id=?").run("2025-11-01T00:00:00Z", revOld);
    s.workDb.prepare("UPDATE events SET ts=? WHERE id=?").run("2026-01-01T00:00:00Z", revNew);

    // 3. synth（收口提炼）
    const synthId = s.remember(pid, "s", false, { kind: "decision", text: "收口提炼决定", confirmed: false, origin: "auto", source: src });

    // 2. correction（待确认纠正）
    const targetId = s.remember(pid, "s", false, { kind: "rule", text: "旧规则被纠正", confirmed: true, source: src });
    const corrId = s.remember(pid, "s", false, { kind: "rule", text: "新纠正规则", confirmed: false, supersedes: targetId, source: src });

    // 1. stale（已确认且与代码不符）
    const staleId = s.remember(pid, "s", false, { kind: "pitfall", text: "已确认但与代码不符", confirmed: true, source: src });
    s.commit([{ kind: "verify", project_id: pid, session_id: null, target_id: staleId, body: { outcome: "contradicted", head: "abcdef1234567890", refs: [], model: "m" } }], () => {});

    // 代码核验转正的条目即便 stale，由 staleBlocked 停注，不算 staleWarning
    const codeStaleId = s.remember(pid, "s", false, { kind: "pitfall", text: "代码核验转正不符", confirmed: false, origin: "extract", source: src });
    s.lifecycle("confirm", codeStaleId, null, { by: "code" });
    s.commit([{ kind: "verify", project_id: pid, session_id: null, target_id: codeStaleId, body: { outcome: "contradicted", head: "abcdef1234567890", refs: [], model: "m" } }], () => {});

    const res = collectInbox(s, { cwd: alpha, now, clock: ownClock, limit: 20 });
    assert.deepEqual(res.counts, { stale: 1, correction: 1, synth: 1, review: 2, conflict: 2, total: 7 });
    assert.deepEqual(
      res.items.map((x) => [x.kind, x.id]),
      [
        ["stale", staleId],
        ["correction", corrId],
        ["synth", synthId],
        ["review", revOld],
        ["review", revNew],
        ["conflict", cc1 < cc2 ? cc1 : cc2],
        ["conflict", cu1 < cu2 ? cu1 : cu2],
      ],
    );
    const corrItem = res.items.find((x) => x.kind === "correction")!;
    assert.equal(corrItem.targetShortId, targetId.slice(0, 8));
    assert.ok(!res.items.some((x) => x.text.includes("普通未确认")));

    const txt = formatInboxText(res);
    assert.match(txt, /ab verify/);
    assert.match(txt, /ab confirm/);
    assert.match(txt, /ab get/);
    assert.match(txt, /ab archive/);
    assert.match(txt, /ab review --archive/);
  } finally {
    s.close();
  }
});

test("作用域过滤：全局、指定项目、pm、未登记目录、--all 与未入 projects 表的项目零写入", () => {
  const s = new Store(":memory:", ":memory:");
  try {
    const pidA = s.ensureProject("alpha");
    const pidB = s.ensureProject("beta");
    // gamma 存在 registry 中，但故意不 ensureProject("gamma")

    const gSynth = s.remember(null, "s", false, { kind: "decision", text: "全局收口决定", confirmed: false, origin: "auto", source: src });
    const aSynth = s.remember(pidA, "s", false, { kind: "decision", text: "alpha收口决定", confirmed: false, origin: "auto", source: src });
    const bSynth = s.remember(pidB, "s", false, { kind: "decision", text: "beta收口决定", confirmed: false, origin: "auto", source: src });
    // 跨项目冲突：beta 与 全局 冲突，在 alpha 范围也应可见（因为全局端在范围内）
    const gConf = s.remember(null, "s", false, { kind: "rule", text: "全局冲突端", confirmed: true, source: src });
    s.remember(pidB, "s", false, { kind: "rule", text: "beta冲突端", confirmed: false, relation: { type: "conflicts", target: gConf }, source: src });

    const now = new Date();
    // 未登记目录：仅全局
    const unreg = collectInbox(s, { cwd: elsewhere, now, clock: ownClock });
    assert.equal(unreg.scope, "global");
    assert.deepEqual(unreg.items.map((x) => x.id).includes(gSynth), true);
    assert.deepEqual(unreg.items.some((x) => x.id === aSynth || x.id === bSynth), false);
    assert.equal(unreg.counts.conflict, 1);

    // 指定项目 alpha：全局 + alpha
    const alphaRes = collectInbox(s, { cwd: elsewhere, projectName: "alpha", now, clock: ownClock });
    assert.equal(alphaRes.scope, "project");
    assert.equal(alphaRes.project, "alpha");
    assert.ok(alphaRes.items.some((x) => x.id === gSynth));
    assert.ok(alphaRes.items.some((x) => x.id === aSynth));
    assert.ok(!alphaRes.items.some((x) => x.id === bSynth));

    // pm 目录（未指定项目）：全库
    const pmRes = collectInbox(s, { cwd: pmRoot, now, clock: ownClock });
    assert.equal(pmRes.scope, "all");
    assert.ok(pmRes.items.some((x) => x.id === aSynth));
    assert.ok(pmRes.items.some((x) => x.id === bSynth));

    // --all：全库
    const allRes = collectInbox(s, { cwd: alpha, all: true, now, clock: ownClock });
    assert.equal(allRes.scope, "all");
    assert.equal(allRes.counts.synth, 3);

    // 未写入 projects 表的项目 gamma：不抛错、不写 projects 表，仅返回全局
    const projectsBefore = s.listProjects().length;
    const gammaRes = collectInbox(s, { cwd: gamma, projectName: "gamma", now, clock: ownClock });
    assert.equal(s.listProjects().length, projectsBefore);
    assert.ok(gammaRes.items.some((x) => x.id === gSynth));
    assert.ok(!gammaRes.items.some((x) => x.id === aSynth));

    // 未知项目名抛 BriefError
    assert.throws(() => collectInbox(s, { cwd: alpha, projectName: "missing", now, clock: ownClock }), BriefError);
  } finally {
    s.close();
  }
});

test("briefInboxBlock：只展开高信号项且含已确认冲突、排除双未确认冲突、≤450字、worker不注入、不挤死规则", () => {
  const s = new Store(":memory:", ":memory:");
  try {
    const pid = s.ensureProject("alpha");
    // 10 条正常已确认规则，验证展开不挤死正文规则
    for (let i = 0; i < 10; i++) {
      s.remember(pid, "s", false, { kind: "rule", text: `正常规则-${i}`, confirmed: true, source: src });
    }
    // 1 对双未确认冲突：不应进 briefInboxBlock，只走 conflictReminder
    const u1 = s.remember(pid, "s", false, { kind: "pitfall", text: "双未确认坑甲", confirmed: false, source: src });
    s.remember(pid, "s", false, { kind: "pitfall", text: "双未确认坑乙", confirmed: false, relation: { type: "conflicts", target: u1 }, source: src });

    const onlyUnconfirmedConflict = briefInboxBlock(s, "alpha", false, new Date());
    assert.equal(onlyUnconfirmedConflict, null);

    // 6 条高信号项（超 BRIEF_INBOX_MAX_ITEMS = 5）
    const s1 = s.remember(pid, "s", false, { kind: "pitfall", text: "高信号不符一" + "长".repeat(40), confirmed: true, source: src });
    s.commit([{ kind: "verify", project_id: pid, session_id: null, target_id: s1, body: { outcome: "contradicted", head: "1234567890", refs: [], model: "m" } }], () => {});
    const oldT = s.remember(pid, "s", false, { kind: "rule", text: "旧规则", confirmed: true, source: src });
    s.remember(pid, "s", false, { kind: "rule", text: "高信号纠正二" + "长".repeat(40), confirmed: false, supersedes: oldT, source: src });
    s.remember(pid, "s", false, { kind: "decision", text: "高信号收口三", confirmed: false, origin: "auto", source: src });
    s.remember(pid, "s", false, { kind: "decision", text: "高信号收口四", confirmed: false, origin: "auto", source: src });
    const c1 = s.remember(pid, "s", false, { kind: "rule", text: "高信号已确认冲突甲", confirmed: true, source: src });
    const c2 = s.remember(pid, "s", false, { kind: "rule", text: "高信号冲突乙", confirmed: false, relation: { type: "conflicts", target: c1 }, source: src });
    s.workDb.prepare("UPDATE events SET ts=? WHERE id=?").run("2026-11-01T00:00:00Z", c2);
    const c3 = s.remember(pid, "s", false, { kind: "rule", text: "高信号第六条不该挤进来", confirmed: true, source: src });
    s.remember(pid, "s", false, { kind: "rule", text: "高信号冲突丁", confirmed: false, relation: { type: "conflicts", target: c3 }, source: src });

    const block = briefInboxBlock(s, "alpha", false, new Date());
    assert.ok(block !== null);
    assert.ok(block.length <= BRIEF_INBOX_MAX_CHARS, `block length ${block.length} > ${BRIEF_INBOX_MAX_CHARS}`);
    const itemLines = block.split("\n").slice(1).filter((l) => l.trim().startsWith("["));
    assert.ok(itemLines.length <= BRIEF_INBOX_MAX_ITEMS && itemLines.length >= 1);
    assert.doesNotMatch(block, /双未确认坑甲/);
    assert.doesNotMatch(block, /高信号第六条不该挤进来/);

    const used: string[] = [];
    const mainBrief = brief(s, alpha, undefined, false, used);
    assert.ok(mainBrief.length <= BRIEF_MAX_CHARS);
    assert.match(mainBrief, /正常规则-9/);
    assert.match(mainBrief, /高信号不符一/);
    assert.match(mainBrief, /高信号纠正二/);
    assert.match(mainBrief, /ab inbox --kind conflict 看清单/);
    assert.match(mainBrief, /ab inbox --kind stale 看清单/);

    // worker 模式绝对不带 briefInboxBlock
    const workerUsed: string[] = [];
    const workerBrief = brief(s, alpha, undefined, true, workerUsed);
    assert.doesNotMatch(workerBrief, /高信号纠正二|高信号收口三|ab inbox 全量|待用户拍板/);
  } finally {
    s.close();
  }
});

test("CLI ab inbox：--kind、--limit、--json 纯 JSON、错误退出码，以及 ab inbox 与 ab brief 零多余写库", () => {
  const abHome = join(dir, "cli-ab");
  mkdirSync(abHome, { recursive: true });
  const s = new Store(join(abHome, "store.db"), join(abHome, "index.db"));
  const pid = s.ensureProject("alpha");
  const synthId = s.remember(pid, "s", false, { kind: "decision", text: "CLI 收口测试决定", confirmed: false, origin: "auto", source: src });
  const c1 = s.remember(pid, "s", false, { kind: "rule", text: "CLI 未确认冲突1", confirmed: false, source: src });
  s.remember(pid, "s", false, { kind: "rule", text: "CLI 未确认冲突2", confirmed: false, relation: { type: "conflicts", target: c1 }, source: src });
  s.close();

  const eventsBefore = new Store(join(abHome, "store.db"), join(abHome, "index.db")).eventCount();
  // 先测参数校验报错
  for (const badArgs of [
    ["inbox", "unknown-proj"],
    ["inbox", "alpha", "--all"],
    ["inbox", "--kind", "bogus"],
    ["inbox", "--limit", "0"],
    ["inbox", "--limit", "-3"],
    ["inbox", "--limit", "abc"],
  ]) {
    const r = runCli(abHome, alpha, ...badArgs);
    assert.notEqual(r.status, 0, badArgs.join(" "));
    assert.doesNotMatch(r.stderr, /\n\s+at |Node\.js v/);
  }

  // --json 纯净 JSON 输出
  const jsonRun = runCli(abHome, alpha, "inbox", "--json");
  assert.equal(jsonRun.status, 0, jsonRun.stderr);
  const parsed = JSON.parse(jsonRun.stdout);
  assert.equal(parsed.counts.synth, 1);
  assert.equal(parsed.counts.conflict, 1);
  assert.equal(parsed.counts.total, 2);
  assert.equal(parsed.limit, INBOX_DEFAULT_LIMIT);
  assert.equal(parsed.items[0].id, synthId);

  // --kind 与 --limit
  const kindRun = runCli(abHome, alpha, "inbox", "--kind", "conflict", "--limit", "1");
  assert.equal(kindRun.status, 0, kindRun.stderr);
  assert.match(kindRun.stdout, /CLI 未确认冲突/);
  assert.doesNotMatch(kindRun.stdout, /CLI 收口测试决定/);

  // 针对未进 projects 表的 gamma 运行 ab inbox
  const gammaRun = runCli(abHome, gamma, "inbox", "gamma", "--json");
  assert.equal(gammaRun.status, 0, gammaRun.stderr);

  // 跑带高信号展开块的 ab brief（本用例无已确认规则，所以 inject_log 应保持 0 增量）
  const briefRun = runCli(abHome, alpha, "brief");
  assert.equal(briefRun.status, 0, briefRun.stderr);
  assert.match(briefRun.stdout, /CLI 收口测试决定/);

  // 核查零 events 增量、零 inject_log 写入、零 prop_usage 写入、gamma 未写入 projects 表
  const check = new Store(join(abHome, "store.db"), join(abHome, "index.db"));
  try {
    assert.equal(check.eventCount(), eventsBefore);
    const injectRows = Number((check.workDb.prepare("SELECT COUNT(*) AS n FROM inject_log").get() as { n: number }).n);
    const usageRows = Number((check.workDb.prepare("SELECT COUNT(*) AS n FROM prop_usage").get() as { n: number }).n);
    assert.equal(injectRows, 0);
    assert.equal(usageRows, 0);
    assert.ok(!check.listProjects().some((p) => p.name === "gamma"));
  } finally {
    check.close();
  }
});

test("statusReport 的待办行包含 ab inbox 引导并保留 stale 前缀", () => {
  const s = new Store(":memory:", ":memory:");
  try {
    const pid = s.ensureProject("alpha");
    const a = s.remember(pid, "s", false, { kind: "rule", text: "冲突甲", confirmed: true, source: src });
    s.remember(pid, "s", false, { kind: "rule", text: "冲突乙", confirmed: false, relation: { type: "conflicts", target: a }, source: src });
    const st = s.remember(pid, "s", false, { kind: "pitfall", text: "不符坑", confirmed: true, source: src });
    s.commit([{ kind: "verify", project_id: pid, session_id: null, target_id: st, body: { outcome: "contradicted", head: "abcdef1", refs: [], model: "m" } }], () => {});
    const ctx: StatusContext = {
      cwd: alpha,
      userHome: dir,
      storeHome: dir,
      host: { ok: true, detection: null },
      embedder: null,
      embedReason: "test",
      chatConfig: { error: "test" },
      now: new Date(),
    };
    const out = statusReport(s, ctx);
    assert.match(out, /冲突 1 对未解决：ab get 看双方，ab archive 错的一条；ab inbox --kind conflict 看清单/);
    assert.match(out, /与代码不符 1 条（待用户核实）：ab verify <id> 重核，ab confirm <id> 保留（ab inbox --kind stale 看清单）/);
  } finally {
    s.close();
  }
});
