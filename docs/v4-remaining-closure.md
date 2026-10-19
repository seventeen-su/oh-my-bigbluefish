# OMB 剩余项收口（v4.9.4 起）

> 目的：把历次文档里的"仍未做"逐条处置——**已做**、**设计不变量**、**外部依赖**、
> **用户设置**四类，并给出可核对证据。收口后不再有"可执行但没人做"的条目。

## 1. 已做（本轮及此前关闭）

| 条目 | 状态 | 证据 |
| --- | --- | --- |
| 主动记忆有限状态工作流（候选→作用域/时效→查重→写入→验证→冲突/过期） | 已做 | `modules/memory/controller.ts`（4.7.0 决策+执行）、`confirm.ts`（4.8.x 确认/撤销/审计）、`findSameContent`（4.8.0 去重）、`findRelatedRecords`/`findSemanticRelated`（4.9.0/4.9.1 冲突可见） |
| 用户显式晋升入口 | 已做 | `/omb-confirm`（4.8.0）+ 撤销/审计（4.8.1） |
| 证据与节点映射 | 已做（文件级） | `dsh/project-evidence.ts` 的 `extractEvidencePaths` + `omb_project` L1"→ 文件"（4.9.3） |
| 精确同内容去重 | 已做 | `findSameContent` 由捕获路径与 `omb_remember` 共用（4.8.0） |
| precision@k 读数 | 已做（使用归因口径） | `retrieval.ranked/precisionAt1/3/5` + `retrievalRankNote()`（4.9.2） |
| 包导出映射 | 已做 | `readPackageEntryMap` + `resolveImportTarget` 第三级解析（4.9.4） |
| 临时约束过期、任务 TTL | 已做 | controller 的 TTL/回合双过期（4.7.0） |

## 2. 设计不变量（**不做**，不是遗漏）

### 2.1 三方自动合并 / 自动补丁

- 现状：写守卫拒绝时输出 base/current **冲突材料包**，由人/模型重读后自己改
  （`docs/v4.4-versioning-alias-and-oom.md`、`docs/v4-architecture.md` §"不做三方合并"）。
- 为什么不做：守卫的职责是"读后被改 → 拒绝"，自动合并会在没有用户决定的情况下改文件，
  与"守卫不是权限边界、也不替用户做决定"的定位冲突；且校验与宿主持久化之间仍有
  非原子窗口（AGENTS.md 不变量 10），自动写回会把竞态放大成静默覆盖。
- 结论：**设计不变量**。需要合并时用 git 自身（`git merge`）或人工处理。

### 2.2 自动晋升 / 自动撤销记忆

- 现状：候选→已确认只能 `/omb-confirm`；撤销只能 `/omb-confirm undo`。
- 为什么不做：`useCount`/召回次数不参与阶段推导（AGENTS.md v4.6.0 条目），
  自动晋升会把"被引用多次"误当"更可信"；证据等级只能由用户裁决。
- 结论：**设计不变量**，已用 `lifecycle.ts` + 命令入口固化。

### 2.3 完整类型图 / 类型解析

- 现状：导入图是静态文本 + 文件系统解析（相对路径、tsconfig 别名、workspace 包导出），
  **不含**类型/签名/泛型解析。
- 为什么不做：需要加载 TypeScript 编译器 API，按项目规模付出秒级代价；`omb_project`
  是廉价快照（≤2400 字符、扫描上限、缓存），不应变成类型检查任务。
  类型正确性由 `tsc` 承担，导入图只需回答"模块怎么依赖"（4.9.4 已补包导出映射）。
- 结论：**设计边界**（成本/收益），不是缺陷。

## 3. 外部依赖（**本仓库做不了**，已备取证工具）

### 3.1 OOM 根因最终定位

- 现状：`## 进程`（rss/heapUsed/heapTotal/external/uptime）读数可见；
  `scripts/heap-snapshot.ps1` 支持 `repro`/`early` 两种模式并保留快照；
  历史结论：OMB 事件驱动表"条目小、事件驱动"，两个增长点属实但**不是主因**，
  空闲仍增长（`docs/v4-completion.md` v4.3 段）。
- 为什么不能在此定位：需要**宿主进程**的 heap snapshot（V8 快照），插件侧拿不到
  宿主堆的分配归属；脚本已备，但运行与解析依赖宿主环境与人工一步。
- 结论：**外部依赖**。操作步骤见 `scripts/heap-snapshot.ps1` 头部与
  `docs/v4.4-versioning-alias-and-oom.md`。

### 3.2 `dsh-path-guard` 的 `selfProtection`

- 现状：`dsh-path-guard` 是 profile 里**另一个插件**（`docs/dsh-0.2.1-rc.2-compatibility.md`
  §"待人工一步"），不是 OMB 仓库内代码；`docs/parallel-work.md` 也把它列为
  影响插件管理的 profile 级设置。
- 为什么不能在此改：改的是用户的 profile 组合与安全策略，属于**用户设置**；
  OMB 不能替用户放宽自己的写保护。
- 结论：**用户设置**（非本仓库缺陷）。

## 4. 仍受能力限制的已知边界（不假装已做）

- 语义冲突提示只在**有嵌入器且向量已编码**时生效；语义相似 ≠ 矛盾（4.9.1）；
- 证据文件映射只到文件、不解析符号（4.9.3）；路径只表示"命令提到过"，不核验存在性；
- precision@k 是使用归因口径（分母是使用命中数），不是标注集评测（4.9.2）；
- 记忆去重只认精确同内容；近义改写由离线整合处理（4.8.0）。

## 5. 验证

- `tsc --noEmit` 0；`eslint .` 0；`vitest run` 全量通过；`node scripts/version.mjs` 一致；
- 版本以 `version-manifest.json` 为准；构建代数与部署副本在每次发布记录里核对。
