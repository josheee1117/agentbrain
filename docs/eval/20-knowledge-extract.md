# Eval 20：决策卡与知识抽取评测及背景还原测试

日期：2026-11-02（SGT）。
被测分支：`feat/knowledge-decisions` @ `2766d78`。
对应设计：`docs/design/20260804-agentbrain-总体设计.md` §8.11.6 第 2 项（抽取评测）与第 3 项（还原测试）。

## 做法与隔离

1. **环境与数据隔离**：
   - 使用隔离目录 `~/.cache/agentbrain-eval/kd-extract2/home` 作为 `HOME`，库目录为独立的 `kd-extract2/ab`（从**纯空库**开始，无历史 store.db/index.db）；
   - 通过软链连接钥匙串（只读凭据）及代码项目路径（只读代码核验）；
   - 对话素材复制自 `~/.cache/agentbrain-eval/kd-extract/transcripts/moved-from-host-dir/` 下 3 个会话副本到隔离目录 `.claude/projects/`，未读取宿主真实目录，未启动真实宿主；
   - 抽取模型使用 `extract.json` 配置的 `cn:deepseek-v4.1-flash`（max 档推理）；
   - 所有命令均通过 `HOME=$R/home AB_HOME=$R/ab AB_REGISTRY=$R/registry node .../src/cli.ts` 运行。
2. **原始模型返回捕获**：
   - 编写 `node --import record-fetch.mjs` 全局拦截器，对每次发送给抽取模型 `/chat/completions` 的响应正文原样存盘到 `kd-extract2/raw/*.json`（未记录请求头与密钥）。
3. **人工基线先行**：
   - 在执行 `ab capture` 和 `ab work` 前，人工通读三段会话副本中用户原话，提炼出 3 × 3 = 9 项最重要的决定或知识存盘于 `kd-extract2/human-selected-baseline.md` 并记录时间（2026-11-02 16:55 SGT）。

---

## 抽取评测结果

### 1. 三段会话总体统计表

| 会话 ID | 会话主题 | 所在目录（项目） | 窗口数 | 抽取候选 | 提议入库 | 决定 (decision) | 规则 (rule) | 知识 (note) | 坑 (pitfall) | 丢弃候选 (整条/单条证据) | 窗口失败 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `f306c00a` | pi-ops 门禁讨论 | `pm` | 3 | 15 | 14 | 1 | 2 | 1 | 10 | too_long 1 / quote_mismatch 1, role_mismatch 2 | 0 |
| `10e1a41f` | 规则场景标签讨论 | `pm` | 3 | 10 | 9 | 3 | 3 | 1 | 2 | too_long 1 / 无 | 0 |
| `de34203f` | insuranceagent 调用链摸底 | `insuranceagent` | 2 | 10 | 8 | 2 | 3 | 2 | 1 | 无 / 无（关系未判定 2） | 0 |
| **总计** | - | - | **8** | **35** | **31** | **6** | **8** | **4** | **13** | **too_long 2 / 证据丢弃 3** | **0** |

*注：全量提取后最终沉淀条目共 33 条（含未确认 23 条、代码核验转正 10 条、与代码不符标记 3 条）。项目分布：pm 12、insuranceagent 9、agentbrain 4、全局 4、pi-ops 3、data-asset 1。*

---

### 2. 人工基线 3 × 3 个核心条目核对

