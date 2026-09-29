# DSH 兼容性、peer 依赖与自动压缩（task-5 证据档）

> 目标宿主：**DSH `0.2.0-rc.2`**（`<dsh-checkout>\package.json` 版本 `0.2.0-rc.2`；
> `packages/{core/tools,core/session,core/system-prompt,core/agent,preset/agent-preset,llm/token-meter,interaction/commands,bundle/base}/package.json` 逐一实测同为 `0.2.0-rc.2`）
> Cordis：`@deepseek-ai/cordis` **`4.0.4`**（`<dsh-checkout>\vendor\cordis\package.json`）
> 本档只记录**读过源码/实测过**的事实；每条断言带 `文件:行号`。不确定的写在 §7。

---

## 1. 结论速览

| 问题 | 结论 |
| --- | --- |
| 根 `package.json` 的 peer 声明 | 已补：**7 个必需 + 27 个可选**（§2），全部按 `^0.2.0-rc.2` / `~4.0.4` 写，并逐个在 npm 上验过该版本存在 |
| 宿主契约核查 | 4 项匹配、1 项**不匹配**（`ctx.on('tool/call')` 不会触发 → 制品索引收不到工具调用，§3.6）、1 项**契约在但 OMB 未接线**（tokenMeter → 压力档位恒 relaxed，§6.1） |
| 自动压缩 | **恢复**：`compaction-basic` + `command-compact` + `tool-result-pruner` 三行按 DSH 自带预设逐行开；`image-offload` **不加**（留在宿主平面）。判定为**概念重叠 + 测量耦合**，非真冲突（§4） |
| OMB 上下文优化 | 仍正常：它**只读** tokenMeter、**从不改会话历史**（§4.2 证据），与压缩各改一条轴 |

---

## 2. peer 依赖声明（`package.json`）

### 2.1 版本范围与理由

| 包 | 范围 | 理由 |
| --- | --- | --- |
| `@deepseek-ai/dsh-*`（全部） | `^0.2.0-rc.2` | 0.x 的 caret **锁小版本**：等价于 `>=0.2.0-rc.2 <0.3.0-0`（实测见 §2.2），因此在 0.2 线内跟随 rc.N 与 0.2.0 正式版，但**跳不到 0.3**（宿主的破坏性变更历来发生在小版本，见规划 §12 R11） |
| `@deepseek-ai/cordis` | `~4.0.4` | cordis 与 dsh-* **不是同一条版本线**（实测 4.0.4）；DSH 自己把 cordis 声明为 `workspace:~`（`packages/core/tools/package.json` 的 peerDependencies），`~` 即"同 4.x 小版本"，这里与宿主保持一致 |
| `dsh-desktop-notify` | `*`（optional） | 第三方插件（npm 实测 `1.4.1`）。OMB 只用**结构探测**（`modules/notify/bridge.ts:56` 的最小接口 + `:191` 形状校验），版本不构成契约；形状不符即静默降级（已有测试） |

**为什么不是精确 pin**：规划 §12 R11 曾写"pin 精确 peer 版本"，DSH 内部包之间也确实用 `workspace:*`（打包时即精确版本）。但那是**同一 monorepo 内**的做法；OMB 是独立可安装的 bundle，精确 pin 会把每一次 `rc.N` 递增都变成 peer 报错，而 §3 核查过的契约面在 0.2 线内是稳定的。`^0.2.0-rc.2` 仍然**不能**跨小版本，安全性与精确 pin 同级，运维成本低得多。

### 2.2 预发布范围语义（实测，不是推断）

用 node-semver `7.8.5`（与 DSH 同大版本）实测：

```
range: ^0.2.0-rc.2 => [ >=0.2.0-rc.2 <0.3.0-0 ]
   0.2.0-rc.2   true      0.2.0        true      0.2.1   true
   0.2.0-rc.3   true      0.2.1-rc.1   false     0.3.0   false
   0.3.0-rc.1   false     0.1.9        false     1.0.0   false
cordis ~4.0.4 => >=4.0.4 <4.1.0-0 | 4.0.5: true | 4.1.0: false
```

