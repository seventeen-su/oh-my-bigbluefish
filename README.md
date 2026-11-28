# Oh-My-bigbluefish

基于 DSH 的记忆增强插件。它把记忆、状态和思维链保存到同一个 PostgreSQL 数据库，让 DSH 在对话中自动带回相关上下文。

## 能做什么

- 记住事实、线索和事件，并按项目或全局范围隔离。
- 自动召回上次结论、当前状态、错误签名和相关链接。
- 用状态机跟踪任务进度，保留状态变化历史。
- 把零散记忆组织成思维链和关联组。
- 在后台完成抽取、去重、冲突检测、线索转事实、链接建议和遗忘。
- 提供 7 个工具和 4 篇技能说明，覆盖记忆、召回、状态和后台巩固。

## 安装

1. 打开 DSH 的插件管理。
2. 粘贴仓库地址 `https://github.com/seventeen-su/oh-my-bigbluefish`。
3. 安装后启用插件，重启 DSH。

插件随包提供运行产物和嵌入模型，不需要额外下载或手动复制文件。首次启动会自动创建数据库结构。

## 配置

默认连接 `postgres://omb:omb@127.0.0.1:5432/omb`。在插件配置里修改 `databaseUrl` 即可连接其他数据库。

常用配置：

- `autoMigrate`：启动时自动升级数据库结构。
- `jobs`：启用后台巩固任务。
- `embeddingModel`：嵌入模型目录，默认使用包内模型。
- `urlAllowlist`：允许动态 URL 读取的域名列表，默认关闭。

## 使用

正常对话即可。插件会根据会话内容自动注入常驻记忆和事件记忆，也会在需要时调用工具：

- `omb_remember`：保存记忆、状态或思维链。
- `omb_recall`：主动检索。
- `omb_update`：修改记忆或推进状态。
- `omb_link`：建立实体之间的链接。
- `omb_history`：查看状态历史。
- `omb_status`：查看数据库、队列、投影和工作流状态。
- `omb_admin`：审计、回滚、归档和重放死信。

DSH 还会加载 4 篇技能说明：`omb-memory`、`omb-recall`、`omb-state`、`omb-consolidate`。

## 数据与安全

所有数据保存在本地 PostgreSQL 数据库。插件不包含独立前端，不收集用户画像，不向外部服务发送记忆内容。

动态 URL 读取默认关闭。开启后仍会拒绝环回地址、私网地址和重定向到内网的请求。动态代码只在 QuickJS 沙箱中执行。

审计日志带哈希链，单步回滚会检查版本并拒绝覆盖更新的修改。

## 维护

查看运行状态：

```text
omb_status
```

备份数据库：

```powershell
pg_dump -Fc -d omb -f omb-backup.dump
```

恢复数据库：

```powershell
pg_restore -d omb --clean --if-exists omb-backup.dump
```

升级插件后重启 DSH。数据库迁移会在启动时执行。

## 文档

- `docs/v7/REQUIREMENTS.md`：需求和验收标准。
- `docs/v7/SPEC.md`：实现规格。
- `docs/v7/adr/`：架构决策。
- `docs/legacy/`：旧版本历史资料，仅作存档。

[![powered by dsh](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
