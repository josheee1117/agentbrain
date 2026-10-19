#!/usr/bin/env python3
"""评测 12 汇总：python3 eval/recall-misses/analyze.py [--base <eval11 astra1.jsonl>] [--variant var1.jsonl ...]
读 eval/recall-misses/items.json（42 条标签条目的元数据、四种做法的结果、同窗口追问结论），
可选读召回版提示词试跑结果（probe.ts --mode variant 的输出，可给多个文件，按窗口去重取第一条成功的），
和 eval 11 的 astra 原窗口结果（L）同口径对比。只读，不调模型。"""
import json, sys, os, collections
here = os.path.dirname(os.path.abspath(__file__))
items = json.load(open(os.path.join(here, 'items.json')))
U = [i for i in items if i['label'] != '没用']
# 人工复核后的个别改判（证据见 docs/eval/12 第 3 节）：25946296 在 T 里有一条弱化版产出（只说"可移植、补安装说明"，没说"在全新空配置里真跑 pi install"），匹配员判不算。
OVERRIDE = {('25946296', 'T'): 'weak_version'}
def cause(i, run):
    o = OVERRIDE.get((i['id'][:8], run))
    if o: return o
    p = i['inwindow_probe'] or {}
    v = p.get('verdict')
    if v in ('new', 'merge'): return 'not_selected'
    if p.get('why_skip') == 'already_known': return 'already_in_docs'
    if v == 'skip': return 'standard_drops:' + str(p.get('why_skip'))
    return 'no_probe'
print('## 漏检原因（每条漏检 × 做法）')
tot = collections.Counter()
for run, key in [('B 一步 Haiku（eval 07）', 'kept_B'), ('L 一步 astra 原窗口（eval 11）', 'kept_L'), ('T 一步 astra 话题窗口（eval 11）', 'kept_T')]:
    miss = [i for i in U if i[key] is False]
    c = collections.Counter(cause(i, key[-1]) for i in miss)
    tot.update(c)
    print(f'{run}: 漏 {len(miss)}/{len(U)}', dict(c))
print('合计', sum(tot.values()), dict(tot))
distinct = [i for i in U if not (i['kept_B'] and i['kept_L'] and i['kept_T'])]
print('至少漏过一次的不同条目', len(distinct), dict(collections.Counter(cause(i, 'X') for i in distinct)))
print('三次都漏', [i['id'][:8] for i in U if not i['kept_B'] and not i['kept_L'] and not i['kept_T']])
print('三次里至少一次留下', sum(1 for i in U if i['kept_B'] or i['kept_L'] or i['kept_T']), '/', len(U), '；三次都留下', sum(1 for i in U if i['kept_B'] and i['kept_L'] and i['kept_T']))

print('\n## 同窗口追问的校准（astra，同一提示词标准、同一窗口，逐条问会不会记）')
for lab in ['有用', '部分有用', '没用']:
    xs = [i for i in items if i['label'] == lab and i['inwindow_probe']]
    k = sum(1 for i in xs if i['inwindow_probe']['verdict'] in ('new', 'merge'))
    print(f'  {lab}: 会记 {k}/{len(xs)}', dict(collections.Counter((i['inwindow_probe'].get('why_skip') or '-') for i in xs if i['inwindow_probe']['verdict'] == 'skip')))

print('\n## 漏检集中在哪（有用+部分有用 26 条，留下数/总数）')
def tab(name, f):
    g = collections.defaultdict(list)
    for i in U: g[f(i)].append(i)
    print(name)
    for k, v in sorted(g.items(), key=lambda x: str(x[0])):
        s = lambda key: f"{sum(1 for i in v if i[key])}/{sum(1 for i in v if i[key] is not None)}"
        print(f"  {str(k):24s} n={len(v):2d}  A两步 {s('kept_A'):6s} B {s('kept_B'):6s} L {s('kept_L'):6s} T {s('kept_T'):6s}")
tab('子集', lambda i: i['set'])
tab('种类', lambda i: i['kind'])
tab('依据', lambda i: i['basis'])
tab('子代理会话', lambda i: i['worker'])
tab('证据只在子代理第一轮（派活提示）', lambda i: i['evidence_only_first_turn_of_worker'])
tab('窗口字数', lambda i: '<15k' if i['window_chars'] < 15000 else ('15-40k' if i['window_chars'] < 40000 else '>40k'))
tab('原抽取器在该窗口的条数', lambda i: '<=3' if i['orig_candidates_in_window'] <= 3 else ('4-5' if i['orig_candidates_in_window'] <= 5 else '6+'))
print('证据位置都在被重放的窗口内：', all(w == ['window'] for i in items for w in [i['evidence_where']] if i['window_chars']))

