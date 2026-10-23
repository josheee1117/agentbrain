# Eval 17：只靠召回块指令的 ab-used 标注（51b2a6e 实跑，2026-10-22，部分完成）

> 目的：eval 16 开组的宿主指令文件里有 ab-used 说明，51b2a6e 删掉了托管块里的 CITE 两条，只剩召回块末尾那句指令。本轮量"只靠召回块"的标注率/精确率/召回率，并端到端验证 51b2a6e 的遥测链路。

## 设置
- 代码：GitHub `feat/memory-viewer` @ `51b2a6e` 的临时克隆 `/private/tmp/cite17/agentbrain`；另加一个只在本地的提交，删掉 `eval/cite-used/` 和 `docs/eval/16-cite-used.md`（里面有临时库的真实 id，带工具的宿主能读到），代码不变。
- 库：复制 eval 16 的 `abhome-on`（44 条脱敏记忆，id 与 eval 16 相同），清空 capture 表；库里带 dev 期 `rank` 列的旧遥测表（inject_log 360 / recall_runs 223 / cite_scan 141 行）在第一次打开时被 `dropPreviewTelemetry` 删除重建（0 行、无 rank 列），已核对。
- 隔离 HOME `/private/tmp/cite17/home`：钥匙串、Pi `models.json`、Codex `auth.json` 都是软链；`~/.local/bin/ab` 是包装脚本，指向临时 cli + 临时 AB_HOME；Codex hook 命令里直接写 `AB_HOME=…`；stdin `</dev/null`。
- 宿主指令文件：`ab setup --notes` 写的新托管块（不含 ab-used），`grep -c ab-used` 四个文件都是 0；`ab setup --cite on`。
- 宿主：

| 宿主 | 版本 | 模型 | 推理 | 工具 |
|---|---|---|---|---|
| Pi | 1.3.0 | cpa/deepseek-v4.1-flash（models.json 里唯一的 v4.1） | `--thinking max` | `--tools read,grep,find,ls`（只读） |
| Codex | codex-cli 0.162.1 | gpt-5.6-sol | `model_reasoning_effort="xhigh"` | 只读沙箱 |

- 题目：eval 16 的 23 题。runner `harness/run.py`（断点续跑，429 等 10 分钟）。

## 完成情况
- Pi：23/23（q18 第一次 400 `reasoning_text must be passed back`，重试成功）。
- Codex：q01–q06 共 6 题；q07 起 ChatGPT 账号额度用尽（提示 15:31 SGT 重置），runner 已停。
- 抽取 `ab work`：抽取模型 ark deepseek-v4.1-flash 5 小时额度用尽（`AccountQuotaExceeded`，13:57:43 SGT 重置），31 个窗口全部延后，**没有抽出任何东西**。

## 结果（标注由执行代理逐条人工判定，未经用户抽查）

| | 有召回的轮 | 模型写了 ab-used | 扫描记为已标注 | 看板标注率 | 精确率（模型行） | 召回率（模型行） | 没召回却标 |
|---|---|---|---|---|---|---|---|
| Pi deepseek-v4.1-flash | 19 | 19/19 | 18 | 18/20 = 90% | 26/27 | 26/27（另 1 条说不清） | 0/4 |
| Codex gpt-5.6-sol | 6 | 6/6 | 6 | 6/6 = 100% | 10/10 | 10/10 | — |

- 和 eval 16 比：Pi 带工具后没有"空回答"轮，只靠召回块指令，标注率 19/19（eval 16 deepseek-v4-pro 无工具 8/20）。Codex 6 题全标、全对，样本小。
- Pi 误标 1：q09 标了 0246839d（hook 要 try/catch），正文讲的是卡住和超时，只顺带一句"异常被 try 吞掉"。漏标 1：q11 用了 f4c6a2e6（决定不进 brief 正文）没标。
- 标题不符 1：Pi q17 把两条记忆的标题写进一个分段，按规则判为不符（id 正确）。
- 看板 Pi 分母是 20 而不是 19、已标注是 18 而不是 19，由下面两个新坑造成。

## 端到端核对
- 召回注入：两宿主都注入，`inject_log` 43 行（pi 34 / codex 9），`recall_runs` 34 行，`cite=1`。
- 解析：35 次引用记入，0 个 id 被丢；标注率 ≤100%（90% / 100%）。
- 失败轮：Pi q18 第一次（400，模型没有文字回复）**没有**被标 `failed`，见坑 1。Codex 额度失败的 4 次都是 q07（没召回），不进分母，正确。
- `ab work` 跑了 4 次（都因 429 延后），遥测行和标注没被改动；抽取后锚点是否完好**没验证**（没抽成）。
- `ab view` 正常生成，截图 `assets/17-view-overview.png`。

