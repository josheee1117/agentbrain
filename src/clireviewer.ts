/**
 * CLI 审稿后端（v3 第 2 阶段，2026-10-15 用户认可）：用各宿主自己的命令行无头跑审稿，用各自账号的额度，
 * 而不是直接调 API。claude -p / codex exec / pi -p 都从 stdin 读提示词，输出里取最后一条回复当结论 JSON。
 *
 * 防自激：审稿子进程带 AGENTBRAIN_REVIEWER=1；ab 的 hook（capture/recall）看到它就什么都不做，
 * 另外各宿主也关掉 hook/扩展/会话持久化，审稿会话不会被登记、抽取，也不会再拉起 curate。
 * 在空的临时目录里跑，不读项目的 CLAUDE.md/AGENTS.md，不给任何工具。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkFailure, parseRetryAfterMs, type Chat } from "./llm.ts";

export type CliHost = "claude" | "codex" | "pi";
export const CLI_HOSTS: readonly CliHost[] = ["claude", "codex", "pi"];
export const REVIEWER_ENV = "AGENTBRAIN_REVIEWER";

export interface CliSpec {
  host: CliHost;
  /** 宿主认的模型名/别名（claude: haiku / claude-haiku-5-5；codex: gpt-6-astra；pi: provider/id）。不写用宿主默认。 */
  model?: string;
  /** 推理强度：claude --effort、codex model_reasoning_effort、pi --thinking。 */
  effort?: string;
  /** 可执行文件，默认就是 host 名（走 PATH）。 */
  bin?: string;
  timeoutMs: number;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}
export type Runner = (cmd: string, args: string[], input: string, opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<RunResult>;

export const spawnRunner: Runner = (cmd, args, input, opts) =>
  new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let child;
    try {
      child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      return resolve({ code: 127, stdout: "", stderr: String(e), timedOut: false });
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => {
      stderr += String(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });

/** 子进程环境：标记审稿身份；去掉会让 claude 以为自己嵌在另一个 Claude Code 会话里的变量。 */
export function reviewerEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, [REVIEWER_ENV]: "1" };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  return env;
}

export function cliCommand(spec: CliSpec, system: string, user: string, dir: string): { cmd: string; args: string[]; input: string; lastFile?: string } {
  const cmd = spec.bin ?? spec.host;
  if (spec.host === "claude") {
    const args = ["-p", "--output-format", "json", "--no-session-persistence", "--tools", "", "--setting-sources", "", "--system-prompt", system];
    if (spec.model) args.push("--model", spec.model);
    if (spec.effort) args.push("--effort", spec.effort);
    return { cmd, args, input: user };
  }
  if (spec.host === "codex") {
    const lastFile = join(dir, "last.txt");
    const args = ["exec", "--ephemeral", "--skip-git-repo-check", "-C", dir, "-s", "read-only", "--ignore-rules", "--disable", "hooks", "--json", "-o", lastFile];
    if (spec.model) args.push("-m", spec.model);
    if (spec.effort) args.push("-c", `model_reasoning_effort=${spec.effort}`);
    args.push("-");
    // codex exec 没有单独的系统提示参数：标准全文放在前面，任务放后面
    return { cmd, args, input: `${system}\n\n---\n\n${user}`, lastFile };
  }
  const args = ["-p", "--no-session", "--no-tools", "--no-extensions", "--no-mcp", "--no-prompt-templates", "--system-prompt", system];
  if (spec.model) args.push("--model", spec.model);
  if (spec.effort) args.push("--thinking", spec.effort);
  return { cmd, args, input: user };
}

const LIMIT = /usage[ _]limit|rate.?limit|limit[ _]reached|hit your (?:\w+ )?limit|quota|too many requests|\b429\b|cooling down|overloaded_error/i;

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
/** 某时区在某时刻相对 UTC 的偏移（毫秒）。 */
function tzOffsetMs(at: number, tz: string): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(at)).map((x) => [x.type, x.value]));
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second)) - at;
}
/**
 * Claude Code 新格式："You've hit your weekly limit · resets Oct 17 at 1am (Asia/Singapore)"；
 * 也有不带日期的 "resets 3pm (Asia/Singapore)"。返回距重置还有多少毫秒；认不出返回 undefined。
 */
