/**
 * Pensieve 导入：解析、映射、幂等、纠正、与已有记忆去重（假 embedding、假模型）。
 * 运行：node --test src/pensieve.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, type Embedder } from "./store.ts";
import type { Chat, ChatMessage } from "./llm.ts";
import { condense, importPensieve, mapDoc, parseDoc, planImport, type ImportDeps } from "./pensieve.ts";

const base = realpathSync(mkdtempSync(join(tmpdir(), "ab-pensieve-")));
let n = 0;
const fakeEmbed: Embedder = Object.assign(async (texts: string[]) => texts.map((t) => {
  const v = new Float32Array(97);
  for (const ch of t) v[ch.codePointAt(0)! % 97] += 1;
  return v;
}), { model: "fake-embed" });

const DECISION = `---
id: 2025-12-11-selective-null
type: decision
title: "selective 的 null 与空字符串语义必须保留"
status: active
---
# selective 的 null 与空字符串语义必须保留

## 一句话结论
> null = 不更新，"" = 清空字段。禁止 trimToNull。

## Context
数据库字段 NOT NULL + 默认值，配合 insertSelective。

## Problem
trimToNull 把 "" 转成 null，updateSelective 跳过，前端清空不生效。

\`\`\`
前端传 "" → null ❌
\`\`\`

## Decision
| a | b |
|---|---|

## 上下文链接
- [[knowledge/persistence-standard/content]]
`;
const MAXIM = `---
id: eliminate-special-cases
type: maxim
title: Eliminate special cases
status: active
---
## One-line Conclusion
> Prefer changing data shape so edge cases become the default path.

## Guidance
- Remove branches that only patch one-off inputs.

## Boundaries
- Breaking user-visible behavior is a migration.
`;
const KNOW = `---
id: dict-sync-label
type: knowledge
title: "字典同步禁止用源库空 label 覆盖本地 label"
status: active
---
## Summary
同步曾以源库 label 为准，源库为空会把本地补全的 label 改回空。

## Content
现已调整为只在源库 label 非空时覆盖。
`;

function repo(files: Record<string, string>): string {
  const r = join(base, `r${n++}`);
  for (const [rel, src] of Object.entries(files)) {
    mkdirSync(join(r, ".pensieve", rel, ".."), { recursive: true });
    writeFileSync(join(r, ".pensieve", rel), src);
  }
  return r;
}

function deps(store: Store, chat: Chat | null): ImportDeps {
  return { store, projectId: (nm) => store.ensureProject(nm), embedder: fakeEmbed, chat: chat ? { chat, model: "fake" } : null, relateSim: 0.7, relateTop: 3, relateBatch: 6 };
}

test("解析与映射：一句话结论做正文，Context/Problem 压成背景，去掉代码块、表格和链接", () => {
  const d = parseDoc("/x/decisions/a.md", DECISION, "decision")!;
  const m = mapDoc(d);
  assert.equal(m.kind, "decision");
  assert.match(m.text, /^selective 的 null 与空字符串语义必须保留：null = 不更新/);
  assert.match(m.why!, /NOT NULL \+ 默认值/);
  assert.match(m.why!, /前端清空不生效/);
  assert.doesNotMatch(m.why!, /❌|\|/);
  const k = mapDoc(parseDoc("/x/knowledge/k/content.md", KNOW, "knowledge")!);
  assert.equal(k.kind, "pitfall", "标题讲『禁止…覆盖』按坑");
  assert.equal(mapDoc(parseDoc("/x/maxims/m.md", MAXIM, "maxim")!).kind, "rule");
  assert.equal(condense("- a\n- [[b/c]]\n| x |"), "a；b/c");
  const meta = parseDoc("/x/decisions/t.md", "---\nid: t\ntitle: 写入时机\n---\n# 写入时机\n\n**日期**: 2026-03-24\n**状态**: 已实施\n\n## 背景\n两条路径。\n\n## 决策\n只在 sync=false 时写 pending_sync\n", "decision")!;
  const colon = parseDoc("/x/decisions/c.md", "---\nid: c\ntitle: 日志表\n---\n## 决策\n新建 log 表，关键设计点：\n\n- 只追加\n- 按对象建索引\n\n## 后果\n无\n", "decision")!;
  assert.equal(colon.conclusion, "新建 log 表，关键设计点：只追加；按对象建索引", "冒号收尾时带上后面的列表");
  assert.equal(mapDoc(parseDoc("/x/knowledge/f.md", "---\nid: f\ntitle: Feign 集成规范\n---\n## Summary\n异常必须分类，失败要重试。\n", "knowledge")!).kind, "note", "规范里出现失败/异常不算坑");
  assert.equal(meta.conclusion, "只在 sync=false 时写 pending_sync", "没有结论段时取决策段，跳过元数据块，保留下划线");
});

test("计划：只导 active；pipelines/short-term 不导；跳过清单生效；多仓库相同内容只导一次并提为全局", () => {
  const a = repo({ "decisions/a.md": DECISION, "maxims/m.md": MAXIM, "pipelines/p.md": "x", "maxims/._m.md": "\u0000Mac OS X ATTR", "short-term/decisions/s.md": DECISION.replace("2025-12-11-selective-null", "st"), "knowledge/k/content.md": KNOW.replace("status: active", "status: archived") });
  const b = repo({ "maxims/m.md": MAXIM });
  const plan = planImport([{ root: a, project: "alpha" }, { root: b, project: "beta" }], new Map([["nothing", "x"]]));
  assert.deepEqual(plan.items.map((i) => [i.doc.id, i.project]).sort(), [["2025-12-11-selective-null", "alpha"], ["eliminate-special-cases", null]]);
  assert.equal(plan.items.find((i) => i.doc.id === "eliminate-special-cases")!.also.length, 1);
  assert.deepEqual(plan.skipped.map((s) => s.reason.split(" ")[0]), ["status=archived", "与"]);
  const skipped = planImport([{ root: a, project: "alpha" }], new Map([["eliminate-special-cases", "Pensieve 默认模板"]]));
  assert.equal(skipped.items.length, 1);
  assert.equal(skipped.skipped.find((s) => s.id === "eliminate-special-cases")!.reason, "Pensieve 默认模板");
});

test("写入：已确认、origin=import、带出处；重导不重复；文件改了记为纠正并替代旧条；归档过的不再导", async () => {
  const dir = join(base, `s${n++}`);
  mkdirSync(dir);
  const store = new Store(join(dir, "store.db"), join(dir, "index.db"));
  const r = repo({ "decisions/a.md": DECISION });
  const first = await importPensieve(deps(store, null), planImport([{ root: r, project: "alpha" }], new Map()));
  assert.equal(first.created.length, 1);
  const p = store.project().props.get(first.created[0])!;
  assert.equal(p.confirmed, true);
  assert.equal(p.confirmed_by, "user");
  assert.equal(p.origin, "import");
  assert.equal(p.import_ref!.id, "2025-12-11-selective-null");
  assert.equal(p.import_ref!.path, join(r, ".pensieve/decisions/a.md"));
  const again = await importPensieve(deps(store, null), planImport([{ root: r, project: "alpha" }], new Map()));
  assert.deepEqual([again.created.length, again.corrected.length, again.unchanged], [0, 0, 1]);
  store.lifecycle("tag", first.created[0], null, { scenes: ["design"] }); // 重导替代时复制旧条目的场景
  writeFileSync(join(r, ".pensieve/decisions/a.md"), DECISION.replace("禁止 trimToNull。", "禁止 trimToNull 和 trimToEmpty。"));
  const changed = await importPensieve(deps(store, null), planImport([{ root: r, project: "alpha" }], new Map()));
  assert.equal(changed.corrected.length, 1);
  const props = store.project().props;
  assert.equal(props.get(first.created[0])!.state, "superseded");
  assert.match(props.get(changed.corrected[0])!.text, /trimToEmpty/);
  assert.deepEqual(props.get(changed.corrected[0])!.scenes, ["design"]);
  store.lifecycle("archive", changed.corrected[0], null);
  const after = await importPensieve(deps(store, null), planImport([{ root: r, project: "alpha" }], new Map()));
  assert.deepEqual([after.created.length, after.corrected.length, after.archivedSkip], [0, 0, 1]);
  store.close();
});

test("去重：近邻是未确认自动条目就并进导入条；是用户确认条目就把导入条并进去，确认条目不动", async () => {
  const dir = join(base, `s${n++}`);
  mkdirSync(dir);
  const store = new Store(join(dir, "store.db"), join(dir, "index.db"));
  const pid = store.ensureProject("alpha");
  const src = { host: null, session_id: null, transcript: null, anchor: null, summary: "x" };
  const KTEXT = "字典同步禁止用源库空 label 覆盖本地 label：同步曾以源库 label 为准，源库为空会把本地补全的 label 改回空。";
  const auto = store.remember(pid, null, false, { kind: "pitfall", text: KTEXT, confirmed: false, origin: "extract", source: src });
  const mine = store.remember(pid, null, false, { kind: "rule", text: "Eliminate special cases：Prefer changing data shape so edge cases become the default path.", confirmed: true, source: src });
  const r = repo({ "knowledge/k/content.md": KNOW, "maxims/m.md": MAXIM, "decisions/a.md": DECISION });
  const chat = (async (msgs: ChatMessage[]) => {
    const q = msgs[1].content!;
    const results = q.split(/## q/).slice(1).map((blk) => {
      const lines = blk.split("\n");
      const id = `q${lines[0].trim()}`;
      const nLine = lines.find((l) => l.startsWith("N: "))!;
      const pick = (key: string) => { const i = lines.filter((l) => /^m\d+: /.test(l)).findIndex((l) => l.includes(key)); return i < 0 ? null : `m${i + 1}`; };
      if (nLine.includes("字典同步")) return { id, relation: "duplicate", target: pick("字典同步"), reason: "同一件事" };
      if (nLine.includes("Eliminate")) return { id, relation: "duplicate", target: pick("Eliminate"), reason: "同一条" };
      return { id, relation: "unrelated", target: null, reason: "无关" };
    });
    return { message: { role: "assistant", content: JSON.stringify({ results }) }, tokens: 1 };
  }) as Chat;
  const rep = await importPensieve(deps(store, chat), planImport([{ root: r, project: "alpha" }], new Map()));
  const props = store.project().props;
  assert.equal(props.get(auto)!.state, "archived");
  const kImp = [...props.values()].find((p) => p.import_ref?.id === "dict-sync-label")!;
  assert.equal(props.get(auto)!.merged_into, kImp.id);
  assert.equal(kImp.state, "active");
  assert.equal(kImp.extra_sources.length, 1, "被并入条目的来源挂到导入条上");
  const mImp = [...props.values()].find((p) => p.import_ref?.id === "eliminate-special-cases")!;
  assert.equal(mImp.state, "archived");
  assert.equal(mImp.merged_into, mine);
  assert.equal(props.get(mine)!.state, "active", "用户确认条目不动");
  assert.equal(rep.relate.mergedExisting, 1);
  assert.equal(rep.relate.mergedIntoExisting, 1);
  store.close();
});

test("关系判定出错时记下原因；再跑同一命令，未变但没判过关系的导入条会补判", async () => {
  const dir = join(base, `s${n++}`);
  mkdirSync(dir);
  const store = new Store(join(dir, "store.db"), join(dir, "index.db"));
  const pid = store.ensureProject("alpha");
  const src = { host: null, session_id: null, transcript: null, anchor: null, summary: "x" };
  const auto = store.remember(pid, null, false, { kind: "pitfall", text: "字典同步禁止用源库空 label 覆盖本地 label：同步曾以源库 label 为准，源库为空会把本地补全的 label 改回空。", confirmed: false, origin: "extract", source: src });
  const r = repo({ "knowledge/k/content.md": KNOW });
  const bad = (async () => { throw new Error("HTTP 400 bad request"); }) as unknown as Chat;
  const first = await importPensieve(deps(store, bad), planImport([{ root: r, project: "alpha" }], new Map()));
  assert.equal(first.relate.errors, 1);
  assert.match(first.relate.errorDetails[0], /HTTP 400/);
  const good = (async () => ({ message: { role: "assistant", content: JSON.stringify({ results: [{ id: "q1", relation: "duplicate", target: "m1", reason: "同一件事" }] }) }, tokens: 1 })) as unknown as Chat;
  const second = await importPensieve(deps(store, good), planImport([{ root: r, project: "alpha" }], new Map()));
  assert.deepEqual([second.created.length, second.unchanged, second.relate.mergedExisting], [0, 1, 1]);
  assert.equal(store.project().props.get(auto)!.state, "archived");
  const third = await importPensieve(deps(store, bad), planImport([{ root: r, project: "alpha" }], new Map()));
  assert.equal(third.relate.errors, 0, "判过的不再判");
  store.close();
});
