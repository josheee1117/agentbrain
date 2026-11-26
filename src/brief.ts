/** ab brief（设计 §7.1）：开工时注入的全局规则 + 当前项目的坑与规则。只拼文本，不写 stdout、不退出进程。 */
import type { Store } from "./store.ts";
import { SCENES, type PropKind, type Proposition, type Scene } from "./l2.ts";
import { isRegistryHome, loadRegistry, resolveProject } from "./registry.ts";
import { active, disputed, short, stalePrefix, TRUST_LABEL } from "./present.ts";
import { staleBlocked, staleWarning } from "./visibility.ts";
import { reviewList } from "./expiry.ts";
import { BriefError, briefInboxBlock } from "./inbox.ts";

export { BriefError };

export const BRIEF_MAX_CHARS = 2000;
/** 场景段的单独预算（§11.10，写死的常量；整个 brief 的上限是两段之和）。 */
export const BRIEF_SCENE_MAX_CHARS = 2000;

const SCENE_LABEL: Record<Scene, string> = { design: "设计", code: "开发", review: "review" };
/** 场景段标题与“放不下”提示的预留字符（只在有场景规则时从通用段预算里扣）。 */
const SCENE_OVERHEAD_RESERVE = 80;
/** 规则段落较多时至少保留的基础字符预算，避免高信号待拍板展开把规则段挤死。 */
const MIN_RULES_BUDGET = 400;

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
    // §12.6.7 T1：不是用户确认的条目标出转正来源；没标的就是用户确认过的（见 TRUST_LEGEND）
    const trust = p.confirmed_by && p.confirmed_by !== "user" ? `（${TRUST_LABEL[p.confirmed_by]}）` : "";
    const line = `- [${short(p.id)}] ${stalePrefix(p)}${p.text.split(/\n+/).map((s) => s.trim()).filter(Boolean).join(" / ")}${trust}${disputed(p)}\n`;
    if (text.length + line.length > budget) continue;
    text += line;
    used.push(p.id);
    shown++;
  }
  return { text, hidden: rows.length - shown };
}

const CLOSE = "\n</agentbrain>\n";

/** 只在范围里有自动转正的条目时才多这一行（算进固定预算，所以尽量短；哪种来源出现了才解释哪种）。 */
export function trustLegend(rows: readonly Proposition[]): string | null {
  const code = rows.some((p) => p.confirmed_by === "code");
  const corr = rows.some((p) => p.confirmed_by === "corroboration");
  if (!code && !corr) return null;
  return `没标注的条目是用户确认过的${code ? "；标（代码核验）的由模型核对代码后转正，没有人确认过" : ""}${corr ? "；标（跨会话印证）的是用户在多个会话里说过" : ""}。`;
}

/** 冲突汇总（§8.13.7）：只数与本次 brief 范围（全局 + 当前项目）有关的冲突对，
 *  报对数和最老天数，不查 inject_log（那是 ab status 的事，brief 每轮都跑，不为它多打数据库）。 */
export function conflictReminder(store: Store, projectName: string | undefined, now: Date = new Date()): string | null {
  const proj = store.project();
  if (!proj.conflict_pairs.length) return null;
  const pid = projectName ? store.listProjects().find((p) => p.name === projectName)?.id : undefined;
  const inScope = (id: string): boolean => {
    const p = proj.props.get(id);
    if (!p) return false;
    if (p.project_id === null) return true;
    return pid !== undefined && p.project_id === pid;
  };
  let n = 0;
  let oldest = 0;
  for (const pair of proj.conflict_pairs) {
    if (!pair.ids.some(inScope)) continue;
    n++;
    oldest = Math.max(oldest, Math.floor((now.getTime() - Date.parse(pair.ts)) / 86_400_000));
  }
  if (!n) return null;
  return `冲突 ${n} 对未解决（最老 ${oldest} 天）：ab get 看双方，ab archive 错的一条；ab inbox --kind conflict 看清单。`;
}

/** 到期复审汇总（§8.14）：只数与本次 brief 范围有关的到期未确认条目。
 *  用 ownClock（默认时钟，只看条目自身字段，不读 transcript 文件），brief 每轮都跑不能为它还文件。 */
