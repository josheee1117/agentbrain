/** ab recall（每轮召回，§21 D3）：按提示词召回当前项目的坑/规则/决定。只拼文本；embedder 由调用方按需给（提示词被跳过时不取；null 或出错时只走字面通道，门槛更严）。 */
import type { Embedder, Store } from "./store.ts";
import type { Proposition } from "./l2.ts";
import { indexText } from "./store.ts";
import { isConfirmedCorrection, RECALL_KINDS, recallable } from "./visibility.ts";
import { resolveProject } from "./registry.ts";
import { CITE_CHECK_BUDGET_MS, citationsStale } from "./citecheck.ts";
import { disputed, KIND_LABEL, short, stalePrefix } from "./present.ts";
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
    let line = `- [${short(p.id)}] ${KIND_LABEL[p.kind]}${p.confirmed ? "" : "（未确认）"}${corrections.includes(p) ? `（纠正，替代 [${short(p.supersedes!)}]）` : ""}${disputed(p)}${outdated ? "（可能过时）" : ""}: ${stalePrefix(p)}${body}`;
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

// ---------- 每轮钩子轻量条件触发器（BM25 长度归一化 + 高区分词门控，<2.5ms 零网络） ----------

const HOOK_STOP_TOKENS = new Set([
  "git", "status", "branch", "main", "origin", "commit", "push", "npm", "run", "test", "typecheck",
  "src", "docs", "adr", "readme", "function", "return", "const", "let", "true", "false", "null", "array", "slice",
  "代码", "文件", "函数", "变量", "修改", "提交", "推送", "分支", "目录", "检查", "测试", "方案", "继续", "可以",
  "推荐", "状态", "报错", "类型", "解释", "一下", "看看", "现在", "刚才", "局部", "拼写", "错误", "最新", "三个",
  "谢谢", "收到", "下一步", "什么", "帮我", "直接", "加个", "写一", "合理", "我们", "需要", "不能", "不要",
  "怎么", "如何", "是不是", "能不能", "打算", "准备", "之后", "里面", "一个", "这个", "那个", "先看",
  "总结", "改动", "改变", "使用", "所有", "本次", "情况", "问题", "结果", "原因", "效果", "方法", "部分",
  "内容", "信息", "目前", "之前", "以后", "整体", "全部", "注意", "处理", "实现", "功能", "模块", "逻辑",
]);

/** 含中文虚词/代词/方位量词的跨边界二字切分（如“的改”“用的”“对我”）不算领域区分词。 */
const CJK_PARTICLE_CHAR = /[的了着过之与及或而对在把被给让跟从到向于为以因按由是有无会能可要就都也还又再只先不没别很更最这那你我他她它咱啥谁哪各每上下左右前后里外中内次个条项点处份种些]/;

export const HOOK_TRIGGER_TUNING = {
  MIN_PROMPT_CHARS: 14,
  MIN_QUERY_TOKENS: 3,
  MIN_TOKEN_IDF: 1.5,
  MIN_HITS: 2,
  MIN_MAX_IDF: 2.6,
  MIN_SCORE: 6.5,
  COV_SCORE: 5.5,
  MIN_COV: 0.22,
  B: 0.75,
  MAX_HINTS: 3,
  MAX_QUERY_CHARS: 400,
} as const;

function hookTokens(raw: string): Set<string> {
  const out = new Set<string>();
  for (const t of lexTokens(raw)) {
    if (t.length < 2 || HOOK_STOP_TOKENS.has(t)) continue;
    if (/^[\u3400-\u9fff\uf900-\ufaff]{2}$/.test(t) && CJK_PARTICLE_CHAR.test(t)) continue;
    out.add(t);
  }
  for (const m of raw.matchAll(/[A-Za-z][A-Za-z0-9_.-]{2,}|[0-9]{3,}/g)) {
    const w = m[0].toLowerCase();
    if (!HOOK_STOP_TOKENS.has(w)) out.add(w);
  }
  return out;
}

export interface ConditionalTriggerResult {
  block: string;
  ids: string[];
}

/**
 * 宿主每轮 UserPromptSubmit 的本地条件触发提示（纯内存 BM25，不调向量/网络）：
 * 常规操作/简短指令保持完全静默；只有提问命中具体窄域/防坑高区分词时，才输出短 ID 线索引导模型先跑 ab get。
 */
