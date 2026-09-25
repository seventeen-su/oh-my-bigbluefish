# OMB v3 重构规划与计划

> 目标宿主：**DSH v0.1.7-rc.2**（`D:\Program\deepseek-harness`，`package.json:3`）
> 现状基线：OMB v2.3.0，85,658 行 TypeScript，453 个 git 跟踪文件
> 文档性质：施工蓝图（长期保留在 `docs/`，见 §13.5）
> 版本：**v3** —— 取代 v1（内外核）与 v2（微内核 + 认识论认知层）
> 状态：待用户审阅

---

## 0. 本轮的五条修正与执行结果

| # | 你的意见 | 本版处理 |
|---|---|---|
| 1 | 认知层还是太参考之前的；它应当是一个**针对 AI 思维链**的认知增强组件，保证思维链高效准确、有方法论指导、不过长不过短；配合上下文优化使用；**不要出现哲学术语**（哲学语义需深入理解，不利于 LLM），而是把哲学**贯彻进方法论**；必须**通用**，拆分并删除针对某个细节的非通用冗余 | **认知层从"认识论骨架"改为"思维链质量层"。** 哲学词汇全部移除，改为**八条可直接执行的方法论规则**（§4.3）。删除全部只在编程域成立的机制（§4.7）。见 §4 |
| 2 | 保留多跳查询（关联记忆）但不强制、供 AI 选择；向量检索保留；插件内部也模块化，可开关（如多查询、向量检索） | **关联扩展与向量检索都保留，且都是独立可开的模块**（§3.4、§5.5、§5.7）。模块清单细化为"每能力一行" |
| 3 | **无需每回合硬性 token 上限**；用前沿的革命性思路构建上下文优化 | **删除硬上限。** 改为**测量驱动的软压力塑形 + 拉取式上下文 + 模型自控推理深度**（§6.3-6.4）。这依赖一个本轮才验证的宿主事实（§1.4） |
| 4 | 自主决策你留下的问题 | 四处决策已定，含理由与被否决项（§2） |
| 5 | 组件应为**通用性**设计，不限编程或工作；生活、简单、情感陪伴都应适用 | 全文以通用性为筛选器：只在编程域成立的机制被删除或降为可选；情感/生活写进验收（§11.4、§13.3） |

---

## 1. 宿主事实

### 1.1 事实 A — 你的插件在 DSH 0.1.7 上根本没有被挂载

DSH 删除了用户预设目录机制，`$DSH_HOME/.agent-presets/<id>/`（`preset.yml` + `agent.cordis.yml`）**已不被任何代码读取**：

- 删除提交 `d1e22a7e24`（2026-09-21）
- 权威原文：`packages/preset/agent-preset/skills/editing-cordis-compositions/SKILL.md:69-70` — "Nothing reads that directory any more."
- 0.1.3 → 0.1.7：**4496 个提交 / 17 天**

实测：当前 profile 的 188 个插件行与 9 个 bundle 中**没有任何 OMB 行或 bundle**。

### 1.2 事实 B — 前端开关 = 文件开关，只有一条实现路径

`plugin-manager` 的 `listPlugins()` 判定可寻址性时要求 `entry.id === 'include'`（`plugin-manager/src/index.ts:267`），否则标 `readOnlyReason: 'unaddressable'`。预设内部的行挂在 `preset-<id>` 树下，**在插件页上拨不动**。

写入端是 `writePluginEnabled(profile.patchPath, row.patchId, row.moduleName, enabled)`（`:430`）→ `profiles/web/cordis.patch.yml` 那一行的 `disabled`（`patch.ts:36-39`）。

→ **功能模块必须是 profile 根层的行。**

### 1.3 事实 C — 宿主存储不能承载 FTS 记忆索引

`storage-sqlite` 只暴露 `readonly kv: KvFacet`（`storage-sqlite/src/index.ts:57`），`DatabaseSync` 是 `private`。不支持原始 SQL、`MATCH`/FTS、有序扫描、范围查询、排序、跨记录事务。

→ **自开 SQLite 文件是唯一正确选择。**（`node:sqlite` 实测在本机 Node v24.12.0 可用。）

### 1.4 事实 D — 宿主已提供**逐节点 token 记账**与**缓存命中度量**（本轮新验证）

这一条是 §6 全部设计的基础。

```ts
// packages/llm/llm/src/types.ts:171-186
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  totalTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number      // ← 推理 token 单独计
}
```

```ts
// packages/llm/token-meter/src/index.ts:146-191
measure(session: Session, requestHeader?: EpochHeader): TokenMeasurement
// 返回 { logRevision, baseline, surfaceDeltaTokens, totalTokens,
//        surfaceTokens, nodes: MeterSurfaceNode[] }
```

四个可用于本组件的量：

| 量 | 出处 | 用途 |
|---|---|---|
| `reasoningTokens` | `types.ts:186` | **直接度量"思维链长度"**——本版认知层的核心 KPI |
| `cacheReadTokens` / `cacheWriteTokens` | `types.ts:184-185`；`llm-deepseek/src/translate.ts:36` 把 DeepSeek 的 `prompt_cache_hit_tokens` 映射为 `cacheReadTokens` | **缓存命中率真实可测** |
| `nodes: MeterSurfaceNode[]` | `token-meter/src/index.ts:189` | **逐节点价格**：知道上下文中每一块花了多少 token |
| 已注册的 `tokenUsage` / `contextPressure` / `contextBreakdown` 会话投影 | `token-meter/src/index.ts:114-116` | 直接读会话的上下文压力，**不必自己算** |

`measure()` 的节点集"总是描述当前会话表面"（`:138-140`），每次调用克隆那些位置节点，测量是 O(surface)。

**结论：上下文优化不需要猜，可以建立在真实测量上。** 这否定了 v2 的"静态硬上限"——上限曾是唯一选择，是因为我以为无法测量。

### 1.5 事实 E — 宿主具备热重载，且等待 disposer 收敛

| 环节 | 实现 | 证据 |
|---|---|---|
| 开关 → 文件 | 写 `cordis.patch.yml` 的 `disabled` | `plugin-manager/src/index.ts:430`；`patch.ts:36-39` |
| 文件 → 运行中生效 | `reload()` → `reconcileProfilePatches(...)` | `plugin-manager/src/index.ts:762-765` |
| 免重启判定 | `get('hmr') !== undefined ? 'applied' : 'restart-required'` | `plugin-manager/src/index.ts:776` |
| 配置热监听 | `hmr` 监视 profile 的 `cordis.patch.yml` 与 `$DSH_HOME/cordis.patch.yml` | `hmr/src/index.ts:215,235` |
| 卸载等待收敛 | `entry.update` 后 `await` 所有旧 fiber；**旧 fiber 失败会 reject 整次 reconcile** | `app-boot/src/index.ts:289-299` |

→ **H-1：`dispose` 绝不抛异常。** 否则用户点开关时 UI 报错、配置写了却没生效。

### 1.6 事实 F — 系统提示分为"静态段"与"易变运行时上下文快照"

```ts
// packages/core/system-prompt/src/index.ts
SECTION_ORDERS   // :125-159  静态段，按 order 拼接
CONTEXT_ORDERS   // :164-168  易变上下文（SANDBOX_POLICY 110 / APPROVAL_POLICY 115 / SUBAGENT_DELEGATION 120）
renderPrompt(assembly)           // :279-284  插值 {{var}}，拼接静态段
joinContextSections(sections)    // :303-307
//   → "Current runtime context. This snapshot supersedes earlier runtime-context snapshots."
```

易变内容走 `contexts`，其快照自身声明"取代此前的运行时上下文快照"。这正是放易变内容的位置；静态段应保持逐字节冻结以维持前缀缓存。

### 1.7 事实 G — 其余施工要点

| 事实 | 证据 |
|---|---|
| 宿主版本 0.1.7-rc.2 | `package.json:3` |
| 预设声明 `{id, name?, description?, order?, plugins}` | `agent-preset-registry/src/definition.ts:5-11` |
| bundle patch 声明 `dsh.bundle.patch`（字符串或有序列表） | `app-boot/src/profile.ts:58-75` |
| 相对 `name` 锚定 `ctx.baseUrl`（声明补丁文件所在目录） | `vendor/loader/src/config/tree.ts:112-128` |
| `systemPrompt.context()` 全局层对每会话生效 | `system-prompt/src/index.ts:561-576` |
| `AssembleContext.agent` 可取会话 | `agent/src/runtime-types.ts:18-23`；`Agent.session` `:168` |
| `SessionHeader.cwd` | `session/src/types.ts:105` |
| `sessionProjections.register` 签名；`apply` 必须同步、必须返回同一引用 | `session-projection/src/index.ts:48-93`、`:233-293` |
| `jobs.start` 同步返回、不阻塞回合 | `jobs/src/index.ts:100-192` |
| `dshHome` 解析顺序 | `util/home-paths/src/index.ts:87-91` |
| 无桌面通知服务（第三方 `dsh-desktop-notify` 仍在适配新版） | 全树无 notify 服务 |
| 客户端面板 / 设置页表单拿不到（预设面） | `client/modules/src/index.ts:2-8,983`；`config-editor/src/index.ts:40` |
| 工作流包改名 `-worker-thread` → `-ptc` | 提交 `35af8698c2` |
| 会话格式 V4 | `session/src/types.ts:89` |
| 技能目录注入的权威写法 | `presets/cordis.patch.yml:143-149` |

---

## 2. 自主决策（你留下的问题）

