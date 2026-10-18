# R4 —— DSH 0.2.1-rc.2 原生能力图谱与会话搜索集成研究

- 研究线程：DSH 原生能力 / 会话搜索 / 宿主侧集成判据
- 宿主：`D:\Program\deepseek-harness`，tag `dsh-v0.2.1-rc.2`，commit `687f282e86`（只读）
- 运行 profile：`C:\Users\SuSeventeen\.dsh\profiles\web`
- OMB 仓库：`D:\Program\Oh-My-BigBlueFish`（本报告是唯一写盘产物；未改代码、未跑 git、未装包）
- 证据分级：**[实测]**＝本次真跑出来的命令/输出；**[源码]**＝只读源码行；**[报告]**＝他人（Lead/R5）已测；**[推测]**＝由前两者推导、未端到端验证

---

## 0. 结论速览（给 Lead 的 8 句判词）

1. **根 realm 有一个 `sessionQuery` 服务，可以拿到**——`dsh-base` 在根层装了 `@deepseek-ai/dsh-session-query-sqlite`，配置 `path: ':memory:'`、`openAt: never`；`openAt: never` 的语义是"**精确读、标题、谱系照常可用，只有全文搜索被禁用**"（`packages/bundle/base/cordis.patch.yml:149-161`）。所以 "OMB 能不能用 sessionQuery" 的答案是：**能用，但只能用精确读那一半**。
2. **带搜索的那一个 `sessionQuery` 实例拿不到**——它由 `@deepseek-ai/dsh-experimental-session-search` 的 bundle patch 放进带 `isolate: { sessionQuery: true }` 的组（`packages/experimental/session-search/cordis.patch.yml:1-14`）。隔离用组私有 Symbol 做键（`vendor/cordis/src/reflect.ts:286-292`、`vendor/loader/src/config/isolate.ts:49-68`），根 realm 解析不到；R5 已用真 Loader 实证"组内拿得到、根层 `null`"。
3. **`session_search` 在当前语料规模下不可用，根因不是并发、是"冷建索引 + 30s 硬超时 + 全有或全无"**：索引一次调用里要观测 391 个会话（283.7MB 压缩 / **1021.7MB 解压** / 145,107 个 zstd frame / 256,582 条 JSONL 记录），全部装完才开事务写入；30s 一到被超时守卫中止，**一条都没写进去**，下次重来。所以 4/4 超时是必然，不是运气。
4. **超时后不会"后台接着建"**：中止点都在写事务之前（`_observeStable`→`assertNotAborted`），异常抛出、串行队列释放，索引仍是空的；进程内 `:memory:` 也不跨重启。
5. **`session_event_search` 与 `session_search` 同命运**（都走 `searchEvents`/`searchSessions`，都要那个 FTS 后端）；**`session_trace` 与 `session_event_read` 不建索引、秒回**——本次 [实测] 两次调用均即时返回。
6. **采用率接近零（6 次 / 391 会话）的可解释原因**：能力常驻成本 ~1,190 token/请求（5 个工具 schema 3,976 字符 ≈ 1,105 token + 常驻提示段 315 字符 ≈ 88 token，[实测] 用真插件定义量出来的），可用性却是 0（每次都 30s 超时），且 OMB 自己的 `omb_recall` 已经在做跨会话召回——模型有一个更便宜、更快的同类入口。
7. **给三条研究线程的最强结论**：宿主已经有"会话日志的规范读取层"（精确读/标题/谱系/事件窗）且根 realm 可达；**不要自己再解析 `session.jsonl.zstd`**。搜索这一半宿主当前是坏的，**要么修宿主索引，要么在 OMB 侧自建索引**，不要在两者之间做第三条半吊子路。
8. **一个必须马上改的习惯**：`ctx.sessionQuery` 这种属性读在未 `inject` 的行里会抛 `cannot get property "sessionQuery" without inject`（`vendor/cordis/src/reflect.ts:144`）；OMB 现在的 `ctx.get()`+try/catch 写法（`dsh/host.ts:69-77`）是对的，继续用它。

---

## 1. 能力矩阵

### 1.1 表（契约 / 源 / realm / OMB 能否用 / 与 OMB 现有机制的关系 / token 与缓存代价）

