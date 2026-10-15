import json,sys
R=[r for r in json.load(open(sys.argv[1])) if 'old' in r]
print('replayed',len(R),'skipped',[ (r['set'],r['n'],r.get('skip')) for r in json.load(open(sys.argv[1])) if 'old' not in r and r.get('skip')!='not_extracted'])
for v in ['old','new']:
    for s in ['s30','fresh','all']:
        rows=[r for r in R if s=='all' or r['set']==s]
        tp=sum(r['gold'] and r[v]['admit'] for r in rows); fp=sum(not r['gold'] and r[v]['admit'] for r in rows)
        P=sum(r['gold'] for r in rows); Nn=len(rows)-P
        print(v,s,f"n={len(rows)} kept-useful {tp}/{P}  admitted-useless {fp}/{Nn}  acc {(tp+Nn-fp)/len(rows):.2f}")
for r in R:
    o,n=r['old'],r['new']
    print(r['set'],r['n'],'gold',int(r['gold']),'W' if r.get('worker') else ' ','old',int(o['admit']),'new',int(n['admit']),n['dropped'],n['ev'],'|',(n.get('text') or (n.get('near') or {}).get('text') or '')[:70], (n.get('near') or {}).get('durability') or '', 'findable' if (n.get('near') or {}).get('findable') else '')
