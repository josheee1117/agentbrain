/**
 * ab curate 的编排：从库里取候选 → 组装审稿输入 → 审稿团 → 执行计划 → （--apply 时）写可撤销事件 → 报告。
 * 默认 dry-run，只写报告不写库。所有写入都能用 ab curate --undo <run> 撤销。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chatClient } from "./llm.ts";
import { cliChat, spawnRunner, type Runner } from "./clireviewer.ts";
import type { Proposition } from "./l2.ts";
import { readKey } from "./embed.ts";
import { expandSource } from "./source.ts";
import { sanitize } from "./sanitize.ts";
import type { Store } from "./store.ts";
import { isWorkerTranscript } from "./transcript.ts";
import type { Action, CallStat, CandidateInput, CurateResult, Judge, PanelMember, ReviewConfig } from "./review.ts";
import { API_REVIEW_TIMEOUT_MS, CLI_REVIEW_TIMEOUT_MS, judgeBatch, judgeBatchPrimary, limit, MEMBER_CONCURRENCY, memberChatConfig, planAction } from "./review.ts";

export const CONTEXT_MAX_CHARS = 1500;
export const NEIGHBORS = 5;

export function candidateInput(store: Store, p: Proposition, props: Map<string, Proposition>, names: Map<string, string>): CandidateInput {
  const raw = expandSource(p.source);
  const context = raw ? sanitize(raw.length > CONTEXT_MAX_CHARS ? raw.slice(-CONTEXT_MAX_CHARS) : raw).text : null;
  const near = (store.neighbors(p.id) ?? [])
    .filter((n) => n.prop.id !== p.id && n.prop.state === "active")
    .slice(0, NEIGHBORS)
    .map((n) => ({ id: n.prop.id, text: n.prop.text, confirmed_by_user: n.prop.confirmed_by === "user" }));
  void props;
  return {
    id: p.id,
    kind: p.kind,
    scope: p.project_id ? "project" : "global",
    project: p.project_id ? (names.get(p.project_id) ?? null) : null,
    text: sanitize(p.text).text,
    why: p.why ? sanitize(p.why).text : undefined,
    scenario: p.value?.scenario ?? p.trigger,
    basis: p.basis,
    context,
    worker: isWorkerTranscript(p.source.transcript),
    neighbors: near.map((n) => ({ ...n, text: sanitize(n.text).text })),
  };
}

export interface Keys {
  read(service: string): string | { error: string };
}

/** 按配置连上审稿团。少于配置的成员可用时返回 missing，调用方不得写库。 */
export function connectPanel(cfg: ReviewConfig, keys: Keys = { read: readKey }, cliRunner: Runner = spawnRunner): { panel: Judge[]; arbiter: Judge | null; missing: string[] } {
  const panel: Judge[] = [];
  const missing: string[] = [];
  const connect = (m: PanelMember): Judge | null => {
    const gate = limit(MEMBER_CONCURRENCY);
    if (m.type === "cli") {
      // 用宿主自己的登录和额度，不读钥匙串；命令不存在等问题在调用时报，算这一票失败
      const chat = cliChat({ host: m.host!, model: m.model || undefined, effort: m.effort, bin: m.bin, timeoutMs: CLI_REVIEW_TIMEOUT_MS }, cliRunner);
      return { name: m.name, chat: (msgs, o) => gate(() => chat(msgs, o)) };
    }
    const k = keys.read(m.keyService);
    if (typeof k !== "string") {
      missing.push(`${m.name}: ${k.error}`);
      return null;
    }
    const chat = chatClient(memberChatConfig(m), k, API_REVIEW_TIMEOUT_MS);
    return { name: m.name, chat: (msgs, o) => gate(() => chat(msgs, o)) };
  };
  for (const m of cfg.panel) {
    const j = connect(m);
    if (j) panel.push(j);
  }
  const inPanel = cfg.panel.some((m) => m.name === cfg.arbiter);
  const arbiter = inPanel ? (panel.find((j) => j.name === cfg.arbiter) ?? null) : connect(cfg.arbiterMember);
  return { panel, arbiter, missing };
}

