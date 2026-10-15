/**
 * L2 合同（设计 §5.3、§9.1、§19.4）：L1 事件体、投影出的 Proposition，以及投影函数本身。
 * 这里是这些形状的唯一来源；未冻结的 facets、组合视图、projector version 见 §21 2026-10-10 切片 2 条目。
 */
export type PropKind = "rule" | "decision" | "pitfall" | "note";
export type EventKind = "remember" | "archive" | "reactivate" | "confirm" | "purge" | "evidence" | "verify" | "relate" | "unconfirm" | "tag" | "stage";
export type Host = "claude" | "codex" | "pi";
/** candidate：v3 候选区（ab work 自动抽取写这里），不进召回、brief、搜索，等审稿人裁决（§21 2026-10-14 v3）。 */
export type PropState = "active" | "archived" | "superseded" | "candidate";
/** 价值标准的标记（v3 第 1 阶段只打标记、不丢弃，交给审稿人）。 */
export type ValueFlag = "no_scenario" | "phase" | "findable" | "narrative";

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
export type Origin = "manual" | "extract" | "import";
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
  /** 写进候选区（v3）：投影成 state=candidate。 */
  candidate?: boolean;
  /** 抽取器给的价值字段与校验标记（v3 第 1 阶段只记录）。 */
  value?: { scenario?: string; durability?: "permanent" | "phase" | "exploration"; findable?: boolean; flags: ValueFlag[] };
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

/** archive 事件体。ab work 归档过期提议、或判定为重复后并入 into 时带 reason。用 reactivate 可撤销。 */
export interface ArchiveBody {
  reason?: "expired" | "duplicate" | "value-audit";
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

/**
 * stage 事件（v3）：把 agent 用 ab remember 直接写进正式库的条目移回候选区（stage），或撤销这一步（unstage）。
 * 用于补救候选区上线前后 agent 自记、未经审稿的条目。用户确认过的条目投影时忽略 stage；unstage 只对 stage 过的条目生效。
 */
export interface StageBody {
  action: "stage" | "unstage";
  reason?: "agent_remember";
  note?: string;
}

/** tag 事件：只改元数据标记，不改正文。 */
export interface TagBody {
  guidance?: boolean;
}

/** relate 事件：ab work 关系判定第 2 层的结论（§9.4.4、§21 2026-10-13）。unsure 也写，表示判过、仍未定。 */
export interface RelateBody {
  outcome: "duplicate" | "refines" | "conflicts" | "unrelated" | "unsure";
  target: string | null;
  reason: string;
  model: string;
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
  /** 指导 agent 干活方式的偏好（见 RememberBody.guidance、tag 事件）。 */
  guidance: boolean;
  /** 被 unconfirm 撤销过自动转正的原因；用户再确认后清空。 */
  demoted: UnconfirmBody["reason"] | null;
  /** 进过候选区（归档后再恢复也回到候选区，不会被恢复成正式条目）。 */
  candidate: boolean;
  /** 被 stage 事件从正式库移回候选区（unstage 只对它生效）。 */
  staged: boolean;
  value: RememberBody["value"] | null;
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
        state: b.candidate === true ? "candidate" : "active",
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
        valid_days: typeof b.valid_days === "number" ? b.valid_days : null,
        said_at: typeof b.said_at === "string" ? b.said_at : null,
        related: null,
        merged_into: null,
        conflicts_with: null,
        import_ref: b.import_ref ?? null,
        guidance: b.guidance === true,
        demoted: null,
        candidate: b.candidate === true,
        staged: false,
        value: b.value ?? null,
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
      if (!target.confirmed || (b.by ?? "user") === "user") target.confirmed_by = b.by ?? "user"; // 用户确认覆盖自动转正的来源
      target.confirmed = true;
      if ((b.by ?? "user") === "user") target.unreconciled = false; // §9.4.4：只有用户能解除
      if ((b.by ?? "user") === "user") target.demoted = null;
      // 用户亲自确认的候选直接进正式库（用户的话优先于审稿人）
      if ((b.by ?? "user") === "user" && target.candidate) {
        target.candidate = false;
        target.staged = false;
        if (target.state === "candidate") target.state = "active";
      }
      else if (target.demoted) {
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
    if (r.kind === "stage") {
      const b = JSON.parse(r.body) as StageBody;
      if (b.action === "stage") {
        // 用户确认过的不动；已在候选区或已归档/被替代的也不动
        if (target.confirmed_by === "user" || target.candidate || target.state !== "active") continue;
        target.candidate = true;
        target.staged = true;
        target.state = "candidate";
      } else if (b.action === "unstage" && target.staged) {
        target.candidate = false;
        target.staged = false;
        if (target.state === "candidate") target.state = "active";
      }
      continue;
    }
    if (r.kind === "tag") {
      const b = JSON.parse(r.body) as TagBody;
      if (typeof b.guidance === "boolean") target.guidance = b.guidance;
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
    target.state = r.kind === "archive" ? "archived" : target.candidate ? "candidate" : "active";
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
  return { props, orphans, ephemeral, purged };
}

/**
 * 未确认条目进每轮召回的门槛（D3，§21 2026-10-13）：规则或决定、依据是用户原话且带用户引文；
 * 关系未判定、与代码不符、有冲突或待确认纠正、本身是纠正的都不进。agent 推断的坑要等代码核验转正（那时已是已确认）。
 */
export function recallableUnconfirmed(p: Proposition): boolean {
  return (
    !p.confirmed &&
    (p.kind === "rule" || p.kind === "decision") &&
    (p.basis === "user_directive" || p.basis === "user_confirmed") &&
    p.evidence.some((e) => e.role === "user") &&
    !p.unreconciled &&
    !p.stale &&
    !p.conflicts_with &&
    !p.supersedes &&
    !p.pending_corrections.length &&
    !p.demoted
  );
}
