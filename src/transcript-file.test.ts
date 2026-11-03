/**
 * 文件层入口（设计 §7.6）：resolveTranscript / readTranscript / allowedTranscript。
 * 全部用 zstdCompressSync 生成的真实压缩文件和临时 HOME。
 * 运行：node --test src/transcript-file.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs, { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { allowedTranscript, readTranscript, resolveTranscript } from "./transcript-file.ts";
import { expandSource, latestAnchor, linesOf } from "./source.ts";
import { cleanTranscript, isWorkerTranscript } from "./transcript.ts";
import { modelOf } from "./telemetry.ts";

const base = realpathSync(mkdtempSync(join(tmpdir(), "ab-tfile-")));
let n = 0;

function env() {
  const dir = realpathSync(mkdtempSync(join(base, `e${n++}-`)));
  const home = join(dir, "home");
  const roots = { codex: join(home, ".codex/sessions"), codexArch: join(home, ".codex/archived_sessions"), claude: join(home, ".claude/projects/p"), pi: join(home, ".pi/agent/sessions") };
  for (const d of [roots.codex, roots.codexArch, roots.claude, roots.pi]) mkdirSync(d, { recursive: true });
  const old = process.env.HOME;
  process.env.HOME = home;
  const restore = () => {
    process.env.HOME = old;
  };
  return { dir, home, roots, restore };
}

const bigText = () => {
  const out: string[] = [];
  for (let i = 0; i < 30_000; i++) out.push(JSON.stringify({ ordinal: i, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `第 ${i} 行内容内容内容` }] } }));
  return out.join("\n") + "\n";
};

function put(file: string, text: string, compress: boolean): Buffer {
  const raw = Buffer.from(text, "utf8");
  if (!compress) {
    writeFileSync(file, raw);
    return raw;
  }
  const c = zstdCompressSync(raw);
  writeFileSync(file, c);
  return c;
}

/** Codex 会话文件名 `rollout-…-<id>` 的固定前缀。 */
function codexPath(dir: string, id: string, ext: ".jsonl" | ".jsonl.zst"): string {
  return join(dir, `rollout-2026-10-08T10-45-49-${id}${ext}`);
}

test("resolveTranscript：先 .jsonl 后 .jsonl.zst；只有压缩那份时解析到它", () => {
  const e = env();
  try {
    const p = codexPath(e.roots.codex, "01a11967-19b1-7063-8631-c3dfad45ef88", ".jsonl");
    assert.equal(resolveTranscript(p), null);
    const zst = p + ".zst";
    writeFileSync(zst, zstdCompressSync(Buffer.from("x")));
    assert.equal(resolveTranscript(p), zst);
    assert.equal(resolveTranscript(zst), zst);
    // 并存时取未压缩那份
    writeFileSync(p, "y");
    assert.equal(resolveTranscript(p), p);
    assert.equal(resolveTranscript(zst), p);
    assert.equal(resolveTranscript(p + ".txt"), null);
  } finally {
    e.restore();
  }
});

test("readTranscript 全文：压缩文件解压内容与原文一致", () => {
  const e = env();
  try {
    const text = bigText();
    const p = codexPath(e.roots.codex, "01a11967-19b1-7063-8631-c3dfad45ef88", ".jsonl");
    put(p + ".zst", text, true);
    assert.equal(readTranscript(p), text);
    assert.equal(readTranscript(p + ".zst"), text);
  } finally {
    e.restore();
  }
});

test("readTranscript 开头：只读压缩文件前 256 KB，解压后截取前 n 字节，和全文开头一致；不查完整性", () => {
  const e = env();
  try {
    const text = bigText();
    const p = join(e.roots.codex, "head.jsonl.zst");
    const c = put(p, text, true);
    const n = 16_384;
    const head = readTranscript(p, n);
    assert.equal(Buffer.byteLength(head, "utf8"), n, "maxBytes 按字节截");
    assert.equal(head, Buffer.from(text, "utf8").subarray(0, n).toString("utf8"));
    // 压缩文件不足 256 KB 时整个可解出，仍只截取 n
    const small = "短".repeat(2000);
    const smallC = zstdCompressSync(Buffer.from(small, "utf8"));
    const smallP = join(e.roots.codex, "small.jsonl.zst");
    writeFileSync(smallP, smallC);
    assert.equal(readTranscript(smallP, 1000), Buffer.from(small, "utf8").subarray(0, 1000).toString("utf8"));
    assert.ok(c.length > 0);
  } finally {
    e.restore();
  }
});

