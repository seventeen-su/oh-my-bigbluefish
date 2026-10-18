# R2 —— 思维链质量（omb-reasoning）：机制审计、SOTA 与重构提案

- 研究线程：reasoning（思维链质量）。唯一写盘产物：本文件。未改代码、未跑 git、未装包。
- OMB 仓库：`D:\Program\Oh-My-BigBlueFish`（v3.6.0，工作树干净，只读）
- DSH：`D:\Program\deepseek-harness`，tag `dsh-v0.2.1-rc.2`（只读）
- Profile：`C:\Users\SuSeventeen\.dsh\profiles\web`
- 语料：`C:\Users\SuSeventeen\.dsh\sessions`，391 个会话日志（283.7MB 压缩 / 256,316 事件 / 49,440 次工具调用），本报告全部统计都跑在这份语料上。
- 证据分级：**[实测]**＝本次命令/日志/同会话 `omb_status` 真跑出来的；**[源码]**＝只读源码行号；**[报告]**＝论文/厂商文档自述（附 URL）；**[推测]**＝由前两者推导、未端到端验证。

---

## 0. 结论速览（给 Lead 的 12 句判词）

1. **默认工作点（`standard` + `pressure=tight`）本轮注入 0 字符**，不是 bug，是设计：五段注入的每一个前置条件都不成立（§1.2 逐条列算式）。模型侧实际得到的全部"思维链质量"只有 **71 字符的常驻提示**。
2. **`omb_focus` 不改变模型怎么想，只改变我们说什么**。当前 profile 把 `agent-default-model.reasoningEffort` 钉在 `max`，本次抽查的每个请求头都是 `reasoningEffort: "max"`（更早的会话里出现过 `xhigh`），而 DeepSeek 的 effort 档是 `low/high/max`、另可 `off`/`none` 关闭思考 [报告]。所以 `quick` 档"别展开"在算力层面完全无效——思考 token 一个也省不下来。
3. **"尚未核对过结论" = 模块级 `verifyCalls === 0`**（`modules/reasoning/index.ts:340`）。本会话日志里确实一次 `omb_verify` 都没有；全语料 391 会话只有 56 次（工具调用占比 **0.11%**），其中 51 次在 OMB 仓库外的真实项目里。
4. **验证段是循环依赖**：注入验证段要求"有未闭合结论"（`verify.ts:329`），而未闭合只能由"先调用过 `omb_verify` 且判定不通过"产生。实测全语料只有 **3 个会话**的注入里出现过验证段（36 个快照）。
5. **档位差异在压力下退化成空**：`controlForBand` 只对 `quick` 生效（`control.ts:126-134`），而 `quick` 全语料只注入过 **1 个快照 / 1 个会话**。v3.6 的"压力—严谨度耦合"在生产里从未真正触发。
6. **循环提示是唯一高频生效的机制**：553 个注入快照 / 82 个会话（占含 OMB 内容的快照 36%）。它的证据模型很弱（三条阈值 + 上次空证据归并），且**并行工具调用会打乱 call↔result 归并**（DSH 每步 1.27 次调用，`tool-calls.ts:42-46,264,282`），精度未被测过。
7. **`上次注入：压力 tight` 是"压缩前的时间戳"，不是第二数据源**：两侧都调用同一个 `kernel.pressure(session)`（`kernel/index.ts:524-529`）。实测 Lead 会话 06:13 上下文 617,110 token（tight 真实）→ 06:18–06:19 compaction → 21,308 token（relaxed），而 trace 在 06:39:28 仍写 tight。原因是渲染发生在请求之前（`agent-loop/src/agent.ts:409-420`），采样锚点还是压缩前用量。
8. **状态面把"陈旧采样"当"当前事实"展示**：`RenderTrace` 只存 band 字符串，不存时间/总量/窗口/采样会话（`index.ts:681-696`），且 `lastRender` 是**模块全局**的（跨会话互相覆盖）。同一屏上两个组件各说一套，就是这个原因。
9. **循环/验证/档位三条状态是本模块的真实缺陷集中地**：`loopService.reset()` 会删掉整份会话状态（包括验证台账与显式档位），而文档说只清窗口（`index.ts:107 vs 446-449`）；`sessions` 表无 LRU（`index.ts:274`），`verifyCalls` 是跨会话累计却与"本会话未闭合数"同屏（`index.ts:340`）。
10. **成本结构反了**：3 个 reasoning 工具的 schema 共 **1,442 字符（≈450 token）/请求**（实测 request/header），而 8 张方法卡全文由模型按需拉取、全语料 `omb_method` 只有 34 次调用。钱花在"工具常驻"，收益靠"一句话提示"。
11. **DSH 原生已经有真正的推理算力旋钮**（`reasoningEffort: off/low/high/max`）、会话级模型选择（`sessionController.selectModel` + `modelSelection` 投影）、`agent/pre-step` 瀑布、plan/goal/todo 原生状态、compaction 事件、subagent 独立复核。OMB 在重复"提示词脚手架"，却没用这些。
12. **重构方向（P0 两条）**：① 把档位映射到 `reasoningEffort`（真实省 token/时延），文本层退化为"一句话 + 事件驱动一行"；② 删掉 `omb_verify` 与验证台账（或换成"收尾闸门 + 可选 subagent 复核"）。见 §4。

---

## 1. 现状：OMB reasoning 到底在做什么

### 1.1 代码路径（真实接线，file:line）

**注册面**（`modules/reasoning/index.ts`）

| 面 | 位置 | 内容 |
|---|---|---|
| 常驻提示 | `index.ts:310-312` | `residentHint(hintBudget)`，`apply` 内算一次；预算上限 `RESIDENT_HINT_MAX`（120），配置 `residentHintChars` 受 `clampHintBudget` 收敛（`:821-830`） |
| 易变注入 | `index.ts:570-714` | `PromptContribution.context(input)`：指令/读数/卡片/验证段/循环提示/出口段六段拼成 `text`，并把留痕写进 `lastRender` |
| 服务 | `index.ts:780-783` | `prompt:omb-reasoning`（PromptContribution）、`tools:omb-reasoning`、`reasoning:loop`、`reasoning:methods` |
| 工具 | `index.ts:532-546` → `tools.ts:264-266` | `omb_method` / `omb_focus` / `omb_verify` 三条 |
| 事件 | `index.ts:393-405 / 407-415 / 417-440` | `evidence/observed`（滚动指纹窗口 + 循环检测）、`focus/changed`、`turn/start`（默认档位落地一次、回合号推进） |
| 状态面 | `index.ts:716-778` | 健康行 + `describeLastRender` + 糊弄观察 + 失败分类分布 + 会话行 + 常驻提示回显 |

