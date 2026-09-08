# 行业分类：FinanceDatabase

本项目按 **Sector（板块）→ Industry Group（行业组）→ Industry（行业）** 维护公司行业。完整词表在 `data/vocabulary.json` 的 `financedatabase` 体系中，包含 **11 个板块、24 个行业组、69 个行业**。

这套分类是 FinanceDatabase 对 GICS 的宽松近似，**不是 MSCI 官方 GICS**。英文原值保存在 `aliases`；中文名称是本项目显示译名，不宣称为官方译名。保留上游固定版本的名称与结构，不用其他年份的 GICS 分类替换。

## 来源与版本

| 项目 | 固定依据 |
| --- | --- |
| 上游提交 | `ac05d03dbed851a6fd3905a2e92ee036d0397760` |
| 分类字典 | [compression/categories/categories.json](https://github.com/JerBouma/FinanceDatabase/blob/ac05d03dbed851a6fd3905a2e92ee036d0397760/compression/categories/categories.json) |
| 股票接口 | [financedatabase/Equities.py](https://github.com/JerBouma/FinanceDatabase/blob/ac05d03dbed851a6fd3905a2e92ee036d0397760/financedatabase/Equities.py) |
| 分类方法 | [README：Questions & Answers](https://github.com/JerBouma/FinanceDatabase/blob/ac05d03dbed851a6fd3905a2e92ee036d0397760/README.md#questions--answers) |
| 获取时间 | `2026-09-08T01:03:47Z` |

上游字典另含 159 个 Sub-Industry（子行业），但股票 CSV 及 Equities 接口仅提供前三层。本项目不录入第四层、不猜测个股子行业，也不复制子行业定义或企业简介。网页、构建与下游消费不联网同步上游；未来更新需要显式比较差异、补充来源并人工复核。

## 完整分类明细

每行是一个行业组，最后一列是该组下的全部行业。部分行业与行业组名称相同，这是上游结构，不代表重复节点。

| 板块 Sector | 行业组 Industry Group | 行业 Industry（中文 / 英文原值） |
| --- | --- | --- |
| 通信服务 / Communication Services | 媒体与娱乐 / Media & Entertainment | 娱乐 / Entertainment；互动媒体与服务 / Interactive Media & Services；媒体 / Media |
| 通信服务 / Communication Services | 电信服务 / Telecommunication Services | 综合电信服务 / Diversified Telecommunication Services；无线电信服务 / Wireless Telecommunication Services |
| 可选消费 / Consumer Discretionary | 汽车与零部件 / Automobiles & Components | 汽车零部件 / Auto Components；汽车 / Automobiles |
| 可选消费 / Consumer Discretionary | 耐用消费品与服装 / Consumer Durables & Apparel | 家庭耐用消费品 / Household Durables；休闲用品 / Leisure Products；纺织、服装与奢侈品 / Textiles, Apparel & Luxury Goods |
| 可选消费 / Consumer Discretionary | 消费者服务 / Consumer Services | 多元化消费者服务 / Diversified Consumer Services；酒店、餐饮与休闲 / Hotels, Restaurants & Leisure |
| 可选消费 / Consumer Discretionary | 零售 / Retailing | 分销商 / Distributors；互联网与直销零售 / Internet & Direct Marketing Retail；多品类零售 / Multiline Retail；专业零售 / Specialty Retail |
| 必需消费 / Consumer Staples | 食品与主要用品零售 / Food & Staples Retailing | 食品与主要用品零售 / Food & Staples Retailing |
| 必需消费 / Consumer Staples | 食品、饮料与烟草 / Food, Beverage & Tobacco | 饮料 / Beverages；食品 / Food Products；烟草 / Tobacco |
| 必需消费 / Consumer Staples | 家庭与个人用品 / Household & Personal Products | 家庭用品 / Household Products；个人用品 / Personal Products |
| 能源 / Energy | 能源 / Energy | 能源设备与服务 / Energy Equipment & Services；石油、天然气与消耗性燃料 / Oil, Gas & Consumable Fuels |
| 金融 / Financials | 银行 / Banks | 银行 / Banks；储蓄与抵押贷款金融 / Thrifts & Mortgage Finance |
| 金融 / Financials | 多元金融 / Diversified Financials | 资本市场 / Capital Markets；消费金融 / Consumer Finance；多元化金融服务 / Diversified Financial Services；抵押型房地产投资信托 / Mortgage Real Estate Investment Trusts (REITs) |
| 金融 / Financials | 保险 / Insurance | 保险 / Insurance |
| 医疗保健 / Health Care | 医疗设备与服务 / Health Care Equipment & Services | 医疗设备与用品 / Health Care Equipment & Supplies；医疗服务提供商与服务 / Health Care Providers & Services；医疗技术 / Health Care Technology |
| 医疗保健 / Health Care | 制药、生物技术与生命科学 / Pharmaceuticals, Biotechnology & Life Sciences | 生物技术 / Biotechnology；生命科学工具与服务 / Life Sciences Tools & Services；制药 / Pharmaceuticals |
| 工业 / Industrials | 资本品 / Capital Goods | 航空航天与国防 / Aerospace & Defense；建筑产品 / Building Products；建筑与工程 / Construction & Engineering；电气设备 / Electrical Equipment；工业综合企业 / Industrial Conglomerates；机械 / Machinery；贸易公司与分销商 / Trading Companies & Distributors |
| 工业 / Industrials | 商业与专业服务 / Commercial & Professional Services | 商业服务与用品 / Commercial Services & Supplies；专业服务 / Professional Services |
| 工业 / Industrials | 运输 / Transportation | 航空货运与物流 / Air Freight & Logistics；航空公司 / Airlines；海运 / Marine；公路与铁路 / Road & Rail；交通基础设施 / Transportation Infrastructure |
| 信息技术 / Information Technology | 半导体与半导体设备 / Semiconductors & Semiconductor Equipment | 半导体与半导体设备 / Semiconductors & Semiconductor Equipment |
| 信息技术 / Information Technology | 软件与服务 / Software & Services | 信息技术服务 / IT Services；软件 / Software |
| 信息技术 / Information Technology | 技术硬件与设备 / Technology Hardware & Equipment | 通信设备 / Communications Equipment；电子设备、仪器与元件 / Electronic Equipment, Instruments & Components；技术硬件、存储与外围设备 / Technology Hardware, Storage & Peripherals |
| 材料 / Materials | 材料 / Materials | 化学品 / Chemicals；建筑材料 / Construction Materials；容器与包装 / Containers & Packaging；金属与采矿 / Metals & Mining；纸与林产品 / Paper & Forest Products |
| 房地产 / Real Estate | 房地产 / Real Estate | 权益型房地产投资信托 / Equity Real Estate Investment Trusts (REITs)；房地产管理与开发 / Real Estate Management & Development |
| 公用事业 / Utilities | 公用事业 / Utilities | 电力公用事业 / Electric Utilities；燃气公用事业 / Gas Utilities；独立发电商与可再生能源发电商 / Independent Power and Renewable Electricity Producers；综合公用事业 / Multi-Utilities；水务公用事业 / Water Utilities |

## 现有股票的上游分类

以下是首次导入时的**上游原值及来源快照**，不是独立确认后的分类结论。首次导入的 10 只股票均为 `pending`，没有据此补写审核人、审核时间、上市状态、名称或 MIC。后续可以经过人工核验补齐资料并变为 `reviewed`；当前值和审核状态以证券源文件为准，不以本节的导入快照锁定日常维护。

来源文件：[NMS.csv](https://github.com/JerBouma/FinanceDatabase/blob/ac05d03dbed851a6fd3905a2e92ee036d0397760/database/equities/NMS.csv)、[NYQ.csv](https://github.com/JerBouma/FinanceDatabase/blob/ac05d03dbed851a6fd3905a2e92ee036d0397760/database/equities/NYQ.csv)。每条证券的 `sources` 单独保存其文件链接、获取时间、上游代码和原始三层名称，且通过 `industry.source_ids` 关联 `/industry` 依据。

| 本项目代码 | 上游代码 / 文件 | 板块 → 行业组 → 行业 |
| --- | --- | --- |
| NVDA | NVDA / NMS | Information Technology → Semiconductors & Semiconductor Equipment → Semiconductors & Semiconductor Equipment |
| CRWV | CRWV / NMS | Information Technology → Software & Services → Software |
| MSTR | MSTR / NMS | Information Technology → Software & Services → Software |
| TSLA | TSLA / NMS | Consumer Discretionary → Automobiles & Components → Automobiles |
| GOOG | GOOG / NMS | Communication Services → Telecommunication Services → Diversified Telecommunication Services |
| GOOGL | GOOGL / NMS | Communication Services → Telecommunication Services → Diversified Telecommunication Services |
| ARM | ARM / NMS | Information Technology → Semiconductors & Semiconductor Equipment → Semiconductors & Semiconductor Equipment |
| BABA | BABA / NYQ | Consumer Discretionary → Retailing → Internet & Direct Marketing Retail |
| TSM | TSM / NYQ | Information Technology → Semiconductors & Semiconductor Equipment → Semiconductors & Semiconductor Equipment |
| BRK.B | BRK-B / NYQ | Financials → Insurance → Insurance |

**GOOG / GOOGL 的“综合电信服务”分类存在待复核疑点。** 按维护决策先保留原值，并在证券备注及来源说明中明确提示，不偷偷更正为其他行业。之后若经人工核对需要改值，应新增对应依据，保留旧来源，按审核流程处理。

BRK.B 用已有的 Yahoo 别名 BRK-B 匹配上游，规范代码不变。CRWV 的 AI 云/算力主主题、MSTR 的比特币资产主主题也不因行业导入而改变。

## 维护约束

`financedatabase` 和 `yahoo` 是独立体系：不能因中文同叫“信息技术”就复用 ID 或默认为同一分类。现有 Yahoo 标签与 ID 原样保留，不补造 Industry Group。

网页按板块、行业组联动过滤；选行业可补齐已知父级。行业可以未知，也可以只知道一部分层级，但填写的节点必须属于同一体系，已知父子关系不能冲突，非空分类必须有行业来源。词表中的 FinanceDatabase 行业必须保有完整的组和板块关系。

主主题仍用于互斥交易分组，辅助标签仍用于检索。SPY、QQQ、SOXL、KWEB、GLD、TLT、IBIT 的公司行业全部为空，使用 ETF 属性与主主题，不从基金名称或持仓猜测公司行业。

字段规则见 [数据模型](data-model.md)，第三方署名与再分发边界见 [许可说明](licensing.md)。
