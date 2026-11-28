/**
 * §11.8 端到端：真实 CLI 子进程、临时 AB_HOME 与临时 HOME，不碰真实 ~/.agentbrain 和宿主指令文件。
 * 召回 hook → inject_log/recall_runs；ab setup --cite on → 召回块带指令、宿主文件写托管块；
 * 助手回复写 ab-used → ab view 扫到引用并显示在看板数据里。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "ab-viewer-")));
const home = join(dir, "store");
const fakeHome = join(dir, "fakehome");
const repos = join(dir, "pm/repos");
mkdirSync(repos, { recursive: true });
const bin = join(dir, "bin");
mkdirSync(bin);
writeFileSync(join(bin, "ps"), `#!/bin/sh\necho '${process.pid} 1 pi'\n`);
chmodSync(join(bin, "ps"), 0o755);
const SESSION = "viewer-e2e-session";
const tdir = join(fakeHome, ".pi/agent/sessions/x");
mkdirSync(tdir, { recursive: true });
const transcript = join(tdir, `2026-10-21T00-00-00-000Z_${SESSION}.jsonl`);
const line = (o: unknown) => JSON.stringify(o) + "\n";
writeFileSync(transcript, line({ type: "message", id: "u1", parentId: null, timestamp: "2026-10-21T00:00:00.000Z", message: { role: "user", content: "全局锁怎么用" } }));
const alpha = join(dir, "alpha");
execFileSync("git", ["init", "-q", alpha]);
writeFileSync(join(repos, "alpha.md"), `- 路径：\`${alpha}\`\n`);
const beta = join(dir, "beta");
execFileSync("git", ["init", "-q", beta]);
writeFileSync(join(repos, "beta.md"), `- 路径：\`${beta}\`\n`);
const CLI = join(import.meta.dirname, "cli.ts");

function ab(args: string[], cwd = alpha, input?: string): string {
  return execFileSync("node", [CLI, ...args], {
    cwd,
    input,
    encoding: "utf8",
    env: { ...process.env, AB_HOME: home, AB_REGISTRY: repos, HOME: fakeHome, AB_HOST_HOME: fakeHome, PATH: `${bin}:${process.env.PATH}`, CLAUDE_CODE_SESSION_ID: "", CODEX_THREAD_ID: "", PI_SESSION_ID: SESSION },
  });
}
const hook = () => JSON.parse(ab(["recall", "--hook"], alpha, JSON.stringify({ prompt: "alpha 召回 全局锁", cwd: alpha, transcript_path: transcript }))).hookSpecificOutput.additionalContext as string;
const db = () => new DatabaseSync(join(home, "store.db"), { readOnly: true });
const dataOf = (file: string) => JSON.parse(/<script id="data" type="application\/json">([\s\S]*?)<\/script>/.exec(readFileSync(file, "utf8"))![1]);

test("召回记录、引用开关、ab-used 扫描、看板数据，一条链走通", () => {
  const id = /\[([0-9a-f]{8})\]/.exec(ab(["remember", "--confirmed", "--kind", "pitfall", "--text", "别在 alpha 召回里用全局锁，凭据从环境变量读", "--summary", "锁"]))![1];
  ab(["remember", "--confirmed", "--kind", "rule", "--text", "beta 的全局锁规则", "--summary", "beta"], beta);

  // 1. 开关默认关：常规提问保持静默（无泛化提醒噪音），不自动检索；照常记录 recall_runs
  const off = hook();
  assert.equal(off, "");
  assert.doesNotMatch(off, /记忆：|ab-used/);
  assert.doesNotMatch(off, new RegExp(`\\[${id}\\] 坑:`));
  let d = db();
  assert.deepEqual({ ...(d.prepare("SELECT host,outcome,n_hits,cite FROM recall_runs").get() as any) }, { host: "pi", outcome: "nohit", n_hits: 0, cite: 0 });
  d.close();
  // 模型主动 search 并交付
  ab(["search", "全局锁"], alpha);
  // 模型回答了这一轮（没有回复的回合会被当成模型调用失败，不进统计）
  appendFileSync(transcript, line({ type: "message", id: "a0", parentId: "u1", timestamp: new Date().toISOString(),
    message: { role: "assistant", provider: "cpa", model: "glm-5.3", content: [{ type: "text", text: "先按账户加锁。" }] } }));

  // 2. 打开开关：召回块末尾多一行指令，宿主指令文件不动
  const setup = ab(["setup", "--cite", "on"]);
  assert.match(setup, /引用指令：开/);
  assert.equal(existsSync(join(fakeHome, ".config/opencode/AGENTS.md")), false);
  // 钩子按用户轮归属：新一轮才带开关，上一轮的回复不会借到它
  appendFileSync(transcript, line({ type: "message", id: "u2", parentId: "a1", timestamp: new Date().toISOString(),
    message: { role: "user", content: "换成按账户的锁" } }));
  const on = hook();
  assert.match(on, /记忆：简短标题 \(8位id\)；…/);

  // 3. 助手回复引用了这条（标题贴切）和一个编造的 id
  appendFileSync(transcript, line({ type: "message", id: "a2", parentId: "u2", timestamp: new Date(Date.now() + 1000).toISOString(),
    message: { role: "assistant", provider: "cpa", model: "glm-5.3", stopReason: "stop", content: [{ type: "text", text: `换成按账户的锁。\n记忆: alpha 召回别用全局锁 (${id})；编的 (deadbeef)` }] } }));
  const out = join(dir, "view.html");
  const v = ab(["view", "--no-open", "--out", out]);
  assert.match(v, /记到 1 次引用/);
  const data = dataOf(out);
  const e = data.entries.find((x: any) => x.id.startsWith(id));
  assert.equal(e.usage.inject_sessions, 1);
  assert.equal(e.usage.cited_sessions, 1);
  assert.equal(e.usage.mismatched, 0);
  assert.equal(data.telemetry.memory.total, 1);
  assert.equal(data.telemetry.memory.reported, 1);
  assert.equal(data.telemetry.memory.adopted, 1);
  assert.equal(data.telemetry.memory.unverifiable, 1);

  // 4. 关掉开关：召回块不再带指令
  ab(["setup", "--cite", "off"]);
  assert.doesNotMatch(hook(), /记忆：简短标题/);
});

test("库被别的进程占着写锁时，召回 hook 照常输出，统计放弃不等", () => {
  ab(["setup", "--cite", "on"]);
  const freshTranscript = join(tdir, "2026-01-02T00-00-00-000Z_s_lock_turn1.jsonl");
  writeFileSync(freshTranscript, line({ type: "session", version: 3, id: "s_lock_turn1", timestamp: new Date().toISOString(), cwd: alpha }));
  const before = (db().prepare("SELECT COUNT(*) AS n FROM recall_runs").get() as { n: number }).n;
  const lock = new DatabaseSync(join(home, "store.db"));
  lock.exec("BEGIN IMMEDIATE");
  try {
    const t0 = Date.now();
    const ctx = JSON.parse(ab(["recall", "--hook"], alpha, JSON.stringify({ prompt: "alpha 召回 全局锁", cwd: alpha, transcript_path: freshTranscript }))).hookSpecificOutput.additionalContext as string;
    const ms = Date.now() - t0;
    assert.match(ctx, /<agentbrain-recall>/);
    assert.ok(ms < 2000, `hook 用了 ${ms}ms`);
  } finally {
    lock.exec("ROLLBACK");
    lock.close();
  }
  assert.equal((db().prepare("SELECT COUNT(*) AS n FROM recall_runs").get() as { n: number }).n, before, "拿不到锁就不记");
  ab(["setup", "--cite", "off"]);
});
