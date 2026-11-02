# Eval 21：跨项目段 0.6 阈值，和 Pensieve 重导后 `ab get` 的正文

日期：2026-11-02（SGT）。仓库 `agentbrain-kd`，分支 `feat/knowledge-decisions` @ 38ef647。

对应设计 §8.11.6 的第 4 项（跨项目阈值评测）和第 5 项（Pensieve 替代）。结论先说：

- **0.6 偏低，建议 0.65。** 正例命中数不变（4/5），负例误出从 5/10 降到 3/10，误出条目从 11 条降到 4 条，每题平均条数从 1.53 降到 1.00。阈值最终由主会话定。
- **Pensieve 重导后 `ab get` 的正文与原文一致。** 56 篇里 49 篇逐字相同，5 篇只在脱敏处不同（`/Users/<name>` 换 `~`），2 篇整段没写进库（原文含密钥，导入自己拒掉的）。抽样的 5 篇全部逐字一致。第二次、第三次重导没有新增、没有改 id。

## 做法

- 库：2026-11-02 14:40 SGT 用 `sqlite3 ~/.agentbrain/store.db ".backup"` 从真实库只读拷出 `store.db`、`index.db`，连 `embedding.json`、`extract.json` 一起放在 `~/.cache/agentbrain-eval/kd-cross/ab/`。`~/code_me/pm/repos` 拷一份到 `kd-cross/registry/`，全程 `AB_REGISTRY` 指向副本。所有命令都是 `AB_HOME=<副本> AB_REGISTRY=<副本> node .../agentbrain-kd/src/cli.ts`，没用全局 `ab`，没改 `HOME`（向量钥匙在钥匙串）。
- 副本基线：事件 2967 条，索引向量 1556 条。评测期间库被分成 6 份副本，每份只改自己那份：`ab`（阈值评测与 CLI 行为检查）、`ab-import`（Pensieve 导入）、`ab-pending`、`ab-pending2`、`ab-pending3`（pending 提示）、`ab-degraded`（降级）。
- 题集写在 `~/.cache/verify-evidence/agentbrain/20261102-144010-kd-cross/queries.tsv`，14:24:07 落盘（时间与 sha256 记在 `queries.tsv.lock`），看任何分数之前就定死了查询和期望。之后只动过一次题集，是为了修正路径笔误：
  - 14:30 把 A3、B5 的 cwd 从 `~/code/pi-ops` 改成 `~/code_me/pi-ops`（原路径不存在，两题跑出来是空，不算结果）。查询词、期望一字未动，改动也记进了 `queries.tsv.lock`。
  - 跑批脚本第一版把 TSV 第 5 列（期望）拼进了查询词，导致第一次结果作废。修完重跑，作废那轮不写进本报告。
- 低于 0.6 的分数：CLI 只显示过门槛的，所以另写脚本（`work/summary.ts`、`work/perquery.ts`）直接读副本 `index.db` 的 `vecs` 表，复算余弦，不改 `src`。脚本口径与 `Store.crossProjectHits` 一致（只取其他项目的 active 条目，按 `text_hash` 判向量是否过期）。
- **交叉核对**：脚本算出的 0.6 前 3 条的 id 和分数，与真实 `ab search` 输出的跨项目段逐条比对，15 题全部一致（`xcheck-cli-vs-script.txt`）。

## 题集

正例 5 题（P）：在 A 项目里搜，B 项目确实有能用的经验。负例 10 题：A 类 5 题是「术语相同、业务含义不同」，B 类 5 题与其他项目完全无关。

| 题 | 类 | 目录 | 查询 |
|---|---|---|---|
| P1 | 正 | data-asset | 比率指标怎么建模 |
| P2 | 正 | ai-data | 派生指标维度槽位怎么排，空维度哨兵怎么处理 |
| P3 | 正 | ai-data | 数仓表责任人没匹配到字典怎么处理 |
| P4 | 正 | content-verification-agent | embedding 补算和缓存失效按什么判定 |
| P5 | 正 | agentbrain | 模型返回的 JSON 结构化输出校验失败怎么处理 |
| A1 | 同类术语 | data-asset | 标签组推送失败怎么排查 |
| A2 | 同类术语 | ai-data | pytest 找不到，测试怎么跑 |
| A3 | 同类术语 | pi-ops | 测试环境日志怎么查 |
| A4 | 同类术语 | content-verification-agent | 发布到 Jenkins 要不要先授权 |
| A5 | 同类术语 | agentbrain | JVM 堆 OOM 怎么排查 |
| B1 | 无关 | data-asset | 今天中午吃什么 |
| B2 | 无关 | ai-data | 帮我给 Vue 组件加个淡入动画 |
| B3 | 无关 | insuranceagent | 打印机驱动装不上怎么办 |
| B4 | 无关 | agentbrain | 写一首关于秋天的短诗 |
| B5 | 无关 | pi-ops | 周末去哪座山徒步比较好 |