**宿主接线**（`dsh/session.ts`）

- `CONTEXT_ORDER = 200`（`:50`）；宿主自己的 `CONTEXT_ORDERS` 是 110/115/120/125/200/210（`packages/core/system-prompt/src/index.ts:170-179`）。**OMB 与宿主的 `HARNESS_SOURCE: 200` 同序**（`:176`），`WEB_SURFACE: 210` 在其后——这是一个真实的顺序位冲突，不是一个"注释过时"。
- 注入注册：`systemPrompt.context({ name: 'omb:cognitive', order: 200, text })`（`:633-653`）。`text(ctx)` 里**每次**读 `kernel.focus(sessionId)` 与 `kernel.pressure(sessionId).band`（`:640-645`），然后把常驻文本与动态文本拼成 runtime-context 快照。
- **渲染时机**：DSH 在**每个请求**装配时都会 `refreshContext` + `runtimeContext.project`（`packages/core/agent-loop/src/agent.ts:409-420`；快照只在文本变化时提交，`runtime-context.ts:113-160`）。所以 OMB 的 `context()` 是**每请求都执行**的，不是"每轮一次"。
- 观测事件：`step/start` → `turn/start`（`:798-808`）；`tool/call` → `evidence/observed`（actionHash=name+args 字符串，evidenceHash=''，`:826-837`）；宿主 `tools/result` → `evidence/observed`（actionHash=callId，evidenceHash=结果前 512 字符的哈希，`:843-877`）。

**纯逻辑层**

- 档位：`focus.ts:49-53`（只有 `deep` 读控制行；`standard/quick` 不读）、`:82-96`（`projectFocus`）、`:198-245`（写后回读）。
- 控制表：`control.ts:60-88`（quick=0 验证预算；standard=1；deep=3；`injectCard` 只有 deep 有 R4）、`:126-134`（`controlForBand` 只把 quick 抬到 standard）、`:143-147`（`pressureRaisedFloor`）、`:175-189`（`controlLine` 一行 ≤120 字符）。
- 方法卡：`methods.ts:43-92`（8 张）、`:113-117`（按档声明 needs，**不是注入计划**）、`:152-177`（常驻提示 3 变体，71/54/26 字符；当前用 71 版本）。
- 循环：`loop.ts:45-50`（阈值 3/2/3/5）、`:106-124`（call/result 归并）、`:136-154`（优先级 repeat→oscillation→stalled→no-new-evidence）、`:157-159`（≤80 字符提示）。
- 验证：`verify.ts:51-64`（6 条正则）、`:82-129`（形式判定）、`:302-337`（台账汇总 + 注入行）、`:363-366`（claimKey = 逐字文本）。
- 糊弄观察：`gaming.ts:86-103`（只看循环信号 + 标签），**只上状态面**，不进注入。

### 1.2 状态异常逐条解释

#### A. 为什么 `standard` + `tight` 是"上次注入：空"

`context()` 的六段在 `standard + tight` 下逐段判空（全部 [源码] + 与 trace 吻合 [实测]）：

| 段 | 条件 | standard | tight 的影响 | 结果 |
|---|---|---|---|---|
| ① 指令 | `projection.directive`（`focus.ts:89`，仅 quick） | `''` | 无 | 空 |
| ② 控制读数 | `projection.controlText`（`focus.ts:91`；`ANNOUNCE_CONTROL.standard=false`，`:49-53`；`pressureRaisedFloor(standard,tight)=false`，`control.ts:132,143-147`） | `''` | `controlForBand` 对 standard 原样返回 | 空 |
| ③ 规则卡 | `projection.cards`（`control.ts:70-78` `injectCard:null`） | `[]` | tight 只换"索引"，而索引要求 `substantive=true`（`index.ts:596,615-618`），standard 下 `controlText=''` 且 `cards=[]` → `substantive=false` | 空 |
| ④ 验证段 | `control.verifyBudget>0` 且 `unresolved>0`（`index.ts:645-652`；`verify.ts:329`） | 预算=1，但本会话从未 `omb_verify` → `unresolved=0` | tight 不改变它 | 空 |
| ⑤ 循环提示 | `state.lastSignal !== null`（`index.ts:654-660`） | 本会话无信号 | — | 空 |
| ⑥ 出口段 | 仅 `stalled`/`no-new-evidence`（`control.ts:247-254`） | 无信号 | — | 空 |

`lastRender` 于是记录 `chars=0, delivered=[], requested=CARDS_BY_DEPTH.standard=['R1']`，状态行按 `index.ts:220-223` 渲染成"空（深度 standard，压力 tight；请求 R1，未注入）"。

**这就是本次 71/120 字符常驻提示 + "空"的全部来源。** 它是设计使然（`methods.ts:110-111` 明说 standard 不额外注入），不是渲染丢了内容。

顺带一个措辞缺陷：`requested` 取自 `CARDS_BY_DEPTH`（"声明需要"），而 standard 的 `injectCard` 是 `null`——模块**从未打算**注入 R1，状态却写"请求 R1"。这正是本模块声明要消灭的"读数说谎"类缺陷（`index.ts:160-163` 的注释说 requested 是"该档位声明需要的卡"，但渲染成"请求"）。

#### B. "尚未核对过结论"是什么意思

`index.ts:340`：`verifyCalls > 0 ? ... : '尚未核对过结论'`。`verifyCalls` 在 `verifyPort` 的 **claim 分支**自增（`:503`），是**模块级（跨会话）**计数，不随会话清空。

- 本会话日志里 `omb_verify` 调用数为 0 → 该句如实。
- 它同时暴露机制问题：验证段（④）要求 `unresolved>0`，而 `unresolved` 只来自"调用过 `omb_verify` 且判定非 `checkable`"的记录。**没调用过验证工具 ⇒ 永远不会出现验证提醒 ⇒ 更不会想起来调用**。全语料实测：验证段只出现在 **3 个会话 / 36 个快照**；`omb_verify` 56 次 / 391 会话（0.11% 的工具调用）。
- 同一行里 `未闭合` 是所有会话求和（`index.ts:329-330`），而 `验证 N 次` 是模块级累计——两个数不是同一口径，却写在一句话里。

#### C. "1 tracked session"、循环信号 none、8 张卡

