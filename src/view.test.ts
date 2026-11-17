import { test } from "node:test";
import assert from "node:assert/strict";
import { Store, type Embedder } from "./store.ts";
import type { RememberBody } from "./l2.ts";
import { buildViewData, graphLayout, pca2, renderHtml } from "./view.ts";
import { logInjections } from "./telemetry.ts";

const src: RememberBody["source"] = { host: "pi", session_id: "s1", transcript: null, anchor: null, summary: "讨论端口" };
const fakeEmbed: Embedder = async (texts) => texts.map((t) => Float32Array.from([/猫/.test(t) ? 1 : 0, /狗/.test(t) ? 1 : 0, /雨/.test(t) ? 1 : 0.1]));

test("buildViewData：状态、关系、近邻、PCA 坐标、默认含归档条目", async () => {
  const s = new Store(":memory:", ":memory:");
  const pid = s.ensureProject("proj");
  const a = s.remember(pid, "s1", false, { kind: "rule", text: "猫用 3100 端口", why: "避免冲突", confirmed: true, source: src });
  const b = s.remember(null, "s1", false, { kind: "note", text: "猫猫偏好", confirmed: false, origin: "extract", source: src,
    evidence: [{ anchor: "a1", role: "user", quote_sha256: "f".repeat(64) }] });
  const c = s.remember(pid, "s1", false, { kind: "decision", text: "狗下雨", confirmed: true, source: src });
  const d = s.remember(pid, "s1", false, { kind: "rule", text: "猫用 3200 端口", confirmed: true, supersedes: a, source: src });
  s.lifecycle("archive", c, "s1");
  await s.syncVectors(fakeEmbed, "fake");
  const v = buildViewData(s, new Date("2026-10-13T00:00:00Z"));
  assert.equal(v.counts.total, 4);
  assert.equal(v.counts.active, 2);
  assert.equal(v.counts.vectors, 4);
  const get = (id: string) => v.entries.find((e) => e.id === id)!;
  assert.equal(get(a).status, "user");
  assert.equal(get(a).state, "superseded");
  assert.deepEqual(get(a).links, [{ type: "superseded_by", id: d }]);
  assert.deepEqual(get(d).links, [{ type: "supersedes", id: a }]);
  assert.equal(get(b).status, "unconfirmed");
  assert.equal(get(b).project, "全局");
  assert.equal(get(b).origin, "extract");
  assert.equal(get(b).evidence[0].anchor, "a1");
  assert.equal(get(a).why, "避免冲突");
  assert.deepEqual(get(a).sessions, ["pi:s1"]);
  assert.equal(get(d).neighbors[0].similarity, 1, "同向量的相似度为 1");
  assert.ok(get(d).neighbors.length <= 5 && !get(d).neighbors.some((n) => n.id === d));
  assert.ok(v.entries.every((e) => e.xy && e.xy.every(Number.isFinite)));
});

test("pca2：沿方差最大方向展开", () => {
  const pts = pca2([0, 1, 2, 3].map((i) => Float32Array.from([i, 0, 0.01 * (i % 2)])));
  const xs = pts.map((p) => Math.abs(p[0]));
  assert.ok(Math.max(...xs) > 1.4);
  assert.deepEqual(pca2([]), []);
});

