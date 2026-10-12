/**
 * L2 合同（设计 §5.3、§9.1、§19.4）：L1 事件体、投影出的 Proposition，以及投影函数本身。
 * 这里是这些形状的唯一来源；未冻结的 facets、组合视图、projector version 见 §21 2026-10-10 切片 2 条目。
 */
export type PropKind = "rule" | "decision" | "pitfall" | "note";
export type EventKind = "remember" | "archive" | "reactivate" | "confirm" | "purge" | "evidence" | "verify";
export type Host = "claude" | "codex" | "pi";
export type PropState = "active" | "archived" | "superseded";

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
export type Origin = "manual" | "extract";
/** 抽取器判定的与已有记忆的关系（§9.4.4）。 */
export type RelationType = "new" | "duplicate" | "refines" | "conflicts" | "supersedes" | "unsure";
/** 谁让这条转正：用户、代码核验、跨会话印证。旧数据缺字段按用户。 */
export type ConfirmedBy = "user" | "code" | "corroboration";

/** transcript 里的证据坐标。不存原文，只存引文的 sha256（§13.3）。 */
export interface EvidenceRef {
  anchor: string;
  role: "user" | "assistant" | "tool";
  quote_sha256: string;
}

/** 代码证据：仓库内相对路径 + 行号，或一个 commit。quote 是核对过的原文片段（已脱敏，≤200 字）。 */
export type CodeRef =
  | { path: string; line_start: number; line_end: number; quote: string }
  | { commit: string; quote: string };

export interface RememberBody {
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
  /** 邻居检查没做完整或模型拿不准（§9.4.4）。只有用户能解除（confirm 或 archive）。 */
  unreconciled?: boolean;
}

/** evidence 事件：给已有记忆追加一处来源（抽取判定为重复时）。 */
export interface EvidenceBody {
  source: SourcePointer;
  basis: Basis;
  evidence: EvidenceRef[];
  window_id: string;
}

/** verify 事件：ab work 按仓库真实代码核验一条未确认记忆的结果。只有带可核对代码证据的结论才写 L1。 */
export interface VerifyBody {
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

/** archive 事件体。ab work 归档过期提议时带 reason。 */
export interface ArchiveBody {
  reason?: "expired";
}

export interface ExtraSource {
  host: Host | null;
  session_id: string | null;
  basis: Basis;
  quote_sha256: string[];
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
  /** 代码核验通过时的证据。 */
  code_evidence: { head: string; refs: CodeRef[] } | null;
  /** 代码与这条矛盾（未确认条目才会被核验）。 */
  stale: { head: string; refs: CodeRef[] } | null;
  expired: boolean;
}

export interface Projection {
  props: Map<string, Proposition>;
  /** 指向不存在/已清除目标的 meta-lifecycle 事件，fail-closed 跳过并计数（§14.2） */
  orphans: number;
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
        code_evidence: null,
        stale: null,
        expired: false,
      });
      continue;
    }
    const target = r.target_id ? props.get(r.target_id) : undefined;
    if (!target) {
      orphans++; // unknown parent / purged target：fail-closed 跳过
      continue;
    }
    if (r.kind === "confirm") {
      const b = JSON.parse(r.body) as ConfirmBody;
      if (!target.confirmed) target.confirmed_by = b.by ?? "user";
      target.confirmed = true;
      if ((b.by ?? "user") === "user") target.unreconciled = false; // §9.4.4：只有用户能解除
      continue;
    }
    if (r.kind === "evidence") {
      const b = JSON.parse(r.body) as EvidenceBody;
      target.extra_sources.push({
        host: b.source.host,
        session_id: b.source.session_id,
        basis: b.basis,
        quote_sha256: b.evidence.map((e) => e.quote_sha256),
      });
      continue;
    }
    if (r.kind === "verify") {
      const b = JSON.parse(r.body) as VerifyBody;
      if (b.outcome === "verified") {
        target.code_evidence = { head: b.head, refs: b.refs };
        target.stale = null;
        if (!target.confirmed) target.confirmed_by = "code";
        target.confirmed = true;
      } else {
        target.stale = { head: b.head, refs: b.refs };
      }
      continue;
    }
    target.state = r.kind === "archive" ? "archived" : "active";
    target.expired = r.kind === "archive" && (JSON.parse(r.body) as ArchiveBody).reason === "expired";
  }
  // 未确认的纠正不改旧条目：agent 的推断不能盖掉已确认的结论。
  for (const p of props.values()) {
    if (!p.supersedes || p.state !== "active") continue;
    const target = props.get(p.supersedes);
    if (!p.confirmed) {
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
  return { props, orphans, ephemeral, purged };
}
