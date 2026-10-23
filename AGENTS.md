# AGENTS.md — 给在此仓库工作的 agent

本仓库是 **OMB v4.15.2**：DSH（DeepSeek Harness）的通用认知增强插件。先读这一段，再读代码。

## 1. 分层（不要跨层）

| 层 | 目录 | 允许做什么 |
| --- | --- | --- |
| 内核/ABI | `kernel/` | 服务总线、事件总线、健康面、catalog、display；**零业务逻辑** |
| 宿主适配 | `dsh/` | **唯一**接触宿主 Context/服务/文件系统/子进程的层；v4.1 新增 `dsh/project-root.ts`（项目身份 = git root，供记忆库/画像/`omb_project` 共用） |
| 模块 | `modules/` | 纯逻辑 + `kernel` 端口；**禁止 import `@deepseek-ai/*`**（ESLint 强制） |
| 包壳 | `packages/` | 薄 re-export + `default` 宿主插件入口 |
| 预设/补丁 | `cordis.patch.yml` | 行、组、`!!js` 表达式；改它先读 `cordis-composition-reference` |
| 证据/计划 | `docs/` | 设计、兼容性、研究报告；**事实优先于叙述** |

单一真源：模块清单与工具面在 `kernel/abi/catalog.ts`；插件页名称/说明在 `kernel/display.ts`；
行与顺序在 `cordis.patch.yml`；构建代数在 `build-generation.json` / `lib-gen/g<N>`。

## 2. 不变量（违反会静默失效，测试不一定红）

1. **模块不接触宿主**：需要宿主事实时，由 `dsh/` 通过内核服务（`SERVICES.*`）或事件提供；形状用结构化最小接口。
2. **接线必须有消费者**：声明/服务/事件都要能指出生产调用点；"已注册"不等于"已生效"。
3. **状态面只说事实**：读数带来源与时间；没有测量就写"未测量/为什么"，不要显示成 0 或绿。
4. **记忆逐字保真**：不做有损摘要；冲突只呈现；supersede 非破坏；隐私是用户命令，模型不能放宽。
5. **热路径零 LLM**：写入准入、检索、捕获、状态都不得调用模型；只有用户显式要求的独立复核可例外。
6. **token/注意力预算**：工具 schema 与常驻提示都是每请求成本；新能力优先做参数/按需文件，不新增常驻散文。
7. **缓存前缀**：`systemPrompt.context()` 在 DSH 是**尾部 user/message 快照**，不是系统提示段；真正要逐字节稳定的是跨会话项目前缀（`AGENTS.md`/skills 目录/常驻句）。
8. **构建产物最后生成一次**：`lib-gen` 换代必须全量一致；混代会产生两个内核实例。
9. **项目身份 = git root**：记忆库、项目画像、`omb_project` 一律先 `SERVICES.projectRoot` 再按根取库；
   子目录会话**不得**另起项目库；非 git 目录退化为 cwd。解析在 `dsh/`（模块不跑子进程），失败绝不抛。
10. **守卫 = 资源级内容哈希 + 显式未知**：写守卫按**该文件内容哈希**（读取时固化 `sha256` 前 16，≤2MB）
    判定，不用全局 epoch；`edit` 与 `write` 同一判定表；缺印记/超限/读失败一律放行但必须计
    `blindWrites`/`unverifiable`，**不得静默**；守卫自身异常 fail-open（守卫不是权限边界），但必须留声。
    覆盖**已存在**文件且无可核验读取印记时默认 `blindWritePolicy='deny'`（v4.5.3）；
    连续 deny 到阈值后**不再自动放行**，只有 deny 之后的重新读取才解除并计 `gaveUps`。
    校验（`tools/pre-execute`）与宿主真正写入之间仍有**非原子窗口**：守卫能缩小但不能消除覆盖竞态。
11. **写可见性三件套（v4.2）**：shell 写路径（正则提取，提取不到记 `shellUnknown`，不猜）、
    其他会话/子代理写（`recentWrites` + `otherSessionWrites`）、指令文件指纹（`AGENTS.md`/`CLAUDE.md`
    进 epoch）。三者都只用于"读后是否已被改/规则是否已变"的事实提示与无法核验时的保守拒绝，
    **不得**据此声称知道完整写集；shell 的未知写必须显式计数。

## 3. 命令

```powershell
npx tsc --noEmit          # 类型门禁
npx eslint .              # 分层/风格门禁
npx vitest run            # 全量测试
node scripts/build.mjs    # 构建一次，代数 +1；不要在门禁里反复跑
node scripts/check-resolution.mjs
```

