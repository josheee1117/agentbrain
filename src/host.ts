/**
 * 会话身份（设计 §7.1）：按离自己最近的宿主父进程判定 host，
 * 再取该宿主的环境变量。不能看到哪个变量就用哪个，嵌套启动会继承上层变量。
 */
import { execFileSync } from "node:child_process";
import { readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { Host } from "./store.ts";

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
};

/** chain 从最近的父进程开始。第一个命中的进程决定 host。 */
export function pickHost(chain: Proc[], env: Record<string, string | undefined>): HostHit | null {
  for (const p of chain) {
    const name = basename(p.comm);
    let host: Host | null = null;
    if (name === "claude") host = "claude";
    else if (name === "codex") host = "codex";
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

function findFile(dir: string, pred: (name: string) => boolean, depth: number): string | null {
  let ents;
  try {
    ents = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of ents) {
    if (!e.isDirectory() && pred(e.name)) return join(dir, e.name);
  }
  if (depth <= 0) return null;
  for (const e of ents) {
    if (!e.isDirectory()) continue;
    const hit = findFile(join(dir, e.name), pred, depth - 1);
    if (hit) return hit;
  }
  return null;
}

export function locateTranscript(host: Host, sessionId: string): string | null {
  const home = homedir();
  if (host === "claude") return findFile(join(home, ".claude/projects"), (n) => n === `${sessionId}.jsonl`, 2);
  if (host === "codex") return findFile(join(home, ".codex/sessions"), (n) => n.startsWith("rollout-") && n.endsWith(`-${sessionId}.jsonl`), 4);
  return findFile(join(home, ".pi/agent/sessions"), (n) => n.endsWith(`_${sessionId}.jsonl`), 2);
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
    detection: { host: hit.host, session_id: hit.session_id, transcript: transcript ? realpathSync(transcript) : null },
  };
}
