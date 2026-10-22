# opencode 宿主支持

## Sub-features
- OpenCode v2 插件召回 (`integrations/opencode/agentbrain-v2.js`)，通过 context 钩子自动触发 `ab recall --hook` 并注入系统提示
- OpenCode 会话坐标捕获 (`ab capture --hook --host opencode`)，从 OpenCode 本地 SQLite 数据库 (`~/.local/share/opencode/opencode.db`) 关联 `session_v2` 与 `session_message`
- 会话生命周期与边界识别：处理 UserPromptSubmit、PreCompact 话题压缩切分以及 SessionEnd 归档事件
- 派生与子代理隔离：通过 `OPENCODE_SESSION_ID` 环境变量传递会话身份，子代理会话标记为 ephemeral

## How to get to it (user POV)
- 在 OpenCode 编辑器或 CLI 中载入 `agentbrain-v2.js` 插件后，在对话中自动召回记忆，并在会话归档或压缩时自动触发沉淀

## Driving it with verify.sh
- `printf '{"session_id":"ses_verify1","transcript_path":"opencode://session/ses_verify1","cwd":"%s","hook_event_name":"UserPromptSubmit"}\n' "$REPO" | env HOME="$FAKE_HOME" AB_HOME="$AB_HOME" AGENTBRAIN_HOME="$AB_HOME" AB_REGISTRY="$AB_REGISTRY" node src/cli.ts capture --hook --host opencode`
- `env HOME="$FAKE_HOME" AB_HOME="$AB_HOME" AGENTBRAIN_HOME="$AB_HOME" AB_REGISTRY="$AB_REGISTRY" node src/cli.ts work --session opencode:ses_verify1 --dry-run`
- Proof: capture 退出码 0，work store 中成功登记会话坐标，`work --dry-run` 正确识别会话及待处理字符

## Gotchas
- OpenCode 数据库路径硬编码为 `$HOME/.local/share/opencode/opencode.db`，且严格拒绝非规范路径和符号链接
- 隔离驱动时需通过覆盖 `HOME` 环境变量将 OpenCode SQLite 库引导至临时隔离目录
