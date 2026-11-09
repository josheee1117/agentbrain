#!/usr/bin/env node
/**
 * agentbrain 命令行（设计 §7.1）：brief / remember / correct / recall / search / get / confirm / archive / tag / status(doctor) / capture / work。
 * 预算类数字是代码常量（§2.2），零配置键。
 */
import { parseArgs } from "node:util";
import { homedir } from "node:os";
import { chmodSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { Store, type Embedder } from "./store.ts";
import { type Alternative, type Host, type PropKind, type Proposition, type Scene, type SourcePointer, SCENES } from "./l2.ts";
import { embed, loadEmbedConfig, readKey } from "./embed.ts";
import { expandImport, expandSource, latestAnchor } from "./source.ts";
import { firstLine, LINK_LABEL, linkIndex, linkSummary, stateMark as linkState } from "./links.ts";
import { detectHost, locateTranscript } from "./host.ts";
import type { Detection } from "./host.ts";
import { isRegistryHome, loadRegistry, registryDir, resolveProject } from "./registry.ts";
import { chatClient, loadChatConfig } from "./llm.ts";
import { allowedTranscript } from "./transcript-file.ts";
import { BACKLOG_WINDOWS_PER_SWEEP, RELATE_BATCH, RELATE_SIM, RELATE_TOP, piSessionId, runWork, type WorkDeps } from "./work.ts";
import * as intake from "./intake.ts";
import { buildViewData, renderHtml } from "./view.ts";
import { applyNotes, type NoteAction } from "./notes.ts";
import { citeEnabled, setCite, logInjections, logQuery, modelOf, recordRecall, scanSession, sessionsToScan, withCiteInstruction, RECALL_REMINDER, type Ctx as TelemetryCtx } from "./telemetry.ts";
import { brief, BriefError } from "./brief.ts";
import { guidanceBlock, recall } from "./recall.ts";
import { MainSaid, userQuoteHashes, workerQuoteAudit } from "./audit.ts";
import { sha256 } from "./extract.ts";
import { sanitize } from "./sanitize.ts";
import { cleanTranscript, isWorkerTranscript } from "./transcript.ts";
import { opencodeId, opencodeSession } from "./opencode.ts";
import { applyActions, candidateInput, connectPanel, loadReport, planAll, runPanel, saveReport, undoRun, type RunReport } from "./curate.ts";
import { REVIEWER_ENV } from "./clireviewer.ts";
import { addTopicMark, listTopicRuns, newTopicRun, saveTopicReport, topicChatFor, topicEnabled, TOPIC_IDLE_MS, topicReportDir, undoTopicRun } from "./topic.ts";
import { configForHost, loadReviewConfig, QuotaExhausted, type CallStat } from "./review.ts";
import { runSetup, STEPS, type Step } from "./setup.ts";
import { reviewList, sourceClock } from "./expiry.ts";
import { fmtCounts, statusLine, statusReport } from "./status.ts";
import { disputed, KIND_LABEL, quoteLines, searchDetail, short } from "./present.ts";
import { displayPath, importPensieve, planImport, type PlanInput } from "./pensieve.ts";

const RECALL_EMBED_TIMEOUT_MS = 3000;
const GET_MAX_NEIGHBORS = 3;
/** ab search 前几条显示全文（§11.5 (ii)）。 */
const SEARCH_FULL_ROWS = 8;
/** ab search 一共取多少条：第 SEARCH_FULL_ROWS+1 名到这里每条一行（§11.6 (i)，代码常量，§2.2）。 */
const SEARCH_MAX_HITS = 16;
/** 第 9–16 名那一行正文最多显示的字数。 */
const SEARCH_BRIEF_CHARS = 60;
/** 前 8 条全文里带 body 的条目显示正文前多少字（§8.11.4）。 */
const SEARCH_BODY_CHARS = 300;
const KINDS: PropKind[] = ["rule", "decision", "pitfall", "note"];
const SCOPE_LABEL = (p: Proposition, names: Map<string, string>) =>
  p.project_id === null ? "全局" : (names.get(p.project_id) ?? "未知项目");

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function home(): string {
  return process.env.AB_HOME || join(homedir(), ".agentbrain");
}

function open(): Store {
  const root = home();
  return new Store(join(root, "store.db"), join(root, "index.db"));
}

function createEmbedder(timeoutMs?: number): { embedder: Embedder | null; reason: string | null } {
  try {
    const config = loadEmbedConfig(home());
    if ("error" in config) return { embedder: null, reason: config.error };
    const key = readKey();
    if (typeof key !== "string") return { embedder: null, reason: key.error };
    const embedder = Object.assign(
      (texts: string[]) => embed(texts, config, key, timeoutMs === undefined ? undefined : { timeoutMs }),
      { model: config.model },
    );
    return { embedder, reason: null };
  } catch (e) {
    return { embedder: null, reason: e instanceof Error ? e.message : String(e) };
  }
}

async function updateVectors(store: Store): Promise<string | null> {
  const { embedder, reason } = createEmbedder();
  if (!embedder) return reason;
  try {
    await store.syncVectors(embedder, embedder.model!);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** 归属没确认的条目（§8.11.3）：读路径都标出来，不能悄悄当成会话项目的事实。 */
function unresolvedMark(p: Proposition): string {
  return p.value?.flags?.includes("project_unresolved") ? "[归属未定]" : "";
}

/**
 * §8.11.3 归属说明：成功归到别的项目的，写清会话在哪、抽取判归哪个项目，人才能看出错归并纠正；
 * 归属没确认的写清原因。会话项目和归属项目相同时不显示。
 */
function ownershipLine(p: Proposition, names: Map<string, string>): string {
  const here = SCOPE_LABEL(p, names);
  if (p.value?.flags?.includes("project_unresolved")) return `归属: 会话在 ${here}，抽取没能确认归属（这条暂记在会话项目）`;
  const session = p.value?.session_project;
  return session && session !== here ? `归属: 会话在 ${session}，抽取判定归属 ${here}` : "";
}

/** 读路径标记：未确认、自动沉淀、归属未定、关系未判定（§9.4.4）、与代码不符。 */
function marks(p: Proposition): string {
  return [
    p.confirmed ? "" : p.origin === "extract" ? "[未确认·自动沉淀]" : "[未确认]",
    unresolvedMark(p),
    p.unreconciled ? "[关系未判定]" : "",
    p.stale ? "[与代码不符]" : "",
  ].join("");
}

const BASIS_LABEL: Record<string, string> = {
  user_directive: "用户原话",
  user_confirmed: "用户认可",
  observed_failure: "工具报错",
  agent_inference: "agent 推断",
};

function codeRef(r: import("./l2.ts").CodeRef): string {
  return "commit" in r ? `commit ${r.commit.slice(0, 10)}「${r.quote}」` : `${r.path}:${r.line_start}${r.line_end !== r.line_start ? `-${r.line_end}` : ""}「${r.quote}」`;
}

/** 前缀必须唯一命中一条，否则报错退出。 */
function findByPrefix(store: Store, prefix: string): Proposition {
  const hits = [...store.project().props.values()].filter((p) => p.id.startsWith(prefix));
  if (hits.length === 1) return hits[0];
  die(hits.length === 0 ? `找不到记忆: ${prefix}` : `前缀不唯一，匹配了 ${hits.length} 条: ${prefix}`);
}

function namesOf(store: Store): Map<string, string> {
  return new Map(store.listProjects().map((p) => [p.id, p.name]));
}

/**
 * `--body-file` 和可重复的 `--alternative "<方案>::<否掉的原因>"`（§8.11.5）。
 * 解析只在命令行边界：坏格式立即报错，字段校验留给 store 的写入口。
 */
function readDetailArgs(bodyFile: string | undefined, alternatives: string[]): { body?: string; alternatives?: Alternative[] } {
  const body = bodyFile === undefined ? undefined : readFileSync(bodyFile, "utf8").trim();
  const alts: Alternative[] = [];
  for (const raw of alternatives) {
    const k = raw.indexOf("::");
    const option = k < 0 ? "" : raw.slice(0, k).trim();
    const rejected = k < 0 ? "" : raw.slice(k + 2).trim();
    if (!option || !rejected) die(`--alternative 要写成 "<方案>::<否掉的原因>"，收到: ${raw}`);
    alts.push({ option, rejected_because: rejected });
  }
  return { ...(body ? { body } : {}), ...(alts.length ? { alternatives: alts } : {}) };
}

/** `--scene` 的值只在 CLI 边界解析校验（§11.10）；之后内部只用 Scene[]。 */
function parseScenes(raw: string, allowNone: boolean): Scene[] {
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (allowNone && parts.length === 1 && parts[0] === "none") return [];
  const bad = parts.filter((s) => !(SCENES as readonly string[]).includes(s));
  if (!parts.length || bad.length)
    die(`--scene 必须是 ${SCENES.join("|")} 的逗号组合${allowNone ? "，清空用 none" : ""}，收到: ${raw}`);
  return [...new Set(parts)] as Scene[];
}

// ---------- 子命令 ----------

// ---------- recall ----------

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (c: Buffer | string) => chunks.push(typeof c === "string" ? Buffer.from(c) : c));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

async function cmdRecall(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { hook: { type: "boolean", default: false } },
    strict: true,
    allowPositionals: true,
  });
  let query: string;
  let cwd: string;
  let worker = false;
  const t0 = performance.now();
  let hookRaw: Record<string, unknown> | null = null;
  if (values.hook) {
    if (process.env[REVIEWER_ENV]) return; // 审稿子进程不注入召回
    const raw = JSON.parse(await readStdin()) as { prompt?: unknown; cwd?: unknown; transcript_path?: unknown; want_count?: unknown; worker?: unknown };
    hookRaw = raw as Record<string, unknown>;
    if (typeof raw.prompt !== "string") return;
    query = raw.prompt;
    cwd = typeof raw.cwd === "string" && raw.cwd ? raw.cwd : process.cwd();
    worker = raw.worker === true || isWorkerTranscript(typeof raw.transcript_path === "string" ? raw.transcript_path : null);
  } else {
    query = positionals.join(" ");
    cwd = process.cwd();
    if (!query.trim()) return;
  }
  const store = open();
  const ctx = hookRaw ? telemetryCtx(store, hookRaw, cwd) : null;
  let cite = false;
  try {
    cite = citeEnabled(store.workDb);
  } catch {
    cite = false;
  }
  try {
    if (values.hook) {
      // 每轮钩子不再自动检索（§11.9.3）：斜杠命令开头的提问不注入
      if (query.trim().startsWith("/")) return;

      // 1. 常驻偏好（guidanceBlock，不变）
      const used: string[] = [];
      let prefs = "";
      try {
        prefs = guidanceBlock(store.project().props.values(), worker, new Set(), used);
      } catch {
        prefs = "";
      }

      // 2. 提醒块（带报告要求，若开关打开）
      let reminder = `<agentbrain-recall>\n${RECALL_REMINDER}\n</agentbrain-recall>\n`;
      if (cite) reminder = withCiteInstruction(reminder);

      const block = prefs + reminder;
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: block.trimEnd() },
      }) + "\n");

      if (ctx) telemetry(() => recordRecall(store.workDb, ctx, "nohit", [], performance.now() - t0, cite, new Date()));
      if (used.length) markUsed(store, used);
      return;
    }

    // 手动调用：ab recall <文本> 保留检索（评测 A 组用旧提交）
    const used: string[] = [];
    const stale: string[] = [];
    let recalled: string;
    try {
      recalled = await recall(store, query, cwd, () => createEmbedder(RECALL_EMBED_TIMEOUT_MS).embedder, used, stale, undefined, worker);
    } catch (e) {
      throw e;
    }
    let prefs = "";
    if (!query.trim().startsWith("/")) {
      try {
        prefs = guidanceBlock(store.project().props.values(), worker, new Set(used), used);
      } catch {
        prefs = "";
      }
    }
    const block = prefs + recalled;
    if (block) process.stdout.write(block);
    if (!block) return;
    markUsed(store, used);
    if (stale.length) {
      try {
        store.queueReverify(stale, new Date());
      } catch {
        // 库忙或只读时跳过
      }
    }
  } finally {
    store.close();
  }
}