| 会话 | 人工基线核心内容 | 模型原始返回 | 最终入库 | 没入库原因与丢弃代码行 |
|---|---|---|---|---|
| `f306c00a` | 1. pi-ops main 分支保护门禁规则调整（final 改只显示不拦截；后续彻底关闭门禁） | **有**（`06.json` Candidate 1，kind: decision，project: pi-ops） | **未入库** | **丢在 `too_long`**：`src/extract.ts:422-423`。模型输出了 4 条 evidence，超过了 `MAX_EVIDENCE = 3`（`src/extract.ts:16`），代码在 `if (!text || why === null || trigger === null || c.evidence.length > MAX_EVIDENCE)` 处直接整条丢弃。 |
| `f306c00a` | 2. `tools/verify-status --dispatch` 派发去重 | **有**（`01.json` Candidate 2） | **入库**（`5806451a`，rule） | 正常入库，模型归类为 rule。 |
| `f306c00a` | 3. pi-ops 门禁修改时全量测试兜底与测试用例超时规范 | **有**（`06.json` Candidate 2/3/4） | **全部入库**（`6e6031e9`、`d823f836`、`9b425ecc`） | 拆为全量测试兜底坑与异步测试超时规范坑，全部入库且通过代码核验转正。 |
| `10e1a41f` | 1. 规则按场景（design/code/review）打标签 | **有**（Candidate 1） | **入库**（`b49d0b20`，decision） | 正常入库，带完整 alternatives 与正文。 |
| `10e1a41f` | 2. 抽取模型选型（国内版）与取消超时限制 | **有**（Candidate 2/3） | **全部入库**（`a9f97359` decision，`6dcf1158` rule） | 正常入库，带完整 alternatives 与原话。 |
| `10e1a41f` | 3. agentbrain 替代 Pensieve 定位与子代理跨项目可见 | **有**（Candidate 4） | **全部入库**（`8241778b` decision，`3cbc24c3` rule） | 正常入库（用户选 A），带完整 alternatives 与正文。 |
| `de34203f` | 1. GET /tag/listByScene 接口按对象区分 scenekey | **有**（Candidate 1） | **入库**（`1f9ec84b`，rule） | 正常入库，列入接口约定。 |
| `de34203f` | 2. markAllGroupWithWework 缺 weworkId 跳过不报错 | **有**（Candidate 1/2） | **全部入库**（`1f9ec84b` rule，`a09cd262` note） | 正常入库，note 通过代码核验转正。 |
| `de34203f` | 3. 企微标签全量推送与按值自动打标支持 | **有**（Candidate 3/4） | **全部入库**（`4be8342a` rule，`5986d576` decision，`de3d9030` rule） | 正常入库，带完整 alternatives 与正文。 |

---

### 3. 门禁会话“决定 0 条”根本原因定性

针对上一轮线索“pi-ops 门禁会话 12 条结果里决定 0 条”的问题调查结论：
- **结论：模型明确提出了该决定，是被后续校验代码丢弃的。**
- **模型原始返回证据**（`kd-extract2/raw/06.json` Candidate 1）：
  ```json
  {
    "kind": "decision",
    "project": "pi-ops",
    "basis": "user_directive",
    "text": "pi-ops 的 GitHub 门禁整体去掉：main 不要求任何必过检查，final（governance-trust-anchor）和 evidence-gate 两个 workflow 都停用，只留禁强推和禁删分支；门禁代码没删，可恢复。以后 pi-ops 的 PR 不会自动跑测试，验证要在本地跑 pnpm test。",
    "why": "背景：pi-ops 的 final 门禁只要改了已登记为证明的测试就一律拒绝，没有人工放行；#33–#37 连续 5 次合并这项全红、每次都用管理员权限强合，#34/#37 连 evidence-gate 也红着被一起合进来，门禁既没拦住坏代码又架空了真正的测试检查。用户因此让直接改 GitHub 上的门禁，而不是继续绕。",
    "alternatives": [
      {
        "option": "维持现状：final 仍留在必过检查里，红了用管理员权限硬合",
        "rejected_because": "final 从不放行，强行合并还会把 evidence-gate 的红一起带进来，等于架空真正的测试检查",
        "evidence": 2
      }
    ],
    "evidence": [
      { "anchor": "#33", "role": "user", "quote": "你直接帮我把 github 中的这个 gate 关闭或者改成你更赞同的方式" },
      { "anchor": "#57", "role": "assistant", "quote": "从 #33 起，最近 5 个合并的 PR，`final` 全部没过，每次都是你用管理员权限强行合并。" },
      { "anchor": "#57", "role": "assistant", "quote": "强行合并连带架空了真正的测试" },
      { "anchor": "#242", "role": "assistant", "quote": "main 分支不再要求任何检查通过才能合并。禁止强推、禁止删分支这两条保护还留着。" }
    ]
  }
  ```
