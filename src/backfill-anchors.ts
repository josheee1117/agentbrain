import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolveTrunkRef } from "./changeverify.ts";
import { ANCHORS_MAX, checkTagBody, normalizeAnchor, parseAnchor, type Proposition } from "./l2.ts";
import { parseJsonLoose, type Chat, type ChatMessage } from "./llm.ts";
import type { RegistryEntry } from "./registry.ts";
import type { Store } from "./store.ts";

export const MAX_PROMPT_FILES = 800;
const DEFAULT_BATCH_SIZE = 40;

export interface DecisionCandidate {
  prop: Proposition;
  project: string;
}

export interface BackfillProjectSummary {
  project: string;
  trunkRef: string | null;
  head: string | null;
  candidate_count: number;
  anchored_count: number;
  empty_count: number;
  dropped_invalid_count: number;
}

export interface BackfillItem {
  id: string;
  short_id: string;
  project: string;
  head: string | null;
  text: string;
  why?: string;
  anchors: string[];
  dropped: string[];
  reason: string;
}

export interface BackfillPlan {
  generated_at: string;
  projects: BackfillProjectSummary[];
  items: BackfillItem[];
}

export interface ApplyBackfillResult {
  applied: number;
  skipped: number;
  dryRun: boolean;
  details: { id: string; status: "applied" | "skipped" | "dry_run"; reason?: string }[];
}

interface RepoTreeInfo {
  trunkRef: string | null;
  head: string | null;
  files: Set<string>;
  sortedFiles: string[];
}

const lexCompare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** 收集所有待补锚点的项目级活跃 decision（无 code_evidence、无 anchors、非 stale/草稿退场/demoted）。 */
export function collectDecisionCandidates(store: Store, _registry: RegistryEntry[], projectFilter?: string): DecisionCandidate[] {
  const names = new Map(store.listProjects().map((p) => [p.id, p.name]));
  const out: DecisionCandidate[] = [];
  for (const p of store.project().props.values()) {
    if (
      p.state !== "active" ||
      p.kind !== "decision" ||
      p.project_id === null ||
      (p.code_evidence && p.code_evidence.refs.length > 0) ||
      p.anchors.length > 0 ||
      p.stale ||
      p.superseded_draft ||
      p.demoted
    ) {
      continue;
    }
    const project = names.get(p.project_id);
    if (!project) continue;
    if (projectFilter && project !== projectFilter) continue;
    out.push({ prop: p, project });
  }
  out.sort((a, b) => lexCompare(a.project, b.project) || a.prop.seq - b.prop.seq);
  return out;
}

function loadRepoTree(entry: RegistryEntry | undefined): RepoTreeInfo {
  if (!entry?.path || !existsSync(entry.path)) {
    return { trunkRef: null, head: null, files: new Set(), sortedFiles: [] };
  }
  let trunk: { ref: string; sha: string } | null;
  try {
    trunk = resolveTrunkRef(entry.path, entry.trunk);
  } catch {
    return { trunkRef: null, head: null, files: new Set(), sortedFiles: [] };
  }
  if (!trunk) return { trunkRef: null, head: null, files: new Set(), sortedFiles: [] };
  const raw = execFileSync(
    "git",
    ["--literal-pathspecs", "-C", entry.path, "-c", "core.quotepath=false", "-c", "core.hooksPath=/dev/null", "--no-pager", "ls-tree", "-r", "--name-only", "-z", trunk.sha],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
  );
  const sortedFiles = raw.split("\0").filter(Boolean).sort(lexCompare);
  return { trunkRef: trunk.ref, head: trunk.sha, files: new Set(sortedFiles), sortedFiles };
}

