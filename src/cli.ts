#!/usr/bin/env node
/**
 * agentbrain 命令行（设计 §7.1）：brief / remember / correct / recall / search / get / confirm / archive / status(doctor) / capture / work。
 * 预算类数字是代码常量（§2.2），零配置键。
 */
import { parseArgs } from "node:util";
import { homedir } from "node:os";
import { chmodSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { Store, type Embedder } from "./store.ts";
import { type Host, type PropKind, type Proposition, type SourcePointer } from "./l2.ts";
import { embed, loadEmbedConfig, readKey } from "./embed.ts";
import { expandSource, latestAnchor } from "./source.ts";
import { detectHost, locateTranscript } from "./host.ts";
import type { Detection } from "./host.ts";
import { isRegistryHome, loadRegistry, registryDir, resolveProject } from "./registry.ts";
import { chatClient, loadChatConfig } from "./llm.ts";
import { allowedTranscript, BACKLOG_WINDOWS_PER_SWEEP, RELATE_BATCH, RELATE_SIM, RELATE_TOP, piSessionId, runWork, type WorkDeps } from "./work.ts";
import * as intake from "./intake.ts";
import { buildViewData, renderHtml } from "./view.ts";
import { brief, BriefError } from "./brief.ts";
import { guidanceBlock, recall } from "./recall.ts";
import { workerQuoteAudit } from "./audit.ts";
import { isWorkerTranscript } from "./transcript.ts";
import { reviewList, sourceClock } from "./expiry.ts";
import { fmtCounts, statusReport } from "./status.ts";
import { disputed, KIND_LABEL, projectIdByName, short } from "./present.ts";
import { displayPath, importPensieve, planImport, type PlanInput } from "./pensieve.ts";

const RECALL_EMBED_TIMEOUT_MS = 3000;
const GET_MAX_NEIGHBORS = 3;
const EXTRACT_TIMEOUT_MS = 90_000;
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

/** 读路径标记：未确认、自动沉淀、关系未判定（§9.4.4）、与代码不符。 */
function marks(p: Proposition): string {
  return [
    p.confirmed ? "" : p.origin === "extract" ? "[未确认·自动沉淀]" : "[未确认]",
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
  if (values.hook) {
    const raw = JSON.parse(await readStdin()) as { prompt?: unknown; cwd?: unknown; transcript_path?: unknown };
    if (typeof raw.prompt !== "string") return;
    query = raw.prompt;
    cwd = typeof raw.cwd === "string" && raw.cwd ? raw.cwd : process.cwd();
    worker = isWorkerTranscript(typeof raw.transcript_path === "string" ? raw.transcript_path : null);
  } else {
    query = positionals.join(" ");
    cwd = process.cwd();
    if (!query.trim()) return;
  }
  const store = open();
  try {
    const used: string[] = [];
    const stale: string[] = [];
    const recalled = await recall(store, query, cwd, () => createEmbedder(RECALL_EMBED_TIMEOUT_MS).embedder, used, stale, undefined, worker);
    // 常驻偏好不看相似度，每轮都给（斜杠命令除外）；本轮召回已给出的不重复
    let prefs = "";
    if (!query.trim().startsWith("/")) {
      try {
        prefs = guidanceBlock(store.project().props.values(), worker, new Set(used), used);
      } catch {
        prefs = ""; // fail-open
      }
    }
    const block = prefs + recalled;
    if (!block) return;
    markUsed(store, used);
    if (stale.length) {
      try {
        store.queueReverify(stale, new Date());
      } catch {
        // 库忙或只读时跳过，下次召回会再排
      }
    }
    if (values.hook) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: block.trimEnd() },
      }) + "\n");
    } else {
      process.stdout.write(block);
    }
  } finally {
    store.close();
  }
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
    options: { worker: { type: "boolean", default: false } },
    strict: true,
    allowPositionals: true,
  });
  const store = open();
  try {
    let out: string;
    const used: string[] = [];
    try {
      out = brief(store, process.cwd(), positionals[0], values.worker === true, used);
    } catch (e) {
      if (e instanceof BriefError) die(e.message);
      throw e;
    }
    process.stdout.write(out);
    markUsed(store, used);
  } finally {
    store.close();
  }
}

const HOSTS: Host[] = ["claude", "codex", "pi"];