P1 是设计里点名的那题。P2–P5 是重新挑的：同一个业务主题在另一个项目里有成体系的条目（维度槽位、MaxCompute 责任人字典、embedding 补算哈希、结构化输出校验）。

题集写期望时按条目内容挑的 id，跑完才发现 11 个期望 id 里 4 个当时已是 archived（`79dfe66c`、`91a86d18`、`18d4d7cc`、`efd78296`，被更新版本替代或合入），而跨项目段只取 active，这些 id 永远不可能出现。命中判定改成只用实际能出现的 id 重算，汇总表**与下面完全相同**（`threshold-table-active-expectations.txt`），所以沿用。可命中的期望 id：P1 `2018b871`；P2 `8b6bf402`、`9888aac0`；P3 `e8d8c189`；P4 `c0cb27ed`；P5 `9a8ba25e`、`e6343ea0`。

## 每个查询的结果

真实 CLI 输出（`cli-<题>.txt`），跨项目段原样摘录。分数是两位小数，跟 CLI 显示一致。

P1（data-asset，比率指标怎么建模）
- `2018b871` ai-data 决定 0.70（比率类指标只能建模为衍生，`${A}/${B}*100`）
- 门槛 0.6 只出这 1 条。下一名 `7be5200e`（ai-data，衍生指标结果表结构未定）0.57，被挡掉。

P2（ai-data，派生指标维度槽位怎么排，空维度哨兵怎么处理）
- `9888aac0` data-asset 坑 0.81（后端先剔除空维度哨兵再排槽位）
- `8b6bf402` data-asset 决定 0.77（同上，权威实现）
- `a1722951` data-asset 坑 0.72（原子+周期+维度集合没有唯一约束）
- 期望里能出现的两条（`9888aac0`、`8b6bf402`）都在，另外带出的 `a1722951` 也切题。本轮最干净的一题。

P3（ai-data，数仓表责任人没匹配到字典怎么处理）
- `60e29b0e` data-asset 决定 0.74（责任人由 table_owner 字典派生）
- `e8d8c189` data-asset 决定 0.72（未匹配时置空并告警，不中断同步）
- `e36330f9` data-asset 决定 0.72（单条源值映射不上时降级处理）

P4（content-verification-agent，embedding 补算和缓存失效按什么判定）
- `c0cb27ed` ai-data 坑 0.74（用「文本+模型」哈希判定补算）
- `416b507e` ai-data 坑 0.61（向量写回失败不能让同步整体失败）

P5（agentbrain，模型返回的 JSON 结构化输出校验失败怎么处理）
- `6270f7d7` pi-ops 坑 0.74（`invalid specialist json` 报错）
- `c64c1afc` pi-ops 坑 0.73（先看 calls/tokens 判断是模型还是代码回归）
- `067454c5` content-verification-agent 规则 0.71（FAILED 只留给系统错误）
- 这题期望的两条 `9a8ba25e`（0.69）、`e6343ea0`（0.66）**掉在 3 条上限之外**：它们排第 7、第 12 名，前面还有 `b70bf6da`、`046eef26`、`7b6a6963`、`8d19152a` 等。跨项目段里显示的是别的项目同样切题的条目。题判「漏」，但给出来的三条内容都对。

A1（data-asset，标签组推送失败怎么排查）
- `b2dc12a0` insuranceagent 坑 0.70、`24bf7b77` insuranceagent 规则 0.66、`fbd13292` insuranceagent 决定 0.63
- 全部是企微客户标签推送链路的条目。资产平台的「标签门面」是另一套系统，这些条目说的库、表、任务在 data-asset 里都不存在。

A2（ai-data，pytest 找不到，测试怎么跑）
- `6d0b35ea` content-verification-agent 坑 0.63（它的 venv 没有 pytest，要用 `uv run --with pytest`）
- 那是一个 Python 项目的环境约定，ai-data 是 Node + pnpm。

