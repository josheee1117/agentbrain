/**
 * 一步式记忆（2026-10-15 用户经 pstack review 认可的目标设计）：话题结束时，一个后台子模型
 * （Claude Code：Haiku 5.5 max，经 claude -p）读话题窗口 + 《好记忆的标准》 + 附近已有记忆，一次决定：
 * 新记 / 并入已有 / 不记。不再分"抽取器 → 候选区 → 审稿团"两步；staging 只留作审计记录和撤销手段。
 * 这里只放提示词和输出校验，接线（ab work 里调用、写事件）在后续切片。
 * 2026-10-19 §8.7 召回修法 1–3：去掉"宁缺毋滥 / 大多数会话没东西"的偏置、加按类清单（含工具输出里的坑）、上限 5→8；提示词与评测 12 的 V1 逐字相同。
 */
import type { ChatMessage } from "./llm.ts";
import { parseJsonLoose } from "./llm.ts";
import type { Proposition } from "./l2.ts";
import { buildInput, neighborLabel, type ExtractWindow, type ProjectContext } from "./extract.ts";
import { GOOD_MEMORY_STANDARD } from "./standard.ts";
import { JUDGE_RULES } from "./review.ts";

/** 每窗口最多几条结论。§8.7（2026-10-19 用户批准）由 5 提到 8：去掉"偏少"倾向、加按类清单后防止被上限截断。按 §2.2 是代码常量，不做配置项。 */
export const ONE_PASS_MAX_ITEMS = 8;

/**
 * §8.7 修法 2：按类清单（只在心里过，不输出过程）。和评测 12 的召回版提示词 V1（版本 eea066fc04d0）逐字相同，
 * 改这里或标准、判断要点都会改变 PROMPT_VERSION；《好记忆的标准》本身一字不改（§8.7 不做修法 5）。
 */
export const ONE_PASS_CHECKLIST = `## 先逐类过一遍（只在心里过，不输出过程）
从头到尾把会话扫一遍，下面每一类都要找，不要只挑最显眼的一两条：
1. 用户对干活方式的要求和纠正：汇报、验证、测试写法、改动范围、沟通方式。子代理会话里，派活提示中的通用干活方法照常算，只丢一次性任务限制。
2. 本项目的设计决定和理由、模块职责、跨多处的契约和对外接口约定。
3. 工具输出里的失败或意外：原因不是报错一眼能看出、换个任务还会撞上的坑（包括环境、分支、构建来源、宿主差异这类排查陷阱）。
4. 用户机器和测试环境的具体事实（怎么连、哪个端口、哪个目录、用哪个命令）。
每一类找到的都按标准过一遍：合格的都给出，不合格的不给。同一件事只给一条。

`;

export const ONE_PASS_SYSTEM = `你是 agentbrain 的记忆员。你读一段已经结束的编码会话（一个话题），按下面的《好记忆的标准》决定这段会话里有没有值得长期记住的东西，一次给出最终结论。你的结论会直接写进记忆库（可撤销，状态是未确认）。漏记和错记一样有代价：合格的记忆没记下来，下一个 agent 就会再踩一次。

${GOOD_MEMORY_STANDARD}

${ONE_PASS_CHECKLIST}## 你的任务
对这段会话给出 0 到 ${ONE_PASS_MAX_ITEMS} 条结论，每条二选一：
- new：一条已有记忆里没有的、合格的新记忆。text 写成一句可照着做的原则（不写本次/日期/内部 id），scenario 以"当…时"开头且不是正文换个说法，why 写当时发生了什么、用户为什么这样要求。
- merge：会话里的东西和 <existing_memories> 里某条讲的是同一件事；into 填那条的编号（m1、m2…），text 写合并后的完整原则。
没有合格内容时 items 给空数组，不要为了有产出硬凑；但一段长会话里常常有好几条合格的，不要只给最显眼的一两条。
同一件事只给一条。<confirmed_memories> 里已经有的不要再记。
<context_only> 里的内容只供理解，不能当依据。

下面的判断要点原本写给逐条审稿人：其中 discard 就是"不记"，keep/rewrite 就是 new（按标准写好），merge 就是 merge。

${JUDGE_RULES}
- 格式硬要求：每条必须给 kind（rule/decision/pitfall）、class（A/B/C）和以"当"开头、含"时"的 scenario；merge 必须给存在的 into。缺这些的结论作废。

只输出 JSON：{"items":[{"action":"new|merge","into":"m1（merge 必填）","kind":"rule|decision|pitfall","class":"A|B|C","text":"…","scenario":"当…时","why":"…","guidance":false,"reason":"一句话：为什么值得记"}]}`;

/** 子代理会话说明：按 v4 标准（2026-10-14 用户定）——派活提示不算用户原话，但其中的通用干活方法照常按 A 类判断，只丢一次性任务限制；agent 自己观察到的坑、设计理由照常记。抽取器那条 WORKER_NOTE 更严，一步式不用它。 */
export const ONE_PASS_WORKER_NOTE = `注意：这是被委派的子代理（worker）会话。记录里的 user 轮是父 agent 写的派活提示，不是用户本人的话，不能单独证明"用户要求"；但其中的通用干活方法（测试写法、验证方式、临时产物放哪）按内容当 A 类判断，只有一次性任务限制不记。agent 自己从工具输出观察到的坑、代码里的设计理由，照常按 C/B 类判断。`;

export function buildOnePassMessages(win: ExtractWindow, ctx: ProjectContext, neighbors: Proposition[]): ChatMessage[] {
  return [
    { role: "system", content: ONE_PASS_SYSTEM },
    { role: "user", content: buildInput(win, ctx, neighbors, ONE_PASS_WORKER_NOTE) },
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
  /** A 类一律 true（与审稿链路 review.ts normalize 同口径：标准写明 A 类"确认后每轮常驻注入"，不靠模型记得标）。 */
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
    // 先校验再数上限：超限之后的坏条按真实原因计数，too_many 只数"合格但超出上限"的（上限只数合格条）
    if (items.length >= ONE_PASS_MAX_ITEMS) { bad("too_many"); continue; }
    items.push({ action: v.action, into, kind: v.kind, class: v.class, text, scenario, why: typeof v.why === "string" && v.why.trim() ? v.why.trim() : null, guidance: v.guidance === true || v.class === "A", reason: typeof v.reason === "string" ? v.reason : "" });
  }
  return { items, invalid };
}
