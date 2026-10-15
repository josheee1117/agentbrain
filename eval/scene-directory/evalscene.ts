// 开工背景评测：baseline brief vs 带场景目录的 brief；目录→场景命中率；打开一个场景后的覆盖；对照：baseline brief + 一次 ab search。
// node evalscene.ts <home> <split|all> <out.json> [--search]
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { E, chat, parseJsonLoose, pool } from "./common.ts";
const [home, split, outFile] = process.argv.slice(2);
const doSearch = process.argv.includes("--search");
const CLI = "~/code_me/agentbrain-scene/src/cli.ts";
const ab = (...args: string[]) => execFileSync("node", [CLI, ...args], { cwd: "/tmp", env: { ...process.env, AB_HOME: home }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const Q = JSON.parse(readFileSync(E + "/questions.json", "utf8")).filter((q: any) => split === "all" || q.split === split);
const { chat: c } = chat();
const GRADE = `你是严格的评分员。只根据给定的"上下文"判断：一个只读过这段上下文、没有任何其他知识的 agent，能否答出问题的标准答案。
评分：
- 1：标准答案的所有关键点都在上下文里明确写出（或只需字面推理即可得到）；
- 0.5：只覆盖了部分关键点；
- 0：上下文没有给出这些关键点（只有相关话题/标题/"用 ab search 查"之类的提示不算覆盖）。
不要用常识或猜测补全。只输出 JSON：{"score":0|0.5|1,"reason":"一句话"}`;
async function grade(ctx: string, q: any): Promise<{ score: number; reason: string }> {
  for (let t = 0; t < 3; t++) {
    try {
      const { message } = await c([{ role: "system", content: GRADE }, { role: "user", content: `上下文：\n<<<\n${ctx}\n>>>\n\n问题：${q.question}\n标准答案：${q.answer}\n关键点：${(q.key_points ?? []).join("；")}` }], { json: true });
      const j = parseJsonLoose(message.content) as any;
      if (j && [0, 0.5, 1].includes(Number(j.score))) return { score: Number(j.score), reason: String(j.reason ?? "") };
    } catch {}
  }
  return { score: 0, reason: "grader failed" };
}
const PICK = `你是一个刚进项目的 agent。下面是开工时拿到的 brief，里面有"场景目录"（[编号] 标题（条数））。针对你要解决的问题，选一个最可能包含答案的场景去打开；如果 brief 里已经有答案或没有合适的场景，选 none。
只输出 JSON：{"scene":"<编号或 none>"}`;
async function pick(brief: string, q: any): Promise<string> {
  for (let t = 0; t < 3; t++) {
    try {
      const { message } = await c([{ role: "system", content: PICK }, { role: "user", content: `brief：\n${brief}\n\n问题：${q.question}` }], { json: true });
      const j = parseJsonLoose(message.content) as any;
      if (j && typeof j.scene === "string") return j.scene.replace(/[\[\]]/g, "").trim();
    } catch {}
  }
  return "none";
}
const briefs = new Map<string, string>();
for (const p of new Set(Q.map((q: any) => q.project))) briefs.set(p as string, ab("brief", p as string));
const sceneCache = new Map<string, string>();
const rows = await pool(Q, 4, async (q: any) => {
  const brief = briefs.get(q.project)!;
  const g0 = await grade(brief, q);
  const row: any = { qid: q.qid, project: q.project, split: q.split, kind: q.kind, briefChars: brief.length, brief: g0 };
  const hasDir = /ab scene <编号>/.test(brief);
  if (hasDir) {
    const sid = await pick(brief, q);
    row.pick = sid;
    if (sid !== "none") {
      let txt = sceneCache.get(sid);
      if (txt === undefined) {
        try { txt = ab("scene", sid); } catch { txt = ""; }
        sceneCache.set(sid, txt);
      }
      row.hit = q.gold_ids.some((g: string) => txt!.includes(`[${g}]`));
      row.openChars = txt.length;
      row.open = await grade(brief + "\n\n" + txt, q);
    } else {
      row.hit = false;
      row.openChars = 0;
      row.open = g0;
    }
  }
  if (doSearch) {
    const s = ab("search", "--project", q.project, q.question);
    row.searchHit = q.gold_ids.some((g: string) => s.includes(`[${g}]`));
    row.searchChars = s.length;
    row.search = await grade(brief + "\n\nab search 结果：\n" + s, q);
  }
  return row;
});
const avg = (xs: number[]) => (xs.length ? +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(3) : null);
const summary: any = { n: rows.length, brief: avg(rows.map((r: any) => r.brief.score)), briefChars: avg([...briefs.values()].map((b) => b.length)) };
if (rows.some((r: any) => "hit" in r)) Object.assign(summary, { pickHit: avg(rows.map((r: any) => (r.hit ? 1 : 0))), pickNone: rows.filter((r: any) => r.pick === "none").length, open: avg(rows.map((r: any) => r.open.score)), openChars: avg(rows.map((r: any) => r.openChars)) });
if (doSearch) Object.assign(summary, { searchHit: avg(rows.map((r: any) => (r.searchHit ? 1 : 0))), search: avg(rows.map((r: any) => r.search.score)), searchChars: avg(rows.map((r: any) => r.searchChars)) });
const byProj: any = {};
for (const p of briefs.keys()) { const rs = rows.filter((r: any) => r.project === p); byProj[p] = { n: rs.length, brief: avg(rs.map((r: any) => r.brief.score)), ...(rs.some((r: any) => "hit" in r) ? { pickHit: avg(rs.map((r: any) => (r.hit ? 1 : 0))), open: avg(rs.map((r: any) => r.open.score)) } : {}), ...(doSearch ? { search: avg(rs.map((r: any) => r.search.score)) } : {}) }; }
summary.byProject = byProj;
writeFileSync(outFile, JSON.stringify({ summary, rows, briefs: Object.fromEntries(briefs) }, null, 1));
console.log(JSON.stringify(summary, null, 1));
