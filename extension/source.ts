/**
 * Source Pointer 展开（设计 §13.3 v2.4）：按需读 Pi session JSONL，
 * 从记忆时的 leaf entry 沿 parentId 回溯，还原"当时是怎么讨论出来的"。
 * agentbrain 自身不存对话原文。
 */
import { readFileSync, existsSync } from "node:fs";
import type { SourcePointer } from "./store.ts";

const MAX_ENTRIES = 30;
const MAX_CHARS_PER_ENTRY = 600;
const MAX_TOTAL_CHARS = 8000;

interface Entry {
  id: string;
  parentId: string | null;
  type: string;
  message?: { role: string; content: unknown };
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => (c && typeof c === "object" && (c as any).type === "text" ? String((c as any).text) : ""))
    .filter(Boolean)
    .join("\n");
}

/** 返回按时间顺序的对话片段；transcript 不存在或指针无效时返回 null（显式不可用，不伪装成空）。 */
export function expandSource(src: SourcePointer): string | null {
  if (!src.file || !src.entry_id || !existsSync(src.file)) return null;
  const byId = new Map<string, Entry>();
  for (const line of readFileSync(src.file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as Entry;
      if (e.id) byId.set(e.id, e);
    } catch {
      /* 跳过坏行 */
    }
  }
  if (!byId.has(src.entry_id)) return null;
  const chain: Entry[] = [];
  let cur: Entry | undefined = byId.get(src.entry_id);
  while (cur && chain.length < MAX_ENTRIES) {
    if (cur.type === "message" && cur.message && (cur.message.role === "user" || cur.message.role === "assistant")) {
      chain.push(cur);
    }
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  chain.reverse();
  const out: string[] = [];
  let total = 0;
  for (const e of chain) {
    let t = textOf(e.message!.content).trim();
    if (!t) continue;
    if (t.length > MAX_CHARS_PER_ENTRY) t = t.slice(0, MAX_CHARS_PER_ENTRY) + "…";
    const line = `[${e.message!.role}] ${t}`;
    if (total + line.length > MAX_TOTAL_CHARS) break;
    out.push(line);
    total += line.length;
  }
  return out.join("\n\n");
}
