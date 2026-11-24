import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { detectHost, locateTranscript } from "./host.ts";
import { agyLocate } from "./agy.ts";
import { Store } from "./store.ts";
import * as intake from "./intake.ts";

function fixture(t: TestContext) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "ab-agy-locate-")));
  const keys = ["HOME", "AB_HOME", "AGENTBRAIN_HOME", "AB_REGISTRY", "ANTIGRAVITY_APP_DATA_DIR", "GEMINI_HOME"];
  const old = keys.map((key) => process.env[key]);
  process.env.HOME = home;
  process.env.AB_HOME = process.env.AGENTBRAIN_HOME = join(home, "ab");
  process.env.AB_REGISTRY = join(home, "repos");
  delete process.env.ANTIGRAVITY_APP_DATA_DIR;
  delete process.env.GEMINI_HOME;
  t.after(() => {
    keys.forEach((key, i) => { if (old[i] === undefined) delete process.env[key]; else process.env[key] = old[i]; });
    rmSync(home, { recursive: true, force: true });
  });
  const apps = [join(home, ".gemini/antigravity-cli"), join(home, ".gemini/antigravity"), join(home, ".t3/userdata/providers/antigravity/instance-a/antigravity-acp")];
  apps.forEach((app) => mkdirSync(app, { recursive: true }));
  const path = (app: string, id: string) => join(app, "brain", id, ".system_generated/logs/transcript_full.jsonl");
  const log = (app: string, id: string) => {
    const file = path(app, id);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ step_index: 0, type: "USER_INPUT", status: "DONE", content: `<USER_REQUEST>定位原话 ${id}</USER_REQUEST>` }) + "\n");
    return file;
  };
  const cli = (...args: string[]) => spawnSync(process.execPath, [join(import.meta.dirname, "cli.ts"), ...args], { env: process.env, encoding: "utf8" });
  return { home, apps, path, log, cli };
}

for (const [i, kind] of ["CLI", "IDE", "T3"].entries()) {
  test(`agy locate 根提示定位 ${kind} 的完整版`, (t) => {
    const f = fixture(t);
    const id = `hint-${i}`;
    const file = f.log(f.apps[i], id);
    process.env.ANTIGRAVITY_APP_DATA_DIR = f.apps[i] + "/";
    assert.equal(locateTranscript("agy", id), file);
  });

  test(`agy locate 无提示且唯一 ${kind} 完整版时命中`, (t) => {
    const f = fixture(t);
    const id = `unique-${i}`;
    const file = f.log(f.apps[i], id);
    assert.equal(locateTranscript("agy", id), file);
  });

  test(`agy locate ${kind} 日志未落盘时保留合法提示的规范坐标`, (t) => {
    const f = fixture(t);
    process.env.ANTIGRAVITY_APP_DATA_DIR = f.apps[i];
    assert.equal(locateTranscript("agy", "late"), f.path(f.apps[i], "late"));
  });
}

test("agy locate 只有 GEMINI_HOME 时只接受已枚举的 T3 实例", (t) => {
  const f = fixture(t);
  const other = join(f.home, ".t3/userdata/providers/antigravity/instance-b/antigravity-acp");
  mkdirSync(other, { recursive: true });
  process.env.GEMINI_HOME = dirname(other);
  assert.equal(locateTranscript("agy", "t3-late"), f.path(other, "t3-late"));
  const file = f.log(other, "t3-full");
  assert.equal(locateTranscript("agy", "t3-full"), file);
  process.env.GEMINI_HOME = f.apps[0];
  assert.equal(locateTranscript("agy", "not-t3"), null);
  process.env.GEMINI_HOME = join(f.home, ".t3/userdata/providers/antigravity/not-discovered");
  assert.equal(locateTranscript("agy", "not-discovered"), null);
});

test("agy locate 多根同 id 无论提示都冲突，不按枚举顺序挑第一份", (t) => {
  const f = fixture(t);
  f.apps.forEach((app) => f.log(app, "shared"));
  assert.equal(locateTranscript("agy", "shared"), null);
  const result = agyLocate("shared");
  assert.equal(result.path, null);
  assert.deepEqual(result.conflict.map((root) => root.appData).sort(), [...f.apps].sort());
  for (const app of f.apps) {
    process.env.ANTIGRAVITY_APP_DATA_DIR = app;
    assert.equal(locateTranscript("agy", "shared"), null);
  }
  delete process.env.ANTIGRAVITY_APP_DATA_DIR;
  process.env.GEMINI_HOME = dirname(f.apps[2]);
  assert.equal(locateTranscript("agy", "shared"), null);
});

test("agy locate 无候选、截断版、非法 id 和任意环境路径不放行", (t) => {
  const f = fixture(t);
  assert.equal(locateTranscript("agy", "absent"), null);
  const outside = join(f.home, "outside");
  f.log(outside, "outside");
  process.env.ANTIGRAVITY_APP_DATA_DIR = outside;
  assert.equal(locateTranscript("agy", "outside"), null);
  assert.equal(locateTranscript("agy", "late"), null);
  process.env.GEMINI_HOME = outside;
  assert.equal(locateTranscript("agy", "outside"), null);
  process.env.ANTIGRAVITY_APP_DATA_DIR = f.apps[1];
  for (const id of ["", "../outside", "a/b", ".."]) assert.equal(locateTranscript("agy", id), null);
  delete process.env.ANTIGRAVITY_APP_DATA_DIR;
  delete process.env.GEMINI_HOME;
  const truncated = join(dirname(f.path(f.apps[1], "short")), "transcript.jsonl");
  mkdirSync(dirname(truncated), { recursive: true });
  writeFileSync(truncated, "{}\n");
  assert.equal(locateTranscript("agy", "short"), null);
  process.env.ANTIGRAVITY_APP_DATA_DIR = outside;
  const file = f.log(f.apps[1], "unique");
  assert.equal(locateTranscript("agy", "unique"), file, "非法提示不影响合法唯一候选");
});