A3（pi-ops，测试环境日志怎么查）
- `1b55ea30` insuranceagent 坑 0.63（用 sls MCP 查它自己的测试环境日志 project）
- `b701d94d` pm 规则 0.62（去查该公司生产 SLS 的某个 project）
- 两条都是「去阿里云 SLS 查」，但 pi-ops 的测试环境日志在 `test-svc-02` 上，走的是另一套通道。

A4（content-verification-agent，发布到 Jenkins 要不要先授权）
- `442c37df` data-asset 规则 0.70（发布到 dev 等同部署测试环境，必须明确授权）
- `5ab4957e` data-asset 规则 0.65（"合入/合并"指推远端分支）
- `db3d6993` pm 规则 0.64（新建 Jenkins Job 要放进对应视图）
- 三条都是 data-asset / pm 的发布链规矩。content-verification-agent 自己的测试环境是另一条链（该项目的测试环境域名）。

A5（agentbrain，JVM 堆 OOM 怎么排查）
- `d8178a08` pi-ops 坑 0.74（白盒捕获堆 OOM 不能只靠 `jdk.JavaErrorThrow`）
- `159b866f` pi-ops 规则 0.62（三类故障两种部署形态都要能监控）
- agentbrain 是 TypeScript/Node 项目，没有 JVM 堆。

B1–B5（与其他项目无关）：五题跨项目段全是空。分数最高的分别是 0.29（B1）、0.38（B2）、0.38（B3）、0.19（B4）、0.30（B5），都远低于 0.5，说明「完全无关」这一档本身不构成风险。

## 各阈值下的汇总

每题最多 3 条（`CROSS_PROJECT_MAX`）。「命中」= 期望条目进了这 3 条；「误出」= 负例题该为空却出了条目。

| 阈值 | 正例命中 | 负例误出 | 负例误出条目数 | 15 题总显示条数 | 每题平均 |
|---|---|---|---|---|---|
| 0.50 | 4/5 | 5/10 | 15 | 30 | 2.00 |
| 0.55 | 4/5 | 5/10 | 13 | 27 | 1.80 |
| 0.60 | 4/5 | 5/10 | 11 | 23 | 1.53 |
| 0.65 | 4/5 | 3/10 | 4 | 15 | 1.00 |
| 0.70 | 4/5 | 3/10 | 3 | 14 | 0.93 |
| 0.75 | 1/5 | 0/10 | 0 | 2 | 0.13 |

逐题条数（`perquery.ts`）：

| 题 | 0.50 | 0.55 | 0.60 | 0.65 | 0.70 | 0.75 |
|---|---|---|---|---|---|---|
| P1 | 3/中 | 2/中 | 1/中 | 1/中 | 1/中 | 0/漏 |
| P2 | 3/中 | 3/中 | 3/中 | 3/中 | 3/中 | 2/中 |
| P3 | 3/中 | 3/中 | 3/中 | 3/中 | 3/中 | 0/漏 |
| P4 | 3/中 | 3/中 | 2/中 | 1/中 | 1/中 | 0/漏 |
| P5 | 3/漏 | 3/漏 | 3/漏 | 3/漏 | 3/漏 | 0/漏 |
| A1 | 3/误 | 3/误 | 3/误 | 2/误 | 1/误 | 0/空 |
| A2 | 3/误 | 1/误 | 1/误 | 0/空 | 0/空 | 0/空 |
| A3 | 3/误 | 3/误 | 2/误 | 0/空 | 0/空 | 0/空 |
| A4 | 3/误 | 3/误 | 3/误 | 1/误 | 1/误 | 0/空 |
| A5 | 3/误 | 3/误 | 2/误 | 1/误 | 1/误 | 0/空 |
| B1–B5 | 0 | 0 | 0 | 0 | 0 | 0 |

## 建议阈值

**建议 0.65。** 理由：

