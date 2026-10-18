# DSH `0.2.1-rc.2` 接触面逐条复核（task-2 证据档）

> 目标宿主：**DSH `0.2.1-rc.2`**（`D:\Program\deepseek-harness`，`git describe` = `dsh-v0.2.1-rc.2`，HEAD `687f282e86`）
> 被核对象：**OMB `3.6.0`**（`D:\Program\Oh-My-BigBlueFish`，HEAD `cdf6f47`，工作树干净）
> 上一版基线：`docs/dsh-compatibility.md`（针对 `0.2.0-rc.2`）
> 本档只记录**读过源码/实测过**的事实；每条断言带 `文件:行号`。查不到的写进 §8，不猜。

---

## 1. 摘要

| 接触面 | 结论 | 一句话 |
| --- | --- | --- |
| 1 提示变量严格插值 | **兼容**（带余量风险） | 只有 `provider`/`model` 两个内置变量；全仓唯一真插值是 `cordis.patch.yml:104` 的 `{{model}}`，合法。但 `{{model}}` 的取值可能为 `undefined`，那时**整轮失败** |
| 2 `ctx.on('tool/call')` | **兼容** | rc.2 仍然没有 ctx 级 `tool/call`；OMB 已改订 `session/event`，载荷口径不变 |
| 3 会话投影 | **兼容** | 服务名/方法/键名/字段名/compaction 后行为**逐字未变** |
| 4 `commands.register` 的 `input` | **兼容** | OMB 唯一的命令已声明 `input`；但"重名静默覆盖"的说法**不成立**——重名会抛 |
| 5 `tools.register` | **兼容** | `output` 必填、`parameters` 原样投影、`ToolRunContext.agent` 仍在根上 |
| 6 `desktopNotify` | **兼容**（外部源已核，§3.6） | DSH checkout **零命中**（协议不在树内）；已按外部实现 `D:\Program\dsh-desktop-notify`（`2.1.0-led.1`）逐条核对：API 版本、能力清单、`notify`/`push`/`pushAlways` 门控、click 四态**全部与 OMB 的假设一致** |
| 7 fs 写否决 + 异步挂载 | **兼容** | `fs/*-intent` 语义未变（OMB 不订阅，无风险）；异步挂载已由"用时重扫"兜住 |
| 8 peer 依赖契约 | **需改** | 33 条 peer 全部存在且版本为 `0.2.1-rc.2`；但 `^0.2.0-rc.2` **不构成 pin**——DSH 的门接受任何 `0.2.x-*` |

**计数：兼容 7 项（其中 2 项带余量风险）、需改 1 项（peer 口径）。**
`desktopNotify` 已从"无法确认"升级为"兼容（外部源已核）"：协议不在 DSH 树内是结构事实，但外部实现已逐条读过（§3.6）。
**追加复核（§11）另有一个独立结论**：预设写法是 rc.2 的官方正确写法，但**工具行有 3 处遗漏**（`time-context`、`tool-schedule`、`tool-plugin-market`）+ 1 个已废弃字段（`backgroundMode`）。

### 最危险的三条

1. **peer 范围给的是假 pin（§3.8）。** 基线 §2.2 断言"`^0.2.0-rc.2` 不接受 `0.2.1-rc.1`"，据此得出"宁可报错也不要静默接受未核验的宿主"。**这个前提在 DSH 自己的判定口径下是错的**：`app-boot` 用 `semver.satisfies(..., { includePrerelease: true })`（`packages/boot/app-boot/src/plugin-compatibility.ts:52`），实测该口径下 `0.2.1-rc.2`、`0.2.1-rc.1`、甚至 `0.2.1-alpha.5` **全部满足** `^0.2.0-rc.2`。所以声明拦不住任何 `0.2.x` 预发布，只拦 `0.3.x`。
2. **拦不住的方向上，失败是"静默消失"而不是报错（§3.8）。** 若真到了不满足的版本，bundle 的处理是**跳过并只进 `skippedBundles`**，且源码注释明写 "nothing is printed"（`packages/boot/app-boot/src/profile.ts:732-733`、`:759-767`）。表现会是"OMB 整个不见了，日志里什么都没有"。
3. **`{{model}}` 的 undefined 分支会让整轮运行失败（§3.1）。** `AgentOptions.model` 是可选（`packages/core/agent/src/runtime-types.ts:30`），插值器对"已注册但值为 `undefined`"同样抛错（`packages/core/system-prompt/src/index.ts:370-371`）。Web 主代理有默认模型兜底，但 resumed/子代理路径存在 model 为空的真实状态（`packages/subagent/subagent/tests/continuation.spec.ts:836` 断言 resumed 代理 `options.model` 就是 `undefined`）。

---

## 2. 版本基线

| 项 | 值 | 证据 |
| --- | --- | --- |
| OMB 版本 | `3.6.0` | `package.json:3` |
| DSH 版本 | `0.2.1-rc.2` | `D:\Program\deepseek-harness\package.json:3`；`git describe --tags --always` → `dsh-v0.2.1-rc.2` |
| 全部 `@deepseek-ai/dsh-*` | `0.2.1-rc.2`（逐一读 `package.json`，共 300+ 个包，无一例外） | 脚本遍历 `packages/**/package.json`、`vendor/**/package.json` |
| `@deepseek-ai/cordis` | **`4.0.5`**（基线记的是 `4.0.4`） | `vendor/cordis/package.json` |
| 其他 vendor | group `1.0.5` / hmr `1.0.20` / include `1.0.10` / loader `1.0.6` / logger-console `1.0.5` / timer `1.1.7` / cosmokit `1.8.6` / schemastery `3.18.5` | 各 `vendor/*/package.json` |
| `rc.1 → rc.2` 改动量 | 456 文件 / +4921 / −845 | `git diff dsh-v0.2.1-rc.1..HEAD --stat` |
| `0.2.0-rc.2 → HEAD` 改动量 | 8431 文件 / +320407 / −84704 | `git diff dsh-v0.2.0-rc.2..HEAD --stat`（**无法逐条审**，故本档按接触面定点核） |
| OMB peer 声明 | **33 条**（7 必需 + 26 可选），不是 34 | `package.json` 的 `peerDependencies` 与 `peerDependenciesMeta` 实数 |
| OMB `engines` 字段 | **不存在** | `package.json` 无 `engines`；这决定 §3.8 走 peer 路径而非 `engines.dsh` 路径 |

**与基线的三处版本漂移（都要记账）**：

1. `@deepseek-ai/cordis` `4.0.4 → 4.0.5`。对 OMB 无影响：`~4.0.4` = `>=4.0.4 <4.1.0-0`，实测 `4.0.5` **满足**（默认口径也满足）。
2. `dsh-desktop-notify` 已从 `peerDependencies` **整个移除**（基线 §2.3 里它是 27 个可选 peer 之一）。理由写在 `pnpm-workspace.yaml` 注释里（npm 上该名字被他人占用）。所以 33 = 32 个 `dsh-*` + 1 个 `cordis`，而不是用户描述的 34。
3. `autoInstallPeers` 已从 `true`（基线 §2.4 实测）改为 **`false`**：同时写在 `pnpm-workspace.yaml` 与 `pnpm-lock.yaml:4`。

---

## 3. 逐条复核

### 3.1 提示变量严格插值

**接触面**：DSH 的提示段/上下文段里出现 `{{x}}` 时，`x` 必须是已注册变量，否则抛错并让整轮运行失败。

**rc.2 实际**：

| 事实 | 证据 |
| --- | --- |
| 内置注册**只有** `provider` / `model`，在 `agent-loop` 构造期注册到**全局层** | `packages/core/agent-loop/src/index.ts:389-390` |
| 生产源码里**没有**别处注册变量（其余 `.variable(` 全在 `tests/`） | 全仓 grep `systemPrompt.variable(` / `.variable('`：命中的生产文件仅 `agent-loop/src/index.ts` |
| 注册 API：`ctx.systemPrompt.variable(name, provider)`，名字须匹配 `/^[a-z][a-z0-9_]*$/` | `packages/core/system-prompt/src/index.ts:561`、`:196`；文档注释 `:553-570` |
| 插件**可以**自注册变量（这就是"cwd 之所以不是内置"的正解） | 同上；示例 `persona` 测试自己注册 `cwd`：`packages/preset/persona/tests/persona.spec.ts:25` |
| 段文本默认**走**插值，只有显式 `interpolate: false` 才原样保留 | `renderPrompt`：`packages/core/system-prompt/src/index.ts:290-295`（`:292` 是三元的判定） |
| `persona` 的 `prefix`/`suffix` **没有**设 `interpolate: false` → 一定被插值 | `packages/preset/persona/src/index.ts:62-73`（`section({text: config.prefix})`，`:66`，无 `interpolate` 键） |
| 未注册变量 → 抛 | `:365-368`（错误文本 `unknown prompt variable "{{x}}" …; registered variables: …`） |
| **已注册但值为 `undefined` → 同样抛** | `:369-372`（`prompt variable "{{x}}" has no value for this assembly …`） |
| `cwd` 确实被 DSH 自己当"未注册变量"反例测 | `packages/core/system-prompt/tests/system-prompt.spec.ts:211`（`toThrow('unknown prompt variable "{{cwd}}" in section "deployment:persona-suffix"')`）、`:212`（同一用例里才把 `cwd` 注册进去） |
| 抛错点在**生产调用链**上：`renderPrompt` 唯一生产调用方是 agent 的 step 入口 | `packages/core/agent-loop/src/agent.ts:407`（`const renderedPrompt = renderPrompt(assembly)`，在 `step()` 方法体内，未见就地 try/catch） |
| `AssembleContext` 基类型**没有** `agent`，是模块增强加上去的 | 基类型 `packages/core/system-prompt/src/index.ts:42-50`；增强 `packages/core/agent/src/runtime-types.ts:19-21`；灌入 `packages/core/agent/src/dispatch.ts:174-176` |

**OMB 现状**：全仓运行时只有**一处**真插值 —— `cordis.patch.yml:104` 的 `{{model}}`（persona `prefix`）。`{{cwd}}` 的 `suffix` 已被改写成注释并留下根因说明（`cordis.patch.yml:105-121`）。完整清单见 §6。

**兼容性判定：兼容。** `{{model}}` 的变量名合法、由 DSH 全局注册，`assemble()` 把全局变量合并进每个 scope 的 `variables`（`system-prompt/src/index.ts:619-629`），所以预设作用域内可用。

**需要改什么（余量风险，非当前故障）**：`{{model}}` 的**值**可能为空。`variable('model', context => context.agent?.options.model)`（`agent-loop/src/index.ts:390`）在两种情况下返回 `undefined`：
- `context.agent` 缺失（非 agent 发起的汇编）；
- `agent.options.model` 缺失（`AgentOptions.model?: string`，`core/agent/src/runtime-types.ts:30`）。

Web 主代理有默认模型兜底（`packages/api/session-controller/src/agent.ts:304` 在 header 无路由时回落到 `agentDefaultModel.currentSelection()`），所以日常路径不会踩到。但 `options.model === undefined` 是**生产代码自己承认的真实状态**：`packages/compaction/compaction-basic/src/index.ts:77` 与 `src/summarizer.ts:133-135` 都显式防它；`packages/subagent/subagent/tests/continuation.spec.ts:836` 直接断言 resumed 代理的 `options.model` 为 `undefined`。只要有某个挂了本预设的代理在这种状态下渲染 persona，`{{model}}` 就会在 `:370-371` 抛错，**整轮失败**（与 OMB 已经踩过的 `{{cwd}}` 是同一种失败）。

**建议**（不实施，见 §9）：要么在 OMB 侧自注册一个兜底变量（`ctx.systemPrompt.variable('model', …)` 会与宿主重名——**不可行**，重名抛 `prompt variable "model" is already registered`，`system-prompt/src/index.ts:413-415`），要么把 `{{model}}` 从 persona 前缀里去掉（最简单的零风险做法），要么接受并在文档里写明"仅当宿主提供了 model 时可用"。

**验证方法**：构造一个 `options.model` 被 `delete` 的 agent，走 `systemPrompt.assemble(assembleContextFor(agent))` + `renderPrompt()`，应抛 `prompt variable "{{model}}" has no value for this assembly`。**否证条件**：若此时不抛（例如别处注册了同名变量或提供了默认值），本条余量风险不成立。

