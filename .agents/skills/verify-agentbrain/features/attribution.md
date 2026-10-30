# 归属显示（§8.11.3 第 4 条）

## Sub-features
- 抽取把候选归到**会话项目**时（项目清单里点名的那个）：`ab get` 多一行「归属: 会话在 X，抽取判定归属 Y」
- 归属没确认（名字未登记、指向别的项目却没给 `project_anchor`、anchor 轮里找不到名字/路径）：条目留在会话项目，带 `value.flags=["project_unresolved"]`
- `project_unresolved` 的条目在三处都标「[归属未定]」：`ab search` 结果行、`ab search` 的跨项目段、`ab get` 标题行
- `ab get` 对归属未定再写一行「归属: 会话在 X，抽取没能确认归属（这条暂记在会话项目）」

## How to get to it (user POV)
- 在 pm 里讨论别的仓库的事，抽取判到那个仓库：`ab get <id>` 显示会话在哪个项目、被判到哪个项目
- 抽取拿不准归属时，条目留在会话项目但明确标「[归属未定]」，不会被当成会话项目的既有事实

## Driving it with verify.sh
- `verify.sh run` 的 `cli-attr-*` 步骤：用真 store 写两条（一条 `project_unresolved`、一条 `session_project` 跨项目）→ `ab search` 结果行和 `ab get` 标归属未定 → 跨项目归属的 `ab get` 显示归属行
- Proof: `cli-attr-search` / `cli-attr-get-unresolved` / `cli-attr-get-cross` 全 pass

## 单测
- `src/extract.test.ts`：成功归到别的项目时 `value.session_project` 记会话项目；退回会话项目、本来同项目的不记
- `src/work.test.ts`：跨项目归属落进 L1 时 `value.session_project` 是会话项目
- `src/cli.test.ts`：三处「[归属未定]」标记、`ab get` 的两行归属说明、同项目不显示归属行

## Gotchas
- 会话项目和最终项目相同时不显示归属行：那条没有歧义，多一行只是噪音
- 标记读 `p.value.flags`，不看 `project_id`：归属未定的条目 `project_id` 就是会话项目，只能靠 flag 区分
- 模型没写 `project` 字段是「缺省记到会话项目」，不算归属未定；只有写了名字但没登记才标
