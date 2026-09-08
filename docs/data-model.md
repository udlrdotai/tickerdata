# 数据模型 3.0.0

## 证券，不是公司

`id` 使用本项目分配的 `ins-*` 稳定内部 ID；初始序号与网页新增 UUID 都不是 ISIN、FIGI 等官方标识。裸 ticker 不作永久全球 ID。改名通常保留 ID；新证券是否需要新 ID 必须人工判断。

`symbol.original` 保留输入形式，`canonical` 是本项目选定的规范形式，`mic` 是上市市场的四位 MIC（不确定则空）。规范化只去首尾空白和大写。`aliases` 每项包含 `provider` 和 `symbol`，如 Yahoo 的 `BRK-B` 对应本项目的 `BRK.B`；不全局替换 `.`，避免损坏 `0700.HK`。

若原始符号也是某个显式供应商别名，索引不会再把它作为无 provider 的通用原始符号。不同 provider 的同名别名可以并存；同 provider、同 MIC、同别名指向多个非 inactive 证券会报冲突。不同 MIC 可重名，查询时可能歧义。

`symbol.history` 保存历史符号、原 MIC、可空的 `valid_from` / `valid_to` 日期；它不是一套自动证券行动引擎。历史复用允许产生歧义，消费者不会擅自以日期或“最像”的名字挑一个。要复现历史分类，固定原来报告使用的 release，而不是从当前数据猜测。

`name.en` / `name.zh` 可空。`security_type` 为 `stock`、`etf`、`other`。同一公司的不同证券可共享可空的 `issuer.id`；`issuer.country` 为可空的两位国家 / 地区代码，只表示发行人，不代替 MIC。ARM、BABA、TSM 不受发行人国家筛选。

`listing_status` 为 `active`、`inactive` 或 `unknown`。抓取失败不能将它变成 `inactive`。`related_instrument_ids` 可显式关联前后证券，但不能自引用、悬空，已审核记录不能关联尚未发布的证券。不要通过删除记录处理历史。

## 标准行业与多选标签

`industry` 引用词表的 `system_id`、`sector_id`、`industry_group_id`、`industry_id`，均可空，依次表达体系、板块、行业组、行业。所有已填写节点必须属于选定体系，已知的上下级关系也必须一致；不能通过省略板块来绕过行业与行业组的关系检查。

`industry_systems[]` 含 `sectors`、`industry_groups`、`industries`。行业组通过 `sector_id` 关联板块；行业通过 `industry_group_id` 关联行业组，同时保留 `sector_id`，两条父级路径不能矛盾。已知部分层级时可只填写已知的证券字段，不要求虚构未知内容。

`financedatabase` 使用固定上游版本的 11 板块 → 24 行业组 → 69 行业，词表内组和行业的父级关系完整。它是上游对 GICS 的近似，不是官方 GICS。现有 `yahoo` 体系的 ID、显示名、别名及行业语义保留，`industry_groups` 为空、`industry_group_id` 为 null，不能静默解释成 FinanceDatabase 分类。完整明细、来源与个股疑点见 [行业分类](industry-classification.md)。

`classification` 只包含 `tag_ids` 和 `source_ids`。`tag_ids` 是去重后的标签 ID 数组，可选零个、一个或多个，已审核证券也可以没有标签。非空标签必须引用词表中的条目，并提供覆盖 `/classification` 的来源。不再单独维护主主题，也不要求用某个标签作为唯一分组。

行业描述业务所属；标签用于跨行业检索交易、研究方向或产品特征。标签非互斥，同一证券可以同时具有“人工智能”和“半导体/AI”等标签。下游统计不能把不同标签组的数量直接相加当作证券总数；需要互斥统计时应明确选定行业层级等规则，不能默认取第一个标签当主主题。ETF 继续使用独立属性，不套用公司行业。

词表条目都有稳定 `id`、`name_zh`、`description` 和 `aliases`。重命名只改显示名称；删除 / 合并后所有引用必须依然有效。语义明显变化时宜创建新 ID 并审阅迁移，不应偷换既有 ID 的含义。

## 字段级依据

每条 `sources` 包含：

