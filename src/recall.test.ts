/** recall 直接单测（不起子进程，只走全文检索）。运行：node --test src/recall.test.ts */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.ts";
import type { RememberBody } from "./l2.ts";
import { recall, RECALL_MAX_CHARS } from "./recall.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "ab-recall-")));
const repos = join(dir, "pm/repos");
const alpha = join(dir, "alpha");
const elsewhere = join(dir, "elsewhere");
for (const d of [repos, alpha, elsewhere]) mkdirSync(d, { recursive: true });
writeFileSync(join(repos, "alpha.md"), `- 路径：\`${alpha}\`\n`);
process.env.AB_REGISTRY = repos;

const src: RememberBody["source"] = { host: "pi", session_id: "s", transcript: null, anchor: null, summary: "讨论" };
const noEmbed = () => null;

function seeded(): Store {
  const s = new Store(":memory:", ":memory:");
  const pid = s.ensureProject("alpha");
  s.remember(pid, "s", false, { kind: "pitfall", text: "lockfile pitfall in alpha", confirmed: true, source: src });
  s.remember(pid, "s", false, { kind: "pitfall", text: "lockfile unconfirmed guess", confirmed: false, source: src });
  s.remember(pid, "s", false, { kind: "note", text: "lockfile fact note", confirmed: true, source: src });
  s.remember(null, "s", false, { kind: "rule", text: "lockfile global plain", confirmed: true, source: src });
  s.remember(null, "s", false, { kind: "rule", text: "lockfile global for workers", confirmed: true, for_workers: true, source: src });
  return s;
}

test("短提示词、斜杠命令直接跳过，且不去取 embedder", async () => {
  let called = 0;
  const get = () => (called++, null);
  assert.equal(await recall(seeded(), "abc", alpha, get), "");
  assert.equal(await recall(seeded(), "/compact now", alpha, get), "");
  assert.equal(called, 0);
});

test("项目内：已确认坑 + for_workers 全局；排除未确认推断、事实、未标 for_workers 的全局", async () => {
  const out = await recall(seeded(), "lockfile", alpha, noEmbed);
  assert.match(out, /^<agentbrain-recall>\n/);
  assert.match(out, /坑: lockfile pitfall in alpha/);
  assert.match(out, /规则: lockfile global for workers/);
  assert.doesNotMatch(out, /unconfirmed guess|fact note|global plain/);
});

test("未登记目录只召回 for_workers 全局；没命中返回空串", async () => {
  const out = await recall(seeded(), "lockfile", elsewhere, noEmbed);
  assert.doesNotMatch(out, /pitfall in alpha/);
  assert.match(out, /for workers/);
  assert.equal(await recall(seeded(), "nothingmatcheshere", alpha, noEmbed), "");
});

test("总长不超 RECALL_MAX_CHARS，最多 3 条", async () => {
  const s = new Store(":memory:", ":memory:");
  const pid = s.ensureProject("alpha");
  for (let i = 0; i < 6; i++) s.remember(pid, "s", false, { kind: "pitfall", text: `lockfile ${i} ${"y".repeat(300)}`, confirmed: true, source: src });
  const out = await recall(s, "lockfile", alpha, noEmbed);
  assert.ok(out.length <= RECALL_MAX_CHARS, String(out.length));
  assert.ok(out.split("\n").filter((l) => l.startsWith("- [")).length <= 3);
});
