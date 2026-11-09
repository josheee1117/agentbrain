/** ab status / ab doctor：自检报告。只拼文本；宿主检测、向量、模型配置由调用方给。 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Embedder, Store } from "./store.ts";
import type { HostResult } from "./host.ts";
import type { ChatConfig } from "./llm.ts";
import { isRegistryHome, loadRegistry, registryDir, resolveProject } from "./registry.ts";
import * as intake from "./intake.ts";
import { reviewList, sourceClock } from "./expiry.ts";
import { opencodeDbPath, recentOpencodeSessions } from "./opencode.ts";

export interface StatusContext {
  cwd: string;
  /** 用户主目录（查 CLAUDE.md/AGENTS.md 接线）。 */
  userHome: string;
  /** agentbrain 数据目录（AB_HOME）。 */
  storeHome: string;
  host: HostResult;
  embedder: Embedder | null;
  embedReason: string | null;
  chatConfig: ChatConfig | { error: string };
  now: Date;
}

function namesOf(store: Store): Map<string, string> {
  return new Map(store.listProjects().map((p) => [p.id, p.name]));
}

export function fmtCounts(o: Record<string, number>): string {
  const parts = Object.entries(o).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`);
  return parts.length ? parts.join("、") : "无";
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function chatLine(cfg: StatusContext["chatConfig"]): string {
  if ("error" in cfg) return `不可用（${cfg.error}）`;
  const chain = [cfg, ...(cfg.fallbacks ?? [])].map((c) => `${c.model} @ ${hostOf(c.baseUrl)}`).join(" → ");
  return `${chain}（key: 钥匙串 ${cfg.keyService}）`;
}

function sedimentLines(store: Store, cfg: StatusContext["chatConfig"], now: Date): string[] {
  const st = intake.stats(store.workDb, now);
  const props = [...store.project().props.values()];
  const auto = props.filter((p) => p.origin === "extract");
  const r = st.receipts7d;
  const lastRetry = st.windows.nextRetry ? `，最早 ${new Date(st.windows.nextRetry).toLocaleString("zh-CN", { hour12: false })} 重试` : "";
  return [
    "沉淀（切片 3）:",
    `  会话: 已登记 ${st.sessions.total}，未登记目录 ${st.sessions.unregistered}，ephemeral ${st.sessions.ephemeral}；补登记历史会话（装 hook 前）${st.sessions.backfill}；近 7 天疑似漏登记 ${st.sessions.scanned}${st.sessions.scanned ? `（${fmtCounts(st.sessions.scannedByHost)}；hook 装好后开始的会话仍只能靠扫描登记，该宿主 hook 可能没生效，Codex 要在 /hooks 里信任）` : ""}；会话级错误 ${fmtCounts(st.sessions.errors)}`,
    `  窗口: 完成 ${st.windows.done}，延后 ${st.windows.deferred}${lastRetry}，失败 ${st.windows.failed}；未完成原因 ${fmtCounts(st.windows.errors)}`,
    `  今日用量: 调用 ${st.budget.calls}，token ${st.budget.tokens}（只记录，不设上限）`,
    `  近 7 天: 候选 ${r.candidates}，提议 ${r.proposals}，附加来源 ${r.attached}，待确认纠正 ${r.corrections}，关系未判定 ${r.unreconciled}，跨会话印证 ${r.corroborated}，同窗口合并 ${r.merged}；丢弃整条候选 ${fmtCounts(r.dropped)}、单条证据 ${fmtCounts(r.evidence_dropped)}；剥掉注入/ab 输出 ${r.stripped}；脱敏命中 ${fmtCounts(r.sanitizer)}`,
    `  自动沉淀条目: 共 ${auto.length}，未确认 ${auto.filter((p) => !p.confirmed && p.state === "active").length}，代码核验转正 ${props.filter((p) => p.confirmed_by === "code").length}，跨会话印证转正 ${props.filter((p) => p.confirmed_by === "corroboration").length}，与代码不符 ${props.filter((p) => p.stale && p.state === "active").length}，到期归档 ${auto.filter((p) => p.expired).length}`,
    `  到期待复审: ${reviewList(props, store.usage(), now, sourceClock()).length}（ab review 查看，ab view 里标"到期待复审"；不会自动归档）`,
    `  关系未判定积压（§9.4.4）: ${props.filter((p) => p.unreconciled && p.state === "active").length}`,
    `  抽取模型: ${chatLine(cfg)}；上次运行 ${st.lastRun ?? "从未"}，上次成功 ${st.lastSuccess ?? "从未"}；租约被接管 ${st.leaseTakeovers} 次`,
  ];
}

function conflictLine(store: Store, now: Date): string {
  const pairs = store.project().conflict_pairs;
  if (!pairs.length) return "冲突 0 对";
  const since = new Map<string, string>();
  let oldest = 0;
  for (const pair of pairs) {
    oldest = Math.max(oldest, Math.floor((now.getTime() - Date.parse(pair.ts)) / 86_400_000));
    for (const id of pair.ids) {
      if (!since.has(id) || pair.ts < since.get(id)!) since.set(id, pair.ts);
    }
  }
  // 一条记忆可能卷入多对冲突；同一行注入记录只计一次。
  const count = store.workDb.prepare("SELECT COUNT(*) AS n FROM inject_log WHERE prop_id=? AND ts>?");
  let injected = 0;
  for (const [id, ts] of since) injected += Number(count.get(id, ts)!.n);
  return `冲突 ${pairs.length} 对，最老 ${oldest} 天，挂着期间被注入 ${injected} 次；处理：ab get 看双方，ab archive 错的一条`;
}

function containsBrief(file: string): boolean {
  try {
    return readFileSync(file, "utf8").includes("ab brief");
  } catch {
    return false;
  }
}

export function statusReport(store: Store, ctx: StatusContext): string {
  const { cwd } = ctx;
  {
    const here = resolveProject(cwd);
    const where = isRegistryHome(cwd) ? "pm（清单所在仓库）" : here ? `项目 ${here.name}` : "未登记目录";
    const found = ctx.host;
    const proj = store.project();
    const all = [...proj.props.values()];
    const names = namesOf(store);
    const byScope = new Map<string, number>();
    for (const p of all) if (p.state === "active") byScope.set(p.project_id ?? "", (byScope.get(p.project_id ?? "") ?? 0) + 1);
    const scopeLines = [...byScope.entries()].map(([id, n]) => `${id === "" ? "全局" : (names.get(id) ?? id)} ${n}`);

    const reg = loadRegistry();
    const regNames = new Set(reg.map((e) => e.name));
    const orphans = store
      .listProjects()
      .filter((p) => !regNames.has(p.name))
      .map((p) => `孤立项目: ${p.name}（${byScope.get(p.id) ?? 0} 条记忆）——清单改名或删除了？`);
    const problems = reg.flatMap((e) => {
      if (!e.path) return [`${e.name}: 档案没有路径行`];
      return existsSync(e.path) ? [] : [`${e.name}: 路径不存在 ${e.path}`];
    });
    const userHome = ctx.userHome;
    const wires = [
      ["~/.claude/CLAUDE.md", join(userHome, ".claude/CLAUDE.md")],
      ["~/.codex/AGENTS.md", join(userHome, ".codex/AGENTS.md")],
      ["~/.pi/agent/AGENTS.md", join(userHome, ".pi/agent/AGENTS.md")],
      ["pm 仓库根 AGENTS.md", join(registryDir(), "..", "AGENTS.md")],
    ].map(([label, file]) => `${label}: ${containsBrief(file) ? "含 ab brief" : "没有 ab brief"}`);
    const plugin = join(userHome, ".config/opencode/plugins/agentbrain-v2.js");
    let opencode = "未安装插件";
    if (existsSync(plugin)) {
      try {
        recentOpencodeSessions(ctx.now.getTime() - 7 * 86_400_000);
        opencode = `正常（插件在位，SQLite 只读可访问，${opencodeDbPath()}）`;
      } catch {
        opencode = "插件在位，但 SQLite 不可读取";
      }
    }
    const { embedder, embedReason: reason } = ctx;
    const vectors = store.vectorStatus();
    const vectorLine = embedder
      ? `向量: ${embedder.model}，已向量化 ${vectors.model === embedder.model ? vectors.embedded : 0}/${vectors.total}`
      : `向量: 不可用（${reason}）`;

    return (
      [
        `目录: ${where}`,
        `宿主: ${!found.ok ? `宿主检测失败: ${found.error}` : found.detection ? `${found.detection.host}  会话 ${found.detection.session_id ?? "（未取得）"}  transcript ${found.detection.transcript ? "已找到" : "未找到"}` : "未检测到宿主"}`,
        `active: ${scopeLines.join("、") || "无"}`,
        conflictLine(store, ctx.now),
        vectorLine,
        `doctor: orphan 事件 ${proj.orphans}，已忽略的详情 ${proj.detail_ignored}，ephemeral 证据 ${proj.ephemeral}，已清除 ${proj.purged}`,
        `接线: ${wires.join("；")}`,
        `opencode: ${opencode}`,
        `清单: ${problems.length ? problems.join("；") : "全部可解析"}`,
        ...sedimentLines(store, ctx.chatConfig, ctx.now),
        ...(orphans.length ? [orphans.join("\n")] : []),
        `store: ${ctx.storeHome}`,
      ].join("\n")
    );
  }
}

/** 失败窗口只看近 7 天：老失败会被 30 天保留期清掉之前一直挂着，状态栏不该常亮警告。 */
export const STATUS_LINE_FAILED_DAYS = 7;

/** `ab status --line`：给宿主状态栏用的一行 JSON（§11.7）。只读、不连网、不调模型。 */
export function statusLine(store: Store, now: Date, clock = sourceClock()): { review: number; work_failed: number } {
  const props = store.project().props.values();
  const review = reviewList(props, store.usage(), now, clock).length;
  const since = new Date(now.getTime() - STATUS_LINE_FAILED_DAYS * 86_400_000).toISOString();
  const row = store.workDb.prepare("SELECT COUNT(*) AS n FROM capture_windows WHERE state='failed' AND updated_at >= ?").get(since) as { n: number };
  return { review, work_failed: Number(row.n) };
}
