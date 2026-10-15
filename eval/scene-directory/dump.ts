import { Store } from "~/code_me/agentbrain/src/store.ts";
const E = "~/.agentbrain/eval/overview";
const s = new Store(E + "~", E + "~");
const names = new Map(s.listProjects().map((p) => [p.id, p.name]));
const out: any[] = [];
for (const p of s.project().props.values()) {
  if (p.state !== "active") continue;
  out.push({ id: p.id, project: p.project_id ? names.get(p.project_id) : "GLOBAL", kind: p.kind, confirmed: p.confirmed, fw: p.for_workers, guidance: (p as any).guidance ?? false, disputed: p.pending_corrections.length > 0, text: p.text, why: (p as any).why ?? null, seq: p.seq });
}
(await import("node:fs")).writeFileSync(E + "/active.json", JSON.stringify(out, null, 1));
