/**
 * Pi 扩展状态栏逻辑（§11.7）：出错与没命中分开、0 段隐藏、刷新失败保留旧值、子代理不设状态。
 * 运行：node --test src/pi-status.test.ts（ab 用假 runner，不起子进程）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { realpathSync } from "node:fs";

type R = { ok: true; out: string } | { ok: false; reason: "timeout" | "missing" | "exit" };
const extPath = join(import.meta.dirname, "../integrations/pi/agentbrain-recall.ts");
const mod = (await import(extPath)) as {
  createExtension(run: (a: string[], i: object, t: number, cwd?: string) => Promise<R>): (pi: unknown) => void;
  renderStatus(r: unknown, t: unknown): string;
  makeExecRunner(cmd: [string, string[]]): (a: string[], i: object, t: number, cwd?: string) => Promise<R>;
};

function harness(script: (args: string[], input: object, timeout: number) => R | Promise<R>, sessionFile = "/tmp/s.jsonl") {
  const handlers = new Map<string, (e: unknown, ctx: unknown) => Promise<unknown>>();
  const commands = new Map<string, { handler(a: string, ctx: unknown): Promise<void> }>();
  const calls: { args: string[]; input: object; timeout: number; cwd?: string }[] = [];
  mod.createExtension(async (args, input, timeout, cwd?: string) => {
    calls.push({ args, input, timeout, cwd });
    return script(args, input, timeout);
  })({ on: (n: string, h: never) => handlers.set(n, h), registerCommand: (n: string, c: never) => commands.set(n, c) });
  const statuses: string[] = [];
  const notes: [string, string | undefined][] = [];
  const ctx = {
    sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => "sid" },
    ui: { setStatus: (_k: string, t: string) => statuses.push(t), notify: (m: string, t?: string) => notes.push([m, t]) },
  };
  const tick = () => new Promise((r) => setImmediate(r));
  return { handlers, commands, calls, statuses, notes, ctx, tick };
}

const hookOut = () => JSON.stringify({ hookSpecificOutput: { additionalContext: "<agentbrain-recall>\n- [abcd1234] 坑: x\n</agentbrain-recall>" } });

test("renderStatus：0 段不显示，出错显示 ⚠ 文字", () => {
  assert.equal(mod.renderStatus(null, null), "🧠 ab");
  assert.equal(mod.renderStatus(null, { review: 0, work_failed: 0 }), "🧠 ab");
  assert.equal(mod.renderStatus(null, { review: 12, work_failed: 0 }), "🧠 ab · 待确认 12");
  assert.equal(mod.renderStatus(null, { review: 12, work_failed: 3 }), "🧠 ab · 待确认 12 · ⚠ 抽取失败 3");
  assert.equal(mod.renderStatus({ error: "timeout" }, { review: 1, work_failed: 0 }), "🧠 ab ⚠ 召回超时 · 待确认 1");
  assert.equal(mod.renderStatus({ error: "missing" }, null), "⚠ ab 不可用");
});

test("召回：成功注入显示 🧠 ab、空输出正常、超时与出错分开且不注入", async () => {
  let mode: "hit" | "miss" | "timeout" | "exit" | "garbage" = "hit";
  const h = harness((args) => {
    if (args[0] !== "recall") return { ok: true, out: "" };
    if (mode === "hit") return { ok: true, out: hookOut() };
    if (mode === "miss") return { ok: true, out: "" };
    if (mode === "garbage") return { ok: true, out: "not json" };
    return { ok: false, reason: mode };
  });
  const start = h.handlers.get("before_agent_start")!;
  const hit = (await start({ prompt: "q" }, h.ctx)) as { message: { content: string; display: boolean } };
  assert.match(hit.message.content, /abcd1234/);
  assert.equal(hit.message.display, false);
  assert.equal(h.statuses.at(-1), "🧠 ab");
  mode = "miss";
  assert.equal(await start({ prompt: "q" }, h.ctx), undefined);
  assert.equal(h.statuses.at(-1), "🧠 ab");
  mode = "timeout";
  assert.equal(await start({ prompt: "q" }, h.ctx), undefined);
  assert.equal(h.statuses.at(-1), "🧠 ab ⚠ 召回超时");
  mode = "exit";
  await start({ prompt: "q" }, h.ctx);
  assert.equal(h.statuses.at(-1), "🧠 ab ⚠ 召回出错");
  mode = "garbage";
  assert.equal(await start({ prompt: "q" }, h.ctx), undefined);
  assert.equal(h.statuses.at(-1), "🧠 ab ⚠ 召回出错");
});

test("待办数：session_start 和 agent_end 后台刷新，3 秒超时，失败保留旧值，不阻塞事件", async () => {
  let todo: R = { ok: true, out: JSON.stringify({ review: 12, work_failed: 3 }) };
  let release: () => void = () => {};
  let hold = false;
  const h = harness((args, _i, timeout) => {
    if (args[0] === "status") {
      assert.deepEqual(args, ["status", "--line"]);
      assert.equal(timeout, 3000);
      if (hold) return new Promise<R>((r) => (release = () => r(todo)));
      return todo;
    }
    if (args[0] === "recall") return { ok: true, out: hookOut() };
    return { ok: true, out: "" };
  });
  await h.handlers.get("session_start")!({}, h.ctx);
  await h.tick();
  assert.equal(h.statuses.at(-1), "🧠 ab · 待确认 12 · ⚠ 抽取失败 3");
  await h.handlers.get("before_agent_start")!({ prompt: "q" }, h.ctx);
  assert.equal(h.statuses.at(-1), "🧠 ab · 待确认 12 · ⚠ 抽取失败 3");
  todo = { ok: false, reason: "timeout" };
  await h.handlers.get("agent_end")!({}, h.ctx);
  await h.tick();
  assert.equal(h.statuses.at(-1), "🧠 ab · 待确认 12 · ⚠ 抽取失败 3", "超时保留旧值");
  hold = true;
  todo = { ok: true, out: JSON.stringify({ review: 0, work_failed: 0 }) };
  await h.handlers.get("agent_end")!({}, h.ctx); // 不等 ab 返回就结束
  assert.equal(h.statuses.at(-1), "🧠 ab · 待确认 12 · ⚠ 抽取失败 3");
  release();
  await h.tick();
  assert.equal(h.statuses.at(-1), "🧠 ab");
});

test("子代理（inMemory 会话）不设状态，也不跑 status --line", async () => {
  const h = harness((args) => (args[0] === "recall" ? { ok: true, out: hookOut() } : { ok: true, out: JSON.stringify({ review: 5, work_failed: 0 }) }), "");
  await h.handlers.get("session_start")!({}, h.ctx);
  await h.handlers.get("before_agent_start")!({ prompt: "q" }, h.ctx);
  await h.handlers.get("agent_end")!({}, h.ctx);
  await h.tick();
  assert.deepEqual(h.statuses, []);
  assert.equal(h.calls.some((c) => c.args[0] === "status"), false);
});

test("/ab：成功时弹出当前状态 + ab status 全文，失败时报错误原因", async () => {
  let st: R = { ok: true, out: "当前项目: alpha\n到期待复审: 1\n" };
  const h = harness((args) => (args[0] === "status" && args.length === 1 ? st : args[0] === "status" ? { ok: true, out: JSON.stringify({ review: 1, work_failed: 0 }) } : { ok: true, out: "" }));
  await h.commands.get("ab")!.handler("", h.ctx);
  assert.deepEqual(h.notes.at(-1), ["🧠 ab\n\n当前项目: alpha\n到期待复审: 1", "info"]);
  st = { ok: false, reason: "missing" };
  await h.commands.get("ab")!.handler("", h.ctx);
  assert.deepEqual(h.notes.at(-1), ["ab 不可用：找不到 ab 命令", "error"]);
});

test("execRunner：真起子进程，区分 ab 不存在、超时、非零退出，并在指定 cwd 运行", async () => {
  const missing = mod.makeExecRunner(["/nonexistent/ab-xyz", []]);
  assert.deepEqual(await missing(["status"], {}, 1000), { ok: false, reason: "missing" });
  const slow = mod.makeExecRunner([process.execPath, ["-e", "setTimeout(()=>{},5000)"]]);
  assert.deepEqual(await slow([], {}, 200), { ok: false, reason: "timeout" });
  const fail = mod.makeExecRunner([process.execPath, ["-e", "process.exit(3)"]]);
  assert.deepEqual(await fail([], {}, 2000), { ok: false, reason: "exit" });
  const big = mod.makeExecRunner([process.execPath, ["-e", "process.stdout.write('x'.repeat(2*1024*1024))"]]);
  assert.deepEqual(await big([], {}, 5000), { ok: false, reason: "exit" }, "输出超限不算超时");
  const echo = mod.makeExecRunner([process.execPath, ["-e", "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(process.cwd()+'|'+s))"]]);
  assert.deepEqual(await echo([], { a: 1 }, 2000, "/tmp"), { ok: true, out: `${realpathSync("/tmp")}|{"a":1}` });
});

test("runner 抛错或 reject 时按出错处理，不让这一轮失败", async () => {
  const h = harness(() => {
    throw new Error("boom");
  });
  assert.equal(await h.handlers.get("before_agent_start")!({ prompt: "q" }, h.ctx), undefined);
  assert.equal(h.statuses.at(-1), "🧠 ab ⚠ 召回出错");
  await h.handlers.get("agent_end")!({}, h.ctx);
  await h.tick();
});

test("扩展发起的 custom 轮次不召回、状态保持；cwd 用会话的 ctx.cwd", async () => {
  let out = hookOut();
  const h = harness((args) => (args[0] === "recall" ? { ok: true, out } : { ok: true, out: "" }));
  (h.ctx as Record<string, unknown>).cwd = "/session/dir";
  await h.handlers.get("before_agent_start")!({ messageType: "user", prompt: "q" }, h.ctx);
  assert.equal(h.statuses.at(-1), "🧠 ab");
  const recallCall = h.calls.find((c) => c.args[0] === "recall")!;
  assert.equal((recallCall.input as { cwd: string }).cwd, "/session/dir");
  assert.equal(recallCall.cwd, "/session/dir");
  const n = h.calls.length;
  assert.equal(await h.handlers.get("before_agent_start")!({ messageType: "custom", message: {} }, h.ctx), undefined);
  assert.equal(h.calls.filter((c) => c.args[0] === "recall").length, 1, "custom 轮次不召回");
  assert.ok(h.calls.length > n, "但照常登记会话");
  assert.equal(h.statuses.at(-1), "🧠 ab");
  out = JSON.stringify({ hookSpecificOutput: { additionalContext: "<agentbrain-recall>\n- [abcd1234] 坑: x\n</agentbrain-recall>" } });
  const res = (await h.handlers.get("before_agent_start")!({ prompt: "q" }, h.ctx)) as { message: { content: string } };
  assert.match(res.message.content, /abcd1234/);
  assert.equal(h.statuses.at(-1), "🧠 ab");
});