1. 0.6 → 0.65 是唯一一段「正例不减、误出腰斩」的区间：正例仍是 4/5，误出从 5/10 题、11 条降到 3/10 题、4 条，每题平均条数从 1.53 降到 1.00。0.7 只再多省 1 条（4 条 → 3 条），0.75 直接丢掉 3 个正例。
2. 0.6 的问题不是「差一点」，而是把「同类术语、不同业务」这一档整档放进来：A1、A4 在 0.6 各有 3 条误出，A1 的最高分 0.70 比 P1 的正例（0.70）还高一线。这类误出比完全无关的问题危险，因为条目读起来像答案。
3. 0.65 下仍误出的 3 题是 A1（2 条）、A4（1 条）、A5（1 条），内容都是「确实切题、只是别的项目」的规矩。要再压下去只能靠项目相关性判断，不是调阈值能解决的，所以不建议为它们继续抬阈值。
4. 上限 3 条也值得一起看：P5 期望的两条（0.69、0.66）被 3 条上限挤掉，跨项目段给的是另外三条同样切题的。这是「最多 3 条」的代价，不是阈值的代价；如果想让这两条进来，要改的是上限，不是门槛。反过来说，0.65 之后每题平均只剩 1 条，把上限从 3 抬到 4 也不会让负例更脏，可以另开一题议。

不建议 0.7 的理由：它和 0.65 的正例命中一样，只少 1 条误出，但 P5 过了门槛的候选从 12 条降到 4 条（`e6343ea0` 0.66、`2bf7b240` 0.66、`8d19152a` 0.68 都被挡掉），而 P5 是这儿最依赖「多条不同角度」才能答对的一题。0.75 明确不可取：正例只剩 1/5，P3（0.74）、P4（0.74）、P5（0.74）都整题漏掉。

阈值常量在 `src/store.ts:25`（`CROSS_PROJECT_MIN_SIM = 0.6`）。按本次任务要求没有改，留给主会话定。

## 其他 CLI 行为检查

下面各项都用真实 CLI 各走一次。

| 检查 | 做法 | 结果 |
|---|---|---|
| degraded 不出跨项目段 | `ab-degraded` 的 `embedding.json` 指向 `embedding.invalid` | 通过。没有跨项目段，降级提示写明「跨项目段也要算查询向量，这次没查」 |
| pending 有提示 | 删掉其他四个项目（ai-data / pi-ops / insuranceagent / content-verification-agent）在副本里的全部向量（1556 → 1257），再搜 | 通过。段尾出现「另有 241 条其他项目的记忆还没算向量，可能漏」 |
| pending 与命中同时出现 | 只删 pi-ops / insuranceagent / content-verification-agent 的向量（剩 24 条待算），搜 P1 | 通过。正常出 `2018b871`，段尾仍带「另有 24 条」 |
| `--project` 不出 | data-asset 目录里 `search 比率指标怎么建模 --project data-asset` | 通过。无跨项目段 |
| `--all` 不出 | 同目录 `search 比率指标怎么建模 --all` | 通过。无跨项目段（跨项目条目直接混进了主结果，符合 `--all` 的语义） |
| pm 清单目录不出 | `AB_REGISTRY` 指向副本 `pm/repos`，在副本 pm 仓库根搜 | 通过。无跨项目段，主结果本来就是全库 |

degraded 那次的降级提示在 0.6 之外多了一句「跨项目段也要算查询向量，这次没查」，和任务书里「degraded 时有说明」一致。

pending 提示的计数口径是「其他项目里向量缺失或已过期的条目数」，不含本项目、不含全局。两次实测都对得上：第一次删掉四个项目共 499 条里的 241 条 active 条目向量，报 241；第二次只删 pi-ops / insuranceagent / content-verification-agent 三个项目，报 24（这三个项目在副本里大多是非 active，所以只剩 24 条 active）。

## Pensieve 替代

### 导入数字

在 `ab-import` 副本上跑，`--dry-run` 一次、正式三次。

| 次数 | 新增 | 内容变更改为纠正 | 未变 | 此前已归档不再导 | 补上正文 | 跳过 |
|---|---|---|---|---|---|---|
| 1 | 10 | 9 | 128 | 1 | 111 | 10 |
| 2 | 0 | 0 | 147 | 1 | 0 | 10 |
| 3 | 0 | 0 | 147 | 1 | 0 | 10 |

