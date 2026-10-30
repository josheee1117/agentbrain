# 详情正文、否掉的方案、原话（§8.11.2/§8.11.4/§8.11.5）

## Sub-features
- 详情正文 (`ab remember/correct ... --body-file <文件>`)，决定 / 事实 / 坑能带，规则不能；≤40000 字
- 否掉的方案 (`ab remember/correct ... --alternative "<方案>::<否掉的原因>"`，可重复)，只有决定能带，≤5 项
- `ab get` 显示顺序：text → why → 否掉的方案（每项附它引用的原话）→ 正文 → 全部原话（带角色和时间，没时间写"时间未知"）→ 归属/来源 → 关联与近邻
- `ab get --expand` 原对话不在时，先列库里存的原话，再说明原对话不可用
- `ab search` 前 8 条里带正文的条目显示正文前 300 字和 `ab get <id> 看全文`
- 写入口统一脱敏：text / why / body / alternatives 命中密钥时 CLI 报错退出 1，导入不写该字段并在报告里列出
- Pensieve 导入把 md 正文存成 body（不截断）；重导时旧条目缺 body 的追加 `detail` 事件补上，不换 id、不动确认状态/场景/关联

## How to get to it (user POV)
- 记录一条决定并带上详情：`ab remember --kind decision --text ... --summary ... --body-file notes.md --alternative "旧方案::为什么不采用"`
- 事后补详情：Pensieve 重导（`ab import pensieve <仓库目录>`）
- 只看库里的内容还原背景：`ab get <id 前缀> [--expand]`

## Driving it with verify.sh
- `verify.sh run` 的 `cli-detail-*` 步骤：`--body-file`/`--alternative` 写入 → `ab get` 显示正文和否掉的方案 → `ab search` 正文提示 → 规则带正文被拒 → `correct` 不继承详情
- Proof: `cli-detail-get-body` / `cli-detail-get-alt` / `cli-detail-search-hint` / `cli-detail-rule-body` / `cli-detail-correct-nocopy-text` 全 pass

## 单测
- `src/store.test.ts`：投影（quote/said_at/body/alternatives/ExtraSource.evidence/旧数据缺省）、detail 补详情与不覆盖、入口校验（种类/长度/密钥/下标越界）、向量文本含 body
- `src/pensieve.test.ts`：md 正文映射成 body、代码块里的密钥不写 body 并进报告、重导只补 body 不换 id、源文件变了的照旧带 body
- `src/cli.test.ts`：remember/correct 参数、get 顺序与 `--expand` 原话回退、search 正文提示、抽取入口拒绝含密钥的条
- `src/review.test.ts`：带 body 或 alternatives 的条目跳过改写

## Gotchas
- body 只给决定 / 事实 / 坑：规则必须一行说清，`--body-file` 配 `--kind rule` 直接报错退出 1
- 手写没有原话可指，`--alternative` 的 evidence 缺省；抽取写入时 evidence 是本文 `evidence[]` 的下标，下标越界的项在写入口被丢掉，不丢整条
- `ab correct` 不继承旧条目的 body 和 alternatives（标题改了，详情照搬会自相矛盾），要沿用就显式重给；旧详情在旧条目的 `ab get` 里还在
- 带 body 或 alternatives 的未确认条目 `ab curate` 不改写，只记进报告，避免自动改写丢掉详情
- Pensieve 里被映射成规则的 maxim 不带 body（规则必须一行说清），所以它们的 md 正文不会进库
- 因密钥或超长没写进 body 的文档会列在导入报告里，这些仓库的 `.pensieve/` 不能删
