import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Store, type Embedder } from "./store.ts";
import { runWork, type WorkDeps } from "./work.ts";
import { upsertSession } from "./intake.ts";
import { buildMessages } from "./extract.ts";
import { buildOnePassMessages, ONE_PASS_SYSTEM } from "./onepass.ts";
import { buildRelateMessages } from "./relate.ts";
import { importPensieve, planImport } from "./pensieve.ts";
import { applyActions } from "./curate.ts";
import { PROMPT_VERSION } from "./topic.ts";
import * as llm from "./llm.ts";
import type { Chat, ChatMessage } from "./llm.ts";
import type { EventRow, RememberBody } from "./l2.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const hash = (s: string) => createHash("sha256").update(s, "utf8").digest("hex").slice(0, 12);
const quote = "以后核验记忆时先检查仓库的当前版本";
const candidate = {
  kind: "pitfall", scope: "project", text: "核验记忆时先检查仓库的当前版本", why: "旧版本的测试结果不能证明当前版本行为", basis: "user_directive",
  evidence: [{ anchor: "#1", role: "user", quote }], relation: { type: "new", target: null },
};
const source = { host: null, session_id: null, transcript: null, anchor: null, summary: "合成来源" };
const embedder: Embedder = Object.assign(async (texts: string[]) => texts.map(() => new Float32Array([1, 0])), { model: "local-fixture" });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ab-prompt-version-"));
  const home = join(dir, "ab");
  const repo = join(dir, "repo");
  const registry = join(dir, "repos");
  mkdirSync(repo);
  mkdirSync(registry);
  const store = new Store(join(home, "store.db"), join(home, "index.db"));
  const pid = store.ensureProject("fixture");
  const get = (id: string) => execFileSync(process.execPath, [join(root, "src/cli.ts"), "get", id], {
    cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, AB_HOME: home, AGENTBRAIN_HOME: home, AB_REGISTRY: registry, HOME: dir, AGENTBRAIN_REVIEWER: "1" },
  });
  const calls: ChatMessage[][] = [];
  const deps = (answer: (messages: ChatMessage[]) => object): WorkDeps => ({
    store, embedder, now: () => new Date(), registry: [{ name: "fixture", path: repo }], registryDir: registry,
    resolveProject: () => null, projectId: () => pid,
    chat: { model: "fixture-model", chat: async (messages) => {
      calls.push(structuredClone(messages));
      return { tokens: 1, message: { role: "assistant", content: JSON.stringify(answer(messages)) } };
    } },
  });
  const register = () => {
    const transcript = join(dir, "session.jsonl");
    writeFileSync(transcript, JSON.stringify({ type: "user", uuid: "u1", message: { role: "user", content: quote } }) + "\n");
    upsertSession(store.workDb, { host: "claude", session_id: "fixture-session", transcript, cwd: repo, ended: true, ephemeral: false, via: "hook" }, () => "fixture", new Date());
  };
  const remember = (extra: Partial<RememberBody> = {}) => store.remember(pid, null, false, { kind: "pitfall", text: candidate.text, source, confirmed: false, origin: "extract", ...extra });
  const events = () => store.workDb.prepare("SELECT * FROM events ORDER BY seq").all() as unknown as EventRow[];
  const f = { dir, home, repo, registry, store, pid, get, deps, calls, register, remember, events,
    close: () => { f.store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
  return f;
}

type Fixture = ReturnType<typeof fixture>;
const labels = { remember: "抽取", evidence: "追加证据", relate: "关系判定", verify: "代码核验" };
function checkOutput(f: Fixture, kind: keyof typeof labels, system: string, model = "fixture-model") {
  const rows = f.events().filter((r) => r.kind === kind);
  assert.ok(rows.length > 0, `${kind} 确实写入 L1`);
  for (const row of rows) {
    const body = JSON.parse(row.body!);
    assert.equal(body.model, model);
    assert.equal(body.prompt_version, hash(system));
    assert.equal(body.topic?.prompt_version, undefined);
    assert.equal(body.topic?.model, undefined);
    const id = kind === "remember" ? row.id : row.target_id!;
    const p = f.store.project().props.get(id)!;
    assert.ok(p.model_outputs.some((o) => o.event_id === row.id && o.kind === kind && o.model === model && o.prompt_version === hash(system)));
    assert.ok(f.get(id).includes(`[${row.id.slice(0, 8)}] ${labels[kind]}: ${model}，提示词版本 ${hash(system)}`));
  }
  for (const row of f.events().filter((r) => r.kind === "archive" || r.kind === "confirm")) {
    const body = JSON.parse(row.body!);
    assert.equal(body.model, undefined);
    assert.equal(body.prompt_version, undefined);
  }
}

const ordinary = () => ({ candidates: [candidate] });
const sys = (calls: ChatMessage[][], marker: string) => calls.find((c) => c[0].content!.includes(marker))![0].content!;

test("§8.8 普通抽取的 L1、L2 与真实 ab get 记录同一模型和实发系统版本", async () => {
  const f = fixture();
  try {
    f.register();
    const report = await runWork(f.deps(ordinary), { sweep: false, dryRun: false });
    assert.equal(report.receipt.proposals, 1);
    checkOutput(f, "remember", sys(f.calls, "记忆抽取器"));
  } finally { f.close(); }
});

test("§8.8 一步式只写顶层版本，运行报告与实发系统版本一致", async () => {
  const f = fixture();
  try {
    f.register();
    const chat: Chat = async (messages) => {
      f.calls.push(structuredClone(messages));
      return { tokens: 1, message: { role: "assistant", content: JSON.stringify({ items: [{ action: "new", kind: "pitfall", class: "C", text: candidate.text, scenario: "当验证代码行为时", why: candidate.why, reason: "避免测错版本" }] }) } };
    };
    const report = await runWork({ ...f.deps(() => ({ results: [] })), topic: { run: "fixture-run", chatFor: () => ({ chat, model: "claude:fixture@max" }) } }, { sweep: false, dryRun: false });
    assert.equal(report.receipt.proposals, 1);
    checkOutput(f, "remember", sys(f.calls, "记忆员"), "claude:fixture@max");
    assert.equal(report.topic!.windows[0].prompt_version, hash(ONE_PASS_SYSTEM));
  } finally { f.close(); }
});

test("§8.8 普通抽取判重复只追加 evidence，版本属于本次抽取", async () => {
  const f = fixture();
  try {
    f.remember({ confirmed: true });
    f.register();
    const report = await runWork(f.deps(() => ({ candidates: [{ ...candidate, relation: { type: "duplicate", target: "m1" } }] })), { sweep: false, dryRun: false });
    assert.equal(report.receipt.attached, 1);
    assert.equal(f.events().filter((r) => r.kind === "remember").length, 1);
    checkOutput(f, "evidence", sys(f.calls, "记忆抽取器"));
  } finally { f.close(); }
});

test("§8.8 work 关系判定记录 relate 和派生 evidence，不给 archive 或 confirm 加模型字段", async () => {
  const f = fixture();
  try {
    f.remember({ kind: "rule", basis: "user_directive", source: { ...source, host: "claude", session_id: "s1" }, evidence: [{ role: "user", anchor: "u1", quote_sha256: "q1" }] });
    f.remember({ kind: "rule", basis: "user_directive", source: { ...source, host: "claude", session_id: "s2" }, evidence: [{ role: "user", anchor: "u2", quote_sha256: "q2" }] });
    const report = await runWork(f.deps(() => ({ results: [{ id: "q1", relation: "duplicate", target: "m1", reason: "同一规则" }] })), { sweep: false, dryRun: false });
    assert.equal(report.relate.duplicate, 1);
    assert.equal(report.relate.corroborated, 1);
    checkOutput(f, "relate", sys(f.calls, "记忆关系判定器"));
    checkOutput(f, "evidence", sys(f.calls, "记忆关系判定器"));
  } finally { f.close(); }
});

test("§8.8 Pensieve 共用关系写入点覆盖正反 relate 和 evidence", async () => {
  const f = fixture();
  try {
    f.remember();
    const dir = join(f.repo, ".pensieve/knowledge");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "fixture.md"), "---\nid: fixture\ntype: knowledge\ntitle: 核验记忆\nstatus: active\n---\n## Summary\n核验记忆时先检查仓库的当前版本\n");
    const deps = f.deps(() => ({ results: [{ id: "q1", relation: "duplicate", target: "m1", reason: "同一记忆" }] }));
    assert.ok(!("error" in deps.chat));
    const report = await importPensieve({ store: f.store, embedder, chat: deps.chat, projectId: () => f.pid, relateSim: 0.7, relateTop: 3, relateBatch: 6 }, planImport([{ root: f.repo, project: "fixture" }], new Map()));
    assert.equal(report.relate.mergedExisting, 1);
    assert.equal(f.events().filter((r) => r.kind === "relate").length, 2);
    checkOutput(f, "relate", sys(f.calls, "记忆关系判定器"));
    checkOutput(f, "evidence", sys(f.calls, "记忆关系判定器"));
  } finally { f.close(); }
});

