import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.ts";
import type { Chat, ChatMessage } from "./llm.ts";
import type { RegistryEntry } from "./registry.ts";
import {
  applyBackfillPlan,
  buildBackfillPlan,
  collectDecisionCandidates,
  renderBackfillMarkdown,
} from "./backfill-anchors.ts";

const SCRIPT = join(import.meta.dirname, "..", "scripts", "backfill-decision-anchors.ts");

function setupRepos(t: { after: (fn: () => void) => void }) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ab3-backfill-")));
  const alpha = join(dir, "alpha");
  const beta = join(dir, "beta");
  mkdirSync(join(alpha, "src"), { recursive: true });
  mkdirSync(join(beta, "docs"), { recursive: true });
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
  git(alpha, "init", "-qb", "main");
  writeFileSync(join(alpha, "src/中文模块.ts"), "export const LIMIT = 42;\n");
  writeFileSync(join(alpha, "src/auth.ts"), "export const AUTH = true;\n");
  git(alpha, "add", ".");
  git(alpha, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "alpha init");
  const alphaHead = git(alpha, "rev-parse", "HEAD");

  git(beta, "init", "-qb", "main");
  writeFileSync(join(beta, "docs/契约.md"), "# 契约\n");
  git(beta, "add", ".");
  git(beta, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "beta init");
  const betaHead = git(beta, "rev-parse", "HEAD");

  const store = new Store(join(dir, "store.db"), join(dir, "index.db"));
  const alphaId = store.ensureProject("alpha");
  const betaId = store.ensureProject("beta");
  const registry: RegistryEntry[] = [
    { name: "alpha", path: alpha, trunk: "main" },
    { name: "beta", path: beta, trunk: "main" },
  ];
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, alpha, beta, alphaHead, betaHead, store, alphaId, betaId, registry, git };
}

const SRC = { host: "pi" as const, session_id: "s", transcript: null, anchor: null, summary: "回填测试" };

test("collectDecisionCandidates 只收项目级 active 无 code_evidence 且无 anchors 的 decision，按项目与 seq 排序", (t) => {
  const e = setupRepos(t);
  const bDec = e.store.remember(e.betaId, null, false, { kind: "decision", text: "beta 决定", confirmed: true, source: SRC });
  const aDec1 = e.store.remember(e.alphaId, null, false, { kind: "decision", text: "alpha 决定 1", confirmed: false, source: SRC });
  const aDec2 = e.store.remember(e.alphaId, null, false, { kind: "decision", text: "alpha 决定 2", confirmed: true, source: SRC });

  // 排除项：全局、非 decision、已归档、已有 anchors、已有 code_evidence、stale、demoted、superseded_draft
  e.store.remember(null, null, false, { kind: "decision", text: "全局决定", confirmed: true, source: SRC });
  e.store.remember(e.alphaId, null, false, { kind: "rule", text: "规则", confirmed: true, source: SRC });
  const arch = e.store.remember(e.alphaId, null, false, { kind: "decision", text: "归档决定", confirmed: true, source: SRC });
  e.store.lifecycle("archive", arch, null);
  e.store.remember(e.alphaId, null, false, { kind: "decision", text: "已有锚点", confirmed: true, anchors: ["src/auth.ts"], source: SRC });
  const hasEv = e.store.remember(e.alphaId, null, false, { kind: "decision", text: "已有证据", confirmed: false, source: SRC });
  e.store.commit([{ kind: "verify", project_id: e.alphaId, session_id: null, target_id: hasEv, body: { outcome: "verified", head: e.alphaHead, refs: [{ path: "src/auth.ts", line_start: 1, line_end: 1, quote: "AUTH = true" }] } }], () => {});
  const staleId = e.store.remember(e.alphaId, null, false, { kind: "decision", text: "stale 决定", confirmed: true, source: SRC });
  e.store.commit([{ kind: "verify", project_id: e.alphaId, session_id: null, target_id: staleId, body: { outcome: "contradicted", head: e.alphaHead, refs: [] } }], () => {});
  const demotedId = e.store.remember(e.alphaId, null, false, { kind: "decision", text: "demoted 决定", confirmed: false, source: SRC });
  e.store.lifecycle("unconfirm", demotedId, null, { reason: "worker_prompt" });
  const draftOld = e.store.remember(e.alphaId, null, false, { kind: "decision", text: "旧草稿", origin: "extract", confirmed: false, source: SRC });
  const draftNew = e.store.remember(e.alphaId, null, false, { kind: "decision", text: "新草稿", origin: "extract", confirmed: false, supersedes: draftOld, source: SRC });

  const all = collectDecisionCandidates(e.store, e.registry);
  assert.deepEqual(all.map(c => c.prop.id), [aDec1, aDec2, draftNew, bDec]);
  const onlyAlpha = collectDecisionCandidates(e.store, e.registry, "alpha");
  assert.deepEqual(onlyAlpha.map(c => c.prop.id), [aDec1, aDec2, draftNew]);
});