| # | 宿主面 | 契约摘要 | 源（file:line） | realm / isolate 注意 | 根 realm 的 OMB 能否在运行期用 | 对 OMB 现有机制的先验/替代关系 | token / 缓存影响 |
|---|---|---|---|---|---|---|---|
| 1 | `sessionSearch` 5 工具（模型面） | 5 个工具：`session_search` / `session_event_search` / `session_trace` / `session_event_trace` / `session_event_read`；前两个 30s 预算，后三个无预算 | `packages/experimental/tool-session-query/src/index.ts:19,36-39,51-54,65-121` | 工具注册在**根** `tools` 服务上（全局可见）；工具**实现**用的 `sessionQuery` 是隔离组内的搜索实例 | 能"看见"，不能"当函数调"（见 §1.2 机制 B） | 与 `omb_recall`/`omb_relate` 功能重叠（跨会话召回），宿主版**当前不可用** | 常驻 3,976 字符 schema ≈ **1,105 token/请求**；+ 315 字符提示段 ≈ 88 token [实测] |
| 2 | `sessionQuery` 服务（**根实例**） | 抽象 `SessionQueryEngine`，服务名 `sessionQuery`，`inject: ['sessions']`；精确读：`listSessions`/`readSession`/`filterSessions`/`readTitle*`/`listEvents`/`filterEvents`/`readSurface`/`traceSession`/`traceEvent`/`readEvent`；FTS：`searchSessions`/`searchEvents` | `packages/session-query/session-query/src/index.ts:98-99,106,153,164,174,184,206,220,269,280,310,327,340,355`；过滤子 `types.ts:199,205-210` | 根层 provider：`dsh-base` 行 `session-query-sqlite`（`:memory:`+`openAt: never`），web-app 重申同值；未 disabled | **能**（`ctx.get('sessionQuery')`，无需 inject）；搜索方法抛 `SESSION_QUERY_SEARCH_DISABLED` | **应当替代** OMB 记忆里任何"自己找会话/自己解析日志/自己折标题"的实现 | 零常驻 token；调用期有 I/O（冷读会话日志），按会话大小线性 |
| 3 | `sessionQuery` 服务（**搜索实例**） | 同上，后端 SQLite FTS5；`:memory:`、`openAt: first-search` | `packages/experimental/session-search/cordis.patch.yml:1-14`；`packages/session-query/session-query-sqlite/src/index.ts:89,204,206-224` | **组私有 realm**（`isolate: {sessionQuery: true}`） | **不能**（R5 实证同构机制：根层 `null`） | 想用它的唯一合法姿势是"模型调工具" | 见 #1 |
| 4 | `contextPressure` / `tokenUsage` / `contextBreakdown` 会话投影 | 三个投影的键与字段（`pressureTokens`/`projectedTokens`/`contextWindow`；`uncachedInputTokens`/`outputTokens`/`cacheReadTokens`/`cacheWriteTokens`；`systemTokens`/`toolsTokens`/`messageTokens`） | `packages/llm/token-meter/src/projection.ts:13-18,30-48,59-66,68-77`；读取 `ctx.sessionProjections.stateOf(session,key)` | 根层（`session-projection` 在 base），无 isolate | **已经在用**（`dsh/pressure.ts:47-49,205-263`） | 已是 OMB 压力度量真源，**不要再自己算** | 零常驻；每次 measure O(surface) |
| 5 | `tokenMeter` 服务 | `measure(session, requestHeader?)` → `{header,nodes,assistantTokens,usage}`；`estimateMessage` | `packages/llm/token-meter/src/index.ts:101-116,146,214` | 根层（web-app 明说"token METER 留在 host plane"：`packages/bundle/web-app/cordis.patch.yml:532-537`） | **能**（`ctx.get('tokenMeter')`） | 与 #4 同源；OMB 只需投影，不必直接调 | 零常驻 |
| 6 | `compaction` 服务 | 抽象 `CompactionEngine`（`ctx.compaction`）：触发策略/保留/摘要，成功则用**一个摘要节点**替换一段 surface；事件 `compaction/summary-error`（waterfall） | `packages/compaction/compaction/src/index.ts`（`CompactionEngine`、`CompactionTrigger`、`ManualCompactionError`） | **预设组隔离**：根层三行被 web-app `disabled`（`:539-546`），实现在 `preset-omb` 的 `compaction` 组（OMB `cordis.patch.yml:216-232`，`isolate: {compaction:true}`） | **不能**（R5 实证：根层 `null`） | 与 OMB 上下文轴不冲突（OMB 只读压力、不改历史） | 压缩本身要调一次模型；OMB 无感 |
| 7 | `compaction-basic` 配置 | `thresholdRatio` 默认 **0.8**、`headroomTokens` 默认 **65,536**、`retainRatio` 默认 **0.16**；`modelPolicies[]` 可按模型覆盖 | `packages/compaction/compaction-basic/src/config.ts:20,23,75-80`；`src/index.ts:114,116-119` | 同上 | 只能改**自己预设里那一行**的 config（改文件+新会话） | OMB 的软压力档位（0.3/0.6）在 0.8 之前转"读数+索引"，互补 | — |
| 8 | `toolResultPruner` | 确定性裁剪：超 `thresholdChars`(8192) 保留 head 4096 + tail 1024，中间换成固定标记；原文经 shadowed 节点可追回；`inject: ['tokenMeter']` | `packages/compaction/compaction-tool-result-pruner/src/config.ts:11-16`；`src/index.ts:44-52` | 预设组隔离（同上） | **不能**直接调；但**效果作用在 OMB 的工具输出上**（见风险 R6） | OMB 无需重复实现；但 OMB 大输出工具必须按 8192 设计 | 削减 token（正向） |
| 9 | `systemPrompt` 段注册 | `ctx.systemPrompt.section({name, order, text, …})`；集中分配 order；`getSectionOrder(name)` | `packages/core/system-prompt/src/index.ts:131-165,150,478-486,494-496` | 根层服务、全局段（无 scope）→ **所有 agent 都吃** | **能**（OMB 已在用：`dsh/session.ts` 的 `wirePromptInjection`） | OMB 的常驻预算必须把宿主段算进去（当前 315 字符 → 88 token） | 常驻；静态文本，首请求后不抖动缓存 |
| 10 | `tools` 注册表 | `register(definition)` 返回 disposer；`get(name, scope)`；`schemas(scope)`；**同名注册会抛**；`output { schema, render }` 必需 | `packages/core/tools/src/index.ts:1071,1238,1268`；形状校验 `src/schema.ts:574-575`；`output` 缺失抛错见 OMB `dsh/tool-bridge.ts:140-149` 的实测注释 | 根层 | **能**（OMB 已用） | OMB 的 `tool-bridge` 就是这条路；**不要注册 `session_search` 等 5 个名字** | 每个工具都进 schema（见 #1） |
| 11 | `commands` 注册表 | 服务名 `commands`（斜杠命令） | `packages/interaction/commands/src/index.ts:277` | 根层 | **能**（OMB 内核行 `inject: ['commands']`，`dsh/plugin.ts:66`） | `/omb-privacy` 已走这条 | 命令不进 schema，几乎零成本 |
| 12 | 会话事件 `session/event` | `(session, event)`；payload 的 `args[0]` **就是** Session 对象；`sessions` 服务 `get(id)`/`list()` | `packages/core/session/src/index.ts:74,1077,1352,1360` | 根层 | **能**（OMB 已订阅） | OMB 压力桥的 Session→sessionId 映射就是靠它 | 零常驻 |
| 13 | `sessionProjections` 注册表 | `register(definition)` / `stateOf(session, key)` | `packages/llm/token-meter/src/index.ts:114-116` 调用；读取同 #4 | 根层 | **能** | 已用 | 零常驻 |
| 14 | `subagent` / `workflow` / `goal` / `todo` / `plan` | 都是**工具 + 预设行**：`tool-subagent`/`tool-subagent-fork`、`workflow-ptc`+`tool-workflow`（`isolate: {workflowEngine:true}`）、`tool-goal`、`tool-todo`、`plan-mode`（`isolate: {planMode:true}`） | OMB `cordis.patch.yml:176-259`（逐行照抄创造模式）；id 列表同 `packages/bundle/web-app/presets/cordis.patch.yml` | 全在 **preset-omb** 里；`workflowEngine`/`planMode` 隔离 | 工具**模型可用**；服务**程序不可用**（根层拿不到 `planMode`/`workflowEngine`） | OMB 只能"用工具"，不能"用引擎"；不要试图从插件里驱动 workflow | 工具的 schema 常驻成本由宿主预设承担 |
| 15 | `skill` | 技能目录 + `tool-skill` 工具；`skill-filesystem` 带 `customSkillDirs` | OMB `cordis.patch.yml:271-277` | 预设内 | 工具可用；服务是根层（`skill` 包） | OMB 的 `omb_method` 与 skill 是两套"按需拉取正文"，**不要互相镜像** | 仅目录进提示，正文按需 |
| 16 | `hooks` | `hook-protocol` 是**非插件库**：matcher/外部命令执行/输出合并/事件落库；bridge 是 Claude Code / Codex 两种方言 | `packages/experimental/hook-protocol/src/index.ts:1-6` | 根层 bridge → 用户 settings 配的**外部命令** | **不能**"注册一个 hook"；只能提供外部可执行文件 + 让用户写 settings | 不是 OMB 的集成面（除非 OMB 出一个命令行入口） | 零常驻 |
| 17 | `auto-review` | **不是"质量复审"**：是 `Auto` 权限预设的 **LLM 授权闸门**——每个原生工具调用（含 PTC 内层）在**执行 body 之前**被审一次，deny 时按审批策略问人/直接拒 | `packages/experimental/auto-review/src/index.ts:1-7` | 根层实验包（`OPTIONAL_BUNDLES` 之一） | 语义上"能用"（它是 gate），但**不是**推理/答案复审 | **结论线程要纠正的误读**：它不是"第二意见 reviewer" | 每次工具调用一次模型审 → 贵 |
| 18 | `sessionTitle` | 服务 `sessionTitle`；投影 `title`/`titleInput`；provider 可换（`session-title-first-prompt-llm`） | `packages/session/session-title/src/index.ts:317,344-346`；base `:60-68` | 根层 | **能**（`ctx.get('sessionTitle')`） | `session_search` 输出里的标题就来自它；OMB 记忆若要"会话摘要"，建议读它而不是再调一次模型 | 零常驻 |
| 19 | `OPTIONAL_BUNDLES`（可开关的官方 bundle 名单） | 12 个；含 session-search / ralph / terminal / badge-skill / session-titles / agent-team / voice-input / cot-translation / auto-review / inspector / plugin-market / tool-worktree | `packages/boot/app-boot/src/profile.ts:223-236` | 由 profile `package.json` 的 `dsh.profile.bundles` 决定是否加载 | 只读事实 | OMB 可以在「装什么」层面判断某个能力是"可选开"还是"默认开" | 关掉 bundle 直接省掉它的常驻成本 |
| 20 | 工具调用超时守卫 | `timeout-policy` 读 `ToolDefinition.timeoutMs`，用 `deadline(exec.signal,…)` 武装，超时替换成 `tool call timed out after Nms`；`timeoutMs` **永远不下发给模型** | `packages/guard/timeout-policy/src/index.ts:25,41-42,57-74`；base 行 `:408-409` | 根层 | 只读事实（这是"30s"的来源） | 决定 `session_search` 失败形态的就是它 | 零常驻 |

