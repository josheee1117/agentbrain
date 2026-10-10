/**
 * 检索评测：临时 store + 真实 embedding。
 * 运行：node scripts/eval-retrieval.ts
 * 不碰 ~/.agentbrain 的 store.db / index.db。
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { Store, type Embedder, type SearchHit } from "../src/store.ts";
import { cosine, embed, fromBlob, loadEmbedConfig, readKey } from "../src/embed.ts";

const HOME = join(homedir(), ".agentbrain");
const LIMIT = 5;
const FAIL_CAP = 20;
const CLIP = 40;

interface CorpusItem {
  id: string;
  project: string | null;
  kind: "pitfall" | "rule";
  text: string;
}
interface QueryItem {
  q: string;
  project: string;
  expect: string[];
}

const corpus = JSON.parse(readFileSync(join(HOME, "eval/corpus.json"), "utf8")) as CorpusItem[];
const queries = JSON.parse(readFileSync(join(HOME, "eval/queries.json"), "utf8")) as QueryItem[];

const cfg = loadEmbedConfig(HOME);
if ("error" in cfg) throw new Error(cfg.error);
const key = readKey();
if (typeof key !== "string") throw new Error(key.error);

const dir = mkdtempSync(join(tmpdir(), "ab-eval-"));
const store = new Store(join(dir, "store.db"), join(dir, "index.db"));

function clip(s: string): string {
  const t = s.replace(/\s+/g, " ");
  return t.length <= CLIP ? t : t.slice(0, CLIP);
}

function pct(n: number, d: number): string {
  return d === 0 ? "-" : `${((n / d) * 100).toFixed(1)}%`;
}

function metrics(ranks: (number | null)[]) {
  let hit1 = 0, hit3 = 0, recall = 0, mrr = 0;
  for (const r of ranks) {
    if (r === null) continue;
    if (r <= 1) hit1++;
    if (r <= 3) hit3++;
    if (r <= LIMIT) recall++;
    mrr += 1 / r;
  }
  const n = ranks.length;
  return { hit1: pct(hit1, n), hit3: pct(hit3, n), recall: pct(recall, n), mrr: (mrr / n).toFixed(3) };
}

try {
  const nameToId = new Map<string, string>();
  const corpusToMem = new Map<string, string>();
  const memToCorpus = new Map<string, string>();
  const source = { host: null, session_id: null, transcript: null, anchor: null, summary: "eval corpus" };
  for (const item of corpus) {
    let projectId: string | null = null;
    if (item.project !== null) {
      projectId = nameToId.get(item.project) ?? store.ensureProject(item.project);
      nameToId.set(item.project, projectId);
    }
    const memId = store.remember(projectId, null, false, {
      kind: item.kind,
      text: item.text,
      source,
      confirmed: true,
    });
    corpusToMem.set(item.id, memId);
    memToCorpus.set(memId, item.id);
  }

  const embedder: Embedder = Object.assign(
    (texts: string[]) => embed(texts, cfg, key),
    { model: cfg.model },
  );
  for (;;) {
    const { pending } = await store.syncVectors(embedder, cfg.model);
    if (pending === 0) break;
  }

  const queryVecs = new Map<string, Float32Array>();
  const uniqueQs = [...new Set(queries.map((q) => q.q))];
  const vecs = await embed(uniqueQs, cfg, key);
  uniqueQs.forEach((q, i) => queryVecs.set(q, vecs[i]));

  const index = new DatabaseSync(join(dir, "index.db"));
  const vecRows = index.prepare("SELECT id, vec FROM vecs").all() as { id: string; vec: Uint8Array }[];
  const vecByMem = new Map(vecRows.map((r) => [r.id, fromBlob(r.vec)]));
  index.close();

  const ftsRanks: (number | null)[] = [];
  const hybRanks: (number | null)[] = [];
  let ftsNeg = 0, hybNeg = 0, neg = 0;
  const fails: string[] = [];
  const scans: { expect: number; other: number; negative: boolean }[] = [];

  for (const query of queries) {
    const projectId = nameToId.get(query.project);
    const opts = { projects: projectId ? [projectId] : [], includeGlobal: true, limit: LIMIT };
    const inScope = (memId: string) => {
      const item = corpus.find((c) => c.id === memToCorpus.get(memId));
      return !!item && (item.project === null || item.project === query.project);
    };
    const expectMem = new Set(query.expect.map((id) => corpusToMem.get(id)!));

    const rankOf = (hits: SearchHit[]) => {
      const i = hits.findIndex((h) => expectMem.has(h.id));
      return i === -1 ? null : i + 1;
    };
    const ftsHits = store.search(query.q, opts);
    const { hits: hybHits, degraded } = await store.searchHybrid(query.q, opts, embedder);
    if (degraded) throw new Error(`混合检索降级: ${degraded}`);

    if (query.expect.length === 0) {
      neg++;
      if (ftsHits.length) ftsNeg++;
      if (hybHits.length) hybNeg++;
    } else {
      ftsRanks.push(rankOf(ftsHits));
      const hybRank = rankOf(hybHits);
      hybRanks.push(hybRank);
      if ((hybRank === null || hybRank > 3) && fails.length < FAIL_CAP) {
        const want = query.expect.map((id) => clip(corpus.find((c) => c.id === id)!.text)).join(" | ");
        const got = hybHits.slice(0, 3).map((h) => clip(h.text)).join(" | ") || "（无）";
        fails.push(`${query.q}\n  期望: ${want}\n  top3: ${got}`);
      }
    }

    const qv = queryVecs.get(query.q)!;
    let expectMax = -1, otherMax = -1;
    for (const [memId, vec] of vecByMem) {
      if (!inScope(memId)) continue;
      const sim = cosine(qv, vec);
      if (expectMem.has(memId)) expectMax = Math.max(expectMax, sim);
      else otherMax = Math.max(otherMax, sim);
    }
    scans.push({ expect: expectMax, other: otherMax, negative: query.expect.length === 0 });
  }

  const pos = scans.filter((s) => !s.negative);
  const fts = metrics(ftsRanks);
  const hyb = metrics(hybRanks);
  const lines = [
    `语料 ${corpus.length} 条，查询 ${queries.length} 条（正例 ${ftsRanks.length}，负例 ${neg}）`,
    "",
    "指标          纯 FTS     混合",
    `hit@1       ${fts.hit1.padStart(8)}  ${hyb.hit1.padStart(8)}`,
    `hit@3       ${fts.hit3.padStart(8)}  ${hyb.hit3.padStart(8)}`,
    `recall@5    ${fts.recall.padStart(8)}  ${hyb.recall.padStart(8)}`,
    `MRR         ${fts.mrr.padStart(8)}  ${hyb.mrr.padStart(8)}`,
    `负例误报率   ${pct(ftsNeg, neg).padStart(8)}  ${pct(hybNeg, neg).padStart(8)}`,
    "",
    "门槛    召回      误报      排错",
  ];
  for (let t = 30; t <= 70; t += 5) {
    const th = t / 100;
    const recalled = pos.filter((s) => s.expect >= th).length;
    const falsePos = scans.filter((s) => s.negative && s.other >= th).length;
    const misrank = pos.filter((s) => s.other >= th && s.other > s.expect).length;
    lines.push(
      `${th.toFixed(2)}  ${pct(recalled, pos.length).padStart(8)}  ${pct(falsePos, neg).padStart(8)}  ${pct(misrank, pos.length).padStart(8)}`,
    );
  }
  lines.push("", `混合检索 hit@3 失败的正例（${fails.length} 条，最多 ${FAIL_CAP}）`);
  lines.push(fails.length ? fails.join("\n") : "（无）");
  console.log(lines.join("\n"));
} finally {
  store.close();
  rmSync(dir, { recursive: true, force: true });
}
