import { relative } from "node:path";
import { GitRefRepoTools, RepoTools } from "./codeverify.ts";
import { parseAnchor, type CodeRef, type Proposition } from "./l2.ts";
import type { RegistryEntry } from "./registry.ts";
import type { Store } from "./store.ts";
import * as intake from "./intake.ts";
import { skipQueuedVerify, type VerifyRunResult } from "./work.ts";

export const MAX_CHANGED_ENQUEUE = 20;
type FileRef = Extract<CodeRef, { path: string }>;
export type ChangePriority = "deleted" | "broken" | "anchor" | "overlap_or_ident";
const PRIORITY_ORDER: Record<ChangePriority, number> = { deleted: 1, broken: 2, anchor: 3, overlap_or_ident: 4 };
const bestPriority = (a: ChangePriority | null, b: ChangePriority | null): ChangePriority | null =>
  !a ? b : !b ? a : PRIORITY_ORDER[a] <= PRIORITY_ORDER[b] ? a : b;
export interface ChangeScanResult {
  project: string;
  trunkRef: string | null;
  head: string | null;
  checked: number;
  hits: number;
  shifted: number;
  prescreened: number;
  enqueued: number;
  truncated: number;
  skipped: Record<"no_file_refs" | "already_queued" | "not_verifiable" | "same_head" | "backoff" | "untracked_path" | "unchanged" | "unmerged_branch", number>;
  items: { id: string; seq: number; priority: ChangePriority }[];
  prescreenedIds: string[];
  run?: VerifyRunResult;
}

function optionalGit(tools: RepoTools, args: string[]): string | null {
  try { return tools.git(args).trim(); } catch { return null; }
}

function validateRef(ref: string): void {
  if (!ref || ref.startsWith("-") || /[\s\0]/.test(ref)) throw new Error("不允许的 git ref");
}

/** 只读本地已有 ref，不 fetch，不切换工作区。 */
export function resolveTrunkRef(root: string, trunk: string | null | undefined, explicitRef?: string): { ref: string; sha: string } | null {
  const tools = new RepoTools(root);
  if (explicitRef !== undefined) {
    validateRef(explicitRef);
    const sha = optionalGit(tools, ["rev-parse", "--verify", `${explicitRef}^{commit}`]);
    if (!sha) throw new Error(`无法解析 --ref ${explicitRef}`);
    return { ref: explicitRef, sha };
  }
  if (!trunk) {
    const sha = optionalGit(tools, ["rev-parse", "--verify", "HEAD^{commit}"]);
    return sha ? { ref: "HEAD", sha } : null;
  }
  validateRef(trunk);
  if (optionalGit(tools, ["check-ref-format", `refs/heads/${trunk}`]) === null) throw new Error(`不允许的主干名：${trunk}`);
  const remote = optionalGit(tools, ["rev-parse", "--verify", `refs/remotes/origin/${trunk}^{commit}`]);
  const local = optionalGit(tools, ["rev-parse", "--verify", `refs/heads/${trunk}^{commit}`]);
  if (remote && local) {
    if (remote !== local && optionalGit(tools, ["merge-base", "--is-ancestor", remote, local]) !== null) return { ref: trunk, sha: local };
    return { ref: `origin/${trunk}`, sha: remote };
  }
  return remote ? { ref: `origin/${trunk}`, sha: remote } : local ? { ref: trunk, sha: local } : null;
}

class ChangeRepoTools extends GitRefRepoTools {
  path(rel: string): string { return relative(this.root, this.scopedPath(rel)); }
}

const RESERVED = new Set(("abstract arguments as async await bool boolean break byte case catch char class const continue debugger declare default delete do double else enum export extends false final finally float for from function global goto if implements import in instanceof int interface let long module namespace native new null number object of package private protected public readonly require return short static string struct super switch symbol synchronized this throw throws transient true try type typeof undefined union unknown unsigned using var virtual void volatile while with yield").split(" "));
const norm = (text: string) => text.replace(/\s+/g, " ").trim();