| 字段 | 含义 |
| --- | --- |
| `id` | 此记录内唯一的来源 ID。 |
| `kind` | `manual` / `issuer` / `exchange` / `provider` / `other`。 |
| `label` | 简短依据、资料名称或人工分类理由，不能为空白。 |
| `url` | 有实际来源时填 HTTP(S) 链接，否则空；不能编造网址。 |
| `accessed_at` | 实际取得资料的 UTC 时间，不知道则空。 |
| `fields` | 来源覆盖字段，如 `/industry`、`/classification`、`/etf`；也支持身份、名称、发行人、上市状态、备注。 |

`industry.source_ids`、`classification.source_ids`、`etf.source_ids` 各自指向覆盖该字段的来源，不能用“整条来自 Yahoo”掩盖标签实际来自人工。行业或标签非空时必须有对应依据。没有标签时允许 `classification.source_ids` 为空；保留的来源引用仍需有效且覆盖对应字段。身份和名称来源用 `sources.fields` 直接指明。

手工理由可以没有 URL；这意味着“人工判断”，不是经过网页证据验证。资料更新时间与审核时间是不同概念。`notes` 保留人的备注，不放完整供应商业务简介或大段受限文本。

## ETF

ETF 必须有 `etf` 对象，但未确认属性可空；公司行业的四个 ID（含体系和行业组）必须全空、来源数组为空。非 ETF 的 `etf` 必须为空。

ETF 属性包括 `objective`（指数 / 目标）、`asset_class`（equity / fixed_income / commodity / digital_asset / multi_asset / other）、`exposure`（地区敞口描述数组）、`leverage_factor`（正倍数）、`direction`（long / short / neutral）、`reset_period`（daily / monthly / none / other）、`fund_category`、`description` 及 `source_ids`。

填写倍数时必须同时填写方向与重置周期；倍数大于 1 不能写 neutral / none。未知倍数保持空，不默认 1。杠杆倍数不含负号，做空通过 direction 表达。ETF 无股票行业或持仓数据不构成错误；不维护实时持仓和行业权重。

## 审核与版本

`review.status` 为 `pending`、`reviewed`、`needs_review`。只有 `reviewed` 进入正式产物，且需要英文名称、MIC、审核人和 UTC 审核时间。行业允许未知，标签允许为空；已填写的行业、标签和 ETF 属性仍需各自对应的依据。不能用满足 schema 代替事实核查。

`review.reviewed_at` 是最近一次人工审核时间，待复核时可保留上次时间作参考。旧已审核内容修改后，要么降为待复核，要么明确重新审核并更新时间。这个状态机由网页导入 / 编辑逻辑与 PR 基准比较共同约束。

所有源记录、词表、建议、发布文件都有 `schema_version`。取消主主题是严格协议变更，当前源数据和发布产物使用 3.0.0；新词表产物为 `vocabulary.json`，不再输出 `themes.json`。消费者遇到其他版本拒绝读取，不能只改版本号冒充迁移完成。历史 1.0.0 / 2.0.0 快照保持原字节和哈希，使用对应旧版本消费者读取，或显式迁移旧维护源数据后生成新的发布版本；不要直接修改 release 附件。

1.0.0 / 2.0.0 维护数据迁移将旧 `themes` 合入 `tags`，保留 ID、名称、别名和引用关系；将每条记录非空的 `primary_theme_id` 加入 `tag_ids` 并去重，再移除旧字段。1.0.0 数据还需增加空的行业组字段及词表组数组，不推断旧行业的新组，也不把 Yahoo 改成 FinanceDatabase。ID 或名称冲突不能静默合并为不同含义，应明确处理后再迁移。

迁移前验证旧格式和关系，先预览再显式应用。对于已验证为纯结构转换的已有记录，保留审核状态、审核人和时间，不重复要求用户审核同一事实；夹带实际内容修改仍须降为待复核或明确重新审核，不能借迁移将待审核数据自动变为已审核。此次主题转标签不丢失行业、身份、ETF 属性或字段级证据。历史建议保留原 schema 版本和基准记录哈希，不能重写哈希使旧建议“重新有效”。迁移用法见 README。

JSON Schema 负责形状、类型、格式和枚举；`src/validation.js` 负责跨字段、跨记录、分类引用及审核规则。使用其他 JSON Schema 工具时，也需要执行 `npm run validate`，不能省略语义校验。
