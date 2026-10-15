#!/usr/bin/env python3
"""How eval/ was assembled (2026-10-15). Sources are private working dirs, not in the repo:
  R = box /workspace/agentbrain-review   (recall-eval, value-audit, scene-eval, one-off samples)
  M = copy of Mac ~/.agentbrain/eval     (curate runs, labels, retrieval v1 corpus, replay)
Every text file goes through scrub.py. Full memory dumps (active.jsonl, s60_props.json, emb-cache.json,
index.db/store.db snapshots, transcripts) are NOT copied; id/metadata-only versions are written instead.
"""
import json, os, re, shutil, sys, glob
sys.path.insert(0, os.path.dirname(__file__))
from scrub import scrub

R = "/workspace/agentbrain-review"; M = "/workspace/evalrec"
OUT = os.path.join(os.path.dirname(__file__), "..")

def put(src, dst):
    t, hits = scrub(open(src, encoding="utf-8").read())
    d = os.path.join(OUT, dst); os.makedirs(os.path.dirname(d), exist_ok=True)
    if d.endswith(".json"): json.loads(t)
    open(d, "w", encoding="utf-8").write(t)
    if hits: print(dst, hits)

def walk(o, hits):
    if isinstance(o, str):
        t, h = scrub(o)
        for k, v in h.items(): hits[k] = hits.get(k, 0) + v
        return t
    if isinstance(o, list): return [walk(x, hits) for x in o]
    if isinstance(o, dict): return {k: walk(v, hits) for k, v in o.items()}
    return o

def putj(obj, dst):
    hits = {}
    t = json.dumps(walk(obj, hits), ensure_ascii=False, indent=1)
    d = os.path.join(OUT, dst); os.makedirs(os.path.dirname(d), exist_ok=True)
    json.loads(t); open(d, "w", encoding="utf-8").write(t + "\n")
    if hits: print(dst, hits)

# retrieval v1 (2026-10-10, scripts/eval-retrieval.ts)
put(f"{M}/corpus.json", "retrieval-v1/corpus.json"); put(f"{M}/queries.json", "retrieval-v1/queries.json")

# recall accuracy / policy (#49 #50)
for f in ["queries.json", "eval.ts", "sweep.ts", "diag.ts", "dump.ts", "baseline-mac.json"]:
    put(f"{R}/recall-eval/{f}", f"recall/{f}")
for v in ["base", "agentbrain", "polA", "polB"]:
    put(f"{R}/recall-eval/res-{v}.json", f"recall/results/res-{v}.json")
meta = []
for l in open(f"{R}/recall-eval/active.jsonl"):
    a = json.loads(l); meta.append({k: a[k] for k in a if k not in ("text", "why", "trigger", "v")})
putj(meta, "recall/active-meta.json")

# one-off guard (#40 #43 #46)
put(f"{R}/oneoff-sample48.json", "oneoff/sample48.json"); put(f"{R}/oneoff-heldout160.json", "oneoff/heldout160.json")
put(f"{R}/score.ts", "oneoff/score.ts"); put(f"{R}/score-held.ts", "oneoff/score-held.ts")
put(f"{R}/eval-40-42.md", "oneoff/eval-40-42-review.md")

# value-standard gate (#51)
V = f"{R}/value-audit"
for f in ["sample30.json", "sample30.md", "labels30.json", "labels_fresh30.json", "gate.ts", "gate_items.json",
          "gate_out_v1.json", "gate_v2a.json", "gate_v2b.json", "replay.ts", "replay_v1.json", "score.py",
          "rscore.py", "gen.py", "dump.ts", "proj.ts", "q.mjs"]:
    put(f"{V}/{f}", f"value-gate/{f}")

# curate (#54): labels + condensed runs + scripts
for f in ["labels60.json", "labels90.json", "labels90_relabel.json", "sample60.json", "sample60.md"]:
    put(f"{V}/{f}", f"curate/labels/{f}")
put(f"{M}/curate_items.json", "curate/labels/curate_items.json")
put(f"{M}/label/items.json", "curate/labels/s60_items.json")
for f in ["rearb.ts", "dump_props.ts", "wk.ts", "run_v3.sh", "run90.sh", "runv4.sh", "runcli.sh"]:
    put(f"{M}/{f}", f"curate/scripts/{f}")
put(f"{R}/eval/score90.py", "curate/scripts/score90.py"); put(f"{R}/score_curate.py", "curate/scripts/score_curate.py")
KEEP = ("set", "n", "id", "gold", "route", "final", "admit", "votes", "context")
for p in sorted(p for p in glob.glob(f"{M}/curate_*.json") if not p.endswith("curate_items.json")):
    j = json.load(open(p)); name = os.path.basename(p)[len("curate_"):-5]
    if "rows" not in j:
        putj(j, f"curate/runs/{name}.json"); continue
    rows = [{k: r[k] for k in KEEP if k in r} | {"into": [v["j"].get("into") for v in r.get("vote_detail", []) if v.get("j")]} for r in j["rows"]]
    out = {"summary": j["summary"], "rows": rows}
    if "rearb_stats" in j: out["rearb_stats"] = j["rearb_stats"]
    putj(out, f"curate/runs/{name}.json")
for p in sorted(glob.glob(f"{M}/curate_*.log")):
    put(p, f"curate/runs/logs/{os.path.basename(p)}")

# one-pass vs two-pass replay (in progress; PR #54 scripts/replay-eval.ts)
put(f"{R}/eval/replay/score_replay.py", "onepass-replay/score_replay.py"); put(f"{M}/replay/probe.ts", "onepass-replay/probe.ts")
put(f"{M}/replay/run1.log", "onepass-replay/run1.log")
rows = []
for l in open(f"{M}/replay/run1.jsonl"):
    w = json.loads(l)
    def c(x): return {k: x.get(k) for k in x if k not in ("cands", "raw", "text", "prompt", "out")} | {"n_cands": len(x.get("cands", []))} if isinstance(x, dict) else x
    rows.append({k: (c(v) if k in ("A", "B") else v) for k, v in w.items() if k not in ("text", "window_text")})
putj(rows, "onepass-replay/run1-meta.json")

# graph 1-hop, scene simulation, scene directory session-start eval
S = f"{R}/scene-eval"
for f in ["graph1hop.py", "edges.json", "graph1hop_out.json"]: put(f"{S}/{f}", f"graph-1hop/{f}")
for f in ["sim.py", "sim2.py", "stats.py", "sim_out.txt", "sim2_out.txt", "stats_out.txt"]: put(f"{S}/{f}", f"scene-sim/{f}")
for f in ["genq.ts", "common.ts", "evalscene.ts", "dump.ts", "questions.json", "genq.log"]:
    put(f"{S}/session-start/{f}", f"scene-directory/{f}")
for p in sorted(glob.glob(f"{S}/session-start/res-*.json")):
    j = json.load(open(p)); j.pop("briefs", None)
    putj(j, f"scene-directory/results/{os.path.basename(p)}")
