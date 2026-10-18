# R7 —— 根本性重构：无「常驻推理/上下文提示」的 DSH 原生组合

> 输入：`docs/v3.7-redesign.md`（已裁决施工面）、`docs/research/2026-10-18-{memory,reasoning,context,dsh-capabilities}.md`（四份研究报告）、本线程前两份探针报告。
> 结论口径：本文件只写**可裁决的组合方案**；不写代码、不改仓库。所有"宿主原生面"的证据为 `file:line`；未端到端验证的设计标 `[设计]`。
> 用户前提核对：**"reasoning/context 可能是净负担"在原代码里已被证据证实**——reasoning 在默认工作点（`standard` + `tight`）注入 **0 字符**、`omb_focus` 不改真实 `reasoningEffort`、`omb_verify` 是循环依赖（reasoning §0 第 1/2/4 条）；context 模块对全部 prompt token 的贡献是 **0.00035%**、`admission`/`context:pressure` 服务**零生产消费者**（context §0 第 1/2/4 条）。所以本轮不是"把提示写得更好"，而是**把常驻面清零，把能力换成"宿主原生的按需面"**。

---

## 0. 判决（5 句）

1. **用户前提成立**：reasoning 的默认工作点在**注入 0 字符**的同时还花 **≈400 token/请求的 schema**（3 工具 1,442 字符）且不改变真实 `reasoningEffort`；context 模块对全部 prompt token 的贡献是 **0.00035%**、核心 API **零生产消费者**。所以它俩在默认模式下是"负收益的常驻面"，不是"还差一点接上"。
2. **根治方向不是改提示词，而是换载体**：把"每请求付费的常驻面"换成"按需付费的宿主原生面"——skills（目录+正文）、工具结果、会话事件、预设（模式）。
3. **三个组合**：A **零常驻**（默认模式只有一句 ≤24 字符 + 6 个工具，模型面 ≈90–110 token/请求，较现状 −75%~−80%）；B **模式即预设**（`omb` ⊂ `omb-deep` ⊂ `omb-team`，推理=技能包+真 effort，只在选择时付费）；C **隔离即上下文管理**（探索进 subagent/ralph，主会话只收结论，主会话增量从 40–80k 降到 1–3k token 量级）。
4. **推荐路线 = A 做默认，B 做能力容器，C 做用法纪律**；被替代的 OMB 面：`omb_method`/`omb_focus`/`omb_verify` 三工具、六段易变注入、context 模块全部裁决 API。
5. **最大的两个风险**：技能目录/工具数同样要付费（R1/R2）；模式降级会因"删工具"重开缓存序列（R3，靠单调嵌套规避）。

---

## 1. 中心法则（先立规矩，再谈组合）

DSH 0.2.1-rc.2 的成本模型只有两条通道会让 OMB 付费：

| 通道 | 何时付费 | 缓存性 | 判据 |
|---|---|---|---|
| **系统提示 sections**（`ctx.systemPrompt.section`） | 每个请求 | 静态文本 ⇒ 只在首请求付费；**一旦变化就是前缀变化** | `packages/core/system-prompt/src/index.ts:131-165,478-486` |
| **工具 schema**（`ctx.tools.register`） | 每个请求 | 工具目录变化 ⇒ 请求前缀变化；本 profile 的 `deepseek-flash` 配了 `toolUpdate: addition-only`，**只增不减**时可增量 | `packages/core/tools/src/index.ts:1071,1268`；`C:\...\profiles\web\cordis.patch.yml:18-19`（`systemPromptUpdate: in-history` + `toolUpdate: addition-only`） |
| （非付费通道）运行时 **contexts**（`ctx.systemPrompt.context`）、会话事件、投影、skill 正文、工具结果 | 只在被拉取/被注入的那一步 | 追加进历史，不改前缀（旧前缀仍可命中） | `system-prompt/src/index.ts:170-179`（CONTEXT_ORDERS）、`tool-skill/src/index.ts:167-205` |

**推论（本轮设计的硬约束）**：

1. **常驻字节只允许存在一句"触发句"**（记忆库的 ≤24 字符），其余全部下沉到：skill 正文（按需）、工具结果（按需）、诊断工具（按需）、会话历史（宿主压缩管）。
2. **能力多寡必须用"可选（preset/模式）"表达，而不是"常驻段落"**。宿主已经把这套机制做出来了：agent preset 里注册的工具/段落是**该 agent 私有**的（`tool-skill` 注释原文："a plugin mounted inside an agent preset registers for that agent alone"，`packages/skill/tool-skill/src/index.ts:207-213`；`packages/experimental/tool-agent-team/src/index.ts:173-192` 就是这么把 `team:policy` 段 + 5 个团队工具挂在 `scoped.*` 上的）。
3. **模式的切换要"单调叠加"**：本 profile 的模型声明 `toolUpdate: addition-only` ⇒ 从 `omb` 升到 `omb-deep`（只加工具）可容忍缓存；降级（删工具）会重开请求序列。**设计成 `omb ⊂ omb-deep ⊂ omb-team` 的嵌套集合，降级=新会话。**

