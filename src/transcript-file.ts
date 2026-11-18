/**
 * 文件层唯一入口（设计 §7.6）：resolveTranscript / readTranscript / allowedTranscript。
 * 只做文件层的事：定位 `.jsonl` / `.jsonl.zst`、按需读（全文或开头）、准入与路径解析，不解析内容。
 * 调用方不再自己判断扩展名。
 */
import { realpathSync, readFileSync, readSync, openSync, closeSync, statSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import type { Host } from "./l2.ts";
import { opencodeId, opencodeSession } from "./opencode.ts";
import { agyBrainDir, agySessionId } from "./agy.ts";

/** `.jsonl.zst` 读全文时的解压上限（字节）：实测最大约 66 MB，4 倍余量（§7.6）。 */
const ZST_MAX_OUTPUT_BYTES = 256 * 1024 * 1024;
/** `.jsonl.zst` 读开头时只读压缩文件前这么多字节（§7.6 实测 941 个文件都够用，0.86 ms）。 */
const ZST_HEAD_READ_BYTES = 256 * 1024;

/** 文件是否存在且是普通文件（跟随符号链接；准入另有 realpath 检查）。 */
function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** 先试 `x.jsonl`，再试 `x.jsonl.zst`（与 Codex path_metadata.rs 的顺序一致）；都没有返回 null。 */
export function resolveTranscript(path: string): string | null {
  const base = path.endsWith(".jsonl.zst") ? path.slice(0, -4) : path.endsWith(".jsonl") ? path : null;
  if (!base) return null;
  if (isFile(base)) return base;
  const alt = base + ".zst";
  return isFile(alt) ? alt : null;
}

/**
 * 按 zstd 格式走一遍帧头和块头，确认文件完整：最后一帧的最后一个块存在，且帧头带的 checksum 也在。
 * Node 的 zstdDecompressSync 对截断帧不报错，只返回已解出的部分（实测 -1 字节静默少 2 万字），
 * 所以解压前必须单独查完整性。不核对帧头里的原始长度：本机 941 个里有 17 个没有这个字段（§7.6）。
 */
function zstFrameComplete(b: Buffer): boolean {
  let p = 0;
  if (!b.length) return false;
  while (p < b.length) {
    if (p + 5 > b.length || b.readUInt32LE(p) !== 0xfd2fb528) return false;
    const d = b[p + 4];
    const fcs = d >> 6;
    const single = (d >> 5) & 1;
    const chk = (d >> 2) & 1;
    const did = d & 3;
    p += 5 + (single ? 0 : 1) + [0, 1, 2, 4][did] + [single ? 1 : 0, 2, 4, 8][fcs];
    for (;;) {
      if (p + 3 > b.length) return false;
      const h = b[p] | (b[p + 1] << 8) | (b[p + 2] << 16);
      p += 3;
      const last = h & 1;
      const type = (h >> 1) & 3;
      const size = h >> 3;
      if (type === 3) return false; // 保留块类型不是合法 zstd
      p += type === 1 ? 1 : size; // 1=RLE 块（存 1 个字节）；0=raw、2=compressed 块存 size 字节
      if (p > b.length) return false;
      if (last) break;
    }
    if (chk) p += 4;
    if (p > b.length) return false;
  }
  return true;
}

/**
 * 读 transcript 全文（不给 maxBytes）。`.jsonl.zst` 解压前先查完整性，超过解压上限抛错，
 * 由调用方记 source_unavailable。坏文件、截断帧、文件不存在都抛错（不存在不能伪装成空会话，
 * 调用方会把它当成 0 轮静默跳过）。
 */
export function readTranscript(path: string, maxBytes?: number): string {
  const p = resolveTranscript(path);
  if (!p) throw new Error(`transcript 不存在: ${path}`);
  if (p.endsWith(".zst")) {
    if (maxBytes === undefined) {
      const c = readFileSync(p);
      if (!zstFrameComplete(c)) throw new Error(`截断或损坏的压缩文件: ${p}`);
      return zstdDecompressSync(c, { maxOutputLength: ZST_MAX_OUTPUT_BYTES }).toString("utf8");
    }
    // 读开头：只读压缩文件前 256 KB 再解压（故意利用截断帧返回部分数据，这里不查完整性）。
    const fd = openSync(p, "r");
    try {
      const buf = Buffer.alloc(ZST_HEAD_READ_BYTES);
      const n = readSync(fd, buf, 0, ZST_HEAD_READ_BYTES, 0);
      return zstdDecompressSync(buf.subarray(0, n), { maxOutputLength: ZST_MAX_OUTPUT_BYTES }).subarray(0, maxBytes).toString("utf8");
    } finally {
      closeSync(fd);
    }
  }
  if (maxBytes === undefined) return readFileSync(p, "utf8");
  const fd = openSync(p, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    const n = readSync(fd, buf, 0, maxBytes, 0);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

const TRANSCRIPT_ROOTS: Record<Host, string[]> = {
  claude: [".claude/projects"],
  codex: [".codex/sessions", ".codex/archived_sessions"],
  pi: [".pi/agent/sessions"],
  opencode: [],
  agy: [],
};

/**
 * 准入：transcript 必须是真实文件、落在该宿主自己的会话目录下。先解析实际文件（`.jsonl` 或 `.jsonl.zst`），
 * 再做 realpath 和根目录检查，返回实际路径。只有 Codex 放行 `.jsonl.zst`，其他宿主照旧拒绝。
 * 两种都不存在时维持现状（§7.6 第 4 条）：`.jsonl` 结尾且在根目录内就返回 resolve(path)，
 * 因为 Claude 的 transcript 可能晚于第一次 hook 才落盘。每次读之前都查，L1 与 capture_sessions 里的路径都不算可信。
 */
export function allowedTranscript(host: Host, path: string, sessionId?: string): string | null {
  if (host === "opencode") {
    const id = opencodeId(path);
    if (!id || (sessionId !== undefined && id !== sessionId)) return null;
    try {
      return opencodeSession(path) ? path : null;
    } catch {
      return null;
    }
  }
  if (host === "agy") return allowedAgy(path, sessionId);
  if (!path.endsWith(".jsonl") && !path.endsWith(".jsonl.zst")) return null;
  if (host !== "codex" && path.endsWith(".jsonl.zst")) return null;
  const inRoot = (real: string) =>
    TRANSCRIPT_ROOTS[host].some((r) => {
      const root = join(homedir(), r);
      let rootReal = root;
      try {
        rootReal = realpathSync(root);
      } catch {
        /* 目录不存在时按字面比较 */
      }
      return real.startsWith(rootReal + sep);
    });
  const found = resolveTranscript(path);
  if (found && host !== "codex" && found.endsWith(".zst")) return null;
  if (!found) {
    // 两种都不存在：按字面路径检查根目录（Claude 的文件可能还没写）
    const literal = resolve(path);
    return inRoot(literal) ? literal : null;
  }
  let real: string;
  try {
    real = realpathSync(found);
  } catch {
    return null;
  }
  if (!real.endsWith(".jsonl") && !(host === "codex" && real.endsWith(".jsonl.zst"))) return null;
  return inRoot(real) ? real : null;
}

/**
 * agy（§7.7）：只认 `brain/<id>/.system_generated/logs/transcript_full.jsonl` 这一种形状，真实路径必须正好落在那里。
 * 给的是同目录的截断版 `transcript.jsonl` 时换成完整版。文件还没写出来时按字面路径放行（同 Claude）。
 */
function allowedAgy(path: string, sessionId?: string): string | null {
  const id = agySessionId(path);
  if (!id || (sessionId !== undefined && id !== sessionId)) return null;
  const rel = join(id, ".system_generated", "logs", "transcript_full.jsonl");
  const root = agyBrainDir();
  let rootReal = root;
  try {
    rootReal = realpathSync(root);
  } catch {
    /* 目录不存在时按字面比较 */
  }
  const full = join(dirname(resolve(path)), "transcript_full.jsonl");
  if (!isFile(full)) return full === join(root, rel) || full === join(rootReal, rel) ? full : null;
  let real: string;
  try {
    real = realpathSync(full);
  } catch {
    return null;
  }
  return real === join(rootReal, rel) ? real : null;
}
