import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.ts";
import { cleanTranscript, type Turn } from "./transcript.ts";
import { logInjections, logQuery, logRecallRun, parseAbUsed, scanSession, sessionsToScan } from "./telemetry.ts";
import { buildViewData } from "./view.ts";

const ctx = { host: "pi" as const, session_id: "review", transcript: null, project_id: null };
const ts = (s: number) => new Date(Date.UTC(2026, 9, 29, 1, 0, s));
const turn = (anchor: string, role: Turn["role"], text: string, s: number, final = role === "assistant"): Turn => ({ anchor, role, text, ts: ts(s).toISOString(), ...(role === "assistant" ? { final } : {}) });
const scan = (s: Store, turns: Turn[]) => scanSession(s.workDb, "pi", "review", turns, () => "临时库", null, ts(3600));
const rows = (s: Store) => s.workDb.prepare("SELECT anchor,cite,status,queried FROM memory_reports ORDER BY ts").all().map((r) => ({ ...r }));

function transcript(host: "pi" | "claude" | "codex", entries: unknown[]) {
  const path = join(mkdtempSync(join(tmpdir(), "ab-final-")), `${host}.jsonl`);
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n"));
  return cleanTranscript(host, path).turns;
}

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
  logInjections(s.workDb, ctx, "search", ["abcdef01"], ts(0));
  logRecallRun(s.workDb, { ...ctx, session_id: "round-only" }, "nohit", 0, 1, true, ts(0));
  assert.deepEqual(sessionsToScan(s.workDb).map((x) => x.session_id).sort(), ["review", "round-only"]);
  s.close();
});

test("无法核对保留，关闭轮不算漏报，重复扫描不增加条数", () => {
  const s = new Store(":memory:", ":memory:");
  logRecallRun(s.workDb, ctx, "nohit", 0, 1, true, ts(0));
  logRecallRun(s.workDb, ctx, "nohit", 0, 1, false, ts(10));
  const turns = [turn("u1", "user", "问题", 0), turn("a1", "assistant", "记忆：未知 (deadbeef)", 2), turn("u2", "user", "问题2", 10), turn("a2", "assistant", "没有报告", 12)];
  scan(s, turns);
  scan(s, turns);
  assert.equal(s.workDb.prepare("SELECT COUNT(*) AS n FROM memory_report_ids WHERE verified=0").get()?.n, 1);
  const metrics = buildViewData(s, ts(3600)).telemetry.memory;
  assert.equal(metrics.total, 1);
  assert.equal(metrics.adopted, 1);
  assert.equal(metrics.unverifiable, 1);
  s.close();
});

test("final：Pi 进度、工具、失败和仍在运行的轮不结算，只有 stop 回答结算", () => {
  const entries = [
    { type: "message", id: "u", parentId: null, timestamp: ts(0), message: { role: "user", content: "问题" } },
    { type: "message", id: "p", parentId: "u", timestamp: ts(1), message: { role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "记忆：临时库 (abcdef01)" }, { type: "toolCall", id: "c", name: "bash", arguments: { command: "true" } }] } },
    { type: "message", id: "t", parentId: "p", timestamp: ts(2), message: { role: "toolResult", content: "ok" } },
  ];
  const s = new Store(":memory:", ":memory:");
  logRecallRun(s.workDb, ctx, "nohit", 0, 1, true, ts(0));
  for (const end of [[], [{ type: "message", id: "e", parentId: "t", timestamp: ts(3), message: { role: "assistant", stopReason: "error", content: [] } }]]) {
    const turns = transcript("pi", [...entries, ...end]);
    assert.ok(turns.filter((t) => t.role === "assistant").every((t) => t.final !== true));
    scan(s, turns);
    assert.deepEqual(rows(s), []);
  }
  const turns = transcript("pi", [...entries, { type: "message", id: "a", parentId: "t", timestamp: ts(4), message: { role: "assistant", stopReason: "stop", content: "记忆：本轮未用" } }]);
  assert.equal(turns.at(-1)?.final, true);
  scan(s, turns);
  assert.equal(rows(s)[0].status, "unused");
  s.close();
});

test("final：Claude 只认 end_turn，Codex 只认 final_answer 或无错误 task_complete", () => {
  const claude = transcript("claude", [
    { type: "user", uuid: "u", timestamp: ts(0), message: { content: "问题" } },
    { type: "assistant", uuid: "p", timestamp: ts(1), message: { content: "进度", stop_reason: "tool_use" } },
    { type: "assistant", uuid: "a", timestamp: ts(2), message: { content: "回答", stop_reason: "end_turn" } },
  ]);
  assert.deepEqual(claude.filter((t) => t.role === "assistant").map((t) => t.final === true), [false, true]);
  const message = (phase?: string) => ({ type: "response_item", timestamp: ts(1), payload: { type: "message", role: "assistant", phase, content: [{ text: "回答" }] } });
  assert.equal(transcript("codex", [message("commentary")])[0].final === true, false);
  assert.equal(transcript("codex", [message("final_answer")])[0].final, true);
  assert.equal(transcript("codex", [message(), { type: "event_msg", timestamp: ts(2), payload: { type: "task_complete", last_agent_message: "回答" } }]).filter((t) => t.final).length, 1);
  assert.equal(transcript("codex", [message("commentary"), { type: "event_msg", timestamp: ts(2), payload: { type: "task_complete", last_agent_message: "回答", error: { message: "quota" } } }]).filter((t) => t.final).length, 0);
});