部署：宿主加载的是 `C:\Users\SuSeventeen\.dsh\profiles\web\node_modules\@omb\*` 的真实副本，
不是本仓库。同步流程：`git pull` → `node scripts/build.mjs` → 同步 `lib-gen`/组件目录 → relink → 重启 `dsh web` → `omb_status` 核对代数。

## 4. 高频坑（都踩过）

- 宿主会话事件边界是 `step/start`/`step/end`，不是 `turn/start`；`tool/call.arguments` 是未解析 JSON 字符串。
- 投影 `stateOf()` 返回 **host state**：`contextPressure` 没有 `projectedTokens`（自己算 `pressureTokens+surfaceTokens−sampledSurfaceTokens`）；`tokenUsage` 是 `{totals,last}`；`contextBreakdown` 是嵌套 `breakdown.*`。
- `systemPrompt.context()` 是尾部快照；`systemPrompt.section` 才是系统提示段。
- 预设内组可能 `isolate`（compaction/toolResultPruner/sessionQuery）：根 realm 拿不到；`ctx.get` 与 `ctx.<name>` 语义不同（后者需 inject）。
- 会话搜索 `fts5(unicode61)` 中文子串不可用；OMB 的 bigram FTS 是中文唯一通道。
- 构建代数（g<N>）是为绕 ESM 缓存；状态面必须同时核对加载/磁盘/部署清单。
- Windows 路径/长路径/符号链接：复制用 `fs.cpSync(..., {dereference:false, verbatimSymlinks:true})`。

## 5. 当前方向（2026-10）

- **v4.15.2（当前） = 侧边栏运行状态与项目画像页（x3，4.15.0 收尾）**：
  `ui.runtime()` 读已有台账（版本/库状态/隐私闸门/控制器/捕获/活动日志），
  `ui.profile()` 经 `SERVICES.projectProfile.read(activeSession.cwd())`；
  路由 `GET /runtime`、`GET /profile`；页面新增"运行状态""项目画像"两个只读页签。
  契约：`docs/v4.15.2-sidebar-runtime-profile.md`。
- **v4.15.1** = 侧边栏手动确认动作（x3，4.15.0 收尾）：`createConfirmAction`
  复用 `/omb-confirm` 的 promote/undo；`POST /omb/api/confirm`（JSON、同源、200/409/415/400）
  供页面按钮确认候选/撤销确认；**没有模型工具入口**；审计 sessionId=null（全局面板）。
  契约：`docs/v4.15.1-sidebar-confirm-actions.md`。
- **v4.15.0** = 管理侧边栏（只读 UI，x2）：`modules/memory/ui.ts` 提供
  `omb:ui` 只读服务（概览/列表/候选/详情+审计+相关条目）；`dsh/ui-route.ts` 在宿主
  `webServer` 注册 `/omb/api`（仅 GET、同源、no-store）；`packages/memory/client.js`
  是手写浏览器 bundle，经 `dsh.client` 注册侧边栏图标与 `main` 面板。
  契约：`docs/v4.15.0-sidebar-ui.md`。
- **v4.14.0** = 主动记忆提示扩展与跟进（x2）：新增 `recall-first`
  （引用过去结论先查）与 `project-fact`（路径/命令/端口/版本/URL）两类 cue；
  execute 模式不再整体抑制提示：控制器精确提示优先，没写时才给 cue；
  未写入的 cue 在**下一条用户消息**给一次跟进（dry-run/off/任务约束不跟进）；
  活动日志加 `proactive`，健康面/metrics 报命中与跟进数。
  契约：`docs/v4.14.0-proactive-initiative.md`。
- **v4.13.0** = 事件控制器显式状态机（x2）：`ControllerSessionState` 加
  `phase`（idle/candidate-pending/tracking-tasks/mixed）与 `transition`（事件→阶段→动作）；
  动作带确定性 id，persist 每会话幂等（最近 64 个候选，计 `duplicateActions`）；
  `ControllerStats.failures` 按 8 类计失败，健康面只列发生的类别，metrics 按类输出；
  控制器动作/失败进活动日志（`controller`/`error`）。契约：`docs/v4.13.0-controller-state-machine.md`。
- **v4.12.0** = 跨工作区状态机与文件索引（x2）：`situation().workspace`
  惰性记录会话在 git root 之间的切换（`switches`/`previousRoot`/`since`，子目录变化不算），
  `omb_project` L0 显示切换次数；画像 `ProjectProfileStructure.files` 按符号+导入数
  排序前 12 个文件，L1 显示前 4 个（规模索引，不是完整 repo-map）。
  契约：`docs/v4.12.0-workspace-state-and-file-index.md`。