function refreshCitations(store: Store, now: Date): { sessions: number; cited: number; dropped: number; unreadable: number } {
  const r = { sessions: 0, cited: 0, dropped: 0, unreadable: 0 };
  const props = store.project().props;
  const textOf = (id: string) => props.get(id)?.text ?? null;
  const preferences = [...props.values()]
    .filter((p) => p.state === "active" && p.confirmed && p.guidance && p.project_id === null && !p.scenes.length) // 和 guidanceBlock 同口径（§11.10）
    .map((p) => p.id);
  for (const s of (() => { try { return sessionsToScan(store.workDb); } catch { return []; } })()) {
    const file = s.transcript ?? locateTranscript(s.host, s.session_id);
    if (!file) {
      r.unreadable++;
      continue;
    }
    try {
      const turns = cleanTranscript(s.host, file).turns;
      const res = scanSession(store.workDb, s.host, s.session_id, turns, textOf, modelOf(s.host, file), now, preferences);
      r.sessions++;
      r.cited += res.cited;
      r.dropped += res.dropped;
    } catch {
      r.unreadable++;
    }
  }
  return r;
}

function detectCtx(store: Store, cwd: string): TelemetryCtx {
  let host: Host | null = null;
  let session_id: string | null = null;
  let transcript: string | null = null;
  try {
    const found = detectHost();
    if (found.ok && found.detection) {
      host = found.detection.host;
      session_id = found.detection.session_id;
      transcript = found.detection.transcript;
    }
  } catch {
    // 忽略检测失败，保持 null
  }
  return { host, session_id, transcript, project_id: projectIdOf(store, cwd) };
}

function telemetry(fn: () => void): void {
  try {
    fn();
  } catch {
    // 库忙、只读或表不存在时跳过
  }
}

/** 从 hook 输入认出宿主和会话：transcript_path 必须在该宿主会话目录下（allowedTranscript），否则看环境变量。 */
function telemetryCtx(store: Store, raw: Record<string, unknown>, cwd: string): TelemetryCtx {
  let host: Host | null = null;
  let session_id: string | null = null;
  let transcript: string | null = null;
  const given = typeof raw.transcript_path === "string" && raw.transcript_path ? raw.transcript_path : null;
  const sid = typeof raw.session_id === "string" && raw.session_id ? raw.session_id : null;
  if (given) {
    for (const h of HOSTS) {
      const ok = allowedTranscript(h, given);
      if (!ok) continue;
      host = h;
      transcript = ok;
      session_id = h === "opencode" ? opencodeId(given) : h === "pi" ? piSessionId(ok) : sid ?? codexOrClaudeId(ok);
      break;
    }
  }
  if (!host) {
    const found = detectHost();
    if (found.ok && found.detection) {
      host = found.detection.host;
      session_id = sid ?? found.detection.session_id;
    }
  }
  return { host, session_id, transcript, project_id: projectIdOf(store, cwd) };
}

function projectIdOf(store: Store, cwd: string): string | null {
  try {
    const here = resolveProject(cwd);
    return here ? (store.listProjects().find((p) => p.name === here.name)?.id ?? null) : null;
  } catch {
    return null;
  }
}

/** Claude 是 <uuid>.jsonl，Codex 是 rollout-…-<uuid>.jsonl（可能带 .zst）：取末尾 uuid。 */
function codexOrClaudeId(file: string): string | null {
  const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(?:\.zst)?$/i.exec(file);
  return m ? m[1] : null;
}

/** 记"最近被注入"（到期复审用）。只是统计：失败不影响 brief/recall 的输出。 */
function markUsed(store: Store, ids: string[]): void {
  try {
    store.markUsed(ids, new Date());
  } catch {
    // 库忙或只读时跳过
  }
}

function cmdBrief(argv: string[]): void {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { worker: { type: "boolean", default: false }, scene: { type: "string" } },
    strict: true,
    allowPositionals: true,
  });
  const scenes = values.scene === undefined ? [] : parseScenes(values.scene, false);
  const store = open();
  try {
    let out: string;
    const used: string[] = [];
    try {
      out = brief(store, process.cwd(), positionals[0], values.worker === true, used, scenes);
    } catch (e) {
      if (e instanceof BriefError) die(e.message);
      throw e;
    }
    process.stdout.write(out);
    markUsed(store, used);
    if (used.length) {
      telemetry(() => logInjections(store.workDb, detectCtx(store, process.cwd()), "brief", used, new Date()));
    }
  } finally {
    store.close();
  }
}

const HOSTS: Host[] = ["claude", "codex", "pi", "opencode"];

function parseSessionKey(raw: string, errorMessage: string): { host: Host; session_id: string } {
  const i = raw.indexOf(":");
  const host = raw.slice(0, i);
  const session_id = raw.slice(i + 1);
  if (i <= 0 || !HOSTS.includes(host as Host) || !session_id) die(`${errorMessage}，收到: ${raw}`);
  return { host: host as Host, session_id };
}

/** 当前主会话。检测失败或没有宿主时为 null。 */
function relayedBy(): { host: Host; session_id: string | null } | null {
  const found = detectHost();
  return found.ok && found.detection ? { host: found.detection.host, session_id: found.detection.session_id } : null;
}

/** 来源指向子代理。找不到它的 transcript 时 transcript 与 anchor 为 null，并提示。 */
function workerSource(raw: string, summary: string): { source: SourcePointer; missing: boolean } {
  const w = parseSessionKey(raw, "--from-worker 必须是 claude|codex|pi|opencode:<session_id>");
  const found = locateTranscript(w.host, w.session_id);
  const transcript = found ? (w.host === "opencode" ? found : realpathSync(found)) : null;
  const anchor = transcript ? latestAnchor(w.host, transcript) : null;
  return {
    source: { host: w.host, session_id: w.session_id, transcript, anchor, summary, relayed_by: relayedBy() },
    missing: transcript === null,
  };
}

async function cmdRemember(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      kind: { type: "string" },
      text: { type: "string" },
      summary: { type: "string" },
      why: { type: "string" },
      global: { type: "boolean", default: false },
      project: { type: "string" },
      "for-workers": { type: "boolean", default: false },
      confirmed: { type: "boolean", default: false },
      "from-worker": { type: "string" },
      scene: { type: "string" },
      "body-file": { type: "string" },
      alternative: { type: "string", multiple: true, default: [] },
    },
    strict: true,
  });
  const kind = values.kind as PropKind | undefined;
  if (!kind || !KINDS.includes(kind)) die(`--kind 必须是 ${KINDS.join("|")}`);
  const scenes = values.scene === undefined ? undefined : parseScenes(values.scene, false);
  if (scenes && kind !== "rule") die("--scene 只能用于规则（--kind rule）");
  if (!values.text) die("缺少 --text");
  if (!values.summary) die("缺少 --summary");
  if (values["for-workers"] && !values.global) die("--for-workers 只能和 --global 一起用");
  if (values.global && values.project) die("--global 与 --project 不能同时用");
  const detail = readDetailArgs(values["body-file"], values.alternative as string[]);

  const store = open();
  try {
    let projectId: string | null = null;
    if (!values.global) {
      if (values.project) {
        if (!loadRegistry().some((e) => e.name === values.project)) die(`清单里没有项目: ${values.project}`);
        projectId = store.ensureProject(values.project);
      } else {
        const here = resolveProject(process.cwd());
        if (!here) die("当前目录不是已登记项目。记全局记忆加 --global，或用 --project <名> 指定项目。");
        projectId = store.ensureProject(here.name);
      }
    }
    const found = detectHost();
    const det: Detection | null = found.ok ? found.detection : null;
    let transcript = det?.transcript ?? null;
    let anchor = det && transcript ? latestAnchor(det.host, transcript) : null;
    let source: SourcePointer = {
      host: det?.host ?? null,
      session_id: det?.session_id ?? null,
      transcript,
      anchor,
      summary: values.summary,
    };
    let missingWorker = false;
    if (values["from-worker"]) {
      const w = workerSource(values["from-worker"], values.summary);
      source = w.source;
      transcript = source.transcript;
      missingWorker = w.missing;
    }
    const confirmed = values.confirmed === true;
    let id: string;
    try {
      id = store.remember(projectId, source.session_id, false, {
        kind,
        text: values.text,
        why: values.why,
        ...detail,
        for_workers: values["for-workers"] || undefined,
        confirmed,
        scenes,
        source,
      });
    } catch (e) {
      die((e as Error).message);
    }
    let out = `已记住 [${short(id)}] ${KIND_LABEL[kind]}: ${values.text}`;
    if (missingWorker) out += "\n未找到子代理会话记录";
    else if (transcript === null) out += "\n未找到会话记录，这条记忆没有可展开的来源。";
    if (!confirmed) out += `\n未确认：不进 brief，用户认可后 ab confirm ${short(id)}`;
    const reason = await updateVectors(store);
    if (reason) out += `\n向量未更新：${reason}`;
    console.log(out);
  } finally {
    store.close();
  }
}