| # | 问题 | 决策 | 理由 | 被否决的替代 |
|---|---|---|---|---|
| **D1** | 认知层"打不过基线就删掉整层"的证伪承诺 | **接受，但改为分层承诺**：①每个**机制**必须在同预算下打败"关闭该机制"的自身消融 ②整层**不需要**打败"哑重试"就能存活——通用场景（生活/陪伴）没有可执行成功判据，"哑重试 + 执行式选择"基线在那里**不可用**，构不成对照 | 编程有可执行神谕，生活与情感对话没有。用编程域基线裁决通用组件是范畴错误。**但机制级消融在任何域都成立**，所以承诺保留在最有效的那一层 | ①无条件接受整层证伪（会误杀通用组件）②完全取消承诺（回到不可证伪） |
| **D2** | 向量检索 v1 保留还是砍掉 | **保留，但作为独立可关模块，并按新 schema 重建**：独立 `embedding` 表 `(memory_id, model_id, dim, revision)`，`model_id`/`dim` 非空 + CHECK；`meta` 表记录当前模型与修订；**写入时拒绝无法归属的向量** | ①你明确要求保留 ②本机已有 23GB BGE 权重 ③**但旧的那列无维度标记的 BLOB 正是"混入 256 维哈希词袋"缺陷的藏身处**——不是修它，是重建它 | 砍到 v1 之后（违背你的要求）；沿用旧列结构（保留缺陷） |
| **D3** | 三层类型化边 vs 真图谱 | **保留关联扩展（多跳），但交互式且可选**：`edge` 表三种类型化边（`supersedes`/`conflicts_with`/`derived_from`）+ 一个可选工具 `omb_relate` 让模型自己决定要不要多跳；**不建实体/关系抽取流水线**，不做自动图扩展 | 你要求"保留多跳但不强制、供 AI 选择"——这正好也是证据支持的最优形态：图谱收益集中在多跳类查询（少数），所以做成**按需拉取**而非默认路径 | 自动图扩展（把少数场景的成本摊到所有查询）；完全砍掉多跳（违背你的要求） |
| **D4** | 中文能力轴是否默认开启 | **默认关闭，且永不落盘**：能力相关观察只存在于当前会话内存与 `sessionProjections`，不写任何存储；开关默认 `false`，开启后也只在会话内生效 | ①错误成本不对称（高估用户产生自信的错误帮助）②能力估计在心理测量学里成熟，但在智能体记忆里**未被迁移、未被评估** ③"生活/陪伴"场景里对用户能力打分明确有害 | 默认开启（隐私 + 错误成本）；完全不做（你对画像深化有要求，保留为可选） |

---

## 3. 微内核架构

### 3.1 为什么内外核必须废弃

v1 内外核成立的前提是「内核加载失败不得阻塞宿主」，为此写了 `substrate/safe-state.ts`(156) + `boot.ts`(178) + `rollback.ts`(183) + `runtime/plugin.ts` 的启动闸门。DSH 0.1.7 自己处理加载失败后，**这个前提消失了**。

更关键：你的要求「单一功能开关不得影响其他功能与既有会话」与**分层内核本身冲突**——内核状态坏了会连坐所有模块。微内核相反：内核小到几乎不可能坏，模块之间无依赖边。

### 3.2 微内核职责（穷举，不得扩张）

| 职责 | 说明 | 不做什么 |
|---|---|---|
| 服务注册 | 模块注册命名服务，解析依赖 | 不实现任何服务 |
| 事件总线 | 模块间唯一通信方式 | 不做事件持久化 |
| 模块生命周期 | `setup`/`start`/`stop`/`dispose`，依赖拓扑排序 | 不做业务逻辑 |
| 配置校验 | 按 schema 校验，失败给精确路径 | 不提供缺省值之外的决策 |
| 资源槽 | 预算（token/时间/次数）统一分配与回收 | 不做预算策略 |
| 健康面 | 聚合模块 `health()`，产出状态面数据 | 不做修复 |
| 回合钩子 | 把宿主回合边界转发给订阅模块 | 不实现回合逻辑 |
| 度量桥 | 把宿主 `tokenMeter.measure()` 与会话投影暴露给模块 | **不重复实现计量** |
| 日志/时钟端口 | 注入，便于测试 | — |

**内核代码预算 ≤350 行。** 超出即设计错误，必须把逻辑移入模块。

### 3.3 微内核 ABI

```ts
// kernel/abi/manifest.ts
export interface ModuleManifest {
  readonly id: string                       // = cordis.patch.yml 行 id = 插件页开关
  readonly version: string
  readonly requires: readonly string[]
  readonly optional?: readonly string[]
  readonly capabilities: readonly string[]
  readonly configSchema: ZodType            // 缺省值必须完整
  readonly health: () => Promise<ModuleHealth>
}

export interface ModuleHealth {
  readonly state: 'ok' | 'degraded' | 'failed'
  readonly detail: string                   // 必须写明原因（无空降级）
  readonly metrics?: Readonly<Record<string, number>>
}
```

```ts
// kernel/abi/kernel.ts
export interface Kernel {
  provide<T>(name: string, service: T): () => void
  /** 缺失返回 undefined，不抛（热插拔基础） */
  service<T>(name: string): T | undefined
  emit<E extends keyof ModuleEvents>(e: E, p: ModuleEvents[E]): void
  on<E extends keyof ModuleEvents>(e: E, fn: (p: ModuleEvents[E]) => void): () => void
  budget(kind: BudgetKind, amount: number): BudgetGrant | undefined
  report(health: ModuleHealth): void
  /** 度量桥：读当前会话的上下文压力与逐节点价格（宿主 tokenMeter） */
  readonly pressure: (session: SessionRef) => ContextPressure
  readonly logger: Logger
  readonly clock: Clock
}

/** 软压力，不是硬上限（§6.3） */
export interface ContextPressure {
  readonly totalTokens: number
  /** 已用 / 该路由可用窗口；宿主未声明窗口时为 undefined */
  readonly fillRatio?: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  /** 逐节点 token 价格，供模块决定注入什么最划算 */
  readonly nodes: readonly { readonly name: string; readonly tokens: number }[]
}
```

**关键不变量（CI 静态断言）：**

1. 模块**只能**经 `Kernel` 通信——禁止 import 其他模块的文件
2. `service()` 缺失返回 `undefined` 而不抛
3. 所有注册走 `ctx.effect`——热插拔自动回收
4. **`dispose` 绝不抛异常**（事实 E）
5. 内核目录不得出现思维链/记忆/检索/画像类符号
6. 模块不得自己实现 token 计量——一律走 `pressure`

### 3.4 模块清单（每能力一行 = 一个开关）

按你的要求，功能内部也模块化。**每行独立可开关，关闭不影响其余。**

| 行 id | 模块 | 默认 | 提供 |
|---|---|---|---|
| `omb-kernel` | 微内核 | 启用 | 服务/事件/生命周期/配置/度量桥/健康 |
| `omb-memory` | 记忆库 | 启用 | 双库存储、检索、整合、生命周期 |
| `omb-memory-vector` | 向量通道 | 启用 | 语义召回（可关 → 纯词法仍完整可用） |
| `omb-memory-graph` | 关联扩展 | 启用 | 多跳关联（**交互式，供 AI 选择**，不自动扩展） |
| `omb-memory-multiquery` | 多查询改写 | **关闭** | 一次查询改写成 N 条并行检索 |
| `omb-profile` | 用户画像 | 启用 | 显式条目读写（能力轴默认关闭且不落盘，见 D4） |
| `omb-reasoning` | 思维链质量 | 启用 | 方法论规则卡 + 推理深度自控 + 循环检测 |
| `omb-context` | 上下文优化 | 启用 | 软压力塑形、拉取式视图、注入裁决、度量 |
| `omb-artifact` | 制品索引 | 启用 | 制品索引（不注入清单，按需拉） |
| `omb-notify` | 通知桥 | 启用 | 探测外部 `desktopNotify`，未装则静默 |
| `preset-omb` | 大肥鱼模式预设 | 启用 | persona + 标准工具面（内部零 OMB 行） |

**依赖是树**：除 `omb-*-memory-*` 三行依赖 `omb-memory` 外，其余模块只依赖内核，彼此经事件通信。

### 3.5 目录结构

```
<仓库根>/
├── package.json / cordis.patch.yml / tsconfig*.json / eslint.config.mjs
├── kernel/                       微内核（唯一无业务逻辑处，≤350 行）
│   ├── abi/ · registry.ts · bus.ts · budget.ts · status.ts · meter.ts
├── modules/                      每模块自包含；logic.ts 是纯函数（零 I/O）
│   ├── memory/{manifest,logic,store,retrieve,consolidate,graph,vector,multiquery,index}.ts
│   ├── profile/ · reasoning/ · context/ · artifact/ · notify/
├── dsh/                          唯一宿主边界层（唯一 import @deepseek-ai/*）
│   ├── host.ts · tools/ · prompt/ · projections.ts · hooks.ts
├── skills/omb-runtime/SKILL.md
└── tests/{kernel,modules,dsh,e2e}
```

**分层规则**：`kernel/` 不得 import `modules/`、`dsh/`；`modules/<a>/` 不得 import `modules/<b>/`；`dsh/` 是唯一接触 `@deepseek-ai/*` 运行时的层；`modules/*/logic.ts` 零 I/O。

---

## 4. 组件一：思维链质量层

### 4.1 它是什么，不是什么

**是**：一个针对**推理过程本身**的质量控制层——让思维链在**该长的时候长、该短的时候短、不重复、不空转、不编造、能收敛**。

**不是**：
- 不是策略选择器（旧 Governor 的静态查表）
- 不是候选生成器（旧 Generator）
- 不是世界观对象（旧 World/Self Model）
- 不是哲学语义层（**本版明确移除全部哲学术语**）
- 不接管 Agent Loop（DSH 硬约束，`docs/cookbook/extension-cookbook.md:100`）

### 4.2 方法论如何"贯彻"而不是"表述"

你的要求是：把方法论做进机制里，而不是让 LLM 去理解哲学术语。做法是**三层落地**：

| 层 | 做法 | 为什么不是术语 |
|---|---|---|
| **可执行规则** | 八条规则写成人称中性的操作动词（"列出≥2个互斥方案"而不是"分析矛盾的两个方面"） | LLM 执行的是动作，不是解释概念 |
| **可观测状态** | 规则触发与结果都变成会话内状态（循环计数、未验证分支数、已收敛标志） | 状态可被测量、被消融；术语不可 |
| **按需拉取** | 规则不是每轮全文注入——模型用一个工具自取它当下需要的规则卡 | 避免"术语墙"占上下文，也避免固定投影的浪费 |

**这是本版与 v2 最本质的差别**：v2 把认识论原理映射成机制，但机制里仍留着原理的词汇与结构；v3 只保留**动作**，并由模型按需取用。

