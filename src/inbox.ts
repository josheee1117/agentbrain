/**
 * ab inbox & brief 高信号待用户拍板展开（只读，不写 events / inject_log / projects）。
 */
import type { PropKind, Proposition } from "./l2.ts";
import type { Store } from "./store.ts";
import { ownClock, reviewList, type Clock } from "./expiry.ts";
import { KIND_LABEL, short } from "./present.ts";
import { isRegistryHome, loadRegistry, resolveProject } from "./registry.ts";
import { staleWarning } from "./visibility.ts";

export const INBOX_DEFAULT_LIMIT = 10;
export const BRIEF_INBOX_MAX_ITEMS = 5;
export const BRIEF_INBOX_MAX_CHARS = 450;

export type InboxKind = "stale" | "correction" | "synth" | "review" | "conflict";
export const INBOX_KINDS: readonly InboxKind[] = ["stale", "correction", "synth", "review", "conflict"];

export class BriefError extends Error {}
export const InboxError = BriefError;

export interface InboxCounts {
  stale: number;
  correction: number;
  synth: number;
  review: number;
  conflict: number;
  total: number;
}

export interface InboxItem {
  kind: InboxKind;
  id: string;
  shortId: string;
  scope: string;
  propKind: PropKind;
  text: string;
  action: string;
  targetId?: string;
  targetShortId?: string;
  staleHead?: string;
  overdueDays?: number;
  validDays?: number;
  pairIds?: [string, string];
  pairShortIds?: [string, string];
  otherScope?: string;
  otherPropKind?: PropKind;
  otherText?: string;
  confirmedAny?: boolean;
  conflictDays?: number;
  ts: string;
}

export interface InboxOpts {
  cwd?: string;
  projectName?: string;
  all?: boolean;
  kind?: InboxKind;
  limit?: number;
  now?: Date;
  clock?: Clock;
}

export interface InboxResult {
  scope: "all" | "project" | "global";
  project: string | null;
  counts: InboxCounts;
  totalFiltered: number;
  limit: number;
  items: InboxItem[];
}

const KIND_ZH: Record<InboxKind, string> = {
  stale: "不符",
  correction: "纠正",
  synth: "收口提炼",
  review: "复审",
  conflict: "冲突",
};

function oneLine(text: string, maxChars?: number): string {
  const clean = text.split(/\n+/).map((s) => s.trim()).filter(Boolean).join(" / ");
  if (maxChars === undefined) return clean;
  const chars = [...clean];
  return chars.length > maxChars ? chars.slice(0, Math.max(1, maxChars - 1)).join("") + "…" : clean;
}

function scopeName(projectId: string | null, names: Map<string, string>): string {
  return projectId === null ? "全局" : (names.get(projectId) ?? "未知项目");
}

function makeInScope(mode: "all" | "project" | "global", pid: string | undefined): (projectId: string | null) => boolean {
  if (mode === "all") return () => true;
  if (mode === "project") return (projectId) => projectId === null || (pid !== undefined && projectId === pid);
  return (projectId) => projectId === null;
}

