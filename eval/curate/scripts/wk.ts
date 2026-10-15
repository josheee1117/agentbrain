import { Store } from "~/code_me/agentbrain-p2v4/src/store.ts";
import { readFileSync } from "node:fs";
const mod = await import("~/code_me/agentbrain-p2v4/src/curate.ts");
const h = process.env.HOME + "/.agentbrain/eval/s60home";
const s = new Store(h + "/store.db", h + "/index.db");
const props = s.project().props;
const L = JSON.parse(readFileSync(process.env.HOME + "/.agentbrain/eval/labels90.json", "utf8"));
const names = new Map(s.listProjects().map((p) => [p.id, p.name]));
for (const i of L) { if (i.label !== "没用") continue; const p = props.get(i.id)!; const c = mod.candidateInput(s, p, props, names); console.log(i.set + "#" + i.n, "worker=" + c.worker, p.source.host, (p.source.transcript || "").split("/").slice(-2).join("/")); }
