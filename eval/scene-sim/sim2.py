# 控制组：同一检索范围下，“按簇注入”vs“直接按条目注入”，阈值在 tune 上选、test 上报
exec(open('sim.py').read().split("out=[]")[0])
elig_kinds={'pitfall','rule','decision'}
def universe(r,elig):
    L=[a for a in A if a['proj'] in ((r['project'],'GLOBAL') if r['project'] else ('GLOBAL',))]
    if elig: L=[a for a in L if a['kind'] in elig_kinds and (a['proj']!='GLOBAL' or a['fw'] or r['project'] is None)]
    return L
c,m=cluster('emb',0.35)
def method(r,kind,th,elig,cap=1500):
    if r['query'] not in cache: return [],0
    q=qv(r['query']); U=universe(r,elig); ids={a['id'] for a in U}
    if kind=='entries':
        S=sorted(U,key=lambda a:-float(a['v']@q))
        if not S or float(S[0]['v']@q)<th: return [],0
        out=[];b=cap
        for a in S[:20]:
            if len(a['text'])>b: break
            b-=len(a['text']); out.append(a['id'])
        return out,sum(len(byid[x]['text']) for x in out)
    if kind=='top3':
        S=sorted(U,key=lambda a:-float(a['v']@q))[:3]
        S=[a for a in S if float(a['v']@q)>=th]
        return [a['id'] for a in S],sum(len(a['text']) for a in S)
    # scene
    ks={}
    for a in U: ks.setdefault(c[a['id']],[]).append(a['id'])
    best=max(ks,key=lambda k:float(nz(np.mean([byid[x]['v'] for x in ks[k]],axis=0))@q))
    cv=nz(np.mean([byid[x]['v'] for x in ks[best]],axis=0))
    if float(cv@q)<th: return [],0
    ms=sorted(ks[best],key=lambda x:-float(byid[x]['v']@q)); out=[];b=cap
    for x in ms:
        if len(byid[x]['text'])>b: break
        b-=len(byid[x]['text']); out.append(x)
    return out,sum(len(byid[x]['text']) for x in out)
def score(rs,kind,th,elig,cap=1500):
    pos=neg=hit=fi=ch=n=0
    for r in rs:
        inj,cc=method(r,kind,th,elig,cap); ch+=cc
        if r['gold']: pos+=1; hit+=any(x in r['gold'] for x in inj); n+=len(inj)
        else: neg+=1; fi+=bool(inj)
    return round(hit/pos,3),fi,neg,round(ch/len(rs)),round(n/pos,1)
tune=[r for r in res if r['split']=='tune']; test=[r for r in res if r['split']=='test']
for elig in [False,True]:
  for kind,cap in [('top3',None),('scene',1500),('entries',1500),('entries',450)]:
    # tune 上选阈值：false injection = 0 的前提下覆盖最高
    best=None
    for th in np.arange(0.3,0.75,0.01):
        cov,fi,neg,_,_=score(tune,kind,th,elig,cap or 1500)
        if fi==0 and (best is None or cov>best[1]): best=(round(th,2),cov)
    th=best[0]
    print(dict(elig=elig,method=kind,cap=cap,th=th,tune=score(tune,kind,th,elig,cap or 1500),test=score(test,kind,th,elig,cap or 1500)))
print('polB test',json.load(open(D+'res-polB.json'))['report']['test'])
