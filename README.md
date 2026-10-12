# agentbrain

以 abrain 为架构母体的本地 Agent 记忆系统：结构性沉淀（sediment）+ L1 证据历史 → L2 确定性投影 → L3 可重建索引 + 分层读取 + Agent Loadout/子代理委派。

- 宿主：Pi、Claude Code、Codex 平等接入，任一都可作为主体会话；统一入口是 `ab` 命令行，会话靠全局规则文件里的一句指令或主会话的派活说明调用它，不给宿主装插件
- 记忆分全局与项目两级；项目清单以 pm 的 `repos/*.md` 为准
- 产品前提：宿主无关的个人 Agent 记忆；先把记忆本身做好，首个替代对象是 Pensieve；动机首先是所有权，其次是复杂度
- 代码 clean-room 自写；abrain 的 ADR、架构文档与源码当规格读，不作代码抄
- 核心来源：pi-astack 的 abrain/sediment（event-first、统一 proposition、单 writer、确定性投影、自治纠错）
- 对照来源：TencentDB Agent Memory（选择性吸收 Loadout、capture 调度、provenance、显式降级等机制，不复制团队 Memory Hub）

**当前状态：v2.6 宿主无关基线。切片 1（显式记忆 + 搜索 + 来源展开 + Brief）已在 Pi 上实现；切片 1.5（宿主无关化）2026-10-10 已实现；切片 2（纠正、混合检索、每轮召回、冲突暴露、近邻）2026-10-10 代码完成，三宿主接线见 `integrations/`，2026-10-12 已在用户机器接入，Claude Code 模型侧待复验；后续切片按 §18 逐个授权。**

- 总体设计：[docs/design/20260804-agentbrain-总体设计.md](docs/design/20260804-agentbrain-总体设计.md)
- 领域词汇：[CONTEXT.md](CONTEXT.md)
- Wayfinder 地图：[以 abrain 为母体的 agentbrain v2 路线](https://github.com/josheee1117/agentbrain/issues/1)