### 4.3 八条方法论规则（通用，领域中立）

每条都是**动作**，且都能被观测。中列是**模型实际看到的措辞**。

| # | 模型实际看到的措辞 | 通用性理由 | 可观测判据 |
|---|---|---|---|
| **R1 匹配深度** | "先判断这个问题需要多少推理：简单确认/闲聊/事实问答 → 直接回答；需要推导/多方案权衡/信息不全 → 展开推理。不要为容易的问题展开长篇推理，也不要用一句话回答复杂问题。" | 任何域都成立；简单问候与情感陪伴不需要长链 | `reasoningTokens` 分布 vs 任务复杂度；**过度推理率** |

> **本表是蓝图，不是现状。** 规则卡的**真源是代码**：`modules/reasoning/methods.ts`。
> 施工与后续去粗之后，R2/R3/R5/R7/R8 的措辞已与上表不同（例如 R3 去掉了 `**` 强调符——
> 提示词不渲染 markdown；R2 的"先解决这个"改成了"先向用户问清楚"；R5 与 R7 的职责
> 重新划开）。**改文案请改代码**，不要照本表改；本表保留是为了留下"当初为什么这么设计"
> 的理由（第三列的通用性理由与第四列的可观测判据仍然有效）。
| **R2 先立判据** | "在推理前先明确：什么样的结果算解决了这个问题？如果说不清，先解决这个。" | 编程（测试）与生活（用户满意/情绪缓解）都有判据，只是形式不同 | 判据缺失时的澄清率；"做完才发现理解错"的比例 |
| **R3 备选再收敛** | "在确定方案前，列出至少两个**互斥**的可能解释或做法，然后说明为什么选这一个。**但不要为凑数列假备选**——只有一个合理解释时直接说。" | 通用：诊断、建议、人际判断都需要防过早收敛 | **过早收敛率**：首轮锁定单一方案且后续被迫推翻的比例 |
| **R4 结论可检验** | "每个关键结论要能回答：如果它错了，会看到什么不一样？说不出来的结论，标成'待确认'而不是断言。" | 通用；生活场景同样适用（"他大概是这个意思"→ 可验证的问法） | **待确认标记率**（应 >0；=0 说明在猜） |
| **R5 锚定具体** | "推理要挂在具体事实上：用户原话、文件行号、命令输出、约定。不要用'通常''一般来说'代替你没核实的东西。" | 通用 | 抽象断言占比；被后续证据推翻的断言数 |
| **R6 失败即换向** | "同一个方向连续失败两次，就不再重试第三次。停下来，说明为什么这个方向不行，换一个方向或问用户。" | 通用：编程、谈判、安慰方式都适用 | 第 3 次重复尝试的次数（应→0）；换向后成功率 |
| **R7 不编造** | "不知道就说不知道，不确定就标不确定。**编造一个看起来合理的答案比说'我不确定'代价更高。**" | 通用 | 幻觉率（人工抽查或后续证据推翻率代理） |
| **R8 冲突只呈现** | "发现信息互相矛盾（用户前后不一致、文档与代码不符、两个来源冲突）时，**把冲突摆出来**，不要静默选一个。" | 通用；且用户会自相矛盾，静默裁决是更坏的行为 | 冲突呈现率；静默覆盖次数（应 = 0） |

**注入策略**：不是每轮注入全部八条。只注入一条 **≤120 字符的常驻提示**（说明有规则卡可用 + 何时用），规则全文由模型经 `omb_method` 工具按需拉取。理由见 §6.4。

### 4.4 推理深度自控（"不过长不过短"的落地）

研究里的对应结论是**长度-准确率单峰非单调**（存在最优长度，超过则变差），且**模型对"我需不需要更多推理"的自省不可靠**。所以：

**不由我们决定深度，而是把深度做成模型可控的显式状态：**

```ts
// 模型可调用的工具
omb_focus({ depth: 'quick' | 'standard' | 'deep', reason: string })
```

| 档位 | 投影行为 |
|---|---|
| `quick` | 注入"本轮不要展开，直接回答"（抑制过度推理） |
| `standard` | 默认 |
| `deep` | 注入 R3/R4/R5 全文（强制展开备选与可检验性） |

**我们只做两件事**：①把深度选择变成一次**显式动作**（模型对自己的推理预算做元认知决策）②**测量它**（`reasoningTokens` 按 depth 分层统计）。

**自调离线**：若 `quick` 档成功率不降，则默认档可下移；若 `deep` 档成功率不升，则说明该规则卡无效 → 删除该卡。

**这就是"不过长不过短"的可操作形式**：不是我们规定长度，而是给模型一个可观测的旋钮 + 一个能证伪该旋钮是否有用的账本。

### 4.5 循环与空转检测（唯一需要"计算"的部分）

模型自己看不见"我已经绕了三圈"。这一项**只能由外部提供**，因此它是本组件唯一带状态的机制：

```ts
// modules/reasoning/logic.ts（纯函数）
export interface LoopSignal {
  readonly kind: 'repeat-action' | 'no-new-evidence' | 'oscillation' | 'stalled'
  readonly detail: string
  /** 注入给模型的一句话提示（≤80 字符） */
  readonly hint: string
}

export function detectLoop(recent: readonly TurnFingerprint[]): LoopSignal | null
```

指纹 = 动作哈希（工具名 + 参数摘要）与证据哈希（新增的可观察事实）。四类信号：

- `repeat-action`：连续两次相同动作+参数 → "这一步刚做过"
- `no-new-evidence`：连续 k 轮没有新增证据 → "在原地打转，换个方向"
- `oscillation`：A→B→A→B → "在两种做法之间来回，需要第三个选项"
- `stalled`：同一意图被反复表达但无进展 → "先确认目标是否理解一致"

**这是通用的**：编程（重复同一命令）、生活建议（重复同一套说辞）、情感陪伴（反复给同一个安慰）都是同一现象。

### 4.6 与上下文优化的分工（你要求"配合使用"）

| | 思维链质量层 | 上下文优化组件 |
|---|---|---|
| 关注 | **推理过程**（长度、收敛、重复、编造） | **注入内容**（什么进上下文、多少、何时） |
| 输出 | 规则卡、深度档位、循环提示 | 压力塑形、拉取式视图、注入裁决 |
| 度量 | `reasoningTokens` / 轮次 / 过早收敛率 | `totalTokens` / 缓存命中率 / 拉取次数 |
| **接口** | 思维链层**声明需要什么**（如"deep 档需要 R3/R4/R5 全文"），上下文层**决定是否与如何给** | |

这个接口是**反向**的：不是上下文层猜思维链需要什么，而是思维链层提出需求、上下文层裁决。这消除了一类常见耦合失败（上下文层塞入"可能有用"的东西）。

### 4.7 明确删除的非通用冗余

| 删除项 | 为什么是"针对某个细节"的 |
|---|---|
| **派生检验义务**（修复必须附带新检验） | 只在可执行域成立；生活/陪伴场景没有"检验" |
| **执行证据台账的强制化** | 同上；保留为**可选记账**（工程域有用），不做强制门 |
| **瓶颈选择靠干预** | 编程的失败依赖结构在生活场景无对等物 |
| **"矛盾"术语与四类矛盾分类** | 术语化；内核（R3 备选 + R8 冲突呈现）已保留为通用动作 |
| **世界模型 / 自我模型对象** | 无决策读取的状态；其内容归为记忆的 `kind` |
| **Intent ABI + 能力代理** | 塌缩为工具 schema 与权限检查，无独立价值 |
| **定时反思** | 自我生成的反馈不可靠；反思只在有**新外部证据**时才有意义，已并入 R6 |

---

## 5. 组件二：记忆库

### 5.1 统辖原则

文献里**最大的已测风险不是漏记，而是注入错误或有损的上下文**。因此：精度优先于召回 · 逐字优先于抽取 · 可逆优先于破坏性。

证据链：Retrieval Helps or Hurts?(NAACL 2024) · Lost in the Noise(ICLR 2026) · The First Drop of Ink(ICML 2026) · Fidelity Before Structure · When Not to Write Memory(IEEE)。

### 5.2 数据模型

```sql
-- 节点：一条记忆
memory(
  id, scope, kind, text, content_hash,
  source_ref NOT NULL,          -- 会话/轮次/文件/命令；投毒防御与证据独立的必要条件
  asserted_by,                  -- user | model | execution
  observed_at, valid_to, superseded_by,
  last_used_at, use_count,
  project
)

-- 边：三种类型，没有权重
edge(from_id, to_id, type, created_at)
--  type ∈ supersedes | conflicts_with | derived_from
--  ⚠️ 无 weight 字段：未归一化的边权 = 和融合缺陷同一类量纲不可比错误。边是布尔事实

-- 向量：独立表，可归属、可重建（D2）
embedding(memory_id, model_id NOT NULL, dim NOT NULL, revision NOT NULL, vector,
          CHECK(dim > 0))

-- 元数据
meta(schema_version, embedding_model_id, embedding_dim, embedding_revision)
```

**字段的依据（不是习惯）：**

| 字段 | 依据 |
|---|---|
| `text` 逐字 | **Fidelity Before Structure：受控消融，标题即结论——逐字块胜过有损的 artifact 抽取。** ⚠️ 这直接否定旧设计"抽取结构化事实再存储"的核心假设 |
| `source_ref` 非空 | 投毒防御（Memory Poisoning 论文）+ 证据独立性（When Not to Write Memory） |
| `asserted_by` | **可检验的**置信度替代品。旧设计用 0~1 浮点 confidence，而**没有证据表明 LLM 输出的标量置信度是校准的**——一个未校准的浮点数是"与决策相关的谎言" |
| `observed_at` + `valid_to` | 时序化。旧设计只有 `created`/`updated`，**无法回答"这条结论在三月是否成立"** |
| `superseded_by` | 非破坏性更正；投毒可撤销性；"我当时相信什么" |
| 三种边 | 只有时间/冲突边立刻回本——它们回答扁平检索**结构上无法回答**的问题 |

**诚实标注：`valid_to` 在检测到矛盾之前永远是 NULL**，因为没有任何东西知道一个事实何时停止为真。→ **为机制留预算，不要为数据留预算。**