test("readTranscript 全文：截断帧、坏帧抛错；开头读取对截断帧不抛错", () => {
  const e = env();
  try {
    const text = bigText();
    const p = codexPath(e.roots.codex, "01a11967-19b1-7063-8631-c3dfad45ef88", ".jsonl.zst");
    const c = put(p, text, true);
    // 截掉最后一字节：Node 的解压静默返回部分数据，不报错；完整性检查必须自己抓住
    writeFileSync(p, c.subarray(0, c.length - 1));
    assert.throws(() => readTranscript(p), /截断或损坏/);
    assert.equal(Buffer.byteLength(readTranscript(p, 4096), "utf8"), 4096, "开头读取故意利用截断返回部分数据，不查完整性");
    // 坏帧（不是 zstd）
    const bad = codexPath(e.roots.codex, "01a11967-19b1-7063-8631-c3dfad45ef89", ".jsonl.zst");
    writeFileSync(bad, Buffer.from("不是 zstd 帧"));
    assert.throws(() => readTranscript(bad), /截断或损坏/);
  } finally {
    e.restore();
  }
});

test("readTranscript 全文：超过 256 MB 解压上限抛错", () => {
  const e = env();
  try {
    const p = codexPath(e.roots.codex, "01a11967-19b1-7063-8631-c3dfad45ef90", ".jsonl.zst");
    const c = zstdCompressSync(Buffer.alloc(256 * 1024 * 1024 + 1));
    writeFileSync(p, c);
    assert.throws(() => readTranscript(p), /ERR_BUFFER_TOO_LARGE/);
  } finally {
    e.restore();
  }
});

test("readTranscript：文件不存在时抛错，不伪装成空会话", () => {
  const e = env();
  try {
    const p = codexPath(e.roots.codex, "01a11967-19b1-7063-8631-c3dfad45ef91", ".jsonl");
    assert.throws(() => readTranscript(p), /不存在/);
    assert.throws(() => readTranscript(p + ".zst"), /不存在/);
    assert.throws(() => readTranscript(p, 100), /不存在/);
  } finally {
    e.restore();
  }
});

test("allowedTranscript：Claude 的 transcript 还没落盘时维持现状（§7.6 第 4 条），返回字面路径不判 null", () => {
  const e = env();
  try {
    const p = join(e.roots.claude, "01a11967-19b1-7063-8631-c3dfad45ef88.jsonl");
    const ok = allowedTranscript("claude", p);
    assert.equal(ok, p, "文件不存在但路径合法：返回字面路径，供第一次 hook 后晚落盘用");
    // 目录都不存在时也按字面比较
    rmSync(join(e.home, ".claude"), { recursive: true });
    const p2 = join(e.home, ".claude/projects/nonexistent-dir/x.jsonl");
    assert.equal(allowedTranscript("claude", p2), p2);
    // 路径在根目录外：还是拒绝
    assert.equal(allowedTranscript("claude", join(e.dir, "x.jsonl")), null);
  } finally {
    e.restore();
  }
});

test("resolveTranscript：存在性判断只 stat 不读文件内容，且目录不算文件", (t) => {
  const e = env();
  const reads = t.mock.method(fs, "readFileSync", fs.readFileSync);
  syncBuiltinESMExports();
  try {
    const p = codexPath(e.roots.codex, "01a11967-19b1-7063-8631-c3dfad45ef92", ".jsonl");
    writeFileSync(p, "x");
    assert.equal(resolveTranscript(p), p);
    assert.equal(resolveTranscript(p + ".zst"), p);
    mkdirSync(p + ".zst");
    assert.equal(resolveTranscript(p), p);
    rmSync(p);
    assert.equal(resolveTranscript(p + ".zst"), null, "目录不是普通文件");
    assert.equal(resolveTranscript(p + ".txt"), null);
    assert.equal(reads.mock.callCount(), 0, "解析路径不能读取正文");
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    e.restore();
  }
});