两点必须知道：
1. `^0.2.0-rc.2` **接受** `0.2.0-rc.N`（同 patch 线的预发布）与 `0.2.x` 正式版；
2. 它**不接受** `0.2.1-rc.1` —— 新 patch 线的预发布是未经本档核验的新构建，需要人工重新发布 OMB 的范围。这是刻意的：**宁可报错也不要静默接受未核验的宿主**。

### 2.3 必需 vs 可选（两级）

**必需（7）**——OMB 自身运行时/装配离不开：`@deepseek-ai/cordis`、`dsh-commands`（`dsh/plugin.ts:59` 的 `inject`）、`dsh-tools`（`:195` 读 `tools` 服务）、`dsh-session`（`session/event`）、`dsh-system-prompt`（`dsh/session.ts:435`）、`dsh-token-meter`（内核度量桥的宿主来源，`kernel/abi/kernel.ts:102`）、`dsh-agent-preset`（`cordis.patch.yml` 的 `preset-omb` 行本身就是它）。

**可选（27）**——大肥鱼模式预设引用的工具/人格/技能行 + 压缩组 + 通知桥。缺任何一个只让**那一行**不激活（插件页可见），OMB 自身模块照常工作：
`dsh-agent-instructions`、`dsh-command-goal`、`dsh-persona`、`dsh-plan-mode`、`dsh-plugin-manager`、`dsh-skill-filesystem`、`dsh-tool-{ask-user,bash,fs,fs-search,goal,jobs,present,pwsh,ralph,skill,subagent,subagent-control,todo,web,workflow}`、`dsh-workflow-ptc`、`dsh-compaction`、`dsh-compaction-basic`、`dsh-compaction-tool-result-pruner`、`dsh-command-compact`、`dsh-desktop-notify`。

### 2.4 安装语义（实测）

- `pnpm-lock.yaml` 的 importer 段**不记录 peerDependencies**（只记 dependencies/devDependencies/optionalDependencies）→ 加 peer 不需要刷新 lockfile。
- `pnpm-lock.yaml:4` `settings.autoInstallPeers: true` → 装依赖时 pnpm 会尝试把**必需** peer 从 npm 拉下来。已逐个实测 `@0.2.0-rc.2` 在 npm 上**都存在**（26 个 dsh-* 包逐个 `npm view <pkg>@0.2.0-rc.2 version` 全部返回该版本；`cordis@4.0.4` 存在），**不会因 peer 导致安装失败**。
- 注意 npm 的 `latest` tag 是**陈旧**的（`@deepseek-ai/dsh-tools` 的 dist-tags 实测为 `{latest: 0.0.1-rc.1, alpha: 0.1.7-alpha.2, next: 0.2.0-rc.2}`）；`0.2.0-rc.2` 在 `next` 上。写范围时不要看 `latest`。
- 副作用：这条路径会真的下载一份宿主包到本仓库 `node_modules`（OMB 运行时不 `import` 它们，只影响安装体积）。若不希望如此，应在 `pnpm-workspace.yaml`/`.npmrc` 关掉 `autoInstallPeers`——**不在本任务写入范围**，见 §7。

---

## 3. 宿主契约清单与逐条核查

