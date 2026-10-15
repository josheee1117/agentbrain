import { Store } from "/workspace/agentbrain/src/store.ts";
import fs from "node:fs";
const s = new Store("home/store.db", "home/index.db");
const projs = new Map(s.listProjects().map((p:any)=>[p.id,p.name]));
const props = [...s.project().props.values()];
const out = props.filter(p=>p.state==="active").map(p=>({id:p.id.slice(0,8), proj:p.project_id?projs.get(p.project_id):"GLOBAL", kind:p.kind, conf:p.confirmed, fw:p.for_workers, text:p.text.replace(/\n/g," / ")}));
fs.writeFileSync("active.jsonl", out.map(o=>JSON.stringify(o)).join("\n"));
const c: Record<string,number> = {};
for (const p of props) { const k = `${p.state}|${p.project_id?projs.get(p.project_id):"GLOBAL"}|conf=${p.confirmed}|fw=${p.for_workers}`; c[k]=(c[k]||0)+1; }
console.log(c);
