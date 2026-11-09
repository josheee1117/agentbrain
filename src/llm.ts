/**
 * 切片 3 的模型调用（设计 §19.3）：OpenAI 兼容 /chat/completions。
 * 配置在 <home>/extract.json：model 必填；baseUrl 可选（§14.4 不在代码里写死 model ID 和地址）。
 * 有自己的 baseUrl 时 key 读钥匙串 service agentbrain-extract；没有时沿用 embedding.json 的 baseUrl
 * 与 agentbrain-embedding 的 key。不读环境变量，key 不进文件。
 * 可选 fallbacks（备用渠道，按顺序试）：主渠道报网络/超时/限流/HTTP 错误时才换下一个。
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { KEYCHAIN_SERVICE, loadEmbedConfig } from "./embed.ts";

export const promptVersion = (system: string): string => createHash("sha256").update(system, "utf8").digest("hex").slice(0, 12);

/** extract.json 自带 baseUrl 时用的钥匙串 service。 */
export const EXTRACT_KEYCHAIN_SERVICE = "agentbrain-extract";

export interface ChatConfig {
  baseUrl: string;
  model: string;
  /** 读 key 用的钥匙串 service。 */
  keyService: string;
  /** 并进请求体的额外字段（如 DashScope 的 enable_thinking:false）；来自配置，不写死。 */
  extraBody?: Record<string, unknown>;
  /** 备用渠道，按顺序试；主渠道报渠道类错误才换。老配置没有这一项。 */
  fallbacks?: ChatConfig[];
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: object };
}

/** 闭集错误码（doctor 按它计数）。 */
export type WorkError =
  | "no_config"
  | "no_key"
  | "network"
  | "timeout"
  | "http_429"
  | "http_error"
  | "invalid_output"
  | "embed_unavailable"
  | "source_unavailable"
  /** 仅旧数据：日上限已取消（§21 2026-10-13）。 */
  | "budget_exhausted";

export class WorkFailure extends Error {
  code: WorkError;
  /** 429 时：建议等多久（毫秒），来自 Retry-After 头或错误正文里的重置时间。 */
  retryAfterMs?: number;
  constructor(code: WorkError, message: string, retryAfterMs?: number) {
    super(message);
    this.code = code;
    if (typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs >= 0) this.retryAfterMs = retryAfterMs;
  }
}

