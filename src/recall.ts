/** ab recall（每轮召回，§21 D3）：按提示词召回当前项目的坑/规则/决定。只拼文本；embedder 由调用方按需给（提示词被跳过时不取；null 时只走全文检索）。 */
import type { Embedder, Store } from "./store.ts";
import { recallableUnconfirmed, type PropKind, type Proposition } from "./l2.ts";
import { resolveProject } from "./registry.ts";
import { CITE_CHECK_BUDGET_MS, citationsStale } from "./citecheck.ts";
import { disputed, KIND_LABEL, projectIdByName, short } from "./present.ts";

export const RECALL_MAX_ITEMS = 3;
export const RECALL_MAX_CHARS = 600;
// 测试集上 0.55 负例误报 0%、召回 63%；0.50 召回 87% 但误报 13%。每轮注入宁缺毋滥。
const RECALL_MIN_SIM = 0.55;
const RECALL_KINDS: PropKind[] = ["pitfall", "rule", "decision"];
/** 用户纠正的保底位（§21 2026-10-14，参考 DeerMem 的 correction 预算）：相关的已确认纠正先占位、最先输出，不被其他条目挤掉。 */
export const RECALL_CORRECTION_SLOTS = 1;

/**
 * 能占保底位的纠正：已确认、替代过旧条目（任何种类，事实被纠正也要带上），
 * 且自己没有待确认的更正、没有冲突（否则"纠正"本身就有争议，不该顶到第一位）。
 */
export function isConfirmedCorrection(p: Proposition): boolean {
  return p.confirmed && !!p.supersedes && !p.pending_corrections.length && !p.conflicts_with;
}

/**
 * 命中时返回 <agentbrain-recall> 块；跳过或没有命中返回空串。shown（可选）收集实际输出的条目 id；
 * stale（可选）收集代码引文核对失败、标了"可能过时"的条目 id，由调用方排队重新核验。
 */
export async function recall(store: Store, query: string, cwd: string, getEmbedder: () => Embedder | null, shown: string[] = [], stale: string[] = []): Promise<string> {
  const prompt = query.trim();
  if (prompt.length < 4 || prompt.startsWith("/")) return "";
  const here = resolveProject(cwd);
  const projects = here ? [projectIdByName(store, here.name)] : [];
  const embedder = getEmbedder();
  const { hits } = await store.searchHybrid(prompt, {
    projects,
    includeGlobal: true,
    includeArchived: true,
    limit: 20,
    skipSync: true,
    minSim: RECALL_MIN_SIM,
  }, embedder);
  const props = store.project().props;
  const inScope = (p: Proposition) => {
    if (p.project_id === null && !p.for_workers) return false;
    if (p.project_id !== null && (!here || p.project_id !== projects[0])) return false;
    return true;
  };
  const ranked = hits.map((h) => props.get(h.id)).filter((p): p is Proposition => !!p && p.state === "active" && inScope(p));
  // 保底位只给向量相似度过门槛的纠正：纯全文检索命中（RRF 融合不受门槛约束）可能只是弱相关，不能跳到第一
  const similar = new Set(hits.filter((h) => (h.similarity ?? 0) >= RECALL_MIN_SIM).map((h) => h.id));
  const corrections = ranked.filter((p) => isConfirmedCorrection(p) && similar.has(p.id)).slice(0, RECALL_CORRECTION_SLOTS);
  const confirmed = [
    ...corrections,
    ...ranked.filter((p) => p.confirmed && RECALL_KINDS.includes(p.kind) && !corrections.includes(p)).slice(0, RECALL_MAX_ITEMS - corrections.length),
  ];
  // D3（§21 2026-10-13）：有用户原话依据的未确认规则/决定，最多 1 条，排在已确认之后
  const extra = confirmed.length < RECALL_MAX_ITEMS ? ranked.find(recallableUnconfirmed) : undefined;
  const picked = extra ? [...confirmed, extra] : confirmed;
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
