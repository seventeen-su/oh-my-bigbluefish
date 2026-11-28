# OMB 当前架构

本文只描述当前实现，不是历史计划或审查记录。适用版本：OMB 7.1.18。

## 目标与边界

OMB 是运行在 DeepSeek Harness（DSH）中的单库属性化记忆插件。它把记忆、状态机和思维链统一存进 PostgreSQL，并在每轮对话中提供常驻上下文、事件召回和主动检索。

非目标：

- 不做向量数据库、图数据库或多存储同步。
- 不在热路径调用 LLM。
- 不把召回、图扩展或字符串匹配当作长期遗忘的唯一依据。
- 不把审计哈希链宣传成不可篡改存储；它只是篡改可发现（tamper-evident）。

## 分层

```text
domain <- ports <- app / retrieval / recall / jobs <- adapters <- plugin/v7
```

| 目录 | 职责 | 禁止 |
|---|---|---|
| `packages/v7/src/domain` | 纯类型、校验、分词、引用与触发派生 | 不 import `node:*`、`pg`、适配器 |
| `packages/v7/src/ports` | Store、Embedder、JobQueue、DynamicResolver 等窄接口 | 不依赖具体实现 |
| `packages/v7/src/app` | remember/update/recall/dynamic 用例 | 只依赖 domain + ports |
| `packages/v7/src/retrieval` | 六通道、图扩展、RRF、门控、重排 | 只依赖 ports |
| `packages/v7/src/recall` | T0/T1 文本装配 | 只依赖 retrieval/ports |
| `packages/v7/src/adapters` | PostgreSQL、pg-boss、QuickJS、ONNX、DSH 宿主面 | 不反向依赖 plugin |
| `plugin/v7` | 唯一组合根：装配、热开关、dispose | 加载期不碰磁盘；错误不抛宿主 |

## 数据模型

- `omb.attribute` 是属性唯一真源；实体、状态机、思维链都共享这张表。
- `omb.entity_view` 在写事务内从属性派生；检索、投影、审计读取派生结果。
- 归档是软删除：不物理删除，已有链接/组仍可解析，普通检索默认排除。
- 项目身份拆为 `projectId`、`workspaceId`、`repositoryId`、`branchId`；worktree 共享项目知识，分支身份独立。
- 记忆、状态和思维链都支持历史版本；状态推进必须携带 `expectedRevision`。
- `supersedes` 是生命周期：`active / superseded / retracted / archived`，带 `valid_from / valid_to`。当前召回排除历史事实，历史检索和显式时间窗仍可读到。

## 写路径

`AttributeWriter` 是 entity/attribute/view/link/chain/audit/outbox 的唯一业务写事务。`Store.write/patch/archive/link` 都委托它。

一次写入会在同一事务中：

1. 写属性并更新实体版本；
2. 派生 `entity_view`、引用、链接和触发键；
3. 写审计哈希链；
4. 写 outbox 事件并提交；
5. 由事件消费者投递嵌入、相似建议、依赖刷新和投影任务。

工具调用支持稳定 `commandId` 与内容指纹两层幂等；重复提交不会重复建实体。

## 检索与召回

检索计划由 `retrieval/compiler.ts` 生成，可 JSON 往返后重放。八个 provider 独立 deadline、独立失败隔离：

```text
trigger / fulltext / single_char / vector / time / state_board
+ links / expand
```

融合使用 RRF，常数固定为 60。融合分不是概率：门控同时看原始分、多通道排名共识、单通道排名和相对分。全部候选先做摘要特征初排，再对 Top K 一次批量富化精排；缺失富化按中性处理，避免只给前 24 条证据。

召回层：

- **T0**：长期偏好、当前状态和库索引，经 `systemPrompt.context` 注入。
- **T1**：用户消息、工具结果、错误和路径等事件触发；内容窗口在 90 步/7 轮内去重。
- **T2**：`omb_recall` 主动检索。

“今天/昨天/前天”按显式 IANA 时区的当地日历日计算，覆盖 DST。

## 后台、并发与生命周期

- outbox 使用 LISTEN/NOTIFY 唤醒，带退避、死信、重连 reconcile；不靠固定轮询。
- timer 承担 durable schedule；巩固任务以事件驱动为主，timer 分级兜底。
- 投影只做 `preference_board` / `state_board` 增量投影；水位超龄时 T0 回退写模型并记录原因。
- 状态更新和自动刷新都用 revision CAS；冲突返回完整差异，自动刷新不得覆盖人工修改。
- 动态属性建立有向依赖图；目标更新只标记依赖闭包 stale，按深度定向刷新，深度上限 4。
- `managePostgres` 生命周期用进程级引用计数和串行状态机；`dispose` 等待后台任务、监听器、连接池和宿主钩子收尾。
- 连接断开、数据库重启和重复装配必须能恢复，且不累积监听器、连接或工具注册。

## 采用、证据与遗忘

采用证据分四层：

```text
Retrieved -> Referenced -> Utilized -> Validated
```

同一次 `(entity, session, task)` 的重复召回只算一个使用机会；采用置信度做小样本平滑。单纯召回或 `access_count` 不提高显著度。遗忘看使用证据，不看字符串相似度。

Evidence 账本独立记录来源类型、来源 ID、内容哈希、置信度和验证状态。两个会话引用同一文件不算两份独立验证；线索晋升必须有独立证据。`supersedes`/`retract` 在事务内更新生命周期、关系、审计/inverse 和 outbox。

## 安全

- 动态代码只在 QuickJS 沙箱：无宿主、网络、文件；100ms / 16MB / 32KB。
- 动态 URL 默认关闭，按 allowlist 放行。
- T0/T1 注入只作为数据块，不执行其中的指令；高风险命中只注入隔离说明。
- 默认数据库连接 `postgres://omb:omb@127.0.0.1:5432/omb` 只用于本机 loopback 开发。生产必须收紧监听、认证、TLS 和角色权限，见 [SECURITY.md](SECURITY.md)。
- 审计哈希链是 tamper-evident，不是不可篡改；没有外部锚点时无法发现链尾删除。

## 构建与发布

```text
pnpm v7:typecheck
pnpm v7:lint
pnpm v7:test
pnpm v7:test:pg
pnpm v7:build
```

构建产物在 `lib-gen/v7-g<N>/plugin/v7/index.js`；`version-manifest.json` 是版本单一真源。发布使用 annotated tag 和 GitHub Release，Release 首行标注当前 DSH 适配版本。

数据库迁移在 `packages/v7/src/adapters/postgres/migrations/`，当前为 001–017。迁移校验和变化会拒绝执行，这是保护，不是可绕过的错误。