test("readTranscript 开头：大文件只读前 256 KB 解压，按字节截取，和全文前 N 字节一致", (t) => {
  const e = env();
  try {
    const text = Buffer.from(randomBytes(400_000).map((b) => 65 + (b % 58))).toString("latin1");
    const p = codexPath(e.roots.codex, "01a11967-19b1-7063-8631-c3dfad45ef93", ".jsonl.zst");
    const c = put(p, text, true);
    assert.ok(c.length > 256 * 1024, "压缩文件必须大于 256 KB 才有截断效果");
    const n = 100_000;
    const expected = Buffer.from(readTranscript(p), "utf8").subarray(0, n).toString("utf8");
    const reads = t.mock.method(fs, "readFileSync", fs.readFileSync);
    const headReads = t.mock.method(fs, "readSync", fs.readSync);
    syncBuiltinESMExports();
    const head = readTranscript(p, n);
    assert.equal(head, expected);
    assert.equal(reads.mock.callCount(), 0, "开头读取不能读压缩文件全文");
    assert.equal(headReads.mock.callCount(), 1);
    const args: unknown[] = headReads.mock.calls[0].arguments;
    assert.equal(args[3], 256 * 1024);
    assert.equal(args[4], 0);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    e.restore();
  }
});

test("readTranscript 开头：maxBytes 按字节截取，不按字符（多字节字符场景）", () => {
  const e = env();
  try {
    const text = "汉".repeat(10_000); // 每字符 3 字节
    const p = codexPath(e.roots.codex, "01a11967-19b1-7063-8631-c3dfad45ef94", ".jsonl.zst");
    put(p, text, true);
    const n = 100;
    const head = readTranscript(p, n);
    // 前 100 字节解码（可能带半个字的替换符），不能是前 100 个字符（300 字节）
    assert.equal(head, Buffer.from(text, "utf8").subarray(0, n).toString("utf8"));
    assert.notEqual(head, text.slice(0, 100));
  } finally {
    e.restore();
  }
});

test("readTranscript 开头：解压超出上限抛错，防止小文件解出巨量内容", () => {
  const e = env();
  try {
    const p = codexPath(e.roots.codex, "01a11967-19b1-7063-8631-c3dfad45ef95", ".jsonl.zst");
    const c = zstdCompressSync(Buffer.alloc(20 * 1024 * 1024)); // 解压后 20 MB，超开头解压上限
    writeFileSync(p, c);
    assert.throws(() => readTranscript(p, 4096), /BUFFER_TOO_LARGE/);
  } finally {
    e.restore();
  }
});

test("allowedTranscript：放行 Codex 的 .jsonl.zst，拒绝 Claude 和 Pi 的压缩文件", () => {
  const e = env();
  try {
    const text = "{}";
    const codexZ = codexPath(e.roots.codex, "01a11967-19b1-7063-8631-c3dfad45ef88", ".jsonl.zst");
    const claudeZ = join(e.roots.claude, "01a11967-19b1-7063-8631-c3dfad45ef88.jsonl.zst");
    const piZ = join(e.roots.pi, "2026-01-01T00-00-00-000Z_01a11967-19b1-7063-8631-c3dfad45ef88.jsonl.zst");
    put(codexZ, text, true);
    put(claudeZ, text, true);
    put(piZ, text, true);
    assert.equal(allowedTranscript("codex", codexZ), codexZ);
    assert.equal(allowedTranscript("claude", claudeZ), null);
    assert.equal(allowedTranscript("pi", piZ), null);
    assert.equal(allowedTranscript("claude", claudeZ.slice(0, -4)), null, "登记路径仍是 .jsonl 时也不能放行压缩文件");
    assert.equal(allowedTranscript("pi", piZ.slice(0, -4)), null);
    // 未压缩仍按原规则
    const claudeP = join(e.roots.claude, "01a11967-19b1-7063-8631-c3dfad45ef88.jsonl");
    put(claudeP, text, false);
    assert.equal(allowedTranscript("claude", claudeP), claudeP);
  } finally {
    e.restore();
  }
});

