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
import { createHash } from "node:crypto";
import { fromBlob } from "./embed.ts";
import { Store, MAX_EMBED_PER_SYNC, VEC_TEXT_MAX_CHARS, vectorText, type Embedder } from "./store.ts";
import { BODY_MAX_CHARS, fold, type EventRow, type Projection, type RememberBody } from "./l2.ts";

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

const fakeEmbed: Embedder = async (texts) => texts.map((text) => Float32Array.from([
  /[猫喵]/.test(text) ? 1 : 0,
  /[狗犬]/.test(text) ? 1 : 0,
  /[雨湿]/.test(text) ? 1 : 0,
]));

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

test("fold：未确认的纠正挂在目标的 pending_corrections 上，确认或归档后消失", () => {
  const s = mem();
  const pid = s.ensureProject("p");
  const old = s.remember(pid, "s1", false, { kind: "pitfall", text: "锁用全局一把", confirmed: true, source: src() });
  const rejected = s.remember(pid, "s1", false, { kind: "pitfall", text: "锁不用加", confirmed: false, supersedes: old, source: src() });
  const accepted = s.remember(pid, "s1", false, { kind: "pitfall", text: "锁按账户分", confirmed: false, supersedes: old, source: src() });
  assert.deepEqual(s.project().props.get(old)!.pending_corrections, [rejected, accepted]);
  assert.equal(s.project().props.get(old)!.state, "active");
  s.lifecycle("archive", rejected, "s1");
  assert.deepEqual(s.project().props.get(old)!.pending_corrections, [accepted]);
  s.lifecycle("confirm", accepted, "s1");
  const target = s.project().props.get(old)!;
  assert.equal(target.state, "superseded");
  assert.equal(target.superseded_by, accepted);
  assert.deepEqual(target.pending_corrections, []);
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

test("混合检索：无字面重叠、FTS 搜不到时向量能召回", async () => {
  const s = mem();
  try {
    const id = s.remember(null, "cat", false, { kind: "note", text: "猫咪很可爱", confirmed: true, source: src() });
    s.remember(null, "dog", false, { kind: "note", text: "狗喜欢散步", confirmed: true, source: src() });
    const opts = { projects: [], includeGlobal: true };
    assert.deepEqual(s.search("喵星人", opts), []);
    let queries = 0;
    const result = await s.searchHybrid("喵星人", opts, async (texts) => {
      if (texts.includes("喵星人")) { queries++; assert.deepEqual(texts, ["喵星人"]); }
      return fakeEmbed(texts);
    });
    assert.equal(result.degraded, null);
    assert.deepEqual(result.hits.map((p) => p.id), [id]);
    assert.equal(queries, 1);
  } finally { s.close(); }
});

test("向量 Purge：提交后立即删除 vecs，无需再次 syncVectors", async () => {
  const s = mem();
  try {
    const gone = s.remember(null, "gone", false, { kind: "note", text: "猫咪", confirmed: true, source: src() });
    const keep = s.remember(null, "keep", false, { kind: "note", text: "狗狗", confirmed: true, source: src() });
    await s.syncVectors(fakeEmbed, "fake");
    s.purgeSession("gone");
    const rows = (s as any).fts.prepare("SELECT id FROM vecs").all();
    assert.deepEqual(rows.map((p: { id: string }) => p.id), [keep]);
    assert.equal(s.project().props.has(gone), false);
  } finally { s.close(); }
});

test("向量写回：embedding 无写锁，期间另一实例 Purge 不会复活向量", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-vec-purge-"));
  const a = new Store(join(dir, "store.db"), join(dir, "index.db"));
  const b = new Store(join(dir, "store.db"), join(dir, "index.db"));
  try {
    a.remember(null, "gone", false, { kind: "note", text: "猫咪", confirmed: true, source: src() });
    const keep = a.remember(null, "keep", false, { kind: "note", text: "狗狗", confirmed: true, source: src() });
    const result = await a.syncVectors(async (texts) => {
      assert.equal((a as any).fts.isTransaction, false);
      assert.equal((a as any).db.isTransaction, false);
      b.purgeSession("gone");
      return fakeEmbed(texts);
    }, "fake");
    assert.deepEqual(result, { embedded: 1, pending: 0 });
    assert.deepEqual((a as any).fts.prepare("SELECT id FROM vecs").all().map((p: { id: string }) => p.id), [keep]);
  } finally {
    a.close(); b.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test("向量同步：全部 state 均向量化，文本相同不重复请求，模型变化清空重算", async () => {
  const s = mem();
  try {
    const old = s.remember(null, "s", false, { kind: "note", text: "猫", why: "狗", confirmed: true, source: src() });
    const archived = s.remember(null, "s", false, { kind: "note", text: "雨", confirmed: false, source: src() });
    s.lifecycle("archive", archived, "s");
    s.remember(null, "s", false, { kind: "note", text: "喵", confirmed: true, supersedes: old, source: src() });
    let calls = 0;
    const embedder: Embedder = async (texts) => {
      calls++;
      assert.deepEqual(texts, ["猫\n狗", "雨", "喵"]);
      return fakeEmbed(texts);
    };
    assert.deepEqual(await s.syncVectors(embedder, "one"), { embedded: 3, pending: 0 });
    assert.deepEqual(await s.syncVectors(embedder, "one"), { embedded: 0, pending: 0 });
    assert.equal(calls, 1);
    assert.deepEqual(s.vectorStatus(), { model: "one", embedded: 3, total: 3 });
    const row = (s as any).fts.prepare("SELECT text_hash,vec FROM vecs WHERE id=?").get(old);
    assert.equal(row.text_hash, createHash("sha256").update("猫\n狗").digest("hex"));
    assert.deepEqual(fromBlob(row.vec), Float32Array.from([1, 1, 0]));
    assert.deepEqual(await s.syncVectors(async (texts) => {
      assert.equal((s as any).fts.prepare("SELECT count(*) AS n FROM vecs").get().n, 0);
      assert.equal(s.vectorStatus().model, "two");
      return embedder(texts);
    }, "two"), { embedded: 3, pending: 0 });
    assert.equal(calls, 2);
  } finally { s.close(); }
});

test("向量同步：每次最多 200 条，返回剩余数量", async () => {
  const s = mem();
  try {
    for (let i = 0; i < MAX_EMBED_PER_SYNC + 5; i++) {
      s.remember(null, null, false, { kind: "note", text: `猫${i}`, confirmed: true, source: src() });
    }
    const sizes: number[] = [];
    const embedder: Embedder = async (texts) => { sizes.push(texts.length); return fakeEmbed(texts); };
    assert.deepEqual(await s.syncVectors(embedder, "fake"), { embedded: 200, pending: 5 });
    assert.deepEqual(await s.syncVectors(embedder, "fake"), { embedded: 5, pending: 0 });
    assert.deepEqual(sizes, [200, 5]);
  } finally { s.close(); }
});

test("向量同步：hash 变化重新请求，embedding 期间正文变化不写回旧向量", async () => {
  const s = mem();
  try {
    const id = s.remember(null, "s", false, { kind: "note", text: "猫", confirmed: true, source: src() });
    await s.syncVectors(fakeEmbed, "fake");
    const replaceText = (text: string) => {
      (s as any).db.prepare("UPDATE events SET body=? WHERE id=?").run(
        JSON.stringify({ kind: "note", text, confirmed: true, source: src() }), id,
      );
      (s as any).cache = null;
    };
    replaceText("狗");
    assert.equal(s.vectorStatus().embedded, 0);
    assert.deepEqual(await s.syncVectors(async (texts) => {
      assert.deepEqual(texts, ["狗"]);
      replaceText("雨");
      return fakeEmbed(texts);
    }, "fake"), { embedded: 0, pending: 1 });
    assert.deepEqual(await s.syncVectors(fakeEmbed, "fake"), { embedded: 1, pending: 0 });
    const row = (s as any).fts.prepare("SELECT vec FROM vecs WHERE id=?").get(id);
    assert.deepEqual(fromBlob(row.vec), Float32Array.from([0, 0, 1]));
  } finally { s.close(); }
});

test("向量同步：并发模型切换拒绝旧模型写回", async () => {
  const s = mem();
  try {
    const id = s.remember(null, "s", false, { kind: "note", text: "猫", confirmed: true, source: src() });
    await assert.rejects(s.syncVectors(async (texts) => {
      await s.syncVectors(async (input) => input.map(() => Float32Array.from([0, 1, 0])), "new");
      return fakeEmbed(texts);
    }, "old"), /模型在请求期间已变化/);
    assert.equal(s.vectorStatus().model, "new");
    assert.deepEqual(fromBlob((s as any).fts.prepare("SELECT vec FROM vecs WHERE id=?").get(id).vec), Float32Array.from([0, 1, 0]));
  } finally { s.close(); }
});

test("混合检索：embedding 抛错或未配置时返回纯 FTS 和降级原因", async () => {
  const s = mem();
  try {
    s.remember(null, "s", false, { kind: "note", text: "猫咪很可爱", confirmed: true, source: src() });
    const opts = { projects: [], includeGlobal: true };
    const expected = s.search("猫咪很可爱", opts);
    const failed = await s.searchHybrid("猫咪很可爱", opts, async () => { throw new Error("假接口超时"); });
    assert.deepEqual(failed.hits, expected);
    assert.match(failed.degraded!, /假接口超时/);
    assert.deepEqual(await s.searchHybrid("猫咪很可爱", opts, null), { hits: expected, degraded: "未配置 embedding" });
  } finally { s.close(); }
});

test("混合检索：同步失败只报告降级，已缓存向量仍可用于搜索", async () => {
  const s = mem();
  try {
    const id = s.remember(null, "s", false, { kind: "note", text: "猫咪很可爱", confirmed: true, source: src() });
    await s.syncVectors(fakeEmbed, "fake");
    s.remember(null, "s", false, { kind: "note", text: "狗狗", confirmed: true, source: src() });
    const result = await s.searchHybrid("喵星人", { projects: [], includeGlobal: true }, async (texts) => {
      if (texts[0] !== "喵星人") throw new Error("假同步失败");
      return fakeEmbed(texts);
    });
    assert.deepEqual(result.hits.map((p) => p.id), [id]);
    assert.match(result.degraded!, /向量未更新.*假同步失败/);
  } finally { s.close(); }
});

test("混合检索：范围、kind、state 在向量 top-N 前过滤", async () => {
  const s = mem();
  try {
    const a = s.ensureProject("a");
    const b = s.ensureProject("b");
    const body = (text: string, kind: RememberBody["kind"] = "note"): RememberBody => ({ kind, text, confirmed: true, source: src() });
    for (let i = 0; i < 25; i++) s.remember(b, "b", false, body(`猫${i}`));
    const target = s.remember(a, "a", false, body("猫狗"));
    const archived = s.remember(a, "a", false, body("猫旧"));
    s.lifecycle("archive", archived, "a");
    const superseded = s.remember(a, "a", false, body("猫前"));
    s.remember(a, "a", false, { ...body("狗后"), supersedes: superseded });
    s.remember(a, "a", false, body("猫规则", "rule"));
    const global = s.remember(null, "g", false, body("猫全局"));
    const opts = { projects: [a], includeGlobal: false, kind: "note" as const };
    const result = await s.searchHybrid("喵", opts, fakeEmbed);
    assert.deepEqual(result.hits.map((p) => p.id), [target], "25 条更相似的外项目条目不会挤掉本项目候选");
    const history = await s.searchHybrid("喵", { ...opts, includeArchived: true }, fakeEmbed);
    assert.deepEqual(new Set(history.hits.map((p) => p.id)), new Set([target, archived, superseded]));
    const withGlobal = await s.searchHybrid("喵", { ...opts, includeGlobal: true }, fakeEmbed);
    assert.deepEqual(new Set(withGlobal.hits.map((p) => p.id)), new Set([target, global]));
    const globalOnly = await s.searchHybrid("喵", { projects: [], includeGlobal: true }, fakeEmbed);
    assert.deepEqual(globalOnly.hits.map((p) => p.id), [global]);
    const all = await s.searchHybrid("喵", { projects: "all", includeGlobal: false, limit: 20 }, fakeEmbed);
    assert.equal(all.hits.length, 20);
    assert.ok(all.hits.every((p) => p.project_id !== null));
  } finally { s.close(); }
});

test("混合检索：RRF 双路命中优先、去重并截到 limit", async () => {
  const s = mem();
  try {
    const both = s.remember(null, "s", false, { kind: "note", text: "猫喵", confirmed: true, source: src() });
    s.remember(null, "s", false, { kind: "note", text: "猫", confirmed: true, source: src() });
    s.remember(null, "s", false, { kind: "note", text: "喵字面", confirmed: true, source: src() });
    const embedder: Embedder = async (texts) => texts.map((t) => Float32Array.from(t === "喵字面" ? [0, 1] : [1, 0]));
    const result = await s.searchHybrid("喵", { projects: [], includeGlobal: true, limit: 1 }, embedder);
    assert.deepEqual(result.hits.map((p) => p.id), [both]);
  } finally { s.close(); }
});

test("近邻：只用已存向量，限本项目加全局、只看 active、过门槛；本条无向量返回 null", async () => {
  const s = mem();
  try {
    const p = s.ensureProject("p");
    const q = s.ensureProject("q");
    const body = (text: string) => ({ kind: "note" as const, text, confirmed: true, source: src() });
    const self = s.remember(p, "s1", false, body("猫要喂"));
    const same = s.remember(p, "s1", false, body("猫粮在柜子里"));
    const global = s.remember(null, "s1", false, body("喵星人怕水"));
    s.remember(q, "s1", false, body("别的项目的猫"));
    s.remember(p, "s1", false, body("狗要遛"));
    const archived = s.remember(p, "s1", false, body("旧的猫笔记"));
    s.lifecycle("archive", archived, "s1");
    await s.syncVectors(fakeEmbed, "fake");
    assert.deepEqual(s.neighbors(self)!.map((n) => n.prop.id).sort(), [same, global].sort());
    assert.equal(s.neighbors(self)![0].similarity, 1);
    const fresh = s.remember(p, "s1", false, body("刚记的猫"));
    assert.equal(s.neighbors(fresh), null);
    assert.equal(s.neighbors(same)!.some((n) => n.prop.id === fresh), false, "没有向量的条目不当近邻");
  } finally { s.close(); }
});

test("混合检索：查询 embedding 期间 Purge，返回结果不含旧 FTS 命中", async () => {
  const s = mem();
  try {
    s.remember(null, "gone", false, { kind: "note", text: "猫咪", confirmed: true, source: src() });
    await s.syncVectors(fakeEmbed, "fake");
    const result = await s.searchHybrid("猫咪", { projects: [], includeGlobal: true }, async (texts) => {
      s.purgeSession("gone");
      return fakeEmbed(texts);
    });
    assert.deepEqual(result, { hits: [], degraded: null });
    assert.equal(s.vectorStatus().embedded, 0);
  } finally { s.close(); }
});

test("混合检索：余弦门槛排除低相似候选", async () => {
  const s = mem();
  try {
    const pass = s.remember(null, "s", false, { kind: "note", text: "近", confirmed: true, source: src() });
    s.remember(null, "s", false, { kind: "note", text: "远", confirmed: true, source: src() });
    const embedder: Embedder = async (texts) => texts.map((text) => {
      if (text === "查询") return Float32Array.from([1, 0]);
      const similarity = text === "近" ? 0.46 : 0.44;
      return Float32Array.from([similarity, Math.sqrt(1 - similarity * similarity)]);
    });
    const result = await s.searchHybrid("查询", { projects: [], includeGlobal: true }, embedder);
    assert.deepEqual(result.hits.map((p) => p.id), [pass]);
    const strict = await s.searchHybrid("查询", { projects: [], includeGlobal: true, minSim: 0.5 }, embedder);
    assert.deepEqual(strict.hits, []);
  } finally { s.close(); }
});

test("混合检索：两路各取 20 条，融合 limit 可超过 20", async () => {
  const s = mem();
  try {
    for (let i = 0; i < 25; i++) {
      s.remember(null, "s", false, { kind: "note", text: `查询字面${i}`, confirmed: true, source: src() });
      s.remember(null, "s", false, { kind: "note", text: `语义${i}`, confirmed: true, source: src() });
    }
    const embedder: Embedder = async (texts) => texts.map((text) => Float32Array.from(text.startsWith("查询字面") ? [0, 1] : [1, 0]));
    const result = await s.searchHybrid("查询", { projects: [], includeGlobal: true, limit: 30 }, embedder);
    assert.equal(result.hits.length, 30);
    assert.equal(new Set(result.hits.map((p) => p.id)).size, 30);
    const all = await s.searchHybrid("查询", { projects: [], includeGlobal: true, limit: 100 }, embedder);
    assert.equal(all.hits.length, 40);
  } finally { s.close(); }
});

test("子代理召回的未确认门槛：只放有用户原话的未确认规则/决定，冲突、纠正、关系未判定、与代码不符、推断的坑都不放", async () => {
  const { recallable } = await import("./visibility.ts");
  const recallableUnconfirmed = (p: any) => !p.confirmed && recallable(p, true);
  const ok = { state: "active", confirmed: false, kind: "rule", basis: "user_directive", evidence: [{ role: "user" }], unreconciled: false, stale: null, conflicts_with: null, supersedes: undefined, pending_corrections: [] } as any;
  assert.equal(recallableUnconfirmed(ok), true);
  assert.equal(recallableUnconfirmed({ ...ok, kind: "decision", basis: "user_confirmed" }), true);
  for (const bad of [{ confirmed: true }, { kind: "pitfall" }, { basis: "agent_inference" }, { evidence: [{ role: "assistant" }] }, { unreconciled: true }, { stale: {} }, { conflicts_with: "x" }, { supersedes: "x" }, { pending_corrections: ["x"] }])
    assert.equal(recallableUnconfirmed({ ...ok, ...bad }), false, JSON.stringify(bad));
});


// ---------- §8.11 详情正文、否掉的方案、原话入库（2026-10-30） ----------

test("§8.11 投影：证据带原话和时间；追加来源的证据完整保存；旧数据缺省为空", () => {
  const rows: EventRow[] = [
    { seq: 1, id: "e1", ts: "2026-10-01T00:00:00Z", kind: "remember", project_id: "p", session_id: "s1", ephemeral: 0, target_id: null,
      body: JSON.stringify({ kind: "decision", text: "缓存用 Redis", confirmed: true, source: src("选型"),
        evidence: [
          { anchor: "u1", role: "user", quote_sha256: "h1", quote: "单机内存撑不住", said_at: "2026-10-01T00:01:00Z" },
          { anchor: "a1", role: "assistant", quote_sha256: "h2", quote: "可以先上 Redis 试一周" },
        ] }) },
    { seq: 2, id: "e2", ts: "2026-10-02T00:00:00Z", kind: "evidence", project_id: "p", session_id: "s2", ephemeral: 0, target_id: "e1",
      body: JSON.stringify({ source: { host: "codex", session_id: "s2", transcript: null, anchor: "u9", summary: "再确认" },
        basis: "user_directive", evidence: [{ anchor: "u9", role: "user", quote_sha256: "h3", quote: "Redis 就行" }], window_id: "w" }) },
    // 旧版本写的事件：证据只有哈希，没有原话和时间
    { seq: 3, id: "e3", ts: "2026-10-03T00:00:00Z", kind: "remember", project_id: "p", session_id: "s3", ephemeral: 0, target_id: null,
      body: JSON.stringify({ kind: "pitfall", text: "老坑", confirmed: true, source: src("旧"),
        evidence: [{ anchor: "u5", role: "user", quote_sha256: "h5" }] }) },
  ];
  const proj = fold(rows);
  const p = proj.props.get("e1")!;
  assert.deepEqual(p.evidence.map((e) => [e.quote, e.said_at]), [["单机内存撑不住", "2026-10-01T00:01:00Z"], ["可以先上 Redis 试一周", undefined]]);
  assert.deepEqual(p.extra_sources, [{
    host: "codex", session_id: "s2", basis: "user_directive",
    evidence: [{ anchor: "u9", role: "user", quote_sha256: "h3", quote: "Redis 就行" }],
  }], "追加来源也带原话");
  assert.equal(p.body, null);
  assert.deepEqual(p.alternatives, []);
  const old = proj.props.get("e3")!;
  assert.deepEqual(old.evidence, [{ anchor: "u5", role: "user", quote_sha256: "h5" }]);
  assert.equal(old.body, null);
});

test("§8.11 detail 事件：补正文和否掉的方案，不换 id、不改确认状态；已有 body 不覆盖并计数", () => {
  const s = mem();
  try {
    const pid = s.ensureProject("p");
    const id = s.remember(pid, "s1", false, { kind: "decision", text: "缓存用 Redis", confirmed: true, source: src() });
    const alt = { option: "继续用单机内存", rejected_because: "多实例下不一致" };
    s.detail(id, null, { body: "过期 300 秒", alternatives: [alt] });
    let p = s.project().props.get(id)!;
    assert.equal(p.body, "过期 300 秒");
    assert.deepEqual(p.alternatives, [alt]);
    assert.equal(p.confirmed, true);
    assert.equal(p.state, "active");
    assert.equal(p.seq, 1, "不换 id、不新增条目");
    assert.equal(s.project().detail_ignored, 0);

    s.detail(id, null, { body: "另一段正文" });
    p = s.project().props.get(id)!;
    assert.equal(p.body, "过期 300 秒", "已有 body 不覆盖");
    assert.equal(s.project().detail_ignored, 1, "被忽略的详情计诊断");

    const rule = s.remember(pid, "s1", false, { kind: "rule", text: "一行说清", confirmed: true, source: src() });
    assert.throws(() => s.detail(rule, null, { body: "规则不能带正文" }), /正文/);
    assert.throws(() => s.detail("missing", null, { body: "x" }), /unknown or purged/);
  } finally { s.close(); }
});

test("§8.11 写入口校验：body 只给决定/事实/坑，上限 40000 字；alternatives 只给决定、最多 5 项、各字段 200 字", () => {
  const s = mem();
  try {
    const pid = s.ensureProject("p");
    const mk = (extra: Partial<RememberBody>) => s.remember(pid, null, false, { kind: "note", text: "x", confirmed: true, source: src(), ...extra });
    assert.throws(() => s.remember(pid, null, false, { kind: "rule", text: "r", confirmed: true, source: src(), body: "详情" }), /正文/);
    assert.ok(mk({ body: "长".repeat(BODY_MAX_CHARS) }), "正好 40000 字通过");
    assert.throws(() => mk({ body: "长".repeat(BODY_MAX_CHARS + 1) }), /40000/);
    assert.throws(() => mk({ body: "配置里 token: sk-abcdefghijklmnopqrstuvwxyz0123" }), /密钥/);
    assert.throws(() => mk({ alternatives: [{ option: "甲", rejected_because: "乙" }] }), /决定/);
    const alts = Array.from({ length: 6 }, (_, i) => ({ option: `方案${i}`, rejected_because: "原因" }));
    assert.throws(() => s.remember(pid, null, false, { kind: "decision", text: "d", confirmed: true, source: src(), alternatives: alts }), /5/);
    assert.throws(() => s.remember(pid, null, false, { kind: "decision", text: "d", confirmed: true, source: src(),
      alternatives: [{ option: "长".repeat(201), rejected_because: "原因" }] }), /200/);
    assert.throws(() => s.remember(pid, null, false, { kind: "decision", text: "d", confirmed: true, source: src(),
      alternatives: [{ option: "甲", rejected_because: "key = sk-abcdefghijklmnopqrstuvwxyz0123" }] }), /密钥/);
    // evidence 下标越界的方案被丢掉，手写（缺 evidence）的保留
    const id = s.remember(pid, null, false, { kind: "decision", text: "决定", confirmed: true, source: src(),
      evidence: [{ anchor: "u1", role: "user", quote_sha256: "h" }],
      alternatives: [
        { option: "甲", rejected_because: "有原话支撑", evidence: 0 },
        { option: "乙", rejected_because: "下标越界", evidence: 3 },
        { option: "丙", rejected_because: "手写没有原话" },
      ] });
    assert.deepEqual(s.project().props.get(id)!.alternatives.map((a) => a.option), ["甲", "丙"]);
  } finally { s.close(); }
});

test("§8.11 向量文本含 body：补上正文后重算，超长截到输入上限", async () => {
  const s = mem();
  try {
    const noBody = s.remember(null, "s", false, { kind: "note", text: "猫", why: "狗", confirmed: true, source: src() });
    const texts: string[][] = [];
    const embedder: Embedder = async (t) => { texts.push(t); return fakeEmbed(t); };
    await s.syncVectors(embedder, "fake");
    assert.deepEqual(texts[0], ["猫\n狗"]);
    s.detail(noBody, null, { body: "雨" });
    assert.deepEqual(await s.syncVectors(embedder, "fake"), { embedded: 1, pending: 0 }, "body 变了要重算向量");
    assert.deepEqual(texts[1], ["猫\n狗\n雨"]);
    const huge = s.remember(null, "s", false, { kind: "note", text: "长", confirmed: true, source: src(), body: "长".repeat(BODY_MAX_CHARS) });
    assert.equal([...vectorText(s.project().props.get(huge)!)].length, VEC_TEXT_MAX_CHARS, "超出向量输入上限时截断");
  } finally { s.close(); }
});
