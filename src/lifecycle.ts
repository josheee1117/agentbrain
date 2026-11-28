/**
 * 四层记忆生命周期自动流转（L0 永久安全红线 / L1 常驻核心 / L2 按需温层 / L3 抽取草稿试用期）：
 * - 只发标准 L1 事件（confirm / tag / archive），SCHEMA_VERSION 保持 1，全部动作可逆；
 * - L0（redline=true，上限 15 条）：永久豁免使用率衰减降级与超期归档；
 * - L3 → L1/L2 自动转正：无争议未确认条目满足跨会话印证（≥2 独立会话）或实盘采纳（≥2 会话引用/查看）自动 confirm；
 * - 单会话代码核验（confirmed_by="code" 且 0 采纳、<2 会话）：落入 L2（on_demand=true），不挤占被动 brief；
 * - L1 → L2 衰减降级：已确认非红线非偏好条目近 30 天 brief 注入 ≥25 且 0 采纳（或满 60 天且近 60 天注入 ≥5 但 0 采纳），自动转为 on_demand=true；
 * - L3 超期归档：origin="extract" 未确认草稿满 14 天仍 0 采纳、单会话且无代码证据，自动 archive(reason="expired")。
 */
import { ownClock } from "./expiry.ts";
import type { ArchiveBody, ConfirmBody, Proposition, TagBody } from "./l2.ts";
import { KIND_LABEL, short } from "./present.ts";
import type { PendingAppend, Store } from "./store.ts";

export const REDLINE_MAX = 15;
export const PROMOTE_MIN_SESSIONS = 2;
export const PROMOTE_MIN_ADOPTIONS = 2;
export const DEMOTE_WINDOW_DAYS = 30;
export const DEMOTE_MIN_BRIEF_INJECTIONS = 25;
export const DEMOTE_IDLE_DAYS = 60;
export const DEMOTE_IDLE_MIN_INJECTIONS = 5;
export const UNUSED_EXTRACT_ARCHIVE_DAYS = 14;

export interface LifecycleActionItem {
  id: string;
  shortId: string;
  kind: Proposition["kind"];
  scope: string;
  text: string;
  detail: string;
}

export interface LifecycleReport {
  dryRun: boolean;
  at: string;
  redlineCount: number;
  promotedCorroboration: LifecycleActionItem[];
  promotedAdoption: LifecycleActionItem[];
  warmTieredCode: LifecycleActionItem[];
  demotedToOnDemand: LifecycleActionItem[];
  archivedDrafts: LifecycleActionItem[];
}

interface PropTelemetry {
  adoptedSessions: number;
  briefInj30d: number;
  adopted30d: number;
  inj60d: number;
  adopted60d: number;
}

function oneLine(text: string, maxChars = 72): string {
  const clean = text.split(/\n+/).map((s) => s.trim()).filter(Boolean).join(" / ");
  const chars = [...clean];
  return chars.length > maxChars ? chars.slice(0, maxChars - 1).join("") + "…" : clean;
}

/** 统计跨会话独立来源（排除同一句原话因 fork/resume 复制造成的伪多会话）。 */
export function distinctSessionKeys(p: Proposition): string[] {
  const entries: { key: string; quotes: string[] }[] = [];
  const push = (host: string | null, sid: string | null, quotes: string[]) => {
    if (!sid) return;
    entries.push({ key: `${host ?? "unknown"}:${sid}`, quotes });
  };
  push(p.source.host, p.source.session_id, p.evidence.map((e) => e.quote_sha256));
  for (const s of p.extra_sources) {
    push(s.host, s.session_id, s.evidence.map((e) => e.quote_sha256));
  }
  const bySession = new Map<string, Set<string>>();
  for (const e of entries) {
    const set = bySession.get(e.key) ?? new Set<string>();
    for (const q of e.quotes) set.add(q);
    bySession.set(e.key, set);
  }
  const seenQuotes = new Set<string>();
  const independent: string[] = [];
  for (const [key, quotes] of bySession) {
    if (quotes.size === 0 || ![...quotes].some((q) => seenQuotes.has(q))) {
      independent.push(key);
    }
    for (const q of quotes) seenQuotes.add(q);
  }
  return independent;
}

