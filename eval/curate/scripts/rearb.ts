// 只对 v6 里仲裁调用失败（503）的条目重跑仲裁：同一份三家判决、同一套提示词。只读库副本。
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const R = "~/code_me/agentbrain-p2";
const { Store } = await import(`${R}/src/store.ts`);
const rv = await import(`${R}/src/review.ts`);
const { candidateInput, connectPanel } = await import(`${R}/src/curate.ts`);
const home = process.env.AB_HOME!;
const cfg = rv.loadReviewConfig(home);
const f = "~/.agentbrain/eval/curate_v6.json";
const d = JSON.parse(readFileSync(f, "utf8"));
const store = new Store(join(home, "store.db"), join(home, "index.db"));
const props = store.project().props;
const names = new Map(store.listProjects().map((p: any) => [p.id, p.name]));
const { arbiter } = connectPanel(cfg);
const stats: any[] = [];
for (const r of d.rows.filter((r: any) => r.route === "undecided")) {
  const c = candidateInput(store, props.get(r.id), props, names);
  const votes = r.vote_detail.map((v: any) => ({ name: v.name, j: v.j }));
  const wording = rv.allAdmit(votes.map((v: any) => v.j));
  const a = rv.renderArbiter(c, votes);
  const t0 = Date.now();
  const res = await arbiter.chat([{ role: "system", content: wording ? rv.WORDING_SYSTEM : rv.ARBITER_SYSTEM }, { role: "user", content: a.prompt }], { json: true });
  stats.push({ member: "sol", role: "arbiter", ms: Date.now() - t0, tokens: res.tokens, ok: true, rerun: true });
  const fin = rv.parseJudgements(res.message.content, a.ids, a.neighborIds, [c]).get(c.id);
  const ok = fin && !(wording && fin.verdict === "discard");
  r.route = ok ? (wording ? "arbiter_wording" : "arbiter") : "undecided";
  r.final = ok ? fin.verdict : null;
  r.admit = ok ? fin.verdict !== "discard" : undefined;
  r.reason = fin?.reason;
  r.rearbitrated = true;
  console.log(r.set, r.n, r.route, r.final);
}
d.rearb_stats = stats;
writeFileSync("~/.agentbrain/eval/curate_v6r.json", JSON.stringify(d, null, 1));
store.close();