export interface RunReport {
  run: string;
  at: string;
  dry_run: boolean;
  panel: { name: string; model: string }[];
  arbiter: string;
  results: (CurateResult & { action: Action; text: string })[];
  stats: CallStat[];
  /** --apply 时写下的事件，供 --undo 逆向。 */
  applied: { op: string; id: string; events: string[]; created?: string }[];
}

/** primary 给了主审 name 时按 primary 模式（其余成员只给参考意见、arbiter 不用），否则按投票 + 仲裁。 */
export async function runPanel(inputs: CandidateInput[], panel: Judge[], arbiter: Judge, batchSize: number, stats: CallStat[], concurrency = 2, primary: string | null = null): Promise<CurateResult[]> {
  const main = primary ? panel.find((j) => j.name === primary) : undefined;
  if (primary && !main) throw new Error(`主审 ${primary} 连不上`);
  const advisors = panel.filter((j) => j !== main);
  const batches: CandidateInput[][] = [];
  for (let i = 0; i < inputs.length; i += batchSize) batches.push(inputs.slice(i, i + batchSize));
  const out: CurateResult[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, batches.length) }, async () => {
      while (next < batches.length) {
        const b = batches[next++];
        out.push(...(await (main ? judgeBatchPrimary(b, main, advisors, stats) : judgeBatch(b, panel, arbiter, stats))));
      }
    }),
  );
  const order = new Map(inputs.map((c, i) => [c.id, i]));
  return out.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
}

/**
 * 写事件。每条动作记下它写的事件，--undo 据此逆向。用户确认过的条目在 planAction 里已经 skip。
 * onProgress：每写下一步就回调一次（调用方据此落盘报告），中途出错也留得下撤销记录。
 */
export function applyActions(store: Store, run: string, actions: Action[], props: Map<string, Proposition>, onProgress: (applied: RunReport["applied"]) => void = () => {}): RunReport["applied"] {
  const applied: RunReport["applied"] = [];
  const done = (x: RunReport["applied"][number]) => {
    applied.push(x);
    onProgress(applied);
    return x;
  };
  for (const a of actions) {
    const p = props.get(a.id);
    if (!p || p.confirmed || p.state !== "active") continue; // 二次把关
    if (a.op === "promote") {
      // 留下：条目本来就有效，不写状态事件；审稿认定是干活偏好的才打 guidance。带场景的规则不打（§11.10）
      if (a.guidance && !p.guidance && !p.scenes.length) done({ op: a.op, id: p.id, events: [store.lifecycle("tag", p.id, null, { guidance: true, run })] });
    } else if (a.op === "discard") {
      done({ op: a.op, id: p.id, events: [store.lifecycle("archive", p.id, null, { reason: "curate", run, note: `${run}: ${a.reason}`.slice(0, 300) })] });
    } else if (a.op === "rewrite") {
      // 改写正文和场景来自模型输出：写 L1 前再脱敏一次（§13.2）
      const text = sanitize(a.text).text;
      const scenario = sanitize(a.scenario).text;
      const created = store.remember(p.project_id, null, false, {
        kind: p.kind,
        text,
        why: p.why,
        source: p.source,
        for_workers: p.for_workers,
        confirmed: false,
        origin: "curate",
        basis: p.basis,
        trigger: scenario,
        evidence: p.evidence,
        said_at: p.said_at ?? undefined,
        valid_days: p.valid_days ?? undefined,
        // 场景跟着旧条目走（§11.10）；带场景的规则不当常驻偏好
        scenes: p.scenes.length ? p.scenes : undefined,
        guidance: a.guidance && !p.scenes.length,
        value: { scenario, flags: [] },
        curate: { run, of: p.id },
      });
      const x = done({ op: a.op, id: p.id, events: [], created }); // 先记下新条目，归档原条目前出错也能撤销
      x.events.push(store.lifecycle("archive", p.id, null, { reason: "curate", run, into: created, note: `${run}: 改写为 ${created}` }));
      onProgress(applied);
    } else if (a.op === "merge") {
      done({ op: a.op, id: p.id, events: [store.lifecycle("archive", p.id, null, { reason: "duplicate", run, into: a.into, note: `${run}: 并入` })] });
    }
  }
  return applied;
}

