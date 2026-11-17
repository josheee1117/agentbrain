# ab work (后台自动抽取与代码核验)

## Sub-features
- 会话捕获与坐标登记 (`ab capture --hook`)，登记会话坐标与定位点，SessionEnd 异步拉起后台抽取
- Codex 压缩会话读时解析（§7.6）：`.jsonl.zst` 读取时解压、不迁移数据，解压前先查完整性（Node 对截断帧不报错），每次读都过准入
- 会话静置与结束抽取：基于 LLM（DashScope `qwen-plus`）提取候选命题，引文逐字核对，两次脱敏
- 代码只读核验与转正 (`ab work --sweep`)：只读检查代码仓库，验证未确认的坑与事实是否属实，对得上则自动转正
- 话题模式与断点续抽 (`ab work --session ... [--redo]`, `ab work --runs`, `ab work --undo`)
- 额度限流自恢复：抽取、embedding、代码核验撞上 429/quota/rate limit 按 Retry-After 延后，不算失败尝试，额度恢复后接着做。单次延后最多 1 小时，历史上被写成几天后的 429 行也按延后满 1 小时算到期。单会话 hook 拉起的 `ab work` 顺带重试别的会话已到期的延后窗口
- 过期延后行退出：进度已越过 `to_anchor` 的 deferred 行标 `failed` / `superseded`（不删，到期由 prune 清）。清理在短写事务里复核租约并重读当前进度，旧进程被接管后恢复时不会误标别人的正常排队行；它不算抽取失败（`report.windows.failed`、`ab status` 的「失败」与 `status --line` 的 `work_failed` 都排除 `error_code='superseded'`，但「未完成原因」照常列出）。Codex 换了 transcript 文件、旧数字进度不在新文件里、且新文件第一轮 ordinal 更大时，从第一轮接着切，窗口 `from` 仍是旧进度
- 换文件后的重放不重记证据：用户编辑 Codex 旧消息也会换文件，新文件首轮会把已抽过的原话再送一遍。给已有条目追加来源时，同宿主同会话里 `quote_sha256` 已经记过的证据跳过；整条来源都跳掉就不写事件。跨会话同原话照常追加（那是印证，有意义）
- 话题模式的 `topic_cooldown:<host>` 判到期不查库：新版本写入已按 `MAX_DEFER_MS` 封顶一小时，截止时间比「现在 + 一小时」还远的只可能是旧版本未封顶的原值，按到期处理（`src/intake.ts` 的 `cooldownDue`）。不再按同宿主任意 429 行的 `MAX(updated_at)` 重新起算，别的会话的 429 挡不住已到期的历史冷却
- 模型产出留痕（§8.10）：普通抽取、一步式话题、重复追加证据、关系判定、代码核验写下的 L1 事件都带 `model` 与 `prompt_version`（实发系统提示词全文的 SHA-256 前 12 位），`ab get` 按事件逐条列出
- 转正只有三条路：用户 confirm / 代码核验 / 跨会话印证；跨会话印证要求两个以上会话各自有用户原话，关系未判定（`[关系未判定]`）或带冲突、待确认纠正、替代关系的条目不转正

- 失败原因存库（§12.6.6）：`capture_windows.error_detail` 是 HTTP 状态码加脱敏后的上游报错；`ab work` 输出末尾有「出错明细」
- 钩子拉起的 `ab work --session` 输出追加到 `<AB_HOME>/work.log`（超过 5 MB 轮转一份）
- 窗口用完重试次数时，多于一轮且超过 8000 字就对半拆开重试（原窗口记 `failed/split`，不算失败）；401/403 和没配密钥一样延后不计次数

## How to get to it (user POV)
- 系统守护进程（如 launchd `agentbrain.work`）或宿主 SessionEnd 事件在后台自动调用 `ab work`
- 用户可手动运行 `ab work --sweep` 核验待定记忆，或通过 `ab work --dry-run` 预览积压情况

