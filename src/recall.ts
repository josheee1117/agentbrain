/** ab recall（每轮召回，§21 D3）：按提示词召回当前项目的坑/规则/决定。只拼文本；embedder 由调用方按需给（提示词被跳过时不取；null 或出错时只走字面通道，门槛更严）。 */
import type { Embedder, Store } from "./store.ts";
import type { Proposition } from "./l2.ts";
import { indexText } from "./store.ts";
import { isConfirmedCorrection, RECALL_KINDS, recallable } from "./visibility.ts";
import { resolveProject } from "./registry.ts";
import { CITE_CHECK_BUDGET_MS, citationsStale } from "./citecheck.ts";
import { disputed, KIND_LABEL, short } from "./present.ts";
import { LexIndex, lexTokens } from "./lexical.ts";

export const RECALL_MAX_ITEMS = 3;
export const RECALL_MAX_CHARS = 600;
/** 用户纠正的保底位（§21 2026-10-14，参考 DeerMem 的 correction 预算）：相关的已确认纠正先占位、最先输出，不被其他条目挤掉。 */
export const RECALL_CORRECTION_SLOTS = 1;
/** 送去算向量的提示词最多取这么多字符：长粘贴（日志、diff）只会稀释意图。 */
const RECALL_QUERY_CHARS = 800;

/**
 * 打分与门槛（2026-10-14 召回评测集 recall-eval 的 tune 切分上校准，test 切分只用于最后报数）。
 * score = 向量余弦 + LEX_WEIGHT × 字面覆盖率。一条要进，须同时满足：
 * - 绝对门槛：余弦 ≥ MIN_SIM；或余弦 ≥ MIN_SIM_LEX 且字面覆盖率 ≥ LEX_STRONG（字面强命中能把略低的向量拉进来）；
 * - 相对门槛：score ≥ 本轮最高分 − REL_MARGIN（远落后于第一名的不凑数）。
 * 没有 embedder 或向量调用失败时只看字面：覆盖率 ≥ LEX_ONLY。
 * tune 切分上的取舍：MIN_SIM 0.62 是为了挡掉 0.60 左右的无关命中（"agentbrain 抽取模型用哪个"这类库里根本没有的问题）；
 * 只看字面时 0.4 负例零误报、命中率约为有向量时的三分之一，只当降级用。
 */
export const RECALL_TUNING = {
  MIN_SIM: 0.62,
  MIN_SIM_LEX: 0.5,
  LEX_STRONG: 0.5,
  LEX_WEIGHT: 0.2,
  REL_MARGIN: 0.1,
  LEX_ONLY: 0.4,
};

