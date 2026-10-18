# OMB v3 结构审计：架构 / 宿主适配 / 维护性 / 安全 / 部署

> 任务：task-15（A1 结构审计）。只读审计，**未改任何源码、未跑 git、未装包**。
> 输入：仓库全部源码（kernel 3,837 行 / dsh 3,421 / modules 18,940 / tests 24,029 / scripts 1,105 / lib-gen 21,370 生成行，按行数实测）、`docs/*.md`（7,624 行）、`docs/research/*`（四份基线报告 + probe-followup + 两份并行审计）、`cordis.patch.yml`、DSH checkout `dsh-v0.2.1-rc.2`（`687f282e86`）、本机 profile 与真实 DB。
> 标注：`[实测]` = 本机运行/读文件/DB/基准；`[源码]` = 直接读代码或宿主源码；`[推测]` = 无实测，仅逻辑外推。

## 0. 口径（先说清楚，否则数字会被误读）

- 测试门禁实测：`npx vitest run` → **99 个测试文件 / 1,414 passed / 1 skipped / 6.59s**（2026-10-18 本机）`[实测]`。
- 运行中的宿主加载的是 profile 副本：`C:\Users\SuSeventeen\.dsh\profiles\web\node_modules\@omb\*` 是**独立的真实目录**（非 symlink），`@omb/plugin` 版本 `3.6.0`、`build-generation.json` = **g84**；仓库也是 g84、3.6.0。两边此刻同代，但同步机制是手工的（见 S-05）`[实测]`。
- 真实记忆库规模（只读打开）：用户库 `knowledge.db` **memory=16 / embedding=19 / edge=1 / fts=16**；项目库 `session.db` **3 / 3 / 0 / 3**；`PRAGMA user_version=2`；`asserted_by`：用户库 model 12、user 4；项目库全为 model `[实测]`。历史语料 391 会话 / 283.7MB / 256,316 事件（docs/research 基线）`[报告]`。
- 代码度量（去空行，按 `//`/`*`/`/*` 开头计注释）：kernel 1,757 注释 / 2,080 代码（**84%**）；dsh 1,457 / 1,955（**75%**）；modules 6,136 / 12,804（**48%**）；tests 14%。**注释量本身不是缺陷**——缺陷是"规格写在注释里、由白名单和约定来执行"（见 S-01/S-08）`[实测]`。
- 工具面成本（g84 产物实测，逐工具 `description` + `parameters.jsonSchema` + 名称 + 约 40 注册开销）：9 个 OMB 工具合计 **≈4,381 字符/请求**：recall 747、remember 938、verify 639、focus 467、relate 444、method 330、files 318、forget 313、status 185。docs 引用的 1,442 字符只是 reasoning 三件（我复算 ≈1,436+开销，方法一致）`[实测]`。

## 1. 判决：用户说的"根本性问题"是什么

不是"某个功能没做好"。是**四个结构性错位**，每一个都会在修好 N 个实例后长出第 N+1 个：

1. **声明/接线/生效三态分裂**：能力在类型里、在 catalog 里、在注释里都"存在"，但生产路径上可能没有任何消费者。仓库自己记录了三起同类事故（工具面、提示注入、模块健康广播），并行审计又发现当前仍有一处 P0（`reasoningEffort` 映射从未被 `dsh/` 应用，S-01）。只要"接线"仍由人工在 N 个文件各写一遍，这类缺陷是**结构性可再生**的。
2. **生命周期没有状态机**：模块由宿主逐行异步挂载、内核同步 apply、工具在微任务里注册、项目库在 `turn/start` 之后才预热。启动窗口内没有"未就绪"的显式状态，只有一串**半接状态**（S-02）。用户看到的"记忆没工作""工具没出现""状态自相矛盾"多数落在这个窗口。docs 自己承认：异步挂载真机首轮时序**从未成对测过**（`docs/dsh-0.2.1-rc.2-compatibility.md:459`）`[源码]`。
3. **ABI 是字符串 + 约定，不是契约**：`Kernel.service(name:string)` 无类型、服务总线全开放、事件面靠 `HOST_ONLY_EVENTS` 白名单合流、catalog 只被测试部分驱动、反向断言至今缺一条（`kernel/abi/catalog.ts:130` 自认）。每加一个模块/事件/宿主版本，新增的都是**静默失败面**（S-03）。
4. **安全边界不是一个强制点，而是一组"应该都经过"的路径**：库访问边界做得很好，但 `forProject`/`snapshot` 的"归属未知可读"语义、profile 的取库路径、recall 输出丢掉证据等级，把"隐私闸门"从承诺变回了路径正确性（S-04）。

**为什么增量修不好**：现有修法每一条都对，但都长在"出事的那个调用点"上（README 里的措辞是"修法不是在某处补 emit，那会长出第二个真源"）。仓库已经在**同一根因上修了至少四次**（工具面一次、提示面一次、健康广播一次、当前 effort 一次）。要做的是把"接线"从人工纪律变成**唯一入口 + 运行时证据 + 会失败的测试**，而不是继续补第 N+1 处。

---

## 2. P0（结构性阻断：不先做，其余修完仍会复发）

### S-01（P0）`reasoningEffort` 映射已实现、已暴露、**从未接线**：`omb_focus` 仍然只改文字

