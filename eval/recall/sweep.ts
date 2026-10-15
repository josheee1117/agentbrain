import fs from "node:fs";
const repo = "/workspace/agentbrain";
const { Store } = await import(repo + "/src/store.ts");
const R = await import(repo + "/src/recall.ts");
const { recallableUnconfirmed } = await import(repo + "/src/l2.ts");
const store = new Store("home/store.db", "home/index.db");
const cache = JSON.parse(fs.readFileSync("emb-cache.json", "utf8"));
const emb = Object.assign(async (ts: string[]) => ts.map((t) => { const b = Buffer.from(cache[t], "base64"); return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); }), { model: store.embeddingModel() });
const qs = JSON.parse(fs.readFileSync("queries.json", "utf8")).filter((q: any) => q.split === "tune");
const props = store.project().props;
const projs = new Map(store.listProjects().map((p: any) => [p.name, p.id]));
for (const q of qs) q.elig = q.gold.filter((g: string) => { const p: any = [...props.values()].find((x: any) => x.id.startsWith(g)); if (!["pitfall","rule","decision"].includes(p.kind) || p.state!=="active") return false; if (p.project_id === null ? !p.for_workers : p.project_id !== projs.get(q.project)) return false; return p.confirmed || recallableUnconfirmed(p); });
const rows: any[] = [];
for (const MIN_SIM of [0.55, 0.58, 0.6, 0.62, 0.65]) for (const MIN_SIM_LEX of [0.45, 0.5, 0.55]) for (const LEX_STRONG of [0.4, 0.5, 0.6]) for (const LEX_WEIGHT of [0.2, 0.3, 0.5]) for (const REL_MARGIN of [0.08, 0.12, 0.2]) {
  Object.assign(R.RECALL_TUNING, { MIN_SIM, MIN_SIM_LEX, LEX_STRONG, LEX_WEIGHT, REL_MARGIN });
  let eh = 0, en = 0, inj = 0, ig = 0, fi = 0, nn = 0;
  for (const q of qs) {
    const shown: string[] = [];
    await R.recall(store, q.query, "/x", () => emb, shown, [], () => (q.project ? { name: q.project, path: "/nonexistent" } : null));
    const s = shown.map((x) => x.slice(0, 8));
    if (!q.gold.length) { nn++; if (s.length) fi++; continue; }
    if (q.elig.length) { en++; if (s.some((x) => q.elig.includes(x))) eh++; }
    inj += s.length; ig += s.filter((x) => q.gold.includes(x)).length;
  }
  rows.push({ MIN_SIM, MIN_SIM_LEX, LEX_STRONG, LEX_WEIGHT, REL_MARGIN, er: eh / en, p: ig / inj, fi: fi / nn, obj: eh / en + 0.5 * (ig / inj) - fi / nn });
}
rows.sort((a, b) => b.obj - a.obj);
for (const r of rows.slice(0, 15)) console.log(JSON.stringify(r));
console.log("current-like", JSON.stringify(rows.find((r) => r.MIN_SIM === 0.6 && r.MIN_SIM_LEX === 0.5 && r.LEX_STRONG === 0.5 && r.LEX_WEIGHT === 0.3 && r.REL_MARGIN === 0.12)));
