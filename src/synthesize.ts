import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { RepoTools } from "./codeverify.ts";
import { resolveTrunkRef } from "./changeverify.ts";
import {
  ALTERNATIVES_MAX,
  ANCHORS_MAX,
  checkAnchors,
  checkRememberBody,
  parseAnchor,
  SCENES,
  type Alternative,
  type Origin,
  type PropKind,
  type Proposition,
  type RememberBody,
  type Scene,
  type SourcePointer,
} from "./l2.ts";
import { parseJsonLoose, promptVersion, type Chat, type ChatMessage } from "./llm.ts";
import type { RegistryEntry } from "./registry.ts";
import type { Store } from "./store.ts";

export const SYNTH_MAX_CANDIDATES = 3;
export const SYNTH_SPEC_MAX_CHARS = 24_000;
export const SYNTH_EXISTING_MAX = 40;
export const SYNTH_DRAFT_HINTS_MAX = 20;
export const SYNTH_KINDS = ["decision", "rule", "pitfall"] as const;
export type SynthKind = (typeof SYNTH_KINDS)[number];

const MAX_PROMPT_FILES = 800;
const MAX_DIFF_PATCH_CHARS = 8_000;
const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const SYSTEM = `你是 agentbrain 的需求收口综合沉淀助手。给定需求/方案/派活文档（spec）、仓库 git diff 与变更文件清单、仓内可验证文件清单，以及项目现有有效记忆，提炼本次真正落定、值得长期保留的新项目记忆（最多 ${SYNTH_MAX_CANDIDATES} 条，kind 取 "decision" | "rule" | "pitfall"）。

规则：
1. 只提炼明确落定且长期有效的三类结论，不记过程碎片、临时状态或与现有记忆同义重复的内容；没有值得长期保留的新结论时返回 {"candidates":[]}：
   - "decision"：落定的架构、契约、数据模型或关键工程取舍（可带 alternatives）；
   - "rule"：本次变更或复盘确立、后续改同类模块必须遵守的项目硬约束（可带 scenes，元素取自 design|code|test|review）；
   - "pitfall"：本次实锤暴露、换个任务改这片代码还会再踩的反直觉陷阱与防坑做法。
2. 每条候选必须至少带 1 个真实存在的代码或契约锚点（最多 ${ANCHORS_MAX} 个），只能从给定仓内文件清单挑选相对路径，或写成 "<已知项目名>:<相对路径>"，绝不编造不存在的路径。
3. 若本次定稿明确替代了现有记忆清单里的某条同项目条目，可将 supersedes 设为该条的 8 位短 id 或完整 id；否则省略或设为 null。
4. 只输出严格 JSON 对象：
{"candidates":[{"kind":"decision|rule|pitfall","text":"一句话说清结论","why":"为什么这样定或为什么会踩坑","scenes":[],"anchors":["相对路径"],"alternatives":[{"option":"否掉的方案","rejected_because":"原因"}],"supersedes":null}]}`;

export const SYNTH_PROMPT_VERSION = promptVersion(SYSTEM);

export interface SynthesizeCandidate {
  id: string | null;
  kind: SynthKind;
  text: string;
  why?: string;
  scenes?: Scene[];
  onDemand?: boolean;
  anchors: string[];
  anchorHead: string;
  alternatives?: Alternative[];
  supersedes?: string;
  confirmed: false;
  origin: "auto";
}

export interface SynthesizeSkipped {
  text: string;
  reason: string;
  droppedAnchors?: string[];
}

export interface DraftHint {
  id: string;
  shortId: string;
  kind: PropKind;
  origin: Origin;
  text: string;
  reasons: string[];
}

export interface SynthesizeResult {
  project: string;
  dryRun: boolean;
  head: string;
  diffBase: string | null;
  model: string;
  promptVersion: string;
  truncated: boolean;
  created: SynthesizeCandidate[];
  skipped: SynthesizeSkipped[];
  draftHints: DraftHint[];
  vectorWarning: string | null;
}

