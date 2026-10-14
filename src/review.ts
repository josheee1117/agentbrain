/**
 * v3 第 2 阶段：审稿团（ab curate）。设计见 docs v3 pipeline：3 家模型各自独立判每条候选，
 * 三票一致直接执行，有分歧（或改写写法不同）交给仲裁。配置在 <home>/review.json，代码里不写死模型、地址或钥匙串名。
 * 这里只放纯逻辑（配置、提示词、解析、计票、执行计划）；模型调用由调用方注入，便于测试。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Chat, ChatConfig } from "./llm.ts";
import { parseJsonLoose } from "./llm.ts";
import type { PropKind, Proposition } from "./l2.ts";
import { GOOD_MEMORY_STANDARD } from "./standard.ts";

export interface PanelMember {
  name: string;
  baseUrl: string;
  model: string;
  /** 钥匙串 service 名；配置文件只记名字，key 不进文件。 */
  keyService: string;
  timeoutMs?: number;
  /** 同时在途的请求数（默认 1：代理/套餐常按并发限流）。 */
  concurrency?: number;
  /** 并进请求体的额外字段。 */
  extraBody?: Record<string, unknown>;
}

export interface ReviewConfig {
  panel: PanelMember[];
  /** 仲裁人：panel 里某个成员的 name。 */
  arbiter: string;
  /** 每批几条候选（默认 10）。 */
  batchSize: number;
  /** 一次最多几批（默认 3）。 */
  maxBatches: number;
}

export const REVIEW_FILE = "review.json";

export function loadReviewConfig(home: string): ReviewConfig | { error: string } {
  const path = join(home, REVIEW_FILE);
  let o: any;
  try {
    o = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { error: `没有 ${path} 或不是合法 JSON（先跑 ab setup）` };
  }
  return validateReviewConfig(o, path);
}

export function validateReviewConfig(o: any, path = REVIEW_FILE): ReviewConfig | { error: string } {
  if (!Array.isArray(o?.panel) || o.panel.length === 0) return { error: `${path} 缺 panel` };
  const names = new Set<string>();
  const panel: PanelMember[] = [];
  for (const m of o.panel) {
    for (const k of ["name", "baseUrl", "model", "keyService"]) {
      if (typeof m?.[k] !== "string" || !m[k].trim()) return { error: `${path} 的 panel 成员缺 ${k}` };
    }
    if (names.has(m.name)) return { error: `${path} 的 panel 成员重名: ${m.name}` };
    names.add(m.name);
    if (m.extraBody !== undefined && (typeof m.extraBody !== "object" || m.extraBody === null || Array.isArray(m.extraBody))) return { error: `${path} 的 ${m.name}.extraBody 必须是对象` };
    panel.push({
      name: m.name,
      baseUrl: m.baseUrl,
      model: m.model,
      keyService: m.keyService,
      timeoutMs: typeof m.timeoutMs === "number" && m.timeoutMs > 0 ? m.timeoutMs : undefined,
      concurrency: typeof m.concurrency === "number" && m.concurrency >= 1 ? Math.floor(m.concurrency) : undefined,
      extraBody: m.extraBody,
    });
  }
  if (typeof o.arbiter !== "string" || !names.has(o.arbiter)) return { error: `${path} 的 arbiter 必须是 panel 里某个成员的 name` };
  const int = (v: unknown, d: number) => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : d);
  return { panel, arbiter: o.arbiter, batchSize: int(o.batchSize, 10), maxBatches: int(o.maxBatches, 3) };
}

export function memberChatConfig(m: PanelMember): ChatConfig {
  return { baseUrl: m.baseUrl, model: m.model, keyService: m.keyService, extraBody: m.extraBody };
}

/** 每个成员一个并发闸：同一家同时最多 n 个请求在途。 */
export function limit(n: number): <T>(f: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: (() => void)[] = [];
  return async <T>(f: () => Promise<T>) => {
    if (active >= n) await new Promise<void>((r) => queue.push(r));
    active++;
    try {
      return await f();
    } finally {
      active--;
      queue.shift()?.();
    }
  };
}

// ---------- 输入 ----------

export interface CandidateInput {
  /** 正式 id（结果按它回填）。 */
  id: string;
  kind: PropKind;
  scope: "project" | "global";
  project: string | null;
  text: string;
  why?: string;
  scenario?: string;
  basis?: string;
  /** 证据所在的会话片段（已脱敏、截断）；拿不到为 null。 */
  context: string | null;
  /** 证据来自子代理会话（派活提示不算用户原话）。 */
  worker: boolean;
  /** 正式库里的近邻（不含自己）。 */
  neighbors: { id: string; text: string; confirmed_by_user: boolean }[];
}