- **被丢弃的代码行**：`src/extract.ts:422`。
  ```ts
  const text = str(c.text, MAX_TEXT_CHARS);
  const why = c.why === undefined || c.why === null || c.why === "" ? undefined : str(c.why, MAX_WHY_CHARS);
  const rawScenario = c.scenario ?? c.trigger;
  const trigger = rawScenario === undefined || rawScenario === null || rawScenario === "" ? undefined : str(rawScenario, MAX_TEXT_CHARS);
  if (!text || why === null || trigger === null || c.evidence.length > MAX_EVIDENCE) {
    drop("too_long");
    continue;
  }
  ```
  在 `src/extract.ts:16` 中定义了常量 `export const MAX_EVIDENCE = 3`。模型为了充分论证背景和否决原因，给出了 4 处证据（1 处用户原话 + 3 处助手原话），使得 `c.evidence.length (4) > MAX_EVIDENCE (3)`，直接触发 `drop("too_long")`，导致整条关键决定被过滤丢弃。
- **提示词问题**：在 `src/extract.ts:313` 提示词中，仅说明了“每条候选必须带证据，程序会逐字核对”，**完全未说明证据条数不能超过 3 条**。校验端硬性限制了 3 条且超出直接整条丢弃，而非截取前 3 条，导致高质量候选被误杀。

---

### 4. 四项人工判定逐项核验

1. **决定写出了具体对象，否掉的方案带了原话**：
   - 证据 1（`b49d0b20`）：具体对象为“品味规则按场景打标签（design / code / review）”，否掉方案为“先用环境变量 AB_SCENE 传场景给 pi”，原话附带“我建议按照 tag 区分一下，方便召回时有针对性的来”。
   - 证据 2（`cdacd535`）：具体对象为“标签链路 objectId 从 bigint 改成 varchar(64)（utf8mb4_bin）”，否掉方案为“新增 object_key 字段，企微用 key、其他对象继续用数字 ID”，原话附带“另加 object_key 字段的话，所有查询和写入都要分‘企微用 key、其他用 id’两条路，这种特殊分支会散得到处都是”。
   - 证据 3（`a9f97359`）：具体对象为“agentbrain 抽取模型用 workbuddy 国内版（cn:deepseek-v4.1-flash）”，否掉方案为“把抽取模型换成腾讯渠道的 deepseek flash”，原话附带“我的建议是把抽取模型换成腾讯 deepseek flash”。
2. **至少产出一条 note（知识），并且通过代码核验或被正确判为不可核验**：
   - 实际共抽取产出 **4 条 note**，并在 `ab work --sweep` 中**全部真实通过代码核验转正（confirmed: true）**：
     - `9f4fe29a`（pi-ops）：pi-ops 根目录 `deploy/local/` 下的测试文件不属于任何子项目，`pnpm -r test` 跑不到；
     - `a5a7e714`（pm）：给 herdr 里的 pi 传参数只能写进发出的文本，不能靠环境变量；且这行指令要放在 pstack / skill 前缀之后；
     - `770a25d0`（insuranceagent）：企微标签同步上线前必须先给 WEWORK 标签组配好 tag_permission，再打开同步开关；
     - `a09cd262`（insuranceagent）：markAllGroupWithWework 只有 object=WEWORK 的标签组用 weworkId 保存，其余组（含派生组）一律沿用 custId。
3. **pm 会话里讲 pi-ops 的决定落到 pi-ops，或标「归属未定」，不能落成 pm**：
   - 会话 `f306c00a`（pm 目录）中关于 pi-ops 的条目（如 `9f4fe29a` note、`6e6031e9` pitfall、`9b425ecc` pitfall）全部落到 `pi-ops`，未落成 pm；
   - 会话 `f306c00a` 中关于 data-asset 的决定 `2484dff7` 落到 `data-asset`，`ab get` 明确提示：`归属: 会话在 pm，抽取判定归属 data-asset`；
   - 会话 `10e1a41f`（pm 目录）中关于 agentbrain 的决定 `a9f97359` 和 `8241778b` 全部精准落到 `agentbrain`。
4. **统计数据**：
   - 窗口数：共 8 个窗口全部完成，延后 0，失败 0；
   - 候选数：产出候选 35 条，提议 31 条，入库 33 条；
   - 丢弃统计：整条候选丢弃 2 条（均为 `too_long`，由于 evidence.length > 3 触发）；单条证据丢弃 3 处（1 处 `quote_mismatch`，2 处 `role_mismatch`）；
   - 窗口失败数：0。

