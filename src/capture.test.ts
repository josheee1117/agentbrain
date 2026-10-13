/**
 * 切片 3 端到端：真的跑 ab 子进程，模型与 embedding 是本机上的假 OpenAI 兼容服务（确定性），不连外网。
 * 走一遍 hook 登记 → SessionEnd 拉起分离的 ab work → 自动沉淀 → doctor → ab work --sweep 代码核验转正。
 * 运行：node --test src/capture.test.ts
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "ab-cap-")));
const abHome = join(dir, "store");
const fakeHome = join(dir, "home");
const repos = join(dir, "pm/repos");
const bin = join(dir, "bin");
for (const d of [abHome, repos, bin, join(fakeHome, ".claude/projects/p")]) mkdirSync(d, { recursive: true });
writeFileSync(join(bin, "security"), "#!/bin/sh\necho fixture-key\n");
chmodSync(join(bin, "security"), 0o755);

const repo = join(dir, "alpha");
mkdirSync(repo);
writeFileSync(join(repo, "README.md"), "# alpha\n\nhook 命令要写成 /opt/homebrew/bin/node 的绝对路径，宿主 PATH 不可靠。\n");
execFileSync("git", ["-C", repo, "init", "-q"]);
execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "add", "."]);
execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
writeFileSync(join(repos, "alpha.md"), `- 路径：\`${repo}\`\n`);

const SID = "11111111-2222-3333-4444-555555555555";
const transcript = join(fakeHome, `.claude/projects/p/${SID}.jsonl`);
writeFileSync(transcript, [
  { type: "user", uuid: "u1", cwd: repo, message: { role: "user", content: "以后 hook 命令都写 node 绝对路径。我的 token=abcdefghijklmnop 别记" } },
  { type: "assistant", uuid: "a1", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "env node scripts/hook.js" } }] } },
  { type: "user", uuid: "r1", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "env: node: No such file or directory", is_error: true }] } },
].map((l) => JSON.stringify(l)).join("\n") + "\n");

const seen: { path: string; auth: string; body: any }[] = [];
const vec = (t: string) => {
  const v = new Array(97).fill(0);
  for (const ch of t) v[ch.codePointAt(0)! % 97] += 1;
  return v;
};
function reply(body: any): object {
  const msgs = body.messages as { role: string; content: string }[];
  if (body.tools) {
    if (msgs.length === 2) return { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "search_code", arguments: JSON.stringify({ pattern: "绝对路径" }) } }] };
    return { role: "assistant", content: JSON.stringify({ verdict: "verified", evidence: [{ path: "README.md", line_start: 3, line_end: 3, quote: "hook 命令要写成 /opt/homebrew/bin/node 的绝对路径" }] }) };
  }
  const user = msgs[1].content;
  const tool = /\[#(\d+) tool\] (env: node: No such file)/.exec(user);
  const said = /\[#(\d+) user\] (以后 hook 命令都写 node 绝对路径)/.exec(user);
  const candidates = [];
  if (said) candidates.push({ kind: "rule", scope: "project", text: "hook 命令都写 node 绝对路径", why: "宿主 hook 子进程的 PATH 很少，上次写 ab 直接报找不到命令", basis: "user_directive", evidence: [{ anchor: `#${said[1]}`, role: "user", quote: said[2] }], relation: { type: "new", target: null } });
  if (tool) candidates.push({ kind: "pitfall", scope: "project", text: "宿主子进程环境变量很少，找不到解释器就报错退出", trigger: "配置宿主 hook", basis: "observed_failure", evidence: [{ anchor: `#${tool[1]}`, role: "tool", quote: tool[2] }], relation: { type: "new", target: null } });
  return { role: "assistant", content: JSON.stringify({ candidates }) };
}
const server = createServer(async (req: IncomingMessage, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  seen.push({ path: req.url!, auth: String(req.headers.authorization), body });
  res.setHeader("content-type", "application/json");
  if (req.url === "/v1/embeddings") res.end(JSON.stringify({ data: body.input.map((t: string, index: number) => ({ index, embedding: vec(t) })) }));
  else if (req.url === "/v1/chat/completions") res.end(JSON.stringify({ choices: [{ message: reply(body) }], usage: { total_tokens: 42 } }));
  else res.writeHead(404).end("{}");
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as AddressInfo).port;
writeFileSync(join(abHome, "embedding.json"), JSON.stringify({ baseUrl: `http://127.0.0.1:${port}/v1`, model: "fake-embed" }));
writeFileSync(join(abHome, "extract.json"), JSON.stringify({ model: "fake-llm" }));
after(() => server.close());

const CLI = join(import.meta.dirname, "cli.ts");
const ENV = { ...process.env, AB_HOME: abHome, AB_REGISTRY: repos, HOME: fakeHome, PATH: `${bin}:${process.env.PATH}` };

/** 异步跑 ab：假服务在本进程里，同步调用会把它卡死。 */
function ab(args: string[], opts: { cwd?: string; input?: string } = {}): Promise<{ out: string; err: string; code: number; ms: number }> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: opts.cwd ?? repo, env: ENV });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ out, err, code: code ?? -1, ms: Date.now() - t0 }));
    child.stdin.end(opts.input ?? "");
  });
}
const hook = (event: string, extra: object = {}) =>
  ab(["capture", "--hook", "--host", "claude"], { input: JSON.stringify({ session_id: SID, transcript_path: transcript, cwd: repo, hook_event_name: event, ...extra }) });