/** `--from-worker host:session`。host 必须是三个宿主之一。 */
function parseFromWorker(raw: string): { host: Host; session_id: string } {
  const i = raw.indexOf(":");
  const host = raw.slice(0, i);
  const session_id = raw.slice(i + 1);
  if (i <= 0 || !HOSTS.includes(host as Host) || !session_id) die(`--from-worker 必须是 claude|codex|pi:<session_id>，收到: ${raw}`);
  return { host: host as Host, session_id };
}

/** 当前主会话。检测失败或没有宿主时为 null。 */
function relayedBy(): { host: Host; session_id: string | null } | null {
  const found = detectHost();
  return found.ok && found.detection ? { host: found.detection.host, session_id: found.detection.session_id } : null;
}

/** 来源指向子代理。找不到它的 transcript 时 transcript 与 anchor 为 null，并提示。 */
function workerSource(raw: string, summary: string): { source: SourcePointer; missing: boolean } {
  const w = parseFromWorker(raw);
  const found = locateTranscript(w.host, w.session_id);
  const transcript = found ? realpathSync(found) : null;
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
    },
    strict: true,
  });
  const kind = values.kind as PropKind | undefined;
  if (!kind || !KINDS.includes(kind)) die(`--kind 必须是 ${KINDS.join("|")}`);
  if (!values.text) die("缺少 --text");
  if (!values.summary) die("缺少 --summary");
  if (values["for-workers"] && !values.global) die("--for-workers 只能和 --global 一起用");
  if (values.global && values.project) die("--global 与 --project 不能同时用");

  const store = open();
  try {
    let projectId: string | null = null;
    if (!values.global) {
      if (values.project) {
        if (!loadRegistry().some((e) => e.name === values.project)) die(`清单里没有项目: ${values.project}`);
        projectId = projectIdByName(store, values.project);
      } else {
        const here = resolveProject(process.cwd());
        if (!here) die("当前目录不是已登记项目。记全局记忆加 --global，或用 --project <名> 指定项目。");
        projectId = projectIdByName(store, here.name);
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
    const id = store.remember(projectId, source.session_id, false, {
      kind,
      text: values.text,
      why: values.why,
      for_workers: values["for-workers"] || undefined,
      confirmed: values.confirmed === true,
      source,
    });
    let out = `已记住 [${short(id)}] ${KIND_LABEL[kind]}: ${values.text}`;
    if (missingWorker) out += "\n未找到子代理会话记录";
    else if (transcript === null) out += "\n未找到会话记录，这条记忆没有可展开的来源。";
    if (!values.confirmed) out += `\n未确认：不进 brief，用户认可后 ab confirm ${short(id)}`;
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
    },
    strict: true,
    allowPositionals: true,
  });
  const query = positionals.join(" ");
  if (!query) die("用法: ab search <关键词…>");
  if (values.kind && !KINDS.includes(values.kind as PropKind)) die(`--kind 必须是 ${KINDS.join("|")}`);
  if (values.project && values.all) die("--project 与 --all 不能同时用");

  const store = open();
  try {
    const inPm = isRegistryHome(process.cwd());
    let projects: string[] | "all";
    let includeGlobal = true;
    if (values.all || (inPm && !values.project)) projects = "all";
    else if (values.project) {
      const hit = store.listProjects().find((p) => p.name === values.project);
      if (!hit) die(`没有名为 ${values.project} 的项目记忆`);
      projects = [hit.id];
    } else {
      const here = resolveProject(process.cwd());
      projects = here ? [projectIdByName(store, here.name)] : [];
      if (!here) includeGlobal = true;
    }
    const names = namesOf(store);
    const { embedder, reason } = createEmbedder();
    const { hits, degraded } = await store.searchHybrid(query, {
      projects,
      includeGlobal,
      kind: values.kind as PropKind | undefined,
      includeArchived: values.archived,
    }, embedder);
    if (!hits.length) {
      console.log("没有匹配的记忆。");
    }
    const props = store.project().props;
    for (const h of hits) {
      const p = props.get(h.id);
      const scope = p ? SCOPE_LABEL(p, names) : "未知";
      const mark = p ? marks(p) : "";
      const flag = p?.state === "archived" ? "（已归档）" : p?.state === "superseded" ? "（已被替代）" : "";
      console.log(`[${short(h.id)}] ${scope} ${KIND_LABEL[h.kind]}${mark}${flag}${p ? disputed(p) : ""}: ${h.text.split("\n")[0]}`);
    }
    if (degraded) console.log(`（仅全文检索：${reason ?? degraded}）`);
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
    const names = namesOf(store);
    const stateMark = p.state === "archived" ? "（已归档）" : p.state === "superseded" ? "（已被替代）" : "";
    const linesOut = [
      `[${short(p.id)}] ${SCOPE_LABEL(p, names)} ${KIND_LABEL[p.kind]}${stateMark}${p.confirmed ? "" : p.origin === "extract" ? " 未确认（自动沉淀）" : " 未确认（agent 自记）"}${p.unreconciled ? " 关系未判定" : ""}: ${p.text}`,
      p.confirmed && p.confirmed_by === "code" ? "已由代码核验转正" : "",
      p.confirmed && p.confirmed_by === "corroboration" ? "已由跨会话印证转正（两个以上会话里用户都这样说过）" : "",
      p.expired ? `到期未确认，已归档（撤销用 ab archive --reactivate ${short(p.id)}）` : "",
      p.trigger ? `触发: ${p.trigger}` : "",
      p.import_ref ? `导入自 Pensieve ${p.import_ref.id}: ${p.import_ref.path}${p.import_ref.also?.length ? `（另有 ${p.import_ref.also.length} 处相同副本）` : ""}` : "",
      p.basis ? `依据: ${BASIS_LABEL[p.basis] ?? p.basis}，引文 ${p.evidence.length} 处（${p.evidence.map((e) => `${e.role}@${e.anchor.slice(0, 12)}`).join("、")}）` : "",
      p.extra_sources.length ? `另有 ${p.extra_sources.length} 处来源（${p.extra_sources.map((x) => `${x.host ?? "?"}:${(x.session_id ?? "?").slice(0, 8)} ${BASIS_LABEL[x.basis] ?? x.basis}`).join("、")}）` : "",
      p.code_evidence ? `代码证据（HEAD ${p.code_evidence.head.slice(0, 10)}）: ${p.code_evidence.refs.map(codeRef).join("；")}` : "",
      p.stale ? `与代码不符（HEAD ${p.stale.head.slice(0, 10)}）: ${p.stale.refs.map(codeRef).join("；")}` : "",
      p.merged_into ? `判定与 [${short(p.merged_into)}] 重复，已并入并归档（撤销用 ab archive --reactivate ${short(p.id)}）` : "",
      p.related && p.related.outcome === "refines" && p.related.target ? `是 [${short(p.related.target)}] 的补充` : "",
      p.conflicts_with ? `与 [${short(p.conflicts_with)}] 说法冲突（关系判定），两条不能同时成立` : "",
      p.supersedes ? `替代了 [${short(p.supersedes)}]` : "",
      p.superseded_by ? `已被 [${short(p.superseded_by)}] 替代` : "",
      ...p.pending_corrections.map((id) => {
        const c = store.project().props.get(id)!;
        if (c.conflicts_with === p.id && !c.supersedes) return `与 [${short(id)}] 说法冲突（关系判定）: ${c.text}（两条不能同时成立；作废哪条就 ab archive 哪条）`;
        return `待确认的纠正 [${short(id)}]: ${c.text}（认可用 ab confirm ${short(id)}，否决用 ab archive ${short(id)}）`;
      }),
      p.why ? `为什么: ${p.why}` : "",
      `来源: ${p.source.summary}（${p.source.host ?? "未知宿主"}）${p.source.transcript ? "" : "（无 transcript）"}${p.source.relayed_by ? `（经 ${p.source.relayed_by.host} 主会话转记）` : ""}  记录于 ${p.ts.slice(0, 10)}`,
    ].filter(Boolean);
    const shown = new Set([p.supersedes, p.superseded_by, ...p.pending_corrections]);
    const near = store.neighbors(p.id);
    if (near === null) linesOut.push("相关: 近邻不可用，这条还没有向量");
    else {
      const rows = near.filter((n) => !shown.has(n.prop.id)).slice(0, GET_MAX_NEIGHBORS).map(({ prop: n, similarity }) =>
        `  [${short(n.id)}] ${SCOPE_LABEL(n, names)} ${KIND_LABEL[n.kind]}${marks(n)}: ${n.text.split("\n")[0]}（${similarity.toFixed(2)}）`);
      if (rows.length) linesOut.push("相关（向量近邻）:", ...rows);
    }
    if (values.expand) {
      const disc = expandSource(p.source);
      linesOut.push("", "--- 当时的讨论 ---", disc ? disc : "来源不可用：transcript 不存在或定位点失效。");
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
    },
    strict: true,
    allowPositionals: true,
  });
  if (!positionals[0]) die("用法: ab correct <id 前缀> --text <新内容> --summary <当时在讨论什么>");
  if (!values.text) die("缺少 --text");
  if (!values.summary) die("缺少 --summary");
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
      for_workers: old.for_workers || undefined,
      confirmed: values.confirmed === true,
      supersedes: old.id,
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