### 5.3 双库（跨项目 / 跨会话）

```
$DSH_HOME/.omb/memory/          ← 跨项目
├── knowledge.db                长期结论、显式偏好、约束
├── knowledge.db-wal
└── README.md

<cwd>/.omb/memory/              ← 跨会话（本项目 / 本话题）
├── session.db                  情境记录、经验、项目相关结论
├── session.db-wal
└── README.md
```

**路径解析**：用户根 = `ctx.get('profileContext')?.dshHome` → `$DSH_HOME` → `~/.dsh`（`util/home-paths/src/index.ts:87-91`）；项目根 = `AssembleContext.agent.session.header.cwd`（`agent/src/runtime-types.ts:18-23`、`session/src/types.ts:105`）→ 回退 `ctx.get('workspace')` → 回退 `process.cwd()`。目录不存在时自动创建。

**保留双库的真正理由是删除语义**：用户库作为独立物理工件，让"删除关于我的一切"变成一次文件操作，而不是一个可能出错的查询。检索侧论证弱（两个库时固定配额足够）。

**写入路由**：按 `kind` + 显式覆盖决定去向；两个库各自校验，向错误的库写错类型**直接拒绝**（不静默接受）。

### 5.4 检索（默认路径）

```
① 门控     先决定【要不要检索】。"不需要记忆"是合法的一等结果
② 扇出     两个库都查，**绝不短路**（修掉"首个非空即停"）
③ 词法为主 FTS5/BM25；**禁止跨通道分数算术**
④ 排名融合 若第二通道存在 → RRF（k=60，可配置）
⑤ 每库配额 防一个库饿死另一个
⑥ 上限+重排 硬候选上限，可选廉价重排 top-20 → top-5
⑦ 返回     逐字文本 + source_ref + observed_at（消费者免费获得溯源）
```

**RRF 的意义**：它只用排名 ⇒ 天然无量纲、天然与候选池大小无关。**旧的两个缺陷（排名归一值 + 原始余弦相加；评分除以池大小）因此是【消解】而不是【被修】。**

⚠️ **k=60 是惯例默认值，不是最优值**——我无法引证其原始依据，因此暴露为配置项，不作为承重设计。

**明确不在默认路径**：HyDE、多查询扩展、LLM 重排、学习式融合——都往热路径加一次 LLM 调用，收益未证。多查询改写作为**独立可开模块**（`omb-memory-multiquery`，默认关闭）。

### 5.5 关联扩展（多跳）—— 按你的要求保留，但交互式

你要求"保留多跳但不强制、供 AI 选择"。这正好也是证据支持的最优形态：**图谱收益集中在多跳类查询（少数）**，所以做成按需拉取而非默认路径。

```ts
// 模型可调用的工具
omb_relate({ id, depth?: 1|2, types?: ['supersedes','conflicts_with','derived_from'] })
// 返回 { nodes: [...], edges: [...], why: '...' }
```

- `omb-memory-graph` 模块关闭 → **该工具不注册**（模型看不到它，也不会去调）
- **不做实体/关系抽取流水线**：抽取有损（Fidelity Before Structure），而 KET-RAG 这篇 KDD 论文的贡献正是"让图索引更便宜"，说明朴素图索引太贵
- 三种边**已经是一张图**，只是很小且带类型；前向兼容真正的图谱

### 5.6 写入与整合

**准入（启发式，精度优先）**：写，当且仅当 ①用户显式陈述 ②可由具体工件复现 ③被执行结果确认。否则弃权，**并记录每一次弃权**以审计漏记率。

⚠️ **准入不是相似度阈值。必须评估证据的独立性**——`When Not to Write Memory`(IEEE) 命名了「相关性痕迹导致的假晋升」：智能体第二次看到同一件错事，是因为它自己第一次写下了它。**独立性只能在离线计算**，在线时你还看不到第二条痕迹是回响。

**在线**：只插入。不合并、不调 LLM、不摘要。完整溯源随行。

**离线批处理**（由宿主回合边界触发，跑在 `ctx.jobs.start()`，不阻塞回合）：
1. 精确去重 by `content_hash`；近重复用哈希分块生成候选 —— **绝不 all-pairs**（修掉二次方合并）
2. 回响检测：若 N 条痕迹同源，塌缩为一条并计 `use_count`
3. 矛盾：发 `conflicts_with` 边；当新条目是 `user` 或 `execution` 断言时发 `supersedes`
4. **衰减排序，不衰减行** —— 不删除（隐私除外）

### 5.7 向量通道（模块化，按你的要求保留）

- 独立模块 `omb-memory-vector`，可关 → 系统退化为**完整的纯词法版本**
- 独立 `embedding` 表，`model_id`/`dim`/`revision` 非空 + CHECK；**写入时拒绝无法归属的向量**
- 不可归属的向量不可用于搜索，因此在写入时就被拒绝——从结构上消灭旧缺陷
- 换模型时：`meta` 表记录当前模型；"哪些向量已陈旧"是一个**查询**，不是一次事故

⚠️ 诚实标注：证据方向对"保留向量"并不友好（一篇预印本报告 BM25-only 在 LoCoMo 上领先；另一项研究称交叉编码器是"占主导的、无向量的杠杆"），且你的 BGE-small-zh 是**纯中文**模型而语料是中英混合——弱点正好落在 BM25 最强的地方。**但你明确要求保留，所以我保留它并把它做成可关、可重建、可归属的。**

### 5.8 用户画像

- 只存**显式**陈述 + 用户可编辑
- 显式声明获得推断**结构上无法覆盖**的优先级 —— 不是更高的权重，是**不同的来源等级**。权重会被聚合投票压过去，等级不会
- 冲突**只呈现不裁决**（用户会自相矛盾，静默选一个是更坏的行为）
- **能力轴默认关闭且永不落盘**（D4）
- 物理上独立成工件，使「删除关于我的记忆」是一次文件操作

---

## 6. 组件三：上下文优化

### 6.1 上一版的问题

v2 的设计是：前缀稳定布局 + 准入控制 + 使用台账 + **静态硬上限**。前三条被证据支持，第四条——**硬上限**——是"因为无法测量所以只能设上限"的产物。

**事实 D 改变了这一点**：宿主暴露 `measure()`，给出 `totalTokens`、`surfaceDeltaTokens`、`surfaceTokens`、**逐节点价格**，以及 `cacheReadTokens`/`cacheWriteTokens`/`reasoningTokens`。所以我以为只能设上限的地方，其实可以**测量并塑形**。

### 6.2 统辖原则

宿主已经优化**体量**（按字符阈值裁剪、溢出存储、压缩、图像外置）。插件没被使用的杠杆是：

1. **准入**（到底要不要注入）—— 宿主不做
2. **布局**（前缀稳定，为了缓存）
3. **归因**（注入的东西到底被用了没有）
4. **塑形**（按测得的压力调整行为，而不是设死上限）—— 来自事实 D

### 6.3 软压力塑形（取代硬上限）

**没有每回合硬性 token 上限。** 改为三档压力响应，档位由 `fillRatio`（已用 / 可用窗口）与**本轮增量**共同决定：

| 压力档 | 触发（示意，实际阈值从测量标定） | 行为 |
|---|---|---|
| **宽松** | `fillRatio < 0.3` | **不做任何注入裁决**。规则卡按需给，记忆按需拉。不主动推任何东西 |
| **适中** | `0.3 ≤ fillRatio < 0.6` | **按边际价值排序**只推最有价值的一条；其余留给模型自己拉 |
| **紧张** | `fillRatio ≥ 0.6` | 只保留**索引视图**（"有什么可用"），内容全部转为工具拉取；并主动提示模型当前上下文紧张 |

关键设计点：

- 档位是**行为切换**，不是**丢弃**。任何被推迟的东西仍可通过工具取回——**有恢复路径**，因此不会有静默信息丢失
- 阈值**从测量标定**，不手写。标定方法：观察 `fillRatio` 与"本轮是否出错/是否重复劳动"的关系，找拐点
- 压力回落到宽松档时**不主动补回**已省略的内容（避免抖动与缓存失效）

### 6.4 拉取式上下文（本版的核心思路）

旧设计是**推送**：每轮把"可能有用"的东西算好塞进去。已知问题：①无关内容会主动降低准确率 ②未使用的内容是纯浪费 ③变动的前缀会破坏缓存。

新设计是**拉取**：默认不推，把可用内容的**索引**变得极其廉价，让模型自己决定拉什么。

| 视图（工具） | 返回 | 何时用 |
|---|---|---|
| `omb_recall(query)` | 记忆检索结果（逐字 + 溯源） | 模型判断需要历史 |
| `omb_relate(id)` | 关联链（多跳，§5.5） | 模型判断需要上下游 |
| `omb_files()` | 制品索引（路径/类型/时间，**不含内容**） | 模型需要找文件 |
| `omb_method(topic)` | 方法论规则卡全文（§4.3） | 模型判断需要方法指导 |
| `omb_focus(depth)` | 设定推理深度档位（§4.4） | 模型判断需要更多/更少思考 |

**每轮只常驻一条 ≤120 字符的提示**，说明这些工具存在以及何时该用。其余全部按需。

**为什么这是范式变化而不是微调**：它把上下文从**我们填的容器**变成**模型管理的资源**。三条收益同时成立：

1. **精度**——不推无关内容（避开"无关上下文主动降低准确率"这一已测风险）
2. **缓存**——常驻前缀极小且冻结
3. **可归因**——每次注入都是模型的一次**显式动作**，因此"用了没有"是**已知的**，不需要事后推断

**它同时解决了使用台账的归因问题**：拉取式设计下，"注入了但没被使用"这个类别**不存在**——因为每次注入都是一次显式拉取。使用台账退化为**拉取计数**（一个廉价计数器），而不是需要推断的归因问题。

### 6.5 前缀稳定布局

```
[冻结的 persona + 冻结的规则常驻提示 + 冻结的工具 schema]
        ↓ 以上必须逐字节稳定，跨轮不变
[会话稳定的内容（如有）：本项目约定、显式偏好]      ← 由 §6.7 的裁决决定是否放这里
        ↓
[回合易变内容]  ← 走宿主的 systemPrompt.context()（事实 F）
```