args = sys.argv[1:]
basep = os.path.join(here, '..', 'topic-windows', 'runs', 'astra1.jsonl')  # eval 11 的原始结果（PR #59 分支 eval/topic-windows/）
if '--base' in args:
    k = args.index('--base'); basep = args[k + 1]; del args[k:k + 2]
if args and args[0] == '--variant':
    files = args[1:]
    V = {}
    for f in files:
        rows_in = json.load(open(f)) if f.endswith('.json') else [json.loads(l) for l in open(f) if l.strip()]  # variant-meta.json 是去掉原始输出的数组版
        for o in rows_in:
            if o.get('window_id') and not o.get('error') and 'match' in o and o['window_id'] not in V: V[o['window_id']] = o
    base = {}
    bp = basep
    if os.path.exists(bp):
        for l in open(bp):
            o = json.loads(l)
            for w in o.get('windows', []) or []:
                if 'matchL' in w: base[w['window_id']] = w
    lab = {i['id']: i for i in items}
    rows = []
    for wid, o in V.items():
        if o.get('match_invalid'): continue
        for r in o['refs']:
            b = base.get(wid)
            rows.append(dict(id=r['id'], label=lab[r['id']]['label'], set=r['set'], kind=lab[r['id']]['kind'], V=bool(o['match'].get(r['id'])), L=(bool(b['matchL'].get(r['id'])) if b else None)))
    both = [r for r in rows if r['L'] is not None]
    def line(name, key, xs):
        u = [r for r in xs if r['label'] == '有用']; pu = [r for r in xs if r['label'] != '没用']; x = [r for r in xs if r['label'] == '没用']
        f = lambda g, want: f"{sum(1 for r in g if r[key] is want)}/{len(g)}"
        acc = sum(1 for r in xs if r[key] == (r['label'] != '没用'))
        return f"| {name} | {f(u, True)} | {f(pu, True)} | {f(x, False)} | {acc}/{len(xs)} |"
    print(f'\n## 召回版提示词 V1 vs 现提示词（astra，同一批原窗口；窗口 {len(V)}，两边都有结果的条目 {len(both)}）')
    for scope, sel in [('全部', lambda r: True), ('s30', lambda r: r['set'] == 's30'), ('s60', lambda r: r['set'] == 's60')]:
        xs = [r for r in both if sel(r)]
        print(f'### {scope}\n| 提示词 | 有用留下 | 有用+部分有用留下 | 没用挡掉 | 总对 |\n|---|---|---|---|---|')
        print(line('现提示词（eval 11 L）', 'L', xs)); print(line('召回版 V1', 'V', xs))
    print('V1 对 L 的分歧：')
    for r in both:
        if r['V'] != r['L']: print(f"  {r['set']} {r['id'][:8]} {r['label']} {r['kind']} L={'留' if r['L'] else '挡'} V1={'留' if r['V'] else '挡'}")
    n_out = sum(len(o['items']) for o in V.values()); n_base = sum(len(base[w].get('outsL', [])) for w in V if w in base)
    ms = [o['ms'] for o in V.values() if o.get('ms')]
    bms = [base[w]['L']['ms'] for w in V if w in base and base[w].get('L', {}).get('ms')]
    print(f'产出条数 V1 {n_out} vs L {n_base}；平均每次耗时 V1 {sum(ms)/max(1,len(ms))/1000:.0f}s vs L {sum(bms)/max(1,len(bms))/1000:.0f}s；无效/超上限', dict(collections.Counter(k for o in V.values() for k, v in (o.get('invalid') or {}).items() for _ in range(v))))
    # 产出里没对上任何原条目的新条目
    newc = sum(1 for o in V.values() for x in o['outs'] if x['key'] not in {v for v in o['match'].values() if v})
    print('V1 产出中和任何原条目都对不上的', newc)

