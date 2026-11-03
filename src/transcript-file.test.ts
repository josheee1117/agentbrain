/**
 * 文件层入口（设计 §7.6）：resolveTranscript / readTranscript / allowedTranscript。
 * 全部用 zstdCompressSync 生成的真实压缩文件和临时 HOME。
 * 运行：node --test src/transcript-file.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { allowedTranscript, readTranscript, resolveTranscript } from "./transcript-file.ts";

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
    assert.equal(head.length, n);
    assert.equal(head, text.slice(0, n));
    // 压缩文件不足 256 KB 时整个可解出，仍只截取 n
    const small = "短".repeat(2000);
    const smallC = zstdCompressSync(Buffer.from(small, "utf8"));
    const smallP = join(e.roots.codex, "small.jsonl.zst");
    writeFileSync(smallP, smallC);
    assert.equal(readTranscript(smallP, 1000), small.slice(0, 1000));
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
    assert.equal(readTranscript(p, 4096).length, 4096, "开头读取故意利用截断返回部分数据，不查完整性");
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

test("readTranscript：文件不存在按空串返回，不抛错", () => {
  const e = env();
  try {
    const p = codexPath(e.roots.codex, "01a11967-19b1-7063-8631-c3dfad45ef91", ".jsonl");
    assert.equal(readTranscript(p), "");
    assert.equal(readTranscript(p + ".zst"), "");
    assert.equal(readTranscript(p, 100), "");
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

test("cleanup", () => rmSync(base, { recursive: true, force: true }));
