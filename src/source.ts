/**
 * Source Pointer 展开（设计 §13.3）：按需读宿主 transcript，
 * 从记忆时的定位点回溯，还原"当时是怎么讨论出来的"。
 * agentbrain 自身不存对话原文。
 */
import { closeSync, constants as fsConstants, fstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { extname, isAbsolute, sep } from "node:path";
import { sanitize } from "./sanitize.ts";
import type { SourcePointer, Host } from "./l2.ts";
import { opencodeId, opencodeParts } from "./opencode.ts";
import { allowedTranscript, readTranscript } from "./transcript-file.ts";

const MAX_ENTRIES = 30;
const MAX_CHARS_PER_ENTRY = 600;
const MAX_TOTAL_CHARS = 8000;

type Role = "user" | "assistant";

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) =>
      c && typeof c === "object" && (c as any).type === "text" && typeof (c as any).text === "string" ? (c as any).text : "",
    )
    .filter(Boolean)
    .join("\n");
}

export function linesOf(file: string): unknown[] {
  const out: unknown[] = [];
  for (const line of readTranscript(file).split("\n")) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line);
      if (v === null || typeof v !== "object" || Array.isArray(v)) continue; // null、数字、数组不是条目
      out.push(v);
    } catch {
      /* 跳过坏行 */
    }
  }
  return out;
}

function budget(segments: { role: Role; text: string }[]): string {
  const out: string[] = [];
  let total = 0;
  for (const s of segments) {
    let t = s.text.trim();
    if (!t) continue;
    if (t.length > MAX_CHARS_PER_ENTRY) t = t.slice(0, MAX_CHARS_PER_ENTRY) + "…";
    const line = `[${s.role}] ${t}`;
    if (total + line.length > MAX_TOTAL_CHARS) break;
    out.push(line);
    total += line.length;
  }
  return out.join("\n\n");
}

interface PiEntry {
  id?: string;
  parentId?: string | null;
  type?: string;
  message?: { role?: string; content?: unknown };
}

