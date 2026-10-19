"""评测 14 答案层：按 rubric.md 跑回答和交叉裁判。python3 answer.py <outdir> answer|judge
outdir 里要有 raw-outputs.json（cli-run.ts）和 gold.json（gold-dump.ts）。结果续跑安全（已有的跳过）。
AB_HOME 必须指向临时目录；pi 关掉工具/扩展/技能/上下文文件/MCP，stdin 为 /dev/null。"""
import json, os, sys, subprocess, random, threading, re, time
from concurrent.futures import ThreadPoolExecutor
out, phase = sys.argv[1], sys.argv[2]
ab = os.environ.get('AB_HOME', '')
assert ab and os.path.realpath(ab) != os.path.realpath(os.path.expanduser('~/.agentbrain')), 'AB_HOME 必须是临时目录'
MODELS = ['cpa/deepseek-v4-pro', 'cpa/glm-5.3']
JUDGE = {'cpa/deepseek-v4-pro': 'cpa/glm-5.3', 'cpa/glm-5.3': 'cpa/deepseek-v4-pro'}
FLAGS = ['-p', '--no-session', '--no-tools', '--no-extensions', '--no-skills', '--no-context-files', '--no-prompt-templates', '--no-mcp', '--mode', 'json', '--thinking', 'max']
raw = json.load(open(os.path.join(out, 'raw-outputs.json'))); gold = json.load(open(os.path.join(out, 'gold.json')))
lock = threading.Lock()
def pi(model, prompt):
    t0 = time.time()
    p = subprocess.run(['pi', *FLAGS, '--model', model, prompt], stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=1500)
    text, thinking, used_model, level = '', 0, None, set()
    for line in p.stdout.splitlines():
        try: e = json.loads(line)
        except Exception: continue
        level |= set(re.findall(r'"thinkingLevel":\s*"(\w+)"', line))
        if e.get('type') == 'message_end' and e['message'].get('role') == 'assistant':
            m = e['message']; used_model = f"{m.get('provider')}/{m.get('model')}"
            text = ''.join(c.get('text', '') for c in m['content'] if c.get('type') == 'text')
            thinking = sum(len(c.get('thinking', '')) for c in m['content'] if c.get('type') == 'thinking')
    return {'text': text, 'thinking_chars': thinking, 'used_model': used_model, 'thinking_level': sorted(level), 'exit': p.returncode, 'stderr': p.stderr[-300:], 'secs': round(time.time() - t0)}
def save(name, data):
    with lock:
        tmp = os.path.join(out, name + '.tmp'); json.dump(data, open(tmp, 'w'), ensure_ascii=False, indent=1); os.replace(tmp, os.path.join(out, name))
def load(name):
    f = os.path.join(out, name); return json.load(open(f)) if os.path.exists(f) else {}
if phase == 'answer':
    A = load('answers.json'); tasks = []
    for cond in ['before', 'after']:
        for r in raw[cond]:
            if r['id'] not in gold: continue
            tool = r['search'] + ''.join('\n$ ab get\n' + g for g in r['gets'])
            for m in MODELS:
                k = f"{r['id']}|{cond}|{m}"
                if k in A and A[k]['text']: continue
                prompt = f"下面是一个记忆工具针对这个问题给出的输出。只根据这些输出回答问题，输出里没有的就说\"输出里没有\"，不要猜。回答要具体，把相关的结论和理由都说出来。\n问题：{r['query']}\n工具输出：\n{tool}"
                tasks.append((k, m, prompt, len(tool)))
    random.seed(14); random.shuffle(tasks)
    def go(t):
        k, m, prompt, n = t; res = pi(m, prompt); res['tool_chars'] = n
        with lock: A[k] = res
        save('answers.json', A); print(k, res['used_model'], res['thinking_level'], res['thinking_chars'], len(res['text']), res['secs'], flush=True)
    with ThreadPoolExecutor(6) as ex: list(ex.map(go, tasks))
elif phase == 'judge':
    A = load('answers.json'); J = load('judged.json'); tasks = []
    for k, a in A.items():
        if k in J and J[k].get('parsed'): continue
        qid, cond, m = k.split('|'); g = gold[qid]
        need = '\n'.join(f"槽{i + 1}（说出其中任一条的关键事实即算覆盖）：\n" + '\n'.join(f"  - {e['text']}" for e in s) for i, s in enumerate(g['slots']))
        whys = '\n'.join(f"  - {e['why']}" for s in g['slots'] for e in s if e['why']) if g['need_why'] else ''
        prompt = (f"你是评分员。根据必需条目判断一个回答是否覆盖了它们。只输出 JSON，不要别的文字。\n"
                  f"规则：每个槽，回答说出了槽里至少一条条目的关键事实（意思对即可，不要求原词）= true；只说\"输出里没有\"、含糊、或与条目相反 = false。\n"
                  + (f"这道题还要求说出理由：回答说出了下面任一条理由 = why:true，否则 false。\n理由：\n{whys}\n" if g['need_why'] else "这道题不要求理由：why 填 null。\n")
                  + f"wrong：回答里有与必需条目直接矛盾的说法 = true。\n"
                  f"输出格式：{{\"slots\":[{', '.join(['true/false'] * len(g['slots']))}],\"why\":true/false/null,\"wrong\":true/false,\"note\":\"一句话\"}}\n\n"
                  f"问题：{g['query']}\n\n必需条目：\n{need}\n\n回答：\n{a['text'] or '（空）'}")
        tasks.append((k, JUDGE[m], prompt, len(g['slots'])))
    random.seed(140); random.shuffle(tasks)
    def go(t):
        k, jm, prompt, ns = t; parsed = None
        for attempt in range(2):
            res = pi(jm, prompt)
            mm = re.search(r'\{.*\}', res['text'], re.S)
            try:
                v = json.loads(mm.group(0)); assert isinstance(v['slots'], list) and len(v['slots']) == ns; parsed = v; break
            except Exception: continue
        with lock: J[k] = {'judge': jm, 'parsed': parsed, 'used_model': res['used_model'], 'thinking_level': res['thinking_level'], 'thinking_chars': res['thinking_chars'], 'attempts': attempt + 1}
        save('judged.json', J); print(k, jm, parsed and parsed['slots'], parsed and parsed.get('why'), flush=True)
    with ThreadPoolExecutor(6) as ex: list(ex.map(go, tasks))
