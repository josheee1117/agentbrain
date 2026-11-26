import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.ts";
import { brief } from "./brief.ts";
import { buildViewData, renderHtml } from "./view.ts";
import type { Chat, ChatMessage } from "./llm.ts";
import type { RegistryEntry } from "./registry.ts";
import {
  SYNTH_DRAFT_HINTS_MAX,
  SYNTH_EXISTING_MAX,
  SYNTH_MAX_CANDIDATES,
  SYNTH_PROMPT_VERSION,
  SYNTH_SPEC_MAX_CHARS,
  synthesizeProject,
} from "./synthesize.ts";

const CLI = join(import.meta.dirname, "cli.ts");
const SRC = { host: "pi" as const, session_id: "s0", transcript: null, anchor: null, summary: "测试" };

function setupSandbox(t: { after: (fn: () => void) => void }) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ab4-synth-")));
  const home = join(dir, "home");
  const ab = join(dir, "ab");
  const repos = join(dir, "pm/repos");
  const repo = join(dir, "alpha");
  const repo2 = join(dir, "beta");
  const bin = join(dir, "bin");
  for (const p of [home, ab, repos, repo, repo2, bin]) mkdirSync(p, { recursive: true });

  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

  git(repo, "init", "-qb", "main");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src/core.ts"), "export const CORE = 1;\n");
  writeFileSync(join(repo, "src/中文模块.ts"), "export const LIMIT = 42;\n");
  git(repo, "add", ".");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  const baseHead = git(repo, "rev-parse", "HEAD");

  git(repo, "checkout", "-qb", "feature");
  writeFileSync(join(repo, "src/synth.ts"), "export const SYNTH = true;\n");
  writeFileSync(join(repo, "src/core.ts"), "export const CORE = 2;\n");
  git(repo, "add", ".");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "feature change");
  const head = git(repo, "rev-parse", "HEAD");

  git(repo2, "init", "-qb", "main");
  mkdirSync(join(repo2, "docs"), { recursive: true });
  writeFileSync(join(repo2, "docs/contract.md"), "# contract\n");
  git(repo2, "add", ".");
  git(repo2, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "beta init");

  writeFileSync(join(repos, "alpha.md"), `- 路径：\`${repo}\`\n- 主干：\`main\`\n`);
  writeFileSync(join(repos, "beta.md"), `- 路径：\`${repo2}\`\n- 主干：\`main\`\n`);
  writeFileSync(join(bin, "security"), '#!/bin/sh\ncase "$*" in *agentbrain-extract*|*agentbrain-embedding*) printf fixture-key;; *) exit 1;; esac\n');
  chmodSync(join(bin, "security"), 0o755);

  const env = {
    ...process.env,
    HOME: home,
    AB_HOME: ab,
    AGENTBRAIN_HOME: ab,
    AB_REGISTRY: repos,
    PATH: `${bin}:${process.env.PATH}`,
    PI_SESSION_ID: "",
    PI_SESSION_FILE: "",
    PI_INTERCOM_SESSION_ID: "",
    CLAUDE_SESSION_ID: "",
    CODEX_SESSION_ID: "",
    GEMINI_HOME: "",
    ANTIGRAVITY_APP_DATA_DIR: "",
    ANTIGRAVITY_CONVERSATION_ID: "",
  };

  const registry: RegistryEntry[] = [
    { name: "alpha", path: repo, trunk: "main" },
    { name: "beta", path: repo2, trunk: "main" },
  ];

  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, home, ab, repos, repo, repo2, baseHead, head, env, registry, git };
}