async function cmdSearch(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      kind: { type: "string" },
      archived: { type: "boolean", default: false },
      project: { type: "string" },
      all: { type: "boolean", default: false },
      scene: { type: "string" },
    },
    strict: true,
    allowPositionals: true,
  });
  const scenes = values.scene === undefined ? [] : parseScenes(values.scene, false);
  const query = positionals.join(" ");
  if (scenes.length && query) die("ab search --scene 只列出该场景的规则，不和关键词同用");
  if (!query && !scenes.length) die("用法: ab search <关键词…>");
  if (values.kind && !KINDS.includes(values.kind as PropKind)) die(`--kind 必须是 ${KINDS.join("|")}`);
  // 场景分支只列规则、只看有效条目（brief 的已确认门槛不变）
  if (scenes.length && values.kind && values.kind !== "rule") die("ab search --scene 只列规则，不能配 --kind 其他种类");
  if (scenes.length && values.archived) die("ab search --scene 不查归档条目，--archived 不能和 --scene 同用");
  if (values.project && values.all) die("--project 与 --all 不能同时用");

  const store = open();
  try {
    const inPm = isRegistryHome(process.cwd());
    const here = inPm ? null : resolveProject(process.cwd());
    const hereId = here ? store.ensureProject(here.name) : null;
    let projects: string[] | "all";
    let includeGlobal = true;
    if (values.all || (inPm && !values.project)) projects = "all";
    else if (values.project) {
      const hit = store.listProjects().find((p) => p.name === values.project);
      if (!hit) die(`没有名为 ${values.project} 的项目记忆`);
      projects = [hit.id];
    } else {
      projects = hereId ? [hereId] : [];
      if (!hereId) includeGlobal = true;
    }
    // §8.11.4：只在项目目录里搜、且没指定范围时带跨项目段；pm 目录本来就搜全库，--scene 列举不算搜索
    const crossProject = hereId && !values.project && !values.all ? { excludeProjectId: hereId } : undefined;
    const names = namesOf(store);
    const props = store.project().props;
    if (scenes.length) {
      // 场景内条目少，全列即可；不走混合检索（两条通道先截断再融合，事后过滤会漏，§11.10）。
      // 未确认的也列（带 [未确认] 标记）：场景内条目本来就少，用户要看得全。
      const inScope = (p: Proposition) =>
        projects === "all" || (p.project_id === null ? includeGlobal : projects.includes(p.project_id));
      const rows = [...props.values()]
        .filter((p) => p.state === "active" && p.kind === "rule" && p.scenes.some((s) => scenes.includes(s)) && inScope(p))
        .sort((a, b) => b.seq - a.seq);
      if (!rows.length) console.log("没有该场景的规则。");
      const links = linkIndex(props);
      for (const p of rows) {
        console.log(`[${short(p.id)}] ${SCOPE_LABEL(p, names)} ${KIND_LABEL[p.kind]}${marks(p)}${linkState(p)}${disputed(p)}: ${searchDetail(p.text, p)}`);
        const rel = linkSummary(links.get(p.id) ?? [], props, short);
        if (rel) console.log(`  关联: ${rel}`);
      }
      telemetry(() => {
        const ctx = detectCtx(store, process.cwd());
        const now = new Date();
        logQuery(store.workDb, ctx, "search", now);
        logInjections(store.workDb, ctx, "search", rows.map((p) => p.id), now);
      });
      return;
    }
    const { embedder, reason } = createEmbedder();
    const { hits, cross, degraded } = await store.searchHybrid(query, {
      projects,
      includeGlobal,
      kind: values.kind as PropKind | undefined,
      includeArchived: values.archived,
      limit: SEARCH_MAX_HITS,
      crossProject,
    }, embedder);
    if (!hits.length) {
      console.log("没有匹配的记忆。");
    }
    const links = linkIndex(props);
    hits.slice(0, SEARCH_FULL_ROWS).forEach((h) => {
      const p = props.get(h.id);
      const scope = p ? SCOPE_LABEL(p, names) : "未知";
      const mark = p ? marks(p) : "";
      // 正文用投影里的 p.text：命中里的 text 是索引文本（正文 + why），用它会把 why 打两遍
      console.log(`[${short(h.id)}] ${scope} ${KIND_LABEL[h.kind]}${mark}${p ? linkState(p) : ""}${p ? disputed(p) : ""}: ${searchDetail(p ? p.text : h.text, p)}`);
      const rel = p ? linkSummary(links.get(p.id) ?? [], props, short) : "";
      if (rel) console.log(`  关联: ${rel}`);
    });
    const more = hits.slice(SEARCH_FULL_ROWS);
    if (more.length) {
      console.log(`更多（第 ${SEARCH_FULL_ROWS + 1}–${SEARCH_FULL_ROWS + more.length} 名，看全文用 ab get）:`);
      for (const h of more) {
        const p = props.get(h.id);
        console.log(`  [${short(h.id)}] ${p ? SCOPE_LABEL(p, names) : "未知"} ${KIND_LABEL[h.kind]}${p ? marks(p) + linkState(p) : ""}: ${firstLine(p ? p.text : h.text, SEARCH_BRIEF_CHARS)}`);
      }
    }
    if (degraded) console.log(`（仅全文检索：${reason ?? degraded}${crossProject && !cross ? "；跨项目段也要算查询向量，这次没查" : ""}）`);
    let crossIds: string[] = [];
    if (cross && (cross.hits.length || cross.pending > 0)) {
      if (cross.hits.length) {
        console.log("其他项目里相近的：");
        for (const h of cross.hits) {
          const p = props.get(h.id);
          console.log(`[${short(h.id)}] ${names.get(h.project_id) ?? "未知项目"} ${KIND_LABEL[h.kind]}${p ? marks(p) : ""}: ${firstLine(p ? p.text : h.text, SEARCH_BRIEF_CHARS)}（${h.similarity.toFixed(2)}）`);
        }
      }
      if (cross.pending > 0) console.log(`另有 ${cross.pending} 条其他项目的记忆还没算向量，可能漏`);
      crossIds = cross.hits.map((h) => h.id);
    }
    telemetry(() => {
      const ctx = detectCtx(store, process.cwd());
      const now = new Date();
      logQuery(store.workDb, ctx, "search", now);
      logInjections(store.workDb, ctx, "search", [...hits.map((h) => h.id), ...crossIds], now);
    });
  } finally {
    store.close();
  }
}