---

## 2. 原生面清单（用不用 / 删什么）

| # | 宿主原生面 | 契约（要点） | 源 | realm / isolate | 每请求成本 | OMB 该怎么做 | 因此删掉 OMB 的什么 |
|---|---|---|---|---|---|---|---|
| 1 | **skills：目录 + `skill` 工具（渐进披露）** | 目录 = 每个 skill 的 `name + description`（描述上限默认 500，可配 `catalogDescriptionMaxLength`）；正文**不常驻**，由 `skill` 工具调用后作为 **instructions 类用户消息**注入本步 | `packages/skill/skill-filesystem/src/index.ts:28,45,112-133,730-760`；`packages/skill/tool-skill/src/index.ts:83-91,163-205` | 根（`skills` 服务） | 目录条目 ≈ `len(name)+len(description)`；`skill` 工具 schema ≈ 300 字符；正文只在调用那一步 | **把 reasoning 的 8 张方法卡整体改成 skill 目录**（正文=卡正文），描述压到 ≤120 字符 | **`omb_method` 工具及其 schema**（−≈300 字符/请求）、方法卡索引代码 |
| 2 | **agent-team（团队模式）** | 预设级组合：`team:policy` 段（order 600）+ `team:identity` 上下文 + 5 工具（`spawn_teammate`/`send_message`/`list_agents`/`wait_agent`/`interrupt_agent`），全部**挂在预设的 agent 作用域** | `packages/experimental/tool-agent-team/src/index.ts:14,173-192,192-260`；bundle：`OPTIONAL_BUNDLES` 含 `dsh-experimental-agent-team-profile`（`packages/boot/app-boot/src/profile.ts:229`） | 预设级（agent scope） | 只在 team 模式付费：1 段 + 5 工具 schema | **做成独立预设 `omb-team`**，默认模式不装 | 不删 OMB 代码，但"要并行就 spawn OMB 模块"的说法删掉 |
| 3 | **subagent / subagent_fork / workflow（上下文隔离）** | `subagent` 新上下文（fresh，无父会话历史）；`subagent_fork` **继承已完成回合**；`workflow` 脚本化扇出；每次调用是一个独立 agent 会话 | OMB 预设行 `cordis.patch.yml:233-259`；`packages/core/tools/src/index.ts`（`subagent_fork`/`workflow` 工具面） | 预设级（`workflowEngine` 隔离，`cordis.patch.yml:237`） | 0 常驻以外：schema 已由宿主付费 | **主会话只留结论**：探索/长链推理进 subagent，父会话增长 ≈ 结果长度（1–3k 字符）而不是全过程（数十 k） | 删"循环检测要在主会话里做"的思路（见 #6） |
| 4 | **ralph（新鲜 agent 迭代）** | 每轮新 agent、无父会话种子，workspace 当长期记忆 | `OPTIONAL_BUNDLES` 含 `dsh-experimental-ralph-bundle`（`profile.ts:225`）；本 profile 已启用（`package.json:16`） | 预设/bundle 级 | 0 | 长跑任务（重构、批量迁移）用 ralph，而不是在主会话里堆历史 | —— |
| 5 | **plan / goal / todo** | `plan-mode`（隔离 `planMode`）+ `exit_plan_mode`；`goal`（`create_goal`/`update_goal`）；`todo_write`（`allowParallelInProgress`） | OMB 预设行 `cordis.patch.yml:176-200,262-265` | 预设级（`planMode` 隔离） | plan 段只在该模式；goal/todo 是 schema 成本 | plan 收进 `omb-deep`；goal/todo 保持宿主默认（不要 OMB 再造状态机） | 删 OMB 侧"档位/循环"与 todo 的耦合（reasoning §1 的 `controlForBand`） |
| 6 | **hooks（外部命令）** | CC/Codex 方言桥：`configPath` 指向 `hooks.json` 或带 `hooks` 键的 settings；支持 `SessionStart`、prompt/tool pre/post、`Stop`、subagent 事件；输出经 `mergeHookOutputs` 合并为决策 | `packages/experimental/hooks-claude-code/src/index.ts:3,50-59,102`；协议库 `packages/experimental/hook-protocol/src/index.ts:1-6` | 根（bridge） | **0**（不进提示，进程外执行） | **把"循环提示/风险闸门"做成可选 hook**（PreToolUse 上比对最近 N 次相同工具+参数，命中就 deny/ask 并写 stderr） | 删 reasoning 的循环提示常驻逻辑（它 553 次注入、精度未测，reasoning §0 第 6 条） |
| 7 | **auto-review（授权闸门，不是质量复审）** | `Auto` 权限预设下，每个原生工具调用（含 PTC 内层）执行 body 前被 LLM 审一次；deny 按审批策略问人/直接拒 | `packages/experimental/auto-review/src/index.ts:1-7` | 根（实验包，`OPTIONAL_BUNDLES` `profile.ts:232`） | 每次工具调用一次模型调用（**贵**） | **只在 danger 场景开**（如用户开 `danger-full-access`）；**不得**当"第二意见 reviewer" | 删 `omb_verify` 的"结论复核"幻想（reasoning §0 第 4 条） |
| 8 | **session-search（5 工具）** | 见 R4 报告：根 `sessionQuery`（精确读/标题/谱系可用）+ 隔离组 FTS 实例（搜索；30s 上限内跑不完冷建） | 本线程 `2026-10-18-dsh-capabilities.md` §2；`packages/experimental/session-search/cordis.patch.yml:1-14` | 工具在根、FTS 实例在隔离组 | 315 字符提示 + 3,976 字符 schema ≈ **1,190 token/请求**（实测） | 默认模式**不启用**（省钱）；`omb-deep` 里用 `session_trace`/`session_event_read`（不需索引、秒回）；搜索修好后再评估 | 删 OMB 记忆里"自己解析会话日志"的路径，改走根 `sessionQuery` 精确读 |
| 9 | **compaction / tool-result-pruner** | 压缩：`thresholdRatio 0.8`、`headroomTokens 65,536`、`retainRatio 0.16`；裁剪：8192/4096/1024 | `packages/compaction/compaction-basic/src/config.ts:20,23,75-80`；`compaction-tool-result-pruner/src/config.ts:11-16` | 预设 `compaction` 组隔离（OMB `cordis.patch.yml:216-232`） | 0 常驻；压缩触发时一次模型调用 | 保持现状（宿主做）；OMB 只读事件 | 删 context 模块对"压缩后再造一层预算"的一切想法 |
| 10 | **systemPrompt sections vs contexts** | sections=系统提示（含 order 分配，`TOOL_SESSION_QUERY:2300`、`TEAM_POLICY:600`…）；contexts=运行时上下文（`WORKING_DIRECTORY:100`、`HARNESS_SOURCE:200`…） | `system-prompt/src/index.ts:131-165,170-179,478-496` | 根 | sections 静态=一次；contexts 每次变的段=每轮新前缀 | **OMB 只保留 1 个 ≤24 字符 section；其余全删**；诊断读数走工具结果，不走 context | 删 reasoning 的六段易变注入（reasoning §1.2：默认 0 字符，最坏 500+） |
| 11 | **会话投影** | `contextPressure`(pressureTokens/projectedTokens/contextWindow)、`tokenUsage`、`contextBreakdown`；注意 host state 形状（`{totals,last}`、`{systems,surfaceTokens,breakdown}`） | `packages/llm/token-meter/src/projection.ts:13-77`；R4 报告 §1 行 4；context §0 第 4 条指出 OMB 现在读错形状 | 根 | 0 | 修 OMB 桥的读法（v3.7 T1）；**只用于 `omb_status` 诊断工具** | 删 context 模块的 `select/marginalValue/measuredCost`（零消费者） |
| 12 | **modelSelection / reasoningEffort** | `agent/request` waterfall → `request/header.config.reasoningEffort`；DeepSeek 支持 `off/low/high/max`；不支持会抛 `UNSUPPORTED_REASONING_EFFORT` | 本线程 `2026-10-18-probe-followup.md` Q1（实测）；`llm-deepseek/src/model-info.ts:6-32` | 根或**预设级**（预设内注册 = 只对该 agent 生效） | 0（改的是请求头；改档=前缀变化） | **档位=预设选择**（`omb`/`omb-deep` 两档），配合一条预设级 `agent/request` 监听器；不用逐请求工具 | **删 `omb_focus` 工具**（它现在只改文字，reasoning §0 第 2 条） |
| 13 | **commands（斜杠命令）** | `commands` 服务；命令不进 schema、几乎零成本 | `packages/interaction/commands/src/index.ts:277`；OMB 已用（`dsh/plugin.ts:66`） | 根 | ≈0 | `/omb-focus`、`/omb-deep`、`/omb-privacy` 用命令；**不要为这些功能造工具** | 删对应工具的参数面 |
| 14 | **plugin-market / plugin-manager** | 可安装 bundle（含 skill bundle）；`OPTIONAL_BUNDLES` 12 个 | `profile.ts:223-236`；`packages/boot/plugin-manager/src/index.ts:292-300` | 根 | 随装什么而变 | **把 OMB 的"推理技能包"做成可安装/可卸载的 bundle**（用户按需装），而不是 OMB 内核的一部分 | 删"推理是 OMB 必装件"的定位 |
| 15 | **agent-instructions（项目记忆）** | `AGENTS.md` 兼容文件在首个请求前进入**durable context**；`maxBytes: 65536` | `packages/context/agent-instructions/src/index.ts:2-4,86-147`；OMB 预设行 `cordis.patch.yml:122-125` | 预设级 | 每会话一次（进历史，不是每请求） | **项目级事实写进 `AGENTS.md`（宿主加载）；跨会话结论留在 OMB 记忆库** | 删 context 模块"项目上下文要 OMB 推"的定位 |
| 16 | **agent preset registry（模式容器）** | 预设 = 一组插件行；每会话选一个；预设内注册=agent 私有 | `cordis.patch.yml:186-285`；`packages/preset/agent-preset-registry/src/mount.ts`（R5 已验） | 预设级 | 取决于预设内容 | **本方案的核心容器**：`omb`/`omb-deep`/`omb-team` 三个预设 | 删"所有 OMB 认知行必须在根层"的旧约束（它只是为了插件页可拨动） |
| 17 | **upgrade-guide 纪律** | 0.1.7→0.2.1-rc.2 的破坏性变更清单 | `docs/upgrade-guide/v0.2.1-alpha.{1..4}/`、`v0.2.0-rc.2/`、`v0.1.7-rc.2/` | — | — | 每次升 rc 先跑 guide 里的 rename/scope 清单 | 删"抄一份创造模式的工具行"里过期的行 |

