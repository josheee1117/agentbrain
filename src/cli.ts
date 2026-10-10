#!/usr/bin/env node
/**
 * agentbrain 命令行（设计 §7.1）：brief / remember / search / get / confirm / archive / status。
 * 预算类数字是代码常量（§2.2），零配置键。
 */
import { parseArgs } from "node:util";
import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Store, type PropKind, type Proposition } from "./store.ts";
import { expandSource, latestAnchor } from "./source.ts";
import { detectHost } from "./host.ts";
import type { Detection } from "./host.ts";
import { isRegistryHome, loadRegistry, registryDir, resolveProject } from "./registry.ts";

const BRIEF_MAX_CHARS = 2000;
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

function short(id: string): string {
  return id.slice(0, 8);
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
    const line = `- [${short(p.id)}] ${p.text.split(/\n+/).map((s) => s.trim()).filter(Boolean).join(" / ")}\n`;
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
  let pending = 0;

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
    pending += rules.filter((p) => !p.confirmed).length;
    pending += mine.filter((p) => (p.kind === "pitfall" || p.kind === "rule") && !p.confirmed).length;
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
    pending += global.filter((p) => (p.kind === "rule" || p.kind === "pitfall") && !p.confirmed).length;
    sections.push({ title: "全局规则与坑（最近在前）：", rows: global.filter((p) => p.confirmed), kinds: ["rule", "pitfall"] });
    const idByName = new Map(store.listProjects().map((p) => [p.name, p.id]));
    const overview = loadRegistry()
      .filter((e) => e.path)
      .map((e) => {
        const mine = all.filter((x) => x.project_id === idByName.get(e.name));
        pending += mine.filter((x) => !x.confirmed).length;
        return `- ${e.name}：${counts(mine.filter((x) => x.confirmed))}`;
      });
    if (overview.length) after.push("各项目概况：\n" + overview.join("\n"));
    noteFor = (n) => `全局还有 ${n} 条放不下，用 ab search --all 查。`;
  } else if (project) {
    const pid = projectIdByName(store, project.name);
    const mine = all.filter((p) => p.project_id === pid);
    head = `<agentbrain project="${project.name}">`;
    pending += global.filter((p) => (p.kind === "rule" || p.kind === "pitfall") && !p.confirmed).length;
    pending += mine.filter((p) => !p.confirmed).length;
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
    pending += global.filter((p) => (p.kind === "rule" || p.kind === "pitfall") && !p.confirmed).length;
    sections.push({ title: "全局规则与坑：", rows: global.filter((p) => p.confirmed), kinds: ["rule", "pitfall"] });
  }

  const tails = [
    worker
      ? "你是被派活的子代理：不写记忆，新坑写进汇报，由主会话决定是否记下。搜索用 ab search，看一条用 ab get。"
      : "记住用 ab remember，搜索用 ab search，看一条用 ab get。",
  ];
  if (pending && !worker) tails.push(`另有 ${pending} 条 agent 自记未确认（ab search 可见），用户认可后 ab confirm <id>。`);

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

function cmdRemember(argv: string[]): void {
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
    const transcript = det?.transcript ?? null;
    const anchor = det && transcript ? latestAnchor(det.host, transcript) : null;
    const id = store.remember(projectId, det?.session_id ?? null, false, {
      kind,
      text: values.text,
      why: values.why,
      for_workers: values["for-workers"] || undefined,
      confirmed: values.confirmed === true,
      source: { host: det?.host ?? null, session_id: det?.session_id ?? null, transcript, anchor, summary: values.summary },
    });
    let out = `已记住 [${short(id)}] ${KIND_LABEL[kind]}: ${values.text}`;
    if (transcript === null) out += "\n未找到会话记录，这条记忆没有可展开的来源。";
    if (!values.confirmed) out += `\n未确认：不进 brief，用户认可后 ab confirm ${short(id)}`;
    console.log(out);
  } finally {
    store.close();
  }
}

function cmdSearch(argv: string[]): void {
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
    const hits = store.search(query, {
      projects,
      includeGlobal,
      kind: values.kind as PropKind | undefined,
      includeArchived: values.archived,
    });
    if (!hits.length) {
      console.log("没有匹配的记忆。");
      return;
    }
    const props = store.project().props;
    for (const h of hits) {
      const p = props.get(h.id);
      const scope = p ? SCOPE_LABEL(p, names) : "未知";
      const mark = p && !p.confirmed ? "[未确认]" : "";
      console.log(`[${short(h.id)}] ${scope} ${KIND_LABEL[h.kind]}${mark}: ${h.text.split("\n")[0]}`);
    }
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
    const linesOut = [
      `[${short(p.id)}] ${SCOPE_LABEL(p, namesOf(store))} ${KIND_LABEL[p.kind]}${p.state === "archived" ? "（已归档）" : ""}${p.confirmed ? "" : " 未确认（agent 自记）"}: ${p.text}`,
      p.why ? `为什么: ${p.why}` : "",
      `来源: ${p.source.summary}（${p.source.host ?? "未知宿主"}）${p.source.transcript ? "" : "（无 transcript）"}  记录于 ${p.ts.slice(0, 10)}`,
    ].filter(Boolean);
    if (values.expand) {
      const disc = expandSource(p.source);
      linesOut.push("", "--- 当时的讨论 ---", disc ? disc : "来源不可用：transcript 不存在或定位点失效。");
    }
    console.log(linesOut.join("\n"));
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

    console.log(
      [
        `目录: ${where}`,
        `宿主: ${!found.ok ? `宿主检测失败: ${found.error}` : found.detection ? `${found.detection.host}  会话 ${found.detection.session_id ?? "（未取得）"}  transcript ${found.detection.transcript ? "已找到" : "未找到"}` : "未检测到宿主"}`,
        `active: ${scopeLines.join("、") || "无"}`,
        `doctor: orphan 事件 ${proj.orphans}，ephemeral 证据 ${proj.ephemeral}，已清除 ${proj.purged}`,
        `接线: ${wires.join("；")}`,
        `清单: ${problems.length ? problems.join("；") : "全部可解析"}`,
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
                                    默认记到当前目录所属项目；--global 记全局；--for-workers 让子代理也看到这条全局规则
                                    --confirmed 用户明确要求记的才加；不加则不进 brief
  ab search <关键词…> [--kind <种类>] [--project <项目名> | --all] [--archived]
  ab get <id 前缀> [--expand]       --expand 展开记下这条时的原始讨论
  ab confirm <id 前缀>
  ab archive <id 前缀> [--reactivate]
  ab status                         当前项目、宿主、接线自检`;

function main(): void {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "help" || rest.includes("--help") || rest.includes("-h") || cmd === "--help" || cmd === "-h") {
    console.log(USAGE);
    return;
  }
  try {
    if (cmd === "brief") return cmdBrief(rest);
    if (cmd === "remember") return cmdRemember(rest);
    if (cmd === "search") return cmdSearch(rest);
    if (cmd === "get") return cmdGet(rest);
    if (cmd === "confirm") return cmdConfirm(rest);
    if (cmd === "archive") return cmdArchive(rest);
    if (cmd === "status") return cmdStatus();
  } catch (e) {
    if ((e as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) die(`${(e as Error).message}\n${USAGE}`);
    throw e;
  }
  die(`未知子命令: ${cmd}\n${USAGE}`);
}

main();
