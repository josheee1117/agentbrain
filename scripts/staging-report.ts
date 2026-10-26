/**
 * 去掉候选区（§8.8）前后对照，只读：列出旧版本写成候选、或被 stage 移进候选区的条目，升级后它们在什么状态、能不能进召回。
 * 新代码不写任何迁移事件：投影直接忽略旧的候选标记和 stage/curate 事件，所以跑几遍结果都一样。
 * 用法：AB_HOME=<库或库的副本> node scripts/staging-report.ts [--json]
 */
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { homedir } from "node:os";
import { fold, type EventRow } from "../src/l2.ts";
import { recallable, trustOf } from "../src/visibility.ts";

const home = process.env.AB_HOME || join(homedir(), ".agentbrain");
const db = new DatabaseSync(join(home, "store.db"), { readOnly: true });
const rows = db.prepare("SELECT * FROM events ORDER BY seq").all() as unknown as EventRow[];
db.close();
const staged = new Set<string>();
for (const r of rows) {
  if (r.kind === "remember" && r.body && JSON.parse(r.body).candidate === true) staged.add(r.id);
  if (r.kind === "stage" && r.target_id && r.body && JSON.parse(r.body).action === "stage") staged.add(r.target_id);
}
const { props } = fold(rows);
const items = [...staged].map((id) => props.get(id)).filter((p) => !!p).map((p) => ({
  id: p.id.slice(0, 8),
  ts: p.ts,
  origin: p.origin,
  kind: p.kind,
  scope: p.project_id === null ? "global" : "project",
  state: p.state,
  trust: trustOf(p),
  recall: recallable(p, false),
  text: p.text.split("\n")[0].slice(0, 80),
}));
if (process.argv.includes("--json")) {
  console.log(JSON.stringify(items, null, 2));
} else {
  const count = (f: (x: (typeof items)[number]) => string) => Object.entries(items.reduce<Record<string, number>>((m, x) => ((m[f(x)] = (m[f(x)] ?? 0) + 1), m), {})).map(([k, v]) => `${k} ${v}`).join("，");
  console.log(`旧候选区条目 ${items.length} 条（只读，未写库）`);
  console.log(`  升级后状态：${count((x) => x.state)}`);
  console.log(`  来源：${count((x) => x.origin)}；种类：${count((x) => x.kind)}；可信程度：${count((x) => x.trust)}`);
  console.log(`  进每轮召回资格（主会话）：${count((x) => (x.recall ? "能" : "不能"))}`);
  for (const x of items) console.log(`  [${x.id}] ${x.ts.slice(0, 16)} ${x.origin} ${x.kind} ${x.state}${x.recall ? "" : "（不进召回）"}: ${x.text}`);
}
