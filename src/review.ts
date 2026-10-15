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
import { CLI_HOSTS, type CliHost } from "./clireviewer.ts";

export interface PanelMember {
  name: string;
  /** api（默认）：直接调 OpenAI 兼容接口；cli：用宿主自己的命令行无头跑（claude -p / codex exec / pi -p），用宿主账号的额度。 */
  type: "api" | "cli";
  /** type=cli 时：哪个宿主。 */
  host?: CliHost;
  /** type=cli 时：推理强度（claude --effort / codex model_reasoning_effort / pi --thinking）。 */
  effort?: string;
  /** type=cli 时可选：可执行文件路径，默认走 PATH。 */
  bin?: string;
  /** type=api 必填；type=cli 为空串。 */
  baseUrl: string;
  /** type=api：模型 id；type=cli：宿主认的模型名/别名，空串 = 宿主默认。 */
  model: string;
  /** 钥匙串 service 名；配置文件只记名字，key 不进文件。type=cli 为空串（用宿主自己的登录）。 */
  keyService: string;
  timeoutMs?: number;
  /** 同时在途的请求数（默认 1：代理/套餐常按并发限流）。 */
  concurrency?: number;
  /** 并进请求体的额外字段。 */
  extraBody?: Record<string, unknown>;
}

export interface ReviewConfig {
  /**
   * panel：panel 里各成员投票，一致直接执行，分歧交仲裁。
   * primary：只有 primary 一位主审定结论；panel 里其他成员只给参考意见（先跑，意见附给主审、记进报告，不投票），不用仲裁。
   */
  mode: "panel" | "primary";
  /**
   * 会话结束抽取完后自动拉起分离的 ab curate --apply（默认 false）。
   * 只有 review.json 明确写 "autoRun": true 才会自动审稿写库；不写或 false 时 hook 不拉起审稿。
   */
  autoRun: boolean;
  /**
   * 按宿主分的审稿人（可选）：某个宿主的会话结束后，用这里配的成员单独审"从该宿主会话抽出来的候选"，
   * 用的是该宿主自己的账号额度（通常是 type=cli 的 claude -p / codex exec / pi -p）。没配的宿主走上面的 mode/panel。
   */
  hostReviewers: Partial<Record<CliHost, PanelMember>>;
  /** primary 模式下的主审（panel 成员的 name）。 */
  primary: string | null;
  panel: PanelMember[];
  /** 仲裁人的 name：panel 里某个成员，或 review.json 里单独写的仲裁模型（arbiter 写成对象）。 */
  arbiter: string;
  /** 仲裁模型的完整配置（在 panel 里时就是那个成员）。 */
  arbiterMember: PanelMember;
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
    const r = validateMember(m, path);
    if ("error" in r) return r;
    if (names.has(r.name)) return { error: `${path} 的 panel 成员重名: ${r.name}` };
    names.add(r.name);
    panel.push(r);
  }
  const mode = o.mode === undefined ? "panel" : o.mode;
  if (mode !== "panel" && mode !== "primary") return { error: `${path} 的 mode 只能是 panel 或 primary` };
  if (o.autoRun !== undefined && typeof o.autoRun !== "boolean") return { error: `${path} 的 autoRun 只能是 true 或 false` };
  const hostReviewers: Partial<Record<CliHost, PanelMember>> = {};
  if (o.hostReviewers !== undefined) {
    if (typeof o.hostReviewers !== "object" || o.hostReviewers === null || Array.isArray(o.hostReviewers)) return { error: `${path} 的 hostReviewers 必须是对象` };
    for (const [h, m] of Object.entries(o.hostReviewers)) {
      if (!CLI_HOSTS.includes(h as CliHost)) return { error: `${path} 的 hostReviewers 只能有 ${CLI_HOSTS.join("/")}` };
      if (m === null) continue;
      const r = validateMember(m, path);
      if ("error" in r) return { error: r.error.replace("panel 成员", `hostReviewers.${h}`) };
      hostReviewers[h as CliHost] = r;
    }
  }
  const int = (v: unknown, d: number) => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : d);
  if (mode === "primary") {
    const pm = panel.find((m) => m.name === o.primary);
    if (!pm) return { error: `${path} 的 mode=primary 时 primary 必须是 panel 里某个成员的 name` };
    // primary 模式不用仲裁：arbiter 字段即使写了也忽略，这里指向主审只为类型完整
    return { mode, autoRun: o.autoRun === true, hostReviewers, primary: pm.name, panel, arbiter: pm.name, arbiterMember: pm, batchSize: int(o.batchSize, 10), maxBatches: int(o.maxBatches, 3) };
  }
  let arbiterMember: PanelMember | undefined;
  if (typeof o.arbiter === "string") arbiterMember = panel.find((m) => m.name === o.arbiter);
  else if (o.arbiter && typeof o.arbiter === "object") {
    const r = validateMember(o.arbiter, path);
    if ("error" in r) return { error: r.error.replace("panel 成员", "arbiter ") };
    if (names.has(r.name)) return { error: `${path} 的 arbiter 和 panel 成员重名: ${r.name}（要用 panel 成员当仲裁就只写它的 name）` };
    arbiterMember = r;
  }
  if (!arbiterMember) return { error: `${path} 的 arbiter 必须是 panel 里某个成员的 name，或一个完整的模型配置对象` };
  return { mode, autoRun: o.autoRun === true, hostReviewers, primary: null, panel, arbiter: arbiterMember.name, arbiterMember, batchSize: int(o.batchSize, 10), maxBatches: int(o.maxBatches, 3) };
}

