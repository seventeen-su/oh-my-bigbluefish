# OMB v2 架构文档（oh-my-bigbluefish）

> 依据仓库实际施工代码编写（HEAD fd9f999，package.json version 1.7.0）。
> 层 DAG：`substrate(0) → supervisor(1) → kernel/runtime/memory(2) → components ABI`。
> 本文只描述**实际已实现的内容**；设计稿遗留的未接线部分在 §14 列明。

---

## 1. 系统定位

OMB v2（大肥鱼模式 v2）是叠加在普通 DSH 会话之上的**认知增强层**。

### 1.1 认知层语义

- **无双 Loop**（`runtime/plugin.ts` 文件头注释）：不替换、不包装、不重启 DSH Agent Loop；
  只做三件事——**观察**（DSH 事件 → 认知事件库）、**注入**（systemPrompt.context 认知投影）、
  **命令注册**（/mode /bench /evolve + kern_* 工具）。
- **模型调用归 DSH**：llm 服务只读装配 ModelAdapter 供 /bench 用，不拦截对话模型路径。

### 1.2 挂载方式

- `agent.cordis.yml` 的 `omb-v2` 行：`name: './lib/runtime/plugin.js?v=6'`；
  `lib/` 为编译产物（`pnpm build` = `tsc -p tsconfig.build.json`）。
- `?v=N` 尾缀破除宿主 Node ESM 模块缓存：修改 lib/ 下代码重新 build 后须递增或重启宿主。
- 预设 id = 目录名 `oh-my-bigbluefish`（须匹配 `^[a-z0-9][a-z0-9-]*$`）。

### 1.3 组合构成

- `agent.cordis.yml` = standard 预设模型面行（工具/技能/目标/计划/压缩/委派/ask-user/todo/web）
  + `omb-v2` 认知行。
- 组合必须保留完整模型工具行——只有 omb-v2 一行的预设是**无工具会话**
  （模型无工具可用会幻觉出不存在的工具名）。

### 1.4 关键 config

| 配置 | 缺省/取值 | 语义 |
|---|---|---|
| `cognitiveRoot` | `workspace/.omb` | 认知数据根（相对 preset 根解析，迁移可移植） |
| `hostVersion` | 注入后覆写 | 宿主版本唯一来源（`kernel/schemas/host-version.ts`） |
| `model` | deepseek-official / deepseek-v4-flash | /bench 真实执行；缺失 → 回放执行降级 |
| `activationLogDir` | `workspace/.omb/activation` | 版本激活记录幂等落盘 |
| `bootstrap` | true | 三线布局自动初始化/修复 |
| `benchVersion` | 'v2' | 'v1' 切回 legacy 录制基准 |
| `line` | stable | 固定初始版本线（后备/兼容机制） |
| `selfIteration` | 全启用（不写 = 既有行为） | 自迭代开关面（部署级策略，无界面开关）：`enabled` 链路总开关 / `minStrength` 触发门槛 / `backgroundModelCalls` 后台模型调用许可（`auto` → 由并发档位决定）/ `schedule` 演化节律 |
| `concurrency` | 未知 | 并发能力声明面：`maxConcurrentRequests`（1 → 自动禁止后台模型调用）；宿主 llm 暴露元数据时优先读宿主，未知则不擅自收紧 |
| `episodeSampleRate` | 0.02 | 记忆检索 Episode 采样率（0~1） |

---

## 2. 总体架构：内外双核与认知双核

> 本章描述实际系统的总体骨架：层结构上的内外双核分层（恢复根 → 系统管理层 → 认知系统）
> 与运行期的认知双核（Governor + Scheduler + Generator）；§3-§14 为按层展开的实现细节。

### 2.1 内外双核分层架构

系统按可信度与演化自由度分为三层（依赖 DAG：substrate(0) → supervisor(1) →
kernel/runtime/memory(2)，见 §3.1）：

| 层 | 实际职责 | 关键文件 |
|---|---|---|
| ① 恢复根 Recovery Root | 极小、稳定、AI 不可触碰：启动完整性校验与自动回退、版本线加载、沙盒验证通道、原子回滚 | `substrate/boot.ts`（bootStable 启动校验+自动回退）、`snapshot.ts`（版本线/布局/git 工具）、`sandbox.ts`（受限子进程验证通道）、`rollback.ts`（update-ref 原子回退） |
| ② 系统管理层 Supervisor | 有状态服务与受控演化：git 演化事务、验证链、冻结基准、候选信任池、能力注册表、版本编排（Runtime Snapshot）、集体共享 | `supervisor/txn.ts`（演化事务：begin/commit/verify/mergeTo/rollback）、`validate.ts`（G1-G3 验证链）、`bench.ts`（冻结基准）、`candidates.ts`（信任池+谱系检查）、`capability.ts`（能力注册表）、`versioning.ts`（Runtime Snapshot）、`share.ts`（集体共享协议） |
| ③ 认知系统 Cognitive System | 可自由演化的运行期认知核心：监督决策、过程调度与生成、过程库、记忆 | `runtime/governor.ts`、`scheduler.ts`、`generator.ts`、`kernel/processes/*.yaml`（过程库，机制即数据，经 `kernel/policy-loader.ts` 加载）、`memory/`（记忆系统） |

- 不可触碰面收敛到恢复根：AI 不直接写正式安装树；管理层可更新但更新经受控路径
  （候选 → 沙盒验证 → 信任池 → Activation Contract，见 §2.5/§7.3/§8）；
  认知系统（policy/processes/记忆）随版本线自由演化（§4）。

### 2.2 认知双核：Fast Governor + Rare Generator

运行期认知回路 = `runtime/governor.ts + scheduler.ts + generator.ts` 三件套：
Governor 常态用结构化策略廉价决策（表驱动，代码不感知内容）；Scheduler 对已知过程
确定性选择；Generator 仅在真正陌生时生成临时过程（受预算约束）——正常路径零额外 token。

| 环节 | 实际实现（runtime/） |
|---|---|
| Governor 监督 | `governor.ts`：`GovernorInput` 十一字段（task_contract/state_snapshot/environment/candidate_processes/applicability_results/budget/risk/progress_vector/uncertainty_vector/maintenance_state/evidence_sufficiency）；`decide()` 表驱动——success_criteria 全覆盖短路 Stop（`isSuccessCriteriaCovered`），否则查 `(applicability, evidence_gaps, budget_ok)` 三维决策表 → RunProcess / Verify / GenerateProcess / ExpandSearch / RetrieveMemory / Delegate / Stop；规则数据化于 `kernel/policy/governor.yaml`（改 YAML 即改行为） |
| 计算分配 | `governor.ts` `BUDGET_DIMENSIONS` 六维（深度/广度/工具/检索/分支/上下文）+ `allocate()` 纯函数分配 |
| Progress | `governor.ts` `PROGRESS_DIMENSIONS` 七维（constraint_reduction … uncertainty_reduction）+ `utilityEstimate()` |
| Scheduler 已知调度 | `scheduler.ts` `ProcessScheduler`：Applicability Strong/Partial 直接复用（库序确定性 + 成本预算守卫，超预算 → none）；OOD → 交 Generator；Failed/Contradictory 不生成（Governor 决策域 RetrieveMemory/ExpandSearch） |
| Generator 生成 | `generator.ts` `ProcessGenerator` 阶梯（Reuse→Compose→Mutate→Generate，LLM 生成是最后手段，防 token 黑洞）+ `generator-ops.ts`（assessApplicability / composeProcesses / mutateProcess / editDistance / keywordRetrieve）；Ephemeral Process 仅存当前任务，成功经验经演化链（§7）固化 |