export type Verdict = "keep" | "rewrite" | "merge" | "discard";
export type MemClass = "A" | "B" | "C" | "none";

export interface Judgement {
  verdict: Verdict;
  class: MemClass;
  scenario?: string;
  text?: string;
  /** merge 的目标（正式 id）。 */
  into?: string;
  guidance: boolean;
  reason: string;
}

const SCENARIO = /^当.+时/s;
export function isScenario(s: unknown): s is string {
  return typeof s === "string" && SCENARIO.test(s.trim());
}

const OUTPUT = `只输出 JSON：{"verdicts":[{"id":"c1","verdict":"keep|rewrite|merge|discard","class":"A|B|C|none","scenario":"当…时","text":"改写后的正文（rewrite/merge 必填）","into":"n1（merge 必填，填近邻编号）","guidance":false,"reason":"一句话理由"}]}`;

export const JUDGE_SYSTEM = `你是记忆库的审稿人。下面是《好记忆的标准》全文，严格按它判断每条候选该不该进正式库。

${GOOD_MEMORY_STANDARD}

## 你的任务
对每条候选独立给出四选一：
- keep：原文已经合格（能迁移、查不到、改做法、有"当…时"场景），原样进库。scenario 填它的适用场景。
- rewrite：内容有价值，但写得太具体、是现状描述、缺场景或夹着流水账；把它概括成可迁移的原则再进库。text 写新正文（一句话、可照着做、不写本次/日期/内部 id），scenario 以"当…时"开头且不能只是正文换个说法。
- merge：和某条近邻讲的是同一件事；into 填那条近邻的编号，text 写合并后的原则。
- discard：不满足标准（流水账、报错自己说明原因的一次性问题、代码/文档里能查到的事实、临时用法、一次性授权、证据只是父 agent 派给子代理的提示）。

判断要点：
- 先问"三类里属于哪一类"（A 干活偏好 / B 只有人知道的知识 / C 真会反复踩的坑）；哪类都不是就 discard。
- 只描述某个系统当前状态、某个字段/接口/SQL 怎么写的，是代码里能查到的，discard；但其中如果藏着用户的偏好或设计理由，rewrite 成那条偏好/理由。
- 用户表达的干活方式（汇报、语气、测试、审查、架构取向）是 A 类，价值最高；guidance=true。
- 宁可 rewrite 也不要因为写法差就 discard 一条有价值的知识；但没价值的不要硬救。
- class 为 none 时 verdict 必须是 discard。

${OUTPUT}`;

export function renderCandidates(batch: CandidateInput[]): { prompt: string; ids: Map<string, string>; neighborIds: Map<string, string> } {
  const ids = new Map<string, string>();
  const neighborIds = new Map<string, string>();
  const nbKey = new Map<string, string>();
  const parts: string[] = [];
  batch.forEach((c, i) => {
    const cid = `c${i + 1}`;
    ids.set(cid, c.id);
    const nbs = c.neighbors.map((n) => {
      let k = nbKey.get(n.id);
      if (!k) {
        k = `n${nbKey.size + 1}`;
        nbKey.set(n.id, k);
        neighborIds.set(k, n.id);
      }
      return `  ${k}${n.confirmed_by_user ? "（用户确认）" : ""}：${n.text}`;
    });
    parts.push(
      [
        `<candidate id="${cid}">`,
        `种类：${c.kind}　范围：${c.scope === "global" ? "全局" : `项目 ${c.project ?? ""}`}　依据：${c.basis ?? "未标"}${c.worker ? "　（来自子代理会话：里面的“用户”消息其实是父 agent 的派活提示）" : ""}`,
        `正文：${c.text}`,
        `背景：${c.why ?? "（无）"}`,
        `场景：${c.scenario ?? "（未写）"}`,
        `会话片段：${c.context ? `\n${c.context}` : "（拿不到）"}`,
        `近邻：${nbs.length ? `\n${nbs.join("\n")}` : "（无）"}`,
        `</candidate>`,
      ].join("\n"),
    );
  });
  return { prompt: `共 ${batch.length} 条候选，每条都要给结论：\n\n${parts.join("\n\n")}`, ids, neighborIds };
}