- **v4.11.0** = 活动日志与崩溃窗口验证（x2）：`modules/memory/activity.ts`
  有界环形（200 条）记录写入/去重/升级/弃权/召回/确认/错误，健康面只列发生过的事件、
  不含正文、不落盘；`tests/dsh/project-evidence-crash.test.ts` 用真实 SIGKILL
  验证证据文件原子写（JSON 可解析、可读回、无损坏现场）。
  契约：`docs/v4.11.0-activity-log-and-crash-tests.md`。
- **v4.10.1** = 取消离线整合、写入时确定性去重（x3）：删除
  `modules/memory/consolidate.ts` 与 `turn/end` 订阅、`consolidationEveryTurns` 配置、
  整合台账/健康读数（0.7 近似合并会自动标失效，有损且不可解释）。去重只发生在写入路径：
  `contentHash` 精确或归一化 bigram ≥0.9（数字不同不合并），用户断言命中候选就升级；
  **不自动 `supersedes`**，是否推翻由调用方显式给。契约：`docs/v4.10.1-write-time-dedupe.md`。
- **v4.10.0** = 检索过滤与模糊回退（x2）：schema v6 加 `memory.tags`（JSON 数组，
  默认 `[]`，最多 8 个、每个 ≤24 字符）；`omb_recall` 新增 `status`（active/stale/superseded/all）、
  `tags`（AND）、`fuzzy`（默认开）；词法 0 命中时用 `searchFuzzy` 的 `LIKE` 子串回退，
  通道标记 `fuzzy`。过滤全部在 SQL 下推（`json_each`），不是 JS 事后裁剪。
  契约：`docs/v4.10.0-retrieval-filters.md`。
- **v4.9.7** = 用户断言的模糊去重与压缩后追忆修复（x3）：`findSimilarContent`
  在内容哈希之外用归一化 bigram（≥0.9）判近似同内容，**数字不同不合并**；用户断言
  命中既有候选时就地把 `assertedBy` 升为 `user`（正文/id/时间不改）；压缩后当前上下文
  没有原话时，若库里已有同内容已确认记录，记 `previously-verified` 继续写入，否则仍拒绝。
  契约：`docs/v4.9.7-fuzzy-dedupe.md`。
- **v4.9.6** = 补齐深度与堆快照命令简介（x3）：`/omb-depth` → 设置本会话的思考深度；
  `/omb-heap` → 查看进程内存，可抓堆快照排查。六个用户命令简介统一为一行、无括号。
  契约：`docs/v4.9.6-depth-heap-descriptions.md`。
- **v4.9.5** = 命令简介精简与过程卡隐藏（x3）：四个用户命令的简介改短、
  去括号、说人话（只改 `description`，不动命令名与用法）；8 张过程卡 frontmatter 加
  `user-invocable: false`（模型技能，不再出现在用户斜杠菜单），并改名为
  `omb-depth/goal/options/testable/cite/failure/honesty/conflict`。
  契约：`docs/v4.9.5-naming-cleanup.md`。
- **v4.9.4** = 项目画像包导出映射 + 剩余项收口（x3）：`readPackageEntryMap`
  读 workspace `packages/*/package.json` 的 `main`/`types`/`exports`，裸包名 →
  仓库内入口文件（相对路径/别名之后第三级解析），文件边/目录边/近似调用边都适用。
  剩余项收口见 `docs/v4-remaining-closure.md`：类型图/三方合并为设计不变量，
  OOM 根因为宿主快照外部依赖，`dsh-path-guard selfProtection` 是用户设置。
- **v4.9.3** = 项目证据到文件映射（x3）：`extractEvidencePaths` 从命令里
  抽带扩展名的文件路径（URL/目录/符号不记，单条 ≤5），证据落盘升 v3（v2 旧文件照读）；
  `omb_project` L1 在证据后显示"→ 文件"（最多 2 个，更多写"等 N 个"）。
  契约：`docs/v4.9.3-evidence-file-mapping.md`。
- **v4.9.2** = 检索命中排名读数（x3）：`usageTracker` 按召回顺序记曝光排名；
  `used_tool` 命中时统计使用命中的 @1/@3/@5 分布（同一 id 取最好排名，分母是使用命中数）；
  健康面 `retrieval.ranked/precisionAt1/3/5` + `retrievalRankNote()`（无读数不写）。
  契约：`docs/v4.9.2-retrieval-precision.md`。
