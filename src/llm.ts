/**
 * 切片 3 的模型调用（设计 §19.3）：OpenAI 兼容 /chat/completions。
 * 配置在 <home>/extract.json：model 必填；baseUrl 可选（§14.4 不在代码里写死 model ID 和地址）。
 * 有自己的 baseUrl 时 key 读钥匙串 service agentbrain-extract；没有时沿用 embedding.json 的 baseUrl
 * 与 agentbrain-embedding 的 key。不读环境变量，key 不进文件。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { KEYCHAIN_SERVICE, loadEmbedConfig } from "./embed.ts";

/** extract.json 自带 baseUrl 时用的钥匙串 service。 */
export const EXTRACT_KEYCHAIN_SERVICE = "agentbrain-extract";

export interface ChatConfig {
  baseUrl: string;
  model: string;
  /** 读 key 用的钥匙串 service。 */
  keyService: string;
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
  constructor(code: WorkError, message: string) {
    super(message);
    this.code = code;
  }
}

export function loadChatConfig(home: string): ChatConfig | { error: string } {
  const path = join(home, "extract.json");
  let o: { model?: unknown; baseUrl?: unknown };
  try {
    o = JSON.parse(readFileSync(path, "utf8")) as typeof o;
  } catch {
    return { error: `没有 ${path} 或不是合法 JSON` };
  }
  if (typeof o?.model !== "string" || !o.model.trim()) return { error: `${path} 缺 model` };
  if (o.baseUrl !== undefined) {
    if (typeof o.baseUrl !== "string" || !o.baseUrl.trim()) return { error: `${path} 的 baseUrl 不是非空字符串` };
    return { baseUrl: o.baseUrl, model: o.model, keyService: EXTRACT_KEYCHAIN_SERVICE };
  }
  const emb = loadEmbedConfig(home);
  if ("error" in emb) return { error: `${path} 没写 baseUrl，沿用 embedding 配置失败：${emb.error}` };
  return { baseUrl: emb.baseUrl, model: o.model, keyService: KEYCHAIN_SERVICE };
}

export type Chat = (messages: ChatMessage[], opts?: { tools?: ToolSpec[]; json?: boolean }) => Promise<{ message: ChatMessage; tokens: number }>;

export function chatClient(cfg: ChatConfig, key: string, timeoutMs: number, fetchImpl: typeof fetch = fetch): Chat {
  return async (messages, opts) => {
    const url = `${cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const body: Record<string, unknown> = { model: cfg.model, messages, temperature: 0 };
    if (opts?.tools) body.tools = opts.tools;
    if (opts?.json) body.response_format = { type: "json_object" };
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
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
    if (res.status === 429) throw new WorkFailure("http_429", "模型接口限流 429");
    if (!res.ok) throw new WorkFailure("http_error", `模型接口 HTTP ${res.status}${parsed?.error?.message ? `: ${parsed.error.message}` : ""}`);
    const message = parsed?.choices?.[0]?.message;
    if (!message || typeof message !== "object") throw new WorkFailure("invalid_output", "模型返回里没有 message");
    return { message, tokens: Number(parsed?.usage?.total_tokens) || 0 };
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
