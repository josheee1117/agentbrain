import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "./store.ts";
import { buildViewData } from "./view.ts";
import type { RememberBody } from "./l2.ts";
import { CITE_INSTRUCTION, citeEnabled, logInjections, logRecallRun, markFailedTurns, parseAbUsed, prune, scanSession, setCite, stripAbUsed, titleOverlap, withCiteInstruction } from "./telemetry.ts";

const src: RememberBody["source"] = { host: "pi", session_id: "s1", transcript: null, anchor: null, summary: "测试" };

test("parseAbUsed：只认最后一行 ab-used，只取括号里的 8 位 id，中英文分隔与括号都认", () => {
  const text = "正文提到 ab-used: 旧的 (11111111) 不该算\n结论……\nab-used: 调 pi/codex 测试用临时库 (7f3c2a1b)；不跑 npm i（B81D44E7）; 没有 id 的段; 重复 (7f3c2a1b)";
  assert.deepEqual(parseAbUsed(text), [
    { id: "7f3c2a1b", title: "调 pi/codex 测试用临时库" },
    { id: "b81d44e7", title: "不跑 npm i" },
  ]);
  assert.deepEqual(parseAbUsed("`ab-used: 标题 (abcdef01)`"), [{ id: "abcdef01", title: "标题" }]);
  assert.deepEqual(parseAbUsed("没有标记的回复"), []);
  assert.deepEqual(parseAbUsed("ab-used: 括号里不是 id (7f3c2a1)"), [], "7 位不算");
});

test("stripAbUsed 只去掉标记行；withCiteInstruction 插在召回块闭合前，没召回块不动", () => {
  assert.equal(stripAbUsed("回答\nab-used: x (7f3c2a1b)"), "回答");
  const block = "<agentbrain-recall>\n- [7f3c2a1b] 规则: x\n</agentbrain-recall>\n";
  assert.equal(withCiteInstruction(block), `<agentbrain-recall>\n- [7f3c2a1b] 规则: x\n${CITE_INSTRUCTION}\n</agentbrain-recall>\n`);
  assert.equal(withCiteInstruction("<agentbrain-prefs>\nx\n</agentbrain-prefs>\n"), "<agentbrain-prefs>\nx\n</agentbrain-prefs>\n");
});

test("titleOverlap：贴切的意译高，无关的标题低", () => {
  const body = "调用 pi 或 codex 做测试时，AB_HOME 指到临时库，并用 </dev/null 关掉 stdin";
  assert.ok(titleOverlap("调 pi/codex 测试用临时库", body) >= 0.3);
  assert.ok(titleOverlap("数据库迁移要先备份", body) < 0.3);
});

test("cite 开关默认关，存在 work_meta", () => {
  const s = new Store(":memory:", ":memory:");
  assert.equal(citeEnabled(s.workDb), false);
  setCite(s.workDb, true);
  assert.equal(citeEnabled(s.workDb), true);
  setCite(s.workDb, false);
  assert.equal(citeEnabled(s.workDb), false);
});

test("scanSession：只认本会话此前注入过的召回条目；标题不符只标记；编造和别处注入的 id 丢弃；重复扫描不加倍", () => {
  const s = new Store(":memory:", ":memory:");
  const a = s.remember(null, null, false, { kind: "rule", text: "调用 pi 或 codex 做测试时，AB_HOME 指到临时库", confirmed: true, source: src });
  const b = s.remember(null, null, false, { kind: "pitfall", text: "不要在有全局软链的目录跑 npm i", confirmed: true, source: src });
  const c = s.remember(null, null, false, { kind: "rule", text: "别的会话才注入的条目", confirmed: true, source: src });
  const p = s.remember(null, null, false, { kind: "rule", text: "常驻偏好", confirmed: true, source: src });
  const ctx = { host: "pi" as const, session_id: "s1", transcript: null, project_id: null };
  logInjections(s.workDb, ctx, "recall", [a, b], new Date("2026-10-21T01:00:00Z"));
  logInjections(s.workDb, ctx, "pref", [p], new Date("2026-10-21T01:00:00Z"));
  logInjections(s.workDb, { ...ctx, session_id: "other" }, "recall", [c], new Date("2026-10-21T01:00:00Z"));
  const turns = [
    // 注入之前的回复引用 a：时间上不可能依据它，不算
    { anchor: "t0", role: "assistant" as const, text: `ab-used: 早到的 (${a.slice(0, 8)})`, ts: "2026-10-21T00:59:00.000Z" },
    { anchor: "t1", role: "user" as const, text: `ab-used: 用户说的不算 (${a.slice(0, 8)})`, ts: "2026-10-21T01:00:30.000Z" },
    { anchor: "t2", role: "assistant" as const, text: `好的\nab-used: 测试用临时库 (${a.slice(0, 8)})；数据库迁移先备份 (${b.slice(0, 8)})；别处的 (${c.slice(0, 8)})；编的 (deadbeef)；偏好 (${p.slice(0, 8)})`, ts: "2026-10-21T01:01:00.000Z" },
  ];
  const r = scanSession(s.workDb, "pi", "s1", turns, (id) => s.project().props.get(id)?.text ?? null, "cpa/glm-5.3", new Date("2026-10-21T02:00:00Z"));
  assert.deepEqual(r, { marked_turns: 1, cited: 2, dropped: 4, mismatched: 1 });
  const rows = s.workDb.prepare("SELECT prop_id,path,cited,title_mismatch,cited_title FROM inject_log WHERE session_id='s1' ORDER BY prop_id").all() as any[];
  const by = new Map(rows.map((x) => [x.prop_id, x]));
  assert.equal(by.get(a).cited, 1);
  assert.equal(by.get(a).title_mismatch, 0);
  assert.equal(by.get(b).cited, 1);
  assert.equal(by.get(b).title_mismatch, 1, "标题与正文无关：仍算引用，但标出不符");
  assert.equal(by.get(p).cited, 0, "常驻偏好不参与引用");
  const again = scanSession(s.workDb, "pi", "s1", turns, (id) => s.project().props.get(id)?.text ?? null, "cpa/glm-5.3", new Date("2026-10-21T02:00:00Z"));
  assert.equal(again.cited, 2);
  assert.equal((s.workDb.prepare("SELECT COUNT(*) AS n FROM inject_log WHERE cited=1").get() as any).n, 2);
  assert.deepEqual({ ...(s.workDb.prepare("SELECT model,marked_turns FROM cite_scan WHERE session_id='s1'").get() as any) }, { model: "cpa/glm-5.3", marked_turns: 1 });
});

