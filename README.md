# Oh-My-bigbluefish

[![powered by DSH](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)

Oh-My-bigbluefish 是运行在 DSH 中的记忆增强插件。它将记忆、状态和思维链统一保存在 PostgreSQL，使 DSH 能在多轮对话中持续理解上下文、延续任务并复用历史结论。

## 用途

- 保存事实、线索和事件，并按项目或全局范围隔离。
- 召回历史结论、当前状态、错误签名和相关链接。
- 使用状态机跟踪任务进度，保留状态变化历史。
- 将零散记忆组织为思维链和关联组。
- 在后台完成抽取、去重、冲突检测、线索转事实、链接建议和遗忘。
- 提供 7 个工具和 4 篇技能说明，覆盖记忆、召回、状态和后台巩固。

## 设计与架构

插件使用单库属性化模型。一个实体由若干属性组成，属性是唯一真源。实体视图在同一次数据库事务中派生，检索、投影和审计都读取这份派生结果。

### 三种认知单位

| 单位 | 作用 | 关键特征 |
|---|---|---|
| 记忆 | 记录事实、线索和事件 | 可引用、可链接、可召回 |
| 状态 | 表示任务、目标或对象的当前状态 | 有状态值和历史版本，版本变化可追溯 |
| 思维链 | 把多个记忆和状态组织成一条推理或任务线 | 有序成员，可跨项目引用 |

记忆回答“知道什么”。状态回答“现在处于什么阶段”。思维链回答“这些信息如何串成一条线”。

三者共享同一套实体、属性和链接模型。状态是长期存在的实体，每次状态推进生成新的历史版本。思维链是带顺序的组，成员可以指向记忆或状态。引用关系记录在统一的引用表中，检索时可以沿链接扩展。

### 数据流

```text
属性写入
  ├─ 同事务派生实体视图
  ├─ 写入引用、链接和触发键
  └─ 写入审计与 outbox 事件

实体视图
  ├─ trigger 触发匹配
  ├─ fulltext 全文检索
  ├─ single_char 单字回退
  ├─ vector 向量检索
  ├─ time 时间窗口
  └─ state_board 状态看板
        │
        ▼
  图扩展 → RRF 融合 → 原始分门控 → 场景重排
        │
        ▼
  T0 常驻上下文 / T1 事件召回 / T2 主动检索
```

T0 注入长期偏好、当前状态和库索引。T1 在用户消息、工具结果和错误事件出现时召回。T2 由 `omb_recall` 主动调用。

### 后台与可靠性

插件使用 PostgreSQL 保存任务、outbox、投影水位、timer 和工作流状态。后台任务由 LISTEN/NOTIFY 和到期 timer 唤醒，不使用固定轮询。实体写入与 outbox 在同一个事务提交。投影失败会保留待处理任务并在水位超龄时回退到写模型。

审计日志使用哈希链。单步回滚会检查实体版本，拒绝覆盖更新后的修改。动态 URL 默认关闭，动态代码只在 QuickJS 沙箱中执行。

## 安装

1. 打开 DSH 的插件管理。
2. 粘贴仓库地址 `https://github.com/seventeen-su/oh-my-bigbluefish`。
3. 安装并启用插件，然后重启 DSH。

安装包包含运行产物、数据库迁移和嵌入模型。安装过程不需要构建步骤、下载脚本或手动复制文件。首次启动时，插件会自动创建数据库结构。

## 配置

默认连接 `postgres://omb:omb@127.0.0.1:5432/omb`。在插件配置中修改 `databaseUrl` 可以连接其他数据库。

常用配置：

- `autoMigrate`：启动时自动升级数据库结构。
- `jobs`：启用后台巩固任务。
- `embeddingModel`：嵌入模型目录，默认使用包内模型。
- `urlAllowlist`：允许动态 URL 读取的域名列表，默认关闭。

## 使用

插件在会话中自动注入常驻记忆和事件记忆，并根据任务需要调用工具：

- `omb_remember`：保存记忆、状态或思维链。
- `omb_recall`：主动检索。
- `omb_update`：修改记忆或推进状态。
- `omb_link`：建立实体之间的链接。
- `omb_history`：查看状态历史。
- `omb_status`：查看数据库、队列、投影和工作流状态。
- `omb_admin`：审计、回滚、归档和重放死信。

DSH 会加载 4 篇技能说明：`omb-memory`、`omb-recall`、`omb-state`、`omb-consolidate`。

## 维护

运行状态通过 `omb_status` 查看。

数据库备份：

```powershell
pg_dump -Fc -d omb -f omb-backup.dump
```

数据库恢复：

```powershell
pg_restore -d omb --clean --if-exists omb-backup.dump
```

升级插件后重启 DSH。数据库迁移在启动时自动执行。

## 文档

- `docs/v7/REQUIREMENTS.md`：需求和验收标准。
- `docs/v7/SPEC.md`：实现规格。
- `docs/v7/adr/`：架构决策。

## 许可证

Copyright (C) 2026 苏拾柒

本项目使用 GNU General Public License version 3 only，SPDX 标识为 `GPL-3.0-only`。完整许可证文本见 `LICENSE`。

插件依赖和随包分发的 BGE-small-zh-v1.5 嵌入模型使用各自的许可证。依赖清单、模型归属和许可证文本见 `THIRD_PARTY_NOTICES.md` 与 `licenses/`。
