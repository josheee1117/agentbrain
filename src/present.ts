/** brief / recall / CLI 共用的展示与查找小工具。 */
import type { Store } from "./store.ts";
import { KIND_LABEL, type PropKind, type Proposition } from "./l2.ts";

export { KIND_LABEL };

export function short(id: string): string {
  return id.slice(0, 8);
}

export function disputed(p: Proposition): string {
  const conflicts = p.conflicts.map((id) => `与 [${short(id)}] 冲突`);
  const corrections = p.pending_corrections.length ? [`有待确认的纠正 ${p.pending_corrections.map((id) => `[${short(id)}]`).join("")}`] : [];
  const marks = [...conflicts, ...corrections];
  return marks.length ? `（${marks.join("；")}）` : "";
}

export function active(store: Store): Proposition[] {
  return [...store.project().props.values()].filter((p) => p.state === "active");
}

/** "为什么"在搜索结果里最多显示多少字（§11.5 (ii)）。 */
export const SEARCH_WHY_MAX_CHARS = 200;
/** 搜索结果里带详情正文的条目显示前多少字（§8.11.4）。 */
export const SEARCH_BODY_MAX_CHARS = 300;

/**
 * 搜索结果显示全文（§11.5 (ii)，2026-10-16 用户批准）：正文全部打印（多行时后续行缩进），
 * 有"为什么"打一行（最多 200 字，超出加"…"），有场景（value.scenario 或 trigger）打一行。
 * 带详情正文的显示正文前 300 字，再提示用 ab get 看全文（§8.11.4）。来源和近邻仍用 ab get。
 */
export function searchDetail(text: string, p: Partial<Pick<Proposition, "id" | "why" | "body" | "trigger" | "value">> | undefined): string {
  const [first, ...rest] = text.split("\n");
  const out = [first, ...rest.map((l) => `  ${l}`)];
  const why = p?.why?.replace(/\s+/g, " ").trim();
  if (why) out.push(`  为什么: ${why.length > SEARCH_WHY_MAX_CHARS ? why.slice(0, SEARCH_WHY_MAX_CHARS) + "…" : why}`);
  const scene = (p?.value?.scenario ?? p?.trigger)?.replace(/\s+/g, " ").trim();
  if (scene) out.push(`  场景: ${scene}`);
  const body = p?.body?.trim();
  if (body && p?.id) {
    const chars = [...body];
    out.push(`  正文: ${chars.length > SEARCH_BODY_MAX_CHARS ? chars.slice(0, SEARCH_BODY_MAX_CHARS).join("") + "…" : body}`);
    out.push(`  ab get ${short(p.id)} 看全文`);
  }
  return out.join("\n");
}

/**
 * ab get 的原话块（§8.11.4）：主来源和追加来源的全部引文，带角色和时间，没时间写"时间未知"。
 * 追加来源的引文末尾标上它来自哪次会话。
 */
export function quoteLines(p: Proposition): string[] {
  const one = (e: Proposition["evidence"][number], from?: string) =>
    `  [${e.role} ${e.said_at ?? "时间未知"}] ${e.quote ?? "（旧数据只存了哈希，原文没留下）"}${from ? `（来源 ${from}）` : ""}`;
  const rows = p.evidence.map((e) => one(e));
  for (const s of p.extra_sources) {
    const from = `${s.host ?? "未知宿主"}:${(s.session_id ?? "?").slice(0, 8)}`;
    rows.push(...s.evidence.map((e) => one(e, from)));
  }
  return rows.length ? ["原话:", ...rows] : [];
}