test("buildBackfillPlan：中文文件、过滤幻觉/越界路径、超 800 文件优先截断、确定性排序与 Markdown 渲染", async (t) => {
  const e = setupRepos(t);
  for (let i = 0; i < 820; i++) writeFileSync(join(e.alpha, `src/extra-${String(i).padStart(3, "0")}.ts`), `export const N${i} = ${i};\n`);
  e.git(e.alpha, "add", ".");
  e.git(e.alpha, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "many files");
  const head = e.git(e.alpha, "rev-parse", "HEAD");

  const d1 = e.store.remember(e.alphaId, null, false, { kind: "decision", text: "中文模块阈值和 auth 配置", why: "参考 中文模块.ts 与 beta 契约", confirmed: true, guidance: true, source: SRC });
  const d2 = e.store.remember(e.alphaId, null, false, { kind: "decision", text: "没有对应文件的纯流程决定", confirmed: false, source: SRC });

  const seenPrompts: string[] = [];
  const chat: Chat = async (msgs: ChatMessage[]) => {
    seenPrompts.push(msgs.map(m => m.content ?? "").join("\n"));
    return {
      message: {
        role: "assistant",
        content: JSON.stringify({
          items: [
            {
              id: d1.slice(0, 8),
              anchors: ["./src/中文模块.ts", "beta:docs/契约.md", "src/不存在.ts", "../escape.ts", "beta:docs/不存在.md"],
              reason: "命中中文模块与跨仓契约文档",
            },
            { id: d2, anchors: [], reason: "纯流程决定无对应文件" },
          ],
        }),
      },
      tokens: 100,
    };
  };

  const now = new Date("2026-11-26T10:00:00Z");
  const plan1 = await buildBackfillPlan({ store: e.store, registry: e.registry, chat, now });
  const plan2 = await buildBackfillPlan({ store: e.store, registry: e.registry, chat, now });
  assert.deepEqual(plan1, plan2, "同一输入必须确定性幂等");

  // 提示词里文件列表被控制在 <=800 且优先包含候选提及的文件
  assert.match(seenPrompts[0], /src\/中文模块\.ts/);
  const listedFiles = seenPrompts[0].split("\n").filter(l => l.startsWith("- ")).length;
  assert.ok(listedFiles <= 800, `文件清单应截断在 800 以内，实际 ${listedFiles}`);

  assert.equal(plan1.projects.length, 1);
  assert.deepEqual(plan1.projects[0], {
    project: "alpha",
    trunkRef: "main",
    head,
    candidate_count: 2,
    anchored_count: 1,
    empty_count: 1,
    dropped_invalid_count: 3,
  });

  const item1 = plan1.items.find(i => i.id === d1)!;
  assert.deepEqual(item1.anchors, ["src/中文模块.ts", "beta:docs/契约.md"]);
  assert.deepEqual(item1.dropped, ["src/不存在.ts", "../escape.ts", "beta:docs/不存在.md"]);
  assert.equal(item1.head, head);

  const md = renderBackfillMarkdown(plan1);
  assert.match(md, /\| alpha \| main \|/);
  assert.match(md, /src\/中文模块\.ts/);
  assert.match(md, /beta:docs\/契约\.md/);
});

test("applyBackfillPlan：仅改无锚点/无证据/active 条目、不改 confirmed/text/guidance、重复执行幂等跳过", async (t) => {
  const e = setupRepos(t);
  const dConfirmed = e.store.remember(e.alphaId, null, false, { kind: "decision", text: "已确认决定", confirmed: true, guidance: true, source: SRC });
  const dUnconfirmed = e.store.remember(e.alphaId, null, false, { kind: "decision", text: "未确认决定", confirmed: false, source: SRC });
  const dLaterEv = e.store.remember(e.alphaId, null, false, { kind: "decision", text: "后来拿到证据", confirmed: false, source: SRC });

  const plan = await buildBackfillPlan({
    store: e.store,
    registry: e.registry,
    chat: async () => ({
      message: {
        role: "assistant",
        content: JSON.stringify({
          items: [
            { id: dConfirmed, anchors: ["src/auth.ts"], reason: "r1" },
            { id: dUnconfirmed, anchors: ["src/中文模块.ts"], reason: "r2" },
            { id: dLaterEv, anchors: ["src/auth.ts"], reason: "r3" },
          ],
        }),
      },
      tokens: 10,
    }),
  });

  // 在 apply 前给 dLaterEv 补上 code_evidence → apply 时必须跳过
  e.store.commit([{
    kind: "verify",
    project_id: e.alphaId,
    session_id: null,
    target_id: dLaterEv,
    body: { outcome: "verified", head: e.alphaHead, refs: [{ path: "src/auth.ts", line_start: 1, line_end: 1, quote: "AUTH = true" }] },
  }], () => {});

  const dry = applyBackfillPlan(e.store, plan, { dryRun: true });
  assert.deepEqual([dry.applied, dry.skipped, dry.dryRun], [2, 1, true]);
  assert.deepEqual(e.store.project().props.get(dConfirmed)!.anchors, []);

  const first = applyBackfillPlan(e.store, plan);
  assert.deepEqual([first.applied, first.skipped, first.dryRun], [2, 1, false]);
  const pConf = e.store.project().props.get(dConfirmed)!;
  const pUnconf = e.store.project().props.get(dUnconfirmed)!;
  assert.deepEqual(pConf.anchors, ["src/auth.ts"]);
  assert.equal(pConf.anchor_head, e.alphaHead);
  assert.equal(pConf.confirmed, true);
  assert.equal(pConf.guidance, true);
  assert.equal(pConf.text, "已确认决定");
  assert.deepEqual(pUnconf.anchors, ["src/中文模块.ts"]);
  assert.equal(pUnconf.confirmed, false, "未确认决定补锚点不自动转正");

  // 重复执行完全幂等
  const second = applyBackfillPlan(e.store, plan);
  assert.deepEqual([second.applied, second.skipped, second.dryRun], [0, 3, false]);
});