- **证据**：`modules/reasoning/effort.ts:30` 定义 `effortForDepth`（quick→low、deep→max）；`modules/reasoning/index.ts:545` 把它挂在 `reasoning:methods.effortFor` 上；`:628` 又经 `methodsService` 暴露。全仓 grep `effortFor|reasoningEffort|agent/request`：`dsh/` **零消费点**，只有 `modules/` 的注释与纯函数；`dsh/plugin.ts` 没有 `agent/request` 订阅，没有 `request/header` 改写 `[源码]`。而 v3.7-R1 的验收写的是"quick 请求 `request/header.reasoningEffort=low`"（`docs/v3.7-redesign.md:49`）。
- **根因**：模块层被禁 import 宿主，算力旋钮只能由 `dsh/` 应用；但"由 dsh/ 应用"这件事只写在注释里（`focus.ts:9`、`tools.ts:108`），没有强制物。测试只测纯函数映射，测不到"宿主请求头变了"。
- **影响面**：三档推理深度对模型**零算力作用**；`quick` 省不了思考 token、`deep` 不增加预算；回执与状态面对"推理预算"的所有措辞（`focus.ts:223-243`）在算力层面不成立。这是用户"思维链质量"诉求的核心杠杆，且属于仓库自己定义的最难排查形态（"绿着，但没电"）。
- **为什么增量修不好**：再加一个 wire 只是第 N+2 个"声明—接线"对；没有机制阻止下一次（memory 触发句、context 读数、privacy 命令面都走同构路径）。
- **结构修法**：① 把"宿主能力应用"收敛为 `dsh/host-actions.ts` 单一表：`{ capability, apply(ctx), evidence() }`，模块只能声明 `HostAction`，由该表统一注册/重放/注销；② 装配时校验：catalog 中每个 `capabilities` 必须映射到一条 HostAction 或一条明确的"纯文本"豁免，缺一条则模块 `failed`（而不是 `ok`）；③ 状态面显示的每个"已应用"读数必须来自 evidence 采样（最近一次 `request/header` 的 effort），不是"已接线"布尔。
- **验证**：真机同一会话 A/B：`standard` 与 `quick` 各发 3 轮，抓 `request/header.reasoningEffort` 与 `outputTokens`；quick 的 outputTokens 中位数 ≤ max 的 40%（v3.7 验收口径）。反证测试：删掉 `dsh/` 的 HostAction 注册，这条 e2e 必须红。

### S-02（P0）冷启动窗口是"未定义状态"：异步挂载 + 半接工具/库/压力/状态

- **证据**：`kernel/hostEntry.ts:440-499` 的 `apply` **同步返回 disposer**，全部挂载逻辑在 `void (async () => { await waitForKernel(...); ... handle.mount(...) })()` 里——即发生在 `apply` 返回**之后**；工具注册靠 `replayModuleRegistrations`（`hostEntry.ts:131-142`）+ `turn/start` 重放（`dsh/plugin.ts:299-301`）；`dsh/modules.ts:15-17` 却写"宿主要求所有注册在 apply 返回前完成（H-2）"。按该说明，当前实现**与自己的硬约束相反**；而 H-2 引用的宿主文件在 rc.2 **已不存在**（`packages/preset/agent-preset-registry/src/invariant.ts`；实际是 `mount.ts`/`index.ts`，且 `index.ts:127-142` 的审计会等 Loader 树 settle）`[源码+实测 grep]`。
- **量化**：真实日志 143 次记忆写入中 **5 次"项目库尚未就绪"（3.5%）**（`docs/research/2026-10-18-memory.md:32,152`）；`omb_status` 的"已打开项目库 0 个"在首回合前**必然**为 0（开库由 `turn/start` 预热，memory §1.8）；OMB 9 个工具、4,381 字符 schema 是**逐步出现**的，首轮请求可能只看到 `omb_status` `[源码+报告]`。
- **根因**：启动顺序是"宿主 Loader 调度 + 微任务 + 事件"三者合成的**涌现顺序**，没有任何一层的状态机说"我现在还缺什么"。`waitForKernel` 只等内核发布一个 promise；内核发布了，但模块、库、工具桥、压力投影都还没好。
- **影响面**：首回合的工具选择（模型看不到 recall）、首回合写入（项目库未就绪）、首轮状态面（0 库/未测量）、首轮 token 预算（工具表变化导致前缀缓存失效）。用户体感是"OMB 时灵时不灵"。
- **为什么增量修不好**：每个"补一个 await/重放"都在把竞态窗口挪到下一处；没有"就绪"的可观测定义，测试只能断言"线接上了"。
- **结构修法**：① 引入**装配就绪阶段**（`booting → modules-mounted → store-warm → ready`），由内核暴露 `ready()` 并在状态面/工具回执里显示；未 ready 时工具显式返回"装配中 + 缺什么"，而不是报"无记忆"；② 首个 `turn/start` 之前完成项目库预热（可懒，但必须在工具调用路径上 await 一次 `forSession`，当前 `remember` 走的正是这条路，缺的是**显式等待语义**）；③ 用**真实宿主 headless 启动**做契约测试，断言首轮工具集合 = 9、首轮状态面不含"未测量"矛盾。
- **验证**：重启宿主后**第一回合立即**调 `omb_remember`（project kind）与 `omb_status`，各 10 次；0 次"项目库尚未就绪"，状态面 ready 阶段为 `ready`；若复现则修复未生效。

### S-03（P0）ABI 是"字符串 + 白名单 + 注释"：双事件面、无类型服务、无版本协商、无权限边界

