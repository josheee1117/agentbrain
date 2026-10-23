"""引用评测打分：summary.json（extract.py 产出）+ labels.json（人工标注）→ 各车道指标。
labels.json: {"<lane>/<q>": {"<8位id>": {"used": "yes|no|unclear", "evidence": "回答原文引句"}}}
只算 .done 的运行；unclear 不进精确率/召回率分母，单独计数。"""
import json, re, sys
from collections import defaultdict
SEG = re.compile(r'[(（]\s*([0-9a-f]{8})\s*[)）]\s*$', re.I)
def cited_ids(line):
    if not line: return []
    out = []
    for s in re.split(r'[；;]', line):
        m = SEG.search(s.strip())
        if m and m.group(1).lower() not in out: out.append(m.group(1).lower())
    return out
def score(summary, labels):
    lanes = defaultdict(lambda: defaultdict(int))
    for r in summary:
        L = lanes[r['lane']]; key = f"{r['lane']}/{r['q']}"
        L['runs'] += 1
        inj = set(r['injected']); ids = cited_ids(r.get('ab_used_line'))
        valid = [i for i in ids if i in inj]
        L['fabricated_drops'] += len(ids) - len(valid)
        if r.get('ab_used_line'): L['line_present'] += 1
        if not inj:
            L['no_recall_runs'] += 1
            if ids: L['marks_without_recall'] += 1
            continue
        L['recall_runs'] += 1
        if valid: L['marked_runs'] += 1
        L['title_mismatch'] += sum(c['mismatch'] for c in r.get('scan_cited', []))
        L['scan_cited'] += len(r.get('scan_cited', []))
        lab = labels.get(key, {})
        for i in inj:
            u = lab.get(i, {}).get('used')
            if u is None: L['unlabeled'] += 1; continue
            if u == 'unclear': L['unclear'] += 1; continue
            m = i in valid
            L['tp' if (m and u == 'yes') else 'fp' if m else 'fn' if u == 'yes' else 'tn'] += 1
    out = {}
    for k, L in sorted(lanes.items()):
        d = dict(L)
        d['marking_rate'] = f"{L['marked_runs']}/{L['recall_runs']}"
        d['precision'] = f"{L['tp']}/{L['tp']+L['fp']}"
        d['recall'] = f"{L['tp']}/{L['tp']+L['fn']}"
        out[k] = d
    return out
if __name__ == '__main__':
    s = json.load(open(sys.argv[1])); l = json.load(open(sys.argv[2])) if len(sys.argv) > 2 else {}
    print(json.dumps(score(s, l), ensure_ascii=False, indent=1))