function cmdGet(argv: string[]): void {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { expand: { type: "boolean", default: false } },
    strict: true,
    allowPositionals: true,
  });
  if (!positionals[0]) die("用法: ab get <id 前缀>");
  const store = open();
  try {
    const p = findByPrefix(store, positionals[0]);
    telemetry(() => {
      const ctx = detectCtx(store, process.cwd());
      const now = new Date();
      logQuery(store.workDb, ctx, "get", now);
      logInjections(store.workDb, ctx, "get", [p.id], now);
    });
    const names = namesOf(store);
    const stateMark = p.state === "archived" ? "（已归档）" : p.state === "superseded" ? "（已被替代）" : "";
    // §8.11.4 顺序：text、why、alternatives（每项附它引用的原话）、body、全部原话，然后才是关联和近邻
    const altLines = p.alternatives.length
      ? ["否掉的方案:", ...p.alternatives.map((a) => {
        const q = a.evidence === undefined ? "" : p.evidence[a.evidence]?.quote;
        return `  ${a.option}：${a.rejected_because}${q ? `（「${q}」）` : ""}`;
      })]
      : [];
    const quotes = quoteLines(p);
    const linesOut = [
      `[${short(p.id)}] ${SCOPE_LABEL(p, names)} ${KIND_LABEL[p.kind]}${stateMark}${p.confirmed ? "" : p.origin === "extract" ? " 未确认（自动沉淀）" : " 未确认（agent 自记）"}${unresolvedMark(p)}${p.unreconciled ? " 关系未判定" : ""}: ${p.text}`,
      p.confirmed && p.confirmed_by === "code" ? "已由代码核验转正" : "",
      p.confirmed && p.confirmed_by === "corroboration" ? "已由跨会话印证转正（两个以上会话里用户都这样说过）" : "",
      p.expired ? `到期未确认，已归档（撤销用 ab archive --reactivate ${short(p.id)}）` : "",
      p.trigger ? `触发: ${p.trigger}` : "",
      p.import_ref ? `导入自 Pensieve ${p.import_ref.id}: ${p.import_ref.path}${p.import_ref.also?.length ? `（另有 ${p.import_ref.also.length} 处相同副本）` : ""}` : "",
      p.why ? `为什么: ${p.why}` : "",
      ...altLines,
      p.body ? `正文:\n${p.body}` : "",
      p.value?.flags?.includes("body_dropped") ? "正文未入库（抽取时被校验拦下）" : "",
      ...quotes,
      ownershipLine(p, names),
      p.basis ? `依据: ${BASIS_LABEL[p.basis] ?? p.basis}，引文 ${p.evidence.length} 处（${p.evidence.map((e) => `${e.role}@${e.anchor.slice(0, 12)}`).join("、")}）` : "",
      p.extra_sources.length ? `另有 ${p.extra_sources.length} 处来源（${p.extra_sources.map((x) => `${x.host ?? "?"}:${(x.session_id ?? "?").slice(0, 8)} ${BASIS_LABEL[x.basis] ?? x.basis}`).join("、")}）` : "",
      p.code_evidence ? `代码证据（HEAD ${p.code_evidence.head.slice(0, 10)}）: ${p.code_evidence.refs.map(codeRef).join("；")}` : "",
      p.stale ? `与代码不符（HEAD ${p.stale.head.slice(0, 10)}）: ${p.stale.refs.map(codeRef).join("；")}` : "",
      // 并入、替代的对方在下面"关联"里列；冲突和待确认纠正在这里带操作提示。
      p.merged_into ? `已判定为重复并归档（撤销用 ab archive --reactivate ${short(p.id)}）` : "",
      ...p.conflicts.map((id) => {
        const c = store.project().props.get(id)!;
        return `与 [${short(id)}] 冲突（关系判定）: ${c.text}（两条不能同时成立；作废哪条就 ab archive 哪条）`;
      }),
      ...p.pending_corrections.map((id) => {
        const c = store.project().props.get(id)!;
        return `待确认的纠正 [${short(id)}]: ${c.text}（认可用 ab confirm ${short(id)}，否决用 ab archive ${short(id)}）`;
      }),
      `来源: ${p.source.summary}（${p.source.host ?? "未知宿主"}）${p.source.transcript ? "" : "（无 transcript）"}${p.source.relayed_by ? `（经 ${p.source.relayed_by.host} 主会话转记）` : ""}  记录于 ${p.ts.slice(0, 10)}`,
    ].filter(Boolean);
    if (p.model_outputs.length) {
      const labels = { remember: "抽取", evidence: "追加证据", relate: "关系判定", verify: "代码核验" };
      linesOut.push("模型产出记录:", ...p.model_outputs.map((o) =>
        `  [${short(o.event_id)}] ${labels[o.kind]}: ${o.model ?? "未记录"}，提示词版本 ${o.prompt_version ?? "未记录"}`));
    }
    // 双向关联（§11.6 (ii)）：每个一行，带对方状态和正文第一行；上面已列出的冲突和待确认纠正不重复。
    const all = store.project().props;
    const rel = (linkIndex(all).get(p.id) ?? []).filter((l) => !p.pending_corrections.includes(l.id) && !(l.type === "conflicts" && p.conflicts.includes(l.id)));
    if (rel.length) {
      linesOut.push("关联:", ...rel.map((l) => {
        const n = all.get(l.id)!;
        return `  ${LINK_LABEL[l.type]} [${short(n.id)}]${linkState(n)} ${SCOPE_LABEL(n, names)} ${KIND_LABEL[n.kind]}${marks(n)}: ${firstLine(n.text, SEARCH_BRIEF_CHARS)}`;
      }));
    }
    const shown = new Set<string | undefined>([p.supersedes, p.superseded_by, ...p.conflicts, ...p.pending_corrections, ...rel.map((l) => l.id)]);
    const near = store.neighbors(p.id);
    if (near === null) linesOut.push("相关: 近邻不可用，这条还没有向量");
    else {
      const rows = near.filter((n) => !shown.has(n.prop.id)).slice(0, GET_MAX_NEIGHBORS).map(({ prop: n, similarity }) =>
        `  [${short(n.id)}] ${SCOPE_LABEL(n, names)} ${KIND_LABEL[n.kind]}${marks(n)}: ${n.text.split("\n")[0]}（${similarity.toFixed(2)}）`);
      if (rows.length) linesOut.push("相关（向量近邻）:", ...rows);
    }
    if (values.expand) {
      const disc = expandSource(p.source);
      if (disc || !p.import_ref) {
        // §8.11.4：原对话不在了，先列库里存的原话，再说原对话不可用
        if (!disc && quotes.length) linesOut.push("", `--- 原对话已不可用：transcript 不存在或定位点失效（${p.source.transcript ? "定位点失效" : "没有 transcript"}），下面是库里存的原话 ---`, ...quotes);
        else linesOut.push("", "--- 当时的讨论 ---", disc ? disc : "来源不可用：transcript 不存在或定位点失效。");
      } else {
        // Pensieve 导入条没有 transcript：打开导入时记下的原 md 文件（§11.6 (iii)）
        const r = expandImport(p.import_ref);
        linesOut.push("", "--- Pensieve 原文件 ---");
        if (r.ok) linesOut.push(`${displayPath(r.path, homedir())}${r.changed ? "（导入后改过：内容哈希与导入时不同，下面是现在的内容）" : ""}`, r.text, ...(r.truncated ? ["（已截断，完整内容看原文件）"] : []));
        else linesOut.push(`原文件不可用：${r.reason}`);
      }
    }
    console.log(linesOut.join("\n"));
  } finally {
    store.close();
  }
}

async function cmdCorrect(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      text: { type: "string" },
      summary: { type: "string" },
      why: { type: "string" },
      confirmed: { type: "boolean", default: false },
      "from-worker": { type: "string" },
      "body-file": { type: "string" },
      alternative: { type: "string", multiple: true, default: [] },
    },
    strict: true,
    allowPositionals: true,
  });
  if (!positionals[0]) die("用法: ab correct <id 前缀> --text <新内容> --summary <当时在讨论什么>");
  if (!values.text) die("缺少 --text");
  if (!values.summary) die("缺少 --summary");
  // 详情是结论内容：标题改了不能照搬，不继承旧条目的 body 和 alternatives（§8.11.5）
  const detail = readDetailArgs(values["body-file"], values.alternative as string[]);
  const store = open();
  try {
    const old = findByPrefix(store, positionals[0]);
    if (old.state !== "active") die(`只能纠正仍有效的记忆，这条是 ${old.state}: ${short(old.id)}`);
    let source: SourcePointer;
    let missingWorker = false;
    if (values["from-worker"]) {
      const w = workerSource(values["from-worker"], values.summary);
      source = w.source;
      missingWorker = w.missing;
    } else {
      const found = detectHost();
      const det: Detection | null = found.ok ? found.detection : null;
      const transcript = det?.transcript ?? null;
      source = {
        host: det?.host ?? null,
        session_id: det?.session_id ?? null,
        transcript,
        anchor: det && transcript ? latestAnchor(det.host, transcript) : null,
        summary: values.summary,
      };
    }
    const id = store.remember(old.project_id, source.session_id, false, {
      kind: old.kind,
      text: values.text,
      why: values.why,
      ...detail,
      for_workers: old.for_workers || undefined,
      confirmed: values.confirmed === true,
      supersedes: old.id,
      scenes: old.scenes.length ? old.scenes : undefined,
      source,
    });
    let out = `已纠正 [${short(id)}] 替代 [${short(old.id)}]: ${values.text}`;
    if (missingWorker) out += "\n未找到子代理会话记录";
    else if (source.transcript === null) out += "\n未找到会话记录，这条记忆没有可展开的来源。";
    if (!values.confirmed) out += `\n未确认：不进 brief，也不替代旧条目，用户认可后 ab confirm ${short(id)}`;
    const reason = await updateVectors(store);
    if (reason) out += `\n向量未更新：${reason}`;
    console.log(out);
  } finally {
    store.close();
  }
}

function cmdConfirm(argv: string[]): void {
  const { positionals } = parseArgs({ args: argv, strict: true, allowPositionals: true });
  if (!positionals[0]) die("用法: ab confirm <id 前缀>");
  const store = open();
  try {
    const p = findByPrefix(store, positionals[0]);
    if (p.confirmed) {
      console.log(`已是确认状态 [${short(p.id)}] ${p.text}`);
      return;
    }
    const found = detectHost();
    store.lifecycle("confirm", p.id, found.ok ? (found.detection?.session_id ?? null) : null);
    console.log(`已确认 [${short(p.id)}] ${p.text}`);
  } finally {
    store.close();
  }
}

function cmdArchive(argv: string[]): void {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { reactivate: { type: "boolean", default: false } },
    strict: true,
    allowPositionals: true,
  });
  if (!positionals[0]) die("用法: ab archive <id 前缀>");
  const store = open();
  try {
    const p = findByPrefix(store, positionals[0]);
    const found = detectHost();
    store.lifecycle(values.reactivate ? "reactivate" : "archive", p.id, found.ok ? (found.detection?.session_id ?? null) : null);
    console.log(`${values.reactivate ? "已恢复" : "已归档"} [${short(p.id)}] ${p.text}`);
  } finally {
    store.close();
  }
}

/** ab tag：改元数据标记，不改正文。目前只有场景标签（§11.10）。 */
function cmdTag(argv: string[]): void {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { scene: { type: "string" } },
    strict: true,
    allowPositionals: true,
  });
  if (!positionals[0] || values.scene === undefined) die("用法: ab tag <id 前缀> --scene <design,code,review|none>");
  const scenes = parseScenes(values.scene, true);
  const store = open();
  try {
    const p = findByPrefix(store, positionals[0]);
    if (p.kind !== "rule") die(`--scene 只能用于规则，这条是 ${KIND_LABEL[p.kind]}: ${short(p.id)}`);
    if (scenes.length && p.guidance)
      die(`[${short(p.id)}] 是干活偏好（guidance），不能带场景；先 ab guidance ${short(p.id)} --off`);
    store.lifecycle("tag", p.id, null, { scenes });
    console.log(
      scenes.length ? `已设场景 [${short(p.id)}] ${scenes.join(",")}: ${p.text}` : `已清空场景 [${short(p.id)}]: ${p.text}`,
    );
  } finally {
    store.close();
  }
}

