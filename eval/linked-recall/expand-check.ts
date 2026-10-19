// 场景②"还原一个决策当时是怎么讨论出来的"：active 决定里，ab get --expand 能展开原始讨论的有多少。
import path from "node:path";
const [repo, home] = process.argv.slice(2);
if (path.resolve(process.env.AB_HOME ?? "") !== path.resolve(home)) throw new Error("AB_HOME 必须等于库副本目录");
const { Store } = await import(path.join(repo, "src/store.ts"));
const { expandSource } = await import(path.join(repo, "src/source.ts"));
const store = new Store(path.join(home, "store.db"), path.join(home, "index.db"));
const out: Record<string, Record<string, number>> = {};
for (const p of store.project().props.values() as any) {
  if (p.state !== "active") continue;
  const k = p.kind + "/" + p.origin;
  out[k] ??= { n: 0, expandable: 0, no_transcript: 0, failed: 0, why: 0 };
  out[k].n++; if (p.why) out[k].why++;
  if (!p.source.transcript) { out[k].no_transcript++; continue; }
  let d: string | null = null; try { d = expandSource(p.source); } catch { d = null; }
  if (d) out[k].expandable++; else out[k].failed++;
}
console.log(JSON.stringify(out, null, 1));
store.close();
