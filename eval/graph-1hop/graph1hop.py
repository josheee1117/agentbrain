# 只读模拟“图 1 跳扩展”：polB 召回注入的条目之外，再追加其 1 跳邻居，看能否救回整条未命中的查询。
# 边来源：(a) 关系边 edges.json（related/conflicts/merged/supersedes，双向，仅 id）；(b) 向量近邻（同项目或全局，cos>=T，取 top-k）。
import json, sqlite3, sys, collections, numpy as np
D='/workspace/agentbrain-review/recall-eval/'
HERE='/workspace/agentbrain-review/scene-eval/'
A=[json.loads(l) for l in open(D+'active.jsonl')]
byid={a['id']:a for a in A}
db=sqlite3.connect(f'file:{HERE}index.db?mode=ro',uri=True)
V={}
for fid,b in db.execute('select id,vec from vecs'):
    if fid[:8] in byid: V[fid[:8]]=np.frombuffer(b,dtype=np.float32)/np.linalg.norm(np.frombuffer(b,dtype=np.float32))
res=json.load(open(D+'res-polB.json'))['results']
G=collections.defaultdict(set)
for e in json.load(open(HERE+'edges.json')):
    for k in ('related','conflicts','merged','supersedes'):
        if k in e:
            t=e[k][1] if k=='related' else e[k]
            if t in byid and e['id'] in byid: G[e['id']].add(t); G[t].add(e['id'])
def knn(i,k,T):
    if i not in V: return set()
    p=byid[i]['proj']; c=[]
    for j,v in V.items():
        if j==i or byid[j]['proj'] not in (p,'global'): continue
        s=float(V[i]@v)
        if s>=T: c.append((s,j))
    return {j for _,j in sorted(c,reverse=True)[:k]}
def run(name,nb,split):
    rs=[r for r in res if r['gold'] and (split=='all' or r['split']==split)]
    miss=[r for r in rs if not set(r['injected'])&set(r['gold'])]
    resc=0; added=0; addgold=0
    for r in rs:
        inj=set(r['injected']); ext=set().union(*[nb(i) for i in inj]) - inj if inj else set()
        added+=len(ext - set(r['gold'])); addgold+=len(ext & set(r['gold']))
        if r in miss and ext & set(r['gold']): resc+=1
    neg=[r for r in res if not r['gold'] and (split=='all' or r['split']==split)]
    negadd=sum(len(set().union(*[nb(i) for i in r['injected']]) - set(r['injected'])) if r['injected'] else 0 for r in neg)
    return dict(variant=name,split=split,pos=len(rs),fully_missed=len(miss),rescued=resc,added_non_gold_on_pos=added,added_gold=addgold,added_on_negatives=negadd)
out=[]
for split in ('test','all'):
    out.append(run('relation-edges',lambda i:G[i],split))
    for k,T in ((1,0.6),(2,0.6),(3,0.5)):
        out.append(run(f'vec-knn k={k} cos>={T}',lambda i,k=k,T=T:knn(i,k,T),split))
for o in out: print(json.dumps(o,ensure_ascii=False))
json.dump(out,open(HERE+'graph1hop_out.json','w'),ensure_ascii=False,indent=1)