export interface SynthesizeOptions {
  store: Store;
  project: string;
  registry: RegistryEntry[];
  specs: string[];
  diffBase?: string;
  dryRun?: boolean;
  chat: Chat;
  model: string;
  source?: SourcePointer;
  updateVectors?: (store: Store) => Promise<string | null>;
}

const lexCompare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const normText = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[。；;，,！!？?：:]+$/u, "");

function optionalGit(tools: RepoTools, args: string[]): string | null {
  try {
    return tools.git(args).trim();
  } catch {
    return null;
  }
}

export function loadSpecs(paths: string[]): { text: string; truncated: boolean } {
  if (!paths.length) throw new Error("缺少 --spec <文件>");
  const sections: string[] = [];
  let hasContent = false;
  for (const path of paths) {
    let st;
    try {
      st = statSync(path);
    } catch {
      throw new Error(`找不到 spec 文件：${path}`);
    }
    if (!st.isFile()) throw new Error(`spec 不是普通文件：${path}`);
    const content = readFileSync(path, "utf8");
    if (content.trim().length > 0) hasContent = true;
    sections.push(`### ${path}\n${content.trim()}`);
  }
  if (!hasContent) throw new Error("--spec 文档内容为空");
  const combined = sections.join("\n\n");
  const chars = [...combined];
  if (chars.length <= SYNTH_SPEC_MAX_CHARS) return { text: combined, truncated: false };
  return { text: chars.slice(0, SYNTH_SPEC_MAX_CHARS).join(""), truncated: true };
}

function collectGitContext(entry: RegistryEntry, diffBase?: string): {
  head: string;
  diffBase: string | null;
  changedFiles: string[];
  diffStat: string;
  diffPatch: string;
  headFiles: Set<string>;
  sortedHeadFiles: string[];
} {
  if (!entry.path) throw new Error(`项目 ${entry.name} 没有本地仓库路径`);
  try {
    realpathSync(entry.path);
  } catch {
    throw new Error(`本地项目仓库不可用：${entry.path}`);
  }
  const tools = new RepoTools(entry.path);
  const head = tools.head();
  if (!head) throw new Error(`项目仓库无法解析 HEAD：${entry.path}`);

  let diffBaseLabel: string | null = null;
  let baseSha: string | null = null;
  if (diffBase !== undefined) {
    if (!diffBase || diffBase.startsWith("-") || /[\s\0]/.test(diffBase)) {
      throw new Error("不允许的 --diff-base ref");
    }
    baseSha = optionalGit(tools, ["rev-parse", "--verify", `${diffBase}^{commit}`]);
    if (!baseSha) throw new Error(`无法解析 --diff-base ${diffBase}`);
    diffBaseLabel = diffBase;
  } else {
    const trunk = resolveTrunkRef(entry.path, entry.trunk);
    if (trunk && trunk.sha !== head) {
      const mb = optionalGit(tools, ["merge-base", trunk.sha, head]);
      if (mb && mb !== head) {
        diffBaseLabel = mb === trunk.sha ? trunk.ref : `merge-base(${trunk.ref})`;
        baseSha = mb;
      } else if (mb === head) {
        const parent = optionalGit(tools, ["rev-parse", "--verify", "HEAD~1^{commit}"]);
        if (parent) {
          diffBaseLabel = "HEAD~1";
          baseSha = parent;
        } else {
          diffBaseLabel = trunk.ref;
          baseSha = EMPTY_TREE_SHA;
        }
      } else {
        diffBaseLabel = trunk.ref;
        baseSha = trunk.sha;
      }
    } else {
      const parent = optionalGit(tools, ["rev-parse", "--verify", "HEAD~1^{commit}"]);
      if (parent) {
        diffBaseLabel = "HEAD~1";
        baseSha = parent;
      } else {
        diffBaseLabel = trunk?.ref ?? null;
        baseSha = EMPTY_TREE_SHA;
      }
    }
  }

  const headFilesRaw = tools.git(["ls-tree", "-r", "--name-only", "-z", head]);
  const sortedHeadFiles = headFilesRaw.split("\0").filter(Boolean).sort(lexCompare);
  const headFiles = new Set(sortedHeadFiles);

  let changedFiles: string[] = [];
  let diffStat = "（无提交差异）";
  let diffPatch = "";
  if (baseSha && baseSha !== head) {
    changedFiles = tools
      .git(["diff", "--name-only", "-z", "--no-renames", baseSha, head])
      .split("\0")
      .filter(Boolean);
    diffStat = tools.git(["diff", "--stat", baseSha, head]).trim() || "（无提交差异）";
    try {
      const rawPatch = tools.git(["diff", "--unified=2", "--no-textconv", baseSha, head]);
      const patchChars = [...rawPatch];
      diffPatch =
        patchChars.length > MAX_DIFF_PATCH_CHARS
          ? patchChars.slice(0, MAX_DIFF_PATCH_CHARS).join("") + "\n…（diff 已截断）"
          : rawPatch;
    } catch (e) {
      const err = e as { code?: string; message?: string };
      if (err.code === "ENOBUFS" || /ENOBUFS|maxBuffer/i.test(err.message ?? "")) {
        diffPatch = "（diff 过大已略去正文，仅保留变更文件清单与 --stat）";
      } else {
        throw e;
      }
    }
  }

  return { head, diffBase: diffBaseLabel, changedFiles, diffStat, diffPatch, headFiles, sortedHeadFiles };
}

