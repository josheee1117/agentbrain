"""提议方案的覆盖：前 8 条全文 + 第 9–16 条一行 + 前 8 条的显式关联 id（含已归档、含反向）。python3 combo.py"""
import json,collections as C
from score_linked import edges, cover, load_q
def go(qf,of):
    Q=load_q(qf)
    O={r['id']:r for r in json.load(open(of))['results']}
    out=C.defaultdict(C.Counter); extra=C.defaultdict(int)
    for q in Q:
        r=O[q['id']]; s8=set(r['search']); s16=set(r['search16'])
        lkall=set().union(*[edges['link'][g] for g in s8]); lk=lkall-s16
        for name,got in [('search8',s8),('search16',s16),('8+link',s8|lkall),('16+link8 (提议)',s16|lk)]:
            n,t=cover(q,list(got),True); lab='full' if n==t else 'part' if n else 'none'
            for sp in [q['split'],'all']: out[(name,sp)][lab]+=1
        extra[q['split']]+=len(lk)
    for k in sorted(out): print(qf,k,dict(out[k]))
    print('link ids added (not already in 16):',dict(extra))
go('linked-queries.json','out-base.json'); go('r95-multi.json','out-r95.json')
