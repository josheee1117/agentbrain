// 评测 14：把测试集查询的必需条目正文和 why 从库副本里取出来给裁判用（输出含正文，不进仓库）。
// node gold-dump.ts <after-repo> <home> <out.json> <queries.json>...
import fs from "node:fs"; import path from "node:path";
const [repo, home, out, ...qfiles] = process.argv.slice(2);
if (path.resolve(process.env.AB_HOME ?? "") !== path.resolve(home)) throw new Error("AB_HOME 必须等于库副本目录");
const { Store } = await import(path.join(repo, "src/store.ts"));
const store = new Store(path.join(home, "store.db"), path.join(home, "index.db"));
const props = store.project().props;
const full = (p8: string) => [...props.keys()].find((k: string) => k.startsWith(p8))!;
const res: Record<string, any> = {};
for (const qf of qfiles) for (const q of JSON.parse(fs.readFileSync(qf, "utf8"))) {
  if (q.split !== "test") continue;
  res[q.id] = { query: q.query, need_why: !!q.need_why, slots: q.slots.map((s: string[]) => s.map((g) => { const p = props.get(full(g)); return { id: g, text: p.text, why: p.why ?? null }; })) };
}
fs.writeFileSync(out, JSON.stringify(res, null, 1));
store.close();
