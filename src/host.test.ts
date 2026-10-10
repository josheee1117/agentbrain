/**
 * 宿主判定。运行：node --test src/host.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ancestors, parsePs, pickHost, type Proc } from "./host.ts";

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