| # | 契约 | OMB 侧（用法） | DSH 0.2.0-rc.2 侧（定义） | 结论 |
| --- | --- | --- | --- | --- |
| 3.1 | Cordis `ctx` 代理与 Guard | `ctx.get()` / `ctx.on()` / `ctx.effect()`（`dsh/host.ts:69,72,96-98`） | `get` trap 对"非特殊属性且未 inject"抛 `cannot get property "X" without inject`（`vendor/cordis/src/reflect.ts:135-159`，错误在 `:144`）；特殊属性（方法）在 `:137` 放行 | **匹配**。OMB 只 `inject: ['commands']`（`dsh/plugin.ts:59`），其余服务一律 `ctx.get(name)` 探测——与 DSH 自己在预设里用 `!!js "!ctx.get('profileContext')"`（`packages/boot/app-boot/src/compatibility-preflight.ts:93,183` 读同名服务）是同一套用法 |
| 3.2 | `commands` 服务 | `inject: ['commands']`（`dsh/plugin.ts:59`）。**目前没有注册任何命令**（为 task-8 隐私模式预备） | `super(ctx, 'commands')`（`packages/interaction/commands/src/index.ts:277`）；`register(definition): () => void`（`:285`）；`CommandDefinition{definitionId?,name,description,handler}`（`:61-77`）；handler 必须返回 `CommandResult`（`:228-230`） | **匹配**（契约在，暂未使用） |
| 3.3 | `tools` 服务与工具形状 | `toHostTool()` 产出 `{name,description,parameters(jsonSchema),output:{schema,render},execute}`（`dsh/tools.ts:68-85`），经 `tools.register()` 注册（`:152`）；`output` 必填 | `super(ctx, 'tools')`（`packages/core/tools/src/index.ts:849`）；`register(definition: ToolDefinition): () => void`（`:1063`）；缺 `output` 抛 `tool "<name>" must declare output { schema, render, presentationMeta? }`（`:1069`） | **匹配** |
| 3.4 | `systemPrompt` 服务 | `readService(ctx,'systemPrompt')`（`dsh/session.ts:435`），注入常驻段与逐回合上下文 | `super(ctx, 'systemPrompt')`（`packages/core/system-prompt/src/index.ts:422`）；`section(section)`（`:454`）；`context(context)`（`:489`） | **匹配** |
| 3.5 | 会话事件 | `ctx.on('session/event')`（`dsh/session.ts:273`）、`ctx.on('tools/result')`（`:363`） | ctx 层只发 `session/event` / `session/disposed`（`packages/core/session/src/index.ts:405`），参数 `[session, event]`（`:757-764`）；`tools/result` 是 ctx 事件（`core/tools/src/index.ts:198` 声明、`:1704` 发出） | **匹配** |
| 3.6 | `tool/call` 事件 | `ctx.on('tool/call')`（`dsh/hooks.ts:76`），并期望载荷 `{name|toolName, args}`（`:78-83`） | **没有 ctx 级 `tool/call`**：它只是**会话事件类型**（`core/session/src/known-event-types.ts:73`；载荷 `{turn,step,callId,name,arguments:string}`，`core/session/src/types.ts:361`）。DSH 自己的 agent-loop 也只用 `ctx.on('session/event')`（`core/agent-loop/src/runtime-context.ts:134`、`agent.ts:332`） | **不匹配** → 制品索引收不到任何工具调用（静默失效）。修法见 §6.2 |
| 3.7 | 会话日志格式 | 文档写 `session.v4.jsonl.zstd` | `SESSION_FORMAT_VERSION = 4`（`core/session/src/types.ts:89`，读时校验 `:105-106`）；文件名 `session.v<N>.jsonl`（`packages/session/session-format/src/filename.ts:16`）+ `.zstd`（`packages/session/session-persistence-jsonl/src/format.ts:42`；默认压缩 `zstd`，`src/index.ts:68`） | **匹配** |
| 3.8 | `step/start` / `step/end` | 未直接订阅（若有需要，可经 `session/event` 的 `event.type` 拿到） | 是会话事件类型（`known-event-types.ts:58-59`；载荷 `{turn,step}`，`types.ts:299-301`）；不变量要求 step 必须在 turn 内（`invariant.ts:94-112`） | **匹配**（OMB 目前不需要） |
| 3.9 | `tokenMeter` | 内核度量桥的来源（`kernel/abi/kernel.ts:102` 注释） | `@deepseek-ai/dsh-token-meter@0.2.0-rc.2` 已发布；`measure()` 形状见规划 §1.4（`packages/llm/token-meter/src/index.ts`） | **契约在，但 OMB 未接线**（§6.1） |
| 3.10 | `desktopNotify` | `ctx.get('desktopNotify')`（`dsh/plugin.ts:154`）+ 形状探测（`modules/notify/bridge.ts:56,191`） | 由第三方 `dsh-desktop-notify` 提供（npm 实测 `1.4.1`）；DSH 树内无此包 | **匹配**（optional peer） |

---

## 4. 自动压缩：真实冲突边界与开/关决定