test("§8.8 代码核验保留原抽取版本，L3 删除重建后展示一致且 L1 字节不变", async () => {
  const f = fixture();
  try {
    execFileSync("git", ["init", "-q", f.repo]);
    writeFileSync(join(f.repo, "proof.txt"), "当前版本需要重新验证\n");
    execFileSync("git", ["-C", f.repo, "add", "."]);
    execFileSync("git", ["-C", f.repo, "-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "fixture"]);
    f.register();
    await runWork(f.deps(ordinary), { sweep: false, dryRun: false });
    const id = f.events()[0].id;
    const extraction = JSON.parse(f.events()[0].body!);
    const deps = f.deps(() => ({ verdict: "verified", evidence: [{ path: "proof.txt", line_start: 1, line_end: 1, quote: "当前版本需要重新验证" }] }));
    const report = await runWork({ ...deps, embedder: null }, { sweep: true, dryRun: false });
    assert.equal(report.verify.verified, 1);
    checkOutput(f, "verify", sys(f.calls, "代码核验员"));
    checkOutput(f, "remember", sys(f.calls, "记忆抽取器"));
    assert.notEqual(extraction.prompt_version, JSON.parse(f.events().find((r) => r.kind === "verify")!.body!).prompt_version);
    const before = f.get(id).split("模型产出记录:\n")[1].split("相关")[0];
    const l1 = JSON.stringify(f.events());
    f.store.close();
    for (const suffix of ["", "-wal", "-shm"]) rmSync(join(f.home, `index.db${suffix}`), { force: true });
    const reopened = new Store(join(f.home, "store.db"), join(f.home, "index.db"));
    f.store = reopened;
    assert.equal(reopened.search("核验记忆", { projects: "all", includeGlobal: true }).length, 1);
    assert.equal(f.get(id).split("模型产出记录:\n")[1].split("相关")[0], before);
    assert.equal(JSON.stringify(reopened.workDb.prepare("SELECT * FROM events ORDER BY seq").all()), l1);
  } finally { f.close(); }
});

test("§8.8 旧事件缺字段显示未记录，旧 topic 版本保留原值，顶层字段优先", () => {
  const f = fixture();
  try {
    const old = f.remember();
    const topic = { run: "old", window_id: "w", trigger: "idle" as const, from: null, to: "u1", part: null, prompt_version: "1afa045d9d7c", model: "claude:old@max", class: "C" as const };
    const legacy = f.remember({ topic });
    const modern = f.remember({ topic, model: "new", prompt_version: "0123456789ab" });
    assert.ok(f.get(old).includes(`[${old.slice(0, 8)}] 抽取: 未记录，提示词版本 未记录`));
    assert.ok(f.get(legacy).includes("抽取: claude:old@max，提示词版本 1afa045d9d7c"));
    assert.ok(f.get(modern).includes("抽取: new，提示词版本 0123456789ab"));
    const verify = f.store.commit([{ kind: "verify", project_id: f.pid, session_id: null, target_id: old, body: { outcome: "verified", head: "old", refs: [], model: "old-verifier" } }], () => {});
    assert.ok(f.get(old).includes(`[${verify[0].slice(0, 8)}] 代码核验: old-verifier，提示词版本 未记录`));
  } finally { f.close(); }
});

test("§8.8 curate 改写不写模型元数据，真实 ab get 显示未记录且正常退出", () => {
  const f = fixture();
  try {
    const original = f.remember();
    const applied = applyActions(f.store, "curate-fixture", [{ op: "rewrite", id: original, text: "核验前先确认当前分支的代码版本", scenario: "当检查记忆是否仍成立时", guidance: false }], f.store.project().props);
    const id = applied[0].created!;
    const row = f.events().find((r) => r.id === id)!;
    const body = JSON.parse(row.body!);
    assert.equal(body.origin, "curate");
    assert.equal(body.model, undefined);
    assert.equal(body.prompt_version, undefined);
    assert.ok(f.get(id).includes(`[${id.slice(0, 8)}] 抽取: 未记录，提示词版本 未记录`));
  } finally { f.close(); }
});

test("§8.8 普通抽取与一步式的模型失败、空结论和非法输出不补造 L1 事件", async () => {
  for (const topic of [false, true]) {
    for (const result of ["failure", "empty", "invalid"] as const) {
      const f = fixture();
      try {
        f.register();
        const deps = f.deps(() => {
          if (result === "failure") throw new llm.WorkFailure("network", "fixture failure");
          return result === "empty" ? { candidates: [], items: [] } : {};
        });
        assert.ok(!("error" in deps.chat));
        if (topic) deps.topic = { run: "empty", chatFor: () => { assert.ok(!("error" in deps.chat)); return deps.chat; } };
        await runWork(deps, { sweep: false, dryRun: false });
        assert.equal(f.events().length, 0);
      } finally { f.close(); }
    }
  }
});

test("§8.8 关系模型失败或目标编号非法，不补造 relate、evidence 或 archive", async () => {
  for (const fails of [true, false]) {
    const f = fixture();
    try {
      f.remember({ confirmed: true });
      f.remember();
      const before = JSON.stringify(f.events());
      const report = await runWork(f.deps(() => {
        if (fails) throw new llm.WorkFailure("network", "fixture relation failure");
        return { results: [{ id: "q1", relation: "duplicate", target: "m999" }] };
      }), { sweep: false, dryRun: false });
      assert.equal(report.relate.errors, 1);
      assert.equal(JSON.stringify(f.events()), before);
    } finally { f.close(); }
  }
});

test("§8.8 核验失败、证据不符或无确定结论，不补造 verify", async () => {
  for (const outcome of ["failure", "bad-evidence", "not_verifiable", "inconclusive"] as const) {
    const f = fixture();
    try {
      execFileSync("git", ["init", "-q", f.repo]);
      writeFileSync(join(f.repo, "proof.txt"), "当前版本需要重新验证\n");
      execFileSync("git", ["-C", f.repo, "add", "."]);
      execFileSync("git", ["-C", f.repo, "-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "fixture"]);
      f.remember();
      const before = JSON.stringify(f.events());
      const deps = f.deps(() => {
        if (outcome === "failure") throw new llm.WorkFailure("network", "fixture verify failure");
        return outcome === "bad-evidence"
          ? { verdict: "verified", evidence: [{ path: "proof.txt", line_start: 1, line_end: 1, quote: "编造的代码证据" }] }
          : { verdict: outcome, evidence: [] };
      });
      const report = await runWork({ ...deps, embedder: null }, { sweep: true, dryRun: false });
      assert.equal(report.verify.verified, 0);
      assert.equal(report.verify.errors + report.verify.inconclusive + report.verify.not_verifiable, 1);
      assert.equal(JSON.stringify(f.events()), before);
    } finally { f.close(); }
  }
});

test("§8.8 版本按 UTF-8 全文计算，不 trim，改一个字符或追加段就变", () => {
  for (const text of [" 系统提示词\n", "系统提示词", "系统提示词。", "系统提示词\n额外规则"]) assert.equal(llm.promptVersion(text), hash(text));
  assert.equal(new Set([" 系统提示词\n", "系统提示词", "系统提示词。", "系统提示词\n额外规则"].map(llm.promptVersion)).size, 4);
  assert.equal(PROMPT_VERSION, hash(ONE_PASS_SYSTEM));
});

test("§8.8 同一系统提示重启不变，只换会话或项目正文不变", () => {
  const ctx = { name: "fixture", docs: "文档甲", registry: "档案甲", confirmed: "" };
  for (const build of [buildMessages, buildOnePassMessages]) {
    const a = build({ turns: [{ role: "user", anchor: "a", text: "正文甲" }], context: [] }, ctx, []);
    const b = build({ turns: [{ role: "user", anchor: "b", text: "正文乙" }], context: [], worker: true }, { ...ctx, docs: "文档乙", registry: "档案乙" }, []);
    assert.equal(hash(a[0].content!), hash(b[0].content!));
    assert.notEqual(a[1].content, b[1].content);
  }
  const prop = { text: "正文甲", kind: "rule", confirmed: false } as const;
  const itemA = { prop: { ...prop, id: "a" }, neighbors: [] };
  const itemB = { prop: { ...prop, id: "b", text: "正文乙" }, neighbors: [] };
  const aRelate = buildRelateMessages([itemA as unknown as Parameters<typeof buildRelateMessages>[0][number]]);
  const bRelate = buildRelateMessages([itemB as unknown as Parameters<typeof buildRelateMessages>[0][number]]);
  assert.equal(hash(aRelate[0].content!), hash(bRelate[0].content!));
  assert.notEqual(aRelate[1].content, bRelate[1].content);
  const script = "import { PROMPT_VERSION } from './src/topic.ts'; import { EXTRACT_PROMPT_VERSION } from './src/extract.ts'; import { RELATE_PROMPT_VERSION } from './src/relate.ts'; import { VERIFY_PROMPT_VERSION } from './src/codeverify.ts'; console.log(JSON.stringify([PROMPT_VERSION, EXTRACT_PROMPT_VERSION, RELATE_PROMPT_VERSION, VERIFY_PROMPT_VERSION]))";
  const a = execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd: root, encoding: "utf8" });
  const b = execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd: root, encoding: "utf8" });
  const versions = JSON.parse(a);
  assert.equal(versions[0], hash(ONE_PASS_SYSTEM));
  assert.equal(versions[1], hash(buildMessages({ turns: [], context: [] }, ctx, [])[0].content!));
  assert.equal(versions[2], hash(aRelate[0].content!));
  assert.match(versions[3], /^[a-f0-9]{12}$/);
  assert.equal(b, a);
});