---

### 3.2 `ctx.on('tool/call')` 不会触发

**接触面**：`tool/call` 只是**会话事件类型**，不是 ctx 事件；ctx 层只发 `session/event`，`args[0]` 是 `Session`，`event.data.arguments` 是 **JSON 字符串**。

**rc.2 实际（逐项都与基线一致）**：

| 事实 | 证据 |
| --- | --- |
| `tool/call` 在会话事件类型表里 | `packages/core/session/src/known-event-types.ts:75`（基线记的是 `:73`，仅行号平移） |
| 载荷 `arguments` 仍是 **`string`** | `packages/core/session/src/types.ts:362`：`'tool/call': { turn; step; callId; name; arguments: string }` |
| ctx 层事件签名 `(session, event)` | `packages/core/session/src/index.ts:74` |
| 实际派发点 | `packages/core/session/src/index.ts:884-889`（`collectSessionCallbacks(entry.emitCtx, [entry.carrier, 'session/event', …])`） |
| 全仓**没有** ctx 级 `tool/call` 事件声明 | grep `'tool/call'` 命中 200+ 处，全部是"会话事件"用法（`session.append('tool/call', …)`、`event.type === 'tool/call'`）；`Events` 接口里无此键 |

**OMB 现状**：已改对。生产代码里**唯一**的 `ctx.on(` 是 `dsh/hooks.ts:142`，订的是 `session/event`，实现逐个字段都对：

- 取 `args[1]` 判 `event.type === 'tool/call'`（`dsh/hooks.ts:144-145`）；
- `data.arguments` 当字符串 `JSON.parse`，解析失败静默跳过（`:150-160`）；
- 会话归属取 `args[0]` 的 `id`（`:177` 的 `pickString(args[0], 'id')`）——`Session.id` 确实存在（getter `packages/core/session/src/index.ts:546`，header `packages/core/session/src/types.ts:102`）。

**兼容性判定：兼容。**

**需要改什么**：无。

**验证方法**：真机发一次带路径参数的工具调用（如 `read`），再看 `omb_files` 是否出现该文件。**否证条件**：若 `omb_files` 仍恒空，则本条的"已生效"不成立（注意：单测喂真实事件形状只能证明形状对，不能证明宿主真的发）。

---

### 3.3 会话投影

**接触面**：`ctx.sessionProjections.stateOf(session, key)`，键 `contextPressure` / `tokenUsage` / `contextBreakdown`；要 `Session` 对象不是 id；`contextPressure` 含 `pressureTokens`/`projectedTokens`/`contextWindow`，优先 `projectedTokens`。

**rc.2 实际**：

| 事实 | 证据 |
| --- | --- |
| 服务名 `sessionProjections` | `packages/session/session-projection/src/index.ts:208`（`super(ctx, 'sessionProjections')`） |
| `stateOf(session: Session, key)`：**第一参是 Session 对象** | `:320-323` |
| 未注册的键返回 `undefined`（不抛） | `:324-325` |
| 三个键在类型表里 | `packages/llm/token-meter/src/projection.ts:69-76`（`tokenUsage` / `contextPressure` / `contextBreakdown`） |
| `contextPressure` 三个字段**全部可选** | `:36` `pressureTokens?: number`、`:45` `projectedTokens?: number`、`:47` `contextWindow?: number` |
| `projectedTokens` 的语义就是"下一次请求"、**compaction 一遮罩立即变** | `:37-45`（注释原文：`…reacting the moment a compaction shadows a span — which pressureTokens alone cannot do`） |
| `tokenUsage` 四个桶 | `:13-18` |
| `contextBreakdown` 三个启发式字段 | `:59-66` |
| 会话注册表兜底路径 `sessions.get(id)` | `super(ctx,'sessions')` `packages/core/session/src/index.ts:1077`；`get(id: SessionId)` `:1352` |

**OMB 现状**：`dsh/pressure.ts` 逐字对上：键名常量 `:47-49`、服务名 `:55`、先读缓存再问注册表（`:60-70` 的注释描述两条路）、**优先 `projectedTokens`**（`:235` `firstFinite(pressure['projectedTokens'], pressure['pressureTokens'])`）、窗口 `:242`、以及四种"未测量"成因的可分辨文案（`:228` 起）。

**兼容性判定：兼容。** 基线 §6.1 的修法在 rc.2 上仍然成立，无需改动。

**需要改什么**：无。

**验证方法**：真机上让上下文超过 ~50% 后看 `omb_status` 的 `fillRatio` 是否非空、`reason` 是否给的是"已读到 …"。**否证条件**：若 `fillRatio` 恒为 `null` 且 `reason` 说"宿主尚未注册 contextPressure 投影"，说明 rc.2 改变了投影注册时机或键名。

---

### 3.4 `commands.register` 的行级 `input` 描述符

**接触面**：命令若未声明 `input`，则 `/cmd args` 不被认领，会当普通消息发给模型。

**rc.2 实际**：

| 事实 | 证据 |
| --- | --- |
| `CommandDefinition.input?: CommandInputDescriptor` | `packages/interaction/commands/src/index.ts:69` |
| 描述符校验：必须有**非空** `hint: string`，可选 `attachments: boolean` | `:192-208`（`:195-201` 是 hint 两条；`:202-204` 是 attachments 类型） |
| `register(definition)` 返回 disposer，注册进 calling context 的层 | `:285-292` |
| **重名会抛**，不是静默覆盖 | `packages/core/scope/src/store.ts:45`（`if (data.has(name)) throw this.duplicateError(name)`）；命令层的错误文本 `commands/src/index.ts:102-105` |
| 跨作用域是**有意的遮蔽**（scoped 覆盖 global），与"重名"不是一回事 | `:101-105` 的 `scope === undefined ? … : '… already registered in this scope'` |
| 认领判定①：菜单选中，只有声明了 `input` 才建 claim，否则走 detached execute | `packages/client/ui-commands/src/client/service.ts:270`（`if (desc.input !== undefined) return { claim: … }`），`:273-275` 是 else 分支 |
| 认领判定②：空格键，`desc.input === undefined` 直接不认领 | `:295-300`（`:299` `if (desc === undefined || desc.input === undefined) return undefined`） |
| 认领判定③：回车，声明了 `input` → 认领（参数容忍）；**没声明且带参数 → 返回 `undefined`（= 当普通消息）** | `:357-365`：`:357` 有 input → claim；`:361` `if (!bare) return undefined`；`:363-364` 才是 bare 的 detached execute |
| 宿主执行器本身**只按名字**认领（`input` 只用于附件门控） | `commands/src/index.ts:367-370`（`parseCommand` + `view().get(name)`）；附件门控 `:391` |

**结论**：用户描述的三条**两条成立、一条不成立**：
- ✅ 未声明 `input` → `/cmd args` 当普通消息（**成立**，证据 `service.ts:361`）；
- ✅ register 按名字存 Map（`NamedEntries` 内部 `Map<string, V>`，`store.ts:31`）；
- ❌ **"重名静默覆盖"不成立** —— 同层重名**抛错**（`store.ts:45`）。

**OMB 现状**：只有一个命令 `omb-privacy`，**已声明 `input`**（`modules/memory/privacy/index.ts:589` `input: { hint: '[status | normal | read-only | sealed | trust | forget <会话id> | clear]' }`），注册点 `:553-604`。OMB 的注释（`:560-588`）已把同一根因写清楚，与上面 `service.ts` 的行号一致。

**兼容性判定：兼容。**

**需要改什么**：无。但建议（§9）在文档里改掉"重名静默覆盖"的表述，避免下次据此写出错判。

**验证方法**：真机发 `/omb-privacy read-only`，看是否有回执 + 会话日志出现 `command/run`。**否证条件**：若该行被当成普通文本进了模型（会话日志里是 `user/message` 而不是 `command/run`），则 `input` 认领路径在 rc.2 变了。

---

### 3.5 `tools.register`

**接触面**：`definition.parameters` 原样投影；`ToolRunContext` 运行时带 `agent`（`agent.session.id`）。

**rc.2 实际**：

| 事实 | 证据 |
| --- | --- |
| `register(definition: ToolDefinition)` 返回 disposer | `packages/core/tools/src/index.ts:1071` |
| `output` **必填**，缺了抛 `tool "x" must declare output { schema, render, presentationMeta? }` | `:1074-1078`（错误文本在 `:1077`，与基线逐字相同） |
| `output.schema` 还要过 `assertSupportedJsonSchema` | `:1079` |
| 保留名 `run_code` 不可注册/不可遮蔽 | `:1088-1090` |
| 同层重名抛（与命令同源） | `:1091-1095` → `NamedEntries.insert` → `store.ts:45` |
| **`parameters` 原样投影**：`schemaOf()` 只做 `snapshotJsonValue(parameters)`，不改写 | `:1290-1302` |
| 但必须是 **lossless JSON**，否则抛 `tool "x" parameters must be lossless JSON before schema projection` | `:1292-1295` |
| 模型可见字段白名单只有 `name/description/parameters/deferLoading` | `:1291,1296-1301` |
| `ToolRunContext extends ToolExecution`，**不含** `agent` 的独立副本 | `:419-436`（只加 `deferContext` / `concludeTurn`） |
| `agent` 在**根的** `ToolExecutionInput` 上，且**可选** | `:327-340`（`:340` `readonly agent?: Agent`） |
| `Agent` 公共面只有 `id`（`SessionId`）；`session` 是运行时增强 | `packages/core/agent/src/types.ts:15-18`；`packages/core/agent/src/runtime-types.ts:164-168`（`readonly session: Session`） |

**OMB 现状**：`dsh/tools.ts` 与之逐条对齐：
- `toHostTool` 产出 `{ name, description, parameters, output: { schema, render }, execute }`（`:163-174`）；
- `parameters` 一律过 `cleanJsonRecord`（`:167`，实现 `:122-136`）——正是为了消掉 zod v4 `~standard` 那个**不可枚举**键（`:102-125` 的注释记录了实测报错）；
- 执行上下文读 `exec.agent.id`、`exec.agent.session.header.id`、`exec.callId`，漂移即降级为"归属未知"、绝不抛（`:66-92`）。

**兼容性判定：兼容。** 用户描述的"`agent.session.id`"，实际可用路径是 **`agent.id`**（公共契约）和 **`agent.session.header.id`**（运行时增强）；`agent.session.id` 也存在（`Session` 有 `id` getter，`core/session/src/index.ts:546`），但 OMB 用的是前两者，更稳。

**需要改什么**：无。

**验证方法**：注册一个用 zod 生成 schema 的工具，看是否被拒；再在工具执行体里读 `exec.agent.id`，与发起会话 id 比对。**否证条件**：若跳过 `cleanJsonRecord` 仍能注册成功，说明宿主放松了 lossless 校验（届时 `cleanJsonRecord` 可简化）。

---

### 3.6 `desktopNotify` 对外 API

**接触面**：基线 `1.0.0`；`notify()` 与 `push()` 门控完全相同、只是返回明细；`pushAlways()` 才绕过门控；用 `capabilities` 数组探测（协议明说"不要靠版本号猜"）；`click` 四态。

**rc.2 实际：DSH 树内零命中，但外部实现已核。** 两种搜法都没有结果：

- 递归文件搜索 `desktopNotify|desktop-notify`（`*.ts/*.tsx/*.json/*.yml/*.md`，排除 `node_modules`）→ 无输出（后因太慢改用 ripgrep）；
- ripgrep 全 checkout `desktopNotify|desktop-notify` → **`No matches found`**。

**为什么找不到（这不是遗漏，是结构事实）**：该能力由**第三方 Cordis 插件**提供，不是 DSH 树内包。证据：DSH 的 300+ 个 `@deepseek-ai/*` 包里**没有** `dsh-desktop-notify`（§2 的遍历清单里没有它），而用户 profile 把它当作独立 bundle + 独立依赖引入（`C:\Users\SuSeventeen\.dsh\profiles\web\package.json` 的 `bundles` 列表与 `dependencies` 里都有 `dsh-desktop-notify`，后者是 `link:D:/Program/dsh-desktop-notify`）。