### 4.1 四个包各做什么（全部读过实现）

| 包 | 触发 | 改什么 | 关键证据 |
| --- | --- | --- | --- |
| `@deepseek-ai/dsh-compaction` | 服务接口（无自主触发） | 提供 `ctx.compaction`；一次成功运行把选定的一段表面替换成**一个摘要节点** | `packages/compaction/compaction/src/index.ts:32`（触发类型 `'pressure'\|'context-overflow'`）、`:112-117`、`:119-141`（`compactIfNeeded`）、`:187`（`compactRegion`） |
| `@deepseek-ai/dsh-compaction-basic` | **步边界**：`measurement.totalTokens >= thresholdTokens`；另加 provider 报上下文溢出时的恢复 | 用 `ctx.tokenMeter` 定价，选一段历史 → 调模型摘要 → 替换 | `packages/compaction/compaction-basic/src/index.ts:106`（注释：用 `ctx.tokenMeter` 取压力）、`:144-232`（注册步边界压力 + 溢出恢复）、`:319`（阈值判定）、`src/types.ts:10-18`（`thresholdRatio` 0.8、`headroomTokens` 65536、`retainRatio` 0.16）、`src/config.ts:191-195`（阈值 = min(window×ratio, 请求预算−headroom)）、`src/summarizer.ts`（真调模型） |
| `@deepseek-ai/dsh-compaction-tool-result-pruner` | **确定性、无 LLM**：单个工具结果超过 `thresholdChars` | 保留 head + 固定 marker + tail，替换**表面**内容；**原文经 shadowed node 可追回** | `src/config.ts:7-14`（marker 与 8192/4096/1024 缺省）、`src/index.ts:85-119`（裁剪与自检）、`:126-127`（"保留完整事件数据，只有 `content` 变，并引用被遮蔽的节点，使 replay 能取回原文"）、`:160-174`（append `compaction/prune` + `shadowedTokenCount`）、`:59`（注册 `toolResultPruner` 服务） |
| `@deepseek-ai/dsh-command-compact` | **只有人打 `/compact`** | 走 `ctx.compaction.compactNow` | `packages/compaction/command-compact/src/index.ts:11-12`（`inject = ['commands','compaction']`）、`:14`（无参数）、`:24-56`（把失败分类成人话） |

`@deepseek-ai/dsh-compaction-image-offload` 只在**宿主平面**的 base bundle 里（`packages/bundle/base/cordis.patch.yml:427-428`），DSH 自带预设的压缩组里**没有**它；OMB 也从不产生图片 → **不加入本预设**。

### 4.2 OMB 侧到底碰了什么（决定"真冲突 vs 概念重叠"的证据）

- OMB 的上下文优化**只读**压力：`modules/context/index.ts:249` `kernel.pressure(target)`，`:241-249` 是唯一的压力取数路径。
- 它**从不改会话历史**：在 `modules/context/**` 里 grep `session.append` / `surfaceOp` / 会话写操作 → **零命中**；它维护的是**内存里的**拉取台账（`:197` 的 `ledgers`、`recordPull` `:396`、`noteTurn` `:348`）。
- 台账的判据是"拉取次数 / 轮数"（`modules/context/watch.ts:47-181`、`cacheHitRate` `:235-237`），与历史体量无关。
- 档位阈值 `[0.3, 0.6]`（`modules/context/index.ts:60,70`）**低于**压缩阈值（~0.8 减去 headroom）：OMB 在 0.6 就转"只给索引"，压缩在更晚才动手。

