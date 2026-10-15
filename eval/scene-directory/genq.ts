// 生成"开工背景"评测题：每项目按 kind×是否确认 分层、固定种子抽样；模型把条目改写成开工时会问的问题 + 标准答案，并判断是否算"开工背景"。
import { readFileSync, writeFileSync } from "node:fs";
import { E, chat, parseJsonLoose, rng, shuffle, pool } from "./common.ts";
const A = JSON.parse(readFileSync(E + "/active.json", "utf8"));
const PLAN: Record<string, number> = { "data-asset": 18, "ai-data": 18, insuranceagent: 10 };
const { chat: c } = chat();
const SYS = `你在给一个"开工背景"评测出题。给你一条项目记忆。判断：一个 agent 在这个项目里开始一次新会话时，这条是否属于值得事先知道的背景（架构/设计决定、模块职责、环境事实、反复出现的坑、用户规则）——而不是只有做某个很细的具体任务才用得到的细节。
如果是，把它改写成 agent 开工时会自己问的一个自然问题（不要照抄原文措辞、不要在问题里泄露答案），并给出标准答案（1-2 句，只含原文支持的关键事实）。
只输出 JSON：{"relevant": true|false, "question": "...", "answer": "...", "key_points": ["答案必须包含的 1-3 个关键点"]}`;
const out: any[] = [];
for (const [proj, n] of Object.entries(PLAN)) {
  const r = rng(20261015);
  const mine = A.filter((x: any) => x.project === proj);
  const groups = new Map<string, any[]>();
  for (const x of shuffle(mine, r)) { const k = x.kind + (x.confirmed ? "c" : "u"); groups.set(k, [...(groups.get(k) ?? []), x]); }
  const order: any[] = []; // 分层轮转
  const keys = [...groups.keys()].sort();
  for (let i = 0; order.length < mine.length; i++) for (const k of keys) { const g = groups.get(k)!; if (g[i]) order.push(g[i]); }
  const cand = order.slice(0, Math.min(order.length, n * 2));
  const res = await pool(cand, 6, async (x) => {
    const { message } = await c([{ role: "system", content: SYS }, { role: "user", content: `项目：${proj}\n类型：${x.kind}\n内容：${x.text}${x.why ? `\n背景：${x.why}` : ""}` }], { json: true });
    return { x, j: parseJsonLoose(message.content) as any };
  });
  let k = 0;
  for (const { x, j } of res) {
    if (k >= n || !j?.relevant || !j.question) continue;
    out.push({ qid: `${proj}-${String(k + 1).padStart(2, "0")}`, project: proj, split: k % 3 === 2 ? "test" : "tune", kind: x.kind, confirmed: x.confirmed, gold_ids: [x.id.slice(0, 8)], question: j.question, answer: j.answer, key_points: j.key_points, source_text: x.text });
    k++;
  }
  console.log(proj, "candidates", cand.length, "kept", k);
}
writeFileSync(E + "/questions.json", JSON.stringify(out, null, 1));
