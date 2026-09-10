# tickerdata

轻量证券元数据与**标准行业 + 多选标签**维护系统。**人工审核并合入 Git 的 JSON 是权威来源；网页是编辑器，AI 和外部提供商不是权威。**

这是独立项目，不包含订单流分析、交易、行情、组合管理、账号、数据库或服务器 API。

## MVP 与当前状态

采用原生静态网页、每证券一个 JSON、集中词表、JSON Schema + 交叉引用校验、GitHub Actions 构建、Python 标准库消费。浏览器不依赖 Yahoo 或 AI，没有外部 CDN。

初始化包含 NVDA、CRWV、MSTR、TSLA、GOOG、GOOGL、ARM、BABA、TSM、BRK-B、SPY、QQQ、SOXL、KWEB、GLD、TLT、IBIT 共 17 条**待审核占位样例**。用户给出的分类语义只是审核起点；没有独立核实的名称、MIC、地区等保留为空，上市状态为 `unknown`。维护者可以补齐资料、审核和新增证券，当前内容及审核状态以 `data/` 源记录为准，不要求一直保持初始化状态。

公司行业采用独立的 FinanceDatabase **板块 → 行业组 → 行业** 体系，初始词表包含 11 / 24 / 69 个节点，10 只股票记录了固定版本的上游分类与来源，导入时均待人工审核。GOOG / GOOGL 的上游电信分类标有疑点，不将导入视为事实确认。保留旧 Yahoo 体系；ETF 不套用公司行业。[完整中英分类明细与股票映射](docs/industry-classification.md)。

不再设置单选主主题。此前 12 个主题已与 3 个标签合为 15 个标签，原 ID、显示名、别名和证券关联保留；标签可多选，也可不填。此次仅作结构迁移，不撤销已有人工审核。后续可继续维护标签，不以初始数量限制数据。

**全部尚未审核时，正式 `instruments.json` 和索引为空；完成审核并发布后，只包含已审核记录。** 网页可以查看和维护所有源记录。样例、单元测试中的虚构证券，都不能作为投资事实。

