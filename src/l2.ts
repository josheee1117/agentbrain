/**
 * L2 合同（设计 §5.3、§9.1、§19.4）：L1 事件体、投影出的 Proposition，以及投影函数本身。
 * 这里是这些形状的唯一来源；未冻结的 facets、组合视图、projector version 见 §21 2026-10-10 切片 2 条目。
 */
import { sanitize, secretKinds } from "./sanitize.ts";

export type PropKind = "rule" | "decision" | "pitfall" | "note";
export type EventKind = "remember" | "archive" | "reactivate" | "confirm" | "purge" | "evidence" | "verify" | "relate" | "unconfirm" | "tag" | "stage" | "curate" | "detail";

export const KIND_LABEL: Record<PropKind, string> = { rule: "规则", decision: "决定", pitfall: "坑", note: "事实" };

/** §8.11.2：详情正文只给决定、事实、坑（规则必须一行说清）。 */
export const BODY_KINDS: readonly PropKind[] = ["decision", "note", "pitfall"];
export const BODY_MAX_CHARS = 40000;
export const ALTERNATIVES_MAX = 5;
export const ALTERNATIVE_FIELD_MAX_CHARS = 200;
export type Host = "claude" | "codex" | "pi" | "opencode";
/** 只表示条目还在不在用；可信程度另看 confirmed / confirmed_by（visibility.ts 的 trustOf）。候选区已去掉（§8.8）。 */
export type PropState = "active" | "archived" | "superseded";
/** 价值标准的标记（v3 第 1 阶段只打标记、不丢弃，交给审稿人）。 */
export type ValueFlag = "no_scenario" | "phase" | "findable" | "narrative" | "project_unresolved" | "body_dropped" | "alternatives_dropped";
/** 场景（§11.10）：规则按设计 / 开发 / review 打标签，开工只加载当前场景的。封闭三值，空表示不分场景。 */
export const SCENES = ["design", "code", "review"] as const;
export type Scene = (typeof SCENES)[number];

export interface SourcePointer {
  host: Host | null;
  session_id: string | null;
  transcript: string | null; // transcript 文件；ephemeral 会话为 null
  anchor: string | null; // 记忆时的定位点：pi entry id / claude uuid / codex ordinal
  summary: string; // 一句话：讨论了什么
  /** 主会话转记子代理汇报时，记录当时的主会话。 */
  relayed_by?: { host: Host; session_id: string | null } | null;
}

/** 切片 3：这条记忆从哪种依据抽出来（§8.2）。user_* 必须引用户原话，observed_failure 必须引工具输出。 */
export type Basis = "user_directive" | "user_confirmed" | "observed_failure" | "agent_inference";
export type Origin = "manual" | "extract" | "import" | "curate";
/** 从外部知识库导入的出处（§21 2026-10-13 Pensieve 导入）：原文件路径与内容哈希，重导时据此判断是否变更。 */
export interface ImportRef {
  system: "pensieve";
  id: string;
  path: string;
  sha256: string;
  /** 同一内容在其他仓库的副本路径。 */
  also?: string[];
}
/** 抽取器判定的与已有记忆的关系（§9.4.4）。 */
export type RelationType = "new" | "duplicate" | "refines" | "conflicts" | "supersedes" | "unsure";
/** 谁让这条转正：用户、代码核验、跨会话印证。旧数据缺字段按用户。 */
export type ConfirmedBy = "user" | "code" | "corroboration";

/**
 * transcript 里的证据坐标（§13.3）。quote 是逐字核对、过滤密钥之后实际算哈希的那段原话（§8.11.2），
 * 不变量 sha256(quote) === quote_sha256；旧事件只留哈希，投影出不带 quote 的引用。
 * said_at 是这段原话所在轮的时间，没有就缺省（不拿条目的 said_at 代替）。
 */
export interface EvidenceRef {
  anchor: string;
  role: "user" | "assistant" | "tool";
  quote_sha256: string;
  quote?: string;
  said_at?: string;
}

/** 讨论时否定掉的方案（§8.11.2）。evidence 指向本条 evidence[] 的下标；手写没有原话可指，缺省。 */
export interface Alternative {
  option: string;
  rejected_because: string;
  evidence?: number;
}

/** 代码证据：仓库内相对路径 + 行号，或一个 commit。quote 是核对过的原文片段（已脱敏，≤200 字）。 */
export type CodeRef =
  | { path: string; line_start: number; line_end: number; quote: string }
  | { commit: string; quote: string };

