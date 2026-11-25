/** 运行：node --test src/codeverify.test.ts */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as codeverify from "./codeverify.ts";
import { RepoEscape, RepoTools, verifyProposition } from "./codeverify.ts";
import type { Chat, ChatMessage } from "./llm.ts";
import type { Proposition } from "./l2.ts";

const base = realpathSync(mkdtempSync(join(tmpdir(), "ab-cv-")));
const root = join(base, "repo");
mkdirSync(join(root, "src"), { recursive: true });
writeFileSync(join(base, "outside.txt"), "机密 outside\n");
writeFileSync(join(root, "src/store.ts"), "const BUSY = 1;\nconst VEC_MIN_SIM = 0.45;\nexport {};\n");
writeFileSync(join(root, "README.md"), "hook 命令写成 /opt/homebrew/bin/node 绝对路径\n");
symlinkSync(join(base, "outside.txt"), join(root, "escape.txt"));
const git = (...a: string[]) => execFileSync("git", ["-C", root, ...a], { encoding: "utf8" });
git("init", "-q");
git("-c", "user.name=t", "-c", "user.email=t@t", "add", ".");
git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "门槛从 0.35 调到 0.45");
const tools = new RepoTools(root);
const head = tools.head()!;

test("路径越界一律拒绝：..、绝对路径、.git、符号链接逃逸、pathspec 魔法、选项注入", () => {
  for (const p of ["../outside.txt", "src/../../outside.txt", "/etc/passwd", ".git/config", "src/../.git/HEAD", "escape.txt", ":(top)README.md", "-rf", "a\0b"]) {
    assert.throws(() => tools.resolve(p), RepoEscape, p);
    assert.match(tools.run("read_file", { path: p }), /^错误：/, p);
  }
  assert.equal(tools.check({ path: "../outside.txt", line_start: 1, line_end: 1, quote: "机密 outside" }), null);
  assert.equal(tools.check({ path: "escape.txt", line_start: 1, line_end: 1, quote: "机密 outside" }), null);
  assert.match(tools.run("git_log", { path: "../" }), /^错误：路径越出仓库/);
  assert.match(tools.run("list_dir", { path: "." }), /README\.md/);
  assert.doesNotMatch(tools.run("list_dir", { path: "." }), /\.git/);
});

test("只读工具：搜、读、log、blame 都限在仓库内", () => {
  assert.match(tools.run("search_code", { pattern: "VEC_MIN_SIM" }), /src\/store\.ts:2:const VEC_MIN_SIM = 0\.45;/);
  assert.equal(tools.run("read_file", { path: "src/store.ts", start_line: 2, end_line: 2 }), "2: const VEC_MIN_SIM = 0.45;");
  assert.match(tools.run("git_log", {}), /门槛从 0\.35 调到 0\.45/);
  assert.match(tools.run("git_blame", { path: "src/store.ts", start_line: 2 }), /VEC_MIN_SIM/);
  assert.match(tools.run("rm_rf", {}), /没有工具/);
});

test("证据核对：文件引文逐字对得上才算，commit 必须是 HEAD 的祖先", () => {
  assert.deepEqual(tools.check({ path: "src/store.ts", line_start: 2, line_end: 2, quote: "VEC_MIN_SIM = 0.45" }), { path: "src/store.ts", line_start: 2, line_end: 2, quote: "VEC_MIN_SIM = 0.45" });
  assert.equal(tools.check({ path: "src/store.ts", line_start: 1, line_end: 1, quote: "VEC_MIN_SIM = 0.45" }), null);
  assert.equal(tools.check({ path: "src/store.ts", line_start: 2, line_end: 2, quote: "VEC_MIN_SIM = 0.35" }), null);
  assert.equal(tools.check({ path: "nope.ts", line_start: 1, line_end: 1, quote: "whatever" }), null);
  assert.deepEqual(tools.check({ commit: head.slice(0, 12), quote: "从 0.35 调到 0.45" }), { commit: head, quote: "从 0.35 调到 0.45" });
  assert.equal(tools.check({ commit: "deadbeefdeadbeef", quote: "从 0.35 调到 0.45" }), null);
});

