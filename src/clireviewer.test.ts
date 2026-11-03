/** CLI 审稿后端：命令行参数、输出解析、限流识别、防自激环境；认领租约；配置。运行：node --test src/clireviewer.test.ts */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliChat, cliCommand, cliFailure, parseClaudeResetMs, parseCliOutput, reviewerEnv, REVIEWER_ENV, type Runner } from "./clireviewer.ts";
import { configForHost, judgeBatchPrimary, QuotaExhausted, retryPolicy, validateReviewConfig, type CallStat, type CandidateInput } from "./review.ts";
import { connectPanel } from "./curate.ts";
import { Store } from "./store.ts";
import { runSetup } from "./setup.ts";

const cand = (id: string): CandidateInput => ({ id, kind: "rule", scope: "global", project: null, text: `正文${id}`, context: null, worker: false, neighbors: [] });

test("cliCommand：claude 关工具/关设置源/不存会话，模型与强度走参数；codex 关 hook、只读、临时目录；pi 关扩展和工具", () => {
  const c = cliCommand({ host: "claude", model: "haiku", effort: "max", timeoutMs: 1 }, "SYS", "USER", "/tmp/d");
  assert.equal(c.cmd, "claude");
  assert.deepEqual(c.args.slice(0, 9), ["-p", "--output-format", "json", "--no-session-persistence", "--tools", "", "--setting-sources", "", "--system-prompt"]);
  assert.equal(c.args[9], "SYS");
  assert.deepEqual(c.args.slice(-4), ["--model", "haiku", "--effort", "max"]);
  assert.equal(c.input, "USER");
  const x = cliCommand({ host: "codex", model: "gpt-6-astra", effort: "max", timeoutMs: 1 }, "SYS", "USER", "/tmp/d");
  assert.ok(x.args.includes("--ephemeral") && x.args.includes("read-only") && x.args.join(" ").includes("--disable hooks"));
  assert.ok(x.args.join(" ").includes("-m gpt-6-astra -c model_reasoning_effort=max -"));
  assert.equal(x.lastFile, "/tmp/d/last.txt");
  assert.match(x.input, /^SYS[\s\S]*USER$/);
  const p = cliCommand({ host: "pi", effort: "high", timeoutMs: 1 }, "SYS", "USER", "/tmp/d");
  assert.ok(p.args.includes("--no-extensions") && p.args.includes("--no-tools") && p.args.includes("--no-session"));
  assert.ok(!p.args.includes("--model"), "没配模型就用 Pi 默认");
  assert.deepEqual(p.args.slice(-2), ["--thinking", "high"]);
});

test("parseCliOutput：claude 取 result 和费用；is_error/限额 → http_429；codex 取最后一条和 usage；pi 取 stdout", () => {
  const ok = parseCliOutput("claude", { code: 0, stdout: JSON.stringify({ result: '{"verdicts":[]}', is_error: false, total_cost_usd: 0.01, usage: { input_tokens: 5, output_tokens: 7 } }), stderr: "", timedOut: false }, null);
  assert.deepEqual(ok, { text: '{"verdicts":[]}', tokens: 12, costUsd: 0.01 });
  assert.throws(() => parseCliOutput("claude", { code: 1, stdout: JSON.stringify({ is_error: true, result: "Claude AI usage limit reached|1999999999" }), stderr: "", timedOut: false }, null), (e: any) => e.code === "http_429" && e.retryAfterMs > 0);
  assert.throws(() => parseCliOutput("claude", { code: 1, stdout: "not json", stderr: "boom", timedOut: false }, null), (e: any) => e.code === "http_error");
  const cx = parseCliOutput("codex", { code: 0, stdout: ['{"type":"turn.completed","usage":{"input_tokens":30,"output_tokens":4}}'].join("\n"), stderr: "", timedOut: false }, '{"verdicts":[]}');
  assert.deepEqual(cx, { text: '{"verdicts":[]}', tokens: 34 });
  assert.throws(() => parseCliOutput("codex", { code: 1, stdout: '{"type":"turn.failed","error":{"message":"usage_limit_reached"}}', stderr: "", timedOut: false }, null), (e: any) => e.code === "http_429");
  assert.deepEqual(parseCliOutput("pi", { code: 0, stdout: "{}", stderr: "", timedOut: false }, null), { text: "{}", tokens: 0 });
  assert.equal(cliFailure("pi", "network down").code, "http_error");
});

