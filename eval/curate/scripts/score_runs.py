#!/usr/bin/env python3
"""Score every condensed curate run in runs/ against user labels.
"留" = admit is True (merge counts as kept); "丢" = admit is False; None = undecided (wrong both ways).
gold = labels used at run time (row.gold); relabel = labels/labels90_relabel.json (2026-10-15 user rule).
"没新增" = discard/undecided or merge (merge archives the candidate and leaves the target unchanged).
usage: cd eval/curate && python3 scripts/score_runs.py > scores.md"""
import json, glob, os
REL = {(x["set"], x["n"]): x["label"] != "没用" for x in json.load(open("labels/labels90_relabel.json"))}
def rate(rows, want_keep):
    g = [r for r in rows if r["_g"] is want_keep]
    ok = sum(1 for r in g if r.get("admit") is want_keep)
    return f"{ok}/{len(g)}={100*ok/len(g):.0f}%" if g else "—"
def nonew(rows):
    g = [r for r in rows if r["_g"] is False]; ok = sum(1 for r in g if r.get("admit") is not True or r["final"] == "merge")
    return f"{ok}/{len(g)}" if g else "—"
print("| run | set | 没用被丢 (gold) | 有用+部分被留 (gold) | 没用被丢 (relabel) | 有用+部分被留 (relabel) | 没用没新增 (relabel) | merge | 未决 |")
print("|---|---|---|---|---|---|---|---|---|")
for p in sorted(glob.glob("runs/*.json")):
    j = json.load(open(p)); name = os.path.basename(p)[:-5]
    if "rows" not in j: print(f"| {name} | — | 中止：额度用完（429），预计恢复 {j.get('resetAt')}，见 logs | | | | | | |"); continue
    for s in sorted({r["set"] for r in j["rows"]}):
        xs = [r for r in j["rows"] if r["set"] == s]
        for r in xs: r["_g"] = r["gold"]
        a, b = rate(xs, False), rate(xs, True)
        if s in ("s30", "s60"):
            for r in xs: r["_g"] = REL[(s, r["n"])]
            c, d, e = rate(xs, False), rate(xs, True), nonew(xs)
        else: c = d = e = "—"
        m = sum(1 for r in xs if r["final"] == "merge"); u = sum(1 for r in xs if r.get("admit") is None)
        print(f"| {name} | {s} | {a} | {b} | {c} | {d} | {e} | {m} | {u} |")
