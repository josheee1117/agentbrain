/**
 * Pensieve 导入（§21 2026-10-13）：把 .pensieve/{maxims,decisions,knowledge} 里用户整理过的知识导成已确认记忆。
 * 本文件只做解析与映射（纯函数 + 只读文件）；写 L1、去重判定在 importPensieve。
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { ImportRef, PropKind, Proposition, RememberBody } from "./l2.ts";
import type { Store, Embedder } from "./store.ts";
import { parseJsonLoose, type Chat } from "./llm.ts";
import { applyVerdict, buildRelateMessages, parseRelate, type RelateItem } from "./relate.ts";
import { sanitize, hasSecret } from "./sanitize.ts";

export const IMPORT_TEXT_MAX = 400;
export const IMPORT_WHY_MAX = 400;
const TYPE_DIRS: Record<string, "maxim" | "decision" | "knowledge"> = { maxims: "maxim", decisions: "decision", knowledge: "knowledge" };
const CONCLUSION = ["一句话结论", "one-line conclusion", "结论", "核心结论", "summary", "摘要"];
const WHY_DECISION = ["context", "背景", "problem", "问题"];
const WHY_MAXIM = ["guidance", "指导规则", "指导", "boundaries", "边界"];
const WHY_KNOWLEDGE = ["content", "内容", "背景", "context"];
/** knowledge 里讲坑的：标题/结论带这些词按 pitfall，其余按 note。 */
// knowledge 记成坑：标题里有明确的陷阱/禁止措辞，或结论里点名是坑/根因/NPE。"必须""失败""异常"这类词在规范和架构说明里太常见，不算。
const TRAP_TITLE = /坑|陷阱|禁止|不要|别用|误判|根因|会导致|root[- ]cause|NPE|trap|gotcha|pitfall/i;
const TRAP_BODY = /坑|陷阱|根因|root[- ]cause|NPE|gotcha|pitfall/i;

export interface PensieveDoc {
  id: string;
  type: "maxim" | "decision" | "knowledge";
  title: string;
  status: string;
  path: string;
  sha256: string;
  conclusion: string;
  sections: Map<string, string>;
}

export interface ImportPlanItem {
  doc: PensieveDoc;
  kind: PropKind;
  text: string;
  why: string | undefined;
  /** 同一 id、同一内容出现在多个仓库时其余的路径。 */
  also: string[];
}

export interface Skipped {
  path: string;
  id: string;
  reason: string;
}

export function parseFrontmatter(src: string): { meta: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src);
  if (!m) return { meta: {}, body: src };
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return { meta, body: src.slice(m[0].length) };
}

