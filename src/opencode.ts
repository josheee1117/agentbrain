import { DatabaseSync } from "node:sqlite";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PREFIX = "opencode://session/";
const SESSION_ID = /^ses_[a-zA-Z0-9]+$/;

export interface OpencodeSession {
  id: string;
  directory: string;
  parent_id: string | null;
  time_created: number;
  time_updated: number;
}

export interface OpencodePart {
  id: string;
  role: "user" | "assistant";
  ts: string;
  final?: boolean;
  data: Record<string, unknown>;
}

export function opencodeRef(id: string): string | null {
  return SESSION_ID.test(id) ? PREFIX + id : null;
}

export function opencodeId(ref: string): string | null {
  if (!ref.startsWith(PREFIX)) return null;
  const id = ref.slice(PREFIX.length);
  return SESSION_ID.test(id) ? id : null;
}

export function opencodeDbPath(): string {
  return join(homedir(), ".local/share/opencode/opencode.db");
}

function readDb<T>(read: (db: DatabaseSync) => T): T {
  const path = opencodeDbPath();
  // 不跟随被换成任意文件的数据库链接，也不让调用方提供数据库路径。
  if (realpathSync(path) !== path) throw new Error("opencode database path is not canonical");
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout=1000");
    return read(db);
  } finally {
    db.close();
  }
}

export function opencodeSession(ref: string): OpencodeSession | null {
  const id = opencodeId(ref);
  if (!id) return null;
  return readDb((db) => {
    const row = db.prepare("SELECT id,directory,parent_id,time_created,time_updated FROM session_v2 WHERE id=?").get(id);
    if (!row || typeof row.id !== "string" || typeof row.directory !== "string" || (row.parent_id !== null && typeof row.parent_id !== "string") || typeof row.time_created !== "number" || typeof row.time_updated !== "number") return null;
    return { id: row.id, directory: row.directory, parent_id: row.parent_id, time_created: row.time_created, time_updated: row.time_updated };
  });
}

export function recentOpencodeSessions(since: number): OpencodeSession[] {
  return readDb((db) => db.prepare("SELECT id,directory,parent_id,time_created,time_updated FROM session_v2 WHERE time_updated>=? AND parent_id IS NULL ORDER BY time_updated").all(since) as unknown as OpencodeSession[]);
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** user 定位点用 message.id，assistant 加 content 下标。 */
export function opencodeParts(ref: string): { session: OpencodeSession; parts: OpencodePart[] } {
  const session = opencodeSession(ref);
  if (!session) throw new Error("opencode session does not exist");
  return readDb((db) => {
    const rows = db.prepare("SELECT id,type,time_created,data FROM session_message WHERE session_id=? ORDER BY seq").all(session.id);
    const parts: OpencodePart[] = [];
    for (const row of rows) {
      if (typeof row.id !== "string" || typeof row.data !== "string" || typeof row.time_created !== "number") continue;
      if (row.type !== "user" && row.type !== "assistant") continue;
      const message: unknown = JSON.parse(row.data);
      if (!object(message)) continue;
      const ts = new Date(row.time_created).toISOString();
      if (row.type === "user" && typeof message.text === "string") {
        parts.push({ id: row.id, role: "user", ts, data: { type: "text", text: message.text } });
      } else if (row.type === "assistant" && Array.isArray(message.content)) {
        message.content.forEach((data: unknown, i: number) => {
          if (!object(data) || (data.type !== "text" && data.type !== "tool")) return;
          if (data.type === "tool" && object(data.state)) {
            const state = data.state;
            const output = Array.isArray(state.content) ? state.content.filter(object).filter((p) => p.type === "text" && typeof p.text === "string").map((p) => p.text).join("\n") : "";
            const error = object(state.error) && typeof state.error.message === "string" ? state.error.message : "";
            parts.push({ id: `${row.id}:${i}`, role: "assistant", ts, data: { ...data, tool: data.name, state: { ...state, output, error } } });
          } else if (data.type === "text") {
            const final = object(message.time) && typeof message.time.completed === "number" && message.finish === "stop" && !message.error;
            const completed = final && object(message.time) ? new Date(Number(message.time.completed)).toISOString() : ts;
            parts.push({ id: `${row.id}:${i}`, role: "assistant", ts: completed, final, data });
          }
        });
      }
    }
    return { session, parts };
  });
}

export function opencodeModel(ref: string): string | null {
  const session = opencodeSession(ref);
  if (!session) return null;
  return readDb((db) => {
    const row = db.prepare("SELECT data FROM session_message WHERE session_id=? AND type='assistant' ORDER BY seq DESC LIMIT 1").get(session.id) as { data?: unknown } | undefined;
    if (!row || typeof row.data !== "string") return null;
    const m: unknown = JSON.parse(row.data);
    if (!object(m) || !object(m.model) || typeof m.model.id !== "string") return null;
    return typeof m.model.providerID === "string" ? `${m.model.providerID}/${m.model.id}` : m.model.id;
  });
}