test("报告只用当前轮的钩子和查询，斜杠命令与无钩子轮不借上一轮开关", () => {
  const s = new Store(":memory:", ":memory:");
  logRecallRun(s.workDb, ctx, "nohit", 0, 1, true, ts(0));
  logInjections(s.workDb, ctx, "search", ["abcdef01"], ts(1));
  scan(s, [turn("u1", "user", "问题", 0), turn("a1", "assistant", "记忆：本轮未用", 2), turn("u2", "user", "/command", 4), turn("a2", "assistant", "完成", 5), turn("u3", "user", "没钩子", 6), turn("a3", "assistant", "完成", 7)]);
  assert.deepEqual(rows(s), [
    { anchor: "a1", cite: 1, status: "unused", queried: 1 },
    { anchor: "a2", cite: 0, status: "unreported", queried: 0 },
    { anchor: "a3", cite: 0, status: "unreported", queried: 0 },
  ]);
  s.close();
});

test("一个钩子只匹配一个用户轮，当前轮关闭开关时不沿用上一轮", () => {
  const s = new Store(":memory:", ":memory:");
  logRecallRun(s.workDb, ctx, "nohit", 0, 1, true, ts(0));
  logRecallRun(s.workDb, ctx, "nohit", 0, 1, false, ts(4));
  scan(s, [turn("u1", "user", "问题", 0), turn("a1", "assistant", "完成", 2), turn("u2", "user", "问题2", 4), turn("a2", "assistant", "完成", 5)]);
  assert.deepEqual(rows(s).map((r) => r.cite), [1, 0]);
  s.close();
});

test("引用和报告共用最终回答，重扫清掉上一次派生引用并在同一事务回滚", () => {
  const s = new Store(":memory:", ":memory:");
  logRecallRun(s.workDb, ctx, "hit", 1, 1, true, ts(0));
  logInjections(s.workDb, ctx, "search", ["abcdef01"], ts(1));
  const user = turn("u", "user", "问题", 0);
  const cited = turn("a", "assistant", "记忆：临时库 (abcdef01)", 5);
  scan(s, [user, cited]);
  assert.equal(s.workDb.prepare("SELECT cited FROM inject_log").get()?.cited, 1);
  scan(s, [user, turn("p", "assistant", "记忆：临时库 (abcdef01)", 2, false), turn("a", "assistant", "记忆：本轮未用", 5)]);
  assert.equal(rows(s)[0].status, "unused");
  assert.equal(s.workDb.prepare("SELECT cited FROM inject_log").get()?.cited, 0);
  assert.equal(s.workDb.prepare("SELECT cited_at FROM inject_log").get()?.cited_at, null);
  scan(s, [user, cited]);
  s.workDb.exec("CREATE TRIGGER fail_report BEFORE INSERT ON memory_reports BEGIN SELECT RAISE(ABORT,'test rollback'); END");
  assert.throws(() => scan(s, [user, turn("a", "assistant", "记忆：本轮未用", 5)]), /test rollback/);
  assert.equal(s.workDb.prepare("SELECT cited FROM inject_log").get()?.cited, 1);
  assert.equal(rows(s)[0].status, "used");
  s.close();
});

test("只有零结果查询的会话也扫描，查询不串到紧接的下一轮", () => {
  const s = new Store(":memory:", ":memory:");
  logQuery(s.workDb, ctx, "search", ts(1));
  assert.deepEqual(sessionsToScan(s.workDb).map((r) => r.session_id), ["review"]);
  scan(s, [turn("u", "user", "问题", 0), turn("a", "assistant", "记忆：本轮未用", 2), turn("u2", "user", "继续", 3), turn("a2", "assistant", "完成", 4)]);
  assert.deepEqual(rows(s).map((r) => r.queried), [1, 0]);
  s.close();
});

test("失败轮占用自己的钩子，下一轮不能借用", () => {
  const s = new Store(":memory:", ":memory:");
  logRecallRun(s.workDb, ctx, "nohit", 0, 1, true, ts(1));
  scan(s, [turn("u1", "user", "问题", 0), turn("p", "assistant", "进度", 2, false), turn("u2", "user", "再试", 3), turn("a", "assistant", "完成", 4)]);
  assert.deepEqual(rows(s), [{ anchor: "a", cite: 0, status: "unreported", queried: 0 }]);
  s.close();
});

test("宿主验证只有一个技能驱动，驱动的结果断言拒绝错误退出码和错误统计", async () => {
  const root = join(import.meta.dirname, "..");
  assert.equal(existsSync(join(root, "scripts/verify-codex.ts")), false);
  assert.equal(existsSync(join(root, "scripts/run-all-host-verification.ts")), false);
  const path = join(root, ".agents/skills/verify-agentbrain/hosts.ts");
  assert.equal(existsSync(path), true);
  const { assertScenario, hostEnv } = await import(path);
  const env = hostEnv({ AB_HOME: "/test/store", AB_REGISTRY: "/test/repos" });
  assert.equal(env.AB_HOME, "/test/store");
  assert.equal(env.AB_REGISTRY, "/test/repos");
  const expected = { status: "used", queried: 1, id: "abcdef01" };
  const reports = [{ status: "used", queried: 1, cite: 1 }];
  const ids = [{ short_id: "abcdef01", verified: 1 }];
  assertScenario(0, reports, ids, expected);
  assert.throws(() => assertScenario(1, reports, ids, expected));
  assert.throws(() => assertScenario(0, [{ ...reports[0], queried: 0 }], ids, expected));
  assert.throws(() => assertScenario(0, reports, [{ ...ids[0], verified: 0 }], expected));
  assert.throws(() => assertScenario(0, [], [], expected));
  assert.ok(readFileSync(path, "utf8").includes('"-readonly"'));
});
