/**
 * 切片 1 不变量测试（设计 §15.1）。运行：node --test extension/
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, fold } from "./store.ts";
import { expandSource } from "./source.ts";

function mem() {
  return new Store(":memory:", ":memory:");
}
const src = (summary = "讨论") => ({ file: null, entry_id: null, summary });

test("相同 L1 → 相同 L2（纯函数，重复 fold 结果相同）", () => {
  const s = mem();
  const pid = s.bind("/r", "p");
  s.remember(pid, "s1", false, { kind: "pitfall", text: "别在 agent_end 里同步调模型", source: src() });
  const a = s.remember(pid, "s1", false, { kind: "decision", text: "用 SQLite", source: src() });
  s.lifecycle("archive", a, "s1");
  const p1 = s.project();
  const rows = (s as any).db.prepare("SELECT * FROM events ORDER BY seq").all();
  const p2 = fold(rows);
  assert.deepEqual([...p1.props.values()], [...p2.props.values()]);
  assert.equal(p1.props.get(a)!.state, "archived");
  s.close();
});

test("archive/reactivate 状态轴；未知目标 fail-closed", () => {
  const s = mem();
  const pid = s.bind("/r", "p");
  const id = s.remember(pid, "s1", false, { kind: "note", text: "x", source: src() });
  s.lifecycle("archive", id, "s1");
  assert.equal(s.search(pid, "x").length, 0, "归档后默认搜不到");
  assert.equal(s.search(pid, "x", { includeArchived: true }).length, 1);
  s.lifecycle("reactivate", id, "s1");
  assert.equal(s.project().props.get(id)!.state, "active");
  assert.throws(() => s.lifecycle("archive", "nope", "s1"), /unknown or purged/);
  s.close();
});

test("ephemeral 证据记录但不投影，doctor 可见", () => {
  const s = mem();
  const pid = s.bind("/r", "p");
  s.remember(pid, null, true, { kind: "pitfall", text: "子代理的临时结论", source: src() });
  const p = s.project();
  assert.equal(p.props.size, 0);
  assert.equal(p.ephemeral, 1);
  s.close();
});

test("范围 Purge：声明+枚举同一事务；正文不可从 L1/L2/L3 任一面恢复；无关会话不受影响", () => {
  const s = mem();
  const pid = s.bind("/r", "p");
  const a = s.remember(pid, "s1", false, { kind: "note", text: "SECRET_ALPHA", source: src("含密钥") });
  const b = s.remember(pid, "s2", false, { kind: "note", text: "keep me", source: src() });
  s.lifecycle("archive", a, "s1");
  const r = s.purgeSession("s1");
  assert.equal(r.enumerated.length, 2, "枚举包含 remember 与 archive 两条");
  const rows = (s as any).db.prepare("SELECT kind, body FROM events ORDER BY seq").all();
  for (const row of rows) if (row.kind !== "purge") assert.ok(!String(row.body).includes("SECRET_ALPHA"));
  const purge = rows.find((x: any) => x.kind === "purge");
  assert.deepEqual(JSON.parse(purge.body).enumerated, r.enumerated);
  const p = s.project();
  assert.equal(p.props.has(a), false);
  assert.equal(p.props.get(b)!.text, "keep me");
  assert.equal(p.purged, 2);
  assert.equal(s.search(pid, "SECRET_ALPHA").length, 0);
  assert.equal(s.search(pid, "keep", { includeArchived: true }).length, 1);
  // 迟到的 meta-lifecycle 指向已清除目标 → 拒绝
  assert.throws(() => s.lifecycle("reactivate", a, "s3"));
  s.close();
});

test("删除 index.db 后重新打开自动重建，搜索恢复（L3 可重建）", () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-"));
  const sp = join(dir, "store.db");
  const ip = join(dir, "index.db");
  let s = new Store(sp, ip);
  const pid = s.bind("/r", "p");
  s.remember(pid, "s1", false, { kind: "pitfall", text: "项目用 SQLite 存流水账，不要用 git 做同步", source: src() });
  s.close();
  rmSync(ip, { force: true });
  rmSync(ip + "-wal", { force: true });
  rmSync(ip + "-shm", { force: true });
  assert.equal(existsSync(ip), false);
  s = new Store(sp, ip);
  assert.equal(s.search(pid, "流水账").length, 1, "中文三字词命中");
  assert.equal(s.search(pid, "sqlite").length, 1, "大小写不敏感");
  assert.equal(s.search(pid, "git").length, 1, "三字母走 FTS");
  assert.equal(s.search(pid, "同步").length, 1, "两字短词退回 LIKE");
  assert.equal(s.search(pid, "kubernetes").length, 0);
  s.close();
  rmSync(dir, { recursive: true, force: true });
});

test("项目隔离：另一个项目搜不到本项目的记忆", () => {
  const s = mem();
  const a = s.bind("/a", "A");
  const b = s.bind("/b", "B");
  s.remember(a, "s1", false, { kind: "note", text: "only in A project", source: src() });
  assert.equal(s.search(b, "project").length, 0);
  assert.equal(s.search(a, "project").length, 1);
  assert.equal(s.bind("/a2", "A"), a, "同名再次 bind 得到同一项目 id（多 checkout）");
  s.close();
});

test("Source Pointer 展开：沿 parentId 回溯，按时间顺序输出；文件缺失返回 null", () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-src-"));
  const f = join(dir, "s.jsonl");
  const lines = [
    { type: "session", version: 3, id: "x" },
    { type: "message", id: "e1", parentId: null, message: { role: "user", content: "我们用 SQLite 还是文件？" } },
    { type: "message", id: "e2", parentId: "e1", message: { role: "assistant", content: [{ type: "text", text: "SQLite，理由是事务。" }] } },
    { type: "message", id: "e3", parentId: "e2", message: { role: "toolResult", content: [{ type: "text", text: "noise" }] } },
    { type: "message", id: "e4", parentId: "e3", message: { role: "user", content: "好，就这么定。" } },
    { type: "message", id: "other", parentId: "e1", message: { role: "user", content: "另一个分支" } },
  ];
  writeFileSync(f, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const out = expandSource({ file: f, entry_id: "e4", summary: "" })!;
  assert.match(out, /^\[user\] 我们用 SQLite/);
  assert.ok(out.indexOf("SQLite，理由") < out.indexOf("就这么定"));
  assert.ok(!out.includes("noise"), "工具结果不进讨论片段");
  assert.ok(!out.includes("另一个分支"), "只沿祖先链，不读其他分支");
  assert.equal(expandSource({ file: f, entry_id: "missing", summary: "" }), null);
  assert.equal(expandSource({ file: join(dir, "nope.jsonl"), entry_id: "e1", summary: "" }), null);
  rmSync(dir, { recursive: true, force: true });
});
