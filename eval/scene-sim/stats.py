exec(open('sim.py').read().split("out=[]")[0])
for t in [0.25,0.45]:
    c,m=cluster('emb',t)
    big=[k for k,v in m.items() if len(v)>=3]
    print(t,'multi',sum(1 for v in m.values() if len(v)>1),'size>=3',len(big),'per proj',collections.Counter(k.split('|')[0] for k in big).most_common())
    if t==0.25:
        for k,v in list((k,v) for k,v in m.items() if len(v)>1)[:4]: print([byid[x]['text'][:50] for x in v])