test("常量导出与正常综合沉淀：<=3 条、confirmed=false、origin=auto、合法 anchors 与 anchor_head、旧条零确认/零归档", async (t) => {
  assert.equal(SYNTH_MAX_CANDIDATES, 3);
  assert.equal(SYNTH_SPEC_MAX_CHARS, 24_000);
  assert.equal(SYNTH_EXISTING_MAX, 40);
  assert.equal(SYNTH_DRAFT_HINTS_MAX, 20);
  assert.match(SYNTH_PROMPT_VERSION, /^[0-9a-f]{12}$/);

  const e = setupSandbox(t);
  const store = new Store(join(e.ab, "store.db"), join(e.ab, "index.db"));
  t.after(() => store.close());
  const pid = store.ensureProject("alpha");

  const oldConfirmed = store.remember(pid, null, false, {
    kind: "decision",
    text: "核心模块默认限制 42",
    confirmed: true,
    source: SRC,
  });
  const oldDraft = store.remember(pid, null, false, {
    kind: "decision",
    text: "旧草稿决定：需要收口替代",
    confirmed: false,
    origin: "extract",
    source: SRC,
  });
  const oldPitfallDraft = store.remember(pid, null, false, {
    kind: "pitfall",
    text: "待清理过程坑草稿",
    confirmed: false,
    origin: "extract",
    source: SRC,
  });

  const spec1 = join(e.dir, "spec1.md");
  const spec2 = join(e.dir, "spec2.md");
  writeFileSync(spec1, "# 需求方案\n确定新增 synth 模块并支持中文路径。\n");
  writeFileSync(spec2, "# 补充\n替代旧草稿决定，补充跨仓契约锚点。\n");

  const seenPrompts: string[] = [];
  const chat: Chat = async (messages: ChatMessage[]) => {
    seenPrompts.push(messages.map((m) => m.content ?? "").join("\n"));
    return {
      message: {
        role: "assistant",
        content: JSON.stringify({
          candidates: [
            {
              kind: "decision",
              text: "收口决定一：新增 synth 模块负责收口沉淀",
              why: "单会话抽取容易遗漏架构定稿",
              anchors: ["./src/synth.ts", "beta:docs/contract.md"],
              alternatives: [{ option: "完全靠后台抽取", rejected_because: "碎片过多且常漏核心决定" }],
              supersedes: oldDraft.slice(0, 8),
            },
            {
              kind: "decision",
              text: "收口决定二：核心模块常量改为 2",
              anchors: ["src/core.ts"],
            },
            {
              kind: "decision",
              text: "收口决定三：中文路径保留 UTF-8 原样",
              anchors: ["src/中文模块.ts"],
            },
            {
              kind: "decision",
              text: "收口决定四：超出上限 3 条应被截断",
              anchors: ["src/synth.ts"],
            },
          ],
        }),
      },
      tokens: 120,
      model: "mock-synth-model",
    };
  };

  let vectorCalled = 0;
  const res = await synthesizeProject({
    store,
    project: "alpha",
    registry: e.registry,
    specs: [spec1, spec2],
    chat,
    model: "fallback-model",
    updateVectors: async () => {
      vectorCalled++;
      return "模拟向量服务不可用";
    },
  });

  assert.equal(res.project, "alpha");
  assert.equal(res.dryRun, false);
  assert.equal(res.head, e.head);
  assert.equal(res.model, "mock-synth-model");
  assert.equal(res.promptVersion, SYNTH_PROMPT_VERSION);
  assert.equal(res.truncated, false);
  assert.equal(res.created.length, 3);
  assert.equal(res.skipped.length, 1);
  assert.match(res.skipped[0].reason, /上限/);
  assert.equal(vectorCalled, 1);
  assert.equal(res.vectorWarning, "模拟向量服务不可用");

  const props = store.project().props;
  for (const item of res.created) {
    assert.ok(item.id);
    const p = props.get(item.id)!;
    assert.equal(p.kind, "decision");
    assert.equal(p.confirmed, false);
    assert.equal(p.confirmed_by, null);
    assert.equal(p.origin, "auto");
    assert.equal(p.anchor_head, e.head);
    assert.ok(p.anchors.length > 0);
    assert.equal(p.model_outputs[0]?.model, "mock-synth-model");
    assert.equal(p.model_outputs[0]?.prompt_version, SYNTH_PROMPT_VERSION);
  }
  assert.deepEqual(props.get(res.created[0].id!)?.anchors, ["src/synth.ts", "beta:docs/contract.md"]);
  assert.equal(props.get(res.created[0].id!)?.supersedes, oldDraft);

  // 绝不自动 confirm 或 archive 旧条目
  assert.equal(props.get(oldConfirmed)?.state, "active");
  assert.equal(props.get(oldConfirmed)?.confirmed, true);
  assert.equal(props.get(oldDraft)?.state, "active");
  assert.equal(props.get(oldDraft)?.confirmed, false);
  assert.equal(props.get(oldPitfallDraft)?.state, "active");
  assert.equal(props.get(oldPitfallDraft)?.confirmed, false);

  // draftHints 列出原有未确认草稿且未改动它们
  assert.ok(res.draftHints.some((h) => h.id === oldDraft));
  assert.ok(res.draftHints.some((h) => h.id === oldPitfallDraft));
  assert.ok(seenPrompts[0].includes("src/synth.ts"));
  assert.ok(seenPrompts[0].includes("需求方案"));
  assert.ok(seenPrompts[0].includes("补充"));
});

