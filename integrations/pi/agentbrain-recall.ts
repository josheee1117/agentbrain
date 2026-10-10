/**
 * Pi 每轮召回。只调用 ab，不读记忆库。
 */
import { execFile } from "node:child_process";
import type { BeforeAgentStartEventResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";

const TIMEOUT_MS = 5000;

function recall(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const child = execFile("ab", ["recall", "--hook"], { timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      resolve(err ? "" : stdout);
    });
    child.stdin?.end(JSON.stringify({ prompt, cwd: process.cwd() }));
  });
}

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (e): Promise<BeforeAgentStartEventResult | undefined> => {
    try {
      const raw = await recall(e.prompt);
      if (!raw.trim()) return undefined;
      const parsed = JSON.parse(raw) as { hookSpecificOutput?: { additionalContext?: unknown } };
      const content = parsed.hookSpecificOutput?.additionalContext;
      if (typeof content !== "string" || !content) return undefined;
      return { message: { customType: "agentbrain-recall", content, display: false } };
    } catch {
      return undefined;
    }
  });
}
