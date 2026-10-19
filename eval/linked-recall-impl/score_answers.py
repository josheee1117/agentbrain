"""评测 14 答案层汇总：python3 score_answers.py <outdir>
读 judged.json（answer.py judge 产出）和 gold.json，按 rubric.md 出 full/part/none；写 answer-grades.json（不含正文，可进仓库）。"""
import json, sys, os, collections as C
out = sys.argv[1]
J = json.load(open(os.path.join(out, 'judged.json'))); G = json.load(open(os.path.join(out, 'gold.json')))
A = json.load(open(os.path.join(out, 'answers.json')))
grades = []
for k, j in sorted(J.items()):
    qid, cond, model = k.split('|'); v = j['parsed']; g = G[qid]
    if not v: grades.append({'id': qid, 'cond': cond, 'model': model, 'label': 'unparsed'}); continue
    slots = [bool(x) for x in v['slots']]; n = sum(slots); t = len(slots)
    if g['need_why']: t += 1; n += bool(v.get('why'))
    lab = 'full' if n == t else 'part' if n else 'none'
    grades.append({'id': qid, 'set': 'linked' if qid.startswith('L') else 'r95', 'cond': cond, 'model': model, 'judge': j['judge'], 'slots': slots, 'why': v.get('why'), 'wrong': bool(v.get('wrong')), 'n': n, 't': t, 'label': lab,
                   'answer_chars': len(A[k]['text']), 'tool_chars': A[k]['tool_chars'], 'answer_thinking_level': A[k]['thinking_level'], 'answer_used_model': A[k]['used_model'], 'answer_thinking_chars': A[k]['thinking_chars'],
                   'judge_thinking_level': j['thinking_level'], 'judge_used_model': j['used_model'], 'judge_attempts': j['attempts']})
json.dump(grades, open(os.path.join(out, 'answer-grades.json'), 'w'), ensure_ascii=False, indent=0)
for model in ['cpa/deepseek-v4-pro', 'cpa/glm-5.3']:
    for st in ['linked', 'r95', 'all']:
        for cond in ['before', 'after']:
            L = [x for x in grades if x['model'] == model and x['cond'] == cond and (st == 'all' or x.get('set') == st)]
            c = C.Counter(x['label'] for x in L)
            print(f"{model:20s} {st:6s} {cond:6s} n={len(L):2d} full {c['full']:2d} part {c['part']:2d} none {c['none']:2d} unparsed {c['unparsed']} slots {sum(x.get('n', 0) for x in L)}/{sum(x.get('t', 0) for x in L)} wrong {sum(x.get('wrong', False) for x in L)}")
# 逐题前后对比
print('\n逐题（前→后）变化：')
by = {(x['id'], x['cond'], x['model']): x for x in grades}
for model in ['cpa/deepseek-v4-pro', 'cpa/glm-5.3']:
    up = [q for q in G if by.get((q, 'after', model), {}).get('n', 0) > by.get((q, 'before', model), {}).get('n', 0)]
    down = [q for q in G if by.get((q, 'after', model), {}).get('n', 0) < by.get((q, 'before', model), {}).get('n', 0)]
    print(model, '变好', len(up), up, '变差', len(down), down)
