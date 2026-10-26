/** brief / recall / CLI 共用的展示与查找小工具。 */
import type { Store } from "./store.ts";
import type { PropKind, Proposition } from "./l2.ts";

export const KIND_LABEL: Record<PropKind, string> = { rule: "规则", decision: "决定", pitfall: "坑", note: "事实" };

export function short(id: string): string {
  return id.slice(0, 8);
}

export function disputed(p: Proposition): string {
  return p.pending_corrections.length ? `（有待确认的纠正 ${p.pending_corrections.map((id) => `[${short(id)}]`).join("")}）` : "";
}

export function active(store: Store): Proposition[] {
  return [...store.project().props.values()].filter((p) => p.state === "active");
}

/** "为什么"在搜索结果里最多显示多少字（§11.5 (ii)）。 */
export const SEARCH_WHY_MAX_CHARS = 200;

/**
 * 搜索结果显示全文（§11.5 (ii)，2026-10-16 用户批准）：正文全部打印（多行时后续行缩进），
 * 有"为什么"打一行（最多 200 字，超出加"…"），有场景（value.scenario 或 trigger）打一行。来源和近邻仍用 ab get。
 */
export function searchDetail(text: string, p: Partial<Pick<Proposition, "why" | "trigger" | "value">> | undefined): string {
  const [first, ...rest] = text.split("\n");
  const out = [first, ...rest.map((l) => `  ${l}`)];
  const why = p?.why?.replace(/\s+/g, " ").trim();
  if (why) out.push(`  为什么: ${why.length > SEARCH_WHY_MAX_CHARS ? why.slice(0, SEARCH_WHY_MAX_CHARS) + "…" : why}`);
  const scene = (p?.value?.scenario ?? p?.trigger)?.replace(/\s+/g, " ").trim();
  if (scene) out.push(`  场景: ${scene}`);
  return out.join("\n");
}
