/**
 * 记忆看板的统计（设计 §11.8.2、§11.8.9）：注入明细 inject_log、召回结果 recall_runs、引用扫描 cite_scan。
 * 都是 store.db 里的工作表，不进 L1、不参与投影；只保留 RETENTION_DAYS 天。写失败由调用方吞掉（fail-open）。
 */
import type { DatabaseSync } from "node:sqlite";
import { linesOf } from "./source.ts";
import { opencodeModel } from "./opencode.ts";
import type { Host } from "./l2.ts";
import type { Turn } from "./transcript.ts";

export const RETENTION_DAYS = 90;
/** 标题与条目正文的字面重合低于此值记为"标题不符"（只做提示，不丢引用）。 */
export const TITLE_MATCH_MIN = 0.3;
export const CITE_KEY = "cite";
export const CITE_INSTRUCTION = "（本轮回答若实际依据了上面某条，在回复最后单独一行写：ab-used: 简短标题 (id)，多条用；分隔。没用上就不写。）";

export type InjectPath = "recall" | "pref" | "brief" | "search" | "get";
export type RecallOutcome = "hit" | "nohit" | "error";

export interface Ctx {
  host: Host | null;
  session_id: string | null;
  transcript: string | null;
  project_id: string | null;
}

export function citeEnabled(db: DatabaseSync): boolean {
  const r = db.prepare("SELECT value FROM work_meta WHERE key=?").get(CITE_KEY) as { value: string } | undefined;
  return r?.value === "on";
}

export function setCite(db: DatabaseSync, on: boolean): void {
  db.prepare("INSERT INTO work_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(CITE_KEY, on ? "on" : "off");
}

/** 召回块末尾（闭合标签前）加一行引用指令；没有召回块就原样返回。指令不占召回的字数预算。 */
export function withCiteInstruction(block: string): string {
  const close = "\n</agentbrain-recall>";
  const i = block.lastIndexOf(close);
  return i < 0 ? block : block.slice(0, i) + "\n" + CITE_INSTRUCTION + block.slice(i);
}

export function logInjections(db: DatabaseSync, ctx: Ctx, path: InjectPath, ids: readonly string[], now: Date): void {
  if (!ids.length) return;
  const st = db.prepare("INSERT INTO inject_log(ts,host,session_id,transcript,project_id,prop_id,path,rank) VALUES(?,?,?,?,?,?,?,?)");
  ids.forEach((id, i) => st.run(now.toISOString(), ctx.host, ctx.session_id, ctx.transcript, ctx.project_id, id, path, i + 1));
}

export function logRecallRun(db: DatabaseSync, ctx: Ctx, outcome: RecallOutcome, nHits: number, ms: number, cite: boolean, now: Date): void {
  db.prepare("INSERT INTO recall_runs(ts,host,session_id,project_id,outcome,n_hits,ms,cite) VALUES(?,?,?,?,?,?,?,?)")
    .run(now.toISOString(), ctx.host, ctx.session_id, ctx.project_id, outcome, nHits, Math.round(ms), cite ? 1 : 0);
}

/** 删掉 RETENTION_DAYS 天前的统计行。返回删除行数。 */
export function prune(db: DatabaseSync, now: Date, days = RETENTION_DAYS): number {
  const cut = new Date(now.getTime() - days * 86_400_000).toISOString();
  let n = 0;
  n += Number(db.prepare("DELETE FROM inject_log WHERE ts<?").run(cut).changes);
  n += Number(db.prepare("DELETE FROM recall_runs WHERE ts<?").run(cut).changes);
  n += Number(db.prepare("DELETE FROM cite_scan WHERE scanned_at<?").run(cut).changes);
  return n;
}

export interface Citation {
  id: string;
  title: string;
}

const AB_USED = /^\s*`?\s*ab-used\s*[:：]\s*(.*?)`?\s*$/i;
const ID_IN_PARENS = /[(（]\s*([0-9a-f]{8})\s*[)）]\s*$/i;

/** 取回复里最后一行 ab-used，按；/; 切开，每段只认末尾括号里的 8 位 id；没有合法 id 的段丢弃。 */
export function parseAbUsed(text: string): Citation[] {
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = AB_USED.exec(lines[i]);
    if (!m) continue;
    const out: Citation[] = [];
    for (const seg of m[1].split(/[；;]/)) {
      const s = seg.trim();
      const id = ID_IN_PARENS.exec(s);
      if (!id) continue;
      const cid = id[1].toLowerCase();
      if (out.some((c) => c.id === cid)) continue;
      out.push({ id: cid, title: s.slice(0, id.index).trim() });
    }
    return out;
  }
  return [];
}