export interface ModelProvenance {
  model?: string;
  prompt_version?: string;
}

export interface ModelOutput {
  event_id: string;
  kind: "remember" | "evidence" | "relate" | "verify";
  model: string | null;
  prompt_version: string | null;
}

export interface RememberBody extends ModelProvenance {
  kind: PropKind;
  text: string;
  why?: string;
  source: SourcePointer;
  /** 子代理也要看。只对全局记忆有意义（§11.1）。 */
  for_workers?: boolean;
  /** 用户明确要求记的为 true。旧数据可缺，投影时缺字段按已确认。 */
  confirmed: boolean;
  /** 这条是对某条已有记忆的纠正。只有本条已确认时才会把目标标成 superseded。 */
  supersedes?: string;
  /** 以下为切片 3 自动沉淀的字段；手工 remember 缺省。 */
  origin?: Origin;
  basis?: Basis;
  trigger?: string;
  evidence?: EvidenceRef[];
  window_id?: string;
  relation?: { type: RelationType; target: string | null };
  /** 第 1 层没判定关系（§9.4.4 pending）。第 2 层 relate 判出确定关系即解除；判 unsure 后只有用户能解除（§21 2026-10-13）。 */
  unreconciled?: boolean;
  /** 导入条目的出处（origin=import）。 */
  import_ref?: ImportRef;
  /** 预计有效天数（抽取器可建议）；缺省按种类给默认值，见 expiry.ts。 */
  valid_days?: number;
  /** 证据原话的时间（抽取时取证据所在轮的时间）。重跑抽取不会改它，到期复审从这里起算。 */
  said_at?: string;
  /** 指导 agent 怎么干活的偏好（汇报方式、语气、工作流）。已确认的全局偏好每轮常驻注入（§21 2026-10-14 价值审计 C）。 */
  guidance?: boolean;
  /** 只对规则有意义（§11.10）。空/缺省表示不分场景。 */
  scenes?: Scene[];
  /** 旧版本（v3 候选区，§8.8 前）写下的候选标记。投影时忽略：条目照常是有效的未确认条目。 */
  candidate?: boolean;
  /** 旧版本 ab remember --direct 写下的标记（候选区去掉后不再写，也不再读）。 */
  direct?: boolean;
  /** ab curate 改写生成的新条目：哪次运行、改写的是哪条（--undo 在报告没落盘时从 L1 找回）。 */
  curate?: { run: string; of: string };
  /** 话题结束时一步式沉淀写的条目（§8.6）：哪次运行、哪个话题窗口、怎么触发的、窗口定位点起止、提示词版本、模型。ab work --undo 据 run 从 L1 找回。 */
  topic?: TopicProvenance;
  /** 抽取器给的价值字段与校验标记（v3 第 1 阶段只记录）。 */
  value?: { scenario?: string; durability?: "permanent" | "phase" | "exploration"; findable?: boolean; flags: ValueFlag[]; session_project?: string };
  /** 详情正文（§8.11.2）：决定、事实、坑能带，正文仍是一行标题。上限 BODY_MAX_CHARS，不截断。 */
  body?: string;
  /** 讨论时否定掉的方案（§8.11.2）：只有决定能带。 */
  alternatives?: Alternative[];
}

/** detail 事件：给已有条目补上原来没有的详情（§8.11.2）。不换 id、不改确认状态和关联。 */
export interface DetailBody {
  body?: string;
  alternatives?: Alternative[];
}

export interface TopicProvenance {
  run: string;
  window_id: string;
  trigger: "idle" | "compact" | "session_end";
  /** 窗口起点（不含，上一个处理进度）与终点定位点：Claude 消息 uuid、Codex 行序号、Pi 条目 id。 */
  from: string | null;
  to: string;
  /** 话题太长拆开时为 "k/n"。 */
  part: string | null;
  /** 旧事件的系统提示与 worker note 联合哈希，只读原值。新事件写顶层字段。 */
  prompt_version?: string;
  /** 旧事件的宿主:模型@推理强度，新事件写顶层字段。 */
  model?: string;
  /** 模型给的价值类别 A/B/C。 */
  class: "A" | "B" | "C";
}

/** evidence 事件：给已有记忆追加一处来源（抽取判定为重复时）。 */
export interface EvidenceBody extends ModelProvenance {
  source: SourcePointer;
  basis: Basis;
  evidence: EvidenceRef[];
  window_id: string;
}