**结论**：
1. **没有真冲突**——两者改的不是同一份东西。压缩改会话历史（surface/日志），OMB 改的是"我往提示里塞什么"（且默认不塞）；它们共享的只有**测量**（`tokenMeter` 读数）。
2. **有一处测量耦合，但是良性的**：压缩后压力下降 → OMB 档位从 tight 回 relaxed。规划 §6.3 已经规定"压力回落到宽松档时**不主动补回**已省略的内容"，所以不会抖动。
3. **一处需要记账口径的注意**（不是冲突）：`cacheHitRate`（`watch.ts:235`）在每次压缩后会掉一截——**前缀缓存被压缩作废**，这不是 OMB 布局的问题。OMB 的自调本来就规定"运行时只记账、参数调整在维护期做"（规划 §6.6），因此可接受；更好的做法是把掉点与 `compaction/start`/`compaction/end`（会话事件类型，`known-event-types.ts:32,34`）关联后再判读。**这一条属于 task-7/task-9 的范围，本任务只记录。**
4. **pruner 与"逐字召回"**：`omb_recall` 的结果若超过 8192 字符，在历史里会被掐掉中段（head 4096 + tail 1024 保留，原文可经 shadowed node 追回）。这与规划 §6.8"不重复造宿主的裁剪"、阶段 5.6"与宿主 pruner 协调"一致；OMB 默认召回条数很小，实际很少触发。

### 4.3 开/关决定（逐行）

| 行 | 决定 | 理由 |
| --- | --- | --- |
| `compaction`（组，`cordis:group`，`isolate: {compaction: true, toolResultPruner: true}`） | **开** | 与 DSH 自带创造模式预设逐行一致（`packages/bundle/web-app/presets/cordis.patch.yml:62-78`），位置也一致（紧接 `planning` 组） |
| `compaction-basic` | **开** | 这正是"恢复自动压缩"本体；它读 tokenMeter 但**不碰** OMB 的任何状态 |
| `command-compact` | **开** | 只有人打 `/compact` 才动（`:11-14`），无自主行为；给用户一个显式的手动入口 |
| `tool-result-pruner` | **开** | 纯确定性、无模型调用；表面替换且原文可追回；且**它在 web-app profile 的宿主平面行是被禁用的**（`packages/bundle/web-app/cordis.patch.yml:509-516` 把 `compaction-basic`/`command-compact`/`tool-result-pruner` 三行 `disabled: true`），不回预设就等于全profile 都没有裁剪 |
| `image-offload` | **不开** | 宿主平面已有（`base/cordis.patch.yml:427-428`）；DSH 预设组不含它；OMB 不产生图片 |
| `tool-cordis` | **仍不开** | 与本次任务无关（原决定：给"改 DSH 自身"用，与 OMB 日常认知任务无关） |

### 4.4 装配级证据（可复现）

`cordis.patch.yml` 用 Loader 兼容 schema 解析后的实际启用情况（`!!js` 按未求值表达式处理）：

```
根层行 ids: omb-kernel, omb-memory, omb-memory-vector, omb-profile, omb-reasoning,
            omb-context, omb-artifact, omb-notify, preset-omb
preset-omb 行数: 19
compaction 组: name=cordis:group group=true isolate={"compaction":true,"toolResultPruner":true}
  - compaction-basic → @deepseek-ai/dsh-compaction-basic | disabled=（未设置=启用） | config=（无）
  - command-compact → @deepseek-ai/dsh-command-compact | disabled=（未设置=启用） | config=（无）
  - tool-result-pruner → @deepseek-ai/dsh-compaction-tool-result-pruner | disabled=（未设置=启用）
      | config={"thresholdChars":8192,"headChars":4096,"tailChars":1024}
顺序: planning(9) < compaction(10) < delegation(11) = true
预设内启用行数: 16 | 含 compaction: true
image-offload 是否被本预设重复声明: false
```

复现方式（临时脚本，不入仓库）：用 `js-yaml` 的 `DEFAULT_SCHEMA.extend([js-scalar-type, js-seq-type])` 解析
`cordis.patch.yml`（`!!js` 构造成 `{__jsExpr}`），再断言上表。

---

## 5. 门禁实测（原始输出摘要）

跑于 `2026-09-29 23:40`（本仓库为多人并行施工中，**红点全部来自 task-7/task-8 的在飞改动**，已逐条归因）：

