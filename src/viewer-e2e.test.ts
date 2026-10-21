/**
 * §11.8 端到端：真实 CLI 子进程、临时 AB_HOME 与临时 HOME，不碰真实 ~/.agentbrain 和宿主指令文件。
 * 召回 hook → inject_log/recall_runs；ab setup --cite on → 召回块带指令、宿主文件写托管块；
 * 助手回复写 ab-used → ab view 扫到引用并显示在看板数据里；--share 脱敏、--exclude-project 排除。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
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

test("召回记录、引用开关、ab-used 扫描、看板数据、分享脱敏，一条链走通", () => {
  const id = /\[([0-9a-f]{8})\]/.exec(ab(["remember", "--confirmed", "--kind", "pitfall", "--text", "别在 alpha 召回里用全局锁，token=abcd1234efgh5678 要换", "--summary", "锁"]))![1];
  ab(["remember", "--confirmed", "--kind", "rule", "--text", "beta 的全局锁规则", "--summary", "beta"], beta);

  // 1. 开关默认关：召回块没有指令；注入和召回结果都记下来，带宿主和会话
  const off = hook();
  assert.match(off, new RegExp(`\\[${id}\\] 坑:`));
  assert.doesNotMatch(off, /ab-used/);
  let d = db();
  const inj = d.prepare("SELECT host,session_id,path,rank,substr(prop_id,1,8) AS p FROM inject_log WHERE path='recall'").all() as any[];
  assert.deepEqual(inj.map((r) => ({ ...r })), [{ host: "pi", session_id: SESSION, path: "recall", rank: 1, p: id }]);
  assert.deepEqual({ ...(d.prepare("SELECT host,outcome,n_hits,cite FROM recall_runs").get() as any) }, { host: "pi", outcome: "hit", n_hits: 1, cite: 0 });
  d.close();
  // 模型回答了这一轮（没有回复的回合会被当成模型调用失败，不进统计）
  appendFileSync(transcript, line({ type: "message", id: "a0", parentId: "u1", timestamp: new Date().toISOString(),
    message: { role: "assistant", provider: "cpa", model: "glm-5.3", content: [{ type: "text", text: "先按账户加锁。" }] } }));

  // 2. 打开开关：宿主指令文件写入托管块（含 ab-used 说明），召回块末尾多一行指令
  const setup = ab(["setup", "--cite", "on"]);
  assert.match(setup, /引用指令：开/);
  assert.match(readFileSync(join(fakeHome, ".config/opencode/AGENTS.md"), "utf8"), /ab-used: 简短标题 \(id\)/);
  const on = hook();
  assert.match(on, /ab-used: 简短标题 \(id\)，多条用；分隔。没用上就不写。）\n<\/agentbrain-recall>$/);

  // 3. 助手回复引用了这条（标题贴切）和一个编造的 id
  appendFileSync(transcript, line({ type: "message", id: "a1", parentId: "a0", timestamp: new Date(Date.now() + 1000).toISOString(),
    message: { role: "assistant", provider: "cpa", model: "glm-5.3", content: [{ type: "text", text: `换成按账户的锁。\nab-used: alpha 召回别用全局锁 (${id})；编的 (deadbeef)` }] } }));
  const out = join(dir, "view.html");
  const v = ab(["view", "--no-open", "--out", out]);
  assert.match(v, /记到 1 次引用，丢弃 1 个/);
  const data = dataOf(out);
  const e = data.entries.find((x: any) => x.id.startsWith(id));
  assert.equal(e.usage.inject_sessions, 1, "同一会话两次注入只算 1 个会话");
  assert.equal(e.usage.inject_total, 2);
  assert.equal(e.usage.cited_sessions, 1);
  assert.equal(e.usage.mismatched, 0);
  const pi = data.telemetry.hosts.find((h: any) => h.host === "pi");
  assert.deepEqual(pi, { host: "pi", model: "cpa/glm-5.3", sessions: 1, recall_turns: 1, marked_turns: 1 });
  assert.equal(data.telemetry.recall_runs.hit, 2);

  // 4. 抽取输入里没有 ab-used 行
  // （work 用 stripAbUsed；这里直接检查看板没把标记行当内容）
  assert.ok(!data.entries.some((x: any) => /ab-used/.test(x.text)));

  // 5. 分享版：正文过脱敏、去会话 id；排除 beta 项目
  const share = join(dir, "share.html");
  const sv = ab(["view", "--no-open", "--share", "--exclude-project", "beta", "--out", share]);
  assert.match(sv, /已排除 beta/);
  const sd = dataOf(share);
  const se = sd.entries.find((x: any) => x.id.startsWith(id));
  assert.match(se.text, /token=\[SECRET:credential\]/);
  assert.doesNotMatch(readFileSync(share, "utf8"), /abcd1234efgh5678/);
  assert.deepEqual(se.sessions, []);
  assert.ok(!sd.entries.some((x: any) => x.project === "beta"));
  assert.equal(sd.share, true);
  assert.ok(dataOf(out).entries.some((x: any) => x.project === "beta"), "普通版不受影响");

  // 6. 关掉开关：召回块不再带指令，托管块回到三条
  ab(["setup", "--cite", "off"]);
  assert.doesNotMatch(hook(), /ab-used/);
  assert.doesNotMatch(readFileSync(join(fakeHome, ".config/opencode/AGENTS.md"), "utf8"), /ab-used/);
});
