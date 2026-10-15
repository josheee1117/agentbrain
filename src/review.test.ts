/** 审稿团：配置、解析、计票、仲裁、执行与撤销。运行：node --test src/review.test.ts */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "./store.ts";
import type { RememberBody } from "./l2.ts";
import type { Chat } from "./llm.ts";
import { retryPolicy, judgeBatch, judgeBatchPrimary, normalize, planAction, renderCandidates, unanimous, validateReviewConfig, type CandidateInput, type CallStat, type Judgement } from "./review.ts";
import { applyActions, connectPanel, planAll, runPanel, undoRun } from "./curate.ts";

retryPolicy.backoffMs = [0, 0];
retryPolicy.maxWaitMs = 1000;
const src: RememberBody["source"] = { host: "pi", session_id: "s", transcript: null, anchor: null, summary: "x" };
const cand = (id: string, over: Partial<CandidateInput> = {}): CandidateInput => ({ id, kind: "rule", scope: "global", project: null, text: `正文${id}`, context: null, worker: false, neighbors: [], ...over });
const reply = (verdicts: object[]): Chat => async () => ({ message: { role: "assistant", content: JSON.stringify({ verdicts }) }, tokens: 10 });

test("配置：成员字段齐全、不重名、仲裁是成员或单独的模型；默认批大小", () => {
  const m = (name: string) => ({ name, baseUrl: "http://x", model: "m", keyService: `agentbrain-${name}` });
  assert.match((validateReviewConfig({}) as any).error, /缺 panel/);
  assert.match((validateReviewConfig({ panel: [m("a"), m("a")], arbiter: "a" }) as any).error, /重名/);
  assert.match((validateReviewConfig({ panel: [m("a")], arbiter: "z" }) as any).error, /arbiter/);
  assert.match((validateReviewConfig({ panel: [{ ...m("a"), keyService: "" }], arbiter: "a" }) as any).error, /keyService/);
  const ok = validateReviewConfig({ panel: [m("a"), m("b"), m("c")], arbiter: "b" });
  assert.ok(!("error" in ok));
  assert.equal(ok.batchSize, 10);
  assert.equal(ok.arbiterMember.name, "b");
  const sep = validateReviewConfig({ panel: [m("a"), m("b"), m("c")], arbiter: m("s") });
  assert.ok(!("error" in sep) && sep.arbiter === "s" && sep.arbiterMember.model === "m", "仲裁可以是不参加投票的单独模型");
  assert.match((validateReviewConfig({ panel: [m("a")], arbiter: m("a") }) as any).error, /重名/);
  assert.match((validateReviewConfig({ panel: [m("a")], arbiter: { name: "s" } }) as any).error, /arbiter 缺 baseUrl/);
  assert.equal(ok.maxBatches, 3);
});

test("normalize：留下的必须有当…时场景和类别；keep 但原文没场景按改写；merge 要指向近邻", () => {
  const c = cand("x");
  const nb = new Map([["n1", "real-id"]]);
  assert.equal(normalize({ verdict: "keep", class: "A" }, c, nb), null, "没场景");
  assert.equal(normalize({ verdict: "keep", class: "none", scenario: "当写测试时" }, c, nb), null, "要留又说哪类都不是");
  const k = normalize({ verdict: "keep", class: "A", scenario: "当写测试时" }, c, nb)!;
  assert.equal(k.verdict, "rewrite");
  assert.equal(k.text, c.text);
  assert.equal(k.guidance, true);
  const k2 = normalize({ verdict: "keep", class: "C", scenario: "当写测试时" }, cand("y", { scenario: "当跑 e2e 时" }), nb)!;
  assert.equal(k2.verdict, "keep");
  assert.equal(normalize({ verdict: "merge", class: "B", scenario: "当x时", text: "t", into: "n9" }, c, nb), null);
  assert.equal(normalize({ verdict: "merge", class: "B", scenario: "当x时", text: "t", into: "n1" }, c, nb)!.into, "real-id");
  assert.equal(normalize({ verdict: "discard", class: "none" }, c, nb)!.verdict, "discard");
  assert.equal(normalize({ verdict: "maybe" }, c, nb), null);
});

