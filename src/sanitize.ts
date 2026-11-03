/**
 * 确定性脱敏（设计 §13.2、§8.1）：送模型前、写 L1 前各跑一次。
 * 命中处换成带类型的占位符，计数只记类型不记内容。
 */
export type SanitizeKind = "api_key" | "bearer" | "jwt" | "pem" | "credential" | "email" | "phone" | "id_card" | "home_path";

export interface Sanitized {
  text: string;
  hits: Partial<Record<SanitizeKind, number>>;
}

const SECRET_KINDS: SanitizeKind[] = ["api_key", "bearer", "jwt", "pem", "credential"];

const RULES: { kind: SanitizeKind; re: RegExp; keep?: (m: RegExpExecArray) => string; allow?: (value: string) => boolean }[] = [
  { kind: "pem", re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g },
  { kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { kind: "bearer", re: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi },
  {
    kind: "api_key",
    re: /\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|glpat-[A-Za-z0-9_-]{20,})/g,
  },
  {
    // key=value / "key": "value" 形态；值要够长才算，避免把 "token=1" 这类说明文字打码
    kind: "credential",
    re: /((?<!\[)(?:api[_-]?key|secret|token|password|passwd|auth[_-]?token|access[_-]?key)["']?\s*[:=]\s*["']?)([^\s"',;\[\]]{8,})/gi,
    keep: (m) => m[1],
    // 值本身不是秘密：${VAR} 环境变量占位符、文档里的算法公式（SHA256(...)、MD5(...)）
    allow: (v) => v.startsWith("${") || /^(?:SHA\d+|MD5|HMAC[A-Z0-9-]*|BASE64[A-Z0-9]*-?)\(/i.test(v),
  },
  { kind: "email", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { kind: "id_card", re: /(?<![0-9])[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?![0-9])/g },
  { kind: "phone", re: /(?<![0-9])(?:\+?86[- ]?)?1[3-9]\d{9}(?![0-9])/g },
];

const HOME_RE = /\/(?:Users|home)\/[A-Za-z0-9._-]+(?=\/|\b)/g;

function placeholder(kind: SanitizeKind): string {
  return SECRET_KINDS.includes(kind) ? `[SECRET:${kind}]` : `[PII:${kind}]`;
}

export function sanitize(input: string): Sanitized {
  const hits: Partial<Record<SanitizeKind, number>> = {};
  let text = input;
  for (const rule of RULES) {
    text = text.replace(rule.re, (...args) => {
      const m = args.slice(0, -2) as unknown as RegExpExecArray;
      if (rule.kind === "email" && /\[(?:SECRET|PII):/.test(m[0])) return m[0];
      if (rule.allow?.(m[2])) return m[0];
      hits[rule.kind] = (hits[rule.kind] ?? 0) + 1;
      return (rule.keep ? rule.keep(m) : "") + placeholder(rule.kind);
    });
  }
  text = text.replace(HOME_RE, () => {
    hits.home_path = (hits.home_path ?? 0) + 1;
    return "~";
  });
  return { text, hits };
}

export function hasSecret(s: Sanitized | string): boolean {
  const text = typeof s === "string" ? s : s.text;
  return /\[SECRET:/.test(text) || (typeof s !== "string" && SECRET_KINDS.some((k) => (s.hits[k] ?? 0) > 0));
}

/**
 * 未脱敏的原文里有没有密钥（§8.11.2 的写入口：正文、否掉的方案这类没走 sanitize 的字段）。
 * 代码块里的也算：正则跑在全文上，不先删代码块。返回命中的类型，空数组表示干净。
 */
export function secretKinds(input: string): SanitizeKind[] {
  const hits = sanitize(input).hits;
  return SECRET_KINDS.filter((k) => (hits[k] ?? 0) > 0);
}

export function addHits(into: Partial<Record<SanitizeKind, number>>, from: Partial<Record<SanitizeKind, number>>): void {
  for (const [k, n] of Object.entries(from) as [SanitizeKind, number][]) into[k] = (into[k] ?? 0) + n;
}
