/** 价值审计（§21 2026-10-14）：worker 派活提示不算用户原话、价值标准校验、撤销自动转正、常驻偏好。运行：node --test src/value.test.ts */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanTranscript, isPiWorker, isWorkerTranscript } from "./transcript.ts";
import { buildMessages, validate, type ExtractWindow } from "./extract.ts";
import { Store } from "./store.ts";
import type { RememberBody } from "./l2.ts";
import { recallable } from "./visibility.ts";
const recallableUnconfirmed = (p: Parameters<typeof recallable>[0]) => !p.confirmed && recallable(p, true);
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

test("worker 会话：引派活提示的证据以 worker_prompt 丢弃，规则因此 basis_unsupported；工具证据的坑照常保留", () => {
  const v = validate({ candidates: [
    { kind: "rule", scope: "project", text: "不要 git checkout / stash 任何文件", why: "worktree 里有用户未提交的阶段成果，checkout 会丢掉", basis: "user_directive", evidence: [{ anchor: "#1", role: "user", quote: "严禁 git checkout / stash 任何文件" }], relation: { type: "new", target: null } },
    { kind: "pitfall", scope: "project", trigger: "在本机跑 prisma 迁移", text: "prisma migrate 需要能建 shadow database 的账号", basis: "observed_failure", evidence: [{ anchor: "#2", role: "tool", quote: "prisma migrate 需要 shadow database 权限" }], relation: { type: "new", target: null } },
  ] }, workerWin, [], "w");
  assert.deepEqual(v.evidenceDropped, { worker_prompt: 1 });
  assert.deepEqual(v.dropped, { no_evidence: 1 });
  assert.deepEqual(v.candidates.map((c) => c.kind), ["pitfall"]);
  const msgs = buildMessages(workerWin, { name: "p", docs: "", registry: "", confirmed: "" }, []);
  assert.match(String(msgs[1].content), /子代理（worker）会话/);
  assert.doesNotMatch(buildMessages({ ...workerWin, worker: false }, { name: "p", docs: "", registry: "", confirmed: "" }, [])[1].content ?? "", /子代理（worker）会话/);
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
  assert.equal(p.confirmed_by, null, "撤销后核验证据不等于自动转正");
  assert.equal(p.code_evidence, null);
  assert.equal(p.demoted, "worker_prompt");

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

test("常驻偏好跳过带场景的条目（§11.10：curate 同时写上 guidance 与 scenes 也不每轮注入）", () => {
  const s = new Store(":memory:", ":memory:");
  const base = { kind: "rule" as const, source: src("m"), confirmed: true };
  const both = s.remember(null, "m", false, { ...base, text: "带场景的偏好", guidance: true, scenes: ["code"] });
  const plain = s.remember(null, "m", false, { ...base, text: "普通偏好", guidance: true });
  const shown: string[] = [];
  const out = guidanceBlock(s.project().props.values(), false, new Set(), shown);
  assert.doesNotMatch(out, /带场景的偏好/);
  assert.deepEqual(shown, [plain]);
  assert.ok(!shown.includes(both));
});

test("audit worker-quotes：派活提示里转抄的是用户主会话的原话 → 不撤销；只在派活提示里出现的照常撤销", async () => {
  const { MainSaid, userQuoteHashes } = await import("./audit.ts");
  const { sha256 } = await import("./extract.ts");
  const s = new Store(":memory:", ":memory:");
  const pid = s.ensureProject("p");
  const relayed = s.remember(pid, "w1", false, auto({ text: "e2e 必须真实跑", evidence: [{ anchor: "a", role: "user", quote_sha256: sha256("e2e 测试必须真实跑通，不能 mock") }] }));
  const workerOnly = s.remember(pid, "w1", false, auto({ text: "只在派活提示里", evidence: [{ anchor: "a", role: "user", quote_sha256: sha256("改完只汇报 diff 摘要") }] }));
  const main = new MainSaid();
  main.add("另外，e2e 测试必须真实跑通，不能 mock，之前被坑过");
  const workerPrompt = ["任务：修 bug。约束：e2e 测试必须真实跑通，不能 mock。改完只汇报 diff 摘要。先跑 ab brief --worker"];
  const saidInMain = (p: any) => main.quotedIn(workerPrompt, userQuoteHashes(p), sha256);
  const plan = workerQuoteAudit(s.project().props.values(), () => null, () => true, saidInMain);
  assert.deepEqual(plan.demote.map((p) => p.id), [workerOnly]);
  assert.ok(!plan.demote.some((p) => p.id === relayed));
  assert.equal(main.quotedIn(workerPrompt, new Set([sha256("改完只汇报 diff 摘要")]), sha256), false, "主会话没说过");
});

test("audit worker-quotes：关系判定为重复/细化一条用户亲自确认的条目 → 同一条规则，不撤销", () => {
  const s = new Store(":memory:", ":memory:");
  const pid = s.ensureProject("p");
  const userRule = s.remember(pid, "m", false, { kind: "rule", text: "review 按严重程度分挡", confirmed: true, source: src("m") });
  const relayed = s.remember(pid, "w1", false, auto({ text: "review 输出按阻断/重要/次要排列" }));
  s.commit([{ kind: "relate", project_id: pid, session_id: null, target_id: relayed, body: { outcome: "refines", target: userRule, model: "m" } as never }], () => {});
  const lone = s.remember(pid, "w1", false, auto({ text: "只在派活提示里的规则" }));
  const plan = workerQuoteAudit(s.project().props.values(), () => null, () => true);
  assert.deepEqual(plan.demote.map((p) => p.id), [lone]);
});
