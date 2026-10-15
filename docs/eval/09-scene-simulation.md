# 9. 场景层模拟（只读模拟，2026-10-15）

## 问题
借鉴 TencentDB 的 L2"场景块"：把项目内相近的记忆聚成"场景"。下面两种用法能否提升每轮召回？
- (A) 命中某条后，把它所在场景的其余成员一起追加；
- (B) 直接按场景质心选场景注入。

## 数据
- 与第 8 篇相同：95 条 recall-eval（gold 由执行者标），polB 注入结果作为基线，511 条 active，10-15 快照的向量。
- 场景 = 项目内 embedding 层次聚类（余弦、average linkage，阈值 t），或者按"项目×kind"分组。
- 场景摘要用"成员原文拼接"来近似，信息量是 LLM 摘要的上限，所以结果偏乐观。

## 方法
- `eval/scene-sim/sim.py`：A 方案，比较 t=0.25/0.35/0.45 以及"项目×kind"分组，有/没有 1500 字符上限。脚本 B 段遇到负例查询时因缺向量缓存报错，B 方案以 sim2.py 为准。
- `eval/scene-sim/sim2.py`：B 方案，场景优先 top-1 对照"同范围直接取 top-3 条目"。阈值在 tune 上选，要求误注入为 0。
- `eval/scene-sim/stats.py`：polB 基线指标和近重复统计。
- 指标：gold 覆盖率、每条查询多出的字符数、多出的非目标条数。
- 复现（需要 index.db 快照、active.jsonl、emb-cache.json，都未提交；依赖 numpy 和 scikit-learn）：
  ```bash
  python3 -m venv venv && venv/bin/pip install numpy scikit-learn
  venv/bin/python eval/scene-sim/sim.py; venv/bin/python eval/scene-sim/sim2.py; venv/bin/python eval/scene-sim/stats.py
  ```
  输出已存为 `sim_out.txt`、`sim2_out.txt`、`stats_out.txt`。

## 结果

A. 命中后追加所在场景（基线 polB：test 0.852，all 0.844）：

| 分组 | split | 覆盖 | 救回 | 多出字符/查询 | 多出非目标/查询 |
|---|---|---|---|---|---|
| emb t=0.35 | test | 0.852 | 0 | 199 | 1.1 |
| emb t=0.45（上限 1500） | test | 0.852 | 0 | 671 | 4.4 |
| 项目×kind | test | 0.852 | 0 | 4352 | 32.3 |
| emb t=0.35 | all | 0.883 | 3（都在 tune） | 230 | 1.3 |
| emb t=0.45（上限 1500） | all | 0.883 | 3 | 752 | 4.9 |
| 项目×kind | all | 0.896 | 4 | 4593 | 34.1 |

B. 场景优先 vs 条目（阈值 0.61，误注入 0）：

| 方法 | tune 覆盖 | test 覆盖 | 字符/查询（test） |
|---|---|---|---|
| top-3 条目 | 0.92 | 0.852 | 259 |
| 场景 top-1 | 0.88 | 0.926 | 307 |

合计都是 69/77，打平。簇平均只有 1.8 条，本质上就是"top-1～2 条目"。

副产品：t=0.25 时有 60 组近重复或高度相关的条目对，可以作为去重的候选信号。

## 结论与决定（2026-10-15）
- 不做每轮场景层。A 在 test 上 0 收益，全量 +3.9 个百分点，代价是每条查询多 230～750 字符；B 和条目检索打平。
- 如果要借鉴，最多做"会话开头的轻量目录"，先评测再决定，见第 10 篇。

## 保留意见
- 摘要用成员原文代替，偏乐观；但即便如此，test 上也没有收益。
- test 正例只有 27 条。
