# agentbrain feature map

| Feature | File | 说明 |
|---|---|---|
| status / doctor | [status.md](status.md) | 数据库状态摘要、宿主与接线诊断、状态栏单行指标 |
| brief | [brief.md](brief.md) | 开工背景速览、全局规则与当前项目坑注入（含子代理 --worker 模式） |
| inbox | [inbox.md](inbox.md) | 待用户确认高信号清单 `ab inbox`（5 类优先级、`--noise` 低引用规则扫描、只读零写入）与主会话 `ab brief` 前 5 条展开 |
| scene | [scene.md](scene.md) | 规则四场景标签（`design`/`code`/`test`/`review`）、专属性优先 `≤8` 条路由 + 按需触发器、`--on-demand` 与 `search --scene` 列举 |
| remember / search / get / correct | [memory.md](memory.md) | 显式记忆记录、纠正替代、混合检索与详情关联查看、模型产出记录（模型与提示词版本） |
| stale 护栏与草稿退场 | [stale-guard.md](stale-guard.md) | 按确认来源停注或警告，confirm 清 stale，单条 verify 只读 ref，未确认 extract 草稿可逆退场 |
| 变更驱动重核 | [change-verify.md](change-verify.md) | 只读主干扫描、非祖先三分支、机械预筛、20 条入队上限、持租约同步消费和默认关闭的每日扫描 |
| 锚点、决定核验与存量补锚点 | [anchors-decisions.md](anchors-decisions.md) | `anchors`/`anchor_head`、`--anchor`、跨仓锚点匹配与入队消费、决定首次核验不转正、离线补锚点脚本 |
| 需求收口综合沉淀 | [synthesize.md](synthesize.md) | `ab synthesize` 结合 `--spec` 与 diff 提炼 ≤3 条带锚点未确认决定、`--dry-run` 零写库与草稿清理提示 |
| 冲突显示与处理 | [conflicts.md](conflicts.md) | 冲突按对双向显示，与待确认纠正分开；`ab relate --coexist\|--refines` 解除互补误报冲突；status 报对数、最老天数和期间注入次数；归档与恢复闭环 |
| 详情正文与原话 | [detail.md](detail.md) | 决定/事实/坑的详情正文、否掉的方案、`ab get` 原话显示、含 Pensieve 重导补正文 |
| 跨项目段 | [cross-project.md](cross-project.md) | 项目目录里搜索时，末尾带出其他项目里相近的条目（阈值 0.65、最多 3 条） |
| 归属显示 | [attribution.md](attribution.md) | 抽取判到别的项目时 `ab get` 写清会话在哪；归属没确认的条目标「[归属未定]」 |
| recall-hook | [recall-hook.md](recall-hook.md) | 宿主每轮静默召回、上下文注入（Claude Code、Pi、Codex） |
| opencode-host | [opencode-host.md](opencode-host.md) | OpenCode 宿主接入、v2 插件召回、SQLite 会话捕获与子代理隔离 |
| agy-host | [agy-host.md](agy-host.md) | Antigravity 宿主三处接入（CLI、IDE、T3 动态实例）：完整日志发现与 sweep、摘要副本只读、冲突跳过、去噪与分处诊断（含插件状态） |
| work | [work.md](work.md) | 后台会话自动抽取、单实例租约调度、代码核验与转正、跨会话印证、模型产出留痕；Codex 压缩会话 `.jsonl.zst` 读时解析（§7.6） |
| curate / review | [curate.md](curate.md) | 未确认条目审稿建议、审稿回滚、worker 原话审计与到期复审；旧候选区条目只读对照 |
| view | [view.md](view.md) | 手动生成本地 HTML 记忆看板（概览、关联图、注入/引用统计） |
| purge / backup / restore | [admin.md](admin.md) | 清除一个会话（只能由人在终端发起，逐面报告）、备份与恢复、库版本号与只读保护、操作者和机器、文件权限 |
| team | [team.md](team.md) | 真实宿主一轮四步：Pi / Codex / Claude Code 各跑一轮，正式库副本，逐项断言与正式库核对 |
| hosts | [hosts.md](hosts.md) | 真实宿主隔离闭环：Claude Code / Codex / Pi / opencode 逐场景断言与正式库核对 |