---

## 3. 三个激进组合

### 组合 A —— **「零常驻」**（最小面：一句话 + 工具 + 真相）

**命题**：OMB 在默认模式下**没有任何推理/上下文提示**；模型只从两处知道 OMB 存在：① 一条 ≤24 字符常驻句（记忆触发）；② 工具描述本身（JIT 说明）。

**行/服务影响**

```yaml
# profile 根层：只留内核 + 记忆 + 制品 + 诊断
- id: omb-kernel        # 不变
- id: omb-memory        # 去掉 residentHint 之外的任何注入；新增 ≤24 字符触发句
- id: omb-memory-vector # 不变
- id: omb-profile       # 不变（无模型面）
- id: omb-artifact      # 不变（omb_files）
# 删除：omb-reasoning / omb-context 两行（模块保留代码一个版本做回滚）
```

**服务面**：`prompt:omb-reasoning`（PromptContribution）、`reasoning:loop`、`reasoning:methods`、`context:pressure/select/marginalValue/measuredCost` 全部下线；`omb_status` 扩为唯一诊断工具（并入压力/拉取/压缩/cache 读数）。

**工具面**：`omb_status`、`omb_recall`、`omb_remember`、`omb_relate`、`omb_forget`、`omb_files` = **6 个**（删 `omb_method`/`omb_focus`/`omb_verify`）。
**能力去哪了**：8 张方法卡 → 8 个 skill（**只在 `omb-deep` 预设里出现**，见组合 B）；档位 → 预设选择；复核 → 高风险时显式 subagent。