function gatherInboxItems(
  store: Store,
  inScope: (projectId: string | null) => boolean,
  now: Date,
  clock: Clock,
): { items: InboxItem[]; counts: InboxCounts } {
  const proj = store.project();
  const props = proj.props;
  const names = new Map(store.listProjects().map((p) => [p.id, p.name]));

  const seenSingle = new Set<string>();

  // 1. stale: 已确认但与代码不符（排除被草稿替代和代码核验转正的）
  const staleItems: InboxItem[] = [...props.values()]
    .filter((p) => p.state === "active" && !p.superseded_draft && staleWarning(p) && inScope(p.project_id))
    .sort((a, b) => b.seq - a.seq)
    .map((p) => {
      seenSingle.add(p.id);
      return {
        kind: "stale",
        id: p.id,
        shortId: short(p.id),
        scope: scopeName(p.project_id, names),
        propKind: p.kind,
        text: oneLine(p.text),
        action: `ab verify ${short(p.id)} | ab confirm ${short(p.id)}`,
        staleHead: p.stale?.head,
        ts: p.ts,
      };
    });

  // 2. correction: 有效条目的 pending_corrections 指向的未确认 active 且 !superseded_draft 纠正条
  const correctionRows: { item: InboxItem; seq: number }[] = [];
  for (const t of props.values()) {
    if (t.state !== "active") continue;
    for (const cid of t.pending_corrections) {
      const c = props.get(cid);
      if (!c || c.state !== "active" || c.confirmed || c.superseded_draft || seenSingle.has(c.id)) continue;
      if (!inScope(c.project_id) && !inScope(t.project_id)) continue;
      seenSingle.add(c.id);
      correctionRows.push({
        seq: c.seq,
        item: {
          kind: "correction",
          id: c.id,
          shortId: short(c.id),
          scope: scopeName(c.project_id, names),
          propKind: c.kind,
          text: oneLine(c.text),
          action: `ab confirm ${short(c.id)} | ab archive ${short(c.id)}`,
          targetId: t.id,
          targetShortId: short(t.id),
          ts: c.ts,
        },
      });
    }
  }
  correctionRows.sort((a, b) => b.seq - a.seq);
  const correctionItems = correctionRows.map((r) => r.item);

  // 3. synth: 需求收口提炼新决定（未确认、active、!superseded_draft、origin === "auto"）
  const synthItems: InboxItem[] = [...props.values()]
    .filter((p) => p.state === "active" && !p.confirmed && !p.superseded_draft && p.origin === "auto" && !seenSingle.has(p.id) && inScope(p.project_id))
    .sort((a, b) => b.seq - a.seq)
    .map((p) => {
      seenSingle.add(p.id);
      return {
        kind: "synth",
        id: p.id,
        shortId: short(p.id),
        scope: scopeName(p.project_id, names),
        propKind: p.kind,
        text: oneLine(p.text),
        action: `ab confirm ${short(p.id)} | ab archive ${short(p.id)}`,
        ts: p.ts,
      };
    });

  // 4. review: 到期待复审（reviewList 已按 overdueDays 降序排好）
  const reviewItems: InboxItem[] = reviewList(props.values(), store.usage(), now, clock)
    .filter((d) => !seenSingle.has(d.prop.id) && inScope(d.prop.project_id))
    .map((d) => {
      seenSingle.add(d.prop.id);
      return {
        kind: "review",
        id: d.prop.id,
        shortId: short(d.prop.id),
        scope: scopeName(d.prop.project_id, names),
        propKind: d.prop.kind,
        text: oneLine(d.prop.text),
        action: `ab confirm ${short(d.prop.id)} | ab review --archive ${short(d.prop.id)}`,
        overdueDays: d.overdueDays,
        validDays: d.validDays,
        ts: d.prop.ts,
      };
    });

  // 5. conflict: 未解决冲突对（含至少一条 confirmed 的优先，其次最老在前）
  const conflictItems: InboxItem[] = [];
  for (const pair of proj.conflict_pairs) {
    const a = props.get(pair.ids[0]);
    const b = props.get(pair.ids[1]);
    if (!a || !b) continue;
    if (!inScope(a.project_id) && !inScope(b.project_id)) continue;
    const confirmedAny = a.confirmed || b.confirmed;
    const conflictDays = Math.max(0, Math.floor((now.getTime() - Date.parse(pair.ts)) / 86_400_000));
    conflictItems.push({
      kind: "conflict",
      id: a.id,
      shortId: short(a.id),
      scope: scopeName(a.project_id, names),
      propKind: a.kind,
      text: oneLine(a.text),
      action: `ab get ${short(a.id)} ${short(b.id)} | ab relate ${short(a.id)} ${short(b.id)} --coexist | ab archive <id>`,
      pairIds: pair.ids,
      pairShortIds: [short(a.id), short(b.id)],
      otherScope: scopeName(b.project_id, names),
      otherPropKind: b.kind,
      otherText: oneLine(b.text),
      confirmedAny,
      conflictDays,
      ts: pair.ts,
    });
  }
  conflictItems.sort((a, b) => {
    const confDiff = Number(b.confirmedAny === true) - Number(a.confirmedAny === true);
    if (confDiff !== 0) return confDiff;
    return a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0;
  });

  const items = [...staleItems, ...correctionItems, ...synthItems, ...reviewItems, ...conflictItems];
  const counts: InboxCounts = {
    stale: staleItems.length,
    correction: correctionItems.length,
    synth: synthItems.length,
    review: reviewItems.length,
    conflict: conflictItems.length,
    total: items.length,
  };
  return { items, counts };
}