### 2.3 World/Self Model

`runtime/models.ts`（S1）：装配期从运行时真实状态只读组装 World/Self 模型——
World Model = 项目架构/依赖/运行时/外部状态；Self Model = 当前能力/已知限制/可靠策略/
易失败工具/盲点。`buildWorldModel` / `buildSelfModel` 是 RuntimeView 的纯函数
（`runtime/assembly.ts` `assembleModelView` 供视图），同 view → 同内容同 id（确定性）；
无硬数据 → 诚实未知缺省，不臆造。模型类型定义于 `kernel/schemas/s.ts`。

### 2.4 Intent ABI 与能力合成

能力调用面由三文件构成：

- `kernel/capability-abi.ts`：`CapabilityContractSchema`——input/output 为 zod schema +
  cost / side_effect / reversibility / reliability / evidence_quality / idempotency /
  concurrency / environment / authority_scope 契约匹配字段；
- `runtime/intent.ts`：`IntentSchema`（verb/object/scope/effects/constraints/
  required_verification，自 `kernel/schemas/p.ts` P4 派生）+ 合成流程：Intent →
  CapabilityGraph（默认 fixed plan `defaultGraphPlan`）→ 契约匹配 → Provider Selection
  （reliability 降序）→ Binding → 执行 + Failure Fallback 降级链；
- `supervisor/capability.ts`：能力注册表——注册（重复 id fail-loud）/ 发现（name+scope
  过滤）/ 同层同名冲突 fail-loud（平台硬边界）/ 注销（未知 id fail-loud）。

### 2.5 Activation Contract

版本激活是唯一提交接口：`stable_head = candidate_hash` 仅由恢复根原子切换。
`supervisor/activation.ts` 全链：

幂等检查 → 污染守卫（谱系含 untrusted 拒绝）→ evaluate+classify（Regressed/Unknown
拒晋升）→ 切换前快照捕获（rollback_snapshot）→ Recovery Root 原子切换
（`substrate/rollback.ts` rollbackTo）→ ActivationContract 组装（M6 schema 校验
fail-loud）→ EvolutionObject 落 git（M4，id=sha256(内容)）→ `versioning.ts`
SnapshotRegistry.promote（新请求用新快照，进行中请求不受影响）→ activation/committed
事件；crash-window 由 pending 标记恢复（`supervisor/activation-log.ts` 幂等落盘），
污染回滚经 rollback(contract) 切回 predecessor。

### 2.6 沙盒虚拟化

候选执行走受限子进程验证通道（`substrate/sandbox.ts` + `substrate/win32-*` 系列）：

- `sandbox.ts`：`createCandidateDir`（mkdtemp 于 `.evolution/candidates/`，进程退出兜底
  清理）；`runRestricted`——WRITE_RESTRICTED 受限令牌 spawn node 跑 .cjs，写能力 =
  writableDirs/私有 temp 上的精确 ACE；受限进程内 stdio pipe 会 EPERM → 输出走结果文件
  （`OMB_SANDBOX_RESULT_FILE`）；TMP/TEMP 改写私有 temp；fail-closed（Win32 失败抛错，
  绝不静默以完整令牌运行）；`sandboxStatus()` 显式降级探测（非 Windows/koffi 加载失败
  → 记录 degraded，门禁语义保持）。
- `win32-*` 系列：`win32-ffi.ts`（koffi FFI 绑定）/ `win32-token.ts`（受限令牌）/
  `win32-acl.ts`（ACE 授权）/ `win32-sid.ts`（确定性 SID）/ `win32-spawn.ts`（受限
  spawn）/ `win32-abi.ts`。
- 消费方：候选管线 G3-exec（§7.3）——dynamicCordisRunner 通道优先，通道失败/缺失
  回退受限子进程（WRITE_RESTRICTED + 结果文件方案 + 沙盒语义断言）。

### 2.7 共享与 Evolution Object

集体共享协议（`supervisor/share.ts` + `supervisor/share-pipeline.ts`）：

- `share.ts`：protocol.json = 协议/schema 版本单一权威源（PROTOCOL_VERSION=1）；
  Registry = Git 清单 transport（本地目录 `.evolution/registry/`：protocol.json +
  manifest.json + objects/<hex>.json + blacklist.json）；RegistryAPI
  （list/get/publish/verify/revoke）+ addVerification（共识回传写路径）；
  签名校验（`supervisor/signature.ts`：格式 + Git 签名）。
- `share-pipeline.ts`：`stripId`（内容寻址体，id=sha256(canonical body)）、
  `packObject`/`unpackObject`（canonical JSON + 签名头 envelope，格式/版本/签名/schema/
  哈希任一非法 fail-loud）、`absorb` 吸收管线（签名/哈希 → schema → 本地回放 bench →
  契约测试 → 入库已验证 → 共识回传，任一阶段失败短路 + AbsorbReport 记录失败步）。
- Evolution Object（M4）：id=sha256(canonical body)，承载 parent 链头 + diff + bench +
  verifications，晋升时随提交写入（§7.4）。
- 生产默认不自动发布/吸收，显式入口 `/evolve share|absorb <id>`（§7.7）。

---

## 3. 分层架构与目录

### 3.1 层 DAG

规则：**import 目标层 ≤ 源层**（eslint `no-cross-layer-import` + `tests/m0/dag-lint.test.ts` 钉住）。

- `substrate(0)`：不 import 任何上层（平台原语）。
- `supervisor(1)`：只 import node 内置 + `kernel/schemas/`（**IR 契约例外**——
  `supervisor → kernel` 其它路径禁止）+ supervisor 内文件 + substrate。
- `kernel/runtime/memory(2)`：可 import 0/1/2 层；kernel 只依赖 kernel/schemas。
- **runtime 禁止 import components**：组件注册表落 supervisor 层 1，`components/registry.ts` 仅为 ABI 出口。

### 3.2 目录职责