**token 账**（按 v3.7 的实测基线折算，字符≈token/3.6）：

| 项 | 现状 | A | 差 |
|---|---|---|---|
| OMB 系统提示段 | 71 字符 ≈ 20 token | **24 字符 ≈ 7 token** | −13 |
| OMB 工具 schema | 10 工具；其中 reasoning 3 工具 **1,442 字符 ≈ 400 token**（v3.7 §4 实测） | 6 工具；删掉的 3 个 schema −1,442 字符 | **−≈430 token/请求** |
| 易变注入 | 默认 0，最坏 500+ 字符 | 0（不存在） | 0 ~ −140 |
| 合计（模型面） | **≈500–520 token/请求**（v3.7 验收基线） | **≈90–110 token/请求** | **−75%~−80%** |
| 缓存 | 静态段不抖；`controlForBand` 按压力切换会抖 | 只有一个静态句 ⇒ 首请求后零抖动 | 更稳 |

**验收测试**（可执行断言）：

1. `tests/dsh/zero-resident.test.ts`：新会话首个 `request/header` 里，OMB 贡献的字符数 = 24（允许 0），且**不含**任何 `omb_reasoning`/`context:` 段。
2. 工具清单 = 6 个 `omb_*`；`ctx.tools.get('omb_method') === undefined`。
3. 同进程两次渲染的常驻句字节相同（缓存稳定判据，沿用 v3.7 M1 的测法）。
4. 会话 20 回合内：`request/header` 的 OMB 字符数**不随回合增长**（无易变注入）。
5. 现有回归：`omb_recall` 使用率不下降（≥v3.7 目标 30% 的 20 回合实验口径）。

