import { chatClient, loadChatConfig, parseJsonLoose, type Chat } from "~/code_me/agentbrain/src/llm.ts";
import { readKey } from "~/code_me/agentbrain/src/embed.ts";
export const E = "~/.agentbrain/eval/overview";
export function chat(): { chat: Chat; model: string } {
  const cfg = loadChatConfig(E + "/home");
  if ("error" in cfg) throw new Error(cfg.error);
  const key = readKey(cfg.keyService);
  if (typeof key !== "string") throw new Error(key.error);
  return { chat: chatClient(cfg, key, 180_000), model: cfg.model };
}
export { parseJsonLoose };
export function rng(seed: number) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
export function shuffle<T>(a: T[], r: () => number): T[] { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; }
export async function pool<T, R>(items: T[], n: number, f: (x: T, i: number) => Promise<R>): Promise<R[]> { const out: R[] = new Array(items.length); let k = 0; await Promise.all(Array.from({ length: n }, async () => { while (k < items.length) { const i = k++; out[i] = await f(items[i], i); } })); return out; }
