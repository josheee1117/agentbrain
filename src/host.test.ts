/**
 * 宿主判定。运行：node --test src/host.test.ts
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { ancestors, locateTranscript, parsePs, pickHost, type Proc } from "./host.ts";

const base = realpathSync(mkdtempSync(join(tmpdir(), "ab-host-")));
const oldHome = process.env.HOME;
process.env.HOME = base; // locateTranscript 的夹具 home；单测里再按需临时覆盖
const codexId = "01a11967-19b1-7063-8631-c3dfad45ef88";
const text = [
  JSON.stringify({ type: "session_meta", payload: { cwd: "/x", source: "vscode" } }),
  JSON.stringify({ ordinal: 1, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] } }),
].join("\n") + "\n";
after(() => {
  process.env.HOME = oldHome;
  rmSync(base, { recursive: true, force: true });
});

const node = (args: string): Proc => ({ comm: "/opt/homebrew/bin/node", args });
const claude: Proc = { comm: "/usr/local/bin/claude", args: "" };

const env = {
  CLAUDE_CODE_SESSION_ID: "claude-1",
  CODEX_THREAD_ID: "codex-1",
  PI_SESSION_ID: "pi-1",
};

test("嵌套 claude→pi：链从最近的 pi 进程开始，判定为 pi 并取 PI_SESSION_ID", () => {
  const chain = [node("/opt/pi/pi-coding-agent/dist/cli.js"), claude];
  assert.deepEqual(pickHost(chain, env), { host: "pi", session_id: "pi-1" });
});

test("只有 claude：判定为 claude，即使两个变量都在", () => {
  assert.deepEqual(pickHost([claude], env), { host: "claude", session_id: "claude-1" });
});

test("变量缺失为 null；comm basename 为 pi 也算；都没有返回 null", () => {
  assert.deepEqual(pickHost([{ comm: "pi", args: "" }], {}), { host: "pi", session_id: null });
  assert.equal(pickHost([node("some-other-tool"), { comm: "zsh", args: "" }], env), null);
});

test("ps 非零退出时 ancestors 抛错，不返回空链", () => {
  const d = mkdtempSync(join(tmpdir(), "ab-host-"));
  writeFileSync(join(d, "ps"), "#!/bin/sh\necho 'ps 坏了' >&2\nexit 1\n");
  chmodSync(join(d, "ps"), 0o755);
  const saved = process.env.PATH;
  process.env.PATH = `${d}:${saved}`;
  try {
    assert.throws(() => ancestors(process.pid), /ps 退出 1/);
  } finally {
    process.env.PATH = saved;
    rmSync(d, { recursive: true, force: true });
  }
});

test("parsePs：comm 路径带空格时保留整段，basename 仍是 claude", () => {
  const out = "  100    1 /Users/x/Library/Application Support/Claude/claude.app/Contents/MacOS/claude\n  200  100 /bin/zsh\n";
  const m = parsePs(out);
  const c = m.get(100)!;
  assert.equal(c.ppid, 1);
  assert.equal(c.rest, "/Users/x/Library/Application Support/Claude/claude.app/Contents/MacOS/claude");
  assert.equal(pickHost([{ comm: m.get(200)!.rest, args: "" }, { comm: c.rest, args: "" }], {})?.host, "claude");
});

test("locateTranscript（§7.6）：sessions 和 archived_sessions 都找得到压缩会话；并存时取未压缩那份", () => {
  const codex = join(base, ".codex");
  mkdirSync(join(codex, "sessions/2026/10/08"), { recursive: true });
  mkdirSync(join(codex, "archived_sessions/2026/10/08"), { recursive: true });
  const sessZ = join(codex, `sessions/2026/10/08/rollout-2026-10-08T10-45-49-${codexId}.jsonl.zst`);
  const archZ = join(codex, `archived_sessions/2026/10/08/rollout-2026-10-08T10-45-49-${codexId}.jsonl.zst`);
  writeFileSync(sessZ, zstdCompressSync(Buffer.from(text, "utf8")));
  writeFileSync(archZ, zstdCompressSync(Buffer.from(text, "utf8")));
  // 只有 sessions 有：找到它；archived 里有 sessions 也有：sessions 优先
  assert.equal(locateTranscript("codex", codexId), sessZ);
  rmSync(sessZ);
  assert.equal(locateTranscript("codex", codexId), archZ);
  // archived 恢复成 .jsonl 且 sessions 只有 .jsonl.zst：sessions 里的压缩份优先（先 sessions 后 archived）
  writeFileSync(sessZ, zstdCompressSync(Buffer.from(text, "utf8")));
  writeFileSync(archZ, "");
  assert.equal(locateTranscript("codex", codexId), sessZ);
});

test("locateTranscript（§7.6）：同目录里 .jsonl 与 .jsonl.zst 并存时取未压缩那份", () => {
  const codex = join(base, ".codex");
  mkdirSync(join(codex, "sessions/2026/10/09"), { recursive: true });
  const id = "01a11967-19b1-7063-8631-c3dfad45ef91";
  const plain = join(codex, `sessions/2026/10/09/rollout-2026-10-09T10-45-49-${id}.jsonl`);
  const zst = plain + ".zst";
  writeFileSync(plain, text);
  writeFileSync(zst, zstdCompressSync(Buffer.from(text, "utf8")));
  assert.equal(locateTranscript("codex", id), plain);
});

test("locateTranscript：claude 和 pi 的查找不变，压缩后缀不算命中", () => {
  const claudeId = "01a11967-19b1-7063-8631-c3dfad45ef89";
  mkdirSync(join(base, ".claude/projects/p"), { recursive: true });
  const claude = join(base, `.claude/projects/p/${claudeId}.jsonl`);
  writeFileSync(claude, text);
  assert.equal(locateTranscript("claude", claudeId), claude);
  const piDir = join(base, ".pi/agent/sessions/x");
  mkdirSync(piDir, { recursive: true });
  const piId = "01a11967-19b1-7063-8631-c3dfad45ef90";
  const pi = join(piDir, `2026-01-01T00-00-00-000Z_${piId}.jsonl`);
  writeFileSync(pi, text);
  assert.equal(locateTranscript("pi", piId), pi);
});