- **证据**：`Kernel.service<T>(name: string)`（`kernel/abi/kernel.ts:100-153`）对服务名与形状零校验；服务表同名**静默替换**（注释明说，`kernel/index.ts:104-112`）；任何模块可 `service('stores')` 拿到全库并读写；事件面靠 `adopt.ts:96-103` 的 6 条 `HOST_ONLY_EVENTS` 白名单在**宿主总线**与**内核总线**之间路由，`adopt.ts:185-222` 的注释记录了两次"订阅成功、事件永不到来"的真实事故；catalog 的 `requires` 不决定真实启动顺序（`catalog.ts:15-26` 自认"不要在注释里假装它成立"）；反向断言（实际注册 ⊆ 目录声明）至今缺失（`catalog.ts:130`）。
- **影响面**：新增宿主事件、新增服务、改服务形状、换宿主版本——每一种都可能静默失效；一个第三方/受损模块可在同一内核里读全部记忆（无 capability 隔离）；事件名拼写错误永远不报错。
- **为什么增量修不好**：白名单每加一个名字就是一次补丁；两次事故都由此而来。服务的 `as` 断言各写各的，形状冲突只能在运行时炸。
- **结构修法**：① 服务表改为**按名字的类型注册表**（`declare module` 或 `ServiceMap` 接口，`service<K extends keyof ServiceMap>(k: K): ServiceMap[K]|undefined`），并在注册时做一次形状探针；② 事件面显式建模：`HostEventAdapter` 为每个宿主事件写一条（名称、载荷投影、缺失时降级原因），内核事件与宿主事件**不共享命名空间**；③ 每模块在 manifest 声明所需服务，内核提供 `check()` 并在状态面列出"声明了但未解析到"的项；④ 服务访问带模块身份（`service(name, {as: moduleId})`），stores 只对登记过的消费者开放。
- **验证**：一个"错误宿主事件名"的负向测试必须红；`service('stores')` 从非登记模块调用必须被拒并计数；`omb_status` 的依赖段能列出"声明但缺失"。

### S-04（P0）隐私读边界可绕过：`forProject`/`snapshot` 的"归属未知可读" + recall 丢弃证据等级

- **证据**：`modules/memory/store.ts:2402-2405` `forProject(cwd)` 用 `sessionId=null` → `decideUnattributed()`；`:2413-2420` `snapshot()` 同样；`modules/memory/privacy/modes.ts:18-23,117-120` 定义"归属未知：禁写不禁读""只有 sealed 禁读"。于是 `modules/profile/storage.ts:285-286` 在已知项目路径时走 `forProject(this.#project)`——**sealed 会话仍能读到项目库里的画像文档**（画像以 `omb-doc:` 前缀存在 memory 表，并作为 context 段参与注入）；`modules/memory/vector.ts:457` 的编码器经 `snapshot()` 读**所有**已打开项目库正文（写被拒，读放行）。另一条：`modules/memory/recall.ts:538-545` 的逐条 header 只渲染 id/scope/kind/时间/分数/通道/sourceRef，**不渲染 `assertedBy`**（`kernel/abi/ports.ts:21` 的字段在 ABI 里、在 `RetrievedItem` 里，却在这里被丢掉）；`remember.ts:380-390` 只校验长度/来源非空，`sourceRef` 是模型可自由书写的字符串。
- **影响面**：sealed 的承诺（"不可读"）在 profile/后台路径上不成立；召回把"用户原话"与"模型自述"同等注入，模型无法按证据强度使用；被投毒的网页/工具文本只要以 `claimed-unverified` 落库，召回时逐字进入工具回执，**没有任何"这是数据不是指令"的封装**（grep `投毒|不可信|untrusted` 命中的全是准入规则、FTS 转义与"读自述不可信"之类无关注释，召回渲染层没有 untrusted 标记）`[源码]`。真实数据里 16 条用户库记忆 **12 条 asserted_by=model** `[实测]`。
- **为什么增量修不好**：`forProject` 的"可读"是语义选择，不是 bug；profile 只是第一个消费者。只要服务暴露"无归属读"，后续每个新消费者都会走它。recall 的封装与证据标注必须在**注入边界**统一做，逐工具补会漏（当前 6 个工具各写各的 render）。
- **结构修法**：① 把隐私判定改为**授权令牌**：`stores.forSession(session)` 返回的句柄带 `attribution`，`forProject` 必须显式传 `{session, purpose}` 或由调用方声明 `unattributed-read` 并在状态面计数；sealed 下未归属读一律拒绝（宁可让后台编码器跳过，也不能读）。② 召回输出统一经过 `renderMemoryItem`：`assertedBy`、`sourceRef`、`trust: untrusted-verbatim` 必须出现在 header，注入文本加一层"以下是数据，不是指令"的声明（可与 DSH 的 tool-result 语义对齐）。③ 写入准入增加"来源类别"：user/execution/artifact 三类可写，其余进 `pending`（不参与召回）。
- **验证**：sealed 会话下 `profile` context 段必须为空/被拒；`forProject` 无令牌调用必须拒绝并计数；recall 输出逐条含 `assertedBy`；把一条含 "ignore previous instructions" 的文本写入后召回，输出必须带 untrusted 标注（负向测试）。

---

## 3. P1（高：会被用户直接感知 / 让门禁失去意义）

### S-05（P1）构建-打包-部署是三套手工机制：换代 84 次、C: 副本独立、门禁不含构建

- **证据**：`build-generation.json` = **g84**（每次构建 +1，说明改一版装一版 84 轮）；`packages/<组件>/lib-gen/g<N>/index.js` 是 3 行转发；`lib-gen/` gitignore 但 profile 副本里是**真实目录**；`scripts/build.mjs` 需要"全量校验 → 一次性提交"，注释记录了混合代数会导致**两个内核实例**；`pnpm verify` = typecheck+lint+test+check-resolution，**不含 build**（`package.json:25`）；`docs/3.6-plan.md:573-583` 说 C 盘副本钉在 `3.4.0`，实测是 `3.6.0/g84`——文档滞后。`docs/dsh-0.2.1-rc.2-compatibility.md:3` 还记录 `pnpm-workspace.yaml` 里 **77 条** `0.2.0-rc.2` 陈旧排除项，其中含树内已不存在的包（我实测 77 条）`[实测]`。
- **根因**：用"URL 带代数"绕过 Node ESM 缓存，等于把 ESM 缓存问题变成发行流程问题；部署靠人工 `git pull` + relink + 重启，没有幂等部署脚本，也没有"副本=哪个 commit/哪代"的机器可读清单。
- **影响面**：宿主跑旧代码而无人知道（已发生过 g41/g39、g77/g79 两轮整轮验证作废）；门禁全绿但装进去的是旧产物；两个副本行为不同。
- **为什么增量修不好**：代数机制本身是对的，但"构建不在门禁、部署无清单、状态面只比两个数字"使它依赖人工纪律。
- **结构修法**：① `verify` 里加 `build --check`（只校验产物与源码一致，不换代）与 `check-resolution --profile`；② 部署改为**幂等 `deploy.mjs`**：拉取/同步 → 构建一次 → 原子切换副本 → 写 `deployment.json{commit,generation,dshVersion,at}` → 重启探针；③ 状态面显示三份代数（加载/磁盘/部署清单）与 commit。
- **验证**：连续两次 `deploy` 结果字节一致；故意改源码不重建，`verify` 必须红；`omb_status` 三份代数一致。