test("锚点严格过滤、无锚点/重复候选跳过与超长 spec 按 SYNTH_SPEC_MAX_CHARS 截断", async (t) => {
  const e = setupSandbox(t);
  const store = new Store(join(e.ab, "store.db"), join(e.ab, "index.db"));
  t.after(() => store.close());
  const pid = store.ensureProject("alpha");
  store.remember(pid, null, false, {
    kind: "decision",
    text: "已存在的重复决定",
    confirmed: true,
    source: SRC,
  });

  const big1 = join(e.dir, "big1.md");
  const big2 = join(e.dir, "big2.md");
  writeFileSync(big1, "A".repeat(20_000));
  writeFileSync(big2, "B".repeat(10_000));

  let promptUser = "";
  const chat: Chat = async (messages) => {
    promptUser = messages.find((m) => m.role === "user")?.content ?? "";
    return {
      message: {
        role: "assistant",
        content: JSON.stringify({
          candidates: [
            {
              kind: "decision",
              text: "全无效锚点应跳过",
              anchors: ["../escape.ts", "src/不存在.ts", "unknown:a.ts", "/abs/path.ts"],
            },
            {
              kind: "decision",
              text: "已存在的重复决定。",
              anchors: ["src/core.ts"],
            },
            {
              kind: "decision",
              text: "混合锚点保留合法路径",
              anchors: ["src/不存在.ts", "./src/core.ts", "../bad.ts"],
            },
          ],
        }),
      },
      tokens: 50,
    };
  };

  const res = await synthesizeProject({
    store,
    project: "alpha",
    registry: e.registry,
    specs: [big1, big2],
    chat,
    model: "m1",
  });

  assert.equal(res.truncated, true);
  assert.ok(promptUser.includes("A".repeat(100)));
  assert.ok(!promptUser.includes("B".repeat(8_000)), "超长 spec 应被截断");
  assert.equal(res.created.length, 1);
  assert.deepEqual(res.created[0].anchors, ["src/core.ts"]);
  assert.equal(res.skipped.length, 2);
  assert.match(res.skipped[0].reason, /锚点/);
  assert.match(res.skipped[1].reason, /重复/);
});

test("supersedes 同项目校验：同项目 active/stale 解析完整 UUID，跨项目/已归档/无效前缀忽略而不阻断", async (t) => {
  const e = setupSandbox(t);
  const store = new Store(join(e.ab, "store.db"), join(e.ab, "index.db"));
  t.after(() => store.close());
  const alphaId = store.ensureProject("alpha");
  const betaId = store.ensureProject("beta");

  const staleTarget = store.remember(alphaId, null, false, {
    kind: "decision",
    text: "同项目 stale 目标",
    confirmed: true,
    source: SRC,
  });
  store.commit(
    [{ kind: "verify", project_id: alphaId, session_id: null, target_id: staleTarget, body: { outcome: "contradicted", head: e.head, refs: [] } }],
    () => {},
  );
  const archivedTarget = store.remember(alphaId, null, false, {
    kind: "decision",
    text: "同项目已归档目标",
    confirmed: false,
    source: SRC,
  });
  store.lifecycle("archive", archivedTarget, null);
  const crossTarget = store.remember(betaId, null, false, {
    kind: "decision",
    text: "跨项目 beta 目标",
    confirmed: true,
    source: SRC,
  });

  const chat: Chat = async () => ({
    message: {
      role: "assistant",
      content: JSON.stringify({
        candidates: [
          {
            kind: "decision",
            text: "替代同项目 stale 条目的新决定",
            anchors: ["src/core.ts"],
            supersedes: staleTarget.slice(0, 8),
          },
          {
            kind: "decision",
            text: "指代跨项目与已归档时应置空 supersedes",
            anchors: ["src/synth.ts"],
            supersedes: crossTarget.slice(0, 8),
          },
          {
            kind: "decision",
            text: "指代已归档或不存在 id 时置空 supersedes",
            anchors: ["src/中文模块.ts"],
            supersedes: archivedTarget.slice(0, 8),
          },
        ],
      }),
    },
    tokens: 50,
  });

  const res = await synthesizeProject({
    store,
    project: "alpha",
    registry: e.registry,
    specs: [join(e.repo, "src/core.ts")],
    chat,
    model: "m1",
  });

  assert.equal(res.created.length, 3);
  const props = store.project().props;
  assert.equal(props.get(res.created[0].id!)?.supersedes, staleTarget);
  assert.equal(props.get(res.created[1].id!)?.supersedes, undefined);
  assert.equal(props.get(res.created[2].id!)?.supersedes, undefined);
  assert.equal(props.get(staleTarget)?.state, "active");
});

