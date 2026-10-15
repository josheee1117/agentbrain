# 只读模拟“场景层”：按项目内 embedding 聚类，当召回命中某条时追加其簇（场景）内容。
import json, sqlite3, base64, sys, numpy as np, collections
from sklearn.cluster import AgglomerativeClustering
D='/workspace/agentbrain-review/recall-eval/'
A=[json.loads(l) for l in open(D+'active.jsonl')]
byid={a['id']:a for a in A}
db=sqlite3.connect('file:/workspace/agentbrain-review/scene-eval/index.db?mode=ro',uri=True)
V={}
for fid,b in db.execute('select id,vec from vecs'):
    s=fid[:8]
    if s in byid: V[s]=np.frombuffer(b,dtype=np.float32)
A=[a for a in A if a['id'] in V]
def nz(v): return v/np.linalg.norm(v)
for a in A: a['v']=nz(V[a['id']])
cache=json.load(open(D+'emb-cache.json'))
res=json.load(open(D+'res-polB.json'))['results']
def qv(t): return nz(np.frombuffer(base64.b64decode(cache[t]),dtype=np.float32))
projs=collections.defaultdict(list)
for a in A: projs[a['proj']].append(a)

def cluster(mode,t=None):
    cid={}
    for p,L in projs.items():
        if mode=='kind':
            for a in L: cid[a['id']]=f"{p}|{a['kind']}"
            continue
        if len(L)==1: cid[L[0]['id']]=p+'|0'; continue
        X=np.stack([a['v'] for a in L])
        lab=AgglomerativeClustering(n_clusters=None,metric='cosine',linkage='average',distance_threshold=t).fit_predict(X)
        for a,l in zip(L,lab): cid[a['id']]=f"{p}|{l}"
    mem=collections.defaultdict(list)
    for k,c in cid.items(): mem[c].append(k)
    return cid,mem

def run(name,cid,mem,split,cap=None):
    rs=[r for r in res if split=='all' or r['split']==split]
    pos=[r for r in rs if r['gold']]
    b_hit=s_hit=0; b_chars=s_chars=0; noise=0; rescued=[]
    for r in pos:
        inj=r['injected']; gold=set(r['gold'])
        bh=any(i in gold for i in inj); b_hit+=bh
        b_chars+=sum(len(byid[i]['text']) for i in inj if i in byid)
        q=qv(r['query'])
        extra=[]; seen=set(inj)
        for i in inj:
            if i not in cid: continue
            ms=[m for m in mem[cid[i]] if m not in seen]
            ms.sort(key=lambda m:-float(byid[m]['v']@q))
            budget=cap
            for m in ms:
                L=len(byid[m]['text'])
                if budget is not None:
                    if budget<L: break
                    budget-=L
                extra.append(m); seen.add(m)
        sh=bh or any(m in gold for m in extra); s_hit+=sh
        if sh and not bh: rescued.append(r['id'])
        s_chars+=sum(len(byid[m]['text']) for m in extra)
        noise+=sum(1 for m in extra if m not in gold)
    n=len(pos); sizes=[len(v) for v in mem.values()]
    return dict(variant=name,split=split,clusters=len(mem),avg_size=round(np.mean(sizes),1),max_size=max(sizes),
        base_cov=round(b_hit/n,3),scene_cov=round(s_hit/n,3),rescued=rescued,
        base_chars_per_q=round(b_chars/n),extra_chars_per_q=round(s_chars/n),extra_nongold_per_q=round(noise/n,1))

out=[]
for split in ['test','all']:
    out.append(run('project×kind',*cluster('kind'),split))
    for t in [0.25,0.35,0.45]:
        c,m=cluster('emb',t)
        out.append(run(f'emb t={t}',c,m,split))
        out.append(run(f'emb t={t} cap1500',c,m,split,cap=1500))
for o in out: print(json.dumps(o,ensure_ascii=False))

# 场景优先检索：按簇质心排序，注入 top-1 簇（cap 1500），看覆盖与负样本误注入
c,m=cluster('emb',0.35)
cent={k:nz(np.mean([byid[x]['v'] for x in v],axis=0)) for k,v in m.items()}
for split in ['test','all']:
    rs=[r for r in res if split=='all' or r['split']==split]
    for th in [0.0,0.45,0.55]:
        hit=fi=0;chars=0
        for r in rs:
            q=qv(r['query'])
            ks=[k for k in cent if (r['project'] is None and k.startswith('GLOBAL|')) or k.split('|')[0] in (r['project'],'GLOBAL')]
            best=max(ks,key=lambda k:float(cent[k]@q)); s=float(cent[best]@q)
            if s<th: continue
            ms=sorted(m[best],key=lambda x:-float(byid[x]['v']@q)); inj=[];bud=1500
            for x in ms:
                if len(byid[x]['text'])>bud: break
                bud-=len(byid[x]['text']); inj.append(x)
            chars+=sum(len(byid[x]['text']) for x in inj)
            if r['gold']: hit+=any(x in r['gold'] for x in inj)
            else: fi+=1
        pos=sum(1 for r in rs if r['gold']); neg=len(rs)-pos
        print(json.dumps(dict(variant=f'scene-first top1 th={th}',split=split,cov=round(hit/pos,3),falseInj=f'{fi}/{neg}',chars_per_q=round(chars/len(rs))),ensure_ascii=False))
# 漏召回里 gold 是否在同项目同簇（t=0.35）里与某条已注入条目同簇
miss=[r for r in res if r['gold'] and not any(i in r['gold'] for i in r['injected'])]
print('missed',len(miss),'with_any_injection',sum(1 for r in miss if r['injected']))
