// 召回评测：node eval.ts <repoDir> <homeDir> [--fill] [--split tune|test|all] [--out file] [--verbose]
import fs from "node:fs";
import path from "node:path";
const [repo, home] = process.argv.slice(2);
const args = process.argv.slice(4);
const fill = args.includes("--fill");
const split = args[args.indexOf("--split") + 1] && args.includes("--split") ? args[args.indexOf("--split") + 1] : "all";
const outFile = args.includes("--out") ? args[args.indexOf("--out") + 1] : null;
const verbose = args.includes("--verbose");
const noEmbed = args.includes("--noembed");
const lexOnly = args.includes("--lexonly") ? Number(args[args.indexOf("--lexonly") + 1]) : null;
const here = path.dirname(new URL(import.meta.url).pathname);
const { Store } = await import(path.join(repo, "src/store.ts"));
const { recall } = await import(path.join(repo, "src/recall.ts"));
const R = await import(path.join(repo, "src/recall.ts"));
if (lexOnly !== null && R.RECALL_TUNING) R.RECALL_TUNING.LEX_ONLY = lexOnly;
const { recallableUnconfirmed } = await import(path.join(repo, "src/l2.ts"));
const cacheFile = path.join(here, "emb-cache.json");
const cache: Record<string, string> = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, "utf8")) : {};
const store = new Store(path.join(home, "store.db"), path.join(home, "index.db"));
const model = store.embeddingModel();
let realEmbed: any = null;
if (fill) {
  const e = await import(path.join(repo, "src/embed.ts"));
  const cfg = e.loadEmbedConfig(home);
  const key = e.readKey();
  if (typeof key !== "string") throw new Error("no key");
  realEmbed = (t: string[]) => e.embed(t, cfg, key);
}
const misses: string[] = [];
const embedder = Object.assign(async (texts: string[]) => {
  const out: Float32Array[] = [];
  for (const t of texts) {
    if (!cache[t]) {
      if (!realEmbed) { misses.push(t); throw new Error("cache miss"); }
      const [v] = await realEmbed([t]);
      cache[t] = Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64");
    }
    const b = Buffer.from(cache[t], "base64");
    out.push(new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)));
  }
  return out;
}, { model });
// 把查询/改写文本暴露给 embedder，好让 --fill 预先拿到
const queries = JSON.parse(fs.readFileSync(path.join(here, "queries.json"), "utf8")).filter((q: any) => split === "all" || q.split === split);
const props = store.project().props;
const full = (short: string) => [...props.keys()].find((k: string) => k.startsWith(short));
const results: any[] = [];
for (const q of queries) {
  const shown: string[] = [];
  const t0 = performance.now();
  let block = "";
  let err = null;
  try {
    block = await recall(store, q.query, "/eval/" + (q.project ?? "none"), () => (noEmbed ? null : embedder), shown, [], () => (q.project ? { name: q.project, path: "/nonexistent/" + q.project } : null));
  } catch (e: any) { err = e.message; }
  const ms = performance.now() - t0;
  const inj = shown.map((s) => s.slice(0, 8));
  const projId = q.project ? store.listProjects().find((x: any) => x.name === q.project)?.id : undefined;
  const eligibleGold = q.gold.filter((g: string) => {
    const p: any = props.get(full(g)!);
    if (!p || p.state !== "active" || !["pitfall", "rule", "decision"].includes(p.kind)) return false;
    if (p.project_id === null ? !p.for_workers : p.project_id !== projId) return false;
    return p.confirmed || recallableUnconfirmed(p);
  });
  results.push({ eligibleGold, id: q.id, type: q.type, split: q.split, project: q.project, query: q.query, gold: q.gold, injected: inj, ms, err });
}
if (fill) fs.writeFileSync(cacheFile, JSON.stringify(cache));
if (misses.length) console.error("CACHE MISSES:", misses.length, misses.slice(0, 5));
function score(rs: any[]) {
  const pos = rs.filter((r) => r.gold.length), neg = rs.filter((r) => !r.gold.length);
  let hit = 0, mrr = 0, injN = 0, injGold = 0;
  for (const r of pos) {
    const rank = r.injected.findIndex((i: string) => r.gold.includes(i));
    if (rank >= 0) { hit++; mrr += 1 / (rank + 1); }
    injN += r.injected.length; injGold += r.injected.filter((i: string) => r.gold.includes(i)).length;
  }
  const el = pos.filter((r) => r.eligibleGold.length);
  const elHit = el.filter((r) => r.injected.some((i: string) => r.eligibleGold.includes(i))).length;
  const fi = neg.filter((r) => r.injected.length).length;
  const ms = rs.map((r) => r.ms).sort((a, b) => a - b);
  const pct = (p: number) => ms[Math.min(ms.length - 1, Math.floor(p * ms.length))];
  return { n: rs.length, pos: pos.length, neg: neg.length, "recall@3": +(hit / pos.length).toFixed(3), MRR: +(mrr / pos.length).toFixed(3), precision: injN ? +(injGold / injN).toFixed(3) : null, injectedPerPos: +(injN / pos.length).toFixed(2), eligiblePos: el.length, "eligibleRecall@3": el.length ? +(elHit / el.length).toFixed(3) : null, falseInjection: neg.length ? +(fi / neg.length).toFixed(3) : null, p50ms: +pct(0.5).toFixed(1), p95ms: +pct(0.95).toFixed(1) };
}
const report: any = {};
for (const s of ["tune", "test"]) { const rs = results.filter((r) => r.split === s); if (rs.length) report[s] = score(rs); }
report.all = score(results);
console.log(JSON.stringify(report, null, 1));
if (verbose) for (const r of results) {
  const ok = r.gold.length ? r.injected.some((i: string) => r.gold.includes(i)) : !r.injected.length;
  console.log(`${ok ? "OK " : "XX "}${r.id} [${r.project}] ${r.query.slice(0, 40)} | gold=${r.gold.join(",")} | elig=${r.eligibleGold.join(",")} | inj=${r.injected.join(",")}${r.err ? " ERR " + r.err : ""}`);
}
if (outFile) fs.writeFileSync(outFile, JSON.stringify({ report, results }, null, 1));
