/**
 * 一步式记忆（2026-10-15 用户经 pstack review 认可的目标设计）：话题结束时，一个后台子模型
 * （Claude Code：Haiku 5.5 max，经 claude -p）读话题窗口 + 《好记忆的标准》 + 附近已有记忆，一次决定：
 * 新记 / 并入已有 / 不记。不再分"抽取器 → 候选区 → 审稿团"两步；staging 只留作审计记录和撤销手段。
 * 这里只放提示词和输出校验，接线（ab work 里调用、写事件）在后续切片。
 */
import type { ChatMessage } from "./llm.ts";
import { parseJsonLoose } from "./llm.ts";
import type { Proposition } from "./l2.ts";
import { buildMessages, neighborLabel, type ExtractWindow, type ProjectContext } from "./extract.ts";
import { GOOD_MEMORY_STANDARD } from "./standard.ts";
import { JUDGE_RULES } from "./review.ts";

export const ONE_PASS_MAX_ITEMS = 5;

export const ONE_PASS_SYSTEM = `你是 agentbrain 的记忆员。你读一段已经结束的编码会话（一个话题），按下面的《好记忆的标准》决定这段会话里有没有值得长期记住的东西，一次给出最终结论。你的结论会直接写进记忆库（可撤销），没有第二个审稿人，所以宁缺毋滥。

${GOOD_MEMORY_STANDARD}

## 你的任务
对这段会话给出 0 到 ${ONE_PASS_MAX_ITEMS} 条结论，每条二选一：
- new：一条已有记忆里没有的、合格的新记忆。text 写成一句可照着做的原则（不写本次/日期/内部 id），scenario 以"当…时"开头且不是正文换个说法，why 写当时发生了什么、用户为什么这样要求。
- merge：会话里的东西和 <existing_memories> 里某条讲的是同一件事；into 填那条的编号（m1、m2…），text 写合并后的完整原则。
大多数会话没有值得记的东西，这时 items 给空数组——这是正常结论，不要为了有产出硬凑。
同一件事只给一条。<confirmed_memories> 里已经有的不要再记。
<context_only> 里的内容只供理解，不能当依据。

下面的判断要点原本写给逐条审稿人：其中 discard 就是"不记"，keep/rewrite 就是 new（按标准写好），merge 就是 merge。

${JUDGE_RULES.replace(/- 格式硬要求[\s\S]*$/, "").trim()}
- 格式硬要求：每条必须给 kind（rule/decision/pitfall）、class（A/B/C）和以"当"开头、含"时"的 scenario；merge 必须给存在的 into。缺这些的结论作废。

只输出 JSON：{"items":[{"action":"new|merge","into":"m1（merge 必填）","kind":"rule|decision|pitfall","class":"A|B|C","text":"…","scenario":"当…时","why":"…","guidance":false,"reason":"一句话：为什么值得记"}]}`;

export function buildOnePassMessages(win: ExtractWindow, ctx: ProjectContext, neighbors: Proposition[]): ChatMessage[] {
  const [, user] = buildMessages(win, ctx, neighbors);
  return [
    { role: "system", content: ONE_PASS_SYSTEM },
    { role: "user", content: user.content },
  ];
}

export interface OnePassItem {
  action: "new" | "merge";
  /** merge 的目标正式 id。 */
  into: string | null;
  kind: "rule" | "decision" | "pitfall";
  class: "A" | "B" | "C";
  text: string;
  scenario: string;
  why: string | null;
  guidance: boolean;
  reason: string;
}

export type OnePassInvalid = "bad_action" | "bad_kind" | "bad_class" | "no_text" | "no_scenario" | "merge_bad_target" | "too_many";

/** 校验一步式输出：不合格的单条作废并计数，其余照用。输出整体不是 JSON 时返回 null。 */
export function parseOnePass(raw: string | null, neighbors: Proposition[]): { items: OnePassItem[]; invalid: Partial<Record<OnePassInvalid, number>> } | null {
  const o = parseJsonLoose(raw) as { items?: unknown } | null;
  if (!o || !Array.isArray(o.items)) return null;
  const byLabel = new Map(neighbors.map((p, i) => [neighborLabel(i), p.id]));
  const invalid: Partial<Record<OnePassInvalid, number>> = {};
  const bad = (k: OnePassInvalid) => (invalid[k] = (invalid[k] ?? 0) + 1);
  const items: OnePassItem[] = [];
  for (const v of o.items as any[]) {
    if (items.length >= ONE_PASS_MAX_ITEMS) {
      bad("too_many");
      continue;
    }
    if (v?.action !== "new" && v?.action !== "merge") { bad("bad_action"); continue; }
    if (!["rule", "decision", "pitfall"].includes(v.kind)) { bad("bad_kind"); continue; }
    if (!["A", "B", "C"].includes(v.class)) { bad("bad_class"); continue; }
    const text = typeof v.text === "string" ? v.text.trim() : "";
    if (!text) { bad("no_text"); continue; }
    const scenario = typeof v.scenario === "string" ? v.scenario.trim() : "";
    if (!/^当.+时/s.test(scenario)) { bad("no_scenario"); continue; }
    let into: string | null = null;
    if (v.action === "merge") {
      into = byLabel.get(String(v.into)) ?? null;
      if (!into) { bad("merge_bad_target"); continue; }
    }
    items.push({ action: v.action, into, kind: v.kind, class: v.class, text, scenario, why: typeof v.why === "string" && v.why.trim() ? v.why.trim() : null, guidance: v.guidance === true, reason: typeof v.reason === "string" ? v.reason : "" });
  }
  return { items, invalid };
}
