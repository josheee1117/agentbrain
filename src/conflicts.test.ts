import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Store } from "./store.ts";
import { fold, type EventRow, type RememberBody, type RelateBody } from "./l2.ts";
import { brief } from "./brief.ts";
import { guidanceBlock } from "./recall.ts";
import { disputed } from "./present.ts";
import { isConfirmedCorrection, recallable } from "./visibility.ts";
import { statusReport, type StatusContext } from "./status.ts";

const isolated = realpathSync(mkdtempSync(join(tmpdir(), "ab-conflicts-env-")));
process.env.HOME = isolated;
process.env.AB_HOME = join(isolated, "store");
process.env.AB_REGISTRY = join(isolated, "repos");
mkdirSync(process.env.AB_REGISTRY);

const source: RememberBody["source"] = { host: null, session_id: null, transcript: null, anchor: null, summary: "冲突验收" };
const remember = (id: string, seq: number, extra: Partial<RememberBody> = {}): EventRow => ({
  id, seq, ts: "2026-11-01T00:00:00.000Z", kind: "remember", project_id: null, session_id: null, ephemeral: 0, target_id: null,
  body: JSON.stringify({ kind: "rule", text: id, confirmed: true, source, ...extra }),
});
const relate = (id: string, other: string, seq: number, outcome: RelateBody["outcome"] = "conflicts", ts = "2026-11-02T00:00:00.000Z"): EventRow => ({
  id: `relate-${seq}`, seq, ts, kind: "relate", project_id: null, session_id: null, ephemeral: 0, target_id: id,
  body: JSON.stringify({ outcome, target: other, reason: "验收", model: "fixture" }),
});

test("同一条同时保留多对冲突，两端都可见，且不冒充待确认纠正", () => {
  const p = fold([remember("A", 1), remember("B", 2), remember("C", 3), relate("A", "B", 4), relate("A", "C", 5)]).props;
  assert.deepEqual(p.get("A")!.conflicts, ["B", "C"]);
  assert.deepEqual(p.get("B")!.conflicts, ["A"]);
  assert.deepEqual(p.get("C")!.conflicts, ["A"]);
  for (const x of p.values()) assert.deepEqual(x.pending_corrections, []);
});

test("同一对按 seq 最新判定，反方向 refines 只解除这一对", () => {
  const rows = [remember("A", 1), remember("B", 2), remember("C", 3), relate("A", "B", 4), relate("A", "C", 5)];
  for (const [a, b] of [["A", "B"], ["B", "A"]]) {
    const p = fold([...rows, relate(a, b, 6, "refines", "2026-10-01T00:00:00.000Z")]).props;
    assert.deepEqual(p.get("A")!.conflicts, ["C"]);
    assert.deepEqual(p.get("B")!.conflicts, []);
    assert.deepEqual(p.get("C")!.conflicts, ["A"]);
  }
});

test("remember.relation 也参与按对判定，归档、恢复和确认替代按最终 active 状态取冲突", () => {
  const rows = [remember("A", 1), remember("B", 2, { relation: { type: "conflicts", target: "A" } })];
  assert.deepEqual(fold(rows).props.get("A")!.conflicts, ["B"]);
  assert.deepEqual(fold([...rows, relate("A", "B", 3, "refines")]).props.get("A")!.conflicts, []);
  const archive: EventRow = { ...relate("B", "A", 3), kind: "archive", body: "{}" };
  assert.deepEqual(fold([...rows, archive]).props.get("A")!.conflicts, []);
  assert.deepEqual(fold([...rows, archive, { ...archive, id: "restore", seq: 4, kind: "reactivate" }]).props.get("A")!.conflicts, ["B"]);
  assert.deepEqual(fold([...rows, remember("replacement", 3, { supersedes: "B" })]).props.get("A")!.conflicts, []);
  assert.deepEqual(fold([remember("A", 1), { ...relate("A", "missing", 2), ephemeral: 1 }]).props.get("A")!.conflicts, []);
});

test("brief 将普通冲突和真正未确认纠正分开写", () => {
  const s = new Store(":memory:", ":memory:");
  try {
    const a = s.remember(null, null, false, { kind: "rule", text: "重试三次", confirmed: true, source });
    const b = s.remember(null, null, false, { kind: "rule", text: "重试五次", confirmed: false, source, relation: { type: "conflicts", target: a } });
    assert.equal(disputed(s.project().props.get(a)!), `（与 [${b.slice(0, 8)}] 冲突）`);
    const c = s.remember(null, null, false, { kind: "rule", text: "重试两次", confirmed: false, source, supersedes: a });
    const text = brief(s, "/", undefined, false);
    assert.match(text, new RegExp(`与 \\[${b.slice(0, 8)}\\] 冲突`));
    assert.match(text, new RegExp(`有待确认的纠正 \\[${c.slice(0, 8)}\\]`));
    assert.doesNotMatch(text, new RegExp(`有待确认的纠正 \\[${b.slice(0, 8)}\\]`));
  } finally { s.close(); }
});

test("冲突不改变常驻偏好和纠正保底资格，双方未确认的条目仍不主动注入", () => {
  const rows = [remember("old", 1), remember("A", 2, { guidance: true, supersedes: "old" }), remember("B", 3, { confirmed: false, guidance: true })];
  for (const [from, to] of [["B", "A"], ["A", "B"]]) {
    const props = fold([...rows, relate(from, to, 4)]).props;
    assert.equal(guidanceBlock(props.values(), false), "");
    assert.equal(recallable(props.get("B")!, false), false);
    assert.equal(isConfirmedCorrection(props.get("A")!), false);
    for (const [id, p] of props) {
      const pending = id === to ? [from] : p.pending_corrections;
      const directedConflict = id === from ? to : null;
      assert.equal(isConfirmedCorrection(p), p.confirmed && !!p.supersedes && !pending.length && !directedConflict);
    }
  }
});

