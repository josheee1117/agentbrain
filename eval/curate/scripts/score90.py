import json,sys
import os
lab={(i['set'],i['n']):i for i in json.load(open(os.environ.get('LABELS','/workspace/agentbrain-review/value-audit/labels90.json')))}
def score(path,name):
    R=json.load(open(path)); rows=R['rows']
    out=[f"## {name}"]
    for s in ['s30','s60',None]:
        xs=[r for r in rows if s is None or r['set']==s]
        if not xs: continue
        def rate(sel,want):
            g=[r for r in xs if sel(lab[(r['set'],r['n'])]['label'])]
            return f"{sum(1 for r in g if r['admit'] is want)}/{len(g)}" + (f"={100*sum(1 for r in g if r['admit'] is want)/len(g):.0f}%" if g else "")
        und=sum(1 for r in xs if r['admit'] is None)
        out.append(f"{s or 'all'}: 没用被丢 {rate(lambda l:l=='没用',False)} | 有用+部分有用被留 {rate(lambda l:l!='没用',True)} | 只算有用被留 {rate(lambda l:l=='有用',True)} | 部分有用被留 {rate(lambda l:l=='部分有用',True)} | merge {sum(1 for r in xs if r['final']=='merge')} | 未决 {und}")
    out.append("misses:")
    for r in rows:
        l=lab[(r['set'],r['n'])]
        miss = (l['label']=='没用' and r['admit'] is not False) or (l['label']!='没用' and r['admit'] is not True)
        if miss:
            adv={k:v for k,v in r['votes'].items()}
            out.append(f"  {r['set']}#{r['n']} 标={l['label']} 判={r['final']} 票={adv} 注={l['comment']} | {(r.get('reason') or '')[:90]}")
    return "\n".join(out)
for a in sys.argv[1:]:
    p,n=a.split('=',1) if '=' in a else (a,a); print(score(p,n)); print()
