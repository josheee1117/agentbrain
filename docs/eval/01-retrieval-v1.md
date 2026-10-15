# 1. 检索门槛 v1（切片 2，2026-10-10）

## 问题
混合检索（FTS5 trigram + 向量）里，向量路的余弦门槛取多少？`ab search` 和每轮 `ab recall` 是否该用同一个门槛？融合用 RRF 还是加权？

## 数据
- `eval/retrieval-v1/corpus.json`：53 条手写语料（pitfall/rule），33 条全局、20 条分属 agentbrain、pm、data-asset 等项目。内容改写自当时库里的真实条目，由执行者编写。
- `eval/retrieval-v1/queries.json`：121 条查询，其中 106 条正例带 `expect`（应命中的语料 id），15 条负例（`expect` 为空）。查询故意用和原文不同的说法（同义改写、口语化描述），用来测语义召回。由执行者编写和标注，用户没有逐条复核。
- 没有划分 tune/test。

## 方法
- 脚本：仓库内 `scripts/eval-retrieval.ts`。建临时 store，写入语料，用真实 embedding（DashScope）建向量，再对每条查询分别跑纯 FTS 和混合检索。
- 指标：正例 top-5 命中率、负例误报率（负例的最高相似度 ≥ 门槛就算误报）、门槛扫描表（每个门槛下的正例召回 / 负例误报 / 错序）。
- 复现（需要 embedding key，经 `ab` 自己的 readKey 读取）：
  ```bash
  mkdir -p ~/.agentbrain/eval && cp eval/retrieval-v1/{corpus,queries}.json ~/.agentbrain/eval/
  node scripts/eval-retrieval.ts
  ```

## 结果（取自当时写进代码注释和设计文档 §11.4 的数字）

| 门槛 | 正例召回 | 负例误报 |
|---|---|---|
| 0.45 | 93% | 33% |
| 0.50 | 87% | 13% |
| 0.55 | 63% | 0% |

- RRF（k=60，两路各取前 20）没有和加权融合对比过。
- 纯 FTS 与混合检索的对比表当时没有留存。

## 结论与决定（2026-10-10，写入设计文档 §11.4）
- `ab search` 用 0.45：主动搜索时更看重召回。
- 每轮 `ab recall` 用 0.55：每轮注入宁缺毋滥。
- 融合保留 RRF（k=60），理由是没有反证，并不是因为它赢过了加权融合。

## 保留意见
- 语料只有 53 条且是改写过的，查询由同一个人写，分布比真实使用干净得多。之后 #49 的真实库评测（见第 2 篇）把每轮门槛改成了"余弦 + 字面覆盖"的组合门槛。
- 语料文本已脱敏，但原文本来就是改写过的示例，没有转录原文。