### 1.2 机制（为什么"能不能用"是这样的）

**A. `ctx.get(name)` 与 `ctx.name` 不是一回事**

- `ctx.get` 落到 `ctx.reflect.get` → 查 **调用者 ctx 的 isolate 映射** 指向的 store 槽（`vendor/cordis/src/reflect.ts:233-243`），**不要求 inject**。
- `ctx.name` 走代理 `get` 陷阱：未在 `inject` 里声明 → `internal/get` waterfall → 沿 fiber 链找 `fiber.store[name]`，找不到就抛 `cannot get property "name" without inject`（`vendor/cordis/src/reflect.ts:136-171,144`）。只有 `inject` 里列出的名字才会被 `fiber._checkImpl` 预装进 `store`（`vendor/cordis/src/fiber.ts:315-319,597-609`）。
- 因此 OMB 现在"只 inject `commands`、其余一律 `ctx.get` + try/catch"（`dsh/plugin.ts:66`、`dsh/host.ts:69-77`）是**对的**，也是唯一能同时满足"可选降级"与"热插拔"的写法。

**B. 隔离组的服务根 realm 拿不到，但根 realm 自己的同名服务拿得到**

本次用真 `@deepseek-ai/cordis`（`vendor/cordis/lib/index.js`）做了一次最小 realm 探针 [实测]（命令见 §5 P3），结论：

```
[["omb gated inject","ROOT"],["root.get","ROOT"],["fresh ctx.get","ROOT"]]
```

- 根层有 provider 时，根层的消费者（含"后来才挂上的行"、以及 `root.extend({})` 出来的新 ctx）`ctx.get('sessionQuery')` 都拿到 **ROOT** 实例；
- 属性读 `ctx.sessionQuery` 在**没有 inject** 的行里抛 `cannot get property "sessionQuery" without inject`；
- 带 `inject: ['sessionQuery']` 的行会被 Cordis **门控**到 provider 激活之后才 `apply`（本次 `omb gated inject` 一次拿到 ROOT）——这与 R5 §4 的"inject 未满足 = 静默 PENDING"是同一机制的两面。
- 隔离组里的同名 provider 使用**组私有 Symbol**（`reflect.ts:286-292`），根层解析的键不同 → 拿不到（R5 §3.3 已用真 Loader 实证 `rootRealmEngine: null`；本线程未重复整树探针）。

**C. 一个容易漏的时序坑** [实测]

第一次探针里，**同一批**挂载的消费者在 provider 激活前调用 `ctx.get` 得到 `null`（provider fiber 尚未 ACTIVE）；200ms 后再读就是 `ROOT`。所以 OMB 若要用根 `sessionQuery`：

- 要么在行上写 `inject: ['sessionQuery']`（被门控，provider 不在则**静默 PENDING**，整行什么都不做——这是 R5 记录的静默型风险）；
- 要么保持现状（不 inject），**每次调用时解析、未就绪就降级**（OMB 现有 `readService` 风格），并如实把"未就绪"写进状态面。

推荐后者（与 OMB 对 `desktopNotify` 的处理一致，`dsh/plugin.ts:149-232`）。

---

## 2. 会话搜索深挖（含 30s 超时根因）

### 2.1 它是怎么拼起来的 [源码]

| 环节 | 事实 | 源 |
|---|---|---|
| 挂载位置 | session-search bundle 的 patch 在**根 include 树**里插了一个组 `optional-session-search`，`isolate: {sessionQuery:true}`，组内两行：`optional-session-query-sqlite`（`path:' :memory:'`、`openAt:'first-search'`）+ `optional-tool-session-query` | `packages/experimental/session-search/cordis.patch.yml:1-14` |
| 本机是否加载 | 本 profile 的 bundles 列表里有 `@deepseek-ai/dsh-experimental-session-search` | `C:\Users\SuSeventeen\.dsh\profiles\web\package.json:15` |
| 服务契约 | `SessionQueryEngine`（抽象类，服务名 `sessionQuery`） | `packages/session-query/session-query/src/index.ts:98-99,106` |
| 后端 | SQLite **FTS5**（`tokenize='unicode61'`），持久表 `persisted_sessions`+`persisted_docs`；**连接级 TEMP 表** `live_sessions`+`temp.live_docs` 存进程内活跃会话；schema 版本 8 | `packages/session-query/session-query-sqlite/src/schema.ts:8,103-139,141-169` |
| 打开时机 | `openAt: 'startup' | 'first-search' | 'never'`；`first-search` ⇒ 首次搜索才 import `node:sqlite` 并开库 | 同 `index.ts:89,264-266,360-381` |
| 建索引时机 | **每次 search 都 `_reconcile`**：`persistence.list()` → 逐会话比对 `revision` → 只冷读变化过的会话 → 再 `persistence.list()` 比对快照 → 有写入才 `BEGIN IMMEDIATE` 批量替换 | 同 `index.ts:407-493,495-562` |
| 冷读成本 | 每个非 live 会话 `readColdSessionLog`（打开 handle、整段读、校验）；live 会话直接 `observeLive` | 同 `index.ts:513-526,548-554`；`packages/session-query/session-query/src/cold-read.ts:31-57` |
| 稳定性重试 | 观测期间持久快照变了 / live 会话集合变了 → 重试，**最多 2 次**，还不行抛 `SESSION_QUERY_PERSISTENCE_FAILED: …did not stabilize after one retry` | 同 `index.ts:86,495-562` |
| 串行化 | 所有操作过 `_serialized`（FIFO 门），同一进程同时只有一个 search 在跑 | 同 `index.ts:383-405` |
| 搜索开关 | `openAt:'never'` ⇒ `searchSessions/searchEvents` 抛 `SESSION_QUERY_SEARCH_DISABLED`，**SQLite 从不 import**；精确读照常 | 同 `index.ts:333-344` |

