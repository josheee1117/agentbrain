/**
 * Pi 接线：每轮召回（before_agent_start）+ 切片 3 会话登记（before_agent_start / session_shutdown）
 * + 话题结束触发（§8.6）：session_before_compact 时登记一个话题边界（ab 的开关关着时 ab 什么都不做）
 * + 底部状态栏与 /ab 命令（§11.7）。
 * 只调用 ab，不读记忆库。文件名沿用切片 2，已有的符号链接不用改。
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import type { BeforeAgentStartEventResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";

const TIMEOUT_MS = 5000;
const SHUTDOWN_TIMEOUT_MS = 3000;
/** 状态栏待办数的刷新超时；超时保留上一次的值（§11.7）。 */
export const STATUS_TIMEOUT_MS = 3000;
const COMMAND_TIMEOUT_MS = 15000;
export const STATUS_KEY = "agentbrain";
// 宿主 PATH 不一定有 ab 和 Node ≥ 24（integrations/README.md）。本机装法存在时用绝对路径，否则退回 PATH。
const NODE = "/opt/homebrew/bin/node";
const AB = "/Users/hejiayuan/.local/bin/ab";
const CMD: [string, string[]] = existsSync(NODE) && existsSync(AB) ? [NODE, [AB]] : ["ab", []];

/** ab 调用结果：出错和"没输出"分开（以前出错也当空字符串，状态栏分不出没命中还是坏了）。 */
export type AbResult = { ok: true; out: string } | { ok: false; reason: "timeout" | "missing" | "exit" };
export type Runner = (args: string[], input: object, timeout: number, cwd?: string) => Promise<AbResult>;

/** execFile 的错误归类：找不到命令 / 超时被杀 / 其余（非零退出、输出超限等）。 */
export function classifyExecError(err: unknown): "timeout" | "missing" | "exit" {
  const e = err as NodeJS.ErrnoException & { killed?: boolean };
  if (e.code === "ENOENT") return "missing";
  if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return "exit"; // 输出超限也会 killed=true，不是超时
  return e.killed ? "timeout" : "exit";
}

export function makeExecRunner(cmd: [string, string[]]): Runner {
  return (args, input, timeout, cwd) =>
    new Promise((resolve) => {
      try {
        const child = execFile(cmd[0], [...cmd[1], ...args], { timeout, maxBuffer: 1024 * 1024, cwd }, (err, stdout) => {
          resolve(err ? { ok: false, reason: classifyExecError(err) } : { ok: true, out: stdout });
        });
        child.stdin?.on("error", () => {}); // 子进程没起来时写 stdin 会 EPIPE，结果以回调为准
        child.stdin?.end(JSON.stringify(input));
      } catch (err) {
        resolve({ ok: false, reason: classifyExecError(err) });
      }
    });
}

export const execRunner: Runner = makeExecRunner(CMD);

/** Pi 的会话管理器。getSessionFile 为空即 inMemory 会话（子代理），按 ephemeral 登记（§9.5）。 */
type SessionCtx = { sessionManager?: { getSessionFile?(): string | undefined; getSessionId?(): string | undefined } };
type UiCtx = { ui?: { setStatus?(key: string, text: string | undefined): void; notify?(m: string, t?: "info" | "warning" | "error"): void } };

export type RecallState = { n: number } | { error: "timeout" | "missing" | "exit" } | null;
export type Todo = { review: number; work_failed: number } | null;

/** 状态栏文字。值为 0 的段不显示；pi-cc-extensions 会剥掉颜色，所以状态只靠文字和 ⚠ 区分。 */
export function renderStatus(recall: RecallState, todo: Todo): string {
  const parts: string[] = [];
  if (recall && "error" in recall) {
    parts.push(recall.error === "missing" ? "⚠ ab 不可用" : recall.error === "timeout" ? "🧠 ab ⚠ 召回超时" : "🧠 ab ⚠ 召回出错");
  } else {
    parts.push(recall ? `🧠 ab ${recall.n}` : "🧠 ab");
  }
  if (todo?.review) parts.push(`待确认 ${todo.review}`);
  if (todo?.work_failed) parts.push(`⚠ 抽取失败 ${todo.work_failed}`);
  return parts.join(" · ");
}

function parseTodo(r: AbResult): Todo {
  if (!r.ok) return null;
  try {
    const j = JSON.parse(r.out) as { review?: unknown; work_failed?: unknown };
    if (typeof j.review !== "number" || typeof j.work_failed !== "number") return null;
    return { review: j.review, work_failed: j.work_failed };
  } catch {
    return null;
  }
}

/** 会话工作目录：Pi 的 ctx.cwd（resume 别的目录的会话时与进程 cwd 不同），没有再退回进程 cwd。 */
function cwdOf(ctx: unknown): string {
  const c = (ctx as { cwd?: unknown } | undefined)?.cwd;
  return typeof c === "string" && c ? c : process.cwd();
}

function isSubagent(ctx: unknown): boolean {
  return !(ctx as SessionCtx | undefined)?.sessionManager?.getSessionFile?.();
}