test("真实 CLI：--dry-run 零写库（events/WAL/mtime 不变）、--json 结构、写库后 confirmed=false/origin=auto 与错误参数退出", async (t) => {
  const e = setupSandbox(t);
  const specFile = join(e.dir, "design.md");
  const emptySpec = join(e.dir, "empty.md");
  writeFileSync(specFile, "# 收口定谱\n核心开关保持默认开启。\n");
  writeFileSync(emptySpec, "   \n\t\n");

  const server = createServer(async (req, res) => {
    assert.equal(req.url, "/v1/chat/completions");
    let body = "";
    for await (const c of req) body += c;
    JSON.parse(body);
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              role: "assistant",
              content: JSON.stringify({
                candidates: [
                  {
                    kind: "decision",
                    text: "CLI 收口沉淀决定",
                    why: "真实 CLI 端到端测试",
                    anchors: ["src/synth.ts"],
                  },
                ],
              }),
            },
          },
        ],
        usage: { total_tokens: 42 },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))));
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  writeFileSync(join(e.ab, "extract.json"), JSON.stringify({ baseUrl: `http://127.0.0.1:${addr.port}/v1`, model: "ab4-mock" }));

  const runCli = (...args: string[]) =>
    new Promise<{ status: number | null; out: string; err: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [CLI, ...args], { cwd: e.repo, env: e.env, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("error", reject);
      child.on("close", (status) => resolve({ status, out, err }));
    });

  // 先在 store 写一条未确认草稿以确认 dry-run 不改动现有文件 WAL / mtime / events
  const seedStore = new Store(join(e.ab, "store.db"), join(e.ab, "index.db"));
  const pid = seedStore.ensureProject("alpha");
  const draftId = seedStore.remember(pid, null, false, {
    kind: "decision",
    text: "既有未确认草稿",
    confirmed: false,
    origin: "extract",
    source: SRC,
  });
  const eventsBefore = seedStore.eventCount();
  seedStore.close();

  const dbPath = join(e.ab, "store.db");
  const idxPath = join(e.ab, "index.db");
  const mtimeBefore = statSync(dbPath).mtimeMs;
  const idxMtimeBefore = statSync(idxPath).mtimeMs;
  const walBefore = existsSync(`${dbPath}-wal`);

  // 1. --dry-run --json 零写库
  const dry = await runCli("synthesize", "alpha", "--spec", specFile, "--diff-base", e.baseHead, "--dry-run", "--json");
  assert.equal(dry.status, 0, dry.err);
  const dryJson = JSON.parse(dry.out);
  assert.equal(dryJson.project, "alpha");
  assert.equal(dryJson.dryRun, true);
  assert.equal(dryJson.model, "ab4-mock");
  assert.equal(dryJson.promptVersion, SYNTH_PROMPT_VERSION);
  assert.equal(dryJson.truncated, false);
  assert.equal(dryJson.created.length, 1);
  assert.equal(dryJson.created[0].id, null);
  assert.equal(dryJson.created[0].confirmed, false);
  assert.equal(dryJson.created[0].origin, "auto");
  assert.ok(dryJson.draftHints.some((h: { id: string }) => h.id === draftId));

  assert.equal(statSync(dbPath).mtimeMs, mtimeBefore, "--dry-run 不能改动 store.db mtime");
  assert.equal(statSync(idxPath).mtimeMs, idxMtimeBefore, "--dry-run 不能改动 index.db mtime");
  assert.equal(existsSync(`${dbPath}-wal`), walBefore, "--dry-run 不能新增 WAL 文件");

  // 2. 缺失 --spec / 不存在项目 / 空 spec 报错退出
  for (const badArgs of [
    ["synthesize", "alpha"],
    ["synthesize", "missing-proj", "--spec", specFile],
    ["synthesize", "alpha", "--spec", join(e.dir, "missing.md")],
    ["synthesize", "alpha", "--spec", emptySpec],
  ]) {
    const r = await runCli(...badArgs);
    assert.notEqual(r.status, 0, badArgs.join(" "));
  }

  // 3. 正式写入
  const real = await runCli("synthesize", "alpha", "--spec", specFile, "--json");
  assert.equal(real.status, 0, real.err);
  const realJson = JSON.parse(real.out);
  assert.equal(realJson.dryRun, false);
  assert.equal(realJson.created.length, 1);
  const createdId = realJson.created[0].id as string;
  assert.ok(createdId);

  const checkStore = new Store(join(e.ab, "store.db"), join(e.ab, "index.db"));
  t.after(() => checkStore.close());
  assert.equal(checkStore.eventCount(), eventsBefore + 1);
  const prop = checkStore.project().props.get(createdId)!;
  assert.equal(prop.confirmed, false);
  assert.equal(prop.origin, "auto");
  assert.equal(prop.anchor_head, e.head);
  assert.deepEqual(prop.anchors, ["src/synth.ts"]);
});

