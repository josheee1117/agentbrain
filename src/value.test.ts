/** 价值审计（§21 2026-10-14）：worker 派活提示不算用户原话、价值标准校验、撤销自动转正、常驻偏好。运行：node --test src/value.test.ts */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanTranscript, isPiWorker, isWorkerTranscript } from "./transcript.ts";
import { buildMessages, EXPLORATION_PREFIX, isScenario, validate, type ExtractWindow } from "./extract.ts";
import { Store } from "./store.ts";
import type { RememberBody } from "./l2.ts";
import { recallableUnconfirmed } from "./l2.ts";
import { guidanceBlock, GUIDANCE_MAX_CHARS } from "./recall.ts";
import { workerQuoteAudit } from "./audit.ts";

const dir = mkdtempSync(join(tmpdir(), "ab-value-"));
const file = (name: string, lines: object[]) => {
  const p = join(dir, name);
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return p;
};
const piMsg = (id: string, parentId: string | null, role: string, text: string) => ({ type: "message", id, parentId, timestamp: "2026-10-12T07:15:30.234Z", message: { role, content: [{ type: "text", text }] } });

// ---------- B：认出 worker 会话 ----------

test("pi：派活提示带 ab brief --worker、会话名 pi-worker、带 parentSession 的都是 worker；用户自己开的不是", () => {
  const sys = { type: "message", id: "s0", parentId: null, message: { role: "system", content: "", sections: { preamble: "x".repeat(40_000) } } };
  const byPrompt = file("pi-prompt.jsonl", [
    { type: "session", version: 3, id: "p1", cwd: "/repo" },
    sys,
    piMsg("u1", "s0", "user", "任务如下。\n目标仓库：/repo。先跑 `ab brief --worker`，读 AGENTS.md。严禁 git checkout。"),
  ]);
  const byName = file("pi-name.jsonl", [
    { type: "session", version: 3, id: "p2", cwd: "/repo" },
    { type: "session_info", id: "i", parentId: null, name: "pi-worker" },
    piMsg("u1", "i", "user", "修一下 cli 测试"),
  ]);
  const byParent = file("pi-parent.jsonl", [{ type: "session", version: 3, id: "p3", cwd: "/repo", parentSession: "/x.jsonl" }, piMsg("u1", null, "user", "继续")]);
  const mine = file("pi-main.jsonl", [
    { type: "session", version: 3, id: "p4", cwd: "/repo" },
    sys,
    piMsg("u1", "s0", "user", "以后汇报直接写在回复正文里，别提 ab brief 的事"),
  ]);
  for (const f of [byPrompt, byName, byParent]) {
    assert.equal(isWorkerTranscript(f), true, f);
    assert.equal(cleanTranscript("pi", f).worker, true, f);
  }
  assert.equal(isWorkerTranscript(mine), false);
  assert.equal(cleanTranscript("pi", mine).worker, false);
  assert.equal(isPiWorker([{ type: "session_info", name: "maxcompute-architecture" }]), false, "别的会话名不算");
});

test("codex exec 会话的 cleanTranscript 也标 worker（只有 thread_spawn 子 agent 才整个跳过）", () => {
  const f = file("cx.jsonl", [
    { timestamp: "t", type: "session_meta", payload: { id: "c1", cwd: "/repo", originator: "codex_exec", source: "exec" } },
    { timestamp: "t", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "任务如下：修测试" }] } },
  ]);
  const c = cleanTranscript("codex", f);
  assert.equal(c.worker, true);
  assert.equal(c.subagent, false);
});

// ---------- B：worker 窗口里 user 轮不算证据 ----------

const workerWin: ExtractWindow = {
  context: [],
  worker: true,
  turns: [
    { anchor: "u1", role: "user", text: "严禁 git checkout / stash 任何文件，也不要 commit、push" },
    { anchor: "t1", role: "tool", text: "Error: prisma migrate 需要 shadow database 权限" },
  ],
};
const sc = "当在 ai-data 的共享 worktree 里干活时";