- 易变内容走 `contexts`（宿主为该用途准备的位置，其快照自带"取代此前快照"语义）
- 静态段保持逐字节冻结：无时间戳、无计数器、无重排序
- **证伪**：按轮读 `cacheReadTokens` / `cacheWriteTokens`；若命中率与「每解决一个任务的成本」相对旧布局无改善 → 删除该布局

### 6.6 测量驱动自调

有了事实 D 的量，组件可以自己标定自己：

| 量 | 用途 |
|---|---|
| `cacheReadTokens / (cacheRead + cacheWrite)` | 前缀稳定性的健康度 |
| `reasoningTokens` 按 depth 档位分层 | §4.4 的深度旋钮是否有效 |
| `nodes[].tokens` | 哪一块最贵；贵的块是否值得 |
| `totalTokens` / 可用窗口 = `fillRatio` | §6.3 的压力档位 |
| 拉取次数 / 轮次 | 拉取式设计是否被真的使用（若长期趋近 0 → 模型不用工具 → 删除对应视图） |

**自调离线**：运行时只记账，参数调整在维护期做，避免运行时抖动。

### 6.7 注入裁决（在压力档位允许推的时候）

```ts
// modules/context/logic.ts（纯函数）
export function marginalValue(
  candidate: Candidate,
  alreadyPresent: readonly Candidate[],
  focus: FocusState,
): number {
  const relevance = relevanceTo(candidate, focus)
  const novelty = 1 - maxSimilarity(candidate, alreadyPresent)   // 关键
  const cost = candidate.tokens
  return (relevance * novelty) / Math.max(cost, 1)               // 单位 token 的边际价值
}
```

**`novelty` 是关键**：旧设计只看单条相关性，导致注入 5 条说同一件事的记忆。这是浪费的主要来源。

- `cost` 来自**真实测量**（`nodes[].tokens`），不是估算
- 硬候选上限仍然存在（作为安全阀），但**不是每回合的 token 上限**——它是"一次最多考虑几个候选"

### 6.8 明确不做

| 不做 | 理由 |
|---|---|
| **每回合硬性 token 上限** | 你的明确要求；且硬上限在信息不足时造成静默损失，软塑形不会（有恢复路径） |
| **注入内容的压缩** | ①重复宿主的压缩 ②多一次模型调用 ③有不可恢复的信息丢失风险 ④**Token 削减 ≠ 成本削减**（API 式编码智能体的端到端实证）⑤缓存前缀本已深度折扣 |
| 任何 KV cache 机制 | 引擎职责；且在**推理**而非困惑度上的评估显示压缩可疑；【模拟】它（丢会话中段轮次来"驱逐"）是无声、有损、不可审计的 |
| 位置黑客（"关键内容总放最后"） | 位置效应跨模型/跨长度不稳定，且与缓存友好排序冲突。**冲突时缓存排序胜**（缓存排序按美元可测，相关性排序无法可靠测量） |
| 学习式/RL 选择策略 | 没有标签、没有反事实 |
| 第二个 token 计量器 / 第二个溢出存储 / 第二个摘要器 | 宿主已有；协调而非重复 |
| 推理长度控制 | 那是调用方/推理配置的职责；我们只能影响**注入什么**与**给模型一个深度旋钮**（§4.4） |

### 6.9 构建顺序与杀死判据

1. **度量桥 + 前缀稳定布局**（事实 D 落地；立刻可证伪）
2. **拉取式视图**（`omb_recall` / `omb_relate` / `omb_files` / `omb_method` / `omb_focus`）
3. **软压力塑形**（阈值从 ① 的测量标定）
4. **注入裁决**（仅当压力档位允许推时）

**杀死判据**：
- 若拉取次数 / 轮次长期趋近 0 → 模型不用这些视图 → **删除对应视图**，不要保留"以防万一"
- 若某压力档位的行为相对"完全不做"无改善 → 删除该档位
- 若前缀布局改动的缓存命中率无改善 → 删除该布局

---

## 7. 三个组件的分工与接口

```
                 ┌──────────────────────────────┐
                 │  omb-reasoning（思维链质量） │
                 │  规则卡 · 深度档位 · 循环检测 │
                 └───────────┬──────────────────┘
                             │ ① 声明需要什么（"deep 档要 R3/R4/R5 全文"）
                             ▼
                 ┌──────────────────────────────┐
                 │  omb-context（上下文优化）   │
                 │  压力塑形 · 拉取视图 · 裁决   │
                 └───────────┬──────────────────┘
                             │ ② 决定是否与如何给
                             ▼
                 ┌──────────────────────────────┐
                 │  omb-memory（记忆库）        │
                 │  双库 · 检索 · 关联 · 画像    │
                 └──────────────────────────────┘
                             │ ③ 提供内容，带溯源
                             ▲
                             └── 模型经工具拉取（默认不推）
```

**接口是反向的**：不是上下文层猜思维链需要什么，而是思维链层**提出需求**、上下文层**裁决**。这消除了一类常见耦合失败（上下文层塞入"可能有用"的东西）。

---

## 8. 删除清单

### 8.1 整目录删除

| 路径 | 行数 | 理由 |
|---|---|---|
| `substrate/` | 4,410 | 三线版本线、只读 ACL、**启动闸门与安全状态（本版明确废弃）**、沙箱虚拟化 |
| `supervisor/` | 12,124 | 事件存储（宿主已提供 `sessionProjections`）、候选管线、晋升、维护调度、基准、验证债务 |
| `components/` | 30 | re-export 壳 |
| `runtime/` | 15,917 | 全部重写（`assembly.ts` 5,021 行） |
| `stable/` `latest/` `versions.git/` | — | 三线布局产物 |
| `tests/` | 47,369 | 随实现重写；仅移植 §11.3 的用例语义 |

### 8.2 功能级删除

| 功能 | 理由 |
|---|---|
| 内外核分层 + 启动闸门 + 安全状态 | DSH 已自行处理加载失败；且分层内核的连坐风险与"单模块开关不影响其他"直接冲突 |
| 三线版本切换 / 自迭代 / 候选晋升 / 冻结基准 / 分享对象 | 你的要求 |
| 验证契约体系（三态 + 信任阶梯 + 四库 + 债务）与修复系统 | 你未选中；且它引入 LLM judge 后需一整套信任阶梯防守循环自证 |
| 维护调度 | 你未选中；其唯一不可替代职责（整合触发）改由回合边界驱动 |
| 沙箱虚拟化（6 文件 860 行 + koffi） | 你未选中；DSH 自带宿主 sandbox |
| 仅测试引用的死模块（≈2,360 行） | 生产路径无 importer；`intent`/`operator` 是"Intent ABI"的旧死实现 |
| **Governor 静态查表** | 静态表无法表达"具体问题具体分析"；且是**未测量的策略** |
| **Generator 候选生成** | 产出无执行证伪路径的假设 |
| **World/Self Model 对象** | 无决策读取的状态；内容归为记忆的 `kind` |
| **Intent ABI + 能力代理** | 塌缩为工具 schema 与权限检查 |
| **哲学术语作为注入词汇** | 你的明确要求；内核（八条规则）已保留为动作 |
| 派生检验义务 / 执行证据强制门 / 瓶颈干预选择 | 只在编程域成立（§4.7） |
| 固定 500 token 投影 / 每回合硬性上限 | 你的明确要求；改为软塑形 + 拉取 |

### 8.3 必须保留

| 项 | 理由 |
|---|---|
| `models/bge-small-zh-v1.5/` | 权重 164MB + `.onnx_data`；你要求保留向量检索 |
| `memory/cjk-ngram.ts`（64 行） | 零 import、正确、有基准。**实测关键**：`node:sqlite` 的 SQLite **不能注册自定义 FTS5 tokenizer**，默认 `unicode61` 把连续 CJK 当一个 token，`'记忆'` 无法命中 `'长期记忆系统'` |
| `memory/staging-policy.ts`（194 行） | 纯常量 + 纯函数；`contentHash` 是去重原语 |
| `memory/embeddings.ts`（150 行） | 哈希词袋 + 余弦/序列化原语 |
| `memory/embeddings-onnx.ts`（494 行，除硬编码路径探测） | WordPiece + 模型发现 + 自检，模型无关 |
| `scripts/fetch-embedding-model.ts` | 幂等 + sha256 校验 |
| `tests/m3/` 的用例**语义** | 见 §11.3 |
| `skills/omb-runtime/SKILL.md` | 重写（删 `/mode` `/bench` `/evolve` 段，改为规则卡与工具用法） |
| `docs/architecture.md` | 重写为 v3 |

### 8.4 已记录的旧文档↔代码漂移（不得沿用）

| 旧 `architecture.md` 声称 | 实际 |
|---|---|
| §2.1/§7.4：`supervisor/{txn,activation}.ts` 是演化事务/激活路径 | 生产路径是 `candidate-pipeline.ts` 自做 git；两者**只被测试引用** |
| §2.4：Intent ABI / Broker 是"能力调用面" | 只有 `supervisor/capability.ts` 在生产路径；`runtime/{intent,broker,operator*}.ts` 等**只被测试引用** |
| `assembly.ts` 头注释「LOC budget ≤400」 | 实际 5,021 行 |

---

## 9. 实施计划

### 阶段 0 — 清空与骨架

| 步骤 | 产出 | 门禁 |
|---|---|---|
| 0.1 | 基线存档：`pnpm typecheck` / `pnpm test` | 存档存在（当前：typecheck 退出码 0；test 155 文件 / 2158 用例 / 1 预存失败 `tests/m5/maintenance.test.ts:168`，属被删路径） |
| 0.2 | 提取 §11.3 用例语义清单（含原 `path:line`） | 清单存在 |
| 0.3 | 权重迁移 `workspace/.omb/models/` → `models/`（gitignore） | 文件数不变 |
| 0.4 | 删除 §8.1/§8.2 全部内容 | `git status` 反映删除 |
| 0.5 | 建骨架 `kernel/ modules/ dsh/ tests/`；改 `tsconfig*.json`、`.gitignore` | 空骨架 typecheck 通过 |
| 0.6 | `eslint.config.mjs`：内核纯度 + 模块隔离规则 | 故意违规 → 报错 |
| 0.7 | `package.json`（`dsh.bundle.patch`）+ `cordis.patch.yml`（§10.1） | YAML 可被 `composeEntries` 解析 |