- 试运行：`共 148 条待导入，跳过 10 条`。
- 跳过的 10 条全部是 `.pensieve/decisions/` 里 `status: archived` 的文档；dry-run 输出逐条给了路径和 `status=archived`。
- 入库后全库导入条 167 条：data-asset 157 条（148 个 Pensieve id，其中 9 条是被纠正后留下的 superseded 历史），加 insuranceagent 早已导入的 10 条。导入前 data-asset 是 138 条、全部没有正文。
- 第一次「补上正文 111」：这些条目此前已导入过，但当时没存正文（§8.11.5 之前），这次按「源文件没变也补正文、不换 id」补上。
- 正文没写进库的 2 篇，导入自己报了出来并保留了原条目：`file-query-data-permission-design`（2833 字）、`file-query-multi-bucket-oss-sign`（3242 字），原因都是「正文里含密钥，先删掉再记」。这两篇的正文在库里是空的，`ab get` 也照实不显示正文。注意 21 篇 maxim 映射成规则，规则本来就不带正文（§8.11.2：规则必须一行说清），那 21 篇不算丢内容。
- 第一次和后来的运行都出现过 `关系判定: 出错 1，原因 向量: embedding 请求失败: The operation was aborted due to timeout`，以及 `向量未更新`。这是 embedding 调用超时（`EMBED_TIMEOUT_MS = 8000`）导致的：导入新增/纠正了 19 条条目需要算向量，加上原有的待算条目，`syncVectors` 一次最多补 200 条（`MAX_EMBED_PER_SYNC`），批量请求超时后这 130 条就一直待算。不影响导入结果（不重复、不改 id），重跑还会再试。

**第二次、第三次重导没有重复、没有改 id**：把每次运行后的导入条 `(id, import_ref.id, sha256, state, 有无正文)` 全量导出比对，三次完全一致（`imported-after1/2/3.tsv` 逐字节相同）。同一个 (项目, Pensieve id) 下没有出现两条非 superseded 的记录。

### 5 篇抽样

随机种子 20261102，population 是 `~/code/data-asset/.pensieve/knowledge` 下全部 56 个 `.md`（`python3 random.Random(20261102).sample(..., 5)`）。抽样列表落在 `pensieve-sample5.txt`。

| 篇 | id | 种类 | 库里正文 === 原文（去 frontmatter） | CLI stdout 里原文出现次数 | 原文长度 |
|---|---|---|---|---|---|
| qa-pair-ai-create-preview-contract/content.md | a6f84b70 | note | 是 | 1 | 1198 字 |
| code-taste-examples/content.md | e1fc1c25 | note | 是 | 1 | 4142 字 |
| interface-implementation-standard/content.md | 451800b5 | note | 是 | 1 | 2282 字 |
| qa-ragflow-dataset-management-flow/content.md | b21f41e3 | note | 是 | 1 | 1823 字 |
| qa-ragflow-dataset-metadata-management-flow/content.md | b6e18a79 | note | 是 | 1 | 3029 字 |

5 篇全部一致，没有任何差异，「脱敏处除外」这一条都没用上（这 5 篇里没有用户家目录路径或密钥）。比对方法两道：直接在投影里逐字比 `p.body`；再用真实 `ab get <id 前缀>` 的 stdout 检查原文正文是否作为一个连续片段出现，5 篇各出现 1 次，说明 CLI 输出没有插入、转义或截断。

### 全部 56 篇的情况（基线，不限于抽样）

| 情况 | 篇数 | 说明 |
|---|---|---|
| 逐字一致 | 49 | |
| 只在脱敏处不同 | 5 | 差距全部来自 `/Users/<name>` → `~`（`home_path` 脱敏），最多差 5 处 |
| 库里没有正文 | 2 | 原文含密钥，导入自己拒掉（上面两篇） |
| 其他真差异 | 0 | |

脱敏那 5 篇是 `content-verification-agent-architecture`、`external-open-api-auth-pattern`、`indicator-v13-interface-capability-map`、`tag-derive-upms-behavior`、`wework-oauth-crm-boundary`。差异类型单一：家目录路径被打码，没有出现「密钥导致整段跳过」「编码」「截断」这三种。

不是差异但值得记一笔：`project-structure` 这个 Pensieve id 在 data-asset 和 insuranceagent 两个仓库里都存在（不同内容，各自 1 条 active）。按 id 查时要注意加项目过滤，否则会拿错仓库的那条。本次比对脚本一开始踩了这个坑，加项目过滤后 56 篇的结果如上。

## 局限