test("reviewerEnv：带审稿标记，去掉嵌套 Claude Code 的变量", () => {
  const e = reviewerEnv({ PATH: "/bin", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli" });
  assert.equal(e[REVIEWER_ENV], "1");
  assert.equal(e.CLAUDECODE, undefined);
  assert.equal(e.PATH, "/bin");
});

test("cliChat：拼系统/用户提示，用临时目录和审稿环境跑；超时报 timeout；codex 读 -o 文件", async () => {
  let seen: { cmd: string; args: string[]; input: string; cwd: string; env: NodeJS.ProcessEnv } | null = null;
  const run: Runner = async (cmd, args, input, o) => {
    seen = { cmd, args, input, cwd: o.cwd, env: o.env };
    return { code: 0, stdout: JSON.stringify({ result: "OK", is_error: false, usage: {} }), stderr: "", timedOut: false };
  };
  const r = await cliChat({ host: "claude", model: "haiku", timeoutMs: 1000 }, run)([{ role: "system", content: "S" }, { role: "user", content: "U" }]);
  assert.equal(r.message.content, "OK");
  assert.equal(seen!.input, "U");
  assert.equal(seen!.args[seen!.args.indexOf("--system-prompt") + 1], "S");
  assert.equal(seen!.env[REVIEWER_ENV], "1");
  assert.match(seen!.cwd, /ab-review-/);
  const slow: Runner = async () => ({ code: null, stdout: "", stderr: "", timedOut: true });
  await assert.rejects(cliChat({ host: "pi", timeoutMs: 5 }, slow)([{ role: "user", content: "U" }]), (e: any) => e.code === "timeout");
  const codexRun: Runner = async (_c, args) => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(args[args.indexOf("-o") + 1], "LAST");
    return { code: 0, stdout: "", stderr: "", timedOut: false };
  };
  assert.equal((await cliChat({ host: "codex", timeoutMs: 1000 }, codexRun)([{ role: "user", content: "U" }])).message.content, "LAST");
});

test("CLI 成员额度用完：退避表用完就 QuotaExhausted，整次停下", async () => {
  const saved = [...retryPolicy.backoffMs];
  retryPolicy.backoffMs.splice(0, retryPolicy.backoffMs.length, 1, 1);
  try {
    const run: Runner = async () => ({ code: 1, stdout: JSON.stringify({ is_error: true, result: "You've hit your usage limit" }), stderr: "", timedOut: false });
    const cfg = validateReviewConfig({ mode: "primary", primary: "h", panel: [{ name: "h", type: "cli", host: "claude", model: "haiku", effort: "max" }] });
    assert.ok(!("error" in cfg));
    const { panel } = connectPanel(cfg as any, { read: () => ({ error: "不该读钥匙串" }) as any }, run);
    const stats: CallStat[] = [];
    await assert.rejects(judgeBatchPrimary([cand("a")], panel[0], [], stats), (e) => e instanceof QuotaExhausted);
  } finally {
    retryPolicy.backoffMs.splice(0, retryPolicy.backoffMs.length, ...saved);
  }
});

test("配置：cli 成员不要 baseUrl/key；host 必须合法；hostReviewers 与 configForHost", () => {
  const cli = { name: "h", type: "cli", host: "claude", model: "haiku", effort: "max" };
  const cfg = validateReviewConfig({ mode: "primary", primary: "h", panel: [cli], hostReviewers: { codex: { name: "cx", type: "cli", host: "codex", model: "gpt-6-astra", effort: "max" } } });
  assert.ok(!("error" in cfg));
  if ("error" in cfg) return;
  assert.equal(cfg.panel[0].keyService, "");
  assert.match((validateReviewConfig({ mode: "primary", primary: "h", panel: [{ ...cli, host: "cursor" }] }) as any).error, /host/);
  assert.match((validateReviewConfig({ mode: "primary", primary: "h", panel: [{ ...cli, type: "grpc" }] }) as any).error, /type/);
  assert.match((validateReviewConfig({ mode: "primary", primary: "h", panel: [cli], hostReviewers: { cursor: cli } }) as any).error, /hostReviewers/);
  const forCodex = configForHost(cfg, "codex");
  assert.equal(forCodex.onlyHost, "codex");
  assert.deepEqual([forCodex.cfg.mode, forCodex.cfg.primary, forCodex.cfg.panel.map((m) => m.name)], ["primary", "cx", ["cx"]]);
  assert.equal(configForHost(cfg, "pi").onlyHost, "pi", "没配宿主审稿人：走主配置，但仍只审该宿主的候选（--host 不扩大范围）");
  assert.equal(configForHost(cfg, "pi").cfg, cfg);
  assert.equal(configForHost(cfg, null).onlyHost, null);
});

test("ab setup reviewers：默认 Claude 用 haiku max、Codex 用 gpt-6-astra max、Pi 用默认模型 max；没有主配置时用 Claude 审稿人当主审", async () => {
  const home = mkdtempSync(join(tmpdir(), "ab-setup-"));
  const prevHostHome = process.env.AB_HOST_HOME;
  process.env.AB_HOST_HOME = home; // 宿主配置读空目录，不受本机 ~/.pi ~/.codex 影响
  try {
    const said: string[] = [];
    await runSetup(home, ["reviewers"], { ask: async (_q, def) => def ?? "", secret: async () => "", say: (x) => said.push(x) });
    const r = JSON.parse(readFileSync(join(home, "review.json"), "utf8"));
    assert.deepEqual(r.hostReviewers.claude, { name: "claude-review", type: "cli", host: "claude", model: "haiku", effort: "max" });
    assert.equal(r.hostReviewers.codex.model, "gpt-6-astra");
    assert.equal(r.hostReviewers.codex.effort, "max");
    assert.equal(r.hostReviewers.pi.model, "");
    assert.equal(r.hostReviewers.pi.effort, "max");
    assert.deepEqual([r.mode, r.primary, r.panel[0].name], ["primary", "claude-review", "claude-review"]);
    // 选 api：默认是经 cpa 的 astra
    const answers = (q: string, def?: string) => (q.startsWith("Claude Code 会话") ? "api" : (def ?? ""));
    await runSetup(home, ["reviewers"], { ask: async (q, d) => answers(q, d), secret: async () => "", say: () => {} });
    const r2 = JSON.parse(readFileSync(join(home, "review.json"), "utf8"));
    assert.deepEqual([r2.hostReviewers.claude.type, r2.hostReviewers.claude.model, r2.hostReviewers.claude.keyService, r2.hostReviewers.claude.baseUrl], ["api", "gpt-6-astra", "codex-cpa-local-api-key", "http://127.0.0.1:8317/v1"]);
  } finally {
    if (prevHostHome === undefined) delete process.env.AB_HOST_HOME;
    else process.env.AB_HOST_HOME = prevHostHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("ab setup reviewers：默认模型按宿主自己的配置推出（Pi 的 reviewer 子代理模型、Codex 的 review_model），不写死", async () => {
  const { hostReviewerDefault } = await import("./setup.ts");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const h = mkdtempSync(join(tmpdir(), "ab-hosthome-"));
  try {
    assert.deepEqual(hostReviewerDefault("pi", h), { model: "", effort: "max" });
    assert.deepEqual(hostReviewerDefault("codex", h), { model: "gpt-6-astra", effort: "max" });
    mkdirSync(join(h, ".pi", "agent"), { recursive: true });
    writeFileSync(join(h, ".pi", "agent", "settings.json"), JSON.stringify({ defaultModel: "grok-4.7", subagents: { agentOverrides: { reviewer: { model: "openai-codex/gpt-6-astra" } } } }));
    mkdirSync(join(h, ".codex"), { recursive: true });
    writeFileSync(join(h, ".codex", "config.toml"), 'model = "gpt-6.1-sol"\nreview_model = "gpt-6-terra"\n');
    assert.equal(hostReviewerDefault("pi", h).model, "openai-codex/gpt-6-astra");
    assert.equal(hostReviewerDefault("pi", h).effort, "max");
    assert.equal(hostReviewerDefault("codex", h).model, "gpt-6-terra");
    assert.deepEqual(hostReviewerDefault("claude", h), { model: "haiku", effort: "max" });
    writeFileSync(join(h, ".pi", "agent", "settings.json"), "{坏的 json");
    assert.equal(hostReviewerDefault("pi", h).model, "", "读坏了就用内置默认");
  } finally {
    rmSync(h, { recursive: true, force: true });
  }
});

test("一步式：提示词含标准与新记/并入/不记；输出校验丢掉不合格单条", async () => {
  const { ONE_PASS_SYSTEM, parseOnePass, buildOnePassMessages } = await import("./onepass.ts");
  assert.match(ONE_PASS_SYSTEM, /好记忆的标准/);
  assert.match(ONE_PASS_SYSTEM, /items 给空数组/);
  const nb = [{ id: "P1", kind: "rule", text: "已有", confirmed: true } as any];
  const msgs = buildOnePassMessages({ turns: [{ role: "user", text: "以后汇报说人话", anchor: "a1" } as any], context: [] }, { name: "x", docs: "", registry: "", confirmed: "" }, nb);
  assert.equal(msgs[0].content, ONE_PASS_SYSTEM);
  assert.match(msgs[1].content!, /m1 \[rule\] 已有/);
  const r = parseOnePass(JSON.stringify({ items: [
    { action: "new", kind: "rule", class: "A", text: "说人话", scenario: "当汇报时", why: "用户要求" },
    { action: "merge", into: "m1", kind: "rule", class: "A", text: "合并", scenario: "当汇报时" },
    { action: "merge", into: "m9", kind: "rule", class: "A", text: "x", scenario: "当汇报时" },
    { action: "new", kind: "rule", class: "A", text: "y", scenario: "汇报时" },
    { action: "keep", kind: "rule", class: "A", text: "z", scenario: "当x时" },
  ] }), nb);
  assert.ok(r);
  assert.deepEqual(r!.items.map((i) => [i.action, i.into]), [["new", null], ["merge", "P1"]]);
  assert.deepEqual(r!.invalid, { merge_bad_target: 1, no_scenario: 1, bad_action: 1 });
  assert.deepEqual(parseOnePass('{"items":[]}', [])!.items, []);
  const { ONE_PASS_WORKER_NOTE } = await import("./onepass.ts");
  const { WORKER_NOTE } = await import("./extract.ts");
  const wm = buildOnePassMessages({ turns: [{ role: "user", text: "派活", anchor: "a1" } as any], context: [], worker: true }, { name: "x", docs: "", registry: "", confirmed: "" }, []);
  assert.ok(wm[1].content!.includes(ONE_PASS_WORKER_NOTE) && !wm[1].content!.includes(WORKER_NOTE));
  assert.equal(parseOnePass("不是 JSON", []), null);
});

test("一步式：仓库背景含原版 worker 说明时背景原样保留，只使用一步式 worker 说明", async () => {
  const { buildOnePassMessages, ONE_PASS_WORKER_NOTE } = await import("./onepass.ts");
  const { WORKER_NOTE } = await import("./extract.ts");
  const docs = `仓库说明\n${WORKER_NOTE}\n背景结束`;
  const [, user] = buildOnePassMessages({ turns: [{ role: "user", text: "派活", anchor: "a1" }], context: [], worker: true }, { name: "x", docs, registry: "", confirmed: "" }, []);
  assert.equal(user.content, [
    "项目：x",
    `<repo_docs>\n${docs}\n</repo_docs>`,
    "<existing_memories>\n（无）\n</existing_memories>",
    ONE_PASS_WORKER_NOTE,
    "<transcript>\n[#1 user] 派活\n</transcript>",
  ].join("\n\n"));
});

test("一步式召回修法 §8.7：去掉偏少倾向、含按类清单（含工具输出里的坑）、上限 8 条、标准一字不改", async () => {
  const { ONE_PASS_SYSTEM, ONE_PASS_CHECKLIST, ONE_PASS_MAX_ITEMS, parseOnePass } = await import("./onepass.ts");
  const { GOOD_MEMORY_STANDARD } = await import("./standard.ts");
  for (const lean of ["宁缺毋滥", "大多数会话没有值得记", "没有第二个审稿人", "这是正常结论"]) assert.ok(!ONE_PASS_SYSTEM.includes(lean), `仍含偏少措辞：${lean}`);
  assert.match(ONE_PASS_SYSTEM, /漏记和错记一样有代价/);
  assert.match(ONE_PASS_SYSTEM, /不要只给最显眼的一两条/);
  assert.match(ONE_PASS_SYSTEM, /不要为了有产出硬凑/, "仍然允许给空、不许硬凑");
  assert.ok(ONE_PASS_SYSTEM.includes(ONE_PASS_CHECKLIST));
  assert.ok(ONE_PASS_SYSTEM.indexOf(ONE_PASS_CHECKLIST) < ONE_PASS_SYSTEM.indexOf("## 你的任务"), "清单在任务说明之前");
  for (const cat of ["用户对干活方式的要求和纠正", "设计决定和理由", "工具输出里的失败或意外", "排查陷阱", "用户机器和测试环境的具体事实"]) assert.ok(ONE_PASS_CHECKLIST.includes(cat), `清单缺：${cat}`);
  assert.ok(ONE_PASS_SYSTEM.includes(GOOD_MEMORY_STANDARD), "《好记忆的标准》原文照搬");
  assert.equal(ONE_PASS_MAX_ITEMS, 8);
  assert.match(ONE_PASS_SYSTEM, /0 到 8 条结论/);
  const item = (i: number) => ({ action: "new", kind: "pitfall", class: "C", text: `坑${i}`, scenario: "当排查构建时", why: "工具报错" });
  const r = parseOnePass(JSON.stringify({ items: Array.from({ length: 10 }, (_, i) => item(i)) }), []);
  assert.equal(r!.items.length, 8);
  assert.deepEqual(r!.invalid, { too_many: 2 });
  assert.equal(parseOnePass(JSON.stringify({ items: Array.from({ length: 8 }, (_, i) => item(i)) }), [])!.items.length, 8);
  // 超限之后的坏条按真实原因计数；坏条不占名额
  const mixed = [item(0), { ...item(1), kind: "fact" }, ...Array.from({ length: 8 }, (_, i) => item(i + 2)), { ...item(20), scenario: "排查时" }];
  const m = parseOnePass(JSON.stringify({ items: mixed }), [])!;
  assert.equal(m.items.length, 8);
  assert.deepEqual(m.invalid, { bad_kind: 1, too_many: 1, no_scenario: 1 });
});

test("一步式提示词钉死为评测 12 的 V1：§8.7 批准的是逐字相同，任何漂移都要先过用户", async () => {
  const { ONE_PASS_SYSTEM } = await import("./onepass.ts");
  const { createHash } = await import("node:crypto");
  // 版本号口径与评测 12 的 probe.ts 一致：sha256(ONE_PASS_SYSTEM) 前 12 位。
  // 注意 topic.ts 的 PROMPT_VERSION 另把子代理说明一起算进去，数值不同、不要拿来对比。
  // 5f4e4becc159 = 2026-10-30 按 §8.11.3 改《好记忆的标准》（decision 例外）后重新钉死
  assert.equal(createHash("sha256").update(ONE_PASS_SYSTEM).digest("hex").slice(0, 12), "5f4e4becc159");
});

test("一步式：A 类结论一律 guidance=true（与审稿链路同口径），B/C 类看模型标注", async () => {
  const { parseOnePass } = await import("./onepass.ts");
  const r = parseOnePass(JSON.stringify({ items: [
    { action: "new", kind: "rule", class: "A", text: "说人话", scenario: "当汇报时", guidance: false },
    { action: "new", kind: "decision", class: "B", text: "选方案 X", scenario: "当改存储时" },
    { action: "new", kind: "pitfall", class: "C", text: "先重启再测", scenario: "当跑 e2e 时", guidance: true },
  ] }), [])!;
  assert.deepEqual(r.items.map((i) => i.guidance), [true, false, true]);
});

test("限流识别：Claude 新格式 weekly limit 带重置时间（时区）→ http_429 + 等待时长", () => {
  const now = Date.parse("2026-10-15T09:08:00Z"); // 新加坡 17:08
  const ms = parseClaudeResetMs("You've hit your weekly limit · resets Oct 17 at 1am (Asia/Singapore)", now);
  assert.equal(new Date(now + ms!).toISOString(), "2026-10-16T17:00:00.000Z"); // 10-17 01:00 SGT
  const ms2 = parseClaudeResetMs("You've hit your session limit · resets 3pm (Asia/Singapore)", now);
  assert.equal(new Date(now + ms2!).toISOString(), "2026-10-16T07:00:00.000Z", "今天 15:00 已过 → 明天");
  assert.equal(parseClaudeResetMs("resets 11:30pm (UTC)", now), Date.parse("2026-10-15T23:30:00Z") - now);
  assert.equal(parseClaudeResetMs("resets Oct 17 at 1am (Not/AZone)", now), undefined);
  assert.equal(parseClaudeResetMs("no reset here", now), undefined);
  const f = cliFailure("claude", "You've hit your weekly limit · resets Oct 17 at 1am (Asia/Singapore)");
  assert.equal(f.code, "http_429");
  assert.ok((f as any).retryAfterMs > 3_600_000);
});