## 新坑
1. **调用工具后失败的轮不会被标 failed**：`markFailedTurns` 把"本轮有任何带文字的助手轮"当成已回答，而 Pi transcript 清洗后的工具调用轮文字是"调用 read: …"，所以模型调用工具后报错的轮也算已回答。建议只认非工具调用的助手文字。
2. **回答里提到 `<agentbrain-recall>` 会吞掉后面的 ab-used 行**：`stripInjected` 的 `<agentbrain(-recall)?>…(</…>|$)` 在没有闭合标签时一直删到文末。Pi q11 回答里写了反引号包着的 `<agentbrain-recall>`，后面的正文和末行 ab-used 都被删，这轮记为没标；抽取也会丢掉这段正文。建议扫描直接解析原文，以及只剥离真正注入的块（例如要求闭合，或只剥用户消息里的）。
3. Pi 扩展在 `-p` 模式退出时偶发未捕获异常（`isSubagent` 读到失效的 ctx，`agentbrain-recall.ts:89`），进程退出码 1，回答不受影响。这个问题早已存在，不是本分支引入的。
4. 看板"标注率"表里只有未命中轮的会话显示为"模型 未知"行（cite_scan 只记有注入的会话）。

## 没做 / 待补
- Codex q07–q23（15:31 后可续跑：`python3 harness/run.py codex`，已完成的题会跳过）。
- `ab work` 抽取与锚点核对（13:58 后再跑）。
- 用户抽查标注。

## 2026-10-22 修复后重扫（ed29756）
- 新坑 1、2 已修：只调了工具的助手轮不算回答（`Turn.reply` 为空）；只剥离闭合的 `<agentbrain…>…</agentbrain…>`；引用扫描解析原始回复文字。
- 在同一个临时库上用修复后的代码跑 `ab view` 重扫已有 Pi 会话：q18 第一次失败那轮记为 failed，q11 的 ab-used 认出来了。Pi 看板标注率 19/19（命中 20，失败 1，已标注 19），引用 27 次。Codex 不变（6/6）。

## 2026-10-23 补跑 Codex q07–q23（4aaf121）
- 代码：临时克隆切到 `4aaf121`（加同一个隐藏 eval 产物的本地提交），库和 HOME 不变。
- Codex 23/23 完成：q07–q20 在 10-23 上午跑完；q21 起额度再次用尽，12:25 SGT 前后又遇到 401（`Missing bearer`，auth.json 当时失效，14:45 重新登录后正常），runner 放弃 q21–q23；16:17 重新启动后 q21–q23 一次通过。
- 扫描：跑一次 `ab view` 重扫，52 个会话，记到 51 次引用，丢弃 0 个 id。

| | 有召回的轮 | 模型写了 ab-used | 精确率（模型行） | 召回率（模型行） | 没召回却标 | 看板标注率 |
|---|---|---|---|---|---|---|
| Pi deepseek-v4.1-flash（不变） | 19 | 19/19 | 26/27 | 26/27（另 1 条说不清） | 0/4 | 19/19 |
| Codex gpt-5.6-sol | 19 | 18/19 | 24/24 | 24/24（另 1 条说不清） | 0/4 | 18/21 = 86% |

- Codex 唯一没写 ab-used 的 q15：注入的 090a4f27（cli.test.ts 的 AB_HOME 隔离）和问题（macOS `/var` 软链）无关，回答也没用它，不标是对的。
- 说不清 1：q10 注入 8afca8b7（向量误报率、0.45/0.55 门槛），回答提到"不是简单把 minSim 改成 0.55 就等价"，可能受它影响，没标。
- q09 没标 0246839d（hook try/catch）是对的：回答只顺带说"try/catch 救不了仍在等待的操作"。Pi 在同一题标了它，判为误标。
- 标注由执行代理逐条判定，未经用户抽查。

### 新坑 5：Codex 只输出了进度消息就失败的轮不会被标 failed
- 看板 Codex 分母是 21 而不是 19：额度失败的两次会话（10-22 15:48 的 q10 第一次、10-23 11:25 的 q21 第一次）里，Codex 在失败前已经发出"我先核对…"这类进度 `agent_message`，`markFailedTurns` 把它当成已回答，这两轮记为"命中、没标"。另外 11 次失败会话都正确标了 failed。
- 建议：Codex 只认 `phase=final_answer`（或 `task_complete` 带 `last_agent_message`）的助手文字算回答；进度消息不算。不影响默认关闭的 cite，阻塞级别低。

### 抽取 `ab work`
- 10-23 16:27 SGT：快照 `inject_log` / `cite_scan` / `recall_runs`，把 24 个 `failed/http_429`（attempts=4）窗口重置成 `deferred`、attempts=0，再跑 `ab work`：37 个窗口全部再次 429 延后，0 个候选。ark 的 deepseek-v4.1-flash 额度仍然用尽（真实库也从 10-23 11:29 SGT 起一直 429）。
- `ab work` 前后三张遥测表逐行相同（`cmp`），没被改动。抽取后锚点是否完好**仍未验证**（没抽成）。

## 仍待补
- 抽取额度恢复后在本库重跑 `ab work`，核对锚点和遥测。
- 用户抽查标注。
- 新坑 5 的修复。
