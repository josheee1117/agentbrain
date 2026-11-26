/** brief / recall / CLI 共用的展示与查找小工具。 */
import type { Store } from "./store.ts";
import { KIND_LABEL, type PropKind, type Proposition, type Who } from "./l2.ts";

import { staleWarning } from "./visibility.ts";

export { KIND_LABEL };

export function stalePrefix(p: Pick<Proposition, "stale" | "confirmed" | "confirmed_by">): string {
  return staleWarning(p) ? `[与代码不符@${p.stale!.head.slice(0, 7)}，待用户核实] ` : "";
}

export function short(id: string): string {
  return id.slice(0, 8);
}

/** 确认来源的叫法（§12.6.7 T1/T2）：读路径都用这一份，agent 才分得清哪些是人确认过的。 */
export const TRUST_LABEL = { user: "用户确认", code: "代码核验", corroboration: "跨会话印证" } as const;

/** 已确认条目的来源标记；未确认的由调用方按原口径标（自动沉淀 / agent 自记）。 */
export function trustMark(p: Pick<Proposition, "confirmed" | "confirmed_by">): string {
  return p.confirmed ? `[${TRUST_LABEL[p.confirmed_by ?? "user"]}]` : "";
}

/** 谁、哪台机器；旧事件没有记。 */
export function whoLabel(w: Who): string {
  return w.actor ? `${w.actor}@${w.machine ?? "未知机器"}` : "操作者未记录（旧事件）";
}

/** ab get 的「写入」行：谁写的、哪台机器、从哪来（§12.6.7 T4）。 */
export function writtenLine(p: Proposition): string {
  const sid = p.session_id ? p.session_id.slice(0, 8) : null;
  const via =
    p.origin === "extract" ? `后台抽取，来自 ${p.source.host ?? "未知宿主"} 会话 ${sid ?? "?"}`
    : p.origin === "auto" ? "需求收口提炼"
    : p.origin === "import" ? "导入"
    : p.origin === "curate" ? "审稿改写"
    : sid ? `在 ${p.source.host ?? "agent"} 会话 ${sid} 里执行` : "不在 agent 会话里执行";
  return `写入: ${whoLabel(p.written_by)} · ${via} · ${p.ts.slice(0, 10)}`;
}

/** ab get 的「确认」行：确认来源、谁、何时、是否在 agent 会话里执行。 */
export function confirmedLine(p: Proposition): string {
  if (!p.confirmed) return `确认: 还没有人确认${p.demoted ? "（自动转正被撤销过，只有用户 ab confirm 能再转正）" : ""}`;
  const e = p.confirmed_event;
  const at = e ? e.ts.slice(0, 10) : "时间未记录";
  if (p.confirmed_by === "code") return `确认: ${TRUST_LABEL.code}转正 · ${at}（模型按仓库代码核对后转正，没有人确认过）`;
  if (p.confirmed_by === "corroboration") return `确认: ${TRUST_LABEL.corroboration}转正 · ${at}（两个以上会话里用户都这样说过）`;
  const where = e?.session_id ? `在 agent 会话 ${e.session_id.slice(0, 8)} 里执行` : "不在 agent 会话里执行";
  return `确认: ${TRUST_LABEL.user} · ${e ? whoLabel(e) : "操作者未记录（旧事件）"} · ${at} · ${where}`;
}

export function disputed(p: Proposition): string {
  const conflicts = p.conflicts.map((id) => `与 [${short(id)}] 冲突`);
  const corrections = p.pending_corrections.length ? [`有待确认的纠正 ${p.pending_corrections.map((id) => `[${short(id)}]`).join("")}`] : [];
  const marks = [...conflicts, ...corrections];
  return marks.length ? `（${marks.join("；")}）` : "";
}

export function active(store: Store): Proposition[] {
  return [...store.project().props.values()].filter((p) => p.state === "active");
}

/** "为什么"在搜索结果里最多显示多少字（§11.5 (ii)）。 */
export const SEARCH_WHY_MAX_CHARS = 200;
/** 搜索结果里带详情正文的条目显示前多少字（§8.11.4）。 */
export const SEARCH_BODY_MAX_CHARS = 300;

/**
 * 搜索结果显示全文（§11.5 (ii)，2026-10-16 用户批准）：正文全部打印（多行时后续行缩进），
 * 有"为什么"打一行（最多 200 字，超出加"…"），有场景（value.scenario 或 trigger）打一行。
 * 带详情正文的显示正文前 300 字，再提示用 ab get 看全文（§8.11.4）。来源和近邻仍用 ab get。
 */
export function searchDetail(text: string, p: Partial<Pick<Proposition, "id" | "why" | "body" | "trigger" | "value">> | undefined): string {
  const [first, ...rest] = text.split("\n");
  const out = [first, ...rest.map((l) => `  ${l}`)];
  const why = p?.why?.replace(/\s+/g, " ").trim();
  if (why) out.push(`  为什么: ${why.length > SEARCH_WHY_MAX_CHARS ? why.slice(0, SEARCH_WHY_MAX_CHARS) + "…" : why}`);
  const scene = (p?.value?.scenario ?? p?.trigger)?.replace(/\s+/g, " ").trim();
  if (scene) out.push(`  场景: ${scene}`);
  const body = p?.body?.trim();
  if (body && p?.id) {
    const chars = [...body];
    out.push(`  正文: ${chars.length > SEARCH_BODY_MAX_CHARS ? chars.slice(0, SEARCH_BODY_MAX_CHARS).join("") + "…" : body}`);
    out.push(`  ab get ${short(p.id)} 看全文`);
  }
  return out.join("\n");
}

/**
 * ab get 的原话块（§8.11.4）：主来源和追加来源的全部引文，带角色和时间，没时间写"时间未知"。
 * 追加来源的引文末尾标上它来自哪次会话。
 */
export function quoteLines(p: Proposition): string[] {
  const one = (e: Proposition["evidence"][number], from?: string) =>
    `  [${e.role} ${e.said_at ?? "时间未知"}] ${e.quote ?? "（旧数据只存了哈希，原文没留下）"}${from ? `（来源 ${from}）` : ""}`;
  const rows = p.evidence.map((e) => one(e));
  for (const s of p.extra_sources) {
    const from = `${s.host ?? "未知宿主"}:${(s.session_id ?? "?").slice(0, 8)}`;
    rows.push(...s.evidence.map((e) => one(e, from)));
  }
  return rows.length ? ["原话:", ...rows] : [];
}