### 2.2 五个工具的模型面形状 [源码 + 实测]

| 工具 | 参数（要点） | 输出形状 | 是否需要 FTS 后端 |
|---|---|---|---|
| `session_search` | `query`（必填，字面全文）、`session_ids[]`、`created_at_from/to`、`parent_session_ids[]`、`include_root_sessions`、`availability[]`(live/persisted)、`event_seq_from/to`、`event_time_from/to`、`event_types[]`、`event_surfaces[]`(current/shadowed/log-only) | 每个会话 1 条命中，6 行：`N. Session <id> — <title>` / Created / Parent / Availability / Best match: seq|type|surface|time / `Snippet: <240 字符>`；上限 100；截断追加一行"Result cap reached" | **是** |
| `session_event_search` | `session_id`（缺省=当前会话）、`query`、`seq_from/to`、`time_from/to`、`event_types[]`、`surfaces[]` | 每个事件 2 行：`N. seq x | type | surface | time` + `Snippet:`；上限 100 | **是** |
| `session_trace` | `session_id?` | 目标会话头 + 祖先（nearest first）+ 后代树 | 否（`traceSession`） |
| `session_event_trace` | `session_id?`、`seq`（必填） | 该事件在 surface 上的直接替换与关系 | 否（`traceEvent`） |
| `session_event_read` | `session_id?`、`seq`、`before?`、`after?` | 目标事件**完整未删减** JSON + 前后若干 raw 事件摘要 | 否（`readEvent`） |

参数定义：`packages/experimental/tool-session-query/src/input.ts:45-67,69-82,84-86`；输出渲染：`src/presentation.ts:48-106`（search）/`:108-…`（trace/read）。

**授权与作用域**（重要，OMB 若自己实现必须照做）：

- 调用者必须有 `exec.agent`，否则 `SESSION_QUERY_TOOL_MISSING_AGENT`；调用者会话无 `cwd` ⇒ `SESSION_QUERY_TOOL_UNAUTHORIZED`（`src/operations.ts:61-68`）。
- 搜索结果**在查询里强制加 `{kind:'cwd', values:[caller.header.cwd]}`**（`src/operations.ts:90`），并**排除调用者自己**（`:101`）。
- 目标会话授权 = 用 `filterSessions([{id},{cwd}])` 查一次，命中数必须为 1（`src/workspace-access.ts:75-90`）；标题读取后会再校验一次 header（`:101-109`）。
- 当前会话的"排除正在执行的这一步"：`session_event_search` 把 `range.to` 夹到 `boundary.lastStepStartSeq - 1`（`src/operations.ts:128-139`）——即**看不见当前 step 自身**，需要 `turnBoundary` 投影。
- 跨会话搜索**只能搜同一个 cwd**；索引本身是全语料的（见 2.3），`cwd` 只是查询期过滤。

### 2.3 30s 超时的根因（Lead 的 4/4 超时）

#### 实测数据（本机真语料，只读）

命令见 §5 P1。结果：

```json
{"files":391,"compressedMB":283.7,"frames":145107,"rawMB":1021.7,"lines":256582,"errs":0,"decodeMs":5634,"parseMs":2280,"totalMs":8774}
```

- 391 个 `session.v4.jsonl.zstd`，压缩 283.7MB，**解压后 1021.7MB**，145,107 个 zstd frame，**256,582 条 JSONL 记录**。
- 用宿主自己的 `scanZstdFrames`+`decompressZstdFrame`（`packages/session/session-persistence-jsonl/lib/types/zstd.js`）**单线程顺序**跑完：解压 5.6s + JSON.parse 2.3s = **8.8s 墙钟**。这已经只是**下限**——还没算 `handle.read` 的日志校验、`Session.create` 的回放校验、`buildSessionEventSearchDocuments` 的逐事件抽文、以及 FTS 写入。
- FTS 写入单独微测 [实测]：同 schema 的 `fts5(..., tokenize='unicode61')`，2 万条约 2.4KB 文档入库 909ms（≈22k docs/s）⇒ 若 ~17 万条文档，仅 insert ≈ 7-8s。

#### 根因链 [源码 + 实测推导]

1. `openAt:'first-search'` ⇒ 第一个 search 才开库（快，不是瓶颈）。
2. `searchSessions` 在 `_serialized` 里先 `_ensureReady` 再 `_reconcile`：**一次调用要观测整个语料**——`persistence.list()`（两遍）+ 对每个 revision 变化的会话 `readColdSessionLog` + 建文档。
3. **写入在"全部观测完成之后"才发生**（`BEGIN IMMEDIATE` 前后的 abort 检查在观测阶段，写事务里没有 abort 检查）。
4. 30s 一到，`timeout-policy` 守卫把 `exec.signal` abort，`_observeStable`/`_serialized` 在 `assertNotAborted` 处抛 `SESSION_QUERY_ABORTED` → **事务从未开始，索引仍是空**；被替换成模型面文本 `tool call timed out after 30000ms`（`packages/guard/timeout-policy/src/index.ts:41-42,57-74`）。
5. 下一次调用从零重来。**没有"部分进度"这个状态**：`:memory:` 不跨重启，进程内又因为超时永远写不进第一条。
6. 并发/串行不是主因：`_serialized` 是 FIFO，同时发多个只会让后来的在 `waitWithAbort` 里被自己的 signal 掐掉；即使串行，单次也过不了 30s。

⇒ **"超时是否包含冷建索引"：包含。** "超时后是否还在后台建"：**不会**——它在抛异常，不会留下正在进行的构建。副作用是"永远建不成"，比"建得慢"严重。

#### 能调什么、不能调什么

| knob | 位置 | 现状 | 判断 |
|---|---|---|---|
| `path` | `session-query-sqlite` Config | `':memory:'` | 改持久文件可**跨重启复用**；但首次建库仍要一次跑完（一次性成本仍在） |
| `openAt` | 同上 | `first-search` | `startup` = 把建库搬到启动（**启动阻塞**，不推荐）；`never` = 关搜索但保留精确读 |
| `searchTimeoutMs` | `tool-session-query` Config（`src/index.ts:25,36-39`） | 30,000（上限 `MAX_TIMER_DELAY_MS=2_147_483_647`，`packages/util/timeout/src/index.ts:25`） | **唯一能"让它跑完一次"的旋钮**；代价是那一轮对话要等一次冷建 |
| `maxSearchResults` | 同上（默认 100） | 100 | 与 R6 交互：100 条 × ~6 行 ≈ 远超 8192 字符 ⇒ 输出会被 pruner 砍掉中段 |
| `journalMode` | sqlite Config | `wal`（`:memory:` 上无意义） | 持久化后才相关 |
| `snippetChars` | sqlite Config（默认 240，`SESSION_QUERY_SQLITE_SNIPPET_CHARS`） | 240 | 只影响输出体积 |
| `persistedReadConcurrency` | 默认 4（`SESSION_QUERY_DEFAULT_PERSISTED_INSPECT_CONCURRENCY`） | 4 | 解压+解析是 CPU 密集单线程逻辑，**加并发几乎没有收益** |
| "按 workspace 缩小索引" | — | **不存在** | `cwd` 只在查询期过滤（`operations.ts:90`）；索引永远是全语料 ⇒ 不能靠"限定工作区"降成本 |

