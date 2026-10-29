import { test, after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, symlinkSync, renameSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { opencodeRef, opencodeSession, opencodeParts } from "./opencode.ts";
import { allowedTranscript, scan, runWork, type WorkDeps } from "./work.ts";
import { cleanTranscript } from "./transcript.ts";
import { expandSource, latestAnchor } from "./source.ts";
import { Store } from "./store.ts";
import * as intake from "./intake.ts";
import { pickHost } from "./host.ts";

const oldHome = process.env.HOME;
const home = realpathSync(mkdtempSync(join(tmpdir(), "ab-opencode-")));
process.env.HOME = home;
after(() => { process.env.HOME = oldHome; rmSync(home, { recursive: true, force: true }); });
const dir = join(home, ".local/share/opencode");
mkdirSync(dir, { recursive: true });
const path = join(dir, "opencode.db");
const db = new DatabaseSync(path);
db.exec(`CREATE TABLE session_v2(id TEXT PRIMARY KEY,directory TEXT,parent_id TEXT,time_created INTEGER,time_updated INTEGER);
CREATE TABLE session_message(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,seq INTEGER,time_created INTEGER,data TEXT);`);
const now = Date.now();
const repo = join(home, "repo");
mkdirSync(repo);
execFileSync("git", ["init", "-q", repo]);
for (const [id, cwd, parent, time] of [["ses_main", repo, null, now - 3600000], ["ses_child", repo, "ses_main", now], ["ses_old", repo, null, now - 8 * 86400000], ["ses_unregistered", "/elsewhere", null, now]] as const) {
  db.prepare("INSERT INTO session_v2 VALUES(?,?,?,?,?)").run(id, cwd, parent, time, time);
}
let seq = 0;
for (const [id, role, text] of [["u", "user", "以后实现前先验证真实接口，因为此前假数据掩盖了 SQLite 的错误"], ["a", "assistant", "好的，先做真实验证"], ["s", "synthetic", "<agentbrain-recall>not evidence</agentbrain-recall>"]] as const) {
  db.prepare("INSERT INTO session_message VALUES(?,?,?,?,?,?)").run(id, "ses_main", role, seq++, now, JSON.stringify(role === "assistant" ? { content: [{ type: "text", text }] } : { text }));
}
db.close();
const ref = opencodeRef("ses_main")!;

test("nearest opencode parent wins over inherited Pi session identity", () => {
  assert.deepEqual(pickHost([{ comm: "/opt/homebrew/bin/opencode", args: "opencode" }, { comm: "pi", args: "pi" }], { OPENCODE_SESSION_ID: "ses_main", PI_SESSION_ID: "parent" }), { host: "opencode", session_id: "ses_main" });
});

test("SQLite reference accepts existing sessions and rejects nonexistent or forged paths", () => {
  assert.equal(allowedTranscript("opencode", ref, "ses_main"), ref);
  assert.equal(allowedTranscript("opencode", ref, "ses_child"), null);
  assert.equal(allowedTranscript("opencode", "opencode://session/ses_missing"), null);
  assert.equal(allowedTranscript("opencode", path), null);
  assert.equal(allowedTranscript("opencode", "opencode://session/../../secret"), null);
  assert.equal(allowedTranscript("opencode", `file://${path}#ses_main`), null);
  assert.equal(opencodeSession(ref)?.directory, repo);
  const connection = new DatabaseSync(path, { readOnly: true });
  try { assert.throws(() => connection.exec("DELETE FROM session_v2"), /readonly/); } finally { connection.close(); }
  renameSync(path, path + ".original");
  symlinkSync(path + ".original", path);
  try { assert.equal(allowedTranscript("opencode", ref), null); } finally { unlinkSync(path); renameSync(path + ".original", path); }
});

test("SQLite transcript reads user and assistant text, excludes synthetic recall, and expands anchors", () => {
  const text = cleanTranscript("opencode", ref);
  assert.equal(text.turns.length, 2);
  assert.deepEqual(new Set(text.turns.map((t) => t.role)), new Set(["user", "assistant"]));
  assert.equal(text.cwd, repo);
  assert.equal(text.worker, false);
  assert.equal(cleanTranscript("opencode", opencodeRef("ses_child")!).subagent, true);
  const anchor = latestAnchor("opencode", ref)!;
  const expanded = expandSource({ host: "opencode", session_id: "ses_main", transcript: ref, anchor, summary: "test" });
  assert.ok(expanded);
  assert.doesNotMatch(expanded, /not evidence/);
  assert.equal(expandSource({ host: "opencode", session_id: "ses_other", transcript: ref, anchor, summary: "test" }), null);
  assert.equal(opencodeParts(ref).parts.length, 2);
});

test("opencode 最终回答要求 completed 和 stop，进度、失败、工具继续都不算", () => {
  const connection = new DatabaseSync(path);
  try {
    for (const [metadata, final] of [
      [{ time: { created: now } }, false],
      [{ time: { completed: now + 100 }, finish: "tool-calls" }, false],
      [{ time: { completed: now + 100 }, finish: "stop", error: { message: "quota" } }, false],
      [{ time: { completed: now + 100 }, finish: "stop" }, true],
    ] as const) {
      connection.prepare("UPDATE session_message SET data=? WHERE id='a'").run(JSON.stringify({ ...metadata, content: [{ type: "text", text: "记忆：本轮未用" }] }));
      assert.equal(cleanTranscript("opencode", ref).turns.at(-1)?.final === true, final);
    }
  } finally { connection.close(); }
});

function deps(store: Store): WorkDeps {
  return { store, now: () => new Date(now), chat: { error: "no_config", message: "test" }, embedder: null, registry: [{ name: "test", path: repo }], registryDir: home, resolveProject: (cwd) => cwd === repo ? { name: "test", path: repo } : null, projectId: (name) => store.ensureProject(name) };
}

test("sweep registers recent project sessions once, excluding children, old and unknown projects", async () => {
  const store = new Store(join(home, "scan-store.db"), join(home, "scan-index.db"));
  try {
    assert.equal(scan(deps(store)), 1);
    assert.equal(scan(deps(store)), 0);
    assert.deepEqual(intake.sessions(store.workDb).map((s) => s.session_id), ["ses_main"]);
    const report = await runWork(deps(store), { session: { host: "opencode", session_id: "ses_main" }, sweep: false, dryRun: true });
    assert.equal(report.dry[0].windows, 1);
    assert.ok(report.dry[0].chars > 20);
  } finally { store.close(); }
});

test("capture uses SQLite cwd, rejects fake sessions, and marks child ephemeral", () => {
  const registry = join(home, "repos");
  mkdirSync(registry);
  writeFileSync(join(registry, "test.md"), `- 路径：\`${repo}\`\n`);
  const abHome = join(home, "ab");
  const cli = join(import.meta.dirname, "cli.ts");
  const capture = (session_id: string, transcript_path = `opencode://session/${session_id}`) => spawnSync(process.execPath, [cli, "capture", "--hook", "--host", "opencode"], { env: { ...process.env, AB_HOME: abHome, AB_REGISTRY: registry }, input: JSON.stringify({ session_id, transcript_path, cwd: "/forged", hook_event_name: "UserPromptSubmit" }), encoding: "utf8" });
  assert.equal(capture("ses_main").status, 0);
  assert.equal(capture("ses_child").status, 0);
  assert.equal(capture("ses_missing").status, 0);
  assert.equal(capture("ses_forged", ref).status, 0);
  const store = new Store(join(abHome, "store.db"), join(abHome, "index.db"));
  try {
    const rows = intake.sessions(store.workDb);
    assert.equal(rows.length, 2);
    assert.equal(rows.find((s) => s.session_id === "ses_main")?.cwd, repo);
    assert.equal(rows.find((s) => s.session_id === "ses_child")?.ephemeral, 1);
  } finally { store.close(); }
});