export function expiryReminder(store: Store, projectName: string | undefined, now: Date = new Date()): string | null {
  const proj = store.project();
  const pid = projectName ? store.listProjects().find((p) => p.name === projectName)?.id : undefined;
  const inScope = (id: string): boolean => {
    const p = proj.props.get(id);
    if (!p) return false;
    if (p.project_id === null) return true;
    return pid !== undefined && p.project_id === pid;
  };
  const due = reviewList(proj.props.values(), store.usage(), now).filter((d) => inScope(d.prop.id));
  if (!due.length) return null;
  const oldest = Math.max(...due.map((d) => d.overdueDays));
  return `到期未复审 ${due.length} 条（最老超期 ${oldest} 天）：ab review 看清单，ab confirm 留用，ab review --archive 归档。`;
}

export function staleReminder(store: Store, projectName: string | undefined, worker = false): string | null {
  const pid = projectName ? store.listProjects().find(p => p.name === projectName)?.id : undefined;
  const n = active(store).filter(p => staleWarning(p) && (p.project_id === null
    ? !worker || (p.for_workers && p.kind === "rule")
    : p.project_id === pid && (!worker || p.kind === "rule" || p.kind === "pitfall"))).length;
  return n ? `与代码不符 ${n} 条（待用户核实）：ab inbox --kind stale 看清单，ab verify <id> 重核，ab confirm <id> 保留。` : null;
}

function fitInboxBlock(inbox: string, cap: number): string | null {
  if (inbox.length <= cap) return inbox;
  const rows = inbox.split("\n");
  if (rows.length < 2) return null;
  const kept = [rows[0]];
  let len = rows[0].length;
  for (let i = 1; i < rows.length; i++) {
    if (len + 1 + rows[i].length > cap) break;
    kept.push(rows[i]);
    len += 1 + rows[i].length;
  }
  return kept.length > 1 ? kept.join("\n") : null;
}

/** 什么时候该先搜（§11.5 (i)，2026-10-16 用户批准）。算在固定部分里：超预算时先截条目，不截这行。主会话和子代理都给。 */
export const SEARCH_HINT = "遇到这几类情况先 ab search <关键词> 再动手：用户提到\"上次/之前/我们定过\"；要改不熟悉的模块或配置；报错看不出原因；要做设计取舍。看一条的来龙去脉用 ab get。";

/** 正文预算 = 上限减掉开头、各段标题、结尾提示。各段再按原比例（均分）分。 */
function contentBudgets(fixed: string[], titles: string[], cap = BRIEF_MAX_CHARS): number[] {
  const n = fixed.length + titles.length;
  const fixedLen =
    fixed.reduce((s, p) => s + p.length, 0) +
    titles.reduce((s, t) => s + t.length + 1, 0) +
    Math.max(0, n - 1) +
    CLOSE.length;
  const total = Math.max(0, cap - fixedLen);
  const each = titles.length ? Math.floor(total / titles.length) : 0;
  return titles.map(() => each);
}