test("回归 1：--dry-run 报错路径必须清理临时快照目录 ab-synth-ro-*", async (t) => {
  const e = setupSandbox(t);
  const specFile = join(e.dir, "design.md");
  writeFileSync(specFile, "# 收口定谱\n验证失败清理。\n");
  const customTmp = join(e.dir, "custom-tmp");
  mkdirSync(customTmp, { recursive: true });
  writeFileSync(join(e.ab, "extract.json"), JSON.stringify({ baseUrl: "http://127.0.0.1:1/v1", model: "ab4-mock" }));
  const s = new Store(join(e.ab, "store.db"), join(e.ab, "index.db"));
  s.ensureProject("alpha");
  s.close();

  const r = await new Promise<{ status: number | null; err: string }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [CLI, "synthesize", "alpha", "--spec", specFile, "--diff-base", "nonexistent-ref", "--dry-run"],
      { cwd: e.repo, env: { ...e.env, TMPDIR: customTmp }, stdio: ["ignore", "pipe", "pipe"] },
    );
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, err }));
  });
  assert.notEqual(r.status, 0);
  assert.match(r.err, /无法解析 --diff-base/);
  assert.deepEqual(
    readdirSync(customTmp).filter((n) => n.startsWith("ab-synth-ro-")),
    [],
    "--dry-run 报错路径不得残留 ab-synth-ro-* 临时目录",
  );
});

test("回归 2：分叉分支不传 --diff-base 时按 merge-base 计算 diff，不混入主干新提交", async (t) => {
  const e = setupSandbox(t);
  // 让 main 在分叉后新增一个只在 main 上的文件
  e.git(e.repo, "checkout", "-q", "main");
  writeFileSync(join(e.repo, "src/trunk-only.ts"), "export const TRUNK_ONLY = 1;\n");
  e.git(e.repo, "add", ".");
  e.git(e.repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "trunk advance");
  e.git(e.repo, "checkout", "-q", "feature");

  const store = new Store(join(e.ab, "store.db"), join(e.ab, "index.db"));
  t.after(() => store.close());
  const spec = join(e.dir, "spec.md");
  writeFileSync(spec, "# 特性定谱\n只改 synth.ts。\n");

  let promptUser = "";
  const chat: Chat = async (messages) => {
    promptUser = messages.find((m) => m.role === "user")?.content ?? "";
    return {
      message: {
        role: "assistant",
        content: JSON.stringify({
          candidates: [{ kind: "decision", text: "分叉分支只取本分支变更", anchors: ["src/synth.ts"] }],
        }),
      },
      tokens: 20,
    };
  };

  const res = await synthesizeProject({
    store,
    project: "alpha",
    registry: e.registry,
    specs: [spec],
    dryRun: true,
    chat,
    model: "m1",
  });

  assert.equal(res.diffBase, "merge-base(main)");
  const changedSection = promptUser.split("仓内可验证文件清单")[0];
  assert.ok(changedSection.includes("src/synth.ts"), "应包含特性分支改动");
  assert.ok(!changedSection.includes("trunk-only.ts"), "不得混入分叉后主干新增文件");
});