/** verify 事件：ab work 按仓库真实代码核验一条未确认记忆的结果。只有带可核对代码证据的结论才写 L1。 */
export interface VerifyBody extends ModelProvenance {
  outcome: "verified" | "contradicted";
  head: string;
  refs: CodeRef[];
  model: string;
}

/** confirm 事件体。用户确认为 {}；跨会话印证带 by 与会话列表。 */
export interface ConfirmBody {
  by?: ConfirmedBy;
  sessions?: string[];
}

/** archive 事件体。ab work 归档过期提议、或判定为重复后并入 into 时带 reason。用 reactivate 可撤销。 */
export interface ArchiveBody {
  reason?: "expired" | "duplicate" | "value-audit" | "curate" | "topic_undo";
  into?: string;
  /** 归档说明（value-audit 写不合格的原因）。 */
  note?: string;
}

/**
 * unconfirm 事件：撤销自动转正（跨会话印证、代码核验）。用于事后发现转正依据不成立，
 * 例如"用户原话"其实是父 agent 写给 worker 的派活提示（§21 2026-10-14 价值审计 B）。
 * 撤销后不再自动转正，也不再按"有用户原话"进每轮召回；只有用户 ab confirm 能再转正。用户确认过的条目不该写这个事件。
 */
export interface UnconfirmBody {
  reason: "worker_prompt";
  note?: string;
}

/** tag 事件：只改元数据标记，不改正文。scenes 整组替换，[] 清空；没给这个字段就不动。 */
export interface TagBody {
  guidance?: boolean;
  scenes?: Scene[];
}

/** relate 事件：ab work 关系判定第 2 层的结论（§9.4.4、§21 2026-10-13）。unsure 也写，表示判过、仍未定。 */
export interface RelateBody extends ModelProvenance {
  outcome: "duplicate" | "refines" | "conflicts" | "unrelated" | "unsure";
  target: string | null;
  reason: string;
  model: string;
}

export interface ExtraSource {
  host: Host | null;
  session_id: string | null;
  basis: Basis;
  /** 追加证据也完整保存原话；旧事件只有哈希，投影出不带 quote 的引用（§8.11.2）。 */
  evidence: EvidenceRef[];
}

export interface Proposition {
  id: string;
  seq: number;
  ts: string;
  project_id: string | null; // null = 全局
  session_id: string | null;
  kind: PropKind;
  text: string;
  why?: string;
  source: SourcePointer;
  for_workers: boolean;
  confirmed: boolean;
  state: PropState;
  supersedes?: string;
  superseded_by?: string;
  /** 指向本条、仍 active 但未确认的纠正。非空即未解决冲突，读路径必须标出（§9.2）。 */
  pending_corrections: string[];
  origin: Origin;
  basis?: Basis;
  trigger?: string;
  evidence: EvidenceRef[];
  unreconciled: boolean;
  /** 已确认时由谁确认；未确认为 null。 */
  confirmed_by: ConfirmedBy | null;
  /** 抽取判定为重复后追加的来源。 */
  extra_sources: ExtraSource[];
  model_outputs: ModelOutput[];
  /** 代码核验通过时的证据。 */
  code_evidence: { head: string; refs: CodeRef[] } | null;
  /** 代码与这条矛盾（未确认条目才会被核验）。 */
  stale: { head: string; refs: CodeRef[] } | null;
  expired: boolean;
  /** 预计有效天数；null = 用种类默认值。 */
  valid_days: number | null;
  said_at: string | null;
  /** 关系判定第 2 层的结论；没判过为 null。 */
  related: { outcome: RelateBody["outcome"]; target: string | null } | null;
  /** 判定为重复、已并入的条目。 */
  merged_into: string | null;
  /** 关系判定判为与之冲突的条目；只标记，从不替代对方。 */
  conflicts_with: string | null;
  import_ref: ImportRef | null;
  /** 详情正文；旧数据为 null（§8.11.2）。 */
  body: string | null;
  /** 否定掉的方案；旧数据为 []。 */
  alternatives: Alternative[];
  /** 指导 agent 干活方式的偏好（见 RememberBody.guidance、tag 事件）。 */
  guidance: boolean;
  /** 场景标签（§11.10）；旧数据缺字段为 []。 */
  scenes: Scene[];
  /** 话题沉淀（§8.6）写入的条目：所属运行 id（ab work --undo 用）。 */
  topic_run?: string;
  /** 被 unconfirm 撤销过自动转正的原因；用户再确认后清空。 */
  demoted: UnconfirmBody["reason"] | null;
  value: RememberBody["value"] | null;
}