**外部实现逐条核对**（源码 `D:\Program\dsh-desktop-notify`，profile 链接的就是这一份，版本 `2.1.0-led.1`）。下表每一条都是**读实现**得来，不是读文档：

| 接触面 | 外部实现事实 | 证据（`D:\Program\dsh-desktop-notify\`） | 与 OMB 假设 |
| --- | --- | --- | --- |
| 对外 API 版本 | `NOTIFY_API_VERSION = '1.1.0-led.1'`，**主版本仍是 1**（`-led.1` 只标记一条不进主线的串口灯带协议） | `src/api.ts:46`、注释 `:41-45` | ✅ OMB 声明基线 `'1.0.0'`（major 1），语义兼容 |
| 能力清单 | `push` / `pushAlways` / `notify` + `click.session`/`click.page`/`click.url`/`click.legacy-url` + `web-notification` + 本分支的 `led.*` | `src/api.ts:49-69` | ✅ 三个方法都在；`led.*` 是 OMB 不用的新增项，`capabilities` 只用于排除，不影响 |
| 服务面 | `NotifyApi{ apiVersion, capabilities, push→boolean, pushAlways→boolean, notify→NotifyOutcome, led }` | `src/api.ts:93-99`、`:212-235` | ✅ OMB 的 `desktopNotify` 形状探测对得上 |
| 门控：`push` 与 `notify` 同一套 | 两者都走 `deliver()`；`push` 只是返回 `deliver(item).queued`，`notify` 返回完整明细 | `src/api.ts:185-210`（`deliver`）、`:215-217`（push）、`:228-230`（notify） | ✅ 与"门控完全相同、只是返回明细"一致 |
| 门控：`pushAlways` 绕过 | `pushAlways` **直接调 `enqueue()`**，不经 `deliver()`、不看会话聚焦门控 | `src/api.ts:218-227` | ✅ 与"只有 pushAlways 绕过门控"一致 |
| 结果明细字段 | `NotifyOutcome{ ok, queued, silenced, reason('' \| invalid-payload \| silenced \| duplicate \| dropped), apiVersion, unsupportedVersion }` | `src/api.ts:81-91` | ✅ OMB 的 `outcomeOf` 读的 `queued`/`reason`/`ok` 都在 |
| 版本不兼容判定 | **只比主版本**：`major > ownMajor` 才置 `unsupportedVersion` | `src/api.ts:176-183`（`:180-182`） | ✅ OMB 声明 `v: '1.0.0'` → `1 > 1` 为假，不会触发降级 |
| `click` 四态 | `ClickTarget = {none} \| {session, sessionId} \| {page, page} \| {url, url}`；`PageTarget = 'settings-plugins' \| 'plugins'` | `src/protocol.ts:18-22`、`:15` | ✅ 与 OMB 的四态**逐字相同**（含 page 的两个取值） |

**一处**文档与实现不一致（不影响功能）：OMB 的桥注释按对方 `2.0.0` 写（`modules/notify/bridge.ts:69`、`:81`、`:116`），而实际链接的是 `2.1.0-led.1`。实现层面的门控与 click 与 OMB 的假设**完全一致**，所以这是注释陈旧，不是契约破裂。

**OMB 现状**（可核）：

| 事实 | 证据 |
| --- | --- |
| 声明对外 API 基线 `'1.0.0'` | `modules/notify/bridge.ts:76` |
| 发送方法优先序 `notify` → `push` → `pushAlways` | `:92-106` |
| `capabilities` 只用来**排除**，不认识就退回形状探测（不判死） | `:94-101` |
| `click` 四态：`none` / `session` / `page('plugins'\|'settings-plugins')` / `url` | `:116-122` |
| 载荷字段：`title` 必填、`message` ≤400、`urgency` 三档、`sessionId`、`click`、旧写法 `url`、`v` | `:125-146` |

**兼容性判定：兼容。** 需要改什么：**代码不用改**；建议只修注释里的对方版本号（§9 L-1）。

**仍然未验证的一项**（诚实边界）：**桌面是否真的弹出过**——我没有真机推送观测。这不是契约问题，是"存在≠生效"的最后一环：形状对、门控对、调用点存在，仍然可能因为聚焦门控/设置页开关/渠道不可用而从不出现。

**验证方法（可执行）**：在真实 profile 里触发一次会推送的事件（例如关掉一个被依赖的模块行，触发 `kernel/module-graph-changed`），看桌面是否弹出；再读 `notify()` 返回的 `reason`（`silenced` / `dropped` / `duplicate` 会区分原因）。**否证条件**：若服务在、返回 `ok: true` 但桌面从不弹，说明门控之外还有一道（设置页开关/渠道降级）把消息吞了。

---

### 3.7 fs 权威写否决 + 独立 Cordis 行异步挂载

这一条含两个独立问题，分开核。

#### 3.7.a `fs/write-intent` / `fs/edit-intent` 的否决语义

| 事实 | 证据 |
| --- | --- |
| 两个事件都是 **waterfall（单槽决定）**，签名 `(target: FsTarget, actor: object \| undefined, next)` | `packages/fs/fs/src/index.ts:59`（write）、`:67`（edit） |
| 语义：`next()` = 退回"无条件写"；**第一个返回值的监听器拥有决定权，不与同伴组合** | `:51-58`（write 注释）、`:60-66`（edit 注释） |
| 发出点（真实写路径） | `packages/fs/tool-fs/src/write.ts:121`、`edit.ts:133`；`packages/fs/tool-str-replace-editor/src/index.ts:255,289,342` |
| 官方策略插件**占槽但**不调 next（即"接管决定"而不是"否决"） | `packages/fs/fs-observation-policy/src/index.ts:116-122`（注释原文 `occupy the single decision slot — do NOT call next()`） |
| **真正的否决 = 抛**：监听器抛 → `waterfall` reject → 写不发生 | 测试即规范：`packages/deliverables/workspace-changes/tests/current-directory.spec.ts:81-82`（`ctx.on('fs/write-intent', () => { throw new Error('policy denied') })` → `rejects.toThrow('policy denied')`） |

**OMB 现状：不订阅。** 全仓 grep `fs/write-intent|fs/edit-intent|write-intent` → **零命中**。所以这条接触面上 OMB 既没有兼容风险，也**没有**任何写否决能力（这是有意还是遗漏，本档只记录事实）。

**兼容性判定：兼容（无接触）。** 需要改什么：无。

#### 3.7.b 独立 Cordis 行的异步挂载（"一次性收集会漏掉后来挂载的东西"）

**宿主侧机制证据（为什么必然异步）**：

| 事实 | 证据 |
| --- | --- |
| loader 行加载插件是 **`await` 异步 import** | `vendor/loader/src/config/entry.ts:226`（`moduleNamespace = await this.parent.tree.import(this.options.name, …)`） |
| 同一棵树的更新是**并发**跑完再汇合 | `vendor/loader/src/config/tree.ts:47`（`await Promise.allSettled(tasks)`）；`vendor/loader/src/config/group.ts:56` |
| import 走宿主注入的 loader（可拦截） | `vendor/loader/src/internal.ts:58,94` |

⇒ 内核行的 `apply` 是同步跑完的，而模块行的 `apply`（`inject: ['omb:kernel']`）必须等内核发布服务后、在其**异步 import 完成**时才跑 —— 在内核 `apply` 内做一次性收集**必然**得空集。这条推理与 OMB 自己记录的症状一致（`dsh/plugin.ts:327-333`、`tests/dsh/prompt-injection-live.test.ts:1-30`）。

**OMB 现状：两个面都用"用时重扫"而不是"启动快照"**：

| 面 | 做法 | 证据 |
| --- | --- | --- |
| 工具面 | `turn/start` 时重放幂等 `sync()` | `dsh/plugin.ts:293-301`（注释 `:295-298` 写明症状） |
| 提示面 | 传**提供者函数**而不是数组，每次要文本时重扫服务表 | `dsh/plugin.ts:443-446`（`contributions: () => collectPromptContributions(handle.kernel)`）、`:459-479`（`collectToolSpecs` 同样遍历 `kernel.services()`） |
| 回归护栏 | 专门测试"接线**之后**才 provide"的顺序（与真机一致） | `tests/dsh/prompt-injection-live.test.ts:24-30`（文件头断言本文件是防复发的唯一护栏） |

**兼容性判定：兼容（结构层面）。**

**需要改什么**：无强制项。但有一条**证据强度**的保留，见 §8：我没有捕获**真机时序**（内核 apply 那一刻的贡献数 vs 首个 turn/start 之后的贡献数），只有宿主 loader 的异步机制证据 + OMB 的模拟顺序测试。若要把这条从"结构上成立"升级为"实测成立"，需要的证据写在 §8。

**验证方法**：真机首轮对话后看 `omb_status` 的"常驻提示 N/120 字符"是否非零、工具面是否出现 `omb_*` 工具。**否证条件**：若首轮对话里常驻提示恒为 0 而后续轮次才出现，说明"用时重扫"确实在兜；若**始终**为 0，则 `turn/start` 重放与提供者函数两条都没生效。

---

### 3.8 peer 依赖契约

**接触面**：root `package.json` 声明 34 个 `@deepseek-ai/*` peer（用户描述），`autoInstallPeers: false` 不装；需逐一比对 checkout 实际版本与导出。

**先纠正前提**：实际是 **33 条**（32 个 `dsh-*` + 1 个 `cordis`；7 必需 + 26 可选）。34 是基线时代的数字（那时还含 `dsh-desktop-notify`）。完整表见 §7。

**rc.2 侧的关键机制（这是本节的核心，比表本身重要）**：

| 事实 | 证据 |
| --- | --- |
| DSH 判定 DSH 版本要求用 **`includePrerelease: true`** | `packages/boot/app-boot/src/plugin-compatibility.ts:51-53`（`:52`） |
| 有 `engines.dsh` 时它**独自决定**，peer 被完全忽略 | `:57-61`（`return satisfies(…) ? {} : { 'engines.dsh': range }`） |
| 没有 `engines.dsh` 时，**每一个** `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` peer 都必须满足 | `:62-73`（`:69` 的过滤前缀），文档注释 `:77-80` |
| 不满足 → 返回 issue（不抛），由调用方决定 | `:95-101` |
| **启动期**：bundle 的 dsh 要求不满足时是**跳过该 bundle**，且 "nothing is printed"，只进 `skippedBundles` | `packages/boot/app-boot/src/profile.ts:727-733`（注释）、`:759-767`（`throw` 被就地 `catch` 收进 `skippedBundles`） |
| 豁免文件：profile 目录下的 `compatibility.json`，键为 `name@version`、值为**精确** runtime 版本列表 | `packages/boot/app-boot/src/profile-compatibility.ts:10`（文件名）、`:99`（读取）、`:83-87`（键/值校验） |

**semver 实测（node-semver `7.8.5`，与宿主同版本，脚本在 `%TEMP%` 跑、未入仓）**：

```
range             version        默认口径   includePrerelease:true（= DSH 实际口径）
^0.2.0-rc.2       0.2.0-rc.2     true       true
^0.2.0-rc.2       0.2.1-rc.2     false      true     ← 宿主当前版本
^0.2.0-rc.2       0.2.1-rc.1     false      true
^0.2.0-rc.2       0.2.1-alpha.5  false      true
^0.2.0-rc.2       0.2.1          true       true
^0.2.0-rc.2       0.3.0-rc.1     false      false    ← 小版本边界仍然有效
~4.0.4            4.0.5          true       true
~4.0.4            4.1.0          false      false
```

**这张表推翻了基线 §2.2 的结论**。基线只用默认口径测，得出"`^0.2.0-rc.2` **不接受** `0.2.1-rc.1`"，并据此写下"宁可报错也不要静默接受未核验的宿主"。真实情况是：

- DSH 的门用 `includePrerelease`，因此 `^0.2.0-rc.2` **静默接受**任何 `0.2.x` 预发布（含 `0.2.1-alpha.5`、含未来未核验的 `0.2.9-rc.1`）；
- 它能拦住的只有 `0.3.0` 及以上的小版本跳变（两种口径都是 `false`）；
- 也就是说：**这条声明既没有"pin 住已核验宿主"的作用，也没有"未核验就报错"的作用**，它唯一可靠的作用是"拦住小版本跳变"。而它挡不住的那些，**失败方式是静默跳过**（`profile.ts:732-733` "nothing is printed"）。

**"为什么现在还能跑"**：因为 `^0.2.0-rc.2` 在 DSH 的口径下**满足** `0.2.1-rc.2`（上表第 2 行），所以 bundle 不会被跳过。这不是"被豁免"——profile 目录 `C:\Users\SuSeventeen\.dsh\profiles\web` 下**没有** `compatibility.json`（目录里无该文件），豁免表为空。真机旁证：本会话 persona 文本里的 `{{model}}` 已渲染成 `deepseek-flash`，说明 OMB 的 bundle 确实加载了、persona 段确实渲染了。

**另一条独立事实（重要，且与 install 语义相关）**：OMB 对 `@deepseek-ai/*` **零 import**。生产文件 grep `from '@deepseek-ai/` / `require('@deepseek-ai/` → **零命中**；并由 `tests/dsh/no-host-imports.test.ts` 固化成会失败的断言（见 `pnpm-workspace.yaml` 的注释说明）。加之 `autoInstallPeers: false`（`pnpm-workspace.yaml`、`pnpm-lock.yaml:4`），宿主包不会被物理装进本仓库。

⇒ 所以 33 条 peer 的实际作用是**声明 + DSH 门校验**，不是运行期依赖解析。这也意味着：**peer 范围写得宽，代价不是装不上，而是"未核验也照跑"。**

**兼容性判定：需改（口径问题，非当前故障）。**

**需要改什么**（详见 §9）：
1. 给 root `package.json` 补一个 **`engines.dsh`**（例如 `">=0.2.1-rc.2 <0.3.0-0"`）。它一旦存在就**独自决定**（`plugin-compatibility.ts:57-61`），peer 被忽略 —— 这比 33 条 peer 更可控、更可读，也消除"32 条里任意一条膨胀"的噪音。
2. 或者（若保留 peer 路径）把 32 条 `^0.2.0-rc.2` 收窄到真正核验过的范围，但**必须知道**它只在 `0.3.x` 边界上有效，收窄写法的实际约束力有限。
3. 顺手清理 `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude`：**74 条全部钉在 `@0.2.0-rc.2`**，与当前宿主 `0.2.1-rc.2` 已脱节；且其中有 `@deepseek-ai/dsh-invariants@0.2.0-rc.2` 这类**在 rc.2 树内已不存在的包**（`packages`/`vendor` 全遍历无该包名；`packages/core/session/src/invariant.ts` 也已不存在，基线 §3.8 引用的那个文件现已无）。因为 `autoInstallPeers: false` 且零 import，这份清单**当前是惰性的**——但它是陈旧元数据，会误导下一次版本升级。

**验证方法**：在真实 profile 里执行一次 `plugin_manager` 的 list，看 `@omb/plugin` 是否出现在结果里、有无 compatibility 提示；或直接读 `C:\Users\SuSeventeen\.dsh\profiles\web\compatibility.json` 是否存在。**否证条件**：若 `dsh` 把 `includePrerelease` 改成默认口径，则 `0.2.1-rc.2` 会立刻让 OMB 被**静默跳过**（这正是不该依赖当前口径的原因）。

---

## 4. 全仓库 `{{` 插值点清单

搜法：OMB 全仓 `*.ts/*.yml/*.yaml/*.json/*.md/*.mjs`（排除 `node_modules`、`dist`、`lib-gen`、`.git`）grep `\{\{`。

| 文件:行 | 内容（节选） | 变量 | 走 DSH 插值? | 合法性 |
| --- | --- | --- | --- | --- |
| `cordis.patch.yml:104` | `你是运行在「大肥鱼模式」…基于 {{model}} 模型。` | `model` | **是**（persona `prefix` → `deployment:persona-prefix` 段，未设 `interpolate:false`） | ✅ 合法（`agent-loop/src/index.ts:390` 全局注册）；⚠️ 值可能为 `undefined`（§3.1） |
| `cordis.patch.yml:105` | `# **不要再加 \`suffix: 你的工作目录是 {{cwd}}。\`**` | `cwd` | 否（YAML 注释） | — |
| `cordis.patch.yml:108` | `# unknown prompt variable "{{cwd}}" in section "deployment:persona-suffix";` | `cwd` | 否（注释里的**实测错误样本**） | — |
| `cordis.patch.yml:116` | `# …拿 \`{{cwd}}\` 当"未注册变量"的反例来测的）` | `cwd` | 否（注释） | ✅ 该说法在 rc.2 仍成立（`tests/system-prompt.spec.ts:211`） |
| `docs/omb-v3-refactor-plan.md:103` | `renderPrompt(assembly) // 插值 {{var}}…` | `var` | 否（文档） | — |
| `eslint.config.mjs:70-72` | `'反向分层 import：{{from}} → {{to}}（{{source}}）'` 等 | `from`/`to`/`source` | 否（**OMB 自己的 lint 消息模板**，由 OMB 的规则代码替换） | — |
| `eslint.config.mjs:177-178` | `'微内核纯度违规…"{{word}}"（{{where}}）'`、`'…{{file}} 有 {{lines}} 行 > {{budget}} 行。'` | `word`/`where`/`file`/`lines`/`budget` | 否（同上） | — |
| `eslint.config.mjs:248` | `'模块层不得直接取时间（{{what}}）…'` | `what` | 否（同上） | — |

**结论**：**运行时只有 1 个真插值点**（`cordis.patch.yml:104` 的 `{{model}}`），其余全是注释/文档/OMB 自有模板。没有任何残留的非法变量（`{{cwd}}` 已被彻底移除并留了根因注释）。

---

## 5. OMB 源码侧调用点清单（按接触面）

| 接触面 | OMB 调用点 | 关键内容 |
| --- | --- | --- |
| 1 插值 | `cordis.patch.yml:99-104`（persona 行）、`:122-125`（agent-instructions 行，`maxBytes: 65536`） | persona `prefix` 含 `{{model}}`；`suffix` 已删 |
| 2 会话事件 | `dsh/hooks.ts:142-190`；订阅设备 `dsh/plugin.ts:314`（`wireArtifactIndex`） | 唯一 `ctx.on`；`event.type==='tool/call'` + `JSON.parse(data.arguments)` |
| 3 会话投影 | `dsh/pressure.ts:47-55`（键与服务名）、`:205-250`（读 + 优先 `projectedTokens` + 窗口）；接线 `dsh/plugin.ts:305`（`onHostSession: pressure.remember`） | 先查缓存再问 `sessions.get`；四种未测量成因 |
| 4 命令 | `modules/memory/privacy/index.ts:536-604`（注册，`:589` 的 `input`）、`:90-91`（服务名） | 唯一命令 `omb-privacy`，已声明 `input` |
| 5 工具 | `dsh/tools.ts:163-174`（`toHostTool`）、`:122-136`（`cleanJsonRecord`）、`:66-92`（`toolCallContextFromHostExec`）；`dsh/tool-bridge.ts:13,20,140`（重名与最小结构面）；`dsh/plugin.ts:459-479`（收集）、`:293-301`（`turn/start` 重放） | `output` 必填、参数清洗、上下文归属 |
| 6 通知 | `modules/notify/bridge.ts:76`（基线 `1.0.0`）、`:92-106`（方法选择）、`:116-122`（click 四态）、`:125-146`（载荷）；取服务 `dsh/plugin.ts`（`ctx.get('desktopNotify')`） | 纯结构探测，形状不符即降级 |
| 7 fs / 时序 | **无 fs 监听**（零命中）；时序：`dsh/plugin.ts:299-301`（工具重放）、`:443-446`（提示提供者）；护栏 `tests/dsh/prompt-injection-live.test.ts` | 两个面都"用时重扫" |

---

## 6. 33 条 peer 契约表

`R` = 必需（`peerDependenciesMeta` 未标 optional），`O` = 可选。
"声明范围" 取自 OMB `package.json`；"checkout 实际" 取自 DSH checkout 各包 `package.json`。
"满足（DSH 门）" = `semver.satisfies(actual, range, {includePrerelease:true})`，即 `plugin-compatibility.ts:52` 的真实口径。
"满足（默认口径）" = 不带选项，即 npm/pnpm peer 校验的口径。

| 包名 | 声明范围 | 类型 | checkout 实际 | 满足（DSH 门） | 满足（默认口径） |
| --- | --- | --- | --- | --- | --- |
| `@deepseek-ai/cordis` | `~4.0.4` | R | `4.0.5` | ✅ | ✅ |
| `@deepseek-ai/dsh-agent-preset` | `^0.2.0-rc.2` | R | `0.2.1-rc.2` | ✅ | ❌ |
| `@deepseek-ai/dsh-commands` | `^0.2.0-rc.2` | R | `0.2.1-rc.2` | ✅ | ❌ |
| `@deepseek-ai/dsh-session` | `^0.2.0-rc.2` | R | `0.2.1-rc.2` | ✅ | ❌ |
| `@deepseek-ai/dsh-system-prompt` | `^0.2.0-rc.2` | R | `0.2.1-rc.2` | ✅ | ❌ |
| `@deepseek-ai/dsh-token-meter` | `^0.2.0-rc.2` | R | `0.2.1-rc.2` | ✅ | ❌ |
| `@deepseek-ai/dsh-tools` | `^0.2.0-rc.2` | R | `0.2.1-rc.2` | ✅ | ❌ |
| `@deepseek-ai/dsh-agent-instructions` | `^0.2.0-rc.2` | O | `0.2.1-rc.2` | ✅ | ❌ |
| `@deepseek-ai/dsh-command-compact` | `^0.2.0-rc.2` | O | `0.2.1-rc.2` | ✅ | ❌ |
| `@deepseek-ai/dsh-command-goal` | `^0.2.0-rc.2` | O | `0.2.1-rc.2` | ✅ | ❌ |
| `@deepseek-ai/dsh-compaction` | `^0.2.0-rc.2` | O | `0.2.1-rc.2` | ✅ | ❌ |
| `@deepseek-ai/dsh-compaction-basic` | `^0.2.0-rc.2` | O | `0.2.1-rc.2` | ✅ | ❌ |
| `@deepseek-ai/dsh-compaction-tool-result-pruner` | `^0.2.0-rc.2` | O | `0.2.1-rc.2` | ✅ | ❌ |
| `@deepseek-ai/dsh-persona` | `^0.2.0-rc.2` | O | `0.2.1-rc.2` | ✅ | ❌ |
| `@deepseek-ai/dsh-plan-mode` | `^0.2.0-rc.2` | O | `0.2.1-rc.2` | ✅ | ❌ |
| `@deepseek-ai/dsh-plugin-manager` | `^0.2.0-rc.2` | O | `0.2.1-rc.2` | ✅ | ❌ |
| `@deepseek-ai/dsh-skill-filesystem` | `^0.2.0-rc.2` | O | `0.2.1-rc.2` | ✅ | ❌ |
| `@deepseek-ai/dsh-tool-ask-user` | `^0.2.0-rc.2` | O | `0.2.1-rc.2` | ✅ | ❌ |
| `@deepseek-ai/dsh-tool-bash` | `^0.2.0-rc.2` | O | `0.2.1-rc.2` | ✅ | ❌ |
| `@deepseek-ai/dsh-tool-fs` | `^0.2.0-rc.2` | O | `0.2.1-rc.2` | ✅ | ❌ |
| `@deepseek-ai/dsh-tool-fs-search` | `^0.2.0-rc.2` | O | `0.2.1-rc.2` | ✅ | ❌ |
| `@deepseek-ai/dsh-tool-goal` | `^0.2.0-rc.2` | O | `0.2.1-rc.2` | ✅ | ❌ |
| `@deepseek-ai/dsh-tool-jobs` | `^0.2.0-rc.2` | O | `0.2.1-rc.2` | ✅ | ❌ |
| `@deepseek-ai/dsh-tool-present` | `^0.2.0-rc.2` | O | `0.2.1-rc.2` | ✅ | ❌ |
| `@deepseek-ai/dsh-tool-pwsh` | `^0.2.0-rc.2` | O | `0.2.1-rc.2` | ✅ | ❌ |
| `@deepseek-ai/dsh-tool-ralph` | `^0.2.0-rc.2` | O | `0.2.1-rc.2` | ✅ | ❌ |
| `@deepseek-ai/dsh-tool-skill` | `^0.2.0-rc.2` | O | `0.2.1-rc.2` | ✅ | ❌ |
| `@deepseek-ai/dsh-tool-subagent` | `^0.2.0-rc.2` | O | `0.2.1-rc.2` | ✅ | ❌ |
| `@deepseek-ai/dsh-tool-subagent-control` | `^0.2.0-rc.2` | O | `0.2.1-rc.2` | ✅ | ❌ |
| `@deepseek-ai/dsh-tool-todo` | `^0.2.0-rc.2` | O | `0.2.1-rc.2` | ✅ | ❌ |
| `@deepseek-ai/dsh-tool-web` | `^0.2.0-rc.2` | O | `0.2.1-rc.2` | ✅ | ❌ |
| `@deepseek-ai/dsh-tool-workflow` | `^0.2.0-rc.2` | O | `0.2.1-rc.2` | ✅ | ❌ |
| `@deepseek-ai/dsh-workflow-ptc` | `^0.2.0-rc.2` | O | `0.2.1-rc.2` | ✅ | ❌ |

**汇总**：33 条全部**在 checkout 内存在**、版本号只有两种（`0.2.1-rc.2` / `4.0.5`），**零缺失、零改名、零拆分**。DSH 门口径下 **33/33 满足**；默认口径下 **1/33 满足**（仅 cordis）。
**OMB 实际用到的导出**：**零个**。全仓对 `@deepseek-ai/*` 零 import（grep 为空 + `tests/dsh/no-host-imports.test.ts` 固化）；对宿主的一切访问都经 `ctx.get()`/`ctx.on()`/`ctx.effect()` 的结构化最小接口（`dsh/plugin.ts` 顶部三条硬约束）。

---

## 7. 与基线的差异（需要更新基线的地方）

| 基线位置 | 基线说法 | rc.2 实况 | 影响 |
| --- | --- | --- | --- |
| §2.2 | `^0.2.0-rc.2` **不接受** `0.2.1-rc.1`，据此主张"宁可报错不要静默接受未核验宿主" | **错**（在 DSH 实际口径下）。`includePrerelease:true` 时接受 `0.2.1-rc.1`/`-rc.2`/`-alpha.5` 全部 | 高：这条是当年定 peer 范围的依据 |
| §2.3 | 27 个可选 peer（含 `dsh-desktop-notify`） | 26 个可选，`dsh-desktop-notify` 已**整个移除** | 中：总数 34 → 33 |
| §2.4 | `pnpm-lock.yaml:4 settings.autoInstallPeers: true` | **`false`**（`pnpm-lock.yaml:4` + `pnpm-workspace.yaml`） | 中：安装副作用已消失，但也失去"peer 会被解析校验"这一层 |
| §3.6 | 引用 `known-event-types.ts:73` | 现在 `:75`（内容不变） | 低：仅行号平移 |
| §3.8 | 引用 `core/session/src/invariant.ts:94-112` | **该文件已不存在**（`packages/core/session/src/` 无 `invariant.ts`） | 低：OMB 不使用该不变量，但引用已失效 |
| §4.3 | `compaction` 组三行逐行开 | 开/关决定本身未复核（不在本任务 8 个接触面内）；宿主侧三个包在 rc.2 仍在且版本为 `0.2.1-rc.2` | 待后续任务 |
| §3.10/§8.5 | `dsh-desktop-notify` npm `1.4.1`、`*` 范围 | 已无 peer；profile 实际链接外部源码版本 `2.1.0-led.1`，OMB 注释按 `2.0.0` 写 | 中：见 §3.6 |

---

## 8. 未做到 / 无法确认（如实列出，含"缺什么"）

1. **`desktopNotify` 的契约已核完，但"真的弹过"仍未观测**（§3.6）。协议不在 DSH 树内（零命中是结构事实），外部实现 `D:\Program\dsh-desktop-notify@2.1.0-led.1` 的 API 版本/能力清单/门控/click 四态已逐条读过并与 OMB 假设一致。**仍缺**：真机一次桌面弹出的观测（`notify()` 的 `reason` 可区分 `silenced`/`dropped`/`duplicate`）。
2. **异步挂载只到"结构性成立"，未捕获真机时序**（§3.7.b）。我有的证据是宿主 loader 的异步 import（`entry.ts:226`）+ OMB 的模拟迟到测试；**没有**的是真机上"内核 `apply` 那一刻贡献数 = 0，首个 `turn/start` 之后 = N"的成对读数。缺：一次带计数的启动日志（`dsh/plugin.ts:326-334` 的 debug 日志在 `config.debug === true` 时会打印"此刻可见的提示贡献 N 个"，正是为此设计的），或 `omb_status` 首轮前后的对照。
3. **`rc.1 → rc.2`（456 文件）与 `0.2.0-rc.2 → HEAD`（8431 文件）没有逐条审**。本档只对用户点名的 8 个接触面做定点核；其余（`jobs`、`workspace`、`profileContext` 的提供者、`agent-preset` 内层 `plugins` schema 等）**未逐条核**——因为 OMB 当前代码不读它们或只做存在性探测。
4. **`compaction` 三行在真机是否激活未验**。本档只确认了三个包在 rc.2 仍存在（`compaction`/`compaction-basic`/`compaction-tool-result-pruner`），没有核 `cordis.patch.yml` 的装配结果。缺：真机 `install_bundle` 的 application 结果或 `dsh: warning: N entries did not activate`。
5. **`minimumReleaseAgeExclude` 的 74 条是否需要清理**只做事实记录（全部钉 `0.2.0-rc.2`、含树内已不存在的 `dsh-invariants`），未核它是否会影响任何实际安装路径（`autoInstallPeers: false` 下看起来是惰性的）。
6. **未做任何写操作/构建/包管理器/git 操作**（任务硬边界）。本档所有结论来自只读 grep/read + 两个纯只读 node 脚本（semver 实测、peer 表 join），临时文件只写在 `$env:TEMP`。

---

## 9. 结论与建议改动清单（按风险排序；**本任务不实施**）

### 风险等级：高

**H-1. 给 root `package.json` 补 `engines.dsh`，把"版本契约"从 32 条 peer 收敛成一条。**
- 改哪个文件的哪一行：`package.json`，在顶层（与 `"version"` 同级）新增 `"engines": { "dsh": ">=0.2.1-rc.2 <0.3.0-0" }`。
- 为什么：一旦存在 `engines.dsh`，`plugin-compatibility.ts:57-61` 就**只用它**、完全忽略 peer。这样契约**一条可读**，且不再依赖 `includePrerelease` 的偶然宽容。
- 注意：范围**必须**带 `-rc.2` 预发布段，否则 `semver` 在同样口径下要显式覆盖预发布；建议直接照抄实测通过的写法并在任务三用 `semver.satisfies('0.2.1-rc.2', …)` 自证。
- 验证方法：改后跑 `node -e` 用 `includePrerelease:true` 断言 `0.2.1-rc.2` 满足、`0.2.0-rc.2` 不满足（后者是刻意的：0.2.0 从未被本档核过）。

**H-2. 处理 `{{model}}` 的空值分支（§3.1）。**
- 最小改动：把 `cordis.patch.yml:104` 的 `{{model}}` 去掉——
  `你是运行在「大肥鱼模式」（OMB v3 认知增强）下的智能体，基于 {{model}} 模型。`
  → `你是运行在「大肥鱼模式」（OMB v3 认知增强）下的智能体。`
  （模型身份已由 DSH 自己的通道提供给模型，重复一遍只是多一处会炸的变量——与当年删 `{{cwd}}` 是同一个理由。）
- 备选（保留动态模型名）：在 OMB 的 `dsh/` 层**不能**重名注册 `model`（会抛"already registered"），因此只能换名自算：`ctx.systemPrompt.variable('omb_model', ctx => …)`，但拿不到 agent 的 model 就没意义（`AssembleContext.agent` 是宿主增强字段，OMB 可读）。这条路成本高、收益低。
- 验证方法：构造 `delete agent.options.model` 的 agent，`renderPrompt(assemble(...))` 不应抛；且真机首轮 persona 文本里不出现字面 `{{model}}`。

### 风险等级：中

**M-1. 记录并（可选）清理 `pnpm-workspace.yaml` 的陈旧元数据。**
- `minimumReleaseAgeExclude` 的 74 条全部钉 `@0.2.0-rc.2`，与 `0.2.1-rc.2` 宿主脱节；其中 `@deepseek-ai/dsh-invariants@0.2.0-rc.2` 已无对应包。
- 改哪个文件：`pnpm-workspace.yaml`。建议整体重生成或整段删除（`autoInstallPeers: false` + 零 import 下该清单是惰性的）。
- 验证方法：`pnpm install --lockfile-only` 后 lockfile 无 diff（或按任务三的门禁跑一遍）。

**M-2. 修正文档里两处已被证伪的说法（避免下次据此错判）。**
- `docs/dsh-compatibility.md` §2.2 的"不接受 `0.2.1-rc.1`"结论需加限定：**仅在 semver 默认口径下成立**；DSH 实际用 `includePrerelease: true`，接受一切 `0.2.x` 预发布。
- 关于 `commands.register` 的"重名静默覆盖"：实为**同层抛错**（`store.ts:45`），只有跨作用域才是有意遮蔽。若要写进文档/注释，请按此更正。

### 风险等级：低（只记录，建议不动）

**L-1. `desktopNotify` 代码不动，只把注释里的"对方版本"写对。**
- `modules/notify/bridge.ts:69`、`:81`、`:116` 三处注释按对方 `2.0.0` 写，而 profile 实际链接 `D:\Program\dsh-desktop-notify@2.1.0-led.1`（`src/api.ts:46` 的 `NOTIFY_API_VERSION = '1.1.0-led.1'`）。
- 门控与 click 四态在 `2.1.0-led.1` 里**未变**（§3.6 表），所以是注释陈旧，不是契约破裂。建议注释改成"协议基线 1.0.0；对方版本随安装变化，不构成契约"。
- 验证方法：改完后真机触发一次 `kernel/module-graph-changed`，看 `notify()` 返回的 `reason` 为空（已入队）还是 `silenced`。

**L-2. 基线里两条失效引用**（`known-event-types.ts:73→75`、`invariant.ts` 已不存在）建议在下次维护 `docs/dsh-compatibility.md` 时一并修掉。

---

## 10. 复验方法（下次换宿主版本时按此执行）

1. **版本**：`git describe --tags --always` + 遍历 `packages/**/package.json`、`vendor/**/package.json` 核对 `dsh-*` 与 `cordis` 实际版本。
2. **插值**：`grep -n '{{' ` 全仓；对每个生效插值点，确认变量在 `agent-loop/src/index.ts` 的注册表里，且 provider **可能返回 undefined 时不至于炸**。
3. **事件**：确认 `core/session/src/index.ts` 的 `session/event` 签名仍是 `(session, event)`，`types.ts` 的 `tool/call.data.arguments` 仍是 `string`。
4. **投影**：确认 `session-projection` 的 `stateOf` 第一参仍是 `Session`，`token-meter/src/projection.ts` 的键名与三个字段名未变。
5. **命令**：确认 `client/ui-commands` 里 `desc.input === undefined → 不认领` 的判定还在（尤其 `matchEnter` 的 `if (!bare) return undefined`）。
6. **工具**：确认 `register` 仍强制 `output`、`parameters` 仍走 lossless 投影、`ToolExecutionInput.agent` 仍在根上。
7. **peer**：用 `includePrerelease: true` 重跑 semver 断言（**不要用默认口径**），并检查 `app-boot/src/profile.ts` 的"跳过 bundle 且不打印"行为是否还在。
8. **"真的发生了"**：每一条都要有**行为级**观测（`omb_files` 有内容 / `fillRatio` 非空 / 命令有 `command/run` / 桌面上真的弹出），不能只凭"注册成功/健康面绿"。

> 本档最贵的一条仍然是基线那句：**存在 ≠ 生效。** 本轮的等价物是 §3.8 —— 一条看起来在 pin 版本的 peer 声明，在宿主的真实判定口径下什么也没 pin；而它若真的不满足，失败方式是"什么都看不见"。

---

## 11. 追加复核：大肥鱼模式的预设写法与"基于创造模式"是否成立

> 问题（用户原话）："核对新模式的正确写法，确保大肥鱼模式基于创造模式构建正常，工具配置完全而没有遗漏等。"
> 结论先说：**写法正确（就是 rc.2 的官方写法），装配可行（本会话即运行在该预设下），但工具行有 3 处遗漏、1 个已废弃字段、3 行应在 rc.2 已删除的残留。**

### 11.1 预设声明写法是否仍是 rc.2 的正确 schema

`@deepseek-ai/dsh-agent-preset` 的实现只有 30 行（`packages/preset/agent-preset/src/index.ts`），逐条对 OMB 的写法：

| 契约 | rc.2 实现 | OMB 写法 | 判定 |
| --- | --- | --- | --- |
| 挂哪个服务 | `static inject = ['agentPresets']`（`:13`） | 行 `name: '@deepseek-ai/dsh-agent-preset'`（`cordis.patch.yml:93`） | ✅ 官方就是"一行 `dsh-agent-preset`" |
| `plugins` 如何成为子行 | `static readonly [EntryGroup.key] = true`（`:15`）+ 注释"Preserve child expressions until their own plugins activate" | `config.plugins:` 数组（`:99` 起） | ✅ 必须靠这个标记；OMB 用了官方形态 |
| config schema | `z.object({ id: required, name: string, description: string, order: number, plugins: z.array(z.any()).required() })`（`:16-23`） | `id: omb` / `name: 大肥鱼模式` / `description: …` / `order: 10` / `plugins: [...]`（`:95-99`） | ✅ 字段名逐字命中；`name`/`description`/`order` 均为**可选**，OMB 全给了 |
| 提交给谁 | `[Service.init]` → `ctx.agentPresets.register(this.config)`（`:27-29`） | — | ✅ 无需额外代码 |
| 类型契约 | `PresetDefinition{ id; name?; description?; order?; plugins }`（`agent-preset-registry/src/definition.ts:5-11`） | 同上 | ✅ |
| `plugins` 元素允许什么 | `Omit<EntryOptions,'id'\|'disabled'> & { id?: string; disabled?: EntryOptions['disabled'] \| JsExpr }`（`definition.ts:10`） | 用 `id` / `name` / `config` / `disabled: !!js …` | ✅ `disabled` 明确允许 `JsExpr`（`!!js` 是一等公民） |
| YAML 结构校验 | `entryListProblem`（`definition.ts:18-39`）：顶层必须是数组；每行必须是对象且 `name` 为非空字符串；`group: true` 的 `config` 递归校验 | 顶层就是数组；每行都有 `name`；`planning`/`compaction`/`delegation` 三个 `cordis:group` 的 `config` 也是数组 | ✅ 结构合法 |
| **显示名从哪来** | `display.ts`：内置 id（`standard`/`ptc`/`minimal`/`cordis`）且**未发布 name** → 走 locale 字典；**其余一律 `name ?? id`**（`:70`） | `id: omb` + `name: 大肥鱼模式` | ✅ **这正是自定义预设拿到显示名的唯一正确途径**；不写 `name` 就会显示 id `omb` |
| `order` 语义 | `AgentPreset.order?`（`agent-preset-registry/src/preset.ts:8`），供列表排序 | `order: 10`（官方 `standard: 1`、`cordis: 4`） | ✅ 排在官方四项之后 |
| 预设如何被选中 | registry `Config{ default: string; selectedDefault: Volatile<string\|undefined> }`（`preset.ts:13-17`）；部署在 `packages/bundle/web-app/cordis.patch.yml:586-589` 配 `default: standard` | OMB 不改 default | ✅ OMB 模式需用户手动选；**不会**自动成为默认 |

**结论 11.1：OMB 的预设声明就是 rc.2 的官方正确写法**，没有任何已废弃字段或缺失的必填字段（`name`/`description` 不是"新字段"而是**自定义预设的显示名通道**，见 `display.ts:47-55` 的 `isBuiltInPreset` 定义）。

**rc.2 相对 0.2.0-rc.2 在该目录改了什么**（`git diff dsh-v0.2.0-rc.2..HEAD -- packages/preset`，43 文件 +432/−391）：全部落在 README/skills/locale/package.json 与 `skills.spec.ts`，**没有**改 `PresetDefinition` 的字段集、没有改 `Config` schema、没有改 `display.ts` 的选中规则。即：**预设声明写法在 0.2.1-rc.2 未变**。

### 11.2 与 DSH 自带创造模式逐行对照

rc.2 的创造模式 = `packages/bundle/web-app/presets/cordis.patch.yml`（`id: cordis`、`order: 4`；**不发布 `name`** → 显示名来自 locale `presetCordisName: '创造模式'`，`packages/client/ui-agent-preset/src/client/locales.ts:101`）。

**先看 rc.2 相对 0.2.0-rc.2 对该文件改了什么**（`git diff dsh-v0.2.0-rc.2..HEAD -- packages/bundle/web-app/presets/cordis.patch.yml`，只列增删行）：

```diff
-              suffix: Your working directory is {{cwd}}.          ← 上游自己也删了！（OMB 的 {{cwd}} 教训与上游同源）
+          - id: time-context
+            name: '@deepseek-ai/dsh-time-context'
+          - id: tool-schedule
+            name: '@deepseek-ai/dsh-tool-schedule'
-                    You are in plan mode. Stay in plan mode until exit_plan_mode succeeds or the user switches the session mode. …
+                    You are in plan mode. Stay in plan mode until the user approves your plan through exit_plan_mode or switches the session mode. …
-                  backgroundMode: continuable                      ← ×2，字段已从 Config 移除
-              - id: tool-subagent-codex        (disabled: true)    ← 整行删除
-              - id: tool-subagent-claude-code  (disabled: true)    ← 整行删除
-              - id: tool-ralph                 (disabled: true)    ← 整行删除
+          - id: tool-plugin-market
+            name: '@deepseek-ai/dsh-plugin-market/tools'
+            disabled: !!js "!ctx.get('profileContext')"
```

**逐行对照表**（左=rc.2 创造模式行号；右=OMB `cordis.patch.yml` 行号）：

| # | 创造模式行（id / name） | rc.2 位置 | OMB | 判定 |
| --- | --- | --- | --- | --- |
| 1 | `persona` / `@deepseek-ai/dsh-persona`（prefix 含 `{{model}}`） | `:13-17` | 有，`:100-104` | **配置漂移（有意）**：文案是 OMB 自己的中文人格；同样用 `{{model}}`（该变量合法，见 §3.1 的余量风险） |
| 2 | `agent-instructions` / `maxBytes: 65536` | `:18-21` | 有，`:122-125` | ✅ 相同 |
| 3 | `time-context` / `@deepseek-ai/dsh-time-context` | `:22-23` | **无** | ❌ **遗漏**（该包 rc.2 存在：`packages/context/time-context`，description = "Durable per-step context with the current time and elapsed time" → 模型拿不到当前时间/已过时间） |
| 4 | `tool-bash` / `disabled: !!js process.platform === 'win32'` | `:24-26` | 有，`:150-152` | ✅ 逐字相同 |
| 5 | `tool-pwsh` / `disabled: !!js process.platform !== 'win32'` | `:27-29` | 有，`:153-155` | ✅ 逐字相同 |
| 6 | `tool-fs` | `:30-31` | 有，`:156-157` | ✅ |
| 7 | `tool-fs-search` / `sampleOverCapGlobResults: false` | `:32-35` | 有，`:158-161` | ✅ 相同 |
| 8 | `tool-jobs` | `:36-37` | 有，`:162-163` | ✅ |
| 9 | `tool-schedule` / `@deepseek-ai/dsh-tool-schedule` | `:38-39` | **无** | ❌ **遗漏**（包在 rc.2 存在：description = "Model-facing reminder management tools (schedule_create/list/update/delete)"） |
| 10 | `command-goal` | `:40-41` | 有，`:164-165` | ✅ |
| 11 | `tool-goal` | `:42-43` | 有，`:166-167` | ✅ |
| 12 | `planning` 组（`isolate: {planMode: true}`）+ `plan-mode` | `:44-64` | 有，`:168-188` | ⚠️ **配置漂移**：OMB 的 `section` 首句是 **0.2.0-rc.2 旧版**（"until exit_plan_mode succeeds"），rc.2 已改为 "until the user approves your plan through exit_plan_mode" |
| 13 | `compaction` 组（`isolate: {compaction, toolResultPruner}`）+ 3 行（含 `8192/4096/1024`） | `:65-81` | 有，`:204-220` | ✅ 逐字相同 |
| 14 | `delegation` 组（`isolate: {workflowEngine: true}`）→ `tool-subagent-control`、`…/list-agents` | `:82-92` | 有，`:221-230` | ✅ 相同（子路径导出存在：`tool-subagent-control/package.json` 的 `exports` 含 `./list-agents`） |
| 15 | → `tool-subagent`（spawn）、`tool-subagent-fork`（fork） | `:93-103` | 有，`:231-243` | ⚠️ **OMB 多写了 `backgroundMode: continuable`**（`:237`、`:243`）——**该字段在 rc.2 已不存在**（见 11.3） |
| 16 | → `workflow-ptc`、`tool-workflow` | `:104-108` | 有，`:260-265` | ✅ |
| 17 | ~~`tool-subagent-codex`~~ / ~~`tool-subagent-claude-code`~~ / ~~`tool-ralph`~~ | **rc.2 已删** | OMB 仍有，`:244-259`、`:266-271`（均 `disabled: true`） | ⚠️ **多余残留**（自 0.2.0-rc.2 抄来）；因 `disabled`，挂载审计跳过（`agent-preset-registry/src/mount.ts:139`）→ 无害但误导 |
| 18 | `tool-ask-user` | `:109-110` | 有，`:272-273` | ✅ |
| 19 | `tool-todo` / `allowParallelInProgress: true` | `:111-114` | 有，`:274-277` | ✅ 相同 |
| 20 | `tool-web` / `fetch: true, searchTimeoutMs: 60000` | `:115-119` | 有，`:278-282` | ✅ 相同 |
| 21 | `tool-cordis` / `@deepseek-ai/dsh-tool-cordis` | `:120-121` | **无** | ✅ **可接受的遗漏**：OMB 注释写明理由（"给'改 DSH 自身'用，与 OMB 的日常认知任务无关"，`cordis.patch.yml:141-143`）。代价：没有 `cordis_inspect_*` 一族工具 |
| 22 | `skill-filesystem` / `customSkillDirs: [!!js … dsh-agent-preset … /skills]` | `:122-126` | 有，`:283-287` | ✅ 逐字相同（同一个 `!!js` 表达式） |
| 23 | `tool-skill` | `:127-128` | 有，`:288-289` | ✅ |
| 24 | `present` / `@deepseek-ai/dsh-tool-present` | `:129-130` | 有，`:290-291` | ✅ |
| 25 | `tool-plugin-manager` / `@deepseek-ai/dsh-plugin-manager/tools` / `disabled: !!js "!ctx.get('profileContext')"` | `:131-133` | 有，`:292-294` | ✅ 逐字相同（子路径导出存在：`plugin-manager/package.json` 的 `exports` 含 `./tools`） |
| 26 | `tool-plugin-market` / `@deepseek-ai/dsh-plugin-market/tools` / 同一 `!!js` 条件 | `:134-135` | **无** | ❌ **遗漏**（导出存在：`plugin-market/package.json` 的 `exports` 含 `./tools`） |

**"工具配置完全而没有遗漏"这个断言不成立**。rc.2 创造模式的工具/工具运行品行共 **20 个**（`tool-bash`、`tool-pwsh`、`tool-fs`、`tool-fs-search`、`tool-jobs`、`tool-schedule`、`tool-goal`、`tool-subagent-control`、`tool-subagent-control/list-agents`、`tool-subagent`(spawn)、`tool-subagent`(fork)、`workflow-ptc`、`tool-workflow`、`tool-ask-user`、`tool-todo`、`tool-web`、`tool-cordis`、`tool-skill`、`present`、`tool-plugin-manager`、`tool-plugin-market` —— 按行数计 21，其中 `workflow-ptc` 是 PTC 运行时而非工具本身）。OMB 缺：

| 缺失行 | 性质 | 影响 | 是否可接受 |
| --- | --- | --- | --- |
| `tool-schedule` | **工具** | 模型没有 `schedule_*` 一族工具 | ❌ 不可接受（与创造模式不对齐） |
| `tool-plugin-market` | **工具**（条件启用） | 模型没有插件市场工具 | ⚠️ 影响小（standard 预设里它是 `disabled: true`），但对齐应补 |
| `tool-cordis` | **工具** | 没有 `cordis_inspect_*` | ✅ 可接受（有文档理由） |
| `time-context` | **上下文**（非工具） | 模型拿不到当前时间/已过时间 | ❌ 不可接受（与创造模式不对齐，且不需要任何 OMB 侧适配） |

**本会话就是活证据**（旁证）：我的系统提示里 persona 段是 `cordis.patch.yml:104` 的逐字文本、`{{model}}` 已插值为 `deepseek-flash` → **大肥鱼模式预设确实挂载成功**；同时我的工具面里**没有** `schedule_*`、runtime context 里**没有**当前时间 → 与"缺 `tool-schedule` / `time-context`"一致。（严格说这是我的自观测，不是仪表读数，故列为旁证。）

### 11.3 实际装配可行性

| 问题 | 事实 | 证据 | 对 OMB 的判定 |
| --- | --- | --- | --- |
| `plugins` 元素是裸包名还是相对路径 | 两种都行；解析基座由挂载方传入：`mountPreset` 调 `prepareProfileEntries(ctx, plugins, ctx.baseUrl)` | `agent-preset-registry/src/mount.ts:209`；doc `:199`（"Scope context inheriting the declaring Loader's resolution base"） | OMB 全用**裸包名** `@deepseek-ai/dsh-*`，与官方逐字同构 → ✅ 可解析 |
| 是否支持子路径包名 | 官方自己就用 `@deepseek-ai/dsh-tool-subagent-control/list-agents`、`…/plugin-manager/tools`、`…/plugin-market/tools` | `presets/cordis.patch.yml:91,132,135` | OMB 同样用它们 → ✅ |
| `!!js` 求值时机/上下文 | loader 用 `new Function('ctx','expr',…)`；`disabled` 在**读该 entry 的 disabled 时**用 `this.ctx` 求值 | `vendor/loader/src/config/utils.ts:5,11-14`；`vendor/loader/src/config/entry.ts:88-98` | OMB 的 `!!js process.platform…` 与 `!!js "!ctx.get('profileContext')"` 与官方**逐字相同** → ✅ 未变 |
| 表达式会不会被过早求值 | 不会：`agent-preset` 用 `EntryGroup.key = true` 专门"把子表达式保留到子插件激活时" | `agent-preset/src/index.ts:14-15` | ✅ 这是官方为预设行设的机制 |
| 未知 config 字段会怎样 | **不报错**：`Schema.resolve` 默认 `strict = false`（`vendor/schemastery/src/index.ts:515`），object 分支 `if (!strict) merge(result, data)`（`:821`）把**未声明的键原样合并**进结果 | 同上 | ⚠️ `backgroundMode` **不会**让行失败，而是**静默无效**（`tool-subagent` 的 `Config` 里没有它，`packages/subagent/tool-subagent/src/index.ts:80-99`；`apply()` 只对 `persona`/`toolFilter` 显式抛错 `:147-151`） |
| 行失败会怎样 | `mountPreset` 在 `auditRows` 后：有 failed 行 → **抛**（整个预设挂载失败）；有服务泄漏 → **抛** | `mount.ts:204-216`（`:212`、`:213`） | 若真有非法行，表现是"选大肥鱼模式直接失败"，不会静默 |
| `disabled` 行参与审计吗 | 不参与：`if (entry.disabled) continue` | `mount.ts:138-139` | OMB 的 codex/claude-code/ralph 三行 → 无害 |
| 挂载时还会再跑兼容性预检 | `prepareProfileEntries` → `preflight`：不满足 dsh 要求的行被 `disabled = true` 并写 stderr 一行；`profileContext` 缺失时整体放行 | `packages/boot/app-boot/src/compatibility-preflight.ts:74-84`、`:93-94`、`:114-118` | 预设内全是 `@deepseek-ai/dsh-*`（peer 用 `workspace:*` → 视为当前 runtime 版本，`plugin-compatibility.ts:70`）→ ✅ 不会被禁 |
| `backgroundMode` 的历史 | 0.2.0-rc.2 存在（预设与 `bundle/base/cordis.patch.yml` 都有）；**0.2.1-rc.1 起消失**，全仓 `packages/` 零命中 | `git grep backgroundMode dsh-v0.2.0-rc.2 -- packages`（命中 `presets/cordis.patch.yml:95,101,108,116` 等）；`git grep … dsh-v0.2.1-rc.1` → exit 1；HEAD `packages/` 零命中 | ⚠️ OMB 停在旧写法的**唯一实际痕迹**是这两行；无害但应删 |

**护栏覆盖（空白要写清）**：

| 已有测试 | 覆盖什么 | 是否覆盖预设 |
| --- | --- | --- |
| `tests/dsh/assembly.smoke.test.ts` | 真实 `MODULE_ENTRIES` + 真实内核装配：模块不被阻断、健康、工具服务注册、提示贡献可收集、卸载清零 | ❌ 只到内核/模块层，**完全不碰 DSH 的 preset YAML** |
| `tests/kernel/abi.contract.test.ts:53-116` | `cordis.patch.yml` 的行 id ↔ `MODULE_IDS` ↔ catalog 三方一致 | ❌ 只比对 `id: <moduleId>` 字符串；`:75-77` 收集 name 时**只收 `@omb/` 前缀**，预设里的 `@deepseek-ai/dsh-*` 全被过滤掉 |
| `tests/dsh/module-graph-source.test.ts:32,45` | 行级 `inject` 与模块目录漂移 | ❌ 注释明写"预设行 `preset-omb` 与它内部的插件行缩进不同、id 也不以 `omb-` 开头，**天然排除**" |
| `tests/dsh/modules.test.ts:37,214-256` | 模块入口 ↔ 目录 | ❌ 同上 |

⇒ **`preset-omb.config.plugins` 目前零测试覆盖**：没有任何测试断言它的行存在、字段在目标 DSH 版本合法、或与创造模式对账。这正是"遗漏 3 行 + 残留 1 个废弃字段"能长期存在而门禁全绿的原因（与 §6.2/§3.7 的"存在≠生效"同源）。

### 11.4 `desktopNotify` 事实升级（覆盖 §3.6/§8 的旧结论）

旧结论"无法确认"已作废，改为**已核**。要点（详细表见 §3.6）：

- `NOTIFY_API_VERSION = '1.1.0-led.1'`，主版本仍 1 → OMB 声明 `v: '1.0.0'` 不会触发 `unsupportedVersion`（`src/api.ts:46`、`:176-183`）。
- `capabilities` 含 `push` / `pushAlways` / `notify`（`src/api.ts:49-52`）。
- `notify()` 与 `push()` **同一个 `deliver()`**，只是返回不同（`src/api.ts:185-210`、`:215-217`、`:228-230`）→ 与"门控完全相同、只是返回明细"一致。
- `pushAlways()` **直接 `enqueue()`**，绕过门控（`src/api.ts:218-227`）。
- `click` 四态 `none|session|page|url`，`page` 白名单 `settings-plugins|plugins`（`src/protocol.ts:15,18-22`）→ 与 OMB 的 `:116-122` 逐字一致。
- 唯一残留：OMB 注释按对方 `2.0.0` 写，实际链接 `2.1.0-led.1` → 注释陈旧（§9 L-1）。
- 仍未验证：**桌面真的弹过没有**（§8 第 1 条）。

peer 部分同时确认：**33 条**（32 个 `dsh-*` + `cordis`）、`includePrerelease:true` 下 `^0.2.0-rc.2` 接受 `0.2.1-rc.2`（§3.8 的表与结论不变）。

### 11.5 本节新增的建议改动（接 §9 编号，按风险排序；**仍未实施**）

**H-3. 补 `time-context` 行**（模型失去"当前时间/已过时间"这条上下文；与 OMB 自身能力无关，纯属对齐遗漏）。
- 改哪个文件哪一行：`cordis.patch.yml`，在 `:163`（`tool-jobs` 的 `name` 行）之后插入：
  ```yaml
            - id: time-context
              name: '@deepseek-ai/dsh-time-context'
  ```
- 位置依据：创造模式把它放在 `agent-instructions` 之后、`tool-bash` 之前（`presets/cordis.patch.yml:22-23`）；放 `tool-jobs` 之后同样安全（预设行顺序不影响行为，只影响插件页展示）。
- 验证方法：启用后看随回合上下文里是否出现时间戳；**否证条件**：若加了行仍无时间，说明该包还依赖其他前置（如 `settings`），需看 `auditRows` 是否把它列为 pending。

**H-4. 补 `tool-schedule` 行**（模型没有 `schedule_*` 工具）。
- 改哪一行：`cordis.patch.yml`，在 `:163` 之后（与 H-3 一起）：
  ```yaml
            - id: tool-schedule
              name: '@deepseek-ai/dsh-tool-schedule'
  ```
- 验证方法：模型工具面出现 `schedule_create/list/update/delete`；**否证条件**：若出现但在 pending 列表里（`mount.ts:152-155`），说明缺 `ctx.schedule` 服务，需在宿主平面启用 schedule。

**M-3. 删除两处已废弃的 `backgroundMode`**。
- 改哪一行：`cordis.patch.yml:237`、`:243` 各删一行 `backgroundMode: continuable`。
- 理由：rc.2 的 `tool-subagent` `Config` 无此字段（`packages/subagent/tool-subagent/src/index.ts:80-99`），schemastery `strict=false` 会把它原样合并（`vendor/schemastery/src/index.ts:821`）→ **不报错、也不生效**。这是本节最"存在≠生效"的一条：YAML 里写着，读起来像配置了后台可续，实际什么也没配。
- 注意：**不要**改成别的字段来"恢复"该行为。rc.2 里 continuable 已是运行时概念（`SubagentCatalogEntry.mode`），不是 tool-subagent 的配置项；相关提交 `8344d64363 feat(subagent): default continuable delegation to background` 表明它已成默认。
- 验证方法：删后预设仍能挂载（`git diff` 只少两行）；**否证条件**：若删后行为变化（子代理不再可续），说明 rc.2 仍有别处读这个键——但全仓 grep 为零命中，不可能。

**M-4. 删除三行 rc.2 已移除的残留行**（`tool-subagent-codex` `:244-251`、`tool-subagent-claude-code` `:252-259`、`tool-ralph` `:266-271`）。
- 理由：rc.2 创造模式已把它们整行删除（§11.2 的 diff）。它们 `disabled: true`，`auditRows` 跳过（`mount.ts:139`），所以**当前无害**；保留的代价是"看起来 OMB 模式支持 codex/claude-code/ralph 三种委派"这一假象。
- 若**保留**则必须接受一个风险：某天有人把 `disabled` 改成 `false`，`provider: codex` 会因为对应 provider 未注册而让整个预设挂载失败（`mount.ts:212`）。删掉可以消除这个陷阱。
- 验证方法：删后插件页行数减 3，其余不变。

**M-5. 补 `tool-plugin-market` 行**（与创造模式对齐；也是 `!!js` 条件行）。
- 改哪一行：`cordis.patch.yml`，在 `:294` 之后追加：
  ```yaml
            - id: tool-plugin-market
              name: '@deepseek-ai/dsh-plugin-market/tools'
              disabled: !!js "!ctx.get('profileContext')"
  ```
- 优先级低于 H-3/H-4：它在官方 `standard` 预设里也是 `disabled: true`（`presets/standard.patch.yml:126-128`），影响面小。

**L-3. 对齐 `plan-mode` 的 `section` 文案**（低风险，纯漂移）。
- 改哪里：`cordis.patch.yml:178` 首句 "Stay in plan mode until `exit_plan_mode` succeeds or the user switches the session mode." → 与 rc.2 一致："…until the user approves your plan through exit_plan_mode or switches the session mode."
- 为什么值得改：旧文案的"成功即退出"与新文案的"用户批准才退出"在**审批被拒**的场景下语义不同；这是行为指引，不是装饰。
- 验证方法：改后与 `presets/cordis.patch.yml:54` 首句逐字比对。

**L-4. 补一条会失败的护栏（本节最重要的"防复发"项）**。
- 新增测试（建议放 `tests/dsh/preset-composition.test.ts`）：解析 `cordis.patch.yml` 的 `preset-omb.config.plugins`，断言
  （a）每行的 `name` 去掉子路径后能在 DSH checkout 里解析到包；
  （b）每行的 `config` 键集合 ⊆ 该包 `Config` 声明（可从 `lib/types/index.d.ts` 提取，或对 `@deepseek-ai/dsh-tool-subagent` 直接用已知键表）；
  （c）工具行集合与 `packages/bundle/web-app/presets/cordis.patch.yml` 的差集 == `{tool-cordis}`（即唯一允许的遗漏）。
- 理由：现在 `preset-omb` 的 `plugins` **零覆盖**（§11.3 表），本条能把 H-3/H-4/M-3/M-4/M-5 一起钉死。

### 11.6 本节的否证条件

- **若"写法正确"判断错**：真机预设卡片显示的是 `omb` 而不是"大肥鱼模式"（说明 `name` 没被 `display.ts:70` 读到），或选该预设时 `mountPreset` 抛 `row … : …`（`mount.ts:212`）。
- **若"遗漏 3 行"判断错**：加了 `time-context` / `tool-schedule` 后工具面与上下文**没有任何变化**（说明它们本就被别处提供）；或 `tool-plugin-market` 加后立刻变 pending（说明宿主平面没提供它需要的服务）。
- **若"`backgroundMode` 无害"判断错**：删这两行后子代理委派行为发生变化（但 HEAD 全仓该键零命中，故此情形几乎不可能）。
- **若"装配可行"判断错**：预设能加载但 `auditRows` 报 pending（`mount.ts:152-155`），说明某些行在等宿主服务——那时要看的不是 YAML，而是宿主平面缺哪个服务。

---

## 12. Lead 复核与落地（2026-10-18）

> 本节记录 Lead 在证据档之上做的**独立复核**与**实际改动**；只说已发生的事。门禁与实测输出见 §12.3。

### 12.1 独立复核（重读源码，不抄结论）

| 复核点 | 结果 | 证据 |
| --- | --- | --- |
| 内置提示变量只有 `provider`/`model`；未注册与 `undefined` 都抛 | ✅ | `packages/core/agent-loop/src/index.ts:389-390`；`packages/core/system-prompt/src/index.ts:365-372` |
| OMB 全仓插值点只有 `{{model}}`（无 `{{cwd}}`） | ✅ | `cordis.patch.yml:104`；已固化为 `tests/dsh/host-contract.test.ts` |
| `ctx.on('tool/call')` 不触发、走 `session/event` 且 `arguments: string` | ✅ | `packages/core/session/src/known-event-types.ts:75`、`types.ts:362`；OMB 唯一 `ctx.on` 在 `dsh/hooks.ts:142` |
| `stateOf(session, key)` 与三个投影键/字段未变 | ✅ | `packages/session/session-projection/src/index.ts:320-328`；`packages/llm/token-meter/src/projection.ts:36-76` |
| 命令未声明 `input` → `/cmd args` 当普通消息 | ✅ | `packages/client/ui-commands/src/client/service.ts:299,361`；OMB 命令已带 `input`（`modules/memory/privacy/index.ts:589`） |
| 命令/工具同层重名**抛错**（不是静默覆盖） | ✅ | `packages/core/scope/src/store.ts:45`；`tools.register` 走同一 `NamedEntries` |
| `tools.register` 强制 `output`、`parameters` 原样投影、`agent` 在根上 | ✅ | `packages/core/tools/src/index.ts:1074-1078`、`:1290-1302`、`:340` |
| `desktopNotify` 协议（改从外部插件源码核，不看 DSH checkout） | ✅ | `D:\Program\dsh-desktop-notify` 2.1.0-led.1：`src/api.ts:46` API `1.1.0-led.1`；`:49-52` capabilities；`:185-230` `notify`/`push` 同一 `deliver()`、`pushAlways` 绕门控；`src/protocol.ts:18-22` click 四态；`:176-183` 只比主版本 → 基线 `1.0.0` 不被判 unsupported |
| `fs/write-intent`/`fs/edit-intent` 语义未变，OMB 无接触 | ✅ | `packages/fs/fs/src/index.ts:59,67`；`fs/tool-fs/src/write.ts:121`、`edit.ts:133`；OMB 零 `ctx.on('fs/*-intent')` |
| 异步挂载 → 一次性收集必漏；OMB 用"用时重扫" | ✅ 结构层 | `vendor/loader/src/config/entry.ts:226`；`dsh/plugin.ts:293-301`、`:443-446` |
| DSH 兼容门在 `includePrerelease: true` 下接受引擎范围 | ✅ 实测 | §12.3 |
| 大肥鱼模式预设 = rc.2 官方写法；32 行全部可解析 | ✅ 实测 | §12.3 |

### 12.2 已落地改动

| # | 改动 | 文件 | 验证 |
| --- | --- | --- | --- |
| 1 | 版本契约收敛为一条 `engines.dsh = ">=0.2.0-rc.2 <=0.2.1-rc.2"`（下限 0.2.0-rc.2、上限钉在最后一次核过的 0.2.1-rc.2；0.2.1 正式版与 0.2.2-* 未核过，一律拒绝） | `package.json` | DSH 自己的 `evaluatePluginCompatibility` 实测（§12.3）+ 新测试先红后绿 |
| 2 | 预设对齐 rc.2 创造模式：新增 `time-context` / `tool-schedule` / `tool-plugin-market`；删除 `tool-subagent-codex` / `-claude-code` / `tool-ralph` 与 `backgroundMode`；`plan-mode` 文案换成 rc.2 版本 | `cordis.patch.yml` | `tests/dsh/preset-composition.test.ts` 先红后绿 + schema 解析实测（§12.3） |
| 3 | peer 契约补 3 条（`dsh-time-context` / `dsh-tool-schedule` / `dsh-plugin-market`，均 optional），总数 33 → 36 | `package.json`、`pnpm-workspace.yaml` 注释 | 同测试 |
| 4 | 新增两条护栏：插值变量清单 + 预设行清单（本仓库第一次覆盖 `preset-omb.config.plugins`） | `tests/dsh/host-contract.test.ts`、`tests/dsh/preset-composition.test.ts` | vitest 红→绿 |
| 5 | `desktopNotify` 注释版本对齐真机（2.0.0 → 2.x / 2.1.0-led.1，API 1.1.0-led.1） | `modules/notify/bridge.ts` | 源码实测 |
| 6 | 基线档加勘误 banner（semver 口径、重名覆盖两处已被证伪） | `docs/dsh-compatibility.md` | — |

### 12.3 实测原始输出（摘要）

**DSH 兼容门对 `engines.dsh` 的判定**（rc.2 自己的 `evaluatePluginCompatibility`）：

```text
engines.dsh = >=0.2.0-rc.2 <=0.2.1-rc.2
runtime 0.2.0-rc.2: ADMITTED
runtime 0.2.1-rc.2: ADMITTED   ← 本轮核过的构建
runtime 0.2.0-rc.3: ADMITTED   ← 同 patch 线的预发布，语义上仍属 0.2.0
runtime 0.2.1:      DENIED     ← 正式版未核过，拒绝
runtime 0.2.9-rc.1: DENIED     ← 未核过
runtime 0.3.0-rc.1: DENIED
```

**预设解析**（`yaml.JSON_SCHEMA.extend(!!js scalar)`，与 `vendor/include/src/index.ts:9-23` 同一套）：

```text
YAML 解析：ok，顶层条目 1
preset-omb：id=omb name=大肥鱼模式 order=10 plugins=22
32 行（含 3 个 group 的子行）全部解析到 DSH rc.2 树里的包（版本一律 0.2.1-rc.2）：
  time-context / tool-schedule / tool-plugin-market 已在列；
  tool-plugin-manager 与 tool-plugin-market 是 `!!js "!ctx.get('profileContext')"` 条件行；
  tool-bash / tool-pwsh 按平台条件；
  @omb/{kernel,memory,memory-vector,profile,reasoning,context,artifact,notify} 8 行都在。
