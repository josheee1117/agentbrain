/**
 * 切片 3 的 transcript 去噪（设计 §7.2、§8.1）：把三宿主的 transcript 读成按时间排列的轮次。
 * 丢掉宿主注入与 ab 自己的输出（防自回声），工具调用压成一行，工具输出只在像报错时留首尾。
 * 只读文件，不脱敏（脱敏在调用方，送模型前与写 L1 前各一次）。
 */
import { CODEX_INJECTED, linesOf } from "./source.ts";
import type { Host } from "./l2.ts";

export type TurnRole = "user" | "assistant" | "tool";

export interface Turn {
  /** 宿主定位点：pi entry id / claude uuid / codex ordinal。 */
  anchor: string;
  role: TurnRole;
  text: string;
  /** 这一轮的时间（宿主记录的 ISO 时间戳）；没有就缺省。 */
  ts?: string;
}

export interface Cleaned {
  turns: Turn[];
  /** 被剥掉的注入块与 ab 输出数。 */
  stripped: number;
  /** transcript 里记的工作目录（首个出现的），找不到为 null。 */
  cwd: string | null;
  /** Codex 子 agent 会话（guardian 审批、thread_spawn 等）：里面的 user 是另一个 agent，不是用户。 */
  subagent: boolean;
}

/** Codex rollout 的 session_meta.payload.source.subagent 存在即子 agent 会话（§21 2026-10-13）。 */
export function isCodexSubagent(lines: any[]): boolean {
  const meta = lines.find((e) => e?.type === "session_meta");
  return !!meta?.payload?.source?.subagent;
}