| 目录 | 层 | 职责与关键文件 |
|---|---|---|
| `substrate/` | 0 | 恢复根与平台原语：`boot.ts`（bootStable 启动校验+自动回退）、`bootstrap.ts`（三线布局自动初始化/修复/旧种子迁移）、`lines.ts`（按线加载：指针解析+ls-tree 物化）、`snapshot.ts`（版本线/布局/git 工具）、`mode-command.ts`（/mode 纯逻辑）、`rollback.ts`（update-ref 原子回退）、`sandbox.ts`（受限子进程验证通道）、`win32-*.ts`（ACL/token 原语） |
| `supervisor/` | 1 | 有状态服务与存储：`maintenance.ts`（维护调度器）、`verification-stores.ts`（四库）、`verification-debt.ts`（验证债务）、`artifact-index.ts`（制品索引）、`candidate-pipeline.ts`（G1-G4 管线与晋升）、`promotion.ts`（stable 晋升/回滚）、`bench.ts`/`bench-v2.ts`（冻结基准）、`real-executor.ts`、`judge.ts`、`shadow.ts`、`share.ts`（集体共享）、`dynamic-runner.ts`（runner 通道）、`event-store.ts`、`state-reducer.ts`、`checkpoint.ts`、`versioning.ts`、`component-registry.ts`、`capability.ts`、`activation-log.ts` |
| `kernel/` | 2 | 纯函数核心（零 I/O、零副作用、确定性）：`verification.ts`、`repair-contract.ts`、`shadow-contract.ts`、`candidate-contract.ts`、`bench-contract.ts`、`promotion-gate.ts`、`verifier-evolution.ts`、`candidate-generator.ts`、`evolve-decision.ts`、`environment-fingerprint.ts`、`process-quality.ts`、`controllability.ts`、`structured-judge.ts`、`shadow-route.ts`、`policy-loader.ts`；`kernel/schemas/`（IR 契约层 zod）；`kernel/policy/*.yaml`（机制即数据：governor/budget/context/evolve）；`kernel/processes/*.yaml`（hypothesize-test / retrieve-verify）；`kernel/bench-tasks/`（冻结基准 20 任务） |
| `runtime/` | 2 | 认知运行时装配与插件面：`plugin.ts`（Cordis 插件入口）、`assembly.ts`（组合根 CognitiveRuntime）、`kern-tools.ts`（kern_* 桥）、`runtime-contract.ts`（三层契约）、`loop-hooks.ts`（三钩子助手/降级记录）、`dsh-events.ts`、`governor.ts`、`prompt.ts`、`renderer.ts`、`scheduler.ts`、`generator*.ts`、`context-candidates.ts`、`evolution-signals.ts`、`signal-collectors.ts`、`models.ts`、`repair-executors.ts`、`judge-executor.ts`、`model-adapter.ts`、`snapshot-hash.ts`、`turn-helpers.ts` |
| `memory/` | 2 | 记忆系统：`backend.ts`（SQLite+FTS5）、`backend-retrieval.ts`、`retrieve.ts`（六阶段检索）、`staging.ts`/`consolidate.ts`（经验入长期记忆）、`utility.ts`（Episode 归因）、`cjk-ngram.ts`、`negative-pattern.ts`、`memory-retrieval.ts`（首个组件实现） |
| `components/` | ABI | `registry.ts` 类型出口 |
| `skills/omb-runtime/` | — | `SKILL.md` 使用说明技能（渐进层源文件） |
| `scripts/` | — | `init-three-line.ts`、`deploy-lines.ts`、`bench-report.ts`、`replay-recorder.ts`、`retrieval-bench.ts`、`gen-bench-fixtures.ts` |
| `tests/` | — | m0（层/布局/加载）… m9（验证契约体系） |
| `lib/` | — | 构建产物（gitignored） |

---

## 4. 三线版本机制

版本线承载版本化认知对象（kernel/policy + kernel/processes），运行时按线加载。

### 4.1 布局

- `versions.git`：bare repo（`git init --bare -b main`）承载三线。
- `initial` = 永久不可变 **tag**（`refs/tags/initial`）；`stable` = `refs/heads/stable`；
  `latest` = **trusted-latest 指针**（`refs/heads/trusted-latest`；R1 起缺失即 fail-loud，
  旧种子由启动自动重建，不回退 main）。
- `stable/`、`latest/`：正式 worktree，施加只读 ACL
  （`icacls /inheritance:r /grant:r "Everyone:RX" /T /C`）。
- 线指针引用表：`substrate/lines.ts` `LINE_POINTER_REFS`。

### 4.2 物化与加载

- 运行时**不读 worktree**（正式 worktree 只读 + Windows git/icacls 锁竞态；禁止
  checkout/worktree/archive 改写运行目录）。`ensureLineSnapshot`：解析线 commit →
  `materializeLineSnapshot` 物化——`git ls-tree -r --name-only -z <commit>` 枚举 +
  逐文件 `git show <commit>:<path>`（原始字节）写出到
  **`workspace/.omb/lines/<line>/<commit>/`**（不可变快照目录，同 commit 幂等复用）。
- 指针：原子写 `lines/<line>/pointer`（tmp+rename）；切换 = 改指针，下一请求读新快照。

### 4.3 切换：/mode 与 kern_switch

- `/mode <initial|stable|latest>`：`substrate/mode-command.ts` 纯逻辑 + `runtime/plugin.ts` 接线。
- 流程：解析 → load 校验（fail-loud）→ **空白会话守卫**（会话事件流无 `turn/start`
  才允许切换；/mode 自身运行不打开 turn，不会破坏空白）→ onSwitch。
- onSwitch：`rebuildSnapshotForLine`（新线物化 → 新快照 → `registry.promote`，
  下一请求生效；失败降级保持当前快照）→ `recordLineActivation`
  （activation/committed 事件入链 + `workspace/.omb/activation/` 幂等落盘，
  ActivationContract M6 schema 校验 fail-loud）。
- `kern_switch`（`runtime/kern-tools.ts`）：同语义（校验+快照重建+激活记录）
  但**无空白会话守卫**——工具由模型运行中显式调用 = 显式意图。

### 4.4 种子自动迁移（旧布局检测）

`substrate/bootstrap.ts` `ensureThreeLineLayout`（插件启动时执行，绝不 throw）：

- 健康布局：纯 fs 检查，零 git 子进程，零开销。
- 缺失：完整初始化（种子 = manifest + README + kernel/policy + kernel/processes 快照；
  tag initial + branch stable；main 分叉一版；trusted-latest ← main head）。
- 损坏：保守修复（绝不删除 versions.git / worktree 内已有内容）。
- **旧种子检测**：`legacySeedHint`（纯 fs 预检）+ `isLegacySeed`（git 确认：
  无 trusted-latest 或 stable 基线树缺 kernel/policy）→ `migrateLegacySeed`
  （释放 ACL 删旧 worktree → `versions.git` 移动为 `versions.git.legacy-<ts>` 备份 →
  清理旧 lines/ 快照 → 重建新种子）。
- `config.bootstrap: false` 可关闭。

---

## 5. 上下文与认知投影

三个 context section 由 `runtime/plugin.ts` 经 `systemPrompt.context` 注册
（order 小者在前：contract(80) → capabilities(85) → projection(90)）。

### 5.1 cognitive:contract（order 80）——固定契约

- 文本：`OMB_RUNTIME_CONTRACT`（`runtime/runtime-contract.ts`，静态常量、不随演化变）。
- 硬约束：总长 ≤ 500 字符（`tests/m9/runtime-contract.test.ts` 钉住；当前 411 字符）。
- 内容：可用面（命令/工具/投影）、使用时机（kern_memory / kern_profile / /bench / /mode +
  **自迭代按需许可**：涉及自迭代、版本线、验证或修复的任务可先 `kern_status` 看状态与被拦原因，
  条件满足再 `/evolve` 或 `kern_evolve` 触发）、边界（不主动加载内部机制、不无由触发改动；
  认知层仅观察注入、未验证候选不视为可信能力）。标题为「OMB认知层使用方式：」（不强调版本）。

### 5.2 cognitive:capabilities（order 85）——动态能力行

- `buildCapabilitiesLine(capabilitiesViewOf(cognitive))`：纯函数、同步求值、确定性。
- 内容：capabilities/components 名称 + 语义裁判可用性 + 候选验证通道（runner / 受限子进程）；
  全部未知 → 兜底「当前无额外能力面」。