test("unanimous：缺票、结论不同、改写文字不同都不算一致", () => {
  const d: Judgement = { verdict: "discard", class: "none", guidance: false, reason: "" };
  const k: Judgement = { verdict: "keep", class: "C", scenario: "当x时", guidance: false, reason: "" };
  const rw = (text: string): Judgement => ({ verdict: "rewrite", class: "A", scenario: "当x时", text, guidance: true, reason: "" });
  assert.equal(unanimous([d, d, d])?.verdict, "discard");
  assert.equal(unanimous([d, d, null]), null);
  assert.equal(unanimous([d, d, k]), null);
  assert.equal(unanimous([rw("a"), rw("b"), rw("a")]), null);
  assert.equal(unanimous([rw("a"), rw("a"), rw("a")])?.text, "a");
  assert.equal(unanimous([k, { ...k, guidance: true }, k])?.guidance, true);
});

test("审稿团：各成员看到同一份提示；一致的不仲裁，分歧的交仲裁，仲裁无效为未决", async () => {
  const seen: string[] = [];
  const spy = (inner: Chat): Chat => async (m, o) => {
    seen.push(m[1].content!);
    return inner(m, o);
  };
  const batch = [cand("a"), cand("b"), cand("c")];
  const all = [{ id: "c1", verdict: "discard", class: "none", reason: "流水账" }, { id: "c2", verdict: "discard", class: "none" }, { id: "c3", verdict: "discard", class: "none" }];
  const split = [{ id: "c1", verdict: "discard", class: "none" }, { id: "c2", verdict: "rewrite", class: "A", scenario: "当汇报时", text: "说人话" }, { id: "c3", verdict: "discard", class: "none" }];
  const panel = [{ name: "p1", chat: spy(reply(all)) }, { name: "p2", chat: spy(reply(split)) }, { name: "p3", chat: spy(reply(all)) }];
  let arbCalls = 0;
  const arbiter = {
    name: "p1",
    chat: (async (m) => {
      arbCalls++;
      assert.match(m[1].content!, /三位审稿人的意见/);
      return { message: { role: "assistant", content: m[1].content!.includes("正文b") ? JSON.stringify({ verdicts: [{ id: "c1", verdict: "rewrite", class: "A", scenario: "当汇报时", text: "说人话" }] }) : "不是 JSON" }, tokens: 5 };
    }) as Chat,
  };
  const stats: CallStat[] = [];
  const res = await judgeBatch(batch, panel, arbiter, stats);
  assert.equal(new Set(seen).size, 1, "三家拿到完全相同的输入、互不可见");
  assert.equal(arbCalls, 1);
  assert.deepEqual(res.map((r) => r.decision.route), ["unanimous", "arbiter", "unanimous"]);
  assert.equal(res[1].decision.final?.text, "说人话");
  assert.equal(stats.filter((s) => s.role === "judge").length, 3);
});

test("审稿人调用失败：重试一次后算弃权，交仲裁", async () => {
  let n = 0;
  const bad: Chat = async () => {
    n++;
    throw new Error("boom");
  };
  const ok = reply([{ id: "c1", verdict: "discard", class: "none" }]);
  const stats: CallStat[] = [];
  const [r] = await judgeBatch([cand("a")], [{ name: "x", chat: bad }, { name: "y", chat: ok }, { name: "z", chat: ok }], { name: "y", chat: ok }, stats);
  assert.equal(n, 2);
  assert.equal(r.decision.route, "arbiter");
  assert.equal(stats.filter((s) => !s.ok).length, 1);
});

test("近邻按候选各自编号，merge 只能并入本条的近邻；提示里标出用户确认和子代理来源", async () => {
  const { parseJudgements } = await import("./review.ts");
  const batch = [cand("a", { neighbors: [{ id: "N", text: "邻", confirmed_by_user: true }], worker: true }), cand("b", { neighbors: [{ id: "M", text: "邻2", confirmed_by_user: false }, { id: "N", text: "邻", confirmed_by_user: true }] })];
  const r = renderCandidates(batch);
  assert.equal(r.neighborIds.get("c1:n1"), "N");
  assert.equal(r.neighborIds.get("c2:n2"), "N");
  const inv = new Map<string, string>();
  const got = parseJudgements(JSON.stringify({ verdicts: [{ id: "c1", verdict: "merge", class: "B", scenario: "当x时", text: "t", into: "n2" }, { id: "c2", verdict: "merge", class: "B", scenario: "当x时", text: "t", into: "n1" }] }), r.ids, r.neighborIds, batch, inv);
  assert.equal(inv.get("a"), "merge_bad_target", "c1 没有 n2");
  assert.equal(got.get("b")?.into, "M");
  assert.match(r.prompt, /n1（用户确认）：邻/);
  assert.match(r.prompt, /派活提示/);
});

