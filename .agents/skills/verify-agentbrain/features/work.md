# ab work (后台自动抽取与代码核验)

## Sub-features
- 会话捕获与坐标登记 (`ab capture --hook`)，登记会话坐标与定位点，SessionEnd 异步拉起后台抽取
- 会话静置与结束抽取：基于 LLM（DashScope `qwen-plus`）提取候选命题，引文逐字核对，两次脱敏
- 代码只读核验与转正 (`ab work --sweep`)：只读检查代码仓库，验证未确认的坑与事实是否属实，对得上则自动转正
- 话题模式与断点续抽 (`ab work --session ... [--redo]`, `ab work --runs`, `ab work --undo`)
- 额度限流自恢复：抽取、embedding、代码核验撞上 429/quota/rate limit 按 Retry-After 延后，不算失败尝试，额度恢复后接着做；单会话 hook 拉起的 `ab work` 顺带重试别的会话已到期的延后窗口
- 模型产出留痕（§8.10）：普通抽取、一步式话题、重复追加证据、关系判定、代码核验写下的 L1 事件都带 `model` 与 `prompt_version`（实发系统提示词全文的 SHA-256 前 12 位），`ab get` 按事件逐条列出
- 转正只有三条路：用户 confirm / 代码核验 / 跨会话印证；跨会话印证要求两个以上会话各自有用户原话，关系未判定（`[关系未判定]`）或带冲突、待确认纠正、替代关系的条目不转正

## How to get to it (user POV)
- 系统守护进程（如 launchd `agentbrain.work`）或宿主 SessionEnd 事件在后台自动调用 `ab work`
- 用户可手动运行 `ab work --sweep` 核验待定记忆，或通过 `ab work --dry-run` 预览积压情况

## Driving it with verify.sh
- `env AB_HOME="$AB_HOME" AGENTBRAIN_HOME="$AB_HOME" node src/cli.ts work --dry-run`
- `env AB_HOME="$AB_HOME" AGENTBRAIN_HOME="$AB_HOME" node src/cli.ts work --session opencode:ses_verify1 --dry-run`（verify.sh 里 `cli-opencode-work`）
- Proof: 退出码 0，打印当前待处理会话与窗口积压量，不调用远程 LLM API，不产生模型费用

## Gotchas
- 会话一律写成 `host:<session_id>`，首个冒号之后整段都算 session id（子代理 id 带冒号也能用）；`capture` / `work --session` / `remember --from-worker` 各自的报错文案不同，都不接受未知宿主或空 id
- 真实的抽取沉淀和代码核验依赖远程大模型 API key（`~/.agentbrain/extract.json`）
- 本地无真实 key 时真实模型调用受限，通过 `--dry-run` 验证调度与积压扫描逻辑；429 延后与续做只能用单元测试覆盖，真实额度恢复未在本技能里跑
- 自动抽取和 agent 自记都直接写成有效的未确认条目（不再进候选区），代码核验转正或用户 confirm 才变已确认
- 模型产出段与版本口径只用单测覆盖（`src/prompt-version.test.ts` 用假 chat 跑真实的 `runWork` / `importPensieve` / `applyActions`，再调真实 `ab get`）。`ab work --dry-run` 不调模型，驱动不出这段，要看真实输出用 `ab get`
- `ab curate --apply` 改写的条目本次不带 `model` / `prompt_version`，`ab get` 显示「未记录」，属已知范围例外（§8.10）
- `extract.json` 可加 `extraBody`（对象，如 `{"reasoning_effort":"medium"}`）原样带进 chat 请求；写了非对象时 `ab status` / `ab doctor` 的「抽取模型」行显示「不可用（…/extract.json 的 extraBody 必须是对象）」
- 抽取请求不设超时（用户 2026-10-30）：租约过期由别的进程接管，写库前复核租约，不会重复写；因此挂住的 `ab work` 不会自己退，靠租约接管——这条只能在真实模型调用里观察，本技能不跑
- 话题一步式的 `prompt_version` 改成只 hash 实发的系统提示词（worker 说明在 user 消息里，不再混进 hash）；旧 `topic.prompt_version` 保留原口径，不回填