---

## 还原测试结果

在测试库中删除 `$R/home/.claude/projects/` 下全部 3 个对应会话副本文件后，仅凭 `ab get <id> --expand` 回答 4 个问题。
因门禁会话抽出的决定 Candidate 1 被 `too_long` 丢弃，决定条目从另外两段会话挑选：
- 条目 1：`b49d0b20`（规则场景标签，来自会话 `10e1a41f`）
- 条目 2：`cdacd535`（标签 objectId 改 varchar，来自会话 `de34203f`）
- 条目 3：`a9f97359`（抽取模型选型，来自会话 `10e1a41f`）

### 还原问答与判定

| 问项 | 条目 1：`b49d0b20` (场景标签) | 条目 2：`cdacd535` (标签改字段) | 条目 3：`a9f97359` (抽取模型选型) |
|---|---|---|---|
| **1. 当时什么问题** | **答得出**：23 条品味规范写成全局规则占满开工摘要预算（2000字），导致开发和 review 组规则全显示不出来；并非所有场景都需要全量加载。 | **答得出**：标签模块接入企微客户（WEWORK）对象，企微客户身份是 external_userid 字符串，库中无稳定数字 ID。 | **答得出**：workbuddy 国际版渠道当天上午不稳，多个窗口超时或报错延后，需要配置和切换抽取模型与密钥。 |
| **2. 定了什么** | **答得出**：规则按场景打标签（design/code/review，可多选），派活按类别自动加载，主会话摘要只放一行索引；正文说明数据格式、命令和互斥逻辑。 | **答得出**：三张表 object_id 改 varchar(64)（utf8mb4_bin），直接存 external_userid；分两步开发交付（先换类型回归、后上功能）。 | **答得出**：抽取模型改用 workbuddy 国内版（`cn:deepseek-v4.1-flash`，max 档，钥匙 `agentbrain-extract-cn`），不用腾讯试用套餐。 |
| **3. 否掉了什么** | **答得出**：否掉“先用环境变量 AB_SCENE 传场景给 pi”，理由是 herdr agent start 不收环境变量，send 复用原进程也换不了。 | **答得出**：否掉“新增 object_key 字段，企微用 key、其他继续用数字 ID”，理由是查询写入分两条路，特殊分支散得到处都是。 | **答得出**：否掉“把抽取模型换成腾讯渠道的 deepseek flash”，理由是用户认为抽取不适合用现在的腾讯试用套餐。 |
| **4. 谁说的原话** | **答得出**：user 说“我建议按照 tag 区分一下，方便召回时有针对性的来”；assistant 说“每条规则可以带场景标签，取值是设计 / 开发 / review...”。 | **答得出**：user 说“接下来我先把测试环境的字段类型改成字符串，然后下一步我们开始开发”；assistant 提供了理由原话。 | **答得出**：user 说“国际版不稳就让国内版的那个继续，这个抽取不太建议使用现在这个腾讯的试用套餐”；assistant 提议原话在案。 |
| **综合判定** | **4 问全答得出** | **4 问全答得出** | **4 问全答得出** |

### `ab get <id> --expand` 原样输出

