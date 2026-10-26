# ab work (后台自动抽取与代码核验)

## Sub-features
- 会话捕获与坐标登记 (`ab capture --hook`)，登记会话坐标与定位点，SessionEnd 异步拉起后台抽取
- 会话静置与结束抽取：基于 LLM（DashScope `qwen-plus`）提取候选命题，引文逐字核对，两次脱敏
- 代码只读核验与转正 (`ab work --sweep`)：只读检查代码仓库，验证未确认的坑与事实是否属实，对得上则自动转正
- 话题模式与断点续抽 (`ab work --session ... [--redo]`, `ab work --runs`, `ab work --undo`)
- 额度限流自恢复：抽取、embedding、代码核验撞上 429/quota/rate limit 按 Retry-After 延后，不算失败尝试，额度恢复后接着做；单会话 hook 拉起的 `ab work` 顺带重试别的会话已到期的延后窗口

## How to get to it (user POV)
- 系统守护进程（如 launchd `agentbrain.work`）或宿主 SessionEnd 事件在后台自动调用 `ab work`
- 用户可手动运行 `ab work --sweep` 核验待定记忆，或通过 `ab work --dry-run` 预览积压情况

## Driving it with verify.sh
- `env AB_HOME="$AB_HOME" AGENTBRAIN_HOME="$AB_HOME" node src/cli.ts work --dry-run`
- Proof: 退出码 0，打印当前待处理会话与窗口积压量，不调用远程 LLM API，不产生模型费用

## Gotchas
- 真实的抽取沉淀和代码核验依赖远程大模型 API key（`~/.agentbrain/extract.json`）
- 本地无真实 key 时真实模型调用受限，通过 `--dry-run` 验证调度与积压扫描逻辑；429 延后与续做只能用单元测试覆盖，真实额度恢复未在本技能里跑
- 自动抽取和 agent 自记都直接写成有效的未确认条目（不再进候选区），代码核验转正或用户 confirm 才变已确认