### 5.3 cognitive:projection（order 90）——每轮投影

- 投影管线（S8 事件驱动预热）：`turn/start` 事件**预热**（`prepareForTurn` 提前触发
  prepareTurn——宿主事件流 turn/start 先于 systemPrompt.assemble）→ context 同步求值
  返回**缓存投影文本**（未完成 → 空串/上次投影，宿主同步接口约束文档化）→
  `prepareTurn` 的 inject 回调写缓存并入链 `context/injected` 事件
  （**Model-visible ⟺ logged**：注入必有对应事件）。
- 防重入：`preparing` set（预热与求值共享，并发只跑一次 prepare）。
- 文本格式：`认知投影（OMB v2，<type>，<N> tokens）` + A3 sections 串联
  （`runtime/loop-hooks.ts` `projectionToText`）。

### 5.4 WorkingState

`runtime/prompt.ts` `PromptWorkingState`，字段：
`goal / confirmed_facts / active_hypotheses / contradictions / open_questions /
evidence_gaps / next_best_action / environment`。

投影 = Governor 决策 + 工作状态 + 记忆/上下文候选，按预算编译
（`budget.yaml` `context_budget_tokens: 500`，§17 真实数据标定回写）。

### 5.5 上下文候选五来源

`runtime/context-candidates.ts` `gatherContextCandidates`
（设计全集 Memory/Evidence/Capability/Process/Artifact）：

| 来源 | 数据源 | 封顶 | view |
|---|---|---|---|
| memory | retrieve 输出 | 检索 limit | summary |
| evidence | 最近会话 Observation/decision 事件（`EVIDENCE_EVENT_TYPES`） | N=6 | original |
| capability | 能力注册表当前可用能力 | M=5 | original |
| process | 调度器 R3 调度结果 | 1 | original |
| artifact | **Artifact Index 最近制品**（S4） | K=3 | pointer |

**Artifact Index（S4 事件驱动发现）**——`supervisor/artifact-index.ts`：
`discoverArtifactsFromEvents` 只扫 `tool/result` 事件，payload 文本按扩展名白名单正则
提取路径样 token（每事件上限 5）；root 提供 → 只索引 root 下存在的文件
（hash 真实、restorable:true），幽灵路径/越界跳过，root 未提供 →
hash='unavailable'/restorable:false 诚实缺省；`ARTIFACT_CAP=500` 超限淘汰最旧；
JSONL `index.jsonl` 原子写。

**ΔInfoValue（S3 首版承诺）**——`estimateInfoValue` 缺口匹配启发式：
`INFO_VALUE_BASE(60) + GAP_BONUS(120)·缺口重叠 + QUESTION_BONUS(60)·问题重叠
− CONFLICT_PENALTY(60)·已确认事实冲突`；token 化复用 `memory/cjk-ngram.ts`
（CJK bigram / 非 CJK 空白分词）；renderer 按 marginal 贪心在预算内选择
（`context.yaml` marginal_weights/kind_costs 数据化）。

---

## 6. 记忆系统

### 6.1 存储

- `memory.db`（`memory/backend.ts`）：SQLite WAL 单写者 + FTS5 bm25。
- 六表：memory / memory_relation / memory_stats / retrieval_episode / staging / checkpoint。
- 幂等键：同 `provenance.event` 二次 ingest → no-op（恢复 = 幂等重跑）。

### 6.2 六阶段检索

`memory/retrieve.ts`（架构 §7.3），入口 `retrieve(backend, q, {episode})`：

1. **Scope**：覆盖链 Session→Project→Global，会话优先无则降级，止于首命中；
2. **Kind**：显式 kind 或 task_type 偏好表（qa→Semantic/Decision、planning→Procedural、
   debug→Episodic、generic→全）；
3. **Channel**：text→lexical（FTS5）/ relation→关系遍历 depth-1 /
   Episodic 偏好→episode（payload 时间排序）/ 否则 temporal（updated 排序）；
4. **Expansion**：结果不足 limit → top-1 depth-1 关系扩展；
5. **Rank**：Memory Value 统一价值模型降序。

**Memory Value**（§7.4）：
`0.4×utility_score + 0.3×reliability(prov_class) + 0.2×retrievability
+ 0.1×transferability(scope) − pollution(Suspicious 0.2) − maintenance(payload 大小)`；
prov_class 可靠性 User-declared 1.0 … Model-inferred 0.5；scope 可迁移性
Global 1.0 / Project 0.7 / Session 0.4。

每次检索记 Retrieval Episode（`opts.episode=false` 关闭），outcome 事后归因
（`memory/utility.ts` 六计数器 + utility 更新，M5 ranking 学习输入）。

### 6.3 Profile 画像（跨项目）

- 画像 = **单条 Profile 记忆**，确定性 id `profile:user`；**Global 作用域**
  （跨项目可检索），prov_class='User-declared'。
- 写入面 `kern_profile`（`runtime/assembly.ts` `upsertProfile`）：不存在 → 新建；
  存在 → 更新 payload（replace=true 覆写 / 缺省合并追加去重）。
- 读取面 `kern_memory kind=Profile scope=Global`——读写面闭合（W1 未接线审计修复）。

### 6.4 环境指纹与 Predictive Invalidation（P7）

- 指纹采集：`kernel/environment-fingerprint.ts` `collectEnvironmentFingerprint`
  （os/node/dsh_version/project；gpu/cuda 无探测缺省）；diff：`diffFingerprints`
  （固定字段序 os/node/dsh_version/project/gpu/cuda）。
- 失效动作：`supervisor/maintenance.ts` `predictiveInvalidate`（指纹 diff →
  受影响对象 markSuspicious + 最小回归子集 → 能力衰减记录：
  每字段变化 × `CAPABILITY_DECAY_FACTOR 0.8`）。
- 落盘：`environment_check` 维护任务 → `.evolution/decay/<ts>.json` → 入队 repair。

### 6.5 长期学习闭环（R4）

`memory/staging.ts`（Experience Admission 准入）+ `memory/consolidate.ts`
（dedup/merge/relation/decay，单写者事务）——`memory_consolidation` 维护任务驱动。

---

## 7. 演化系统

### 7.1 信号

- 来源①：finalizeTurn 聚合 `utility_counts`（`supervisor/state-reducer.ts`）→
  `countsToSignalRecords`；来源②：L1 generalization 采集器（`runtime/signal-collectors.ts`）。
- 落盘：`runtime/evolution-signals.ts` 追加写 `.evolution/signals/<yyyy-mm-dd>.jsonl`
  （SignalRecordSchema 校验 fail-loud，按日分文件）；kern_status `recent_signals` = 当日记录数。

### 7.2 判定

- `kernel/evolve-decision.ts` `decideEvolution`：纯函数、确定性。
- 策略：`kernel/policy/evolve.yaml`（数据化）——`signal_triggers` 表、`roi_min`、
  `daily_evolution_cost`、`debt_thresholds`（soft 10 / hard 50 / critical 100）。
- `signal_triggers`：corrections / oracle_fail / scope_miss / untrusted_object → 触发演化
  （对应 repair / candidate_validation）；活跃正向信号（tool_calls / retrieval_calls / …）
  → 仅记账不演化（防噪声）。