**回滚**：删两行 = 已回滚；模块代码保留一个版本；`omb-reasoning` 的 config 开关 `enabled: false`（原行恢复即回到旧行为）。

---

### 组合 B —— **「模式即预设」**（推荐主线：`omb` ⊂ `omb-deep` ⊂ `omb-team`）

**命题**：推理能力不是一个"始终挂着的组件"，而是**用户显式选择的模式**；每个模式是一个 agent preset，装不同的 skill 目录与宿主插件行。OMB 记忆与制品留在根层（所有模式共享）。

**三个预设的精确行**

```yaml
# ── 预设 1：omb（默认，= 组合 A 的模型面）──────────────────────────
- id: preset-omb
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: omb
    name: 大肥鱼模式
    order: 10
    plugins:
      - { id: persona, name: '@deepseek-ai/dsh-persona', config: { prefix: '你是运行在「大肥鱼模式」…' } }
      - { id: agent-instructions, name: '@deepseek-ai/dsh-agent-instructions', config: { maxBytes: 65536 } }
      - { id: time-context, name: '@deepseek-ai/dsh-time-context' }
      # …宿主默认工具行原样保留（tool-fs/tool-pwsh/tool-jobs/tool-web/skill-filesystem/tool-skill/present…）
      - { id: compaction, name: cordis:group, group: true, isolate: { compaction: true, toolResultPruner: true },
          config: [ {id: compaction-basic, …}, {id: command-compact, …}, {id: tool-result-pruner, …} ] }
      - { id: delegation, name: cordis:group, group: true, isolate: { workflowEngine: true },
          config: [ tool-subagent, tool-subagent-fork, workflow-ptc, tool-workflow ] }
      - { id: tool-todo, name: '@deepseek-ai/dsh-tool-todo', config: { allowParallelInProgress: true } }
      # 这里【没有】plan/ralph/agent-team/session-search/skill 的推理包

# ── 预设 2：omb-deep（`omb` + 推理技能 + 计划 + 真 effort）──────────
- id: preset-omb-deep
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: omb-deep
    name: 大肥鱼·深潜
    order: 11
    plugins:
      # 与 preset-omb 相同的行（逐行复制，别用继承——DSH 没有预设继承）
      - { id: plan-mode, name: '@deepseek-ai/dsh-plan-mode', config: { section: '<宿主默认 plan 段>' } }   # 放在 planning 组里
      - { id: skill-reasoning, name: '@deepseek-ai/dsh-skill-filesystem',
          config: { customSkillDirs: [ '!!js <OMB包目录>/skills/reasoning' ] } }   # 与默认 skill 目录并存
      - { id: tool-skill, name: '@deepseek-ai/dsh-tool-skill' }
      - { id: omb-effort, name: '@omb/reasoning-effort' }   # OMB 新薄行：预设内注册 agent/request 监听器
      - { id: tool-subagent, … }                             # 已有；深潜模式允许子代理
      # 可选：{ id: tool-session-trace, name: '@deepseek-ai/dsh-tool-session-query' } 的 trace/read 子集（见 R4 报告）

# ── 预设 3：omb-team（团队模式 = omb-deep + 团队）────────────────────
- id: preset-omb-team
  name: '@deepseek-ai/dsh-agent-preset'
  config: { id: omb-team, name: 大肥鱼·团队, order: 12, plugins: [ …omb-deep 的全部…, 团队行 ] }
      # 团队行可直接复用官方 agent-team bundle 的预设（OPTIONAL_BUNDLES: dsh-experimental-agent-team-profile）
```

**关键机制（都有源码依据）**