| 命令 | 结果 | 归因 |
| --- | --- | --- |
| `npx tsc --noEmit` | **红，7 处** | 全部在他人范围：`dsh/moduleEntries.ts(25,26)` 引用尚不存在的 `modules/privacy/index.js`（task-8）；`modules/profile/index.ts(288,378,379,465)` 与 `tests/modules/profile/storage.test.ts(169)` 的 `setSession` 不存在（task-7）。**没有一处指向本任务改的 `package.json` / `cordis.patch.yml`**（JSON/YAML 不参与类型检查） |
| `npx eslint .` | **绿（exit 0，无输出）** | — |
| `npx vitest run` | **948 passed / 17 failed / 2 skipped（共 967 例）** | 失败分布：`tests/modules/context/module.test.ts` 5（会话原子化在飞）、`tests/modules/memory/*` 5（会话归属改造在飞）、`tests/modules/profile/*` 2、`tests/dsh/{modules,module-graph-source}.test.ts` 5（`@omb/privacy` 组件包缺失，报错原文 `@omb/privacy 对应的组件包不存在：packages\privacy\package.json`）、`tests/kernel/abi.contract.test.ts` 1（同上）。**无一条与本任务的改动相关** |
| `node scripts/check-resolution.mjs` | **未跑**：脚本存在但不在 task-5 判据点名的三项内，且它校验的是模块解析清单（task-6/8 在飞）——见 §7 |
| 基线对照 | Lead 给的基线 `888 passed / 2 skipped` 是施工前数字；当前树 967 例（并发任务新增用例），**"只许多不许少"无法在并行施工中作准**——本任务只能保证"我改的三种文件不引入失败" |

---

## 6. 核查中发现的、**不在本任务写入范围**的缺口（只报告，未改）

### 6.1 内核压力桥没接宿主的 `tokenMeter` → 软压力档位恒为 relaxed —— **已修（2026-09-30）**

- 证据：`dsh/plugin.ts:92` `createKernel({ logger, clock })` —— **没有传 `measure`**；而内核的 `pressure()` 只有在拿到 `measure` 时才有真读数（`kernel/abi/kernel.ts:102` 说明该桥来自宿主 `tokenMeter`）。`dsh/status-tool.ts:145-152` 已经把这如实写成"未测量（宿主未声明窗口）"。
- 后果：规划 §6.3 的软压力三档在生产里**恒为 relaxed**（"不做任何注入裁决"），`omb_status` 的 `fillRatio`/逐节点价格永远显示未测量。拉取台账不受影响（它数的是 OMB 工具拉取）。
- **实际修法（与上面最初设想的`ctx.get('tokenMeter')`不同，以实测为准）**：宿主暴露的不是 `tokenMeter` 服务，而是三个**会话投影**
  （`packages/llm/token-meter/src/projection.ts:68-76`：`contextPressure` / `tokenUsage` / `contextBreakdown`），
  经 `ctx.sessionProjections.stateOf(session, key)` 读取。**关键约束**：`stateOf` 要的是
  **`Session` 对象**而不是 sessionId，而 `session/event` 的载荷第一参恰好就是它
  （`packages/core/session/src/index.ts:77` 的签名 `(session, event)`）。
  实现落在 `dsh/pressure.ts`（度量桥）+ `dsh/session.ts` 新增的 `onHostSession` 采集点 +
  `dsh/plugin.ts` 的接线；`fillRatio = projectedTokens / contextWindow`。
- **补充纠正**：本文档早前版本说过"宿主未声明窗口"。**不成立**——`ContextPressureProjection.contextWindow`
  就是路由声明的窗口容量。真实情况是 OMB 从来没去读它。
- **未测量现在有四条可分辨的原因**（服务缺失 / 未上报 usage / 未声明窗口 / 未观察到该会话），
  由 `SERVICES.pressureReading` 给出，`omb_status` 逐字转述。此前四种成因在状态面上是同一个 `null`。

### 6.2 `ctx.on('tool/call')` 在 0.2.0 不会触发 → 制品索引收不到工具调用 —— **已修**

