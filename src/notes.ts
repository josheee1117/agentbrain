/** 宿主全局指令文件里的 agentbrain 托管块（§11.8.9）。用户改过的手写段要 --adopt 才换，免得覆盖用户的话。 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  "- 怎么用：开工先跑 `ab brief`（子代理跑 `ab brief --worker`）；何时查历史记忆由你判断（`<agentbrain-recall>` 提醒）；要查用 `ab search <关键词>`、`ab get <id>`。与现场证据冲突时信现场。",
  "- 干活时不写记忆：后台会从会话里自动抽取候选，由审稿模型决定去留。只有用户明确要你记某件事时，才用 `ab remember --confirmed`（参数见 `ab --help`）。",
];

const LEGACY_BASE = [
  "- 记忆在本机 agentbrain 库（`~/.agentbrain/`）。按范围分全局和项目（项目即 pm 的 `repos/<项目>.md`），按种类分规则、决定、坑、事实；用户的干活偏好每轮常驻注入（`<agentbrain-prefs>`）。",
  "- 怎么用：开工先跑 `ab brief`（子代理跑 `ab brief --worker`）；每轮相关记忆自动注入（`<agentbrain-recall>`）；要查用 `ab search <关键词>`、`ab get <id>`。与现场证据冲突时信现场。",
  "- 干活时不写记忆：后台会从会话里自动抽取候选，由审稿模型决定去留。只有用户明确要你记某件事时，才用 `ab remember --confirmed`（参数见 `ab --help`）。",
];
/** 托管块出现前三个宿主文件里逐字相同的手写段，首次运行据此认出可以直接替换的段。 */
export const LEGACY_SECTION = [HEADING, "", ...LEGACY_BASE].join("\n");

export function managedBlock(): string {
  return [BEGIN, HEADING, "", ...BASE, END].join("\n");
}

export type NoteAction = "create" | "append" | "replace-legacy" | "adopt" | "update" | "unchanged" | "needs-adopt" | "remove" | "absent" | "broken";

export interface NotePlan {
  action: NoteAction;
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

/** 手写段：从标题行到下一个一级或二级标题，或文件末尾。 */
function legacyRange(lines: string[]): [number, number] | null {
  const s = lines.findIndex((l) => l.trim() === HEADING);
  if (s < 0) return null;
  let e = lines.length;
  for (let i = s + 1; i < lines.length; i++) {
    if (/^#{1,2} /.test(lines[i])) {
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

export function planNotes(content: string | null, adopt = false): NotePlan {
  const block = managedBlock();
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

/** 先在同目录写临时文件再改名替换，写到一半中断时宿主文件不会是半截的。软链写到它指向的文件。 */
function writeAtomic(path: string, text: string): void {
  const real = existsSync(path) ? realpathSync(path) : path;
  mkdirSync(dirname(real), { recursive: true });
  const tmp = `${real}.agentbrain-tmp-${process.pid}`;
  writeFileSync(tmp, text, existsSync(real) ? { mode: statSync(real).mode & 0o777 } : {});
  renameSync(tmp, real);
}

export function applyNotes(opts: { dryRun: boolean; adopt: boolean; remove: boolean; home?: string; now?: Date }): NoteResult[] {
  const planned = noteTargets(opts.home).map((t) => {
    const before = existsSync(t.path) ? readFileSync(t.path, "utf8") : null;
    const plan = opts.remove ? planRemove(before) : planNotes(before, opts.adopt);
    if (plan.next !== null) {
      const m = markers(plan.next.split("\n"));
      const want = opts.remove ? 0 : 1;
      if (m.begin.length !== want || m.end.length !== want) throw new Error(`${t.path} 改后标记数不对（begin ${m.begin.length} / end ${m.end.length}），没有写任何文件`);
    }
    return { t, before, plan };
  });
  return planned.map(({ t, before, plan }) => {
    const res: NoteResult = { host: t.host, path: t.path, action: plan.action, diff: plan.next !== null ? unifiedDiff(t.path, before, plan.next) : null, wrote: false, backup: null };
    if (plan.next !== null && !opts.dryRun) {
      res.backup = backup(t.path, opts.now);
      writeAtomic(t.path, plan.next);
      res.wrote = true;
    }
    return res;
  });
}
