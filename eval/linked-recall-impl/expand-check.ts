// 评测 14：active 决定里，ab get --expand 现在能打开原文的有多少（transcript 原始讨论 或 Pensieve 原 md）。
// node expand-check.ts <after-repo> <home>；AB_HOME 必须等于 <home>。
import path from "node:path";
const [repo, home] = process.argv.slice(2);
if (path.resolve(process.env.AB_HOME ?? "") !== path.resolve(home)) throw new Error("AB_HOME 必须等于库副本目录");
const { Store } = await import(path.join(repo, "src/store.ts"));
const { expandSource, expandImport } = await import(path.join(repo, "src/source.ts"));
const store = new Store(path.join(home, "store.db"), path.join(home, "index.db"));
const out: Record<string, Record<string, number>> = {};
const reasons: Record<string, number> = {};
for (const p of store.project().props.values() as any) {
  if (p.state !== "active") continue;
  const k = p.kind + "/" + p.origin;
  out[k] ??= { n: 0, transcript_ok: 0, import_ok: 0, import_changed: 0, none: 0 };
  out[k].n++;
  let d: string | null = null; try { d = p.source.transcript ? expandSource(p.source) : null; } catch { d = null; }
  if (d) { out[k].transcript_ok++; continue; }
  if (p.import_ref) {
    const r = expandImport(p.import_ref);
    if (r.ok) { out[k].import_ok++; if (r.changed) out[k].import_changed++; continue; }
    const why = r.reason.replace(/^.*：/, ""); reasons[why] = (reasons[why] ?? 0) + 1;
  }
  out[k].none++;
}
console.log(JSON.stringify({ out, import_fail_reasons: reasons }, null, 1));
store.close();
