# ab view (记忆看板)

## Sub-features
- 生成自包含 HTML 记忆看板 (`ab view [--out <路径>] [--no-open]`)，默认 `~/.agentbrain/view.html`，权限 0600
- 概览、关联图、记忆详情、注入/引用统计与记忆可见性指标；数据嵌在 HTML 里，离线可开
- 记忆可见性卡片（§11.9）：展示上次扫描时间、报告率、采用率、主动查询率与无法核对数
- 引用扫描：只结算宿主的最终回答（Claude `end_turn`、Pi `stopReason=stop`、Codex `final_answer` / 无错误 `task_complete`、opencode 已完成无错），进度、工具继续、模型失败、仍在运行的轮不结算；读交付记录（brief / search / get / recall）与按轮采用报告，核对模型在回答末尾报告的记忆；未对上的保留并记为无法核对
- 查询事件单独记录：`memory_queries` 记 search / get 的宿主、会话、时间与来源路径，零结果搜索也记；主动查询率按查询事件算
- 扫描时机：除 `ab view` 外，`ab work --sweep` 定时任务结尾也会触发一次引用扫描

## How to get to it (user POV)
- 手动运行 `ab view`，自动用浏览器打开看板
- 无桌面或要留证据时用 `ab view --no-open --out <路径>`，只生成文件

## Driving it with verify.sh
- `env HOME="$FAKE_HOME" AB_HOME="$AB_HOME" AGENTBRAIN_HOME="$AB_HOME" AB_REGISTRY="$AB_REGISTRY" node src/cli.ts view --no-open --out "$EV/view.html"`
- Proof: 退出码 0，打印"已生成 … 共 N 条"；`view.html` 非空且含"agentbrain 记忆看板"

## Gotchas
- 看板只手动生成，后台不自动刷新 HTML 文件，但后台 `ab work --sweep` 会持续推进扫描数据
- 没有候选状态（§8.8）：旧版本写成候选的条目在看板里状态是"有效"、可信程度是"未确认"
- 引用统计覆盖 brief、search、get 与常驻偏好；不再仅限 recall 召回条目
- 引用结算的常驻偏好列表与 `guidanceBlock` 同口径：带场景标签（`scenes` 非空）的条目两边都跳过，它们不参与引用统计（2026-10-30 修复）