test("agy locate 根和未落盘日志父目录的逃逸软链拒绝", (t) => {
  const f = fixture(t);
  const outside = join(f.home, "outside");
  mkdirSync(outside);
  rmSync(f.apps[1], { recursive: true });
  symlinkSync(outside, f.apps[1]);
  process.env.ANTIGRAVITY_APP_DATA_DIR = f.apps[1];
  assert.equal(locateTranscript("agy", "late"), null);
  mkdirSync(join(f.apps[2], "brain"));
  symlinkSync(outside, join(f.apps[2], "brain/late"));
  process.env.ANTIGRAVITY_APP_DATA_DIR = f.apps[2];
  assert.equal(locateTranscript("agy", "late"), null);
});

test("agy detectHost 和 --from-worker 保留未落盘规范路径，三处 get --expand 不串根", (t) => {
  const f = fixture(t);
  const bin = join(f.home, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "ps"), `#!/bin/sh\nprintf '%s\\n' '${process.ppid} 1 /Applications/Antigravity.app/Contents/Resources/language_server'\n`);
  chmodSync(join(bin, "ps"), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  t.after(() => { process.env.PATH = oldPath; });
  process.env.ANTIGRAVITY_APP_DATA_DIR = f.apps[1];
  assert.deepEqual(detectHost({ ANTIGRAVITY_CONVERSATION_ID: "late" }), { ok: true, detection: { host: "agy", session_id: "late", transcript: f.path(f.apps[1], "late") } });
  const late = f.cli("remember", "--kind", "note", "--text", "未落盘坐标", "--summary", "定位", "--global", "--from-worker", "agy:late");
  assert.equal(late.status, 0, late.stderr);
  for (const [i, app] of f.apps.entries()) {
    const id = `source-${i}`;
    const file = f.log(app, id);
    process.env.ANTIGRAVITY_APP_DATA_DIR = app;
    const remembered = f.cli("remember", "--kind", "note", "--text", `来源 ${id}`, "--summary", "定位", "--global", "--from-worker", `agy:${id}`);
    assert.equal(remembered.status, 0, remembered.stderr);
    const prop = /已记住 \[([0-9a-f]+)\]/.exec(remembered.stdout)?.[1];
    assert.ok(prop, remembered.stdout);
    const expanded = f.cli("get", prop, "--expand");
    assert.equal(expanded.status, 0, expanded.stderr);
    const store = new Store(join(process.env.AB_HOME!, "store.db"), join(process.env.AB_HOME!, "index.db"));
    try {
      const source = [...store.project().props.values()].find((p) => p.id.startsWith(prop))?.source;
      assert.equal(source?.transcript, file);
      assert.equal(source?.session_id, id);
    } finally { store.close(); }
    assert.ok(expanded.stdout.includes(`定位原话 ${id}`), expanded.stdout);
    assert.ok(!expanded.stdout.includes(`定位原话 source-${(i + 1) % 3}`));
  }
});

test("agy 真实 capture 入口无路径时登记三处坐标，冲突不登记也不刷新", (t) => {
  const f = fixture(t);
  for (const [i, app] of f.apps.entries()) {
    const id = `capture-${i}`;
    const file = f.log(app, id);
    process.env.ANTIGRAVITY_APP_DATA_DIR = app;
    const manual = f.cli("capture", `agy:${id}`, "--cwd", f.home);
    assert.equal(manual.status, 0, manual.stderr);
    assert.match(manual.stdout, new RegExp(`已登记 agy:${id}`));
    const hook = spawnSync(process.execPath, [join(import.meta.dirname, "cli.ts"), "capture", "--hook", "--host", "agy"], { env: process.env, input: JSON.stringify({ session_id: id, cwd: f.home, hook_event_name: "UserPromptSubmit" }), encoding: "utf8" });
    assert.deepEqual([hook.status, hook.stdout, hook.stderr], [0, "", ""]);
    const store = new Store(join(process.env.AB_HOME!, "store.db"), join(process.env.AB_HOME!, "index.db"));
    try { assert.equal(intake.sessions(store.workDb, { host: "agy", session_id: id })[0].transcript, file); } finally { store.close(); }
  }
  f.apps.forEach((app) => f.log(app, "conflict"));
  const manual = f.cli("capture", "agy:conflict", "--cwd", f.home);
  assert.equal(manual.status, 1);
  assert.match(manual.stderr, /多处有完整日志/);
  const store = new Store(join(process.env.AB_HOME!, "store.db"), join(process.env.AB_HOME!, "index.db"));
  intake.upsertSession(store.workDb, { host: "agy", session_id: "conflict", transcript: f.path(f.apps[0], "conflict"), cwd: f.home, ended: false, ephemeral: false, via: "hook" }, () => null, new Date("2026-01-01"));
  const before = intake.sessions(store.workDb, { host: "agy", session_id: "conflict" })[0];
  store.close();
  const hook = spawnSync(process.execPath, [join(import.meta.dirname, "cli.ts"), "capture", "--hook", "--host", "agy"], { env: process.env, input: JSON.stringify({ session_id: "conflict", cwd: f.home, hook_event_name: "SessionEnd" }), encoding: "utf8" });
  assert.deepEqual([hook.status, hook.stdout, hook.stderr], [0, "", ""]);
  const again = new Store(join(process.env.AB_HOME!, "store.db"), join(process.env.AB_HOME!, "index.db"));
  try { assert.deepEqual(intake.sessions(again.workDb, { host: "agy", session_id: "conflict" })[0], before); } finally { again.close(); }
});