- **v4.9.1** = 冲突提示的语义通道（4.9.0 功能收尾，x3）：`link.ts` 的
  `findSemanticRelated` 在**有嵌入器**时用向量通道补充没有共享实体键的活跃条目
  （归属由库校验，跨空间不召回）；装配层先词法后语义、按 id 去重、最多 3 条，
  无嵌入器/无向量/异常时静默退回词法；回执标注判据通道（词法/语义）。
  契约：`docs/v4.9.0-conflict-hints.md` §3.1。
- **v4.9.0** = 写入冲突提示（独立功能）：`link.ts` 的 `findRelatedRecords`
  只读地找共享实体键（≥2）的活跃既有条目（同作用域、内容不同、最多 3 条），
  通过 `MemoryWriteDeps.findRelated` 端口进入 `omb_remember` 成功回执与
  `/omb-confirm` 确认回执，作为**可能冲突提示**；**不自动 supersedes、不改库、不建边**。
- **v4.8.1** = 候选确认的撤销与审计（4.8.0 功能的收尾，x3 修复位）：
  存储 schema **v5** 增加只增审计表 `memory_confirm`（confirm/undo），v4→v5 纯加法，
  `SCHEMA_VERSION=5`；`asConfirmStore` 探测不到时撤销 fail-closed。
  `/omb-confirm undo <id>...`（≤10 条，逐条报告）只在"审计最后一次动作是 confirm +
  条目仍活跃"时执行；`/omb-confirm log <id>` 查审计；`list [offset]` 分页并显示
  候选年龄/stale 建议。健康面 `confirm.undone/logged`，文案只在按过命令后出现。
  契约：`docs/v4.8.1-confirm-undo-and-audit.md`。
- **v4.8.0** = 候选确认与跨路径写入去重：
  `/omb-confirm [id]` 是**用户**确认候选的斜杠命令（不新增模型工具）：不带参数列出
  候选（每库最近 50 条里筛、最多显示 5 条），带 id 把 `assertedBy` 从 `model` 改为
  `user`（正文/id/来源/时间一字不改），写回后查回验证；sealed 不读、read-only 不写。
  只接受 `semantic`/`procedural` + `model` + 未失效 + 未被取代的候选。
  去重判据 `remember.ts` 的 `findSameContent` 由捕获路径与 `omb_remember` 共用：
  同内容命中时**不写、不触发向量事件**，回执给出已存在条目的 id/阶段（候选附
  `/omb-confirm` 用法）。健康面 `confirmHealthNote()` 只在按过命令后报数。
  契约：`docs/v4.8.0-lifecycle-confirm-and-dedupe.md`。
- **v4.7.0** = 事件驱动记忆控制器（决策 + 执行）：`modules/memory/controller.ts`
  纯 reducer（user-message/tool-result/turn-end/memory-written → persist/lookup/
  request-model/track-task/expire-task），TTL 在事件到达时清算、回合结束清空剩余任务。
  `memoryController` 三档（`execute` 缺省 / `dry-run` / `off`）：execute 下
  `capture.ts` 执行动作——persist 走既有隐私/去重/冷启动写入并**查回验证**
  （id + contentHash），显式记住写 `assertedBy=user`（已确认、不受每会话上限），
  非显式推断写 `assertedBy=model`（候选）；lookup 走词法检索找旧条目并注入
  `supersedes` 用法（不自动 supersedes）；request-model 只注入一行。临时/任务约束
  永不 persist，只在会话内跟踪、易变槽可见。疑问/命令/代码/偏好标记判据抽到
  `modules/memory/message-filter.ts`，捕获与控制器共用一份。execute 且自动捕获开启时
  **抑制 proactive 提示**（避免模型重复 `omb_remember`；v4.14.0 起改为：
  控制器精确提示优先，未写入时 cue 仍生效，未写入的 cue 下一轮跟进）；健康面 `controllerHealthNote()`
  区分 dry-run 与执行，决策计数与执行计数分开。契约：`docs/v4.7.0-memory-controller.md`。
- **v4.6.1** = 审查修复：项目证据改为解析 shell 结果里的 `[exit code: N]`
  （工具 `isError` 不再当命令成功；无标记=unknown），旧 v1 落盘 `ok` 降为 unknown；
  记忆意图分流（临时/任务约束不自动写长期；`modules/memory/intent.ts`）；
  `verifiedFix` 改名 `recoveredFromFailure`（仅"失败后再次成功"，连续成功不重复标记）；
  证据落盘加目录锁/原子替换/磁盘合并/损坏现场保留。契约：`docs/v4.6.1-review-fixes.md`。