/** 把一位审稿人的 JSON 解析成按正式 id 索引的判决；不合格的项不收（之后按"弃权"算，进仲裁）。 */
export function parseJudgements(raw: string | null, ids: Map<string, string>, neighborIds: Map<string, string>, batch: CandidateInput[]): Map<string, Judgement> {
  const out = new Map<string, Judgement>();
  const o = parseJsonLoose(raw) as { verdicts?: unknown } | null;
  const list = Array.isArray(o?.verdicts) ? o!.verdicts : [];
  const byId = new Map(batch.map((c) => [c.id, c]));
  for (const v of list as any[]) {
    const id = ids.get(String(v?.id));
    if (!id || out.has(id)) continue;
    const j = normalize(v, byId.get(id)!, neighborIds);
    if (j) out.set(id, j);
  }
  return out;
}

export function normalize(v: any, c: CandidateInput, neighborIds: Map<string, string>): Judgement | null {
  const verdict = v?.verdict as Verdict;
  if (!["keep", "rewrite", "merge", "discard"].includes(verdict)) return null;
  const cls: MemClass = ["A", "B", "C", "none"].includes(v?.class) ? v.class : "none";
  const reason = typeof v?.reason === "string" ? v.reason.slice(0, 300) : "";
  if (verdict === "discard") return { verdict, class: cls, guidance: false, reason };
  if (cls === "none") return null; // 自相矛盾：要留却说哪类都不是
  const scenario = isScenario(v?.scenario) ? v.scenario.trim() : isScenario(c.scenario) ? c.scenario : undefined;
  if (!scenario) return null; // 说不出场景的不能进库
  const text = typeof v?.text === "string" && v.text.trim() ? v.text.trim().slice(0, 400) : undefined;
  const guidance = v?.guidance === true || cls === "A";
  if (verdict === "merge") {
    const into = neighborIds.get(String(v?.into));
    if (!into || !text) return null;
    return { verdict, class: cls, scenario, text, into, guidance, reason };
  }
  if (verdict === "rewrite") {
    if (!text) return null;
    return { verdict, class: cls, scenario, text, guidance, reason };
  }
  // keep：原文要有场景；没有就等于改写了场景
  if (!isScenario(c.scenario)) return { verdict: "rewrite", class: cls, scenario, text: c.text, guidance, reason };
  return { verdict, class: cls, scenario, guidance, reason };
}

// ---------- 计票 ----------

export type Decision =
  | { route: "unanimous" | "arbiter"; final: Judgement }
  | { route: "undecided"; final: null; why: string };

/** 三票（或更多）全部有效且结论相同（改写/合并时正文也要相同）才直接执行；否则交仲裁。 */
export function unanimous(votes: (Judgement | null)[]): Judgement | null {
  if (votes.length === 0 || votes.some((v) => !v)) return null;
  const [a, ...rest] = votes as Judgement[];
  for (const b of rest) {
    if (b.verdict !== a.verdict) return null;
    if (a.verdict === "merge" && b.into !== a.into) return null;
    if ((a.verdict === "rewrite" || a.verdict === "merge") && b.text !== a.text) return null;
  }
  if (a.verdict === "discard") return a;
  // 一致 keep：任何一票认为是偏好就打标记
  return { ...a, guidance: (votes as Judgement[]).some((v) => v.guidance) };
}

export const ARBITER_SYSTEM = `你是记忆库的仲裁人。审稿团三位审稿人对同一条候选意见不一致（或都要改写但写法不同）。
按下面的《好记忆的标准》，参考三位的结论和理由，给出最终结论；可以采纳其中一位，也可以自己写更好的改写。

${GOOD_MEMORY_STANDARD}

${OUTPUT}
（verdicts 里只放这一条，id 用 c1。）`;

export function renderArbiter(c: CandidateInput, votes: { name: string; j: Judgement | null }[]): { prompt: string; ids: Map<string, string>; neighborIds: Map<string, string> } {
  const r = renderCandidates([c]);
  const back = new Map([...r.neighborIds].map(([k, v]) => [v, k]));
  const lines = votes.map(({ name, j }, i) => {
    if (!j) return `审稿人${i + 1}（${name}）：输出无效或缺失`;
    const into = j.into ? `　并入：${back.get(j.into) ?? j.into}` : "";
    return `审稿人${i + 1}：${j.verdict}（${j.class}）${into}${j.scenario ? `　场景：${j.scenario}` : ""}${j.text ? `　正文：${j.text}` : ""}　理由：${j.reason}`;
  });
  return { prompt: `${r.prompt}\n\n三位审稿人的意见：\n${lines.join("\n")}`, ids: r.ids, neighborIds: r.neighborIds };
}

// ---------- 跑一批 ----------

export interface CallStat {
  member: string;
  role: "judge" | "arbiter";
  ms: number;
  tokens: number;
  ok: boolean;
  error?: string;
}

export interface CurateResult {
  id: string;
  votes: { name: string; j: Judgement | null }[];
  decision: Decision;
}

