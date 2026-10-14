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

export function projectIdByName(store: Store, name: string): string {
  const hit = store.listProjects().find((p) => p.name === name);
  return hit ? hit.id : store.ensureProject(name);
}
