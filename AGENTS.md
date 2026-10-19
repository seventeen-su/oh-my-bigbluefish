# AGENTS.md — 给在此仓库工作的 agent

本仓库是 **OMB v4.8.0**：DSH（DeepSeek Harness）的通用认知增强插件。先读这一段，再读代码。

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

- **v4.8.0（当前） = 候选确认与跨路径写入去重**：
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
  **抑制 proactive 提示**（避免模型重复 `omb_remember`）；健康面 `controllerHealthNote()`
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
- **版本纪律（v4.4）**：新增功能 → x2+1，单个修复 → x3+1；改 `version-manifest.json` 的 `version` 字段 → `node scripts/version.mjs --write`；
  门禁用 `node scripts/version.mjs`（漂移退出码 1）。不要把版本号手写回 4.x。
- v4.4 仍未做（不要在文档里假装已做）：完整类型图/类型解析与包导出映射、真正三方自动合并
  （当前只出冲突材料）、OOM 根因最终定位（依赖宿主 heap snapshot，脚本已备）、`dsh-path-guard` 的
  `selfProtection`（用户设置）。