function selectPromptFiles(sortedFiles: string[], changedFiles: string[], specText: string): string[] {
  if (sortedFiles.length <= MAX_PROMPT_FILES) return sortedFiles;
  const changed = new Set(changedFiles);
  const out = sortedFiles.filter((f) => changed.has(f));
  if (out.length >= MAX_PROMPT_FILES) return out.slice(0, MAX_PROMPT_FILES);

  const tokens = new Set<string>();
  for (const part of specText.toLowerCase().split(/[^\p{L}\p{N}_.-]+/u)) {
    if (part.length >= 2) tokens.add(part);
  }
  const rest = sortedFiles
    .filter((f) => !changed.has(f))
    .map((path) => {
      const lower = path.toLowerCase();
      const base = lower.slice(lower.lastIndexOf("/") + 1);
      let score = 0;
      for (const t of tokens) {
        if (lower.includes(t)) score += base.includes(t) ? 3 : 1;
      }
      return { path, score };
    })
    .sort((a, b) => b.score - a.score || lexCompare(a.path, b.path));

  return [...out, ...rest.slice(0, MAX_PROMPT_FILES - out.length).map((x) => x.path)];
}

function collectDraftHints(projectActive: Proposition[]): DraftHint[] {
  const unconfirmed = projectActive.filter((p) => !p.confirmed);
  const priority = (p: Proposition) =>
    (p.superseded_draft ? 0 : p.origin === "extract" ? 1 : p.kind === "decision" ? 2 : 3);
  unconfirmed.sort((a, b) => priority(a) - priority(b) || b.seq - a.seq);

  return unconfirmed.slice(0, SYNTH_DRAFT_HINTS_MAX).map((p) => {
    const reasons: string[] = ["未确认"];
    if (p.origin === "extract") reasons.push("自动抽取草稿");
    if (p.superseded_draft) reasons.push("已被草稿替代");
    if (!p.anchors.length) reasons.push("缺代码锚点");
    if (!p.code_evidence?.refs.length) reasons.push("缺代码证据");
    if (p.unreconciled) reasons.push("关系未判定");
    return {
      id: p.id,
      shortId: p.id.slice(0, 8),
      kind: p.kind,
      origin: p.origin,
      text: p.text,
      reasons,
    };
  });
}

function resolveSupersedes(raw: unknown, projectId: string | null, allProps: Proposition[]): string | undefined {
  if (typeof raw !== "string" || !projectId) return undefined;
  const q = raw.trim();
  if (!q) return undefined;
  const matches = allProps.filter((p) => p.id === q || p.id.startsWith(q));
  if (matches.length !== 1) return undefined;
  const target = matches[0];
  if (target.project_id !== projectId || target.state !== "active") return undefined;
  return target.id;
}