test("connectPanel：缺 key 的成员列进 missing", () => {
  const cfg = validateReviewConfig({ panel: ["a", "b", "c"].map((n) => ({ name: n, baseUrl: "http://x", model: "m", keyService: `k-${n}` })), arbiter: "a" });
  assert.ok(!("error" in cfg));
  const r = connectPanel(cfg, { read: (s) => (s === "k-b" ? { error: "钥匙串里没有 k-b" } : "key") });
  assert.equal(r.panel.length, 2);
  assert.deepEqual(r.missing, ["b: 钥匙串里没有 k-b"]);
  assert.equal(r.arbiter?.name, "a");
  const cfg2 = validateReviewConfig({ panel: ["a", "b", "c"].map((n) => ({ name: n, baseUrl: "http://x", model: "m", keyService: `k-${n}` })), arbiter: { name: "s", baseUrl: "http://x", model: "sol", keyService: "k-s" } });
  assert.ok(!("error" in cfg2));
  const r2 = connectPanel(cfg2, { read: () => "key" });
  assert.equal(r2.panel.length, 3);
  assert.equal(r2.arbiter?.name, "s");
});

test("执行与撤销：沉淀/改写/并入/丢弃都可逆；用户确认的不动；非候选跳过", async () => {
  const s = new Store(":memory:", ":memory:");
  const mk = (text: string, extra: Partial<RememberBody> = {}) => s.remember(null, "s", false, { kind: "rule", text, confirmed: false, candidate: true, source: src, ...extra });
  const keep = mk("keep", { trigger: "当汇报时" });
  const rew = mk("rew");
  const dis = mk("dis");
  const mer = mk("mer");
  const live = s.remember(null, "s", false, { kind: "rule", text: "live", confirmed: true, source: src });
  const userCand = mk("user");
  s.lifecycle("confirm", userCand, null, {}); // 用户确认：离开候选区
  const props0 = s.project().props;
  const verdicts = [
    { id: "c1", verdict: "keep", class: "A", scenario: "当汇报时" },
    { id: "c2", verdict: "rewrite", class: "B", scenario: "当设计监控时", text: "按需查到≠主动发现" },
    { id: "c3", verdict: "discard", class: "none", reason: "一次性" },
    { id: "c4", verdict: "merge", class: "A", scenario: "当x时", text: "合并", into: "n1" },
    { id: "c5", verdict: "discard", class: "none" },
  ];
  const inputs = [keep, rew, dis, mer, userCand].map((id) => cand(id, { scenario: props0.get(id)!.trigger, neighbors: id === mer ? [{ id: live, text: "live", confirmed_by_user: true }] : [] }));
  const j = reply(verdicts);
  const results = await runPanel(inputs, [{ name: "a", chat: j }, { name: "b", chat: j }, { name: "c", chat: j }], { name: "a", chat: j }, 10, []);
  const actions = planAll(results, props0);
  assert.deepEqual(actions.map((a) => a.op), ["promote", "rewrite", "discard", "merge", "skip"]);
  assert.equal((actions[3] as any).review, true, "并入用户确认的目标只进复核清单，不改目标");
  const before = JSON.stringify(props0.get(userCand));
  const applied = applyActions(s, "run1", actions, props0);
  const p1 = s.project().props;
  assert.equal(p1.get(keep)!.state, "active");
  assert.equal(p1.get(keep)!.guidance, true);
  assert.equal(p1.get(rew)!.state, "archived");
  const created = applied.find((a) => a.op === "rewrite")!.created!;
  assert.equal(p1.get(created)!.text, "按需查到≠主动发现");
  assert.equal(p1.get(created)!.trigger, "当设计监控时");
  assert.equal(p1.get(created)!.confirmed, false);
  assert.equal(p1.get(dis)!.state, "archived");
  assert.equal(p1.get(mer)!.merged_into, live);
  assert.equal(p1.get(live)!.text, "live", "目标正文不变");
  assert.equal(JSON.stringify(p1.get(userCand)), before, "用户确认的条目零改动");
  const n = undoRun(s, { run: "run1", at: "", dry_run: false, panel: [], arbiter: "a", results: [], stats: [], applied });
  assert.equal(n, 4);
  const p2 = s.project().props;
  for (const id of [keep, rew, dis, mer]) assert.equal(p2.get(id)!.state, "candidate", id);
  assert.equal(p2.get(keep)!.guidance, false);
  assert.equal(p2.get(created)!.state, "archived");
});

test("planAction：用户确认的条目、非候选一律 skip", () => {
  const s = new Store(":memory:", ":memory:");
  const a = s.remember(null, "s", false, { kind: "rule", text: "a", confirmed: true, source: src });
  const p = s.project().props.get(a)!;
  const res = { id: a, votes: [], decision: { route: "unanimous" as const, final: { verdict: "discard" as const, class: "none" as const, guidance: false, reason: "" } } };
  assert.equal(planAction(p, res, s.project().props).op, "skip");
});

