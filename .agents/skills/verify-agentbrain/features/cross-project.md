# 跨项目段（§8.11.4）

## Sub-features
- `ab search <关键词>` 在主会话和子代理里都多出一段「其他项目里相近的：」（用户 2026-10-30 选 A，§8.11.8）
- 只在已登记项目目录里出：pm 目录本来就搜全库，不出
- 给了 `--project` 或 `--all` 时不出
- `--scene` 列举模式不出（那是列举不是搜索，也不走混合检索）
- 取法：候选先限定为**其他项目**的 active 条目（不含本项目、不含全局），再按与查询向量的余弦排序，取 ≥0.65 的前 3 条
- 一行一条：`[短id] <项目名> <种类>: <标题>（相似度）`，最多 60 字截断
- 和主结果同一套交付记录：`inject_log` 里 `path='search'`，id 是跨项目段的条目
- 查询向量算不出（degraded）时不出这一段，降级提示里加一句「跨项目段也要算查询向量，这次没查」
- 其他项目还有没算向量的 active 条目时，段尾加一行「另有 N 条其他项目的记忆还没算向量，可能漏」

## How to get to it (user POV)
- 在某个项目里 `ab search <关键词>`，结果末尾自动出现别的项目里的相近决定和知识
- 用户不需要任何参数，主会话和子代理看到的是同一段

## Driving it with verify.sh
- `verify.sh run` 的 `cli-cross-*` 步骤：用假 embedding 接口造跨项目相似度 → 确认段出现、门槛和条数生效、交付记录写进去 → `--project` / `--all` / `--scene` / pm 目录都不出 → 没配 embedding 时不出且有说明
- Proof: `cli-cross-search` / `cli-cross-search-section` / `cli-cross-search-delivered` / `cli-cross-suppressed` / `cli-cross-degraded` 全 pass

## 单测
- `src/store.test.ts`：门槛 0.65 与最多 3 条、先限定再排序（本项目占满全库 top-N 时其他项目照样出）、本项目/全局/归档不进候选、degraded 不出且 pending 单报
- `src/cli.test.ts`：段的位置和行格式、交付记录、四种不该出的场景、degraded 说明、pending 提示

## Gotchas
- `searchHybrid` 在 pending 时仍返回 `degraded=null`，所以跨项目段自己数 pending（`CrossProjectResult.pending`），不靠 degraded 判断
- `--kind` 同样限定跨项目段，否则 `ab search --kind note` 会混进出决定
- 段在「更多（第 9–16 名）」和降级提示之间输出；主结果的 limit 和这一段的 3 条互不影响
- 阈值 0.65（由 `docs/eval/21-cross-project-threshold.md` 定下）写成常量 `CROSS_PROJECT_MIN_SIM`，不加配置键
