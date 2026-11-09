import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { backup as sqliteBackup, DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";

const mode = process.argv[2];
assert.ok(mode === "before" || mode === "after");
const evidence = resolve(process.argv[3]);
const root = resolve(import.meta.dirname, "../../..");
const snapshot = join(evidence, "snapshot");
const home = join(evidence, mode);
const fakeHome = join(evidence, "home");
const repos = join(evidence, "repos");
for (const p of [evidence, snapshot, home, fakeHome, repos]) mkdirSync(p, { recursive: true });
const backup = async (src: string, dst: string) => {
  const db = new DatabaseSync(src, { readOnly: true });
  try { await sqliteBackup(db, dst); } finally { db.close(); }
};
if (mode === "before") {
  for (const name of ["store.db", "index.db"]) await backup(join(process.env.HOME!, ".agentbrain", name), join(snapshot, name));
}
for (const name of ["store.db", "index.db"]) await backup(join(snapshot, name), join(home, name));
writeFileSync(join(repos, "agentbrain.md"), `- 路径：\`${root}\`\n`);
const env = { ...process.env, HOME: fakeHome, AB_HOME: home, AGENTBRAIN_HOME: home, AB_REGISTRY: repos, NODE_OPTIONS: "", PI_SESSION_ID: "", CLAUDE_SESSION_ID: "", CODEX_SESSION_ID: "" };
const run = (args: string[], label: string) => {
  const start = performance.now();
  const r = spawnSync(process.execPath, [join(root, "src/cli.ts"), ...args], { cwd: root, env, encoding: "utf8" });
  const ms = performance.now() - start;
  writeFileSync(join(evidence, `${mode}-${label}.log`), `$ node src/cli.ts ${args.join(" ")}\n${r.stdout}${r.stderr}`);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.trim());
  return { ms: Math.round(ms * 100) / 100, out: r.stdout };
};
const db = new DatabaseSync(join(home, "store.db"));
const rows = db.prepare("SELECT * FROM events WHERE body IS NOT NULL AND ephemeral=0 AND kind IN ('remember','relate') ORDER BY seq").all();
const pairs = new Map<string, { ids: string[]; ts: string; outcome: string }>();
for (const r of rows) {
  const b = JSON.parse(String(r.body));
  const id = r.kind === "remember" ? String(r.id) : String(r.target_id);
  const other = r.kind === "remember" ? b.relation?.target : b.target;
  const outcome = r.kind === "remember" ? b.relation?.type : b.outcome;
  if (!other || other === id) continue;
  const ids = [id, other].sort();
  pairs.set(JSON.stringify(ids), { ids, ts: String(r.ts), outcome });
}
const latestState = db.prepare("SELECT kind FROM events WHERE target_id=? AND body IS NOT NULL AND ephemeral=0 AND kind IN ('archive','reactivate') ORDER BY seq DESC LIMIT 1");
const remembers = new Map(rows.filter((r) => r.kind === "remember").map((r) => [String(r.id), r]));
const superseded = new Set<string>();
const userConfirmed = (id: string) => {
  const r = remembers.get(id);
  if (!r) return false;
  const b = JSON.parse(String(r.body));
  const confirms = db.prepare("SELECT body FROM events WHERE target_id=? AND kind='confirm' AND body IS NOT NULL AND ephemeral=0 ORDER BY seq").all(id);
  return b.confirmed !== false || confirms.some((c) => (JSON.parse(String(c.body)).by ?? "user") === "user");
};
for (const [id, r] of remembers) {
  const b = JSON.parse(String(r.body));
  if (b.supersedes && userConfirmed(id) && latestState.get(id)?.kind !== "archive") superseded.add(b.supersedes);
}
const active = (id: string) => remembers.has(id) && latestState.get(id)?.kind !== "archive" && !superseded.has(id);
const current = [...pairs.values()].filter((p) => p.outcome === "conflicts" && p.ids.every(active));
const oldest = current.reduce((n, p) => Math.max(n, Math.floor((Date.now() - Date.parse(p.ts)) / 86_400_000)), 0);
const sinceById = new Map<string, string>();
for (const p of current) for (const id of p.ids) if (!sinceById.has(id) || p.ts < sinceById.get(id)!) sinceById.set(id, p.ts);
const injections = db.prepare("SELECT COUNT(*) AS n FROM inject_log WHERE prop_id=? AND ts>?");
const injected = [...sinceById].reduce((n, [id, ts]) => n + Number(injections.get(id, ts)!.n), 0);
const ids = [...sinceById.keys()].sort((a, b) => {
  const ra = remembers.get(a)!, rb = remembers.get(b)!;
  const score = (r: typeof ra) => Number(userConfirmed(String(r.id))) * 4 + Number(r.project_id === null) * 2 + Number(JSON.parse(String(r.body)).kind === "rule");
  return score(rb) - score(ra) || Number(rb.seq) - Number(ra.seq);
}).slice(0, 5);
assert.equal(ids.length, 5);
writeFileSync(join(evidence, `${mode}-counts.json`), JSON.stringify({ events: db.prepare("SELECT COUNT(*) AS n FROM events").get()!.n, pairs: current.length, oldest, injected, sampleIds: ids, current }, null, 2));
db.close();
const status = run(["status"], "status").out;
if (mode === "after") assert.ok(status.includes(`冲突 ${current.length} 对，最老 ${oldest} 天，挂着期间被注入 ${injected} 次`), status);
for (let i = 0; i < ids.length; i++) {
  const out = run(["get", ids[i]], `get-${i + 1}`).out;
  if (mode === "after") for (const p of current.filter((p) => p.ids.includes(ids[i]))) {
    const other = p.ids.find((id) => id !== ids[i])!;
    assert.ok(out.includes(`与 [${other.slice(0, 8)}] 冲突`), out);
  }
}
const briefing = run(["brief", "agentbrain", "--scene", "design"], "brief").out;
if (mode === "after") assert.match(briefing, /与 \[[0-9a-f]{8}\] 冲突/);
const timings: Record<string, number[]> = {};
for (const [label, args] of [["search", ["search", "冲突", "--all"]], ["get", ["get", ids[0]]], ["brief", ["brief"]]] as const) {
  timings[label] = [];
  for (let i = 1; i <= 3; i++) {
    const result = run([...args], `${label}-timing-${i}`);
    if (label === "get") assert.ok(result.out.includes(ids[0].slice(0, 8)));
    if (label === "search") assert.match(result.out, /\[[0-9a-f]{8}\]/);
    if (label === "brief") assert.match(result.out, /<agentbrain/);
    timings[label].push(result.ms);
  }
}
if (mode === "after") {
  const target = ids[1];
  const affected = current.filter((p) => p.ids.includes(target));
  const partner = affected[0].ids.find((id) => id !== target)!;
  run(["archive", target], "archive");
  assert.match(run(["status"], "archived-status").out, new RegExp(`^冲突 ${current.length - affected.length} 对`, "m"));
  assert.ok(!run(["get", partner], "archived-partner").out.includes(`与 [${target.slice(0, 8)}] 冲突`));
  run(["archive", "--reactivate", target], "reactivate");
  assert.match(run(["status"], "reactivated-status").out, new RegExp(`^冲突 ${current.length} 对`, "m"));
  assert.ok(run(["get", partner], "reactivated-partner").out.includes(`与 [${target.slice(0, 8)}] 冲突`));
}
writeFileSync(join(evidence, `${mode}-timings.json`), JSON.stringify(timings, null, 2));
console.log(JSON.stringify({ mode, pairs: current.length, oldest, injected, ids, timings, evidence }, null, 2));
if (mode === "after") {
  const before = JSON.parse(readFileSync(join(evidence, "before-timings.json"), "utf8"));
  console.log(JSON.stringify({ before, after: timings }));
}
