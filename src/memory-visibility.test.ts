import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "./store.ts";
import { buildViewData } from "./view.ts";
import { logInjections, logRecallRun, parseAbUsed, scanSession, sessionsToScan } from "./telemetry.ts";

const ctx = { host: "pi" as const, session_id: "visibility", transcript: null, project_id: null };
const at = (minute: number) => new Date(Date.UTC(2026, 9, 29, 1, minute));

test("新旧报告行兼容，明确未用与缺报告不同", () => {
  const expected = [{ id: "abcdef01", title: "临时库" }];
  assert.deepEqual(parseAbUsed("正文\n记忆：临时库 (abcdef01)"), expected);
  assert.deepEqual(parseAbUsed("记忆: 临时库（ABCDEF01）"), expected);
  assert.deepEqual(parseAbUsed("ab-used: 临时库 (abcdef01)"), expected);
  assert.equal(parseAbUsed("记忆：本轮未用"), null);
  assert.deepEqual(parseAbUsed("没有报告"), []);
});

test("交付或按轮记录都能进入扫描范围，不只召回命中", () => {
  const s = new Store(":memory:", ":memory:");
  try {
    logInjections(s.workDb, ctx, "search", ["abcdef01"], at(0));
    logRecallRun(s.workDb, { ...ctx, session_id: "round-only" }, "nohit", 0, 1, true, at(0));
    assert.deepEqual(sessionsToScan(s.workDb).map((x) => x.session_id).sort(), ["round-only", "visibility"]);
  } finally { s.close(); }
});

test("按最终回答记采用、明确未用、未报告，无法核对保留；关闭轮不算漏报", () => {
  const s = new Store(":memory:", ":memory:");
  try {
    const id = s.remember(null, null, false, { kind: "rule", text: "测试用临时库", confirmed: true, source: { host: null, session_id: null, transcript: null, anchor: null, summary: "fixture" } });
    logInjections(s.workDb, ctx, "search", [id], at(1));
    for (let i = 0; i < 5; i++) logRecallRun(s.workDb, ctx, "nohit", 0, 1, i !== 4, at(i * 10));
    const replies = [`记忆：临时库 (${id.slice(0, 8)})`, "记忆：本轮未用", "没有报告", "记忆：未知 (deadbeef)", "关闭时没有报告"];
    const turns = replies.flatMap((text, i) => [
      { anchor: `u${i}`, role: "user" as const, text: "问题", ts: at(i * 10).toISOString() },
      { anchor: `a${i}`, role: "assistant" as const, text, ts: at(i * 10 + 2).toISOString() },
    ]);
    for (let i = 0; i < 2; i++) scanSession(s.workDb, ctx.host, ctx.session_id, turns, (x) => s.project().props.get(x)?.text ?? null, null, at(59));
    const reports = s.workDb.prepare("SELECT status,queried FROM memory_reports ORDER BY ts").all();
    assert.deepEqual(reports.map((r) => r.status), ["used", "unused", "unreported", "used", "unreported"]);
    assert.equal(reports[0].queried, 1);
    const ids = s.workDb.prepare("SELECT short_id,verified FROM memory_report_ids ORDER BY short_id").all();
    assert.equal(ids.length, 2, "重复扫描不增加条数");
    assert.equal(ids.find((r) => r.short_id === "deadbeef")?.verified, 0);
    const metrics = buildViewData(s, at(59)).telemetry.memory;
    assert.equal(metrics.total, 4);
    assert.equal(metrics.reported, 3);
    assert.equal(metrics.adopted, 2);
    assert.equal(metrics.queried, 1);
    assert.equal(metrics.unverifiable, 1);
    assert.equal(metrics.last_scanned, at(59).toISOString());
  } finally { s.close(); }
});
