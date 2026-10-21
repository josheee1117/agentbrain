/**
 * 宿主全局指令文件里的 agentbrain 托管块（设计 §11.8.9）。
 * 只动标记块内部；首次运行把与已知原文逐字相同的手写"## 记忆（agentbrain）"段换成托管块，
 * 内容被用户改过的手写段不动、要 --adopt 才换。写前备份，内容不变不写，--remove-notes 只删块。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { backup } from "./setup.ts";

export const BEGIN = "<!-- agentbrain:begin managed v1（由 ab setup 维护，勿手改；ab setup --remove-notes 可删除） -->";
export const END = "<!-- agentbrain:end managed -->";
const BEGIN_RE = /^<!-- agentbrain:begin managed\b.*-->$/;
const END_RE = /^<!-- agentbrain:end managed -->$/;
const HEADING = "## 记忆（agentbrain）";

const BASE = [
  "- 记忆在本机 agentbrain 库（`~/.agentbrain/`）。按范围分全局和项目（项目即 pm 的 `repos/<项目>.md`），按种类分规则、决定、坑、事实；用户的干活偏好每轮常驻注入（`<agentbrain-prefs>`）。",
  "- 怎么用：开工先跑 `ab brief`（子代理跑 `ab brief --worker`）；每轮相关记忆自动注入（`<agentbrain-recall>`）；要查用 `ab search <关键词>`、`ab get <id>`。与现场证据冲突时信现场。",
  "- 干活时不写记忆：后台会从会话里自动抽取候选，由审稿模型决定去留。只有用户明确要你记某件事时，才用 `ab remember --confirmed`（参数见 `ab --help`）。",
];
const CITE = [
  "- `<agentbrain-recall>` 里每条前面的 `[8 位 id]` 是它的编号。回答若实际依据了其中某条，在回复最后单独一行写：`ab-used: 简短标题 (id)`，多条用；分隔，例如 `ab-used: 调 pi/codex 测试用临时库 (7f3c2a1b)`。没用上就不写，不要为了写而硬套。",
  "- `<agentbrain-prefs>` 里的常驻偏好不用标。",
];

/** 2026-10-21 三个宿主文件里逐字相同的手写段（标题 + 空行 + 三条）。 */
export const LEGACY_SECTION = [HEADING, "", ...BASE].join("\n");

export function managedBlock(cite: boolean): string {
  return [BEGIN, HEADING, "", ...BASE, ...(cite ? CITE : []), END].join("\n");
}

export type NoteAction = "create" | "append" | "replace-legacy" | "adopt" | "update" | "unchanged" | "needs-adopt" | "remove" | "absent" | "broken";

export interface NotePlan {
  action: NoteAction;
  /** 写入后的全文；不写为 null。 */
  next: string | null;
}

function markers(lines: string[]): { begin: number[]; end: number[] } {
  const begin: number[] = [];
  const end: number[] = [];
  lines.forEach((l, i) => {
    if (BEGIN_RE.test(l.trim())) begin.push(i);
    if (END_RE.test(l.trim())) end.push(i);
  });
  return { begin, end };
}

/** 手写段：从标题行到下一个 `## ` 标题或文件末尾。 */
function legacyRange(lines: string[]): [number, number] | null {
  const s = lines.findIndex((l) => l.trim() === HEADING);
  if (s < 0) return null;
  let e = lines.length;
  for (let i = s + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) {
      e = i;
      break;
    }
  }
  return [s, e];
}

function norm(s: string): string {
  return s.split("\n").map((l) => l.trimEnd()).join("\n").trim();
}

function finish(lines: string[], hadNewline: boolean): string {
  const t = lines.join("\n");
  return hadNewline || !t.endsWith("\n") ? t.replace(/\n*$/, "\n") : t;
}