- 输出：`{should_evolve, strength, object_layer, budget_estimate}`。

### 7.3 候选管线（G1-G4）

`supervisor/candidate-pipeline.ts`；目标白名单 kernel/policy/
{governor,budget,context,evolve}.yaml（G1 拒绝未知目标/路径穿越）：

| 门 | 语义 |
|---|---|
| G1 结构 | YAML 解析 + zod schema + 值域约束 |
| G2 | 数据候选 N/A（标记 skipped——策略参数为数据，无单测契约） |
| G3-replay | 候选应用到临时目录 + 捆绑校验 + runBenchV2 回放比较：passed 不降 + 成本代理（context_budget_tokens）劣化 ≤ 容忍 |
| G3-exec | 执行型验证（候选附 `verify.cjs`）——dynamicCordisRunner 通道优先（define→run→invoke verify→stop→undefine，host-only 无人工审批）；通道失败/缺失 → 回退受限子进程（WRITE_RESTRICTED + 结果文件方案 + 沙盒语义断言：候选目录写拒绝）；无脚本 N/A、通道不可用 D5 降级不阻塞 |
| G4 | shadow 契约接线（exposure 记录落 `.evolution/shadows/`） |

单次最多 K=3 候选（`candidate_gate.max_candidates_per_run`）。

### 7.4 晋升（trusted-latest 推进）

`promoteDataCandidate`：临时 worktree（trusted-latest 可写副本）覆盖式提交
（作者 OMB <omb@local>，消息 `evolve: <id> <motivation>`）→ 防误删检查（diff 无删除）
→ `git update-ref refs/heads/trusted-latest` 原子推进（candidate_id 幂等键）→
main 快进 best-effort → 信任池 promote（`supervisor/candidates.ts` CandidatePool）→
**Evolution Object**（M4 immutable，id=sha256(canonical body)）写入提交内
`.evolution-objects/<id>.json`（parent 链头 + diff + bench + verifications
+ P4 可选 verification 挂载）→ evolution/promoted 事件。

### 7.5 stable 晋升门禁（P1e）

`promotion_check` 维护任务 / `/evolve` 共用 `runPromotionCheck`：

- `kernel/promotion-gate.ts` `shouldPromoteToStable` **三层信号**：
  L1 机械硬门（冻结基准 fitness 不降 + 成本劣化 ≤ 容忍，零成本最高优先）→
  L2 统计层（shadow 样本 n ≥ min_shadow_samples 时失败率 ≤ 上限；无样本/样本不足
  → 记录不阻塞，防冻结演化闭环）→ L3 语义旁证占位（judge 仅旁证不作晋升硬信号）。
- 再经 `kernel/candidate-contract.ts` `stablePromotionTrustGate`：**验证契约信任门禁
  fail-closed**——对象无验证记录 / verdict 非 PASS / VerifierTrust < L2 / 非循环失败 → 拒绝。
- `supervisor/promotion.ts` `promoteToStable`：幂等 activation_id + 竞态守卫 +
  `rollbackTo`（update-ref 原子切换 + fsync + worktree best-effort）+ ActivationContract
  （M6，rollback_snapshot = 旧 stable）落盘 + activation/committed + evolution/promoted
  事件；`rollbackPromotion` 回滚契约留恢复面。

### 7.6 shadow 分流（S7 真实放量）

- `kernel/shadow-route.ts` `shouldRouteShadow`：
  `bucket = sha256(session_id + candidate_id) 前 2 字节 % 100 < exposure_rate(10)`
  → 会话按 **latest 线快照运行**（per-request 生效：快照身份/线状态真实变化 +
  policy/processes 按线加载）；前置条件：enabled + 两线分叉（trusted-latest ≠ stable），
  否则零开销不路由。
- exposure/outcome 落 `.evolution/shadows/exposure-<date>.jsonl`；
  `supervisor/promotion.ts` `readShadowSignals` 按 (session,candidate) 键最后一条胜出计数；
  P2 三态——unknowns 独立一档（不计 failures、不污染失败率评分）。

### 7.7 /evolve 命令

- `now`：`runEvolutionNow`——判定 → 入队 candidate_validation → 候选管线 →
  晋升检查 → 维护量子，返回摘要。
- `share`：发布 trusted-latest 演化链头为机制级 Evolution Object → 本地 registry
  （隐私原则：仅 `evolution/*` 来源机制数据，绝不发布私人记忆/会话内容）。
- `absorb <id>`：显式吸收（本地验证 schema/签名 → absorb 管线 → 共识回传）。
- 生产默认不自动发布/吸收（`share.publish_mechanism_objects=false` /
  `auto_discover=false`，配置为未来自动路径预留，显式命令始终可用）。

---

## 8. 验证契约体系（核心）

统一验证语义（P1-P4 + 第二阶段）：Shadow 成功判定 / Repair 重验证 /
Evolution 晋升 / Benchmark 四者共享同一套契约。

### 8.1 六对象

`kernel/schemas/verification.ts`（zod fail-loud）：

| 对象 | 字段 |
|---|---|
| VerificationContract | id / goal / hard_constraints / outcome_conditions / process_conditions / verifiers / trust_required / verdict_semantics |
| VerificationPlan | contract_id + steps{verifier_id, evidence_required} |
| Verifier | id / kind / checks / blind_spots / trust / origin |
| VerificationEvidence | verifier_id / contract_id / checks{name,result,detail} / ts / source |
| VerificationResult | verdict / hard_failures / unknown_checks / evidence_quality / reason / evidence |
| VerifierTrust | TRUST_LEVELS L0-L4 |

枚举：VERIFIER_KINDS 四级（deterministic/external/structured_llm/human_multi）；
VERDICTS 三态（PASS/FAIL/UNKNOWN）。

### 8.2 三态判定（decideVerdict）

`kernel/verification.ts`，纯函数、确定性（同输入同输出）：

- 应查检查 = hard_constraints ∪ outcome_conditions（去重保序）；process_conditions
  不参与判定（由 process_quality 注入面覆盖）。
- 证据按 verifier_id → kind 分层：deterministic/external = **权威**，
  structured_llm/human_multi = **补充**；契约隔离（contract_id 不匹配 / 未声明
  verifier 的证据忽略）。
- 任一应查检查被权威证据判 fail → **FAIL**（hard 优先）；全部应查检查有权威 pass
  （或权威无 fail 且补充 pass 覆盖）→ **PASS**；其余（权威 unknown / 仅补充判 fail /
  无证据）→ **UNKNOWN**（合法终态——证据不足不强行裁决，**LLM 不能定 FAIL**）。
- evidence_quality = 有结果（pass/fail）检查数 / 全部应查检查数（0~1 保留两位）。

### 8.3 验证阶梯与硬约束

- 阶梯：确定性 → 外部工具 → 历史/回归（基线版本化对比）→ 结构化单次裁判（SAJA）→ UNKNOWN。
- **hard 约束不可被 LLM judge 覆盖**（防 reward hacking）；结果与过程质量分离——
  process_quality / controllability 由机械评分器注入（`kernel/process-quality.ts`
  六维向量 + `kernel/controllability.ts` 分类制），不在 decideVerdict 内计算。

### 8.4 信任与非循环

- `trustGate(verifierTrust, required)`：序号 ≥ required 放行（含 equal）；
  trust < required 不能用于 stable 晋升（P4 裁决①）。