### S-06（P1）会话状态无上界、无结束语义、异步 disposer 不被宿主等待

- **证据**：`kernel/sessionRuntime.ts:217-219` `#bySession` 无 LRU（每会话可含任意 slot）；`kernel/registry.ts:296-310` `FocusTable` 无上界；`kernel/activeSession.ts:39` cwd 表无上界；只有 witness 表有 LRU 128（`dsh/session.ts:721`）。`dsh/plugin.ts:385-397` 的 disposer 是**同步**函数，异步收尾挂在 `.async` 属性上；Cordis 只认函数返回值，**`.async` 不会被宿主调用**（grep 全仓仅此处定义；rc.2 的 loader 是否识别函数属性未找到证据 → 这一条含推测）`[源码；宿主是否会调用 .async 部分推测]`。
- **影响面**：长跑宿主内存随会话数增长（语料 391 会话量级）；热重载/重启后旧实例订阅可能残留（H-1 只保证不抛，不保证已退场）；关库与下一次打开竞态（SQLite 句柄/ WAL checkpoint 在后台跑）。子代理会话继承与父会话状态：privacy 已做继承，但 runtime slot 的"继承语义"未定义（`sessionRuntime.ts:135-155` 只按会话隔离）。
- **为什么增量修不好**：每一张表各自加 LRU 是补丁；`session/end` 事件宿主有没有、叫什么，当前代码没建模。
- **结构修法**：① 统一 `SessionLifecycle`：`open/touch/close` 三态，所有按会话的表注册到它，close 时统一清理并断言 `size` 回落；② disposer 契约改为返回 `{sync, async}` 并由 `dsh/plugin.ts` 在宿主关闭路径显式 `await`（或注册宿主 shutdown hook）；③ 状态面带每表 size 与淘汰计数。
- **验证**：压 1,000 个假会话后各表 size ≤ 上限；热开关 20 次后 `listenerCount()` 与各表 size 回到基线；关库后立即重开不抛。

### S-07（P1）门禁可信度：快、全绿、但只证明"假宿主下的代码"，覆盖率与反向断言缺失

- **证据**：1,414 测试 / 6.59s，`vitest.config.ts` 只有 setup（15 行），**无 coverage、无阈值**；`tests/dsh/assembly.smoke.test.ts` 用"假宿主复刻真宿主校验"（README:203 承认"假宿主不复刻校验，测试就会对全被拒绝保持全绿——踩过两次"）；`catalog.ts:130` 明确写着反向断言"由 Lead 统一补"；无真实宿主启动的 CI；`docs/dsh-0.2.1-rc.2-compatibility.md:459` 自认异步挂载真机时序未测 `[源码+实测]`。
- **影响面**：S-01 这种"纯函数 100% 绿、生产零生效"的缺陷无法被门禁发现；插件行解析、实例化、宿主版本兼容都不在门禁里。
- **为什么增量修不好**：再加 100 个单测仍不覆盖"宿主契约"；测试断言的是我们自己写的假宿主。
- **结构修法**：① CI 增加 `headless-host` 集成层：用真实 `dsh` 组合启动一个 profile，跑 3 轮脚本化对话，断言首轮 9 工具、首轮常驻提示 = 104、状态面无矛盾；② 覆盖率门槛（行 ≥80%、分支 ≥70%，先量基线）；③ 双向 catalog 断言 + 每个"接线点"必须在 `host-actions` 表里登记，否则红。
- **验证**：故意删掉 `dsh/` 的 effort 应用 → 集成层必须红；覆盖率低于阈值 → `verify` 红。

### S-08（P1）注释在承担规格、且与代码/宿主引用一起漂移

- **证据**：kernel 84%、dsh 75% 注释；`dsh/modules.ts:15-17` 的 H-2 描述与 `hostEntry.ts:440-499` 的异步挂载**相反**；H-2 引用的 `invariant.ts` 在 rc.2 不存在；`dsh-compatibility` 引用的 `core/session/src/invariant.ts` 也已不存在（并行审计 L-2 记录）；`docs/v3.7-redesign.md` 把已完成项（M2/M3/C1/T1-T4）写成"本轮施工"、把 R1 写成验收通过（实际未接线）；`dsh/plugin.ts:6,240,432` 仍写"7 个工具"，而 catalog + 实现现为 **9 工具**；`package.json` 3.6.0 而代码已有 3.7 Wave1 特性 `[源码+实测]`。
- **根因**：仓库把"为什么这样修"（极有价值）与"当前事实"混写在注释里；事实没有单一真源，靠人同步。
- **影响面**：新读者（包括模型）把注释当规格；升级时拿注释里的宿主行号找不到源；文档与状态面互相矛盾（历史上"模块段 0/存储段 1"就是这种文化的一次外溢）。
- **为什么增量修不好**：改注释不会阻止下一次漂移；需要把**会漂移的事实**移进代码常量/测试/生成文档。
- **结构修法**：① 宿主引用改为 `docs/host-contracts.md` 单一表，CI 校验引用路径存在（可脚本化）；② catalog/工具数/常驻预算/代数等数字由测试生成 `docs/status-facts.md`，禁止手写；③ 注释分两类护栏：`WHY:`（历史教训，保留）与 `CONTRACT:`（必须被测试引用），后者缺测试则 lint 警告。
- **验证**：`node scripts/check-doc-refs.mjs` 绿；README 数字与 `omb_status` 实测一致；H-2 描述与实现二选一并加测试。