test("status 按最新冲突时间报最老天数，按日志行去重计注入，归档和恢复改变对数", () => {
  const s = new Store(":memory:", ":memory:");
  const ctx: StatusContext = { cwd: "/", userHome: "/nonexistent", storeHome: ":memory:", host: { ok: true, detection: null }, embedder: null, embedReason: "未配置", chatConfig: { error: "未配置" }, now: new Date("2026-11-09T00:00:00.000Z") };
  try {
    assert.match(statusReport(s, ctx), /^冲突 0 对$/m);
    const a = s.remember(null, null, false, { kind: "rule", text: "A", confirmed: true, source });
    const b = s.remember(null, null, false, { kind: "rule", text: "B", confirmed: true, source });
    const c = s.remember(null, null, false, { kind: "rule", text: "C", confirmed: true, source });
    const verdicts = [relate(a, b, 4), relate(a, c, 5, "conflicts", "2026-11-04T00:00:00.000Z"), relate(b, a, 6, "conflicts", "2026-11-03T00:00:00.000Z")];
    s.commit(verdicts.map((r) => ({ kind: "relate", project_id: null, session_id: null, target_id: r.target_id, body: JSON.parse(r.body!) })), (db, ids) => {
      ids.forEach((id, i) => db.prepare("UPDATE events SET ts=? WHERE id=?").run(verdicts[i].ts, id));
    });
    const inject = s.workDb.prepare("INSERT INTO inject_log(ts,prop_id,path) VALUES(?,?,'brief')");
    for (const [id, ts] of [[a, "2026-11-02"], [b, "2026-11-03T00:00:00.000Z"], [a, "2026-11-05"], [b, "2026-11-05"], [c, "2026-11-05"]]) inject.run(ts, id);
    assert.match(statusReport(s, ctx), /^冲突 2 对，最老 6 天，挂着期间被注入 3 次；处理：ab get 看双方，ab archive 错的一条$/m);
    s.lifecycle("archive", b, null);
    assert.match(statusReport(s, ctx), /^冲突 1 对，最老 5 天，挂着期间被注入 2 次/m);
    s.lifecycle("reactivate", b, null);
    assert.match(statusReport(s, ctx), /^冲突 2 对，最老 6 天，挂着期间被注入 3 次/m);
  } finally { s.close(); }
});

test("真实 CLI 显示多对冲突，反向改判、归档、恢复形成闭环", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ab-conflicts-")));
  const home = join(dir, "store"), fakeHome = join(dir, "home"), repos = join(dir, "repos");
  for (const d of [home, fakeHome, repos]) mkdirSync(d);
  writeFileSync(join(repos, "conflicts.md"), `- 路径：\`${dir}\`\n`);
  const s = new Store(join(home, "store.db"), join(home, "index.db"));
  const pid = s.ensureProject("conflicts");
  const put = (text: string) => s.remember(pid, null, false, { kind: "rule", text, confirmed: true, source });
  const a = put("冲突验收规则 A"), b = put("冲突验收规则 B"), c = put("冲突验收规则 C");
  s.commit([a, a].map((id, i) => ({ kind: "relate", project_id: pid, session_id: null, target_id: id, body: { outcome: "conflicts", target: i ? c : b, reason: "验收", model: "fixture" } })), () => {});
  const cli = (args: string[]) => {
    const r = spawnSync(process.execPath, [join(import.meta.dirname, "cli.ts"), ...args], { cwd: dir, env: { ...process.env, AB_HOME: home, AGENTBRAIN_HOME: home, AB_REGISTRY: repos, HOME: fakeHome, NODE_OPTIONS: "", PI_SESSION_ID: "", CLAUDE_SESSION_ID: "", CODEX_SESSION_ID: "" }, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  try {
    for (const [id, others] of [[a, [b, c]], [b, [a]], [c, [a]]] as const) {
      const out = cli(["get", id]);
      for (const other of others) assert.ok(out.includes(`与 [${other.slice(0, 8)}] 冲突`), out);
      assert.doesNotMatch(out, /待确认的纠正/);
    }
    assert.match(cli(["search", "冲突验收"]), /与 \[[0-9a-f]{8}\] 冲突/);
    assert.match(cli(["brief", "conflicts"]), /与 \[[0-9a-f]{8}\] 冲突/);
    assert.match(cli(["status"]), /^冲突 2 对/m);
    cli(["archive", b]);
    assert.match(cli(["status"]), /^冲突 1 对/m);
    assert.ok(!cli(["search", "冲突验收"]).includes(`\n[${b.slice(0, 8)}]`));
    assert.ok(!cli(["get", a]).includes(`[${b.slice(0, 8)}]`));
    cli(["archive", "--reactivate", b]);
    assert.match(cli(["status"]), /^冲突 2 对/m);
    assert.ok(cli(["get", a]).includes(`与 [${b.slice(0, 8)}] 冲突`));
    s.commit([{ kind: "relate", project_id: pid, session_id: null, target_id: b, body: { outcome: "refines", target: a, reason: "反向改判", model: "fixture" } }], () => {});
    const out = cli(["get", a]);
    assert.ok(!out.includes(`与 [${b.slice(0, 8)}] 冲突`));
    assert.ok(out.includes(`与 [${c.slice(0, 8)}] 冲突`));
    assert.match(cli(["status"]), /^冲突 1 对/m);
  } finally { s.close(); rmSync(dir, { recursive: true, force: true }); }
});
