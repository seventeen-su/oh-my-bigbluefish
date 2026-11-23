# Oh My BigBlueFish v7

DSH 的单库属性化认知增强插件：记忆、状态机、思维链都作为**属性集合**存在一个
PostgreSQL + pgvector 库里，通过两阶段检索、T0/T1/T2 召回和后台巩固运行。
没有前端、没有用户/项目画像、没有隐私门控。

## 能力

- **单库**：`omb.entity` + `omb.attribute`（真源）+ `omb.entity_view`（同事务派生）。
- **三种单位**：`memory`（fact/clue/event）、`state`（带状态与历史版本）、`chain`（思维链/组）。
- **属性自由扩展**：静态 JSON 或 `{"$dynamic": ...}`（ref/template/file/regex/code/task/url）。
- **引用与链接**：属性内引用记录到 `omb.reference`；实体间支持有向/双向、任意关系。
- **检索**：trigger / fulltext(bigram) / single_char(chars GIN) / vector(HNSW) / time / state_board
  → 图扩展 → RRF(k=60) → 原始分门控 → 场景重排。
- **召回**：T0 常驻偏好/项目状态/库索引；T1 用户消息、工具前后、报错等事件；T2 `omb_recall`。
- **后台**：pg-boss 定时抽取、去重合并、冲突、线索转事实、链接建议、遗忘、属性归并、
  引用腐化；审计日志支持单步回滚。
- **工具**：`omb_remember`、`omb_recall`、`omb_update`、`omb_link`、`omb_history`、
  `omb_status`、`omb_admin`。

## 快速开始

```powershell
pnpm install
$env:OMB_DATABASE_URL = 'postgres://omb:omb@127.0.0.1:5432/omb'
pnpm v7:db:setup
pnpm v7:verify
pnpm v7:bench            # 10 万实体/1 万链接基准
node scripts/v7-deploy.mjs --apply
# 重启 dsh web 后加载 v7
```

旧会话从 `omb`/`omb-daily` 迁到 `cordis` 必须同时改日志 header、补选择事件并修正
`session_projcache`；脚本默认 dry-run，请先关闭 dsh web，再执行：

```powershell
node scripts/v7-migrate-sessions.mjs
node scripts/v7-migrate-sessions.mjs --apply
```

模型默认在 `models/bge-small-zh-v1.5/`；缺失时先跑 `pnpm model:fetch`，或用
`OMB_EMBEDDING_MODEL` 指向其它目录。模型缺失时向量通道标 unavailable，不影响词法检索。
`url` 动态值默认关闭；需要时在 profile 配置 `urlAllowlist`（可配
`urlAllowPrivateAddresses`/`urlTimeoutMs`/`urlMaxBytes`），并保持环回/私网默认拒绝。
PostgreSQL 需要 `vector` 与 `pg_trgm` 扩展（迁移会检查；本地便携安装见 AGENTS.md）。

## 文档

- `docs/v7/REQUIREMENTS.md`：唯一需求源。
- `docs/v7/SPEC.md`：契约与验收。
- `docs/v7/adr/`：架构决策。
- `docs/legacy/`：v4–v6 历史资料，仅存档，不作为 v7 需求。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
