"""汇总 .done 的运行：注入的召回 id、回答正文、ab-used 行、模型与 thinkingLevel；再读 ab view 扫描后的 inject_log.cited。"""
import json, glob, os, re, sqlite3
ROOT='/private/tmp/cite-eval'; rows=[]
AB=re.compile(r'^\s*`?\s*ab-used\s*[:：]\s*(.*?)`?\s*$',re.I|re.M)
for done in sorted(glob.glob(f'{ROOT}/runs/*-*/q*.done')):
    lane=done.split('/')[-2]; qid=os.path.basename(done)[:-5]; model,cond=lane.split('-')
    sid=None; inj=[]; ans=''; meta={}; thinking=[]
    for l in open(done[:-5]+'.jsonl'):
        e=json.loads(l)
        if e.get('type')=='session': sid=e['id']
        if e.get('type')=='message_end':
            m=e['message']
            if m.get('role')=='custom' and m.get('customType')=='agentbrain-recall':
                c=m['content']; seg=c.split('<agentbrain-recall>')[-1] if '<agentbrain-recall>' in c else ''
                inj=re.findall(r'^- \[([0-9a-f]{8})\]',seg,re.M); meta['cite_instr']='ab-used' in seg
            if m.get('role')=='assistant' and m.get('stopReason')!='error':
                ans=''.join(x.get('text','') for x in m['content'] if x.get('type')=='text')
                thinking.append(any(x.get('type')=='thinking' and x.get('thinking','').strip() for x in m['content']))
                meta['model']=f"{m.get('provider')}/{m.get('model')}"
        for k in ('thinkingLevel',):
            if k in json.dumps(e): 
                mm=re.search(r'"thinkingLevel":\s*"(\w+)"',json.dumps(e)); 
                if mm: meta['thinkingLevel']=mm.group(1)
    used=AB.findall(ans)
    rows.append(dict(lane=lane,model=model,cond=cond,q=qid,session=sid,injected=inj,answer=ans,ab_used_line=used[-1] if used else None,has_thinking=any(thinking),**meta))
for cond in ('on','off'):
    db=sqlite3.connect(f'file:{ROOT}/abhome-{cond}/store.db?mode=ro',uri=True)
    cited={}
    for sid,pid,t,mm in db.execute("select session_id,substr(prop_id,1,8),cited_title,title_mismatch from inject_log where cited=1 and path='recall'"):
        cited.setdefault(sid,[]).append({'id':pid,'title':t,'mismatch':mm})
    for r in rows:
        if r['cond']==cond: r['scan_cited']=cited.get(r['session'],[])
json.dump(rows,open(f'{ROOT}/runs/summary.json','w'),ensure_ascii=False,indent=1)
print(len(rows),'runs')