function isDuplicateText(candText: string, existing: Proposition[], supersedesId: string | undefined, accepted: string[]): string | null {
  const candNorm = normText(candText);
  if (!candNorm) return "正文为空";
  for (const p of existing) {
    const existNorm = normText(p.text);
    if (!existNorm) continue;
    if (supersedesId === p.id) {
      if (existNorm === candNorm) return "与拟替代条目正文完全一致";
      continue;
    }
    if (existNorm === candNorm) return "与已有记忆重复";
    if (candNorm.length >= 8 && existNorm.length >= 8 && (existNorm.startsWith(candNorm) || candNorm.startsWith(existNorm))) {
      return "与已有记忆前缀高度重复";
    }
  }
  for (const prev of accepted) {
    if (prev === candNorm) return "与本批候选重复";
    if (candNorm.length >= 8 && prev.length >= 8 && (prev.startsWith(candNorm) || candNorm.startsWith(prev))) {
      return "与本批候选前缀重复";
    }
  }
  return null;
}

function loadRepoFilesCache(registry: RegistryEntry[], projectName: string, headFiles: Set<string>) {
  const cache = new Map<string, Set<string>>([[projectName, headFiles]]);
  return (repoName: string): Set<string> => {
    if (cache.has(repoName)) return cache.get(repoName)!;
    const entry = registry.find((e) => e.name === repoName);
    if (!entry?.path || !existsSync(entry.path)) {
      cache.set(repoName, new Set());
      return cache.get(repoName)!;
    }
    try {
      const tools = new RepoTools(entry.path);
      const sha = resolveTrunkRef(entry.path, entry.trunk)?.sha ?? tools.head();
      const files = sha
        ? new Set(tools.git(["ls-tree", "-r", "--name-only", "-z", sha]).split("\0").filter(Boolean))
        : new Set<string>();
      cache.set(repoName, files);
      return files;
    } catch {
      cache.set(repoName, new Set());
      return cache.get(repoName)!;
    }
  };
}

function filterValidAnchors(
  rawAnchors: string[],
  projectName: string,
  registry: RegistryEntry[],
  repoFiles: (repo: string) => Set<string>,
): { valid: string[]; dropped: string[] } {
  const kept: string[] = [];
  const dropped: string[] = [];
  const knownRepos = new Set(registry.map((e) => e.name));

  for (const raw of rawAnchors) {
    let normalized: string | undefined;
    try {
      normalized = checkAnchors([raw])?.[0];
    } catch {
      dropped.push(raw);
      continue;
    }
    if (!normalized) {
      dropped.push(raw);
      continue;
    }
    const { repo, path } = parseAnchor(normalized);
    if (repo === null || repo === projectName) {
      if (!repoFiles(projectName).has(path)) {
        dropped.push(normalized);
        continue;
      }
    } else if (!knownRepos.has(repo) || !repoFiles(repo).has(path)) {
      dropped.push(normalized);
      continue;
    }
    if (!kept.includes(normalized)) kept.push(normalized);
  }

  const deduped = checkAnchors(kept.slice(0, ANCHORS_MAX)) ?? [];
  if (kept.length > ANCHORS_MAX) {
    for (const extra of kept.slice(ANCHORS_MAX)) {
      dropped.push(extra);
    }
  }
  return { valid: deduped, dropped };
}

function parseAlternatives(raw: unknown): Alternative[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: Alternative[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as { option?: unknown; rejected_because?: unknown };
    if (typeof rec.option !== "string" || typeof rec.rejected_because !== "string") continue;
    const option = rec.option.trim();
    const rejected_because = rec.rejected_because.trim();
    if (!option || !rejected_because) continue;
    out.push({ option, rejected_because });
    if (out.length >= ALTERNATIVES_MAX) break;
  }
  return out.length ? out : undefined;
}