export interface Projection {
  props: Map<string, Proposition>;
  /** 指向不存在/已清除目标的 meta-lifecycle 事件，fail-closed 跳过并计数（§14.2） */
  orphans: number;
  /** 被忽略的详情字段数：条目已有 body 或 alternatives 时 detail 不覆盖（§8.11.2，与 orphans 同类诊断）。 */
  detail_ignored: number;
  ephemeral: number;
  purged: number;
}

export interface EventRow {
  seq: number;
  id: string;
  ts: string;
  kind: EventKind;
  project_id: string | null;
  session_id: string | null;
  ephemeral: number;
  target_id: string | null;
  body: string | null;
}

/** 确定性投影：同一事件序列必然产生同一结果；不调用任何外部状态。 */
export function fold(rows: EventRow[]): Projection {
  const props = new Map<string, Proposition>();
  let orphans = 0;
  let detail_ignored = 0;
  let ephemeral = 0;
  let purged = 0;
  for (const r of rows) {
    if (r.kind === "purge") continue;
    if (r.body === null) {
      purged++;
      continue;
    }
    if (r.ephemeral) {
      ephemeral++;
      continue; // §9.5：记录但默认不投影
    }
    if (r.kind === "remember") {
      const b = JSON.parse(r.body) as RememberBody;
      props.set(r.id, {
        id: r.id,
        seq: r.seq,
        ts: r.ts,
        project_id: r.project_id,
        session_id: r.session_id,
        kind: b.kind,
        text: b.text,
        why: b.why,
        source: b.source,
        for_workers: b.for_workers === true,
        confirmed: b.confirmed !== false,
        state: "active",
        supersedes: b.supersedes,
        pending_corrections: [],
        origin: b.origin ?? "manual",
        basis: b.basis,
        trigger: b.trigger,
        evidence: b.evidence ?? [],
        unreconciled: b.unreconciled === true,
        confirmed_by: b.confirmed !== false ? "user" : null,
        extra_sources: [],
        model_outputs: b.origin === "extract" || b.origin === "curate" || b.topic || b.model !== undefined || b.prompt_version !== undefined
          ? [{ event_id: r.id, kind: "remember", model: b.model ?? b.topic?.model ?? null, prompt_version: b.prompt_version ?? b.topic?.prompt_version ?? null }]
          : [],
        code_evidence: null,
        stale: null,
        expired: false,
        valid_days: typeof b.valid_days === "number" ? b.valid_days : null,
        said_at: typeof b.said_at === "string" ? b.said_at : null,
        related: null,
        merged_into: null,
        conflicts_with: null,
        import_ref: b.import_ref ?? null,
        body: typeof b.body === "string" ? b.body : null,
        alternatives: Array.isArray(b.alternatives) ? b.alternatives : [],
        ...(typeof b.topic?.run === "string" ? { topic_run: b.topic.run } : {}),
        guidance: b.guidance === true,
        scenes: Array.isArray(b.scenes) ? b.scenes : [],
        demoted: null,
        value: b.value ?? null,
      });
      continue;
    }
    const target = r.target_id ? props.get(r.target_id) : undefined;
    if (!target) {
      orphans++; // unknown parent / purged target：fail-closed 跳过
      continue;
    }
    if (r.kind === "evidence" || r.kind === "relate" || r.kind === "verify") {
      const b = JSON.parse(r.body) as ModelProvenance;
      target.model_outputs.push({ event_id: r.id, kind: r.kind, model: b.model ?? null, prompt_version: b.prompt_version ?? null });
    }
    if (r.kind === "detail") {
      const b = JSON.parse(r.body) as DetailBody;
      // fail-closed：只补原来没有的字段，不覆盖已有内容
      if (typeof b.body === "string") {
        if (target.body === null) target.body = b.body;
        else detail_ignored++;
      }
      if (Array.isArray(b.alternatives) && b.alternatives.length) {
        if (!target.alternatives.length) target.alternatives = b.alternatives;
        else detail_ignored++;
      }
      continue;
    }
    if (r.kind === "confirm") {
      const b = JSON.parse(r.body) as ConfirmBody;
      if (!target.confirmed || (b.by ?? "user") === "user") target.confirmed_by = b.by ?? "user"; // 用户确认覆盖自动转正的来源
      target.confirmed = true;
      if ((b.by ?? "user") === "user") target.unreconciled = false; // §9.4.4：只有用户能解除
      if ((b.by ?? "user") === "user") target.demoted = null;
      if (target.demoted) {
        // 撤销过的条目不再自动转正（旧版本写下的事件按顺序重放时也一样）
        if (target.confirmed_by !== "user") {
          target.confirmed = false;
          target.confirmed_by = null;
        }
      }
      continue;
    }
    if (r.kind === "unconfirm") {
      const b = JSON.parse(r.body) as UnconfirmBody;
      if (target.confirmed_by === "user") continue; // 用户确认过的不动：只能进复核清单
      target.confirmed = false;
      target.confirmed_by = null;
      target.code_evidence = null;
      target.demoted = b.reason;
      continue;
    }
    // 旧版本的候选区事件（§8.8 前）：照常重放，不改状态
    if (r.kind === "stage" || r.kind === "curate") continue;
    if (r.kind === "tag") {
      const b = JSON.parse(r.body) as TagBody;
      if (typeof b.guidance === "boolean") target.guidance = b.guidance;
      // 按字段是否出现更新：没给 scenes 不动，给 [] 才清空
      if (Array.isArray(b.scenes)) target.scenes = b.scenes;
      continue;
    }
    if (r.kind === "evidence") {
      const b = JSON.parse(r.body) as EvidenceBody;
      target.extra_sources.push({
        host: b.source.host,
        session_id: b.source.session_id,
        basis: b.basis,
        evidence: b.evidence,
      });
      continue;
    }
    if (r.kind === "verify") {
      const b = JSON.parse(r.body) as VerifyBody;
      if (b.outcome === "verified") {
        target.stale = null;
        if (target.demoted) continue; // 撤销过的条目代码核验也不再转正
        target.code_evidence = { head: b.head, refs: b.refs };
        if (!target.confirmed) target.confirmed_by = "code";
        target.confirmed = true;
      } else {
        target.stale = { head: b.head, refs: b.refs };
      }
      continue;
    }
    if (r.kind === "relate") {
      const b = JSON.parse(r.body) as RelateBody;
      target.related = { outcome: b.outcome, target: b.target };
      // 第 2 层判出了确定关系才解除"关系未判定"；unsure 照旧，之后只有用户能解除
      if (b.outcome !== "unsure") target.unreconciled = false;
      // 冲突只标出来，不写 supersedes：本条日后被印证或代码核验转正也不会自动盖掉对方（§21 2026-10-13 修正）
      target.conflicts_with = b.outcome === "conflicts" ? b.target : null;
      continue;
    }
    target.state = r.kind === "archive" ? "archived" : "active";
    const ab = r.kind === "archive" ? (JSON.parse(r.body) as ArchiveBody) : null;
    target.expired = ab?.reason === "expired";
    target.merged_into = ab?.reason === "duplicate" ? (ab.into ?? null) : null;
  }
  for (const p of props.values()) {
    if (!p.conflicts_with || p.state !== "active") continue;
    const target = props.get(p.conflicts_with);
    if (target && target.state === "active" && !target.pending_corrections.includes(p.id)) target.pending_corrections.push(p.id);
  }
  // 未确认的纠正不改旧条目：agent 的推断不能盖掉已确认的结论。
  // 纠正只有用户确认才生效（§8.4"待确认的纠正不走自动转正"）；被印证或代码核验转正的纠正仍只是待确认。
  for (const p of props.values()) {
    if (!p.supersedes || p.state !== "active") continue;
    const target = props.get(p.supersedes);
    if (!p.confirmed || p.confirmed_by !== "user") {
      target?.pending_corrections.push(p.id);
      continue;
    }
    if (!target) {
      orphans++;
      continue;
    }
    target.state = "superseded";
    target.superseded_by = p.id;
  }
  return { props, orphans, detail_ignored, ephemeral, purged };
}

