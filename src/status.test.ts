/** status 报告直接单测：上下文全由调用方注入。运行：node --test src/status.test.ts */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
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
process.env.AB_REGISTRY = repos;
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
