"""哪种显式边补上了 ab search 缺的槽：边类型、方向（今天 ab get 是否显示）、目标状态。python3 edge_breakdown.py props.json queries.json out.json"""
import json,sys,collections as C
P={p['id']:p for p in json.load(open(sys.argv[1]))}
Q=json.load(open(sys.argv[2])); O={r['id']:r for r in json.load(open(sys.argv[3]))['results']}
full=lambda x: next(k for k in P if k.startswith(x))
def edges_of(a):
    p=P[a]; out=[]
    r=p['related']
    if r and r['outcome']=='refines' and r['target'] in P: out.append((r['target'],'refines','fwd'))
    if p['merged_into'] in P: out.append((p['merged_into'],'merged_into','fwd'))
    if p['supersedes'] in P: out.append((p['supersedes'],'supersedes','fwd'))
    if p['superseded_by'] in P: out.append((p['superseded_by'],'superseded_by','fwd'))
    if p['conflicts_with'] in P: out.append((p['conflicts_with'],'conflicts','fwd'))
    for c in p['pending']: out.append((c,'pending','fwd'))
    for o in P.values():
        if o['id']==a: continue
        r=o['related']
        if r and r['outcome']=='refines' and r['target']==a: out.append((o['id'],'refined_by','rev'))
        if o['merged_into']==a: out.append((o['id'],'merged_from','rev'))
        if o['supersedes']==a and P[a]['superseded_by']!=o['id']: out.append((o['id'],'supersedes(pending)','rev'))
        if o['conflicts_with']==a and o['id'] not in P[a]['pending']: out.append((o['id'],'conflicts(rev)','rev'))
    return out
res=C.Counter(); per=[]
for q in Q:
    r=O[q['id']]; got=set(r['search'])
    for s in q['slots']:
        S={full(g) for g in s}
        if S&got: continue
        hits=[(t,typ,d,P[t]['state']) for g in got for (t,typ,d) in edges_of(g) if t in S]
        if hits:
            t,typ,d,st=sorted(hits,key=lambda h:h[2])[0]  # 优先 fwd
            res[(typ,d,st)]+=1; per.append((q['id'],typ,d,st))
        else: res[('unrescued',)]+=1; per.append((q['id'],'-'))
for k,v in res.most_common(): print(v,k)
print(per)