// ---------- 写入 L1 前的统一检查（§8.11.2：种类、长度、密钥只在入口查一次） ----------

function tooLong(what: string, n: number, max: number): never {
  throw new Error(`${what}太长：${n} 字，上限 ${max} 字`);
}

function scanSecret(what: string, text: string | undefined): void {
  if (text !== undefined && secretKinds(text).length) throw new Error(`${what}里含密钥，先删掉再记`);
}

/**
 * 校验否掉的方案（§8.11.2）：只有决定能带、最多 5 项、各字段 ≤200 字、不含密钥。
 * evidence 下标越界的项由 keepAlternatives 丢掉，不算错误。
 */
export function checkAlternatives(kind: PropKind, alternatives: Alternative[] | undefined): void {
  if (!alternatives?.length) return;
  if (kind !== "decision") throw new Error(`否掉的方案只能记在决定上，这是一条${KIND_LABEL[kind]}`);
  if (alternatives.length > ALTERNATIVES_MAX) throw new Error(`否掉的方案最多 ${ALTERNATIVES_MAX} 项，收到 ${alternatives.length} 项`);
  for (const a of alternatives) {
    if (!a.option?.trim() || !a.rejected_because?.trim()) throw new Error("否掉的方案要同时写方案和否掉的原因");
    if ([...a.option].length > ALTERNATIVE_FIELD_MAX_CHARS || [...a.rejected_because].length > ALTERNATIVE_FIELD_MAX_CHARS)
      throw new Error(`否掉的方案每项最多 ${ALTERNATIVE_FIELD_MAX_CHARS} 字`);
    scanSecret("否掉的方案", a.option);
    scanSecret("否掉的方案", a.rejected_because);
  }
}

