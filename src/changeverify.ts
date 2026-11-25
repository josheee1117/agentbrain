import { relative } from "node:path";
import { GitRefRepoTools, RepoTools } from "./codeverify.ts";
import type { CodeRef, Proposition } from "./l2.ts";
import type { RegistryEntry } from "./registry.ts";
import type { Store } from "./store.ts";
import * as intake from "./intake.ts";
import { skipQueuedVerify, type VerifyRunResult } from "./work.ts";

export const MAX_CHANGED_ENQUEUE = 20;
type FileRef = Extract<CodeRef, { path: string }>;
export type ChangePriority = "deleted" | "broken" | "anchor" | "overlap_or_ident";
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
  if (!pid) return result;
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
  const chooseBase = (p: Proposition): string => {
    const evidence = p.code_evidence!.head;
    const last = intake.lastVerify(db, p.id);
    if (!last || last.outcome.startsWith("error:") || last.head === evidence) return evidence;
    if (isCommit(evidence) && isCommit(last.head)) {
      if (ancestor(evidence, last.head)) return last.head;
      if (ancestor(last.head, evidence)) return evidence;
      if (ancestor(evidence, target.sha) !== ancestor(last.head, target.sha)) return ancestor(evidence, target.sha) ? evidence : last.head;
    } else {
      if (isCommit(evidence) && ancestor(evidence, target.sha)) return evidence;
      if (isCommit(last.head) && ancestor(last.head, target.sha)) return last.head;
    }
    return time(evidence) > time(last.head) ? evidence : last.head;
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
  const hit = (p: Proposition, priority: ChangePriority) => result.items.push({ id: p.id, seq: p.seq, priority });
  const shift = (p: Proposition) => {
    result.shifted++;
    if (!opts.dryRun) intake.recordVerify(db, p.id, target.sha, "shifted", opts.now);
  };
  const groups = new Map<string, { p: Proposition; refs: FileRef[] }[]>();
  for (const p of store.project().props.values()) {
    if (p.state !== "active" || p.project_id !== pid || p.kind === "rule" || p.stale || p.superseded_draft || p.demoted) continue;
    result.checked++;
    const refs = p.code_evidence?.refs.filter((ref): ref is FileRef => "path" in ref) ?? [];
    if (!refs.length) { result.skipped.no_file_refs++; continue; }
    if (queued.has(p.id)) { result.skipped.already_queued++; continue; }
    const last = intake.lastVerify(db, p.id);
    if (skipQueuedVerify(last, target.sha, opts.now)) {
      if (last!.outcome.startsWith("not_verifiable")) result.skipped.not_verifiable++;
      else if (last!.head === target.sha) result.skipped.same_head++;
      else result.skipped.backoff++;
      continue;
    }
    const base = chooseBase(p);
    if (base === target.sha) { result.skipped.same_head++; continue; }
    // normalize through the same scoped-path boundary as read-only code verification
    const normalized = refs.map(ref => ({ ...ref, path: tools.path(ref.path) }));
    if (!isCommit(base)) {
      const priority = checkQuotes(normalized);
      if (priority) hit(p, priority); else shift(p);
      continue;
    }
    const tracked = normalized.filter(ref => tree(base).has(ref.path));
    if (!tracked.length) { result.skipped.untracked_path++; continue; }
    if (!ancestor(base, target.sha)) {
      const priority = checkQuotes(tracked);
      if (!priority) { shift(p); continue; }
      if (!merges.has(base)) merges.set(base, optionalGit(tools, ["merge-base", base, target.sha]));
      const mb = merges.get(base);
      if (mb && changedPaths(mb, [...new Set(tracked.map(ref => ref.path))]).size) hit(p, priority);
      else result.skipped.unmerged_branch++;
      continue;
    }
    const group = groups.get(base) ?? [];
    group.push({ p, refs: tracked }); groups.set(base, group);
  }
  for (const [base, group] of groups) {
    const changed = changedPaths(base, [...new Set(group.flatMap(item => item.refs.map(ref => ref.path)))]);
    for (const { p, refs } of group) {
      if (!refs.some(ref => changed.has(ref.path))) { result.skipped.unchanged++; continue; }
      const priority = checkQuotes(refs);
      if (priority) { hit(p, priority); continue; }
      const matched = refs.some(ref => {
        if (!changed.has(ref.path)) return false;
        const key = `${base}:${ref.path}`;
        if (!diffs.has(key)) diffs.set(key, tools.git(["diff", "-U0", "--no-textconv", "--no-renames", base, target.sha, "--", ref.path]));
        return overlapsOrIdent(diffs.get(key)!, ref);
      });
      if (matched) hit(p, "overlap_or_ident");
      else { result.prescreened++; result.prescreenedIds.push(p.id); }
    }
  }
  const priorityOrder: Record<ChangePriority, number> = { deleted: 1, broken: 2, anchor: 3, overlap_or_ident: 4 };
  result.items.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority] || a.seq - b.seq);
  result.hits = result.items.length;
  result.items = result.items.slice(0, MAX_CHANGED_ENQUEUE);
  result.enqueued = result.items.length;
  result.truncated = result.hits - result.enqueued;
  if (!opts.dryRun) store.queueReverify(result.items.map(item => item.id), opts.now);
  return result;
}
