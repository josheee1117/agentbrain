import { Store } from "/workspace/agentbrain/src/store.ts";
const s = new Store(process.argv[2]+"/store.db",process.argv[2]+"/index.db");
const ps=[...s.project().props.values()].filter(p=>p.state==="active");
const projs=new Map(s.listProjects().map(p=>[p.id,p.name]));
const fs=await import("node:fs");
fs.writeFileSync(process.argv[3], ps.map(p=>JSON.stringify({id:p.id,proj:p.project_id?projs.get(p.project_id):null,kind:p.kind,conf:p.confirmed,by:p.confirmed_by,origin:p.origin,basis:p.basis,fw:p.for_workers,text:p.text,why:p.why,trigger:p.trigger,host:p.source.host,tr:p.source.transcript,extra:p.extra_sources.map(e=>e.session_id),import:!!p.import_ref})).join("\n")+"\n");
console.log(ps.length);
