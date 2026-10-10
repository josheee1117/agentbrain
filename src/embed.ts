/**
 * embedding（设计 §12.2、§11.4、§14.1）：OpenAI 兼容接口，配置在 <home>/embedding.json，
 * key 只从 macOS 钥匙串读。向量以小端 float32 字节进出 L3。接口不可用由调用方显式降级。
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface EmbedConfig {
  baseUrl: string;
  model: string;
}

/** DashScope text-embedding-v4 单次上限 10 条（实测，11 条返回 400）。 */
export const EMBED_BATCH = 10;
export const EMBED_TIMEOUT_MS = 8000;
export const KEYCHAIN_SERVICE = "agentbrain-embedding";

function bad(error: string): { error: string } {
  return { error };
}

/** 文件不存在、JSON 不合法、缺 baseUrl/model（非空字符串）时返回错误，不抛。 */
export function loadEmbedConfig(home: string): EmbedConfig | { error: string } {
  const path = join(home, "embedding.json");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return bad(`没有 ${path}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return bad(`${path} 不是合法 JSON`);
  }
  const o = parsed as { baseUrl?: unknown; model?: unknown };
  if (typeof o?.baseUrl !== "string" || !o.baseUrl.trim()) return bad(`${path} 缺 baseUrl`);
  if (typeof o?.model !== "string" || !o.model.trim()) return bad(`${path} 缺 model`);
  return { baseUrl: o.baseUrl, model: o.model };
}

/** 不读环境变量。钥匙串没有或 security 失败时返回错误，不抛。 */
export function readKey(): string | { error: string } {
  try {
    const out = execFileSync("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const key = out.trim();
    if (!key) return bad(`钥匙串里没有 ${KEYCHAIN_SERVICE}`);
    return key;
  } catch {
    return bad(`钥匙串里没有 ${KEYCHAIN_SERVICE}`);
  }
}

function finiteVec(v: unknown): Float32Array | null {
  if (!Array.isArray(v) || v.length === 0 || !v.every((n) => typeof n === "number" && Number.isFinite(n))) {
    return null;
  }
  return Float32Array.from(v);
}

async function embedBatch(
  texts: string[],
  cfg: EmbedConfig,
  key: string,
  fetchImpl: typeof fetch,
): Promise<Float32Array[]> {
  const url = `${cfg.baseUrl.replace(/\/+$/, "")}/embeddings`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: cfg.model, input: texts, encoding_format: "float" }),
      signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(`embedding 请求失败: ${(e as Error).message}`);
  }
  const body = (await res.json().catch(() => null)) as {
    error?: { message?: unknown };
    data?: { index?: unknown; embedding?: unknown }[];
  } | null;
  const apiMsg = typeof body?.error?.message === "string" ? body.error.message : "";
  if (!res.ok) throw new Error(`embedding HTTP ${res.status}${apiMsg ? `: ${apiMsg}` : ""}`);
  const data = body?.data;
  if (!Array.isArray(data) || data.length !== texts.length) {
    throw new Error(`embedding 返回 ${Array.isArray(data) ? data.length : 0} 条，期望 ${texts.length}`);
  }
  const ordered = data.slice().sort((a, b) => Number(a.index) - Number(b.index));
  const vecs = ordered.map((d) => finiteVec(d.embedding));
  if (vecs.some((v) => !v)) throw new Error("embedding 返回的向量不是有限数字数组");
  const dim = vecs[0]!.length;
  if (vecs.some((v) => v!.length !== dim)) throw new Error("embedding 返回的向量维度不一致");
  return vecs as Float32Array[];
}

/** 空输入返回 []。opts.fetch 注入测试用的假实现。 */
export async function embed(
  texts: string[],
  cfg: EmbedConfig,
  key: string,
  opts?: { fetch?: typeof fetch },
): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  const fetchImpl = opts?.fetch ?? fetch;
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    out.push(...(await embedBatch(texts.slice(i, i + EMBED_BATCH), cfg, key, fetchImpl)));
  }
  return out;
}

/** 小端 float32 字节。 */
export function toBlob(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
}

/** byteOffset 不是 4 的倍数时拷贝，避免 Float32Array 对齐报错。 */
export function fromBlob(b: Uint8Array): Float32Array {
  if (b.byteLength % 4 !== 0) throw new Error(`向量字节长度 ${b.byteLength} 不是 4 的倍数`);
  if (b.byteOffset % 4 === 0) return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
  return new Float32Array(b.slice().buffer);
}

/** 维度不同抛错。任一为零向量返回 0。 */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) throw new Error(`向量维度不同: ${a.length} 与 ${b.length}`);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}
