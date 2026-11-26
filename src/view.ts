/**
 * ab view：把 L2 投影 + 已存向量导出成一个自包含的 HTML 页面（§21 2026-10-13 ab view）。
 * 本文件只读 store（ab view 生成前的引用扫描在 cli.ts，会写统计表）；不发网络请求；引文只存了哈希，页面也只显示定位点。
 */
import type { DatabaseSync } from "node:sqlite";
import type { Store } from "./store.ts";
import type { Proposition } from "./l2.ts";
import { cosine } from "./embed.ts";
import { reviewList, sourceClock, validDays } from "./expiry.ts";
import { trustOf } from "./visibility.ts";
import { basename } from "node:path";
import * as intake from "./intake.ts";
import { listBackups } from "./admin.ts";
import { confirmedLine, writtenLine } from "./present.ts";
import type { CodeVersion } from "./status.ts";

/** "运行状况"里最多列几个没做成的窗口（§12.6.8 V5）。 */
const OPS_PROBLEM_ROWS = 10;

export type ViewStatus = "user" | "code" | "corroboration" | "unconfirmed" | "stale";

export interface ViewEntry {
  id: string;
  kind: Proposition["kind"];
  text: string;
  why: string | null;
  summary: string;
  trigger: string | null;
  project: string; // "全局" 或项目名
  state: Proposition["state"];
  status: ViewStatus;
  origin: Proposition["origin"];
  host: string | null;
  /** 写入这条的操作者；旧事件没有记（§12.6.8 V3）。 */
  actor: string | null;
  /** 写入、确认两行，内容同 ab get（去掉行首标签）。 */
  written: string;
  confirmed_line: string;
  sessions: string[];
  created: string;
  for_workers: boolean;
  expired: boolean;
  /** 到期待复审（未确认、过期、期间没被注入）。 */
  review_due: boolean;
  valid_days: number;
  last_used: string | null;
  unreconciled: boolean;
  evidence: { role: string; anchor: string; quote_sha256: string }[];
  code: { head: string; refs: string[]; stale: boolean } | null;
  links: { type: LinkType; id: string }[];
  /** 注入与引用统计（§11.8）；legacy_uses 是 prop_usage 的老累计数（含常驻偏好、brief，2026-10-14 起）。 */
  usage: EntryUsage;
  g: [number, number] | null;
  neighbors: { id: string; similarity: number }[];
  xy: [number, number] | null;
}

export type LinkType = "merged_into" | "merged_from" | "refines" | "refined_by" | "conflicts" | "supersedes" | "supersedes_pending" | "superseded_by" | "pending_correction";

export interface MemoryMetrics {
  total: number;
  reported: number;
  adopted: number;
  queried: number;
  unverifiable: number;
  last_scanned: string | null;
}

export interface EntryUsage {
  inject_sessions: number;
  inject_total: number;
  by_path: Record<string, number>;
  cited_sessions: number;
  cited_total: number;
  mismatched: number;
  legacy_uses: number;
  last_injected: string | null;
  daily: { day: string; recall: number; brief: number; cited: number }[];
}

export interface HostStat {
  host: string;
  model: string;
  sessions: number;
  recall_turns: number;
  marked_turns: number;
}

export interface Telemetry {
  since: string | null;
  recall_runs: { total: number; hit: number; nohit: number; error: number; p50_ms: number | null; p95_ms: number | null; model_failed: number };
  recall_daily: { day: string; hit: number; nohit: number; error: number }[];
  hosts: HostStat[];
  capture: { failed_sessions: number; failed_by_host: Record<string, number>; deferred_windows: number };
  review_due: number;
  memory: MemoryMetrics;
}

/** 首页"运行状况"（§12.6.8 V1、V5）：代码和库版本、最近备份、没做成的抽取窗口及原因。 */
export interface Ops {
  code: { commit: string; branch: string | null; dirty: number } | null;
  schema: { version: number; supported: number; readOnly: boolean };
  events: number;
  /** 这份代码不认识的事件条数。 */
  unknown: number;
  backup: { at: string; count: number; file: string } | null;
  windows: { failed: number; deferred: number; recent: intake.WindowProblem[] };
}

export interface ViewData {
  generated: string;
  telemetry: Telemetry;
  ops: Ops;
  embed_model: string | null;
  entries: ViewEntry[];
  counts: { total: number; active: number; vectors: number };
}

const NEIGHBORS = 5;
const DAY = 86_400_000;

function rowsOf<T>(db: DatabaseSync, sql: string, ...args: (string | number | null)[]): T[] {
  try {
    return db.prepare(sql).all(...args) as T[];
  } catch {
    return [];
  }
}