- `nonCircularityCheck`：verifier.origin 等于候选自身 → 拒绝
  （**防循环自证**：AI 生成 Candidate → AI 生成 Verifier 的循环链被阻断）。
- 宪法级原则：**验证标准不能被验证器自己定义**——trustGate + nonCircularityCheck +
  stablePromotionTrustGate fail-closed 共同落实。

### 8.5 数据面四库

`supervisor/verification-stores.ts`，`.evolution/verification/`：
每库目录下每记录一个 JSON 文件（文件名 = 复合键 sha256 hex，Windows 文件名安全）；
原子写 tmp+rename；损坏 JSON fail-loud；写失败降级记录不抛。

- **事实库 FactStore**：已确认 Claim 当前有效性（finalizeTurn 自动填充；
  valid=false = 已推翻/矛盾；provenance 子串查询）。
- **基线库 BaselineStore**：**版本化基线对象 = {输入 + 环境指纹 + 运行时快照 +
  期望结果 + 验证器版本}**——「未来演化后知道究竟和哪个历史状态比较」；
  verifier_version 不等 → 基线过期需重放确认，不得直接对比；
  kind 枚举 process / skill-task / policy-regression / projection-rebuild。
- **任务库 TaskStore**：Task Contract / Success Criteria / Verifier 注册面
  （writeShadowOutcome 登记 `shadow:<sessionId>`；当前无执行器消费，留后续）。
- **验证器库 VerifierStore**：Verifier Evolution 注册面（registerVerifier 同 id 覆写）。

### 8.6 验证器注册与替换门禁

`kernel/verifier-evolution.ts` `candidateVerifierGate` + `applyVerifierReplacement`：
注册面 = {固定规范 spec{checks, blind_spots}, 固定验证基准 validation_benchmark,
独立测试集 independent_test_set, 自身版本号 version, origin}。

替换门禁顺序：结构检查（spec.checks 非空且全非空字符串）→ 非循环自证
（origin === verifier_id → 拒绝，fail-closed）→ 无现任首登 → **版本严格递增**
（防回退）→ **已知集/隐藏集/交叉比较/人工复核**（known/hidden/cross/human
四项布尔全 true 才 ok，由调用方注入——独立测试集基础设施留后续）。

生效：门禁 ok → registerVerifier 成为现任 + 审计 JSONL
`<verificationRoot>/verifier-evolution.jsonl`（成功与拒绝都记）。
Verifier Evolution 属**最高风险演化对象**（reward hacking / verifier gaming
是 Agent 系统最高风险攻击面——SpecBench 实证）。

### 8.7 验证债务队列

`supervisor/verification-debt.ts`，`.evolution/verification/debt.jsonl`：

- 入队：shadow outcome UNKNOWN 且 criteria 非空 → `shadow:<sessionId>`；
  repair 对象 UNKNOWN 且 evidence_quality<1 → `repair:<objectId>`。
- DEBT_CAP=500 超限淘汰最旧；同 key 覆写去重；`listPending`（最老优先）/
  `markResolved` / `markPendingManual` / `bumpAttempts`（attempts≥2 → 低频人工复核
  pending_manual）；损坏行跳过（审计日志语义——队列不因坏行死亡）。

### 8.8 空白子代理单次裁判

- `kernel/structured-judge.ts`：一次调用 + 结构化多维输出 {result_quality,
  evidence_quality, process_quality, controllability, uncertainty}（JudgeOutputSchema）
  + `parseJudgeOutput` 容错提取 + `calibrateJudgeOutput` 本地阈值校准
  （≥0.7 且 uncertainty≤0.3 → PASS/high；≤0.3 且 ≤0.3 → FAIL/high；
  其余 → **UNKNOWN/low 合法终态**——不强迫猜）。
- 执行器 `runtime/judge-executor.ts`；装配面（`runtime/plugin.ts`）：
  `ctx.get('subagents')` Guard 安全读取（B3 教训：宿主服务必须经 get 读取）→
  `subagents.start('spawn', {prompt, toolFilter: [], signal})`——
  **spawn 全新会话、toolFilter 空纯文本裁判、同模型零额外订阅成本**。
- subagents 缺失 → judge 不可用诚实降级 → 债务转人工；
  **仅验证债务路径触发（verification_review 复核），正常任务 0 额外成本**。

### 8.9 verification_review 复核

`runtime/assembly.ts` `runVerificationReview`：`listPending(3)` 逐条——
judge PASS/FAIL → `markResolved`（resolution {verdict, judge_used:true}）；
UNKNOWN / judge null → `bumpAttempts`，≥2 → `markPendingManual`；
judge 不可用 → `markPendingManual`（detail 注明）；signal.aborted → 让出不标记；
全部尽力而为，债务保留。

---

## 9. 维护调度

`supervisor/maintenance.ts` `MaintenanceScheduler`（装配注入 `runtime/plugin.ts`：
turn 收尾入队 + 请求间隙小量子 + 进程内 tick）。

### 9.1 债务语义

- `enqueue(input, {accrueDebt: true})` → 入队同时累计债务并立即持久化。
- **成功 → 清偿归零；失败 → 出队但债务保留；中断 → 留队 + 债务累计**（可重试）；
  `DeferredMaintenanceError`（未实现/不可执行）→ 出队但债务保留 + deferredEvents 记录
  （「未实现/未完成 → debt 保留」不再假成功清债）；防双计（已入账任务非执行路径不重复累计）。
- **硬限豁免清单**（2026-08-25 死亡螺旋修复）：gc / memory_consolidation /
  environment_check / turn-finalize:* 不受 hard 限阻塞；硬跳过不累计债务。
- **加载时剪除僵尸债务**：恢复 debt.json 时剔除 `turn-finalize:*` 与 `gc`
  （会话级收尾重启后属主会话已不存在）。
- 持久化 `.evolution/debt.json`（原子写 tmp+rename）。

### 9.2 调度

- 队列按 **ROI = value/estimated_cost 降序**（priority tie-break，critical 强制最前）；
  soft 限（合计 ≥10）→ tick 间隔减半；hard 限（≥50）→ 非必要（normal）任务跳过；
  critical → 请求边界强制插入。
- **硬限豁免清单**（`HARD_LIMIT_EXEMPT`）：gc / 会话收尾 / 记忆整合 / 环境检查（廉价必要维护，
  被阻塞则债务永不清偿）+ **检查与判定类**（`evolution_decision` / `promotion_check` /
  `verification_review`——它们是「债从哪来、能不能释放」的唯一观测与裁决入口，锁住它们会让债务
  永远无法被诊断与清偿）。**保护语义保留**：改动类演化任务（`candidate_validation` / `repair`）
  仍受硬限约束。
- `requestQuantum`：每次执行至多 `batchSize` 个任务（缺省 1 = 单量子语义；生产装配 4——
  同一 tick 内先清高位收尾任务再消费判定/检查类，消除「单量子名额 ROI 饥饿」）；
  可中断：调用方 signal ∪ stop() inFlight 合并；批量执行中中断 → 停止取新任务、剩余留队。
- tick：定时器驱动（基准 60s），生产装配构造后 `start()`（仅在 DSH 运行期生效）；
  队列空时零开销（只增计数不产生执行记录）。
