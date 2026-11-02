/** 06 review 报告的数据层回归（§8.11.2）：条目 3（正文脱敏）、条目 10（全文索引 vs 向量输入）。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store, VEC_TEXT_MAX_CHARS, vectorText, type Embedder } from "./store.ts";
import type { RememberBody } from "./l2.ts";

const src = (): RememberBody["source"] => ({ host: null, session_id: null, transcript: null, anchor: null, summary: "x" });
const mem = () => new Store(":memory:", ":memory:");
const fakeEmbed: Embedder = Object.assign(async (texts: string[]) => texts.map((t) => {
  const v = new Float32Array(97);
  for (const ch of t) v[ch.codePointAt(0)! % 97] += 1;
  return v;
}), { model: "fake-embed" });

test("review 条目 3：手写入口的正文和否掉的方案脱敏后才写 L1", () => {
  const s = mem();
  try {
    const pid = s.ensureProject("p");
    const id = s.remember(pid, null, false, {
      kind: "decision",
      text: "告警邮件只发测试环境",
      confirmed: true,
      source: src(),
      body: "联系 alice@example.com，配置在 /Users/alice/private/company 下",
      alternatives: [{ option: "沿用 bob@example.com 的账号", rejected_because: "数据在 /Users/bob/data" }],
    });
    const p = s.project().props.get(id)!;
    assert.equal(p.body!.includes("alice@example.com"), false, "正文里的邮箱不能原样进库");
    assert.equal(p.body!.includes("/Users/alice"), false, "家目录路径要脱敏");
    assert.match(p.body!, /\[PII:email\]/);
    assert.equal(p.alternatives[0].option.includes("bob@example.com"), false);
    assert.equal(p.alternatives[0].rejected_because.includes("/Users/bob"), false);
    assert.equal(p.text, "告警邮件只发测试环境", "标题不动");
  } finally { s.close(); }
});

test("review 条目 3：送去算向量的输入不含原始邮箱和家目录路径", async () => {
  const s = mem();
  try {
    const pid = s.ensureProject("p");
    s.remember(pid, null, false, {
      kind: "decision",
      text: "告警邮件只发测试环境",
      confirmed: true,
      source: src(),
      body: "联系 alice@example.com，配置在 /Users/alice/private/company 下",
    });
    const sent: string[][] = [];
    await s.syncVectors(async (t) => { sent.push(t); return fakeEmbed(t); }, "fake");
    const all = sent.flat().join("\n");
    assert.equal(all.includes("alice@example.com"), false, `embedding 输入含原始邮箱：${all}`);
    assert.equal(all.includes("/Users/alice"), false, `embedding 输入含原始家目录：${all}`);
  } finally { s.close(); }
});

test("review 条目 3：detail 补正文（Pensieve 重导路径）同样脱敏", () => {
  const s = mem();
  try {
    const pid = s.ensureProject("p");
    const id = s.remember(pid, null, false, { kind: "note", text: "回滚办法", confirmed: true, source: src() });
    s.detail(id, null, { body: "找 alice@example.com，脚本在 /Users/alice/bin/rollback" });
    const p = s.project().props.get(id)!;
    assert.equal(p.body!.includes("alice@example.com"), false);
    assert.equal(p.body!.includes("/Users/alice"), false);
  } finally { s.close(); }
});

test("review 条目 10：全文索引用完整 text + why + body，长正文尾部关键词能搜到", () => {
  const s = mem();
  try {
    const pid = s.ensureProject("p");
    s.remember(pid, null, false, {
      kind: "note",
      text: "缓存口径",
      confirmed: true,
      source: src(),
      body: `${"甲".repeat(6100)}唯一的末尾检索关键词雪豹策略`,
    });
    const hits = s.search("雪豹策略", { projects: [pid], includeGlobal: false, limit: 5 });
    assert.equal(hits.length, 1, "正文后半段的关键词也要能按字面搜到");
    assert.equal(s.project().props.size, 1);
  } finally { s.close(); }
});

test("review 条目 10：向量输入仍按上限截断，text 和 why 全进", () => {
  const s = mem();
  try {
    const pid = s.ensureProject("p");
    const id = s.remember(pid, null, false, {
      kind: "note",
      text: "标题",
      why: "为什么",
      confirmed: true,
      source: src(),
      body: "长".repeat(9000),
    });
    const text = vectorText(s.project().props.get(id)!);
    assert.equal([...text].length, VEC_TEXT_MAX_CHARS, "向量输入仍截到上限");
    assert.ok(text.startsWith("标题\n为什么"), "text 和 why 全进，只截正文");
  } finally { s.close(); }
});
