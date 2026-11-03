# AGENTS.md

## 项目定位

agentbrain：以 abrain 为架构母体的本地 Agent 记忆系统。Pi、Claude Code、Codex、opencode 四个宿主平等接入（统一入口 `ab` 命令行；记忆分全局与项目两级，项目清单以 pm 的 `repos/*.md` 为准），核心是结构性沉淀、统一 proposition、L1 证据历史→L2 确定性投影→L3 可重建索引、分层读取、Agent Loadout 与子代理委派。TencentDB Agent Memory 只作为机制对照，不定义产品边界。

**产品前提：宿主无关的个人 Agent 记忆（设计 §2.1，v2.5）。** 先把记忆本身做好，首个替代对象是 Pensieve；是否接管 pm 的非记忆职责等记忆核心成熟后再定。动机**首先是所有权脱钩**，其次是复杂度；"更好"是复合判据——脱钩 + 复杂度可量化下降（设计 §2.2：配置键 162→≤35、迁移期双写门 17→0，行数不作判据）。代码 clean-room 自写，abrain 只当规格读（§12.5）。

当前进度看 `/Users/hejiayuan/code_me/pm/repos/agentbrain.md`，产品语义以设计文档 `docs/design/20260804-agentbrain-总体设计.md` 为准。

## 约定

- 物理形态（设计 §12.2 已裁决）：`~/.agentbrain/store.db`（L1 + work store）+ `index.db`（FTS5，可删重建）；不透明 event_id + 自增定序；L2 是 L1 上的纯函数投影，不落盘；来源只存 Source Pointer，不存摘录。
- 设计/技术文档：文件名带 YYYYMMDD 日期；每主题只留一份最新文档，原地覆盖修订，变更摘要写进文档内"修订记录"，不靠多文件保历史。
- 新决策：先记入设计文档"修订记录"（含理由）；与已有决策冲突时停下问用户。
- 非平凡改动实现前必须先更新设计文档并获用户明确授权（"开始实现"/"按这个做"）。
- 范围纪律：不加任务外功能/抽象/防御分支；v2 正式范围、seam 与 out-of-scope 见设计 §4/§20，不要把 Design Gate 当作实现者自由选项。
- 复杂度纪律（§2.2）：预算类参数（超时、重试、批大小）默认写死在代码里，不新增配置键；确需按机器或阶段调整的才留成配置。任何"迁移期双写门"形态的开关都不得引入。
- 参考实现在 `~/code_me/pi-astack/extensions/{abrain,sediment,memory,_shared}`（只读参考，勿改动）。

## 写测试和验证

- 离线 CLI 测试同时用临时 `AB_HOME`、`AB_REGISTRY`、`HOME`，临时目录先 `realpath`：抄 `src/capture.test.ts:15-18`。只设 `AB_HOME` 不够，会话定位和 sweep 读 HOME（`src/host.ts:107-110`、`src/work.ts:223`）。
- 真实宿主测试要分别隔离 hook、shell 命令和会话目录，包括只想探参数的预检命令，不能只靠外层环境变量：抄 `.agents/skills/verify-agentbrain/hosts.ts:75-103`。`hostEnv` 本身不隔离 HOME。
- 测试走真实生产函数，假模型只放在边界：抄 `src/prompt-version.test.ts:49`（假 chat 跑真实 `runWork`）。接线样例要真跑：抄 `src/cli.test.ts:532`。
- 断言真实输出或数据库变化，不能只看退出码：hook 内的异常会被静默吞掉。
- worktree 里用该目录的 `node <worktree>/src/cli.ts`，`~/.local/bin/ab` 不跟 worktree 走。
- 派活单和隔离约束冲突时先停下核对，不要绕过。

## 本地验证技能 / Local verification skill

- 本仓库有一个验证技能（随仓库提交）：`.agents/skills/verify-agentbrain/SKILL.md`，功能地图在 `.agents/skills/verify-agentbrain/features/README.md`，控制脚本 `.agents/skills/verify-agentbrain/verify.sh doctor|run|cleanup`。
- 适用工具：Codex 与 Pi（pstack-pi）直接读取 `.agents/skills/verify-agentbrain/`；Claude Code 通过软链接 `.claude/skills/verify-agentbrain` 读取同一份文件。`/maintain-verification-skill` 由 pstack-pi 提供。
- 任何 agent 改完代码，必须先按该技能验证并给出证据（`~/.cache/verify-evidence/agentbrain/`），才能说完成。
- 每个工作日应跑一次维护：`/maintain-verification-skill`（没有该命令时：对照最近提交，更新功能地图和 SKILL.md 中过期的命令/入口，再完整跑一遍 `verify.sh run`），让功能地图跟代码保持一致。
- 这些文件随仓库提交，所有 agent 都能读到。
- This repo has a verification skill (tracked in git) at `.agents/skills/verify-agentbrain/SKILL.md` with a feature map at `.agents/skills/verify-agentbrain/features/README.md`. Any agent must use it to verify changes (with evidence) before calling them done. A weekday daily maintenance pass should run `/maintain-verification-skill` (or, without it: diff recent commits, update stale feature-map entries/commands, then re-run `verify.sh run`) to keep the map in sync with code. These files are tracked in git so every agent can read them. Tools: Codex and Pi (pstack-pi) read `.agents/skills/verify-agentbrain/` directly; Claude Code reads it via the symlink `.claude/skills/verify-agentbrain`. `/maintain-verification-skill` comes from pstack-pi.
