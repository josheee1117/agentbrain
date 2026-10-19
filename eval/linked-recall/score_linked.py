"""评测 13 打分：python3 score_linked.py props.json linked-queries.json out-base.json [out-xxx.json ...]
每条查询的答案拆成若干"槽"（每槽是可互相替代的条目），某读路径拿到每个槽至少一条 = 全，部分 = 部，零 = 无。
need_why 的查询另加一个"理由"槽：该读路径会显示命中条目的 why 才算（每轮召回不显示 why，ab search / ab get 显示）。
扩展模拟：从读路径已拿到的条目出发，沿某类边走 1 跳，看能补上几个缺的槽、带进几条无关条目。"""
import json,sys,collections as C
P={p['id']:p for p in json.load(open(sys.argv[1] if __name__=='__main__' else 'props-meta.json'))}
def full(pfx): return next(k for k in P if k.startswith(pfx))
def load_q(f):
    Q=json.load(open(f))
    for q in Q: q['slots']=[[full(g) for g in s] for s in q['slots']]
    return Q
Q=load_q(sys.argv[2]) if __name__=='__main__' else None
edges=C.defaultdict(lambda: C.defaultdict(set))
def add(t,a,b):
    if a in P and b in P: edges[t][a].add(b); edges[t][b].add(a)
for p in P.values():
    r=p['related']
    if r and r['outcome']=='refines' and r['target']: add('link',p['id'],r['target'])
    if p['merged_into']: add('link',p['id'],p['merged_into'])
    if p['supersedes']: add('link',p['id'],p['supersedes'])
    if p['conflicts_with']: add('link',p['id'],p['conflicts_with'])
    for c in p['pending']: add('link',p['id'],c)
win=C.defaultdict(set); ses=C.defaultdict(set)
for p in P.values():
    if p['window_id']: win[p['window_id']].add(p['id'])
    if p['session']: ses[p['session']].add(p['id'])
for p in P.values():
    if p['window_id']:
        for o in win[p['window_id']]:
            if o!=p['id']: edges['window'][p['id']].add(o)
    if p['session']:
        for o in ses[p['session']]:
            if o!=p['id']: edges['session'][p['id']].add(o)
def cover(q,got,why_visible):
    got=set(got); n=0
    for s in q['slots']:
        if got & set(s): n+=1
    tot=len(q['slots'])
    if q.get('need_why'):
        tot+=1
        hit=[g for s in q['slots'] for g in s if g in got and P[g]['why']]
        if why_visible and hit: n+=1
    return n,tot
def lab(n,t): return 'full' if n==t else ('part' if n else 'none')
def run(outfile):
    O=json.load(open(outfile)); R={r['id']:r for r in O['results']}
    rows=[]
    for q in Q:
        r=R[q['id']]; brief=set(O['briefs'].get(q['project'] or '_none',[]))
        gold={g for s in q['slots'] for g in s}
        ch={'recall':(r['recall'],False),'brief+recall':(list(brief|set(r['recall'])),False),'search':(r['search'],True),'search_arch':(r['search_arch'],True),'search16':(r.get('search16',[]),True),'search24':(r.get('search24',[]),True)}
        row={'id':q['id'],'split':q['split'],'type':q['type']}
        for name,(got,wv) in ch.items():
            n,t=cover(q,got,wv); row[name]=lab(n,t); row[name+'_n']=(n,t)
            # 扩展
            for et in ['link','window','session','vec']:
                if et=='vec':
                    add_=set()
                    for g in got:
                        for nb in [x['id'] for x in r['neighbors'].get(g,[])][:3]: add_.add(nb)
                else:
                    add_=set().union(*[edges[et][g] for g in got]) if got else set()
                add_-=set(got)
                n2,_=cover(q,list(set(got)|add_),wv)
                row[f'{name}+{et}']=lab(n2,t); row[f'{name}+{et}_noise']=len(add_-gold); row[f'{name}+{et}_gain']=n2-n
        # 槽之间是否有显式边（选题偏差检查）
        S=q['slots']; linked=any(set().union(*[edges['link'][g] for g in a]) & set(b) for i,a in enumerate(S) for b in S[i+1:])
        row['gold_linked']=linked if len(S)>1 else None
        rows.append(row)
    return rows
def summarize(rows,label):
    print(f'\n=== {label}')
    for split in ['tune','test','all']:
        L=[x for x in rows if split=='all' or x['split']==split]
        print(f'-- {split} n={len(L)}')
        for name in ['recall','brief+recall','search','search_arch','search16','search24']:
            c=C.Counter(x[name] for x in L)
            line=f"{name:13s} full {c['full']:2d} part {c['part']:2d} none {c['none']:2d}"
            for et in ['link','window','session','vec']:
                c2=C.Counter(x[f'{name}+{et}'] for x in L); noise=sum(x[f'{name}+{et}_noise'] for x in L)
                line+=f" | +{et}: full {c2['full']:2d} noise {noise:3d}"
            print(line)
if __name__=='__main__':
    for f in sys.argv[3:]:
        rows=run(f); summarize(rows,f)
        json.dump(rows,open(f.replace('.json','-scored.json'),'w'),ensure_ascii=False,indent=1)
        print('\nper query (recall / search):')
        for x in rows: print(x['id'],x['split'],x['type'],'recall',x['recall'],x['recall_n'],'search',x['search'],x['search_n'],'arch',x['search_arch'],'gold_linked',x['gold_linked'])