/** 丢掉下标越界的方案（§8.11.2：引用的原话不存在就丢掉这一项，不丢整条）；没有剩下的返回 undefined。 */
export function keepAlternatives(alternatives: Alternative[] | undefined, evidenceCount: number): Alternative[] | undefined {
  const kept = alternatives?.filter((a) => a.evidence === undefined || (a.evidence >= 0 && a.evidence < evidenceCount));
  return kept?.length ? kept : undefined;
}

/**
 * 写入口的最后一个字段：检查完密钥和长度后把 body 换成脱敏结果（§8.11.2 统一脱敏边界）。
 * 检查在前：含密钥的正文整条拒掉（CLI 报错、导入丢字段、抽取丢字段并记 flag），不是偷偷打码。
 */
function sanitizeBody(body: string | undefined): string | undefined {
  return body === undefined ? undefined : sanitize(body).text;
}

/** 正文这一个字段的检查（种类、长度、密钥）与脱敏。导入重导时要单独判 body：不过就不写这个字段，其他字段照常导。 */
export function checkBodyField(kind: PropKind, body: string | undefined): string | undefined {
  if (body === undefined) return undefined;
  if (!BODY_KINDS.includes(kind)) throw new Error(`${KIND_LABEL[kind]}必须一行说清，不能带正文（正文只能给决定、事实、坑）`);
  if ([...body].length > BODY_MAX_CHARS) tooLong("正文", [...body].length, BODY_MAX_CHARS);
  scanSecret("正文", body);
  return sanitizeBody(body);
}

/** 写 remember 事件前的检查：种类、长度、密钥、脱敏。违反的抛错，调用方（CLI）报错退出；通过时就地换成脱敏后的字段。 */
export function checkRememberBody(b: RememberBody): void {
  const body = checkBodyField(b.kind, b.body);
  if (body !== undefined) b.body = body;
  checkAlternatives(b.kind, b.alternatives);
  scanSecret("正文", b.text);
  scanSecret("背景", b.why);
  for (const e of b.evidence ?? []) scanSecret("原话", e.quote);
  // evidence 下标越界的方案在这里丢掉（导入、抽取、手写都不再各自判断），通过的换成脱敏后的文字
  b.alternatives = keepAlternatives(b.alternatives, b.evidence?.length ?? 0)?.map((a) => ({
    ...a,
    option: sanitize(a.option).text,
    rejected_because: sanitize(a.rejected_because).text,
  }));
}

/** 写 detail 事件前的检查与脱敏。目标种类和原话条数由调用方从投影里取。 */
export function checkDetailBody(kind: PropKind, b: DetailBody, evidenceCount: number): void {
  const body = checkBodyField(kind, b.body);
  if (body !== undefined) b.body = body;
  checkAlternatives(kind, b.alternatives);
  b.alternatives = keepAlternatives(b.alternatives, evidenceCount)?.map((a) => ({
    ...a,
    option: sanitize(a.option).text,
    rejected_because: sanitize(a.rejected_because).text,
  }));
}