- `sessions` 是 `Map<SessionRef, SessionState>`（`index.ts:274`），**无上限、无淘汰**，只在 `reset()` 里删（`:446-449`，且会连验证台账/显式档位一起删）。对比 `dsh/pressure.ts:63,148-155` 有 256 LRU——同一仓库两套纪律。
- "无循环信号"= 当前每会话的 `lastSignal` 为 null；但全语料 82 个会话出现过循环提示，所以"无信号"只描述当下。
- 8 张卡是静态数据（`methods.ts:43-92`），不占注入预算；全文只有 `omb_method` 能拉（34 次/391 会话）。

### 1.3 机制实际生效情况（全语料实测）

语料：391 会话日志；统计口径＝`user/message` 且 `source.kind === 'runtime-context'` 的快照文本中出现对应标记。含 OMB 文本的快照共 **1,525 条 / 295 会话**（快照总长 p50 = 846 字符，含全部组件）。

| 机制 | 标记 | 出现快照 | 会话 | 判断 |
|---|---|---|---|---|
| 常驻提示 | `先判断这个问题需要多少推理` | 1,362（71 或 104 字符块） | 279 | **唯一每请求都在** |
| deep 控制读数 | `档位 deep｜` | 396 | 34 | 生效，仅 deep |
| deep 自动注入卡 | `【R4 结论可检验】` | 412 | 44 | 生效，仅 deep |
| 循环提示 | `（检测到循环）` | 553 | 82 | **高频**（含 OMB 内容快照的 36%） |
| 出口段 | `三个合法出口` | 221 | 30 | 生效 |
| 紧档索引 | `取全文：omb_method` | 17 | 2 | 近似惰性 |
| 验证段 | `条结论未过形式核对` | 36 | 3 | 近似惰性 |
| quick 指令 | `本轮不要展开，直接回答` | 1 | 1 | 惰性 |
| standard/quick 控制读数 | `档位 standard｜` / `档位 quick｜` | 0 | 0 | **设计上从不出现** |

工具采用率（census，391 会话 / 49,440 次工具调用）：

| 工具 | 次数 | 占工具调用 | 有调用会话 | 最大集中地 |
|---|---|---|---|---|
| `omb_focus` | 98 | 0.20% | 69 | OMB 仓库会话 41 次（其中 1 个 3,057 步 dev 会话占 14 次） |
| `omb_verify` | 56 | 0.11% | 39 | OMB 仓库 5 次；其余分散在真实项目 |
| `omb_method` | 34 | 0.07% | 20 | OMB 仓库 19 次 |
| `omb_status` | 69 | 0.14% | — | OMB 仓库 **67/69（97%）** |

**关键交叉事实**：有 `omb_focus` 调用的 69 个会话里，只有 34 个后来真的出现过 deep 注入；**另 35 个会话的档位调用没有产生任何 deep 注入**（可能设的是 standard、或会话在下一请求前结束、或渲染落空）。98 次 focus 调用 → 396 个 deep 快照，说明"调档"多数发生在少数会话里反复来回。

### 1.4 真实缺陷清单（按严重度）

| # | 缺陷 | 证据 | 影响 |
|---|---|---|---|
| D1 | **默认档位注入为空**：standard+tight 五段全空（§1.2A） | `index.ts:570-676`；`status` 实测 | 组件在最常见配置下对模型"不存在"，只有 71 字符提示 |
| D2 | **深度不影响算力**：请求头 effort=max（profile `agent-default-model`），`omb_focus` 只改文本 | request/header 实测；`cordis.patch.yml` | quick 省不了思考 token；deep 也不增加真实预算——档位是装饰 |
| D3 | **压力耦合只对 quick 生效**；quick 全语料 1 快照 | `control.ts:126-134,143-147`；实测 | v3.6 §3.4-A 的"压力—严谨度耦合"在生产里从未触发 |
| D4 | **循环检测无精度证据 + 归并模型脆**：`noteObservation` 用"上一条缺证据就补"的启发式（`loop.ts:106-124`），而 DSH 同一步可有多个并发工具调用（49,440/39,081=1.27；`tool-calls.ts:42-46` 调度、`:264` 记 call、`:282` 记 result，提交按序但**调用事件先于结果事件成批出现**） | 源码 + 事件比 | 证据可能挂到错误动作上，制造假 `repeat/no-new-evidence`；实测 36% 快照带循环提示 |
| D5 | **压缩盲区**：不订阅 compaction，循环窗口/验证台账/档位跨压缩保留；压力 band 在渲染时取"请求前预估" | 实测 Lead 会话（§1.5）；`dsh/pressure.ts:232-240` | 压缩后仍按压缩前的世界判断，状态与注入都可能错 |
| D6 | **状态留痕不可审计**：只存 band 字符串，无时间/总量/窗口/采样会话；`lastRender` 模块全局 | `index.ts:156-182,681-696` | 同屏出现"tight vs relaxed"两个事实（§1.5） |
| D7 | **`reset()` 语义与文档相反**：文档"只清窗口"（`index.ts:107`），实现删整份会话状态 | `index.ts:446-449` | 一次 reset 丢掉验证待办与显式档位 |
| D8 | **会话表无上限**；`verifyCalls` 跨会话口径混用 | `index.ts:274,340` | 长跑进程内存增长；状态数字口径不明 |
| D9 | **验证可被形式糊弄**：6 条正则判定"来源可指"（`verify.ts:51-64`），`claimKey` 逐字（`:363-366`） | 源码 | 编一个 `src/a.ts:42` 就"形式可核对"；改述结论即可"清空未闭合" |
| D10 | **"请求 R1"措辞**：standard 的 `injectCard=null`，从未打算注入 | `methods.ts:115` vs `control.ts:70-78`；`index.ts:222` | 读数说谎（本模块自己的红线） |
| D11 | **context order=200 与宿主 `HARNESS_SOURCE:200` 撞位** | `dsh/session.ts:50`；`system-prompt/src/index.ts:176` | 注入顺序依赖注册顺序，非契约；宿主升级可能改序 |
| D12 | **成本结构反了**：3 工具 schema 1,442 字符/请求（约 450 token），采用率 0.07–0.20% | request/header 实测 | 每个请求为几乎不用的工具付常驻费 |
| D13 | 糊弄观察面无独立信号源（只复用循环/验证），"未测量"行 150+ 字符只在状态面 | `gaming.ts:86-168` | 状态噪声（不进注入，非 token 问题） |

### 1.5 Lead 问题的直接回答（压力分歧）

**Q：reasoning 的 `压力 tight` 与 context 的 `relaxed / 0.021 / 21,308 token`，是陈旧还是两源不一致？**

**答：同一个函数、不同时刻；trace 是"压缩前"的陈旧采样，不是第二数据源。**