- **v4.6.0** = 主动记忆 + 项目运行证据：
  常驻提示同时点"写"（`长期偏好/决定主动 omb_remember；跨会话结论先 omb_recall`）；
  `modules/memory/proactive.ts` 在用户消息命中"显式要求记住/纠正旧结论/项目决定/长期偏好"
  时给一行易变提示（`prompt:omb-memory` 的 context 槽，回合结束清空）；
  工具描述把触发条件前置。`dsh/project-evidence.ts` 记录由 `dsh/` 亲眼看到的
  构建/测试/类型/Lint/验收结果，`SERVICES.projectEvidence` → `omb_project` L1 与结构并排；
  未接线/暂无读数/有读数三种说法严格分开。`modules/memory/lifecycle.ts` 按
  `kind + assertedBy` 推导阶段（事件/候选/已确认/经验），召回与 L4 展示阶段；
  `useCount`/召回次数不参与推导，**没有自动晋升路径**。契约：`docs/v4.6.0-proactive-memory-and-evidence.md`。
- **v4.5.3** = **七点审查修复**：
  依赖未挂载的模块（画像等）不得在 `omb_status` 显示"运行中"（内核账本现算覆盖 + 画像
  `availability()` 先探服务）；`scripts/heap-snapshot.ps1` 拆 `repro`/`early` 两种模式，
  保留并合并 `NODE_OPTIONS`、核对快照 PID 职责、磁盘检查/保留/敏感提示；进程内快照统一走
  `dsh/heap-snapshot.ts`；capture 无 `callId` 只挂 pending、不写完成；守卫默认 `deny`、
  逃生前须重读、注释漂移清理；`decideLifecycle` 禁止"执行确认直接晋升 procedural"；
  记忆健康面报有效命中（exposed/used/effectiveRate）。契约：`docs/v4.5.3-review-fixes.md`。
- **v4.4** = **版本号 x1.x2.x3 + 剩余项收尾**：
  版本号改为 `x1.x2.x3`（大版本 / 功能更新 / 修复；`version-manifest.json` + `scripts/version.mjs`，
  禁止手写 4.x）；导入图支持 tsconfig `paths` 别名、文件级边与近似调用边；
  shell 未知写用命令前后 `git status` 差分推断；守卫拒绝时写 base/current 冲突材料包；
  OOM 取证脚本 `scripts/heap-snapshot.ps1` 与证据结论。
  契约：`docs/v4.4-versioning-alias-and-oom.md`。
- v4.3 = **有界化 + 导入图**：`turnBySession`/`projectFailures`/artifact 缓存/reasoning 会话表有界；
  `omb_status` 新增 `## 进程`；画像 `structure.imports`（跨顶层目录相对导入边）。
  契约：`docs/v4.3-bounded-and-imports.md`。
- v4.2 = **写可见性收尾**：指令文件指纹（`AGENTS.md`/`CLAUDE.md` →"指令已变"）、shell 写路径提取
  （提取不到记未知）、跨会话/子代理写归因（`recentWrites` + `otherSessionWrites`）、符号级 repo-map、
  盲写策略可配置（v4.2 默认 `allow`；v4.5.3 起默认 `deny`，逃生前须重读，见上）。
- v4.1 = **时空坐标**：项目身份 = git root；写守卫 = 资源级内容哈希（edit+write）；
  自主捕获 = `tool/call` → `tool/result` 生命周期；`omb_project` = L0–L5 分层时空快照（≤2,400 字符，隐私先于读取）。
- v4.0 = 记忆自主化 + 项目画像 + 事件图 + 推理技能化 + 上下文归零。
- 依据：`docs/v4-decision.md`（含 §9 v4.1 / §10 v4.2 / §11 v4.3 / §12 v4.4 决策）与 `docs/research/2026-10-18-*.md`（14 份）。
- 不要恢复：`omb_verify`、逐回合控制散文、未接线服务、写入时 LLM 抽取、GraphRAG、替换宿主压缩。
- **版本纪律（v4.4 + 用户补充）**：新增功能 → x2+1，单个修复 → x3+1；
  **新界面（含侧边栏 UI）也只升 x2，只有重构才升 x1 大版本**；
  改 `version-manifest.json` 的 `version` 字段 → `node scripts/version.mjs --write`；
  门禁用 `node scripts/version.mjs`（漂移退出码 1）。不要把版本号手写回 4.x。
- v4.4 遗留项已收口：完整类型图/类型解析（设计边界）、三方自动合并（设计不变量）、
  OOM 根因（宿主快照外部依赖）、`dsh-path-guard` 的 `selfProtection`（用户设置）——
  逐条证据与性质见 `docs/v4-remaining-closure.md`；包导出映射已在 v4.9.4 实现。