test("allowedTranscript：拒绝指向根目录外的符号链接", () => {
  const e = env();
  try {
    const outside = join(e.dir, "outside.jsonl.zst");
    put(outside, "{}", true);
    const link = codexPath(e.roots.codex, "01a11967-19b1-7063-8631-c3dfad45ef88", ".jsonl.zst");
    symlinkSync(outside, link);
    assert.equal(allowedTranscript("codex", link), null);
  } finally {
    e.restore();
  }
});

test("expandSource：坏 .zst 不抛错，返回 null 显式不可用；准入解析到 .zst 后用实际路径读", () => {
  const e = env();
  try {
    const p = codexPath(e.roots.codex, "01a11967-19b1-7063-8631-c3dfad45ef89", ".jsonl.zst");
    writeFileSync(p, "not zstd");
    // 坏帧：不抛，返回 null
    const bad = expandSource({ host: "codex", session_id: "x", transcript: p, anchor: "1", summary: "" });
    assert.equal(bad, null);
    // 只存在 .zst：准入解析后读 .zst，内容展开成功
    const msg = { timestamp: "t", ordinal: 1, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "真实问题" }] } };
    const p2 = codexPath(e.roots.codex, "01a11967-19b1-7063-8631-c3dfad45ef90", ".jsonl.zst");
    writeFileSync(p2, zstdCompressSync(Buffer.from(JSON.stringify(msg) + "\n", "utf8")));
    const ok = expandSource({ host: "codex", session_id: "x", transcript: p2.slice(0, -4), anchor: "1", summary: "" });
    assert.match(ok!, /真实问题/);
  } finally {
    e.restore();
  }
});

test("readTranscript 调用方：缺失文件抛错，展示与元数据读取返回不可用", () => {
  const e = env();
  try {
    const p = join(e.roots.pi, "missing.jsonl");
    assert.throws(() => linesOf(p), /不存在/);
    assert.throws(() => cleanTranscript("pi", p), /不存在/);
    assert.equal(modelOf("pi", p), null);
    assert.equal(isWorkerTranscript(p), false);
    assert.equal(latestAnchor("pi", p), null);
    assert.equal(expandSource({ host: "pi", session_id: "s", transcript: p, anchor: "u", summary: "" }), null);
    const pi = join(e.roots.pi, "header.jsonl");
    writeFileSync(pi, JSON.stringify({ type: "session", version: 3, id: "s" }) + "\n");
    assert.equal(isWorkerTranscript(pi), false, "Pi 的追加头部读取也使用同一入口");
  } finally {
    e.restore();
  }
});

test("expandSource：使用准入返回的真实路径，不再次读取符号链接路径", (t) => {
  const e = env();
  try {
    const real = join(e.roots.codex, "real.jsonl");
    const link = join(e.roots.codex, "link.jsonl");
    writeFileSync(real, JSON.stringify({ ordinal: 1, type: "response_item", payload: { type: "message", role: "user", content: [{ text: "真实问题" }] } }) + "\n");
    symlinkSync(real, link);
    const reads = t.mock.method(fs, "readFileSync", fs.readFileSync);
    syncBuiltinESMExports();
    assert.match(expandSource({ host: "codex", session_id: "s", transcript: link, anchor: "1", summary: "" })!, /真实问题/);
    assert.ok(reads.mock.calls.length > 0);
    assert.ok(reads.mock.calls.every((call) => call.arguments[0] === real), "只读取准入返回的路径");
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    e.restore();
  }
});

test("cleanup", () => rmSync(base, { recursive: true, force: true }));