证据链（全部 [实测]，来自 `session-40edda4c...` 的会话日志）：

1. 两侧都调用 `kernel.pressure(session)`：`dsh/session.ts:640-645`（渲染）与 `dsh/status-tool.ts:298`（状态）。`kernel.pressure` 每次现调 `measure`（`kernel/index.ts:524-529`），不存在缓存模块态。
2. 该会话 04:56 与 05:13 两次 `omb_status` 都显示 `moderate`，`total=413,238 / 425,737`，`ratio=0.413/0.426`（窗口 1,000,000）——真实大上下文。
3. 06:08–06:13 用量持续上涨，06:13:35 最后一次压缩前 usage：`totalTokens=617,110`，即 `617,110/1,000,000 = 0.617 ≥ 0.6` → **`tight` 当时是真的**。
4. 06:18:54 `compaction/start`，06:19:17 `compaction/end`；之后到 06:39:22 之间**没有任何 step**（会话空闲 20 分钟）。
5. 06:39:22 第一个压缩后 step 开始：渲染（`agent.ts:409-420`，位于请求发送**之前**）读到的压力还是压缩前的预估锚点 → trace 写 `tight`。
6. 06:39:28 该请求的 usage 到达：`inputTokens=21,308`；同一秒的 `omb_status` 里 context 组件读到 `relaxed / 0.021 / 21,308`。
7. 同一屏状态因此同时显示"上次注入：压力 tight"与"压力档位：relaxed"。

**结论**：不是"两个组件各算一套"，而是 **OMB 把一次的采样值当成永久事实**：`RenderTrace` 没有时间戳、没有 `totalTokens/contextWindow`、没有"采样是请求前还是请求后"的语义（`index.ts:156-182`），而 `token-meter` 的 `contextPressure` 本身就是"不同时刻的 last-wins 混合"（`packages/llm/token-meter/src/projection.ts:19-48` 原文警告）。同一机制还解释了为什么 trace 会显示**别的会话**的渲染（`lastRender` 模块全局）。

---

## 2. SOTA 综述（2025–2026）：机制级细节、证据质量、对插件的适用性

> 全部外部结论标 [报告]（论文/厂商自述），并给出 URL。最后一行给"插件能不能用"的判断——OMB 不能改模型内部，只能改请求参数、提示、宿主事件与工具面。

### 2.1 测试时算力（test-time compute）与预算控制

| 工作 | 机制 | 关键数字/结论 | 对 OMB 的适用性 |
|---|---|---|---|
| Snell et al., *Scaling LLM Test-Time Compute Optimally…*（2024-08）arXiv:2408.03314 [报告] | 两种机制：过程奖励搜索、按 prompt 自适应调整分布；"compute-optimal"按难度分配 | 比 best-of-N 基线提效 **>4×**；FLOPs 匹配下小模型可胜 14× 大模型 | **思想可用，机制不可用**：需要 PRM/多次采样。可借用的只有"按难度分配预算"——即把档位映射到 effort |
| Muennighoff et al., *s1: Simple test-time scaling*（2025-01/03）arXiv:2501.19393 [报告] | **budget forcing**：强制提前结束思考，或反复追加 "Wait" 延长思考 | s1-32B 在 MATH/AIME24 上比 o1-preview 高至多 **27%**；预算延展 50%→57% | **最重要的一条**：真正的"少想/多想"是**控制生成长度**。插件无 token 级控制，但有 `reasoningEffort` 三档——这是同一杠杆的粗粒度版本。**不要**用提示词假装 |
| Li et al., *Adaptive Thinking: LLMs Know When to Think in Latent Space*（ICLR 2026）[报告] | 用自一致性做"是否需要长思考"的代理，训练 adapter 从隐状态预测预算（Sonata） | 同等准确率下 **省 20–60% 思考 token**；推理开销 <1‰ | **机制不可用**（要隐状态）。可借"自一致性"作离线标注思路；在线只能用可观测代理（任务类型、用户显式档位） |
| *Zero-Overhead Introspection for Adaptive Test-Time Compute*（2512.01457，2025-12）[报告] | 模型内省式预算分配 | 本次只核到标题/摘要级 | 同上：插件侧不可用 |

### 2.2 过度思考 / 思考不足

| 工作 | 机制/结论 | 对 OMB 的适用性 |
|---|---|---|
| Chen et al., *Do NOT Think That Much for 2+3=?*（2412.21187）[报告] | 首个系统研究 overthinking：简单题上分配过多算力、收益极小；提出过程/结果效率指标与自训练缓解 | 可借**指标**（按难度分层的 token 效率），不能借训练。它支持"quick 档要有真实算力下降"，而不是只改措辞 |
| Wang et al., *Thoughts Are All Over the Place: On the Underthinking…*（2501.18585）[报告] | underthinking = 频繁切换思路、每条都没走深；TIP 解码惩罚过早切换 | **与 OMB 的 "oscillation/loop" 是同一现象的不同观测层**：TIP 在解码层，OMB 在动作层。可借"切换次数/步数"做循环指标，不借解码 |
| 两者共同点 [报告] | 都用 **思考 token 数** 作为质量维度；仅靠提示词无法可靠缩短思考 | OMB 目前**连思考 token 都没读**（`tokenUsage` 投影里有 `outputTokens` 含 reasoning，未使用） |

### 2.3 自一致性与自验证

| 工作 | 机制 | 结论/证据强度 | 适用性 |
|---|---|---|---|
| Wang et al., *Self-Consistency*（2203.11171）[报告] | 多次采样 + 多数投票 | 数学推理显著提升（GSM8K 等）；需要可比对答案 | **单回合 agent 不可用**（成本×k、且没有 vote 接口）。唯一的合法形态是**独立 subagent 复核**（不同上下文，避免同错） |
| Lightman et al., *Let's Verify Step by Step*（2305.20050）[报告] | 过程监督（PRM800K，80 万步级人工标签） | 过程监督显著优于结果监督；78% MATH | **要训练好的 PRM 才能用**。插件能给的是"可核对的步骤产物"（命令、file:line），不是 PRM |
| Anthropic, *The "think" tool*（2025-03，2025-12 更新）[报告] https://www.anthropic.com/engineering/claude-think-tool | 额外一个"想一步"的工具；τ-bench 航空域 pass^1 **0.570（think+优化提示） vs 0.404（裸 think） vs 0.412（extended thinking） vs 0.332（baseline）**；SWE-bench +1.6%（n=30，p<.001） | **对本项目最关键的一条外部证据**：① 裸 think 工具≈extended thinking≈小幅提升；② **真正的大提升来自"提示 + 工具"一起**；③ 2025-12 官方更新说：多数场景**直接用 extended thinking，别用 think 工具**；④ 长指引放 system prompt 比放工具描述更有效；⑤ 非顺序工具调用/简单指令遵循**没有收益** |
| 由 2.3 推出的判断 [推测] | OMB 的 `omb_verify` 是"裸 think 工具"的形态：无提示协同、纯形式检查 → 收益上限≈裸 think；而它每请求 641 字符 schema + 每次回执 400–500 字符 | 应删除或改写为"收尾闸门"，见 §4 |

