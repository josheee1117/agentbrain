"""评测 14 搜索层打分：python3 score_impl.py <eval/linked-recall 目录> ids.json
用的是真实 CLI 输出里实际显示出来的 id（cli-run.ts 产出），不是模拟。
槽的定义、"理由"槽、full/part/none 与评测 13 的 score_linked.py 相同；区别：
- 改动前 = ab search 显示的 8 条全文行；
- 改动后 = 8 条全文行 + 全文行下"关联:"里列出的 id + 第 9–16 名一行版；另报只加第 9–16 名、只加关联的拆分。
- 理由槽只认全文行（第 9–16 名一行版、关联 id 都不显示 why），前后口径一样。"""
import json, sys, os, collections as C
d = sys.argv[1]
P = {p['id']: p for p in json.load(open(os.path.join(d, 'props-meta.json')))}
def full(pfx): return next(k for k in P if k.startswith(pfx))
Q = {}
for f in ['linked-queries.json', 'r95-multi.json']:
    for q in json.load(open(os.path.join(d, f))):
        q['slots'] = [[full(g) for g in s] for s in q['slots']]; q['set'] = f; Q[q['id']] = q
I = json.load(open(sys.argv[2]))
def cover(q, got, why_rows):
    got = set(got); n = sum(1 for s in q['slots'] if got & set(s)); t = len(q['slots'])
    if q.get('need_why'):
        t += 1
        if any(g in set(why_rows) and P[g]['why'] for s in q['slots'] for g in s): n += 1
    return n, t
lab = lambda n, t: 'full' if n == t else ('part' if n else 'none')
rows = []
for cond in ['before', 'after']:
    for r in I[cond]:
        q = Q[r['id']]
        views = {'shown': r['full'] + r['links'] + r['more'], 'full8': r['full'], 'full8+more': r['full'] + r['more'], 'full8+links': r['full'] + r['links']}
        for v, got in views.items():
            n, t = cover(q, got, r['full'])
            rows.append({'id': r['id'], 'set': q['set'], 'split': q['split'], 'cond': cond, 'view': v, 'n': n, 't': t, 'label': lab(n, t),
                         'extra_ids': len(set(got) - set(r['full'])), 'search_chars': r['search_chars'], 'get_chars': r['get_chars']})
json.dump(rows, open('scored.json', 'w'), ensure_ascii=False, indent=0)
med = lambda xs: sorted(xs)[len(xs) // 2]
for qs in ['linked-queries.json', 'r95-multi.json']:
    print(f'\n=== {qs}')
    for split in ['tune', 'test', 'all']:
        for cond, v in [('before', 'shown'), ('after', 'full8+more'), ('after', 'full8+links'), ('after', 'shown')]:
            L = [x for x in rows if x['set'] == qs and (split == 'all' or x['split'] == split) and x['cond'] == cond and x['view'] == v]
            c = C.Counter(x['label'] for x in L)
            print(f"{split:4s} {cond:6s} {v:12s} n={len(L):2d} full {c['full']:2d} part {c['part']:2d} none {c['none']:2d} slots {sum(x['n'] for x in L)}/{sum(x['t'] for x in L)}")
print('\n=== 输出长度（字符，中位数 / 平均）')
for cond in ['before', 'after']:
    L = [x for x in rows if x['cond'] == cond and x['view'] == 'shown']
    for k in ['search_chars', 'get_chars']:
        xs = [x[k] for x in L]; print(cond, k, 'median', med(xs), 'mean', round(sum(xs) / len(xs)))
