# AGENTS.md

本文件给维护者和 AI agent 使用。当前版本：**OMB 7.2.4**。当前架构见 `docs/ARCHITECTURE.md`，参与开发见 `docs/CONTRIBUTING.md`，安全边界见 `docs/SECURITY.md`。

## 命令

```powershell
pnpm install
pnpm v7:typecheck
pnpm v7:lint
pnpm v7:test          # 单元，不依赖 PostgreSQL
pnpm v7:test:pg       # 真实 PostgreSQL 集成测试
pnpm v7:build         # 构建 lib-gen/v7-g<N>/plugin/v7/index.js
pnpm v7:bench
pnpm v7:deploy        # 默认 dry-run；--apply 才写 DSH profile
```

`OMB_DATABASE_URL` 和 `OMB_TEST_DATABASE_URL` 必须由环境提供。测试库名要含 `test`，不要把测试指向生产库。

## 分层

```text
domain <- ports <- app/retrieval/recall/jobs <- adapters <- plugin/v7
```

- `domain/`：纯类型、校验、分词、引用/触发派生；不 import `node:*`、`pg`、适配器。
- `ports/`：Store、Embedder、JobQueue、DynamicResolver 等窄接口。
- `app/`：remember/update/recall/dynamic 用例；只依赖 domain + ports。
- `retrieval/`：六通道、图扩展、RRF、门控、重排；只依赖 ports。
- `recall/`：T0/T1 文本装配；只依赖 retrieval/ports。
- `adapters/`：PostgreSQL、pg-boss、QuickJS、ONNX、DSH 宿主面。
- `plugin/v7/`：唯一组合根；加载期不碰磁盘，错误不抛宿主。

## 不变量

1. 单 PostgreSQL 库；`omb.attribute` 是属性唯一真源，`entity_view` 同事务派生。
2. 归档不物理删除；已有链接/组仍可解析，普通检索默认排除。
3. 热路径零 LLM；嵌入用本地 ONNX，向量不可用标 `unavailable`，不伪造。
4. 动态代码只在 QuickJS 沙箱：无宿主/网络/文件，100ms/16MB/32KB。
5. 检索 RRF 常数固定 60；融合分不是概率；原始分/共识/相对分门控不达标宁可不返回。
6. 中文单字回退用 `chars text[] + GIN`，不要依赖 CJK `pg_trgm`。
7. 工具/事件/提示必须有真实消费者；没接线的能力不要写成可用。
8. 状态更新必须带 `expectedRevision`；自动刷新不得覆盖人工修改。
9. 采用证据分 Retrieved/Referenced/Utilized/Validated；access/相似度不直接决定遗忘。
10. `supersedes` 是生命周期，不是普通链接；当前召回排除 superseded/retracted。
11. 后台任务用事件、timer、CAS 和 outbox，不新增固定轮询。
12. `dispose` 必须等待后台任务、LISTEN、连接池和宿主钩子收尾。
13. 数据库迁移一旦发布不再修改；校验和变化会被拒绝。
14. 10 个巩固任务必须保留真实 workflow definition；timer 只 startRun，step 与队列共用同一个 runner。
15. T0/T1/T2 必须写逐实体 receipt；adoption 只能从 receipt 的 kept/quarantined 派生，不能从 recall_event 推断。
16. 审计 actor/source 必须由宿主上下文派生；项目是授权边界，回滚要在工具层和事务层双检。
17. 生产数据库、profile 和真实用户会话不得用于实验。

## 文档与提交

- 只维护当前文档：`README.md`、`docs/ARCHITECTURE.md`、`docs/CONTRIBUTING.md`、`docs/SECURITY.md`、`AGENTS.md`、`THIRD_PARTY_NOTICES.md`。
- 不提交历史计划、审查快照、个人工作记录、本机绝对路径、会话日志、数据库转储或凭据。
- 提交信息使用 `type: subject`，空行后编号正文；正文必须真实换行，不能出现字面量 `
`。
- 作者/提交者统一为 `苏拾柒 <seventeen_su@proton.me>`。
- 维护者可直接 push `main`；第三方走 PR，维护者审核后用 Merge commit 合并，保留 PR 作者与提交信息。
- 发布用 annotated tag + GitHub Release，首行标注当前 DSH 适配版本。

## 发布前

```text
pnpm v7:typecheck
pnpm v7:lint
pnpm v7:test
pnpm v7:test:pg
pnpm v7:build
```

7.2.4 闸门：76 文件 / 864 unit、39 文件 / 421 PG；构建 g67 / 1,568,936 bytes。

没有跑过的检查写“未验证”，不要写成“已完成”。