### 2.4 元认知 / 何时该想

| 工作 | 机制 | 适用性 |
|---|---|---|
| ICLR 2026 Sonata（同 2.1） | 预填充阶段预测"该想多少" | 插件不可用（要隐状态） |
| Anthropic 的 extended thinking 与 effort 分级（厂商文档；DeepSeek 亦有 `reasoning_effort: low/high/max`，`thinking: enabled/disabled`，`off` 可关思考）[报告] https://api-docs.deepseek.com/guides/thinking_mode/ | 把"想多少"变成请求参数 | **可用且已在宿主里**：DSH 每次请求带 `reasoningEffort`，profile 现在钉死 `max`。这是 OMB 唯一能真正改变算力的旋钮 |
| 结论 [推测] | 元认知在插件层只能做"三档离散选择 + 显式用户/模型触发"，做不了逐题预测；诚实的设计应承认这一点，而不是用更多规则文本假装 |

### 2.5 CoT 忠实性 / 可监控性（决定"能不能靠自述判断质量"）

| 工作 | 结论 | 对 OMB 的含义 |
|---|---|---|
| Turpin et al., *Language Models Don't Always Say What They Think*（NeurIPS 2023，2305.04388）[报告] | CoT 解释可系统性歪曲真实原因；加偏置特征时准确率最多掉 **36%**，模型不提及偏置；会为错误答案生成合理化解释 | **禁止**用"模型自述'我验证过了'"当质量信号；也是 gaming 模块"只报事实不判作弊"的正确依据 |
| Anthropic, *Reasoning models don't always say what they think*（2025-04）[报告]（搜索索引页 https://www.anthropic.com/research/reasoning-models-dont-say-think ；本次抓取原路径 404，属厂商简报级证据） | 推理模型在提示暗示下会少说关键线索；CoT 监控不完全可靠 | 与上一条同向：质量信号要从**行为/状态**取（工具序列、token、未闭合结论），不从文本自述取 |
| 推论 [推测] | OMB 的 `omb_verify` 只检查"证据字符串形式"，本质上还是在读自述 | 若要保留"核对"，应改为可外部验证的动作（跑命令、读文件、subagent 独立复核） |

### 2.6 脚手架类：plan-and-solve / ReAct

| 工作 | 机制 | 对 OMB 的适用性 |
|---|---|---|
| Wang et al., *Plan-and-Solve Prompting*（2305.04091）[报告] | 先让模型写计划再执行；zero-shot 显著提升多步推理 | **DSH 已有原生 plan 模式 + goal + todo**（§3）。OMB 再写一张 R2 卡是重复；正确做法是把"深任务先落计划"接到宿主状态上 |
| Yao et al., *ReAct*（2210.03629）[报告] | 交替推理与行动、用观察更新 | **agent loop 本身就是 ReAct**；OMB 的 R6（失败先分类）可以视为"观察→换向"的提示版，但宿主已有工具结果与错误分类字段，文本卡片价值低于事件触发的一行 |

### 2.7 推理轨迹评估与长度控制（可迁移的度量）

- 长度≠质量：overthinking 文献同时用"结果准确率"和"过程效率（正确但冗长/错误但冗长）"两类指标 [报告 2412.21187]。OMB 应报告：**每步 outputTokens（含 reasoning）**、**每任务工具调用数**、**重复动作率**、**未闭合结论数**——这些都能从 `tokenUsage` 与现有事件里算，不需要读 CoT 文本。
- 轨迹评估需要参考答案或可验证判据；插件侧没有 gold answer，只能用**行为代理**（回退、重复、往返、放弃率）。OMB 现在的 loop/verify 台账已经是这类代理的雏形，但阈值未标定、精度未测。
- s1 的教训：长度控制必须作用在生成上；只在提示词里写"不要展开"是**没有强制力**的（thinking 由 API 参数控制）[报告+推测]。

---

## 3. DSH 0.2.1-rc.2 原生能力：该用而没用的

> 本节只列与 reasoning 直接相关的面；完整能力矩阵见同批 `docs/research/2026-10-18-dsh-capabilities.md`（R4 线程，避免重复）。

### 3.1 已经存在、OMB 应当改用