- `stop()`：清定时器/队列并中断在飞任务。

### 9.2.1 债务来源与释放（「修复 → 确认 → 释放」）

- **来源记录**：`MaintenanceDebt` 带 `subsystem / reason / first_seen / last_failure`；
  入账方（`kernel/evolve-decision.ts` `DEBT_SUBSYSTEM` / `ACCRUAL_REASON`）标注来源子系统与原因。
  历史条目来源留空 → `debtSourceView().orphan`。
- **按条释放**：`releaseDebt({taskId, expectedSubsystem, evidence, releasedBy})`——来源子系统自检通过
  才释放，子系统不匹配 → 拒绝。组合根 `runDebtRelease` 逐条核对（自检依据 = 该子系统执行体在本进程内
  成功跑完 + 已落盘审计面佐证）；`repair` 维护任务完成后自动接一次释放。
- **释放审计**：`.evolution/debt-releases.jsonl`（时间/释放前累计值/来源子系统/依据/触发者/原因）。
- **人工裁定**：无主且超过 `DEBT_MANUAL_REVIEW_AFTER_MS`（7 天）→ `manualPendingDebt()` 清单，
  **不做自动清除**。
- **明确不做**：任何周期性/到期式批量清除。

### 9.3 维护任务表

`runtime/assembly.ts` `maintenanceRun` switch + finalizeTurn 入队点：

| 任务 id | 触发 | 执行体 |
|---|---|---|
| `turn-finalize:<session>` | 每次 turn 收尾 | event-store compact（GC） |
| `evolution_decision` | 每次 turn 收尾 | 读 signals → decideEvolution → 应演化则入队 candidate_validation |
| `promotion_check` | 每次 turn 收尾 | runPromotionCheck：stable ← trusted-latest 门禁 → promoteToStable |
| `environment_check` | 每次 turn 收尾 | P7 指纹 diff → 衰减记录落盘 + 受影响对象入队 repair |
| `candidate_validation` | 演化判定应演化（accrueDebt） | runEvolutionChain：候选生成 → 验证 → 晋升（旧布局抛 Deferred） |
| `memory_consolidation` | 有 staging 经验（accrueDebt） | runMemoryConsolidation：staging 准入 → consolidate 整合 |
| `repair` | 衰减信号/显式（accrueDebt） | runRepair：读 decay → 契约化重验证 → 处置；无待修对象 = 合法清债 |
| `verification_review` | 验证债务未决（accrueDebt） | runVerificationReview：空白子代理单次裁判复核 |
| `gc` | 维护量子 | event-store compact |

### 9.4 S2 观测与成本数据化

- 每任务执行后追加写 `.evolution/maintenance-observations/<yyyy-mm-dd>.jsonl`
  （{ts, task_id, duration_ms, result: success|deferred|failed|interrupted,
  debt_before, debt_after}；失败降级不阻塞调度）；`observationsSummary()` 供 kern_status。
- **MAINTENANCE_COSTS 数据化**：estimated_cost 从 `evolve.yaml` `maintenance_costs` 读取
  （memory_consolidation 4 / candidate_validation 10 / repair 25 / promotion_check 2 /
  environment_check 2 / evolution_decision 2 / gc 2——取值 ≥ 权重 → 债务任务 ROI ≤ 1，
  不破坏既有调度顺序）；`ready()` 装配时 `setMaintenanceCosts` 注入，改 YAML 即生效；
  初值为出厂值，最终待观测数据按 ROI 标定（§17）。

---

## 10. 修复系统

### 10.1 损坏类型六分类

`kernel/repair-contract.ts` `classifyRepairDamage`（**优先级不可协商**）：
① `verifier_untrusted`（验证器不可信——禁止据此修复对象，最高优先）→
② `external_uncontrollable`（外部不可控失败如验证码阻塞——不污染能力评分）→
③ `environment_change`（指纹 diff 非空——局部回归）→
④ FAIL（hard_failures 命中结构面检查 → `structural_damage` 结构损坏，
否则 `behavior_regression` 行为回归）→
⑤ UNKNOWN → `insufficient_evidence`（证据不足 → 保持怀疑）→
⑥ PASS → 无损坏（null）。

### 10.2 七类对象契约挂载

`seedRepairContract`：memory / process / skill / policy / capability / projection /
version 各挂载验证契约（hard = 结构面硬约束不可被 LLM judge 覆盖；
outcome = 语义面结果条件；中文检查名可审计）；未列 kind → generic 兜底。

- 契约恒两枚验证器：deterministic（L1 权威，checks=hard+outcome，
  origin undefined 非循环面）+ structured_llm（L2 补充，checks=outcome）；
  trust_required='L1'；`repairPlanForObject` 产出最小验证计划。

### 10.3 真实验证执行器

`runtime/repair-executors.ts`——检查名 → 执行器对应（EXECUTORS 表 18 条 /
17 个检查名，generic「对象存在且可读」复用 getById 判定，按七类契约 + generic 派发）：
对象可检索（getById 命中）/ 检索一致性（payload 提取查询文本 → retrieve 两次
top-5 相等）/ 无矛盾（事实库 provenance 子串查询：无事实 unknown、任一 valid=false
fail、全 valid pass）/ 过程定义结构合法（loadProcesses + 定位）/ 重放一致（process
基线版本化对比）/ 技能定义结构合法（SkillSchema）/ 代表任务（skill-task 基线对比）/
策略 schema 合法（loadPolicy）/ 冻结回归集（policy-regression 基线逐 case 以
**基线冻结策略**重跑 decideEvolution 对比）/ 组件健康检查 / 能力契约满足
（CapabilityContractSchema）/ 投影 schema 校验、必填字段、可恢复（projection-rebuild
基线）/ 快照物化完整可读、冒烟套件（线快照 loadPolicy+loadProcesses）/
generic 对象结构 schema 校验。

**缺数据面/无记录 → 诚实 unknown**（不假装判定）；未注册检查名 → unknown；
抛错归表不向外抛。

### 10.4 首次基线自动注册

对象结构类检查（hard 约束）全 pass 且该 kind 无基线 → 自动注册版本化基线：
kind 对应 memory→无 / process→'process' / skill→'skill-task' /
policy→'policy-regression' / projection→'projection-rebuild'；input = 对象
payload/契约摘要；environment_fingerprint = 当前指纹；runtime_snapshot =
当前 snapshotHash；expected_result = 本次判定摘要；verifier_version = '1'。

### 10.5 处置语义

`applyRepairDisposition`：

| 损坏类型 | 处置 | score_eligible |
|---|---|---|
| verifier_untrusted | no_repair（禁止据此修复） | false |
| external_uncontrollable | no_repair（不污染评分） | false |
| environment_change | local_regression（局部回归） | true |
| behavior_regression | degrade_or_rollback（降级/回滚） | true |
| structural_damage | quarantine（隔离标记） | true |
| insufficient_evidence | keep_suspicious（保持怀疑） | true |
| PASS | clear_suspicious（清除存疑，memory 对象 lifecycle 恢复 Active） | true |

`runRepair`（`runtime/assembly.ts`）读 `.evolution/decay/` 记录 → 逐对象契约化
重验证 → `RepairRecord` 落盘 `.evolution/repair/<ts>.json`
（objects 逐条 {id/kind/contract_id/verdict/evidence_quality/disposition/
score_eligible/reason/detail}）。