/** 只读收集待用户拍板的高信号条目，按 5 类优先级排序并过滤作用域。 */
export function collectInbox(store: Store, opts: InboxOpts = {}): InboxResult {
  if (opts.projectName !== undefined) {
    if (!opts.projectName.trim()) throw new InboxError("项目名不能为空");
    if (opts.all) throw new InboxError("项目名与 --all 不能同时使用");
  }
  const registry = loadRegistry();
  let scope: "all" | "project" | "global";
  let project: string | null = null;
  let pid: string | undefined;

  if (opts.all) {
    scope = "all";
  } else if (opts.projectName !== undefined) {
    const named = registry.find((e) => e.name === opts.projectName);
    if (!named) throw new InboxError(`清单里没有项目: ${opts.projectName}`);
    scope = "project";
    project = named.name;
    // 只读查找，绝不调用 ensureProject 写库
    pid = store.listProjects().find((p) => p.name === named.name)?.id;
  } else {
    const cwd = opts.cwd ?? process.cwd();
    if (isRegistryHome(cwd)) {
      scope = "all";
    } else {
      const here = resolveProject(cwd);
      if (here) {
        scope = "project";
        project = here.name;
        pid = store.listProjects().find((p) => p.name === here.name)?.id;
      } else {
        scope = "global";
      }
    }
  }

  const now = opts.now ?? new Date();
  const clock = opts.clock ?? ownClock;
  const limit = Math.max(1, opts.limit ?? INBOX_DEFAULT_LIMIT);
  const { items, counts } = gatherInboxItems(store, makeInScope(scope, pid), now, clock);
  const filtered = opts.kind ? items.filter((it) => it.kind === opts.kind) : items;

  return {
    scope,
    project,
    counts,
    totalFiltered: filtered.length,
    limit,
    items: filtered.slice(0, limit),
  };
}

function scopeDisplay(scope: InboxResult["scope"], project: string | null): string {
  if (scope === "all") return "全库";
  if (scope === "project") return `全局 + ${project}`;
  return "仅全局";
}