全部行都能解析，且 rc.2 对齐检查通过
```

### 12.4 未采纳 / 只记录

- **H-2（去掉 `{{model}}`）未采纳**：它不是 rc.2 的不兼容——`model` 是宿主注册变量，主代理路径有默认模型兜底；而 persona 前缀是**用户手写的人格文本**，删掉会改变模型看到的人格。余量风险（值为 `undefined` 时整轮失败）已写进 §3.1 并留了否证条件。
- **M-1（`minimumReleaseAgeExclude` 74 条陈旧）只记录**：`autoInstallPeers: false` + 零 import 下是惰性元数据，清理属于版本升级动作。
- **`tool-cordis` 仍是有意省略**（唯一允许的差异），已由测试把"省略"变成显式断言。

### 12.5 重启后待验（行为级证据）

1. `omb_status`：8 模块 0 降级；`omb-memory-vector = bge-small-zh-v1.5-512`。
2. 工具面出现 `schedule_*`（`tool-schedule` 生效）与 `plugin_market_*`（`tool-plugin-market` 生效）。
3. runtime context 出现当前时间段（`time-context` 生效）。
4. 预设卡片仍显示"大肥鱼模式"、`{{model}}` 渲染为具体模型名（persona 段生效）。

### 12.6 重启后实测验收（2026-10-18，已通过）

用户重启 `dsh web` 后，`omb_status` 的原始关键行：

```text
## 构建
- 代数：第 83 代（产物目录 lib-gen/g83）
- 磁盘代数：第 83 代（与加载代数一致）          ← 重启前是"加载 82 / 磁盘 83"

