/**
 * 每轮召回的字面通道（§21 召回准确度 2026-10-14）：内存里按 IDF 加权算"查询词覆盖率"。
 * 不用 FTS5 trigram：中文提示词没有空格，整句当一个词去 MATCH 几乎永远不中；短词退回的 LIKE 又不排序，
 * "1""a""is" 这种词会把随便哪条都带进来。这里中文按二字切、英文按词切，常见虚词靠 IDF 自然降权。
 */

const EN_STOP = new Set(
  "a an the is are was were be been am do does did how what why when where which who can could should would will shall may might must i me my we our you your it its this that these those to of in on at for from by with and or not no so if then than as about into over under up down out just also there here have has had get got let use using make made need want please".split(" "),
);
const CJK_RUN = /[\u3400-\u9fff\uf900-\ufaff]+/g;
const WORD = /[a-z0-9][a-z0-9_.\-/]*[a-z0-9]|[a-z0-9]/g;

/** 文本切成检索词：英文/数字词（≥2 字符、去虚词，含 dev_jdk17 这类标识符）+ 中文二字片段。 */
export function lexTokens(text: string): Set<string> {
  const lower = text.toLowerCase();
  const out = new Set<string>();
  for (const w of lower.match(WORD) ?? []) {
    if (w.length < 2 || EN_STOP.has(w)) continue;
    out.add(w);
    // 标识符拆开再收一遍：dev_jdk17 也能被 "jdk17" 命中
    if (/[_.\-/]/.test(w)) for (const part of w.split(/[_.\-/]+/)) if (part.length >= 2 && !EN_STOP.has(part)) out.add(part);
  }
  for (const run of lower.match(CJK_RUN) ?? []) {
    const cs = [...run];
    for (let i = 0; i + 1 < cs.length; i++) out.add(cs[i] + cs[i + 1]);
  }
  return out;
}

/** 语料：每条的词集合 + 文档频率。 */
export class LexIndex {
  private readonly docs = new Map<string, Set<string>>();
  private readonly df = new Map<string, number>();
  constructor(entries: Iterable<{ id: string; text: string }>) {
    for (const e of entries) {
      const toks = lexTokens(e.text);
      this.docs.set(e.id, toks);
      for (const t of toks) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    }
  }
  private idf(t: string): number {
    return Math.log(1 + this.docs.size / (1 + (this.df.get(t) ?? 0)));
  }
  /** 查询词按 IDF 加权、被该条覆盖的比例（0..1）。语料里没出现过的词照样计入分母（按最大权重）：闲聊和无关提问因此覆盖率低。 */
  coverage(queryTokens: Set<string>, id: string): number {
    const doc = this.docs.get(id);
    if (!doc) return 0;
    let total = 0;
    let hit = 0;
    for (const t of queryTokens) {
      const w = this.idf(t);
      total += w;
      if (doc.has(t)) hit += w;
    }
    return total ? hit / total : 0;
  }
}
