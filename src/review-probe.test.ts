import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "./store.ts";
import { logRecallRun, logInjections, markFailedTurns } from "./telemetry.ts";
test("probe: 失败回合后接一次 nohit 召回，nohit 那轮的回复不应算作救回失败回合", () => {
  const s = new Store(":memory:", ":memory:");
  const ctx = { host: "claude" as const, session_id: "s", transcript: null, project_id: null };
  logRecallRun(s.workDb, ctx, "hit", 1, 1, true, new Date("2026-10-21T01:00:00Z"));
  logInjections(s.workDb, ctx, "recall", ["aaaaaaaa"], new Date("2026-10-21T01:00:00Z"));
  logRecallRun(s.workDb, ctx, "nohit", 0, 1, true, new Date("2026-10-21T01:05:00Z"));
  const turns = [{ anchor: "a", role: "assistant" as const, text: "对第二个问题的回答", ts: "2026-10-21T01:06:00.000Z" }];
  assert.equal(markFailedTurns(s.workDb, "claude", "s", turns), 1);
});