### S-09（P1）版本与宿主 API 生命周期风险：单点上界、36 个 peer、77 条陈旧排除

- **证据**：`package.json:6` `engines.dsh = ">=0.2.0-rc.2 <=0.2.1-rc.2"`（**硬上界**，下一个 rc 会被判不满足）；36 个 peerDependencies（29 个 optional 在 `peerDependenciesMeta`），全部 `^0.2.0-rc.2`；`pnpm-workspace.yaml` 137 行里 77 条 `minimumReleaseAgeExclude` 仍钉旧 rc；docs 已记录"当前能跑是因为宿主对 prerelease 的口径，`compatibility.json` 不存在，口径一改就静默跳过"（`dsh-0.2.1-rc.2-compatibility.md:344`）`[实测+源码]`。
- **影响面**：DSH 每次发版都要同时改 36+29 处与上界；漏改的表现是"插件静默不加载"；宿主内部 API 只是结构约定，无版本协商。
- **为什么增量修不好**：peer 表是手工清单；上界是"防止未测试版本"的保守选择，但代价是每次升级都变成一次发布工程。
- **结构修法**：① 只保留**真正 import/必需**的 peer（当前零 import，14 个 optional 是"能力探测"，不需要 peer 声明），把能力探测改为运行时服务表；② `engines` 改 `>=0.2.0-rc.2 <0.3.0` + 启动时 `host.contractProbe()`（探测 5 个关键服务/事件形态）决定兼容性，而不是版本号；③ 删除 `minimumReleaseAgeExclude` 陈旧段。
- **验证**：宿主下一 rc 上启动探针输出兼容矩阵；peer 数量 ≤8；`pnpm install --lockfile-only` 无意外 diff。

### S-10（P1）检索在 10k 行开始变慢、在 100k 行撞内存墙；语义通道只覆盖每条记忆的前 512 token

- **证据（本机基准，按真实 schema/分词器复刻，内存 DB）** `[实测]`：FTS5 bigram OR 查询（20 条候选 + 长度惩罚 + 排序）10k 行 **10.6ms 中位 / 11.6ms P90**；50k 行 **54.9 / 57.1ms**；FTS payload 是正文的 **2.6×**（50k 行 22.1MB vs 正文 8.4MB）；向量全表扫描：10k×512 维 **6ms / 19.5MB**，20k **15ms / 39.1MB** → 100k 约 **75ms + 195MB/库**，且 `searchVector` 把全部候选 BLOB 读进 JS 再逐行余弦（`store.ts:1450-1492`）。召回要查 user + project **两个库**，另有 `searchOverturned` 再查一次 FTS。嵌入器 `WordPieceTokenizer(maxLength=512)`（`onnx.ts:137,154`）而单条记忆允许 **4,000 字符**（`remember.ts:49`）→ 一条满长记忆最多 **~87% 内容对向量通道不可见**；无 chunking、默认无 rerank（`retrieve.ts:160`）、RRF k=60 等权（`:38,415-421`）、`DEFAULT_MAX_CANDIDATES=20` 每库每通道（`:42`）、项目库 LRU 16（`store.ts:71`）。
- **影响面**：当前数据量（19 行）无感；到 10k 行每次 recall 10ms 级、100k 行 100ms 级并常驻 200MB+/库；长结论召回"只看开头"；跨项目库数增长时 fan-out 打开成本与文件句柄上升。
- **为什么增量修不好**：加索引/调 k 是补丁；"每条记忆=一个向量"与"每库全表扫描"是数据模型选择，必须在写入时切块、在存储层做 ANN/量化或至少分页过滤。
- **结构修法**：① 记忆正文按 ~512 token 切块，向量挂在 chunk 上（召回后聚合到父记录），写入时完成；② 向量检索改"先 SQL 过滤 + 分页/量化"，或明确声明上限（如 ≤5k 行/库）并在状态面显示；③ 融合加通道权重与默认 rerank（当前 `asserted` 权重 0.08 太小，证据等级几乎不影响排名）；④ 项目库 fan-out 加"仅当前会话项目 + 用户库"的硬约束（现在已是这样，需写成测试）。
- **验证**：10k 行夹具 recall P90 ≤50ms、100k ≤150ms；一条 4,000 字符记忆的尾部结论能被语义查询召回（当前必失败）；内存占用有上界。

### S-11（P1）写入准入是模型自证 + 第三方路径卫兵：58% 通过率、12/16 条 model 自述

- **证据**：历史 143 次写入 → 83 次准入（58%）；47 次"没有准入依据"、5 次"缺少来源引用"、2 次被 `dsh-path-guard` 拒、1 次隐私 read-only 拒（memory §2.1）；用户库 16 条中 12 条 `asserted_by=model`；`remember.ts` 的 sourceRef 只要求非空，`execution:` 由见证端口核验（R4 已接线），但"用户原话"核验依赖 `witnessLastUser` 的 4,000 字符快照，recall 输出不显示 `assertedBy`（S-04）`[实测+源码]`。
- **影响面**：模型可以（也会）把回顾/总结写成"结论"落库；真实数据里 edge 仅 1 条，记忆不是网络而是 16 个孤立断言；路径卫兵是外部插件，拒绝原因对用户不可见（只在统计里）。
- **为什么增量修不好**：准入是启发式，不是证据链；每个新 kind 都要重写判据。
- **结构修法**：① 写入改为**事件溯源**：先落 `observation`（原始证据 + 来源类别），由确定性规则投影出 `claim`；`omb_remember` 只写 observation，claim 由规则/用户确认产生；② `assertedBy` 三级在 UI/召回/状态面全链路显示；③ 外部插件拒绝进入"写入失败原因"枚举并显示。
- **验证**：构造"回顾体"写入 → 必须进 pending 而非 claim；召回每条带证据等级；path-guard 拒绝能在 `omb_status` 看到。

