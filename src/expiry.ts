/**
 * 到期复审（§21 2026-10-14）：未确认条目过了预计有效期、期间也没被注入过，就进复审清单。
 * 只列出，不自动动：归档要用户（或代理按用户要求）跑 `ab review --archive`，归档可用 ab archive --reactivate 撤销。
 * 已确认的条目（任何途径）永远不进清单。
 */
import type { PropKind, Proposition } from "./l2.ts";

export const DEFAULT_VALID_DAYS: Record<PropKind, number> = { pitfall: 90, note: 90, decision: 180, rule: 180 };
const DAY_MS = 86_400_000;

export interface Usage {
  last_used: string;
  uses: number;
}

export interface ReviewItem {
  prop: Proposition;
  validDays: number;
  /** 计时起点：最近一次被注入，没用过就是记下的时间。 */
  since: string;
  lastUsed: string | null;
  /** 已超期天数。 */
  overdueDays: number;
}

export function validDays(p: Proposition): number {
  return p.valid_days ?? DEFAULT_VALID_DAYS[p.kind];
}

/** 到期待复审：active、未确认、自 max(记下时间, 最近注入) 起超过有效天数。最久超期的在前。 */
export function reviewList(props: Iterable<Proposition>, usage: Map<string, Usage>, now: Date): ReviewItem[] {
  const out: ReviewItem[] = [];
  for (const p of props) {
    if (p.state !== "active" || p.confirmed) continue;
    const lastUsed = usage.get(p.id)?.last_used ?? null;
    const since = lastUsed && lastUsed > p.ts ? lastUsed : p.ts;
    const days = validDays(p);
    const overdue = Math.floor((now.getTime() - Date.parse(since)) / DAY_MS) - days;
    if (overdue > 0) out.push({ prop: p, validDays: days, since, lastUsed, overdueDays: overdue });
  }
  return out.sort((a, b) => b.overdueDays - a.overdueDays);
}