**门禁 G0**：无自迭代/三线/验证债务/启动闸门/Governor 符号；lint + typecheck 通过。

### 阶段 1 — 微内核与度量桥

| 步骤 | 产出 | 门禁 |
|---|---|---|
| 1.1 | `kernel/abi/`：清单、Kernel 接口、事件表、`ContextPressure` | ABI 契约测试 |
| 1.2 | `kernel/{registry,bus,budget,status}.ts` | **≤350 行**；依赖拓扑 + 环检测测试 |
| 1.3 | **`kernel/meter.ts`：接宿主 `tokenMeter.measure()` 与会话投影** | 能读到 `totalTokens`/`fillRatio`/`nodes`/`cacheRead` |
| 1.4 | 静态断言：内核无业务符号 | 故意加一个"检索"符号 → 断言失败 |
| 1.5 | 模块独立性矩阵测试骨架 | 空模块 × 开关组合全部正常 |

**门禁 G1**：内核 ≤350 行；度量桥能读到事实 D 的全部量。

### 阶段 2 — 记忆库

| 步骤 | 产出 | 门禁 |
|---|---|---|
| 2.1 | 迁移框架 + schema（含 `source_ref` 非空、`asserted_by`、`valid_to`、`content_hash`、`meta`） | 迁移测试：空→最新；未来版本→拒绝；失败→回滚 |
| 2.2 | `modules/memory/store.ts`：双库、FTS、`getMany` 批量（**禁 N+1**） | 查询计数断言 |
| 2.3 | `modules/memory/retrieve.ts`：门控 + 扇出 + RRF + 每库配额 | **反例测试**：①同一条记忆在不同池大小下分数稳定 ②窄库命中不遮蔽宽库 ③RRF 无量纲依赖 |
| 2.4 | `modules/memory/consolidate.ts`：去重/回响检测/矛盾/衰减 | 合并上限被遵守；`valid_to` 语义测试 |
| 2.5 | `modules/memory/vector.ts`：独立 `embedding` 表，可归属 | **拒绝无法归属的向量**有测试；关掉模块 → 纯词法仍完整可用 |
| 2.6 | `modules/memory/graph.ts`：三种边 + `omb_relate` 工具 | 多跳按需；关掉模块 → 工具不注册 |
| 2.7 | `modules/memory/multiquery.ts`（默认关闭） | 开启后行为可观测；关闭不影响其余 |
| 2.8 | `modules/profile/`：显式条目 + 冲突呈现；能力轴默认关闭且不落盘 | 显式压过推断；能力轴不写任何文件 |

**门禁 G2**：记忆端到端可用；四个可关模块各自独立开关无副作用。

### 阶段 3 — 接宿主（最小可用）

| 步骤 | 产出 | 门禁 |
|---|---|---|
| 3.1 | `dsh/host.ts`：Cordis Context → Kernel 适配 | 卸载后零残留 |
| 3.2 | `dsh/projections.ts`：`sessionProjections` 折叠单元 | **同一引用不变量 + 同步性断言** |
| 3.3 | `dsh/tools/`：`omb_status`、`omb_recall`、`omb_forget` | 每个工具**服务判空返回错误而非抛**（H-3） |
| 3.4 | `dsh/hooks.ts`：会话事件 → 内核回合钩子 | — |
| 3.5 | bundle 安装 | **A5 通过** |
| 3.6 | 冒烟：写读记忆 | **A6 通过** |

**门禁 G3**：**「插件真的活了」里程碑** —— DSH v0.1.7-rc.2 上可见、可拨、可用。

### 阶段 4 — 思维链质量层

| 步骤 | 产出 | 门禁 |
|---|---|---|
| 4.1 | 八条规则卡（文本）+ `omb_method` 工具 | 规则卡总量受控；按需拉取 |
| 4.2 | `omb_focus` 深度档位 + 投影注入 | 三档行为可观测；`reasoningTokens` 分层记账 |
| 4.3 | `modules/reasoning/logic.ts`：循环/空转检测（四类信号） | 纯函数测试；四类信号各有正反例 |
| 4.4 | 常驻提示 ≤120 字符 | 字符数断言 |
| 4.5 | 消融脚本 | **A10 通过**：机制级消融（每个机制 vs 关闭该机制） |

**门禁 G4**：机制级消融数据支持每条规则卡；不支持的规则卡删除。

### 阶段 5 — 上下文优化

| 步骤 | 产出 | 门禁 |
|---|---|---|
| 5.1 | 前缀稳定布局（静态段冻结，易变走 `contexts`） | 逐字节稳定性测试 |
| 5.2 | 拉取式五视图（`recall`/`relate`/`files`/`method`/`focus`） | 每个视图可单独关闭 |
| 5.3 | 软压力三档（阈值从测量标定） | 档位切换可观测；**无硬上限**断言 |
| 5.4 | `marginalValue` 注入裁决（cost 来自真实测量） | `novelty` 项有反例测试 |
| 5.5 | 度量面板：缓存命中率 / 拉取次数 / 分层 reasoning tokens | **A9 通过** |
| 5.6 | 与宿主 pruner/spill 协调（不重复造） | 长输出被我们转成索引后宿主 pruner 无事可做 |

**门禁 G5**：拉取次数不为 0；缓存命中率有改善；无静默信息丢失（每个被推迟的内容都可取回）。

### 阶段 6 — 热插拔与收尾

| 步骤 | 产出 | 门禁 |
|---|---|---|
| 6.1 | H-1：全部 disposer 不抛 + 在飞行操作等待 | 强制 dispose 抛异常 → 测试失败 |
| 6.2 | H-2：静态断言无「apply 返回后异步注册」 | 反例测试 |
| 6.3 | 热插拔端到端 | **A7/A8 通过** |
| 6.4 | `modules/artifact/` + `modules/notify/` | 无外部服务时静默 + 状态面写明 |
| 6.5 | `preset-omb` + 工具面 | **A11 跨模式通过** |
| 6.6 | 性能：WAL checkpoint、保留策略、向量批处理让出事件循环 | 10k 条检索 < 100ms；`-wal` 不单调增长 |
| 6.7 | 重写 `docs/architecture.md`（每条断言带 `path:line`） | 文档-代码一致性测试 |
| 6.8 | 重写 `README.md` / `THIRD-PARTY-NOTICES.md` | — |
| 6.9 | 按 §13.5 收尾文档：本文长期保留，`architecture.md` 转为事实描述 | 两份文档分工明确、无重复断言 |

**门禁 G6**：A1-A12 全绿。

---

## 10. 宿主集成

### 10.1 YAML 骨架

```yaml
# cordis.patch.yml —— profile 根层，一行一个开关
- insert:
    # ── 微内核（必需）──────────────────────────────────────
    - id: omb-kernel
      name: 'oh-my-bigbluefish/dsh/kernel.js'
      config: { debug: false }

    # ── 记忆库 + 三个可关子能力 ────────────────────────────
    - id: omb-memory
      name: 'oh-my-bigbluefish/dsh/module-memory.js'
      config:
        consolidationEveryTurns: 32
        embeddingThreads: 2
    - id: omb-memory-vector
      name: 'oh-my-bigbluefish/dsh/module-memory-vector.js'
    - id: omb-memory-graph
      name: 'oh-my-bigbluefish/dsh/module-memory-graph.js'
    - id: omb-memory-multiquery
      name: 'oh-my-bigbluefish/dsh/module-memory-multiquery.js'
      disabled: true                    # 默认关闭；打开后多查询并行检索

    # ── 用户画像 ───────────────────────────────────────────
    - id: omb-profile
      name: 'oh-my-bigbluefish/dsh/module-profile.js'
      config:
        inferCapabilityAxis: false      # 默认关闭；且永不落盘（D4）

    # ── 思维链质量层 ───────────────────────────────────────
    - id: omb-reasoning
      name: 'oh-my-bigbluefish/dsh/module-reasoning.js'
      config:
        defaultDepth: standard
        residentHintChars: 120          # 常驻提示上限

    # ── 上下文优化 ─────────────────────────────────────────
    - id: omb-context
      name: 'oh-my-bigbluefish/dsh/module-context.js'
      config:
        pressureBands: [0.3, 0.6]       # 软档位；从测量标定
        candidateConsiderLimit: 12      # 一次最多考虑几个候选（不是每回合 token 上限）

    # ── 制品 / 通知 ────────────────────────────────────────
    - id: omb-artifact
      name: 'oh-my-bigbluefish/dsh/module-artifact.js'
    - id: omb-notify
      name: 'oh-my-bigbluefish/dsh/module-notify.js'

    # ── 大肥鱼模式预设（内部零 OMB 行）──────────────────────
    - id: preset-omb
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: omb
        name: 大肥鱼模式
        description: OMB v3 通用认知增强（思维链质量 / 记忆 / 上下文优化）
        order: 10
        plugins:
          # persona + 逐行抄自 DSH 自带 standard 预设的工具面
          # （packages/bundle/web-app/presets/standard.patch.yml:20-146）
          # 逐行核对，不要凭记忆写
```

**相对路径注意**：`name` 的相对路径锚定**声明补丁文件**的 `ctx.baseUrl`（`vendor/loader/src/config/tree.ts:112-128`），不是预设目录。

### 10.2 工具面（7 个，上限 8）

| 工具 | 用途 | 所属模块（关闭即消失） |
|---|---|---|
| `omb_status` | 模块健康、存储路径与行数、度量面板、降级原因 | 内核 |
| `omb_recall` | 记忆检索（逐字 + 溯源） | `omb-memory` |
| `omb_forget` | 显式遗忘（按 id / kind / 时间窗） | `omb-memory` |
| `omb_relate` | 关联链（多跳，按需） | `omb-memory-graph` |
| `omb_method` | 方法论规则卡（按需拉取） | `omb-reasoning` |
| `omb_focus` | 设定推理深度档位 | `omb-reasoning` |
| `omb_files` | 制品索引（不含内容） | `omb-artifact` |