function validateMember(m: any, path: string): PanelMember | { error: string } {
  const type = m?.type === undefined ? "api" : m.type;
  if (type !== "api" && type !== "cli") return { error: `${path} 的 panel 成员 type 只能是 api 或 cli` };
  if (type === "cli") {
    if (typeof m?.name !== "string" || !m.name.trim()) return { error: `${path} 的 panel 成员缺 name` };
    if (!CLI_HOSTS.includes(m.host)) return { error: `${path} 的 ${m.name}.host 只能是 ${CLI_HOSTS.join("/")}` };
    for (const k of ["model", "effort", "bin"]) if (m[k] !== undefined && typeof m[k] !== "string") return { error: `${path} 的 ${m.name}.${k} 必须是字符串` };
    return {
      name: m.name,
      type,
      host: m.host,
      model: m.model ?? "",
      effort: m.effort || undefined,
      bin: m.bin || undefined,
      baseUrl: "",
      keyService: "",
      timeoutMs: typeof m.timeoutMs === "number" && m.timeoutMs > 0 ? m.timeoutMs : undefined,
      concurrency: typeof m.concurrency === "number" && m.concurrency >= 1 ? Math.floor(m.concurrency) : undefined,
    };
  }
  for (const k of ["name", "baseUrl", "model", "keyService"]) {
    if (typeof m?.[k] !== "string" || !m[k].trim()) return { error: `${path} 的 panel 成员缺 ${k}` };
  }
  if (m.extraBody !== undefined && (typeof m.extraBody !== "object" || m.extraBody === null || Array.isArray(m.extraBody))) return { error: `${path} 的 ${m.name}.extraBody 必须是对象` };
  return {
    name: m.name,
    type,
    baseUrl: m.baseUrl,
    model: m.model,
    keyService: m.keyService,
    timeoutMs: typeof m.timeoutMs === "number" && m.timeoutMs > 0 ? m.timeoutMs : undefined,
    concurrency: typeof m.concurrency === "number" && m.concurrency >= 1 ? Math.floor(m.concurrency) : undefined,
    extraBody: m.extraBody,
  };
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

const EVIDENCE_NOTE = `关于证据：引文是否逐字出自会话，程序在写入时已经核对过；会话片段"拿不到"只是没附上，不等于没有证据。不要以"片段里看不到用户原话/工具输出"为理由丢弃。子代理会话里的派活提示只意味着它不能当作"用户要求"，内容本身值不值得记照常按标准判断。`;

export const JUDGE_RULES = `判断要点：
- 先问"三类里属于哪一类"（A 干活偏好 / B 只有人知道的知识 / C 真会反复踩的坑）；哪类都不是就 discard。
- 只描述某个系统当前状态、某个字段/接口/SQL 怎么写的，是代码里能查到的，discard；但其中如果藏着用户的偏好或设计理由，rewrite 成那条偏好/理由。本项目的设计决定、模块职责、跨多处的代码地图、用户环境的具体事实属于 B 类，能省掉重新探索就留，不要以"能查到"为由丢。
- 跟用户项目和环境无关的通用技术常识（操作系统、shell、语言、通用工具的行为）discard，哪怕换个项目也会撞上；凭据保管套话 discard。
- 用户表达的干活方式（汇报、语气、测试、审查、架构取向）是 A 类，价值最高；guidance=true。
- 宁可 rewrite 也不要因为写法差就 discard 一条有价值的知识；但没价值的不要硬救：不要把一次具体 bug 硬概括成谁都知道的空话（"改配置要同步检查""交接要给完整证据"这类）。
- C 类要问：换个项目、换个任务，下一个 agent 还会撞上吗？撞上时报错能不能直接看出原因？只在某个文件/某次改动里出现过、修完就没了的问题，不算。
- 子代理会话里的"用户"消息是父 agent 的派活提示：它不能单独证明"用户要求"；但其中的通用干活方法（测试写法、验证方式、临时产物放哪）按内容当 A 类判断，只有一次性任务限制才因此 discard。agent 自己从工具输出观察到的坑、或背景里写明的设计理由，照常按 C/B 类判断。
- merge 只用于候选本身合格、只是和近邻重复的情况；候选本身不合格就 discard，不要因为有相似近邻而 merge。
- merge 不是折中：拿不准该留还是该丢时，先把去留想清楚；不合格就 discard，合格才考虑 keep/rewrite/merge。
- 格式硬要求：keep/rewrite/merge 必须给 class（A/B/C）和以"当"开头、含"时"的 scenario；class 为 none 时 verdict 必须是 discard。缺这些的结论会被当成废票。`;

export const JUDGE_SYSTEM = `你是记忆库的审稿人。下面是《好记忆的标准》全文，严格按它判断每条候选该不该进正式库。

${GOOD_MEMORY_STANDARD}

## 你的任务
对每条候选独立给出四选一：
- keep：原文已经合格（能迁移、查不到、改做法、有"当…时"场景），原样进库。scenario 填它的适用场景。
- rewrite：内容有价值，但写得太具体、是现状描述、缺场景或夹着流水账；把它概括成可迁移的原则再进库。text 写新正文（一句话、可照着做、不写本次/日期/内部 id），scenario 以"当…时"开头且不能只是正文换个说法。
- merge：和某条近邻讲的是同一件事；into 填那条近邻的编号，text 写合并后的原则。
- discard：不满足标准（流水账、报错自己说明原因的一次性问题、代码/文档里能查到的事实、临时用法、一次性授权、只针对某次任务的派活限制、通用技术常识）。

${JUDGE_RULES}

${EVIDENCE_NOTE}

${OUTPUT}`;

export function renderCandidates(batch: CandidateInput[]): { prompt: string; ids: Map<string, string>; neighborIds: Map<string, string> } {
  const ids = new Map<string, string>();
  /** 近邻编号按候选各自编（每条候选的近邻都从 n1 起），键为 `<候选编号>:<近邻编号>`：merge 只能并入本条自己的近邻。 */
  const neighborIds = new Map<string, string>();
  const parts: string[] = [];
  batch.forEach((c, i) => {
    const cid = `c${i + 1}`;
    ids.set(cid, c.id);
    const nbs = c.neighbors.map((n, j) => {
      const k = `n${j + 1}`;
      neighborIds.set(`${cid}:${k}`, n.id);
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
export function parseJudgements(raw: string | null, ids: Map<string, string>, neighborIds: Map<string, string>, batch: CandidateInput[], invalid?: Map<string, string>): Map<string, Judgement> {
  const out = new Map<string, Judgement>();
  const o = parseJsonLoose(raw) as { verdicts?: unknown } | null;
  const list = Array.isArray(o?.verdicts) ? o!.verdicts : [];
  const byId = new Map(batch.map((c) => [c.id, c]));
  for (const v of list as any[]) {
    const cid = String(v?.id);
    const id = ids.get(cid);
    if (!id || out.has(id)) continue;
    const why: string[] = [];
    const scoped = new Map([...neighborIds].filter(([k]) => k.startsWith(`${cid}:`)).map(([k, x]) => [k.slice(cid.length + 1), x]));
    const j = normalize(v, byId.get(id)!, scoped, why);
    if (j) out.set(id, j);
    else invalid?.set(id, why[0] ?? "invalid");
  }
  if (invalid) for (const c of batch) if (!out.has(c.id) && !invalid.has(c.id)) invalid.set(c.id, raw === null ? "call_failed" : "missing");
  return out;
}

export function normalize(v: any, c: CandidateInput, neighborIds: Map<string, string>, why: string[] = []): Judgement | null {
  const bad = (w: string) => (why.push(w), null);
  const verdict = v?.verdict as Verdict;
  if (!["keep", "rewrite", "merge", "discard"].includes(verdict)) return bad("bad_verdict");
  const cls: MemClass = ["A", "B", "C", "none"].includes(v?.class) ? v.class : "none";
  const reason = typeof v?.reason === "string" ? v.reason.slice(0, 300) : "";
  if (verdict === "discard") return { verdict, class: cls, guidance: false, reason };
  if (cls === "none") return bad("class_none"); // 自相矛盾：要留却说哪类都不是
  const scenario = isScenario(v?.scenario) ? v.scenario.trim() : isScenario(c.scenario) ? c.scenario : undefined;
  if (!scenario) return bad("no_scenario"); // 说不出场景的不能进库
  const text = typeof v?.text === "string" && v.text.trim() ? v.text.trim().slice(0, 400) : undefined;
  const guidance = v?.guidance === true || cls === "A";
  if (verdict === "merge") {
    const into = neighborIds.get(String(v?.into));
    if (!into) return bad("merge_bad_target");
    if (!text) return bad("merge_no_text");
    return { verdict, class: cls, scenario, text, into, guidance, reason };
  }
  if (verdict === "rewrite") {
    if (!text) return bad("rewrite_no_text");
    return { verdict, class: cls, scenario, text, guidance, reason };
  }
  // keep：原文要有场景；没有就等于改写了场景
  if (!isScenario(c.scenario)) return { verdict: "rewrite", class: cls, scenario, text: c.text, guidance, reason };
  return { verdict, class: cls, scenario, guidance, reason };
}

// ---------- 计票 ----------

/** primary：主审一人定结论（primary 模式）。arbiter_wording：三票都同意留下、只是写法/去向不同，仲裁只定写法（不能改成丢弃）。arbiter：去留有分歧，仲裁定去留。 */
export type Decision =
  | { route: "unanimous" | "arbiter" | "arbiter_wording" | "primary"; final: Judgement }
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

/** 三票全部有效且都主张留下（keep/rewrite/merge）。 */
export function allAdmit(votes: (Judgement | null)[]): boolean {
  return votes.length > 0 && votes.every((v) => v && v.verdict !== "discard");
}

export const ARBITER_SYSTEM = `你是记忆库的仲裁人。审稿团三位审稿人对同一条候选的去留意见不一致。
按下面的《好记忆的标准》和判断要点，参考三位的结论和理由，给出最终结论；可以采纳其中一位，也可以自己写更好的改写。

${GOOD_MEMORY_STANDARD}

${JUDGE_RULES}

${EVIDENCE_NOTE}

${OUTPUT}
（verdicts 里只放这一条，id 用 c1。）`;

export const WORDING_SYSTEM = `你是记忆库的仲裁人。审稿团三位审稿人都同意这条候选应该留下，只是写法或去向（原样保留/改写/并入近邻）不同。
去留已经定了，不要再判 discard。你只负责按下面的《好记忆的标准》定最终写法：在 keep、rewrite、merge 中选一个，可以采纳其中一位，也可以综合写一条更好的。

${GOOD_MEMORY_STANDARD}

${OUTPUT}
（verdicts 里只放这一条，id 用 c1；verdict 只能是 keep、rewrite 或 merge。）`;

export function renderArbiter(c: CandidateInput, votes: { name: string; j: Judgement | null }[]): { prompt: string; ids: Map<string, string>; neighborIds: Map<string, string> } {
  const r = renderCandidates([c]);
  const back = new Map([...r.neighborIds].map(([k, v]) => [v, k.split(":")[1]]));
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
  /** CLI 后端（claude）报的费用，美元。 */
  costUsd?: number;
}

export interface CurateResult {
  id: string;
  /** invalid：这一票为什么无效（call_failed / missing / no_scenario / merge_bad_target …）。 */
  votes: { name: string; j: Judgement | null; invalid?: string; advisory?: boolean }[];
  decision: Decision;
}

export interface Judge {
  name: string;
  chat: Chat;
}

/**
 * 429：按 retry-after（没有就按 backoffMs）退避重试，不算失败。
 * 要等的时间超过 maxWaitMs（套餐额度要几小时后才重置），或退避用完仍是 429，就抛 QuotaExhausted 让整次运行停下，
 * 并报告什么时候恢复，不原地空转。其他错误重试一次后算这一票失败。测试可把时间都设成 0。
 */
export const retryPolicy = { backoffMs: [10_000, 30_000, 60_000, 120_000, 300_000], otherRetries: 1, maxWaitMs: 5 * 60_000 };

export class QuotaExhausted extends Error {
  member: string;
  /** 预计恢复时间（ISO）；不知道为 null。 */
  resetAt: string | null;
  constructor(member: string, resetAt: string | null, detail: string) {
    super(`${member} 额度用完${resetAt ? `，预计 ${resetAt} 恢复` : ""}：${detail}`);
    this.member = member;
    this.resetAt = resetAt;
  }
}

async function timed(member: string, role: CallStat["role"], f: () => ReturnType<Chat>, stats: CallStat[]): Promise<string | null> {
  let other = 0;
  let throttled = 0;
  for (;;) {
    const t0 = Date.now();
    try {
      const r = await f();
      stats.push({ member, role, ms: Date.now() - t0, tokens: r.tokens, ok: true, ...(typeof r.costUsd === "number" ? { costUsd: r.costUsd } : {}) });
      return r.message.content;
    } catch (e) {
      const err = e as Error & { code?: string; retryAfterMs?: number };
      if (err.code === "http_429") {
        const wait = typeof err.retryAfterMs === "number" ? err.retryAfterMs : retryPolicy.backoffMs[throttled];
        if (wait === undefined || wait > retryPolicy.maxWaitMs) {
          stats.push({ member, role, ms: Date.now() - t0, tokens: 0, ok: false, error: err.message.slice(0, 200) });
          const resetAt = typeof err.retryAfterMs === "number" ? new Date(Date.now() + err.retryAfterMs).toISOString() : null;
          throw new QuotaExhausted(member, resetAt, err.message.slice(0, 200));
        }
        throttled++;
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      // 上游过载/暂不可用（502/503/504）：和 429 一样按退避表重试，但用完就算这一票失败，不停整次运行
      if (/HTTP 50[234]\b/.test(err.message) && throttled < retryPolicy.backoffMs.length) {
        await new Promise((r) => setTimeout(r, retryPolicy.backoffMs[throttled++]));
        continue;
      }
      if (other >= retryPolicy.otherRetries) {
        stats.push({ member, role, ms: Date.now() - t0, tokens: 0, ok: false, error: err.message.slice(0, 200) });
        return null;
      }
      other++;
    }
  }
}

/** 审稿团判一批：各成员并行、互不可见；再对不一致的逐条仲裁。 */
export async function judgeBatch(batch: CandidateInput[], panel: Judge[], arbiter: Judge, stats: CallStat[]): Promise<CurateResult[]> {
  const r = renderCandidates(batch);
  const raw = await Promise.all(
    panel.map((m) => timed(m.name, "judge", () => m.chat([{ role: "system", content: JUDGE_SYSTEM }, { role: "user", content: r.prompt }], { json: true }), stats)),
  );
  const invalid = raw.map(() => new Map<string, string>());
  const parsed = raw.map((t, i) => parseJudgements(t, r.ids, r.neighborIds, batch, invalid[i]));
  return Promise.all(
    batch.map(async (c): Promise<CurateResult> => {
      const votes = panel.map((m, i) => {
        const j = parsed[i].get(c.id) ?? null;
        return j ? { name: m.name, j } : { name: m.name, j, invalid: invalid[i].get(c.id) };
      });
      const u = unanimous(votes.map((v) => v.j));
      if (u) return { id: c.id, votes, decision: { route: "unanimous", final: u } };
      const wording = allAdmit(votes.map((v) => v.j));
      const a = renderArbiter(c, votes);
      const sys = wording ? WORDING_SYSTEM : ARBITER_SYSTEM;
      const txt = await timed(arbiter.name, "arbiter", () => arbiter.chat([{ role: "system", content: sys }, { role: "user", content: a.prompt }], { json: true }), stats);
      const fin = parseJudgements(txt, a.ids, a.neighborIds, [c]).get(c.id);
      if (!fin || (wording && fin.verdict === "discard")) return { id: c.id, votes, decision: { route: "undecided", final: null, why: !fin ? "仲裁输出无效" : "三票都要留，仲裁却判丢弃：不执行" } };
      return { id: c.id, votes, decision: { route: wording ? "arbiter_wording" : "arbiter", final: fin } };
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
  const failed = res.votes.filter((v) => v.invalid === "call_failed" && !v.advisory).map((v) => v.name);
  if (failed.length) return { op: "skip", id: p.id, why: `审稿团有人没判（${failed.join("、")} 调用失败），不执行` };
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

// ---------- primary 模式：一位主审 + 参考意见 ----------

export const PRIMARY_NOTE = `每条候选后面附了其他审稿人的参考意见（他们不投票）。可以借鉴他们指出的事实和理由，但结论由你按标准独立判断，不要因为多数意见就跟随。`;

export const PRIMARY_SYSTEM = `${JUDGE_SYSTEM}\n\n${PRIMARY_NOTE}`;

export function renderAdvice(c: CandidateInput, cid: string, advice: { name: string; j: Judgement | null }[], neighborBack: Map<string, string>): string {
  const lines = advice.map(({ name, j }) => {
    if (!j) return `  ${name}：（没给出有效意见）`;
    const into = j.into ? `　并入：${neighborBack.get(j.into) ?? "近邻"}` : "";
    return `  ${name}：${j.verdict}（${j.class}）${into}${j.scenario ? `　场景：${j.scenario}` : ""}${j.text ? `　正文：${j.text}` : ""}　理由：${j.reason}`;
  });
  void c;
  return `<advice for="${cid}">\n${lines.join("\n")}\n</advice>`;
}

/** primary 模式判一批（advisors 可以为空 = 主审单独判）：参考意见先跑（并行、互不可见），再把意见附给主审；主审的结论就是最终结论，不仲裁。主审没给出有效结论的条目为未决。 */
export async function judgeBatchPrimary(batch: CandidateInput[], primary: Judge, advisors: Judge[], stats: CallStat[]): Promise<CurateResult[]> {
  const r = renderCandidates(batch);
  const raw = await Promise.all(
    advisors.map((m) => timed(m.name, "judge", () => m.chat([{ role: "system", content: JUDGE_SYSTEM }, { role: "user", content: r.prompt }], { json: true }), stats)),
  );
  const inv = raw.map(() => new Map<string, string>());
  const adv = raw.map((t, i) => parseJudgements(t, r.ids, r.neighborIds, batch, inv[i]));
  const cidOf = new Map([...r.ids].map(([cid, id]) => [id, cid]));
  const advice = batch.map((c) => {
    const cid = cidOf.get(c.id)!;
    const back = new Map([...r.neighborIds].filter(([k]) => k.startsWith(`${cid}:`)).map(([k, v]) => [v, k.slice(cid.length + 1)]));
    return renderAdvice(c, cid, advisors.map((m, i) => ({ name: m.name, j: adv[i].get(c.id) ?? null })), back);
  });
  // 没有参考成员（主审单独判）时：不附空的 advice 块，也不提"参考意见"，提示词与普通审稿人一致
  const solo = advisors.length === 0;
  const prompt = solo ? r.prompt : `${r.prompt}\n\n其他审稿人的参考意见（不投票）：\n${advice.join("\n")}`;
  const pinv = new Map<string, string>();
  const ptxt = await timed(primary.name, "judge", () => primary.chat([{ role: "system", content: solo ? JUDGE_SYSTEM : PRIMARY_SYSTEM }, { role: "user", content: prompt }], { json: true }), stats);
  const pj = parseJudgements(ptxt, r.ids, r.neighborIds, batch, pinv);
  return batch.map((c) => {
    const pv = pj.get(c.id) ?? null;
    const votes: CurateResult["votes"] = [
      pv ? { name: primary.name, j: pv } : { name: primary.name, j: null, invalid: pinv.get(c.id) },
      ...advisors.map((m, i) => {
        const j = adv[i].get(c.id) ?? null;
        return j ? { name: m.name, j, advisory: true } : { name: m.name, j, invalid: inv[i].get(c.id), advisory: true };
      }),
    ];
    return { id: c.id, votes, decision: pv ? { route: "primary", final: pv } : { route: "undecided", final: null, why: ptxt === null ? "主审调用失败" : "主审输出无效" } };
  });
}

/** 某宿主会话结束后的审稿配置：配了 hostReviewers[host] 就用它单独当主审；否则沿用主配置。 */
export function configForHost(cfg: ReviewConfig, host: CliHost | null): { cfg: ReviewConfig; onlyHost: CliHost | null } {
  const m = host ? cfg.hostReviewers[host] : undefined;
  if (!host || !m) return { cfg, onlyHost: null };
  return { cfg: { ...cfg, mode: "primary", primary: m.name, panel: [m], arbiter: m.name, arbiterMember: m }, onlyHost: host };
}