## Driving it with verify.sh
- `env AB_HOME="$AB_HOME" AGENTBRAIN_HOME="$AB_HOME" node src/cli.ts work --dry-run`
- `env AB_HOME="$AB_HOME" AGENTBRAIN_HOME="$AB_HOME" node src/cli.ts work --session opencode:ses_verify1 --dry-run`（verify.sh 里 `cli-opencode-work`）
- 压缩会话：隔离 HOME 放 `~/.codex/sessions/…/rollout-…-<id>.jsonl.zst`，`capture --hook --host codex` 不带 transcript 也能登记，`work --session codex:<id> --dry-run` 报出待处理窗口（verify.sh 里 `cli-codex-zst-capture`、`cli-codex-zst-work`，读时解压、不开盘缓存）
- Proof: 退出码 0，打印当前待处理会话与窗口积压量，不调用远程 LLM API，不产生模型费用

## Gotchas
- 会话一律写成 `host:<session_id>`，首个冒号之后整段都算 session id（子代理 id 带冒号也能用）；`capture` / `work --session` / `remember --from-worker` 各自的报错文案不同，都不接受未知宿主或空 id
- 真实的抽取沉淀和代码核验依赖远程大模型 API key（`~/.agentbrain/extract.json`）
- 本地无真实 key 时真实模型调用受限，通过 `--dry-run` 验证调度与积压扫描逻辑。429 封顶、被越过的延后行退出、Codex 换文件后续切，都用 `src/work.test.ts` 覆盖。真实额度恢复未在本技能里跑
- 自动抽取和 agent 自记都直接写成有效的未确认条目（不再进候选区），代码核验转正或用户 confirm 才变已确认
- `.jsonl.zst` 只在 Codex 会话目录里被放行（§7.6）；Claude、Pi 的压缩文件照旧拒绝。全文解压上限 256 MB；开头只读压缩文件前 256 KB，与全文共用 256 MB 解压上限，按字节截取。坏文件不阻断扫描，缺失文件报 source_unavailable，进度不动。`--dry-run` 不写库，处理和来源展开不改登记路径。回归测试在 `src/transcript-file.test.ts` 和 `src/work.test.ts`。
- 模型产出段与版本口径只用单测覆盖（`src/prompt-version.test.ts` 用假 chat 跑真实的 `runWork` / `importPensieve` / `applyActions`，再调真实 `ab get`）。`ab work --dry-run` 不调模型，驱动不出这段，要看真实输出用 `ab get`
- `ab curate --apply` 改写的条目本次不带 `model` / `prompt_version`，`ab get` 显示「未记录」，属已知范围例外（§8.10）
- `extract.json` 可加 `extraBody`（对象，如 `{"reasoning_effort":"medium"}`）原样带进 chat 请求；写了非对象时 `ab status` / `ab doctor` 的「抽取模型」行显示「不可用（…/extract.json 的 extraBody 必须是对象）」
- 抽取请求不设超时（用户 2026-10-30）：租约过期由别的进程接管，写库前复核租约，不会重复写；因此挂住的 `ab work` 不会自己退，靠租约接管——这条只能在真实模型调用里观察，本技能不跑
- 话题一步式的 `prompt_version` 改成只 hash 实发的系统提示词（worker 说明在 user 消息里，不再混进 hash）；旧 `topic.prompt_version` 保留原口径，不回填
- `superseded` 只是窗口的 `error_code` 取值，没有新的窗口状态、事件类型或配置键；`WindowErrorCode` 类型把它和 `WorkError` 分开，状态栏统计靠 `error_code!='superseded'` 排除
- 重放去重的边界就三条：同一条目、同宿主同会话、同 `quote_sha256`。不解析 Codex 的 `history_base` / `edit_user_message`，`codexContinues` 的判定没改（只看首轮 ordinal 是否更大），去重放在 `admit` 里
