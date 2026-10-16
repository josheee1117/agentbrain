/**
 * Pi 接线：每轮召回（before_agent_start）+ 切片 3 会话登记（before_agent_start / session_shutdown）
 * + 话题结束触发（§8.6）：session_before_compact 时登记一个话题边界（ab 的开关关着时 ab 什么都不做）。
 * 只调用 ab，不读记忆库。文件名沿用切片 2，已有的符号链接不用改。
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import type { BeforeAgentStartEventResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";

const TIMEOUT_MS = 5000;
const SHUTDOWN_TIMEOUT_MS = 3000;
// 宿主 PATH 不一定有 ab 和 Node ≥ 24（integrations/README.md）。本机装法存在时用绝对路径，否则退回 PATH。
const NODE = "/opt/homebrew/bin/node";
const AB = "/Users/hejiayuan/.local/bin/ab";
const CMD: [string, string[]] = existsSync(NODE) && existsSync(AB) ? [NODE, [AB]] : ["ab", []];

/** Pi 的会话管理器。getSessionFile 为空即 inMemory 会话（子代理），按 ephemeral 登记（§9.5）。 */
type SessionCtx = { sessionManager?: { getSessionFile?(): string | undefined; getSessionId?(): string | undefined } };

function ab(args: string[], input: object, timeout: number): Promise<string> {
  return new Promise((resolve) => {
    const child = execFile(CMD[0], [...CMD[1], ...args], { timeout, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      resolve(err ? "" : stdout);
    });
    child.stdin?.end(JSON.stringify(input));
  });
}

function capture(event: "UserPromptSubmit" | "SessionEnd" | "PreCompact", ctx: unknown, timeout: number): Promise<string> {
  const sm = (ctx as SessionCtx | undefined)?.sessionManager;
  const file = sm?.getSessionFile?.();
  return ab(["capture", "--hook", "--host", "pi"], {
    session_id: sm?.getSessionId?.() ?? null,
    transcript_path: file ?? null,
    ephemeral: !file,
    cwd: process.cwd(),
    hook_event_name: event,
  }, timeout);
}

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (e, ctx): Promise<BeforeAgentStartEventResult | undefined> => {
    void capture("UserPromptSubmit", ctx, TIMEOUT_MS);
    try {
      // 带上 transcript_path：ab 据此认出被委派的 worker 会话，按子代理规矩召回（§21 2026-10-14）
      const file = (ctx as SessionCtx | undefined)?.sessionManager?.getSessionFile?.() ?? null;
      const raw = await ab(["recall", "--hook"], { prompt: e.prompt, cwd: process.cwd(), transcript_path: file }, TIMEOUT_MS);
      if (!raw.trim()) return undefined;
      const parsed = JSON.parse(raw) as { hookSpecificOutput?: { additionalContext?: unknown } };
      const content = parsed.hookSpecificOutput?.additionalContext;
      if (typeof content !== "string" || !content) return undefined;
      return { message: { customType: "agentbrain-recall", content, display: false } };
    } catch {
      return undefined;
    }
  });
  pi.on("session_shutdown", async (_e, ctx) => {
    await capture("SessionEnd", ctx, SHUTDOWN_TIMEOUT_MS);
  });
  // 只登记、拉起分离的 ab work，不等它，也不返回任何东西（不取消、不改压缩）
  pi.on("session_before_compact", async (_e, ctx) => {
    void capture("PreCompact", ctx, TIMEOUT_MS);
    return undefined;
  });
}