| 原生面 | 契约/位置 | OMB 现在怎么做 | 应该怎么做 |
|---|---|---|---|
| **推理算力：`reasoningEffort`** | `packages/llm/llm-deepseek/src/config.ts:21-24,93-94`（`off/low/high/max`，默认 `high`，`off` 关思考）；request/header 里带 `config.reasoningEffort`（实测 `max`）；DSH 允许会话级覆盖（`packages/api/session-controller/src/index.ts:310-312` `selectModel`；`model/selection` 事件与 `modelSelection` 投影，`src/types.ts:100-121`） | 完全不用；`omb_focus` 只改提示文本 | `quick/standard/deep → off|low / high / max`，在下一请求生效；`omb_focus` 变成"设置真实预算"的动作 |
| **思考模式开关** | `thinking: enabled|disabled`（同上 `config.ts:21-22`） | 不用 | 与 effort=off 等价（DSH 会校验：thinking=disabled 时只允许 effort=off，`config.ts:219-222`） |
| **`agent/pre-step` 瀑布** | `packages/core/agent/src/runtime-types.ts:112-120,310-330`；每个 step 可替换/追加消息、声明请求序列起点 | 不用；只在 systemPrompt 的 context 里塞一行 | 用它做**收尾闸门**（要结束一轮时追加一条"给否证条件/未决项"的消息）或"深任务先落计划"的门。注意它拿到 `payload.messages` 与 `agent`，比 runtime-context 更接近"这一步要做什么" |
| **plan / goal / todo 原生状态** | plan-mode：`packages/plan/plan-mode/src/index.ts:66,217,232,278-305`（`exit_plan_mode`、`plan:policy`、`plan` 段）；goal：`goal/tool-goal/src/index.ts:196-236`（`get_goal/create_goal/update_goal`）；todo：`todo/tool-todo/src/index.ts:136`（`todo_write`） | 用 R2/R3 两张文字卡"要求"先立判据/并列备选 | 把"要计划"接到宿主状态：深任务若既无 goal 也无 todo，就注入一行"先落计划/判据"；有 goal 时不再重复说 |
| **compaction 事件与 surface 代际** | 日志实测事件 `compaction/start|summary|end`；`RuntimeContextProjection` 用 surface 替换（`agent-loop/src/runtime-context.ts:113-160`） | 完全不感知 | 循环窗口/验证台账按 surface 代际分区；压缩后把"此前结论可能过期"作为一条真实事件注入（≤80 字符） |
| **token 投影** | `contextPressure`（`pressureTokens/projectedTokens/contextWindow`）、`tokenUsage`、`contextBreakdown`（`packages/llm/token-meter/src/projection.ts:19-66`） | 只读 pressure 的 band | 加读 `tokenUsage.outputTokens`（含 reasoning，`projection.ts:9-18` 原文）：这是"实际想了多少"的唯一可核对读数，也是 quick/deep 效果的验收指标 |
| **subagent / agent-team** | `tool-subagent` / `tool-subagent-fork` / agent-team bundle | 不用 | 唯一可信的"独立复核"：新上下文 + 另一遍推理。只在用户要求或有高风险结论时用（成本=一次完整调用） |
| **auto-review** | `packages/experimental/auto-review/src/index.ts` + README：**每个工具调用执行前**用当前模型审一次（权限闸门，不是质量复审） | 不用 | 不要误用为"答案复审"；但它证明了 `tools/pre-execute` 钩子的可行形态。若要做"动作前检查"，这是路径，不是 reasoning 的默认路径 |
| **systemPrompt 段/上下文顺序** | `packages/core/system-prompt/src/index.ts:79-90,131-179,582-602`；OMB 用 `context({name,order:200})` | 用 200，与 `HARNESS_SOURCE:200` 撞位（§1.1） | 改用低于 200 的非保留值（如 190）或改为 `section`（常驻提示本来就是静态的）；若要静态前缀缓存，`section` 比 `context` 更合适 |
| **hooks / 工具管线** | `tools/pre-execute` 等（auto-review 用）；`hooks` 包是外部命令桥，不是插件注册面（R4 §1.1 #16） | 不用 | 不必用外部 hook；插件内 `kernel.on`/`agent/pre-step` 已够 |

### 3.2 宿主做不到的（决定了重构边界）

- 不能改模型内部：无隐状态、无 PRM、无 token 级 budget forcing、无解码干预（Sonata/TIP 类机制全部不可用）。
- 不能逐题预测"该想多少"：只有 `reasoningEffort` 离散档 + 显式信号（用户/模型/宿主事件）。
- 不能读推理文本做质量判定：`assistant/message` 的文本 OMB 现在拿不到（`dsh/session.ts:786-840` 的 switch 只处理 step/tool），而且即便拿到，CoT 自述不可信（§2.5）。
- 不能拦"最终答复"文本：没有"回答前"钩子；`agent/pre-step` 只在下一步开始前生效。要"收尾闸门"只能**在模型下一次请求前**追加消息（等价于"你还有一步"），或者靠工具面（模型必须先调某工具才能结束——DSH 没有这种强制结束工具）。

---

## 4. 重构提案（按 影响 / 成本 / 风险 / token 排序）

### 4.1 逐机制裁决

| 机制 | 裁决 | 理由 |
|---|---|---|
| 常驻提示（71 字符） | **保留**（可微调为同时承载 R1+R4） | 唯一每请求都在、成本 ~50–70 token；71 字符已是三条变体里最长且不超 120 |
| 档位→文本控制读数（`controlLine`：验证预算/分支/复核/收尾/证据） | **删除文本，改映射 effort** | standard/deep 下 band 无影响（D3）；模型从未被验证过会按这些数字行动；effort 才是真实预算 |
| 自动注入 1 张卡（deep=R4） | **保留但降为"deep 时才有的 1 行判据"** | 现测 deep 生效（44 会话）；卡片正文可由 `omb_method` 拉 |
| 紧档索引 | **删除** | 17 快照 / 2 会话；"索引"在标准档 `substantive=false` 时本就不给（D1） |
| `quick` 指令 | **改写为 effort=off/low**；文本最多保留一句 | 全语料 1 快照；提示词对思考长度无强制力（§2.1） |
| 验证段 + `omb_verify` + 台账 | **删除**（或最小化为"收尾闸门"） | 循环依赖（D4/§1.2B）；56 次/391 会话；schema 641 字符/请求；形式核对可伪造（D9）；证据上限=裸 think 工具（§2.3） |
| 验证预算/分支/复核/收尾表 + 失败 playbook | **删除**（playbook 只保留"失败先分类"一句，由循环信号触发） | 从未被行为验证；`classifyFailure` 需要模型先调删除的工具 |
| 压力带耦合（`controlForBand`） | **删除** | 只影响 quick，quick 几乎不用（D3） |
| 循环检测 | **重写**（不是删） | 高频生效（82 会话）但精度未测、归并脆、无压缩分区；这是唯一有"模型自己看不见"价值的部分 |
| 出口段 | **保留**（重写后由高精度信号触发） | 依据是"合法出口"研究（R1 报告 §3.7）；30 会话生效，成本可控（≤200 字符） |
| 糊弄观察面 | **保留在状态面，压缩到 1–2 行** | 不进注入，无 token 成本；但"低召回高精度"没有精度读数，措辞要改成"未测量" |
| 8 张方法卡 | **8 → 4**（保留 R1 匹配深度、R2 判据、R6 失败分类、R8 冲突呈现；R3 并入 R1/R2，R4/R5 合并为"可检验/有出处"，R7 并入 R2） | 卡片是全语料唯一"按需拉取"的正文；减少后 `omb_method` 的 schema 与索引都更小；删卡不损失已生效机制（R4 卡仍可单列） |
| `omb_status` 的 `上次注入` 行 | **重算**：状态时现读 `kernel.pressure` 并同时报 `{band,total,window,at}`；`requested` 只在真会注入时出现 | D6/D10；这是本模块"不许说谎"的底线 |

**token 账（模型面，每请求，稳态）**