# 同模型两种提示词对比（换模型续跑用）：python3 analyze.py --pair <base.jsonl|json> <v1.jsonl|json> [--label 名字]
# 两个文件都是 probe.ts 的输出（--mode base / --mode variant），只比两边都有成功结果的窗口。
def load_rows(f):
    rs = json.load(open(f)) if f.endswith('.json') else [json.loads(l) for l in open(f) if l.strip()]
    out = {}
    for o in rs:
        if o.get('window_id') and not o.get('error') and 'match' in o and o['window_id'] not in out: out[o['window_id']] = o
    return out
if args and args[0] == '--pair':
    lab_name = 'Volcano'
    if '--label' in args:
        k = args.index('--label'); lab_name = args[k + 1]; del args[k:k + 2]
    Bw, Vw = load_rows(args[1]), load_rows(args[2])
    lab = {i['id']: i for i in items}
    wins = [w for w in Vw if w in Bw and not Vw[w].get('match_invalid') and not Bw[w].get('match_invalid')]
    skipped = sorted(set(Vw) ^ set(Bw) | {w for w in Vw if w in Bw and (Vw[w].get('match_invalid') or Bw[w].get('match_invalid'))})
    rows = []
    for w in wins:
        for r in Vw[w]['refs']:
            rows.append(dict(id=r['id'], label=lab[r['id']]['label'], set=r['set'], kind=lab[r['id']]['kind'], B=bool(Bw[w]['match'].get(r['id'])), V=bool(Vw[w]['match'].get(r['id']))))
    def line(name, key, xs):
        u = [r for r in xs if r['label'] == '有用']; pu = [r for r in xs if r['label'] != '没用']; x = [r for r in xs if r['label'] == '没用']
        f = lambda g, want: f"{sum(1 for r in g if r[key] is want)}/{len(g)}"
        acc = sum(1 for r in xs if r[key] == (r['label'] != '没用'))
        return f"| {name} | {f(u, True)} | {f(pu, True)} | {f(x, False)} | {acc}/{len(xs)} |"
    models = sorted({o.get('model') for o in list(Bw.values()) + list(Vw.values())})
    print(f'\n## 同模型对比（{lab_name}；模型 {models}；窗口 {len(wins)}，条目 {len(rows)}；未计入的窗口 {[w[:8] for w in skipped]}）')
    for scope, sel in [('全部', lambda r: True), ('s30', lambda r: r['set'] == 's30'), ('s60', lambda r: r['set'] == 's60')]:
        xs = [r for r in rows if sel(r)]
        print(f'### {scope}\n| 提示词 | 有用留下 | 有用+部分有用留下 | 没用挡掉 | 总对 |\n|---|---|---|---|---|')
        print(line('现提示词', 'B', xs)); print(line('召回版 V1', 'V', xs))
    print('种类（有用类）：', {k: (sum(1 for r in rows if r['kind'] == k and r['label'] != '没用' and r['B']), sum(1 for r in rows if r['kind'] == k and r['label'] != '没用' and r['V']), sum(1 for r in rows if r['kind'] == k and r['label'] != '没用')) for k in sorted({r['kind'] for r in rows})}, '(现, V1, 总)')
    print('分歧：')
    for r in rows:
        if r['V'] != r['B']: print(f"  {r['set']} {r['id'][:8]} {r['label']} {r['kind']} 现={'留' if r['B'] else '挡'} V1={'留' if r['V'] else '挡'}")
    for name, W in [('现提示词', Bw), ('V1', Vw)]:
        n = sum(len(W[w]['items']) for w in wins); ms = [W[w]['ms'] for w in wins if W[w].get('ms')]
        cov = sum(1 for w in wins for k, v in W[w]['match'].items() if v); tot = sum(len(W[w]['match']) for w in wins)
        newc = sum(1 for w in wins for x in W[w]['outs'] if x['key'] not in {v for v in W[w]['match'].values() if v})
        inv = dict(collections.Counter(k for w in wins for k, v in (W[w].get('invalid') or {}).items() for _ in range(v)))
        print(f'{name}: 产出 {n}（每窗口 {n/max(1,len(wins)):.1f}）；每次抽取平均 {sum(ms)/max(1,len(ms))/1000:.0f}s（{len(ms)} 次）；对上原候选 {cov}/{tot}；对不上任何原条目的新产出 {newc}；无效/超上限 {inv}；无信号窗口 {sum(1 for w in wins if W[w].get("no_signal"))}')
