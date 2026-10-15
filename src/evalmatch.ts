/**
 * 评测匹配员（scripts/replay-eval.ts、scripts/replay-rematch.ts）输出校验。
 * 合法输出：{"refs":{"r1":…,"rN":…}}，每个参考键都在，值只能是 JSON null 或存在的产出编号 "oK"（1 ≤ K ≤ nOuts）。
 * 任何一项不合法整窗判无效（返回 null），不能当成"没匹配上"。
 */
export function parseMatchRefs(o: unknown, nRefs: number, nOuts: number): (number | null)[] | null {
  if (!o || typeof o !== "object") return null;
  const refs = (o as { refs?: unknown }).refs;
  if (!refs || typeof refs !== "object" || Array.isArray(refs)) return null;
  const out: (number | null)[] = [];
  for (let i = 1; i <= nRefs; i++) {
    const k = `r${i}`;
    if (!Object.prototype.hasOwnProperty.call(refs, k)) return null;
    const v = (refs as Record<string, unknown>)[k];
    if (v === null) {
      out.push(null);
      continue;
    }
    if (typeof v !== "string") return null;
    const m = /^o(\d+)$/.exec(v.trim());
    if (!m) return null;
    const n = Number(m[1]);
    if (n < 1 || n > nOuts) return null;
    out.push(n - 1);
  }
  return out;
}
