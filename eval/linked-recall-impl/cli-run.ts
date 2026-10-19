// 评测 14：用真实 CLI 跑改动前/后的 ab search（及前 3 条的 ab get），记下实际显示出来的 id 和输出长度。
// node cli-run.ts <home> <outdir> <before-repo> <after-repo> <queries.json>...
// 只碰库副本：AB_HOME 必须等于 <home>，且不能是 ~/.agentbrain。原始输出（含正文）写到 outdir/raw-*.json，不进仓库。
import fs from "node:fs"; import path from "node:path"; import { execFileSync } from "node:child_process";
const [home, outdir, before, after, ...qfiles] = process.argv.slice(2);
if (path.resolve(process.env.AB_HOME ?? "") !== path.resolve(home)) throw new Error("AB_HOME 必须等于库副本目录");
if (path.resolve(home) === path.resolve(process.env.HOME + "/.agentbrain")) throw new Error("拒绝在正式库上跑");
const reg = fs.mkdtempSync(path.join(outdir, "reg-"));
const { Store } = await import(path.join(after, "src/store.ts"));
const store = new Store(path.join(home, "store.db"), path.join(home, "index.db"));
const all = [...store.project().props.keys()] as string[];
store.close();
const full = (p8: string) => { const m = all.filter((id) => id.startsWith(p8)); if (m.length !== 1) throw new Error(`前缀 ${p8} 对应 ${m.length} 条`); return m[0]; };
const run = (repo: string, args: string[]) =>
  execFileSync("node", [path.join(repo, "src/cli.ts"), ...args], { cwd: home, encoding: "utf8", env: { ...process.env, AB_HOME: home, AB_REGISTRY: reg }, stdio: ["ignore", "pipe", "pipe"] });
const ids = (s: string) => [...s.matchAll(/\[([0-9a-f]{8})\]/g)].map((m) => full(m[1]));
const res: Record<string, any[]> = { before: [], after: [] };
const raw: Record<string, any[]> = { before: [], after: [] };
for (const qf of qfiles) for (const q of JSON.parse(fs.readFileSync(qf, "utf8"))) {
  for (const [cond, repo] of [["before", before], ["after", after]] as const) {
    const sargs = ["search", q.query, ...(q.project ? ["--project", q.project] : [])];
    const out = run(repo, sargs);
    const lines = out.split("\n");
    const fullRows = lines.filter((l) => /^\[[0-9a-f]{8}\]/.test(l)).map((l) => full(l.slice(1, 9)));
    const linkIds = lines.filter((l) => l.startsWith("  关联: ")).flatMap(ids);
    const moreAt = lines.findIndex((l) => l.startsWith("更多（第 "));
    const moreIds = moreAt < 0 ? [] : lines.slice(moreAt + 1).filter((l) => /^  \[[0-9a-f]{8}\]/.test(l)).map((l) => full(l.slice(3, 11)));
    const gets = fullRows.slice(0, 3).map((id) => run(repo, ["get", id.slice(0, 8)]));
    const getIds = gets.flatMap(ids);
    res[cond].push({ id: q.id, split: q.split, set: path.basename(qf), full: fullRows, links: linkIds, more: moreIds, get_ids: getIds, search_chars: [...out].length, get_chars: gets.reduce((n, g) => n + [...g].length, 0) });
    raw[cond].push({ id: q.id, query: q.query, project: q.project, search: out, gets });
  }
  console.log(q.id, "ok");
}
fs.writeFileSync(path.join(outdir, "ids.json"), JSON.stringify(res, null, 1));
fs.writeFileSync(path.join(outdir, "raw-outputs.json"), JSON.stringify(raw, null, 1));
fs.rmSync(reg, { recursive: true });
