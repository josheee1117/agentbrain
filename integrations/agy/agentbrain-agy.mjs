// agentbrain 接 Antigravity CLI（agy）的钩子脚本，SessionStart、PreInvocation 和 Stop 都调它。
// agy 从 stdin 给驼峰 JSON（hookEventName、conversationId、cwd、lastUserInput …），从 stdout 读
// {"injectSteps":[{"systemMessage":{"systemMessage":"…"}}]}。任何失败都回答 {}，不挡 agy。
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const AB = process.env.AGENTBRAIN_AB || join(homedir(), ".local/bin/ab");
const ab = (args, hook, env, input = "") => {
  try {
    return execFileSync(process.execPath, [AB, ...args], { cwd: hook.cwd, env, input, encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "ignore"] }).trim();
  } catch { return ""; }
};
const inject = (text) => (text ? { injectSteps: [{ systemMessage: { systemMessage: text } }] } : {});
const readMarker = (file) => existsSync(file) ? readFileSync(file, "utf8") : "";

const BRIEF_TAIL = "要查历史决定、陌生模块或可能踩过的坑时跑 ab search <关键词>、ab get <id>；与现场证据冲突时信现场。用户明确要你记某件事时才用 ab remember --confirmed。";

function appRoot(hook) {
  const fromTranscript = typeof hook.transcriptPath === "string" && /^(.*)\/brain\/[^/]+\/\.system_generated\/logs\/transcript(?:_full)?\.jsonl$/.exec(hook.transcriptPath)?.[1];
  const acp = process.env.GEMINI_HOME && join(process.env.GEMINI_HOME, "antigravity-acp");
  const root = fromTranscript || process.env.ANTIGRAVITY_APP_DATA_DIR || (acp && existsSync(acp) ? acp : "");
  return root && existsSync(root) ? realpathSync(root) : root;
}

// prompt seen 只控制 capture 和偏好；brief pending 可以在同一轮工具循环中重试。
function recall(hook, root, env) {
  const prompt = hook.lastUserInput;
  if (typeof prompt !== "string" || !prompt || !hook.conversationId) return { text: "" };
  const data = process.env.PLUGIN_DATA || join(tmpdir(), "agentbrain-agy");
  const sessionKey = createHash("sha1").update(root + "\0" + hook.conversationId).digest("hex");
  const seenFile = join(data, "seen", sessionKey), briefFile = join(data, "briefs", sessionKey);
  const promptKey = createHash("sha1").update(prompt).digest("hex");
  const isNewPrompt = readMarker(seenFile) !== promptKey;
  const isDone = readMarker(briefFile) === "done";
  if (!isNewPrompt && isDone) return { text: "" };
  if (!isDone) {
    mkdirSync(join(data, "briefs"), { recursive: true });
    writeFileSync(briefFile, "pending");
  }
  if (isNewPrompt) {
    mkdirSync(join(data, "seen"), { recursive: true });
    writeFileSync(seenFile, promptKey);
    capture(hook, "UserPromptSubmit", env);
  }
  const raw = ab(["recall", "--hook"], hook, env, JSON.stringify({ prompt, cwd: hook.cwd, session_id: hook.conversationId, transcript_path: hook.transcriptPath, want_session_state: true }));
  const reply = raw ? JSON.parse(raw) : null;
  const session = reply?.agentbrain?.session;
  const additionalContext = isNewPrompt && reply?.hookSpecificOutput?.additionalContext;
  const context = typeof additionalContext === "string" ? additionalContext : "";
  let briefText = "";
  if (session?.brief_present === true) writeFileSync(briefFile, "done");
  else if (!isDone && typeof session?.worker === "boolean") {
    const out = ab(session.worker ? ["brief", "--worker"] : ["brief"], hook, env);
    if (out) briefText = `<agentbrain-brief>\n${out}\n${BRIEF_TAIL}\n</agentbrain-brief>`;
  }
  return { text: [briefText, context].filter(Boolean).join("\n"), doneFile: briefText ? briefFile : null };
}

// Stop 且不再继续时按 SessionEnd 登记，ab 会拉起分离的 ab work --session。
function capture(hook, event, env) {
  if (!hook.conversationId) return;
  ab(["capture", "--hook", "--host", "agy"], hook, env, JSON.stringify({ session_id: hook.conversationId, transcript_path: hook.transcriptPath, cwd: hook.cwd, hook_event_name: event }));
}

let result = { text: "" };
try {
  const hook = JSON.parse(readFileSync(0, "utf8"));
  if (!process.env.AGENTBRAIN_REVIEWER && (hook.hookEventName === "PreInvocation" || (hook.hookEventName === "Stop" && hook.continuationActive !== true))) {
    const root = appRoot(hook);
    const env = { ...process.env, ANTIGRAVITY_CONVERSATION_ID: hook.conversationId, ...(root ? { ANTIGRAVITY_APP_DATA_DIR: root } : {}) };
    if (hook.hookEventName === "PreInvocation") result = recall(hook, root, env);
    else capture(hook, "SessionEnd", env);
  }
} catch {
  result = { text: "" };
}
// 同步输出成功后才提交 done，避免输出失败却提前阻止下一次注入。
writeFileSync(1, JSON.stringify(inject(result.text)));
if (result.doneFile) {
  try { writeFileSync(result.doneFile, "done"); } catch {}
}