**能否改这两行**：它们在 `@deepseek-ai/dsh-experimental-session-search` 这个 **bundle 层**的组里（不是预设里的组）。R5 只证过"预设内嵌组的行 patch 打不进"；**bundle 层插入的组其子行是否可被 `- id: …` patch 覆盖，本线程没有实证** ⇒ 标 **[待验]**，探针见 §5 P6。若不可 patch，则在本 profile 里 **没有合法旋钮能让它跑完第一次**（除非把该 bundle 从 `dsh.profile.bundles` 里拿掉再自建行，而 `@deepseek-ai/dsh-session-query-sqlite` 的裸包名在根行里解析不到，见 §4.3）。

### 2.4 事件搜索 / 谱系 / 事件读

- `session_event_search` 与 `session_search` **共用** `searchEvents`/`searchSessions`，同样要 FTS 后端 ⇒ 同样不可用。
- `session_trace` / `session_event_trace` / `session_event_read` 走 `traceSession`/`traceEvent`/`readEvent`，**不碰 SQLite**，且**没有 `timeoutMs`** ⇒ 本次两次调用均即时返回 [实测]：
  - `session_trace()` → 返回了当前会话 + 祖先 `session-40edda4c-…`（`继续开发`）+ `Descendants: none`；
  - `session_event_read({seq:1})` → 立即返回 seq 1 的完整 `sandbox/mode` 事件 JSON。
- 结论：**这三个工具是"现在就能用"的宿主能力**，而且它们带来的信息（谁派生自谁、某一步的原始事件、事件被谁替换过）正是 OMB 记忆/推理最缺的那类"可核对事实"。

### 2.5 常驻成本（每请求）

[实测] 用真插件定义跑出来的（命令见 §5 P4）：

```json
{"sections":[{"name":"tool:session-query","order":2300,"chars":315}],
 "sectionChars":315,"sectionTokensApprox":88,
 "schemaChars":3976,"schemaTokensApprox":1105,"toolCount":5,
 "per":[{"name":"session_search","chars":1672,"timeoutMs":30000},
        {"name":"session_event_search","chars":1023,"timeoutMs":30000},
        {"name":"session_trace","chars":304},
        {"name":"session_event_trace","chars":389},
        {"name":"session_event_read","chars":588}]}
```

- **常驻提示段**：`tool:session-query`，order **2300**（`packages/core/system-prompt/src/index.ts:150`，夹在 LSP 2200 与 GOAL 2400 之间），文本 **315 字符 ≈ 88 token**，**每个请求都在**（`ctx.systemPrompt.section` 未带 scope ⇒ 全局）。
- **5 个工具 schema**：3,976 字符 ≈ **1,105 token**（按 3.6 chars/token 估；真实 provider 计数会略有出入）。这是"工具目录保持稳定以稳住请求缓存"的代价（plan-mode 的注释明说目录跨模式不变就是为了 request-cache，`cordis.patch.yml:194`）。
- **合计 ≈ 1,190 token/请求**，无论模型用不用。静态文本 ⇒ 首请求之后**不再**额外抖动缓存；但**开/关这个 bundle**（插件页拨动）会改系统提示 + 工具目录 ⇒ 那一次会话的缓存会失效（本 profile 的 `deepseek-flash` 配了 `systemPromptUpdate: in-history`，即把新系统提示**追加进历史**而不是改写，能减轻但不能免除）。

---

## 3. 采用率：391 会话只用 6 次，为什么

数据：`C:\Users\SuSeventeen\AppData\Local\Temp\omb-census.json`（Lead 提供，[报告]）：391 个会话里 `session_search` 只出现在**一个**会话（`session-40edda4c-…`，`session_search=6`，该会话 483 次工具调用）。其余 390 个会话零使用。

按"可解释性从强到弱"排：

1. **是坏的**（最强解释）。当前语料下每次调用 30s 后返回 `tool call timed out after 30000ms`。模型对"永远失败且要等 30 秒"的工具会迅速放弃——这不是提示词问题，是可用性问题。Lead 本次 4/4 超时正说明"想用也用不了"。
2. **有更便宜的替代品**。OMB 预设里 `omb_recall`/`omb_relate`/`omb_files` 是**本地、毫秒级、针对 OMB 自己记忆库**的召回；`session_search` 要 30s 且经常空手。"跨会话找旧结论"这个意图被 OMB 自家工具截流了。
3. **作用域天然很窄**。`session_search` 只搜**同一 cwd**（`operations.ts:90`）。本机 391 个会话分布在 `D:\Program\project-*`、`D:\Program\Skills`、`D:\Work\…` 等十余个工作区，从 `D:\Program\Oh-My-BigBlueFish` 出发能看到的历史只是其中一小撮；而**最该被召回的历史往往在别的 cwd**。这一点会持续压低"搜到了"的正反馈。
4. **可见性/措辞**。常驻提示段（`src/index.ts:51-54`）只说了"用它找以前的活"，没说"什么时候值得花一次调用"（对比 OMB 规则卡的"何时用"写法）；5 个工具里 3 个（trace/read）从来不在提示里被举例子说明能干什么。模型在"要不要搜"这一步拿不到判据。
5. **成本/收益比**。1,190 token/请求的常驻成本 vs 一次都没成功的调用：对模型不是在"选工具"，而是在"绕开一个占位符"。
6. **结果会被二次削减**。上限 100 条 × 每条 6 行，远超 pruner 的 8192 字符阈值 ⇒ 命中很多时中段被 `[... tool result middle pruned ...]` 替掉，模型看到的命中数并不等于 `maxSearchResults`。这会进一步降低"搜一次很值"的体感。

可做的实验（不改 OMB 代码）：把索引修好后，用一个 OMB 会话显式问"上周关于 X 的结论"，看模型是否主动选 `session_search`；若仍不选，再把 §3.4 的判据补进提示段。

---

## 4. 给三组件的集成模式

### 4.1 分界线（宿主 vs OMB）

| 能力 | 归谁 | 理由 |
|---|---|---|
| 会话日志的**规范读取**（枚举、精确读、标题、谱系、事件窗、surface/trace） | **宿主**（根 `sessionQuery`，`openAt` 任意都可用） | 已在根 realm、有授权语义、跨后端一致；OMB 自己解析 `*.jsonl.zstd` 是重复实现且有格式版本风险 |
| 会话**全文搜索** | 宿主（现在坏的）/ 或 OMB 自建 | 二选一，不要两边都做（见 4.3） |
| 上下文压力/用量/构成读数 | **宿主**（`sessionProjections`） | OMB 已在用，且是真源 |
| 历史体量削减（compaction / pruner） | **宿主** | OMB 只读压力、不改历史；再叠一层会互相干扰 |
| 系统提示的"认知层"文案、工具面、判据 | **OMB** | 这是 OMB 的产品差异化 |
| 跨会话**认知结论**（结论/偏好/纠错，不是原始事件） | **OMB 记忆** | 宿主只有原始历史，没有"结论"这一层 |