本项目使用公开仓库 [udlrdotai/tickerdata](https://github.com/udlrdotai/tickerdata)，已显式选择公开 Pages 部署，目标维护入口为 <https://udlrdotai.github.io/tickerdata/>。是否部署成功及对应 commit 以仓库 Actions 和 Pages 状态为准。AI 在线生成、yfinance 抓取不属于此版实现。

## 本地启动

需要 Node.js 22+、npm，以及 Python 3.9+。

```sh
npm ci
npm run validate
npm test
python3 -m unittest discover -s tests -p 'test_*.py'
npm run build
npm run serve
```

打开 <http://localhost:8080>。`serve` 只服务 `dist/`，修改源文件后需要重新 `build` 并刷新；不要直接双击 HTML。

真实浏览器维护流程使用 Node 内置测试运行器和仅开发期的 Playwright：

```sh
npx playwright install chromium
npm run test:web
```

该命令自动构建并启动临时本地测试服务，覆盖编辑、审核、导出、新增 ETF、标签合并及完整维护包重新导入，不需要更改正式源记录。Playwright 与浏览器不进入静态网页运行时。

行为测试使用 `tests/fixtures/` 中独立的固定词表和测试证券，不把真实数据的数量、名称、审核状态或发布条数写死。浏览器测试服务在内存中提供测试数据，不覆盖 `data/` 或构建后的 `source-data.json`。真实源数据仍须通过 Schema、引用关系、审核状态迁移与发布规则检查；修复测试依赖不等于放宽审核要求。

本地构建不代表发布。未初始化 Git或工作区有未提交修改时，manifest 的 `source_commit` 是 `null`；无可用 commit 时间时采用固定 Unix epoch，不伪造来源。可通过 `SOURCE_DATE_EPOCH` 指定确定的 UTC 秒数。

## 数据目录

```text
data/
  instruments/ins-000001.json   # 唯一手工维护源，每证券一个文件
  vocabulary.json              # 行业体系和多选标签
schemas/                       # JSON Schema draft-07
src/                           # 同一套浏览器 / CLI 语义校验与发布逻辑
web/                           # 无后台静态维护界面
config/site.json                # 仓库链接、分支、Pages 显式开关
suggestions/                    # 只保存建议及逐项审核决策，不进入发布器
scripts/                       # 校验、构建、草稿导入
examples/consumer.py            # 无第三方依赖的下游消费入口
tests/                         # Node 内置测试、Python unittest
.github/workflows/              # PR 校验、手动 Pages、tag 发布
dist/                          # 生成产物，忽略入库，禁止反向手工维护
```

完整字段含义见 [数据模型 3.0.0](docs/data-model.md)。行业明细见 [FinanceDatabase 分类](docs/industry-classification.md)。许可边界见 [许可说明](docs/licensing.md)。

## 日常维护闭环

1. 在网页按 ticker、名称、别名搜索，按类型 / 标签 / 审核状态筛选；打开或新增证券。
2. 分开填写证券身份、行业、多选标签、ETF 属性和依据。标签只能引用词表 ID，可留空。未知值保留空，不凭公司国籍排除美国上市证券。
3. 查看差异并保存为**浏览器内存草稿**。草稿不写 GitHub、不跨刷新持久保存。页面离开会警告，仍应及时导出。
4. 在“内存草稿 / 完整变更清单”中确认受影响文件。使用 GitHub App 登录后，可直接填写分支名、提交信息、PR 标题和描述，由 Worker 一次性创建新分支与 PR。
5. 仍可导出单证券 `<id>.json`、词表 `vocabulary.json` 或完整维护包作为备用流程。导出只是下载文件，不是提交。多文件标签合并必须把词表和所有引用更新放进**同一个 PR**，不要分别合入。
6. CI 校验通过后由人审阅合入。重新构建站点；正式消费文件仅包含 `review.status=reviewed` 的记录。

**审核不是一个自动通过的按钮。** 审核人需要核对身份、MIC、已填写的行业 / 标签 / ETF 属性和来源，填写 `reviewer`、UTC `reviewed_at`。标签不是审核必填项。已审核记录修改后应变为 `needs_review`，或经过明确复核并填写比旧记录更新的审核时间。PR 校验也会检查这一点。

### 安全导入网页导出文件

网页可以重新导入记录、词表或完整维护包，导入后仍是草稿。要将导出内容应用到本地权威源文件，先预览：

```sh
npm run import -- /path/to/downloaded.json
```

命令显示每个受影响文件的前后内容和当前源数据哈希，不写文件。确认后带上**本次预览输出**的哈希：

```sh
npm run import -- /path/to/downloaded.json --apply --expect HASH_FROM_PREVIEW
npm run validate
```

导入器支持单证券、词表及完整 `{schema_version,instruments,vocabulary}` 维护包；校验整个候选数据集与审核状态迁移，拒绝悬空引用、历史删除、过期预览。涉及标签合并时使用完整维护包，避免只导入词表。

多文件先暂存，再替换 `data/` 目录；这是本地文件操作，不是数据库事务。导入时不要并行编辑源目录。若进程在目录切换期间被强制中断，原数据保留在 `.cache/import-*/previous-data`，先恢复它再继续。不要把 `.cache/` 提交或公开。

最后通过你自己的 Git 客户端审阅并提交；导入器不会自动 commit、push 或声称已经发布。

### 从 1.0.0 / 2.0.0 显式迁移

取消主主题后使用严格的 `3.0.0` 协议，旧文件不能直接导入，也不能只修改 `schema_version`。使用原始 `1.0.0` 或 `2.0.0` 单证券、完整词表或维护包进行预览：

```sh
npm run migrate -- /path/to/legacy.json
```

确认前后差异后，使用本次输出的迁移哈希应用：

```sh
npm run migrate -- /path/to/legacy.json --apply --expect HASH_FROM_PREVIEW
npm run validate
```

迁移器先验证原始旧格式及引用关系，将旧主题并入标签，把每条记录的原主主题 ID 加入标签并去重，移除 `themes` / `primary_theme_id`，再写入新版本号。保留原有 ID、显示名、别名与证据；不能安全处理的 ID 或名称冲突明确报错，不静默覆盖。1.0.0 还需补上空的 `industry_groups` 和可空的 `industry_group_id`，不推断行业组，不将旧 Yahoo ID 换成 FinanceDatabase。

若本地仍是旧版数据，迁移会一并升级完整维护数据集，避免同一目录混用协议。在已升级的目录中导入旧文件，也会校验完整候选数据集；旧词表若会移除被现有证券引用的分类，会被拒绝。涉及多个依赖文件时优先使用完整维护包。

迁移哈希同时绑定当前源数据和本次输入内容，任一变化均需重新预览。已经是 3.0.0 的输入不能再次迁移。纯结构转换可保留已有审核状态、署名和时间；实际修改内容仍受审核降级规则约束，旧文件也不能自动授予一次新审核。应用复用本地多文件导入机制，不 commit、不发布、不改历史 release 或建议文件。

旧建议分别使用保留的 `schemas/v1/`、`schemas/v2/` 结构检查，保留原始版本和基准记录哈希，不适用于 3.0.0 源记录；需要重新生成或人工重新评估，不能通过修改哈希让旧建议自动生效。

### 标签维护

所有自定义分类方向统一为多选标签，使用稳定 ID。显示名重命名不会改变 ID。标签名称及别名去空白、不区分大小写后不能冲突。

删除已被引用的标签会失败；合并需改写所有引用、去重、移除旧 ID，并将受影响证券降为待复核。暂时没有替代项时，不要删标签。公司行业是独立体系，网页提供板块 / 行业组 / 行业联动选择及层级浏览，可通过完整词表 JSON 维护父子关系，并由统一校验器检查引用。行业字段变化不覆盖标签。

标签用于跨行业筛选，不是互斥分组。同一证券可能出现在多个标签下，不能直接相加各标签数量作为总证券数；也不要把第一个标签当作主主题。ETF 使用独立的资产类别、产品属性和标签。

## GitHub / Pages 部署与可见性

**纯 GitHub Pages 不能安全保存服务器端密钥，也没有直接写仓库的后端。** 本系统不在仓库或前端代码中保存 PAT、OAuth secret 或 AI key。网页“直接提交 PR”依赖同源 Cloudflare Worker 完成 GitHub App OAuth 和 GitHub API 调用；浏览器只持有 HttpOnly、Secure、SameSite=Lax 的加密会话 Cookie，不接触 GitHub access token。

### 网页内直接创建 PR（可选）

使用纯静态服务器或 GitHub Pages 预览时，登录功能会显示为未启用，导出维护包和人工 PR 流程仍可用。部署 Worker 后，应先在页面顶部登录 GitHub，再开始编辑；OAuth 会重新加载页面，已有内存草稿不会跨登录跳转保留。随后在“内存草稿 / 完整变更清单”中点击“直接提交 PR（无需先下载再上传）”：

1. 确认变更文件列表。
2. 填写或调整分支名、commit message、PR 标题、PR 描述。
3. 点击“使用 GitHub 登录”完成 GitHub App 授权。GitHub App 需要目标仓库的 Contents `Read and write`、Pull requests `Read and write` 和 Metadata `Read-only` 权限。
4. 勾选确认后提交。页面会先校验远端基线文件是否仍与当前加载时一致；若不一致会拒绝提交并提示刷新重试。
5. 成功后显示可访问的 PR 链接。

常见失败会给出明确提示：登录失效、App 未安装或权限不足、分支重名、远端文件已变化、API 限流、PR 创建失败。若分支已创建但 PR 创建失败，服务端会尝试回滚该临时分支；回滚失败会明确提示人工清理。

### Cloudflare Worker 配置

`wrangler.jsonc` 已配置 `worker/index.js` 处理 `/api/*`，其余路径由 `dist/` 静态资源绑定提供。GitHub App 的 callback URL 应设置为：

```text
https://YOUR_DEPLOYMENT_HOST/api/auth/callback
```

部署前设置三个 Worker secrets：

```sh
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
openssl rand -base64 32 | tr '+/' '-_' | tr -d '=' | npx wrangler secret put SESSION_SECRET
npm run build
npx wrangler deploy
```

`SESSION_SECRET` 必须是 base64url 编码的 32 字节随机密钥。轮换它会立即注销现有会话。GitHub App 建议启用 expiring user access tokens；Worker 会使用 refresh token 自动续期。服务端固定读取部署产物中的 `site-config.json` 和 `source-data.json`，只接受 `data/vocabulary.json` 与 `data/instruments/<id>.json`，重建完整候选数据集并校验审核迁移；前端不能指定其他仓库、默认分支或任意文件路径。

将文件夹放入你明确选择可见性的 GitHub 仓库后，在 `config/site.json` 填写：

```json
{
  "repository_url": "https://github.com/YOUR_OWNER/YOUR_REPOSITORY",
  "branch": "main",
  "pages_enabled": false
}
```

这只启用原文件、GitHub 编辑与历史链接。若默认分支不是 `main`，同步修改 `validate.yml` 的 push 分支配置。

| 场景 | 边界 |
| --- | --- |
| 公开仓库 | 源文件、备注、历史、建议等可被公开读取；不要提交敏感信息。 |
| 私有仓库 | 源代码权限由 GitHub 控制，但不保证 Pages 站点也私有。Pages 的可用性与访问控制受套餐、组织配置影响。 |
| 普通 Pages | 应按公开站点处理；本系统的 `source-data.json` 包含待审核记录及人工备注，不只是正式发布数据。 |
| 私有 Pages | 仅在 GitHub 明确提供并启用受限访问配置时使用；不能凭“仓库私有”推定站点私有。 |
| 私有 release / CI artifact | 保持仓库访问控制；Python 示例没有自动登录，先通过受信任的 GitHub 登录工具下载完整快照再本地读取。 |

公开前人工检查仓库历史、备注、来源文本及全部 `dist` 内容。确认可见性后才能将 `pages_enabled` 改为 `true`，在仓库 Settings → Pages 选择 GitHub Actions，然后从默认分支手动运行 **Publish Pages (explicit opt-in)** 并勾选可见性确认。

模板的双重开关默认关闭；本仓库已在维护者明确要求公开部署后开启配置开关，每次仍需手动确认部署。站点不自动跟随每次 push 部署，避免意外披露。可在 `github-pages` environment 上增加人工批准。即使页面不展示某字段，静态 JSON 仍然可被下载。

GitHub 官方说明（以实际套餐和组织设置为准）：

- [About GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/about-github-pages)
- [Changing Pages visibility](https://docs.github.com/en/pages/getting-started-with-github-pages/changing-the-visibility-of-your-github-pages-site)

### 审阅和回滚

建议保护默认分支，要求 PR、CI 和人工批准，禁止随意覆盖数据 release tag。此 MVP 记录审核人但不实现身份认证或电子签名；字段不能证明是谁操作，真正的账号和审批由 GitHub commit / PR 提供。

CI 的 `--base-ref` 检查会阻止直接删除历史证券、悄悄替换内部 ID，以及未更新时间仍保留已审核状态的内容修改。标记 `inactive` 代替删除，保留历史符号 / 关联 ID。

回滚通过 PR 恢复适当内容；已审核记录的回滚同样需要待复核或新的复核时间，不通过撤销旧时间戳绕开审核。下游历史报告通常直接继续使用原 release，不需要改动现行权威源。

## 发布与固定版本

每次构建都从源数据生成，不双向维护：

| 文件 | 内容 |
| --- | --- |
| `instruments.json` | 全部已审核证券，包括已审核的 `inactive` 历史证券；不包含 `pending` / `needs_review`。 |
| `vocabulary.json` | 多选标签和行业体系词表，带发布 envelope；不是直接复制源词表文件。 |
| `symbol-index.json` | ticker、MIC、显式供应商别名、历史符号及稳定 ID 索引。 |
| `manifest.json` | schema 版本、数据版本、源 commit、确定的生成时间，以及其余三文件的 SHA-256 / 字节数。 |

三个数据文件都带相同 `schema_version` / `data_version`。数据版本是规范化源数据、schema、commit 与确定时间的 SHA-256；对象字段排序稳定，证券和顶层词表按 ID 排序。同一输入和构建来源产生相同字节。

当前协议为 `3.0.0`，记录不含 `primary_theme_id`，词表不含 `themes`；新的词表产物为 `vocabulary.json`，不再输出 `themes.json`。Python 查询结果返回 `tags` 标签对象数组，不再返回 `primary_theme`。下游需同步更新文件名和读取代码。读取 `1.0.0` / `2.0.0` 历史快照时使用对应版本消费者，或先显式迁移旧维护源数据并重新发布。旧 release 的字节、哈希和历史建议基准不修改。

`generated_at` 为 commit 时间（或明确指定的 `SOURCE_DATE_EPOCH`），不是随构建变化的当前时钟。哈希检查保证文件一致性，不等于对远端来源的密码学认证；应从受信任仓库和固定版本获取。

本地输出包含 `dist/releases/<data_version>/` 和 `dist/latest/`。全新 Pages 部署不承诺保留旧站点目录，因此**长期固定版本使用 GitHub Release，而不是依赖旧 Pages URL**。

将已审阅、已合入默认分支的 commit 打上唯一 `data-*` tag，例如 `data-2026-09-07-01` 并推送，会触发 **Publish versioned JSON release**，生成四个独立 release 附件。流程不会覆盖已有 release。同一个 tag 不要移动或替换附件；建议配置 tag ruleset / release 不可变性保护（若仓库可用）。下游同时固定 tag 和 manifest 中的哈希版本。

公共 release 的目录 URL：

```text
https://github.com/YOUR_OWNER/YOUR_REPOSITORY/releases/download/data-2026-09-07-01
```

CI 构建 artifact 只保留 30 天，不作为长期版本地址。固定任意源 commit 也可以在本地检出后 `npm ci && npm run build` 重建，manifest 记录该 commit。

## Python 消费

无需 AI、Yahoo 或 pip 包。先有已审核并发布的记录才能成功查询；尚未审核的样例查询返回未知是预期，不要求 NVDA 等记录永远返回未知。

```sh
python3 examples/consumer.py NVDA --snapshot dist/latest
python3 examples/consumer.py BRK-B --snapshot dist/latest --provider yahoo --mic XNYS
python3 examples/consumer.py NVDA \
  --url https://github.com/YOUR_OWNER/YOUR_REPOSITORY/releases/download/data-2026-09-07-01 \
  --cache .cache/downstream \
  --version DATA_VERSION_FROM_MANIFEST
```

查询仅对符号做去首尾空白和大写处理，**不做全局点号 / 横线替换**。不传 provider 时可搜索所有显式别名；指定 provider 后只匹配该供应商别名以及规范 / 非供应商原始符号。BRK-B 若已标记为 Yahoo 别名，不会因同时是原始输入而绕过 provider 限制。`0700.HK` 保持原样。

GOOG / GOOGL 不合并；同 ticker 在多个市场或历史复用时，明确报歧义，并返回候选 ID。可指定 MIC 缩小范围；默认保留 inactive 候选以避免误认历史证券，需要时显式使用 `--active-only`。未知不是“已退市”。

消费者先验证所有文件的版本、字节数、哈希和引用，再替换成功缓存。网络、超时、混合版本或损坏数据不会覆盖上次成功快照；若允许使用缓存，会明确告警并标识缓存来源。指定 `--version` 后不能悄悄退回另一版本。没有有效缓存时显式失败，由报告项目决定如何处理缺失元数据。

嵌入日报脚本的最小调用：

```python
from examples.consumer import load_snapshot, UnknownSymbol, AmbiguousSymbol

snapshot = load_snapshot("dist/latest")
try:
    result = snapshot.lookup("BRK-B", mic="XNYS", provider="yahoo")
    instrument_id = result["instrument"]["id"]
    tag_ids = [tag["id"] for tag in result["tags"]]
except UnknownSymbol:
    # Report explicitly as unmapped; do not infer delisting.
    print("Unmapped security")
except AmbiguousSymbol as error:
    # Ask the report's mapping layer to choose an explicit MIC or stable ID.
    print("Ambiguous candidates:", error.candidates)
```

远程入口为 `fetch_snapshot(url, cache=None, expected_data_version=None, timeout=10)`；本地入口为 `load_snapshot(path, expected_data_version=None)`。快照对象暴露数据版本、commit、`used_cache` 和 `warning`。下游只需复制 `examples/consumer.py`，或将它作为项目模块引用，不必安装本系统的 Node 依赖。

## 自动化与安全边界

PR 工作流只有 `contents: read`、不持久保存 Git 凭据，不使用 `pull_request_target`，不向不可信 PR 提供 Secrets。Pages 写权限只在部署 job；release 的 `contents: write` 只在上传成品 job，不执行 PR 代码。将来若做 GitHub App + 小服务端创建 PR，需单独评估认证、安装范围、CSRF 与最小权限，不能将密钥转移到网页。

已覆盖 schema、ID / 别名冲突、分类引用、股票 / ETF 规则、审核迁移、草稿导入、版本产物、建议隔离及 Python 查询 / 缓存行为。校验器能阻止结构错误，**不能证明 ticker 身份或分类判断正确**，这仍需人工审阅。

AI / yfinance 后续接口边界见 [建议流程](docs/suggestions.md)。
