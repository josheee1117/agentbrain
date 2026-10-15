/** 用原始会话窗口重放抽取：旧/新提示词 + 各自的 validate，看样本里的自动沉淀条目还会不会被抽出来。
 * 用法：node replay.ts <new_repo> <base_repo> <store_dir> <items.json> <out.json> */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const [newRepo, baseRepo, storeDir, itemsPath, outPath] = process.argv.slice(2);
const N = { ex: await import(join(newRepo, "src/extract.ts")), tr: await import(join(newRepo, "src/transcript.ts")), work: await import(join(newRepo, "src/work.ts")) };
const B = { ex: await import(join(baseRepo, "src/extract.ts")) };
const { sanitize } = await import(join(newRepo, "src/sanitize.ts"));
const { chatClient, loadChatConfig, parseJsonLoose } = await import(join(newRepo, "src/llm.ts"));
const { readKey } = await import(join(newRepo, "src/embed.ts"));
const { DatabaseSync } = await import("node:sqlite");
const db = new DatabaseSync(join(storeDir, "store.db"), { readOnly: true });
const cfg = loadChatConfig(join(homedir(), ".agentbrain"));
const chat = chatClient(cfg, readKey(cfg.keyService), 180_000);
const items = JSON.parse(readFileSync(itemsPath, "utf8"));
const bigr = (s: string) => { const t = s.replace(/\s+/g, ""); const o = new Set<string>(); for (let i = 0; i < t.length - 1; i++) o.add(t.slice(i, i + 2)); return o; };
const sim = (a: string, b: string) => { const A = bigr(a), Bs = bigr(b); let n = 0; for (const x of A) if (Bs.has(x)) n++; return n / Math.max(1, Math.min(A.size, Bs.size)); };
const out: any[] = [];
let i = 0;
await Promise.all(Array.from({ length: 5 }, async () => {
  while (i < items.length) {
    const it = items[i++];
    const row: any = { set: it.set, n: it.n, id: it.id, gold: it.admit, origin: it.origin };
    out.push(row);
    if (it.origin !== "extract") { row.skip = "not_extracted"; continue; }
    const ev = db.prepare("SELECT body FROM events WHERE id=?").get(it.id) as { body: string };
    const body = JSON.parse(ev.body);
    const w = db.prepare("SELECT * FROM capture_windows WHERE window_id=?").get(body.window_id) as any;
    if (!w) { row.skip = "no_window"; continue; }
    const host = body.source.host, file = body.source.transcript;
    let cleaned: any;
    try { cleaned = N.tr.cleanTranscript(host, file); } catch { row.skip = "transcript_unavailable"; continue; }
    const turns = cleaned.turns.map((t: any) => ({ ...t, text: sanitize(t.text).text }));
    const chunks = N.work.chunk(host, w.session_id, turns, w.from_anchor, true);
    const c = Array.isArray(chunks) ? chunks.find((x: any) => x.id === body.window_id) ?? chunks.find((x: any) => x.to === w.to_anchor) : undefined;
    if (!c) { row.skip = "window_mismatch"; continue; }
    row.worker = cleaned.worker;
    const anchors = new Set((body.evidence ?? []).map((e: any) => e.anchor));
    const ctx = { name: it.proj, docs: "", registry: "", confirmed: "" };
    for (const [v, mod, worker] of [["old", B.ex, false], ["new", N.ex, cleaned.worker]] as const) {
      const win = { turns: c.turns, context: c.context, ...(worker ? { worker: true } : {}) };
      let parsed: any = null;
      for (let t = 0; t < 2 && !parsed; t++) {
        try { parsed = parseJsonLoose((await chat(mod.buildMessages(win, ctx, []), { json: true })).message.content); } catch (e) { row[`${v}_err`] = String(e).slice(0, 200); }
      }
      const val = parsed ? mod.validate(parsed, win, [], c.id) : { candidates: [], dropped: { bad_shape: 1 }, evidenceDropped: {} };
      const match = val.candidates
        .map((x: any) => ({ x, s: sim(x.text, it.text), a: x.evidence.some((e: any) => anchors.has(e.anchor)) }))
        .filter((m: any) => m.s >= 0.3 || (m.a && m.s >= 0.15))
        .sort((p: any, q: any) => q.s - p.s)[0];
      // 没匹配上时，记模型原样给过的相近候选被丢的原因
      const rawC = Array.isArray(parsed?.candidates) ? parsed.candidates : [];
      const near = rawC.map((x: any) => ({ x, s: sim(String(x.text ?? ""), it.text) })).sort((p: any, q: any) => q.s - p.s)[0];
      row[v] = { admit: !!match, text: match?.x.text, kind: match?.x.kind, trigger: match?.x.trigger, guidance: match?.x.guidance, sim: match?.s, total: val.candidates.length, dropped: val.dropped, ev: val.evidenceDropped, near: !match && near && near.s >= 0.3 ? { text: near.x.text, durability: near.x.durability, findable: near.x.findable, scenario: near.x.scenario } : undefined };
    }
    process.stderr.write(".");
  }
}));
out.sort((a, b) => (a.set + String(a.n).padStart(2, "0")).localeCompare(b.set + String(b.n).padStart(2, "0")));
writeFileSync(outPath, JSON.stringify(out, null, 1));