/** 格式化 `ab inbox` 人类可读输出。 */
export function formatInboxText(data: InboxResult, opts: { kind?: InboxKind } = {}): string {
  const scopeStr = scopeDisplay(data.scope, data.project);
  if (data.counts.total === 0) return `待确认清单为空（范围：${scopeStr}）。`;
  if (data.totalFiltered === 0) {
    const label = opts.kind ? KIND_ZH[opts.kind] : "该类型";
    return `没有${label}待确认项（全部待确认 ${data.counts.total} 条，范围：${scopeStr}）。`;
  }

  const c = data.counts;
  const summary = opts.kind
    ? `${KIND_ZH[opts.kind]} ${data.totalFiltered} 条`
    : `共 ${data.totalFiltered} 条：不符 ${c.stale}、纠正 ${c.correction}、收口提炼 ${c.synth}、复审 ${c.review}、冲突 ${c.conflict}`;
  const lines: string[] = [`待确认清单（范围：${scopeStr}，${summary}）：`];

  for (const it of data.items) {
    if (it.kind === "stale") {
      lines.push(`  [${it.shortId}] [${KIND_ZH.stale}] ${it.scope} ${KIND_LABEL[it.propKind]}: ${oneLine(it.text, 80)}${it.staleHead ? `（HEAD @${it.staleHead.slice(0, 7)}）` : ""}`);
      lines.push(`    处理: ${it.action}`);
    } else if (it.kind === "correction") {
      lines.push(`  [${it.shortId}] [${KIND_ZH.correction}→${it.targetShortId}] ${it.scope} ${KIND_LABEL[it.propKind]}: ${oneLine(it.text, 80)}`);
      lines.push(`    处理: ${it.action}`);
    } else if (it.kind === "synth") {
      lines.push(`  [${it.shortId}] [${KIND_ZH.synth}] ${it.scope} ${KIND_LABEL[it.propKind]}: ${oneLine(it.text, 80)}`);
      lines.push(`    处理: ${it.action}`);
    } else if (it.kind === "review") {
      lines.push(`  [${it.shortId}] [${KIND_ZH.review}·超期${it.overdueDays}天] ${it.scope} ${KIND_LABEL[it.propKind]}: ${oneLine(it.text, 80)}`);
      lines.push(`    处理: ${it.action}`);
    } else {
      const [id1, id2] = it.pairShortIds!;
      const tag = `冲突${it.confirmedAny ? "·含已确认" : ""}·${it.conflictDays}天`;
      lines.push(`  [${id1}↔${id2}] [${tag}] ${it.scope} ${KIND_LABEL[it.propKind]}: ${oneLine(it.text, 40)} ∥ ${it.otherScope} ${KIND_LABEL[it.otherPropKind!]}: ${oneLine(it.otherText!, 40)}`);
      lines.push(`    处理: ${it.action}`);
    }
  }

  if (data.totalFiltered > data.items.length) {
    lines.push(`…还有 ${data.totalFiltered - data.items.length} 条未显示，用 --limit ${data.totalFiltered} 看全部。`);
  }
  return lines.join("\n");
}

function formatBriefLine(it: InboxItem, textCap: number): string {
  if (it.kind === "stale") return `  [${it.shortId}] 不符·${it.scope}: ${oneLine(it.text, textCap)} → ab verify ${it.shortId} / ab confirm ${it.shortId}`;
  if (it.kind === "correction") return `  [${it.shortId}] 纠正→${it.targetShortId}·${it.scope}: ${oneLine(it.text, textCap)} → ab confirm ${it.shortId}`;
  if (it.kind === "synth") return `  [${it.shortId}] 收口·${it.scope}: ${oneLine(it.text, textCap)} → ab confirm ${it.shortId}`;
  if (it.kind === "review") return `  [${it.shortId}] 复审${it.overdueDays}天·${it.scope}: ${oneLine(it.text, textCap)} → ab confirm ${it.shortId}`;
  const [id1, id2] = it.pairShortIds!;
  const half = Math.max(8, Math.floor(textCap / 2));
  return `  [${id1}↔${id2}] 冲突${it.conflictDays}天·${it.scope}: ${oneLine(it.text, half)} ∥ ${oneLine(it.otherText!, half)} → ab get ${id1}`;
}

/**
 * 为主会话 `ab brief` 生成精简前 BRIEF_INBOX_MAX_ITEMS 条高信号待确认块（总长严格 <= BRIEF_INBOX_MAX_CHARS）。
 * 仅展开：stale / correction / synth / review / 至少一方 confirmed 的 conflict；无高信号项返回 null。
 */
export function briefInboxBlock(
  store: Store,
  projectName: string | undefined,
  inPm = false,
  now: Date = new Date(),
): string | null {
  const scope: "all" | "project" | "global" = inPm ? "all" : projectName ? "project" : "global";
  const pid = scope === "project" && projectName ? store.listProjects().find((p) => p.name === projectName)?.id : undefined;
  const { items } = gatherInboxItems(store, makeInScope(scope, pid), now, ownClock);

  const high: InboxItem[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    if (it.kind === "conflict" && !it.confirmedAny) continue;
    const key = it.kind === "conflict" ? `conflict:${it.pairIds!.join(":")}` : it.id;
    if (seen.has(key)) continue;
    seen.add(key);
    high.push(it);
  }
  if (!high.length) return null;

  const header = `待用户拍板（共 ${high.length} 条高信号，全部用 ab inbox）：`;
  const lines = [header];
  let len = header.length;

  for (const it of high.slice(0, BRIEF_INBOX_MAX_ITEMS)) {
    let line = formatBriefLine(it, 24);
    if (len + 1 + line.length > BRIEF_INBOX_MAX_CHARS && lines.length === 1) {
      // 保证至少能放进第一条（若第一条因项目名或文本略长超限时收窄摘要）
      line = formatBriefLine(it, 10);
    }
    if (len + 1 + line.length > BRIEF_INBOX_MAX_CHARS) break;
    lines.push(line);
    len += 1 + line.length;
  }

  if (lines.length === 1) return null;
  const out = lines.join("\n");
  return out.length <= BRIEF_INBOX_MAX_CHARS ? out : out.slice(0, BRIEF_INBOX_MAX_CHARS);
}

