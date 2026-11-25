import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.ts";
import * as intake from "./intake.ts";
import type { ChatMessage } from "./llm.ts";

const CLI = join(import.meta.dirname, "cli.ts");

for (const suite of ["ab-1", "ab-2"]) test(`${suite} 真实 CLI：stale 确认与变更重核`, async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ab1-cli-")));
  const home = join(dir, "home"), ab = join(dir, "ab"), repos = join(dir, "pm/repos"), repo = join(dir, "repo"), bin = join(dir, "bin");
  for (const p of [home, ab, repos, repo, bin]) mkdirSync(p, { recursive: true });
  writeFileSync(join(repos, "testrepo.md"), `- 路径：\`${repo}\`\n`);
  writeFileSync(join(bin, "security"), '#!/bin/sh\ncase "$*" in *agentbrain-extract*|*agentbrain-embedding*) printf fixture-key;; *) exit 1;; esac\n');
  chmodSync(join(bin, "security"), 0o755);
  const env = { ...process.env, HOME: home, AB_HOME: ab, AGENTBRAIN_HOME: ab, AB_REGISTRY: repos, PATH: `${bin}:${process.env.PATH}`, PI_SESSION_ID: "ab1-fixture", PI_SESSION_FILE: "", PI_INTERCOM_SESSION_ID: "", CLAUDE_SESSION_ID: "", CODEX_SESSION_ID: "", NODE_OPTIONS: "", GEMINI_HOME: "", ANTIGRAVITY_APP_DATA_DIR: "", ANTIGRAVITY_CONVERSATION_ID: "" };
  const evidence = process.env.AB1_EVIDENCE;
  if (evidence) mkdirSync(evidence, { recursive: true });
  const logs: string[] = [];
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { env, encoding: "utf8" });
  git("init", "-q");
  writeFileSync(join(repo, "中文.ts"), "const CACHE_LIMIT = 42;\n");
  git("add", "."); git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "目标缓存限制");
  git("branch", "target");
  const target = git("rev-parse", "HEAD").trim();
  git("checkout", "-qb", "other");
  writeFileSync(join(repo, "中文.ts"), "const CACHE_LIMIT = 99;\n");
  git("add", "."); git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "另一分支");
  writeFileSync(join(repo, "中文.ts"), "const CACHE_LIMIT = 999;\n");
  const current = git("rev-parse", "HEAD").trim(), dirty = git("status", "--porcelain=v1");
  let verdict = "verified", quote = "CACHE_LIMIT = 42", httpStatus = 200;
  const requests: { messages: ChatMessage[] }[] = [];
  const server = createServer(async (req, res) => {
    assert.equal(req.url, "/v1/chat/completions");
    let body = "";
    for await (const chunk of req) body += chunk;
    const payload: { messages: ChatMessage[] } = JSON.parse(body);
    requests.push(payload);
    if (httpStatus !== 200) { res.writeHead(httpStatus); res.end("fixture model failure"); return; }
    const tools = payload.messages.filter(m => m.role === "tool");
    const message: ChatMessage = tools.length ? { role: "assistant", content: JSON.stringify({ verdict, evidence: [{ path: "中文.ts", line_start: 1, quote }] }) }
      : { role: "assistant", content: null, tool_calls: [{ id: "read", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "中文.ts" }) } }] };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ choices: [{ message }], usage: { total_tokens: 10 } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  writeFileSync(join(ab, "extract.json"), JSON.stringify({ baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "ab1-fixture" }));
  const run = async (...args: string[]) => {
    const r = await new Promise<{ status: number | null; out: string; err: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [CLI, ...args], { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] });
      let out = "", err = "";
      child.stdout.on("data", b => out += b); child.stderr.on("data", b => err += b);
      child.on("error", reject); child.on("close", status => resolve({ status, out, err }));
    });
    logs.push(`node ${CLI} ${args.join(" ")}\nexit ${r.status}\n${r.out}${r.err}`);
    return r;
  };
  const ok = async (...args: string[]) => { const r = await run(...args); assert.equal(r.status, 0, r.err); return r.out; };
  const remember = async (kind: string, text: string, confirmed = false, global = false) => {
    const out = await ok("remember", "--kind", kind, "--text", text, "--summary", "stale 回归", ...(confirmed ? ["--confirmed"] : []), ...(global ? ["--global"] : []));
    const id = /已记住 \[([0-9a-f]{8})\]/.exec(out)?.[1]; assert.ok(id); return id;
  };
  const store = new Store(join(ab, "store.db"), join(ab, "index.db"));
  const prop = (prefix: string) => { const p = [...store.project().props.values()].find(p => p.id.startsWith(prefix)); assert.ok(p); return p; };
  const stale = (id: string) => {
    const p = prop(id);
    store.commit([{ kind: "verify", project_id: p.project_id, session_id: null, target_id: p.id, body: { outcome: "contradicted", head: current, refs: [], model: "fixture" } }], () => {});
    store.queueReverify([p.id], new Date());
  };
  try {
    if (suite === "ab-2") {
    await t.test("ab-2 真实 CLI：扫描、预演、JSON、租约、3 条消费和主干确认", async () => {
      writeFileSync(join(repos, "testrepo.md"), `- 路径：\`${repo}\`\n- 主干：\`target\`\n`);
      const ids: string[] = [];
      try {
        for (let i = 0; i < 5; i++) {
          const id = await remember("decision", `ab2 缓存限制决定 ${i}`);
          await ok("verify", id, "--ref", "target"); ids.push(prop(id).id);
        }
        git("update-ref", "refs/heads/target", current);
        const before = requests.length;
        const dry = JSON.parse(await ok("verify", "--changed", "testrepo", "--dry-run", "--json"));
        assert.equal(dry.head, current); assert.equal(dry.trunkRef, "target");
        assert.equal(dry.hits, 5); assert.equal(dry.enqueued, 5);
        assert.equal(intake.queuedReverify(store.workDb).size, 0);
        assert.equal(requests.length, before);
        const holder = intake.acquireLease(store.workDb, new Date()); assert.ok(holder);
        try {
          const busy = await run("verify", "--changed", "testrepo", "--run");
          assert.notEqual(busy.status, 0); assert.match(busy.err, /忙|运行|租约/);
          assert.equal(intake.queuedReverify(store.workDb).size, 0);
        } finally { intake.releaseLease(store.workDb, holder); }
        const queued = JSON.parse(await ok("verify", "--changed", "testrepo", "--json"));
        assert.equal(queued.enqueued, 5); assert.equal(intake.queuedReverify(store.workDb).size, 5);
        assert.equal(requests.length, before);
        const otherPid = store.ensureProject("other");
        const other = store.remember(otherPid, null, false, { kind: "decision", text: "其他项目决定", confirmed: false, source: { host: null, session_id: null, transcript: null, anchor: null, summary: "fixture" } });
        store.queueReverify([other], new Date());
        quote = "CACHE_LIMIT = 99";
        const first = JSON.parse(await ok("verify", "--changed", "testrepo", "--run", "--json"));
        assert.equal(first.run.verified, 3);
        assert.equal(ids.filter(id => intake.lastVerify(store.workDb, id)?.head === current).length, 3);
        assert.equal(ids.filter(id => intake.queuedReverify(store.workDb).has(id)).length, 2);
        assert.equal(intake.queuedReverify(store.workDb).has(other), true);
        assert.ok(requests.slice(before).filter(r => r.messages.some(m => m.role === "tool")).every(r => r.messages.filter(m => m.role === "tool").some(m => /99/.test(m.content ?? "") && !/999/.test(m.content ?? ""))));
        httpStatus = 500;
        const failed = JSON.parse(await ok("verify", "--changed", "testrepo", "--run", "--json"));
        assert.equal(failed.run.errors, 2);
        assert.equal(ids.filter(id => intake.queuedReverify(store.workDb).has(id)).length, 2);
        assert.equal(store.workDb.prepare("SELECT count(*) AS n FROM work_lease").get()!.n, 0);
        httpStatus = 200;
        const second = JSON.parse(await ok("verify", "--changed", "testrepo", "--run", "--json")); assert.equal(second.run.verified, 2);
        assert.ok(ids.every(id => prop(id).confirmed === false));
        assert.equal(store.workDb.prepare("SELECT count(*) AS n FROM work_lease").get()!.n, 0);
        intake.dequeueReverify(store.workDb, other);
        git("update-ref", "refs/heads/target", target);
        const explicit = await remember("decision", "ab2 显式 ref 无证据决定");
        ids.push(prop(explicit).id); store.queueReverify([prop(explicit).id], new Date());
        const explicitRun = JSON.parse(await ok("verify", "--changed", "testrepo", "--ref", "other", "--run", "--json"));
        assert.equal(explicitRun.head, current); assert.equal(explicitRun.run.verified, 1);
        assert.equal(prop(explicit).code_evidence?.head, current); assert.equal(prop(explicit).confirmed, false);
        const confirmation = await remember("decision", "ab2 主干确认"); stale(confirmation);
        await ok("confirm", confirmation);
        assert.equal(intake.lastVerify(store.workDb, prop(confirmation).id)?.head, target);
        assert.equal(intake.queuedReverify(store.workDb).has(prop(confirmation).id), false);
        const output = await ok("verify", "--changed", "testrepo", "--dry-run");
        for (const label of ["trunk-ref", "命中", "跳过", "平移", "预筛", "入队", "截"]) assert.ok(output.includes(label), label);
        const snapshot = JSON.stringify(store.workDb.prepare("SELECT * FROM verify_attempts ORDER BY prop_id").all());
        await ok("verify", "--changed", "testrepo", "--ref", "target", "--dry-run", "--json");
        assert.equal(JSON.stringify(store.workDb.prepare("SELECT * FROM verify_attempts ORDER BY prop_id").all()), snapshot);
      } finally {
        git("update-ref", "refs/heads/target", target); quote = "CACHE_LIMIT = 42"; httpStatus = 200;
        writeFileSync(join(repos, "testrepo.md"), `- 路径：\`${repo}\`\n`);
        for (const id of ids) { intake.dequeueReverify(store.workDb, id); store.lifecycle("archive", id, null); }
      }
    });
    await t.test("ab-2 真实 CLI：错误参数、缺项目、缺路径、无效 ref 单行拒绝", async () => {
      for (const args of [["--run"], ["--dry-run"], ["--json"], ["--changed"], ["--changed", "testrepo", "--run", "--dry-run"], ["--changed", "missing"], ["--changed", "testrepo", "--ref=missing"], ["--changed", "testrepo", "--ref=-invalid"], ["--changed", "testrepo", "--ref=bad ref"]]) {
        const before = requests.length;
        const r = await run("verify", ...args);
        assert.notEqual(r.status, 0, args.join(" "));
        assert.equal(r.err.trim().split("\n").length, 1, r.err);
        assert.doesNotMatch(r.err, /\n\s+at |Node\.js v/); assert.equal(requests.length, before);
      }
      const id = await remember("decision", "ab2 无目录确认"); stale(id);
      writeFileSync(join(repos, "testrepo.md"), `- 路径：\`${join(dir, "missing-repo")}\`\n`);
      try {
        const r = await run("verify", "--changed", "testrepo", "--ref", "target");
        assert.notEqual(r.status, 0); assert.match(r.err, /仓库.*不可用/); assert.equal(r.err.trim().split("\n").length, 1);
        await ok("confirm", id);
        assert.equal(intake.queuedReverify(store.workDb).has(prop(id).id), false);
      } finally { writeFileSync(join(repos, "testrepo.md"), `- 路径：\`${repo}\`\n`); }
    });
    await t.test("ab-2 真实 CLI：证据不足退避到期后重查删除与断裂，非法路径单条隔离", async () => {
      git("checkout", "-f", "target");
      writeFileSync(join(repo, "deleted.ts"), "const CACHE_LIMIT = 42;\n");
      git("add", "."); git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "H1 evidence");
      const h1 = git("rev-parse", "HEAD").trim();
      const ids: string[] = [];
      for (const path of ["deleted.ts", "中文.ts"]) {
        const id = prop(await remember("decision", `ab2 退避重查 ${path}`)).id;
        ids.push(id);
        store.commit([{ kind: "verify", project_id: prop(id).project_id, session_id: null, target_id: id, body: { outcome: "verified", head: h1, refs: [{ path, line_start: 1, line_end: 1, quote: "CACHE_LIMIT = 42" }] } }], () => {});
      }
      rmSync(join(repo, "deleted.ts"));
      writeFileSync(join(repo, "中文.ts"), "const CACHE_LIMIT = 99;\n");
      git("add", "."); git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "H2 invalidates evidence");
      const h2 = git("rev-parse", "HEAD").trim();
      verdict = "inconclusive";
      const attempt = JSON.parse(await ok("verify", "--changed", "testrepo", "--run", "--json"));
      assert.equal(attempt.run.inconclusive, 2);
      for (const id of ids.slice(0, 2)) {
        assert.equal(intake.lastVerify(store.workDb, id)?.outcome, "inconclusive:1");
        assert.equal(prop(id).code_evidence?.head, h1);
        intake.recordVerify(store.workDb, id, h2, "inconclusive:1", new Date(Date.now() - 2 * 86_400_000));
      }
      writeFileSync(join(repo, "unrelated"), "H3\n");
      git("add", "."); git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "H3 unrelated");
      const h3 = git("rev-parse", "HEAD").trim(), before = requests.length;
      writeFileSync(join(repo, "中文.ts"), "const CACHE_LIMIT = 999;\n");
      const dirty = git("status", "--porcelain=v1");
      for (const dryRun of [true, false]) {
        const r = JSON.parse(await ok("verify", "--changed", "testrepo", ...(dryRun ? ["--dry-run"] : []), "--json"));
        assert.equal(r.head, h3);
        assert.deepEqual(r.items.map((item: { id: string; priority: string }) => [item.id, item.priority]), [[ids[0], "deleted"], [ids[1], "broken"]]);
        assert.equal(r.skipped.untracked_path, 0);
        assert.equal(r.skipped.unchanged, 0);
        for (const id of ids) assert.equal(intake.queuedReverify(store.workDb).has(id), !dryRun);
        assert.equal(requests.length, before);
        assert.equal(git("rev-parse", "HEAD").trim(), h3);
        assert.equal(git("status", "--porcelain=v1"), dirty);
        assert.equal(readFileSync(join(repo, "中文.ts"), "utf8"), "const CACHE_LIMIT = 999;\n");
      }
      for (const id of ids) intake.dequeueReverify(store.workDb, id);
      const invalid = prop(await remember("decision", "ab2 非法路径隔离")).id;
      store.commit([{ kind: "verify", project_id: prop(invalid).project_id, session_id: null, target_id: invalid, body: { outcome: "verified", head: h1, refs: [{ path: "-dash.ts", line_start: 1, line_end: 1, quote: "CACHE_LIMIT = 42" }] } }], () => {});
      const mixed = JSON.parse(await ok("verify", "--changed", "testrepo", "--json"));
      assert.equal(mixed.skipped.untracked_path, 1);
      assert.deepEqual(mixed.items.map((item: { id: string; priority: string }) => [item.id, item.priority]), [[ids[0], "deleted"], [ids[1], "broken"]]);
      assert.equal(intake.queuedReverify(store.workDb).has(invalid), false);
    });
    } else {
    for (const mode of ["rule", "archived"]) {
      await t.test(`ab verify 拒绝 ${mode}`, async () => {
        const id = await remember(mode === "rule" ? "rule" : "pitfall", `不可核验${mode}`);
        if (mode === "archived") await ok("archive", id);
        const before = requests.length;
        const r = await run("verify", id, "--ref", "target");
        assert.notEqual(r.status, 0);
        assert.match(r.err, mode === "rule" ? /规则不走代码核验/ : /只能核验仍有效的记忆.*archived/);
        assert.equal(requests.length, before);
        assert.equal(prop(id).confirmed, false);
        assert.equal(intake.lastVerify(store.workDb, prop(id).id), undefined);
      });
    }
    await t.test("ab verify 拒绝被未确认纠正替代的旧草稿", async () => {
      const pid = store.ensureProject("testrepo");
      const old = store.remember(pid, null, false, { kind: "pitfall", text: "不可复活的旧草稿", origin: "extract", confirmed: false, source: { host: null, session_id: null, transcript: null, anchor: null, summary: "回归" } });
      const newer = /已纠正 \[([0-9a-f]{8})\]/.exec(await ok("correct", old.slice(0, 8), "--text", "未确认的替代草稿", "--summary", "回归"))?.[1];
      assert.ok(newer);
      assert.equal(prop(newer).project_id, pid);
      assert.equal(prop(newer).confirmed, false);
      assert.equal(prop(old).superseded_draft, prop(newer).id);
      const before = requests.length;
      const r = await run("verify", old.slice(0, 8));
      assert.notEqual(r.status, 0);
      assert.ok(r.err.includes(`已被草稿 ${newer} 替代的旧草稿不走代码核验；先归档替代草稿或核验新草稿`));
      assert.equal(requests.length, before);
      assert.equal(prop(old).confirmed, false);
      assert.equal(prop(old).superseded_draft, prop(newer).id);
      assert.equal(intake.lastVerify(store.workDb, old), undefined);
      assert.doesNotMatch(await ok("brief"), /不可复活的旧草稿/);
    });
    for (const mode of ["supersedes", "unreconciled", "demoted"]) {
      await t.test(`ab verify 对 ${mode} 只核验不自动转正`, async () => {
        const pid = store.ensureProject("testrepo");
        const old = store.remember(pid, null, false, { kind: "pitfall", text: "退场草稿", origin: "extract", confirmed: false, source: { host: null, session_id: null, transcript: null, anchor: null, summary: "回归" } });
        const id = mode === "supersedes"
          ? /已纠正 \[([0-9a-f]{8})\]/.exec(await ok("correct", old.slice(0, 8), "--text", "缓存限制纠正", "--summary", "回归"))?.[1]
          : store.remember(pid, null, false, { kind: "pitfall", text: `缓存限制${mode}`, confirmed: false, unreconciled: mode === "unreconciled", source: { host: null, session_id: null, transcript: null, anchor: null, summary: "回归" } });
        assert.ok(id);
        if (mode === "demoted") store.lifecycle("unconfirm", prop(id).id, null, { reason: "worker_prompt" });
        const out = await ok("verify", id.slice(0, 8), "--ref", "target");
        assert.equal(prop(id).confirmed, false);
        assert.equal(prop(id).confirmed_by, null);
        assert.match(out, /不自动转正/);
        assert.equal(prop(id).code_evidence?.head ?? null, mode === "demoted" ? null : target);
        assert.equal(intake.lastVerify(store.workDb, prop(id).id)?.outcome, "verified");
        if (mode === "supersedes") assert.equal(prop(old).superseded_draft, prop(id).id);
      });
    }
    const errorsId = await remember("decision", "核验失败场景");
    for (const ref of ["missing", "-invalid", "bad ref"]) {
      await t.test(`ab verify ref 错误不输出堆栈：${ref}`, async () => {
        const r = await run("verify", errorsId, `--ref=${ref}`);
        assert.notEqual(r.status, 0);
        assert.match(r.err, /--ref/);
        assert.equal(r.err.trim().split("\n").length, 1);
        assert.doesNotMatch(r.err, /\n\s+at |Node\.js v/);
      });
    }
    await t.test("ab verify 仓库目录缺失不输出堆栈", async () => {
      writeFileSync(join(repos, "testrepo.md"), `- 路径：\`${join(dir, "missing-repo")}\`\n`);
      try {
        const r = await run("verify", errorsId);
        assert.notEqual(r.status, 0);
        assert.match(r.err, /仓库.*不可用/);
        assert.equal(r.err.trim().split("\n").length, 1);
        assert.doesNotMatch(r.err, /\n\s+at |Node\.js v/);
      } finally { writeFileSync(join(repos, "testrepo.md"), `- 路径：\`${repo}\`\n`); }
    });
    await t.test("ab verify --ref HEAD 优先报告仓库目录缺失", async () => {
      writeFileSync(join(repos, "testrepo.md"), `- 路径：\`${join(dir, "missing-repo")}\`\n`);
      try {
        const before = requests.length;
        const r = await run("verify", errorsId, "--ref", "HEAD");
        assert.notEqual(r.status, 0);
        assert.match(r.err, /本地项目仓库不可用/);
        assert.doesNotMatch(r.err, /无法解析 --ref/);
        assert.equal(requests.length, before);
      } finally { writeFileSync(join(repos, "testrepo.md"), `- 路径：\`${repo}\`\n`); }
    });
    await t.test("ab verify 模型 HTTP 500 不输出堆栈", async () => {
      httpStatus = 500;
      try {
        const r = await run("verify", errorsId, "--ref", "target");
        assert.notEqual(r.status, 0);
        assert.match(r.err, /核验失败.*500/);
        assert.equal(r.err.trim().split("\n").length, 1);
        assert.doesNotMatch(r.err, /\n\s+at |Node\.js v/);
      } finally { httpStatus = 200; }
    });
    await t.test("ab verify 证据不足从 1 次递增到 2 次", async () => {
      verdict = "inconclusive";
      try {
        for (const n of [1, 2]) {
          await ok("verify", errorsId, "--ref", "target");
          assert.equal(intake.lastVerify(store.workDb, prop(errorsId).id)?.outcome, `inconclusive:${n}`);
        }
      } finally { verdict = "verified"; }
    });
    const matrix: { id: string; trust: string | null }[] = [];
    for (const trust of ["user", "corroboration", "code", null]) {
      const id = await remember("rule", `缓存守卫规则${trust ?? "未确认"}`, trust === "user", true);
      if (trust && trust !== "user") store.lifecycle("confirm", prop(id).id, null, { by: trust });
      await ok("guidance", id);
      stale(id);
      matrix.push({ id, trust });
    }
    const matrixBrief = await ok("brief");
    const matrixRecall = await ok("recall", "缓存守卫规则");
    const matrixStatus = await ok("status");
    assert.match(matrixBrief, /与代码不符 2 条/);
    assert.match(matrixStatus, /与代码不符 2 条（待用户核实）/);
    for (const { id, trust } of matrix) {
      const warning = trust === "user" || trust === "corroboration";
      const text = prop(id).text;
      assert.equal(matrixBrief.includes(text), warning);
      assert.equal(matrixRecall.includes(text), warning);
      if (warning) {
        assert.ok(matrixBrief.includes(`[与代码不符@${current.slice(0, 7)}，待用户核实] ${text}`));
        assert.ok(matrixRecall.includes(`[与代码不符@${current.slice(0, 7)}，待用户核实] ${text}`));
      }
      assert.equal(Number(store.workDb.prepare("SELECT count(*) AS n FROM inject_log WHERE path='brief' AND prop_id=?").get(prop(id).id)!.n) > 0, warning);
      await ok("archive", id);
    }
    for (const confirmed of [false, true]) {
      const id = await remember("pitfall", `stale确认${confirmed}`, confirmed);
      stale(id);
      assert.match(await ok("confirm", id), /清除.*与代码不符/);
      assert.equal(prop(id).stale, null); assert.equal(prop(id).confirmed_by, "user");
      assert.equal(intake.lastVerify(store.workDb, prop(id).id)?.head, current);
      assert.equal(intake.lastVerify(store.workDb, prop(id).id)?.outcome, "verified");
      assert.ok(!intake.queuedReverify(store.workDb).has(prop(id).id));
      assert.match(await ok("confirm", id), /已是确认状态/);
    }
    const id = await remember("decision", "缓存限制决定");
    stale(id);
    assert.match(await ok("verify", id, "--ref", "target"), /不自动转正/);
    assert.equal(prop(id).confirmed, false); assert.equal(prop(id).confirmed_by, null);
    assert.equal(prop(id).code_evidence?.head, target); assert.equal(prop(id).stale, null);
    assert.equal(intake.lastVerify(store.workDb, prop(id).id)?.head, target);
    assert.ok(!intake.queuedReverify(store.workDb).has(prop(id).id));
    assert.match(requests.at(-1)!.messages.find(m => m.role === "tool")!.content!, /42/);
    const calls = requests.length;
    await ok("verify", id, "--ref", "target"); assert.ok(requests.length > calls, "同 head 强制重核");
    verdict = "contradicted"; quote = "CACHE_LIMIT = 999";
    await ok("verify", id);
    assert.equal(prop(id).stale?.head, current); assert.equal(prop(id).confirmed, false);
    for (const outcome of ["not_verifiable", "inconclusive"]) {
      verdict = outcome;
      store.queueReverify([prop(id).id], new Date());
      await ok("verify", id, "--ref", "target");
      const recorded = intake.lastVerify(store.workDb, prop(id).id)?.outcome;
      if (outcome === "inconclusive") assert.match(recorded!, /^inconclusive:/);
      else assert.equal(recorded, outcome);
      assert.ok(!intake.queuedReverify(store.workDb).has(prop(id).id));
      assert.equal(prop(id).stale?.head, current);
    }
    const g = await remember("rule", "全局不可核验", true, true);
    assert.match((await run("verify", g)).err, /全局记忆/);
    assert.equal(JSON.parse(await ok("verify", "--changed", "testrepo", "--dry-run", "--json")).project, "testrepo");
    assert.notEqual((await run("verify", id, "--ref", "missing")).status, 0);
    rmSync(join(ab, "extract.json"));
    assert.match((await run("verify", id)).err, /模型.*不可用|模型.*配置/);
    const old = store.remember(prop(id).project_id, null, false, { kind: "pitfall", text: "自动旧草稿", origin: "extract", confirmed: false, source: { host: null, session_id: null, transcript: null, anchor: null, summary: "回归" } });
    const newer = /已纠正 \[([0-9a-f]{8})\]/.exec(await ok("correct", old.slice(0, 8), "--text", "新草稿", "--summary", "回归"))?.[1]; assert.ok(newer);
    assert.equal(prop(old).superseded_draft, prop(newer).id);
    assert.match(await ok("search", "自动旧草稿"), /已被草稿/);
    assert.match(await ok("get", old.slice(0, 8)), /已被草稿.*替代/);
    assert.match(await ok("get", old.slice(0, 8)), /ab archive.*ab confirm/);
    const pendingBefore = await ok("brief"); assert.doesNotMatch(pendingBefore, /自动旧草稿/);
    await ok("recall", "自动旧草稿"); await ok("status");
    await ok("archive", newer);
    assert.equal(prop(old).superseded_draft, null);
    assert.doesNotMatch(await ok("get", old.slice(0, 8)), /已被草稿/);
    await ok("archive", newer, "--reactivate");
    assert.equal(prop(old).superseded_draft, prop(newer).id);
    await ok("correct", newer, "--text", "用户确认的最终草稿", "--summary", "三段替代链", "--confirmed");
    assert.equal(prop(newer).state, "superseded");
    assert.equal(prop(old).superseded_draft, null, "非 active 替代草稿不能继续隐藏旧条目");
    assert.deepEqual(prop(old).pending_corrections, [prop(newer).id]);
    assert.doesNotMatch(await ok("get", old.slice(0, 8)), /已被草稿/);
    assert.match(await ok("search", "自动旧草稿"), /自动旧草稿/);
    assert.equal(git("rev-parse", "HEAD").trim(), current); assert.equal(git("status", "--porcelain=v1"), dirty);
    assert.equal(readFileSync(join(repo, "中文.ts"), "utf8"), "const CACHE_LIMIT = 999;\n");
    }
    logs.push(JSON.stringify({ verify_attempts: store.workDb.prepare("SELECT * FROM verify_attempts").all(), inject_log: store.workDb.prepare("SELECT * FROM inject_log").all(), verify_queue: store.workDb.prepare("SELECT * FROM verify_queue").all(), projection: [...store.project().props.values()], git: { target, current, dirty }, schema: store.schema }, null, 2));
  } finally {
    if (evidence) { writeFileSync(join(evidence, "cli-e2e.log"), logs.join("\n")); writeFileSync(join(evidence, "mock-requests.json"), JSON.stringify(requests, null, 2)); }
    store.close(); await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); rmSync(dir, { recursive: true, force: true });
  }
});