### S-12（P1）状态面是"散文渲染器"，不是事实投影；同一次调用内的自洽靠人工顺序契约

- **证据**：`dsh/status-tool.ts` 420 行里约 60% 是渲染与解释性文案；"组件自述必须先于健康快照渲染"是一条**顺序契约**（`:175-206`），因为模块在 render 里自报健康；`renderStatus` 每次重新计算/重扫服务表与磁盘（`diskGeneration()` 读文件）；历史 68 份 status 里 68 份存在自相矛盾（v3.7 §0）；真实 68 份里 21 份"未知会话"（v3.7 §0）`[源码+报告]`。
- **影响面**：状态面是**唯一模型可见诊断入口**，却是一段每次 1.5–3KB 的中文散文；机器无法读；读者要判断"哪个数字是真的"；顺序契约一旦被破坏就复发矛盾。
- **为什么增量修不好**：每加一个模块就加一段 `render()` 文案；矛盾来自"多个真源"，不是文案。
- **结构修法**：① 状态面改为**结构化事实表**（`{key, value, unit, source, at, confidence}`）+ 一个薄渲染器；模块只贡献事实，不贡献段落；② 同一次 status 只采样一次快照（`facts = snapshot()`），渲染与 metrics 共用；③ 文本输出保留，但由事实生成，长度上限固定。
- **验证**：同一次 status 的任何两个面不出现同 key 不同值（自动比对测试）；status 输出 ≤2KB；`metrics()` 与文本逐项一致。

### S-13（P1）推理"质量"没有效果证据，且成本结构反了

- **证据**：全语料 `omb_method` 34 次（0.07%）、`omb_verify` 56 次（0.11%）、`omb_focus` 98 次（0.20%）；循环提示出现在 **553 个快照 / 82 个会话**（占含 OMB 内容的快照 36%），而循环判定的精度从未被测量（旧配对是启发式，R3 才改成 callId）；`standard` 档注入 0 字符；验证段只在 3 个会话出现（循环依赖：未调 verify → 无未解决项 → 不注入验证段）；四个 reasoning 工具 schema 1,442 字符/请求（reasoning §0, §1.3-1.4）`[报告]`。
- **影响面**：每个请求为几乎不用的工具付 ~450 token；循环提示可能高频误报（36% 快照），把"重复"信号噪声化；用户看不到"用了 OMB 之后答案更好"的任何证据。
- **为什么增量修不好**：调提示词不改变"没有效果度量"；要证明有效性必须有对照实验与判据，当前没有任何 A/B 或标注。
- **结构修法（含 kill criteria）**：① 先做 20 回合 A/B（同任务、有无 OMB reasoning 的盲评 + token/时延），KPI 不达标就按 v3.7-D2 把 8 卡砍到 4、再用 D1 删 `omb_verify`；② 循环检测加**精确率**度量（人工标注 100 个提示样本，precision <70% 则默认关闭）；③ effort 必须真接线（S-01），否则"省算力"类文案全部删除。
- **验证**：A/B 报告落地；循环提示 precision/recall 有数字；`omb_status` 显示本会话 reasoning 的真实成本与命中率。

---

## 4. P2（中：维护成本 / 局部风险，不阻断重构）

- **S-14 死代码与"只被测试驱动"的 API**：`unreportedHealth`（`kernel/registry.ts:313`）全仓 0 引用；`Kernel.budget()` 只有内核实现 + 1 处测试（grep 3 次），无生产消费者；`contextPressure` 已退役但常量保留（`catalog.ts:262-266`）；`moduleGraph()`/`statusNames()`/`listenerCount()` 主要是诊断；`asMemoryStore`/`asRecordScanner` 是能力探测（合理，但形状重复三份）。**结构修法**：删除无消费者 API；budget 要么接线（每模块调用预算）要么删；能力探测收敛成 `capabilityOf(store)`。
- **S-15 重复实现**：隐私判定形状在 `store.ts:1866` 与 `artifact/index.ts` 各定义一份（注释承认"同形状"）；`kernel/abi/catalog.ts` 的 `SERVICES`、`moduleEntries.ts`、`cordis.patch.yml`、`packages/*/package.json` 四处登记同一组模块；`display.ts` 生成 locale（这条是好的单一真源）。**修法**：形状从 `kernel/abi` 出一份；模块清单由 build 生成 yml 候选并 diff。
- **S-16 开发数据与隐私残留**：仓库根 `.omb/memory/session.db` 有 3 条项目记忆（gitignore 了但会被打包/备份）；根目录 `.omb-heartbeat.jsonl` **19,840,489 字节 / 67,394 行**是历史默认开启的残留；`node_modules` 355MB/4,846 文件。**修法**：默认数据根不落在仓库（或启动时检测 cwd 在仓库内并警告）；心跳残留清理。
- **S-17 启动成本**：插件加载需 import 86 个 lib-gen 文件（1.04MB）+ 7 个模块；ONNX 权重可选 23.8MB/解包 296MB；`models/` 不入库。未见明显启动瓶颈（未测），风险在"每个组件一个顶层包 + 78 行 patch"带来的解析/实例化次数 `[推测]`。
- **S-18 常驻预算只剩 16 字符**：`RESIDENT_HINT_MAX=120`（`kernel/abi/host.ts:122`），reasoning 104（README:23-29）；任何新模块加常驻句都会截断别人（`dsh/session.ts:203-251` 的截断账目是对的，但预算是硬顶）。**修法**：预算改为按模块配额 + 全局上限，超配额在装配期失败（而不是运行期静默截断）。