- 判定由执行者一人完成，没有第二人复核；正例「命中」和负例「误出」都是人工标注。
- 题集是执行者看过库里的条目摘要后写的，5 个正例都对准了库里已有的条目。这不是无偏召回率，只能回答「这个阈值会不会让同类术语串项目、会不会漏掉真正有用的经验」。
- 15 题量小，阈值之间 0.05 的差异只代表 3–4 条条目，不能当成精确的最优解。0.65 和 0.7 的实际差别只有 1 条，选 0.65 有「留余量」的成分。
- 只测了 `ab search` 的跨项目段，没测 `ab recall --hook` 每轮召回（那是另一套门槛 `VEC_MIN_SIM`），也没让模型实际使用跨项目段里的条目回答。
- 中文查询的余弦分布集中在 0.5–0.8，0.6 与 0.65 在语义上差别不大，换一批问法结论可能移动一档。
- Pensieve 部分只在 data-asset 一个仓库上跑，其他仓库的 `.pensieve`（如 insuranceagent）没导。

## 发现但没修的问题

1. `ab import pensieve` 的关系判定对 embedding 超时很敏感：`EMBED_TIMEOUT_MS = 8000`，导入后 `ab-import` 副本里积了 130 条待算向量，每次重导都在补算这一步超时并报「关系判定: 出错 1」，导入条目本身没问题（幂等、不改 id）。要不要给导入单独放宽超时或分批，留给主会话定。
2. `project-structure` 这类 Pensieve id 在多个仓库重名（跨仓库短 slug）。同内容跨仓库会被合并成一条全局条目（`planImport` 里的 `dupKey` 逻辑），但**不同内容同 id** 就是各自一条，按 id 查时容易拿错。这次没有造成错误数据，只是比对脚本要小心。
3. `ab get` 对正文因密钥被拒的条目只显示标题和背景，不显示「正文因含密钥未入库」。用户看到条目不完整时没有提示（`get-secret-dropped.txt`）。导入报告里有，但一次性的。

## 改动的文件

只新增了本报告：`docs/eval/21-cross-project-threshold.md`。没有改 `src`，没有改任何工作仓库。

**真实库 `~/.agentbrain/`：数据没被写，但 `store.db` 的 mtime 被碰过。** 收尾核数时我跑了两个只读诊断脚本（`/tmp/pend.ts`、`/tmp/cnt2.ts`），它们直接 `new Store(~/.agentbrain/store.db, ~/.agentbrain/index.db)` 而不是副本；`Store` 构造函数会 `exec(SCHEMA)`（全部 `IF NOT EXISTS`）和一次 `PRAGMA table_info` 检查，所以 `store.db` 的 mtime 变成 14:52（`index.db` 仍 14:38，没被写），表结构和数据没变。证据：与 14:40 的副本逐表对得上（`prop_usage` 277、`memory_reports` 1895、`memory_report_ids` 224、`capture_windows` 852、`capture_candidates` 1253、`cite_scan` 956、`verify_attempts` 128、`work_meta` 5、`events` 2967）；真实库里 14:24 之后的新行全部来自其他人的 claude/pi 会话和 launchd（`inject_log` 里 host 是 `claude`/`pi`，`memory_queries` 全是 claude 的 `0a4c9d68`/`260113c5` 会话），没有一条是我的评测查询词。以后这类诊断脚本也要一律带 `AB_HOME` 指向副本。

## 跑过的命令（节选。ab 命令全部带 `AB_HOME` 和 `AB_REGISTRY`；两个诊断脚本漏了，见上一节）

```
sqlite3 ~/.agentbrain/store.db ".backup $PWD/ab/store.db"
sqlite3 ~/.agentbrain/index.db ".backup $PWD/ab/index.db"
node src/cli.ts search <题>                                  # 15 题，各自 cwd
node src/cli.ts search 比率指标怎么建模 --project data-asset
node src/cli.ts search 比率指标怎么建模 --all
node src/cli.ts import pensieve ~/code/data-asset --dry-run
node src/cli.ts import pensieve ~/code/data-asset            # 正式 3 次
node ~/.cache/agentbrain-eval/kd-cross/work/{score,summary,perquery,xcheck,cmp-all,sanitize-explain,sample5-check}.ts
```

## 证据

`~/.cache/verify-evidence/agentbrain/20261102-144010-kd-cross/`