export function splitSections(body: string): Map<string, string> {
  const out = new Map<string, string>();
  const parts = body.split(/^##\s+(.+?)\s*$/m);
  for (let i = 1; i < parts.length; i += 2) {
    const key = parts[i].replace(/[（(].*?[)）]/g, "").trim().toLowerCase();
    if (!out.has(key)) out.set(key, parts[i + 1].trim());
  }
  return out;
}

/** 去掉代码块、表格、wiki 链接、引用符号，压成一段话。 */
export function condense(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .split(/\r?\n/)
    .filter((l) => !/^\s*\|/.test(l) && !/^\s*#+\s/.test(l))
    .map((l) => l.replace(/^\s*(?:[-*>]|\d+\.)\s*/, "").replace(/\[\[([^\]]+)\]\]/g, "$1").replace(/[`*]/g, "").replace(/(^|\s)_([^_\s][^_]*)_(?=\s|$)/g, "$1$2").trim())
    .filter(Boolean)
    .join("；")
    .replace(/[；;]{2,}/g, "；")
    .replace(/([。！？：:])；/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function cap(s: string, n: number): string {
  const cs = [...s];
  return cs.length <= n ? s : cs.slice(0, n - 1).join("") + "…";
}

function pick(sections: Map<string, string>, keys: string[]): string[] {
  return keys.map((k) => sections.get(k)).filter((v): v is string => !!v);
}

export function parseDoc(path: string, src: string, dirType: PensieveDoc["type"]): PensieveDoc | null {
  const { meta, body } = parseFrontmatter(src);
  const sections = splitSections(body);
  const h1 = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
  const title = meta.title || h1 || "";
  // 没有结论段：decision 退到"决策"段；再不行取第一个不是标题、也不是"**日期**: …"元数据块的段落
  const isMeta = (para: string) => para.split("\n").every((l) => /^\s*(?:[-*]\s*)?(?:\*\*[^*]{1,12}\*\*|[^\s:：]{1,8})\s*[:：]/.test(l));
  const firstPara = (t: string) => {
    const ps = t.split(/\n\s*\n/).map((p) => p.trim());
    const i = ps.findIndex((p) => p && !p.startsWith("#") && !isMeta(p));
    return i < 0 ? undefined : ps.slice(i).join("\n\n");
  };
  const conclusionRaw = pick(sections, CONCLUSION)[0]
    ?? (dirType === "decision" ? pick(sections, ["decision", "决策", "决定", "方案"]).map(firstPara).find(Boolean) : undefined)
    ?? firstPara(body) ?? "";
  // 第一段以冒号收尾（"关键设计点：" 后面跟列表），把下一段也带上，否则正文只剩半句
  const paras = conclusionRaw.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  let conclusion = condense(paras[0] ?? "");
  if (/[:：]$/.test(conclusion) && paras[1]) conclusion = `${conclusion}${condense(paras[1])}`;
  const id = meta.id || path.split("/").slice(-2).join("/").replace(/\.md$/, "");
  return {
    id,
    type: (TYPE_DIRS[meta.type + "s"] ?? (meta.type === "knowledge" ? "knowledge" : null)) ?? dirType,
    title,
    status: (meta.status || "active").toLowerCase(),
    path,
    sha256: createHash("sha256").update(src).digest("hex"),
    conclusion,
    sections,
  };
}

export function mapDoc(doc: PensieveDoc): { kind: PropKind; text: string; why: string | undefined } {
  const kind: PropKind = doc.type === "maxim" ? "rule" : doc.type === "decision" ? "decision" : (TRAP_TITLE.test(doc.title) || TRAP_BODY.test(doc.conclusion)) ? "pitfall" : "note";
  const head = doc.title && !doc.conclusion.includes(doc.title) ? `${doc.title}：` : "";
  const text = cap(sanitize(`${head}${doc.conclusion || doc.title}`).text, IMPORT_TEXT_MAX);
  const whyKeys = doc.type === "decision" ? WHY_DECISION : doc.type === "maxim" ? WHY_MAXIM : WHY_KNOWLEDGE;
  const whyRaw = pick(doc.sections, whyKeys).map(condense).filter(Boolean).join("；");
  const why = whyRaw ? cap(sanitize(whyRaw).text, IMPORT_WHY_MAX) : undefined;
  return { kind, text, why };
}

/** 列出一个仓库（或家目录）下 .pensieve 的可导入文件；pipelines、short-term、.state 不导。 */
export function listDocs(root: string): { path: string; type: PensieveDoc["type"] }[] {
  const base = join(root, ".pensieve");
  const out: { path: string; type: PensieveDoc["type"] }[] = [];
  for (const [dir, type] of Object.entries(TYPE_DIRS)) {
    const d = join(base, dir);
    if (!existsSync(d)) continue;
    const walk = (p: string) => {
      for (const name of readdirSync(p).sort()) {
        if (name.startsWith(".") || /\.(migrated|bak|orig)\b/.test(name)) continue; // ._xxx（macOS AppleDouble）、.state 等隐藏文件不是知识
        const f = join(p, name);
        if (statSync(f).isDirectory()) walk(f);
        else if (name.endsWith(".md")) out.push({ path: f, type });
      }
    };
    walk(d);
  }
  return out;
}

export interface PlanInput {
  root: string;
  /** null = 全局 */
  project: string | null;
}

export function planImport(inputs: PlanInput[], skip: Map<string, string>): { items: (ImportPlanItem & { project: string | null })[]; skipped: Skipped[] } {
  const items: (ImportPlanItem & { project: string | null })[] = [];
  const skipped: Skipped[] = [];
  const seen = new Map<string, ImportPlanItem & { project: string | null }>();
  for (const inp of inputs) {
    for (const f of listDocs(inp.root)) {
      const src = readFileSync(f.path, "utf8");
      const doc = parseDoc(f.path, src, f.type);
      if (!doc) continue;
      if (doc.status !== "active") {
        skipped.push({ path: f.path, id: doc.id, reason: `status=${doc.status}` });
        continue;
      }
      if (skip.has(doc.id)) {
        skipped.push({ path: f.path, id: doc.id, reason: skip.get(doc.id)! });
        continue;
      }
      if (!doc.conclusion && !doc.title) {
        skipped.push({ path: f.path, id: doc.id, reason: "没有结论也没有标题" });
        continue;
      }
      const mapped = mapDoc(doc);
      if (hasSecret(mapped.text) || (mapped.why && hasSecret(mapped.why))) {
        skipped.push({ path: f.path, id: doc.id, reason: "含密钥" });
        continue;
      }
      // 同一 id 同一内容出现在多个仓库（Pensieve 默认模板）：只导一次，作用域提成全局
      const dupKey = `${doc.id}\u0000${doc.sha256}`;
      const prev = seen.get(dupKey);
      if (prev) {
        prev.also.push(f.path);
        prev.project = null;
        skipped.push({ path: f.path, id: doc.id, reason: `与 ${prev.doc.path} 内容相同，合并为一条全局` });
        continue;
      }
      const item = { doc, ...mapped, also: [], project: inp.project };
      seen.set(dupKey, item);
      items.push(item);
    }
  }
  return { items, skipped };
}

export function importRef(item: ImportPlanItem): ImportRef {
  return { system: "pensieve", id: item.doc.id, path: item.doc.path, sha256: item.doc.sha256, also: item.also.length ? item.also : undefined };
}

/** 已导入的同一篇：按 Pensieve id + 作用域找当前有效版本（纠正链的末端）。 */
export function findImported(props: Map<string, Proposition>, id: string, projectId: string | null): Proposition | undefined {
  let best: Proposition | undefined;
  for (const p of props.values()) {
    if (p.import_ref?.system !== "pensieve" || p.import_ref.id !== id || p.project_id !== projectId) continue;
    if (p.state === "superseded") continue;
    if (!best || p.seq > best.seq) best = p;
  }
  return best;
}

export interface ImportReport {
  created: string[];
  corrected: string[];
  unchanged: number;
  archivedSkip: number;
  skipped: Skipped[];
  relate: { mergedExisting: number; mergedIntoExisting: number; refines: number; conflicts: string[]; unrelated: number; unsure: number; errors: number; errorDetails: string[] };
}

export interface ImportDeps {
  store: Store;
  projectId: (name: string) => string;
  embedder: Embedder | null;
  chat: { chat: Chat; model: string } | null;
  relateSim: number;
  relateTop: number;
  relateBatch: number;
}

export async function importPensieve(deps: ImportDeps, plan: ReturnType<typeof planImport>): Promise<ImportReport> {
  const report: ImportReport = { created: [], corrected: [], unchanged: 0, archivedSkip: 0, skipped: plan.skipped, relate: { mergedExisting: 0, mergedIntoExisting: 0, refines: 0, conflicts: [], unrelated: 0, unsure: 0, errors: 0, errorDetails: [] } };
  const pending: string[] = []; // 未变但还没做过关系判定的（上次判定出错或中断），本次补判
  for (const it of plan.items) {
    const pid = it.project === null ? null : deps.projectId(it.project);
    const props = deps.store.project().props;
    const old = findImported(props, it.doc.id, pid);
    if (old && old.state !== "active") {
      report.archivedSkip++; // 归档过（整理时判掉或被并入）：尊重该决定
      continue;
    }
    if (old && old.import_ref?.sha256 === it.doc.sha256) {
      report.unchanged++;
      if (!old.related) pending.push(old.id);
      continue;
    }
    const body: RememberBody = {
      kind: it.kind,
      text: it.text,
      why: it.why,
      source: { host: null, session_id: null, transcript: null, anchor: null, summary: `Pensieve 导入：${it.doc.path}` },
      confirmed: true,
      origin: "import",
      import_ref: importRef(it),
      supersedes: old?.id,
      scenes: old?.scenes.length ? old.scenes : undefined,
    };
    const id = deps.store.remember(pid, null, false, body);
    (old ? report.corrected : report.created).push(id);
  }
  const toRelate = [...report.created, ...report.corrected, ...pending];
  if (deps.embedder && deps.chat && toRelate.length) await relateImports(deps, toRelate, report);
  return report;
}

/** 新导入的条目和已有记忆做关系判定。已有的是用户确认的就并入它（不动它）；否则把已有的并进导入条。 */
async function relateImports(deps: ImportDeps, ids: string[], report: ImportReport): Promise<void> {
  try {
    await deps.store.syncVectors(deps.embedder!, deps.embedder!.model!);
  } catch (e) {
    report.relate.errors++;
    report.relate.errorDetails.push(`向量: ${(e as Error).message}`.slice(0, 300));
    return;
  }
  const items: RelateItem[] = [];
  for (const id of ids) {
    const p = deps.store.project().props.get(id);
    const ns = p ? deps.store.neighbors(id) : null;
    if (!p || !ns) continue;
    const near = ns.filter((n) => n.similarity >= deps.relateSim && n.prop.origin !== "import");
    if (near.length) items.push({ prop: p, neighbors: near.slice(0, deps.relateTop).map((n) => n.prop) });
  }
  for (let i = 0; i < items.length; i += deps.relateBatch) {
    const batch = items.slice(i, i + deps.relateBatch);
    let verdicts;
    try {
      const r = await deps.chat!.chat(buildRelateMessages(batch), { json: true });
      verdicts = parseRelate(parseJsonLoose(r.message.content), batch);
    } catch (e) {
      report.relate.errors++;
      if (report.relate.errorDetails.length < 5) report.relate.errorDetails.push(`判定: ${(e as Error).message}`.slice(0, 300));
      continue;
    }
    batch.forEach((b, k) => {
      const v = verdicts[k];
      if (!v) {
        report.relate.errors++;
        return;
      }
      const props = deps.store.project().props;
      const p = props.get(b.prop.id);
      const t = v.target ? props.get(v.target.id) : null;
      if (!p || p.state !== "active" || (v.target && t?.state !== "active")) return;
      const { appends, merge } = applyVerdict(p, t ?? null, v, deps.chat!.model, { mode: "user-confirmed-wins" });
      if (merge === "new-into-target") report.relate.mergedIntoExisting++;
      else if (merge === "target-into-new") report.relate.mergedExisting++;
      else if (v.outcome === "conflicts") report.relate.conflicts.push(`${p.id.slice(0, 8)}↔${t?.id.slice(0, 8)}`);
      else if (v.outcome !== "duplicate") report.relate[v.outcome]++; // duplicate 必有目标（parseRelate 保证），走不到这里
      deps.store.commit(appends, () => {});
    });
  }
}

export function displayPath(p: string, home: string): string {
  const r = relative(home, p);
  return r.startsWith("..") ? p : `~/${r}`;
}