test("worker 会话：引派活提示的证据以 worker_prompt 丢弃，规则因此 basis_unsupported；工具证据的坑照常保留", () => {
  const v = validate({ candidates: [
    { kind: "rule", scope: "project", scenario: sc, text: "不要 git checkout / stash 任何文件", why: "worktree 里有用户未提交的阶段成果，checkout 会丢掉", basis: "user_directive", evidence: [{ anchor: "#1", role: "user", quote: "严禁 git checkout / stash 任何文件" }], relation: { type: "new", target: null } },
    { kind: "pitfall", scope: "project", scenario: "当在本机跑 prisma 迁移时", text: "prisma migrate 需要能建 shadow database 的账号", basis: "observed_failure", evidence: [{ anchor: "#2", role: "tool", quote: "prisma migrate 需要 shadow database 权限" }], relation: { type: "new", target: null } },
  ] }, workerWin, [], "w");
  assert.deepEqual(v.evidenceDropped, { worker_prompt: 1 });
  assert.deepEqual(v.dropped, { no_evidence: 1 });
  assert.deepEqual(v.candidates.map((c) => c.kind), ["pitfall"]);
  const msgs = buildMessages(workerWin, { name: "p", docs: "", registry: "", confirmed: "" }, []);
  assert.match(String(msgs[1].content), /子代理（worker）会话/);
  assert.doesNotMatch(buildMessages({ ...workerWin, worker: false }, { name: "p", docs: "", registry: "", confirmed: "" }, [])[1].content ?? "", /子代理（worker）会话/);
});

// ---------- A：价值标准 ----------

const win: ExtractWindow = {
  context: [],
  turns: [
    { anchor: "u1", role: "user", text: "以后最终汇报直接写在回复正文里，别只丢个文件路径给我" },
    { anchor: "t1", role: "tool", text: "Error: trino 连接超时，e2e 改用 mock 后才通过" },
  ],
};
const rule = {
  kind: "rule",
  scope: "global",
  scenario: "当任务完成、向用户做最终汇报时",
  text: "最终汇报直接写在回复正文里，文件只作补充",
  why: "助手只给了报告文件路径，用户要翻文件才知道结论，于是要求写进回复",
  basis: "user_directive",
  evidence: [{ anchor: "#1", role: "user", quote: "以后最终汇报直接写在回复正文里" }],
  relation: { type: "new", target: null },
  durability: "permanent",
  findable: false,
  guidance: true,
};

test("合格的偏好：场景存进 trigger，guidance 标记带上", () => {
  const v = validate({ candidates: [rule] }, win, [], "w1");
  assert.deepEqual(v.dropped, {});
  assert.equal(v.candidates[0].trigger, rule.scenario);
  assert.equal(v.candidates[0].guidance, true);
  assert.equal(v.candidates[0].kind, "rule");
});

test("没写场景、场景只是抄正文、太短：no_scenario；旧输出的 trigger 仍当场景用", () => {
  const { scenario: _drop, ...noScenario } = rule;
  const cases = [noScenario, { ...rule, scenario: "汇报时" }, { ...rule, scenario: "当最终汇报直接写在回复正文里，文件只作补充时" }];
  for (const c of cases) assert.deepEqual(validate({ candidates: [c] }, win, [], "w").dropped, { no_scenario: 1 }, JSON.stringify((c as { scenario?: string }).scenario));
  assert.equal(validate({ candidates: [{ ...noScenario, trigger: rule.scenario }] }, win, [], "w").candidates.length, 1);
  assert.equal(isScenario("当给 ai-data 写 e2e 测试时", "e2e 测试不能伪造数据"), true);
});

