// dump projection (all states) with link fields to JSON: node dump.ts <repo> <home> <out>
import fs from "node:fs"; import path from "node:path";
const [repo, home, out] = process.argv.slice(2);
const { Store } = await import(path.join(repo, "src/store.ts"));
const store = new Store(path.join(home, "store.db"), path.join(home, "index.db"));
const props = store.project().props;
const names = new Map(store.listProjects().map((p: any) => [p.id, p.name]));
const rows = [...props.values()].map((p: any) => ({
  id: p.id, seq: p.seq, ts: p.ts, project: p.project_id === null ? null : names.get(p.project_id), kind: p.kind, state: p.state,
  confirmed: p.confirmed, confirmed_by: p.confirmed_by, origin: p.origin, basis: p.basis ?? null, guidance: p.guidance,
  text: p.text, why: p.why ?? null, trigger: p.trigger ?? null, scenario: p.value?.scenario ?? null, summary: p.source?.summary ?? null,
  session: p.source?.session_id ?? null, host: p.source?.host ?? null, window_id: null as any,
  supersedes: p.supersedes ?? null, superseded_by: p.superseded_by ?? null, merged_into: p.merged_into, related: p.related,
  conflicts_with: p.conflicts_with, pending: p.pending_corrections, import_ref: p.import_ref?.id ?? null, extra_sessions: p.extra_sources.map((x: any) => x.session_id),
  unreconciled: p.unreconciled, stale: !!p.stale, candidate: p.candidate,
}));
// window_id lives in L1 body only
const db = (store as any).db;
const win = new Map<string, string | null>();
for (const r of db.prepare("SELECT id, body FROM events WHERE kind='remember' AND body IS NOT NULL").all() as any[]) {
  try { const b = JSON.parse(r.body); win.set(r.id, b.window_id ?? b.topic?.window_id ?? null); } catch {}
}
for (const r of rows) r.window_id = win.get(r.id) ?? null;
fs.writeFileSync(out, JSON.stringify(rows));
console.log(rows.length, "props");
