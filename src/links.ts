/**
 * 显式关联（§11.6 (ii)，2026-10-19 用户批准）：从投影里算出一条记忆的双向关联，供 ab search / ab get 显示。
 * 只用已经存在的关系字段（refines、merged_into、supersedes、conflicts_with），两个方向都算，对方已归档、已替代也算。
 * 只读、不扩展：调用方只列 id 和一句话，不把对方变成结果行，也不沿关联继续走（与评测 08 的决定一致）。
 */
import type { Proposition } from "./l2.ts";

export type LinkType = "refines" | "refined_by" | "merged_into" | "merged_from" | "supersedes" | "corrected_by" | "conflicts";

export interface Link {
  type: LinkType;
  id: string;
}

/** 关联的显示顺序：先本条指出去的，再别人指向本条的。 */
const ORDER: LinkType[] = ["merged_into", "supersedes", "refines", "conflicts", "corrected_by", "refined_by", "merged_from"];

/** 一次算出全库每条记忆的双向关联（按 id 去重，同一对只保留一种关系，优先级见 ORDER）。 */
export function linkIndex(props: ReadonlyMap<string, Proposition>): Map<string, Link[]> {
  const out = new Map<string, Link[]>();
  const add = (from: string, type: LinkType, to: string | null | undefined) => {
    if (!to || to === from || !props.has(from) || !props.has(to)) return;
    const list = out.get(from) ?? [];
    const i = list.findIndex((l) => l.id === to);
    if (i >= 0) {
      if (ORDER.indexOf(type) < ORDER.indexOf(list[i].type)) list[i] = { type, id: to };
    } else list.push({ type, id: to });
    out.set(from, list);
  };
  for (const p of props.values()) {
    if (p.related?.outcome === "refines") {
      add(p.id, "refines", p.related.target);
      add(p.related.target ?? "", "refined_by", p.id);
    }
    if (p.merged_into) {
      add(p.id, "merged_into", p.merged_into);
      add(p.merged_into, "merged_from", p.id);
    }
    if (p.supersedes) {
      add(p.id, "supersedes", p.supersedes);
      add(p.supersedes, "corrected_by", p.id);
    }
    if (p.conflicts_with) {
      add(p.id, "conflicts", p.conflicts_with);
      add(p.conflicts_with, "conflicts", p.id);
    }
  }
  for (const list of out.values()) list.sort((a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type));
  return out;
}

/** 对方的状态标记：有效的不标。 */
export function stateMark(p: Proposition): string {
  return p.state === "archived" ? "（已归档）" : p.state === "superseded" ? "（已被替代）" : "";
}

/** 搜索结果里一行"关联"：每条最多 max 个，超出提示用 ab get。没有关联返回空串。 */
export function linkSummary(links: Link[], props: ReadonlyMap<string, Proposition>, short: (id: string) => string, max = 3): string {
  if (!links.length) return "";
  const phrase = (l: Link) => {
    const t = props.get(l.id)!;
    const ref = `[${short(l.id)}]${stateMark(t)}`;
    switch (l.type) {
      case "refines": return `补充了 ${ref}`;
      case "refined_by": return `被 ${ref} 补充`;
      case "merged_into": return `已并入 ${ref}`;
      case "merged_from": return `合并自 ${ref}`;
      case "supersedes": return `纠正了 ${ref}`;
      case "corrected_by": return `被 ${ref} 纠正`;
      case "conflicts": return `与 ${ref} 冲突`;
    }
  };
  const shown = links.slice(0, max).map(phrase).join("；");
  return links.length > max ? `${shown}；另有 ${links.length - max} 个，ab get 看` : shown;
}

/** ab get 里每个关联的标签。 */
export const LINK_LABEL: Record<LinkType, string> = {
  refines: "补充了",
  refined_by: "被它补充",
  merged_into: "已并入",
  merged_from: "合并自",
  supersedes: "纠正了",
  corrected_by: "被它纠正",
  conflicts: "与之冲突",
};

/** 正文第一行，最多 n 个字（按字符计），超出加"…"。 */
export function firstLine(text: string, n: number): string {
  const line = text.split("\n").map((s) => s.trim()).find(Boolean) ?? "";
  const cs = [...line];
  return cs.length > n ? cs.slice(0, n).join("") + "…" : line;
}