## 模块
- omb-memory-vector：正常——向量通道：神经嵌入 bge-small-zh-v1.5-512（512 维，revision 1）
...
合计：7 个模块，0 降级，0 失败。              ← 7 个"自报模块"；内核不算模块，见下
（模块依赖图）已按依赖顺序挂载 8 个模块；顺序自检通过（行序 = cordis.patch.yml）
（组件自述 · omb-memory-vector）权重目录：C:\Users\SuSeventeen\.dsh\profiles\web\node_modules\@omb\plugin\models\bge-small-zh-v1.5
（组件自述 · omb-notify）已接上宿主 desktopNotify（通道 notify（对外 API 1.1.0-led.1 …））
```

- **向量模型来自副本**：权重目录是 `…\@omb\plugin\models\bge-small-zh-v1.5`（不再是 `D:\Program\…`），
  `id = bge-small-zh-v1.5-512`，装载期降级原因：无。
- **8 个模块挂载、0 降级 0 失败**（`omb_status` 的模块段列 7 个自报模块，内核不参与自报，依赖图另有"挂载 8 个模块"）。
- **`tool-schedule` 生效**：重启后的工具目录新增 `schedule_create` / `schedule_list` / `schedule_update` / `schedule_delete`。
- **`time-context` 生效**：本回合的系统提示出现 `Time sampled while preparing turn 2, step 1: 2026-10-18T13:13:40+08:00`。
- **`tool-plugin-market` 的行为属协议预期**：该包的 tools 只在 `pluginMarket` 服务挂载时才注册
  （`packages/boot/plugin-market/src/tools.ts:66-68` 原文："The service comes from the optional custom plugin
  markets bundle, so a preset can keep this row without the tool appearing or the row waiting"）。
  本 profile 的 `dshmarket` 是第三方 UI 市场，不提供该服务 → 行保留、工具不出现、行不 pending。
  这与 DSH 自带创造模式完全同构，不是遗漏。
- **副本 → 云端同步**：`origin/main` = `327b0dd`；副本 `fetch origin` 后 `reset --hard origin/main`
  （因为上一提交被 amend 改写了历史，不是 fast-forward），`status` 干净；38 项安装验收全绿。
- 重启前锁住的 `__DELETE-AFTER-DSH-RESTART__plugin-old-3.6.0` 已删除，`@omb` 下现在只有
  9 个安装目录 + `README-CLONE.md` + `relink-components.mjs`。
- 待人工一步：把 `dsh-path-guard` 的 `selfProtection` 开回来（改 `profile/package.json` 时临时关闭的）。
