/**
 * 话题触发端到端（§8.6）：真的跑 ab 子进程和 hook；embedding 是本机假服务，宿主子模型是 PATH 里的假 `claude`（不连 Claude）。
 * 走一遍：开关关着时 PreCompact 什么都不做 → 打开开关 → 距上一轮超过 20 分钟的下一轮拉起 ab work，只沉淀已结束的话题
 * → PreCompact 记边界并拉起 ab work → 搜索能看到全文 → ab work --undo 整次撤销。
 * 运行：node --test src/topic-capture.test.ts
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "ab-tcap-")));
const abHome = join(dir, "store");
const fakeHome = join(dir, "home");
const repos = join(dir, "pm/repos");
const bin = join(dir, "bin");
for (const d of [abHome, repos, bin, join(fakeHome, ".claude/projects/p")]) mkdirSync(d, { recursive: true });
writeFileSync(join(bin, "security"), "#!/bin/sh\necho fixture-key\n");
chmodSync(join(bin, "security"), 0o755);

// 假 claude -p：记下参数和环境，按提示词里的标记回一步式 JSON（claude --output-format json 的外形）
const claudeLog = join(dir, "claude.log");
writeFileSync(join(bin, "fake-claude.mjs"), `
import { appendFileSync, readFileSync } from "node:fs";
const input = readFileSync(0, "utf8");
const transcript = (/<transcript>([\\s\\S]*)<\\/transcript>/.exec(input) || ["", ""])[1];
appendFileSync(${JSON.stringify(claudeLog)}, JSON.stringify({ args: process.argv.slice(2), reviewer: process.env.AGENTBRAIN_REVIEWER ?? null, transcript }) + "\\n");
const items = [];
if (/话题一/.test(transcript)) items.push({ action: "new", kind: "pitfall", class: "C", text: "改了前端 UI 后要先重启 dev server 再跑 e2e，否则测的是旧代码", scenario: "当改完前端代码要跑 e2e 时", why: "上次 e2e 全绿但页面没变，查了半小时才发现 dev server 没热更新到构建产物", guidance: false, reason: "真实踩过的坑" });
if (/话题二/.test(transcript)) items.push({ action: "new", kind: "rule", class: "A", text: "数据库迁移脚本先在副本上跑一遍再上正式库", scenario: "当要跑数据库迁移时", why: "用户要求", guidance: false, reason: "用户明确要求" });
process.stdout.write(JSON.stringify({ type: "result", is_error: false, result: JSON.stringify({ items }), usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0.001 }));
`);
writeFileSync(join(bin, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${join(bin, "fake-claude.mjs")}" "$@"\n`);
chmodSync(join(bin, "claude"), 0o755);

const repo = join(dir, "alpha");
mkdirSync(repo);
writeFileSync(join(repo, "README.md"), "# alpha\n");
execFileSync("git", ["-C", repo, "init", "-q"]);
execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "add", "."]);
execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
writeFileSync(join(repos, "alpha.md"), `- 路径：\`${repo}\`\n`);

const SID = "21111111-2222-3333-4444-555555555555";
const transcript = join(fakeHome, `.claude/projects/p/${SID}.jsonl`);
const now = Date.now();
const ago = (min: number) => new Date(now - min * 60_000).toISOString();
const line = (o: object) => JSON.stringify(o) + "\n";
writeFileSync(transcript, [
  { type: "user", uuid: "u1", cwd: repo, timestamp: ago(60), message: { role: "user", content: "话题一：e2e 全绿但页面没变，原来是 dev server 没重启" } },
  { type: "assistant", uuid: "a1", timestamp: ago(58), message: { content: [{ type: "text", text: "对，改 UI 后要先重启 dev server 再跑 e2e。" }] } },
].map(line).join(""));

const server = createServer(async (req: IncomingMessage, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  res.setHeader("content-type", "application/json");
  if (req.url === "/v1/embeddings") res.end(JSON.stringify({ data: body.input.map((t: string, index: number) => ({ index, embedding: Array.from({ length: 97 }, (_, i) => [...t].filter((ch) => ch.codePointAt(0)! % 97 === i).length) })) }));
  else res.writeHead(404).end("{}");
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as AddressInfo).port;
writeFileSync(join(abHome, "embedding.json"), JSON.stringify({ baseUrl: `http://127.0.0.1:${port}/v1`, model: "fake-embed" }));
writeFileSync(join(abHome, "extract.json"), JSON.stringify({ model: "fake-llm" })); // 开关先关着
after(() => server.close());

const CLI = join(import.meta.dirname, "cli.ts");
const ENV = { ...process.env, AB_HOME: abHome, AB_REGISTRY: repos, HOME: fakeHome, AB_HOST_HOME: fakeHome, PATH: `${bin}:${process.env.PATH}` };
delete (ENV as any).AGENTBRAIN_REVIEWER;

function ab(args: string[], opts: { input?: string } = {}): Promise<{ out: string; err: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: repo, env: ENV });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ out, err, code: code ?? -1 }));
    child.stdin.end(opts.input ?? "");
  });
}
const hook = (event: string) => ab(["capture", "--hook", "--host", "claude"], { input: JSON.stringify({ session_id: SID, transcript_path: transcript, cwd: repo, hook_event_name: event }) });
const db = () => new DatabaseSync(join(abHome, "store.db"));
const claudeCalls = () => (existsSync(claudeLog) ? readFileSync(claudeLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
async function waitFor(pred: () => Promise<boolean> | boolean, what: string): Promise<void> {
  for (let i = 0; i < 150; i++) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.fail(`等不到：${what}`);
}

test("开关关着：PreCompact 什么都不做（不登记、不拉起 ab work、不调子模型）", async () => {
  const r = await hook("PreCompact");
  assert.deepEqual([r.code, r.out, r.err], [0, "", ""]);
  assert.equal(existsSync(join(abHome, "store.db")), false, "连库都没打开");
  // 普通的一轮照常登记，但不做静置判断
  await hook("UserPromptSubmit");
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(claudeCalls().length, 0);
  const d = db();
  try {
    assert.equal((d.prepare("SELECT COUNT(*) AS n FROM capture_sessions").get() as { n: number }).n, 1);
    assert.equal((d.prepare("SELECT COUNT(*) AS n FROM work_meta WHERE key LIKE 'topic_marks:%'").get() as { n: number }).n, 0);
  } finally {
    d.close();
  }
});

test("开关打开：距上一轮超过 20 分钟的下一轮拉起 ab work，用宿主子模型沉淀上一个话题，直接进正式库（未确认）", async () => {
  writeFileSync(join(abHome, "extract.json"), JSON.stringify({ model: "fake-llm", topic: true }));
  const d = db();
  d.prepare("UPDATE capture_sessions SET last_touch=? WHERE session_id=?").run(ago(55), SID);
  d.close();
  // 用户 55 分钟后回来，开始第二个话题（新的一轮已经写进 transcript）
  writeFileSync(transcript, readFileSync(transcript, "utf8") + line({ type: "user", uuid: "u2", timestamp: ago(0), message: { role: "user", content: "话题二：以后数据库迁移脚本先在副本上跑一遍" } }));
  const r = await hook("UserPromptSubmit");
  assert.deepEqual([r.code, r.out, r.err], [0, "", ""]);
  await waitFor(async () => /重启 dev server/.test((await ab(["search", "dev server e2e"])).out), "第一个话题沉淀");
  const calls = claudeCalls();
  assert.equal(calls.length, 1);
  assert.match(calls[0].transcript, /话题一/);
  assert.doesNotMatch(calls[0].transcript, /话题二/, "还在聊的话题不送");
  assert.equal(calls[0].reviewer, "1", "子模型会话带 AGENTBRAIN_REVIEWER=1，不会被登记、不会再触发抽取");
  assert.ok(calls[0].args.includes("--model") && calls[0].args.includes("haiku") && calls[0].args.includes("max"));
  const out = (await ab(["search", "dev server e2e"])).out;
  assert.match(out, /alpha 坑\[未确认·自动沉淀\]\[字面\+相似 \d\.\d\d\]: 改了前端 UI 后要先重启 dev server 再跑 e2e，否则测的是旧代码/);
  assert.match(out, /\n  为什么: 上次 e2e 全绿但页面没变，查了半小时才发现 dev server 没热更新到构建产物/, "搜索结果显示全文");
  assert.match(out, /\n  场景: 当改完前端代码要跑 e2e 时/);
});

test("PreCompact：记边界并拉起 ab work，压缩前的话题立刻沉淀；ab work --undo 整次撤销", async () => {
  writeFileSync(transcript, readFileSync(transcript, "utf8") + line({ type: "assistant", uuid: "a2", timestamp: new Date(Date.now() - 1000).toISOString(), message: { content: [{ type: "text", text: "好，迁移先在副本上验证。" }] } }));
  const r = await hook("PreCompact");
  assert.deepEqual([r.code, r.out, r.err], [0, "", ""]);
  await waitFor(async () => /副本上跑/.test((await ab(["search", "数据库迁移 副本"])).out), "压缩前的话题沉淀");
  const calls = claudeCalls();
  assert.equal(calls.length, 2);
  assert.match(calls[1].transcript, /话题二/);
  assert.doesNotMatch(calls[1].transcript, /话题一/, "第一个话题不重抽");
  const runs = (await ab(["work", "--runs"])).out.trim().split("\n");
  assert.equal(runs.length, 2);
  // 后台 ab work 还拿着租约（可能还在往这次运行里写）时不撤
  const d = db();
  try {
    d.prepare("INSERT OR REPLACE INTO work_lease(name,holder,pid,expires_at) VALUES('work','test',?,?)").run(process.pid, new Date(Date.now() + 3_600_000).toISOString());
  } finally {
    d.close();
  }
  const busy = await ab(["work", "--undo", runs[1]]);
  assert.notEqual(busy.code, 0);
  assert.match(busy.err, /正在跑/);
  const d2 = db();
  try {
    d2.prepare("DELETE FROM work_lease WHERE holder='test'").run();
  } finally {
    d2.close();
  }
  await waitFor(async () => {
    const x = db();
    try {
      return !x.prepare("SELECT 1 AS x FROM work_lease WHERE name='work'").get();
    } finally {
      x.close();
    }
  }, "后台 ab work 跑完放掉租约");
  const u = await ab(["work", "--undo", runs[1]]);
  assert.equal(u.code, 0, u.err);
  assert.match(u.out, /已归档 1 条/);
  assert.doesNotMatch((await ab(["search", "数据库迁移 副本"])).out, /副本上跑一遍再上正式库/, "撤销后不再出现在搜索里");
  assert.match((await ab(["search", "dev server e2e"])).out, /重启 dev server/, "别的运行不受影响");
});