- `queries.tsv` / `queries.tsv.lock`：题集与落盘时间、sha256
- `cli-P*.txt`、`cli-A*.txt`、`cli-B*.txt`：15 题的完整 CLI 输出
- `scores.tsv`：每题「其他项目」全部条目的余弦（不截断）
- `summary-detail.txt`：每题的分数明细 + 阈值汇总
- `threshold-table.txt`：逐题 × 6 个阈值的条数与命中
- `threshold-table-active-expectations.txt`：同上，期望 id 只留 active 重算（结果相同），以及 `expected-ids-check.txt`
- `pending-count.txt`：两份 pending 副本里缺向量的条目数与项目分布
- `xcheck-cli-vs-script.txt`：脚本分数与真实 CLI 跨项目段逐题比对
- `cli-check-degraded.txt`、`cli-check-pending*.txt`、`cli-check-scope-*.txt`：四条行为检查
- `import-dryrun.txt`、`import-run1/2/3.txt`、`import-by-project.txt`、`imported-before.tsv`、`imported-after1/2/3.tsv`
- `pensieve-sample5.txt`、`pensieve-sample5-check.txt`、`pensieve-compare-all56.txt`、`pensieve-get-verbatim.txt`
- `get-secret-dropped.txt`、`get-secret-dropped-expand.txt`

脚本在 `~/.cache/agentbrain-eval/kd-cross/work/`（`score.ts`、`summary.ts`、`perquery.ts`、`perquery-active.ts`、`xcheck.ts`、`cmp-all.ts`、`sanitize-explain.ts`、`sample5-check.ts`、`cli-body-check.ts`、`imported.ts`、`imported-by-project.ts`、`pending-count.ts`、`expected-ids.ts`）。

## 新坑 / 决定

**新坑**

- 跑批脚本里 `IFS=$'\t' read -r id cat cwd q` 会少读第 5 列，剩下的自动粘到最后一个变量，查询词里就混进了期望文本。多列 TSV 读循环必须显式读一列 `rest` 兜住。（证据：第一轮 `cli-P1.txt` 首行查询里带着 `ai-data 2018b871（…）`，分数从 0.70 涨到 0.78。）
- 在 `~/.cache/agentbrain-eval/kd-cross/` 里 `sqlite3 ... ".backup $PWD/ab/store.db"` 时，shell 在当前 shell 里先 `mkdir ab` 再 `cd` 的顺序稍有不对，`ab/` 里会生成 0 字节的 `store.db` 和随后 `no such table: events`；`.backup` 用绝对路径 + 先建目录才稳。（证据：14:39 那次的 `ab/store.db` 为 0 字节。）
- `~/.agentbrain/store.db` 是 WAL 模式，直接 `sqlite3 -readonly` 打开会报 `unable to open database file (14)`（目录不可写、无法建 shm）。用 `.backup` 导出，或直接不带 `-readonly` 打开，都能读到。（证据：`sqlite3 -readonly ~/.agentbrain/store.db "select count(*) from events"` 报错，同一句去掉 `-readonly` 返回 2963。）
- 真实库有 launchd 定时任务（`com.agentbrain.work`）在跑 `ab work --sweep`，评测期间真实库 `events` 从 2963 涨到 2967（都是 06:37–06:38 UTC）。要断言「真实库没被写」必须用 `memory_queries`、`prop_usage` 这类只跟该动作相关的表，别用 `events` 总数。（证据：真实库 `memory_queries` 在 14:24 之后新增的 9 条全部是 claude 会话的，六个副本各 81–98 条。）
- 同一个 Pensieve id 可以出现在多个仓库（`project-structure` 在 data-asset 和 insuranceagent 都有）。按 id 跨库查导入条时必须同时过滤项目，否则会拿错仓库那条。
- 直接 `new Store(<真实库路径>)` 开一个「只读」诊断脚本，也会把真实库文件的 mtime 改掉（构造函数跑 `SCHEMA` 和 `PRAGMA`）。要只读就读副本，或直接用 sqlite3。

**决定**

- 阈值评测用独立题集，先在 `queries.tsv.lock` 记下时间和 sha256 再看分数；cwd 笔误的修正也写进 lock，修正只改路径不改查询词。
- 阈值评测和 Pensieve 导入分用两份副本（`ab` / `ab-import`）。第一轮两件事挤在一份副本上，导入在 CLI 截图之后又往 data-asset 加了一批条目，导致后跑的脚本多出 CLI 快照里没有的 `00f2bc55`（P3）；分开后 15 题全部一致。
- 报告只写 id、相似度和短查询，Pensieve 部分只写篇名、长度和差异类型，不贴任何正文。
- 建议阈值 0.65，最终由主会话定；本次没有改 `src/store.ts` 的常量。
