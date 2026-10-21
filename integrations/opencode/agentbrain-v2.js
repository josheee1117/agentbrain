import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

const NODE = "/opt/homebrew/bin/node";
const AB = "/Users/hejiayuan/.local/bin/ab";
const CMD = existsSync(NODE) && existsSync(AB) ? [NODE, [AB]] : ["ab", []];

function exec(args, input, cwd) {
  return new Promise((resolve) => {
    try {
      const child = execFile(CMD[0], [...CMD[1], ...args], { cwd, timeout: 5000, maxBuffer: 1024 * 1024 }, (error, stdout) => resolve(error ? "" : stdout));
      child.stdin?.on("error", () => {});
      child.stdin?.end(JSON.stringify(input));
    } catch {
      resolve("");
    }
  });
}

export default {
  id: "agentbrain",
  async setup(ctx) {
    const run = ctx.options?.run ?? exec;
    const safeRun = (args, input, cwd) => Promise.resolve().then(() => run(args, input, cwd)).catch(() => "");
    const recall = new Map();
    const capture = (id, event, cwd) => safeRun(["capture", "--hook", "--host", "opencode"], {
      session_id: id,
      transcript_path: `opencode://session/${id}`,
      cwd,
      hook_event_name: event,
    }, cwd);
    const off = await ctx.session.hook("context", async (input) => {
      if (process.env.AGENTBRAIN_REVIEWER) return;
      try {
        const session = await ctx.session.get({ sessionID: input.sessionID });
        const cwd = session.location.directory;
        const user = input.messages.findLast((m) => m.role === "user" && m.content.some((p) => p.type === "text" && !p.text.startsWith("<agentbrain")));
        if (!user) return;
        const prompt = user.content.filter((p) => p.type === "text").map((p) => p.text).join("\n");
        let state = recall.get(input.sessionID);
        // 工具循环会多次请求上下文，同一条用户消息只召回一次。
        const key = JSON.stringify([user.id ?? input.messages.indexOf(user), prompt]);
        if (!state || state.key !== key) {
          void capture(input.sessionID, "UserPromptSubmit", cwd);
          const pending = safeRun(["recall", "--hook"], { prompt, cwd, transcript_path: `opencode://session/${input.sessionID}`, worker: !!session.parentID }, cwd).then((raw) => {
            try {
              const content = JSON.parse(raw)?.hookSpecificOutput?.additionalContext;
              return typeof content === "string" ? content : "";
            } catch {
              return "";
            }
          });
          state = { key, pending, cwd };
          recall.set(input.sessionID, state);
        }
        const content = await state.pending;
        if (content) input.system.push({ type: "text", text: content });
      } catch {
        // 记忆不可用时不阻止本轮对话。
      }
    });
    const offShell = await ctx.shell.hook("create.before", (input) => {
      if (input.sessionID) input.env.OPENCODE_SESSION_ID = input.sessionID;
    });
    const offCompact = await ctx.session.hook("compaction", (input) => {
      if (!process.env.AGENTBRAIN_REVIEWER) void capture(input.sessionID, "PreCompact", recall.get(input.sessionID)?.cwd ?? ctx.location.directory);
    });
    const controller = new AbortController();
    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        const id = event.data?.sessionID;
        if (event.type === "session.archived" && id && recall.has(id)) {
          const state = recall.get(id);
          recall.delete(id);
          await capture(id, "SessionEnd", state.cwd);
        }
      }
    })().catch(() => {});
    return async () => {
      controller.abort();
      await off.dispose();
      await offShell.dispose();
      await offCompact.dispose();
      if (!process.env.AGENTBRAIN_REVIEWER) await Promise.all([...recall].map(([id, state]) => capture(id, "SessionEnd", state.cwd)));
      recall.clear();
    };
  },
};
