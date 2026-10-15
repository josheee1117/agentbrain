"""窗口重放评测打分：python3 score_replay.py run1.jsonl [rematch.json]"""
import json, sys, collections
rows = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
quota = [r for r in rows if 'QUOTA' in r]
errs = [r for r in rows if r.get('error')]
W = {}
for r in rows:
    if r.get('window_id') and not r.get('error'): W[r['window_id']] = r
W = list(W.values())
if len(sys.argv) > 2:
    RM = json.load(open(sys.argv[2]))
    agree = collections.Counter()
    for r in W:
        if r['window_id'] in RM:
            for P in ['A','B']:
                old = r.get('match'+P) or {}; new = RM[r['window_id']]['match'+P]
                for x in r['refs']:
                    agree[(bool(old.get(x['id'])), bool(new.get(x['id'])))] += 1
                r['match'+P] = new
    print('matcher low vs high (labelled refs):', dict(agree))
def outs_kind(r, P, key):
    return {o['key']: o['how'] for o in r.get('outs' + P, [])}
res = {}
for P in ['A', 'B']:
    per = collections.defaultdict(lambda: collections.Counter())
    extra_new, extra_sib, total_out, merges = 0, 0, 0, 0
    samples = []
    usd = ms = 0.0
    for r in W:
        m = r.get('match' + P) or {}
        outs = r.get('outs' + P, [])
        hows = {o['key']: o['how'] for o in outs}
        total_out += len(outs)
        matched_by_label = {m[x['id']] for x in r['refs'] if m.get(x['id'])}
        matched_by_any = {v for v in m.values() if v}
        for o in outs:
            if o['key'] not in matched_by_any:
                extra_new += 1
                samples.append((r.get('project'), o['how'], o['text']))
            elif o['key'] not in matched_by_label:
                extra_sib += 1
            if o['how'] == 'merge': merges += 1
        for x in r['refs']:
            k = m.get(x['id'])
            st = 'kept' if k else 'none'
            if k and hows.get(k) == 'merge': st = 'merged'
            per[(x['set'], x['label'])][st] += 1
        if P == 'A' and r.get('A'):
            usd += r['A'].get('judge_usd') or 0; ms += r['A'].get('total_ms') or 0
        if P == 'B' and r.get('B'):
            usd += r['B'].get('usd') or 0; ms += r['B'].get('ms') or 0
    res[P] = dict(per={f'{k[0]}/{k[1]}': dict(v) for k, v in sorted(per.items())}, outputs=total_out, merges=merges, extra_not_matching_any_original=extra_new, extra_matching_unlabelled_original=extra_sib, usd=round(usd, 3), avg_ms_per_window=round(ms / max(1, len(W))), samples=samples)
def agg(P, sets, labels, kept_states=('kept', 'merged')):
    n = k = 0
    for key, v in res[P]['per'].items():
        s, l = key.split('/')
        if s in sets and l in labels:
            n += sum(v.values()); k += sum(v.get(x, 0) for x in kept_states)
    return k, n
print(f'windows={len(W)} errors={len(errs)} quota={len(quota)}')
for P in ['A', 'B']:
    print(f'== {P}')
    for sets in (['s30'], ['s60'], ['s30', 's60']):
        u = agg(P, sets, ['有用']); pu = agg(P, sets, ['有用', '部分有用']); x = agg(P, sets, ['没用'])
        print(f"  {'+'.join(sets)}: 有用留下 {u[0]}/{u[1]}  有用+部分有用留下 {pu[0]}/{pu[1]}  没用挡掉 {x[1]-x[0]}/{x[1]}")
    for k in ['outputs', 'merges', 'extra_not_matching_any_original', 'extra_matching_unlabelled_original', 'usd', 'avg_ms_per_window']:
        print(f'  {k}: {res[P][k]}')
    print('  per:', res[P]['per'])
json.dump(res, open(sys.argv[1] + '.score.json', 'w'), ensure_ascii=False, indent=1)