---

## 5. 追加维度（Lead 指定，合并进本报告的 S1–S4）

### S1 冷启动竞态（对应 S-02、S-05、S-12）

- **时序事实**：内核行 `apply` 同步发布内核 promise → 模块行 `inject:['omb:kernel']` 等待 → 宿主微任务挂载模块 → 模块 `mount` 里 `apply` 注册服务/工具 → `replayModuleRegistrations` 重放工具桥 → `turn/start` 再重放一次；项目库由 `turn/start` 预热；压力投影在首个 `provider usage` 后才非 null；`omb_status` 在模块挂载前会显示"无贡献者/0 库"`[源码]`。
- **真实故障**：5/143 写入"项目库尚未就绪"；首个 `omb_status` 的"已打开项目库 0 个"必然为 0；首轮工具表可能不含 9 个 OMB 工具；首轮常驻提示可能为 0（v3.7 T 系列修的就是这个）`[报告]`。
- **DSH session-search 冷启动**：`session_search` 4 个并行调用全部 30s 超时（`searchTimeoutMs` 30,000），全库 391 会话/283MB，历史上仅 6 次调用；结论是"不可作为每回合外部上下文，只能显式人工调用 + durable path/openAt startup"（`docs/research/2026-10-18-context.md:205-213`）`[实测]`。
- **修复方向**：装配阶段机（S-02）+ 首轮就绪门 + `omb_status` 顶部显示 `phase`；session-search 只做"用户显式触发 + 后台预热"。
- **验证**：重启后首轮 10 连测（S-02）。

### S2 状态生命周期（对应 S-06）

- 每会话表：`SessionRuntimeTable`（无界）、`FocusTable`（无界）、`ActiveSessionTable`（无界）、witness（LRU 128/执行台账 100/文本 4,000）、reasoning `lastRender`（模块级按会话，LRU 见 v3.7-T4）、privacy `SessionRuntime` slot、memory 项目库 LRU 16、vector 待编码队列 256。
- 缺口：无 `session/end` 清理；热重载旧实例订阅只能靠 disposer（且 async 不被等，S-06）；子代理继承只覆盖 privacy，runtime slot 不继承；压缩代际只影响循环窗口（`dsh/session.ts:942-963`），不影响记忆/隐私状态；状态面快照与实时读数的顺序契约靠人工（S-12）。
- **修复方向**：`SessionLifecycle` 统一注册 + close 清理 + 各表 size/淘汰计数进状态面 + 子代理 slot 继承策略显式化。
- **验证**：1,000 会话压测 size 有界；热开关 20 次后订阅数归零；关库重开不抛。

### S3 检索扩展性 / 语义质量（对应 S-10、S-11）

- 当前 19 行 → 10k/100k 的数字见 S-10 基准；按 2 个库 ×（FTS + 向量 + overturned）估算：10k 行单次召回 ~25ms，100k ~250ms+（向量 2×75ms + FTS 2×110ms），内存 2×195MB（向量）+ 索引 ~44MB/库 `[实测+外推]`。
- 语义质量：哈希词袋降级路径的余弦实测（同义改写 0.10、反义 0.33，README:217-230）说明"降级=不可用"；bge-small-zh-512 对中文短文本可用，但 512 token 截断 + 无 chunking + minScore 默认 0（下限由调用方给）意味着长条目与近似重复条目都会污染排名。
- 跨项目授权：召回只查当前会话项目 + 用户库（正确），但 `forProject` 的无归属读是缺口（S-04）。
- 重建：`scanRebuild` 按 id 回填，**每个回合边界最多 32 条**（`DEFAULT_MAX_BACKFILL`，`vector.ts:92`；清单分页上限同量级），10 万条回填 + ONNX 编码按 ~15ms/条估 ≈ 25 分钟 `[推测]`；没有进度/取消语义，只有计数。
- **修复方向**：chunk 化、量化/ANN 或硬上限、默认 rerank、重建进度与取消、索引代际。
- **Kill criteria**：若真实 30 天记忆 <2,000 条且 recall 使用率 <10%，不投入 ANN，改为"库上限 + 冷归档"。

### S4 推理有效性（对应 S-13、S-01）

- 已有证据：method 34 次 / verify 56 次 / focus 98 次（全语料 49,440 工具调用）；standard 注入 0 字符；循环提示 553 快照 / 82 会话（36%）；验证段 36 快照 / 3 会话；effort 未接线（S-01）；工具 schema 4,381 字符/请求（reasoning 部分 1,442）`[报告+实测]`。
- 结论：**当前没有任何"改善结果"的测量**，只有"注入了什么"的测量。成本是确定的，收益未证。
- **修复方向（最小可行）**：① 先接线 effort（S-01）并做 20 回合 A/B；② 循环提示加精度标注与开关；③ 若 A/B 不显著，删 `omb_verify` 与方法卡正文注入（保留 `omb_method` 拉取），把预算换成 memory 触发句（≤24 字符）。
- **Kill criteria**：A/B 胜率 <55% 或 outputTokens 无差异 → 停用 reasoning 常驻面；循环提示 precision <70% → 默认关。

---

## 6. 什么是健全的、必须保留（重构时别一并砍掉）