test("scripts/backfill-decision-anchors.ts：preview 只读不改库，apply --dry-run 与正式写入", async (t) => {
  const e = setupRepos(t);
  const abHome = join(e.dir, "ab");
  const reposDir = join(e.dir, "repos");
  const binDir = join(e.dir, "bin");
  mkdirSync(abHome, { recursive: true });
  mkdirSync(reposDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(reposDir, "alpha.md"), `- 路径：\`${e.alpha}\`\n- 主干：\`main\`\n`);
  writeFileSync(join(binDir, "security"), '#!/bin/sh\ncase "$*" in *agentbrain-extract*|*agentbrain-embedding*) printf fixture-key;; *) exit 1;; esac\n');
  chmodSync(join(binDir, "security"), 0o755);

  const s = new Store(join(abHome, "store.db"), join(abHome, "index.db"));
  const pid = s.ensureProject("alpha");
  const d1 = s.remember(pid, null, false, { kind: "decision", text: "CLI 回填决定", confirmed: false, source: SRC });
  const eventsBefore = Number(s.workDb.prepare("SELECT count(*) AS n FROM events").get()!.n);
  s.close();

  const server = createServer(async (_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      choices: [{
        message: {
          role: "assistant",
          content: JSON.stringify({ items: [{ id: d1.slice(0, 8), anchors: ["src/中文模块.ts"], reason: "脚本测试" }] }),
        },
      }],
      usage: { total_tokens: 25 },
    }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  writeFileSync(join(abHome, "extract.json"), JSON.stringify({ baseUrl: `http://127.0.0.1:${addr.port}/v1`, model: "backfill-fixture" }));

  const env = { ...process.env, HOME: e.dir, AB_HOME: abHome, AGENTBRAIN_HOME: abHome, AB_REGISTRY: reposDir, PATH: `${binDir}:${process.env.PATH}` };
  const runScript = (...args: string[]) => new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", b => stdout += b);
    child.stderr.on("data", b => stderr += b);
    child.on("error", reject);
    child.on("close", status => resolve({ status, stdout, stderr }));
  });
  const outJson = join(e.dir, "plan.json");
  const outMd = join(e.dir, "plan.md");
  try {
    const prev = await runScript("preview", "--project", "alpha", "--out", outJson, "--md", outMd);
    assert.equal(prev.status, 0, prev.stderr);
    const plan = JSON.parse(readFileSync(outJson, "utf8"));
    assert.equal(plan.items[0].anchors[0], "src/中文模块.ts");
    assert.match(readFileSync(outMd, "utf8"), /src\/中文模块\.ts/);

    // preview 只读：事件表未增加
    const sCheck1 = new Store(join(abHome, "store.db"), join(abHome, "index.db"));
    assert.equal(Number(sCheck1.workDb.prepare("SELECT count(*) AS n FROM events").get()!.n), eventsBefore);
    sCheck1.close();

    // apply --dry-run 不写入
    const dry = await runScript("apply", "--plan", outJson, "--dry-run");
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /dryRun|试运行/);

    // apply 写入并二次幂等跳过
    const app1 = await runScript("apply", "--plan", outJson, "--ids", d1.slice(0, 8));
    assert.equal(app1.status, 0, app1.stderr);
    const sCheck2 = new Store(join(abHome, "store.db"), join(abHome, "index.db"));
    assert.deepEqual(sCheck2.project().props.get(d1)!.anchors, ["src/中文模块.ts"]);
    assert.equal(sCheck2.project().props.get(d1)!.confirmed, false);
    sCheck2.close();

    const app2 = await runScript("apply", "--plan", outJson);
    assert.equal(app2.status, 0, app2.stderr);
    assert.match(app2.stdout, /applied=0|跳过 1|applied 0/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
});