### 4.2 从插件引用宿主能力的三条硬规矩（不改 import 纪律）

1. **只经 `ctx.get(name)` / `ctx.on` / `ctx.effect`**，绝不 `import '@deepseek-ai/*'` 运行期代码（OMB 已有护栏 `tests/dsh/no-host-imports.test.ts`，`dsh/plugin.ts:25-31`）。d.ts 类型也不要用宿主包（会引入类型层依赖）。
2. **按"结构化最小接口"声明形状**，形状错了就当能力缺失（`sessionQuery` 只要 `listSessions/filterSessions/readTitle*/traceSession/traceEvent/readEvent/readSurface/readSession` 这几个函数存在即可用）。
3. **每次用前重新解析 + 缺了就说缺**（H-3）：`readService` 包 try/catch，状态面如实写"宿主 sessionQuery 未就绪/搜索被禁用"，不要把"没有"显示成 0。

### 4.3 具体模式（按推荐度）

**模式 A（推荐）：把"精确读/谱系/标题"搬进 OMB 记忆——用根 `sessionQuery`，零新依赖**

- OMB 侧新增一个"宿主会话簿"端口：`listSessions()`→`filterSessions([{kind:'cwd',values:[cwd]}])`→按需 `readTitleSnapshots`/`traceSession`/`readEvent`。
- 用途：`omb_recall` 增加"来源于哪个会话/哪一步"的溯源行；`omb_files` 的制品来源可以挂 `session_trace` 的谱系；`omb_status` 显示"宿主会话簿：N 个（本工作区）"。
- 代价：零常驻 token；每次调用是主线程同步 I/O（冷读日志），要限制单次读取量（优先 `readSurface`/`readEvent`，避免 `readSession` 整段回放，最大会话解压后 46MB）。
- 前提：`ctx.get('sessionQuery')` 拿到根实例（本次探针 + base 注释双证）；拿不到就整条降级。

**模式 B（推荐给"搜索"）：要么修宿主、要么自建，二选一**

- B1 修宿主：目标是把**一次冷建**跑完。可行组合 = `path` 改持久文件 + `searchTimeoutMs` 提到 300000~600000 + 先手动跑一次（可在一次会话里发一个 `session_search`，等它跑完）。之后同一进程内 `_reconcile` 只处理变化会话，应该秒级；重启后持久库仍在，只需增量。**风险**：那 5-10 分钟会阻塞一轮对话；且 §2.3 的"[待验]：这两行能不能被 patch 覆盖"必须先验。
- B2 自建：OMB 已有 SQLite（`dsh/stores.ts` 的 storage 端口），用 `node:sqlite` FTS5（Node 24 自带）建**自己的**索引，语料从模式 A 的 `sessionQuery` 精确读来（不再自己解 zstd）。可自定：只索引**当前 cwd + 最近 N 天**、增量事务、**先写后增量**（把"全有或全无"改成"每会话一次提交"）。代价：OMB 要维护索引 schema 与重建策略；收益：可用的搜索 + 完全可控的预算。
- **不建议**：B3 在根层"再挂一个 `@deepseek-ai/dsh-session-query-sqlite`"。原因 [实测]：从安装锚解析该包 **MODULE_NOT_FOUND**（`apps/cli` 的 `createRequire` 解析不到；它在 pnpm 的 `.pnpm/node_modules` 里，但没有被任何安装锚的依赖暴露），而 profile 目录里也没有任何 `@deepseek-ai/*`（profile `node_modules` 只有 `@omb/*` 与 4 个三方包）。所以根行 `name: '@deepseek-ai/dsh-session-query-sqlite'` 会加载失败。**除非**把该包显式装进 profile 依赖（本次规则不允许装包）。

**模式 C（可选）：把 `session_search` 提示段"变便宜"**

- 关掉整个 bundle ⇒ 省 1,190 token/请求，但 5 个工具全没了（含可用的 trace/read）。当前它不可用，**这个交换在搜索修好前是净赚**。
- 折中：保留 bundle 但把 `maxSearchResults` 降到 ~10（降低输出被 pruner 砍的几率）；不过 §2.3 的"[待验]"决定这条路能不能走。

### 4.4 realm 结论（一句话版）

> `isolate: { sessionQuery: true }` 对 OMB 的含义：**"带 FTS 的那个 sessionQuery 只属于那个组，OMB 永远拿不到；OMB 拿到的是根层 `openAt:'never'` 的那个实例，只有精确读。"** 同一条规则也解释了为什么 OMB 拿不到 `compaction`/`toolResultPruner`/`planMode`/`workflowEngine`（R5 已实证 compaction）。

### 4.5 避免重复 / 碰撞的清单

- **工具名**：不要注册 `session_search` / `session_event_search` / `session_trace` / `session_event_trace` / `session_event_read`（宿主 `tools.register` 同名会抛，`packages/core/tools/src/index.ts` 与 OMB `dsh/tool-bridge.ts:139-168` 的实测注释）。OMB 自己的搜索工具用 `omb_*` 前缀。
- **提示段**：不要在 OMB 的常驻段里复述宿主 `tool:session-query` 的措辞（会双写同一事实，且两段都常驻）；要"补判据"就写**何时用**，不写工具名清单。
- **缓存**：任何"按回合变化"的注入都会抖缓存。OMB 现有 `dsh/session.ts` 的"易变段走 contexts、稳定段走 sections"要守住；宿主新增段是静态的，开关 bundle 才会抖。
- **投影**：不要自己累加 `systemTokens+toolsTokens+messageTokens` 当总量（token-meter 文档明说三项与 `projectedTokens` **不对齐**，`projection.ts:50-66`）。OMB `dsh/pressure.ts:192-203` 已经把三个数标成"估算"，保持。

---

## 5. Lead 可以先跑的最小探针（可直接复制）

> 全部只读、不装包、不改 profile；P1/P2/P4/P5 只读文件与内存，P3 只 import 宿主已构建产物，P6 需要临时 `DSH_HOME`（会写临时目录，可删）。

**P1 语料规模与解码下限（本报告 §2.3 的数据来源）**

```powershell
$code = @'
import fs from 'node:fs'; import path from 'node:path';
const { scanZstdFrames, decompressZstdFrame } = await import('file:///D:/Program/deepseek-harness/packages/session/session-persistence-jsonl/lib/types/zstd.js');
const root='C:/Users/SuSeventeen/.dsh/sessions';
function walk(d,out=[]){for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);if(e.isDirectory())walk(p,out);else if(e.name.endsWith('.zstd'))out.push(p);}return out;}
const files=walk(root); let comp=0,frames=0,raw=0,lines=0,dm=0,pm=0,t0=Date.now();
for(const f of files){const buf=fs.readFileSync(f);comp+=buf.length;const sc=scanZstdFrames(buf);frames+=sc.frames.length;let txt='';const a=Date.now();
for(const fr of sc.frames) txt+=(await decompressZstdFrame(buf.subarray(fr.start,fr.end))).toString('utf8');
dm+=Date.now()-a;raw+=Buffer.byteLength(txt);const b=Date.now();for(const l of txt.split('\n')){if(l.trim()){lines++;try{JSON.parse(l)}catch{}}}pm+=Date.now()-b;}
console.log(JSON.stringify({files:files.length,compressedMB:+(comp/1048576).toFixed(1),frames,rawMB:+(raw/1048576).toFixed(1),lines,decodeMs:dm,parseMs:pm,totalMs:Date.now()-t0}));
'@; $code | node --input-type=module -
```