export async function synthesizeProject(opts: SynthesizeOptions): Promise<SynthesizeResult> {
  const dryRun = opts.dryRun === true;
  const entry = opts.registry.find((e) => e.name === opts.project);
  if (!entry) throw new Error(`未登记项目：${opts.project}`);

  const spec = loadSpecs(opts.specs);
  const gitCtx = collectGitContext(entry, opts.diffBase);

  const projectRow = opts.store.listProjects().find((p) => p.name === opts.project);
  const projectId = projectRow?.id ?? null;
  const allProps = [...opts.store.project().props.values()];
  const projectActive = projectId ? allProps.filter((p) => p.project_id === projectId && p.state === "active") : [];

  const existingForPrompt = projectActive
    .filter((p) => p.kind !== "note" && !p.superseded_draft)
    .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "decision" ? -1 : 1) || (a.confirmed === b.confirmed ? 0 : a.confirmed ? -1 : 1) || b.seq - a.seq)
    .slice(0, SYNTH_EXISTING_MAX);

  const draftHints = collectDraftHints(projectActive);
  const promptFiles = selectPromptFiles(gitCtx.sortedHeadFiles, gitCtx.changedFiles, spec.text);
  const knownRepos = opts.registry.map((e) => e.name).sort(lexCompare);

  const userPrompt = [
    `项目：${opts.project}（HEAD @${gitCtx.head.slice(0, 10)}，diff 基线：${gitCtx.diffBase ?? "初始提交"}）`,
    `已知项目名：${knownRepos.join("、") || opts.project}`,
    "",
    `需求/方案文档（${spec.truncated ? `已截断至 ${SYNTH_SPEC_MAX_CHARS} 字` : "完整"}）：`,
    spec.text,
    "",
    `变更文件（${gitCtx.changedFiles.length} 个）：`,
    ...(gitCtx.changedFiles.length ? gitCtx.changedFiles.map((f) => `- ${f}`) : ["（无）"]),
    "",
    "git diff --stat：",
    gitCtx.diffStat,
    ...(gitCtx.diffPatch ? ["", "git diff 摘要：", gitCtx.diffPatch] : []),
    "",
    `仓内可验证文件清单（共 ${gitCtx.sortedHeadFiles.length} 个，列出 ${promptFiles.length} 个）：`,
    ...promptFiles.map((f) => `- ${f}`),
    "",
    `项目现有有效记忆（列出 ${existingForPrompt.length} 条，供避免重复与填写 supersedes）：`,
    ...(existingForPrompt.length
      ? existingForPrompt.map((p) =>
          JSON.stringify({
            id: p.id.slice(0, 8),
            kind: p.kind,
            confirmed: p.confirmed,
            stale: !!p.stale,
            text: p.text,
            anchors: p.anchors,
          }),
        )
      : ["（暂无）"]),
  ].join("\n");

  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM },
    { role: "user", content: userPrompt },
  ];
  const resp = await opts.chat(messages, { json: true });
  const usedModel = resp.model ?? opts.model;
  const parsed = parseJsonLoose(resp.message?.content ?? null) as { candidates?: unknown; items?: unknown } | unknown[] | null;
  const rawList = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.candidates)
      ? parsed.candidates
      : Array.isArray(parsed?.items)
        ? parsed.items
        : null;
  if (!rawList) throw new Error("模型输出缺少 candidates 数组");

  const repoFiles = loadRepoFilesCache(opts.registry, opts.project, gitCtx.headFiles);
  const created: SynthesizeCandidate[] = [];
  const skipped: SynthesizeSkipped[] = [];
  const acceptedNorms: string[] = [];

  for (const [idx, raw] of rawList.entries()) {
    const rec = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
    const rawText = typeof rec?.text === "string" ? rec.text.trim() : "";
    if (idx >= SYNTH_MAX_CANDIDATES) {
      if (rawText) skipped.push({ text: rawText, reason: `超过单次上限 ${SYNTH_MAX_CANDIDATES} 条` });
      continue;
    }
    if (!rec || !rawText) {
      skipped.push({ text: rawText || "(空)", reason: "缺少有效 text" });
      continue;
    }
    const kindRaw = rec.kind === undefined ? "decision" : rec.kind;
    if (typeof kindRaw !== "string" || !(SYNTH_KINDS as readonly string[]).includes(kindRaw)) {
      skipped.push({ text: rawText, reason: `仅沉淀 decision/rule/pitfall 类型（收到 ${String(rec.kind)}）` });
      continue;
    }
    const kind = kindRaw as SynthKind;

    const supersedesId = resolveSupersedes(rec.supersedes, projectId, allProps);
    const dupReason = isDuplicateText(rawText, projectActive, supersedesId, acceptedNorms);
    if (dupReason) {
      skipped.push({ text: rawText, reason: dupReason });
      continue;
    }

    const rawAnchors = Array.isArray(rec.anchors) ? rec.anchors.filter((a): a is string => typeof a === "string") : [];
    const { valid: validAnchors, dropped: droppedAnchors } = filterValidAnchors(rawAnchors, opts.project, opts.registry, repoFiles);
    if (!validAnchors.length) {
      skipped.push({
        text: rawText,
        reason: "缺少有效代码锚点",
        ...(droppedAnchors.length ? { droppedAnchors } : {}),
      });
      continue;
    }

    const why = typeof rec.why === "string" && rec.why.trim() ? rec.why.trim() : undefined;
    const alternatives = kind === "decision" ? parseAlternatives(rec.alternatives) : undefined;
    const scenes = kind === "rule" && Array.isArray(rec.scenes)
      ? [...new Set(rec.scenes.filter((s): s is Scene => typeof s === "string" && (SCENES as readonly string[]).includes(s)))]
      : [];
    const onDemand = kind !== "decision";
    const source: SourcePointer = opts.source ?? {
      host: null,
      session_id: null,
      transcript: null,
      anchor: null,
      summary: "ab synthesize 需求收口综合沉淀",
    };

    const body: RememberBody = {
      kind,
      text: rawText,
      ...(why ? { why } : {}),
      ...(scenes.length ? { scenes } : {}),
      ...(onDemand ? { on_demand: true } : {}),
      ...(alternatives ? { alternatives } : {}),
      anchors: validAnchors,
      anchor_head: gitCtx.head,
      confirmed: false,
      origin: "auto",
      ...(supersedesId ? { supersedes: supersedesId } : {}),
      model: usedModel,
      prompt_version: SYNTH_PROMPT_VERSION,
      source,
    };

    try {
      checkRememberBody(body);
    } catch (e) {
      skipped.push({ text: rawText, reason: e instanceof Error ? e.message : String(e) });
      continue;
    }

    let createdId: string | null = null;
    if (!dryRun) {
      const ensuredPid = opts.store.ensureProject(opts.project);
      createdId = opts.store.remember(ensuredPid, body.source.session_id, false, body);
    }
    acceptedNorms.push(normText(body.text));
    created.push({
      id: createdId,
      kind,
      text: body.text,
      ...(body.why ? { why: body.why } : {}),
      ...(body.scenes?.length ? { scenes: body.scenes } : {}),
      ...(body.on_demand ? { onDemand: true } : {}),
      anchors: body.anchors!,
      anchorHead: body.anchor_head!,
      ...(body.alternatives ? { alternatives: body.alternatives } : {}),
      ...(body.supersedes ? { supersedes: body.supersedes } : {}),
      confirmed: false,
      origin: "auto",
    });
  }

  let vectorWarning: string | null = null;
  if (!dryRun && created.length > 0 && opts.updateVectors) {
    try {
      vectorWarning = await opts.updateVectors(opts.store);
    } catch (e) {
      vectorWarning = e instanceof Error ? e.message : String(e);
    }
  }

  return {
    project: opts.project,
    dryRun,
    head: gitCtx.head,
    diffBase: gitCtx.diffBase,
    model: usedModel,
    promptVersion: SYNTH_PROMPT_VERSION,
    truncated: spec.truncated,
    created,
    skipped,
    draftHints,
    vectorWarning,
  };
}
