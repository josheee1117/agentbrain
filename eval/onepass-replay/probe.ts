import { Store } from "~/code_me/agentbrain-p2v4/src/store.ts";
import { cleanTranscript } from "~/code_me/agentbrain-p2v4/src/transcript.ts";
import { readFileSync, existsSync } from "node:fs";
const E = process.env.HOME + "/.agentbrain/eval";
const s = new Store(E + "/s60home/store.db", E + "/s60home/index.db");
const props = s.project().props;
const L = JSON.parse(readFileSync(E + "/labels90_relabel.json", "utf8"));
const db = s.workDb;
const out: any = { byOrigin: {}, rows: [] };
for (const i of L) {
  const p = props.get(i.id)!;
  out.byOrigin[p.origin] = (out.byOrigin[p.origin] ?? 0) + 1;
  if (p.origin !== "extract") continue;
  const cc = db.prepare("SELECT window_id FROM capture_candidates WHERE event_id=?").get(i.id) as any;
  const w = cc ? (db.prepare("SELECT * FROM capture_windows WHERE window_id=?").get(cc.window_id) as any) : null;
  const sess = w ? (db.prepare("SELECT transcript FROM capture_sessions WHERE host=? AND session_id=?").get(w.host, w.session_id) as any) : null;
  let found = "no_candidate_row";
  if (cc && !w) found = "no_window_row";
  else if (w && !sess?.transcript) found = "no_transcript_path";
  else if (w && !existsSync(sess.transcript)) found = "transcript_missing";
  else if (w) {
    try {
      const t = cleanTranscript(w.host, sess.transcript).turns;
      const a = w.from_anchor ? t.findIndex((x: any) => x.anchor === w.from_anchor) : -1;
      const b = t.findIndex((x: any) => x.anchor === w.to_anchor);
      found = b < 0 || (w.from_anchor && a < 0) ? "anchor_missing" : `ok:${b - a}turns`;
    } catch (e) { found = "clean_error"; }
  }
  out.rows.push({ set: i.set, n: i.n, label: i.label, window: cc?.window_id?.slice(0, 10) ?? null, found, src: p.source.host, anchor: p.source.anchor });
}
console.log(JSON.stringify(out, null, 0));