function selectPromptFiles(sortedFiles: string[], batch: DecisionCandidate[]): string[] {
  if (sortedFiles.length <= MAX_PROMPT_FILES) return sortedFiles;
  const tokens = new Set<string>();
  for (const { prop } of batch) {
    const src = `${prop.text}\n${prop.why ?? ""}\n${prop.body ?? ""}`.toLowerCase();
    for (const part of src.split(/[^\p{L}\p{N}_.-]+/u)) {
      if (part.length >= 2) tokens.add(part);
    }
  }
  const scored = sortedFiles.map((path) => {
    const lower = path.toLowerCase();
    const base = lower.slice(lower.lastIndexOf("/") + 1);
    let score = 0;
    for (const t of tokens) {
      if (lower.includes(t)) score += base.includes(t) ? 3 : 1;
    }
    return { path, score };
  });
  scored.sort((a, b) => b.score - a.score || lexCompare(a.path, b.path));
  return scored.slice(0, MAX_PROMPT_FILES).map((s) => s.path);
}

const SYSTEM = `你是 agentbrain 的代码锚点标注助手。给定一个项目的一批「决定（decision）」记忆与该项目主干提交的真实文件路径清单，为每条决定挑选最直接相关的代码或契约文件路径（最多 ${ANCHORS_MAX} 个）。

规则：
1. 只能从给定的真实文件清单里选相对路径；若某条决定明确绑定另一个已知项目的文件，可写 "<项目名>:<相对路径>"。绝不编造不存在的路径。
2. 纯流程、团队习惯或没有对应代码文件的决定，anchors 返回空数组 []。
3. 只输出严格 JSON 对象：{"items":[{"id":"完整或8位前缀id","anchors":["相对路径"],"reason":"一句话依据"}]}`;

