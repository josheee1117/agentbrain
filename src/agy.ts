/**
 * Antigravity CLI（agy）的会话布局（设计 §7.7）：每个会话一个目录 `brain/<id>`，
 * 完整记录在 `.system_generated/logs/transcript_full.jsonl`（同目录 `transcript.jsonl` 会截断长字段）。
 * cwd 不在记录里，sweep 从 `conversation_summaries.db` 只读取。
 */
import { DatabaseSync } from "node:sqlite";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ID = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const TAIL = /\/brain\/([^/]+)\/\.system_generated\/logs\/transcript(?:_full)?\.jsonl$/;

export function agyAppDir(): string {
  return join(homedir(), ".gemini/antigravity-cli");
}

export function agyBrainDir(): string {
  return join(agyAppDir(), "brain");
}

/** 会话 id 的完整记录路径；id 不合法（含 `/`、`..`）返回 null。 */
export function agyTranscriptPath(id: string): string | null {
  return ID.test(id) ? join(agyBrainDir(), id, ".system_generated/logs/transcript_full.jsonl") : null;
}

/** 从 `brain/<id>/.system_generated/logs/transcript{,_full}.jsonl` 取 id。 */
export function agySessionId(path: string): string | null {
  const m = TAIL.exec(path);
  return m && ID.test(m[1]) ? m[1] : null;
}

export interface AgyConversation {
  id: string;
  cwd: string;
  parent: string | null;
}

/** 近期会话的工作目录与父会话（只读）。库不存在或读不了时抛错，由调用方跳过 agy。 */
export function agyConversations(sinceMs: number): AgyConversation[] {
  const path = join(agyAppDir(), "conversation_summaries.db");
  if (realpathSync(path) !== path) throw new Error("agy summaries path is not canonical");
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout=1000");
    const rows = db.prepare("SELECT conversation_id, workspace_uris, parent_conversation_id, last_modified_time FROM conversation_summaries").all();
    return rows.flatMap((r) => {
      if (typeof r.conversation_id !== "string" || !ID.test(r.conversation_id)) return [];
      const t = Date.parse(String(r.last_modified_time));
      if (Number.isFinite(t) && t < sinceMs) return [];
      let uri: unknown;
      try {
        uri = (JSON.parse(String(r.workspace_uris)) as unknown[])[0];
      } catch {
        return [];
      }
      if (typeof uri !== "string" || !uri.startsWith("file://")) return [];
      const parent = typeof r.parent_conversation_id === "string" && r.parent_conversation_id ? r.parent_conversation_id : null;
      return [{ id: r.conversation_id, cwd: fileURLToPath(uri), parent }];
    });
  } finally {
    db.close();
  }
}