function loadPropTelemetry(store: Store, now: Date): Map<string, PropTelemetry> {
  const out = new Map<string, PropTelemetry>();
  const since30 = new Date(now.getTime() - DEMOTE_WINDOW_DAYS * 86_400_000).toISOString();
  const since60 = new Date(now.getTime() - DEMOTE_IDLE_DAYS * 86_400_000).toISOString();

  const rows = store.workDb
    .prepare(
      `SELECT prop_id,
              COUNT(DISTINCT CASE WHEN (cited=1 OR path='get') AND failed=0 THEN COALESCE(host || ':' || session_id, 'row:' || id) END) AS adopted_sessions,
              SUM(CASE WHEN path='brief' AND failed=0 AND ts >= ? THEN 1 ELSE 0 END) AS brief_30d,
              SUM(CASE WHEN (cited=1 OR path='get') AND failed=0 AND ts >= ? THEN 1 ELSE 0 END) AS adopted_30d,
              SUM(CASE WHEN failed=0 AND ts >= ? THEN 1 ELSE 0 END) AS inj_60d,
              SUM(CASE WHEN (cited=1 OR path='get') AND failed=0 AND ts >= ? THEN 1 ELSE 0 END) AS adopted_60d
       FROM inject_log
       GROUP BY prop_id`,
    )
    .all(since30, since30, since60, since60) as {
    prop_id: string;
    adopted_sessions: number;
    brief_30d: number;
    adopted_30d: number;
    inj_60d: number;
    adopted_60d: number;
  }[];

  for (const r of rows) {
    out.set(r.prop_id, {
      adoptedSessions: Number(r.adopted_sessions ?? 0),
      briefInj30d: Number(r.brief_30d ?? 0),
      adopted30d: Number(r.adopted_30d ?? 0),
      inj60d: Number(r.inj_60d ?? 0),
      adopted60d: Number(r.adopted_60d ?? 0),
    });
  }
  return out;
}

export function countActiveRedlines(props: Iterable<Proposition>): number {
  let n = 0;
  for (const p of props) {
    if (p.state === "active" && p.redline) n++;
  }
  return n;
}

export function runLifecyclePass(store: Store, opts: { now?: Date; dryRun?: boolean } = {}): LifecycleReport {
  const now = opts.now ?? new Date();
  const dryRun = opts.dryRun === true;
  const proj = store.project();
  const props = proj.props;
  const names = new Map(store.listProjects().map((p) => [p.id, p.name]));
  const scopeOf = (p: Proposition) => (p.project_id === null ? "全局" : (names.get(p.project_id) ?? "未知项目"));
  const telemetry = loadPropTelemetry(store, now);

  const report: LifecycleReport = {
    dryRun,
    at: now.toISOString(),
    redlineCount: countActiveRedlines(props.values()),
    promotedCorroboration: [],
    promotedAdoption: [],
    warmTieredCode: [],
    demotedToOnDemand: [],
    archivedDrafts: [],
  };

  const appends: PendingAppend[] = [];
  const activeList = [...props.values()].filter((p) => p.state === "active").sort((a, b) => a.seq - b.seq);

  for (const p of activeList) {
    if (p.redline) continue; // L0 安全红线永久豁免自动降级与归档

    const tel = telemetry.get(p.id) ?? { adoptedSessions: 0, briefInj30d: 0, adopted30d: 0, inj60d: 0, adopted60d: 0 };
    const sessions = distinctSessionKeys(p);
    const refMs = Date.parse(ownClock(p)) || Date.parse(p.ts) || 0;
    const ageDays = refMs > 0 ? Math.floor((now.getTime() - refMs) / 86_400_000) : 0;

    if (!p.confirmed) {
      const cleanUnconfirmed =
        !p.demoted &&
        !p.stale &&
        !p.unreconciled &&
        p.conflicts.length === 0 &&
        !p.supersedes &&
        !p.superseded_draft &&
        p.pending_corrections.length === 0;

      // 1. L3 -> L1/L2 隐式自动转正（跨会话印证优先，其次多会话实盘采纳）
      if (cleanUnconfirmed && sessions.length >= PROMOTE_MIN_SESSIONS) {
        const body: ConfirmBody = { by: "corroboration", sessions };
        appends.push({ kind: "confirm", project_id: p.project_id, session_id: null, target_id: p.id, body });
        report.promotedCorroboration.push({
          id: p.id,
          shortId: short(p.id),
          kind: p.kind,
          scope: scopeOf(p),
          text: oneLine(p.text),
          detail: `${sessions.length} 个独立会话印证`,
        });
        continue;
      }
      if (cleanUnconfirmed && tel.adoptedSessions >= PROMOTE_MIN_ADOPTIONS) {
        const body: ConfirmBody = { by: "adoption" };
        appends.push({ kind: "confirm", project_id: p.project_id, session_id: null, target_id: p.id, body });
        report.promotedAdoption.push({
          id: p.id,
          shortId: short(p.id),
          kind: p.kind,
          scope: scopeOf(p),
          text: oneLine(p.text),
          detail: `${tel.adoptedSessions} 个会话实际引用或查看`,
        });
        continue;
      }

      // 2. L3 超期零使用抽取草稿自动归档（14 天，不动手写/收口提炼/指向已确认条目的待审纠正/带代码核验证据的草稿）
      const targetsConfirmed = !!(p.supersedes && props.get(p.supersedes)?.confirmed);
      if (
        p.origin === "extract" &&
        ageDays >= UNUSED_EXTRACT_ARCHIVE_DAYS &&
        tel.adoptedSessions === 0 &&
        sessions.length < PROMOTE_MIN_SESSIONS &&
        !p.code_evidence &&
        !targetsConfirmed
      ) {
        const body: ArchiveBody = { reason: "expired", note: `满 ${UNUSED_EXTRACT_ARCHIVE_DAYS} 天零采纳的自动抽取草稿自动归档` };
        appends.push({ kind: "archive", project_id: p.project_id, session_id: null, target_id: p.id, body });
        report.archivedDrafts.push({
          id: p.id,
          shortId: short(p.id),
          kind: p.kind,
          scope: scopeOf(p),
          text: oneLine(p.text),
          detail: `静置 ${ageDays} 天，0 采纳`,
        });
      }
      continue;
    }

    // 以下处理 p.confirmed === true（排除常驻干活偏好 guidance 与已是 on_demand 的条目）
    if (p.guidance || p.on_demand) continue;

    // 3. 单会话代码核验转正条目：未获实盘采纳前留在 L2 温层（on_demand=true），避免直接挤占被动 brief
    if (p.confirmed_by === "code" && tel.adoptedSessions === 0 && sessions.length < PROMOTE_MIN_SESSIONS) {
      const body: TagBody = { on_demand: true };
      appends.push({ kind: "tag", project_id: p.project_id, session_id: null, target_id: p.id, body });
      report.warmTieredCode.push({
        id: p.id,
        shortId: short(p.id),
        kind: p.kind,
        scope: scopeOf(p),
        text: oneLine(p.text),
        detail: "单会话代码核验且尚无采纳，放入按需温层",
      });
      continue;
    }

    // 4. L1 -> L2 使用率衰减降级：高频注入零采纳，或满 60 天有注入仍零采纳
    const highInjectZeroCite = tel.briefInj30d >= DEMOTE_MIN_BRIEF_INJECTIONS && tel.adopted30d === 0;
    const idleLongZeroCite =
      ageDays >= DEMOTE_IDLE_DAYS && tel.inj60d >= DEMOTE_IDLE_MIN_INJECTIONS && tel.adopted60d === 0 && tel.adoptedSessions === 0;
    if (highInjectZeroCite || idleLongZeroCite) {
      const body: TagBody = { on_demand: true };
      appends.push({ kind: "tag", project_id: p.project_id, session_id: null, target_id: p.id, body });
      report.demotedToOnDemand.push({
        id: p.id,
        shortId: short(p.id),
        kind: p.kind,
        scope: scopeOf(p),
        text: oneLine(p.text),
        detail: highInjectZeroCite
          ? `近 ${DEMOTE_WINDOW_DAYS} 天 brief 注入 ${tel.briefInj30d} 次且 0 采纳`
          : `满 ${ageDays} 天（近 ${DEMOTE_IDLE_DAYS} 天注入 ${tel.inj60d} 次）且 0 采纳`,
      });
    }
  }

  if (!dryRun && appends.length > 0) {
    store.commit(appends, () => {});
  }
  return report;
}

