import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
const { default: plugin } = await import(join(import.meta.dirname, "../integrations/opencode/agentbrain-v2.js"));

async function harness(run: (args: string[], input: any) => Promise<string>, parentID?: string) {
  const hooks = new Map<string, (input: any) => Promise<void>>();
  await plugin.setup({
    options: { run }, location: { directory: "/project" },
    event: { subscribe: async function* () {} },
    session: { get: async () => ({ location: { directory: "/project" }, parentID }), hook: async (name: string, handler: any) => { hooks.set(name, handler); return () => {}; } },
    shell: { hook: async (name: string, handler: any) => { hooks.set(name, handler); return () => {}; } },
  });
  return hooks;
}
const context = (text = "用户原话") => ({ sessionID: "ses_one", system: [] as any[], messages: [{ role: "user", content: [{ type: "text", text }] }] });

for (const kind of ["hit", "miss", "error", "invalid"] as const) {
  test(`opencode v2 plugin recall ${kind}`, async () => {
    const calls: { args: string[]; input: any }[] = [];
    const hooks = await harness(async (args, input) => {
      calls.push({ args, input });
      if (args[0] !== "recall") return "";
      if (kind === "error") throw new Error("ab failed");
      if (kind === "invalid") return "not json";
      return kind === "miss" ? "" : JSON.stringify({ hookSpecificOutput: { additionalContext: "<agentbrain-recall>known pitfall</agentbrain-recall>" } });
    });
    const input = context();
    await hooks.get("context")!(input);
    assert.equal(input.system.length, kind === "hit" ? 1 : 0);
    if (kind === "hit") {
      assert.match(input.system[0].text, /<agentbrain-recall>/);
      assert.equal(input.system[0].type, "text");
    }
    assert.equal(calls.find((c) => c.args[0] === "recall")?.input.prompt, "用户原话");
    assert.equal(calls.find((c) => c.args[0] === "capture")?.input.session_id, "ses_one");
    await hooks.get("context")!(context());
    assert.equal(calls.filter((c) => c.args[0] === "recall").length, 1);
    await hooks.get("context")!(context("下一轮新消息"));
    assert.equal(calls.filter((c) => c.args[0] === "recall").length, 2);
  });
}

test("opencode v2 plugin restricts child recall and supplies shell identity", async () => {
  let input: any;
  const hooks = await harness(async (args, raw) => { if (args[0] === "recall") input = raw; return ""; }, "ses_parent");
  await hooks.get("context")!(context());
  assert.equal(input.worker, true);
  const shell = { sessionID: "ses_child", env: {} as Record<string, string> };
  await hooks.get("create.before")!(shell);
  assert.equal(shell.env.OPENCODE_SESSION_ID, "ses_child");
});