function cmdGuidance(argv: string[]): void {
  const { values, positionals } = parseArgs({ args: argv, options: { off: { type: "boolean", default: false } }, strict: true, allowPositionals: true });
  if (!positionals[0]) die("用法: ab guidance <id 前缀> [--off]");
  const store = open();
  try {
    const p = findByPrefix(store, positionals[0]);
    const on = !values.off;
    if (on && p.scenes.length)
      die(`[${short(p.id)}] 带场景标签（${p.scenes.join(",")}），不能同时标成干活偏好；先 ab tag ${short(p.id)} --scene none`);
    if (p.guidance === on) return console.log(`未变 [${short(p.id)}] ${p.text}`);
    store.lifecycle("tag", p.id, null, { guidance: on });
    const note = on && !(p.project_id === null && p.confirmed && p.confirmed_by === "user") ? "（只有用户确认过的全局条目才会每轮常驻）" : "";
    console.log(`${on ? "已标为干活偏好" : "已取消干活偏好"} [${short(p.id)}] ${p.text}${note}`);
  } finally {
    store.close();
  }
}

function cmdAudit(argv: string[]): void {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { apply: { type: "boolean", default: false } },
    strict: true,
    allowPositionals: true,
  });
  if (positionals[0] !== "worker-quotes") die("用法: ab audit worker-quotes [--apply]");
  const store = open();
  try {
    const saidInMain = mainSessionQuotes(store);
    const plan = workerQuoteAudit(store.project().props.values(), sessionTranscript(store), isWorkerTranscript, saidInMain);
    const names = namesOf(store);
    const line = (p: Proposition) => `  [${short(p.id)}] ${SCOPE_LABEL(p, names)} ${KIND_LABEL[p.kind]}${p.confirmed ? `（已确认:${p.confirmed_by}）` : "（未确认）"}: ${p.text.split("\n")[0]}`;
    console.log(`只靠 worker 派活提示当"用户原话"的条目：撤销 ${plan.demote.length} 条，需用户复核 ${plan.review.length} 条（用户确认过的不自动改）。`);
    for (const p of plan.demote) console.log(line(p));
    if (plan.review.length) console.log("需用户复核（用户亲自确认过，不自动改；不要了用 ab archive）：");
    for (const p of plan.review) console.log(line(p));
    if (!values.apply) return console.log(plan.demote.length ? "预览，未写入。加 --apply 撤销上面这些条目的自动转正。" : "");
    for (const p of plan.demote) store.lifecycle("unconfirm", p.id, null, { reason: "worker_prompt", note: "证据是父 agent 写给 worker 的派活提示，不是用户原话" });
    console.log(`已撤销 ${plan.demote.length} 条。用户认可后可 ab confirm <id> 重新确认。`);
  } finally {
    store.close();
  }
}


/**
 * 用户主会话里说过的话（所有登记会话里非 worker 会话的 user 轮），以及每个 worker 会话的 user 轮（派活提示）。
 * 返回判定函数：一条记忆的用户原话哈希能在它的 worker 派活提示里找到对应片段、且这段原文主会话里也逐字出现过 → true。
 * 只在审计时读 transcript；读不了的会话跳过。
 */
function mainSessionQuotes(store: Store): (p: Proposition) => boolean {
  let built: { main: MainSaid; worker: Map<string, string[]> } | null = null;
  const build = () => {
    const main = new MainSaid();
    const worker = new Map<string, string[]>();
    const rows = store.workDb.prepare("SELECT host,session_id,transcript FROM capture_sessions WHERE transcript IS NOT NULL").all() as { host: Host; session_id: string; transcript: string }[];
    for (const r of rows) {
      let cleaned;
      try {
        cleaned = cleanTranscript(r.host, r.transcript);
      } catch {
        continue;
      }
      if (cleaned.subagent) continue;
      const users = cleaned.turns.filter((t) => t.role === "user").map((t) => sanitize(t.text).text);
      if (cleaned.worker || isWorkerTranscript(r.transcript)) worker.set(`${r.host}:${r.session_id}`, users);
      else for (const u of users) main.add(u);
    }
    // 用户自己维护的全局指令文件也是用户的话：派活提示照抄其中的规则时不算 worker-only
    for (const f of [join(homedir(), ".codex/AGENTS.md"), join(homedir(), ".claude/CLAUDE.md"), join(homedir(), ".pi/agent/AGENTS.md")]) {
      try {
        main.add(sanitize(readFileSync(f, "utf8")).text);
      } catch {
        // 没有这个文件
      }
    }
    return { main, worker };
  };
  return (p) => {
    built ??= build();
    const texts = [p.source, ...p.extra_sources].flatMap((s) => built!.worker.get(`${s.host}:${s.session_id}`) ?? []);
    return built.main.quotedIn(texts, userQuoteHashes(p), sha256);
  };
}

/** capture_sessions 里登记的 transcript 路径。 */
function sessionTranscript(store: Store): (host: Host | null, sessionId: string | null) => string | null {
  const q = store.workDb.prepare("SELECT transcript FROM capture_sessions WHERE host=? AND session_id=?");
  return (host, sid) => {
    if (!host || !sid) return null;
    const row = q.get(host, sid) as { transcript?: string | null } | undefined;
    return row?.transcript ?? null;
  };
}

function cmdReview(argv: string[]): void {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { archive: { type: "boolean", default: false }, all: { type: "boolean", default: false }, limit: { type: "string", default: "20" } },
    strict: true,
    allowPositionals: true,
  });
  const store = open();
  try {
    const names = namesOf(store);
    const due = reviewList(store.project().props.values(), store.usage(), new Date(), sourceClock());
    if (!values.archive) {
      if (!due.length) return console.log("没有到期待复审的条目。");
      console.log(`到期待复审 ${due.length} 条（未确认、过了预计有效期、期间没被注入过；已确认的不会出现在这里）：`);
      const limit = Math.max(1, Number.parseInt(values.limit ?? "20", 10) || 20);
      for (const d of due.slice(0, limit))
        console.log(`  [${short(d.prop.id)}] ${SCOPE_LABEL(d.prop, names)} ${KIND_LABEL[d.prop.kind]}${marks(d.prop)}: ${d.prop.text.split("\n")[0]}（有效 ${d.validDays} 天，超期 ${d.overdueDays} 天，${d.lastUsed ? `最近注入 ${d.lastUsed.slice(0, 10)}` : "从未被注入"}）`);
      if (due.length > limit) console.log(`  …还有 ${due.length - limit} 条（按超期天数排序），用 --limit ${due.length} 看全部，或处理完这批再看。`);
      console.log("确认有用：ab confirm <id>；不要了：ab review --archive <id…> 或 --all（归档可用 ab archive --reactivate 撤销）。");
      return;
    }
    if (!values.all && !positionals.length) die("用法: ab review --archive <id 前缀…> | ab review --archive --all");
    const picked = values.all ? due.map((d) => d.prop) : positionals.map((x) => findByPrefix(store, x));
    const dueIds = new Set(due.map((d) => d.prop.id));
    const notDue = picked.filter((p) => !dueIds.has(p.id));
    if (notDue.length) die(`这些不在到期复审清单里（已确认、未到期或已不是 active），不归档: ${notDue.map((p) => short(p.id)).join(" ")}`);
    const found = detectHost();
    const session = found.ok ? (found.detection?.session_id ?? null) : null;
    for (const p of picked) {
      store.lifecycle("archive", p.id, session, { reason: "expired" });
      console.log(`已归档（到期） [${short(p.id)}] ${p.text.split("\n")[0]}`);
    }
    if (picked.length) console.log("撤销：ab archive --reactivate <id>");
  } finally {
    store.close();
  }
}

function cmdView(argv: string[]): void {
  const { values } = parseArgs({
    args: argv,
    options: { out: { type: "string" }, "no-open": { type: "boolean", default: false } },
    strict: true,
  });
  const out = values.out ?? join(home(), "view.html");
  const store = open();
  let data;
  let scan = { sessions: 0, cited: 0, dropped: 0, unreadable: 0 };
  try {
    scan = refreshCitations(store, new Date());
    data = buildViewData(store, new Date());
  } finally {
    store.close();
  }
  writeFileSync(out, renderHtml(data), { mode: 0o600 });
  chmodSync(out, 0o600);
  console.log(`已生成 ${out}：共 ${data.counts.total} 条（有效 ${data.counts.active}），有向量 ${data.counts.vectors} 条`);
  console.log(`引用扫描：${scan.sessions} 个会话，记到 ${scan.cited} 次引用，丢弃 ${scan.dropped} 个对不上注入记录的 id${scan.unreadable ? `，${scan.unreadable} 个会话读不到对话` : ""}`);
  if (!values["no-open"]) {
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
    spawn(opener, [out], { stdio: "ignore", detached: true }).on("error", () => console.log(`没能自动打开，请手动打开 ${out}`)).unref();
  }
}

// ---------- capture / work（切片 3） ----------

