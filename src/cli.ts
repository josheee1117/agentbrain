#!/usr/bin/env node
/**
 * agentbrain 命令行（设计 §7.1）：brief / remember / correct / recall / search / get / confirm / archive / status(doctor) / capture / work。
 * 预算类数字是代码常量（§2.2），零配置键。
 */
import { parseArgs } from "node:util";
import { homedir } from "node:os";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { Store, type Embedder } from "./store.ts";
import type { Host, PropKind, Proposition, SourcePointer } from "./l2.ts";
import { embed, loadEmbedConfig, readKey } from "./embed.ts";
import { expandSource, latestAnchor } from "./source.ts";
import { detectHost, locateTranscript } from "./host.ts";
import type { Detection } from "./host.ts";
import { isRegistryHome, loadRegistry, registryDir, resolveProject } from "./registry.ts";
import { chatClient, loadChatConfig } from "./llm.ts";
import { allowedTranscript, BACKLOG_WINDOWS_PER_SWEEP, piSessionId, PROPOSAL_EXPIRE_DAYS, runWork, type WorkDeps } from "./work.ts";
import * as intake from "./intake.ts";

const BRIEF_MAX_CHARS = 2000;
const RECALL_MAX_ITEMS = 3;
const RECALL_MAX_CHARS = 600;
const RECALL_EMBED_TIMEOUT_MS = 3000;
// 测试集上 0.55 负例误报 0%、召回 63%；0.50 召回 87% 但误报 13%。每轮注入宁缺毋滥。
const RECALL_MIN_SIM = 0.55;
const GET_MAX_NEIGHBORS = 3;
const RECALL_KINDS: PropKind[] = ["pitfall", "rule", "decision"];
const EXTRACT_TIMEOUT_MS = 90_000;
const KINDS: PropKind[] = ["rule", "decision", "pitfall", "note"];
const KIND_LABEL: Record<PropKind, string> = { rule: "规则", decision: "决定", pitfall: "坑", note: "事实" };
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

function short(id: string): string {
  return id.slice(0, 8);
}