export function conditionalTriggerHint(
  store: Store,
  query: string,
  cwd: string,
  worker: boolean,
  exclude: ReadonlySet<string> = new Set(),
  resolve: (cwd: string) => { name: string; path: string } | null = resolveProject,
): ConditionalTriggerResult {
  const T = HOOK_TRIGGER_TUNING;
  const prompt = query.trim();
  if (prompt.length < T.MIN_PROMPT_CHARS || prompt.startsWith("/")) return { block: "", ids: [] };
  const cleaned = [...queryText(prompt)].slice(0, T.MAX_QUERY_CHARS).join("");
  if ([...cleaned].length < T.MIN_PROMPT_CHARS) return { block: "", ids: [] };
  const qToks = hookTokens(cleaned);
  if (qToks.size < T.MIN_QUERY_TOKENS) return { block: "", ids: [] };

  const here = resolve(cwd);
  const projectId = here ? store.listProjects().find((p) => p.name === here.name)?.id ?? null : null;
  const inScope = (p: Proposition) =>
    p.project_id === null ? (worker ? p.for_workers : true) : !!here && projectId !== null && p.project_id === projectId;

  const candidates = [...store.project().props.values()].filter(
    (p) => p.state === "active" && !exclude.has(p.id) && inScope(p) && (p.confirmed || recallable(p, worker)),
  );
  if (!candidates.length) return { block: "", ids: [] };

  const docTokMap = new Map<string, Set<string>>();
  const df = new Map<string, number>();
  let totalLen = 0;
  for (const p of candidates) {
    const headText = `${p.trigger ?? p.value?.scenario ?? ""} ${p.text} ${p.anchors.join(" ")}`;
    const toks = hookTokens(headText);
    docTokMap.set(p.id, toks);
    totalLen += toks.size;
    for (const t of toks) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const N = Math.max(1, candidates.length);
  const avgdl = Math.max(8, totalLen / N);

  const scored: { p: Proposition; score: number; terms: string[] }[] = [];
  for (const p of candidates) {
    const dToks = docTokMap.get(p.id)!;
    const normFactor = 1 - T.B + T.B * (dToks.size / avgdl);
    let bm25 = 0;
    let maxIdf = 0;
    const matchedTerms: { t: string; idf: number }[] = [];
    for (const qt of qToks) {
      if (!dToks.has(qt)) continue;
      const idf = Math.log(1 + (N - (df.get(qt) ?? 0) + 0.5) / ((df.get(qt) ?? 0) + 0.5));
      if (idf < T.MIN_TOKEN_IDF) continue;
      matchedTerms.push({ t: qt, idf });
      if (idf > maxIdf) maxIdf = idf;
      bm25 += idf / normFactor;
    }
    const hitCount = matchedTerms.length;
    const cov = hitCount / qToks.size;
    const boost = p.on_demand ? 1.25 : p.confirmed ? 1.1 : 0.95;
    const score = bm25 * boost;
    if (hitCount >= T.MIN_HITS && maxIdf >= T.MIN_MAX_IDF && (score >= T.MIN_SCORE || (cov >= T.MIN_COV && score >= T.COV_SCORE))) {
      matchedTerms.sort((a, b) => b.idf - a.idf);
      scored.push({ p, score, terms: matchedTerms.slice(0, 3).map((x) => x.t) });
    }
  }
  if (!scored.length) return { block: "", ids: [] };
  scored.sort((a, b) => b.score - a.score || b.p.seq - a.p.seq);
  const top = scored.slice(0, T.MAX_HINTS);
  const items = top.map(({ p, terms }) => `[${short(p.id)}] ${KIND_LABEL[p.kind]}（线索：${terms.join("、")}）`).join("；");
  const cmd = `ab get ${top.map(({ p }) => short(p.id)).join(" ")}`;
  return {
    block: `<agentbrain-recall>\n命中关联记忆线索：${items} → 动手前先跑 \`${cmd}\` 读原文。\n</agentbrain-recall>\n`,
    ids: top.map(({ p }) => p.id),
  };
}

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
        !p.conflicts.length &&
        (!worker || p.for_workers) &&
        !exclude.has(p.id),
    )
    .sort((a, b) => b.seq - a.seq);
  if (!rows.length) return "";
  const head = "<agentbrain-prefs>\n用户的干活偏好（会话首轮）：\n";
  const tail = "\n</agentbrain-prefs>\n";
  const lines: string[] = [];
  let used = head.length + tail.length;
  for (const p of rows) {
    const line = `- [${short(p.id)}] ${stalePrefix(p)}${p.text.split(/\n+/).map((s) => s.trim()).filter(Boolean).join(" / ")}`;
    const add = line.length + (lines.length ? 1 : 0);
    if (used + add > GUIDANCE_MAX_CHARS) continue;
    lines.push(line);
    shown.push(p.id);
    used += add;
  }
  return lines.length ? head + lines.join("\n") + tail : "";
}