1. **分层边界**：`kernel/` / `modules/` / `dsh/` 的依赖方向由 ESLint 强制（`eslint.config.mjs:59-61`），`modules/` 与 `kernel/` 零宿主 import；这使模块零宿主 mock 可测，是 26k 行代码能在 6.6s 内跑完 1,414 个测试的基础。
2. **端口化存储**：`MemoryStore` ABI 不依赖 `node:sqlite`，连接由 `dsh/` 注入；`searchVector` 的归属过滤下推到 SQL；迁移有版本、未来版本拒绝、失败回滚测试。
3. **单一强制点的隐私设计**（库访问边界 + `gateStore` 对未知方法 fail-closed + 生命周期豁免）——方向完全正确，只需堵住 S-04 的无归属读。
4. **"读数必须真"的文化**：`ContextPressure` 的 `fillRatio=null` 四种成因、`detail` 必填、状态面自报 vs 实时顺序契约、`residentHintReport` 的逐项账目——这些是同类项目少见的诚实度，应保留并升级为结构化事实。
5. **构建换代的 ESM 缓存绕过**：URL 带代数 + 双代数并排显示 + 原子提交，思路正确；缺的是部署清单与门禁（S-05）。
6. **确定性**：注册表按 ASCII 排序、拓扑序确定性、RRF/排序 tie-break、`fingerprint`，以及"同一输入必须逐字节稳定"的常驻提示约束。这些应保留为测试不变量。
7. **不接管 Agent Loop、不 monkey-patch 宿主、工具/提示只经明示扩展缝**：这条边界是 OMB 能装进任意 profile 的前提。
8. **测试中的形状契约与真实清单**：`assembly.smoke`、`module-graph-source`、`abi.contract`、`prompt-injection-live`、`status-face-consistency` 这类"装配级"测试比例高，比单元测试更有价值。

---

## 7. 结构修复路线（建议顺序与"不做什么"）

| 顺序 | 动作 | 依赖 | 验收 |
| --- | --- | --- | --- |
| 1 | 堵 S-04 无归属读 + recall 证据等级/untrusted 封装 | 无 | sealed 无读、负向注入测试 |
| 2 | HostAction 单一接线表 + effort 真接线（S-01） | 1 | request/header A/B |
| 3 | 装配阶段机 + 首轮就绪门（S-02） | 2 | 重启首轮 10 连测 0 失败 |
| 4 | ABI 类型化 + 事件适配器 + 反向 catalog 断言（S-03/S-07） | 2 | 错误事件名负向测试红 |
| 5 | 状态面结构化事实 + 会话生命周期（S-12/S-06） | 3 | 同屏无矛盾、size 有界 |
| 6 | 检索 chunk + 上限/rerank/重建进度（S-10） | 5 | 10k/100k 基准达线 |
| 7 | 幂等 deploy + 构建进门禁 + 部署清单（S-05） | 6 | 两次 deploy 字节一致 |
| 8 | 版本/peer/engines 收敛（S-09） | 7 | 下一 rc 启动探针 |

**不做什么（本轮证据反对）**：不引 LLM 到热路径（写入抽取/查询改写/答案复审）；不做 GraphRAG/三级记忆/DB 加密；不新增第 10 个工具；不把 283MB 会话历史搬进 OMB；不为"看起来更完整"保留零消费者的 context/pressure 服务面。

## 8. 可执行验证清单（收尾复跑用）

```bash
node scripts/build.mjs && node scripts/check-resolution.mjs
npx tsc --noEmit && npx eslint . && npx vitest run   # 当前：1,414 pass / 1 skip / 6.59s
```

- 真机：重启宿主 → 首回合调 `omb_status`（看阶段/三份代数/工具数 9）→ 调 `omb_remember`（project kind，10 连测）→ 看 `request/header` 的 `reasoningEffort`（quick/deep A/B）→ sealed 会话下读 profile（应为空/拒绝）。
- 基准：10k 行夹具的 recall P90、100k 行内存与延迟（S-10 脚本可复用：FTS5 bigram + 512 维余弦）。
- 负向：删掉 `dsh/` 的 HostAction 注册后集成测试必须红；错误事件名必须红；catalog 反向断言必须红。

---

### 附：本次量化速查

| 指标 | 值 | 来源 |
| --- | --- | --- |
| 源码行数（kernel/dsh/modules/tests） | 3,837 / 3,421 / 18,940 / 24,029 | 本机 `[实测]` |
| 注释占比（kernel/dsh/modules） | 84% / 75% / 48% | 本机 `[实测]` |
| 测试文件 / 用例 / 时长 | 99 / 1,414 passed + 1 skipped / 6.59s | 本机 `[实测]` |
| OMB 工具数 / 描述+schema | 9 / ≈4,381 字符 | g84 产物 `[实测]` |
| 常驻提示 | 104 / 120 字符（余 16） | README + ABI `[源码]` |
| 记忆库行数（用户/项目） | 16 / 3；edge 1 / 0 | 真实 DB `[实测]` |
| 写入准入 | 143 → 83（58%）；5 次项目库未就绪 | memory 报告 `[报告]` |
| 构建代数 | g84（已 84 次换代） | build-generation.json `[实测]` |
| FTS 查询 10k / 50k 行 | 10.6ms / 54.9ms（P90 11.6/57.1） | 本机基准 `[实测]` |
| 向量扫描 10k / 20k 行 | 6ms/19.5MB；15ms/39.1MB | 本机基准 `[实测]` |
| 心跳历史文件 | 19,840,489 字节 / 67,394 行 | 仓库根 `[实测]` |
| peer / peerMeta / 陈旧排除项 | 36 / 29 / 77 | package.json + workspace `[实测]` |
| session-search 冷启动 | 4/4 30s 超时 | context 报告 `[实测]` |
| C: profile 副本 | 3.6.0 / g84，真实目录（非链接） | 本机 profile `[实测]` |