1. **预设内注册 = agent 私有**：`scoped.systemPrompt`/`scoped.tools` 的写法是宿主自己的产品级先例（`tool-agent-team/src/index.ts:173-192`；`tool-skill/src/index.ts:207-213` 的注释直言"mounted inside an agent preset registers for that agent alone"）。⇒ 深潜模式的 reasoning 技能、plan 段、effort 监听器**只对深潜会话可见**，默认模式 0 成本。
2. **effort 不用工具**：`@omb/reasoning-effort` 行在**预设 ctx** 里注册 `ctx.on('agent/request')`，因为作用域在 agent 上，只对该会话生效，**不需要 sessionId 映射**（比根 ctx 方案更干净；Q1 探针已证明返回的 config 会落到 `request/header`）。若担心与宿主 model-selection 的注册顺序，见风险 R5。
3. **不 import `@deepseek-ai/*`**：预设行通过 `ctx.get('tools').register(...)` / `ctx.on(...)` / `ctx.get('systemPrompt')` 访问；OMB 现有 `toHostTool`（`dsh/tools.ts`）已产出宿主形状。**判据**：`tests/dsh/no-host-imports.test.ts` 保持全绿。
4. **能力是"模式"不是"工具"**：档位（quick/standard/deep）与宿主 effort 的映射写死在预设里（deep→`max`，默认预设→`high` 或继承），**不再有 `omb_focus` 工具**。若确实需要会话内临时切换，用**命令**（`/omb-effort max`）而不是工具。

**token / 缓存账**

| 场景 | 每请求 OMB schema | 提示段 | 说明 |
|---|---|---|---|
| `omb`（默认，多数会话） | 6 工具 ≈ 1,000 字符 ≈ 280 token | 24 字符 | 与组合 A 相同 |
| `omb-deep` | 6 + `skill`(≈300) + trace/read(≈800) + plan(0 工具，段在系统提示) ≈ 1,000+1,100 ≈ 2,100 字符 ≈ 580 token | 24 + 宿主 plan 段 | **只在深潜会话付费** |
| `omb-team` | deep + 5 团队工具 ≈ +1,500 字符 ≈ +420 token | + team 段 | 只在团队会话付费 |

**缓存注意**：`omb → omb-deep` 是**只增工具** ⇒ 命中 `toolUpdate: addition-only`（profile `cordis.patch.yml:18-19`），可增量；`deep → omb` 删工具会重开请求序列 ⇒ **降级请开新会话**。

**验收测试**

1. `tests/dsh/preset-composition.test.ts`（已存在，扩展）：三个预设逐行与 `packages/bundle/web-app/presets/cordis.patch.yml` 对齐；`omb` 预设内**不存在** `plan-mode`/`skill-reasoning`/`omb-effort`/团队行。
2. `tests/dsh/preset-scope.test.ts`：在 `omb` 会话里 `ctx.tools.get('skill')` / `ctx.tools.get('spawn_teammate')` 为 `undefined`；在 `omb-deep` 会话里存在；`request/header` 的 effort 分别为 `high`（或继承）与 `max`（**实测口径**：读会话日志 `request/header` 事件的 `config.reasoningEffort`）。
3. `tests/dsh/mode-promote.test.ts`：同一会话 `omb → omb-deep` 后，工具目录是**超集**（`addition-only` 判据），且没有 `request/header` 的 `reason: 'series'` 重开（除非宿主判定窗口溢出）。
4. skill 目录出现判据：`omb-deep` 会话的 `skill-catalog` 事件里只有 reasoning 包描述的条目（≤N 条，N = 技能数），正文只在 `skill` 调用后出现。
5. 回滚判据：把预设行切回 `preset-omb` 即行为等价于组合 A。

**迁移**（从 8 模块/10 工具）

| 现组件 | 目标形态 | 迁移动作 |
|---|---|---|
| `kernel` | 保留（服务总线/存储/压力桥/工具桥） | 只保留根层；工具桥改为"根工具 + 预设工具"两路 |
| `memory` | 保留，但**写路径与触发重做**（memory §5：准入/可核验/触发句） | 常驻句 ≤24 字符；不加第二个常驻 |
| `memory-vector` | 保留（中文检索必须留，memory §4.1：宿主 `fts5(unicode61)` 搜不到中文） | 不动 |
| `profile` | 保留（无模型面） | 不动 |
| `reasoning` | **拆成 skill 包 + 预设行 + 可选 hook** | 方法卡→`skills/reasoning/*.md`；`omb_focus`→预设/命令；`omb_verify`→删；循环提示→hook |
| `context` | **删模块**，读数并入 `omb_status` | C1/C2 先行；终局删代码（context §4 方案 C：−3,346 行） |
| `artifact` | 保留（`omb_files`） | 不动 |
| `notify` | 保留（无模型面） | 不动 |

---

### 组合 C —— **「隔离即上下文管理」**（深度工作的上下文预算靠 fork/subagent/ralph，不靠压缩）

**命题**：上下文管理的正确手段不是"在提示里教模型省 token"，而是**把工作放进独立的会话上下文**；主会话只保留可复用的结论。

**机制与行影响**