function overlapsOrIdent(diff: string, ref: FileRef): boolean {
  const identifiers = new Set((ref.quote.match(/[A-Za-z_$][A-Za-z0-9_$]{3,}/g) ?? []).filter(word => !RESERVED.has(word)));
  for (const line of diff.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/.exec(line);
    if (hunk) {
      const start = Number(hunk[1]), count = Number(hunk[2] ?? 1);
      const end = count === 0 ? start + 1 : start + count - 1;
      if (start <= ref.line_end + 3 && end >= ref.line_start - 3) return true;
    }
    if ((line.startsWith("+") || line.startsWith("-")) && !line.startsWith("+++ ") && !line.startsWith("--- ")) {
      if ((line.slice(1).match(/[A-Za-z_$][A-Za-z0-9_$]{3,}/g) ?? []).some(word => identifiers.has(word))) return true;
    }
  }
  return false;
}

export function scanChangedProject(store: Store, entry: RegistryEntry, opts: { ref?: string; dryRun: boolean; now: Date }): ChangeScanResult {
  if (!entry.path) throw new Error(`项目 ${entry.name} 没有本地仓库路径`);
  const target = resolveTrunkRef(entry.path, entry.trunk, opts.ref);
  const result: ChangeScanResult = {
    project: entry.name, trunkRef: target?.ref ?? null, head: target?.sha ?? null,
    checked: 0, hits: 0, shifted: 0, prescreened: 0, enqueued: 0, truncated: 0,
    skipped: { no_file_refs: 0, already_queued: 0, not_verifiable: 0, same_head: 0, backoff: 0, untracked_path: 0, unchanged: 0, unmerged_branch: 0 }, items: [], prescreenedIds: [],
  };
  if (!target) return result;
  const tools = new ChangeRepoTools(entry.path, target.sha);
  const db = store.workDb;
  const pid = store.listProjects().find(p => p.name === entry.name)?.id;
  const queued = intake.queuedReverify(db);
  const ancestors = new Map<string, boolean>();
  const commits = new Map<string, boolean>();
  const commitTime = new Map<string, number>();
  const trees = new Map<string, Set<string>>();
  const merges = new Map<string, string | null>();
  const diffs = new Map<string, string>();
  const contents = new Map<string, string | null>();
  const isCommit = (sha: string): boolean => {
    if (!commits.has(sha)) commits.set(sha, /^[0-9a-f]{7,40}$/.test(sha) && optionalGit(tools, ["cat-file", "-t", sha]) === "commit");
    return commits.get(sha)!;
  };
  const ancestor = (base: string, head: string): boolean => {
    const key = `${base}:${head}`;
    if (!ancestors.has(key)) ancestors.set(key, optionalGit(tools, ["merge-base", "--is-ancestor", base, head]) !== null);
    return ancestors.get(key)!;
  };
  const time = (sha: string): number => {
    if (!commitTime.has(sha)) commitTime.set(sha, isCommit(sha) ? Number(tools.git(["show", "-s", "--format=%ct", sha]).trim()) : 0);
    return commitTime.get(sha)!;
  };
  const pickNewer = (a: string, b: string): string => {
    if (a === b) return a;
    if (isCommit(a) && isCommit(b)) {
      if (ancestor(a, b)) return b;
      if (ancestor(b, a)) return a;
      if (ancestor(a, target.sha) !== ancestor(b, target.sha)) return ancestor(a, target.sha) ? a : b;
      return time(a) > time(b) ? a : b;
    }
    if (isCommit(a) !== isCommit(b)) return isCommit(a) ? a : b;
    return a;
  };
  const chooseBase = (p: Proposition, isCrossRepo: boolean, includeEvidenceHead: boolean, last: ReturnType<typeof intake.lastVerify>): string | null => {
    const lastHead = last && (last.outcome === "verified" || last.outcome === "shifted") ? last.head : null;
    const raw = isCrossRepo
      ? [p.anchor_head, lastHead].filter((sha): sha is string => !!sha && isCommit(sha))
      : [includeEvidenceHead ? p.code_evidence?.head : undefined, p.anchor_head, lastHead].filter((sha): sha is string => !!sha);
    const unique = [...new Set(raw)];
    return unique.length ? unique.reduce(pickNewer) : null;
  };
  const tree = (sha: string): Set<string> => {
    if (!trees.has(sha)) trees.set(sha, new Set(tools.git(["ls-tree", "-r", "--name-only", "-z", sha]).split("\0").filter(Boolean)));
    return trees.get(sha)!;
  };
  const changedPaths = (base: string, paths: string[]): Set<string> => {
    const changed = new Set<string>();
    for (let i = 0; i < paths.length; i += 200) {
      for (const path of tools.git(["diff", "--name-only", "-z", "--no-renames", base, target.sha, "--", ...paths.slice(i, i + 200)]).split("\0").filter(Boolean)) changed.add(path);
    }
    return changed;
  };
  const checkQuotes = (refs: FileRef[]): "deleted" | "broken" | null => {
    let broken = false;
    for (const ref of refs) {
      if (!tree(target.sha).has(ref.path)) return "deleted";
      if (!contents.has(ref.path)) {
        const lines = tools.fileLines(ref.path);
        contents.set(ref.path, lines ? norm(lines.join("\n")) : null);
      }
      if (!contents.get(ref.path)?.includes(norm(ref.quote))) broken = true;
    }
    return broken ? "broken" : null;
  };
  const anchorState = (anchors: string[]): ChangePriority | null => {
    if (!anchors.length) return null;
    return anchors.some(a => !tree(target.sha).has(a)) ? "deleted" : "anchor";
  };
  const hit = (p: Proposition, priority: ChangePriority) => result.items.push({ id: p.id, seq: p.seq, priority });
  const shift = (p: Proposition) => {
    result.shifted++;
    if (!opts.dryRun) intake.recordVerify(db, p.id, target.sha, "shifted", opts.now);
  };
  const groups = new Map<string, { p: Proposition; refs: FileRef[]; anchors: string[] }[]>();
  for (const p of store.project().props.values()) {
    if (p.state !== "active" || p.kind === "rule" || p.stale || p.superseded_draft || p.demoted) continue;
    const isOwn = pid !== undefined && p.project_id === pid;
    const anchorPaths = [...new Set(
      p.anchors.map(parseAnchor).filter(a => isOwn ? (a.repo === null || a.repo === entry.name) : a.repo === entry.name).map(a => a.path),
    )];
    if (!isOwn && !anchorPaths.length) continue;
    if (isOwn && p.anchors.length > 0 && !anchorPaths.length) continue;
    const hasMixedAnchors = isOwn && anchorPaths.length > 0 && p.anchors.some(a => {
      const r = parseAnchor(a).repo;
      return r !== null && r !== entry.name;
    });
    const useOwnEvidence = isOwn && (!hasMixedAnchors || (!!p.code_evidence && isCommit(p.code_evidence.head)));
    const refs = useOwnEvidence ? (p.code_evidence?.refs.filter((ref): ref is FileRef => "path" in ref) ?? []) : [];
    result.checked++;
    if (!refs.length && !anchorPaths.length) { result.skipped.no_file_refs++; continue; }
    if (queued.has(p.id)) { result.skipped.already_queued++; continue; }
    const last = intake.lastVerify(db, p.id);
    if (skipQueuedVerify(last, target.sha, opts.now)) {
      if (last!.outcome.startsWith("not_verifiable")) result.skipped.not_verifiable++;
      else if (last!.head === target.sha) result.skipped.same_head++;
      else result.skipped.backoff++;
      continue;
    }
    const base = chooseBase(p, !isOwn, useOwnEvidence, last);
    if (base === target.sha) { result.skipped.same_head++; continue; }
    // normalize through the same scoped-path boundary as read-only code verification
    const normalizedRefs: FileRef[] = [];
    for (const ref of refs) {
      try { normalizedRefs.push({ ...ref, path: tools.path(ref.path) }); } catch { /* 单条非法路径跳过，不中断整批 */ }
    }
    const normalizedAnchors: string[] = [];
    for (const ap of anchorPaths) {
      try { normalizedAnchors.push(tools.path(ap)); } catch { /* 单条非法路径跳过，不中断整批 */ }
    }
    const uniqueAnchors = [...new Set(normalizedAnchors)];
    if (!normalizedRefs.length && !uniqueAnchors.length) { result.skipped.untracked_path++; continue; }
    if (!base) {
      const priority = anchorState(uniqueAnchors);
      if (priority) hit(p, priority);
      continue;
    }
    if (!isCommit(base)) {
      const priority = bestPriority(normalizedRefs.length ? checkQuotes(normalizedRefs) : null, anchorState(uniqueAnchors));
      if (priority) hit(p, priority); else shift(p);
      continue;
    }
    const trackedRefs = normalizedRefs.filter(ref => tree(base).has(ref.path));
    const trackedAnchors = uniqueAnchors.filter(a => tree(base).has(a));
    if (!trackedRefs.length && !trackedAnchors.length) { result.skipped.untracked_path++; continue; }
    if (!ancestor(base, target.sha)) {
      const refP = trackedRefs.length ? checkQuotes(trackedRefs) : null;
      const anchorsOk = trackedAnchors.every(a => tree(target.sha).has(a));
      if (!merges.has(base)) merges.set(base, optionalGit(tools, ["merge-base", base, target.sha]));
      const mb = merges.get(base);
      const mbChangedAnchors = mb && trackedAnchors.length ? changedPaths(mb, trackedAnchors) : null;
      if (!refP && anchorsOk && (!trackedAnchors.length || (mbChangedAnchors !== null && mbChangedAnchors.size === 0))) {
        shift(p);
        continue;
      }
      if (!mb) { result.skipped.unmerged_branch++; continue; }
      const hitRef = refP && trackedRefs.length && changedPaths(mb, [...new Set(trackedRefs.map(r => r.path))]).size ? refP : null;
      const hitAnchor: ChangePriority | null = !anchorsOk ? "deleted" : (mbChangedAnchors && mbChangedAnchors.size > 0 ? "anchor" : null);
      const priority = bestPriority(hitRef, hitAnchor);
      if (priority) hit(p, priority);
      else result.skipped.unmerged_branch++;
      continue;
    }
    const group = groups.get(base) ?? [];
    group.push({ p, refs: trackedRefs, anchors: trackedAnchors }); groups.set(base, group);
  }
  for (const [base, group] of groups) {
    const changed = changedPaths(base, [...new Set(group.flatMap(item => [...item.refs.map(ref => ref.path), ...item.anchors]))]);
    for (const { p, refs, anchors } of group) {
      const refChanged = refs.some(ref => changed.has(ref.path));
      const changedAnchors = anchors.filter(a => changed.has(a));
      if (!refChanged && !changedAnchors.length) { result.skipped.unchanged++; continue; }
      const ancP = anchorState(changedAnchors);
      let refP: ChangePriority | null = null;
      if (refChanged) {
        refP = checkQuotes(refs);
        if (!refP) {
          const matched = refs.some(ref => {
            if (!changed.has(ref.path)) return false;
            const key = `${base}:${ref.path}`;
            if (!diffs.has(key)) diffs.set(key, tools.git(["diff", "-U0", "--no-textconv", "--no-renames", base, target.sha, "--", ref.path]));
            return overlapsOrIdent(diffs.get(key)!, ref);
          });
          if (matched) refP = "overlap_or_ident";
        }
      }
      const priority = bestPriority(ancP, refP);
      if (priority) hit(p, priority);
      else { result.prescreened++; result.prescreenedIds.push(p.id); }
    }
  }
  result.items.sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || a.seq - b.seq);
  result.hits = result.items.length;
  result.items = result.items.slice(0, MAX_CHANGED_ENQUEUE);
  result.enqueued = result.items.length;
  result.truncated = result.hits - result.enqueued;
  if (!opts.dryRun) store.queueReverify(result.items.map(item => item.id), opts.now);
  return result;
}
