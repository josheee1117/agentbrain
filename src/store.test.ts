/**
 * 存储层不变量测试（设计 §15.1）。运行：node --test src/
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store, fold, type Projection, type RememberBody } from "./store.ts";

function mem() {
  return new Store(":memory:", ":memory:");
}
const src = (summary = "讨论"): RememberBody["source"] => ({
  host: "pi",
  session_id: "s",
  transcript: null,
  anchor: null,
  summary,
});

test("相同 L1 → 相同 L2（纯函数，重复 fold 结果相同）", () => {
  const s = mem();
  const pid = s.ensureProject("p");
  s.remember(pid, "s1", false, { kind: "pitfall", text: "别在 agent_end 里同步调模型", confirmed: true, source: src() });
  const a = s.remember(pid, "s1", false, { kind: "decision", text: "用 SQLite", confirmed: true, source: src() });
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
  const pid = s.ensureProject("p");
  const id = s.remember(pid, "s1", false, { kind: "note", text: "x", confirmed: true, source: src() });
  s.lifecycle("archive", id, "s1");
  assert.equal(s.search("x", { projects: [pid], includeGlobal: false }).length, 0, "归档后默认搜不到");
  assert.equal(s.search("x", { projects: [pid], includeGlobal: false, includeArchived: true }).length, 1);
  s.lifecycle("reactivate", id, "s1");
  assert.equal(s.project().props.get(id)!.state, "active");
  assert.throws(() => s.lifecycle("archive", "nope", "s1"), /unknown or purged/);
  s.close();
});

test("ephemeral 证据记录但不投影，doctor 可见", () => {
  const s = mem();
  const pid = s.ensureProject("p");
  s.remember(pid, null, true, { kind: "pitfall", text: "子代理的临时结论", confirmed: true, source: src() });
  const p = s.project();
  assert.equal(p.props.size, 0);
  assert.equal(p.ephemeral, 1);
  s.close();
});

test("范围 Purge：声明+枚举同一事务；正文不可从 L1/L2/L3 任一面恢复；无关会话不受影响", () => {
  const s = mem();
  const pid = s.ensureProject("p");
  const a = s.remember(pid, "s1", false, { kind: "note", text: "SECRET_ALPHA", confirmed: true, source: src("含密钥") });
  const b = s.remember(pid, "s2", false, { kind: "note", text: "keep me", confirmed: true, source: src() });
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
  const opt = { projects: [pid], includeGlobal: false } as const;
  assert.equal(s.search("SECRET_ALPHA", opt).length, 0);
  assert.equal(s.search("keep", { ...opt, includeArchived: true }).length, 1);
  assert.throws(() => s.lifecycle("reactivate", a, "s3"));
  s.close();
});

test("删除 index.db 后重新打开自动重建，搜索恢复（L3 可重建）", () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-"));
  const sp = join(dir, "store.db");
  const ip = join(dir, "index.db");
  let s = new Store(sp, ip);
  const pid = s.ensureProject("p");
  s.remember(pid, "s1", false, { kind: "pitfall", text: "项目用 SQLite 存流水账，不要用 git 做同步", confirmed: true, source: src() });
  s.close();
  rmSync(ip, { force: true });
  rmSync(ip + "-wal", { force: true });
  rmSync(ip + "-shm", { force: true });
  assert.equal(existsSync(ip), false);
  s = new Store(sp, ip);
  const opt = { projects: [pid], includeGlobal: false };
  assert.equal(s.search("流水账", opt).length, 1, "中文三字词命中");
  assert.equal(s.search("sqlite", opt).length, 1, "大小写不敏感");
  assert.equal(s.search("git", opt).length, 1, "三字母走 FTS");
  assert.equal(s.search("同步", opt).length, 1, "两字短词退回 LIKE");
  assert.equal(s.search("kubernetes", opt).length, 0);
  s.close();
  rmSync(dir, { recursive: true, force: true });
});

test("项目隔离：另一个项目搜不到本项目的记忆；同名 ensureProject 返回同一 id", () => {
  const s = mem();
  const a = s.ensureProject("A");
  const b = s.ensureProject("B");
  s.remember(a, "s1", false, { kind: "note", text: "only in A project", confirmed: true, source: src() });
  assert.equal(s.search("project", { projects: [b], includeGlobal: false }).length, 0);
  assert.equal(s.search("project", { projects: [a], includeGlobal: false }).length, 1);
  assert.equal(s.ensureProject("A"), a);
  assert.deepEqual(s.listProjects().map((p) => p.name), ["A", "B"]);
  s.close();
});

test("两个 Store 实例打开同一对文件：A 写入后 B 的 project() 和 search() 都能看到", () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-mp-"));
  const sp = join(dir, "store.db");
  const ip = join(dir, "index.db");
  const a = new Store(sp, ip);
  const b = new Store(sp, ip);
  assert.equal(b.project().props.size, 0);
  const pid = a.ensureProject("p");
  a.remember(pid, "s1", false, { kind: "pitfall", text: "多进程写入后另一个实例必须看得到", confirmed: true, source: src() });
  assert.equal(b.project().props.size, 1, "B 的投影按 L1 水位重算");
  const hits = b.search("多进程", { projects: [pid], includeGlobal: false });
  assert.equal(hits.length, 1, "B 的索引按水位重建");
  assert.equal(hits[0].project_id, pid);
  a.close();
  b.close();
  rmSync(dir, { recursive: true, force: true });
});

test("全局记忆 project_id 为 null；includeGlobal 控制是否命中", () => {
  const s = mem();
  const pid = s.ensureProject("p");
  s.remember(null, "s1", false, { kind: "rule", text: "实现交给 Codex", confirmed: true, source: src() });
  const g = [...s.project().props.values()][0];
  assert.equal(g.project_id, null);
  const base = { projects: [pid] as string[], kind: "rule" as const };
  assert.equal(s.search("Codex", { ...base, includeGlobal: true }).length, 1);
  assert.equal(s.search("Codex", { ...base, includeGlobal: false }).length, 0);
  const hit = s.search("Codex", { projects: "all", includeGlobal: true })[0];
  assert.equal(hit.project_id, null);
  s.close();
});

test("for_workers 落盘并投影出来", () => {
  const s = mem();
  const id = s.remember(null, "s1", false, { kind: "rule", text: "代码风格统一", for_workers: true, confirmed: true, source: src() });
  assert.equal(s.project().props.get(id)!.for_workers, true);
  const plain = s.remember(null, "s1", false, { kind: "rule", text: "只给主会话看", confirmed: true, source: src() });
  assert.equal(s.project().props.get(plain)!.for_workers, false);
  const row = (s as any).db.prepare("SELECT body FROM events WHERE id=?").get(id) as { body: string };
  assert.equal(JSON.parse(row.body).for_workers, true);
  s.close();
});

test("purgeSession 提交后 index.db 不再含被清除正文", () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-purge-"));
  const s = new Store(join(dir, "store.db"), join(dir, "index.db"));
  const pid = s.ensureProject("p");
  s.remember(pid, "s1", false, { kind: "note", text: "SECRET_ALPHA", confirmed: true, source: src() });
  s.search("SECRET", { projects: [pid], includeGlobal: false });
  s.purgeSession("s1");
  const idx = new DatabaseSync(join(dir, "index.db"));
  const hit = idx.prepare("SELECT text FROM props WHERE text LIKE '%SECRET_ALPHA%'").get();
  const seq = idx.prepare("SELECT value FROM meta WHERE key='seq'").get() as { value: string };
  const max = (s as any).db.prepare("SELECT max(seq) AS seq FROM events").get() as { seq: number };
  assert.equal(hit, undefined);
  assert.equal(Number(seq.value), max.seq);
  idx.close();
  s.close();
  rmSync(dir, { recursive: true, force: true });
});

test("旧投影不能把已前进的 index 水位盖回去", () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-idx-"));
  const a = new Store(join(dir, "store.db"), join(dir, "index.db"));
  const b = new Store(join(dir, "store.db"), join(dir, "index.db"));
  const pid = a.ensureProject("p");
  a.remember(pid, "s1", false, { kind: "note", text: "旧水位 ONE", confirmed: true, source: src() });
  const stale: Projection = a.project();
  const staleSeq = (a as any).watermark();
  assert.equal(staleSeq, 1);
  b.remember(pid, "s1", false, { kind: "note", text: "新水位 TWO_BETA", confirmed: true, source: src() });
  b.search("TWO_BETA", { projects: [pid], includeGlobal: false });
  assert.equal((a as any).writeIndex(staleSeq, stale), false);
  const seq = (a as any).fts.prepare("SELECT value FROM meta WHERE key='seq'").get() as { value: string };
  assert.equal(Number(seq.value), 2);
  assert.equal(a.search("TWO_BETA", { projects: [pid], includeGlobal: false }).length, 1);
  a.close();
  b.close();
  rmSync(dir, { recursive: true, force: true });
});

test("purge 后同 session 不能再写入，别的 session 可以", () => {
  const s = mem();
  const pid = s.ensureProject("p");
  s.remember(pid, "s1", false, { kind: "note", text: "gone", confirmed: true, source: src() });
  s.purgeSession("s1");
  assert.throws(
    () => s.remember(pid, "s1", false, { kind: "note", text: "复活", confirmed: true, source: src() }),
    /该会话已清除，不再接受写入/,
  );
  const id = s.remember(pid, "s2", false, { kind: "note", text: "别的会话", confirmed: true, source: src() });
  assert.equal(s.project().props.get(id)!.text, "别的会话");
  s.close();
});

test("fold 对缺 confirmed 的旧 body 视为已确认", () => {
  const s = mem();
  const pid = s.ensureProject("p");
  const id = s.remember(pid, "s1", false, { kind: "pitfall", text: "旧数据", confirmed: true, source: src() });
  (s as any).db.prepare("UPDATE events SET body=? WHERE id=?").run(
    JSON.stringify({ kind: "pitfall", text: "旧数据", source: src() }),
    id,
  );
  (s as any).cache = null;
  assert.equal(s.project().props.get(id)!.confirmed, true);
  const fresh = s.remember(pid, "s1", false, { kind: "note", text: "新写入", confirmed: false, source: src() });
  assert.equal(s.project().props.get(fresh)!.confirmed, false);
  s.lifecycle("confirm", fresh, "s1");
  assert.equal(s.project().props.get(fresh)!.confirmed, true);
  assert.throws(() => s.lifecycle("confirm", "nope", "s1"), /unknown or purged/);
  s.close();
});

test("fold：已确认且带 supersedes 的条目使目标变 superseded，目标不存在计 orphan", () => {
  const s = mem();
  const pid = s.ensureProject("p");
  const old = s.remember(pid, "s1", false, { kind: "decision", text: "用文件", confirmed: true, source: src() });
  const neu = s.remember(pid, "s1", false, {
    kind: "decision",
    text: "用 SQLite",
    confirmed: true,
    supersedes: old,
    source: src(),
  });
  const p = s.project();
  assert.equal(p.props.get(old)!.state, "superseded");
  assert.equal(p.props.get(old)!.superseded_by, neu);
  assert.equal(p.props.get(neu)!.supersedes, old);
  const before = p.orphans;
  s.remember(pid, "s1", false, {
    kind: "note",
    text: "指向不存在",
    confirmed: true,
    supersedes: "missing-id",
    source: src(),
  });
  assert.equal(s.project().orphans, before + 1);
  assert.equal(s.project().props.get(neu)!.state, "active");
  s.close();
});

test("fold 处理 project_id 为 null", () => {
  const s = mem();
  const id = s.remember(null, "s1", false, { kind: "note", text: "全局事实", confirmed: true, source: src() });
  const rows = (s as any).db.prepare("SELECT * FROM events ORDER BY seq").all();
  assert.equal(fold(rows).props.get(id)!.project_id, null);
  s.close();
});

test("换了 store.db 而 index.db 留着：旧索引作废，搜不到旧正文", () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-swap-"));
  const idx = join(dir, "index.db");
  const a = new Store(join(dir, "a.db"), idx);
  const pa = a.ensureProject("p");
  a.remember(pa, "s1", false, { kind: "note", text: "OLD_STORE_A", confirmed: true, source: src() });
  a.remember(pa, "s1", false, { kind: "note", text: "OLD_STORE_B", confirmed: true, source: src() });
  assert.equal(a.search("OLD_STORE", { projects: "all", includeGlobal: true }).length, 2);
  a.close();
  const b = new Store(join(dir, "b.db"), idx);
  b.remember(b.ensureProject("p"), "s1", false, { kind: "note", text: "NEW_STORE", confirmed: true, source: src() });
  assert.equal(b.search("OLD_STORE", { projects: "all", includeGlobal: true }).length, 0);
  assert.equal(b.search("NEW_STORE", { projects: "all", includeGlobal: true }).length, 1);
  b.close();
  rmSync(dir, { recursive: true, force: true });
});

test("另一个进程持有写锁时打开 Store 不抛错", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-lock-"));
  const sp = join(dir, "store.db");
  const script = join(dir, "hold.cjs");
  writeFileSync(
    script,
    [
      'const { DatabaseSync } = require("node:sqlite");',
      "const db = new DatabaseSync(process.argv[2]);",
      'db.exec("PRAGMA journal_mode=WAL; BEGIN EXCLUSIVE");',
      'process.stdout.write("locked");',
      "setTimeout(() => { db.exec('COMMIT'); db.close(); process.exit(0); }, 400);",
    ].join("\n"),
  );
  const child = spawn(process.execPath, [script, sp]);
  let buf = "";
  const locked = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("子进程没有及时报 locked")), 9000);
    child.stdout.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      if (buf.includes("locked")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`子进程在报 locked 前退出: ${code}`));
    });
  });
  try {
    await locked;
    const s = new Store(sp, join(dir, "index.db"));
    s.close();
    const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
    assert.equal(code, 0);
  } finally {
    if (child.exitCode === null) child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});
