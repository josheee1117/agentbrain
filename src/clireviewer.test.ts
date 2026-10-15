/** CLI 审稿后端：命令行参数、输出解析、限流识别、防自激环境；认领租约；配置。运行：node --test src/clireviewer.test.ts */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliChat, cliCommand, cliFailure, parseCliOutput, reviewerEnv, REVIEWER_ENV, type Runner } from "./clireviewer.ts";
import { configForHost, judgeBatchPrimary, QuotaExhausted, retryPolicy, validateReviewConfig, type CallStat, type CandidateInput } from "./review.ts";
import { claimCandidates, connectPanel, releaseClaims, CLAIM_TTL_MS } from "./curate.ts";
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

test("配置：cli 成员不要 baseUrl/key；host 必须合法；hostReviewers 与 configForHost；autoRun 默认 false", () => {
  const cli = { name: "h", type: "cli", host: "claude", model: "haiku", effort: "max" };
  const cfg = validateReviewConfig({ mode: "primary", primary: "h", panel: [cli], hostReviewers: { codex: { name: "cx", type: "cli", host: "codex", model: "gpt-6-astra", effort: "max" } } });
  assert.ok(!("error" in cfg));
  if ("error" in cfg) return;
  assert.equal(cfg.autoRun, false);
  assert.equal(cfg.panel[0].keyService, "");
  assert.match((validateReviewConfig({ mode: "primary", primary: "h", panel: [{ ...cli, host: "cursor" }] }) as any).error, /host/);
  assert.match((validateReviewConfig({ mode: "primary", primary: "h", panel: [{ ...cli, type: "grpc" }] }) as any).error, /type/);
  assert.match((validateReviewConfig({ mode: "primary", primary: "h", panel: [cli], hostReviewers: { cursor: cli } }) as any).error, /hostReviewers/);
  assert.match((validateReviewConfig({ mode: "primary", primary: "h", panel: [cli], autoRun: "yes" }) as any).error, /autoRun/);
  const forCodex = configForHost(cfg, "codex");
  assert.equal(forCodex.onlyHost, "codex");
  assert.deepEqual([forCodex.cfg.mode, forCodex.cfg.primary, forCodex.cfg.panel.map((m) => m.name)], ["primary", "cx", ["cx"]]);
  assert.equal(configForHost(cfg, "pi").onlyHost, null, "没配的宿主走主配置");
  assert.equal(configForHost(cfg, "pi").cfg, cfg);
});

test("认领：两次运行不重复认领；释放后可再认领；过期的认领（崩掉的运行）会被接手", () => {
  const s = new Store(":memory:", ":memory:");
  const db = s.workDb;
  const t = new Date("2026-10-15T00:00:00Z");
  assert.deepEqual(claimCandidates(db, ["a", "b", "c"], "r1", t, 2), ["a", "b"]);
  assert.deepEqual(claimCandidates(db, ["a", "b", "c"], "r2", t, 5), ["c"]);
  releaseClaims(db, "r2");
  assert.deepEqual(claimCandidates(db, ["a", "b", "c"], "r3", t, 5), ["c"]);
  const later = new Date(t.getTime() + CLAIM_TTL_MS + 1);
  assert.deepEqual(claimCandidates(db, ["a", "b", "c"], "r4", later, 5), ["a", "b", "c"], "r1/r3 崩了没释放：过期后接手");
});

test("ab setup reviewers：默认 Claude 用 haiku max、Codex 用 gpt-6-astra max、Pi 用默认模型；autoRun 默认关；没有主配置时用 Claude 审稿人当主审", async () => {
  const home = mkdtempSync(join(tmpdir(), "ab-setup-"));
  try {
    const said: string[] = [];
    await runSetup(home, ["reviewers"], { ask: async (_q, def) => def ?? "", secret: async () => "", say: (x) => said.push(x) });
    const r = JSON.parse(readFileSync(join(home, "review.json"), "utf8"));
    assert.deepEqual(r.hostReviewers.claude, { name: "claude-review", type: "cli", host: "claude", model: "haiku", effort: "max" });
    assert.equal(r.hostReviewers.codex.model, "gpt-6-astra");
    assert.equal(r.hostReviewers.codex.effort, "max");
    assert.equal(r.hostReviewers.pi.model, "");
    assert.equal(r.autoRun, false);
    assert.deepEqual([r.mode, r.primary, r.panel[0].name], ["primary", "claude-review", "claude-review"]);
    // 选 api：默认是经 cpa 的 astra
    const answers = (q: string, def?: string) => (q.startsWith("Claude Code 会话") ? "api" : (def ?? ""));
    await runSetup(home, ["reviewers"], { ask: async (q, d) => answers(q, d), secret: async () => "", say: () => {} });
    const r2 = JSON.parse(readFileSync(join(home, "review.json"), "utf8"));
    assert.deepEqual([r2.hostReviewers.claude.type, r2.hostReviewers.claude.model, r2.hostReviewers.claude.keyService, r2.hostReviewers.claude.baseUrl], ["api", "gpt-6-astra", "codex-cpa-local-api-key", "http://127.0.0.1:8317/v1"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
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
