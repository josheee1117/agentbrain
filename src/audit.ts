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
  /** 这条的原话在用户主会话里也逐字出现过（父 agent 只是转抄）：不撤销。缺省不查。 */
  saidInMain: (p: Proposition) => boolean = () => false,
): WorkerQuotePlan {
  const plan: WorkerQuotePlan = { demote: [], review: [] };
  const memo = new Map<string, boolean>();
  const worker = (host: Host | null, sid: string | null, file: string | null) => {
    const key = `${host}:${sid}`;
    if (!memo.has(key)) memo.set(key, isWorker(file ?? transcriptOf(host, sid)));
    return memo.get(key)!;
  };
  const all = [...props];
  const byId = new Map(all.map((p) => [p.id, p]));
  for (const p of all) {
    if (p.state !== "active" || p.origin !== "extract" || p.demoted) continue;
    // 关系判定认定它和一条用户亲自确认的条目是同一条规则（重复或细化）：用户说过这条规则，派活提示只是转述
    const rel = p.related && (p.related.outcome === "duplicate" || p.related.outcome === "refines") && p.related.target ? byId.get(p.related.target) : undefined;
    if (rel && rel.state === "active" && rel.confirmed && rel.confirmed_by === "user") continue;
    const sources: boolean[] = [];
    if (USER_BASES.has(p.basis ?? "") && p.evidence.some((e) => e.role === "user")) sources.push(worker(p.source.host, p.source.session_id, p.source.transcript));
    for (const s of p.extra_sources) if (USER_BASES.has(s.basis) && s.quote_sha256.length) sources.push(worker(s.host, s.session_id, null));
    if (!sources.length || !sources.every(Boolean)) continue;
    if (saidInMain(p)) continue;
    (p.confirmed && p.confirmed_by === "user" ? plan.review : plan.demote).push(p);
  }
  return plan;
}

// ---------- 主会话里也有同一段原话：父 agent 只是把用户的话转抄进派活提示，不算 worker-only ----------

const GRAM = 4;
const MIN_QUOTE = 4;
const MAX_QUOTE = 200;
const normText = (s: string) => s.replace(/\s+/g, " ").trim();

/** 用户主会话里亲口说过的话（已脱敏、按抽取时的规则压空白）：4 字片段索引 + 原文，供逐字比对。 */
export class MainSaid {
  private readonly grams = new Set<string>();
  private readonly texts: string[] = [];
  add(text: string): void {
    const t = normText(text);
    if (t.length < MIN_QUOTE) return;
    this.texts.push(t);
    for (let i = 0; i + GRAM <= t.length; i++) this.grams.add(t.slice(i, i + GRAM));
  }
  has(s: string): boolean {
    return this.texts.some((t) => t.includes(s));
  }
  /**
   * worker 派活提示 texts 里，哪些片段的 sha256 落在 wanted 里、且这段原文也出现在主会话里。
   * 只在"每个 4 字片段都在主会话出现过"的连续区间里枚举子串算哈希，避免对整段提示做全量枚举。
   */
  quotedIn(texts: readonly string[], wanted: ReadonlySet<string>, sha256: (s: string) => string): boolean {
    if (!wanted.size) return false;
    for (const raw of texts) {
      const t = normText(raw);
      let i = 0;
      while (i + GRAM <= t.length) {
        if (!this.grams.has(t.slice(i, i + GRAM))) {
          i++;
          continue;
        }
        let end = i + GRAM; // [i, end) 内每个 4 字片段都在主会话里出现过
        while (end < t.length && this.grams.has(t.slice(end - GRAM + 1, end + 1))) end++;
        for (let a = i; a + MIN_QUOTE <= end; a++)
          for (let b = a + MIN_QUOTE; b <= Math.min(end, a + MAX_QUOTE); b++) {
            const s = t.slice(a, b);
            if (wanted.has(sha256(s)) && this.has(s)) return true;
            const trimmed = s.trim();
            if (trimmed !== s && trimmed.length >= MIN_QUOTE && wanted.has(sha256(trimmed)) && this.has(trimmed)) return true;
          }
        i = end - GRAM + 1;
      }
    }
    return false;
  }
}

/** 一条记忆的所有用户原话哈希（主来源 + 附加来源）。 */
export function userQuoteHashes(p: Proposition): Set<string> {
  const out = new Set<string>();
  for (const e of p.evidence) if (e.role === "user") out.add(e.quote_sha256);
  for (const s of p.extra_sources) for (const h of s.quote_sha256) out.add(h);
  return out;
}
