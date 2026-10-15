"""一步式 vs 两步式 vs 只审稿（astra v4 / Haiku）在同一批可重放标签条目上的对比。
用法：python3 compare.py <run.jsonl|run1-meta.json> <rematch_high.json> <labels90_relabel.json> <astra_v4_solo.json> <haiku_judge.json>
仓库内复现（不需要私有数据）：
  python3 eval/onepass-replay/compare.py eval/onepass-replay/run1-meta.json eval/onepass-replay/rematch_high.json \
    eval/curate/labels/labels90_relabel.json eval/curate/runs/v4b_solo.json eval/curate/runs/haiku.json
- A 两步 / B 一步：窗口重放结果，标签条目被产出匹配上（含 merge）= 留下，没匹配上 = 没进库（挡掉）。匹配用 high 二次匹配（rematch 覆盖 low）。
- astra-v4 / haiku 只审稿：对原抽取出来的那条候选给的结论，admit=True 算留下（merge 也算留下，和第 6 篇口径一致）。
- 只统计 A/B 都跑完的窗口里的标签条目，四种做法同一批条目。
"""
import json, sys, collections
run, rem, labp, astp, haip = sys.argv[1:6]
rows = {}
_txt = open(run).read()
_recs = json.loads(_txt) if _txt.lstrip().startswith('[') else [json.loads(l) for l in _txt.splitlines() if l.strip()]
errored = [r['window_id'] for r in _recs if r.get('error')]
for r in _recs:
    if r.get('window_id') and not r.get('error'): rows[r['window_id']] = r
RM = json.load(open(rem))
missing_rm = [w for w in rows if w not in RM]
for w, r in rows.items():
    if w in RM:
        r['matchA'] = RM[w]['matchA']; r['matchB'] = RM[w]['matchB']
lab = {x['id']: x for x in json.load(open(labp))}
def judge(p):
    return {r['id']: r for r in json.load(open(p))['rows']}
AST, HAI = judge(astp), judge(haip)
items = []  # (id, set, label, A, B, astra, haiku)
for r in rows.values():
    for x in r['refs']:
        a = bool((r.get('matchA') or {}).get(x['id'])); b = bool((r.get('matchB') or {}).get(x['id']))
        items.append(dict(id=x['id'], set=x['set'], n=x['n'], label=lab[x['id']]['label'], A=a, B=b,
                          astra=AST[x['id']]['admit'] is True, haiku=HAI[x['id']]['admit'] is True))
def line(name, key, sel=lambda i: True):
    xs = [i for i in items if sel(i)]
    u = [i for i in xs if i['label'] == '有用']; pu = [i for i in xs if i['label'] != '没用']; x = [i for i in xs if i['label'] == '没用']
    f = lambda g, want: f"{sum(1 for i in g if i[key] is want)}/{len(g)}"
    acc = sum(1 for i in xs if i[key] == (i['label'] != '没用'))
    return f"| {name} | {f(u, True)} | {f(pu, True)} | {f(x, False)} | {acc}/{len(xs)} |"
print(f"windows={len(rows)} errored={len(errored)} labelled_items={len(items)} windows_without_high_rematch={len(missing_rm)}")
dist = collections.Counter((i['set'], i['label']) for i in items)
print('labels:', dict(dist))
for scope, sel in [('全部', lambda i: True), ('s30', lambda i: i['set'] == 's30'), ('s60', lambda i: i['set'] == 's60')]:
    print(f"\n### {scope}\n| 做法 | 有用留下 | 有用+部分有用留下 | 没用挡掉 | 总对 |\n|---|---|---|---|---|")
    for name, key in [('A 两步（flash 抽 + Haiku 审）', 'A'), ('B 一步（Haiku 抽+判）', 'B'), ('只审稿 astra v4（原候选）', 'astra'), ('只审稿 Haiku max（原候选）', 'haiku')]:
        print(line(name, key, sel))
# 产出与成本
def cost(P):
    out = merges = 0; usd = ms = 0.0
    for r in rows.values():
        outs = r.get('outs' + P, []); out += len(outs); merges += sum(1 for o in outs if o['how'] == 'merge')
        if P == 'A' and r.get('A'): usd += (r['A'].get('judge_usd') or 0); ms += r['A'].get('total_ms') or 0
        if P == 'B' and r.get('B'): usd += r['B'].get('usd') or 0; ms += r['B'].get('ms') or 0
    return out, merges, usd, ms / max(1, len(rows)) / 1000
print("\n| 做法 | 产出条数 | 其中 merge | 空产出窗口 | Haiku 费用（$） | 每窗口平均耗时（s） |\n|---|---|---|---|---|---|")
for P, name in [('A', 'A 两步'), ('B', 'B 一步')]:
    o, m, u, s = cost(P)
    empty = sum(1 for r in rows.values() if not r.get('outs' + P))
    print(f"| {name} | {o} | {m} | {empty} | {u:.2f} | {s:.0f} |")
print("\n分歧（A/B 与标签不一致的条目）：")
for i in sorted(items, key=lambda i: (i['set'], i['n'])):
    want = i['label'] != '没用'
    if i['A'] != want or i['B'] != want:
        print(f"  {i['set']}#{i['n']} 标={i['label']} A={'留' if i['A'] else '无'} B={'留' if i['B'] else '无'} astra={'留' if i['astra'] else '丢'} haiku={'留' if i['haiku'] else '丢'}")
