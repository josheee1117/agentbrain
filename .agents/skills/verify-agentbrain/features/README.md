# agentbrain feature map

| Feature | File | 说明 |
|---|---|---|
| status / doctor | [status.md](status.md) | 数据库状态摘要、宿主与接线诊断、状态栏单行指标 |
| brief | [brief.md](brief.md) | 开工背景速览、全局规则与当前项目坑注入（含子代理 --worker 模式） |
| scene | [scene.md](scene.md) | 规则场景标签（设计/开发/review）、brief 按场景加载与 search --scene 列举 |
| remember / search / get / correct | [memory.md](memory.md) | 显式记忆记录、纠正替代、混合检索与详情关联查看 |
| 详情正文与原话 | [detail.md](detail.md) | 决定/事实/坑的详情正文、否掉的方案、`ab get` 原话显示、含 Pensieve 重导补正文 |
| 跨项目段 | [cross-project.md](cross-project.md) | 项目目录里搜索时，末尾带出其他项目里相近的条目（阈值 0.6、最多 3 条） |
| 归属显示 | [attribution.md](attribution.md) | 抽取判到别的项目时 `ab get` 写清会话在哪；归属没确认的条目标「[归属未定]」 |
| recall-hook | [recall-hook.md](recall-hook.md) | 宿主每轮静默召回、上下文注入（Claude Code、Pi、Codex） |
| opencode-host | [opencode-host.md](opencode-host.md) | OpenCode 宿主接入、v2 插件召回、SQLite 会话捕获与子代理隔离 |
| work | [work.md](work.md) | 后台会话自动抽取、单实例租约调度、代码核验与转正 |
| curate / review | [curate.md](curate.md) | 未确认条目审稿建议、审稿回滚、worker 原话审计与到期复审；旧候选区条目只读对照 |
| view | [view.md](view.md) | 手动生成本地 HTML 记忆看板（概览、关联图、注入/引用统计） |
| hosts | [hosts.md](hosts.md) | 真实宿主隔离闭环：Claude Code / Codex / Pi / opencode 逐场景断言与正式库核对 |
