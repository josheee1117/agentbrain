/**
 * 用前核对（§21 2026-10-14，参考 Copilot 的 citation 校验）：按代码核验过的条目在召回时便宜地重查引文——
 * 文件还在、核对过的片段还在文件里（行号可漂移）。只读文件，不调 git、不调模型；超出时间预算或任何意外都按"没问题"放行。
 */
import { readFileSync, statSync } from "node:fs";
import { RepoEscape, RepoTools } from "./codeverify.ts";
import type { CodeRef } from "./l2.ts";
import { sanitize } from "./sanitize.ts";

/** 每次召回花在核对上的总预算（毫秒）。用完后剩下的引文不查，视为通过。 */
export const CITE_CHECK_BUDGET_MS = 5;
const MAX_FILE_BYTES = 1_000_000;
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/** 引文是否已失效：文件没了、或片段不在文件里。true=可能过时；false=通过或没法判断（fail-open）。 */
export function citationsStale(root: string, refs: readonly CodeRef[], deadline: number, now: () => number = () => performance.now()): boolean {
  let tools: RepoTools;
  try {
    tools = new RepoTools(root);
  } catch {
    return false;
  }
  for (const ref of refs) {
    if (now() > deadline) return false;
    if (!("path" in ref)) continue; // commit 引文要调 git，太慢，不在召回时查
    try {
      let abs: string;
      try {
        abs = tools.resolve(ref.path);
      } catch (e) {
        if (e instanceof RepoEscape && e.message.startsWith("路径不存在")) return true;
        continue;
      }
      const st = statSync(abs);
      if (!st.isFile()) return true;
      if (st.size > MAX_FILE_BYTES) continue;
      const raw = readFileSync(abs, "utf8");
      if (norm(raw).includes(ref.quote)) continue;
      // 引文入库前脱敏过；原文不含时再按脱敏后的文本比一次
      if (now() > deadline) return false;
      if (!norm(sanitize(raw).text).includes(ref.quote)) return true;
    } catch {
      continue;
    }
  }
  return false;
}