/** used（可选）收集实际输出的条目 id，供到期复审记"最近被注入"。scenes 是 --scene 给的场景（§11.10）。 */
export function brief(store: Store, cwd: string, projectName: string | undefined, worker: boolean, used: string[] = [], scenes: Scene[] = []): string {
  const all = active(store).filter(p => !staleBlocked(p) && !p.superseded_draft);
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
  // 场景筛选前先定范围（§11.10）：这里放范围内所有规则（含未确认与带场景的）。
  let scopeRules: Proposition[] = [];
  let noteFor = (n: number) => `还有 ${n} 条放不下，用 ab search 查。`;

  if (worker) {
    if (!project) throw new BriefError("--worker 需要已登记项目：在项目目录里运行，或给出项目名");
    const pid = store.ensureProject(project.name);
    const mine = all.filter((p) => p.project_id === pid);
    head = `<agentbrain project="${project.name}" worker>`;
    const rules = global.filter((p) => p.kind === "rule" && p.for_workers);
    scopeRules = [...rules, ...mine.filter((p) => p.kind === "rule")];
    pending.push(...rules.filter((p) => !p.confirmed));
    pending.push(...mine.filter((p) => (p.kind === "pitfall" || p.kind === "rule") && !p.confirmed));
    sections.push(
      { title: "全局规则（子代理也要看）：", rows: rules.filter((p) => p.confirmed && !p.scenes.length), kinds: ["rule"] },
      {
        title: `${project.name} 的坑与规则（最近在前；与现场证据冲突时信现场）：`,
        rows: mine.filter((p) => p.confirmed && !p.scenes.length),
        kinds: ["pitfall", "rule"],
      },
    );
  } else if ((inPm && !projectName) || (!project && !projectName && inPm)) {
    head = '<agentbrain scope="pm">';
    scopeRules = global.filter((p) => p.kind === "rule");
    pending.push(...global.filter((p) => (p.kind === "rule" || p.kind === "pitfall") && !p.confirmed));
    sections.push({ title: "全局规则与坑（最近在前）：", rows: global.filter((p) => p.confirmed && !p.scenes.length), kinds: ["rule", "pitfall"] });
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
    const pid = store.ensureProject(project.name);
    const mine = all.filter((p) => p.project_id === pid);
    head = `<agentbrain project="${project.name}">`;
    scopeRules = [...global.filter((p) => p.kind === "rule"), ...mine.filter((p) => p.kind === "rule")];
    pending.push(...global.filter((p) => (p.kind === "rule" || p.kind === "pitfall") && !p.confirmed));
    pending.push(...mine.filter((p) => !p.confirmed));
    sections.push(
      { title: "全局规则与坑：", rows: global.filter((p) => p.confirmed && !p.scenes.length), kinds: ["rule", "pitfall"] },
      {
        title: `${project.name} 的坑与规则（最近在前；与现场证据冲突时信现场）：`,
        rows: mine.filter((p) => p.confirmed && !p.scenes.length),
        kinds: ["pitfall", "rule"],
      },
    );
    const decisions = mine.filter((p) => p.kind === "decision" && p.confirmed).length;
    const notes = mine.filter((p) => p.kind === "note" && p.confirmed).length;
    after.push(`决定 ${decisions} 条、事实 ${notes} 条：用 ab search 查，ab get 看当时的讨论。`);
  } else {
    head = '<agentbrain scope="unregistered">';
    scopeRules = global.filter((p) => p.kind === "rule");
    before.push("当前目录不是已登记项目，只给出全局记忆。");
    pending.push(...global.filter((p) => (p.kind === "rule" || p.kind === "pitfall") && !p.confirmed));
    sections.push({ title: "全局规则与坑：", rows: global.filter((p) => p.confirmed && !p.scenes.length), kinds: ["rule", "pitfall"] });
  }

  const inScopeRules = scopeRules.filter((p) => p.confirmed);
  const sceneTitle = scenes.length ? `场景规则（${scenes.map((s) => SCENE_LABEL[s]).join("、")}）：` : "";
  const sceneRows = scenes.length ? inScopeRules.filter((p) => p.scenes.some((s) => scenes.includes(s))) : [];
  if (scenes.length) head = head.slice(0, -1) + ` scene="${scenes.join(",")}">`;
  else {
    // 没给场景时只多一行索引（同一范围计数；0 条的场景不列）
    const per = SCENES.map((s) => [SCENE_LABEL[s], inScopeRules.filter((p) => p.scenes.includes(s)).length] as const).filter(([, n]) => n > 0);
    if (per.length) before.push(`场景规则：${per.map(([label, n]) => `${label} ${n}`).join(" / ")} 条；进入该场景先 ab search --scene <场景>`);
  }

  const tails = [
    worker
      ? `你是被派活的子代理：不写记忆，后台会从会话里自动抽取。\n${SEARCH_HINT}`
      : `干活时不用记记忆，后台会从会话里自动抽取；只有用户明确要你记时才用 ab remember --confirmed。\n${SEARCH_HINT}`,
  ];
  const auto = pending.filter((p) => p.origin === "extract" || p.origin === "auto").length;
  if (pending.length && !worker)
    tails.push(
      auto
        ? `另有 ${pending.length} 条未确认（其中自动沉淀 ${auto} 条，ab search 可见）。用户明确说认可才执行 ab confirm <id>，不要自己确认。`
        : `另有 ${pending.length} 条 agent 自记未确认（ab search 可见）。用户明确说认可才执行 ab confirm <id>，不要自己确认。`,
    );

  const legend = trustLegend([...sections.flatMap((s) => s.rows.filter((p) => s.kinds.includes(p.kind))), ...sceneRows]);
  if (legend) before.push(legend);
  const candidates = sections.reduce((n, s) => n + s.rows.filter((p) => s.kinds.includes(p.kind)).length, 0);
  const noteReserve = candidates > 0 ? noteFor(candidates) : "";
  // 冲突提醒和到期摘要算进固定预算，跟 SEARCH_HINT 同级：超预算时先截条目，不截这行（§8.13.7、§8.14）。
  const conflict = conflictReminder(store, project?.name);
  if (conflict) tails.push(conflict);
  const expiry = expiryReminder(store, project?.name);
  if (expiry) tails.push(expiry);
  const stale = staleReminder(store, project?.name, worker);
  if (stale) tails.push(stale);
  // 场景段有单独预算；标题和提示的字符从通用段预算里扣，两段加起来不超总上限。
  const sceneReserve = sceneRows.length ? sceneTitle.length + 1 + SCENE_OVERHEAD_RESERVE : 0;
  const titles = sections.map((s) => s.title);
  const baseFixed = [head, ...before, ...after, ...(noteReserve ? [noteReserve] : []), ...tails];
  if (!worker) {
    const inbox = briefInboxBlock(store, project?.name, inPm && !projectName);
    if (inbox) {
      const baseAvail = contentBudgets(baseFixed, titles, BRIEF_MAX_CHARS - sceneReserve).reduce((a, b) => a + b, 0);
      const minRules = sections.length ? Math.min(MIN_RULES_BUDGET, Math.floor(baseAvail / 2)) : 0;
      const inboxCap = Math.max(0, baseAvail - minRules - 1);
      const fitted = fitInboxBlock(inbox, inboxCap);
      if (fitted) tails.push(fitted);
    }
  }
  const budgets = contentBudgets(
    [head, ...before, ...after, ...(noteReserve ? [noteReserve] : []), ...tails],
    titles,
    BRIEF_MAX_CHARS - sceneReserve,
  );
  let hidden = 0;
  const body: string[] = [];
  sections.forEach((s, i) => {
    const got = lines(s.rows, s.kinds, budgets[i] ?? 0, used);
    hidden += got.hidden;
    if (got.text) body.push(s.title + "\n" + got.text.trimEnd());
  });
  let sceneNote = "";
  if (sceneRows.length) {
    const got = lines(sceneRows, ["rule"], Math.max(0, BRIEF_SCENE_MAX_CHARS - sceneTitle.length - 1 - SCENE_OVERHEAD_RESERVE), used);
    if (got.text) body.push(sceneTitle + "\n" + got.text.trimEnd());
    if (got.hidden) sceneNote = `场景还有 ${got.hidden} 条放不下，用 ab search --scene ${scenes.join(",")} 查。`;
  }
  const note = hidden ? noteFor(hidden) : "";
  const parts = [head, ...before, ...body, ...after, ...(note ? [note] : []), ...(sceneNote ? [sceneNote] : []), ...tails];
  const max = BRIEF_MAX_CHARS + (sceneRows.length ? BRIEF_SCENE_MAX_CHARS : 0);
  let out = parts.filter(Boolean).join("\n") + CLOSE;
  if (out.length > max) out = out.slice(0, max - 40) + "\n…已截断，用 ab search 查。\n</agentbrain>\n";
  // markUsed / inject_log 只记最终真出现的条目（硬截断兜底时可能丢掉尾部几条）
  const kept = used.filter((id) => out.includes(`- [${short(id)}]`));
  used.length = 0;
  used.push(...kept);
  return out;
}