test("renderHtml：数据里的 </script> 被转义，页面不引外部资源", () => {
  const s = new Store(":memory:", ":memory:");
  s.remember(null, null, false, { kind: "note", text: "</script><img src=x>", confirmed: true, source: src });
  const html = renderHtml(buildViewData(s));
  assert.equal(html.match(/<\/script>/g)!.length, 2);
  assert.ok(!/https?:\/\//.test(html));
});

test("buildViewData：没生效的替代单独标出；按会话计注入；排除项目连带去掉关联", () => {
  const s = new Store(":memory:", ":memory:");
  const pid = s.ensureProject("proj");
  const other = s.ensureProject("secret-proj");
  const old = s.remember(pid, "s1", false, { kind: "rule", text: "旧规则", confirmed: true, source: src });
  const pending = s.remember(pid, "s1", false, { kind: "rule", text: "未确认的纠正", confirmed: false, supersedes: old, source: src });
  const hidden = s.remember(other, "s1", false, { kind: "note", text: "客户项目的事", confirmed: true, supersedes: old, source: src });
  const ctx = { host: "pi" as const, session_id: "s1", transcript: null, project_id: pid };
  logInjections(s.workDb, ctx, "recall", [old], new Date("2026-10-20T01:00:00Z"));
  logInjections(s.workDb, ctx, "recall", [old], new Date("2026-10-20T02:00:00Z"));
  logInjections(s.workDb, { host: null, session_id: null, transcript: null, project_id: pid }, "brief", [old], new Date("2026-10-20T03:00:00Z"));
  logInjections(s.workDb, { ...ctx, session_id: "s2" }, "recall", [old], new Date("2026-10-20T04:00:00Z"));
  const v = buildViewData(s, new Date("2026-10-21T00:00:00Z"));
  const get = (id: string) => v.entries.find((e) => e.id === id)!;
  assert.deepEqual(get(pending).links.filter((l) => l.type.startsWith("supersedes")), [{ type: "supersedes_pending", id: old }]);
  assert.deepEqual(get(hidden).links, [{ type: "supersedes", id: old }], "用户确认的纠正才算已生效的替代");
  assert.equal(get(old).state, "superseded");
  assert.equal(get(old).usage.inject_sessions, 2, "认不出会话的 brief 不算一个会话");
  assert.equal(get(old).usage.inject_total, 4);
  assert.deepEqual(get(old).usage.by_path, { recall: 3, brief: 1 });
  assert.ok(get(old).g, "带关联的条目有关联图坐标");
});

test("graphLayout：确定性、坐标有限、同一连通块的点比不同块的近", () => {
  const nodes = ["a", "b", "c", "d", "e"];
  const edges: [string, string][] = [["a", "b"], ["b", "c"], ["d", "e"]];
  const L1 = graphLayout(nodes, edges);
  assert.deepEqual([...L1], [...graphLayout(nodes, edges)]);
  assert.equal(L1.size, 5);
  assert.ok([...L1.values()].every((p) => p.every(Number.isFinite)));
  const dist = (x: string, y: string) => Math.hypot(L1.get(x)![0] - L1.get(y)![0], L1.get(x)![1] - L1.get(y)![1]);
  assert.ok(Math.max(dist("a", "b"), dist("a", "c")) < Math.min(dist("a", "d"), dist("c", "e")));
});

test("graphLayout：两千个点一条链也很快", () => {
  const nodes = Array.from({ length: 2000 }, (_, i) => `n${i}`);
  const t0 = performance.now();
  graphLayout(nodes, nodes.slice(1).map((n, i) => [nodes[i], n] as [string, string]));
  assert.ok(performance.now() - t0 < 500);
});

// ---------- §12.6.8 V1–V5 ----------

test("§12.6.8：看板数据带操作者、确认与写入两行、运行状况（代码、库、备份、没做成的窗口及原因）", async () => {
  const { mkdtempSync, realpathSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { backup } = await import("./admin.ts");
  const home = realpathSync(mkdtempSync(join(tmpdir(), "ab-view-ops-")));
  const s = new Store(join(home, "store.db"), join(home, "index.db"), { actor: "alice", machine: "mac-a" });
  const pid = s.ensureProject("proj");
  const u = s.remember(pid, "s1", false, { kind: "rule", text: "用户确认的规则", confirmed: true, source: src });
  const c = s.remember(pid, "s2", false, { kind: "pitfall", text: "模型抽出来的坑", confirmed: false, origin: "extract", source: { ...src, host: "claude", session_id: "s2" } });
  s.commit([{ kind: "verify", project_id: pid, session_id: null, target_id: c, body: { outcome: "verified", head: "abc", refs: [], model: "m" } }], () => {});
  const now = new Date("2026-11-17T10:00:00Z");
  const db = s.workDb;
  db.prepare("INSERT INTO capture_windows(window_id,host,session_id,from_anchor,to_anchor,state,attempts,error_code,receipt,updated_at,error_detail) VALUES('w1','claude','abcdef12-x',NULL,'u9','failed',4,'http_error',?,?,?)")
    .run(JSON.stringify({ chars: 47999 }), "2026-11-16T06:21:00.000Z", "模型接口 HTTP 413: input too long");
  db.prepare("INSERT INTO capture_windows(window_id,host,session_id,from_anchor,to_anchor,state,attempts,error_code,updated_at) VALUES('w2','pi','s3',NULL,'z','failed',4,'split',?)").run("2026-11-16T07:00:00.000Z");
  db.prepare("INSERT INTO events(id,ts,kind,body,body_hash) VALUES('e-unknown',?,'rescope','{}','x')").run(now.toISOString());
  const b = backup(s, home, now);
  const v = buildViewData(s, now, { home, code: { commit: "abc1234", branch: "feature-x", dirty: 1, root: "/repo/ab" } });

  const get = (id: string) => v.entries.find((e) => e.id === id)!;
  assert.equal(get(u).actor, "alice");
  assert.match(get(u).confirmed_line, /^用户确认 · alice@mac-a · \d{4}-\d\d-\d\d · 在 agent 会话 s1 里执行$/);
  assert.match(get(u).written, /^alice@mac-a · 在 pi 会话 s1 里执行 · /);
  assert.equal(get(c).status, "code");
  assert.match(get(c).confirmed_line, /^代码核验转正 · \d{4}-\d\d-\d\d（模型按仓库代码核对后转正，没有人确认过）$/);
  assert.match(get(c).written, /^alice@mac-a · 后台抽取，来自 claude 会话 s2 · /);

  assert.deepEqual(v.ops.code, { commit: "abc1234", branch: "feature-x", dirty: 1 });
  assert.deepEqual(v.ops.schema, { version: 1, supported: 1, readOnly: false });
  assert.equal(v.ops.events, 4);
  assert.equal(v.ops.unknown, 1);
  assert.equal(v.ops.backup!.count, 1);
  assert.ok(b.path.endsWith(v.ops.backup!.file) && !v.ops.backup!.file.includes("/"), "备份只给文件名，不带本机目录");
  assert.deepEqual(v.ops.windows.recent.map((p) => [p.host, p.state, p.code, p.chars, p.detail]), [["claude", "failed", "http_error", 47999, "模型接口 HTTP 413: input too long"]], "拆开重试的不列");
  assert.equal(v.ops.windows.failed, 1);

  const html = renderHtml(v);
  for (const piece of ['id="fw"', "全部操作者", "运行状况", "最近没做成的抽取窗口", "确认来源（有效条目）", "<b>确认：</b>", "<b>写入：</b>", "从有数据的第一天画起"]) assert.ok(html.includes(piece), piece);
  assert.ok(!html.includes("打开关联图 →"), "原来只有一个按钮的关系图卡片换掉了");
  assert.ok(!/(?:src|href)="(?!#)[^"]+"/.test(html) && !/https?:\/\//.test(html), "仍是单文件、不引外部资源");
  assert.ok(!html.includes(home), "页面里没有本机数据目录");
  s.close();
});

test("§12.6.8：不给 home 和 code 时运行状况照样有（库版本、窗口），备份和代码为空", () => {
  const s = new Store(":memory:", ":memory:");
  s.remember(null, null, false, { kind: "note", text: "一条", confirmed: true, source: src });
  const v = buildViewData(s);
  assert.equal(v.ops.code, null);
  assert.equal(v.ops.backup, null);
  assert.deepEqual(v.ops.windows, { failed: 0, deferred: 0, recent: [] });
  assert.ok(renderHtml(v).includes("还没有备份，运行 ab backup"));
});