/** 从 Retry-After 头（秒数或 HTTP 日期）或正文（"reset at 2026-10-14 20:21:56 +0800"、"retry after 30s"）解析要等多久。 */
export function parseRetryAfterMs(header: string | null, body: string | undefined, now = Date.now()): number | undefined {
  if (header) {
    const sec = Number(header);
    if (Number.isFinite(sec) && sec >= 0) return Math.round(sec * 1000);
    const at = Date.parse(header);
    if (Number.isFinite(at)) return Math.max(0, at - now);
  }
  if (!body) return undefined;
  const reset = /reset at (\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\s*([+-]\d{2}):?(\d{2})/i.exec(body);
  if (reset) {
    const at = Date.parse(`${reset[1]}T${reset[2]}${reset[3]}:${reset[4]}`);
    if (Number.isFinite(at)) return Math.max(0, at - now);
  }
  const m = /(?:retry[_ -]?after|try again in)[=:\s]+(\d+(?:\.\d+)?)\s*(ms|s|sec|seconds?|m|min|minutes?|h|hours?)?/i.exec(body);
  if (!m) return undefined;
  const u = (m[2] ?? "s").toLowerCase();
  const mult = u === "ms" ? 1 : u.startsWith("h") ? 3_600_000 : u.startsWith("m") ? 60_000 : 1000;
  return Math.round(Number(m[1]) * mult);
}

export function loadChatConfig(home: string): ChatConfig | { error: string } {
  const path = join(home, "extract.json");
  let o: { model?: unknown; baseUrl?: unknown; keyService?: unknown; extraBody?: unknown; fallbacks?: unknown };
  try {
    o = JSON.parse(readFileSync(path, "utf8")) as typeof o;
  } catch {
    return { error: `没有 ${path} 或不是合法 JSON` };
  }
  if (typeof o?.model !== "string" || !o.model.trim()) return { error: `${path} 缺 model` };
  const fb = loadFallbacks(path, o.fallbacks);
  if ("error" in fb) return fb;
  const fallbacks = fb.fallbacks;
  if (o.baseUrl !== undefined) {
    if (typeof o.baseUrl !== "string" || !o.baseUrl.trim()) return { error: `${path} 的 baseUrl 不是非空字符串` };
    const keyService = typeof o.keyService === "string" && o.keyService.trim() ? o.keyService : EXTRACT_KEYCHAIN_SERVICE;
    if (o.extraBody !== undefined && (typeof o.extraBody !== "object" || o.extraBody === null || Array.isArray(o.extraBody))) return { error: `${path} 的 extraBody 必须是对象` };
    return { baseUrl: o.baseUrl, model: o.model, keyService, ...(o.extraBody !== undefined ? { extraBody: o.extraBody as Record<string, unknown> } : {}), ...(fallbacks ? { fallbacks } : {}) };
  }
  const emb = loadEmbedConfig(home);
  if ("error" in emb) return { error: `${path} 没写 baseUrl，沿用 embedding 配置失败：${emb.error}` };
  return { baseUrl: emb.baseUrl, model: o.model, keyService: KEYCHAIN_SERVICE, ...(fallbacks ? { fallbacks } : {}) };
}

/** 备用渠道每项必须有 model 与 baseUrl；keyService 缺省 agentbrain-extract，extraBody 必须是对象。 */
function loadFallbacks(path: string, raw: unknown): { fallbacks?: ChatConfig[] } | { error: string } {
  if (raw === undefined) return {};
  if (!Array.isArray(raw)) return { error: `${path} 的 fallbacks 必须是数组` };
  const out: ChatConfig[] = [];
  for (const [i, f] of raw.entries()) {
    const at = `fallbacks[${i}]`;
    if (typeof f !== "object" || f === null || Array.isArray(f)) return { error: `${path} 的 ${at} 必须是对象` };
    const m = f as { model?: unknown; baseUrl?: unknown; keyService?: unknown; extraBody?: unknown };
    if (typeof m.model !== "string" || !m.model.trim()) return { error: `${path} 的 ${at} 缺 model` };
    if (typeof m.baseUrl !== "string" || !m.baseUrl.trim()) return { error: `${path} 的 ${at} 的 baseUrl 不是非空字符串` };
    if (m.keyService !== undefined && (typeof m.keyService !== "string" || !m.keyService.trim())) return { error: `${path} 的 ${at} 的 keyService 不是非空字符串` };
    if (m.extraBody !== undefined && (typeof m.extraBody !== "object" || m.extraBody === null || Array.isArray(m.extraBody))) return { error: `${path} 的 ${at} 的 extraBody 必须是对象` };
    out.push({
      baseUrl: m.baseUrl,
      model: m.model,
      keyService: typeof m.keyService === "string" ? m.keyService : EXTRACT_KEYCHAIN_SERVICE,
      ...(m.extraBody !== undefined ? { extraBody: m.extraBody as Record<string, unknown> } : {}),
    });
  }
  return out.length ? { fallbacks: out } : {};
}

export type Chat = (messages: ChatMessage[], opts?: { tools?: ToolSpec[]; json?: boolean }) => Promise<{ message: ChatMessage; tokens: number; /** 实际用到的模型（备用渠道时是备用那个）；CLI 后端与老实现可能不给 */ model?: string; /** CLI 后端报的费用（claude 给），API 后端不给 */ costUsd?: number }>;

/** 主渠道报这些错说明是渠道的问题，换下一个；invalid_output 等是输出/配置问题，换渠道也没用。 */
const FALLBACK_CODES = new Set<WorkError>(["network", "timeout", "http_429", "http_error"]);

/** 把多个渠道串成一条链：按顺序试，只在渠道类错误时换下一个，全失败抛最后一个错误。 */
export function fallbackChat(chats: Chat[]): Chat {
  if (chats.length === 1) return chats[0];
  return async (messages, opts) => {
    let last: unknown;
    for (const chat of chats) {
      try {
        return await chat(messages, opts);
      } catch (e) {
        if (!(e instanceof WorkFailure) || !FALLBACK_CODES.has(e.code)) throw e;
        last = e;
      }
    }
    throw last;
  };
}

/**
 * 把主渠道与备用渠道连成一条链。主渠道读不到 key 仍是 no_key（整条链不可用）；
 * 备用渠道读不到 key 就跳过它：钥匙串里没装不该让有 key 的渠道跑不起来。
 * keyOf / makeChat 由调用方给（钥匙串读取与真实 client 创建不搬到这里，测试可换假的）。
 */
export function chatChain(
  cfg: ChatConfig,
  keyOf: (service: string) => string | { error: string },
  makeChat: (c: ChatConfig, key: string) => Chat,
): { chat: Chat; model: string } | { error: WorkError; message: string } {
  const main = keyOf(cfg.keyService);
  if (typeof main !== "string") return { error: "no_key", message: main.error };
  const clients = [cfg, ...(cfg.fallbacks ?? [])]
    .map((c, i) => {
      const key = i === 0 ? main : keyOf(c.keyService);
      return typeof key === "string" ? makeChat(c, key) : null;
    })
    .filter((x) => x !== null);
  return { chat: fallbackChat(clients), model: cfg.model };
}

/** timeoutMs 不给就不设超时（抽取，用户 2026-10-30）：租约过期会被接管，写库前复核租约，不会重复写。 */
export function chatClient(cfg: ChatConfig, key: string, timeoutMs: number | undefined, fetchImpl: typeof fetch = fetch): Chat {
  return async (messages, opts) => {
    const url = `${cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const body: Record<string, unknown> = { ...(cfg.extraBody ?? {}), model: cfg.model, messages, temperature: 0 };
    if (opts?.tools) body.tools = opts.tools;
    if (opts?.json) body.response_format = { type: "json_object" };
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const name = (e as Error).name;
      throw new WorkFailure(name === "TimeoutError" || name === "AbortError" ? "timeout" : "network", `模型请求失败: ${(e as Error).message}`);
    }
    const parsed = (await res.json().catch(() => null)) as {
      choices?: { message?: ChatMessage }[];
      usage?: { total_tokens?: number };
      error?: { message?: string };
    } | null;
    if (res.status === 429)
      throw new WorkFailure("http_429", `模型接口限流 429${parsed?.error?.message ? `: ${parsed.error.message.slice(0, 200)}` : ""}`, parseRetryAfterMs(res.headers.get("retry-after"), parsed?.error?.message));
    if (!res.ok) throw new WorkFailure("http_error", `模型接口 HTTP ${res.status}${parsed?.error?.message ? `: ${parsed.error.message}` : ""}`);
    const message = parsed?.choices?.[0]?.message;
    if (!message || typeof message !== "object") throw new WorkFailure("invalid_output", "模型返回里没有 message");
    return { message, tokens: Number(parsed?.usage?.total_tokens) || 0, model: cfg.model };
  };
}

/** 宽松取 JSON：去掉 ``` 围栏，取第一个 { 到最后一个 }。 */
export function parseJsonLoose(text: string | null): unknown {
  if (!text) return null;
  const t = text.replace(/```(?:json)?/g, "");
  const a = t.indexOf("{");
  const b = t.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try {
    return JSON.parse(t.slice(a, b + 1));
  } catch {
    return null;
  }
}