test("阶段性用法 phase、agent 自己查得到的 findable、正文是一次性叙事 narrative：整条丢", () => {
  assert.deepEqual(validate({ candidates: [{ ...rule, durability: "phase" }] }, win, [], "w").dropped, { phase: 1 });
  assert.deepEqual(validate({ candidates: [{ ...rule, findable: true }] }, win, [], "w").dropped, { findable: 1 });
  for (const t of ["本次汇报直接写在回复正文里", "2026-10-12 起汇报写在回复正文里", "刚才那个汇报要写在回复里"])
    assert.deepEqual(validate({ candidates: [{ ...rule, text: t }] }, win, [], "w").dropped, { narrative: 1 }, t);
});

test("探索经验：存成 note，正文带探索前缀，不带 guidance", () => {
  const v = validate({ candidates: [{ ...rule, kind: "pitfall", basis: "observed_failure", scenario: "当给 ai-data 写 e2e 测试时", text: "trino 连不上时先查网络白名单，别急着换 mock", durability: "exploration", evidence: [{ anchor: "#2", role: "tool", quote: "trino 连接超时" }] }] }, win, [], "w");
  assert.deepEqual(v.dropped, {});
  assert.equal(v.candidates[0].kind, "note");
  assert.ok(v.candidates[0].text.startsWith(EXPLORATION_PREFIX));
  assert.equal(v.candidates[0].guidance, undefined);
});

// ---------- B：撤销自动转正 ----------

const src = (sid: string, transcript: string | null = null): RememberBody["source"] => ({ host: "pi", session_id: sid, transcript, anchor: "a", summary: "x" });
const auto = (extra: Partial<RememberBody> = {}): RememberBody => ({
  kind: "rule",
  text: "不要 git checkout 任何文件",
  confirmed: false,
  origin: "extract",
  basis: "user_directive",
  evidence: [{ anchor: "a", role: "user", quote_sha256: "h" }],
  source: src("w1", "/w1.jsonl"),
  ...extra,
});

test("unconfirm：撤销印证/代码核验的转正；之后再印证、再核验都不转正，也不再按有用户原话进召回；用户确认能恢复", () => {
  const s = new Store(":memory:", ":memory:");
  const pid = s.ensureProject("p");
  const a = s.remember(pid, "w1", false, auto());
  s.lifecycle("confirm", a, null, { by: "corroboration", sessions: ["pi:w1", "pi:w2"] });
  assert.equal(s.project().props.get(a)!.confirmed, true);
  s.lifecycle("unconfirm", a, null, { reason: "worker_prompt" });
  let p = s.project().props.get(a)!;
  assert.equal(p.confirmed, false);
  assert.equal(p.demoted, "worker_prompt");
  assert.equal(recallableUnconfirmed(p), false);
  s.lifecycle("confirm", a, null, { by: "corroboration", sessions: ["pi:w1", "pi:w3"] });
  assert.equal(s.project().props.get(a)!.confirmed, false, "撤销后不再自动印证转正");

  const b = s.remember(pid, "w1", false, auto({ kind: "pitfall", text: "坑" }));
  s.commit([{ kind: "verify", project_id: pid, session_id: null, target_id: b, body: { outcome: "verified", head: "h1", refs: [], model: "m" } }], () => {});
  assert.equal(s.project().props.get(b)!.confirmed_by, "code");
  s.lifecycle("unconfirm", b, null, { reason: "worker_prompt" });
  s.commit([{ kind: "verify", project_id: pid, session_id: null, target_id: b, body: { outcome: "verified", head: "h2", refs: [], model: "m" } }], () => {});
  p = s.project().props.get(b)!;
  assert.equal(p.confirmed, false, "撤销后代码核验也不再转正");
  assert.equal(p.code_evidence, null);

  s.lifecycle("confirm", a, null);
  p = s.project().props.get(a)!;
  assert.equal(p.confirmed, true);
  assert.equal(p.confirmed_by, "user");
  assert.equal(p.demoted, null);
});

