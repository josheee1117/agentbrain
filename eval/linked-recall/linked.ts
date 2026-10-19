// 关联召回评测（docs/eval/13）：node linked.ts <repo> <home> <queries.json> <out.json>
// 对每条查询跑三条读路径：每轮召回 recall()、ab search（store.searchHybrid，默认只看 active，limit 8）、
// ab search --archived；外加项目 brief 的注入条目，以及每个命中条目的向量近邻（ab get 口径 top 5）。
// 只读库副本：AB_HOME 必须指向副本；向量缺失时 searchHybrid 会补算（只写副本 index.db）。
import fs from "node:fs"; import path from "node:path";
const [repo, home, qfile, out] = process.argv.slice(2);
if (!process.env.AB_HOME || path.resolve(process.env.AB_HOME) !== path.resolve(home)) throw new Error("AB_HOME 必须等于库副本目录");
if (path.resolve(home) === path.resolve(process.env.HOME + "/.agentbrain")) throw new Error("拒绝在正式库上跑");
const { Store } = await import(path.join(repo, "src/store.ts"));
const { recall } = await import(path.join(repo, "src/recall.ts"));
const { brief } = await import(path.join(repo, "src/brief.ts"));
const E = await import(path.join(repo, "src/embed.ts"));
const cfg = E.loadEmbedConfig(home); const key = E.readKey();
if ("error" in cfg || typeof key !== "string") throw new Error("embedding 不可用");
const embedder = Object.assign((t: string[]) => E.embed(t, cfg, key), { model: cfg.model });
const store = new Store(path.join(home, "store.db"), path.join(home, "index.db"));
const Q = JSON.parse(fs.readFileSync(qfile, "utf8"));
const projId = (name: string | null) => (name ? store.listProjects().find((p: any) => p.name === name)?.id : undefined);
const briefs: Record<string, string[]> = {};
const results: any[] = [];
for (const q of Q) {
  const cwd = "/eval/" + (q.project ?? "none");
  const resolve = () => (q.project ? { name: q.project, path: "/nonexistent/" + q.project } : null);
  const shown: string[] = [];
  const block = await recall(store, q.query, cwd, () => embedder, shown, [], resolve);
  const pid = projId(q.project);
  const scope = { projects: pid ? [pid] : [], includeGlobal: true };
  const s1 = await store.searchHybrid(q.query, { ...scope }, embedder);
  const s2 = await store.searchHybrid(q.query, { ...scope, includeArchived: true, skipSync: true }, embedder);
  const s16 = await store.searchHybrid(q.query, { ...scope, limit: 16, skipSync: true }, embedder);
  const s24 = await store.searchHybrid(q.query, { ...scope, limit: 24, skipSync: true }, embedder);
  const key = q.project ?? "_none";
  if (!briefs[key]) {
    const used: string[] = [];
    try { brief(store, home, q.project ?? undefined, false, used); } catch (e: any) { used.push("ERR:" + e.message); }
    briefs[key] = used;
  }
  const hitIds = [...new Set([...shown, ...s1.hits.map((h: any) => h.id), ...s2.hits.map((h: any) => h.id)])];
  const neighbors: Record<string, { id: string; sim: number }[]> = {};
  for (const id of hitIds) neighbors[id] = (store.neighbors(id) ?? []).slice(0, 5).map((n: any) => ({ id: n.prop.id, sim: Math.round(n.similarity * 1000) / 1000 }));
  results.push({ id: q.id, recall: shown, recall_chars: block.length, search: s1.hits.map((h: any) => h.id), search_degraded: s1.degraded, search_arch: s2.hits.map((h: any) => h.id), search16: s16.hits.map((h: any) => h.id), search24: s24.hits.map((h: any) => h.id), neighbors });
  console.log(q.id, "recall", shown.length, "search", s1.hits.length, s1.degraded ?? "");
}
fs.writeFileSync(out, JSON.stringify({ results, briefs, embed_model: cfg.model }, null, 1));
store.close();