export interface NoiseRuleItem {
  id: string;
  shortId: string;
  scope: string;
  scenes: string[];
  briefInjections: number;
  cited: number;
  citationRate: number;
  text: string;
  action: string;
}

/** 只读扫描高注入低引用（默认近 30 天 brief 注入 >= 100 且引用率 < 1%）的已确认非偏好规则，建议转按需或归档。 */
export function collectNoiseRules(
  store: Store,
  opts: { days?: number; minBriefInjections?: number; maxCitationRate?: number; now?: Date } = {},
): NoiseRuleItem[] {
  const days = opts.days ?? 30;
  const minBrief = opts.minBriefInjections ?? 100;
  const maxRate = opts.maxCitationRate ?? 0.01;
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - days * 86_400_000).toISOString();

  const stats = new Map<string, { briefInj: number; cited: number }>();
  const rows = store.workDb
    .prepare(
      `SELECT prop_id,
              SUM(CASE WHEN path='brief' AND failed=0 THEN 1 ELSE 0 END) AS brief_inj,
              SUM(CASE WHEN cited=1 AND failed=0 THEN 1 ELSE 0 END) AS cited
       FROM inject_log
       WHERE ts >= ?
       GROUP BY prop_id`,
    )
    .all(since) as { prop_id: string; brief_inj: number; cited: number }[];
  for (const r of rows) {
    stats.set(r.prop_id, { briefInj: Number(r.brief_inj ?? 0), cited: Number(r.cited ?? 0) });
  }

  const names = new Map(store.listProjects().map((p) => [p.id, p.name]));
  const out: NoiseRuleItem[] = [];
  for (const p of store.project().props.values()) {
    if (p.state !== "active" || !p.confirmed || p.kind !== "rule" || p.guidance || p.on_demand) continue;
    const st = stats.get(p.id);
    if (!st || st.briefInj < minBrief) continue;
    const rate = st.cited / st.briefInj;
    if (rate >= maxRate) continue;
    out.push({
      id: p.id,
      shortId: short(p.id),
      scope: scopeName(p.project_id, names),
      scenes: [...p.scenes],
      briefInjections: st.briefInj,
      cited: st.cited,
      citationRate: Number(rate.toFixed(4)),
      text: oneLine(p.text),
      action: `ab tag ${short(p.id)} --on-demand | ab archive ${short(p.id)}`,
    });
  }
  out.sort((a, b) => b.briefInjections - a.briefInjections || a.citationRate - b.citationRate);
  return out;
}

export function formatNoiseText(items: NoiseRuleItem[], days = 30): string {
  if (!items.length) return `近 ${days} 天无高注入低引用噪音规则。`;
  const lines = [`高注入低引用规则候选（近 ${days} 天 brief 注入 ≥100 且引用率 <1%，共 ${items.length} 条）：`];
  for (const it of items) {
    const sc = it.scenes.length ? ` scenes=${it.scenes.join(",")}` : "";
    lines.push(`  [${it.shortId}] ${it.scope}${sc} · brief=${it.briefInjections}, cited=${it.cited} (${(it.citationRate * 100).toFixed(2)}%): ${oneLine(it.text, 72)}`);
    lines.push(`    处理: ${it.action}`);
  }
  return lines.join("\n");
}