test("只读 ref 工具读取中文目标树，不碰别分支的脏工作区", async () => {
  const refRoot = join(base, "ref-repo");
  mkdirSync(refRoot);
  const runGit = (...args: string[]) => execFileSync("git", ["-C", refRoot, ...args], { encoding: "utf8" });
  runGit("init", "-q");
  mkdirSync(join(refRoot, "目录"));
  writeFileSync(join(refRoot, "目录/中文.ts"), "const CACHE_LIMIT = 42;\n");
  writeFileSync(join(refRoot, "large.txt"), "x".repeat(1_000_001));
  symlinkSync("/etc/passwd", join(refRoot, "link"));
  runGit("add", ".");
  runGit("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "目标 ref 的缓存决定");
  const target = runGit("rev-parse", "HEAD").trim();
  runGit("branch", "target");
  runGit("checkout", "-qb", "other");
  runGit("rm", "-q", "目录/中文.ts");
  runGit("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "工作区分支已删文件");
  const foreign = runGit("rev-parse", "HEAD").trim();
  writeFileSync(join(refRoot, "dirty.txt"), "CACHE_LIMIT = 999;\n");
  const before = runGit("status", "--porcelain=v1");
  const t = new codeverify.GitRefRepoTools(refRoot, "target");
  assert.equal(t.head(), target);
  assert.deepEqual(t.fileLines("目录/中文.ts"), ["const CACHE_LIMIT = 42;", ""]);
  assert.equal(t.fileLines("large.txt"), null);
  assert.equal(t.fileLines("link"), null);
  assert.match(t.run("search_code", { pattern: "CACHE_LIMIT" }), /目录\/中文.ts:1:const CACHE_LIMIT = 42/);
  assert.doesNotMatch(t.run("search_code", { pattern: "CACHE_LIMIT" }), /999|dirty/);
  assert.equal(t.run("list_dir", { path: "目录" }), "中文.ts");
  assert.match(t.run("list_dir", { path: "." }), /目录\//);
  assert.doesNotMatch(t.run("git_log", {}), /工作区分支/);
  assert.match(t.run("git_log", { path: "目录/中文.ts" }), /目标 ref/);
  assert.match(t.run("git_blame", { path: "目录/中文.ts", start_line: 1 }), /CACHE_LIMIT = 42/);
  assert.equal(t.commitMessage(foreign), null);
  assert.match(t.commitMessage(target)!, /目标 ref/);
  assert.deepEqual(t.check({ path: "目录/中文.ts", line_start: 1, quote: "CACHE_LIMIT = 42" }), { path: "目录/中文.ts", line_start: 1, line_end: 1, quote: "CACHE_LIMIT = 42" });
  for (const path of ["../outside", "/etc/passwd", ".git/HEAD", ":(top)目录", "-x", "a\0b"])
    assert.match(t.run("read_file", { path }), /^错误：/);
  for (const ref of ["-x", "bad ref", "bad\0ref", "", "missing"]) assert.throws(() => new codeverify.GitRefRepoTools(refRoot, ref));
  const chat = scripted([() => final({ verdict: "verified", evidence: [{ path: "目录/中文.ts", line_start: 1, quote: "CACHE_LIMIT = 42" }] })]);
  assert.equal((await verifyProposition(chat, t, { ...prop, kind: "decision" })).verdict, "verified");
  assert.match(chat.seen[0][1].content!, /种类：决定/);
  assert.match(chat.seen[0][0].content!, /坑、事实或决定/);
  assert.equal(runGit("rev-parse", "HEAD").trim(), foreign);
  assert.equal(runGit("status", "--porcelain=v1"), before);
});

/** 按脚本回放的模型：先调工具，再给结论。记下每次请求，供断言。 */
function scripted(steps: ((msgs: ChatMessage[]) => ChatMessage)[]): Chat & { seen: ChatMessage[][] } {
  const seen: ChatMessage[][] = [];
  const f = (async (msgs: ChatMessage[]) => {
    seen.push(structuredClone(msgs));
    const step = steps[Math.min(seen.length - 1, steps.length - 1)];
    return { message: step(msgs), tokens: 10 };
  }) as Chat & { seen: ChatMessage[][] };
  f.seen = seen;
  return f;
}
const toolCall = (name: string, args: object): ChatMessage => ({ role: "assistant", content: null, tool_calls: [{ id: `c-${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
const final = (o: object): ChatMessage => ({ role: "assistant", content: JSON.stringify(o) });
const prop = { id: "p", kind: "pitfall", text: "向量门槛是 0.45", project_id: "x" } as Proposition;

test("verified：模型调工具后引用对得上的代码 → 结论成立，工具输出回给了模型", async () => {
  const chat = scripted([
    () => toolCall("search_code", { pattern: "VEC_MIN_SIM" }),
    () => final({ verdict: "verified", evidence: [{ path: "src/store.ts", line_start: 2, line_end: 2, quote: "VEC_MIN_SIM = 0.45" }] }),
  ]);
  const r = await verifyProposition(chat, tools, prop);
  assert.deepEqual(r, { verdict: "verified", refs: [{ path: "src/store.ts", line_start: 2, line_end: 2, quote: "VEC_MIN_SIM = 0.45" }], calls: 1, rounds: 2, tokens: 20 });
  assert.match(chat.seen[1].at(-1)!.content!, /src\/store\.ts:2:const VEC_MIN_SIM = 0\.45;/);
});

test("contradicted 带 commit 证据也成立；编造一条证据整个结论作废", async () => {
  const contra = await verifyProposition(scripted([() => final({ verdict: "contradicted", evidence: [{ commit: head, quote: "调到 0.45" }] })]), tools, prop);
  assert.equal(contra.verdict, "contradicted");
  const fake = await verifyProposition(scripted([() => final({ verdict: "verified", evidence: [
    { path: "src/store.ts", line_start: 2, line_end: 2, quote: "VEC_MIN_SIM = 0.45" },
    { path: "src/store.ts", line_start: 3, line_end: 3, quote: "门槛已经验证过" },
  ] })]), tools, prop);
  assert.deepEqual(fake, { verdict: "inconclusive", refs: [], calls: 0, rounds: 1, tokens: 10 });
  const none = await verifyProposition(scripted([() => final({ verdict: "verified", confidence: 0.99, evidence: [] })]), tools, prop);
  assert.equal(none.verdict, "inconclusive", "只有置信度、没有证据不算");
});

test("not_verifiable 原样返回；工具额度用完后强制收尾", async () => {
  assert.equal((await verifyProposition(scripted([() => final({ verdict: "not_verifiable" })]), tools, prop)).verdict, "not_verifiable");
  const loop = scripted([
    ...Array.from({ length: 20 }, () => () => toolCall("list_dir", { path: "." })),
  ]);
  const wrapped = (async (msgs: ChatMessage[], opts?: { tools?: unknown[]; json?: boolean }) => {
    if (!opts?.tools) return { message: final({ verdict: "inconclusive" }), tokens: 1 };
    return loop(msgs, opts as never);
  }) as Chat;
  const r = await verifyProposition(wrapped, tools, prop);
  assert.equal(r.calls, 8);
  assert.equal(r.verdict, "inconclusive");
});

test("§8.11.3 note 核验：body 送检，模型能对 body 里的断言给证据", async () => {
  const withBody = { ...prop, kind: "note", text: "向量门槛与存储位置", body: "VEC_MIN_SIM 定义在 store.ts，值是 0.45。" } as unknown as Proposition;
  const chat = scripted([
    () => toolCall("search_code", { pattern: "VEC_MIN_SIM" }),
    () => final({ verdict: "verified", evidence: [{ path: "src/store.ts", line_start: 2, line_end: 2, quote: "VEC_MIN_SIM = 0.45" }] }),
  ]);
  const r = await verifyProposition(chat, tools, withBody);
  assert.equal(r.verdict, "verified");
  assert.match(chat.seen[0][1].content!, /VEC_MIN_SIM 定义在 store.ts，值是 0\.45/);
});

test("仓库配置不能借 git 执行命令：core.fsmonitor 被关掉", () => {
  const marker = join(base, "pwned");
  const evil = join(base, "evil.sh");
  writeFileSync(evil, `#!/bin/sh\ntouch '${marker}'\n`);
  execFileSync("chmod", ["+x", evil]);
  git("config", "core.fsmonitor", evil);
  try {
    tools.run("search_code", { pattern: "VEC_MIN_SIM" });
    tools.run("git_log", {});
    tools.run("git_blame", { path: "src/store.ts", start_line: 1 });
    tools.check({ commit: head, quote: "从 0.35 调到 0.45" });
    assert.equal(existsSync(marker), false);
  } finally {
    git("config", "--unset", "core.fsmonitor");
  }
});