test("curate 事件：promote 后再 unpromote 回候选；用户确认的忽略；从没候选过的不受 unpromote 影响", () => {
  const s = new Store(":memory:", ":memory:");
  const live = s.remember(null, "s", false, { kind: "rule", text: "a", confirmed: false, source: src });
  s.lifecycle("curate", live, null, { action: "unpromote", run: "r" });
  assert.equal(s.project().props.get(live)!.state, "active");
  const c = s.remember(null, "s", false, { kind: "rule", text: "c", confirmed: false, candidate: true, source: src });
  s.lifecycle("curate", c, null, { action: "promote", run: "r" });
  assert.equal(s.project().props.get(c)!.state, "active");
  s.lifecycle("curate", c, null, { action: "unpromote", run: "r" });
  assert.equal(s.project().props.get(c)!.state, "candidate");
});

test("429 退避重试后成功，不算失败；limit 限住并发", async () => {
  let n = 0;
  const flaky: Chat = async () => {
    if (n++ < 2) throw Object.assign(new Error("模型接口限流 429"), { code: "http_429" });
    return { message: { role: "assistant", content: JSON.stringify({ verdicts: [{ id: "c1", verdict: "discard", class: "none" }] }) }, tokens: 1 };
  };
  const ok = reply([{ id: "c1", verdict: "discard", class: "none" }]);
  const stats: CallStat[] = [];
  const [r] = await judgeBatch([cand("a")], [{ name: "x", chat: flaky }, { name: "y", chat: ok }, { name: "z", chat: ok }], { name: "y", chat: ok }, stats);
  assert.equal(r.decision.route, "unanimous");
  assert.equal(stats.filter((s) => !s.ok).length, 0);
  const { limit } = await import("./review.ts");
  const gate = limit(1);
  let active = 0, peak = 0;
  await Promise.all([1, 2, 3].map(() => gate(async () => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 5)); active--; })));
  assert.equal(peak, 1);
});

test("额度用完（要等的时间超过上限）：整次运行停下并报告恢复时间；普通 429 退避后成功", async () => {
  const { QuotaExhausted } = await import("./review.ts");
  let n = 0;
  const dead: Chat = async () => {
    n++;
    throw Object.assign(new Error("模型接口限流 429: You have exceeded the 5-hour usage quota"), { code: "http_429", retryAfterMs: 3_600_000 });
  };
  const ok = reply([{ id: "c1", verdict: "keep", class: "A" }]);
  await assert.rejects(
    judgeBatch([cand("a")], [{ name: "x", chat: dead }, { name: "y", chat: ok }, { name: "z", chat: ok }], { name: "y", chat: reply([]) }, []),
    (e: any) => e instanceof QuotaExhausted && e.member === "x" && typeof e.resetAt === "string",
  );
  assert.equal(n, 1, "不原地空转");
  let m = 0;
  const noHint: Chat = async () => {
    m++;
    throw Object.assign(new Error("模型接口限流 429"), { code: "http_429" });
  };
  await assert.rejects(judgeBatch([cand("a")], [{ name: "x", chat: noHint }, { name: "y", chat: ok }, { name: "z", chat: ok }], { name: "y", chat: reply([]) }, []), QuotaExhausted);
  assert.equal(m, 3, "退避表用完仍 429 才停");
});

test("无效票记下原因；三票都要留但写法不同 → 仲裁只定写法，判丢弃不执行", async () => {
  const ok = reply([{ id: "c1", verdict: "keep", class: "A" }]);
  const [r] = await judgeBatch([cand("a")], [{ name: "x", chat: ok }, { name: "y", chat: ok }, { name: "z", chat: reply([{ id: "c1", verdict: "discard", class: "none" }]) }], { name: "y", chat: reply([]) }, []);
  assert.equal(r.votes[0].invalid, "no_scenario");
  assert.equal(r.decision.route, "undecided");
  const rw = (t: string) => reply([{ id: "c1", verdict: "rewrite", class: "A", scenario: "当汇报时", text: t }]);
  let sys = "";
  const arb = (content: object): Chat => async (m) => {
    sys = m[0].content!;
    return { message: { role: "assistant", content: JSON.stringify({ verdicts: [content] }) }, tokens: 1 };
  };
  const panel = [{ name: "x", chat: rw("a") }, { name: "y", chat: rw("b") }, { name: "z", chat: rw("c") }];
  const [w] = await judgeBatch([cand("a")], panel, { name: "x", chat: arb({ id: "c1", verdict: "rewrite", class: "A", scenario: "当汇报时", text: "b" }) }, []);
  assert.equal(w.decision.route, "arbiter_wording");
  assert.match(sys, /不要再判 discard/);
  const [d] = await judgeBatch([cand("a")], panel, { name: "x", chat: arb({ id: "c1", verdict: "discard", class: "none" }) }, []);
  assert.equal(d.decision.route, "undecided");
});