/** 抽取输入里去掉 ab-used 行，免得被当成内容沉淀。 */
export function stripAbUsed(text: string): string {
  return text.split(/\r?\n/).filter((l) => !AB_USED.test(l)).join("\n").trim();
}

function bigrams(s: string): Set<string> {
  const t = s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const out = new Set<string>();
  for (let i = 0; i + 1 < t.length; i++) out.add(t.slice(i, i + 2));
  return out;
}

/** 标题里的二字组有多少出现在条目正文里（0–1）。标题为空返回 1（不算不符）。 */
export function titleOverlap(title: string, body: string): number {
  const a = bigrams(title);
  if (!a.size) return 1;
  const b = bigrams(body);
  let hit = 0;
  for (const g of a) if (b.has(g)) hit++;
  return hit / a.size;
}

function join2(p: unknown, m: unknown): string | undefined {
  return typeof m === "string" && m ? (typeof p === "string" && p ? `${p}/${m}` : m) : undefined;
}

/** 宿主 transcript 里最后出现的模型名（pi/opencode 带 provider 前缀）；读不到为 null。 */
export function modelOf(host: Host, file: string): string | null {
  if (host === "opencode") {
    try {
      return opencodeModel(file);
    } catch {
      return null;
    }
  }
  let model: string | null = null;
  let lines: any[];
  try {
    lines = linesOf(file) as any[];
  } catch {
    return null;
  }
  for (const e of lines) {
    const m =
      host === "claude" ? (e?.type === "assistant" ? e?.message?.model : undefined)
      : host === "codex" ? (e?.type === "turn_context" ? e?.payload?.model : undefined)
      : e?.type === "model_change" ? join2(e?.provider, e?.modelId) : e?.message?.role === "assistant" ? join2(e?.message?.provider, e?.message?.model) : undefined;
    if (typeof m === "string" && m && m !== "<synthetic>") model = m;
  }
  return model;
}

export interface ScanResult {
  marked_turns: number;
  cited: number;
  dropped: number;
  mismatched: number;
}

/**
 * 读一个会话的助手回复，把 ab-used 里的 id 与本会话此前注入过的召回条目（path=recall）对上，标 cited。
 * 对不上的 id 丢弃（防编造）；标题与正文重合低于 TITLE_MATCH_MIN 记 title_mismatch，但仍算引用。
 * 幂等：重复扫描只会把同一行再标一次。
 */
export function scanSession(db: DatabaseSync, host: Host, sessionId: string, turns: readonly Turn[], textOf: (propId: string) => string | null, model: string | null, now: Date): ScanResult {
  const res: ScanResult = { marked_turns: 0, cited: 0, dropped: 0, mismatched: 0 };
  const find = db.prepare("SELECT id,prop_id FROM inject_log WHERE host=? AND session_id=? AND path='recall' AND substr(prop_id,1,8)=? AND (? IS NULL OR ts<=?) ORDER BY ts DESC, id DESC LIMIT 1");
  const mark = db.prepare("UPDATE inject_log SET cited=1, cited_at=?, cited_title=?, title_mismatch=? WHERE id=?");
  for (const t of turns) {
    if (t.role !== "assistant") continue;
    const cites = parseAbUsed(t.text);
    if (!cites.length) continue;
    let any = false;
    for (const c of cites) {
      const row = find.get(host, sessionId, c.id, t.ts ?? null, t.ts ?? null) as { id: number; prop_id: string } | undefined;
      if (!row) {
        res.dropped++;
        continue;
      }
      const body = textOf(row.prop_id) ?? "";
      const bad = c.title !== "" && titleOverlap(c.title, body) < TITLE_MATCH_MIN;
      mark.run(t.ts ?? now.toISOString(), c.title || null, bad ? 1 : 0, row.id);
      res.cited++;
      if (bad) res.mismatched++;
      any = true;
    }
    if (any) res.marked_turns++;
  }
  db.prepare("INSERT INTO cite_scan(host,session_id,model,marked_turns,scanned_at) VALUES(?,?,?,?,?) ON CONFLICT(host,session_id) DO UPDATE SET model=excluded.model, marked_turns=excluded.marked_turns, scanned_at=excluded.scanned_at")
    .run(host, sessionId, model, res.marked_turns, now.toISOString());
  return res;
}

/** 有过召回注入、要扫描引用的会话。 */
export function sessionsToScan(db: DatabaseSync): { host: Host; session_id: string; transcript: string | null }[] {
  return db.prepare("SELECT host,session_id,MAX(transcript) AS transcript FROM inject_log WHERE path='recall' AND host IS NOT NULL AND session_id IS NOT NULL GROUP BY host,session_id").all() as any;
}