test("unconfirm 不动用户确认过的条目", () => {
  const s = new Store(":memory:", ":memory:");
  const a = s.remember(null, "w1", false, auto());
  s.lifecycle("confirm", a, null);
  s.lifecycle("unconfirm", a, null, { reason: "worker_prompt" });
  const p = s.project().props.get(a)!;
  assert.equal(p.confirmed, true);
  assert.equal(p.demoted, null);
});

test("audit worker-quotes：用户原话全部来自 worker 会话的才入选；自动转正的撤销，用户确认的进复核清单", () => {
  const s = new Store(":memory:", ":memory:");
  const pid = s.ensureProject("p");
  const onlyWorker = s.remember(pid, "w1", false, auto());
  s.lifecycle("confirm", onlyWorker, null, { by: "corroboration", sessions: [] });
  const mixed = s.remember(pid, "w1", false, auto({ text: "混合来源" }));
  s.commit([{ kind: "evidence", project_id: pid, session_id: "m1", target_id: mixed, body: { source: { ...src("m1"), session_id: "m1" }, basis: "user_directive", evidence: [{ anchor: "a", role: "user", quote_sha256: "h2" }], window_id: "x" } }], () => {});
  const userOk = s.remember(pid, "w1", false, auto({ text: "用户确认过" }));
  s.lifecycle("confirm", userOk, null);
  const toolOnly = s.remember(pid, "w1", false, auto({ kind: "pitfall", text: "工具证据", basis: "observed_failure", evidence: [{ anchor: "a", role: "tool", quote_sha256: "t" }] }));
  const plan = workerQuoteAudit(s.project().props.values(), (_h, sid) => (sid === "m1" ? "/m1.jsonl" : null), (f) => f === "/w1.jsonl");
  assert.deepEqual(plan.demote.map((p) => p.id), [onlyWorker]);
  assert.deepEqual(plan.review.map((p) => p.id), [userOk]);
  assert.ok(![...plan.demote, ...plan.review].some((p) => p.id === mixed || p.id === toolOnly));
});

// ---------- C：常驻偏好 ----------

test("常驻偏好：只放用户确认的全局 guidance；有上限；子代理只看 for_workers；本轮已召回的不重复", () => {
  const s = new Store(":memory:", ":memory:");
  const pid = s.ensureProject("p");
  const base = { kind: "rule" as const, source: src("m"), confirmed: true };
  const talk = s.remember(null, "m", false, { ...base, text: "说人话：先一句话结论，术语要解释", guidance: true });
  const report = s.remember(null, "m", false, { ...base, text: "最终汇报写在回复正文里", guidance: true, for_workers: true });
  s.remember(null, "m", false, { ...base, text: "全局但不是偏好" });
  s.remember(pid, "m", false, { ...base, text: "项目里的偏好", guidance: true });
  s.remember(null, "m", false, { ...base, text: "未确认的偏好", guidance: true, confirmed: false });
  const tagged = s.remember(null, "m", false, { ...base, text: "旧条目后来标成偏好" });
  s.lifecycle("tag", tagged, null, { guidance: true });
  const props = () => s.project().props.values();
  const shown: string[] = [];
  const out = guidanceBlock(props(), false, new Set(), shown);
  assert.match(out, /^<agentbrain-prefs>/);
  assert.deepEqual(new Set(shown), new Set([talk, report, tagged]));
  assert.doesNotMatch(out, /不是偏好|项目里|未确认/);
  assert.deepEqual(new Set((() => { const w: string[] = []; guidanceBlock(props(), true, new Set(), w); return w; })()), new Set([report]));
  assert.doesNotMatch(guidanceBlock(props(), false, new Set([talk])), /说人话/);
  for (let i = 0; i < 20; i++) s.remember(null, "m", false, { ...base, text: `偏好第 ${i} 条：${"很长的说明".repeat(8)}`, guidance: true });
  assert.ok(guidanceBlock(props(), false).length <= GUIDANCE_MAX_CHARS);
  assert.equal(guidanceBlock([], false), "");
});