/**
 * 撤销一次 --apply：打上的 guidance 收回，归档的恢复，改写生成的新条目归档。
 * 只撤销仍然是"这次运行写下的最后一步"的动作：之后被用户确认、被别的运行或手动操作改过的条目不动（不重复撤销，也不撤掉后来的运行）。
 */
/**
 * 从 L1 找回某次运行实际写下的动作（事件 body 里带 run）。写库成功但报告没来得及落盘时，--undo 靠它补全。
 * 旧版本写的事件只有 curate 带 run，找不回的部分仍以报告为准。
 */
export function appliedFromLog(store: Store, run: string): RunReport["applied"] {
  const byId = new Map<string, RunReport["applied"][number]>();
  const entry = (id: string, op: string) => {
    let x = byId.get(id);
    if (!x) byId.set(id, (x = { op, id, events: [] }));
    return x;
  };
  for (const e of store.curateRunEvents(run)) {
    if (e.kind === "remember" && e.body.curate?.of) entry(e.body.curate.of, "rewrite").created = e.id;
    else if (!e.target_id) continue;
    else if (e.kind === "tag") entry(e.target_id, "promote").events.push(e.id);
    else if (e.kind === "archive") {
      const x = entry(e.target_id, e.body.reason === "duplicate" ? "merge" : e.body.into ? "rewrite" : "discard");
      x.op = e.body.reason === "duplicate" ? "merge" : e.body.into ? "rewrite" : "discard";
      x.events.push(e.id);
    }
  }
  return [...byId.values()];
}

export function undoRun(store: Store, report: RunReport): number {
  let n = 0;
  const props = store.project().props;
  // 以 L1 为准：报告里没记下（写库后进程退出 / 落盘失败）的步骤也撤；报告里有、L1 找不回的（旧版本事件）照报告
  const fromLog = appliedFromLog(store, report.run);
  const seen = new Set(fromLog.map((a) => a.id));
  for (const a of [...fromLog, ...report.applied.filter((a) => !seen.has(a.id))]) {
    const p = props.get(a.id);
    const mine = (ev: string | undefined) => !!ev && store.lastStateEvent(a.id) === ev;
    if (p && p.confirmed_by !== "user") {
      if (a.op === "promote") {
        // 旧版本的报告第一个事件是 curate（现在重放时不起作用），guidance tag 在最后
        const tag = a.events[a.events.length - 1];
        // guidance 只在最近一次改它的仍是本次运行的 tag 时才收回（用户之后自己改过就不动）
        if (p.guidance && tag && store.lastGuidanceTag(p.id) === tag) {
          store.lifecycle("tag", p.id, null, { guidance: false });
          n++;
        }
      } else if ((a.op === "discard" || a.op === "merge" || a.op === "rewrite") && p.state === "archived" && mine(a.events[a.events.length - 1])) {
        store.lifecycle("reactivate", p.id, null);
        n++;
      }
    }
    if (a.created) {
      const c = props.get(a.created);
      // 新条目自创建后没被动过（没归档/恢复过）且不是用户确认的，才归档
      if (c && c.state === "active" && c.confirmed_by !== "user" && store.lastStateEvent(c.id) === null) store.lifecycle("archive", c.id, null, { reason: "curate", note: `undo ${report.run}` });
    }
  }
  return n;
}

export function reportDir(home: string): string {
  const d = join(home, "curate");
  mkdirSync(d, { recursive: true });
  return d;
}

export function saveReport(home: string, r: RunReport): string {
  const path = join(reportDir(home), `${r.run}.json`);
  writeFileSync(path, JSON.stringify(r, null, 1));
  return path;
}

export function loadReport(home: string, run: string): RunReport {
  return JSON.parse(readFileSync(join(reportDir(home), `${run.replace(/\.json$/, "")}.json`), "utf8")) as RunReport;
}

export function planAll(results: CurateResult[], props: Map<string, Proposition>): Action[] {
  return results.map((r) => planAction(props.get(r.id)!, r, props));
}
