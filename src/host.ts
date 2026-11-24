/**
 * 会话身份（设计 §7.1）：按离自己最近的宿主父进程判定 host，
 * 再取该宿主的环境变量。不能看到哪个变量就用哪个，嵌套启动会继承上层变量。
 */
import { execFileSync } from "node:child_process";
import { readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { Host } from "./l2.ts";
import { opencodeRef, opencodeSession } from "./opencode.ts";
import { agyLocate } from "./agy.ts";
import { resolveTranscript } from "./transcript-file.ts";

const MAX_ANCESTORS = 20;

export interface Proc {
  comm: string;
  args: string;
}

export interface HostHit {
  host: Host;
  session_id: string | null;
}

const SESSION_ENV: Record<Host, string> = {
  claude: "CLAUDE_CODE_SESSION_ID",
  codex: "CODEX_THREAD_ID",
  pi: "PI_SESSION_ID",
  opencode: "OPENCODE_SESSION_ID",
  agy: "ANTIGRAVITY_CONVERSATION_ID",
};

/** chain 从最近的父进程开始。第一个命中的进程决定 host。 */
export function pickHost(chain: Proc[], env: Record<string, string | undefined>): HostHit | null {
  for (const p of chain) {
    const name = basename(p.comm);
    let host: Host | null = null;
    if (name === "claude") host = "claude";
    else if (name === "codex") host = "codex";
    else if (name === "opencode") host = "opencode";
    else if (name === "agy" || name === "Antigravity" || (name === "language_server" && (p.comm.includes("/Antigravity.app/") || /(?:^|\s)--override_ide_name(?:=|\s+)antigravity(?:\s|$)/.test(p.args)))) host = "agy";
    else if (name === "pi" || (name === "node" && p.args.includes("pi-coding-agent"))) host = "pi";
    if (host) return { host, session_id: env[SESSION_ENV[host]] || null };
  }
  return null;
}

/** 解析 `ps -A -o pid=,ppid=,<col>=` 的输出。<col> 放最后，取整行剩余部分，路径带空格也不会切坏。 */
export function parsePs(out: string): Map<number, { ppid: number; rest: string }> {
  const m = new Map<number, { ppid: number; rest: string }>();
  for (const line of out.split("\n")) {
    const r = /^\s*(\d+)\s+(\d+)\s(.*)$/.exec(line);
    if (r) m.set(Number(r[1]), { ppid: Number(r[2]), rest: r[3].trim() });
  }
  return m;
}

/** ps 非零退出或调用失败时抛错，原因带出来；空输出是合法的（没有祖先）。 */
export function ancestors(startPid: number): Proc[] {
  const ps = (col: string) =>
    parsePs(execFileSync("ps", ["-A", "-o", `pid=,ppid=,${col}=`], { encoding: "utf8" }));
  let comms, args;
  try {
    comms = ps("comm");
    args = ps("args");
  } catch (e) {
    const err = e as { status?: number; stderr?: string; message?: string };
    const why = (err.stderr || err.message || String(e)).trim().split("\n")[0];
    throw new Error(err.status ? `ps 退出 ${err.status}: ${why}` : why);
  }
  const chain: Proc[] = [];
  let pid = startPid;
  for (let i = 0; i < MAX_ANCESTORS && pid > 1; i++) {
    const c = comms.get(pid);
    if (!c) break;
    chain.push({ comm: c.rest, args: args.get(pid)?.rest ?? "" });
    pid = c.ppid;
  }
  return chain;
}

export function locateTranscript(host: Host, sessionId: string): string | null {
  if (host === "opencode") {
    const ref = opencodeRef(sessionId);
    try {
      return ref && opencodeSession(ref) ? ref : null;
    } catch {
      return null;
    }
  }
  if (host === "agy") return agyLocate(sessionId, { appDataDir: process.env.ANTIGRAVITY_APP_DATA_DIR, geminiHome: process.env.GEMINI_HOME }).path;
  const home = homedir();
  // 先 sessions 后 archived_sessions；每个目录先精确找 `.jsonl`，再找 `.jsonl.zst`，不靠目录遍历顺序（§7.6）
  if (host === "claude") return locateIn(join(home, ".claude/projects"), (n) => n === `${sessionId}.jsonl`, 2);
  if (host === "codex") {
    for (const root of [join(home, ".codex/sessions"), join(home, ".codex/archived_sessions")]) {
      const hit = locateIn(root, (n) => n.startsWith("rollout-") && (n.endsWith(`-${sessionId}.jsonl`) || n.endsWith(`-${sessionId}.jsonl.zst`)), 4);
      if (hit) return hit;
    }
    return null;
  }
  return locateIn(join(home, ".pi/agent/sessions"), (n) => n.endsWith(`_${sessionId}.jsonl`), 2);
}

/** 在目录树里先精确找 `.jsonl`，再找 `.jsonl.zst`；两个都返回路径（resolveTranscript 按 Codex 顺序先试未压缩那份）。 */
function locateIn(dir: string, match: (name: string) => boolean, depth: number): string | null {
  let ents;
  try {
    ents = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const names = ents.filter((e) => !e.isDirectory()).map((e) => e.name);
  const plain = names.filter(match).filter((n) => n.endsWith(".jsonl")).map((n) => join(dir, n));
  if (plain.length) return resolveTranscript(plain[0]);
  const zst = names.filter(match).filter((n) => n.endsWith(".jsonl.zst")).map((n) => join(dir, n));
  if (zst.length) return resolveTranscript(zst[0]);
  if (depth <= 0) return null;
  for (const e of ents) {
    if (!e.isDirectory()) continue;
    const hit = locateIn(join(dir, e.name), match, depth - 1);
    if (hit) return hit;
  }
  return null;
}

export interface Detection {
  host: Host;
  session_id: string | null;
  transcript: string | null;
}

export type HostResult =
  | { ok: true; detection: Detection | null }
  | { ok: false; error: string };

/** 从当前进程的父进程起沿链判定宿主。找到宿主 / 没有宿主祖先 / 检测失败（带原因）三种结果。 */
export function detectHost(env: Record<string, string | undefined> = process.env): HostResult {
  let chain: Proc[];
  try {
    chain = ancestors(process.ppid);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const hit = pickHost(chain, env);
  if (!hit) return { ok: true, detection: null };
  const transcript = hit.session_id ? locateTranscript(hit.host, hit.session_id) : null;
  return {
    ok: true,
    detection: { host: hit.host, session_id: hit.session_id, transcript: transcript ? (hit.host === "opencode" || hit.host === "agy" ? transcript : realpathSync(transcript)) : null },
  };
}