判读：`totalMs` 是"只解压+JSON 解析"的下限（本次 8.8s）。若 > 30s 则结论更硬；即使 ~9s，加上回放校验+抽文+FTS 写入也够撑爆 30s。

**P2 FTS5 写入速率（判断"写入是不是瓶颈"）**

```powershell
node --input-type=module -e "const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(':memory:');db.exec(\"CREATE VIRTUAL TABLE d USING fts5(text, tokenize='unicode61')\");const w='alpha beta gamma delta epsilon'.split(' ');const ins=db.prepare('INSERT INTO d(text) VALUES (?)');db.exec('BEGIN');const t=Date.now();for(let i=0;i<20000;i++){let p=[];for(let j=0;j<400;j++)p.push(w[(i*j)%w.length]);ins.run(p.join(' '));}db.exec('COMMIT');console.log(JSON.stringify({docs:20000,ms:Date.now()-t}));"
```

**P3 realm 判定（根 provider 可见 / 属性读需 inject；本次结论的来源）**

```powershell
$code = @'
import { Context } from 'file:///D:/Program/deepseek-harness/vendor/cordis/lib/index.js';
const root = new Context(); const log = [];
root.plugin({ name: 'root-provider', apply(ctx) { ctx.provide('sessionQuery', { id: 'ROOT' }); } });
root.plugin({ name: 'omb-gated', inject: ['sessionQuery'], apply(ctx) { log.push(['omb gated inject', ctx.sessionQuery.id]); } });
root.plugin({ name: 'omb-ungated', apply(ctx) { log.push(['omb ctx.get', ctx.get('sessionQuery')?.id ?? null]); try { log.push(['omb property', ctx.sessionQuery?.id ?? null]); } catch (e) { log.push(['omb property throws', e.message]); } } });
await new Promise(r => setTimeout(r, 300));
log.push(['root.get', root.get('sessionQuery')?.id]);
console.log(JSON.stringify(log));
'@; $code | node --input-type=module -
```

**P4 常驻成本（提示段 + 5 个 schema 的真实字符数）**

```powershell
cd D:\Program\deepseek-harness\packages\experimental\tool-session-query
$code = @'
const mod = await import('./lib/index.js'); const tools=[]; const sections=[];
const ctx={systemPrompt:{section(s){sections.push(s);return()=>{}},getSectionOrder:()=>2300},tools:{register(d){tools.push(d);return()=>{}}}};
mod.apply(ctx,{});
const sc=sections.reduce((a,b)=>a+b.text.length,0);
let tc=0; for(const t of tools) tc+=JSON.stringify({name:t.name,description:t.description,parameters:t.parameters}).length;
console.log(JSON.stringify({sectionChars:sc,sectionTokens:Math.ceil(sc/3.6),schemaChars:tc,schemaTokens:Math.ceil(tc/3.6),tools:tools.map(t=>t.name)}));
'@; $code | node --input-type=module -
```

**P5 三个"不需要索引"的工具（直接手测）**

- `session_trace()`（不传参 = 当前会话）→ 应立即返回祖先/后代；
- `session_event_read({seq: 1})` → 应立即返回 seq 1 的完整事件；
- `session_event_search({query: "…"})` → 会走 FTS，**预期 30s 超时**（与 `session_search` 同命）。

**P6 那两行到底能不能 patch（决定"修宿主"这条路是否可走）——[待验]**

```powershell
$env:DSH_HOME='D:\Program\omb-wt\_probe\r4home'   # 临时 home，别指向真实 .dsh
@'
- id: optional-tool-session-query
  config:
    searchTimeoutMs: 600000
'@ | Set-Content D:\Program\omb-wt\_probe\r4home\probe.yml
node D:\Program\deepseek-harness\apps\cli\lib\bin.js --profile web --patch D:\Program\omb-wt\_probe\r4home\probe.yml --dump-config > D:\Program\omb-wt\_probe\r4home\dump.yml 2> D:\Program\omb-wt\_probe\r4home\err.txt
Get-Content D:\Program\omb-wt\_probe\r4home\err.txt
Select-String -Path D:\Program\omb-wt\_probe\r4home\dump.yml -Pattern "optional-tool-session-query" -Context 0,4
```

判读（R5 已给过同型判据）：stderr **为空**且 dump 里该行出现 `searchTimeoutMs: 600000` ⇒ 可 patch，B1 可行；stderr 出现 `patch … entry "optional-tool-session-query" not found` 且 dump 逐字节不变 ⇒ 不可 patch，**只剩 B2（OMB 自建）或 C（关掉 bundle）**。

**P7 `openAt: never` 下精确读真的可用（根实例自证）**

在 OMB 侧加一个临时探针行（或复用 `omb_status`）读 `ctx.get('sessionQuery')` 并调用 `filterSessions([{kind:'cwd',values:[process.cwd()]}])`，期望返回当前会话（`openAt: never` 只让 `searchSessions/searchEvents` 抛 `SESSION_QUERY_SEARCH_DISABLED`）。

---

## 6. 风险表

| # | 风险 | 触发条件 | 表现 | 缓解 |
|---|---|---|---|---|
| R1 | **根 `sessionQuery` 缺席**（部署删了 base 行 / 换成只读其它后端） | 部署差异 | `inject` 行静默 PENDING；`ctx.get` 返回 undefined | 不 inject，`ctx.get` + 状态面如实报"未就绪" |
| R2 | **把 `openAt` 当常量** | 部署把根行改成 `first-search` | OMB 可能触发一次全语料建库（同 §2.3） | OMB 只用精确读方法；**绝不**从插件里调 `searchSessions` |
| R3 | **整段 `readSession` 拉爆内存/时间** | 对 46MB 解压的会话整读 | 单次调用数十 MB 驻留、主线程卡顿 | 优先 `readSurface`/`readEvent`/`readTitleSnapshots`；加条数上限与超时 |
| R4 | **授权语义抄错** | OMB 自己实现搜索时忘了 cwd 过滤/排除自身/目标校验 | 跨工作区信息泄漏给模型 | 照抄 `operations.ts:61-68,90,101` + `workspace-access.ts:75-109` |
| R5 | **patch 打不进嵌套组**（B1 的拦路石） | `optional-*` 行不可寻址 | `--dump-config` 静默不变 | 先跑 P6；不可就打 B2/C |
| R6 | **输出被 pruner 腰斩** | `session_search` 命中多（100 条 × 6 行 ≫ 8192 字符） | 中段变 `[... tool result middle pruned ...]`，模型以为只搜到几条 | 调小 `maxSearchResults`（~10）或让 OMB 自己的搜索工具按条数分页 |
| R7 | **提示段双写/漂移** | OMB 也在常驻段里描述会话搜索 | 两条指令互相矛盾；常驻成本叠加 | 宿主段管"工具怎么用"，OMB 段只写"何时值得用" |
| R8 | **开关 bundle 导致请求缓存抖动** | 插件页拨 `session-search` | 系统提示+工具目录变化 | 变更只在新会话生效；或接受一次缓存失效 |
| R9 | **把 auto-review 当质量复审** | 误读 name | 结论线程把"授权闸门"当成"第二意见 reviewer"，做错设计 | 见 §1 #17；它管的是"能不能执行工具"，不是"答案对不对" |
| R10 | **`sessionQuery` 冷读阻塞主线程** | 在 turn 中间同步读大量日志 | 整轮变慢，且无超时守卫（精确读方法没有 `timeoutMs`） | OMB 侧自己加 `AbortSignal.timeout` 与分页；一次只读 N 个会话 |
| R11 | **自建索引与宿主索引双份磁盘/CPU** | B2 落地后仍留 bundle | 两套 FTS、两次冷建 | 二选一；B2 落地时把 bundle 从 `dsh.profile.bundles` 拿掉 |