export async function buildBackfillPlan(opts: {
  store: Store;
  registry: RegistryEntry[];
  chat: Chat;
  project?: string;
  batchSize?: number;
  now?: Date;
}): Promise<BackfillPlan> {
  const batchSize = Math.max(1, opts.batchSize ?? DEFAULT_BATCH_SIZE);
  const now = opts.now ?? new Date();
  const candidates = collectDecisionCandidates(opts.store, opts.registry, opts.project);

  const byProject = new Map<string, DecisionCandidate[]>();
  for (const c of candidates) {
    const list = byProject.get(c.project) ?? [];
    list.push(c);
    byProject.set(c.project, list);
  }

  const trees = new Map<string, RepoTreeInfo>();
  const getTree = (repoName: string): RepoTreeInfo => {
    if (!trees.has(repoName)) {
      trees.set(repoName, loadRepoTree(opts.registry.find((e) => e.name === repoName)));
    }
    return trees.get(repoName)!;
  };

  const projects: BackfillProjectSummary[] = [];
  const items: BackfillItem[] = [];

  for (const projectName of [...byProject.keys()].sort(lexCompare)) {
    const projCandidates = byProject.get(projectName)!;
    const tree = getTree(projectName);
    let anchoredCount = 0;
    let emptyCount = 0;
    let droppedInvalidCount = 0;

    if (!tree.head || tree.files.size === 0) {
      for (const { prop } of projCandidates) {
        emptyCount++;
        items.push({
          id: prop.id,
          short_id: prop.id.slice(0, 8),
          project: projectName,
          head: null,
          text: prop.text,
          ...(prop.why ? { why: prop.why } : {}),
          anchors: [],
          dropped: [],
          reason: tree.head ? "仓库文件树为空" : "项目缺少可用本地主干提交",
        });
      }
      projects.push({
        project: projectName,
        trunkRef: tree.trunkRef,
        head: tree.head,
        candidate_count: projCandidates.length,
        anchored_count: anchoredCount,
        empty_count: emptyCount,
        dropped_invalid_count: droppedInvalidCount,
      });
      continue;
    }

    for (let i = 0; i < projCandidates.length; i += batchSize) {
      const batch = projCandidates.slice(i, i + batchSize);
      const promptFiles = selectPromptFiles(tree.sortedFiles, batch);
      const knownRepos = opts.registry.map((e) => e.name).sort(lexCompare);
      const userPrompt = [
        `项目：${projectName}（主干 ${tree.trunkRef ?? "HEAD"} @${tree.head.slice(0, 10)}）`,
        `已知项目名：${knownRepos.join("、") || projectName}`,
        "",
        `项目文件清单（共 ${tree.sortedFiles.length} 个，列出 ${promptFiles.length} 个）：`,
        ...promptFiles.map((f) => `- ${f}`),
        "",
        "待标注决定：",
        ...batch.map(({ prop }) =>
          JSON.stringify({
            id: prop.id.slice(0, 8),
            text: prop.text,
            ...(prop.why ? { why: prop.why } : {}),
            ...(prop.body ? { body: prop.body.slice(0, 300) } : {}),
          }),
        ),
      ].join("\n");

      const messages: ChatMessage[] = [
        { role: "system", content: SYSTEM },
        { role: "user", content: userPrompt },
      ];
      const resp = await opts.chat(messages, { json: true });
      const parsed = parseJsonLoose(resp.message?.content ?? null) as { items?: unknown } | null;
      const rawItems = Array.isArray(parsed?.items) ? parsed.items : [];

      const suggestedById = new Map<string, { anchors: string[]; reason: string }>();
      for (const entry of rawItems) {
        if (!entry || typeof entry !== "object") continue;
        const rec = entry as { id?: unknown; anchors?: unknown; reason?: unknown };
        if (typeof rec.id !== "string" || !rec.id.trim()) continue;
        const key = rec.id.trim();
        const rawAnchors = Array.isArray(rec.anchors) ? rec.anchors.filter((a): a is string => typeof a === "string") : [];
        const reason = typeof rec.reason === "string" ? rec.reason.trim() : "";
        const matched = batch.filter((c) => c.prop.id === key || c.prop.id.startsWith(key));
        if (matched.length === 1) {
          suggestedById.set(matched[0].prop.id, { anchors: rawAnchors, reason });
        }
      }

      for (const { prop } of batch) {
        const suggestion = suggestedById.get(prop.id);
        const rawSuggested = suggestion?.anchors ?? [];
        const reason = suggestion?.reason ?? "模型未返回该条建议";
        const seen = new Set<string>();
        const valid: string[] = [];
        const dropped: string[] = [];

        for (const rawAnchor of rawSuggested) {
          let normalized: string;
          try {
            normalized = normalizeAnchor(rawAnchor);
          } catch {
            dropped.push(rawAnchor);
            continue;
          }
          const { repo, path } = parseAnchor(normalized);
          const targetTree = repo === null ? tree : getTree(repo);
          if (!targetTree.files.has(path)) {
            dropped.push(normalized);
            continue;
          }
          if (seen.has(normalized)) continue;
          if (valid.length >= ANCHORS_MAX) {
            dropped.push(normalized);
            continue;
          }
          seen.add(normalized);
          valid.push(normalized);
        }

        if (valid.length > 0) anchoredCount++;
        else emptyCount++;
        droppedInvalidCount += dropped.length;

        let itemHead: string | null = tree.head;
        if (valid.length > 0 && !valid.some((a) => { const r = parseAnchor(a).repo; return r === null || r === projectName; })) {
          const extRepos = [...new Set(valid.map((a) => parseAnchor(a).repo).filter((r): r is string => r !== null))];
          itemHead = extRepos.length === 1 ? getTree(extRepos[0]).head : null;
        }

        items.push({
          id: prop.id,
          short_id: prop.id.slice(0, 8),
          project: projectName,
          head: itemHead,
          text: prop.text,
          ...(prop.why ? { why: prop.why } : {}),
          anchors: valid,
          dropped,
          reason,
        });
      }
    }

    projects.push({
      project: projectName,
      trunkRef: tree.trunkRef,
      head: tree.head,
      candidate_count: projCandidates.length,
      anchored_count: anchoredCount,
      empty_count: emptyCount,
      dropped_invalid_count: droppedInvalidCount,
    });
  }

  return {
    generated_at: now.toISOString(),
    projects,
    items,
  };
}

