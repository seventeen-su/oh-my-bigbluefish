# 参与开发

## 环境

- Node.js 24+
- pnpm 11+
- PostgreSQL 17 + `vector`、`pg_trgm` 扩展

```powershell
pnpm install
$env:OMB_DATABASE_URL = "postgres://omb:omb@127.0.0.1:5432/omb"
$env:OMB_TEST_DATABASE_URL = "postgres://omb:omb@127.0.0.1:5432/omb_v7_test"
pnpm v7:db:setup
```

测试库必须使用名字含 `test` 的独立库，不要把测试指向生产库。

## 分支与 PR

- `main` 受保护：只有维护者可以直接 push；第三方开发者请 fork 后提交 PR。
- PR 必须由维护者审核并批准后合并。
- 合并使用 **Merge commit**：保留 PR 中每个提交的作者、committer、提交信息和 SHA 语义，不 squash、不 rebase。
- 不要强推已推送的 PR 分支；需要更新时追加提交。
- PR 标题和提交信息使用 `type: subject`，空行后写编号正文：

```text
fix: 修复某条召回路径的重复注入

1. 复现条件与根因。
2. 修复方式与影响范围。
3. 新增回归测试。
```

正文必须使用真实换行，不能出现字面量 `\n`。

## 提交前检查

```powershell
pnpm v7:typecheck
pnpm v7:lint
pnpm v7:test
pnpm v7:test:pg
pnpm v7:build
```

PR 应同时包含失败复现和修复后的回归测试。没有跑过的检查不要写成已验证。

## 代码规则

- 保持 `domain <- ports <- app/retrieval/recall/jobs <- adapters <- plugin/v7` 的依赖方向。
- 不把宿主机、网络、文件系统能力带进 `domain`；动态代码只能在 QuickJS 沙箱执行。
- 热路径不调用 LLM；嵌入不可用时标 `unavailable`，不要伪造向量。
- 写路径必须保持属性、视图、审计和 outbox 同事务。
- 状态更新必须带 `expectedRevision`；冲突要返回完整差异。
- 后台任务用事件、timer 和 CAS，不要新增固定轮询。
- 新增数据库迁移后不要修改已发布迁移文件；迁移校验和变化会被拒绝。

## 文档与隐私

- 只维护当前实现相关的最小文档：`docs/ARCHITECTURE.md`、`docs/CONTRIBUTING.md`、`docs/SECURITY.md` 和 README。
- 不提交历史计划、审查快照、个人工作记录或大段本机探测日志。
- 不提交本机绝对路径、用户名、会话日志、数据库转储、密钥、令牌或 profile 私有配置。
- 示例路径使用 `<workspace>`、`<home>` 或环境变量，不要写具体机器目录。
- 许可证和第三方组件清单统一维护在 `THIRD_PARTY_NOTICES.md`。

## 报告问题

- 功能缺陷：提交 issue，附最小复现、预期行为和实际行为。
- 安全问题：不要公开细节，按 [SECURITY.md](SECURITY.md) 的方式私密报告。
