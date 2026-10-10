/**
 * L2 合同（设计 §5.3、§9.1、§19.4）：L1 事件体、投影出的 Proposition，以及投影函数本身。
 * 这里是这些形状的唯一来源；未冻结的 facets、组合视图、projector version 见 §21 2026-10-10 切片 2 条目。
 */
export type PropKind = "rule" | "decision" | "pitfall" | "note";
export type EventKind = "remember" | "archive" | "reactivate" | "confirm" | "purge";
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
      });
      continue;
    }
    const target = r.target_id ? props.get(r.target_id) : undefined;
    if (!target) {
      orphans++; // unknown parent / purged target：fail-closed 跳过
      continue;
    }
    if (r.kind === "confirm") {
      target.confirmed = true;
      continue;
    }
    target.state = r.kind === "archive" ? "archived" : "active";
  }
  // 未确认的纠正不改旧条目：agent 的推断不能盖掉已确认的结论。
  for (const p of props.values()) {
    if (!p.confirmed || !p.supersedes || p.state !== "active") continue;
    const target = props.get(p.supersedes);
    if (!target) {
      orphans++;
      continue;
    }
    target.state = "superseded";
    target.superseded_by = p.id;
  }
  return { props, orphans, ephemeral, purged };
}