export function formatLifecycleReport(r: LifecycleReport): string {
  const totalChanged =
    r.promotedCorroboration.length +
    r.promotedAdoption.length +
    r.warmTieredCode.length +
    r.demotedToOnDemand.length +
    r.archivedDrafts.length;

  const lines: string[] = [
    `${r.dryRun ? "预演，未写入。" : "已执行四层生命周期流转。"}当前 L0 安全红线 ${r.redlineCount}/${REDLINE_MAX} 条；本次变更 ${totalChanged} 条：`,
    `  自动转正（跨会话印证）: ${r.promotedCorroboration.length} 条`,
    `  自动转正（实盘采纳）: ${r.promotedAdoption.length} 条`,
    `  代码核验归入按需温层（L2）: ${r.warmTieredCode.length} 条`,
    `  衰减降级为按需温层（L1→L2）: ${r.demotedToOnDemand.length} 条`,
    `  超 ${UNUSED_EXTRACT_ARCHIVE_DAYS} 天零使用草稿归档（L3）: ${r.archivedDrafts.length} 条`,
  ];

  const section = (title: string, items: LifecycleActionItem[]) => {
    if (!items.length) return;
    lines.push(`${title}:`);
    for (const it of items.slice(0, 15)) {
      lines.push(`  [${it.shortId}] ${it.scope} ${KIND_LABEL[it.kind]}（${it.detail}）: ${it.text}`);
    }
    if (items.length > 15) lines.push(`  …另有 ${items.length - 15} 条`);
  };

  section("跨会话印证转正", r.promotedCorroboration);
  section("实盘采纳转正", r.promotedAdoption);
  section("代码核验归入按需温层", r.warmTieredCode);
  section("L1→L2 衰减降级", r.demotedToOnDemand);
  section("L3 草稿自动归档", r.archivedDrafts);
  return lines.join("\n");
}