const TOOL_KEEP_CHARS = 300;
const TOOL_CALL_CHARS = 200;
const ERRORISH = /exit code:?\s*[1-9]|exit status [1-9]|\berror\b|failed|traceback|exception|ERR_|not found|denied|panic|fatal/i;
const INJECTED_BLOCKS = [
  /<agentbrain(?:-recall)?(?:\s[^>]*)?>[\s\S]*?(?:<\/agentbrain(?:-recall)?>|$)/g,
  /<system-reminder>[\s\S]*?(?:<\/system-reminder>|$)/g,
  /<local-command-(stdout|stderr|caveat)>[\s\S]*?(?:<\/local-command-\1>|$)/g,
  // 宿主注入的 skill 正文、后台任务通知、Codex app 页面事件、Pi 子代理提示（§21 2026-10-13）
  /<skill\s+name="[^"]*"[^>]*>[\s\S]*?(?:<\/skill>|$)/g,
  /<task-notification>[\s\S]*?(?:<\/task-notification>|$)/g,
  /<external_codex_apps_[a-z_]+>[\s\S]*?(?:<\/external_codex_apps_[a-z_]+>|$)/g,
  /<user-prompt-submit-hook>[\s\S]*?(?:<\/user-prompt-submit-hook>|$)/g,
  /^[ \t]*Subagent updates above\.[ \t]*$/gm,
];
const AB_COMMAND = /(?:^|[\s;&|(`'"])(?:\S*\/)?ab\s+(?:brief|search|get|status|doctor|recall|remember|correct|confirm|archive|capture|work)\b|\bcli\.ts\s+(?:brief|search|get|status|doctor|recall|remember|correct|confirm|archive|capture|work)\b/;

export function isAbCommand(cmd: string): boolean {
  return AB_COMMAND.test(cmd);
}

/** 返回剥掉注入后的文本与剥掉的块数。 */
export function stripInjected(text: string): { text: string; stripped: number } {
  let stripped = 0;
  let out = text;
  for (const re of INJECTED_BLOCKS) {
    out = out.replace(re, () => {
      stripped++;
      return "";
    });
  }
  return { text: out.trim(), stripped };
}

function compressOutput(output: string, isError: boolean): string {
  const t = output.trim();
  if (!t) return "";
  if (!isError && !ERRORISH.test(t)) return `（工具输出 ${t.length} 字，已省略）`;
  if (t.length <= TOOL_KEEP_CHARS * 2) return t;
  return `${t.slice(0, TOOL_KEEP_CHARS)}\n…\n${t.slice(-TOOL_KEEP_CHARS)}`;
}

function callLine(name: string, input: unknown): { line: string; ab: boolean } {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  let parsed = o;
  if (typeof input === "string") {
    try {
      parsed = JSON.parse(input) as Record<string, unknown>;
    } catch {
      parsed = { command: input };
    }
  }
  const cmd = parsed.command ?? parsed.cmd ?? parsed.script;
  const cmdText = Array.isArray(cmd) ? cmd.join(" ") : typeof cmd === "string" ? cmd : "";
  if (cmdText && isAbCommand(cmdText)) return { line: `调用 ab（agentbrain 自身的命令，已省略）`, ab: true };
  const path = parsed.file_path ?? parsed.path;
  const what = cmdText || (typeof path === "string" ? path : JSON.stringify(parsed));
  return { line: `调用 ${name}: ${what.slice(0, TOOL_CALL_CHARS)}`, ab: false };
}

function blockText(c: unknown): string {
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return c
    .map((b) => (b && typeof b === "object" && typeof (b as any).text === "string" ? (b as any).text : typeof b === "string" ? b : ""))
    .filter(Boolean)
    .join("\n");
}

class Builder {
  turns: Turn[] = [];
  stripped = 0;
  abCalls = new Set<string>();
  push(anchor: string, role: TurnRole, parts: string[], ts?: unknown): void {
    const joined = parts.filter(Boolean).join("\n");
    const s = stripInjected(joined);
    this.stripped += s.stripped;
    const at = typeof ts === "string" && Number.isFinite(Date.parse(ts)) ? new Date(ts).toISOString() : undefined;
    if (s.text) this.turns.push({ anchor, role, text: s.text, ...(at ? { ts: at } : {}) });
  }
  call(id: unknown, name: string, input: unknown): string {
    const c = callLine(name, input);
    if (c.ab) {
      this.stripped++;
      if (typeof id === "string") this.abCalls.add(id);
    }
    return c.line;
  }
  output(id: unknown, output: string, isError: boolean): string {
    if (typeof id === "string" && this.abCalls.has(id)) {
      this.stripped++;
      return "";
    }
    if (/<agentbrain/.test(output)) {
      this.stripped++;
      return "";
    }
    return compressOutput(output, isError);
  }
}

function cwdOf(e: any): string | null {
  if (typeof e?.cwd === "string") return e.cwd;
  if (typeof e?.payload?.cwd === "string") return e.payload.cwd;
  return null;
}

function readClaude(lines: any[], b: Builder): void {
  for (const e of lines) {
    if ((e.type !== "user" && e.type !== "assistant") || !e.uuid || e.isMeta || e.isSidechain) continue;
    const content = e.message?.content;
    if (typeof content === "string") {
      b.push(e.uuid, e.type, [content], e.timestamp);
      continue;
    }
    if (!Array.isArray(content)) continue;
    const parts: string[] = [];
    let tool = false;
    for (const c of content) {
      if (!c || typeof c !== "object") continue;
      if (c.type === "text" && typeof c.text === "string") parts.push(c.text);
      else if (c.type === "tool_use") parts.push(b.call(c.id, String(c.name ?? "tool"), c.input));
      else if (c.type === "tool_result") {
        tool = true;
        parts.push(b.output(c.tool_use_id, blockText(c.content), c.is_error === true));
      }
    }
    b.push(e.uuid, tool ? "tool" : e.type, parts, e.timestamp);
  }
}

function readCodex(lines: any[], b: Builder): void {
  lines.forEach((e, i) => {
    if (e.type !== "response_item" || !e.payload) return;
    const anchor = typeof e.ordinal === "number" ? String(e.ordinal) : `L${i}`;
    const p = e.payload;
    if (p.type === "message") {
      if (p.role !== "user" && p.role !== "assistant") return;
      const texts = (Array.isArray(p.content) ? p.content : []).map((c: any) => (typeof c?.text === "string" ? c.text : "")).filter(Boolean);
      const kept = p.role === "user" ? texts.filter((t: string) => !CODEX_INJECTED.some((m) => t.trimStart().startsWith(m))) : texts;
      b.stripped += texts.length - kept.length;
      b.push(anchor, p.role, kept, e.timestamp);
    } else if (p.type === "function_call" || p.type === "custom_tool_call" || p.type === "local_shell_call") {
      b.push(anchor, "assistant", [b.call(p.call_id, String(p.name ?? "shell"), p.arguments ?? p.input ?? p.action)], e.timestamp);
    } else if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
      const out = typeof p.output === "string" ? p.output : JSON.stringify(p.output ?? "");
      b.push(anchor, "tool", [b.output(p.call_id, out, false)], e.timestamp);
    }
  });
}

/** Pi 是一棵树：从最后一条记录沿 parentId 回到根，就是当前分支。 */
function readPi(lines: any[], b: Builder): void {
  const byId = new Map<string, any>();
  let leaf: any = null;
  for (const e of lines) {
    if (typeof e.id !== "string") continue;
    byId.set(e.id, e);
    leaf = e;
  }
  const chain: any[] = [];
  const seen = new Set<string>();
  for (let cur = leaf; cur && !seen.has(cur.id); cur = cur.parentId ? byId.get(cur.parentId) : null) {
    seen.add(cur.id);
    chain.push(cur);
  }
  chain.reverse();
  for (const e of chain) {
    if (e.type !== "message" || !e.message) continue;
    const m = e.message;
    if (m.role === "user") b.push(e.id, "user", [blockText(m.content)], e.timestamp);
    else if (m.role === "assistant") {
      const content = Array.isArray(m.content) ? m.content : [m.content];
      const parts = content.map((c: any) => {
        if (typeof c === "string") return c;
        if (c?.type === "text") return String(c.text ?? "");
        if (c?.type === "toolCall") return b.call(c.id, String(c.name ?? "tool"), c.arguments);
        return "";
      });
      b.push(e.id, "assistant", parts, e.timestamp);
    } else if (m.role === "toolResult") {
      b.push(e.id, "tool", [b.output(m.toolCallId, blockText(m.content), m.isError === true)], e.timestamp);
    }
  }
}

/** 文件读不了时抛错，由调用方记为 source_unavailable。 */
export function cleanTranscript(host: Host, file: string): Cleaned {
  const lines = linesOf(file) as any[];
  const b = new Builder();
  if (host === "claude") readClaude(lines, b);
  else if (host === "codex") readCodex(lines, b);
  else readPi(lines, b);
  let cwd: string | null = null;
  for (const e of lines) {
    cwd = cwdOf(e);
    if (cwd) break;
  }
  return { turns: b.turns, stripped: b.stripped, cwd, subagent: host === "codex" && isCodexSubagent(lines) };
}