```text
#################### ab get b49d0b20 --expand ####################
[b49d0b20] pm 决定 未确认（自动沉淀）: 品味规则按场景打标签（design / code / review，可多选），派活时按派活单的 `- 类别：` 换算场景自动加载对应规则，主会话开工摘要只放一行索引让人用 `ab search --scene <场景>` 查；带场景标签的规则不再进通用全局段。
触发: 当要改 agentbrain 的规则召回方式、或决定某条品味规则在什么场景加载时
为什么: 用户指出不是所有场景都需要全量加载这些品味规则——设计方案、开发代码、review 各有侧重，应按 tag 区分让召回更有针对性；当时 23 条规范刚写成全局规则，把开工摘要的全局段占满，开发组 C 和 review 组 R 一条都显示不出来（包括用户要的 R0），场景标签同时解决针对性加载和字数预算两个问题。
否掉的方案:
  先用环境变量 AB_SCENE 传场景给 pi：herdr agent start 本身不接收环境变量，send 复用原进程时也换不了场景（「我建议按照 tag 区分一下，方便召回时有针对性的来」）
正文:
场景取值只有 design / code / review，可多选，沿用现有 tag 事件，命令为 `ab remember --scene` 和 `ab tag <id> --scene`，非法值直接报错。派活映射：编码类→code；review/代码→review；review/方案、review/技术→design,review；调研、验证→不设。场景通过派活脚本发出去的文本里一行「开工跑 `ab brief --worker --scene <场景>`」传入，位置在 pstack/opencode 前缀之后。开工摘要里：带标签的规则不进通用全局段（被挤掉的原有全局规则因此回来），有场景时场景段单独占 2000 字预算，无场景时只多一行索引。实现细节：场景规则先按项目范围筛再按场景筛；`ab correct` 纠正时继承原条目的场景标签；`ab search --scene` 只做列举、不能和关键词同用（检索先截断再筛会漏条目）；场景标签与常驻偏好互斥（否则偏好每轮注入，场景限制失效）；交付记录只记最终真正输出的条目。
原话:
  [user 2026-10-30T01:45:28.951Z] 我建议按照 tag 区分一下，方便召回时有针对性的来
  [assistant 2026-10-30T01:46:53.824Z] 每条规则可以带场景标签，取值是设计 / 开发 / review，可以同时带多个
依据: 用户原话，引文 2 处（user@d46d07d8-95c、assistant@fdedd682-bdb）
来源: 自动沉淀（ab work）：当要改 agentbrain 的规则召回方式、或决定某条品味规则在什么场景加载时（claude）  记录于 2026-11-02
模型产出记录:
  [b49d0b20] 抽取: cn:deepseek-v4.1-flash，提示词版本 6dfe32b2a655
相关（向量近邻）:
  [a5a7e714] pm 事实: 给 herdr 里的 pi 传参数只能写进发出的文本，不能靠环境变量；且这行指令要放在 pstack / skill 前缀之后。（0.63）
  [3cbc24c3] 全局 规则[未确认·自动沉淀]: review 固定以「抛开历史包袱，在用户可见行为不变的前提下，如果删掉重新开发，我们还会选择这条路线吗」作为第一问；答「会」要说出这条路好在哪里，答「不会」要写清会改选哪条路线、现在切换的代价和建议切换时机，按重要级别报告但不要自作主张去重写。（0.61）
  [5dc7f928] pm 坑: 执行方撞额度停下不会自己续做；先查它在工作区改了哪些文件，一个都没改才关掉 tab、用同一张派活单换下一个模型重派，避免白等或让半成品被重派冲掉。（0.58）

--- 原对话已不可用：transcript 不存在或定位点失效（定位点失效），下面是库里存的原话 ---
原话:
  [user 2026-10-30T01:45:28.951Z] 我建议按照 tag 区分一下，方便召回时有针对性的来
  [assistant 2026-10-30T01:46:53.824Z] 每条规则可以带场景标签，取值是设计 / 开发 / review，可以同时带多个

#################### ab get cdacd535 --expand ####################
[cdacd535] insuranceagent 决定 未确认（自动沉淀）: 标签链路 objectId 从 bigint 改成 varchar(64)（utf8mb4_bin），企微客户直接存 external_userid；分两步交付：第一步只换类型并回归原有打标/同步，第二步再上 WEWORK 功能。
触发: 当 insuranceagent 标签模块要接入企微客户（WEWORK）对象、需要确定 objectId 存什么类型时
为什么: 企微客户的身份就是 external_userid 字符串（crm 表注释与测试库数据都确认），库里没有稳定的数字 ID 能代替；另加 object_key 字段会让所有查询和写入分「企微走 key、其他走 id」两条路，特殊分支散得到处都是。助手提出后，用户先在测试库执行了改表，再同意按两步开发。
否掉的方案:
  新增 object_key 字段，企微用 key、其他对象继续用数字 ID：所有查询和写入都要分两条路，这种特殊分支会散得到处都是（「另加 object_key 字段的话，所有查询和写入都要分"企微用 key、其他用 id"两条路，这种特殊分支会散得到处都是」）
正文:
涉及 tag_marker、tag_marker_log、tag_pending_sync 三张表的 object_id 字段；排序规则必须用 utf8mb4_bin：external_userid 区分大小写，用默认排序规则会把只差大小写的两个 ID 当成同一个，撞唯一索引。故意保持 Long 不动的地方：CusTags.cusId（华哥客户接口）、TagChange（经 tag_change_topic MQ 发给仓库外消费方，消息格式不能变）、源表原始 id 与规则 SQL 的 idExpression（有一条规则拿字符串列比较，改按字符串传会改变 0123 这类带前导零编码的匹配结果）。回滚点：企微数据写入前，三张表都能改回 bigint；写入后字段改不回去。
原话:
  [user 2026-10-09T01:52:28.070Z] 接下来我先把测试环境的字段类型改成字符串，然后下一步我们开始开发。
  [assistant 2026-10-08T09:48:32.430Z] 同意把 `object_id` 改成字符串
  [assistant 2026-10-08T09:48:32.430Z] 另加 object_key 字段的话，所有查询和写入都要分"企微用 key、其他用 id"两条路，这种特殊分支会散得到处都是
依据: 用户认可，引文 3 处（user@6d2e0154-cd8、assistant@08d87ed4-a4c、assistant@08d87ed4-a4c）
来源: 自动沉淀（ab work）：当 insuranceagent 标签模块要接入企微客户（WEWORK）对象、需要确定 objectId 存什么类型时（claude）  记录于 2026-11-02
模型产出记录:
  [cdacd535] 抽取: cn:deepseek-v4.1-flash，提示词版本 6dfe32b2a655
  [fd969219] 关系判定: cn:deepseek-v4.1-flash，提示词版本 7973ce2af3a2
关联:
  被它补充 [5986d576] insuranceagent 决定[未确认·自动沉淀]: 标签规则打标读源表 ID 改为按值判断：能转成数字就按数字（00123→123），转不了就原样当字符串用（企微 wm…、…
相关（向量近邻）:
  [331e4c7a] 全局 坑[未确认·自动沉淀]: 数字 ID 字段改成字符串时：Java 侧传参必须全部同步改成 String，SQL 里写死的 = 0 要改成 = '0'，否则隐式转换会让索引失效，且 'wmXXX' = 0 判真、查出脏数据；空串要先转 null；生产先发代码再改表。（0.83）
  [770a25d0] insuranceagent 事实: 企微标签同步上线前必须先给 WEWORK 标签组配好 tag_permission，再打开同步开关。（0.77）
  [a09cd262] insuranceagent 事实: markAllGroupWithWework 只有 object=WEWORK 的标签组用 weworkId 保存，其余组（含派生组）一律沿用 custId。（0.77）

--- 原对话已不可用：transcript 不存在或定位点失效（定位点失效），下面是库里存的原话 ---
原话:
  [user 2026-10-09T01:52:28.070Z] 接下来我先把测试环境的字段类型改成字符串，然后下一步我们开始开发。
  [assistant 2026-10-08T09:48:32.430Z] 同意把 `object_id` 改成字符串
  [assistant 2026-10-08T09:48:32.430Z] 另加 object_key 字段的话，所有查询和写入都要分"企微用 key、其他用 id"两条路，这种特殊分支会散得到处都是

#################### ab get a9f97359 --expand ####################
[a9f97359] agentbrain 决定 未确认（自动沉淀）: agentbrain 的抽取模型用 workbuddy 国内版（`cn:deepseek-v4.1-flash`，max 档，钥匙 `agentbrain-extract-cn`），不用腾讯渠道的试用套餐（2026-10-30 定）。
触发: 当配置或切换 agentbrain 抽取（自动沉淀）用的模型和钥匙时
为什么: 背景：workbuddy 国际版渠道当天上午不稳，多个窗口超时或报错被延后；助手建议顺手把抽取换成腾讯 deepseek flash（理由是用户刚说过优先腾讯渠道、今天三张单子它很稳），用户否掉，明确抽取不建议用现在的腾讯试用套餐，用国内版继续。
否掉的方案:
  把抽取模型换成腾讯渠道的 deepseek flash：用户认为抽取不适合用现在的腾讯试用套餐，要求国际版不稳就切国内版（「我的建议是把抽取模型换成腾讯 deepseek flash」）
正文:
国际版和国内版走同一个本机反代（7864 端口），只是模型名不同；国内版要单独的钥匙，用国际版钥匙调国内版会报 `realm_mismatch`（「该密钥仅限国际版模型」）。钥匙从 pi 的 `~/.pi/agent/models.json` 的 `workbuddy-cn` 项取，存进钥匙串 `agentbrain-extract-cn`；`~/.agentbrain/extract.json` 的 model 改成 `cn:deepseek-v4.1-flash`、keyService 改成 `agentbrain-extract-cn`，baseUrl 和 max 档不变，原配置备份在 `extract.json.bak-global-20261030`。国际版恢复稳定后要切回只需改回一行配置。`secrets/keychain.tsv` 的凭据备份行由用户自己补。
原话:
  [user 2026-10-30T03:59:43.193Z] 国际版不稳就让国内版的那个继续，这个抽取不太建议使用现在这个腾讯的试用套餐
  [assistant 2026-10-30T03:54:40.695Z] 我的建议是把抽取模型换成腾讯 deepseek flash
归属: 会话在 pm，抽取判定归属 agentbrain
依据: 用户原话，引文 2 处（user@d08bacd9-6bc、assistant@d00d43a8-691）
来源: 自动沉淀（ab work）：当配置或切换 agentbrain 抽取（自动沉淀）用的模型和钥匙时（claude）  记录于 2026-11-02
模型产出记录:
  [a9f97359] 抽取: cn:deepseek-v4.1-flash，提示词版本 6dfe32b2a655
相关（向量近邻）:
  [6dcf1158] agentbrain 规则[未确认·自动沉淀]: 抽取请求不要设置超时：不传超时参数、不挂中止信号，宁可让请求跑几分钟，也不要因为超时把窗口判失败或延后。（0.62）
  [6715cb3b] 全局 规则[未确认·自动沉淀]: 先自己在现有配置里找（比如 pi 的 `~/.pi/agent/models.json` 里就存着各渠道的钥匙），不要一上来就写一条命令让用户在自己终端手工执行。（0.56）
  [f7939795] agentbrain 坑: 环境里带 `AGENTBRAIN_REVIEWER=1` 会让 agentbrain 的 16 项 hook 测试失败（它会跳过召回和捕获），不是代码问题；跑全量测试前先清掉这个变量。（0.53）

--- 原对话已不可用：transcript 不存在或定位点失效（定位点失效），下面是库里存的原话 ---
原话:
  [user 2026-10-30T03:59:43.193Z] 国际版不稳就让国内版的那个继续，这个抽取不太建议使用现在这个腾讯的试用套餐
  [assistant 2026-10-30T03:54:40.695Z] 我的建议是把抽取模型换成腾讯 deepseek flash
```