function pct(sorted: number[], q: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

function telemetryOf(db: DatabaseSync, now: Date, reviewDue: number): Telemetry {
  const all = rowsOf<{ ts: string; outcome: string; ms: number; failed: number }>(db, "SELECT ts,outcome,ms,failed FROM recall_runs ORDER BY ts");
  // 模型调用失败的回合不算命中（§11.8，2026-10-21 用户定），单独计数
  const runs = all.filter((r) => !r.failed);
  const modelFailed = all.length - runs.length;
  const ms = runs.map((r) => r.ms).sort((a, b) => a - b);
  const daily = new Map<string, { day: string; hit: number; nohit: number; error: number }>();
  for (let i = 89; i >= 0; i--) {
    const day = new Date(now.getTime() - i * DAY).toISOString().slice(0, 10);
    daily.set(day, { day, hit: 0, nohit: 0, error: 0 });
  }
  for (const r of runs) {
    const d = daily.get(r.ts.slice(0, 10));
    if (d && (r.outcome === "hit" || r.outcome === "nohit" || r.outcome === "error")) d[r.outcome]++;
  }
  const hosts = rowsOf<HostStat>(db, `SELECT r.host AS host, COALESCE(c.model,'未知') AS model, COUNT(DISTINCT r.session_id) AS sessions,
      SUM(CASE WHEN r.outcome='hit' AND r.cite=1 AND r.failed=0 THEN 1 ELSE 0 END) AS recall_turns,
      SUM(CASE WHEN r.outcome='hit' AND r.cite=1 AND r.failed=0 AND r.marked=1 THEN 1 ELSE 0 END) AS marked_turns
    FROM recall_runs r LEFT JOIN cite_scan c ON c.host=r.host AND c.session_id=r.session_id
    WHERE r.host IS NOT NULL GROUP BY r.host, COALESCE(c.model,'未知') ORDER BY sessions DESC`);
  const failed = rowsOf<{ host: string; n: number }>(db, "SELECT host, COUNT(*) AS n FROM capture_sessions WHERE error_code IS NOT NULL GROUP BY host");
  const deferred = rowsOf<{ n: number }>(db, "SELECT COUNT(*) AS n FROM capture_windows WHERE state='deferred'")[0]?.n ?? 0;
  const since = rowsOf<{ t: string | null }>(db, "SELECT MIN(ts) AS t FROM (SELECT ts FROM recall_runs UNION ALL SELECT ts FROM inject_log)")[0]?.t ?? null;
  const rep = rowsOf<{ cite: number; status: string; queried: number }>(db, "SELECT cite,status,queried FROM memory_reports");
  const citeReps = rep.filter((r) => r.cite === 1);
  const unverifiable = (rowsOf<{ n: number }>(db, "SELECT COUNT(*) AS n FROM memory_report_ids WHERE verified=0")[0]?.n) ?? 0;
  const lastScanned = (rowsOf<{ t: string | null }>(db, "SELECT MAX(scanned_at) AS t FROM cite_scan")[0]?.t) ?? null;
  const memory: MemoryMetrics = {
    total: citeReps.length,
    reported: citeReps.filter((r) => r.status === "used" || r.status === "unused").length,
    adopted: citeReps.filter((r) => r.status === "used").length,
    queried: citeReps.filter((r) => r.queried === 1).length,
    unverifiable,
    last_scanned: lastScanned,
  };
  return {
    since,
    recall_runs: {
      total: runs.length,
      hit: runs.filter((r) => r.outcome === "hit").length,
      nohit: runs.filter((r) => r.outcome === "nohit").length,
      error: runs.filter((r) => r.outcome === "error").length,
      p50_ms: pct(ms, 0.5),
      p95_ms: pct(ms, 0.95),
      model_failed: modelFailed,
    },
    recall_daily: [...daily.values()],
    hosts: hosts.map((h) => ({ ...h, sessions: Number(h.sessions), recall_turns: Number(h.recall_turns), marked_turns: Number(h.marked_turns) })),
    capture: { failed_sessions: failed.reduce((n, r) => n + r.n, 0), failed_by_host: Object.fromEntries(failed.map((r) => [r.host, r.n])), deferred_windows: deferred },
    review_due: reviewDue,
    memory,
  };
}

function usageOf(db: DatabaseSync, now: Date): Map<string, Omit<EntryUsage, "legacy_uses">> {
  const out = new Map<string, Omit<EntryUsage, "legacy_uses">>();
  const rows = rowsOf<{ prop_id: string; ts: string; host: string | null; session_id: string | null; path: string; cited: number; title_mismatch: number }>(
    db, "SELECT prop_id,ts,host,session_id,path,cited,title_mismatch FROM inject_log WHERE failed=0 ORDER BY ts");
  const start = new Date(now.getTime() - 29 * DAY).toISOString().slice(0, 10);
  const sess = new Map<string, Set<string>>();
  const citedSess = new Map<string, Set<string>>();
  for (const r of rows) {
    let u = out.get(r.prop_id);
    if (!u) {
      u = { inject_sessions: 0, inject_total: 0, by_path: {}, cited_sessions: 0, cited_total: 0, mismatched: 0, last_injected: null, daily: [] };
      out.set(r.prop_id, u);
    }
    const key = `${r.host ?? "?"}:${r.session_id}`;
    u.inject_total++;
    u.by_path[r.path] = (u.by_path[r.path] ?? 0) + 1;
    u.last_injected = r.ts;
    if (r.session_id) (sess.get(r.prop_id) ?? sess.set(r.prop_id, new Set()).get(r.prop_id)!).add(key);
    if (r.cited) {
      u.cited_total++;
      if (r.title_mismatch) u.mismatched++;
      if (r.session_id) (citedSess.get(r.prop_id) ?? citedSess.set(r.prop_id, new Set()).get(r.prop_id)!).add(key);
    }
    const day = r.ts.slice(0, 10);
    if (day >= start) {
      let d = u.daily.find((x) => x.day === day);
      if (!d) u.daily.push((d = { day, recall: 0, brief: 0, cited: 0 }));
      if (r.path === "recall" || r.path === "brief") d[r.path]++;
      if (r.cited) d.cited++;
    }
  }
  for (const [id, u] of out) {
    u.inject_sessions = sess.get(id)?.size ?? 0;
    u.cited_sessions = citedSess.get(id)?.size ?? 0;
  }
  return out;
}

/** 关联图布局：每个连通块一个圆，块按大小排成网格。O(点+边)，条目多也不会卡住 ab view。 */
export function graphLayout(nodes: readonly string[], edges: readonly [string, string][]): Map<string, [number, number]> {
  const adj = new Map(nodes.map((id) => [id, [] as string[]]));
  for (const [a, b] of edges) {
    if (!adj.has(a) || !adj.has(b)) continue;
    adj.get(a)!.push(b);
    adj.get(b)!.push(a);
  }
  const seen = new Set<string>();
  const groups: string[][] = [];
  for (const id of nodes) {
    if (seen.has(id)) continue;
    const g: string[] = [];
    const stack = [id];
    seen.add(id);
    while (stack.length) {
      const cur = stack.pop()!;
      g.push(cur);
      for (const n of adj.get(cur)!) if (!seen.has(n)) (seen.add(n), stack.push(n));
    }
    groups.push(g);
  }
  groups.sort((a, b) => b.length - a.length);
  const cell = (g: string[]) => 40 + 12 * Math.sqrt(g.length) * 2;
  const cols = Math.max(1, Math.ceil(Math.sqrt(groups.length)));
  const out = new Map<string, [number, number]>();
  let x = 0;
  let y = 0;
  let rowH = 0;
  groups.forEach((g, i) => {
    if (i % cols === 0 && i) {
      x = 0;
      y += rowH;
      rowH = 0;
    }
    const size = cell(g);
    const r = g.length === 1 ? 0 : size / 2 - 15;
    g.forEach((id, k) => {
      const a = (2 * Math.PI * k) / g.length;
      out.set(id, [Math.round((x + size / 2 + r * Math.cos(a)) * 10) / 10, Math.round((y + size / 2 + r * Math.sin(a)) * 10) / 10]);
    });
    x += size;
    rowH = Math.max(rowH, size);
  });
  return out;
}

function statusOf(p: Proposition): ViewStatus {
  if (p.stale) return "stale";
  return trustOf(p);
}

const refText = (r: { path: string; line_start: number; line_end: number; quote: string } | { commit: string; quote: string }) =>
  "path" in r ? `${r.path}:${r.line_start}-${r.line_end} ${r.quote}` : `${r.commit.slice(0, 10)} ${r.quote}`;

/** 前两个主成分（幂迭代 + 去除第一成分），结果确定：初始向量固定。 */
export function pca2(vecs: Float32Array[]): [number, number][] {
  const n = vecs.length;
  if (n === 0) return [];
  const d = vecs[0].length;
  const mean = new Float64Array(d);
  for (const v of vecs) for (let j = 0; j < d; j++) mean[j] += v[j] / n;
  const X = vecs.map((v) => Float64Array.from(v, (x, j) => x - mean[j]));
  const comps: Float64Array[] = [];
  for (let c = 0; c < 2; c++) {
    let w: Float64Array = Float64Array.from({ length: d }, (_, j) => Math.sin(j + 1 + c * 7));
    for (let it = 0; it < 100; it++) {
      const next = new Float64Array(d);
      for (const x of X) {
        let s = 0;
        for (let j = 0; j < d; j++) s += x[j] * w[j];
        for (let j = 0; j < d; j++) next[j] += s * x[j];
      }
      for (const prev of comps) {
        let s = 0;
        for (let j = 0; j < d; j++) s += next[j] * prev[j];
        for (let j = 0; j < d; j++) next[j] -= s * prev[j];
      }
      const norm = Math.hypot(...next) || 1;
      w = next.map((x) => x / norm);
    }
    comps.push(w);
  }
  return X.map((x) => comps.map((w) => x.reduce((s, xj, j) => s + xj * w[j], 0)) as [number, number]);
}

export function buildViewData(store: Store, now: Date = new Date(), env: { home?: string; code?: CodeVersion | null } = {}): ViewData {
  const projection = store.project();
  const props = projection.props;
  const names = new Map(store.listProjects().map((p) => [p.id, p.name]));
  const usage = store.usage();
  const due = new Set(reviewList(props.values(), usage, now, sourceClock()).map((d) => d.prop.id));
  const vecs = store.currentVectors();
  const ids = [...props.keys()].filter((id) => vecs.has(id));
  const xy = new Map(pca2(ids.map((id) => vecs.get(id)!)).map((p, i) => [ids[i], p]));
  const reverse = new Map<string, ViewEntry["links"]>();
  const addRev = (target: string | null | undefined, link: ViewEntry["links"][number]) => {
    if (!target || !props.has(target)) return;
    reverse.set(target, [...(reverse.get(target) ?? []), link]);
  };
  for (const p of props.values()) {
    addRev(p.merged_into, { type: "merged_from", id: p.id });
    if (p.related?.outcome === "refines") addRev(p.related.target, { type: "refined_by", id: p.id });
  }
  const inj = usageOf(store.workDb, now);
  let entries: ViewEntry[] = [...props.values()].sort((a, b) => b.seq - a.seq).map((p) => {
    const links: ViewEntry["links"] = [];
    const add = (type: ViewEntry["links"][number]["type"], id: string | null | undefined) => {
      if (id && props.has(id) && !links.some((l) => l.type === type && l.id === id)) links.push({ type, id });
    };
    add("merged_into", p.merged_into);
    if (p.related?.outcome === "refines") add("refines", p.related.target);
    for (const id of p.conflicts) add("conflicts", id);
    // 替代只有"有效且用户确认"的纠正才生效（l2.ts 投影）；没生效的另标，免得看起来像已替代
    if (p.supersedes && props.get(p.supersedes)?.superseded_by === p.id) add("supersedes", p.supersedes);
    else add("supersedes_pending", p.supersedes);
    add("superseded_by", p.superseded_by);
    for (const c of p.pending_corrections) add("pending_correction", c);
    for (const l of reverse.get(p.id) ?? []) add(l.type, l.id);
    const own = vecs.get(p.id);
    const neighbors = own
      ? ids.flatMap((id) => {
          const n = props.get(id)!;
          if (id === p.id || (n.project_id !== null && p.project_id !== null && n.project_id !== p.project_id)) return [];
          return [{ id, similarity: Math.round(cosine(own, vecs.get(id)!) * 1000) / 1000 }];
        }).sort((a, b) => b.similarity - a.similarity).slice(0, NEIGHBORS)
      : [];
    const sessions = [p.source.session_id ? `${p.source.host ?? "?"}:${p.source.session_id}` : null,
      ...p.extra_sources.map((x) => (x.session_id ? `${x.host ?? "?"}:${x.session_id}` : null))].filter((s): s is string => !!s);
    const code = p.code_evidence ?? p.stale;
    return {
      id: p.id,
      kind: p.kind,
      text: p.text,
      why: p.why ?? null,
      summary: p.source.summary,
      trigger: p.trigger ?? null,
      project: p.project_id === null ? "全局" : (names.get(p.project_id) ?? "未知项目"),
      state: p.state,
      status: statusOf(p),
      origin: p.origin,
      host: p.source.host,
      actor: p.written_by.actor,
      written: writtenLine(p).replace(/^写入: /, ""),
      confirmed_line: confirmedLine(p).replace(/^确认: /, ""),
      sessions: [...new Set(sessions)],
      created: p.ts,
      for_workers: p.for_workers,
      expired: p.expired,
      review_due: due.has(p.id),
      valid_days: validDays(p),
      last_used: usage.get(p.id)?.last_used ?? null,
      unreconciled: p.unreconciled,
      evidence: p.evidence.map((e) => ({ role: e.role, anchor: e.anchor, quote_sha256: e.quote_sha256 })),
      code: code ? { head: code.head, refs: code.refs.map(refText), stale: !!p.stale } : null,
      links,
      neighbors,
      xy: xy.get(p.id) ?? null,
      usage: { ...(inj.get(p.id) ?? { inject_sessions: 0, inject_total: 0, by_path: {}, cited_sessions: 0, cited_total: 0, mismatched: 0, last_injected: null, daily: [] }), legacy_uses: usage.get(p.id)?.uses ?? 0 },
      g: null as [number, number] | null,
    };
  });
  const linked = entries.filter((e) => e.links.length);
  const edges: [string, string][] = linked.flatMap((e) => e.links.map((l) => [e.id, l.id] as [string, string]));
  const pos = graphLayout(linked.map((e) => e.id), edges);
  for (const e of entries) e.g = pos.get(e.id) ?? null;
  const backups = env.home ? listBackups(env.home) : [];
  const wins = intake.stats(store.workDb, now).windows;
  const ops: Ops = {
    code: env.code ? { commit: env.code.commit, branch: env.code.branch, dirty: env.code.dirty } : null,
    schema: store.schema,
    events: store.eventCount(),
    unknown: projection.unknown,
    // 只给文件名：页面可能在内部分享，不带本机目录
    backup: backups[0] ? { at: backups[0].at.toISOString(), count: backups.length, file: basename(backups[0].path) } : null,
    windows: { failed: wins.failed, deferred: wins.deferred, recent: intake.windowProblems(store.workDb, OPS_PROBLEM_ROWS) },
  };
  return {
    generated: now.toISOString(),
    ops,
    telemetry: telemetryOf(store.workDb, now, entries.filter((e) => e.review_due).length),
    embed_model: store.vectorStatus().model,
    entries,
    counts: { total: entries.length, active: entries.filter((e) => e.state === "active").length, vectors: ids.length },
  };
}

/** JSON 嵌进 <script> 时转义，防止内容里的 </script> 截断脚本。 */
function embedJson(v: unknown): string {
  return JSON.stringify(v).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

export function renderHtml(data: ViewData): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>agentbrain 记忆看板</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*{box-sizing:border-box}body{margin:0;font:14px/1.5 -apple-system,"PingFang SC","Noto Sans CJK SC",sans-serif;background:#000;color:#e6e9f2}
header{display:flex;align-items:center;gap:16px;padding:14px 28px;border-bottom:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.03);backdrop-filter:blur(20px);position:sticky;top:0;z-index:5}
.logo{width:32px;height:32px;border-radius:9px;background:conic-gradient(#7c5cff,#2dd4bf,#7c5cff);display:grid;place-items:center;font-weight:800}
h1{font-size:17px;margin:0}.sub{color:#8a93b2;font-size:12px}
nav{margin-left:24px;display:flex;gap:4px}nav a{padding:6px 13px;border-radius:8px;color:#9aa3c2;cursor:pointer;font-size:13px}nav a.on{background:rgba(255,255,255,.1);color:#fff}
.meta{margin-left:auto;text-align:right;font-size:12px;color:#8a93b2}.badge{display:inline-block;padding:1px 8px;border-radius:99px;font-size:11px;margin-left:6px}
.b-old{background:#4a1d2a;color:#fda4af}
main{padding:20px 28px;display:none;gap:16px}main.on{display:grid}
.grid{display:grid;gap:16px}.card{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:14px;padding:16px;backdrop-filter:blur(10px)}
.card h3{margin:0 0 10px;font-size:13px;color:#aab3d4;font-weight:600}
.kpi .v{font-size:28px;font-weight:700}.kpi .l{color:#8a93b2;font-size:12px}.kpi .d{font-size:12px;margin-top:6px;color:#5eead4}
.row{display:grid;grid-template-columns:90px 1fr 48px;align-items:center;gap:10px;font-size:12px;color:#aab3d4;margin:7px 0}
.bar{display:flex;height:12px;border-radius:6px;overflow:hidden;background:rgba(255,255,255,.06)}
.lg{display:flex;flex-wrap:wrap;gap:12px;font-size:11px;color:#8a93b2;margin-top:8px}.lg i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:4px}
table{width:100%;border-collapse:collapse;font-size:12px}td,th{padding:6px;border-bottom:1px solid rgba(255,255,255,.06);text-align:left}th{color:#7f88a8;font-weight:500}
.num{text-align:right;font-variant-numeric:tabular-nums}.dim{color:#5b6488}
.pill{padding:1px 8px;border-radius:99px;font-size:11px;margin-right:4px;display:inline-block}
.k-decision{background:#2a1f5c;color:#c4b5fd}.k-pitfall{background:#4a1d2a;color:#fda4af}.k-rule{background:#0f3b3a;color:#5eead4}.k-note{background:#3b3416;color:#fde68a}
.s-user{color:#22c55e}.s-code{color:#38bdf8}.s-corroboration{color:#a78bfa}.s-unconfirmed{color:#94a3b8}.s-stale{color:#ef4444}
.filters{display:flex;flex-wrap:wrap;gap:8px;align-items:center}.filters input,.filters select{background:rgba(255,255,255,.05);color:#e6e9f2;border:1px solid rgba(255,255,255,.1);border-radius:8px;padding:5px 8px}
.item{padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.06);cursor:pointer}.item:hover,.item.sel{background:rgba(255,255,255,.06)}
.item .t{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
a{color:#93c5fd;cursor:pointer}#tip{position:fixed;pointer-events:none;background:#111;border:1px solid rgba(255,255,255,.15);color:#fff;padding:6px 9px;border-radius:6px;font-size:12px;max-width:380px;display:none;z-index:9}
</style></head><body>
<header><div class="logo">ab</div><div><h1>agentbrain 记忆看板</h1><div class="sub" id="sub"></div></div>
<nav><a data-tab="ov" class="on">概览</a><a data-tab="gr">关联图</a><a data-tab="ls">记忆</a><a data-tab="mp">向量地图</a></nav>
<div class="meta" id="meta"></div></header>
<main id="ov" class="on"></main>
<main id="gr"><div class="card" style="padding:0;overflow:hidden"><div style="display:flex;gap:14px;padding:12px 16px;border-bottom:1px solid #1e2742;font-size:13px;color:#aab3d4;flex-wrap:wrap">
<b style="color:#fff">关联图</b><span id="gcount"></span><span class="lg" style="margin:0 0 0 auto"><span><i style="background:#7c5cff"></i>决定</span><span><i style="background:#f472b6"></i>坑</span><span><i style="background:#2dd4bf"></i>规则</span><span><i style="background:#fbbf24"></i>事实</span>
<span style="color:#64748b">— 补充</span><span style="color:#60a5fa">— 合并</span><span style="color:#ef4444">— 冲突</span><span style="color:#e2e8f0">— 替代（已生效）</span><span style="color:#f59e0b">┄ 替代（未生效）</span><span>白描边=用户确认 · 大小=注入会话数</span></span></div>
<svg id="gsvg" width="100%" style="display:block;background:radial-gradient(circle at 50% 45%,#0a0a1a,#000)"></svg></div></main>
<main id="ls"><div class="grid" style="grid-template-columns:minmax(360px,1fr) 1.4fr;align-items:start">
<div class="card" style="padding:0"><div class="filters" style="padding:12px"><input type="search" id="q" placeholder="搜索正文 / id" style="flex:1">
<select id="fp"></select><select id="fk"></select><select id="fs"></select><select id="fu"><option value="">全部</option><option value="never">从未注入</option><option value="cited">被引用过</option><option value="mismatch">标题不符</option></select><select id="fw"></select>
<label class="sub"><input type="checkbox" id="fa"> 含归档/已替代</label></div><div class="sub" id="shown" style="padding:0 12px 8px"></div><div id="list" style="max-height:72vh;overflow:auto"></div></div>
<div id="detail"></div></div></main>
<main id="mp"><div class="card"><h3>向量地图（PCA 二维投影，按项目着色；点击打开详情）</h3><svg id="map" viewBox="0 0 800 520" width="100%"></svg><div class="lg" id="legend"></div></div></main>
<div id="tip"></div>
<script id="data" type="application/json">${embedJson(data)}</script>
<script>
const D=JSON.parse(document.getElementById('data').textContent),T=D.telemetry;
const E=D.entries,byId=new Map(E.map(e=>[e.id,e])),A=E.filter(e=>e.state==='active');
const KIND={rule:'规则',decision:'决定',pitfall:'坑',note:'事实'},KC={decision:'#7c5cff',pitfall:'#f472b6',rule:'#2dd4bf',note:'#fbbf24'};
const ST={user:'用户确认',code:'代码核验',corroboration:'跨会话印证',unconfirmed:'未确认',stale:'与代码不符'},SC={user:'#22c55e',code:'#38bdf8',corroboration:'#a78bfa',unconfirmed:'#475569',stale:'#ef4444'};
const STATE={active:'有效',archived:'已归档',superseded:'已被替代'};
const LINK={merged_into:'已并入',merged_from:'合并自',refines:'补充了',refined_by:'被补充',conflicts:'冲突',supersedes:'替代了',supersedes_pending:'替代（未生效）',superseded_by:'被替代',pending_correction:'待确认纠正'};
const EC={refines:'#64748b',refined_by:'#64748b',merged_into:'#60a5fa',merged_from:'#60a5fa',conflicts:'#ef4444',supersedes:'#e2e8f0',superseded_by:'#e2e8f0',supersedes_pending:'#f59e0b',pending_correction:'#f59e0b'};
const PATH={recall:'相似度召回',brief:'brief',search:'主动搜索',get:'主动查看'};
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
const $=id=>document.getElementById(id),short=id=>id.slice(0,8),n=x=>Number(x||0).toLocaleString();
const gen=new Date(D.generated),age=Math.floor((Date.now()-gen.getTime())/864e5);
$('sub').textContent='本地记忆 · '+D.counts.total+' 条（有效 '+D.counts.active+'）· 向量 '+(D.embed_model||'无');
$('meta').innerHTML='生成于 '+esc(gen.toLocaleString())+' · <b>'+(age<=0?'今天':'距今 '+age+' 天')+'</b>'+(age>=7?'<span class="badge b-old">数据较旧，重跑 ab view</span>':'');
document.querySelectorAll('nav a').forEach(a=>a.onclick=()=>tab(a.dataset.tab));
function tab(t){document.querySelectorAll('nav a').forEach(x=>x.classList.toggle('on',x.dataset.tab===t));document.querySelectorAll('main').forEach(m=>m.classList.toggle('on',m.id===t));if(t==='gr')graph();if(t==='mp')map()}
function cnt(list,key){const m={};list.forEach(e=>{const k=key(e);m[k]=(m[k]||0)+1});return m}
function kpi(t,v,l,d,dc){return '<div class="card kpi"><h3>'+t+'</h3><div class="v">'+v+'</div><div class="l">'+l+'</div>'+(d?'<div class="d"'+(dc?' style="color:'+dc+'"':'')+'>'+d+'</div>':'')+'</div>'}
function overview(){
const st=cnt(A,e=>e.status),kd=cnt(A,e=>e.kind),linked=A.filter(e=>e.links.length).length;
const legacy=A.filter(e=>e.usage.legacy_uses>0).length,inj=A.filter(e=>e.usage.inject_total>0).length,never=A.length-inj,cited=A.filter(e=>e.usage.cited_total>0).length;
const lt=cnt(E.flatMap(e=>e.links),l=>l.type);
const hostRows=T.hosts.map(h=>'<tr><td>'+esc(h.host)+'</td><td>'+esc(h.model)+'</td><td class="num">'+h.sessions+'</td><td class="num">'+h.recall_turns+'</td><td class="num">'+h.marked_turns+'</td><td class="num">'+(h.recall_turns?Math.round(100*h.marked_turns/h.recall_turns)+'%':'<span class="dim">—</span>')+'</td></tr>').join('');
const maxK=Math.max(1,...Object.values(kd));
const newByDay={};A.forEach(e=>{const d=e.created.slice(0,10);newByDay[d]=(newByDay[d]||0)+1});
// 时间轴从有数据的第一天画起，最少 14 天（§12.6.8 V4：库才用几周时，90 天的轴大半是空的）
const allDays=T.recall_daily,firstIdx=allDays.findIndex(d=>d.hit+d.nohit+d.error>0||newByDay[d.day]);
const days=allDays.slice(Math.max(0,Math.min(firstIdx<0?allDays.length-14:firstIdx,allDays.length-14))),mx=Math.max(1,...days.map(d=>d.hit+d.nohit+d.error));
const step=900/days.length,bw=Math.max(2,step-2).toFixed(1);
// 90 天时间轴：召回轮数按 recall_runs 算，新增记忆按条目 created 算
const maxNew=Math.max(1,...days.map(d=>newByDay[d.day]||0));
const timeline='<svg viewBox="0 0 900 140" width="100%" style="display:block">'+days.map((d,i)=>{
const x=(i*step+1).toFixed(1),total=d.hit+d.nohit+d.error,h1=total?Math.max(2,60*d.hit/mx):0,h2=total?Math.max(2,60*d.nohit/mx):0,h3=total?Math.max(2,60*d.error/mx):0;
const nw=newByDay[d.day]||0,h4=nw?Math.max(2,60*nw/maxNew):0;
return '<rect x="'+x+'" y="'+(110-h1)+'" width="'+bw+'" height="'+h1+'" fill="#7c5cff" rx="1"><title>'+d.day+' 命中 '+d.hit+'</title></rect>'+
'<rect x="'+x+'" y="'+(110-h1-h2)+'" width="'+bw+'" height="'+h2+'" fill="#334155" rx="1"><title>'+d.day+' 没命中 '+d.nohit+'</title></rect>'+
'<rect x="'+x+'" y="'+(110-h1-h2-h3)+'" width="'+bw+'" height="'+h3+'" fill="#ef4444" rx="1"><title>'+d.day+' 出错 '+d.error+'</title></rect>'+
'<rect x="'+x+'" y="'+115+'" width="'+bw+'" height="'+h4+'" fill="#2dd4bf" rx="1"><title>'+d.day+' 新增 '+nw+'</title></rect>';
}).join('')+'<line x1="0" y1="112" x2="900" y2="112" stroke="#1e2742" stroke-width="1"/></svg>';
// 类型×项目矩阵
const matrixProjects=[...new Set(A.map(e=>e.project))].sort();
const matrix=matrixProjects.map(p=>{
const mine=A.filter(e=>e.project===p);
const cells=Object.keys(KIND).map(k=>{
const items=mine.filter(e=>e.kind===k),delivered=items.filter(e=>e.usage.inject_total>0).length,total=items.length;
const rate=total?Math.round(100*delivered/total):0;
const bg=total?('rgba(124,92,255,'+(0.08+0.5*rate/100)+')'):'transparent';
return '<td style="background:'+bg+';text-align:center;padding:8px 4px;cursor:'+(total?'pointer':'default')+'" '+(total?'data-go-project="'+esc(p)+'" data-go-kind="'+k+'"':'')+'>'+(total?('<div style="font-weight:600">'+delivered+'<span class="dim"> / '+total+'</span></div><div class="dim" style="font-size:11px">'+rate+'%</div>'):'<span class="dim">—</span>')+'</td>';
}).join('');
return '<tr><td style="padding:8px 6px;font-size:12px">'+esc(p)+'</td>'+cells+'</tr>';
}).join('');
const matrixTable='<table style="width:100%;border-collapse:collapse;font-size:12px"><tr><th style="text-align:left;padding:8px 6px">项目</th>'+Object.keys(KIND).map(k=>'<th style="text-align:center;padding:8px 4px"><span class="pill k-'+k+'">'+KIND[k]+'</span></th>').join('')+'</tr>'+matrix+'</table>';
// 首页第一屏：一句话 + 时间轴 + 矩阵 + 关系图入口
// 确认来源放在第一屏（§12.6.8 V2）：一眼看出多少是人确认过的、多少是模型转正的
const trustBar='<div style="max-width:760px;margin:16px auto 0"><div class="sub" style="margin-bottom:5px">确认来源（有效条目）</div><div class="bar" style="height:14px">'+Object.keys(ST).map(k=>'<div title="'+ST[k]+' '+(st[k]||0)+'" style="width:'+(100*(st[k]||0)/Math.max(1,A.length))+'%;background:'+SC[k]+'"></div>').join('')+'</div><div class="lg" style="justify-content:center">'+Object.keys(ST).map(k=>'<span><i style="background:'+SC[k]+'"></i>'+ST[k]+' '+n(st[k]||0)+'</span>').join('')+'</div></div>';
// 运行状况（§12.6.8 V1、V5）：代码和库版本、最近备份、没做成的抽取窗口和原因
const O=D.ops,warn=t=>'<span style="color:#fda4af">'+t+'</span>';
const hrs=t=>{const h=Math.max(0,Math.floor((gen.getTime()-new Date(t).getTime())/36e5));return h<1?'不到 1 小时前':h<48?h+' 小时前':Math.floor(h/24)+' 天前'};
const opsRows=[
['代码',O.code?esc(O.code.commit)+(O.code.branch?'（'+esc(O.code.branch)+'）':'')+' · '+(O.code.dirty?warn('有 '+O.code.dirty+' 个文件没提交'):'没有未提交改动'):'版本未知'],
['库','版本 '+O.schema.version+'（代码支持 '+O.schema.supported+'）'+(O.schema.readOnly?' · '+warn('库比代码新，只读'):'')+' · 事件 '+n(O.events)+' 条 · '+(O.unknown?warn('不认识的事件 '+O.unknown+' 条'):'不认识的事件 0 条')],
['最近备份',O.backup?esc(O.backup.at.slice(0,16).replace('T',' '))+' UTC（'+hrs(O.backup.at)+'）· 共 '+O.backup.count+' 份 · '+esc(O.backup.file):warn('还没有备份，运行 ab backup')],
['抽取窗口',(O.windows.failed?warn('失败 '+O.windows.failed):'失败 0')+' · 延后 '+O.windows.deferred],
].map(r=>'<tr><td style="white-space:nowrap;color:#8a93b2">'+r[0]+'</td><td>'+r[1]+'</td></tr>').join('');
const probRows=O.windows.recent.map(p=>'<tr><td style="white-space:nowrap">'+esc(p.at.slice(5,16).replace('T',' '))+'</td><td style="white-space:nowrap">'+esc(p.host)+':'+esc(p.session_id.slice(0,8))+'</td><td style="white-space:nowrap">'+(p.state==='failed'?warn('失败'):'延后 第 '+p.attempts+' 次')+'</td><td style="white-space:nowrap">'+esc(p.code||'?')+(p.chars?' · '+n(p.chars)+' 字':'')+'</td><td>'+esc(p.detail||'原因没有记录（旧版本留下的）')+'</td></tr>').join('');
const opsCard='<div class="card" id="ops"><h3>运行状况</h3><table>'+opsRows+'</table><h3 style="margin-top:14px">最近没做成的抽取窗口（最多 10 个）</h3>'+(probRows?'<table><tr><th>时间</th><th>会话</th><th>状态</th><th>错误</th><th>原因</th></tr>'+probRows+'</table>':'<div class="sub">没有失败或延后的窗口</div>')+'</div>';
const hero='<div class="card" style="text-align:center;padding:28px 16px"><div style="font-size:20px;font-weight:700;margin-bottom:8px">'+n(A.length)+' 条有效记忆 · '+matrixProjects.length+' 个项目 · 过去 90 天召回 '+n(T.recall_runs.total)+' 轮</div><div class="sub">命中 '+n(T.recall_runs.hit)+' · 没命中 '+n(T.recall_runs.nohit)+' · 出错 '+n(T.recall_runs.error)+(T.recall_runs.model_failed?' · 模型没回答 '+n(T.recall_runs.model_failed):'')+'</div>'+trustBar+'</div>';
const timelineCard='<div class="card"><h3>'+days.length+' 天时间轴（召回轮数 + 新增记忆，从有数据的第一天画起）</h3>'+timeline+'<div class="lg"><span><i style="background:#7c5cff"></i>命中</span><span><i style="background:#334155"></i>没命中</span><span><i style="background:#ef4444"></i>出错</span><span><i style="background:#2dd4bf"></i>新增记忆（下方）</span></div></div>';
const matrixCard='<div class="card"><h3>类型 × 项目矩阵（被交付数 / 总数，颜色深浅 = 交付率）</h3>'+matrixTable+'<div class="sub" style="margin-top:6px">「被交付」= 该条目出现在 inject_log 的次数（含 brief/search/get/recall），不等于「被召回」。点击单元格看该组合下的记忆。</div></div>';
const top=A.filter(e=>e.usage.inject_total>0).sort((a,b)=>b.usage.inject_sessions-a.usage.inject_sessions).slice(0,8);
const conflicts=A.filter(e=>e.links.some(l=>l.type==='conflicts'||l.type==='pending_correction')).length;
const pendingSup=E.filter(e=>e.links.some(l=>l.type==='supersedes_pending')).length;
const supStillInj=E.filter(e=>e.state==='superseded'&&e.usage.inject_total>0).length;
const mism=A.reduce((s,e)=>s+e.usage.mismatched,0);
$('ov').innerHTML=hero+
'<div class="grid" style="grid-template-columns:1fr">'+timelineCard+'</div>'+
'<div class="grid" style="grid-template-columns:1.2fr 1fr">'+matrixCard+opsCard+'</div>'+
'<div class="grid" style="grid-template-columns:repeat(5,1fr)">'+
kpi('有效记忆',n(A.length),'共 '+n(D.counts.total)+' 条 · 用户确认 '+(st.user||0),'未确认 '+(st.unconfirmed||0)+' · 代码核验 '+(st.code||0))+
kpi('有关联的记忆',n(linked),'补充 '+((lt.refines||0))+' · 合并 '+(lt.merged_into||0)+' · 冲突 '+(lt.conflicts||0),'替代未生效 '+pendingSup,pendingSup?'#fbbf24':'')+
kpi('被注入过',n(inj)+'<span class="dim" style="font-size:15px"> / '+n(A.length)+'</span>',(T.since?'明细统计自 '+esc(T.since.slice(0,10)):'还没有注入明细')+' · 老累计有记录 '+legacy+' 条',never+' 条从未被注入',never?'#fbbf24':'')+
kpi('被引用（模型自报）',n(cited),'标了 ab-used 的有效条目','标题不符 '+mism+' 次',mism?'#fbbf24':'')+
kpi('抽取失败',n(T.capture.failed_sessions),'会话 · 延后窗口 '+T.capture.deferred_windows,'待复审 '+T.review_due,T.capture.failed_sessions?'#fda4af':'')+'</div>'+
'<div class="grid" style="grid-template-columns:1.2fr 1fr"><div class="card"><h3>构成（有效条目）</h3>'+
Object.keys(KIND).map(k=>'<div class="row"><span>'+KIND[k]+'</span><div class="bar"><div style="width:'+(100*(kd[k]||0)/maxK)+'%;background:'+KC[k]+'"></div></div><span class="num">'+(kd[k]||0)+'</span></div>').join('')+
'</div>'+
'<div class="card"><h3>召回统计 · 共 '+n(T.recall_runs.total)+' 次，命中 '+n(T.recall_runs.hit)+'，出错 '+n(T.recall_runs.error)+(T.recall_runs.model_failed?'，模型没回答（不计）'+n(T.recall_runs.model_failed):'')+(T.recall_runs.p50_ms!==null?' · 耗时 p50 '+T.recall_runs.p50_ms+'ms / p95 '+T.recall_runs.p95_ms+'ms':'')+'</h3>'+
'<div class="sub" style="margin-top:6px">宿主侧超时不经过 ab，不在这里</div></div></div>'+
'<div class="grid" style="grid-template-columns:1.2fr 1fr"><div class="card"><h3>标注率（按宿主 / 模型）</h3><table><tr><th>宿主</th><th>模型</th><th class="num">会话</th><th class="num">开关打开时有召回的回合</th><th class="num">标了 ab-used 的回合</th><th class="num">标注率</th></tr>'+(hostRows||'<tr><td colspan="6" class="dim">还没有记录</td></tr>')+'</table>'+
'<div class="sub" style="margin-top:6px">"用上"= 模型在回复末尾自报的 ab-used，未经人工核对；标错请纠正。</div></div>'+
'<div class="card"><h3>记忆可见性（§11.9）</h3>'+
'<div style="margin:4px 0 10px 0;font-size:12px;color:#8a93b2">上次扫描：'+esc(T.memory.last_scanned ? T.memory.last_scanned.slice(0, 19).replace('T', ' ') : '未扫描')+'</div>'+
'<table><tr><th>指标</th><th class="num">数值</th></tr>'+
'<tr><td>报告率</td><td class="num">'+(T.memory.total ? Math.round(100 * T.memory.reported / T.memory.total) + '%' : '—')+' ('+T.memory.reported+'/'+T.memory.total+')</td></tr>'+
'<tr><td>采用率</td><td class="num">'+(T.memory.total ? Math.round(100 * T.memory.adopted / T.memory.total) + '%' : '—')+' ('+T.memory.adopted+'/'+T.memory.total+')</td></tr>'+
'<tr><td>主动查询率</td><td class="num">'+(T.memory.total ? Math.round(100 * T.memory.queried / T.memory.total) + '%' : '—')+' ('+T.memory.queried+'/'+T.memory.total+')</td></tr>'+
'<tr><td>无法核对数</td><td class="num">'+T.memory.unverifiable+'</td></tr>'+
'</table></div></div>'+
'<div class="card"><h3>调优清单（只是建议，不会自动改任何条目）</h3><table>'+
[['从未被注入的有效条目',never,'fu=never'],['冲突 / 待确认纠正未解决',conflicts,''],['替代未生效（纠正未确认或已归档）',pendingSup,''],['已被替代却仍被注入',supStillInj,''],['标题不符的引用',mism,'fu=mismatch'],['抽取失败会话 / 延后窗口',T.capture.failed_sessions+' / '+T.capture.deferred_windows,''],['到期待复审',T.review_due,'']].map(r=>'<tr><td>'+(r[2]?'<a data-filter="'+r[2]+'">'+r[0]+'</a>':r[0])+'</td><td class="num">'+r[1]+'</td></tr>').join('')+'</table></div></div>'+
'<div class="card"><h3>注入最多的记忆（按会话数）</h3><table><tr><th>记忆</th><th class="num">注入会话</th><th class="num">注入次数</th><th class="num">被引用会话</th></tr>'+
(top.map(e=>'<tr><td><a data-go="'+e.id+'"><span class="pill k-'+e.kind+'">'+KIND[e.kind]+'</span>'+esc(e.text.split('\\n')[0].slice(0,70))+'</a>'+(e.status==='unconfirmed'?' <span class="pill" style="background:#3b2a0a;color:#fbbf24">未确认</span>':'')+'</td><td class="num">'+e.usage.inject_sessions+'</td><td class="num">'+e.usage.inject_total+'</td><td class="num">'+e.usage.cited_sessions+'</td></tr>').join('')||'<tr><td colspan="4" class="dim">还没有注入记录</td></tr>')+'</table></div>';
}
let gdone=false;function graph(){if(gdone)return;gdone=true;
const N=E.filter(e=>e.g),svg=$('gsvg');$('gcount').textContent=N.length+' 条带关联的记忆';
if(!N.length){svg.setAttribute('height',120);svg.innerHTML='<text x="20" y="60" fill="#8a93b2">没有带关联的记忆</text>';return}
const xs=N.map(e=>e.g[0]),ys=N.map(e=>e.g[1]),x0=Math.min(...xs),x1=Math.max(...xs),y0=Math.min(...ys),y1=Math.max(...ys);
const W=1400,H=Math.max(520,Math.min(1000,W*(y1-y0+1)/(x1-x0+1)));svg.setAttribute('viewBox','0 0 '+W+' '+H);svg.setAttribute('height',Math.min(760,H));
const sx=x=>30+(W-60)*(x-x0)/((x1-x0)||1),sy=y=>30+(H-60)*(y-y0)/((y1-y0)||1);let h='';const seen=new Set();
for(const e of N)for(const l of e.links){const o=byId.get(l.id);if(!o||!o.g)continue;const k=[e.id,o.id].sort().join()+(l.type.startsWith('supersedes')||l.type==='superseded_by'?'s':l.type);if(seen.has(k))continue;seen.add(k);
h+='<line x1="'+sx(e.g[0]).toFixed(1)+'" y1="'+sy(e.g[1]).toFixed(1)+'" x2="'+sx(o.g[0]).toFixed(1)+'" y2="'+sy(o.g[1]).toFixed(1)+'" stroke="'+EC[l.type]+'" stroke-width="'+(l.type==='conflicts'?2:1.3)+'" stroke-opacity=".75"'+(l.type==='supersedes_pending'||l.type==='pending_correction'?' stroke-dasharray="5 4"':'')+'/>'}
for(const e of N){const r=5+Math.min(14,Math.sqrt(e.usage.inject_sessions)*2.2);h+='<circle data-id="'+e.id+'" cx="'+sx(e.g[0]).toFixed(1)+'" cy="'+sy(e.g[1]).toFixed(1)+'" r="'+r.toFixed(1)+'" fill="'+KC[e.kind]+'" fill-opacity="'+(e.state==='active'?.88:.3)+'" stroke="'+(e.status==='user'?'#f8fafc':'#0b1020')+'" stroke-width="'+(e.status==='user'?1.8:1)+'" style="cursor:pointer"/>'}
svg.innerHTML=h}
const projects=[...new Set(E.map(e=>e.project))].sort(),pc=p=>'hsl('+(projects.indexOf(p)*137%360)+',65%,55%)';
let mdone=false;function map(){if(mdone)return;mdone=true;const pts=E.filter(e=>e.xy&&e.state==='active'),svg=$('map');if(!pts.length){svg.innerHTML='<text x="10" y="20" fill="#8a93b2">没有向量</text>';return}
const xs=pts.map(e=>e.xy[0]),ys=pts.map(e=>e.xy[1]),x0=Math.min(...xs),x1=Math.max(...xs),y0=Math.min(...ys),y1=Math.max(...ys);
svg.innerHTML=pts.map(e=>'<circle data-id="'+e.id+'" cx="'+(15+770*(e.xy[0]-x0)/((x1-x0)||1)).toFixed(1)+'" cy="'+(505-490*(e.xy[1]-y0)/((y1-y0)||1)).toFixed(1)+'" r="4" fill="'+pc(e.project)+'" fill-opacity=".85" style="cursor:pointer"/>').join('');
$('legend').innerHTML=[...new Set(pts.map(e=>e.project))].map(p=>'<span><i style="background:'+pc(p)+'"></i>'+esc(p)+'</span>').join('')}
const opt=(el,lab,vals,names)=>{el.innerHTML='<option value="">'+lab+'</option>'+vals.map(v=>'<option value="'+esc(v)+'">'+esc(names?names[v]:v)+'</option>').join('')};
opt($('fp'),'全部项目',projects);opt($('fk'),'全部类型',Object.keys(KIND),KIND);opt($('fs'),'全部状态',Object.keys(ST),ST);
const NOACTOR='未记录（旧事件）',actorOf=e=>e.actor||NOACTOR;opt($('fw'),'全部操作者',[...new Set(E.map(actorOf))].sort());
let sel=null;
function visible(){const q=$('q').value.trim().toLowerCase(),u=$('fu').value;return E.filter(e=>($('fa').checked||e.state==='active')&&(!$('fp').value||e.project===$('fp').value)&&(!$('fk').value||e.kind===$('fk').value)&&(!$('fs').value||e.status===$('fs').value)&&(!$('fw').value||actorOf(e)===$('fw').value)&&(!u||(u==='never'?e.usage.inject_total===0:u==='cited'?e.usage.cited_total>0:e.usage.mismatched>0))&&(!q||(e.id+' '+e.text+' '+(e.why||'')).toLowerCase().includes(q)))}
function list(){const v=visible();$('shown').textContent='显示 '+v.length+' 条';$('list').innerHTML=v.slice(0,600).map(e=>'<div class="item'+(e.id===sel?' sel':'')+'" data-go="'+e.id+'"><div class="t"><span class="pill k-'+e.kind+'">'+KIND[e.kind]+'</span>'+esc(e.text.split('\\n')[0])+'</div><div class="sub">['+short(e.id)+'] '+esc(e.project)+' · <span class="s-'+e.status+'">'+ST[e.status]+'</span>'+(e.state!=='active'?' · '+STATE[e.state]:'')+(e.actor?' · '+esc(e.actor):'')+' · 注入 '+e.usage.inject_sessions+' 会话 · 引用 '+e.usage.cited_sessions+'</div></div>').join('')+(v.length>600?'<div class="sub" style="padding:10px">只列前 600 条，请用筛选缩小</div>':'')}
function ref(id){const e=byId.get(id);return '<a data-go="'+id+'">['+short(id)+']</a> '+(e?esc(e.text.split('\\n')[0].slice(0,60))+(e.state!=='active'?' <span class="dim">('+STATE[e.state]+')</span>':''):'')}
function detail(id){const e=byId.get(id);if(!e)return;sel=id;const u=e.usage;
const days=[];for(let i=29;i>=0;i--)days.push(new Date(gen.getTime()-i*864e5).toISOString().slice(0,10));const dm=new Map(u.daily.map(d=>[d.day,d]));const mx=Math.max(1,...u.daily.map(d=>d.recall+d.brief));
const tl='<svg viewBox="0 0 600 100" width="100%">'+days.map((day,i)=>{const d=dm.get(day);if(!d)return '';let y=92,s='';[['recall','#7c5cff'],['brief','#fbbf24']].forEach(([k,c])=>{const h=80*d[k]/mx;if(h>0){s+='<rect x="'+(i*20+2)+'" y="'+(y-h).toFixed(1)+'" width="16" height="'+h.toFixed(1)+'" fill="'+c+'" rx="2"><title>'+day+' '+PATH[k]+' '+d[k]+'</title></rect>';y-=h}});if(d.cited)s+='<circle cx="'+(i*20+10)+'" cy="'+(y-6)+'" r="3.5" fill="#f8fafc"><title>'+day+' 被引用 '+d.cited+'</title></circle>';return s}).join('')+'</svg>';
$('detail').innerHTML='<div class="card"><div><span class="pill k-'+e.kind+'">'+KIND[e.kind]+'</span><span class="sub">['+short(e.id)+'] '+esc(e.project)+' · </span><span class="s-'+e.status+'">● '+ST[e.status]+'</span><span class="sub"> · '+STATE[e.state]+' · '+(e.origin==='extract'?'自动沉淀':e.origin==='auto'?'收口提炼':e.origin==='import'?'导入':'手动')+' · '+esc(e.host||'命令行')+' · 记录于 '+e.created.slice(0,10)+'</span></div>'+
'<div class="sub" style="margin-top:8px"><b>确认：</b>'+esc(e.confirmed_line)+'</div><div class="sub"><b>写入：</b>'+esc(e.written)+'</div>'+
'<div style="font-size:17px;margin:10px 0;white-space:pre-wrap">'+esc(e.text)+'</div>'+(e.why?'<div class="sub"><b>为什么：</b>'+esc(e.why)+'</div>':'')+(e.trigger?'<div class="sub"><b>触发：</b>'+esc(e.trigger)+'</div>':'')+'<div class="sub"><b>背景：</b>'+esc(e.summary)+'</div>'+
'<div class="grid" style="grid-template-columns:repeat(4,1fr);margin-top:14px">'+kpi('注入会话',u.inject_sessions,'共 '+u.inject_total+' 次')+kpi('被引用会话',u.cited_sessions,'共 '+u.cited_total+' 次',u.mismatched?'标题不符 '+u.mismatched:'',u.mismatched?'#fbbf24':'')+kpi('按路径',Object.entries(u.by_path).map(([k,v])=>(PATH[k]||k)+' '+v).join(' · ')||'—','')+kpi('老累计（prop_usage）',u.legacy_uses,'含常驻偏好与 brief')+'</div>'+
'<h3 style="margin-top:14px">注入时间线（近 30 天）</h3>'+tl+'<div class="lg"><span><i style="background:#7c5cff"></i>相似度召回</span><span><i style="background:#fbbf24"></i>brief</span><span><i style="background:#f8fafc;border-radius:50%"></i>被引用</span>'+(u.last_injected?'<span>最近注入 '+esc(u.last_injected.slice(0,16).replace('T',' '))+'</span>':'')+'</div></div>'+
'<div class="grid" style="grid-template-columns:1fr 1fr;margin-top:16px"><div class="card"><h3>关联</h3>'+(e.links.length?e.links.map(l=>'<div style="margin:5px 0"><span class="pill" style="background:#1d2650;color:'+EC[l.type]+'">'+LINK[l.type]+'</span>'+ref(l.id)+'</div>').join(''):'<span class="dim">无</span>')+'</div>'+
'<div class="card"><h3>向量近邻</h3>'+(e.neighbors.length?e.neighbors.map(x=>'<div style="margin:5px 0"><span class="num" style="color:#5eead4">'+x.similarity.toFixed(2)+'</span> '+ref(x.id)+'</div>').join(''):'<span class="dim">无</span>')+'</div></div>'+
(e.sessions.length||e.evidence.length||e.code?'<div class="card" style="margin-top:16px"><h3>来源与证据</h3>'+e.sessions.map(s=>'<div class="sub">会话 '+esc(s)+'</div>').join('')+e.evidence.map(v=>'<div class="sub">'+esc(v.role)+(v.anchor?' @ '+esc(v.anchor):'')+'</div>').join('')+(e.code?'<div class="sub">'+(e.code.stale?'与代码不符':'代码证据')+'：'+e.code.refs.map(esc).join('<br>')+'</div>':'')+'</div>':'');list()}
document.addEventListener('click',ev=>{const f=ev.target.closest('[data-filter]');if(f){const [k,v]=f.dataset.filter.split('=');$(k).value=v;tab('ls');list();return}const tl=ev.target.closest('[data-tab-link]');if(tl){tab(tl.dataset.tabLink);return}const mp=ev.target.closest('[data-go-project]');if(mp){$('fp').value=mp.dataset.goProject;$('fk').value=mp.dataset.goKind;tab('ls');list();return}const t=ev.target.closest('[data-go],[data-id]');if(t){const id=t.dataset.go||t.dataset.id;const e=byId.get(id);if(e&&e.state!=='active')$('fa').checked=true;tab('ls');detail(id)}});
const tip=$('tip');document.addEventListener('mousemove',ev=>{const id=ev.target.dataset&&ev.target.dataset.id;if(!id){tip.style.display='none';return}const e=byId.get(id);tip.textContent='['+KIND[e.kind]+' · '+e.project+'] '+e.text.slice(0,160);tip.style.display='block';tip.style.left=(ev.clientX+12)+'px';tip.style.top=(ev.clientY+12)+'px'});
['q','fp','fk','fs','fu','fw','fa'].forEach(k=>$(k).addEventListener('input',list));
overview();list();const first=A.slice().sort((a,b)=>b.usage.inject_sessions-a.usage.inject_sessions)[0];if(first)detail(first.id);
const h0=location.hash.slice(1);if(h0.startsWith('m=')){tab('ls');detail(h0.slice(2))}else if(h0.startsWith('tab='))tab(h0.slice(4));window.scrollTo(0,0);
</script></body></html>`;
}