function cmdGuidance(argv: string[]): void {
  const { values, positionals } = parseArgs({ args: argv, options: { off: { type: "boolean", default: false } }, strict: true, allowPositionals: true });
  if (!positionals[0]) die("用法: ab guidance <id 前缀> [--off]");
  const store = open();
  try {
    const p = findByPrefix(store, positionals[0]);
    const on = !values.off;
    if (p.guidance === on) return console.log(`未变 [${short(p.id)}] ${p.text}`);
    store.lifecycle("tag", p.id, null, { guidance: on });
    const note = on && !(p.project_id === null && p.confirmed && p.confirmed_by === "user") ? "（只有用户确认过的全局条目才会每轮常驻）" : "";
    console.log(`${on ? "已标为干活偏好" : "已取消干活偏好"} [${short(p.id)}] ${p.text}${note}`);
  } finally {
    store.close();
  }
}

function cmdAudit(argv: string[]): void {
  const { values, positionals } = parseArgs({ args: argv, options: { apply: { type: "boolean", default: false } }, strict: true, allowPositionals: true });
  if (positionals[0] !== "worker-quotes") die("用法: ab audit worker-quotes [--apply]");
  const store = open();
  try {
    const plan = workerQuoteAudit(store.project().props.values(), sessionTranscript(store), isWorkerTranscript);
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
  try {
    data = buildViewData(store);
  } finally {
    store.close();
  }
  writeFileSync(out, renderHtml(data), { mode: 0o600 });
  chmodSync(out, 0o600);
  console.log(`已生成 ${out}：共 ${data.counts.total} 条（有效 ${data.counts.active}），有向量 ${data.counts.vectors} 条`);
  if (!values["no-open"]) {
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
    spawn(opener, [out], { stdio: "ignore", detached: true }).on("error", () => console.log(`没能自动打开，请手动打开 ${out}`)).unref();
  }
}

// ---------- capture / work（切片 3） ----------

function parseSessionKey(raw: string): { host: Host; session_id: string } {
  const i = raw.indexOf(":");
  const host = raw.slice(0, i) as Host;
  const session_id = raw.slice(i + 1);
  if (i <= 0 || !HOSTS.includes(host) || !session_id) die(`会话必须写成 claude|codex|pi:<session_id>，收到: ${raw}`);
  return { host, session_id };
}

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
  const raw = JSON.parse(await readStdin()) as Record<string, unknown>;
  const given = typeof raw.transcript_path === "string" && raw.transcript_path ? raw.transcript_path : null;
  const ephemeral = raw.ephemeral === true;
  let sessionId = typeof raw.session_id === "string" && raw.session_id ? raw.session_id : null;
  if (!sessionId && host === "pi" && given) sessionId = piSessionId(given);
  if (!sessionId) return;
  let transcript: string | null = null;
  if (given) {
    transcript = allowedTranscript(host, given);
    if (!transcript) return; // 不在宿主会话目录里的路径一律不登记
  } else if (!ephemeral) {
    const found = locateTranscript(host, sessionId);
    transcript = found ? allowedTranscript(host, found) : null;
  }
  const cwd = typeof raw.cwd === "string" && raw.cwd ? raw.cwd : null;
  const ended = raw.hook_event_name === "SessionEnd";
  const store = open();
  let project: string | null = null;
  try {
    intake.upsertSession(store.workDb, { host, session_id: sessionId, transcript, cwd, ended, ephemeral, via: "hook" }, () => {
      project = cwd ? (resolveProject(cwd)?.name ?? null) : null;
      return project;
    }, new Date());
    if (ended) {
      const row = intake.sessions(store.workDb, { host, session_id: sessionId })[0];
      project = row?.project ?? null;
    }
  } finally {
    store.close();
  }
  if (ended && project && !ephemeral) spawnWork(`${host}:${sessionId}`);
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
  if (!positionals[0]) die("用法: ab capture <claude|codex|pi>:<session_id> [--transcript <路径>] [--cwd <目录>] [--end]");
  const key = parseSessionKey(positionals[0]);
  const found = values.transcript ?? locateTranscript(key.host, key.session_id);
  if (!found) die("找不到这个会话的 transcript，用 --transcript 指定");
  const transcript = allowedTranscript(key.host, found);
  if (!transcript) die(`transcript 必须在 ${key.host} 的会话目录下: ${found}`);
  const cwd = values.cwd ?? process.cwd();
  const store = open();
  try {
    const project = resolveProject(cwd)?.name ?? null;
    const r = intake.upsertSession(store.workDb, { ...key, transcript, cwd, ended: values.end === true, ephemeral: false, via: "manual" }, () => project, new Date());
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
    chat = typeof key === "string" ? { chat: chatClient(cfg, key, EXTRACT_TIMEOUT_MS), model: cfg.model } : { error: "no_key", message: key.error };
  }
  return {
    store,
    now: () => new Date(),
    chat,
    embedder: createEmbedder().embedder,
    registry: loadRegistry(),
    registryDir: registryDir(),
    resolveProject: (cwd) => resolveProject(cwd),
    projectId: (name) => projectIdByName(store, name),
    debugDir: process.env.AB_DEBUG === "1" ? join(home(), "debug") : undefined,
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
    },
    strict: true,
  });
  if (values.redo && !values.session) die("--redo 必须和 --session 一起用");
  const store = open();
  try {
    const r = await runWork(workDeps(store), {
      session: values.session ? parseSessionKey(values.session) : undefined,
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
    console.log(
      [
        `${new Date().toISOString()} ab work${values.sweep ? " --sweep" : ""}`,
        `窗口: 完成 ${r.windows.done}，延后 ${r.windows.deferred}，失败 ${r.windows.failed}，跳过 ${r.windows.skipped}${r.scanned ? `；扫描补登记 ${r.scanned}` : ""}${r.backlogLeft ? `；补登记会话留到下次 ${r.backlogLeft}（每次 sweep 最多 ${BACKLOG_WINDOWS_PER_SWEEP} 个窗口）` : ""}`,
        `产出: 候选 ${x.candidates}，提议 ${x.proposals}，附加来源 ${x.attached}，待确认纠正 ${x.corrections}，关系未判定 ${x.unreconciled}，跨会话印证转正 ${x.corroborated}，同窗口合并 ${x.merged}`,
        `丢弃: 整条候选 ${fmtCounts(x.dropped)}；单条证据 ${fmtCounts(x.evidence_dropped)}`,
        Object.values(r.relate).some(Boolean) ? `关系判定: 重复并入 ${r.relate.duplicate}，补充 ${r.relate.refines}，冲突 ${r.relate.conflicts}，无关 ${r.relate.unrelated}，拿不准 ${r.relate.unsure}，并入后跨会话印证转正 ${r.relate.corroborated}，出错 ${r.relate.errors}` : "",
        values.sweep ? `代码核验: 转正 ${r.verify.verified}，与代码不符 ${r.verify.contradicted}，代码无法核验 ${r.verify.not_verifiable}，证据不足 ${r.verify.inconclusive}，出错 ${r.verify.errors}` : "",
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
      console.log(`[${it.project ?? "全局"}] ${it.doc.type}→${it.kind} ${it.doc.id}\n  正文: ${it.text}\n  背景: ${it.why ?? "（无）"}\n  出处: ${displayPath(it.doc.path, h)}${it.also.length ? `（另有 ${it.also.length} 处相同副本）` : ""}`);
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
        projectId: (name) => projectIdByName(store, name),
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
        `导入 Pensieve: 新增 ${r.created.length}，内容变更改为纠正 ${r.corrected.length}，未变 ${r.unchanged}，此前已归档不再导 ${r.archivedSkip}，跳过 ${r.skipped.length}`,
        `关系判定: 已有条目并入导入条 ${x.mergedExisting}，导入条并入已确认条目 ${x.mergedIntoExisting}，补充 ${x.refines}，冲突 ${x.conflicts.length}${x.conflicts.length ? `（${x.conflicts.join("、")}）` : ""}，无关 ${x.unrelated}，拿不准 ${x.unsure}，出错 ${x.errors}`,
        ...x.errorDetails.map((d) => `  出错原因: ${d}`),
        x.errors ? "  出错的条目下次运行同一命令会补判（未变的导入条只要还没判过关系就会重判）" : "",
        reason ? `向量未更新：${reason}` : "",
      ].filter(Boolean).join("\n"),
    );
  } finally {
    store.close();
  }
}

function cmdStatus(): void {
  const store = open();
  try {
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
  ab brief [项目名] [--worker]      开工先跑：全局规则 + 当前项目的坑与规则；--worker 给被派活的子代理
  ab remember --kind <rule|decision|pitfall|note> --text <内容> --summary <当时在讨论什么>
              [--why <理由>] [--global | --project <项目名>] [--for-workers] [--confirmed]
              [--from-worker <claude|codex|pi>:<session_id>]
                                    默认记到当前目录所属项目；--global 记全局；--for-workers 让子代理也看到这条全局规则
                                    --confirmed 用户明确要求记的才加；不加则不进 brief
                                    --from-worker 把来源指回子代理会话，当前主会话记在转记人上
  ab correct <id 前缀> --text <新内容> --summary <当时在讨论什么>
              [--why <理由>] [--confirmed] [--from-worker <claude|codex|pi>:<session_id>]
                                    追加一条替代旧记忆的纠正；未确认前不盖掉旧条目
  ab recall [--hook] [文本…]            每轮召回：当前项目和全局的已确认坑/规则/决定；另可带 1 条无争议的未确认坑/规则/决定（标未确认）
                                    --hook 从 stdin 读 {prompt,cwd}，命中时打一行 hook JSON
  ab search <关键词…> [--kind <种类>] [--project <项目名> | --all] [--archived]
  ab get <id 前缀> [--expand]       看一条：替代链、待确认的纠正、向量近邻；--expand 展开记下这条时的原始讨论
  ab confirm <id 前缀>
  ab archive <id 前缀> [--reactivate]
  ab guidance <id 前缀> [--off]          标成"指导干活方式的偏好"（确认过的全局偏好每轮常驻注入）
  ab audit worker-quotes [--apply]       找出只靠 worker 派活提示当"用户原话"的条目；--apply 撤销其自动转正
  ab review [--limit <n>] [--archive <id 前缀…> | --archive --all]
                                    到期复审：未确认、过了预计有效期、期间没被注入过的条目；--archive 归档（可撤销），已确认的永不进清单
  ab view [--out <路径>] [--no-open]  生成一个本地 HTML 页面浏览全部记忆、关系和向量地图（默认 ~/.agentbrain/view.html）
  ab status | ab doctor             当前项目、宿主、接线自检，沉淀积压、失败与转正
  ab capture --hook --host <claude|codex|pi>
                                    宿主 hook 用：从 stdin 登记会话坐标；SessionEnd 时拉起分离的 ab work
  ab capture <host>:<session_id> [--transcript <路径>] [--cwd <目录>] [--end]
                                    手动登记一个会话（hook 没生效时）
  ab import pensieve <仓库目录>... [--global <目录>]... [--skip-file <文件>] [--dry-run]
                                    把 .pensieve 的 maxim/decision/knowledge 导成已确认记忆（rule/decision/坑或事实），重导不重复，内容变了记为纠正
  ab work [--session <host>:<id> [--redo]] [--sweep] [--dry-run]
                                    处理已静置或已结束会话的新内容，自动沉淀为未确认记忆
                                    --redo 清掉该会话的处理进度从头重跑（已入库的候选不重复）
                                    --sweep 另扫描漏登记的会话、按代码核验未确认的坑（到期条目不再自动归档，见 ab review）（launchd 每 30 分钟）`;

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
    if (cmd === "guidance") return cmdGuidance(rest);
    if (cmd === "audit") return cmdAudit(rest);
    if (cmd === "status" || cmd === "doctor") return cmdStatus();
    if (cmd === "capture") return await cmdCapture(rest);
    if (cmd === "work") return await cmdWork(rest);
    if (cmd === "import") return await cmdImport(rest);
    if (cmd === "view") return cmdView(rest);
    if (cmd === "review") return cmdReview(rest);
  } catch (e) {
    if ((e as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) die(`${(e as Error).message}\n${USAGE}`);
    throw e;
  }
  die(`未知子命令: ${cmd}\n${USAGE}`);
}

await main();
