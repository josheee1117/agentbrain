/** ab status / ab doctor：自检报告。只拼文本；宿主检测、向量、模型配置由调用方给。 */
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import type { Embedder, Store } from "./store.ts";
import type { HostResult } from "./host.ts";
import type { ChatConfig } from "./llm.ts";
import { isRegistryHome, loadRegistry, registryDir, resolveProject } from "./registry.ts";
import * as intake from "./intake.ts";
import { reviewList, sourceClock } from "./expiry.ts";
import { opencodeDbPath, recentOpencodeSessions } from "./opencode.ts";
import { listBackups } from "./admin.ts";
import { agyDiscover, agyRoots } from "./agy.ts";
import { staleWarning } from "./visibility.ts";

export interface AgyRootStatus {
  label: string;
  logs: number;
  extractable: number;
  registered: number;
  source: "sweep" | "plugin";
  problem?: "no_summaries" | "missing_meta" | "unreadable" | "conflict";
}

function agyStatus(store: Store, ctx: StatusContext): { lines: string[]; todo: string[] } {
  const roots = agyRoots().filter((root) => {
    if (root.kind === "t3") return true;
    try { lstatSync(root.appData); } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    }
    return true;
  });
  // 诊断统计所有完整日志，不改变 sweep 的七天发现窗口。
  const discovered = agyDiscover(roots, ctx.now, () => true);
  const conflictIds = new Set(discovered.conflicts.map((c) => c.id));
  const sessions = intake.sessions(store.workDb).filter((s) => s.host === "agy" && !conflictIds.has(s.session_id));
  const todo = discovered.conflicts.map((c) => `agy 会话 ${c.id} 在多处有完整日志，已跳过：${c.roots.join("，")}`);
  const labels = new Map(roots.map((r) => [r.root, r.kind === "t3" ? `T3 ${r.instance!.slice(0, 8)}` : r.kind.toUpperCase()]));
  for (const p of discovered.problems) {
    if (p.kind === "no_summaries") continue;
    const detail = p.kind === "missing_meta" ? `${p.count ?? 0} 份日志缺元数据，无法确认工作目录`
      : [p.count ? `${p.count} 份完整日志无法读取` : "", p.summariesUnreadable ? "摘要库无法读取" : ""].filter(Boolean).join("，") || "应用目录无法读取";
    todo.push(`agy ${labels.get(p.root) ?? p.root}：${detail}`);
  }
  const statuses = roots.map((root): AgyRootStatus => {
    const label = labels.get(root.root)!;
    const conversations = discovered.conversations.filter((c) => c.root.root === root.root);
    let extractable = 0;
    let hasRecentExtractable = false;
    let deleted = 0;
    let cwdUnreadable = 0;
    let unregistered = 0;
    for (const c of conversations) {
      if (c.parent || !c.cwd) continue;
      let project: ReturnType<typeof resolveProject>;
      try { project = resolveProject(c.cwd); } catch (error) {
        const code = error instanceof Error && "code" in error ? error.code : null;
        if (code === "ENOENT" || code === "ENOTDIR") deleted++;
        else if (code === "EACCES" || code === "EPERM") cwdUnreadable++;
        else throw error;
        continue;
      }
      if (project) {
        extractable++;
        if (c.modifiedAt >= ctx.now.getTime() - 7 * 86_400_000) hasRecentExtractable = true;
      } else unregistered++;
    }
    if (deleted) todo.push(`agy ${label}：目录已删 ${deleted} 个主会话，不可抽取`);
    if (cwdUnreadable) todo.push(`agy ${label}：工作目录无法读取 ${cwdUnreadable} 个主会话，不可抽取`);
    if (unregistered) todo.push(`agy ${label}：未登记项目 ${unregistered} 个主会话，不可抽取`);
    const registered = sessions.filter((s) => s.transcript?.startsWith(root.brain + sep)).length;
    if (extractable && !registered) todo.push(`agy ${label}：可抽取主会话 ${extractable}，已登记 0：${hasRecentExtractable ? "检查巡检是否在跑" : "超过 7 天，巡检不会补登记"}`);
    const problems = discovered.problems.filter((p) => p.root === root.root);
    const problem = problems.find((p) => p.kind === "unreadable")?.kind
      ?? problems.find((p) => p.kind === "missing_meta")?.kind
      ?? (discovered.conflicts.some((c) => c.roots.includes(root.root)) ? "conflict" : problems[0]?.kind);
    const pluginHome = root.kind === "t3" ? root.root : join(ctx.userHome, ".gemini");
    return { label, logs: conversations.length, extractable, registered,
      source: existsSync(join(pluginHome, "config/plugins/agentbrain/hooks.json")) ? "plugin" : "sweep", problem };
  });
  const problems = { no_summaries: "尚无对话", missing_meta: "缺元数据", unreadable: "无法读取", conflict: "冲突" };
  return { todo, lines: statuses.map((s) => `agy ${s.label}: 日志 ${s.problem === "unreadable" && !s.logs ? "无法读取" : s.logs}（可抽 ${s.extractable}），已登记 ${s.registered}，${s.source === "plugin" ? "插件在位" : "只靠 sweep"}${s.problem ? `，${problems[s.problem]}` : !s.logs ? "，尚无对话" : ""}`) };
}