/** 提示词里去掉不代表意图的部分：宿主注入的标签块、代码块、URL。 */
function queryText(prompt: string): string {
  return prompt
    .replace(/<([a-zA-Z][\w-]*)[^>]*>[\s\S]*?<\/\1>/g, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 命中时返回 <agentbrain-recall> 块；跳过或没有命中返回空串。shown（可选）收集实际输出的条目 id；
 * stale（可选）收集代码引文核对失败、标了"可能过时"的条目 id，由调用方排队重新核验。
 */
export async function recall(
  store: Store,
  query: string,
  cwd: string,
  getEmbedder: () => Embedder | null,
  shown: string[] = [],
  stale: string[] = [],
  resolve: (cwd: string) => { name: string; path: string } | null = resolveProject,
  worker = false,
): Promise<string> {
  const prompt = query.trim();
  if (prompt.length < 4 || prompt.startsWith("/")) return "";
  const text = queryText(prompt);
  if ([...text].length < 2) return "";
  const here = resolve(cwd);
  const projectId = here ? store.ensureProject(here.name) : null;
  const props = store.project().props;
  // 全局条目（不论 for_workers）都进主会话每轮召回；for_workers 只决定子代理能不能看到（§21 2026-10-14 用户批准放宽）
  // 子代理/被委派的 worker 会话（worker=true）仍按旧规矩：全局只看 for_workers，未确认只放有用户原话的规则/决定（D3）
  const inScope = (p: Proposition) => (p.project_id === null ? (worker ? p.for_workers : true) : !!here && p.project_id === projectId);
  // 资格过滤在打分、截取之前做完（坑 43150a18）：不合格的条目不能占候选位
  const active = [...props.values()].filter((p) => p.state === "active");
  const eligible = active.filter((p) => inScope(p) && recallable(p, worker));
  if (!eligible.length) return "";
  const lex = new LexIndex(active.map((p) => ({ id: p.id, text: indexText(p) })));
  const qTokens = lexTokens(text);
  let sims: Map<string, number> | null = null;
  const embedder = getEmbedder();
  if (embedder) {
    try {
      const [vec] = await embedder([[...text].slice(0, RECALL_QUERY_CHARS).join("")]);
      if (vec) sims = store.similarities(vec, new Set(eligible.map((p) => p.id)));
    } catch {
      sims = null; // 向量不可用：退到只看字面，门槛更严
    }
  }
  const T = RECALL_TUNING;
  const scored = eligible
    .map((p) => {
      const cov = qTokens.size ? lex.coverage(qTokens, p.id) : 0;
      const sim = sims?.get(p.id);
      // 这条还没有（或正文变了、向量过期的）向量时，单条退回只看字面，不能因此永远召不回；
      // 过了字面门槛的按刚过向量门槛计分，免得被相对门槛（最高分 − REL_MARGIN）系统性挤掉
      const pass = sims && sim !== undefined ? sim >= T.MIN_SIM || (sim >= T.MIN_SIM_LEX && cov >= T.LEX_STRONG) : cov >= T.LEX_ONLY;
      return { p, sim: sim ?? 0, score: (sims ? (sim ?? T.MIN_SIM) : 0) + T.LEX_WEIGHT * cov, pass };
    })
    .filter((x) => x.pass)
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return "";
  const best = scored[0]!.score;
  const ranked = scored.filter((x) => x.score >= best - T.REL_MARGIN);
  // 保底位只给向量相似度过门槛的纠正：只靠字面命中的纠正可能只是弱相关，不能跳到第一
  const corrections = ranked
    .filter((x) => isConfirmedCorrection(x.p) && sims && x.sim >= T.MIN_SIM)
    .map((x) => x.p)
    .slice(0, RECALL_CORRECTION_SLOTS);
  // 按相关度挑：已确认的照排；D3 的未确认规则/决定最多 1 条，和已确认一起按分数竞争名额，输出时排在已确认之后
  const chosen: Proposition[] = [...corrections];
  let extra: Proposition | undefined;
  for (const { p } of ranked) {
    if (chosen.length + (extra ? 1 : 0) >= RECALL_MAX_ITEMS) break;
    if (corrections.includes(p)) continue;
    if (p.confirmed) {
      if (RECALL_KINDS.includes(p.kind)) chosen.push(p);
    } else if (!extra) extra = p;
  }
  const picked = extra ? [...chosen, extra] : chosen;
  if (!picked.length) return "";
  const head = "<agentbrain-recall>\n";
  const tail = "\n</agentbrain-recall>\n";
  const rows: string[] = [];
  const deadline = performance.now() + CITE_CHECK_BUDGET_MS;
  for (const p of picked) {
    const outdated = !!here && !!p.code_evidence && !p.stale && citationsStale(here.path, p.code_evidence.refs, deadline);
    const body = p.text.split(/\n+/).map((s) => s.trim()).filter(Boolean).join(" / ");
    let line = `- [${short(p.id)}] ${KIND_LABEL[p.kind]}${p.confirmed ? "" : "（未确认）"}${corrections.includes(p) ? `（纠正，替代 [${short(p.supersedes!)}]）` : ""}${disputed(p)}${outdated ? "（可能过时）" : ""}: ${body}`;
    const used = head.length + rows.join("\n").length + (rows.length ? 1 : 0) + tail.length;
    const room = RECALL_MAX_CHARS - used;
    if (room <= 0) break;
    if (line.length > room) {
      if (room < 2) break;
      line = line.slice(0, room - 1) + "…";
      rows.push(line);
      shown.push(p.id);
      if (outdated) stale.push(p.id);
      break;
    }
    rows.push(line);
    shown.push(p.id);
    if (outdated) stale.push(p.id);
  }
  if (!rows.length) return "";
  return head + rows.join("\n") + tail;
}

// ---------- 常驻偏好（§21 2026-10-14 价值审计 C） ----------

/** 每轮常驻注入的偏好块上限（字符，含首尾标签）。放不下的整条不放。 */
export const GUIDANCE_MAX_CHARS = 800;

/**
 * 每轮常驻的"怎么干活"偏好：用户确认过的全局 guidance 条目（说人话、结论写在回复正文里……），不看相似度。
 * 只放用户确认的（自动转正的不算）、没有争议的；子代理只看 for_workers 的。exclude 里的（本轮召回已给出的）不重复。
 * 带场景的条目直接跳过（§11.10）：场景规则只在对应场景由 brief / search --scene 给出，不能兜底成每轮常驻。
 */
export function guidanceBlock(props: Iterable<Proposition>, worker: boolean, exclude: ReadonlySet<string> = new Set(), shown: string[] = []): string {
  const rows = [...props]
    .filter(
      (p) =>
        p.state === "active" &&
        p.project_id === null &&
        p.guidance &&
        !p.scenes.length &&
        p.confirmed &&
        p.confirmed_by === "user" &&
        !p.pending_corrections.length &&
        !p.conflicts_with &&
        (!worker || p.for_workers) &&
        !exclude.has(p.id),
    )
    .sort((a, b) => b.seq - a.seq);
  if (!rows.length) return "";
  const head = "<agentbrain-prefs>\n用户的干活偏好（每轮常驻）：\n";
  const tail = "\n</agentbrain-prefs>\n";
  const lines: string[] = [];
  let used = head.length + tail.length;
  for (const p of rows) {
    const line = `- [${short(p.id)}] ${p.text.split(/\n+/).map((s) => s.trim()).filter(Boolean).join(" / ")}`;
    const add = line.length + (lines.length ? 1 : 0);
    if (used + add > GUIDANCE_MAX_CHARS) continue;
    lines.push(line);
    shown.push(p.id);
    used += add;
  }
  return lines.length ? head + lines.join("\n") + tail : "";
}