- 证据：见 §3.6。`dsh/hooks.ts:76` 订阅的 `tool/call` 不是 ctx 事件；DSH 侧 `tool/call` 只是会话事件类型（`known-event-types.ts:73`，载荷 `types.ts:361` 的 `arguments` 是 **JSON 字符串**）。
- 后果：`wireArtifactIndex` 从未被调用 → 制品索引（`omb_files` 的数据源）为空。**单元测试发现不了**（测试用 fake ctx 直接 emit `tool/call`）。
- 修法（已实施）：索引接到 `session/event` 订阅，`event.type === 'tool/call'` 时读 `event.data.name` 并 `JSON.parse(event.data.arguments)`。
- **教训（本档最贵的一条）**：旧测试断言的是"订阅存在"，而不是"事件真的会到"——
  于是它一直绿着，而生产里那条线一次都没响。**存在 ≠ 生效。**

### 6.3 peer 的安装副作用

见 §2.4 最后两条：`autoInstallPeers: true` 会让 `pnpm install` 把必需 peer 从 npm 拉下来（已验都存在，不会失败），代价是本仓库多一份宿主包副本；若不想要，需要改 `pnpm-workspace.yaml`/`.npmrc`（不在本任务范围）。

---

## 7. 未做到 / 不确定（如实列出）

1. **`0.1.7-rc.2 → 0.2.0-rc.2` 的完整破坏面无法确证**：DSH 仓库禁止 git，也没有可用的 CHANGELOG 对比。我核对了任务点名的 5 类契约（事件名、ctx/Guard、`ToolDefinition`、`commands.register`、会话日志格式）**加上 OMB 实际读到的每个服务**；其余（`jobs`、`sessionProjections`、`workspace`、`profileContext` 的确切提供者）**没有逐条核对**——因为 OMB 当前代码不读它们（`profileContext` 只在 `cordis.patch.yml` 里被 `ctx.get` 探测一次）。
2. **`@deepseek-ai/dsh-agent-preset` 内层 `plugins` schema 的 0.2.0 变化**未逐字核对。间接证据：`tests/dsh/assembly.smoke.test.ts` 9 例通过（真实清单 + 真实内核装配）。
3. **真实宿主安装未跑**（任务纪律禁止 `plugin_manager`）。因此"compaction 三行在真实 profile 里真的激活"仅有**解析级**证据（§4.4），真正的权威信号是 Lead 复验时的 `install_bundle.application` 与 `dsh: warning: N entries did not activate`。
4. **`node scripts/check-resolution.mjs` 未跑**：它校验的东西（模块解析/代数产物）正被 task-6/task-8 改动，跑出来的红无法归因到本任务；且 task-5 的判据点名的三项不含它。
5. **`dsh-desktop-notify` 的 `*` 范围**：我没读它的发布历史，给不出更窄且安全的范围。OMB 只做结构探测，形状不符即降级（有测试），所以 `*` 是可辩护的，但它确实**不是**"核验过的范围"。
6. **`cacheHitRate` 与压缩事件的关联**（§4.2 第 3 条）只是**建议**，没有实现，也没有测量数据支撑其收益。

---

## 8. 插件管理器的依赖表达能力（2026-09-30，只读调查 + 落地决定）

**问题**：关掉一个前置组件时，能不能让它依赖的组件**一并自动关闭**？或者，**打开**一个依赖已被关掉的组件时，能不能**失败并提示**？

**结论：两条都做不到（第二条只是偶然部分成立）**，因此按用户指定走兜底路线：**检测到变更时推送通知**。

### 8.1 (A) 自动一并关闭 —— **不支持**

- 全仓没有任何代码为依赖方写 `disabled`。唯一的"级联"发生在 **Cordis fiber 层**：
  提供者被卸下 → `reflect.notify` 让每个 `inject` 它的 fiber 卸载到 PENDING
  （`vendor/cordis/src/reflect.ts:297-303`、`:314-336`）。
- 也就是说：**能力层面依赖方确实已经停摆了，但它的"行"仍然是启用状态**。
  用户在插件页看到的是"等待依赖"（`ui-plugin-manager/src/client/locales.ts:238`），
  而"我关掉的那个东西连累了谁"没有任何地方说。
- 关闭动作的落盘路径完全不看依赖：`packages/boot/plugin-manager/src/index.ts:424-435`
  只写 `disabled` 再 reconcile；`src/patch.ts:14-42` 是唯一的 `disabled` 写入者。

