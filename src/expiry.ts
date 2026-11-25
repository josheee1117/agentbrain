/**
 * 到期复审（§21 2026-10-14）：未确认条目过了预计有效期、期间也没被注入过，就进复审清单。
 * 只列出，不自动动：归档要用户（或代理按用户要求）跑 `ab review --archive`，归档可用 ab archive --reactivate 撤销。
 * 已确认的条目（任何途径）永远不进清单。
 */
import type { PropKind, Proposition } from "./l2.ts";
import { sessionStart } from "./work.ts";
import { resolveTranscript } from "./transcript-file.ts";

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

/** 条目的起算时间：原话时间（said_at）；旧条目没有就用来源会话的开始时间；都没有才用写入时间。 */
export type Clock = (p: Proposition) => string;

/** 默认时钟只看条目自身（said_at，否则写入时间），不读文件。 */
export const ownClock: Clock = (p) => p.said_at ?? p.ts;

/**
 * 读路径用的时钟：旧条目没有 said_at 时，用来源 transcript 的会话开始时间（"全部重跑"不会改它），
 * 避免重跑把所有条目的起算时间挤到同几天。按文件缓存。
 */
export function sourceClock(): Clock {
  const cache = new Map<string, string | null>();
  return (p) => {
    if (p.said_at) return p.said_at;
    const file = p.source.transcript;
    if (!file) return p.ts;
    // 缓存键用解析后的路径：`.jsonl` 与 `.jsonl.zst` 是同一份 transcript（§7.6）
    const key = resolveTranscript(file) ?? file;
    if (!cache.has(key)) {
      const ms = sessionStart(key);
      cache.set(key, ms === null ? null : new Date(ms).toISOString());
    }
    const start = cache.get(key);
    return start && start < p.ts ? start : p.ts;
  };
}

/** 到期待复审：active、未确认、自 max(起算时间, 最近注入) 起超过有效天数。最久超期的在前。 */
export function reviewList(props: Iterable<Proposition>, usage: Map<string, Usage>, now: Date, clock: Clock = ownClock): ReviewItem[] {
  const out: ReviewItem[] = [];
  for (const p of props) {
    if (p.state !== "active" || p.confirmed || p.superseded_draft) continue;
    const lastUsed = usage.get(p.id)?.last_used ?? null;
    const start = clock(p);
    const since = lastUsed && lastUsed > start ? lastUsed : start;
    const days = validDays(p);
    const overdue = Math.floor((now.getTime() - Date.parse(since)) / DAY_MS) - days;
    if (overdue > 0) out.push({ prop: p, validDays: days, since, lastUsed, overdueDays: overdue });
  }
  return out.sort((a, b) => b.overdueDays - a.overdueDays);
}