---

## 11. 工具与命令面

### 11.1 kern_* 工具

`runtime/kern-tools.ts` `registerKernTools`：经 `ctx.tools.register` 注册、
disposers 集入 ctx.effect（P8 注册皆效应）；全部为认知运行时方法的薄封装，
参数守卫 + 降级不崩；**工具数 <10 纪律**（当前 6 个）：

| 工具 | 数据源 | 语义 |
|---|---|---|
| `kern_status` | `runtime.statusFor({line, evolution})` | 纯读取状态摘要：版本线/快照哈希/lineSnapshot/维护债务与档位/债务来源与待人工裁决/维护观测/最近信号数/组件健康 + **自迭代状态段**（最近判定结论与原因、信号计数、债务快照、门禁逐项与被拒原因、开关面、三线领先落后关系）；参数 `line` 指定线、`evolution:false` 只看运行状态 |
| `kern_bench` | `runtime.benchV2()` | 运行 v2 契约基准（无 modelAdapter → 回放；有 → 真实 + LLM judge 双判；参数 line/persist） |
| `kern_evolve` | `runtime.runEvolutionNow()` | 触发演化全链（信号判定 → 候选生成/验证/晋升 → 晋升检查 → 维护量子） |
| `kern_switch` | `runtime.switchLine()` | 切换版本线（校验+快照重建+激活记录；无空白会话守卫） |
| `kern_memory` | `runtime.retrieveMemory()` | 记忆检索（scope 覆盖链/kind 过滤/通道选择/价值排序；只读不记 episode） |
| `kern_profile` | `runtime.upsertProfile()` | 登记/更新用户画像（Profile 记忆 Global 作用域） |

### 11.2 命令

`runtime/plugin.ts` 注册：

- `/mode <initial|stable|latest>`：版本线切换（空白会话守卫，见 §4）。
- `/bench`：冻结基准（缺省 v2 契约基准 20 任务——契约四要素 input artifact +
  requirement + output_schema + verifier rules 单一权威，fixture 由 reference 纯函数
  生成；无 modelAdapter → 回放执行器，有 → 真实执行 + D6 全任务双判 LLM judge
  （仅旁证不作晋升硬信号）；明细落盘 `workspace/.omb/bench/<mode>-v2-<line>-<ts>.jsonl`；
  `config.benchVersion: 'v1'` 切回 legacy 录制基准——两版本并存可对比
  「修复了基准契约」与「模型真的进步」）。
- `/evolve now|share|absorb <id>`：见 §7.7。

---

## 12. 运行时契约三层

`runtime/runtime-contract.ts`（W5，宿主架构研究结论：DSH systemPrompt.context
多 section + DSH skill 系统渐进层）：

1. **第一层固定契约**：`OMB_RUNTIME_CONTRACT`（静态常量、≤500 字符硬约束①，
   每次请求注入的极小固定上下文——cognitive:contract section，见 §5.1）。
2. **第二层动态能力行**：`buildCapabilitiesLine`（纯函数、确定性）——
   capabilities/components 名称 + 语义裁判可用性 + 候选验证通道；
   全部未知 → 「当前无额外能力面」（cognitive:capabilities section）。
3. **第三层 omb-runtime 技能**（DSH 原生 skill 渐进层）：仓库内版本化
   `skills/omb-runtime/SKILL.md`（提交即版本化）→ 插件启动时镜像到
   `<dshHome>/skills/omb-runtime/SKILL.md`（幂等：内容一致跳过；不一致原子写
   tmp+rename；尽力而为失败降级记录不抛；测试环境不写真实 ~/.dsh 除非显式注入
   dshHome）→ DSH skill-filesystem 默认扫描 `<dshHome>/skills` → 模型 skill 工具
   目录可见、**按需加载、零固定 token 成本**（严格优于全塞固定上下文）。

---

## 13. 数据落盘清单

`workspace/.omb/`（gitignored，`config.cognitiveRoot`）：

| 路径 | 内容 |
|---|---|
| `events.db` | SQLite 事件库（DSH 事件入链 + 认知事件，P7 唯一事实源） |
| `memory.db` | SQLite + FTS5 记忆库 |
| `checkpoints/` | finalizeTurn 工作状态检查点（session/flush 触发） |
| `lines/<line>/pointer` + `lines/<line>/<commit>/` | 线指针 + 三线物化快照（不可变） |
| `activation/` | 版本激活记录（pending / completed / rolled_back） |
| `bench/<mode>-v2-<line>-<ts>.jsonl` | 基准明细 |
| `.evolution/signals/<date>.jsonl` | 演化信号 |
| `.evolution/shadows/` | exposure.log + exposure-<date>.jsonl（shadow 曝光/outcome） |
| `.evolution/decay/<ts>.json` | 能力衰减记录 |
| `.evolution/repair/<ts>.json` | 重验证审计记录 |
| `.evolution/verification/{facts,baselines,tasks,verifiers}/` | 验证数据面四库 |
| `.evolution/verification/debt.jsonl` | 验证债务队列 |
| `.evolution/verification/verifier-evolution.jsonl` | 验证器替换审计 |
| `.evolution/artifacts/index.jsonl` | 制品索引 |
| `.evolution/maintenance-observations/<date>.jsonl` | 维护观测 |
| `.evolution/candidates/` | CandidatePool 信任池（untrusted/trusted/rejected/error + 0000-bootstrap） |
| `.evolution/registry/` | 共享对象本地 registry（/evolve share/absorb） |
| `.evolution/debt.json` | 维护债务 |
| `.evolution/README.md` | 演化工作区说明 |

---

## 14. 已知留待与边界

- **LLM judge 双模型共识不实现**（S9 裁决）：普通用户不可能长期支付两个以上大模型；
  当前单模型 + 不确定性升级（UNKNOWN 入债务队列，attempts≥2 转低频人工）。
- **ΔInfoValue 反馈修正与成本标定待数据**（§17）：`estimateInfoValue` 权重、
  `maintenance_costs`、`PROCESS_QUALITY_VECTOR_KEYS` 综合权重、`context.yaml`
  kind_costs 均为占位初值——Retrieval Episode 归因反馈修正 + 真实维护观测数据
  积累后按 ROI 标定（改 YAML 即生效）。
- **组件生态当前仅 memory-retrieval**（`memory/memory-retrieval.ts`，manifest 声明
  能力 `memory.retrieve`；能力注册表/组件注册表/健康检查/批量 dispose 回滚机制
  已就绪，组件扩展留后续）。
- **实验性声明**：本预设会挂载进 DSH 会话并注入上下文（认知契约/能力行/每轮投影）、
  执行维护与演化操作（turn 收尾入队维护任务、环境指纹检查、候选晋升可能推进
  trusted-latest/stable 指针）、修改 `workspace/.omb/` 运行数据与 `~/.dsh/skills/`——
  **可能影响 DSH 历史会话的加载/重启行为**（bootStable 启动校验 + 自动回退、
  /mode 切换影响运行时快照）；使用前建议备份，详见 README 实验性警告。
- 其它明确不做：任务库当前无执行器消费（注册面留后续）；shadow 真实放量依赖真实
  会话流量；L3 语义层盲化 judge 占位；gpu/cuda 指纹无探测缺省。