function readPi(file: string, anchor: string): string | null {
  const byId = new Map<string, PiEntry>();
  for (const e of linesOf(file) as PiEntry[]) if (e.id) byId.set(e.id, e);
  if (!byId.has(anchor)) return null;
  const chain: PiEntry[] = [];
  let cur: PiEntry | undefined = byId.get(anchor);
  while (cur && chain.length < MAX_ENTRIES) {
    if (cur.type === "message" && (cur.message?.role === "user" || cur.message?.role === "assistant")) chain.push(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  chain.reverse();
  return budget(chain.map((e) => ({ role: e.message!.role as Role, text: textOf(e.message!.content) })));
}

interface ClaudeEntry {
  uuid?: string;
  parentUuid?: string | null;
  type?: string;
  message?: { content?: unknown };
}

function readClaude(file: string, anchor: string): string | null {
  const byId = new Map<string, ClaudeEntry>();
  for (const e of linesOf(file) as ClaudeEntry[]) if (e.uuid) byId.set(e.uuid, e);
  if (!byId.has(anchor)) return null;
  const chain: ClaudeEntry[] = [];
  let cur: ClaudeEntry | undefined = byId.get(anchor);
  while (cur && chain.length < MAX_ENTRIES) {
    if (cur.type === "user" || cur.type === "assistant") chain.push(cur);
    cur = cur.parentUuid ? byId.get(cur.parentUuid) : undefined;
  }
  chain.reverse();
  return budget(chain.map((e) => ({ role: e.type as Role, text: textOf(e.message?.content) })));
}

interface CodexLine {
  ordinal?: number;
  type?: string;
  payload?: { type?: string; role?: string; content?: { text?: string }[] };
}

/** 只丢这些已知宿主注入；"<" 开头的真实用户输入（如 "<task>"）要保留。 */
export const CODEX_INJECTED = [
  "<environment_context>",
  "<user_instructions>",
  "<heartbeat>",
  "<recommended_plugins>",
  "<turn_aborted>",
  "<permissions instructions>",
  "# AGENTS.md instructions",
];

function readCodex(file: string, anchor: string): string | null {
  const max = Number(anchor);
  if (!Number.isFinite(max)) return null;
  const lines = linesOf(file) as CodexLine[];
  if (!lines.some((e) => e.ordinal === max)) return null; // anchor 对不上任何一行，来源不可用
  const segs: { role: Role; text: string }[] = [];
  for (const e of lines) {
    if (typeof e.ordinal !== "number" || e.ordinal > max) continue;
    if (e.type !== "response_item" || e.payload?.type !== "message") continue;
    const role = e.payload.role;
    if (role !== "user" && role !== "assistant") continue;
    const texts = (e.payload.content ?? []).map((c) => c?.text ?? "").filter(Boolean);
    for (const t of texts) {
      if (role === "user" && CODEX_INJECTED.some((m) => t.trimStart().startsWith(m))) continue;
      segs.push({ role, text: t });
    }
  }
  return budget(segs.slice(-MAX_ENTRIES));
}

/** 返回按时间顺序的对话片段；transcript 不存在或指针无效时返回 null（显式不可用，不伪装成空）。 */
export function expandSource(src: SourcePointer): string | null {
  if (src.host === "opencode") {
    if (!src.transcript || !src.anchor || opencodeId(src.transcript) !== src.session_id) return null;
    try {
      const { parts } = opencodeParts(src.transcript);
      const end = parts.findIndex((p) => p.id === src.anchor);
      if (end < 0) return null;
      return budget(parts.slice(0, end + 1).filter((p) => p.data.type === "text" && typeof p.data.text === "string").slice(-MAX_ENTRIES).map((p) => ({ role: p.role, text: String(p.data.text) }))) || null;
    } catch {
      return null;
    }
  }
  if (!src.host || !src.transcript || !src.anchor) return null;
  const allowed = allowedTranscript(src.host, src.transcript);
  if (!allowed) return null; // L1 里的路径不算可信，每次读都先过准入（§7.6）
  const text =
    src.host === "pi"
      ? readPi(src.transcript, src.anchor)
      : src.host === "claude"
        ? readClaude(src.transcript, src.anchor)
        : readCodex(src.transcript, src.anchor);
  return text || null;
}

/** 当前 transcript 的最新定位点；文件不存在或没有可用条目时返回 null。 */
export function latestAnchor(host: Host, transcriptPath: string): string | null {
  if (host === "opencode") {
    try {
      return opencodeParts(transcriptPath).parts.filter((p) => p.data.type === "text").at(-1)?.id ?? null;
    } catch {
      return null;
    }
  }
  const allowed = allowedTranscript(host, transcriptPath);
  if (!allowed) return null;
  const lines = linesOf(allowed);
  if (host === "pi") {
    let id: string | null = null;
    for (const e of lines as PiEntry[]) if (e.type === "message" && e.id) id = e.id;
    return id;
  }
  if (host === "claude") {
    let uuid: string | null = null;
    for (const e of lines as ClaudeEntry[]) if ((e.type === "user" || e.type === "assistant") && e.uuid) uuid = e.uuid;
    return uuid;
  }
  let ordinal: number | null = null;
  for (const e of lines as CodexLine[]) {
    if (e.type === "response_item" && e.payload?.type === "message" && typeof e.ordinal === "number") ordinal = e.ordinal;
  }
  return ordinal === null ? null : String(ordinal);
}

// ---------- Pensieve 导入条的原文件（§11.6 (iii)，2026-10-19 用户批准） ----------

/** 打开原文件最多给这么多字（按字符计），超出截断并说明。 */
export const IMPORT_EXPAND_MAX_CHARS = 4000;
/** 原文件超过这个字节数不读（Pensieve 文档通常几 KB）。 */
const IMPORT_EXPAND_MAX_BYTES = 256 * 1024;

export type ImportExpand = { ok: true; path: string; text: string; changed: boolean; truncated: boolean } | { ok: false; reason: string };

/**
 * 读 Pensieve 导入条的原 md 文件。只读 import_ref 里记下的路径（主路径不在时依次试 also 里的副本）；
 * 只接受真实路径落在某个 .pensieve/ 目录下的普通 .md 文件（防止被改过的路径指向别处）。
 * 内容走 sanitize 脱敏；哈希与导入时不同就标 changed。读不到时给出原因，不抛。
 */
export function expandImport(ref: { path: string; sha256: string; also?: string[] }): ImportExpand {
  const reasons: string[] = [];
  for (const p of [ref.path, ...(ref.also ?? [])]) {
    const r = readImportFile(p);
    if (!("reason" in r)) {
      const changed = createHash("sha256").update(r.src).digest("hex") !== ref.sha256;
      const s = sanitize(r.src).text;
      const cs = [...s];
      const truncated = cs.length > IMPORT_EXPAND_MAX_CHARS;
      return { ok: true, path: r.real, text: truncated ? cs.slice(0, IMPORT_EXPAND_MAX_CHARS).join("") + "…" : s, changed, truncated };
    }
    reasons.push(`${p}：${r.reason}`);
  }
  return { ok: false, reason: reasons.join("；") };
}

function readImportFile(p: string): { src: string; real: string } | { reason: string } {
  if (!isAbsolute(p)) return { reason: "不是绝对路径" };
  const parts = p.split(sep);
  const k = parts.lastIndexOf(".pensieve");
  if (k < 0 || extname(p).toLowerCase() !== ".md") return { reason: "记下的路径不是 .pensieve 目录下的 .md 文件，拒绝读取" };
  let real: string;
  let root: string;
  try {
    real = realpathSync(p);
    root = realpathSync(parts.slice(0, k + 1).join(sep));
  } catch (e) {
    return { reason: fsReason(e) };
  }
  // 真实路径必须还在记下的那个 .pensieve 目录里：防止 md 是指向别处的符号链接
  if (!real.startsWith(root + sep) || extname(real).toLowerCase() !== ".md") return { reason: "文件实际指向 .pensieve 目录之外（符号链接），拒绝读取" };
  let fd: number | undefined;
  try {
    // 校验之后用同一个文件描述符读，不跟随末级符号链接，免得校验和读取之间被换掉
    fd = openSync(real, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const st = fstatSync(fd);
    if (!st.isFile()) return { reason: "不是普通文件" };
    if (st.size > IMPORT_EXPAND_MAX_BYTES) return { reason: `文件过大（${st.size} 字节）` };
    return { src: readFileSync(fd, "utf8"), real };
  } catch (e) {
    return { reason: fsReason(e) };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function fsReason(e: unknown): string {
  const code = (e as NodeJS.ErrnoException).code;
  if (code === "ENOENT" || code === "ENOTDIR") return "文件不存在";
  if (code === "EACCES" || code === "EPERM") return "没有读取权限";
  if (code === "ELOOP") return "是符号链接，拒绝读取";
  return `无法读取（${code ?? "未知错误"}）`;
}
