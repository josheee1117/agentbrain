import { test } from "node:test";
import assert from "node:assert/strict";
import { Store, type Embedder } from "./store.ts";
import type { RememberBody } from "./l2.ts";
import { buildViewData, pca2, renderHtml } from "./view.ts";

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