**工具设计规则（热插拔要求）**：每个工具执行体**第一步**判空服务，缺失时返回 `{kind:'error', text:'…模块当前已关闭…'}`，**绝不抛**。

**工具数越少越好**：模块关闭 → 工具消失 → 模型看不到也不会去调。这正是"通用性"的实现方式之一（不同场景下不同工具集）。

---

## 11. 测试策略

### 11.1 分层

| 层 | 方式 | 覆盖率 | mock |
|---|---|---|---|
| `kernel/` | 纯函数 + 拓扑 | ≥ 90% | 零 |
| `modules/*/logic.ts` | 纯函数 | ≥ 90% | 零 |
| `modules/*/{store,retrieve}.ts` | 真实 SQLite（临时文件） | ≥ 80% | 仅嵌入器可注入 |
| `dsh/` | fake 宿主端口 | ≥ 70% | 有 |
| 端到端 | 真实 DSH + 真实 bundle | 关键路径 | 无 |

**旧教训**：`tests/helpers/git.ts` 用真实 git + 真实 `icacls` 建 ACL 夹具，导致已知并行 flake 与上调超时。新系统**不用 ACL 夹具**（机制已删），只依赖临时 SQLite 与临时目录，天然可并行。

### 11.2 必须存在的测试

| 验收 | 测试 |
|---|---|
| A2 | 内核纯度静态断言（反例：故意加业务符号 → 失败） |
| A4 | 模块独立性矩阵（11 行 × 开关组合抽样） |
| A7/A8 | 热插拔端到端（§13.2） |
| A9 | 上下文度量：缓存命中率、拉取次数、无硬上限断言 |
| A10 | 机制级消融（每个机制 vs 关闭该机制） |
| A11 | 降级（移除 ONNX → 纯词法 + 原因可见） |
| 反例 | ①同一条记忆在不同池大小下分数稳定 ②窄库命中不遮蔽宽库 ③RRF 无量纲依赖 ④`valid_to` 语义 ⑤拒绝无法归属的向量 |
| H-1 | 强制 disposer 抛异常 → 测试失败（保护 `reconcileProfilePatches`） |
| H-2 | 静态断言无「apply 返回后异步注册」 |
| H-3 | 每个工具的「服务缺失返回错误而非抛」 |
| §4.5 | 循环检测四类信号各有正反例 |
| §4.3 | 八条规则卡：每条有"关闭该卡"的消融入口 |
| §5.7 | 向量模块关闭 → 纯词法路径完整可用 |
| §5.5 | 图谱模块关闭 → `omb_relate` 不注册 |
| §2.1 | 迁移：空→最新；未来版本→拒绝；中途失败→回滚且版本不变 |

### 11.3 从旧测试移植的用例语义（**不复制文件**）

| 来源 | 语义 | 去向 |
|---|---|---|
| `tests/m3/cjk-retrieval.test.ts` | CJK 子串召回；`tokenizeForFts` 边界（单字/多字/混合/非 CJK） | `tests/modules/memory/text.test.ts` |
| `tests/m3/retrieve.test.ts` | 通道降级、关系扩展衰减 | `tests/modules/memory/retrieve.test.ts`（改写为扇出 + RRF 语义） |
| `tests/m3/consolidate.test.ts` | 去重/合并/关系/衰减四步输入输出 | `tests/modules/memory/consolidate.test.ts` |
| `tests/m3/backend.test.ts` | 幂等写入、keyset 分页 | `tests/modules/memory/store.test.ts` |
| `tests/m3/vector-retrieval.test.ts` | 维度不匹配自报告、重编码幂等 | `tests/modules/memory/vector.test.ts` |
| `tests/m3/attribution.test.ts` | 引用归因的区分性 token 思路 | `tests/modules/context/extract.test.ts`（改为拉取计数） |
| `tests/m0/dag-lint.test.ts` | 分层 import 机器校验的思路 | `tests/kernel/isolation.test.ts`（改用新规则） |

### 11.4 通用性验收（你第 5 条要求）

组件必须通过**跨域**验收。任务集分四域，每域至少 10 个场景：

| 域 | 例子 | 判据 |
|---|---|---|
| **工程** | 改 bug、加功能、重构 | 可执行成功判据；`tokensPerResolved` |
| **知识工作** | 调研、写作、分析 | 人工评分；引用可追溯率 |
| **生活事务** | 行程规划、比价、日程协调 | 约束满足率；用户追问次数 |
| **情感陪伴** | 倾诉、安慰、闲聊 | **人类评分**（有用度 / 是否被理解 / 是否显得机械）；**过度推理率必须低** |

**情感陪伴是最强的通用性检验**：如果组件在那里表现出"给闲聊展开长篇推理"或"对情绪问题给出清单式建议"，则 R1（匹配深度）与拉取式设计失败。

---

## 12. 风险与缓解

| # | 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|---|
| R1 | 热插拔时 disposer 抛异常 → 开关操作失败 | 中 | 高 | H-1：CI 静态检查 + 强制抛异常的测试 |
| R2 | 思维链层**证明不了有效** | 中 | 高 | 机制级消融（D1 的分层承诺）；不达标的规则卡删除 |
| R3 | 拉取式设计**模型不用工具** → 视图形同虚设 | **中高** | 高 | 拉取次数 / 轮次是必测指标；长期趋近 0 → 删除对应视图（不要保留"以防万一"） |
| R4 | 软压力档位阈值标定不当 → 抖动 | 中 | 中 | 阈值从测量标定；压力回落时不主动补回 |
| R5 | 通用性不足：某机制只在编程域有效 | 中 | 中 | §11.4 四域验收；情感域是最强检验 |
| R6 | 删除 6 万行后失去回归能力 | 高 | 高 | §11.3 移植清单 + 逐阶段门禁 |
| R7 | 微内核扩张成第二个 `assembly.ts` | 中 | 高 | 内核 ≤350 行硬上限 + 静态断言 |
| R8 | 两个 SQLite 库并发写阻塞事件循环 | 中 | 中 | 一库一连接；`busy_timeout` 1000ms + `BEGIN IMMEDIATE`；写队列串行 |
| R9 | `sessionProjections.apply` 异步或返回新引用 → 静默丢状态 | 中 | 中 | 专门的不变量测试（同步性 + 同一引用） |
| R10 | 23GB `.onnx_data` 被误提交 | 中 | 高 | 阶段 0 就写 `.gitignore` |
| R11 | DSH 0.1.7 是 RC，接口可能再变 | 高 | 中 | `dsh/` 单层隔离；bundle manifest pin 精确 peer 版本 |
| R12 | 画像推断引发隐私不适 | 中 | 中 | 能力轴默认关闭且永不落盘；显式条目用户可编辑；用户库独立工件使删除成为文件操作 |

---

## 13. 附录

### 13.1 研究锚点与证据强度

⚠️ **必须先读这一条**：本轮三个研究代理的 `web_fetch` 均被沙箱阻断（所有域名解析到非公网 IP），因此**没有任何一篇论文被读过全文**。证据来自搜索结果的标题、URL 与片段。下表用三档标注：

- **[强]** 同行评审 + 多来源一致 + 与工程实践相符
- **[中]** 同行评审但单一来源，或预印本但有独立复述
- **[弱]** 单篇预印本 / 未复现 / 仅有片段

#### 记忆与检索

