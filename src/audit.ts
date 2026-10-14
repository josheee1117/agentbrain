/**
 * 价值审计（§21 2026-10-14）B：找出"用户原话"其实是父 agent 写给 worker 的派活提示的条目。
 * 只读投影，给出计划；写入由调用方决定（ab audit worker-quotes --apply）。
 */
import type { Host, Proposition } from "./l2.ts";

const USER_BASES = new Set(["user_directive", "user_confirmed"]);

export interface WorkerQuotePlan {
  /** 自动转正（印证、代码核验）或未确认：撤销自动转正并标记，不再按"有用户原话"对待。 */
  demote: Proposition[];
  /** 用户亲自确认过：不自动改，列给用户复核。 */
  review: Proposition[];
}

/**
 * 一条记忆的"用户原话"来源全部来自 worker 会话（至少一处）时入选；只要有一处来自主会话就不动。
 * transcript 找不到或读不了的来源按主会话处理（宁可漏，不误伤）。
 */
export function workerQuoteAudit(
  props: Iterable<Proposition>,
  transcriptOf: (host: Host | null, sessionId: string | null) => string | null,
  isWorker: (file: string | null) => boolean,
): WorkerQuotePlan {
  const plan: WorkerQuotePlan = { demote: [], review: [] };
  const memo = new Map<string, boolean>();
  const worker = (host: Host | null, sid: string | null, file: string | null) => {
    const key = `${host}:${sid}`;
    if (!memo.has(key)) memo.set(key, isWorker(file ?? transcriptOf(host, sid)));
    return memo.get(key)!;
  };
  for (const p of props) {
    if (p.state !== "active" || p.origin !== "extract" || p.demoted) continue;
    const sources: boolean[] = [];
    if (USER_BASES.has(p.basis ?? "") && p.evidence.some((e) => e.role === "user")) sources.push(worker(p.source.host, p.source.session_id, p.source.transcript));
    for (const s of p.extra_sources) if (USER_BASES.has(s.basis) && s.quote_sha256.length) sources.push(worker(s.host, s.session_id, null));
    if (!sources.length || !sources.every(Boolean)) continue;
    (p.confirmed && p.confirmed_by === "user" ? plan.review : plan.demote).push(p);
  }
  return plan;
}
