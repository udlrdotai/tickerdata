# 可选建议流程：与权威源分离

此 MVP **不调用 AI 或 Yahoo**。提供独立建议 schema、严格检查入口和人工流程；在线生成与 yfinance 缓存适配器是紧接着的扩展，不影响当前手工闭环或下游运行。

## 当前可用的建议文件流程

建议放在 `suggestions/*.json`，遵循 `schemas/suggestion.schema.json`。它包含稳定证券 ID、源记录 `base_record_sha256`、生成时间、生成器、`facts`、`inferences`、`missing`、逐字段 `proposed`、`new_theme_proposals`、`decisions`。

`base_record_sha256` 是 `src/release.js` 的 `recordHash(record)`，即按项目 `stableStringify` 排序、带末尾换行的完整源记录 JSON 的 SHA-256，而不是任意原文件空白格式的哈希。获取示例：

```sh
npm run validate
node --input-type=module -e \
  "import {loadDataset} from './scripts/cli.js'; import {recordHash} from './src/release.js'; const d=await loadDataset(); console.log(recordHash(d.instruments.find(r=>r.id==='ins-000001')));"
npm run suggestion:validate -- suggestions/YOUR_SUGGESTION.json
```

当前建议可提议主主题或辅助标签，不能在 JSON 中嵌入任意可执行补丁。主主题与标签必须来自既有词表；新主题只能进入 `new_theme_proposals`，先独立人工维护词表，不能直接引用到正式数据。

`facts` 中的来源链接必须来自真实参考材料，`inferences` 明确是推断，`missing` 明确列出未知道的信息。语法校验不能判断链接是否真实支持说法，也不能防止事实幻觉，必须由人打开原材料核实 ticker、市场、类型及结论。

每个提议按数组索引在 `decisions` 记录 accepted / rejected、审核人、时间及说明。即使全部 accepted，**建议也不会自动写入 `data/`**。接受后在编辑器中逐项转写，补充字段依据，查看差异，重新审核，通过普通 PR 合入。源记录哈希变了则严格检查报 stale，重新评估而不是盲目套用旧判断。

发布器完全不读取建议目录。普通 CI 只检查建议的 schema，以保留已经完成的历史提议；正式接受前的 `suggestion:validate` 额外检查当前 ID 引用、源记录哈希、重复字段与逐项决策索引。

## AI 扩展约束

以后通过本地脚本或手动 `workflow_dispatch` 实现，优先显式提供输入资料，不做浏览器实时生成。

输入仅包含人工选择的证券 ID、ticker、MIC、类型、已有字段、词表、可选结构化 provider 缓存及引用材料。业务简介等外部文本应序列化成独立数据，绝不能执行其中的命令、链接跳转要求或修改系统指令；生成器无源码写权限，无工具执行权限。

输出限结构化 JSON，并通过现有 suggestion schema 和语义检查。要求选择已有 ID、短理由、区分事实 / 推断 / 缺失、不编造链接；新标签或新主题先提议，不扩写正式词表。不生成主观置信度数字。

密钥仅来自本地环境变量或受保护的 Actions Secrets。不能写进前端、URL、日志、浏览器存储、JSON 源文件或仓库。任何发送给模型的资料都需要确认允许发给选定提供商；尤其不能默认发送私有笔记、完整版权文本或凭据。

若后续支持 Actions 自动创建建议 PR，使用最小权限，显式从受信任默认分支手动运行。不要用携带 Secrets / 写 token 的 `pull_request_target` 检出不可信 PR，也不要执行模型输出。生成建议与有写权限的提交步骤应分离。

## yfinance 扩展约束

未来适配器只在本地 / 手动任务运行；查询 UI、生成正式产物、下游消费都不能依赖在线 Yahoo。未实现前不要声称当前系统已经同步过 Yahoo。

每次成功结果需记录请求的 provider ticker / MIC、成功获取时间、字段级来源与所用库版本，写入独立 `.cache/` 或未经发布的 observation 区域。默认不提交完整业务简介、持仓、原始 payload。

将成功观测与失败日志分开：空响应、429、超时、网络错误只更新失败状态，不覆盖已有成功缓存，不将证券改成 inactive，不把空字段解释成永久未知。设置有限超时、有限重试 / 退避，尊重限流和条款。

ETF 缺少股票行业或持仓字段本来就正常。只有明确人工核实的证券事件才变更上市状态或历史符号。最终从缓存挑选的字段仍需逐项转写、溯源、审核，而不是覆盖已审核记录。

## 不在本 MVP 范围

网页内一键 PR 需要 GitHub App 与小型服务端持有凭据，并评估登录、安装权限与请求防护；不能用前端 PAT 或 OAuth client secret 绕过。维护规模足够小的时候，当前导出 + GitHub 人工 PR 更容易审计。