1. **探索进 subagent（fresh）**：读 20 个文件、跑 10 条命令的探索，父会话只增加 subagent 的结果（1–3k 字符）。工具行已在预设里（`tool-subagent`/`tool-subagent-fork`/`tool-workflow`）。
2. **深链推理进 `subagent_fork`**：需要父会话已完成的结论作为种子的，用 fork（继承已完成回合，`subagent_fork`）。
3. **长跑迭代进 ralph**：`dsh-experimental-ralph-bundle`（本 profile 已启用，`package.json:16`）每轮新 agent、workspace 当记忆。
4. **主会话的"结论卡片"来自 OMB 记忆**：subagent 结束后，父会话只写一条 episodic + 一条 semantic（走现有 `omb_remember` 的准入），下次靠 `omb_recall` 拉。
5. **诊断只在被问时给**：`omb_status` 的上下文段报"本会话 compaction 次数/最近遮蔽 token/cache 命中率"（v3.7 C3），不常驻。

**token 账**（数量级，`[设计]` 估算，用本机实测的压缩/裁剪参数校验）

| 场景 | 主会话上下文增长 | 备注 |
|---|---|---|
| 直接在主会话探索 20 文件 | +40–80k token | 会触发 compaction（0.8 阈值）或强制 compact，成本高（context §0 第 8 条：摘要输入 17.8M token、缓存读仅 1.17%） |
| 用 subagent 探索 | **+1–3k token**（结果文本） | 子会话的 40–80k 随会话结束释放 |
| 用 ralph 长跑 | 主会话 +0，workspace 承载 | 适合批量迁移 |

**验收测试**

1. `tests/dsh/context-isolation.test.ts`：同一任务，主会话 `promptTokens` 增量 < 5k（A/B 对照：直接探索 vs subagent）。
2. compaction 触发次数不上升；`tool-result-pruner` 的 prune 次数不上升（pruner 事件可数）。
3. 父会话的 `subagent` 工具结果里必须出现"结论 + 未决项"两段（模板由 skill 提供，不常驻）。

**回滚**：不需要专门开关——它就是"怎么用工具"的纪律 + 一个 skill。

---

## 4. 推荐路线（裁决表）

| 决策 | 选 | 理由 | 不做 |
|---|---|---|---|
| 常驻推理/上下文提示 | **清零（组合 A）** | reasoning 默认注入 0、context 贡献 0.00035% | 继续加段落 |
| 推理能力表达 | **技能包 + 模式（组合 B）** | skill 正文按需、catalog 只在 deep 模式付费；预设内注册=agent 私有（`tool-agent-team` 先例） | 第二个常驻提示、新工具 |
| 档位 | **预设选择 + 预设级 `agent/request`** | Q1 实测可行；不用 sessionId 映射 | `omb_focus` 工具 |
| 上下文 | **诊断工具 + 项目记忆（AGENTS.md）+ 隔离（组合 C）** | 宿主已有 agent-instructions/compaction/pruner/projections | context 模块、admission API |
| 记忆 | 保留并重做写/查/报（memory §5） | 中文检索必须 OMB 自持 | 把会话历史搬进 OMB |
| 团队/工作流 | 独立预设（`omb-team`）+ 宿主原生工具 | agent-team 已是预设级组合 | OMB 自造调度 |

---

## 5. 风险表