| 结论 | 出处 | 强度 |
|---|---|---|
| **逐字原文胜过抽取结构化** | [Fidelity Before Structure](https://arxiv.org/pdf/2601.00821)（受控消融，标题即结论） | [中] |
| 检索会**主动降低**准确率 | [Retrieval Helps or Hurts?](https://aclanthology.org/2024.naacl-long.308/) NAACL 2024；[Lost in the Noise](https://iclr.cc/virtual/2026/10016328) ICLR 2026；[The First Drop of Ink](https://icml.cc/virtual/2026/poster/65095) ICML 2026 | [强] |
| 无关上下文有害 | [GSM-IC](https://arxiv.org/pdf/2302.00093) ICML 2023；[The Power of Noise](http://arxiv.org/pdf/2401.14887v1) | [强] |
| **相关性痕迹导致的假晋升** | [When Not to Write Memory](https://ieeexplore.ieee.org/document/11607557/) IEEE | [中] |
| 时序知识图谱的时序化 | [Zep](https://ar5iv.labs.arxiv.org/html/2501.13956)；[Temporal Validity in Retrieval Memory](https://ar5iv.labs.arxiv.org/html/2606.26511) | [中] |
| 图谱收益集中在多跳 | [HippoRAG](https://papers.nips.cc/paper_files/paper/2024/hash/6ddc001d07ca4f319af96a3024f6dbd1-Abstract-Conference.html) NeurIPS 2024；[KET-RAG](https://dl.acm.org/doi/abs/10.1145/3711896.3737012) KDD 2025 | [中] |
| RRF 只用排名、无量纲 | [Cormack et al. SIGIR 2009](https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf) | [强]（k=60 的最优性 [弱]） |
| 长输入本身损害推理 | [Context Length Alone Hurts](https://ar5iv.labs.arxiv.org/html/2510.05381) | [中] |
| 有效窗口 < 宣称窗口 | [RULER](https://ui.adsabs.harvard.edu/abs/2024arXiv240406654H/abstract)；[NoLiMa](https://icml.cc/virtual/2025/poster/46685) ICML 2025；[HELMET](https://proceedings.iclr.cc/paper_files/paper/2025/hash/f5332c8273d02729730a9c24dec2135e-Abstract-Conference.html) ICLR 2025 | [强] |

#### 推理与不确定性

| 结论 | 出处 | 强度 |
|---|---|---|
| **无外部反馈的自我纠正会退化**（把对的改成错的） | [Huang et al.](https://arxiv.org/abs/2310.01798) ICLR 2024；[Stechly et al.](https://arxiv.org/abs/2310.12397) | [强] |
| 自我验证在规划类任务上最弱 | ICLR 2025 self-verification limitations | [中] |
| 判官偏爱自己的生成 / 位置偏置 | [Panickssery et al.](https://arxiv.org/abs/2404.13076) NeurIPS 2024；[Wang et al.](https://arxiv.org/abs/2305.17926) | [强] |
| **CoT 主要在数学/符号上有效**，其他域收益小甚至有害 | [Sprague et al.](https://arxiv.org/abs/2409.12183) ICLR 2025；[Jin & Zhang](https://arxiv.org/abs/2505.24225) | [强] |
| **长度-准确率单峰非单调**（存在最优长度） | [When More is Less](https://huggingface.co/papers/2502.07266) | [中] |
| 过度推理已被测量 | [Do NOT Think That Much for 2+3=?](https://arxiv.org/pdf/2412.21187v1) ICML 2025 | [强] |
| 计算量最优策略随预算变化 | [Snell et al.](https://arxiv.org/abs/2408.03314) ICLR 2025 | [中] |
| **重复采样提升的是覆盖率，选择才是瓶颈** | [Large Language Monkeys](https://arxiv.org/abs/2407.21787) | [中] |
| 模型自省"要不要检索"不可靠 | [Adaptive Retrieval Without Self-Knowledge](https://www.semanticscholar.org/paper/273c76c05293f1d219fb2c83443ca9901ba3adf4) | [弱] |
| 言语化置信度校准差 | [Xiong et al.](https://arxiv.org/abs/2306.13063) ICLR 2024；[Kadavath et al.](https://arxiv.org/abs/2207.05221) | [强] |
| 语义熵检测**一致性错误**无效 | [Farquhar et al., Nature 630 (2024)](https://www.nature.com/articles/s41586-024-07421-0) | [强] |
| 监测与控制应当分离 | Nelson & Narens 1990, *Metacognition: Knowing about Knowing*, MIT Press | [强]（概念） |
| 心智理论模块脆弱 | [Ullman](https://arxiv.org/abs/2302.08399) | [中] |

#### 上下文与成本

| 结论 | 出处 | 强度 |
|---|---|---|
| **前缀缓存：任何前缀变更使其后一切失效** | [Anthropic](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)、[OpenAI](https://developers.openai.com/api/docs/guides/prompt-caching)、[Gemini](https://ai.google.dev/gemini-api/docs/caching) 官方文档 | [强]（定性）；⚠️ 所有价格倍率 [弱] |
| **Token 削减 ≠ 成本削减**（端到端实证） | [Token Reduction Is Not Cost Reduction](https://arxiv.org/pdf/2607.12161) | [中] |
| 压缩可能造成**不可恢复**的证据丢失 | [Compression-Aware Abstention](https://export.arxiv.org/pdf/2608.29934) | [弱] |
| KV 压缩在**推理**上可疑 | [Hold Onto That Thought](https://ar5iv.labs.arxiv.org/html/2512.12008) NeurIPS 2025 | [中] |
| 结构保护主导评分 | [Protection Is (Nearly) All You Need](https://arxiv-org.ezproxy.obspm.fr/html/2605.18053v1) | [弱] |
| 位置效应不稳定 | [Positional Biases Shift](https://web3.arxiv.org/pdf/2508.07479)；[Do RAG Systems Really Suffer From Positional Bias?](https://aclanthology.org/2025.emnlp-main.1422/) EMNLP 2025 | [中] |
| 自适应检索（弃权分支）的价值 | [Self-RAG](https://huggingface.co/papers/2310.11511)；[Adaptive-RAG](https://browse.arxiv.org/abs/2403.14403) | [中] |
| MMR/子模选择 | [MMR 1998](https://dl.acm.org/doi/10.3115/1119089.1119120)；[PACMS](https://arxiv-org.ezproxy.obspm.fr/html/2606.20047v1) | [中]（"胜过 top-k" [弱]） |

#### 评测方法

| 结论 | 出处 | 强度 |
|---|---|---|
| 成本盲区的评测是领域已记录的缺陷 | [AI Agents That Matter](https://arxiv.org/abs/2407.01502) | [强] |
| 必须做**计算量对齐**的比较 | [AI Agents That Matter](https://arxiv.org/abs/2407.01502)；[Large Language Monkeys](https://arxiv.org/abs/2407.21787) | [强] |
| 存在性幻觉（实例记忆代替推理） | [The SWE-Bench Illusion](https://arxiv.org/pdf/2506.12286) | [中] |
| 排行榜顶部条目统计上不可区分 | [Coding Agents Have Converged](https://arxiv.org/pdf/2609.17394) | [弱] |

#### 明确**不采用**

| 方向 | 为什么 |
|---|---|
| 自迭代 / 自演化 | 你的要求删除；运行时改自身策略导致不可解释 |
| LLM-as-judge 做验证终审 | 无外部反馈的自我纠正会退化；判官偏爱自己的输出；只允许当作算力分配先验 |
| 定时/无条件反思 | 自我生成的反馈才是不可靠的那部分 |
| 固定多智能体辩论 | 辩论 = 采样 + 选择；同算力下"采样 + 执行式选择"更强且便宜 |
| 训练式过程奖励模型 | 需训练设施且可博弈；代码里执行轨迹是更便宜的步级信号 |
| 保形预测弃答门 | 只给边际覆盖保证，且要求可交换性——换域时正是它失效的地方 |
| 插件层 KV cache / 推理优化 | 能力边界之外 |
| 接管或改写 Agent Loop | DSH 硬约束（`docs/cookbook/extension-cookbook.md:100`） |
| ⚠️ **"The Inverse Scaling of Prompt Engineering"** | **这篇论文不存在**——直接检索后确认。不得引用。"脚手架收益在同算力下消失"的强版本目前**只有预印本**，没有同行评审证据 |

### 13.2 热插拔验收

| 步骤 | 期望 |
|---|---|
| 1 | 记录 DSH 进程 PID |
| 2 | 会话 A 启用 `omb-memory-graph`，用 `omb_relate` 做一次多跳 |
| 3 | 插件页关闭该模块 | ①PID 不变 ②`cordis.patch.yml` 出现 `disabled: true` ③`list_plugins` 显示 `fiberPhase: null` ④**`omb_relate` 从工具目录消失** |
| 4 | 会话 A 继续对话 | **无报错**；若模型尝试关联，得到"模块已关闭"的可读错误 |
| 5 | 重新打开 | ①PID 不变 ②会话 A 的关联状态**从折叠状态恢复** |
| 6 | 关闭 `omb-memory`（有依赖它的模块开启） | 依赖方标 `failed` 并写明原因，**会话不报错** |
| 7 | 只留 `omb-kernel` | 系统正常；`omb_status` 可用；会话不报错 |

### 13.3 通用性验收（跨四域）

见 §11.4。**情感陪伴是最强检验**：组件在那里必须表现出低推理深度、不使用清单式建议、不主动推销记忆。若做不到，R1（匹配深度）与拉取式设计需要重做。

### 13.4 术语表

| 术语 | 含义 |
|---|---|
| 微内核 | ≤350 行、无业务逻辑的内核 |
| 模块 | 一个自注册单元 = `cordis.patch.yml` 一行 = 插件页一个开关 |
| profile 根层 | 组合树的 `include` 层；**只有这一层的行在插件页可拨** |
| 思维链质量层 | 控制推理过程本身（长度/收敛/重复/编造）的组件 |
| 深度档位 | 模型可自设的推理预算档位（quick/standard/deep） |
| 拉取式上下文 | 默认不推，模型按需用工具拉 |
| 软压力塑形 | 按测得的 `fillRatio` 切换行为，不设硬上限 |
| 证据独立性 | 一个事实来自独立来源，而非第一次写入的回响 |
| 诚实降级 | 降级必须带原因且出现在 `omb_status` |

### 13.5 本文档的生命周期

- 位于 `docs/`，纳入 git 跟踪并**长期保留**
- 与 `docs/architecture.md` 的分工：本文是**施工蓝图**（含删除清单、阶段计划、研究依据、决策记录）；
  `architecture.md` 是**落地后的事实描述**（每条断言带 `path:line`）。
  重构完成后本文不删除——它记录了"为什么这样建"，而 `architecture.md` 只记录"建成了什么"。
- 后续修订直接改本文，沿用同一条提交线

---

## 14. 与前两版的关键差异（备查）

| 维度 | v2 | v3 | 为什么改 |
|---|---|---|---|
| 架构 | 微内核 + 模块 | 微内核 + 模块（更细：每能力一行） | 你要求"内部也模块化、可开关" |
| 认知层定位 | 认识论骨架（实践/矛盾/抽象） | **思维链质量层** | 你：太参考之前的；应针对思维链；不要哲学术语 |
| 认知层词汇 | 实践、矛盾、否定之否定… | **八条动作规则** | 你：哲学语义不利于 LLM，应贯彻入方法论 |
| 认知层机制数 | 4 + 1 评测台 | **3**（规则卡 / 深度档位 / 循环检测） | 你：拆分并删除非通用冗余 |
| 推理长度控制 | 未涉及 | **`omb_focus` 深度旋钮 + 分层计量** | 你：不过长不过短 |
| 记忆层级 | L1/L2/L3 | **砍掉层级** | 无证据支持第三个层轴 |
| 多跳 | 自动图扩展 | **交互式按需（`omb_relate`）** | 你要求保留但不强制 |
| 向量 | v1 建议砍掉 | **保留为独立可关模块，新建可归属 schema** | 你要求保留 |
| 上下文上限 | 每回合静态硬上限 | **软压力塑形，无硬上限** | 你的明确要求；且事实 D 使测量成为可能 |
| 上下文范式 | 推送 + 准入控制 | **拉取式 + 准入控制** | 你要求"前沿的革命性思路"；事实 D 支撑 |
| 评测承诺 | 整层 vs 哑重试 | **机制级消融**（分层承诺） | D1：通用组件无法用编程域基线裁决 |
| 通用性 | 未显式验收 | **四域验收，情感陪伴为最强检验** | 你第 5 条要求 |

---

*文档结束。审阅要点：§0 五条修正的执行结果、§2 自主决策、§4 思维链质量层（尤其 §4.3 八条规则的实际措辞）、§6.3-6.4 软塑形与拉取式、§11.4 通用性验收、§13.1 证据强度（尤其那条不存在的论文）。*
