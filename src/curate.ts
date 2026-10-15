/**
 * ab curate 的编排：从库里取候选 → 组装审稿输入 → 审稿团 → 执行计划 → （--apply 时）写可撤销事件 → 报告。
 * 默认 dry-run，只写报告不写库。所有写入都能用 ab curate --undo <run> 撤销。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { chatClient } from "./llm.ts";
import { cliChat, spawnRunner, type Runner } from "./clireviewer.ts";
import type { Proposition } from "./l2.ts";
import { readKey } from "./embed.ts";
import { expandSource } from "./source.ts";
import { sanitize } from "./sanitize.ts";
import type { Store } from "./store.ts";
import { isWorkerTranscript } from "./transcript.ts";
import type { Action, CallStat, CandidateInput, CurateResult, Judge, PanelMember, ReviewConfig } from "./review.ts";
import { judgeBatch, judgeBatchPrimary, limit, memberChatConfig, planAction } from "./review.ts";

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
    const gate = limit(m.concurrency ?? 1);
    if (m.type === "cli") {
      // 用宿主自己的登录和额度，不读钥匙串；命令不存在等问题在调用时报，算这一票失败
      const chat = cliChat({ host: m.host!, model: m.model || undefined, effort: m.effort, bin: m.bin, timeoutMs: m.timeoutMs ?? 600_000 }, cliRunner);
      return { name: m.name, chat: (msgs, o) => gate(() => chat(msgs, o)) };
    }
    const k = keys.read(m.keyService);
    if (typeof k !== "string") {
      missing.push(`${m.name}: ${k.error}`);
      return null;
    }
    const chat = chatClient(memberChatConfig(m), k, m.timeoutMs ?? 300_000);
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

/** 写事件。每条动作记下它写的事件，--undo 据此逆向。用户确认过的条目在 planAction 里已经 skip。 */
export function applyActions(store: Store, run: string, actions: Action[], props: Map<string, Proposition>): RunReport["applied"] {
  const applied: RunReport["applied"] = [];
  for (const a of actions) {
    const p = props.get(a.id);
    if (!p || p.confirmed_by === "user" || p.state !== "candidate") continue; // 二次把关
    if (a.op === "promote") {
      const ev = [store.lifecycle("curate", p.id, null, { action: "promote", run, verdict: "keep" })];
      if (a.guidance && !p.guidance) ev.push(store.lifecycle("tag", p.id, null, { guidance: true }));
      applied.push({ op: a.op, id: p.id, events: ev });
    } else if (a.op === "discard") {
      applied.push({ op: a.op, id: p.id, events: [store.lifecycle("archive", p.id, null, { reason: "curate", note: `${run}: ${a.reason}`.slice(0, 300) })] });
    } else if (a.op === "rewrite") {
      const created = store.remember(p.project_id, null, false, {
        kind: p.kind,
        text: a.text,
        why: p.why,
        source: p.source,
        for_workers: p.for_workers,
        confirmed: false,
        origin: "curate",
        basis: p.basis,
        trigger: a.scenario,
        evidence: p.evidence,
        said_at: p.said_at ?? undefined,
        valid_days: p.valid_days ?? undefined,
        guidance: a.guidance,
        value: { scenario: a.scenario, flags: [] },
      });
      const arch = store.lifecycle("archive", p.id, null, { reason: "curate", into: created, note: `${run}: 改写为 ${created}` });
      applied.push({ op: a.op, id: p.id, events: [arch], created });
    } else if (a.op === "merge") {
      applied.push({ op: a.op, id: p.id, events: [store.lifecycle("archive", p.id, null, { reason: "duplicate", into: a.into, note: `${run}: 并入` })] });
    }
  }
  return applied;
}

/** 撤销一次 --apply：转正的退回候选区，归档的恢复，改写生成的新条目归档。 */
export function undoRun(store: Store, report: RunReport): number {
  let n = 0;
  const props = store.project().props;
  for (const a of report.applied) {
    const p = props.get(a.id);
    if (!p) continue;
    if (a.op === "promote" && p.curated) {
      store.lifecycle("curate", p.id, null, { action: "unpromote", run: report.run });
      if (p.guidance && a.events.length > 1) store.lifecycle("tag", p.id, null, { guidance: false });
      n++;
    } else if ((a.op === "discard" || a.op === "merge" || a.op === "rewrite") && p.state === "archived") {
      store.lifecycle("reactivate", p.id, null);
      n++;
    }
    if (a.created) {
      const c = props.get(a.created);
      if (c && c.state === "active" && c.confirmed_by !== "user") store.lifecycle("archive", c.id, null, { reason: "curate", note: `undo ${report.run}` });
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

// ---------- 认领：并发的 ab curate 不重复审同一条；审稿进程崩了，租约过期后别的运行会接手 ----------

/** 认领租约时长；运行中定时续期。 */
export const CLAIM_TTL_MS = 30 * 60_000;

/** 从 ids（按优先顺序）里认领最多 max 条没被别的运行占着的候选。过期的认领先清掉（崩掉的运行留下的）。 */
export function claimCandidates(db: DatabaseSync, ids: string[], run: string, now: Date, max: number): string[] {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM curate_claims WHERE expires_at < ?").run(now.toISOString());
    const held = new Set((db.prepare("SELECT prop_id FROM curate_claims").all() as { prop_id: string }[]).map((r) => r.prop_id));
    const got = ids.filter((id) => !held.has(id)).slice(0, max);
    const ins = db.prepare("INSERT INTO curate_claims(prop_id,run,pid,expires_at) VALUES(?,?,?,?)");
    const exp = new Date(now.getTime() + CLAIM_TTL_MS).toISOString();
    for (const id of got) ins.run(id, run, process.pid, exp);
    db.exec("COMMIT");
    return got;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function renewClaims(db: DatabaseSync, run: string, now: Date): void {
  db.prepare("UPDATE curate_claims SET expires_at=? WHERE run=?").run(new Date(now.getTime() + CLAIM_TTL_MS).toISOString(), run);
}

export function releaseClaims(db: DatabaseSync, run: string): void {
  db.prepare("DELETE FROM curate_claims WHERE run=?").run(run);
}