test("prune：只删 90 天前的统计行", () => {
  const s = new Store(":memory:", ":memory:");
  const ctx = { host: "pi" as const, session_id: "s1", transcript: null, project_id: null };
  const now = new Date("2026-10-21T00:00:00Z");
  logInjections(s.workDb, ctx, "recall", ["x"], new Date(now.getTime() - 91 * 86_400_000));
  logInjections(s.workDb, ctx, "recall", ["y"], new Date(now.getTime() - 89 * 86_400_000));
  logRecallRun(s.workDb, ctx, "hit", 1, 10, false, new Date(now.getTime() - 91 * 86_400_000));
  logRecallRun(s.workDb, ctx, "nohit", 0, 10, false, now);
  assert.equal(prune(s.workDb, now), 2);
  assert.deepEqual((s.workDb.prepare("SELECT prop_id FROM inject_log").all() as any[]).map((r) => r.prop_id), ["y"]);
  assert.deepEqual((s.workDb.prepare("SELECT outcome FROM recall_runs").all() as any[]).map((r) => r.outcome), ["nohit"]);
});

test("模型调用失败的回合（召回后没有助手回复）不进标注率分母、不算命中、不算注入用量", () => {
  const s = new Store(":memory:", ":memory:");
  const a = s.remember(null, null, false, { kind: "rule", text: "调用 pi 或 codex 做测试时，AB_HOME 指到临时库", confirmed: true, source: src });
  const ctx = { host: "claude" as const, session_id: "s9", transcript: null, project_id: null };
  const t1 = new Date("2026-10-21T01:00:00Z"); // 这一轮额度用尽，模型没回答
  const t2 = new Date("2026-10-21T01:05:00Z"); // 重试成功
  for (const t of [t1, t2]) {
    logRecallRun(s.workDb, ctx, "hit", 1, 10, true, t);
    logInjections(s.workDb, ctx, "recall", [a], t);
  }
  // 失败那轮宿主写的提示已在 transcript 解析时丢掉，所以这里 01:00–01:05 之间没有助手回复
  const turns = [
    { anchor: "u1", role: "user" as const, text: "问题", ts: "2026-10-21T01:00:00.000Z" },
    { anchor: "u2", role: "user" as const, text: "问题", ts: "2026-10-21T01:05:00.000Z" },
    { anchor: "a2", role: "assistant" as const, text: `回答\nab-used: 测试用临时库 (${a.slice(0, 8)})`, ts: "2026-10-21T01:06:00.000Z" },
  ];
  scanSession(s.workDb, "claude", "s9", turns, (id) => s.project().props.get(id)?.text ?? null, "claude-opus-5-5", new Date("2026-10-21T02:00:00Z"));
  const d = buildViewData(s, new Date("2026-10-21T02:00:00Z"));
  const h = d.telemetry.hosts.find((x) => x.host === "claude")!;
  assert.equal(h.recall_turns, 1, "分母只算模型回答了的那轮");
  assert.equal(h.marked_turns, 1);
  assert.equal(d.telemetry.recall_runs.hit, 1);
  assert.equal(d.telemetry.recall_runs.model_failed, 1);
  const e = d.entries.find((x) => x.id === a)!;
  assert.equal(e.usage.inject_total, 1, "失败那轮的注入不算用量");
  assert.equal(e.usage.cited_total, 1);
});

test("对话里一条带时间的回复都没有时判断不了失败，保持原样（不把整段会话当失败）", () => {
  const s = new Store(":memory:", ":memory:");
  const ctx = { host: "codex" as const, session_id: "s8", transcript: null, project_id: null };
  logRecallRun(s.workDb, ctx, "hit", 1, 10, true, new Date("2026-10-21T01:00:00Z"));
  assert.equal(markFailedTurns(s.workDb, "codex", "s8", [{ anchor: "0", role: "assistant", text: "回答" }]), 0);
  assert.equal((s.workDb.prepare("SELECT failed FROM recall_runs").get() as any).failed, 0);
});
