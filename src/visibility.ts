/**
 * 谁能看到一条记忆（§8.8）：状态只说还在不在用，可信程度单独看。
 * 搜索、近邻、每轮召回都从这里取规则，不在各处各写一份。
 */
import type { PropKind, Proposition } from "./l2.ts";

export type Trust = "user" | "code" | "corroboration" | "unconfirmed";

export const RECALL_KINDS: readonly PropKind[] = ["pitfall", "rule", "decision"];

export function trustOf(p: Proposition): Trust {
  return p.confirmed ? (p.confirmed_by ?? "user") : "unconfirmed";
}

/** 搜索和近邻：有效的都能看到，未确认的照样列出、带标记。 */
export function searchable(p: Proposition): boolean {
  return p.state === "active";
}

/** 有冲突、有待确认纠正、关系未判定、与代码不符，或本身是纠正：这类未确认条目有争议，不主动注入。 */
function disputedUnconfirmed(p: Proposition): boolean {
  return p.unreconciled || !!p.stale || p.conflicts.length > 0 || !!p.supersedes || p.pending_corrections.length > 0;
}

export function staleBlocked(p: Proposition): boolean {
  return !!p.stale && (!p.confirmed || p.confirmed_by === "code");
}

export function staleWarning(p: Pick<Proposition, "stale" | "confirmed" | "confirmed_by">): boolean {
  return !!p.stale && p.confirmed && p.confirmed_by !== "code";
}

/** 能占保底位的纠正：已确认、替代过旧条目，且自己没有争议。 */
export function isConfirmedCorrection(p: Proposition): boolean {
  return p.confirmed && !!p.supersedes && !p.pending_corrections.length && !p.conflicts.length && !p.stale;
}

/**
 * 每轮召回的资格（不含项目范围，范围由 recall 按当前目录判）。
 * 主会话：坑、规则、决定，已确认的都行；未确认的只要没争议（§21 2026-10-14 放宽 D3）。
 * 子代理（worker）：未确认的只放有用户原话的规则或决定，撤销过自动转正的不放（D3 原规矩）。
 */
export function recallable(p: Proposition, worker: boolean): boolean {
  if (p.state !== "active") return false;
  if (p.superseded_draft) return false;
  if (staleBlocked(p)) return false;
  if (isConfirmedCorrection(p)) return true;
  if (!RECALL_KINDS.includes(p.kind)) return false;
  if (p.confirmed) return true;
  if (disputedUnconfirmed(p)) return false;
  if (!worker) return true;
  return (
    (p.kind === "rule" || p.kind === "decision") &&
    (p.basis === "user_directive" || p.basis === "user_confirmed") &&
    p.evidence.some((e) => e.role === "user") &&
    !p.demoted
  );
}
