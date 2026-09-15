# tickerdata

轻量证券元数据维护与发布项目。人工审核并合入 Git 的 JSON 是权威来源；网页、AI 和外部数据提供商都不能替代人工审核。

- 公开目录：<https://udlrdotai.github.io/tickerdata/>
- 数据维护台：<https://udlrdotai.github.io/tickerdata/maintenance/>

## 当前功能

- 每只证券使用独立 JSON 文件维护，内部 ID 稳定。
- 支持股票、ETF 和其他证券，以及 ticker、MIC、别名、历史符号和关联证券。
- 支持标准行业层级与多选标签；ETF 使用独立的资产类别、方向、杠杆等属性。
- 记录字段依据、人工备注和 `pending`、`needs_review`、`reviewed` 审核状态。
- 使用 JSON Schema 和语义校验检查字段、引用关系、重复标识及审核状态变更。
- 公开目录支持按代码、名称、别名、行业和标签搜索及筛选，只展示已审核记录。
- 维护台支持编辑证券和词表、查看差异、生成内存草稿，并通过 GitHub 登录直接创建 PR。
- 构建可复现的 JSON 快照、哈希清单、符号索引和静态站点。
- 提供无第三方 Python 依赖的本地或远程快照查询示例。
- GitHub Actions 负责 PR 校验、Pages 发布和带版本的数据 Release。

本项目不提供行情、交易、订单流分析、组合管理或投资建议。

## 本地运行

需要 Node.js 22+、npm 和 Python 3.9+。

```sh
npm ci
npm run validate
npm test
python3 -m unittest discover -s tests -p 'test_*.py'
npm run build
npm run serve
```

打开 <http://localhost:8080> 查看公开目录，或打开
<http://localhost:8080/maintenance/> 使用维护台。修改源文件后需要重新执行
`npm run build`。

浏览器端测试需要 Playwright：

```sh
npx playwright install chromium
npm run test:web
```

## 数据与目录

```text
data/instruments/       每只证券一个 JSON 源文件
data/vocabulary.json    行业体系和标签词表
schemas/                当前及兼容版本的 JSON Schema
src/                    校验、数据模型和发布逻辑
web/                    公开目录与维护台
worker/                 GitHub 登录和创建 PR 的 Cloudflare Worker
suggestions/            与权威数据隔离的建议文件
examples/consumer.py    Python 快照消费者
tests/                  Node、Python 和浏览器测试
```

当前数据协议为 `4.0.0`。字段定义和维护约束见：

- [数据模型](docs/data-model.md)
- [行业分类](docs/industry-classification.md)
- [建议流程](docs/suggestions.md)
- [许可说明](docs/licensing.md)

`data/` 是唯一手工维护源，`dist/` 是构建产物，不应反向编辑。

## 数据维护

1. 在维护台搜索并打开证券，或新增证券。
2. 填写身份、行业、标签、ETF 属性和依据；未知值保持为空。
3. 查看差异并保存为浏览器内存草稿。
4. 确认完整变更清单，通过 GitHub 登录创建分支和 PR。
5. 等待 CI 校验和人工审阅后合入。

内存草稿不会写入 GitHub，也不会跨页面刷新保存。标签合并等多文件修改必须在同一个 PR 中同时更新词表和所有引用。

只有 `review.status` 为 `reviewed` 的证券进入正式发布数据。审核人需要核对身份、MIC、行业、标签、ETF 属性及其依据，并填写审核人和 UTC 审核时间。修改已审核内容后，应将记录标记为 `needs_review`，或完成新一轮审核并更新时间。

建议文件不会自动修改 `data/`，发布器也不会读取 `suggestions/`。接受建议后仍需人工转写、核对依据并通过普通 PR 合入。

## 构建产物

`npm run build` 在 `dist/latest/` 和按数据版本固定的目录中生成：

| 文件 | 内容 |
| --- | --- |
| `instruments.json` | 已审核证券 |
| `vocabulary.json` | 行业体系和标签词表 |
| `symbol-index.json` | ticker、MIC、别名、历史符号和稳定 ID 索引 |
| `manifest.json` | 协议版本、数据版本、源 commit、生成时间和文件哈希 |

同一份源数据、Schema、commit 和生成时间会产生相同内容。工作区有未提交修改时，本地 manifest 的 `source_commit` 为 `null`，不会声称产物来自当前 HEAD。

## Python 消费

从本地构建快照查询：

```sh
python3 examples/consumer.py NVDA --snapshot dist/latest
python3 examples/consumer.py BRK-B --snapshot dist/latest --provider yahoo --mic XNYS
```

从 GitHub Release 查询并缓存：

```sh
python3 examples/consumer.py NVDA \
  --url https://github.com/udlrdotai/tickerdata/releases/download/DATA_TAG \
  --cache .cache/downstream \
  --version DATA_VERSION
```

消费者会校验版本、文件大小、SHA-256 和引用关系。未知或歧义证券会显式报错，不会根据 ticker 格式猜测证券身份。

## 部署

### GitHub Pages

`config/site.json` 配置仓库、默认分支和 Pages 开关。Pages 工作流仅支持手动运行，并要求再次确认公开发布。站点内容应按公开信息处理，提交前不要写入凭据或敏感备注。

### Cloudflare Worker

维护台直接创建 PR 依赖 `worker/index.js`。Worker 处理 `/api/*`，其余路径由 `dist/` 静态资源提供。部署前需要配置 GitHub App，并设置：

- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`
- `SESSION_SECRET`

```sh
npm run build
npx wrangler deploy
```

GitHub App callback URL 为：

```text
https://YOUR_DEPLOYMENT_HOST/api/auth/callback
```

浏览器只持有加密的 HttpOnly 会话 Cookie，不接触 GitHub access token。Worker 仅接受配置仓库中的词表和证券文件，并在创建 PR 前重新校验远端基线及完整候选数据集。

### 数据 Release

在默认分支已审核的 commit 上推送唯一的 `data-*` tag，会触发版本化 JSON Release：

```sh
git tag data-YYYY-MM-DD-NN
git push origin data-YYYY-MM-DD-NN
```

长期消费应固定 Release tag，并校验 `manifest.json` 中的数据版本和哈希。

## 安全与质量边界

- 前端和仓库中不保存 PAT、OAuth secret 或 AI key。
- PR 工作流以只读权限执行，不使用 `pull_request_target`。
- 校验器可以阻止结构、引用和状态错误，但不能证明证券身份或分类结论正确。
- 所有数据结论和来源仍需人工核实。
