/** status 报告直接单测：上下文全由调用方注入。运行：node --test src/status.test.ts */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.ts";
import type { RememberBody } from "./l2.ts";
import { fmtCounts, statusReport, type StatusContext } from "./status.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "ab-status-")));
const repos = join(dir, "pm/repos");
const alpha = join(dir, "alpha");
const userHome = join(dir, "home");
for (const d of [repos, alpha, join(userHome, ".claude")]) mkdirSync(d, { recursive: true });
writeFileSync(join(repos, "alpha.md"), `- 路径：\`${alpha}\`\n`);
writeFileSync(join(repos, "ghost.md"), `- 路径：\`${join(dir, "missing")}\`\n`);
writeFileSync(join(userHome, ".claude/CLAUDE.md"), "开工先跑 ab brief\n");
const oldEnv = { HOME: process.env.HOME, AB_HOME: process.env.AB_HOME, AGENTBRAIN_HOME: process.env.AGENTBRAIN_HOME, AB_REGISTRY: process.env.AB_REGISTRY };
process.env.HOME = userHome;
process.env.AB_HOME = process.env.AGENTBRAIN_HOME = join(dir, "ab");
process.env.AB_REGISTRY = repos;
after(() => {
  for (const [key, value] of Object.entries(oldEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});
const src: RememberBody["source"] = { host: "pi", session_id: "s", transcript: null, anchor: null, summary: "讨论" };

const ctx = (over: Partial<StatusContext> = {}): StatusContext => ({
  cwd: alpha, userHome, storeHome: "/tmp/abhome", host: { ok: true, detection: null } as StatusContext["host"],
  embedder: null, embedReason: "未配置 embedding", chatConfig: { error: "没有 extract.json" }, now: new Date(), ...over,
});

test("报告各行：目录、宿主、active 按范围、向量不可用原因、接线、清单问题、孤立项目、store 路径", () => {
  const s = new Store(":memory:", ":memory:");
  const pid = s.ensureProject("alpha");
  s.ensureProject("old-name");
  s.remember(pid, "s", false, { kind: "rule", text: "r", confirmed: true, source: src });
  s.remember(null, "s", false, { kind: "rule", text: "g", confirmed: true, source: src });
  const out = statusReport(s, ctx());
  assert.match(out, /^目录: 项目 alpha$/m);
  assert.match(out, /^宿主: 未检测到宿主$/m);
  assert.match(out, /^active: (alpha 1、全局 1|全局 1、alpha 1)$/m);
  assert.match(out, /^向量: 不可用（未配置 embedding）$/m);
  assert.match(out, /~\/\.claude\/CLAUDE\.md: 含 ab brief；~\/\.codex\/AGENTS\.md: 没有 ab brief/);
  assert.match(out, /ghost: 路径不存在/);
  assert.match(out, /孤立项目: old-name（0 条记忆）/);
  assert.match(out, /抽取模型: 不可用（没有 extract.json）/);
  assert.match(out, /^store: \/tmp\/abhome$/m);
});

test("抽取模型那行显示渠道链：主渠道 → 备用渠道", () => {
  const out = statusReport(new Store(":memory:", ":memory:"), ctx({
    chatConfig: {
      model: "cn:deepseek-v4.1-flash",
      baseUrl: "http://127.0.0.1:7864/v1",
      keyService: "agentbrain-extract-cn",
      fallbacks: [{ model: "deepseek-v4.1-flash-1017-tx", baseUrl: "http://127.0.0.1:8317/v1", keyService: "codex-cpa-local-api-key" }],
    },
  }));
  assert.match(out, /抽取模型: cn:deepseek-v4\.1-flash @ 127\.0\.0\.1:7864 → deepseek-v4\.1-flash-1017-tx @ 127\.0\.0\.1:8317（key: 钥匙串 agentbrain-extract-cn）/);
});

test("抽取模型只有一个渠道时不画箭头，与以前逐字相同", () => {
  const out = statusReport(new Store(":memory:", ":memory:"), ctx({ chatConfig: { model: "m", baseUrl: "http://127.0.0.1:7864/v1", keyService: "agentbrain-extract" } }));
  assert.match(out, /抽取模型: m @ 127\.0\.0\.1:7864（key: 钥匙串 agentbrain-extract）；/);
  assert.doesNotMatch(out, /→/);
});

test("宿主检测失败如实写出", () => {
  const out = statusReport(new Store(":memory:", ":memory:"), ctx({ host: { ok: false, error: "ps 坏了" } as StatusContext["host"] }));
  assert.match(out, /宿主: 宿主检测失败: ps 坏了/);
});

test("fmtCounts：只列非零，全零写「无」", () => {
  assert.equal(fmtCounts({ a: 1, b: 0, c: 2 }), "a 1、c 2");
  assert.equal(fmtCounts({ a: 0 }), "无");
});

// ---------- §12.6.7 T5：要处理清单、代码、库、备份、失败窗口、孤立项目折叠 ----------

test("§12.6.7 T5：开头是要处理清单；代码、库、备份三行；内部说法改掉", () => {
  const home = join(dir, "t5-home");
  mkdirSync(join(home, "backups"), { recursive: true });
  const s = new Store(join(home, "store.db"), join(home, "index.db"));
  const pid = s.ensureProject("alpha");
  s.remember(pid, "s", false, { kind: "rule", text: "r", confirmed: true, source: src });
  const now = new Date();
  const out = statusReport(s, ctx({ storeHome: home, now, code: { commit: "abc1234", branch: "feature-x", dirty: 2, root: "/repo/ab" } }));
  const lines = out.split("\n");
  assert.equal(lines[0], "要处理（4 项）:");
  assert.deepEqual(lines.slice(1, 5), [
    "  1. 抽取模型不可用（没有 extract.json）：后台不会从新会话里抽取记忆",
    "  2. 还没有备份：ab backup",
    "  3. 代码有 2 个文件没提交：后台任务和钩子跑的就是这份没提交的代码",
    "  4. 向量不可用（未配置 embedding）：搜索只剩全文检索",
  ]);
  assert.match(out, /^代码: abc1234（feature-x），有 2 个文件没提交  \/repo\/ab$/m);
  assert.match(out, /^库: 版本 1（代码支持 1）；事件 1 条；不认识的事件 0 条$/m);
  assert.match(out, /^备份: 还没有（ab backup 做一份；ab work --sweep 每天自动做一次）$/m);
  assert.match(out, /^失败窗口: 没有$/m);
  assert.match(out, /^后台抽取:$/m);
  assert.match(out, /^投影: orphan 事件 0，/m);
  assert.doesNotMatch(out, /切片 3|^doctor:/m);
  s.close();
});

test("§12.6.7 T5：做过备份、代码干净、模型和向量可用、没有积压时写“没有要处理的事”", async () => {
  const { backup } = await import("./admin.ts");
  const home = join(dir, "t5-clean");
  mkdirSync(home, { recursive: true });
  const s = new Store(join(home, "store.db"), join(home, "index.db"));
  s.remember(null, "s", false, { kind: "rule", text: "g", confirmed: true, source: src });
  const now = new Date();
  const b = backup(s, home, now);
  const embedder = Object.assign(async (t: string[]) => t.map(() => new Float32Array(3)), { model: "fake" });
  const out = statusReport(s, ctx({
    storeHome: home, now: new Date(Date.now() + 3 * 3_600_000 + 60_000), embedder, embedReason: null,
    chatConfig: { model: "m", baseUrl: "http://127.0.0.1:1/v1", keyService: "k" },
    code: { commit: "abc1234", branch: null, dirty: 0, root: "/repo/ab" },
  }));
  assert.equal(out.split("\n")[0], "要处理: 没有要处理的事");
  assert.match(out, /^代码: abc1234，没有未提交改动  \/repo\/ab$/m);
  assert.match(out, new RegExp(`^备份: 最近一次 \\S+（3 小时前），共 1 份  ${b.path.replace(/[.\\/]/g, "\\$&")}$`, "m"));
  // 两天没有新备份：列进要处理
  const stale = statusReport(s, ctx({ storeHome: home, now: new Date(Date.now() + 72 * 3_600_000 + 60_000), code: null }));
  assert.match(stale, /最近一次备份是 3 天前：ab backup（ab work --sweep 每天会自动做，没做说明巡检没在跑）/);
  assert.match(stale, /^代码: 版本未知/m);
  s.close();
});

test("§12.6.7 T5：失败窗口列出时间、宿主、错误码和原因；孤立项目超过 3 个折成一行；不认识的事件和冲突进要处理", () => {
  const home = join(dir, "t5-problems");
  mkdirSync(home, { recursive: true });
  const s = new Store(join(home, "store.db"), join(home, "index.db"));
  const pid = s.ensureProject("alpha");
  for (const n of ["o1", "o2", "o3", "o4"]) s.ensureProject(n);
  const a = s.remember(pid, "s", false, { kind: "rule", text: "甲说法", confirmed: true, source: src });
  const b = s.remember(pid, "s", false, { kind: "rule", text: "乙说法", confirmed: true, source: src });
  s.commit([{ kind: "relate", project_id: pid, session_id: null, target_id: a, body: { outcome: "conflicts", target: b, reason: "相反", model: "m" } }], () => {});
  const now = new Date();
  const db = s.workDb;
  db.prepare("INSERT INTO capture_windows(window_id,host,session_id,from_anchor,to_anchor,state,attempts,error_code,receipt,updated_at,error_detail) VALUES('w1','claude','abcdef12-x',NULL,'u9','failed',4,'http_error',?,?,?)")
    .run(JSON.stringify({ chars: 47999 }), now.toISOString(), "模型接口 HTTP 413: input too long");
  db.prepare("INSERT INTO capture_windows(window_id,host,session_id,from_anchor,to_anchor,state,attempts,error_code,next_at,updated_at) VALUES('w2','codex','99887766-y',NULL,'5','deferred',1,'http_429',?,?)")
    .run(new Date(now.getTime() + 60_000).toISOString(), new Date(now.getTime() - 60_000).toISOString());
  db.prepare("INSERT INTO capture_windows(window_id,host,session_id,from_anchor,to_anchor,state,attempts,error_code,updated_at) VALUES('w3','pi','s3',NULL,'z','failed',4,'split',?)").run(now.toISOString());
  db.prepare("INSERT INTO events(id,ts,kind,body,body_hash) VALUES('e-unknown',?,'rescope','{}','x')").run(now.toISOString());
  const out = statusReport(s, ctx({ storeHome: home, now }));
  assert.match(out, /库里有 1 条这份代码不认识的事件，它们没有生效：更新 ab 的代码/);
  assert.match(out, /近 7 天有 1 个窗口抽取失败，这些对话没有抽取：原因看下面"失败窗口"/);
  assert.match(out, /冲突 1 对未解决：ab get 看双方，ab archive 错的一条/);
  assert.match(out, /^库: 版本 1（代码支持 1）；事件 4 条；不认识的事件 1 条$/m);
  assert.match(out, /^失败窗口: 失败 1，延后 1；最近 2 个:$/m);
  assert.match(out, /^  \d{4}-\d\d-\d\dT\d\d:\d\d claude:abcdef12 失败 http_error 47999 字: 模型接口 HTTP 413: input too long$/m);
  assert.match(out, /^  \d{4}-\d\d-\d\dT\d\d:\d\d codex:99887766 延后（第 1 次） http_429: 原因没有记录（旧版本留下的）$/m);
  assert.doesNotMatch(out, /split/, "拆开重试的不算失败窗口");
  assert.match(out, /^孤立项目 4 个（库里有、清单里没有，改名或删除了？）: o1 0 条、o2 0 条、o3 0 条、o4 0 条$/m);
  assert.doesNotMatch(out, /^孤立项目: /m);
  s.close();
});
