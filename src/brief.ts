/** ab brief（设计 §7.1）：开工时注入的全局规则 + 当前项目的坑与规则。只拼文本，不写 stdout、不退出进程。 */
import type { Store } from "./store.ts";
import type { PropKind, Proposition } from "./l2.ts";
import { isRegistryHome, loadRegistry, resolveProject } from "./registry.ts";
import { active, disputed, projectIdByName, short } from "./present.ts";

export const BRIEF_MAX_CHARS = 2000;

/** 用法错误（项目名不在清单、--worker 不在项目里）：CLI 打到 stderr 并以 1 退出。 */
export class BriefError extends Error {}

// ---------- brief ----------

function counts(list: Proposition[]): string {
  const n = (k: PropKind) => list.filter((p) => p.kind === k).length;
  return `坑 ${n("pitfall")}、规则 ${n("rule")}、决定 ${n("decision")}`;
}

/** 换行（含连续空白行）压成 " / "，不丢后半段。放不下的整条不放，计入 hidden。 */
function lines(list: Proposition[], kinds: PropKind[], budget: number, used: string[]): { text: string; hidden: number } {
  const rows = list.filter((p) => kinds.includes(p.kind)).sort((a, b) => b.seq - a.seq);
  let text = "";
  let shown = 0;
  for (const p of rows) {
    const line = `- [${short(p.id)}] ${p.text.split(/\n+/).map((s) => s.trim()).filter(Boolean).join(" / ")}${disputed(p)}\n`;
    if (text.length + line.length > budget) continue;
    text += line;
    used.push(p.id);
    shown++;
  }
  return { text, hidden: rows.length - shown };
}

const CLOSE = "\n</agentbrain>\n";

/** 什么时候该先搜（§11.5 (i)，2026-10-16 用户批准）。算在固定部分里：超预算时先截条目，不截这行。主会话和子代理都给。 */
export const SEARCH_HINT = "遇到这几类情况先 ab search <关键词> 再动手：用户提到\"上次/之前/我们定过\"；要改不熟悉的模块或配置；报错看不出原因；要做设计取舍。看一条的来龙去脉用 ab get。";

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

/** used（可选）收集实际输出的条目 id，供到期复审记"最近被注入"。 */
export function brief(store: Store, cwd: string, projectName: string | undefined, worker: boolean, used: string[] = []): string {
  const all = active(store);
  const global = all.filter((p) => p.project_id === null);
  const pending: Proposition[] = [];

  const named = projectName ? loadRegistry().find((e) => e.name === projectName) : undefined;
  if (projectName && !named) throw new BriefError(`清单里没有项目: ${projectName}`);
  const here = resolveProject(cwd);
  const project = named ? { name: named.name } : here;
  const inPm = isRegistryHome(cwd);

  let head = "";
  const before: string[] = [];
  const after: string[] = [];
  const sections: { title: string; rows: Proposition[]; kinds: PropKind[] }[] = [];
  let noteFor = (n: number) => `还有 ${n} 条放不下，用 ab search 查。`;

  if (worker) {
    if (!project) throw new BriefError("--worker 需要已登记项目：在项目目录里运行，或给出项目名");
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
      ? `你是被派活的子代理：不写记忆，后台会从会话里自动抽取。\n${SEARCH_HINT}`
      : `干活时不用记记忆，后台会从会话里自动抽取并审稿；只有用户明确要你记时才用 ab remember --confirmed。\n${SEARCH_HINT}`,
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
    const got = lines(s.rows, s.kinds, budgets[i] ?? 0, used);
    hidden += got.hidden;
    if (got.text) body.push(s.title + "\n" + got.text.trimEnd());
  });
  const note = hidden ? noteFor(hidden) : "";
  const parts = [head, ...before, ...body, ...after, ...(note ? [note] : []), ...tails];
  let out = parts.filter(Boolean).join("\n") + CLOSE;
  if (out.length > BRIEF_MAX_CHARS) out = out.slice(0, BRIEF_MAX_CHARS - 40) + "\n…已截断，用 ab search 查。\n</agentbrain>\n";
  return out;
}