export function planNotes(content: string | null, cite: boolean, adopt = false): NotePlan {
  const block = managedBlock(cite);
  if (content === null) return { action: "create", next: block + "\n" };
  const lines = content.split("\n");
  const m = markers(lines);
  if (m.begin.length || m.end.length) {
    if (m.begin.length !== 1 || m.end.length !== 1 || m.end[0] < m.begin[0]) return { action: "broken", next: null };
    const cur = lines.slice(m.begin[0], m.end[0] + 1).join("\n");
    if (cur === block) return { action: "unchanged", next: null };
    return { action: "update", next: finish([...lines.slice(0, m.begin[0]), block, ...lines.slice(m.end[0] + 1)], true) };
  }
  const r = legacyRange(lines);
  if (r) {
    const sec = lines.slice(r[0], r[1]).join("\n");
    const same = norm(sec) === norm(LEGACY_SECTION);
    if (!same && !adopt) return { action: "needs-adopt", next: null };
    // 段后原有的空行保留，免得和下一个标题粘在一起
    const tail = lines.slice(r[0], r[1]);
    let blanks = 0;
    for (let i = tail.length - 1; i >= 0 && tail[i].trim() === ""; i--) blanks++;
    const keep = r[1] < lines.length ? Array(Math.max(1, blanks)).fill("") : [];
    return { action: same ? "replace-legacy" : "adopt", next: finish([...lines.slice(0, r[0]), block, ...keep, ...lines.slice(r[1])], true) };
  }
  const body = content.replace(/\n*$/, "");
  return { action: "append", next: (body ? body + "\n\n" : "") + block + "\n" };
}

export function planRemove(content: string | null): NotePlan {
  if (content === null) return { action: "absent", next: null };
  const lines = content.split("\n");
  const m = markers(lines);
  if (!m.begin.length && !m.end.length) return { action: "absent", next: null };
  if (m.begin.length !== 1 || m.end.length !== 1 || m.end[0] < m.begin[0]) return { action: "broken", next: null };
  const before = lines.slice(0, m.begin[0]);
  const after = lines.slice(m.end[0] + 1);
  // 去掉块后多出来的连续空行
  while (before.length && before[before.length - 1].trim() === "" && (after.length === 0 || after[0].trim() === "")) before.pop();
  return { action: "remove", next: finish([...before, ...after], content.endsWith("\n")) };
}

export function noteTargets(h = homedir()): { host: string; path: string }[] {
  return [
    { host: "claude", path: join(h, ".claude", "CLAUDE.md") },
    { host: "codex", path: join(h, ".codex", "AGENTS.md") },
    { host: "pi", path: join(h, ".pi", "agent", "AGENTS.md") },
    { host: "opencode", path: join(h, ".config", "opencode", "AGENTS.md") },
  ];
}

export function unifiedDiff(path: string, before: string | null, after: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ab-notes-"));
  try {
    const a = join(dir, "a");
    const b = join(dir, "b");
    writeFileSync(a, before ?? "");
    writeFileSync(b, after);
    const r = spawnSync("diff", ["-u", "--label", before === null ? "/dev/null" : path, "--label", path, a, b], { encoding: "utf8" });
    return r.stdout || "(无变化)";
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface NoteResult {
  host: string;
  path: string;
  action: NoteAction;
  diff: string | null;
  wrote: boolean;
  backup: string | null;
}

/** 对每个宿主文件规划并（非 dry-run 时）写入。写后复读，确认恰好一对标记（删除时为零对）。 */
export function applyNotes(opts: { cite: boolean; dryRun: boolean; adopt: boolean; remove: boolean; home?: string; now?: Date }): NoteResult[] {
  const out: NoteResult[] = [];
  for (const t of noteTargets(opts.home)) {
    const before = existsSync(t.path) ? readFileSync(t.path, "utf8") : null;
    const plan = opts.remove ? planRemove(before) : planNotes(before, opts.cite, opts.adopt);
    const res: NoteResult = { host: t.host, path: t.path, action: plan.action, diff: plan.next !== null ? unifiedDiff(t.path, before, plan.next) : null, wrote: false, backup: null };
    if (plan.next !== null && !opts.dryRun) {
      res.backup = backup(t.path, opts.now);
      mkdirSync(dirname(t.path), { recursive: true });
      writeFileSync(t.path, plan.next);
      const m = markers(readFileSync(t.path, "utf8").split("\n"));
      const want = opts.remove ? 0 : 1;
      if (m.begin.length !== want || m.end.length !== want) throw new Error(`${t.path} 写入后标记数不对（begin ${m.begin.length} / end ${m.end.length}）`);
      res.wrote = true;
    }
    out.push(res);
  }
  return out;
}
