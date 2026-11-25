import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.ts";
import type { CodeRef, RememberBody } from "./l2.ts";
import * as intake from "./intake.ts";
import { MAX_CHANGED_ENQUEUE, resolveTrunkRef, scanChangedProject } from "./changeverify.ts";

function fixture(t: { after: (fn: () => void) => void }) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ab2-change-")));
  const before = { HOME: process.env.HOME, AB_HOME: process.env.AB_HOME, AGENTBRAIN_HOME: process.env.AGENTBRAIN_HOME, AB_REGISTRY: process.env.AB_REGISTRY };
  Object.assign(process.env, { HOME: dir, AB_HOME: join(dir, "ab"), AGENTBRAIN_HOME: join(dir, "ab"), AB_REGISTRY: join(dir, "repos") });
  const repo = join(dir, "repo");
  mkdirSync(repo);
  const toolsEnv = { PATH: process.env.PATH, HOME: dir, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" };
  const git = (...args: string[]) => execFileSync("git", ["--literal-pathspecs", "-C", repo, "-c", "core.hooksPath=/dev/null", ...args], { env: toolsEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-qb", "main");
  git("config", "user.name", "fixture"); git("config", "user.email", "fixture@local");
  const lines = Array.from({ length: 80 }, (_, i) => `// filler row ${i + 1}`);
  lines[19] = "const CACHE_LIMIT = 42;";
  lines[59] = "return CACHE_LIMIT;";
  const file = (path: string, text: string) => writeFileSync(join(repo, path), text);
  const commit = (text = "fixture") => { git("add", "."); git("commit", "-qm", text); return git("rev-parse", "HEAD"); };
  file("中文.ts", lines.join("\n") + "\n");
  const base = commit("base");
  const store = new Store(join(dir, "ab/store.db"), join(dir, "ab/index.db"));
  const pid = store.ensureProject("sample");
  const now = new Date("2026-11-25T12:00:00Z");
  const ref = { path: "中文.ts", line_start: 20, line_end: 20, quote: "CACHE_LIMIT = 42" };
  const memory = (refs: CodeRef[] | null = [ref], head = base, extra: Partial<RememberBody> = {}) => {
    const id = store.remember(pid, null, false, { kind: "note", text: "缓存常量的契约", confirmed: true, source: { host: null, session_id: null, transcript: null, anchor: null, summary: "fixture" }, ...extra });
    if (refs) store.commit([{ kind: "verify", project_id: pid, session_id: null, target_id: id, body: { outcome: "verified", head, refs } }], () => {});
    return id;
  };
  const entry = { name: "sample", path: repo, trunk: "main" };
  const scan = (dryRun = false, ref?: string) => scanChangedProject(store, entry, { dryRun, ref, now });
  t.after(() => {
    store.close(); rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  });
  return { repo, git, lines, file, commit, store, pid, now, base, ref, memory, scan, entry };
}

test("trunk-ref 选取：equal、local ahead、origin ahead、diverged、单侧、HEAD 和无提交", t => {
  const e = fixture(t);
  e.git("update-ref", "refs/remotes/origin/main", e.base);
  assert.deepEqual(resolveTrunkRef(e.repo, "main"), { ref: "origin/main", sha: e.base });
  e.file("new", "local\n"); const local = e.commit("local");
  assert.deepEqual(resolveTrunkRef(e.repo, "main"), { ref: "main", sha: local });
  e.git("update-ref", "refs/remotes/origin/main", local); e.git("update-ref", "refs/heads/main", e.base);
  assert.deepEqual(resolveTrunkRef(e.repo, "main"), { ref: "origin/main", sha: local });
  e.git("checkout", "-qb", "side", e.base); e.file("other", "side\n"); const side = e.commit("side");
  e.git("update-ref", "refs/heads/main", side);
  assert.deepEqual(resolveTrunkRef(e.repo, "main"), { ref: "origin/main", sha: local });
  e.git("update-ref", "-d", "refs/remotes/origin/main");
  assert.deepEqual(resolveTrunkRef(e.repo, "main"), { ref: "main", sha: side });
  e.git("update-ref", "refs/remotes/origin/release", local);
  assert.deepEqual(resolveTrunkRef(e.repo, "release"), { ref: "origin/release", sha: local });
  assert.equal(resolveTrunkRef(e.repo, "missing"), null);
  for (const trunk of [null, undefined, ""]) assert.deepEqual(resolveTrunkRef(e.repo, trunk), { ref: "HEAD", sha: side });
  assert.deepEqual(resolveTrunkRef(e.repo, "main", e.base), { ref: e.base, sha: e.base });
  for (const trunk of ["-bad", "bad ref", "bad\0ref", "a..b", "x~1", "a:"]) assert.throws(() => resolveTrunkRef(e.repo, trunk));
  for (const ref of ["-bad", "bad ref", "bad\0ref", "missing"]) assert.throws(() => resolveTrunkRef(e.repo, null, ref));
  const empty = join(e.repo, "empty"); mkdirSync(empty); execFileSync("git", ["init", "-q", empty], { env: { HOME: process.env.HOME, PATH: process.env.PATH } });
  assert.equal(resolveTrunkRef(empty, null), null);
});

for (const [name, line, replacement, priority] of [
  ["无关行", 75, "// unrelated update", null],
  ["标识符前缀不误命中", 75, "return CACHE_LIMIT_extra;", null],
  ["±3 行改常量", 22, "const OFFSET = 43;", "overlap_or_ident"],
  ["插入零旧行 hunk", 22, "// inserted", "overlap_or_ident"],
  ["远距离同标识符", 59, "return CACHE_LIMIT + 1;", "overlap_or_ident"],
  ["引文断裂", 19, "const CACHE_LIMIT = 99;", "broken"],
] as const) test(`机械预筛：${name}`, t => {
  const e = fixture(t); const id = e.memory();
  intake.recordVerify(e.store.workDb, id, e.base, "verified", new Date("2026-11-25T11:59:00Z"));
  const last = intake.lastVerify(e.store.workDb, id);
  if (name === "插入零旧行 hunk") e.lines.splice(line, 0, replacement); else e.lines[line] = replacement;
  e.file("中文.ts", e.lines.join("\n") + "\n"); e.commit();
  const dry = e.scan(true);
  assert.equal(dry.enqueued, priority ? 1 : 0);
  assert.equal(intake.queuedReverify(e.store.workDb).size, 0);
  const r = e.scan();
  assert.equal(r.enqueued, priority ? 1 : 0);
  assert.equal(r.items[0]?.priority ?? null, priority);
  assert.deepEqual(intake.lastVerify(e.store.workDb, id), last, "预筛不得覆写基线");
  if (!priority) { assert.equal(r.prescreened, 1); assert.deepEqual(r.prescreenedIds, [id]); }
});

test("候选跳过：种类、stale、草稿退场、demoted、无文件引文、已入队、同 head、退避、未跟踪路径", t => {
  const e = fixture(t);
  e.memory([e.ref], e.base, { kind: "rule" });
  const stale = e.memory(); e.store.commit([{ kind: "verify", project_id: e.pid, session_id: null, target_id: stale, body: { outcome: "contradicted", head: e.base, refs: [e.ref] } }], () => {});
  const old = e.memory([e.ref], e.base, { kind: "decision", confirmed: false, origin: "extract" });
  e.memory(null, e.base, { kind: "decision", confirmed: false, origin: "extract", supersedes: old });
  const demoted = e.memory([e.ref], e.base, { confirmed: false }); e.store.lifecycle("unconfirm", demoted, null, { reason: "fixture demotion" });
  e.memory(null); e.memory([{ commit: e.base, quote: "base" }]);
  const queued = e.memory(); e.store.queueReverify([queued], e.now);
  const unverifiable = e.memory(); intake.recordVerify(e.store.workDb, unverifiable, e.base, "not_verifiable", e.now);
  const backoff = e.memory(); intake.recordVerify(e.store.workDb, backoff, e.base, "inconclusive:1", e.now);
  e.memory([{ ...e.ref, path: "ignored.ts" }]);
  e.file(".gitignore", "ignored.ts\n"); e.file("ignored.ts", "const CACHE_LIMIT = 42;\n");
  e.lines[19] = "const CACHE_LIMIT = 99;"; e.file("中文.ts", e.lines.join("\n")); const head = e.commit();
  const same = e.memory([e.ref]); intake.recordVerify(e.store.workDb, same, head, "verified", e.now);
  const r = e.scan();
  assert.equal(r.hits, 0);
  assert.equal(r.skipped.no_file_refs, 3);
  assert.equal(r.skipped.already_queued, 1);
  assert.equal(r.skipped.not_verifiable, 1); assert.equal(r.skipped.backoff, 1);
  assert.equal(r.skipped.untracked_path, 1); assert.equal(r.skipped.same_head, 1);
});

test("删除文件优先、20 条上限、同优先级 seq 顺序和截断", t => {
  const e = fixture(t);
  const overlap = Array.from({ length: 22 }, () => e.memory());
  e.file("deleted.ts", "const DELETED_VALUE = 42;\n"); e.file("broken.ts", "const BROKEN_VALUE = 42;\n"); const base = e.commit();
  const broken = e.memory([{ path: "broken.ts", line_start: 1, line_end: 1, quote: "BROKEN_VALUE = 42" }], base);
  const deleted = e.memory([{ path: "deleted.ts", line_start: 1, line_end: 1, quote: "DELETED_VALUE = 42" }], base);
  e.git("rm", "deleted.ts"); e.file("broken.ts", "const BROKEN_VALUE = 99;\n");
  e.lines[22] = "const OFFSET = 43;"; e.file("中文.ts", e.lines.join("\n")); e.commit();
  const r = e.scan();
  assert.equal(MAX_CHANGED_ENQUEUE, 20); assert.equal(r.hits, 24); assert.equal(r.enqueued, 20); assert.equal(r.truncated, 4);
  assert.deepEqual(r.items.map(i => i.id), [deleted, broken, ...overlap.slice(0, 18)]);
  assert.equal(intake.queuedReverify(e.store.workDb).size, 20);
});

for (const broken of [false, true, "deleted"] as const) test(`基线缺失回退核对：${broken}`, t => {
  const e = fixture(t); const id = e.memory([e.ref], "f".repeat(40));
  if (broken === "deleted") e.git("rm", "中文.ts");
  else if (broken) { e.lines[19] = "const CACHE_LIMIT = 99;"; e.file("中文.ts", e.lines.join("\n")); }
  const head = broken ? e.commit() : e.base;
  assert.equal(e.scan(true).shifted, broken ? 0 : 1);
  assert.equal(intake.lastVerify(e.store.workDb, id), undefined);
  const r = e.scan();
  assert.equal(r.enqueued, broken ? 1 : 0); assert.equal(r.shifted, broken ? 0 : 1);
  if (!broken) assert.deepEqual({ ...intake.lastVerify(e.store.workDb, id) }, { head, outcome: "shifted", at: e.now.toISOString() });
});

test("非祖先三分支：未上线跳过、cherry-pick 平移、主干改坏入队、后续主干再改触发", t => {
  const e = fixture(t);
  e.git("checkout", "-qb", "feature");
  e.file("branch.ts", "const BRANCH_LIMIT = 42;\n"); const branch = e.commit("branch-only");
  const id = e.memory([{ path: "branch.ts", line_start: 1, line_end: 1, quote: "BRANCH_LIMIT = 42" }], branch);
  e.git("checkout", "main");
  assert.equal(e.scan().skipped.unmerged_branch, 1);
  e.file("main-only", "main\n"); e.commit("main changed"); e.git("cherry-pick", branch);
  const picked = e.git("rev-parse", "HEAD"); assert.notEqual(picked, branch);
  const dry = e.scan(true); assert.equal(dry.shifted, 1); assert.equal(intake.lastVerify(e.store.workDb, id), undefined);
  assert.equal(e.scan().shifted, 1); assert.equal(intake.lastVerify(e.store.workDb, id)?.head, picked);
  e.file("branch.ts", "const BRANCH_LIMIT = 99;\n"); const head = e.commit("broken on trunk");
  assert.equal(e.scan().items[0]?.priority, "broken");
  intake.dequeueReverify(e.store.workDb, id); intake.recordVerify(e.store.workDb, id, branch, "verified", new Date("2026-11-24"));
  assert.equal(e.scan().items[0]?.priority, "broken", "非祖先且主干碰过路径不跳过");
  assert.equal(e.scan().skipped.already_queued, 1);
  assert.equal(e.git("rev-parse", "HEAD"), head);
});

for (const priority of ["deleted", "broken"] as const) test(`退避到期：${priority} 在无关 H3 上仍按代码证据重核`, t => {
  const e = fixture(t); const id = e.memory();
  if (priority === "deleted") rmSync(join(e.repo, "中文.ts"));
  else { e.lines[19] = "const CACHE_LIMIT = 99;"; e.file("中文.ts", e.lines.join("\n")); }
  const h2 = e.commit("H2 invalidates evidence");
  intake.recordVerify(e.store.workDb, id, h2, "inconclusive:1", e.now);
  assert.equal(e.scan().skipped.same_head, 1);
  e.file("unrelated", "H3\n"); const h3 = e.commit("H3 unrelated");
  assert.equal(e.scan().skipped.backoff, 1);
  e.now.setDate(e.now.getDate() + 2);
  for (const dryRun of [true, false]) {
    const r = e.scan(dryRun);
    assert.equal(r.head, h3);
    assert.deepEqual(r.items, [{ id, seq: e.store.project().props.get(id)!.seq, priority }]);
    assert.equal(r.skipped.untracked_path, 0);
    assert.equal(r.skipped.unchanged, 0);
    assert.equal(intake.queuedReverify(e.store.workDb).has(id), !dryRun);
    assert.equal(intake.lastVerify(e.store.workDb, id)?.head, h2);
  }
});

for (const head of ["tracked", "missing"]) test(`路径隔离：非法引文混排不影响正常条目，${head} 基线不误平移`, t => {
  const e = fixture(t);
  const bad = { ...e.ref, path: "-dash.ts" };
  const invalid = e.memory([bad], head === "tracked" ? e.base : "f".repeat(40));
  const normal = e.memory();
  const mixed = e.memory([bad, e.ref]);
  e.lines[19] = "const CACHE_LIMIT = 99;"; e.file("中文.ts", e.lines.join("\n")); e.commit();
  const r = e.scan();
  assert.equal(r.skipped.untracked_path, 1);
  assert.equal(r.shifted, 0);
  assert.deepEqual(r.items.map(item => [item.id, item.priority]), [[normal, "broken"], [mixed, "broken"]]);
  assert.equal(intake.queuedReverify(e.store.workDb).has(invalid), false);
  assert.equal(intake.lastVerify(e.store.workDb, invalid), undefined);
});

test("同一基线超过 200 个引文路径，末批中文文件变更仍入队", t => {
  const e = fixture(t);
  const refs: CodeRef[] = [];
  for (let i = 0; i < 205; i++) {
    const path = `文件${i}.ts`;
    e.file(path, "const VALUE = 42;\n");
    refs.push({ path, line_start: 1, line_end: 1, quote: "VALUE = 42" });
  }
  const base = e.commit(); const id = e.memory(refs, base);
  e.file("文件204.ts", "const VALUE = 99;\n"); e.commit();
  const r = e.scan(); assert.equal(r.enqueued, 1); assert.equal(r.items[0].id, id); assert.equal(r.items[0].priority, "broken");
});

test("预筛规范化空白，常见语言保留字不算标识符共变", t => {
  const e = fixture(t);
  e.lines[19] = "return    42;"; e.file("中文.ts", e.lines.join("\n")); const base = e.commit();
  const id = e.memory([{ ...e.ref, quote: "return 42;" }], base);
  e.lines[59] = "return 99;"; e.file("中文.ts", e.lines.join("\n")); e.commit();
  const r = e.scan(); assert.equal(r.enqueued, 0); assert.deepEqual(r.prescreenedIds, [id]);
});

test("同级非祖先基线优先已在目标主干上的核验记录，出错记录不作基线", t => {
  const e = fixture(t);
  e.git("checkout", "-qb", "feature"); e.file("branch-only", "branch\n"); const branch = e.commit();
  const id = e.memory([e.ref], branch);
  e.git("checkout", "main"); e.file("trunk-only", "trunk\n"); const trunk = e.commit();
  intake.recordVerify(e.store.workDb, id, trunk, "verified", e.now);
  assert.equal(e.scan().skipped.same_head, 1);
  intake.recordVerify(e.store.workDb, id, trunk, "error:network", e.now);
  assert.equal(e.scan().shifted, 1, "出错记录被忽略，按非祖先完好分支平移");
});

test("基线取最新祖先记录；无关路径 unchanged；只读 main 不读脏 feature", t => {
  const e = fixture(t); const id = e.memory();
  e.file("other", "one\n"); const newer = e.commit();
  intake.recordVerify(e.store.workDb, id, newer, "shifted", e.now);
  e.git("checkout", "-qb", "test-branch"); e.lines[19] = "const CACHE_LIMIT = 999;"; e.file("中文.ts", e.lines.join("\n"));
  const dirty = e.git("status", "--porcelain=v1");
  const r = e.scan(); assert.equal(r.head, newer); assert.equal(r.skipped.same_head, 1);
  assert.equal(e.git("status", "--porcelain=v1"), dirty);
  intake.recordVerify(e.store.workDb, id, "f".repeat(40), "error:network", e.now);
  assert.equal(e.scan().skipped.unchanged, 1);
});
