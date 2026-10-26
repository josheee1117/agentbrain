# agentbrain feature map

| Feature | File | 说明 |
|---|---|---|
| status / doctor | [status.md](status.md) | 数据库状态摘要、宿主与接线诊断、状态栏单行指标 |
| brief | [brief.md](brief.md) | 开工背景速览、全局规则与当前项目坑注入（含子代理 --worker 模式） |
| remember / search / get / correct | [memory.md](memory.md) | 显式记忆记录、纠正替代、混合检索与详情关联查看 |
| recall-hook | [recall-hook.md](recall-hook.md) | 宿主每轮静默召回、上下文注入（Claude Code、Pi、Codex） |
| opencode-host | [opencode-host.md](opencode-host.md) | OpenCode 宿主接入、v2 插件召回、SQLite 会话捕获与子代理隔离 |
| work | [work.md](work.md) | 后台会话自动抽取、单实例租约调度、代码核验与转正 |
| curate / review | [curate.md](curate.md) | 未确认条目审稿建议、审稿回滚、worker 原话审计与到期复审；旧候选区条目只读对照 |
| view | [view.md](view.md) | 手动生成本地 HTML 记忆看板（概览、关联图、注入/引用统计） |