### 8.2 (B) 打开时失败并提示 —— **部分支持，但依赖"偶然"**

- 成立的那一半：`setPluginEnabled` 会把自己这一行的 patchId 放进 `requiredIds`
  （`plugin-manager/src/index.ts:431`），`reconcileProfilePatches` 对"新变成未激活的必需项"抛错
  （`app-boot/src/index.ts:293-296`）→ UI 弹 `failedRowEnable`（`locales.ts:378-379`）。
- **但**它成立的原因不是"检查了依赖"，而是"这一行自己起不来"。所以：
  - 只有当那一行**自己声明了** `inject`（行级或模块级静态 `inject`）时才成立；
  - OMB 的模块行只 `inject: ['omb:kernel']`，模块之间的前置是 OMB 自己的
    `manifest.requires`（内核 `planModules` 读的那一份），**DSH 看不到**；
  - 且仅在活 HMR profile 下成立：没有 `hmr` 服务时同一调用直接返回
    `application: 'restart-required'`，**零校验**（`index.ts:763`）。

### 8.3 OMB 侧可以做的与不可以做的

| 想做 | 能不能 | 依据 |
| --- | --- | --- |
| 阻止/修正一次开关 | **不能** | 写文件在前（`index.ts:430`），写完才 reconcile；没有 pre-write 钩子、没有 veto |
| 让插件页把依赖它的行置灰 | **不能** | `protectedModules` / `readOnlyReason` 是 `plugin-manager` 内部私有集（`index.ts:66-76`、`:263-271`） |
| 从 `plugin-manager/changed` **同步**级联 | **不能** | 该 emit 在 `hmr.runExclusive`（嵌套直接抛 `"HMR transactions cannot be nested"`）与 `withFileLock` 之内；同步重入会在 120s 后以 `atomic-write: timed out waiting for the writer lock` 失败（`util/atomic-write/src/index.ts:257-259`） |
| 观察变更并**事后**提醒 | **能** | 见 8.4 |

### 8.4 落地：OMB 自己的检测 + 桌面通知

新增两条能力（都在 OMB 仓库内，不改 DSH）：

1. **账本出账**（`kernel/index.ts` 的 `recordUnmount`）：在此之前挂载账本**只增不减**——
   关掉一行之后 `mounted` 里仍然列着它，`missingDependencies` 恒为空，
   自检还报"顺序自检通过"。**这是"连检测都做不到"的根因。**
   销账的位置信息同时保留下来，重挂时回到原位，避免热开关产生**假**的顺序违规。
2. **变更广播 + 通知**（`kernel/module-graph-changed` → `modules/notify`）：
   卸下时若仍有模块依赖它，推送"`X` 已关闭，依赖它的 `N` 个模块已失效……要恢复：把 `X` 那一行重新打开"。
   只在**卸下**时发，因此启动期天然无噪音（启动只有挂载）。
3. **顺带修掉一条死线**：`kernel/module-health` 早就声明在事件表里、`modules/notify` 也早就订阅了它，
   但**内核从来没有发射过**（全仓 `emit('kernel/module-health'` 只在测试里）。
   于是"模块运行中失败就弹通知"在生产里一次都不会触发，而测试全绿——测试自己手动 emit 了那条事件。
   现在上报与广播绑成同一个动作（`reportHealth`），9 个上报点不可能再漏。

### 8.5 仍未做到的（如实记录）

- **打开依赖方时没有任何提示**：DSH 不校验，OMB 也拿不到"用户正在打开某一行"的事件
  （`plugin-manager/changed` 的载荷只有 `{reason: 'plugin'|'bundle'|'install'|'remove'}`，**没有 target**）。
  事后 diff 只能得到"缺了"，得不到"因为刚才那次操作"。当前只在**关闭**方向给提醒。
- **`desktopNotify` 是否真的在跑没有当场验证**：`dsh-desktop-notify` 的行是活的
  （`Config.listConfigs` 查到 `include:desktop-notify`），但宿主 Service 目录里没有 `desktopNotify` 键，
  无法确定该目录是否穷举。OMB 侧对它是纯结构探测，探测不到就静默降级（有测试），因此不影响正确性。
