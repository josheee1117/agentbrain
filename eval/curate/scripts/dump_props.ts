import { Store } from "~/code_me/agentbrain-p2/src/store.ts";
const h = process.argv[2];
const s = new Store(h + "/store.db", h + "/index.db");
const names = new Map(s.listProjects().map((p) => [p.id, p.name]));
const out = [];
for (const p of s.project().props.values()) {
  if (p.state !== "active" && p.state !== "candidate") continue;
  out.push({ id: p.id, ts: p.ts, proj: p.project_id ? names.get(p.project_id) ?? p.project_id : null, kind: p.kind, text: p.text, why: p.why ?? null,
    scenario: p.value?.scenario ?? p.trigger ?? null, origin: p.origin, basis: p.basis ?? null, host: p.source?.host ?? null, summary: p.source?.summary ?? null,
    state: p.state, candidate: p.candidate, confirmed_by: p.confirmed_by, demoted: p.demoted, for_workers: p.for_workers, guidance: p.guidance, stale: !!p.stale, expired: p.expired });
}
process.stdout.write(JSON.stringify(out));
