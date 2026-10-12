/**
 * Source Pointer 展开（设计 §13.3）：按需读宿主 transcript，
 * 从记忆时的定位点回溯，还原"当时是怎么讨论出来的"。
 * agentbrain 自身不存对话原文。
 */
import { readFileSync, existsSync } from "node:fs";
import type { SourcePointer, Host } from "./l2.ts";

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
  for (const line of readFileSync(file, "utf8").split("\n")) {
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
  if (!src.host || !src.transcript || !src.anchor || !existsSync(src.transcript)) return null;
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
  if (!existsSync(transcriptPath)) return null;
  const lines = linesOf(transcriptPath);
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