export function createExtension(raw: Runner) {
  // runner 契约是只 resolve；万一抛错或 reject，也按"出错"处理，不让宿主这一轮失败
  const run: Runner = (args, input, timeout, cwd) =>
    Promise.resolve()
      .then(() => raw(args, input, timeout, cwd))
      .catch((): AbResult => ({ ok: false, reason: "exit" }));
  return function (pi: ExtensionAPI) {
    let recallState: RecallState = null;
    let todo: Todo = null;

    const paint = (ctx: unknown) => {
      if (isSubagent(ctx)) return; // 子代理不设状态
      try {
        (ctx as UiCtx | undefined)?.ui?.setStatus?.(STATUS_KEY, renderStatus(recallState, todo));
      } catch {
        // 状态栏只是展示，失败不影响召回
      }
    };
    /** 后台刷新待办数；失败或超时保留旧值。 */
    const refreshTodo = (ctx: unknown): Promise<void> => {
      if (isSubagent(ctx)) return Promise.resolve();
      return run(["status", "--line"], {}, STATUS_TIMEOUT_MS, cwdOf(ctx)).then((r) => {
        const next = parseTodo(r);
        if (next) todo = next;
        paint(ctx);
      });
    };

    const capture = (event: "UserPromptSubmit" | "SessionEnd" | "PreCompact", ctx: unknown, timeout: number) => {
      const sm = (ctx as SessionCtx | undefined)?.sessionManager;
      const file = sm?.getSessionFile?.();
      return run(["capture", "--hook", "--host", "pi"], {
        session_id: sm?.getSessionId?.() ?? null,
        transcript_path: file ?? null,
        ephemeral: !file,
        cwd: cwdOf(ctx),
        hook_event_name: event,
      }, timeout, cwdOf(ctx));
    };

    pi.on("session_start", async (_e, ctx) => {
      paint(ctx);
      void refreshTodo(ctx);
    });
    pi.on("before_agent_start", async (e, ctx): Promise<BeforeAgentStartEventResult | undefined> => {
      void capture("UserPromptSubmit", ctx, TIMEOUT_MS);
      // 扩展用 sendMessage(triggerTurn) 发起的一轮没有用户原话：不召回，状态栏保持上一轮
      if ((e as { messageType?: string }).messageType === "custom") return undefined;
      // 带上 transcript_path：ab 据此认出被委派的 worker 会话，按子代理规矩召回（§21 2026-10-14）
      const file = (ctx as SessionCtx | undefined)?.sessionManager?.getSessionFile?.() ?? null;
      // want_count：只有 Pi 要条数，ab 只在这时往 hook JSON 里多放一个 agentbrain 字段
      const r = await run(["recall", "--hook"], { prompt: (e as { prompt?: string }).prompt, cwd: cwdOf(ctx), transcript_path: file, want_count: true }, TIMEOUT_MS, cwdOf(ctx));
      if (!r.ok) {
        recallState = { error: r.reason };
        paint(ctx);
        return undefined;
      }
      try {
        if (!r.out.trim()) {
          recallState = { n: 0 }; // 审稿子进程等不输出任何东西
          paint(ctx);
          return undefined;
        }
        const parsed = JSON.parse(r.out) as { hookSpecificOutput?: { additionalContext?: unknown }; agentbrain?: { recalled?: unknown } };
        const n = parsed.agentbrain?.recalled;
        // 旧版 ab 不认 want_count、不给条数：显示不带数字的"🧠 ab"，不冒充 0
        recallState = typeof n === "number" ? { n } : null;
        paint(ctx);
        const content = parsed.hookSpecificOutput?.additionalContext;
        if (typeof content !== "string" || !content) return undefined;
        return { message: { customType: "agentbrain-recall", content, display: false } };
      } catch {
        recallState = { error: "exit" };
        paint(ctx);
        return undefined;
      }
    });
    pi.on("agent_end", async (_e, ctx) => {
      void refreshTodo(ctx);
    });
    pi.on("session_shutdown", async (_e, ctx) => {
      await capture("SessionEnd", ctx, SHUTDOWN_TIMEOUT_MS);
    });
    // 只登记、拉起分离的 ab work，不等它，也不返回任何东西（不取消、不改压缩）
    pi.on("session_before_compact", async (_e, ctx) => {
      void capture("PreCompact", ctx, TIMEOUT_MS);
      return undefined;
    });
    pi.registerCommand("ab", {
      description: "agentbrain 状态：召回、待确认、后台抽取（ab status）",
      handler: async (_args, ctx) => {
        const ui = (ctx as UiCtx | undefined)?.ui;
        const r = await run(["status"], {}, COMMAND_TIMEOUT_MS, cwdOf(ctx));
        if (!r.ok) {
          ui?.notify?.(r.reason === "missing" ? "ab 不可用：找不到 ab 命令" : r.reason === "timeout" ? "ab status 超时" : "ab status 出错", "error");
          return;
        }
        ui?.notify?.(`${renderStatus(recallState, todo)}\n\n${r.out.trimEnd()}`, "info");
        void refreshTodo(ctx);
      },
    });
  };
}

export default createExtension(execRunner);