test("capture --hook：登记坐标，不输出、不报错；坏输入与越界路径静默忽略", async () => {
  const r = await hook("UserPromptSubmit");
  assert.deepEqual([r.code, r.out, r.err], [0, "", ""]);
  for (const input of ["not json", "{}", JSON.stringify({ session_id: "x", transcript_path: join(fakeHome, ".ssh/id_rsa"), cwd: repo })]) {
    const bad = await ab(["capture", "--hook", "--host", "claude"], { input });
    assert.deepEqual([bad.code, bad.out, bad.err], [0, "", ""], input);
  }
  const st = await ab(["doctor"]);
  assert.match(st.out, /会话: 已登记 1，未登记目录 0/);
  assert.equal(seen.length, 0, "登记不调模型");
});

test("SessionEnd 拉起分离的 ab work：会话被抽成未确认的自动沉淀，秘密没有出本机", async () => {
  const r = await hook("SessionEnd", { reason: "other" });
  assert.deepEqual([r.code, r.out], [0, ""]);
  let out = "";
  for (let i = 0; i < 100 && !/自动沉淀/.test(out); i++) {
    await new Promise((res) => setTimeout(res, 200));
    out = (await ab(["search", "node 绝对路径"])).out;
  }
  assert.match(out, /alpha 规则\[未确认·自动沉淀\]: hook 命令都写 node 绝对路径/);
  assert.match((await ab(["search", "解释器"])).out, /alpha 坑\[未确认·自动沉淀\]: 宿主子进程环境变量很少，找不到解释器就报错退出/);
  const chats = seen.filter((s) => s.path === "/v1/chat/completions");
  assert.equal(chats.length, 1);
  assert.equal(chats[0].auth, "Bearer fixture-key");
  const sent = JSON.stringify(chats[0].body);
  assert.doesNotMatch(sent, /abcdefghijklmnop/);
  assert.match(sent, /token=\[SECRET:credential\]/);
  assert.match(sent, /调用 Bash: env node scripts\/hook.js/);
  assert.match(sent, /hook 命令要写成/, "仓库 README 作为项目背景送了");
  const doctor = (await ab(["doctor"])).out;
  assert.match(doctor, /窗口: 完成 1，延后 0/);
  assert.match(doctor, /近 7 天: 候选 2，提议 2/);
  assert.match(doctor, /脱敏命中 credential 1/);
  const brief = (await ab(["brief"])).out;
  assert.match(brief, /另有 2 条未确认（其中自动沉淀 2 条/);
  assert.doesNotMatch(brief, /hook 命令都写/, "未确认的不进 brief");
});

test("ab work --sweep 按仓库代码核验未确认的坑：证据对得上就转正，get 里能看到代码证据", async () => {
  const before = seen.length;
  const r = await ab(["work", "--sweep"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /代码核验: 转正 1/);
  const tools = seen.slice(before).filter((s) => s.body.tools);
  assert.ok(tools.length >= 2);
  assert.match(JSON.stringify(tools[1].body.messages), /README\.md:3:hook 命令要写成/, "工具结果回给了模型");
  const hit = (await ab(["search", "解释器"])).out;
  const id = /\[([0-9a-f]{8})\] alpha 坑/.exec(hit)![1];
  assert.doesNotMatch(hit, /alpha 坑\[未确认/);
  const got = (await ab(["get", id])).out;
  assert.match(got, /已由代码核验转正/);
  assert.match(got, /代码证据（HEAD [0-9a-f]{10}）: README\.md:3「hook 命令要写成 \/opt\/homebrew\/bin\/node 的绝对路径」/);
  assert.match(got, /依据: 工具报错/);
  const rule = (await ab(["search", "hook 命令都写"])).out;
  assert.match(rule, /规则\[未确认·自动沉淀\]/, "规则不走代码核验，仍未确认");
  const recall = await ab(["recall", "--hook"], { input: JSON.stringify({ prompt: "宿主子进程环境变量很少，找不到解释器", cwd: repo }) });
  assert.match(recall.out, /找不到解释器就报错退出/, "转正后进每轮召回");
});

test("ab work --dry-run 只报待处理量，不调模型、不写库", async () => {
  const before = seen.length;
  const r = await ab(["work", "--dry-run"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(seen.length, before);
});