export function parseClaudeResetMs(text: string, now = Date.now()): number | undefined {
  const m = /resets\s+(?:([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?\s+at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*(?:\(([^)]+)\))?/i.exec(text);
  if (!m) return undefined;
  const tz = m[7]?.trim() || "UTC";
  try {
    tzOffsetMs(now, tz);
  } catch {
    return undefined;
  }
  let h = Number(m[4]) % 12;
  if (m[6].toLowerCase() === "pm") h += 12;
  const min = Number(m[5] ?? 0);
  const local = new Date(now + tzOffsetMs(now, tz)); // 该时区的"现在"，用 UTC 字段读
  const toUtc = (y: number, mo: number, d: number) => {
    const guess = Date.UTC(y, mo, d, h, min);
    return guess - tzOffsetMs(guess - tzOffsetMs(guess, tz), tz);
  };
  let at: number;
  if (m[1]) {
    const mo = MONTHS.indexOf(m[1].toLowerCase());
    if (mo < 0) return undefined;
    at = toUtc(m[3] ? Number(m[3]) : local.getUTCFullYear(), mo, Number(m[2]));
    if (!m[3] && at < now - 86_400_000) at = toUtc(local.getUTCFullYear() + 1, mo, Number(m[2]));
  } else {
    at = toUtc(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
    if (at <= now) at += 86_400_000;
  }
  return Math.max(0, at - now);
}

/** 额度/限流类失败 → http_429（交给 timed 的退避与 QuotaExhausted）；其余为一般失败。 */
export function cliFailure(host: CliHost, text: string): WorkFailure {
  const msg = `${host} 审稿失败：${text.trim().slice(0, 300) || "（没有输出）"}`;
  if (LIMIT.test(text)) {
    // claude 旧格式 "Claude AI usage limit reached|<epoch 秒>"
    const epoch = /limit reached\|(\d{10})/.exec(text);
    const after = epoch ? Math.max(0, Number(epoch[1]) * 1000 - Date.now()) : (parseClaudeResetMs(text) ?? parseRetryAfterMs(null, text));
    return new WorkFailure("http_429", msg, after);
  }
  return new WorkFailure("http_error", msg);
}

/** 从输出里取回复正文和 token 数。 */
export function parseCliOutput(host: CliHost, r: RunResult, last: string | null): { text: string; tokens: number; costUsd?: number } {
  if (host === "claude") {
    let o: any;
    try {
      o = JSON.parse(r.stdout);
    } catch {
      throw cliFailure(host, r.stdout || r.stderr);
    }
    if (o.is_error || typeof o.result !== "string") throw cliFailure(host, String(o.result ?? o.error ?? r.stderr ?? ""));
    const u = o.usage ?? {};
    const tokens = (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    return { text: o.result, tokens, costUsd: typeof o.total_cost_usd === "number" ? o.total_cost_usd : undefined };
  }
  if (host === "codex") {
    let tokens = 0;
    const errors: string[] = [];
    for (const line of r.stdout.split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (e.type === "turn.completed" && e.usage) tokens += (e.usage.input_tokens ?? 0) + (e.usage.output_tokens ?? 0);
        if (e.type === "turn.failed" || e.type === "error") errors.push(String(e.error?.message ?? e.message ?? ""));
      } catch {
        // 非 JSON 行忽略
      }
    }
    if (!last || !last.trim()) throw cliFailure(host, errors.join("\n") || r.stderr);
    return { text: last, tokens };
  }
  if (r.code !== 0 || !r.stdout.trim()) throw cliFailure(host, r.stderr || r.stdout);
  return { text: r.stdout, tokens: 0 };
}

/** 把一个 CLI 宿主包成 Chat：system 消息拼成系统提示，其余消息拼成用户提示。 */
export function cliChat(spec: CliSpec, run: Runner = spawnRunner): Chat {
  return async (messages) => {
    const system = messages.filter((m) => m.role === "system").map((m) => m.content ?? "").join("\n\n");
    const user = messages.filter((m) => m.role !== "system").map((m) => m.content ?? "").join("\n\n");
    const dir = mkdtempSync(join(tmpdir(), "ab-review-"));
    try {
      const c = cliCommand(spec, system, user, dir);
      const r = await run(c.cmd, c.args, c.input, { cwd: dir, env: reviewerEnv(), timeoutMs: spec.timeoutMs });
      if (r.timedOut) throw new WorkFailure("timeout", `${spec.host} 审稿超时（${spec.timeoutMs}ms）`);
      if (r.code === 127 || /ENOENT/.test(r.stderr)) throw new WorkFailure("http_error", `${spec.host} 审稿失败：找不到命令 ${c.cmd}`);
      let last: string | null = null;
      if (c.lastFile) {
        try {
          last = readFileSync(c.lastFile, "utf8");
        } catch {
          last = null;
        }
      }
      const out = parseCliOutput(spec.host, r, last);
      return { message: { role: "assistant", content: out.text }, tokens: out.tokens, costUsd: out.costUsd };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}