---

## 观察与发现的问题（只记录，不修改代码）

1. **证据数量上限与 `too_long` 丢弃过严**：
   - 代码行：`src/extract.ts:422`。
   - 触发场景：抽取模型对复杂度高、带决策分歧和多方论证的条目（如 pi-ops 门禁重构），提供了 4 条证据引用（1 处 user 要求 + 3 处 assistant 方案对比与收尾），超出 `MAX_EVIDENCE = 3` 上限。
   - 结果：整条高质量候选被直接丢弃，且提示词中从未告知模型证据数量上限为 3。建议：对超长 evidence 数组执行防御性截断（如 `c.evidence.slice(0, MAX_EVIDENCE)`）并重映射下标，或在提示词中显式约束证据条数上限，避免因辅助论据多而扼杀关键决策。
2. **提示词与代码类型定义中缺失知识（note）规范**：
   - 文件与行号：`src/extract.ts:20`、`src/extract.ts:30`、`src/extract.ts:300-338`。
   - 现状：代码中 `CandidateKind` 仍为 `Extract<PropKind, "pitfall" | "decision" | "rule">`，提示词 `SYSTEM` 仍写“只记三种：pitfall, decision, rule”。然而 deepseek 模型在理解整体背景后，自发产出了 4 条 `note` 并顺利通过了后续的 `validate`（如果宽松解析）及 `codeverify` 真实代码核验转正。建议：按设计 §8.11.3 补齐提示词中的 note 定义与代码中的 `CandidateKind`。
