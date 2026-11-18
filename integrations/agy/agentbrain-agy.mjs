// agentbrain 接 Antigravity CLI（agy）的钩子脚本，SessionStart、PreInvocation 和 Stop 都调它。
// agy 从 stdin 给驼峰 JSON（hookEventName、conversationId、cwd、lastUserInput …），从 stdout 读
// {"injectSteps":[{"systemMessage":{"systemMessage":"…"}}]}。任何失败都回答 {}，不挡 agy。
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const AB = process.env.AGENTBRAIN_AB || join(homedir(), ".local/bin/ab");
// pm 队列派到 agy 的任务带 PM_JOB_ID：那是被派活的子代理，只要给子代理的偏好。
const worker = !!process.env.PM_JOB_ID;

const ab = (args, cwd, input = "") => execFileSync(process.execPath, [AB, ...args], { cwd, input, encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "ignore"] }).trim();
const inject = (text) => (text ? { injectSteps: [{ systemMessage: { systemMessage: text } }] } : {});

const BRIEF_TAIL = "要查历史决定、陌生模块或可能踩过的坑时跑 ab search <关键词>、ab get <id>；与现场证据冲突时信现场。用户明确要你记某件事时才用 ab remember --confirmed。";

function brief(hook) {
  const out = ab(worker ? ["brief", "--worker"] : ["brief"], hook.cwd);
  return out ? `<agentbrain-brief>\n${out}\n${BRIEF_TAIL}\n</agentbrain-brief>` : "";
}

// PreInvocation 在每次调模型前都跑（工具循环里一轮会有很多次）；同一条用户消息只注入一次，注入的系统消息会留在对话里。
function recall(hook) {
  const prompt = hook.lastUserInput;
  if (typeof prompt !== "string" || !prompt || !hook.conversationId) return "";
  const dir = join(process.env.PLUGIN_DATA || join(tmpdir(), "agentbrain-agy"), "seen");
  const file = join(dir, createHash("sha1").update(String(hook.conversationId)).digest("hex"));
  const key = createHash("sha1").update(prompt).digest("hex");
  try { if (readFileSync(file, "utf8") === key) return ""; } catch {}
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, key);
  capture(hook, "UserPromptSubmit");
  const raw = ab(["recall", "--hook"], hook.cwd, JSON.stringify({ prompt, cwd: hook.cwd, worker }));
  const context = raw && JSON.parse(raw)?.hookSpecificOutput?.additionalContext;
  return typeof context === "string" ? context : "";
}

// 登记会话（设计 §7.7）：转成 ab capture --hook 认的 snake_case。agy 没有会话结束事件，
// Stop 且不再继续时按 SessionEnd 登记，ab 会拉起分离的 ab work --session；登记失败不影响注入。
function capture(hook, event) {
  if (!hook.conversationId) return;
  try {
    ab(["capture", "--hook", "--host", "agy"], hook.cwd, JSON.stringify({ session_id: hook.conversationId, transcript_path: hook.transcriptPath, cwd: hook.cwd, hook_event_name: event }));
  } catch {}
}

let out = {};
try {
  const hook = JSON.parse(readFileSync(0, "utf8"));
  if (!process.env.AGENTBRAIN_REVIEWER) {
    if (hook.hookEventName === "SessionStart") out = inject(brief(hook));
    if (hook.hookEventName === "PreInvocation") out = inject(recall(hook));
    if (hook.hookEventName === "Stop" && hook.continuationActive !== true) capture(hook, "SessionEnd");
  }
} catch {
  out = {};
}
process.stdout.write(JSON.stringify(out));