/** SessionEnd 后拉起分离的 ab work，只处理这一个会话。宿主等不到它，它自己有租约。 */
function spawnWork(key: string): void {
  const child = spawn(process.execPath, [...process.execArgv, process.argv[1], "work", "--session", key], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
}

/**
 * hook 热路径：只登记坐标（不读 transcript），任何错误都吞掉、不写 stdout/stderr，宿主这一轮照常进行。
 * stdin 是宿主给的 JSON：session_id、transcript_path、cwd、hook_event_name；Pi 扩展额外可给 ephemeral。
 */
async function captureHook(host: Host): Promise<void> {
  if (process.env[REVIEWER_ENV]) return; // 审稿子进程的会话不登记、不抽取
  const raw = JSON.parse(await readStdin()) as Record<string, unknown>;
  const given = typeof raw.transcript_path === "string" && raw.transcript_path ? raw.transcript_path : null;
  let ephemeral = raw.ephemeral === true;
  let sessionId = typeof raw.session_id === "string" && raw.session_id ? raw.session_id : null;
  if (!sessionId && host === "pi" && given) sessionId = piSessionId(given);
  if (!sessionId) return;
  let transcript: string | null = null;
  if (given) {
    transcript = allowedTranscript(host, given, sessionId);
    if (!transcript) return; // 不在宿主会话目录里的路径一律不登记
  } else if (!ephemeral) {
    const found = locateTranscript(host, sessionId);
    transcript = found ? allowedTranscript(host, found, sessionId) : null;
  }
  let cwd = typeof raw.cwd === "string" && raw.cwd ? raw.cwd : null;
  if (host === "opencode") {
    const session = transcript ? opencodeSession(transcript) : null;
    if (!session) return;
    cwd = session.directory;
    ephemeral = !!session.parent_id;
  }
  const event = raw.hook_event_name;
  const ended = event === "SessionEnd";
  // 话题结束触发（§8.6）只在开关打开时生效；关着时压缩事件什么都不做，下一轮也不判断静置
  const topic = topicEnabled(home());
  const compact = event === "PreCompact";
  if (compact && !topic) return;
  const now = new Date();
  const store = open();
  let project: string | null = null;
  let idle = false;
  try {
    const before = intake.sessions(store.workDb, { host, session_id: sessionId })[0];
    // 候选 B：下一轮进来时距上次登记已超过 20 分钟，上一个话题多半结束了，拉起 ab work 去看（真正的边界由 transcript 里的时间差决定）
    if (topic && !ended && !compact && before && now.getTime() - Date.parse(before.last_touch) >= TOPIC_IDLE_MS) idle = true;
    intake.upsertSession(store.workDb, { host, session_id: sessionId, transcript, cwd, ended, ephemeral, via: "hook" }, () => {
      project = cwd ? (resolveProject(cwd)?.name ?? null) : null;
      return project;
    }, now);
    if (compact && !ephemeral) addTopicMark(store.workDb, host, sessionId, now);
    if (ended || compact || idle) {
      const row = intake.sessions(store.workDb, { host, session_id: sessionId })[0];
      project = row?.project ?? null;
    }
  } finally {
    store.close();
  }
  if ((ended || compact || idle) && project && !ephemeral) spawnWork(`${host}:${sessionId}`);
}

async function cmdCapture(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      hook: { type: "boolean", default: false },
      host: { type: "string" },
      transcript: { type: "string" },
      cwd: { type: "string" },
      end: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: true,
  });
  if (values.hook) {
    if (!values.host || !HOSTS.includes(values.host as Host)) return;
    try {
      await captureHook(values.host as Host);
    } catch {
      // 登记失败不能让宿主这一轮失败；ab work --sweep 的扫描会补上
    }
    return;
  }
  if (!positionals[0]) die("用法: ab capture <claude|codex|pi|opencode>:<session_id> [--transcript <路径>] [--cwd <目录>] [--end]");
  const key = parseSessionKey(positionals[0], "会话必须写成 claude|codex|pi|opencode:<session_id>");
  const found = values.transcript ?? locateTranscript(key.host, key.session_id);
  if (!found) die("找不到这个会话的 transcript，用 --transcript 指定");
  const transcript = allowedTranscript(key.host, found, key.session_id);
  if (!transcript) die(`transcript 必须在 ${key.host} 的会话目录下: ${found}`);
  const session = key.host === "opencode" ? opencodeSession(transcript) : null;
  const cwd = session?.directory ?? values.cwd ?? process.cwd();
  const store = open();
  try {
    const project = resolveProject(cwd)?.name ?? null;
    const r = intake.upsertSession(store.workDb, { ...key, transcript, cwd, ended: values.end === true, ephemeral: !!session?.parent_id, via: "manual" }, () => project, new Date());
    console.log(`${r === "new" ? "已登记" : "已刷新"} ${key.host}:${key.session_id}${project ? `（项目 ${project}）` : "（cwd 不是已登记项目，不会抽取）"}`);
  } finally {
    store.close();
  }
}

function workDeps(store: Store): WorkDeps {
  const cfg = loadChatConfig(home());
  let chat: WorkDeps["chat"];
  if ("error" in cfg) chat = { error: "no_config", message: cfg.error };
  else {
    const key = readKey(cfg.keyService);
    chat = typeof key === "string" ? { chat: chatClient(cfg, key, undefined), model: cfg.model } : { error: "no_key", message: key.error };
  }
  return {
    store,
    now: () => new Date(),
    chat,
    embedder: createEmbedder().embedder,
    registry: loadRegistry(),
    registryDir: registryDir(),
    resolveProject: (cwd) => resolveProject(cwd),
    projectId: (name) => store.ensureProject(name),
    debugDir: process.env.AB_DEBUG === "1" ? join(home(), "debug") : undefined,
    // 话题结束时一步式沉淀（§8.6）：extract.json "topic": true 才开（默认关）
    ...(topicEnabled(home()) ? { topic: { run: newTopicRun(new Date()), chatFor: topicChatFor(home()), save: (r) => void saveTopicReport(home(), r) } } : {}),
  };
}

async function cmdWork(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      session: { type: "string" },
      sweep: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      redo: { type: "boolean", default: false },
      undo: { type: "string" },
      runs: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (values.redo && !values.session) die("--redo 必须和 --session 一起用");
  if (values.runs) {
    const runs = listTopicRuns(home());
    console.log(runs.length ? runs.join("\n") : `没有话题沉淀运行记录（${topicReportDir(home())}）。`);
    return;
  }
  if (values.undo) {
    const store = open();
    // 拿工作租约：后台 ab work 还在跑（可能正往这次运行里写）时不撤，免得撤一半、后面又写进来
    const holder = intake.acquireLease(store.workDb, new Date());
    if (!holder) {
      store.close();
      die("后台 ab work 正在跑，等它跑完再撤（ab status 看进度）。");
    }
    try {
      const r = undoTopicRun(store, values.undo.replace(/\.json$/, ""));
      console.log(`已归档 ${r.archived.length} 条（可 ab archive --reactivate <id> 逐条恢复）${r.archived.length ? "：" + r.archived.map(short).join("、") : ""}`);
      for (const k of r.kept) console.log(`  未动 [${short(k.id)}]：${k.why}`);
      if (!r.archived.length && !r.kept.length) console.log(`L1 里没有 ${values.undo} 写的条目。`);
    } finally {
      intake.releaseLease(store.workDb, holder!);
      store.close();
    }
    return;
  }
  const store = open();
  try {
    const r = await runWork(workDeps(store), {
      session: values.session ? parseSessionKey(values.session, "会话必须写成 claude|codex|pi|opencode:<session_id>") : undefined,
      sweep: values.sweep === true,
      dryRun: values["dry-run"] === true,
      redo: values.redo === true,
    });
    if (r.busy) {
      console.log("另一个 ab work 正在运行，本次跳过。");
      return;
    }
    if (values["dry-run"]) {
      console.log(r.dry.length ? r.dry.map((d) => `${d.session}: 待处理窗口 ${d.windows}，${d.chars} 字`).join("\n") : "没有待处理的会话。");
      return;
    }
    const x = r.receipt;
    if (values.sweep && !values["dry-run"]) {
      try {
        refreshCitations(store, new Date());
      } catch {
        // 扫描失败不影响整体汇报
      }
    }
    console.log(
      [
        `${new Date().toISOString()} ab work${values.sweep ? " --sweep" : ""}`,
        `窗口: 完成 ${r.windows.done}，延后 ${r.windows.deferred}，失败 ${r.windows.failed}，跳过 ${r.windows.skipped}${r.scanned ? `；扫描补登记 ${r.scanned}` : ""}${r.backlogLeft ? `；补登记会话留到下次 ${r.backlogLeft}（每次 sweep 最多 ${BACKLOG_WINDOWS_PER_SWEEP} 个窗口）` : ""}`,
        `产出: 候选 ${x.candidates}，提议 ${x.proposals}，附加来源 ${x.attached}，待确认纠正 ${x.corrections}，关系未判定 ${x.unreconciled}，跨会话印证转正 ${x.corroborated}，同窗口合并 ${x.merged}`,
        `丢弃: 整条候选 ${fmtCounts(x.dropped)}；单条证据 ${fmtCounts(x.evidence_dropped)}`,
        Object.values(r.relate).some(Boolean) ? `关系判定: 重复并入 ${r.relate.duplicate}，补充 ${r.relate.refines}，冲突 ${r.relate.conflicts}，无关 ${r.relate.unrelated}，拿不准 ${r.relate.unsure}，并入后跨会话印证转正 ${r.relate.corroborated}，出错 ${r.relate.errors}` : "",
        values.sweep ? `代码核验: 转正 ${r.verify.verified}，与代码不符 ${r.verify.contradicted}，代码无法核验 ${r.verify.not_verifiable}，证据不足 ${r.verify.inconclusive}，出错 ${r.verify.errors}` : "",
        r.topic && r.topic.windows.length
          ? `话题沉淀: 运行 ${r.topic.run}，话题窗口 ${r.topic.windows.length}，写入正式库 ${r.topic.windows.reduce((n, w) => n + w.created.length, 0)} 条（未确认），并入建议 ${r.topic.windows.reduce((n, w) => n + w.merges.length, 0)} 条（只进报告）；报告 ${join(topicReportDir(home()), `${r.topic.run}.json`)}；整次撤销 ab work --undo ${r.topic.run}`
          : "",
      ].filter(Boolean).join("\n"),
    );
  } finally {
    store.close();
  }

}