| # | 风险 | 证据/机制 | 缓解 |
|---|---|---|---|
| R1 | **skills 目录本身也不免费** | 每条目录 = name + description（上限默认 500，`skill-filesystem/src/index.ts:28`） | OMB 技能描述硬限 ≤120 字符；技能数 ≤8；只在 deep 预设暴露 |
| R2 | **工具数量**（对模型的选择压力与 schema 成本） | 宿主默认已 ~20+ 工具；OMB 再加 6（A）或 11（deep） | 默认模式 6 个上限；deep 模式用"只增"策略；不新增第 11 个 OMB 工具（沿用 v3.7 纪律） |
| R3 | **缓存失效** | 系统提示/工具目录变化=前缀变化；`toolUpdate: addition-only` 只容忍增加 | 模式集合做成单调嵌套；降级=新会话；常驻句逐字节稳定 |
| R4 | **预设行在插件页不可寻址** | R5 实测：预设内行 `readOnlyReason: 'unaddressable'` | 接受：模式级能力不做"插件页拨杆"；开关=切换预设（用户动作） |
| R5 | **预设级 `agent/request` 与宿主 model-selection 的注册顺序** | Q1 实测：先注册=最外层=最终生效；预设行注册于 agent 创建期，晚于 root，但**与** session-controller 的 `installModelSelection` 先后未验 | 验收测试里直接读 `request/header.config.reasoningEffort`；若不生效，改为根 ctx 监听器 + sessionId 映射（Q1 已验证根方案可行） |
| R6 | **不支持 effort 的 provider** | `resolveCallWithInfo` 抛 `UNSUPPORTED_REASONING_EFFORT`（llm/index.ts:900-940） | 监听器先 `ctx.llm.resolveModelInfo` 探能力；探不到就不设；监听器内 try/catch |
| R7 | **`omb_kernel` 在预设里的可见性** | 根服务对子 ctx 可见（isolate 只遮蔽被点名的名字；R5 组内可见性的反向证据） | 预设行用 `ctx.get('omb:kernel')` 探测式读取；取不到就降级为"无记忆的深潜模式" |
| R8 | **skills 触发率**（目录条目被忽略） | session-search 的教训：1,190 token/请求换 6 次使用（R4 §3） | 技能名与描述用"任务名"（如 `reasoning:debug`），并在 persona prefix 里写一句"需要时用 skill" |
| R9 | **删 context 模块的既得诊断** | 它是唯一模型可见诊断入口（虽然自相矛盾） | 先把读数折进 `omb_status`（v3.7 C1/C2/C3），再删代码；保留一个版本的回滚分支 |
| R10 | **预设不能继承**（DSH 无 preset extends） | 每个预设有自己的 plugins 列表 | 生成器维护"公共行"清单（脚本比对，`tests/dsh/preset-composition.test.ts` 已有同型护栏） |

---

## 6. 回滚矩阵

| 机制 | 回滚动作 | 代价 |
|---|---|---|
| 组合 A（零常驻） | 恢复 `omb-reasoning`/`omb-context` 两行 + 模块代码（保留一代） | 一个 `cordis.patch.yml` 改动 + 新会话 |
| 组合 B（模式即预设） | 预设选择切回 `omb`；或把 deep 行复制回 `preset-omb` | 新会话；缓存重开一次 |
| effort 映射 | 监听器行 `disabled: true`（预设内）或删行 | 立刻回到"effort 恒定" |
| 技能包 | 从预设里删 `skill-reasoning` 行 | 目录消失，正文不再可拉 |
| 隔离纪律（组合 C） | 不需要回滚（只是用法） | — |

门禁沿用 v3.7 §5：`npx tsc --noEmit` / `npx eslint .` / `npx vitest run` / `node scripts/build.mjs`。

---

## 7. 一手证据索引（本报告新增结论所依赖）

- 技能目录/工具：`packages/skill/skill-filesystem/src/index.ts:28,45,112-133,730-760`；`packages/skill/tool-skill/src/index.ts:83-91,163-205`（预设内注册=agent 私有，原文注释 `:207-213`）
- 团队=预设级组合：`packages/experimental/tool-agent-team/src/index.ts:14,173-192,192-260`；`packages/boot/app-boot/src/profile.ts:223-236`（`OPTIONAL_BUNDLES`）
- 系统提示 order 常量与双通道：`packages/core/system-prompt/src/index.ts:131-165,170-179,478-496`
- 投影字段与 host state 形状：`packages/llm/token-meter/src/projection.ts:13-77`；R4 报告 §1 行 4
- compaction/pruner 默认值：`packages/compaction/compaction-basic/src/config.ts:20,23,75-80`；`compaction-tool-result-pruner/src/config.ts:11-16`
- 模型 effort 能力与校验：`packages/llm/llm-deepseek/src/model-info.ts:6-32`；`packages/llm/llm/src/index.ts:900-940,976-990`
- `agent/request` 实测（根监听器接收、顺序、落到 `request/header`）：本线程 `2026-10-18-probe-followup.md` §Q1
- session-search 成本与冷建：本线程 `2026-10-18-dsh-capabilities.md` §2/§2.5；`2026-10-18-probe-followup.md` §Q2
- hooks 外部命令契约：`packages/experimental/hooks-claude-code/src/index.ts:3,50-59,102`；`packages/experimental/hook-protocol/src/index.ts:1-6`
- auto-review 是授权闸门：`packages/experimental/auto-review/src/index.ts:1-7`
- 项目记忆（AGENTS.md）原生加载：`packages/context/agent-instructions/src/index.ts:2-4,86-147`
- profile 侧模型能力声明（`systemPromptUpdate: in-history`、`toolUpdate: addition-only`）：`C:\Users\SuSeventeen\.dsh\profiles\web\cordis.patch.yml:18-19`
- 升级纪律：`docs/upgrade-guide/v0.2.1-alpha.{1..4}/`、`v0.2.0-rc.2/`、`v0.1.7-rc.2/`