---

## 7. 其他三条研究线程不得搞错的主机事实

- **`sessionQuery` 不是"一个服务"而是"一个名字、两个实例"**：根实例（`openAt:'never'`，精确读）+ 隔离组实例（FTS，仅工具可达）。写"OMB 可以用 sessionQuery 做全文搜索"是错的；写"OMB 完全拿不到 sessionQuery"也是错的。
- **`openAt:'never'` ≠ 服务不存在**。它明确保留精确读/标题/谱系（`packages/bundle/base/cordis.patch.yml:149-156` 的注释就是这个契约），这是 DSH 有意的设计，不是降级 hack。
- **`ctx.get(name)` 不需要 inject；`ctx.name` 需要**。任何"OMB 拿不到宿主服务"的结论都要先区分这两条路。
- **`inject` 未满足是静默 PENDING，不是报错**（R5 §4 实证）。所以"加了 inject 结果什么都没发生"不能推断为"服务不存在"。
- **30s 不是模型/网关的 `timeoutMs`**，是 `timeout-policy` 守卫按 `ToolDefinition.timeoutMs` 武装的 `deadline(exec.signal)`（`packages/guard/timeout-policy/src/index.ts:57-74`）。`timeoutMs` 永远不会出现在给模型的 schema 里（`packages/core/tools/tests/tools.spec.ts:144-152`）。
- **`tokenMeter`/`sessionProjections`/`sessionTitle`/`sessions` 都在 host plane（根）**；**`compaction`/`toolResultPruner`/`planMode`/`workflowEngine` 在预设隔离组**。前四个 OMB 可读，后四个不可读（只有它们产出的工具可被模型调用）。
- **`compaction-basic` 的默认触发线是 `thresholdRatio=0.8` + `headroomTokens=65,536`，`retainRatio=0.16`**（`packages/compaction/compaction-basic/src/config.ts:20,23,75-80`）。任何"上下文组件应在 X 比例收手"的阈值论证必须以 0.8/0.16 为对照，且注意本 profile 模型 `contextWindow` 被写成 1,000,000。
- **`contextBreakdown` 的三项是启发式估算，不能相加当总量**（`packages/llm/token-meter/src/projection.ts:50-66`）；压力应读 `contextPressure.projectedTokens`（compaction 后会立即回落），而不是只读 `pressureTokens`。
- **`auto-review` 是权限闸门**（工具执行前的一次 LLM 授权审查，`packages/experimental/auto-review/src/index.ts:1-7`），不是产线复审/质量评审；把它写进"推理组件可借力"会误导实现。
- **`hook-protocol` 是外部命令协议**（`packages/experimental/hook-protocol/src/index.ts:1-6`）：OMB 不能用它"注册一个进程内回调"，只能提供一个可执行入口并让用户写 settings。
- **`rule-result-pruner` 会改 OMB 的工具输出**（8192/4096/1024，`compaction-tool-result-pruner/src/config.ts:11-16`）。OMB 任何"大正文"工具（`omb_method`、`omb_recall`、`omb_files`）都要按 8192 设计：要么分页，要么把可追回标记写清楚。
- **`@deepseek-ai/dsh-session-query-sqlite` 从安装锚解析不到**（[实测] `MODULE_NOT_FOUND`），而 `dsh-session-query` / `dsh-tool-session-query` / `dsh-token-meter` / `dsh-session-projection` / `dsh-compaction-basic` / `dsh-experimental-session-search` 都能解析。任何"在根层再挂一个 SQLite 后端"的方案必须先解决这条。
- **profile 目录里没有任何 `@deepseek-ai/*`**（只有 `@omb/*` + `dshmarket`/`dsh-*` 四个 link 包）[实测]；profile 根行的裸包名解析靠 profile 的 `node_modules`，而 bundle 名解析靠安装锚（install anchor 优先，`packages/boot/app-boot/src/profile.ts:703-725`）。两者不是一套解析基，别混用。

---

## 8. 证据附录（本次新增的一手证据）

| 证据 | 位置 / 命令 |
|---|---|
| 语料：391 文件 / 283.7MB / 1,021.7MB 解压 / 145,107 frame / 256,582 记录 / 解码+解析 8.8s | §5 P1（本机 `~/.dsh/sessions`） |
| FTS5 写入 ~22k docs/s（2 万条 × 2.4KB，909ms） | §5 P2 |
| 根 provider 可见 / 属性读需 inject / inject 门控 | §5 P3（`vendor/cordis/lib/index.js` 真跑） |
| 常驻成本 315 字符≈88 token + 3,976 字符≈1,105 token；`session_search.timeoutMs=30000` | §5 P4（真插件 `apply` + 假 ctx 抓注册） |
| `session_trace` / `session_event_read` 秒回；`session_event_search` 同命于搜索 | 本会话工具调用（§2.4） |
| 根行 `session-query-sqlite` 在 base 且 `openAt: never`；web-app 重申；compaction 三行被 web-app 关掉 | `packages/bundle/base/cordis.patch.yml:138-161`；`packages/bundle/web-app/cordis.patch.yml:22-30,539-546` |
| 搜索实例的隔离组 | `packages/experimental/session-search/cordis.patch.yml:1-14` |
| profile 打开 session-search | `C:\Users\SuSeventeen\.dsh\profiles\web\package.json:15` |
| 包解析探针结果 | `createRequire('…/apps/cli/package.json').resolve(...)`：sqlite 后端 `MODULE_NOT_FOUND`；其余 6 个成功 |
| 30s 守卫 | `packages/guard/timeout-policy/src/index.ts:25,41-42,57-74`；`packages/util/timeout/src/index.ts:25` |
| R5 的 realm 实证（组内可见 / 根层 `null` / inject 静默 PENDING） | `D:\Program\omb-wt\_research\r5-preset-realm-probe.md` §3.3、§4 |
| 采用率 | `C:\Users\SuSeventeen\AppData\Local\Temp\omb-census.json`（Lead 提供） |
