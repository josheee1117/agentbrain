import unittest
from score import score, cited_ids
R = lambda lane,q,inj,line,scan=(): dict(lane=lane,q=q,injected=inj,ab_used_line=line,scan_cited=list(scan))
class T(unittest.TestCase):
    def test_parse(self):
        self.assertEqual(cited_ids('调 pi 用临时库 (7f3c2a1b)；另一条 （b81d44e7）'), ['7f3c2a1b','b81d44e7'])
        self.assertEqual(cited_ids('没有括号的标题'), [])
        self.assertEqual(cited_ids(None), [])
    def test_metrics(self):
        s=[R('glm-on','q1',['aaaaaaaa','bbbbbbbb'],'A (aaaaaaaa); 编的 (cccccccc)',[{'mismatch':1}]),
           R('glm-on','q2',['dddddddd'],None),
           R('glm-on','q3',[],'X (eeeeeeee)')]
        l={'glm-on/q1':{'aaaaaaaa':{'used':'yes'},'bbbbbbbb':{'used':'no'}},'glm-on/q2':{'dddddddd':{'used':'yes'}}}
        o=score(s,l)['glm-on']
        self.assertEqual(o['marking_rate'],'1/2'); self.assertEqual(o['precision'],'1/1'); self.assertEqual(o['recall'],'1/2')
        self.assertEqual(o['fabricated_drops'],2); self.assertEqual(o['marks_without_recall'],1); self.assertEqual(o['title_mismatch'],1)
    def test_wrong_cite_is_fp(self):
        o=score([R('ds-on','q1',['aaaaaaaa'],'A (aaaaaaaa)')],{'ds-on/q1':{'aaaaaaaa':{'used':'no'}}})['ds-on']
        self.assertEqual(o['precision'],'0/1')
unittest.main()