export interface Judge {
  name: string;
  chat: Chat;
}

/** 429 退避重试（默认 10s/30s/60s），其他错误重试一次。测试可把 backoff 设成 0。 */
export const retryPolicy = { backoffMs: [10_000, 30_000, 60_000], otherRetries: 1 };

async function timed(member: string, role: CallStat["role"], f: () => ReturnType<Chat>, stats: CallStat[]): Promise<string | null> {
  let other = 0;
  let throttled = 0;
  for (;;) {
    const t0 = Date.now();
    try {
      const r = await f();
      stats.push({ member, role, ms: Date.now() - t0, tokens: r.tokens, ok: true });
      return r.message.content;
    } catch (e) {
      const code = (e as { code?: string }).code;
      const again = code === "http_429" ? throttled < retryPolicy.backoffMs.length : other < retryPolicy.otherRetries;
      if (!again) {
        stats.push({ member, role, ms: Date.now() - t0, tokens: 0, ok: false, error: (e as Error).message.slice(0, 200) });
        return null;
      }
      if (code === "http_429") await new Promise((r) => setTimeout(r, retryPolicy.backoffMs[throttled++]));
      else other++;
    }
  }
}

/** 审稿团判一批：各成员并行、互不可见；再对不一致的逐条仲裁。 */
export async function judgeBatch(batch: CandidateInput[], panel: Judge[], arbiter: Judge, stats: CallStat[]): Promise<CurateResult[]> {
  const r = renderCandidates(batch);
  const raw = await Promise.all(
    panel.map((m) => timed(m.name, "judge", () => m.chat([{ role: "system", content: JUDGE_SYSTEM }, { role: "user", content: r.prompt }], { json: true }), stats)),
  );
  const parsed = raw.map((t) => parseJudgements(t, r.ids, r.neighborIds, batch));
  return Promise.all(
    batch.map(async (c): Promise<CurateResult> => {
      const votes = panel.map((m, i) => ({ name: m.name, j: parsed[i].get(c.id) ?? null }));
      const u = unanimous(votes.map((v) => v.j));
      if (u) return { id: c.id, votes, decision: { route: "unanimous", final: u } };
      const a = renderArbiter(c, votes);
      const txt = await timed(arbiter.name, "arbiter", () => arbiter.chat([{ role: "system", content: ARBITER_SYSTEM }, { role: "user", content: a.prompt }], { json: true }), stats);
      const fin = parseJudgements(txt, a.ids, a.neighborIds, [c]).get(c.id);
      if (!fin) return { id: c.id, votes, decision: { route: "undecided", final: null, why: txt === null ? "仲裁调用失败" : "仲裁输出无效" } };
      return { id: c.id, votes, decision: { route: "arbiter", final: fin } };
    }),
  );
}

// ---------- 执行计划（dry-run 只出这个；--apply 才写事件） ----------

export type Action =
  | { op: "promote"; id: string; guidance: boolean; scenario: string }
  | { op: "rewrite"; id: string; text: string; scenario: string; guidance: boolean }
  | { op: "merge"; id: string; into: string; text: string; review: boolean }
  | { op: "discard"; id: string; reason: string }
  | { op: "skip"; id: string; why: string };

/** 把结论变成动作。只对候选生效；用户确认过的条目一律 skip（只进复核清单）。 */
export function planAction(p: Proposition, res: CurateResult, liveProps: Map<string, Proposition>): Action {
  if (p.confirmed_by === "user") return { op: "skip", id: p.id, why: "用户确认过的条目不动，进复核清单" };
  if (p.state !== "candidate") return { op: "skip", id: p.id, why: `不是候选（${p.state}）` };
  const d = res.decision;
  if (!d.final) return { op: "skip", id: p.id, why: d.route === "undecided" ? d.why : "无结论" };
  const f = d.final;
  if (f.verdict === "discard") return { op: "discard", id: p.id, reason: f.reason };
  if (f.verdict === "keep") return { op: "promote", id: p.id, guidance: f.guidance, scenario: f.scenario! };
  if (f.verdict === "rewrite") return { op: "rewrite", id: p.id, text: f.text!, scenario: f.scenario!, guidance: f.guidance };
  const target = liveProps.get(f.into!);
  if (!target || target.state !== "active") return { op: "skip", id: p.id, why: "并入目标不存在或不在正式库" };
  // 不改目标正文：候选并入目标（归档、可恢复）；合并后的原则文字进报告，目标是用户确认的则进复核清单
  return { op: "merge", id: p.id, into: target.id, text: f.text!, review: target.confirmed_by === "user" };
}