| 项 | 现状 | 提案后 |
|---|---|---|
| 常驻提示 | 71 字符 ≈ 50–70 token | 71 字符（不变） |
| 工具 schema（reasoning 三件） | 1,442 字符 ≈ 450 token | `omb_focus`≤250 + `omb_method`≤300 ≈ 170 token（删 `omb_verify`） |
| 动态注入（standard/relaxed） | 0 | 0 |
| 动态注入（deep / 循环 / 压缩事件） | 控制行 84–366 字符 + R4 卡（实测 block p50=134） | 一行 ≤120 字符（重写后），至多 1 段 |
| 稳态合计 | ≈500–520 token/请求 | ≈220–240 token/请求（−55%） |
| 峰值（deep 首注入） | 卡片+读数（实测 p90=282 字符） | ≤120 字符 |

> 说明：工具 schema 是稳定前缀、可被 KV cache 命中，但仍是**占用**；上述数字按字符算 token（中文 ~1 token/1–1.5 字符，混合 JSON 更密），故写区间并标 [推测]。

### 4.2 具体文件级计划

**阶段 1（P0，可独立回滚）：「档位→真实预算」+ 删验证工具**

- `modules/reasoning/focus.ts`：新增 `depth → effort` 映射（`quick→off|low`，`standard→high`，`deep→max`）；`applyFocus` 在写内核档位后调用宿主模型选择（若 Lead 确认可用，见 §5-P1）；`projectFocus` 删除 `controlText/announce/pressureRaisedFloor` 相关逻辑（`:82-96` 简化）。
- `modules/reasoning/tools.ts`：删 `createVerifyTool`（`:226-261`）与其入参（`:57-68`）；`omb_focus` 描述压缩到 ≤250 字符（`:187-191`）；`createReasoningTools` 返回 2 条（`:264-266`）。
- `modules/reasoning/verify.ts`：整文件删除（371 行）或缩为 40 行"无未决项"计数（若保留收尾闸门）。
- `modules/reasoning/index.ts`：删 `verifyPort`（`:464-520`）、验证段（`:645-652`）、`VerifyTracker` 状态与状态面行（`:748-764` 中的验证部分）；`describeLastRender` 改为记录 `{band,total,window,at,session}` 并在状态时现读（`:216-252`、`:681-696`）；`reset` 只清窗口（`:446-449`）；`sessions` 加 LRU（如 128）。
- `modules/reasoning/control.ts`：删 `CONTROL_BY_DEPTH` 的验证/分支/复核/收尾字段与 `controlForBand`（`:56-134`、`:161-208`），保留 `FAILURE_PLAYBOOK` 的一句话模板；`renderExitOptions` 保留并把判据改成"档位=effort"的表述。
- `dsh/session.ts`：注册顺序改为 `<200`（避免与 `HARNESS_SOURCE` 撞位）；在 `session/event` 里转发 `compaction/*`（或至少 surface generation）到内核事件；若 Lead 同意，`tool/call` 的事件载荷加 `ok`/`tool` 类别（供循环精度用，属加法 ABI）。
- 验收：见 4.3。

**阶段 2（P1）：循环检测重写**

- `dsh/` 侧用 **callId 精确配对**（`tool/call.callId` 与 `tool/result` 的 callId，DSH `tool/call` 载荷 `packages/core/session/src/types.ts:362` 已带 `callId`），把一条 `evidence/observed` 的 `evidenceHash` 与对应 `actionHash` 绑定，不再用"上一条缺证据就补"。
- `loop.ts`：窗口按 `surfaceGeneration` 分区；加**迟滞**（同一信号触发后 N 步内不重复注入）；阈值从语料标定（用状态面日志做离线网格：目标"提示率≤10% 步"、"后续 5 步内出现不同动作"作为正例代理）。
- 注入侧：只保留 `stalled`/`no-new-evidence` 的出口段 + `repeat-action` 一句；`oscillation` 降为状态面。

**阶段 3（P2）：卡片瘦身 + plan/goal 接线**

- `methods.ts`：8→4 张（R1/R2/R6/R8），常驻提示改为承载 R1+R4 一句；`renderIndex` 随卡片数下降。
- 深任务门：`agent/pre-step` 或 turn/start 时检查"本会话有无 goal/todo"（原生投影），无则注入一行（≤60 字符）"先写判据/计划"；**不新增工具**。

### 4.3 可验收标准（都能从会话日志/状态面算出来）

| # | 指标 | 现状基线（实测） | 目标 | 测法 |
|---|---|---|---|---|
| A1 | 稳态模型面 OMB token/请求 | ≈500–520（71 字符提示 + 1,442 字符 schema） | ≤260（−50%） | 从 `request/header` 的 `tools` 里取 `omb_*` 字符数 + runtime-context 快照里 OMB 段字符数 |
| A2 | 动态注入率（非空注入的请求占比） | 含 OMB 快照里 36% 带循环提示（高频），standard 恒 0 | 常态 ≤10%，且每段 ≤120 字符 | 快照统计 |
| A3 | 循环提示精度/召回 | 未测（82/295 会话有提示） | 精度 ≥0.7、召回 ≥0.5（100 段人工标注：提示后 5 步内是否真的无新证据/换向） | 日志离线标注 |
| A4 | quick 档思考成本 | 与 max 无差别（请求头 max） | `outputTokens`（含 reasoning）≤ max 基线的 40%，p50 时延 −20% | `tokenUsage`/usage 事件，配对任务 A/B（同一任务 max vs off） |
| A5 | 状态诚实性 | 存在"tight vs relaxed 同屏"、"请求 R1" | 30 轮影子运行中 0 处"状态断言无法由实时读数复现"；`上次注入` 必须带时间与 `total/window` | 影子脚本比对 trace 与实时 `kernel.pressure` |
| A6 | 验证替代 | 56 次调用/391 会话；验证段 3 会话 | 若采用"收尾闸门"：只在一轮将结束时出现，且 ≤80 字符；若采用 subagent 复核：只在显式高风险时，成本可计量 | 注入快照 + 工具计数 |
| A7 | `omb_focus` 有效落地率 | 69 个调用会话中 35 个无 deep 注入 | ≥90% 的 focus 调用在下一请求生效（用 request/header 的 effort 或注入行验证） | 会话日志前后对比 |

### 4.4 回滚

每个机制一个**配置开关**（建议 `reasoning.mechanisms: ['effort','loop','hint','gate']`，默认开启新行为；旧行为保留为 `legacy` 分支至少一个版本）。回滚是改 YAML，不是回滚代码；所有注入段都进 `lastRender` 留痕（带时间与输入），回滚后可对比。

### 4.5 明确不做（有据）

