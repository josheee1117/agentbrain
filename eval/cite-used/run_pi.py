"""Pi 引用评测 runner：每个 (模型, 开关) 一条车道，逐题跑真实 pi；断点续跑（已有 .done 的跳过）。
额度 429 时等 10 分钟重试同一题，直到 DEADLINE；其它错误重试 1 次后记 .failed。"""
import json, os, subprocess, sys, time, datetime
ROOT='/private/tmp/cite-eval'; Q=json.load(open(f'{ROOT}/harness/questions.json'))
MODELS={'glm':'cpa/glm-5.3','ds':'cpa/deepseek-v4-pro'}
DEADLINE=datetime.datetime.fromisoformat(os.environ.get('DEADLINE','2026-10-21T23:30:00'))
def env(cond):
    e={k:v for k,v in os.environ.items() if not k.startswith(('PI_','CLAUDE','CODEX','AB_'))}
    e.update(HOME=f'{ROOT}/home-{cond}', AB_HOME=f'{ROOT}/abhome-{cond}', AB_HOST_HOME=f'{ROOT}/home-{cond}', AB_REGISTRY=f'{ROOT}/registry', PATH='/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin')
    return e
def log(msg):
    with open(f'{ROOT}/progress-mac.log','a') as f: f.write(datetime.datetime.now().strftime('%H:%M:%S ')+msg+'\n')
def outcome(path):
    last=None
    for l in open(path):
        try: e=json.loads(l)
        except Exception: continue
        if e.get('type')=='message_end' and e['message'].get('role')=='assistant': last=e['message']
    if not last: return 'noreply',''
    err=last.get('errorMessage') or ''
    if last.get('stopReason')=='error': return ('quota' if '429' in err else 'error'), err[:200]
    txt=''.join(c.get('text','') for c in last.get('content',[]) if c.get('type')=='text')
    return ('ok' if txt.strip() else 'empty'), ''
def lane(model, cond):
    d=f'{ROOT}/runs/{model}-{cond}'; os.makedirs(d,exist_ok=True)
    for q in Q:
        base=f"{d}/{q['id']}"
        if os.path.exists(base+'.done') or os.path.exists(base+'.failed'): continue
        tries=0
        while True:
            if datetime.datetime.now()>DEADLINE: log(f'{model}-{cond} 到截止时间，停'); return
            cmd=['pi','-p','--mode','json','--no-extensions','-e',f'{ROOT}/harness/ab-ext.ts','--no-tools','--no-skills','--no-prompt-templates','--no-mcp','--thinking','max','--model',MODELS[model],q['prompt']]
            t0=time.time()
            with open(base+'.jsonl','w') as out, open(base+'.err','w') as err:
                try: rc=subprocess.run(cmd,stdin=subprocess.DEVNULL,stdout=out,stderr=err,env=env(cond),cwd=f'{ROOT}/agentbrain',timeout=900).returncode
                except subprocess.TimeoutExpired: rc='timeout'
            st,msg=outcome(base+'.jsonl'); dt=round(time.time()-t0)
            log(f"{model}-{cond} {q['id']} rc={rc} {st} {dt}s {msg[:120]}")
            if st=='ok':
                json.dump({'cmd':cmd,'rc':rc,'secs':dt,'finished':datetime.datetime.now().isoformat()},open(base+'.done','w'),ensure_ascii=False); break
            if st=='quota': time.sleep(600); continue
            tries+=1
            if tries>=2: open(base+'.failed','w').write(st+' '+msg); break
if __name__=='__main__':
    model,cond=sys.argv[1],sys.argv[2]; lane(model,cond); log(f'{model}-{cond} 车道结束')
