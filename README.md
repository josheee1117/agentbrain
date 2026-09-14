# agentbrain

以 abrain 为架构母体的本地 Agent 记忆系统：结构性沉淀（sediment）+ L1 证据历史 → L2 确定性投影 → L3 可重建索引 + 分层读取 + Agent Loadout/子代理委派。

- 首发宿主：Pi；v2 不承诺 Claude Code、Codex 或 dsh
- 产品前提：在 Pi 上**取代** abrain 现役实现，不长期并存；动机首先是所有权脱钩，其次是复杂度
- 代码 clean-room 自写；abrain 的 ADR、架构文档与源码当规格读，不作代码抄
- 核心来源：pi-astack 的 abrain/sediment（event-first、统一 proposition、单 writer、确定性投影、自治纠错）
- 对照来源：TencentDB Agent Memory（选择性吸收 Loadout、capture 调度、provenance、显式降级等机制，不复制团队 Memory Hub）

**当前状态：v2.4 场景基线，切片 1（显式记忆 + 搜索 + 来源展开 + Brief）实施中；后续切片按 §18 逐个授权。**

- 总体设计：[docs/design/20260804-agentbrain-总体设计.md](docs/design/20260804-agentbrain-总体设计.md)
- 领域词汇：[CONTEXT.md](CONTEXT.md)
- Wayfinder 地图：[以 abrain 为母体的 agentbrain v2 路线](https://github.com/josheee1117/agentbrain/issues/1)