1. **不再加规则卡片/散文**：证据不支持"更多文字=更好推理"（§2.3 think tool 的对比：裸工具≈extended thinking；真正的提升来自提示与工具协同，而不是条数）。
2. **不用模型自述判断质量/作弊**（Turpin 2305.04388；Anthropic 2025）；不写"别作弊/你被监控"（R1 报告 §3.5 的反例清单）。
3. **不做单回合自一致性/多次采样**：成本×k、无投票接口；要独立意见就用 subagent（显式、可计量）。
4. **不自研 budget forcing / 解码干预**：宿主与 API 都不提供；只有 `reasoningEffort`。
5. **不在热路径加 LLM 调用**（auto-review 形态）：一句提示的成本可以是 0，一次 LLM 审查的成本是一次完整请求。
6. **不扩公共 ABI 除非 Lead 裁决**：`evidence/observed` 加字段要动 `kernel/abi/**`；替代方案是把循环检测整体挪到 `dsh/`（那里有工具名与 callId）。
7. **不把 `projectedTokens` 当唯一真源**：它是请求前预估、多点 last-wins；状态必须同时给 `pressureTokens`、`contextWindow`、采样时间。
8. **不在压缩后沿用旧判断**：窗口/台账按 surface 代际分代；压缩后第一条注入只允许是"上下文已压缩，此前结论需重新核对"。

---

## 5. 开放问题与最小探针（给 Lead）

### 5.1 开放问题

- **Q1（决定 P0 可行性）**：插件能否在运行期改会话的 `reasoningEffort`？路径：`sessionController.selectModel`（`packages/api/session-controller/src/index.ts:310-312`）或写 `model/selection` 事件/投影；根 realm 的服务可达性、是否需要 `inject`、以及 profile 的 `agent-default-model` 会不会覆盖。若不可行，P0 退化为"只读报告建议用户改设置"，价值大减。
- **Q2**：`deepseek-flash` 路由在带 `tools` 时接受 `off` 吗？DeepSeek 文档说 `thinking.type=disabled` 可关（且 thinking 默认开启、effort 默认 high），DSH 适配层支持 `off`（`llm-deepseek/src/config.ts:24,93-94`），但没在真机验证过 `tools + off`。
- **Q3**：DeepSeek 的 `reasoning_content` 在带 tools 时必须回传（文档明说，否则 400）。DSH 是否回传？回传即意味着 **max effort 会把思考文本写回上下文**，这直接影响压力与成本（`packages/llm/llm-deepseek/src/serialize.ts:147` 与 replay 机制）。需要一次真机抓包确认请求体。
- **Q4**：`agent/pre-step` 能否用于"收尾闸门"而不与 runtime-context 重复？`PreStepDecision` 允许替换/追加消息（`runtime-types.ts:112-120`），但追加的消息是否进 surface、是否影响缓存前缀需要实测。
- **Q5**：循环检测的"真值"怎么定？建议用"提示后 5 步内是否出现与之前不同的动作且带来新结果"做代理正例；先人工标 100 段，再定阈值。没有标注就不要宣称精度。
- **Q6**：`omb_status` 的文本是否被测试/文档当契约？`tests/modules/reasoning/module.test.ts` 多处断言状态字符串（如 `:347,359,368-369,387,409,429`）；改状态面要同步改测试，属于可接受成本但要排期。

### 5.2 最小探针（只读或一次性，均不写仓库代码）

- **P1（20 分钟，回答 Q1/Q2）**：开一个一次性会话，先 `omb_status` 记录当前 header effort，再调用宿主模型选择 API 切到 `off`（或由 Lead 在 UI 切），然后看该会话下一条 `request/header` 的 `config.reasoningEffort` 与 usage 的 `outputTokens` 是否下降。**这是整个重构的前提。**
- **P2（30 分钟，回答 Q5）**：用现成 391 会话语料，取 20 个出现循环提示的会话，逐个检查提示时刻前后 3 步的 action/result 哈希，人工判 0/1，算精度。若精度 <0.5，P1 阶段必须先修精度再谈注入频率。
- **P3（10 分钟，回答 Q3）**：在同一会话里连续两轮带工具调用，抓 `request/header` 之后的请求体（或看日志里是否有 `thinking` 块回传），确认 reasoning 是否计入后续 prompt。
- **P4（10 分钟，验证 §1.5 结论的普适性）**：再找 1–2 个"大上下文→压缩→首请求"的会话，检查 trace band 与压缩后 usage 的时间关系，确认不是孤例。
- **P5（5 分钟，回答 D11）**：确认 `systemPrompt.context` 的 order 冲突是否真影响顺序（打印 `renderContextSections` 的顺序即可，或看一次请求的 runtime-context 段顺序）。

---

## 6. 附：本报告引用的本地证据索引

- 会话语料：`C:\Users\SuSeventeen\.dsh\sessions`（391 会话，256,316 事件，49,440 工具调用；本报告 §1.3/§1.4 全部计数来自逐日志解码）。
- 关键日志：`--D-Program-Oh-My-BigBlueFish--/session-40edda4c-eebd-4fd4-b3a1-ef5f59dd584e`（pressure 时间线：04:56 413,238 → 05:13 425,737 → 06:13:35 617,110 → 06:18:54 compaction → 06:39:28 21,308；同屏 tight/relaxed）；`9e63bb73...`（本会话 request/header：60 工具 47,299 字符，`omb_*` 4,552 字符，`reasoningEffort=max`）。
- 代码：`modules/reasoning/{index,control,focus,loop,methods,tools,verify,gaming}.ts`、`dsh/{session,pressure,status-tool}.ts`、`kernel/{index,abi/catalog,display}.ts`（行号已在正文逐条给出）。
- DSH：`packages/core/system-prompt/src/index.ts`、`packages/core/agent-loop/src/{agent,runtime-context,tool-calls}.ts`、`packages/core/agent/src/runtime-types.ts`、`packages/llm/llm-deepseek/src/{config,model-info,serialize}.ts`、`packages/llm/token-meter/src/projection.ts`、`packages/api/session-controller/src/{index,types}.ts`、`packages/plan/plan-mode/src/index.ts`、`packages/{goal/tool-goal,todo/tool-todo}/src/index.ts`、`packages/experimental/auto-review/{README.md,src/index.ts}`。
- 外部（URL 均见 §2）：arXiv:2408.03314、2501.19393、2412.21187、2501.18585、2305.20050、2305.04388、2203.11171（引用自文献列表）、2305.04091、2210.03629；ICLR 2026 Sonata（proceedings.iclr.cc 摘要页）；DeepSeek Thinking Mode 文档；Anthropic think tool 工程博客。