/** 最近一次备份超过这么久就列进"要处理"（自动备份每天一次，两天没有说明巡检没在跑）。 */
const BACKUP_STALE_MS = 48 * 3_600_000;
/** "失败窗口"一段最多列几个。 */
const STATUS_PROBLEM_ROWS = 5;
/** 孤立项目超过这么多个就折成一行。 */
const ORPHAN_FOLD = 3;

export interface CodeVersion {
  commit: string;
  branch: string | null;
  /** 没提交的文件数（只看 src、integrations、package.json）。 */
  dirty: number;
  root: string;
}

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
  /** 当前这份代码的提交与未提交改动（cli 给；拿不到为 null）。 */
  code?: CodeVersion | null;
}

function ago(from: Date, now: Date): string {
  const h = Math.max(0, Math.floor((now.getTime() - from.getTime()) / 3_600_000));
  return h < 1 ? "不到 1 小时前" : h < 48 ? `${h} 小时前` : `${Math.floor(h / 24)} 天前`;
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
    "后台抽取:",
    `  会话: 已登记 ${st.sessions.total}，未登记目录 ${st.sessions.unregistered}，ephemeral ${st.sessions.ephemeral}；补登记历史会话（装 hook 前）${st.sessions.backfill}；近 7 天疑似漏登记 ${st.sessions.scanned}${st.sessions.scanned ? `（${fmtCounts(st.sessions.scannedByHost)}；hook 装好后开始的会话仍只能靠扫描登记，该宿主 hook 可能没生效，Codex 要在 /hooks 里信任）` : ""}；会话级错误 ${fmtCounts(st.sessions.errors)}`,
    `  窗口: 完成 ${st.windows.done}，延后 ${st.windows.deferred}${lastRetry}，失败 ${st.windows.failed}；未完成原因 ${fmtCounts(st.windows.errors)}`,
    `  今日用量: 调用 ${st.budget.calls}，token ${st.budget.tokens}（只记录，不设上限）`,
    `  近 7 天: 候选 ${r.candidates}，提议 ${r.proposals}，附加来源 ${r.attached}，待确认纠正 ${r.corrections}，关系未判定 ${r.unreconciled}，跨会话印证 ${r.corroborated}，同窗口合并 ${r.merged}；丢弃整条候选 ${fmtCounts(r.dropped)}、单条证据 ${fmtCounts(r.evidence_dropped)}；剥掉注入/ab 输出 ${r.stripped}；脱敏命中 ${fmtCounts(r.sanitizer)}`,
    `  自动沉淀条目: 共 ${auto.length}，未确认 ${auto.filter((p) => !p.confirmed && p.state === "active").length}，代码核验转正 ${props.filter((p) => p.confirmed_by === "code").length}，跨会话印证转正 ${props.filter((p) => p.confirmed_by === "corroboration").length}，实盘采纳转正 ${props.filter((p) => p.confirmed_by === "adoption").length}，与代码不符 ${props.filter((p) => p.stale && p.state === "active").length}，到期归档 ${auto.filter((p) => p.expired).length}`,
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
    let here: ReturnType<typeof resolveProject>;
    try { here = resolveProject(cwd); } catch { here = null; }
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
    const agy = agyStatus(store, ctx);
    const { embedder, embedReason: reason } = ctx;
    const vectors = store.vectorStatus();
    const vectorLine = embedder
      ? `向量: ${embedder.model}，已向量化 ${vectors.model === embedder.model ? vectors.embedded : 0}/${vectors.total}`
      : `向量: 不可用（${reason}）`;

    // §12.6.7 T5：代码、库、备份、失败窗口四行，加开头的"要处理"清单
    const schema = store.schema;
    const code = ctx.code;
    const codeLine = code
      ? `代码: ${code.commit}${code.branch ? `（${code.branch}）` : ""}${code.dirty ? `，有 ${code.dirty} 个文件没提交` : "，没有未提交改动"}  ${code.root}`
      : "代码: 版本未知（不是 git 仓库，或没有 git）";
    const dbLine = `库: 版本 ${schema.version}（代码支持 ${schema.supported}）${schema.readOnly ? "，库比代码新，只读" : ""}；事件 ${store.eventCount()} 条；不认识的事件 ${proj.unknown} 条`;
    const backups = listBackups(ctx.storeHome);
    const last = backups[0];
    const backupLine = last
      ? `备份: 最近一次 ${last.at.toISOString()}（${ago(last.at, ctx.now)}），共 ${backups.length} 份  ${last.path}`
      : "备份: 还没有（ab backup 做一份；ab work --sweep 每天自动做一次）";
    const st = intake.stats(store.workDb, ctx.now);
    const recentFailed = statusLine(store, ctx.now).work_failed;
    const probs = intake.windowProblems(store.workDb, STATUS_PROBLEM_ROWS);
    const probLines = probs.length
      ? [
          `失败窗口: 失败 ${st.windows.failed}，延后 ${st.windows.deferred}；最近 ${probs.length} 个:`,
          ...probs.map((p) => `  ${p.at.slice(0, 16)} ${p.host}:${p.session_id.slice(0, 8)} ${p.state === "failed" ? "失败" : `延后（第 ${p.attempts} 次）`} ${p.code ?? "?"}${p.chars ? ` ${p.chars} 字` : ""}: ${p.detail ?? "原因没有记录（旧版本留下的）"}`),
        ]
      : ["失败窗口: 没有"];
    const conflicts = proj.conflict_pairs.length;
    const stale = all.filter(p => p.state === "active" && staleWarning(p)).length;
    const due = reviewList(all, store.usage(), ctx.now, sourceClock()).length;
    const todo = [
      ...agy.todo,
      schema.readOnly ? `库版本 ${schema.version} 比代码支持的 ${schema.supported} 新：这份代码只能读不能写，先更新 ab 的代码` : "",
      proj.unknown ? `库里有 ${proj.unknown} 条这份代码不认识的事件，它们没有生效：更新 ab 的代码` : "",
      "error" in ctx.chatConfig ? `抽取模型不可用（${ctx.chatConfig.error}）：后台不会从新会话里抽取记忆` : "",
      recentFailed ? `近 7 天有 ${recentFailed} 个窗口抽取失败，这些对话没有抽取：原因看下面"失败窗口"` : "",
      !last ? "还没有备份：ab backup" : ctx.now.getTime() - last.at.getTime() > BACKUP_STALE_MS ? `最近一次备份是 ${ago(last.at, ctx.now)}：ab backup（ab work --sweep 每天会自动做，没做说明巡检没在跑）` : "",
      code?.dirty ? `代码有 ${code.dirty} 个文件没提交：后台任务和钩子跑的就是这份没提交的代码` : "",
      conflicts ? `冲突 ${conflicts} 对未解决：ab get 看双方，ab archive 错的一条；ab inbox --kind conflict 看清单` : "",
      due ? `到期待复审 ${due} 条：ab review` : "",
      stale ? `与代码不符 ${stale} 条（待用户核实）：ab verify <id> 重核，ab confirm <id> 保留（ab inbox --kind stale 看清单）` : "",
      !embedder ? `向量不可用（${reason}）：搜索只剩全文检索` : "",
      st.sessions.scanned ? `近 7 天 ${st.sessions.scanned} 个会话钩子没登记、靠扫描补上：检查该宿主的钩子（${fmtCounts(st.sessions.scannedByHost)}）` : "",
    ].filter(Boolean);
    const orphanLines = orphans.length > ORPHAN_FOLD
      ? [`孤立项目 ${orphans.length} 个（库里有、清单里没有，改名或删除了？）: ${store.listProjects().filter((p) => !regNames.has(p.name)).map((p) => `${p.name} ${byScope.get(p.id) ?? 0} 条`).join("、")}`]
      : orphans;

    return (
      [
        todo.length ? `要处理（${todo.length} 项）:` : "要处理: 没有要处理的事",
        ...todo.map((t, i) => `  ${i + 1}. ${t}`),
        `目录: ${where}`,
        `宿主: ${!found.ok ? `宿主检测失败: ${found.error}` : found.detection ? `${found.detection.host}  会话 ${found.detection.session_id ?? "（未取得）"}  transcript ${found.detection.transcript ? "已找到" : "未找到"}` : "未检测到宿主"}`,
        codeLine,
        dbLine,
        backupLine,
        `active: ${scopeLines.join("、") || "无"}`,
        conflictLine(store, ctx.now),
        vectorLine,
        `投影: orphan 事件 ${proj.orphans}，已忽略的详情 ${proj.detail_ignored}，ephemeral 证据 ${proj.ephemeral}，已清除 ${proj.purged}`,
        `接线: ${wires.join("；")}`,
        `opencode: ${opencode}`,
        ...agy.lines,
        `清单: ${problems.length ? problems.join("；") : "全部可解析"}`,
        ...sedimentLines(store, ctx.chatConfig, ctx.now),
        ...probLines,
        ...orphanLines,
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
  // superseded 是清理进度已越过的旧积压行，不是这次抽取失败，不能点亮“抽取失败”警告
  const row = store.workDb.prepare(`SELECT COUNT(*) AS n FROM capture_windows WHERE state='failed' AND (error_code IS NULL OR error_code NOT IN ${intake.NOT_A_FAILURE}) AND updated_at >= ?`).get(since) as { n: number };
  return { review, work_failed: Number(row.n) };
}