async function cmdImport(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      global: { type: "string", multiple: true, default: [] },
      "skip-file": { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: true,
  });
  if (positionals[0] !== "pensieve") die("用法: ab import pensieve <仓库目录>... [--global <目录>]... [--skip-file <文件>] [--dry-run]");
  const dirs = positionals.slice(1);
  const globals = (values.global as string[]).map((d) => realpathSync(d));
  if (!dirs.length && !globals.length) die("至少给一个含 .pensieve 的目录");
  const skip = new Map<string, string>();
  if (values["skip-file"]) {
    for (const line of readFileSync(values["skip-file"], "utf8").split(/\r?\n/)) {
      const m = /^\s*([^\s#]+)\s*(.*)$/.exec(line);
      if (m) skip.set(m[1], m[2].trim() || "整理时判为不导入");
    }
  }
  const inputs: PlanInput[] = globals.map((root) => ({ root, project: null }));
  const unresolved: string[] = [];
  for (const d of dirs) {
    const root = realpathSync(d);
    const here = resolveProject(root);
    if (!here) unresolved.push(root);
    else inputs.push({ root, project: here.name });
  }
  const plan = planImport(inputs, skip);
  for (const u of unresolved) plan.skipped.push({ path: u, id: "*", reason: "目录不属于已登记项目（要记全局请用 --global）" });
  const h = homedir();
  if (values["dry-run"]) {
    for (const it of plan.items) {
      console.log(`[${it.project ?? "全局"}] ${it.doc.type}→${it.kind} ${it.doc.id}\n  正文: ${it.text}\n  背景: ${it.why ?? "（无）"}\n  详情正文: ${it.body ? `${[...it.body].length} 字` : "（无）"}\n  出处: ${displayPath(it.doc.path, h)}${it.also.length ? `（另有 ${it.also.length} 处相同副本）` : ""}`);
    }
    for (const s of plan.skipped) console.log(`跳过 ${s.id} ${displayPath(s.path, h)}：${s.reason}`);
    console.log(`共 ${plan.items.length} 条待导入，跳过 ${plan.skipped.length} 条（试运行，未写入）`);
    return;
  }
  const store = open();
  try {
    const deps = workDeps(store);
    const r = await importPensieve(
      {
        store,
        projectId: (name) => store.ensureProject(name),
        embedder: deps.embedder,
        chat: "error" in deps.chat ? null : deps.chat,
        relateSim: RELATE_SIM,
        relateTop: RELATE_TOP,
        relateBatch: RELATE_BATCH,
      },
      plan,
    );
    const reason = await updateVectors(store);
    const x = r.relate;
    console.log(
      [
        `导入 Pensieve: 新增 ${r.created.length}，内容变更改为纠正 ${r.corrected.length}，未变 ${r.unchanged}，此前已归档不再导 ${r.archivedSkip}，补上正文 ${r.detailed.length}，跳过 ${r.skipped.length}`,
        `关系判定: 已有条目并入导入条 ${x.mergedExisting}，导入条并入已确认条目 ${x.mergedIntoExisting}，补充 ${x.refines}，冲突 ${x.conflicts.length}${x.conflicts.length ? `（${x.conflicts.join("、")}）` : ""}，无关 ${x.unrelated}，拿不准 ${x.unsure}，出错 ${x.errors}`,
        ...x.errorDetails.map((d) => `  出错原因: ${d}`),
        x.errors ? "  出错的条目下次运行同一命令会补判（未变的导入条只要还没判过关系就会重判）" : "",
        ...(r.detailSkipped.length
          ? [
              `正文没写进库的文档 ${r.detailSkipped.length} 篇（这些仓库的 .pensieve 不能删）：`,
              ...r.detailSkipped.map((d) => `  ${d.id} ${displayPath(d.path, h)}：${d.reason}`),
            ]
          : []),
        reason ? `向量未更新：${reason}` : "",
      ].filter(Boolean).join("\n"),
    );
  } finally {
    store.close();
  }
}

function cmdStatus(argv: string[] = []): void {
  const { values } = parseArgs({ args: argv, options: { line: { type: "boolean", default: false } }, strict: true });
  const store = open();
  try {
    if (values.line) {
      process.stdout.write(JSON.stringify(statusLine(store, new Date())) + "\n");
      return;
    }
    const { embedder, reason } = createEmbedder();
    console.log(statusReport(store, {
      cwd: process.cwd(),
      userHome: homedir(),
      storeHome: home(),
      host: detectHost(),
      embedder,
      embedReason: reason,
      chatConfig: loadChatConfig(home()),
      now: new Date(),
    }));
  } finally {
    store.close();
  }
}

const USAGE = `用法:
  ab brief [项目名] [--worker] [--scene design,code,review]
                                    开工先跑：全局规则 + 当前项目的坑与规则；--worker 给被派活的子代理
                                    --scene 另加载该场景的规则（设计/开发/review，可逗号多选）；不给只多一行索引
  ab remember --kind <rule|decision|pitfall|note> --text <内容> --summary <当时在讨论什么>
              [--why <理由>] [--global | --project <项目名>] [--for-workers] [--confirmed]
              [--body-file <文件>] [--alternative "<方案>::<否掉的原因>"]…
              [--from-worker <claude|codex|pi|opencode>:<session_id>] [--scene design,code,review]
                                    干活时不用记：后台会从会话里自动抽取。只有用户明确要你记时才用，并加 --confirmed
                                    --kind note 即事实
                                    不加 --confirmed 的照常生效、标未确认（能搜到，没争议的坑/规则/决定也进每轮召回）
                                    默认记到当前目录所属项目；--global 记全局；--for-workers 让子代理也看到这条全局规则
                                    --body-file 给决定/事实/坑补详情正文（≤40000 字，规则不能带）
                                    --alternative 记讨论时否掉的方案，只用于决定，最多 5 项
                                    --from-worker 把来源指回子代理会话，当前主会话记在转记人上
                                    --scene 只用于规则：按场景打标签，brief 按场景加载
  ab correct <id 前缀> --text <新内容> --summary <当时在讨论什么>
              [--why <理由>] [--confirmed] [--body-file <文件>] [--alternative "<方案>::<原因>"]…
              [--from-worker <claude|codex|pi|opencode>:<session_id>]
                                    追加一条替代旧记忆的纠正；未确认前不盖掉旧条目
                                    不继承旧条目的正文和否掉的方案，要沿用就显式重给
  ab recall [--hook] [文本…]            每轮钩子（--hook 时注入常驻偏好与提醒，不再自动检索）或按文本检索相关记忆
                                    --hook 从 stdin 读 {prompt,cwd}，命中时打一行 hook JSON
  ab search <关键词…> [--kind <种类>] [--project <项目名> | --all] [--archived]
                                    前 8 条全文并列出关联（带详情正文的显示前 300 字和 ab get 提示），第 9–16 名每条一行
                                    在已登记项目目录里还会多出一段「其他项目里相近的」（相似度 ≥0.65 的前 3 条）
  ab search --scene <design,code,review>  只列出该场景的全部规则（含未确认；不和关键词、--archived、--kind 其他种类同用）
  ab get <id 前缀> [--expand]       看一条：为什么、否掉的方案、详情正文、全部原话（带角色和时间），
                                    再列双向关联（补充/合并/纠正/冲突，含已归档的）、待确认的纠正、向量近邻；
                                    --expand 展开记下这条时的原始讨论；原对话不在时先列库里存的原话
                                    （Pensieve 导入条打开原 md 文件）
  ab confirm <id 前缀>
  ab archive <id 前缀> [--reactivate]
  ab tag <id 前缀> --scene <design,code,review|none>
                                    改规则的场景标签（整组替换；none 清空）
  ab guidance <id 前缀> [--off]          标成"指导干活方式的偏好"（确认过的全局偏好每轮常驻注入；带场景标签的不能标）
  ab audit worker-quotes [--apply]       找出只靠 worker 派活提示当"用户原话"的条目；--apply 撤销其自动转正
  ab review [--limit <n>] [--archive <id 前缀…> | --archive --all]
                                    到期复审：未确认、过了预计有效期、期间没被注入过的条目；--archive 归档（可撤销），已确认的永不进清单
  ab view [--out <路径>] [--no-open]  生成记忆看板（概览、关联图、记忆详情、注入/引用统计；默认 ~/.agentbrain/view.html）。只手动生成
  ab status | ab doctor             当前项目、宿主、接线自检，沉淀积压、失败与转正
  ab status --line                  一行 JSON {review, work_failed}：到期待复审数、近 7 天失败窗口数（宿主状态栏用）
  ab capture --hook --host <claude|codex|pi|opencode>
                                    宿主 hook 用：从 stdin 登记会话坐标；SessionEnd 时拉起分离的 ab work
                                    话题沉淀开着时：PreCompact 记话题边界并拉起 ab work；距上一轮超过 20 分钟也拉起
  ab capture <host>:<session_id> [--transcript <路径>] [--cwd <目录>] [--end]
                                    手动登记一个会话（hook 没生效时）
  ab import pensieve <仓库目录>... [--global <目录>]... [--skip-file <文件>] [--dry-run]
                                    把 .pensieve 的 maxim/decision/knowledge 导成已确认记忆（rule/decision/坑或事实），重导不重复，内容变了记为纠正
                                    md 正文存成条目的详情正文；重导时给旧条目补上缺的正文（不换 id）
  ab setup [--only fast,reviewers,panel,keys,hosts,test]
  ab setup --cite on|off [--dry-run]      召回块末尾的引用指令开关（默认关）
  ab setup --notes [--dry-run] [--adopt]  安装/更新宿主指令文件里的 agentbrain 托管块（写前备份，先打印 diff）
  ab setup --remove-notes [--dry-run]     只删托管块
                                    上手向导：快模型、按宿主的审稿人（默认 Claude Haiku max）、主审稿配置、key 进钥匙串、接哪些宿主、连通测试；可重复运行
  ab curate [--apply] [--host claude|codex|pi|opencode] [--limit N] | ab curate --undo <run>
                                    审稿（review.json：primary 一位主审 / panel 投票+仲裁；成员可以是 API，也可以是宿主命令行 claude -p / codex exec / pi -p）按《好记忆的标准》审已生效的未确认条目，给出归档建议
                                    只手动跑；自动抽取和 agent 自记的条目直接生效（未确认），不靠它转正
                                    默认 dry-run 只写报告（~/.agentbrain/curate/）；--apply 才写库，只动未确认条目，用户确认过的不动；--undo 整次撤销
                                    --host：只审该宿主会话抽出的未确认条目，用 review.json hostReviewers 里给它配的审稿人（用该宿主自己的额度）
  ab work [--session <host>:<id> [--redo]] [--sweep] [--dry-run]
                                    处理已静置或已结束会话的新内容，自动沉淀为未确认记忆
                                    --redo 清掉该会话的处理进度从头重跑（已入库的候选不重复）
                                    extract.json 写 "topic": true 时改为话题结束时一步式沉淀（§8.6，默认关）：静置 20 分钟、上下文压缩、会话结束
                                    算话题结束，由该宿主的命令行子模型一次决定记不记，直接写进正式库（未确认）
  ab work --runs | ab work --undo <run>
                                    话题沉淀的运行记录（~/.agentbrain/topic/）；--undo 整次撤销（归档该次写入、之后没被动过的条目）
                                    --sweep 另扫描漏登记的会话、按代码核验未确认的坑（到期条目不再自动归档，见 ab review）（launchd 每 30 分钟）`;

async function cmdCurate(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { apply: { type: "boolean", default: false }, host: { type: "string" }, limit: { type: "string" }, undo: { type: "string" } },
    strict: true,
  });
  const root = home();
  if (values.undo) {
    const report = loadReport(root, values.undo);
    const store = open();
    try {
      console.log(`已撤销 ${report.run}：${undoRun(store, report)} 条恢复原状`);
    } finally {
      store.close();
    }
    return;
  }
  // 审稿子进程里不再递归审稿
  if (process.env[REVIEWER_ENV]) return;
  const loaded = loadReviewConfig(root);
  if ("error" in loaded) die(loaded.error);
  if (values.host !== undefined && !HOSTS.includes(values.host as Host)) die(`--host 只能是 ${HOSTS.join("/")}`);
  // --host：只审从这个宿主会话抽出来的候选，用该宿主配的审稿人（hostReviewers），用它自己的额度
  const { cfg, onlyHost } = values.host === "opencode"
    ? { cfg: loaded, onlyHost: "opencode" as const }
    : configForHost(loaded, (values.host as "claude" | "codex" | "pi" | undefined) ?? null);
  const wantApply = values.apply;
  const store = open();
  const run = `curate-${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
  try {
    const props = store.project().props;
    const names = namesOf(store);
    const cap = values.limit ? Math.max(1, Number(values.limit) || 1) : cfg.batchSize * cfg.maxBatches;
    const pending = [...props.values()].filter((p) => p.state === "active" && !p.confirmed && (!onlyHost || p.source.host === onlyHost)).sort((a, b) => a.seq - b.seq);
    const cands = pending.slice(0, cap);
    if (!cands.length) {
      console.log("没有未确认的有效条目，没有要审的。");
      return;
    }
    const { panel, arbiter, missing } = connectPanel(cfg);
    if (!arbiter || panel.length === 0) die(`审稿团连不上：${missing.join("；") || "仲裁不可用"}`);
    // panel 模式要 3 家都在；primary 模式要主审和配置里的参考成员都在（缺参考意见也不写库，避免悄悄退化）
    const full = missing.length === 0 && (cfg.mode === "primary" ? true : panel.length >= 3);
    const apply = wantApply && full;
    const stats: CallStat[] = [];
    const inputs = cands.map((p) => candidateInput(store, p, props, names));
    let results: Awaited<ReturnType<typeof runPanel>>;
    try {
      results = await runPanel(inputs, panel, arbiter, cfg.batchSize, stats, 2, cfg.mode === "primary" ? cfg.primary : null);
    } catch (e) {
      if (e instanceof QuotaExhausted) die(`审稿团停下了，什么都没写：${e.message}`);
      throw e;
    }
    // 审稿要几分钟：期间用户可能确认/归档了某条。按此刻的库重新规划，planAction 会跳过已归档或已确认的
    const fresh = store.project().props;
    const actions = planAll(results, fresh);
    const report: RunReport = {
      run,
      at: new Date().toISOString(),
      dry_run: !apply,
      panel: cfg.panel.map((m) => ({ name: m.name, model: m.type === "cli" ? `${m.host}:${m.model || "默认"}${m.effort ? `@${m.effort}` : ""}` : m.model })),
      arbiter: cfg.mode === "primary" ? `primary:${cfg.primary}` : cfg.arbiter,
      results: results.map((r, i) => ({ ...r, action: actions[i], text: (fresh.get(r.id) ?? props.get(r.id))!.text })),
      stats,
      applied: [],
    };
    // 先落盘报告再写库，每写一步更新一次：中途出错也能 ab curate --undo
    let path = saveReport(root, report);
    if (apply)
      applyActions(store, run, actions, fresh, (applied) => {
        report.applied = applied;
        path = saveReport(root, report);
      });
    const count = (op: string) => actions.filter((a) => a.op === op).length;
    const routes = results.map((r) => r.decision.route);
    const arb = routes.filter((r) => r === "arbiter" || r === "arbiter_wording").length;
    const advisors = cfg.panel.filter((m) => m.name !== cfg.primary).map((m) => m.name);
    const cost = stats.reduce((n, s) => n + (s.costUsd ?? 0), 0);
    console.log(
      [
        `${new Date().toISOString()} ${apply ? "已执行" : "dry-run（没写库）"}：${cands.length} 条候选`,
        `  沉淀 ${count("promote")}，改写 ${count("rewrite")}，并入 ${count("merge")}，丢弃 ${count("discard")}，跳过 ${count("skip")}`,
        cfg.mode === "primary" ? `  主审 ${cfg.primary} 定结论 ${routes.filter((r) => r === "primary").length}，未决 ${routes.filter((r) => r === "undecided").length}${advisors.length ? `（参考意见：${advisors.join("、")}）` : ""}` : `  三票一致 ${routes.filter((r) => r === "unanimous").length}，仲裁 ${arb}（其中只定写法 ${routes.filter((r) => r === "arbiter_wording").length}），未决 ${routes.filter((r) => r === "undecided").length}`,
        `  调用 ${stats.length} 次，失败 ${stats.filter((s) => !s.ok).length}，token ${stats.reduce((n, s) => n + s.tokens, 0)}${cost ? `，费用约 $${cost.toFixed(4)}` : ""}`,
        missing.length ? `  审稿团缺人（只出报告，不写库）：${missing.join("；")}` : "",
        wantApply && !full ? `  --apply 被忽略：${cfg.mode === "primary" ? "主审或参考成员连不上" : "审稿团不满 3 家"}` : "",
        `报告：${path}${apply ? `\n撤销：ab curate --undo ${run}` : ""}`,
      ].filter(Boolean).join("\n"),
    );
  } finally {
    store.close();
  }
}

function setupNotes(v: { cite?: string; notes?: boolean; "remove-notes"?: boolean; "dry-run"?: boolean; adopt?: boolean }): void {
  if (v.cite !== undefined && v.cite !== "on" && v.cite !== "off") die("--cite 只能是 on 或 off");
  if (v["remove-notes"] && v.notes) die("--remove-notes 不能和 --notes 一起用");
  if (v.cite !== undefined) {
    if (!v["dry-run"]) {
      const store = open();
      try {
        setCite(store.workDb, v.cite === "on");
      } finally {
        store.close();
      }
    }
    console.log(`${v["dry-run"] ? "（预演，未写入）" : ""}引用指令：${v.cite === "on" ? "开" : "关"}`);
  }
  if (!v.notes && !v["remove-notes"]) return;
  const res = applyNotes({ dryRun: !!v["dry-run"], adopt: !!v.adopt, remove: !!v["remove-notes"], home: process.env.AB_HOST_HOME || undefined });
  const LABEL: Record<NoteAction, string> = { create: "新建文件并写入托管块", append: "追加托管块", "replace-legacy": "手写段换成托管块", adopt: "（--adopt）改过的手写段换成托管块", update: "更新托管块", unchanged: "托管块已是最新，不改", "needs-adopt": "手写段被改过，不替换；确认后加 --adopt", remove: "删除托管块", absent: "没有托管块，不改", broken: "标记不成对，不改，请手动检查" };
  for (const r of res) {
    console.log(`\n${r.host}  ${r.path}\n  ${LABEL[r.action]}${r.wrote ? "（已写入）" : r.diff && v["dry-run"] ? "（预演，未写入）" : ""}${r.backup ? `\n  备份：${r.backup}` : ""}`);
    if (r.diff) console.log(r.diff.trimEnd());
  }
}

async function cmdSetup(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      only: { type: "string" },
      cite: { type: "string" },
      notes: { type: "boolean", default: false },
      "remove-notes": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      adopt: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (values.cite !== undefined || values.notes || values["remove-notes"]) return setupNotes(values);
  const only = values.only ? (values.only.split(",").map((s) => s.trim()) as Step[]) : null;
  if (only?.some((s) => !STEPS.includes(s))) die(`--only 只能是 ${STEPS.join(",")}`);
  await runSetup(home(), only);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "help" || rest.includes("--help") || rest.includes("-h") || cmd === "--help" || cmd === "-h") {
    console.log(USAGE);
    return;
  }
  try {
    if (cmd === "brief") return cmdBrief(rest);
    if (cmd === "recall") {
      try {
        await cmdRecall(rest);
      } catch {
        // 召回失败不能让宿主这一轮失败，也不写 stderr。
      }
      return;
    }
    if (cmd === "remember") return await cmdRemember(rest);
    if (cmd === "correct") return await cmdCorrect(rest);
    if (cmd === "search") return await cmdSearch(rest);
    if (cmd === "get") return cmdGet(rest);
    if (cmd === "confirm") return cmdConfirm(rest);
    if (cmd === "archive") return cmdArchive(rest);
    if (cmd === "tag") return cmdTag(rest);
    if (cmd === "guidance") return cmdGuidance(rest);
    if (cmd === "audit") return cmdAudit(rest);
    if (cmd === "status" || cmd === "doctor") return cmdStatus(rest);
    if (cmd === "capture") return await cmdCapture(rest);
    if (cmd === "work") return await cmdWork(rest);
    if (cmd === "import") return await cmdImport(rest);
    if (cmd === "view") return cmdView(rest);
    if (cmd === "review") return cmdReview(rest);
    if (cmd === "curate") return await cmdCurate(rest);
    if (cmd === "setup") return await cmdSetup(rest);
  } catch (e) {
    if ((e as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) die(`${(e as Error).message}\n${USAGE}`);
    throw e;
  }
  die(`未知子命令: ${cmd}\n${USAGE}`);
}

await main();
