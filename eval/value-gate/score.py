import json,sys
R=json.load(open(sys.argv[1]))
def m(rows,v):
    tp=sum(r['gold'] and r[v]['admit'] for r in rows); fp=sum((not r['gold']) and r[v]['admit'] for r in rows)
    fn=sum(r['gold'] and not r[v]['admit'] for r in rows); tn=sum((not r['gold']) and not r[v]['admit'] for r in rows)
    acc=(tp+tn)/len(rows); return f"admit {tp+fp}/{len(rows)} acc {acc:.2f} useful-kept {tp}/{tp+fn} useless-rejected {tn}/{tn+fp}"
for s in ['s30','fresh']:
    rows=[r for r in R if r['set']==s]
    print(s,'baseline(as stored): admit 30/30, useless-rejected 0/%d'%sum(not r['gold'] for r in rows))
    for v in ['old','new']: print('  ',v,m(rows,v))
rows=R; print('all'); [print('  ',v,m(rows,v)) for v in ['old','new']]
if len(sys.argv)>2:
  for r in R:
    flag='' if r['gold']==r['new']['admit'] else ' <-- MISS'
    print(r['set'],r['n'],'gold',int(r['gold']),'old',int(r['old']['admit']),r['old']['reason'],'new',int(r['new']['admit']),r['new']['reason'],r['new'].get('durability'),'G' if r['new'].get('guidance') else '',flag)