test("回归 3 & 4：filterValidAnchors 先去重再截断至 ANCHORS_MAX，大 diff 触发 ENOBUFS 降级兜底", async (t) => {
  const e = setupSandbox(t);
  // 写入 5 个独立文件并制造 >4.5MB 的大 diff 触发 RepoTools.git 的 ENOBUFS (maxBuffer 4MB)
  for (const f of ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]) {
    writeFileSync(join(e.repo, `src/${f}`), `export const ${f[0]} = 1;\n`);
  }
  writeFileSync(join(e.repo, "src/huge.txt"), "X".repeat(4_800_000) + "\n");
  e.git(e.repo, "add", ".");
  e.git(e.repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "many files and huge diff");

  const store = new Store(join(e.ab, "store.db"), join(e.ab, "index.db"));
  t.after(() => store.close());
  const spec = join(e.dir, "spec.md");
  writeFileSync(spec, "# 多锚点与大 diff\n验证去重后截断与 ENOBUFS 降级。\n");

  let promptUser = "";
  const chat: Chat = async (messages) => {
    promptUser = messages.find((m) => m.role === "user")?.content ?? "";
    return {
      message: {
        role: "assistant",
        content: JSON.stringify({
          candidates: [
            {
              kind: "decision",
              text: "先去重再按 5 锚点上限截断",
              anchors: ["./src/a.ts", "src/a.ts", "src//a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"],
            },
          ],
        }),
      },
      tokens: 20,
    };
  };

  const res = await synthesizeProject({
    store,
    project: "alpha",
    registry: e.registry,
    specs: [spec],
    dryRun: true,
    chat,
    model: "m1",
  });

  assert.equal(res.created.length, 1);
  assert.deepEqual(res.created[0].anchors, ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"]);
  assert.ok(promptUser.includes("src/huge.txt"));
  assert.ok(promptUser.includes("diff 过大已略去正文"));
});

test("回归 5：下游展示口径对齐 origin=auto（brief、view、ab get 模型产出记录）", async (t) => {
  const e = setupSandbox(t);
  const store = new Store(join(e.ab, "store.db"), join(e.ab, "index.db"));
  t.after(() => store.close());
  const pid = store.ensureProject("alpha");
  const spec = join(e.dir, "spec.md");
  writeFileSync(spec, "# 展示口径\n对齐 auto 来源文案。\n");

  const chat: Chat = async () => ({
    message: {
      role: "assistant",
      content: JSON.stringify({
        candidates: [{ kind: "decision", text: "展示口径对齐决定", anchors: ["src/synth.ts"] }],
      }),
    },
    tokens: 20,
  });

  const res = await synthesizeProject({
    store,
    project: "alpha",
    registry: e.registry,
    specs: [spec],
    chat,
    model: "mock-auto",
  });
  const createdId = res.created[0].id!;
  assert.equal(store.project().props.get(createdId)?.project_id, pid);

  const prevRegistry = process.env.AB_REGISTRY;
  process.env.AB_REGISTRY = e.repos;
  t.after(() => {
    if (prevRegistry === undefined) delete process.env.AB_REGISTRY;
    else process.env.AB_REGISTRY = prevRegistry;
  });

  const briefOut = brief(store, e.repo, "alpha", false, []);
  assert.match(briefOut, /其中自动沉淀 1 条/);
  assert.doesNotMatch(briefOut, /agent 自记未确认/);

  const html = renderHtml(buildViewData(store, new Date(), { home: e.ab, code: null }));
  assert.match(html, /收口提炼/);

  const getOut = await new Promise<{ status: number | null; out: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, "get", createdId.slice(0, 8)], {
      cwd: e.repo,
      env: e.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, out }));
  });
  assert.equal(getOut.status, 0);
  assert.match(getOut.out, new RegExp(`\\[${createdId.slice(0, 8)}\\] 收口提炼: mock-auto`));
});
