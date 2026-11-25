import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.ts";
import type { ConfirmedBy, PropKind, RememberBody } from "./l2.ts";
import { brief, BRIEF_MAX_CHARS } from "./brief.ts";
import { guidanceBlock, GUIDANCE_MAX_CHARS, recall } from "./recall.ts";
import { isConfirmedCorrection, recallable, searchable } from "./visibility.ts";
import { reviewList } from "./expiry.ts";
import { statusReport } from "./status.ts";
import { logInjections } from "./telemetry.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "ab-stale-")));
const repos = join(dir, "pm/repos"), alpha = join(dir, "alpha");
for (const p of [repos, alpha]) mkdirSync(p, { recursive: true });
writeFileSync(join(repos, "alpha.md"), `- 路径：\`${alpha}\`\n`);
const oldEnv = { HOME: process.env.HOME, AB_HOME: process.env.AB_HOME, AGENTBRAIN_HOME: process.env.AGENTBRAIN_HOME, AB_REGISTRY: process.env.AB_REGISTRY };
process.env.HOME = dir;
process.env.AB_HOME = process.env.AGENTBRAIN_HOME = join(dir, "ab");
process.env.AB_REGISTRY = repos;
after(() => {
  for (const [k, v] of Object.entries(oldEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(dir, { recursive: true, force: true });
});
const source: RememberBody["source"] = { host: null, session_id: null, transcript: null, anchor: null, summary: "回归" };
const head = "abcdef0123456789abcdef0123456789abcdef01";
const verify = (s: Store, id: string, outcome: "verified" | "contradicted") => s.commit([{ kind: "verify", project_id: s.project().props.get(id)!.project_id, session_id: null, target_id: id, body: { outcome, head, refs: [], model: "fixture" } }], () => {});

for (const trust of ["user", "corroboration", "code", null] satisfies (ConfirmedBy | null)[]) {
  test(`stale ${trust ?? "未确认"}：brief、scene、recall、guidance、status 与注入日志`, async () => {
    const s = new Store(":memory:", ":memory:");
    try {
      const id = s.remember(null, null, false, { kind: "rule", text: "缓存守卫规则", source, confirmed: trust === "user", for_workers: true, guidance: true });
      if (trust && trust !== "user") s.lifecycle("confirm", id, null, { by: trust });
      verify(s, id, "contradicted");
      const warning = trust === "user" || trust === "corroboration";
      const prefix = "[与代码不符@abcdef0，待用户核实] ";
      for (const worker of [false, true]) {
        const used: string[] = [];
        const out = brief(s, alpha, undefined, worker, used);
        assert.equal(out.includes("缓存守卫规则"), warning);
        assert.equal(out.includes(prefix + "缓存守卫规则"), warning);
        assert.equal(out.includes("与代码不符 1 条（待用户核实）"), warning);
        assert.equal(used.includes(id), warning);
        const shown: string[] = [];
        const recalled = await recall(s, "缓存守卫规则", alpha, () => null, shown, [], undefined, worker);
        assert.equal(recalled.includes(prefix + "缓存守卫规则"), warning);
        assert.equal(shown.includes(id), warning);
        const prefs: string[] = [];
        const guidance = guidanceBlock(s.project().props.values(), worker, new Set(), prefs);
        assert.equal(guidance.includes(prefix + "缓存守卫规则"), trust === "user");
        assert.equal(prefs.includes(id), trust === "user");
        for (const [path, ids] of [["brief", used], ["recall", [...shown, ...prefs]]] as const)
          logInjections(s.workDb, { host: null, session_id: null, transcript: null, project_id: null }, path, ids, new Date());
      }
      const n = s.workDb.prepare("SELECT count(*) AS n FROM inject_log WHERE prop_id=?").get(id)!.n;
      assert.equal(Number(n) > 0, warning);
      const status = statusReport(s, { cwd: alpha, userHome: dir, storeHome: join(dir, "ab"), host: { ok: true, detection: null }, embedder: null, embedReason: "fixture", chatConfig: { error: "fixture" }, now: new Date() });
      assert.equal(status.includes("与代码不符 1 条（待用户核实）：ab verify"), warning);
      s.lifecycle("tag", id, null, { scenes: ["code"] });
      const scene = brief(s, alpha, undefined, false, [], ["code"]);
      assert.equal(scene.includes(prefix + "缓存守卫规则"), warning);
      assert.ok(scene.length <= BRIEF_MAX_CHARS + 2000);
      assert.ok(searchable(s.project().props.get(id)!));
    } finally { s.close(); }
  });
}

test("stale 汇总按 worker 全局资格、项目与 pm 可见范围统计，并保留预算", () => {
  const s = new Store(":memory:", ":memory:");
  try {
    const pid = s.ensureProject("alpha"), other = s.ensureProject("other");
    for (const [project, for_workers] of [[null, false], [null, true], [pid, false], [other, false]] as const) {
      const id = s.remember(project, null, false, { kind: "rule", text: "长规则".repeat(120), confirmed: true, source, for_workers });
      verify(s, id, "contradicted");
    }
    assert.match(brief(s, alpha, undefined, false), /与代码不符 3 条/);
    assert.match(brief(s, alpha, undefined, true), /与代码不符 2 条/);
    assert.match(brief(s, join(dir, "pm"), undefined, false), /与代码不符 2 条/);
    assert.ok(brief(s, alpha, undefined, false).length <= BRIEF_MAX_CHARS);
    const prefs = guidanceBlock(s.project().props.values(), false);
    assert.ok(prefs.length <= GUIDANCE_MAX_CHARS);
  } finally { s.close(); }
});

test("旧 confirm 不清 stale；仅用户 override_stale 清除，已确认也有效", () => {
  const s = new Store(":memory:", ":memory:");
  try {
    for (const confirmed of [false, true]) {
      const id = s.remember(null, null, false, { kind: "pitfall", text: "旧 confirm", source, confirmed });
      verify(s, id, "contradicted");
      s.lifecycle("confirm", id, null, {});
      assert.ok(s.project().props.get(id)!.stale);
      s.lifecycle("confirm", id, null, { by: "code", override_stale: true });
      assert.ok(s.project().props.get(id)!.stale);
      s.lifecycle("confirm", id, null, { override_stale: true });
      assert.equal(s.project().props.get(id)!.stale, null);
      assert.equal(s.project().props.get(id)!.confirmed_by, "user");
    }
  } finally { s.close(); }
});

test("决定核出 verified 只存代码证据并清 stale；坑与事实仍自动转正", () => {
  const s = new Store(":memory:", ":memory:");
  try {
    for (const kind of ["decision", "pitfall", "note"] satisfies PropKind[]) {
      const id = s.remember(null, null, false, { kind, text: "核验对象", source, confirmed: false });
      verify(s, id, "contradicted"); verify(s, id, "verified");
      const p = s.project().props.get(id)!;
      assert.equal(p.stale, null);
      assert.deepEqual(p.code_evidence, { head, refs: [] });
      assert.equal(p.confirmed, kind !== "decision");
      assert.equal(p.confirmed_by, kind === "decision" ? null : "code");
    }
  } finally { s.close(); }
});

test("过时纠正不占保底位", () => {
  const s = new Store(":memory:", ":memory:");
  try {
    const old = s.remember(null, null, false, { kind: "pitfall", text: "旧", confirmed: true, source });
    const id = s.remember(null, null, false, { kind: "pitfall", text: "新", confirmed: true, supersedes: old, source });
    verify(s, id, "contradicted");
    assert.equal(isConfirmedCorrection(s.project().props.get(id)!), false);
    assert.ok(recallable(s.project().props.get(id)!, false));
  } finally { s.close(); }
});

test("extract 草稿退场、最新竞争者、归档恢复及确认恢复", async () => {
  const s = new Store(":memory:", ":memory:");
  try {
    const pid = s.ensureProject("alpha");
    const old = s.remember(pid, null, false, { kind: "pitfall", text: "缓存守卫旧草稿", origin: "extract", confirmed: false, source, said_at: "2020-01-01" });
    const next = s.remember(pid, null, false, { kind: "pitfall", text: "缓存守卫新草稿", supersedes: old, confirmed: false, source });
    const latest = s.remember(pid, null, false, { kind: "pitfall", text: "缓存守卫最终草稿", supersedes: old, confirmed: false, source });
    const p = s.project().props.get(old)!;
    assert.equal(p.superseded_draft, latest);
    assert.deepEqual(p.pending_corrections, [next, latest]);
    assert.equal(recallable(p, false), false);
    assert.ok(searchable(p));
    assert.ok(s.search("旧草稿", { projects: "all", includeGlobal: true, limit: 8 }).some(h => h.id === old));
    assert.doesNotMatch(await recall(s, "缓存守卫旧草稿", alpha, () => null), /缓存守卫旧草稿/);
    assert.match(brief(s, alpha, undefined, false), /另有 2 条/);
    assert.ok(!reviewList(s.project().props.values(), s.usage(), new Date()).some(d => d.prop.id === old));
    s.lifecycle("archive", latest, null);
    assert.equal(s.project().props.get(old)!.superseded_draft, next);
    s.lifecycle("archive", next, null);
    assert.equal(s.project().props.get(old)!.superseded_draft, null);
    assert.match(brief(s, alpha, undefined, false), /另有 1 条/);
    assert.ok(reviewList(s.project().props.values(), s.usage(), new Date()).some(d => d.prop.id === old));
    s.lifecycle("reactivate", next, null);
    s.lifecycle("confirm", old, null);
    assert.equal(s.project().props.get(old)!.superseded_draft, null);
  } finally { s.close(); }
});

test("三段替代链按最终状态退场：非活跃草稿退出竞争，归档最终条目后恢复", () => {
  for (const withFallback of [false, true]) {
    const s = new Store(":memory:", ":memory:");
    try {
      const pid = s.ensureProject("alpha");
      const old = s.remember(pid, null, false, { kind: "pitfall", text: "旧草稿", origin: "extract", confirmed: false, source, said_at: "2020-01-01" });
      const fallback = withFallback ? s.remember(pid, null, false, { kind: "pitfall", text: "仍活跃的替代草稿", confirmed: false, supersedes: old, source }) : null;
      const latest = s.remember(pid, null, false, { kind: "pitfall", text: "最新替代草稿", confirmed: false, supersedes: old, source });
      assert.equal(s.project().props.get(old)!.superseded_draft, latest);
      const final = s.remember(pid, null, false, { kind: "pitfall", text: "用户确认的最终条目", confirmed: true, supersedes: latest, source });
      const p = s.project().props.get(old)!;
      assert.equal(s.project().props.get(latest)!.state, "superseded");
      assert.equal(p.state, "active");
      assert.equal(p.superseded_draft, fallback, "非 active 的草稿不能继续占退场标记");
      assert.deepEqual(p.pending_corrections, fallback ? [fallback, latest] : [latest], "既有待确认纠正逻辑不变");
      assert.equal(reviewList(s.project().props.values(), s.usage(), new Date()).some(d => d.prop.id === old), !withFallback);
      assert.match(brief(s, alpha, undefined, false), /另有 1 条/);
      s.lifecycle("archive", final, null);
      assert.equal(s.project().props.get(latest)!.state, "active");
      assert.equal(s.project().props.get(old)!.superseded_draft, latest);
      s.lifecycle("reactivate", final, null);
      assert.equal(s.project().props.get(old)!.superseded_draft, fallback);
    } finally { s.close(); }
  }
});

test("草稿退场严禁触碰任一确认来源、非 extract、跨项目和已归档条目", () => {
  const s = new Store(":memory:", ":memory:");
  try {
    const pid = s.ensureProject("alpha"), other = s.ensureProject("other");
    for (const mode of ["user", "corroboration", "code", "manual", "cross", "archived"]) {
      const old = s.remember(pid, null, false, { kind: "pitfall", text: mode, origin: mode === "manual" ? "manual" : "extract", confirmed: mode === "user", source });
      if (mode === "corroboration" || mode === "code") s.lifecycle("confirm", old, null, { by: mode });
      if (mode === "archived") s.lifecycle("archive", old, null);
      s.remember(mode === "cross" ? other : pid, null, false, { kind: "pitfall", text: "新", confirmed: false, supersedes: old, source });
      assert.equal(s.project().props.get(old)!.superseded_draft, null, mode);
    }
  } finally { s.close(); }
});