export function renderBackfillMarkdown(plan: BackfillPlan): string {
  const totalCandidates = plan.projects.reduce((s, p) => s + p.candidate_count, 0);
  const totalAnchored = plan.projects.reduce((s, p) => s + p.anchored_count, 0);
  const totalEmpty = plan.projects.reduce((s, p) => s + p.empty_count, 0);
  const totalDropped = plan.projects.reduce((s, p) => s + p.dropped_invalid_count, 0);

  const lines: string[] = [
    "# 存量项目级决定补锚点预览单",
    "",
    `- 生成时间：${plan.generated_at}`,
    `- 总计：候选 ${totalCandidates} 条，拟补锚点 ${totalAnchored} 条，留空 ${totalEmpty} 条，剔除无效路径 ${totalDropped} 处`,
    "",
    "## 项目汇总",
    "",
    "| 项目 | 主干 | 提交 | 候选 | 拟补锚点 | 留空 | 剔除无效 |",
    "|---|---|---|---:|---:|---:|---:|",
    ...plan.projects.map(
      (p) =>
        `| ${p.project} | ${p.trunkRef ?? "-"} | ${p.head ? p.head.slice(0, 10) : "-"} | ${p.candidate_count} | ${p.anchored_count} | ${p.empty_count} | ${p.dropped_invalid_count} |`,
    ),
  ];

  for (const proj of plan.projects) {
    lines.push("", `## ${proj.project}`, "");
    const projItems = plan.items.filter((i) => i.project === proj.project);
    for (const it of projItems) {
      const anchorsText = it.anchors.length ? it.anchors.join("；") : "（无）";
      lines.push(`- \`[${it.short_id}]\` ${it.text}`);
      lines.push(`  - 锚点：${anchorsText}`);
      if (it.reason) lines.push(`  - 依据：${it.reason}`);
      if (it.dropped.length) lines.push(`  - 已剔除无效路径：${it.dropped.join("；")}`);
    }
  }
  return lines.join("\n") + "\n";
}

export function applyBackfillPlan(
  store: Store,
  plan: BackfillPlan,
  opts?: { project?: string; ids?: string[]; dryRun?: boolean },
): ApplyBackfillResult {
  const dryRun = opts?.dryRun === true;
  const idFilters = opts?.ids?.map((s) => s.trim()).filter(Boolean);
  const selected = plan.items.filter((item) => {
    if (!item.anchors.length) return false;
    if (opts?.project && item.project !== opts.project) return false;
    if (idFilters?.length && !idFilters.some((q) => item.id === q || item.id.startsWith(q))) return false;
    return true;
  });

  const check = (p: Proposition): string | null => {
    if (p.state !== "active") return `条目状态不是 active（${p.state}）`;
    if (p.anchors.length > 0) return "已有锚点";
    if ((p.code_evidence?.refs.length ?? 0) > 0) return "已有代码证据";
    return null;
  };

  let applied = 0;
  let skipped = 0;
  const details: ApplyBackfillResult["details"] = [];

  for (const item of selected) {
    const body = { anchors: item.anchors, ...(item.head ? { anchor_head: item.head } : {}) };
    if (dryRun) {
      checkTagBody(body);
      const p = store.project().props.get(item.id);
      const reason = p ? check(p) : "已不在库里";
      if (reason !== null) {
        skipped++;
        details.push({ id: item.id, status: "skipped", reason });
      } else {
        applied++;
        details.push({ id: item.id, status: "dry_run" });
      }
      continue;
    }
    const res = store.lifecycleIf("tag", item.id, null, body, check);
    if ("id" in res) {
      applied++;
      details.push({ id: item.id, status: "applied" });
    } else {
      skipped++;
      details.push({ id: item.id, status: "skipped", reason: res.skipped });
    }
  }

  return { applied, skipped, dryRun, details };
}