function disputed(p: Proposition): string {
  return p.pending_corrections.length ? `（有待确认的纠正 ${p.pending_corrections.map((id) => `[${short(id)}]`).join("")}）` : "";
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

function active(store: Store): Proposition[] {
  return [...store.project().props.values()].filter((p) => p.state === "active");
}

/** 前缀必须唯一命中一条，否则报错退出。 */
function findByPrefix(store: Store, prefix: string): Proposition {
  const hits = [...store.project().props.values()].filter((p) => p.id.startsWith(prefix));
  if (hits.length === 1) return hits[0];
  die(hits.length === 0 ? `找不到记忆: ${prefix}` : `前缀不唯一，匹配了 ${hits.length} 条: ${prefix}`);
}

function projectIdByName(store: Store, name: string): string {
  const hit = store.listProjects().find((p) => p.name === name);
  return hit ? hit.id : store.ensureProject(name);
}

function namesOf(store: Store): Map<string, string> {
  return new Map(store.listProjects().map((p) => [p.id, p.name]));
}

// ---------- brief ----------

function counts(list: Proposition[]): string {
  const n = (k: PropKind) => list.filter((p) => p.kind === k).length;
  return `坑 ${n("pitfall")}、规则 ${n("rule")}、决定 ${n("decision")}`;
}

/** 换行（含连续空白行）压成 " / "，不丢后半段。放不下的整条不放，计入 hidden。 */
function lines(list: Proposition[], kinds: PropKind[], budget: number): { text: string; hidden: number } {
  const rows = list.filter((p) => kinds.includes(p.kind)).sort((a, b) => b.seq - a.seq);
  let text = "";
  let shown = 0;
  for (const p of rows) {
    const line = `- [${short(p.id)}] ${p.text.split(/\n+/).map((s) => s.trim()).filter(Boolean).join(" / ")}${disputed(p)}\n`;
    if (text.length + line.length > budget) continue;
    text += line;
    shown++;
  }
  return { text, hidden: rows.length - shown };
}

const CLOSE = "\n</agentbrain>\n";

/** 正文预算 = 上限减掉开头、各段标题、结尾提示。各段再按原比例（均分）分。 */
function contentBudgets(fixed: string[], titles: string[]): number[] {
  const n = fixed.length + titles.length;
  const fixedLen =
    fixed.reduce((s, p) => s + p.length, 0) +
    titles.reduce((s, t) => s + t.length + 1, 0) +
    Math.max(0, n - 1) +
    CLOSE.length;
  const total = Math.max(0, BRIEF_MAX_CHARS - fixedLen);
  const each = titles.length ? Math.floor(total / titles.length) : 0;
  return titles.map(() => each);
}

function brief(store: Store, cwd: string, projectName: string | undefined, worker: boolean): string {
  const all = active(store);
  const global = all.filter((p) => p.project_id === null);
  const pending: Proposition[] = [];

  const named = projectName ? loadRegistry().find((e) => e.name === projectName) : undefined;
  if (projectName && !named) die(`清单里没有项目: ${projectName}`);
  const here = resolveProject(cwd);
  const project = named ? { name: named.name } : here;
  const inPm = isRegistryHome(cwd);

  let head = "";
  const before: string[] = [];
  const after: string[] = [];
  const sections: { title: string; rows: Proposition[]; kinds: PropKind[] }[] = [];
  let noteFor = (n: number) => `还有 ${n} 条放不下，用 ab search 查。`;

  if (worker) {
    if (!project) die("--worker 需要已登记项目：在项目目录里运行，或给出项目名");
    const pid = projectIdByName(store, project.name);
    const mine = all.filter((p) => p.project_id === pid);
    head = `<agentbrain project="${project.name}" worker>`;
    const rules = global.filter((p) => p.kind === "rule" && p.for_workers);
    pending.push(...rules.filter((p) => !p.confirmed));
    pending.push(...mine.filter((p) => (p.kind === "pitfall" || p.kind === "rule") && !p.confirmed));
    sections.push(
      { title: "全局规则（子代理也要看）：", rows: rules.filter((p) => p.confirmed), kinds: ["rule"] },
      {
        title: `${project.name} 的坑与规则（最近在前；与现场证据冲突时信现场）：`,
        rows: mine.filter((p) => p.confirmed),
        kinds: ["pitfall", "rule"],
      },
    );
  } else if ((inPm && !projectName) || (!project && !projectName && inPm)) {
    head = '<agentbrain scope="pm">';
    pending.push(...global.filter((p) => (p.kind === "rule" || p.kind === "pitfall") && !p.confirmed));
    sections.push({ title: "全局规则与坑（最近在前）：", rows: global.filter((p) => p.confirmed), kinds: ["rule", "pitfall"] });
    const idByName = new Map(store.listProjects().map((p) => [p.name, p.id]));
    const overview = loadRegistry()
      .filter((e) => e.path)
      .map((e) => {
        const mine = all.filter((x) => x.project_id === idByName.get(e.name));
        pending.push(...mine.filter((x) => !x.confirmed));
        return `- ${e.name}：${counts(mine.filter((x) => x.confirmed))}`;
      });
    if (overview.length) after.push("各项目概况：\n" + overview.join("\n"));
    noteFor = (n) => `全局还有 ${n} 条放不下，用 ab search --all 查。`;
  } else if (project) {
    const pid = projectIdByName(store, project.name);
    const mine = all.filter((p) => p.project_id === pid);
    head = `<agentbrain project="${project.name}">`;
    pending.push(...global.filter((p) => (p.kind === "rule" || p.kind === "pitfall") && !p.confirmed));
    pending.push(...mine.filter((p) => !p.confirmed));
    sections.push(
      { title: "全局规则与坑：", rows: global.filter((p) => p.confirmed), kinds: ["rule", "pitfall"] },
      {
        title: `${project.name} 的坑与规则（最近在前；与现场证据冲突时信现场）：`,
        rows: mine.filter((p) => p.confirmed),
        kinds: ["pitfall", "rule"],
      },
    );
    const decisions = mine.filter((p) => p.kind === "decision" && p.confirmed).length;
    const notes = mine.filter((p) => p.kind === "note" && p.confirmed).length;
    after.push(`决定 ${decisions} 条、事实 ${notes} 条：用 ab search 查，ab get 看当时的讨论。`);
  } else {
    head = '<agentbrain scope="unregistered">';
    before.push("当前目录不是已登记项目，只给出全局记忆。");
    pending.push(...global.filter((p) => (p.kind === "rule" || p.kind === "pitfall") && !p.confirmed));
    sections.push({ title: "全局规则与坑：", rows: global.filter((p) => p.confirmed), kinds: ["rule", "pitfall"] });
  }

  const tails = [
    worker
      ? "你是被派活的子代理：不写记忆，新坑写进汇报，由主会话决定是否记下。搜索用 ab search，看一条用 ab get。"
      : "记住用 ab remember，搜索用 ab search，看一条用 ab get。",
  ];
  const auto = pending.filter((p) => p.origin === "extract").length;
  if (pending.length && !worker)
    tails.push(
      auto
        ? `另有 ${pending.length} 条未确认（其中自动沉淀 ${auto} 条，ab search 可见），用户认可后 ab confirm <id>。`
        : `另有 ${pending.length} 条 agent 自记未确认（ab search 可见），用户认可后 ab confirm <id>。`,
    );

  const candidates = sections.reduce((n, s) => n + s.rows.filter((p) => s.kinds.includes(p.kind)).length, 0);
  const noteReserve = candidates > 0 ? noteFor(candidates) : "";
  const budgets = contentBudgets([head, ...before, ...after, ...(noteReserve ? [noteReserve] : []), ...tails], sections.map((s) => s.title));
  let hidden = 0;
  const body: string[] = [];
  sections.forEach((s, i) => {
    const got = lines(s.rows, s.kinds, budgets[i] ?? 0);
    hidden += got.hidden;
    if (got.text) body.push(s.title + "\n" + got.text.trimEnd());
  });
  const note = hidden ? noteFor(hidden) : "";
  const parts = [head, ...before, ...body, ...after, ...(note ? [note] : []), ...tails];
  let out = parts.filter(Boolean).join("\n") + CLOSE;
  if (out.length > BRIEF_MAX_CHARS) out = out.slice(0, BRIEF_MAX_CHARS - 40) + "\n…已截断，用 ab search 查。\n</agentbrain>\n";
  return out;
}

// ---------- 子命令 ----------

// ---------- recall ----------

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

/** 命中时返回 <agentbrain-recall> 块；跳过或没有命中返回空串。 */
async function recall(store: Store, query: string, cwd: string): Promise<string> {
  const prompt = query.trim();
  if (prompt.length < 4 || prompt.startsWith("/")) return "";
  const here = resolveProject(cwd);
  const projects = here ? [projectIdByName(store, here.name)] : [];
  const { embedder } = createEmbedder(RECALL_EMBED_TIMEOUT_MS);
  const { hits } = await store.searchHybrid(prompt, {
    projects,
    includeGlobal: true,
    includeArchived: true,
    limit: 20,
    skipSync: true,
    minSim: RECALL_MIN_SIM,
  }, embedder);
  const props = store.project().props;
  const picked = hits.flatMap((h) => {
    const p = props.get(h.id);
    if (!p || p.state !== "active" || !p.confirmed || !RECALL_KINDS.includes(p.kind)) return [];
    if (p.project_id === null && !p.for_workers) return [];
    if (p.project_id !== null && (!here || p.project_id !== projects[0])) return [];
    return [p];
  }).slice(0, RECALL_MAX_ITEMS);
  if (!picked.length) return "";
  const head = "<agentbrain-recall>\n";
  const tail = "\n</agentbrain-recall>\n";
  const rows: string[] = [];
  for (const p of picked) {
    const body = p.text.split(/\n+/).map((s) => s.trim()).filter(Boolean).join(" / ");
    let line = `- [${short(p.id)}] ${KIND_LABEL[p.kind]}${disputed(p)}: ${body}`;
    const used = head.length + rows.join("\n").length + (rows.length ? 1 : 0) + tail.length;
    const room = RECALL_MAX_CHARS - used;
    if (room <= 0) break;
    if (line.length > room) {
      if (room < 2) break;
      line = line.slice(0, room - 1) + "…";
      rows.push(line);
      break;
    }
    rows.push(line);
  }
  if (!rows.length) return "";
  return head + rows.join("\n") + tail;
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
  if (values.hook) {
    const raw = JSON.parse(await readStdin()) as { prompt?: unknown; cwd?: unknown };
    if (typeof raw.prompt !== "string") return;
    query = raw.prompt;
    cwd = typeof raw.cwd === "string" && raw.cwd ? raw.cwd : process.cwd();
  } else {
    query = positionals.join(" ");
    cwd = process.cwd();
    if (!query.trim()) return;
  }
  const store = open();
  try {
    const block = await recall(store, query, cwd);
    if (!block) return;
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

function cmdBrief(argv: string[]): void {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { worker: { type: "boolean", default: false } },
    strict: true,
    allowPositionals: true,
  });
  const store = open();
  try {
    process.stdout.write(brief(store, process.cwd(), positionals[0], values.worker === true));
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
      p.expired ? `自动沉淀后 ${PROPOSAL_EXPIRE_DAYS} 天未确认，已归档` : "",
      p.trigger ? `触发: ${p.trigger}` : "",
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
        values.sweep ? `代码核验: 转正 ${r.verify.verified}，与代码不符 ${r.verify.contradicted}，代码无法核验 ${r.verify.not_verifiable}，证据不足 ${r.verify.inconclusive}，出错 ${r.verify.errors}；过期归档 ${r.expired}` : "",
      ].filter(Boolean).join("\n"),
    );
  } finally {
    store.close();
  }
}