test("parseRetryAfterMs：头里的秒数、正文里的重置时间、retry after", async () => {
  const { parseRetryAfterMs } = await import("./llm.ts");
  assert.equal(parseRetryAfterMs("5346", undefined), 5_346_000);
  const now = Date.parse("2026-10-14T19:00:00+08:00");
  assert.equal(parseRetryAfterMs(null, "It will reset at 2026-10-14 20:21:56 +0800 CST.", now), (60 + 21) * 60_000 + 56_000);
  assert.equal(parseRetryAfterMs(null, "please retry after 30s"), 30_000);
  assert.equal(parseRetryAfterMs(null, "nothing"), undefined);
});

test("上游 503 过载：退避重试后成功", async () => {
  let n = 0;
  const busy: Chat = async () => {
    if (n++ < 2) throw Object.assign(new Error("模型接口 HTTP 503: server_is_overloaded"), { code: "http_error" });
    return { message: { role: "assistant", content: JSON.stringify({ verdicts: [{ id: "c1", verdict: "discard", class: "none" }] }) }, tokens: 1 };
  };
  const ok = reply([{ id: "c1", verdict: "discard", class: "none" }]);
  const stats: CallStat[] = [];
  const [r] = await judgeBatch([cand("a")], [{ name: "x", chat: busy }, { name: "y", chat: ok }, { name: "z", chat: ok }], { name: "y", chat: ok }, stats);
  assert.equal(r.decision.route, "unanimous");
  assert.equal(n, 3);
});

test("primary 模式：配置校验；参考意见先跑并附给主审；结论只看主审，参考成员失败不挡执行", async () => {
  const m = (name: string) => ({ name, baseUrl: "http://x", model: "m", keyService: `k-${name}` });
  assert.match((validateReviewConfig({ mode: "primary", panel: [m("a"), m("b")], primary: "z" }) as any).error, /primary/);
  assert.match((validateReviewConfig({ mode: "vote", panel: [m("a")], arbiter: "a" }) as any).error, /mode/);
  const cfg = validateReviewConfig({ mode: "primary", panel: [m("a"), m("b"), m("c")], primary: "a" });
  assert.ok(!("error" in cfg) && cfg.mode === "primary" && cfg.primary === "a");
  let seen = "";
  let sys = "";
  const primary: Chat = async (msgs) => {
    sys = msgs[0].content!;
    seen = msgs[1].content!;
    return { message: { role: "assistant", content: JSON.stringify({ verdicts: [{ id: "c1", verdict: "discard", class: "none", reason: "流水账" }] }) }, tokens: 1 };
  };
  const adv = reply([{ id: "c1", verdict: "rewrite", class: "A", scenario: "当汇报时", text: "说人话", reason: "偏好" }]);
  const dead: Chat = async () => {
    throw new Error("boom");
  };
  const stats: CallStat[] = [];
  const [r] = await judgeBatchPrimary([cand("a")], { name: "a", chat: primary }, [{ name: "b", chat: adv }, { name: "c", chat: dead }], stats);
  assert.match(seen, /参考意见（不投票）/);
  assert.match(seen, /b：rewrite（A）.*说人话/);
  assert.match(seen, /c：（没给出有效意见）/);
  assert.match(sys, /不要因为多数意见就跟随/);
  assert.equal(r.decision.route, "primary");
  assert.equal(r.decision.final?.verdict, "discard");
  assert.deepEqual(r.votes.map((v) => [v.name, !!v.advisory]), [["a", false], ["b", true], ["c", true]]);
  const s = new Store(":memory:", ":memory:");
  const id = s.remember(null, "s", false, { kind: "rule", text: "x", confirmed: false, candidate: true, source: src });
  const plan = planAction(s.project().props.get(id)!, { ...r, id }, s.project().props);
  assert.equal(plan.op, "discard", "参考成员调用失败不挡主审的结论");
  const [u] = await judgeBatchPrimary([cand("a")], { name: "a", chat: dead }, [{ name: "b", chat: adv }], []);
  assert.equal(u.decision.route, "undecided");
});
