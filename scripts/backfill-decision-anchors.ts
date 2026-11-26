#!/usr/bin/env node
/**
 * 存量项目级无 code_evidence 的 decision 离线补锚点脚本（§9.7.8 单 3）。
 * 用法：
 *   node scripts/backfill-decision-anchors.ts preview [--project <名>] [--out <json路径>] [--md <md路径>] [--batch-size <n>]
 *   node scripts/backfill-decision-anchors.ts apply --plan <json路径> [--project <名>] [--ids <逗号分隔id或前缀>] [--dry-run]
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { applyBackfillPlan, buildBackfillPlan, renderBackfillMarkdown, type BackfillPlan } from "../src/backfill-anchors.ts";
import { readKey } from "../src/embed.ts";
import { chatChain, chatClient, loadChatConfig, type Chat } from "../src/llm.ts";
import { loadRegistry } from "../src/registry.ts";
import { Store } from "../src/store.ts";

function abHome(): string {
  return process.env.AB_HOME || process.env.AGENTBRAIN_HOME || join(homedir(), ".agentbrain");
}

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

/** 复制 store.db（含 -wal/-shm）到临时目录以严格只读打开，避免触碰活库或触发写操作（§21/pitfall）。 */
function openReadOnlyCopy(root: string): { store: Store; cleanup: () => void } {
  const srcDb = join(root, "store.db");
  if (!existsSync(srcDb)) die(`找不到数据库文件: ${srcDb}`);
  const scratch = mkdtempSync(join(tmpdir(), "ab-backfill-ro-"));
  for (const suffix of ["", "-wal", "-shm"]) {
    const src = srcDb + suffix;
    if (existsSync(src)) copyFileSync(src, join(scratch, "store.db" + suffix));
  }
  const store = new Store(join(scratch, "store.db"), ":memory:");
  return {
    store,
    cleanup: () => {
      try { store.close(); } catch { /* ignore */ }
      rmSync(scratch, { recursive: true, force: true });
    },
  };
}

async function cmdPreview(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      project: { type: "string" },
      out: { type: "string" },
      md: { type: "string" },
      "batch-size": { type: "string" },
    },
    strict: true,
  });
  const batchSize = values["batch-size"] ? Number(values["batch-size"]) : undefined;
  if (batchSize !== undefined && (!Number.isInteger(batchSize) || batchSize < 1)) die("--batch-size 必须是正整数");

  const root = abHome();
  const cfg = loadChatConfig(root);
  if ("error" in cfg) die(`模型配置不可用：${cfg.error}`);
  const client = chatChain(cfg, readKey, (c, k) => chatClient(c, k, undefined));
  if ("error" in client) die(`模型不可用：${client.message}`);
  const chat: Chat = (messages, opts) => client.chat(messages, opts);

  const { store, cleanup } = openReadOnlyCopy(root);
  try {
    const plan = await buildBackfillPlan({
      store,
      registry: loadRegistry(),
      chat,
      project: values.project,
      batchSize,
    });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const outPath = values.out ?? join(tmpdir(), `backfill-decision-anchors-${ts}.json`);
    const mdPath = values.md ?? outPath.replace(/\.json$/i, "") + ".md";
    mkdirSync(dirname(outPath), { recursive: true });
    mkdirSync(dirname(mdPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(plan, null, 2) + "\n", "utf8");
    writeFileSync(mdPath, renderBackfillMarkdown(plan), "utf8");

    const total = plan.projects.reduce((s, p) => s + p.candidate_count, 0);
    const anchored = plan.projects.reduce((s, p) => s + p.anchored_count, 0);
    const empty = plan.projects.reduce((s, p) => s + p.empty_count, 0);
    const dropped = plan.projects.reduce((s, p) => s + p.dropped_invalid_count, 0);
    console.log(`预览完成（只读，未改库）：候选 ${total}，拟补锚点 ${anchored}，留空 ${empty}，剔除无效 ${dropped}`);
    console.log(`JSON: ${outPath}`);
    console.log(`MD: ${mdPath}`);
    for (const p of plan.projects) {
      console.log(`  ${p.project}: 候选 ${p.candidate_count}，拟补 ${p.anchored_count}，留空 ${p.empty_count}，剔除 ${p.dropped_invalid_count}`);
    }
  } finally {
    cleanup();
  }
}

function cmdApply(argv: string[]): void {
  const { values } = parseArgs({
    args: argv,
    options: {
      plan: { type: "string" },
      project: { type: "string" },
      ids: { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
    strict: true,
  });
  if (!values.plan) die("用法: backfill-decision-anchors.ts apply --plan <json路径> [--project <名>] [--ids <id1,id2>] [--dry-run]");
  const plan = JSON.parse(readFileSync(values.plan, "utf8")) as BackfillPlan;
  const ids = values.ids ? values.ids.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
  const root = abHome();

  if (values["dry-run"]) {
    const { store, cleanup } = openReadOnlyCopy(root);
    try {
      const res = applyBackfillPlan(store, plan, { project: values.project, ids, dryRun: true });
      console.log(`试运行（dryRun=${res.dryRun}，未写库）：applied=${res.applied}，skipped=${res.skipped}`);
    } finally {
      cleanup();
    }
    return;
  }

  const store = new Store(join(root, "store.db"), join(root, "index.db"));
  try {
    const res = applyBackfillPlan(store, plan, { project: values.project, ids, dryRun: false });
    console.log(`写入完成（dryRun=${res.dryRun}）：applied=${res.applied}，skipped=${res.skipped}`);
  } finally {
    store.close();
  }
}

const [sub, ...rest] = process.argv.slice(2);
if (sub === "preview") await cmdPreview(rest);
else if (sub === "apply") cmdApply(rest);
else die("用法: backfill-decision-anchors.ts <preview|apply> ...");