function fmtCounts(o: Record<string, number>): string {
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

function sedimentLines(store: Store): string[] {
  const now = new Date();
  const st = intake.stats(store.workDb, now);
  const props = [...store.project().props.values()];
  const auto = props.filter((p) => p.origin === "extract");
  const cfg = loadChatConfig(home());
  const r = st.receipts7d;
  const lastRetry = st.windows.nextRetry ? `，最早 ${new Date(st.windows.nextRetry).toLocaleString("zh-CN", { hour12: false })} 重试` : "";
  return [
    "沉淀（切片 3）:",
    `  会话: 已登记 ${st.sessions.total}，未登记目录 ${st.sessions.unregistered}，ephemeral ${st.sessions.ephemeral}；补登记历史会话（装 hook 前）${st.sessions.backfill}；近 7 天疑似漏登记 ${st.sessions.scanned}${st.sessions.scanned ? `（${fmtCounts(st.sessions.scannedByHost)}；hook 装好后开始的会话仍只能靠扫描登记，该宿主 hook 可能没生效，Codex 要在 /hooks 里信任）` : ""}；会话级错误 ${fmtCounts(st.sessions.errors)}`,
    `  窗口: 完成 ${st.windows.done}，延后 ${st.windows.deferred}${lastRetry}，失败 ${st.windows.failed}；未完成原因 ${fmtCounts(st.windows.errors)}`,
    `  今日预算: 调用 ${st.budget.calls}/${intake.DAILY_MAX_CALLS}，token ${st.budget.tokens}/${intake.DAILY_MAX_TOKENS}（其中 ${intake.VERIFY_RESERVED_CALLS} 次 / ${intake.VERIFY_RESERVED_TOKENS} token 留给代码核验）`,
    `  近 7 天: 候选 ${r.candidates}，提议 ${r.proposals}，附加来源 ${r.attached}，待确认纠正 ${r.corrections}，关系未判定 ${r.unreconciled}，跨会话印证 ${r.corroborated}，同窗口合并 ${r.merged}；丢弃整条候选 ${fmtCounts(r.dropped)}、单条证据 ${fmtCounts(r.evidence_dropped)}；剥掉注入/ab 输出 ${r.stripped}；脱敏命中 ${fmtCounts(r.sanitizer)}`,
    `  自动沉淀条目: 共 ${auto.length}，未确认 ${auto.filter((p) => !p.confirmed && p.state === "active").length}，代码核验转正 ${props.filter((p) => p.confirmed_by === "code").length}，跨会话印证转正 ${props.filter((p) => p.confirmed_by === "corroboration").length}，与代码不符 ${props.filter((p) => p.stale && p.state === "active").length}，过期归档 ${auto.filter((p) => p.expired).length}`,
    `  关系未判定积压（§9.4.4）: ${props.filter((p) => p.unreconciled && p.state === "active").length}`,
    `  抽取模型: ${"error" in cfg ? `不可用（${cfg.error}）` : `${cfg.model} @ ${hostOf(cfg.baseUrl)}（key: 钥匙串 ${cfg.keyService}）`}；上次运行 ${st.lastRun ?? "从未"}，上次成功 ${st.lastSuccess ?? "从未"}；租约被接管 ${st.leaseTakeovers} 次`,
  ];
}

function containsBrief(file: string): boolean {
  try {
    return readFileSync(file, "utf8").includes("ab brief");
  } catch {
    return false;
  }
}

function cmdStatus(): void {
  const cwd = process.cwd();
  const store = open();
  try {
    const here = resolveProject(cwd);
    const where = isRegistryHome(cwd) ? "pm（清单所在仓库）" : here ? `项目 ${here.name}` : "未登记目录";
    const found = detectHost();
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
    const userHome = homedir();
    const wires = [
      ["~/.claude/CLAUDE.md", join(userHome, ".claude/CLAUDE.md")],
      ["~/.codex/AGENTS.md", join(userHome, ".codex/AGENTS.md")],
      ["~/.pi/agent/AGENTS.md", join(userHome, ".pi/agent/AGENTS.md")],
      ["pm 仓库根 AGENTS.md", join(registryDir(), "..", "AGENTS.md")],
    ].map(([label, file]) => `${label}: ${containsBrief(file) ? "含 ab brief" : "没有 ab brief"}`);
    const { embedder, reason } = createEmbedder();
    const vectors = store.vectorStatus();
    const vectorLine = embedder
      ? `向量: ${embedder.model}，已向量化 ${vectors.model === embedder.model ? vectors.embedded : 0}/${vectors.total}`
      : `向量: 不可用（${reason}）`;

    console.log(
      [
        `目录: ${where}`,
        `宿主: ${!found.ok ? `宿主检测失败: ${found.error}` : found.detection ? `${found.detection.host}  会话 ${found.detection.session_id ?? "（未取得）"}  transcript ${found.detection.transcript ? "已找到" : "未找到"}` : "未检测到宿主"}`,
        `active: ${scopeLines.join("、") || "无"}`,
        vectorLine,
        `doctor: orphan 事件 ${proj.orphans}，ephemeral 证据 ${proj.ephemeral}，已清除 ${proj.purged}`,
        `接线: ${wires.join("；")}`,
        `清单: ${problems.length ? problems.join("；") : "全部可解析"}`,
        ...sedimentLines(store),
        ...(orphans.length ? [orphans.join("\n")] : []),
        `store: ${home()}`,
      ].join("\n"),
    );
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
  ab recall [--hook] [文本…]            每轮召回：当前项目的坑/规则/决定 + 标了 for_workers 的全局记忆
                                    --hook 从 stdin 读 {prompt,cwd}，命中时打一行 hook JSON
  ab search <关键词…> [--kind <种类>] [--project <项目名> | --all] [--archived]
  ab get <id 前缀> [--expand]       看一条：替代链、待确认的纠正、向量近邻；--expand 展开记下这条时的原始讨论
  ab confirm <id 前缀>
  ab archive <id 前缀> [--reactivate]
  ab status | ab doctor             当前项目、宿主、接线自检，沉淀积压、失败与转正
  ab capture --hook --host <claude|codex|pi>
                                    宿主 hook 用：从 stdin 登记会话坐标；SessionEnd 时拉起分离的 ab work
  ab capture <host>:<session_id> [--transcript <路径>] [--cwd <目录>] [--end]
                                    手动登记一个会话（hook 没生效时）
  ab work [--session <host>:<id> [--redo]] [--sweep] [--dry-run]
                                    处理已静置或已结束会话的新内容，自动沉淀为未确认记忆
                                    --redo 清掉该会话的处理进度从头重跑（已入库的候选不重复）
                                    --sweep 另扫描漏登记的会话、按代码核验未确认的坑、归档过期提议（launchd 每 30 分钟）`;

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
    if (cmd === "status" || cmd === "doctor") return cmdStatus();
    if (cmd === "capture") return await cmdCapture(rest);
    if (cmd === "work") return await cmdWork(rest);
  } catch (e) {
    if ((e as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) die(`${(e as Error).message}\n${USAGE}`);
    throw e;
  }
  die(`未知子命令: ${cmd}\n${USAGE}`);
}

await main();
