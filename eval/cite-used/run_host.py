"""Claude Code / Codex / opencode 的引用评测 runner（同 run_pi.py：断点续跑、429 等 10 分钟重试、每题后检查临时检出有没有被改）。
用法：run_host.py <claude|codex|opencode> <on|off>"""
import json, os, subprocess, sys, time, datetime
R='/private/tmp/cite-eval'; Q=json.load(open(f'{R}/harness/questions.json'))
DEADLINE=datetime.datetime.fromisoformat(os.environ.get('DEADLINE','2026-10-21T23:30:00'))
def env(host,cond):
    e={k:v for k,v in os.environ.items() if not k.startswith(('PI_','CLAUDE','CODEX','AB_','OPENCODE'))}
    H=f'{R}/home-{cond}'
    e.update(HOME=H, AB_HOME=f'{R}/abhome-{cond}', AB_REGISTRY=f'{R}/registry', PATH=f'/opt/homebrew/bin:/Users/hejiayuan/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin')
    if host=='codex': e['CODEX_HOME']=f'{H}/.codex'
    if host=='opencode': e['OPENCODE_CONFIG']='/Users/hejiayuan/.config/opencode/opencode.json'
    return e
def cmd(host,prompt):
    if host=='claude': return ['/Users/hejiayuan/.local/bin/claude','-p','--output-format','stream-json','--verbose','--effort','max','--model','opus',prompt]
    if host=='codex': return ['codex','exec','--json','-s','read-only','--dangerously-bypass-hook-trust','--skip-git-repo-check','-c','model_reasoning_effort="xhigh"',prompt]
    return ['opencode','run','--standalone','--format','json','-m','huoshan/ark-code-latest#max',prompt]
def outcome(host,path):
    txt=''; err=''
    for l in open(path):
        try: e=json.loads(l)
        except Exception: continue
        t=e.get('type')
        if host=='claude' and t=='result':
            if e.get('is_error'): err=f"{e.get('api_error_status')} {e.get('result')}"
            else: txt=e.get('result') or ''
        if host=='codex':
            it=e.get('item',{})
            if t=='item.completed' and it.get('type')=='agent_message': txt=it.get('text','')
            if t in ('turn.failed','error'): err=json.dumps(e,ensure_ascii=False)
        if host=='opencode':
            if t=='text': txt+=e.get('part',{}).get('text','')
            if t=='error': err=json.dumps(e.get('error',{}),ensure_ascii=False)
    if txt.strip() and not err: return 'ok',''
    if err: return ('quota' if any(s in err for s in ('429','usage_limit','usage limit','quota','rate_limit')) else 'error'), err[:200]
    return 'noreply',''
def log(m):
    with open(f'{R}/progress-mac.log','a') as f: f.write(datetime.datetime.now().strftime('%H:%M:%S ')+m+'\n')
def lane(host,cond):
    d=f'{R}/runs/{host}-{cond}'; os.makedirs(d,exist_ok=True)
    for q in Q:
        b=f"{d}/{q['id']}"
        if os.path.exists(b+'.done') or os.path.exists(b+'.failed'): continue
        tries=0
        while True:
            if datetime.datetime.now()>DEADLINE: log(f'{host}-{cond} 到截止时间，停'); return
            c=cmd(host,q['prompt']); t0=time.time()
            with open(b+'.jsonl','w') as o, open(b+'.err','w') as er:
                try: rc=subprocess.run(c,stdin=subprocess.DEVNULL,stdout=o,stderr=er,env=env(host,cond),cwd=f'{R}/agentbrain',timeout=900).returncode
                except subprocess.TimeoutExpired: rc='timeout'
            st,msg=outcome(host,b+'.jsonl'); dt=round(time.time()-t0)
            dirty=subprocess.run(['git','-C',f'{R}/agentbrain','status','--porcelain'],capture_output=True,text=True).stdout
            if dirty:  # 宿主改了临时检出：记下 diff 再还原，免得影响后面的题
                open(b+'.dirty.diff','w').write(dirty+subprocess.run(['git','-C',f'{R}/agentbrain','diff'],capture_output=True,text=True).stdout)
                subprocess.run(['git','-C',f'{R}/agentbrain','checkout','--','.']); subprocess.run(['git','-C',f'{R}/agentbrain','clean','-fdq'])
            log(f"{host}-{cond} {q['id']} rc={rc} {st} {dt}s{' DIRTY' if dirty else ''} {msg[:120]}")
            if st=='ok':
                json.dump({'cmd':c,'rc':rc,'secs':dt,'finished':datetime.datetime.now().isoformat()},open(b+'.done','w'),ensure_ascii=False); break
            if st=='quota': time.sleep(600); continue
            tries+=1
            if tries>=2: open(b+'.failed','w').write(st+' '+msg); break
if __name__=='__main__':
    lane(sys.argv[1],sys.argv[2]); log(f'{sys.argv[1]}-{sys.argv[2]} 车道结束')
