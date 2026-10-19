/**
 * 审稿团离线评测（v3 第 2 阶段验收）：拿有标签的条目当候选喂给审稿团，和标签比。只读，不写库。
 * 用法：AB_HOME=<库的副本目录> node scripts/curate-eval.ts <items.json> <out.json> [set...]
 * items.json：[{set,n,id,admit}]（admit=true 表示有用）。review.json 从 AB_HOME 读。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { Store } from "../src/store.ts";
import { loadReviewConfig, QuotaExhausted, type CallStat } from "../src/review.ts";
import { candidateInput, connectPanel, runPanel } from "../src/curate.ts";

const [itemsPath, outPath, ...sets] = process.argv.slice(2);
const home = process.env.AB_HOME || join(homedir(), ".agentbrain");
const cfg = loadReviewConfig(home);
if ("error" in cfg) throw new Error(cfg.error);
const items = (JSON.parse(readFileSync(itemsPath, "utf8")) as { set: string; n: number; id: string; admit: boolean }[]).filter((i) => !sets.length || sets.includes(i.set));
const store = new Store(join(home, "store.db"), join(home, "index.db"));
const props = store.project().props;
const names = new Map(store.listProjects().map((p) => [p.id, p.name]));
const inputs = items.map((i) => {
  const p = props.get(i.id);
  if (!p) throw new Error(`库里没有 ${i.id}`);
  return candidateInput(store, p, props, names);
});
const { panel, arbiter, missing } = connectPanel(cfg);
if (missing.length || !arbiter) throw new Error(`审稿团缺人：${missing.join("；")}`);
const stats: CallStat[] = [];
const t0 = Date.now();
let results: Awaited<ReturnType<typeof runPanel>>;
try {
  results = await runPanel(inputs, panel, arbiter, cfg.batchSize, stats, 2, cfg.mode === "primary" ? cfg.primary : null);
} catch (e) {
  if (!(e instanceof QuotaExhausted)) throw e;
  writeFileSync(outPath, JSON.stringify({ aborted: e.message, resetAt: e.resetAt, stats }, null, 1));
  console.log(`QUOTA_EXHAUSTED ${e.message}`);
  process.exit(3);
}
const wall = Date.now() - t0;
const admitOf = (v: string | undefined) => (v ? v !== "discard" : undefined);
const rows = results.map((r, k) => ({
  set: items[k].set,
  n: items[k].n,
  id: r.id,
  gold: items[k].admit,
  route: r.decision.route,
  final: r.decision.final?.verdict ?? null,
  admit: admitOf(r.decision.final?.verdict),
  votes: Object.fromEntries(r.votes.map((v) => [v.name, v.j?.verdict ?? null])),
  final_text: r.decision.final?.text,
  final_scenario: r.decision.final?.scenario,
  reason: r.decision.final?.reason,
  vote_detail: r.votes,
  context: inputs[k].context !== null,
}));
const pct = (a: number, b: number) => (b ? `${a}/${b} = ${((100 * a) / b).toFixed(0)}%` : "n/a");
const split = (s: string | null) => {
  const xs = rows.filter((r) => !s || r.set === s);
  const useless = xs.filter((r) => !r.gold);
  const useful = xs.filter((r) => r.gold);
  return {
    n: xs.length,
    discard_useless: pct(useless.filter((r) => r.admit === false).length, useless.length),
    keep_useful: pct(useful.filter((r) => r.admit === true).length, useful.length),
    undecided: xs.filter((r) => r.admit === undefined).length,
    arbiter_rate: pct(xs.filter((r) => r.route === "arbiter" || r.route === "arbiter_wording").length, xs.length),
    arbiter_decides_fate: pct(xs.filter((r) => r.route === "arbiter").length, xs.length),
    arbiter_wording_only: pct(xs.filter((r) => r.route === "arbiter_wording").length, xs.length),
    unanimous: pct(xs.filter((r) => r.route === "unanimous").length, xs.length),
    panel_admit_split: pct(xs.filter((r) => { const a = Object.values(r.votes).filter((v) => v).map((v) => v !== "discard"); return a.includes(true) && a.includes(false); }).length, xs.length),
    per_model: Object.fromEntries(
      panel.map((m) => {
        const v = xs.map((r) => ({ a: admitOf(r.votes[m.name] ?? undefined), g: r.gold }));
        return [m.name, { vs_gold: pct(v.filter((x) => x.a === x.g).length, v.length), discard_useless: pct(v.filter((x) => !x.g && x.a === false).length, v.filter((x) => !x.g).length), keep_useful: pct(v.filter((x) => x.g && x.a === true).length, v.filter((x) => x.g).length), invalid: v.filter((x) => x.a === undefined).length }];
      }),
    ),
    pairwise_admit_agreement: Object.fromEntries(
      panel.flatMap((a, i) => panel.slice(i + 1).map((b) => [`${a.name}~${b.name}`, pct(xs.filter((r) => r.votes[a.name] && r.votes[b.name] && admitOf(r.votes[a.name]!) === admitOf(r.votes[b.name]!)).length, xs.length)])),
    ),
  };
};
const q = (xs: number[], p: number) => (xs.length ? xs.sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))] : 0);
const cost = Object.fromEntries(
  [...new Set(stats.map((s) => `${s.member}/${s.role}`))].map((k) => {
    const xs = stats.filter((s) => `${s.member}/${s.role}` === k);
    return [k, { calls: xs.length, failed: xs.filter((s) => !s.ok).length, tokens: xs.reduce((n, s) => n + s.tokens, 0), cost_usd: Number(xs.reduce((n, s) => n + (s.costUsd ?? 0), 0).toFixed(4)), total_ms: xs.reduce((n, s) => n + s.ms, 0), p50_ms: q(xs.map((s) => s.ms), 0.5), max_ms: Math.max(...xs.map((s) => s.ms)), errors: [...new Set(xs.map((s) => s.error).filter(Boolean))] }];
  }),
);
const summary = { at: new Date().toISOString(), panel: cfg.panel.map((m) => (m.type === "cli" ? `${m.name}:${m.host}:${m.model || "默认"}@${m.effort ?? "-"}` : `${m.name}:${m.model}`)), mode: cfg.mode, primary: cfg.primary, arbiter: cfg.mode === "primary" ? null : cfg.arbiter, batch: cfg.batchSize, wall_ms: wall, all: split(null), ...Object.fromEntries([...new Set(rows.map((r) => r.set))].map((s) => [s, split(s)])), cost };
writeFileSync(outPath, JSON.stringify({ summary, rows }, null, 1));
console.log(JSON.stringify(summary, null, 1));
store.close();
