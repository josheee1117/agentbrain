import fs from "node:fs";
const repo = process.argv[2]; const split = process.argv[3] ?? "tune";
const { Store } = await import(repo + "/src/store.ts");
const { cosine, fromBlob } = await import(repo + "/src/embed.ts");
const store = new Store("home/store.db", "home/index.db");
const cache = JSON.parse(fs.readFileSync("emb-cache.json", "utf8"));
const qv = (t: string) => { const b = Buffer.from(cache[t], "base64"); return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
const props = store.project().props;
const projs = new Map(store.listProjects().map((p: any) => [p.name, p.id]));
const vecs = (store as any).fts.prepare("SELECT id,vec FROM vecs").all() as any[];
const base = JSON.parse(fs.readFileSync(process.argv[4] ?? "baseline-mac.json", "utf8")).results;
const qs = JSON.parse(fs.readFileSync("queries.json", "utf8")).filter((q: any) => q.split === split);
for (const q of qs) {
  const r = base.find((x: any) => x.id === q.id);
  const ok = q.gold.length ? r.injected.some((i: string) => q.gold.includes(i)) : !r.injected.length;
  if (ok) continue;
  const pid = q.project ? projs.get(q.project) : undefined;
  const v = qv(q.query);
  const scored = vecs.map((row) => ({ id: row.id, s: cosine(v, fromBlob(row.vec)) })).filter((x) => { const p = props.get(x.id); return p && p.state === "active" && (p.project_id === null || p.project_id === pid); }).sort((a, b) => b.s - a.s);
  console.log(`\n${q.id} [${q.project}] ${q.query.slice(0, 60)}  inj=${r.injected.join(",")}`);
  for (const g of q.gold) {
    const p = [...props.values()].find((p: any) => p.id.startsWith(g));
    const rank = scored.findIndex((x) => x.id === p.id);
    const why = [p.project_id === null ? (p.for_workers ? "GLOBAL-fw" : "GLOBAL-noFW(excluded)") : "proj", p.confirmed ? "conf" : "UNCONF", p.kind].join(" ");
    console.log(`   gold ${g} sim=${scored[rank]?.s.toFixed(3)} vecRank=${rank} ${why}`);
  }
  console.log("   top vec:", scored.slice(0, 3).map((x) => x.id.slice(0, 8) + ":" + x.s.toFixed(3)).join(" "));
}
