# R6 —— 真实 agent harness / 插件 / skill 生态的机制比较，与 OMB 推理+上下文的三个激进重构提案

- 研究线程：R6（生态/源码级比较），与 R1 记忆、R2 推理、R3 上下文、R4 DSH 能力、R5 realm 实证并行
- 输入：本机 DSH profile（`C:\Users\SuSeventeen\.dsh\profiles\web`）、DSH checkout `D:\Program\deepseek-harness` @ `dsh-v0.2.1-rc.2`、OMB 仓库、公开文档/源码/README（2026-10 抓取）
- 唯一写盘产物：本文件。未改代码、未跑 git、未装包、未改 profile。
- 证据分级：**[实测]** = 我在本机跑命令/读源码行/下载原文核对过的；**[报告]** = 官方文档、README、工程博客的原话（未独立复现数字）；**[推测]** = 由前两者推导、未端到端验证。
- 阅读顺序建议：§0 → §3（五个焦点问题）→ §5（提案）。§2 矩阵是证据底座，可后读。

---

## §0 结论速览（12 句判词）

1. **生态已经收敛到四个机制，OMB 只做了其中一个**：启动指令文件（CLAUDE.md / AGENTS.md / GEMINI.md）、**技能（Agent Skills 标准，正文按需加载）**、**确定性工作区索引（Aider repo map）**、**会话后后台记忆（Codex memories / Letta dreaming）**。OMB 做的是"自定义工具 + 按需召回"，既没有工作区索引，也没有事件驱动的捕获。**[报告]**
2. **没有任何系统做到"零模型调用的语义记忆"**。真正的自主捕获只有三条路：(i) 事件→文件确定性追加（hooks / git / 会话日志 / Ralph 的轮间交接）；(ii) 会话空闲后的后台抽取（Codex / Letta，**要花模型 token**）；(iii) 干脆不做（Cline，靠规则让模型自己记得）。所以 OMB 的"热路径零 LLM"并不与"自主捕获"冲突——冲突的是"自主捕获**结论**"这件事本身。**[报告]**
3. **"新会话深度理解项目"在生态里是个已被解决的便宜问题**：Aider 给整仓符号图，默认 **1,024 token/请求**（`map_tokens=1024`，无文件在聊天里时 ×8），tree-sitter + 依赖图 PageRank，零 LLM；Claude Code 用 **MEMORY.md 索引 200 行 / 25KB 上限**；Codex 把 AGENTS.md 链硬截在 **32 KiB**。OMB 这三个都没有：新会话只能靠工具调用现场发现。**[实测/报告]**
4. **"推理写成每轮注入的散文"正在被淘汰**。Claude Code 已把自定义命令合并进 skills（正文只在用到时加载、可用 `!`cmd`` 在加载时做**确定性数据注入**、可 `context: fork` 进子代理）；Codex 给技能列表设**硬预算（context 的 2% 或 8,000 字符，可配到 10,000 token）**；Cline/OpenHands/Letta 都接了同一套 `SKILL.md` 标准。OMB 的 8 张卡本质就是 skills，却做成了一个常驻 schema 的自定义工具。**[报告/实测]**
5. **OMB 的推理组件在语料里几乎没有被用过**：全库 391 会话只有 **34 次 `omb_method`**、**56 次 `omb_verify`**；`standard` 档注入 0 字符、`omb_focus` 只改文字（R2 §0/§1.3）。这与生态里"技能列表每个条目都在花每轮 token"的负结果叠加，构成"负优化"的直接证据。**[报告 R2]**
6. **负结果比正结果更有信息量，且全部指向"少注入、硬上限、确定性"**：Anthropic 自报 agent 比 chat 多 4× token、多代理多 **15×** 且"多数编码任务并行度低、模型还不擅长实时协调"；Claude Code 官方说"技能列表里每个技能**每轮**都花 token，不管用不用"（所以有 `/skill-doctor`）；长 CLAUDE.md "消耗更多上下文并降低遵循度"；Codex 的 32 KiB 与 2% 技能预算都是硬截断。**[报告]**
7. **记忆的演进方向不是图，是"小索引 + 按需展开 + 可核验来源"**。Mem0 OSS v3 从"图 + UPDATE/DELETE"退回 **single-pass ADD-only**（一次 LLM 调用，不覆盖）；Graphiti 仍要 LLM + 图数据库且默认低并发防 429；Letta 把记忆做成 **git 版本化的 MemFS**，并用 `/doctor` **审计系统提示 token 占用**。**[报告/源码]**
8. **捕获的真正对手是"模型自觉"**。Claude Code 的解法是给触发条件（"同一个错误犯第二次""同一句纠正打第二遍"才写 CLAUDE.md）并给**索引硬上限**；Codex 的解法是**后台独立通道**（空闲后生成、限流时跳过、单独抽取/整合模型、自动脱敏）；Cline 的解法只有"写进规则让模型自己更新"——结果社区有"memory bank 不更新"的 issue。OMB 属于 Cline 这一类。**[报告]**
9. **DSH 已把"确定性闸门"和"技能目录"做成了宿主能力，OMB 却在插件里重造**：`hooks-claude-code` 支持 SessionStart/UserPromptSubmit/PreToolUse/PostToolUse/Stop/Subagent*；`tool-skill` 提供 name+description 目录与 `/name` 显式调用；`agent-team`/`workflow`/`goal`/`plan`/`todo` 都已存在。OMB 自己只用了 goal/plan/workflow/todo/skill 的**工具面**（`cordis.patch.yml:178-277`）。**[实测]**
10. **三个最该删的东西（有据）**：上下文组件的 admission 与服务面（零生产消费者，R3）；推理组件的逐回合控制散文与自动注入卡（R2 建议删，v3.7 已列 R2）；`omb_verify` 的循环依赖形态（56 次/391 会话）。删是负成本，且直接回应"负优化"。**[报告 R2/R3]**
11. **三个提案按性价比排序：A 工作区简报+事件捕获 > B 技能化推理+删散文 > C 零 LLM 记忆图**。A 用 ~600 行换"新会话深度理解"，B 用净删 ~1,000 行换"少花 token、用户可 `/r3`"，C 用 ~900 行换"互联记忆"，但风险与迁移成本最高。**[推测]**
12. **不建议做的事（本轮）**：自造压缩器、写入时 LLM 抽取、社区摘要/GraphRAG、把多代理当默认、用 auto-review 当质量复审（它是权限闸门，每次工具调用一次模型审，官方明说"可能放行不安全操作、拒绝有用工作、多花 token"）。**[报告/实测]**

---

## §1 范围、方法与证据分级

**读了什么**

- 本仓：R1/R2/R3/R4 四份报告、`docs/v3.7-redesign.md`、`README.md`、`cordis.patch.yml`、`modules/reasoning/*.ts`。
- DSH 源码 README（file:line 引用见 §8）：`skill/tool-skill`、`skill/skill-filesystem`、`experimental/hooks-claude-code`、`experimental/agent-team`、`subagent/subagent`、`workflow/workflow`、`plan/plan-mode`、`goal/goal`、`experimental/auto-review`、`experimental/tool-ralph`、`experimental/plugin-market-bundle`。
- 外部：Claude Code 文档（memory / skills）、Codex 文档（AGENTS.md / skills / memories / hooks / auto-review）、Anthropic 多代理工程博客、Aider repo map 文档与 `repomap.py`、Letta 文档与 Letta Code README、Mem0/Graphiti/LangMem README、Cline Memory Bank 文档、OpenHands Condenser 文档、Gemini CLI GEMINI.md 文档、MetaGPT/CrewAI/Goose/OpenCode/SWE-agent README、`agents.md` 规范站。

**没做什么（避免把推测当实测）**

- 没有 clone 每个项目、没有跑它们的 A/B；外部数字全部标 **[报告]**。
- 没有复现 Codex/Claude Code 的 token 账；它们的预算数字来自文档原话。
- 没验证 Cursor rules 文档（`cursor.com/docs/context/rules.md` 404），Cursor 只用 R3 已引的工程博客；Goose 只核到"MCP 扩展 70+"，recipes 细节未核；AutoGen 只核到 Magentic-One 存在。这些在 §7 标为未核实。

---

## §2 对比矩阵

### 2.1 工业 / 开源 harness（2025–2026）

| # | 系统 | 机制（源） | token / 缓存行为 | 证据 | 负结果 / 失败 | 判决 |
|---|---|---|---|---|---|---|
| 1 | **Claude Code：指令文件** | CLAUDE.md 四层（managed→user→project→local），目录树**拼接**加载，子目录按需；`@path` 导入（深度 ≤4）在启动时展开；HTML 注释被剥掉；推荐 <200 行；>4 MiB 跳过；压缩后**重新从磁盘注入** | 每会话全量进上下文；导入**不省** token；作为**system prompt 之后的 user 消息**下发，压缩后重注入改变前缀 | [报告] code.claude.com/docs/en/memory | 官方承认"长文件消耗更多上下文、降低遵循度""两条矛盾指令可能任选一条" | **避**：不要做常驻长文；**抄**"索引短、正文文件化" |
| 2 | **Claude Code：auto memory** | 模型在会话中写 4 类笔记（user/feedback/project/reference）到 `~/.claude/projects/<repo>/memory/`；`MEMORY.md` 是索引，**只加载前 200 行或 25KB**；主题文件按需读；写入带 `modified` 时间戳；超限报错要求重写索引；子代理默认不继承 | 索引每会话固定成本（上限硬截）；主题文件 0 常驻；写文件是工具调用（模型发起） | [报告] 同上 | 仍是**模型自觉**；官方明说"不是每次会话都存"；靠"同一纠正第二次"这类触发语 | **抄**索引+上限+按需；**避**当作"自主捕获"（它不是） |
| 3 | **Claude Code：skills** | `SKILL.md` + 可选 scripts/references/assets；遵循 **Agent Skills 开放标准**（agentskills.io）；正文只在调用时加载；自定义命令已合并进 skills；`context: fork` 在子代理里跑；`!`bash`` **动态上下文注入**（加载时执行命令并把输出内联）；`/verify` 会把成功的构建配方**写回** `.claude/skills/verify/SKILL.md` | 目录=name+description（每轮）；正文=一次工具结果（后续重发）；`/skill-doctor` 报每个技能"每轮成本 + 使用次数" | [报告] code.claude.com/docs/en/skills | 官方："**技能列表里每个技能每轮都花 token，不管用不用**"；描述被截短；正文无大小上限 | **抄**"技能=过程"、动态注入、配方回写；**改**：把 OMB 方法卡搬成技能 |
| 4 | **Claude Code：hooks / 子代理 / 压缩** | ~30 个 hook 事件（DSH 侧记录：官方 30 个，桥接支持 7 个）；`PreToolUse` 可硬阻断（不依赖模型自觉）；压缩=摘要+保留最近文件；subagent 干净上下文只回传结论 | hook 返回的上下文进入后续请求（append-only，不破前缀）；阻断=省一次请求 | [实测] DSH `hooks-claude-code/README.md:60-66,175`；[报告] code.claude.com/docs/en/hooks | 桥接缺 23/30 事件；`SessionStart` 是 detached，**可能错过首个请求**（`:176`） | **抄**确定性闸门（Stop/PreToolUse）；**避**把首请求上下文押在 detached hook 上 |
| 5 | **OpenAI Codex：AGENTS.md** | 全局 `~/.codex/AGENTS.md`（或 `AGENTS.override.md`）→ 项目根到 cwd 逐层，**每目录最多一个文件**，根到 cwd 拼接、后者靠后；`project_doc_max_bytes` **默认 32 KiB** 硬截断；每次运行重建（无缓存可清）；`project_doc_fallback_filenames` 可换名 | 每会话全量；截断是硬上限；"靠后覆盖"只是位置语义，不是真覆盖 | [报告] learn.chatgpt.com/docs/agent-configuration/agents-md.md | 截断=静默丢尾部；"instructions truncated" 是官方 troubleshooting 条目 | **抄**上限与逐层拼接；**避**把它当项目理解的唯一来源（它只有文字） |
| 6 | **Codex：memories** | 默认**关闭**；开启后**后台**把合适的历史会话变成 `~/.codex/memories/` 文件；**等会话空闲足够久**才做；限流剩余低于阈值时**跳过**；`extract_model`/`consolidation_model` 单独指定；自动脱敏；可按聊天控制读/写；`disable_on_external_context` 排除用过 MCP/web 的会话 | 生成是额外模型调用（有预算闸门）；注入未来会话=新前缀（首次不命中缓存） | [报告] learn.chatgpt.com/docs/customization/memories.md | 需要模型 token；"memories 不是必须规则，硬规则放 AGENTS.md"（官方警告）；默认关=未验证默认价值 | **抄**后台通道 + 限流闸门 + 脱敏 + 生成/使用分离；**避**热路径同步抽取 |
| 7 | **Codex：skills** | 同一 Agent Skills 标准；`SKILL.md` 目录；**初始列表预算 = context 的 2% 或 8,000 字符**（未知窗口时），`skills.max_context_tokens` 上限 10,000；太多时**先截短 description，再省略并警告**；位置 `.agents/skills`（cwd→repo 根）、`~/.agents/skills`、`/etc/codex/skills`、内置 | 目录受硬预算；正文按需；显式 `$skill` / `/skills` | [报告] learn.chatgpt.com/docs/build-skills.md | 省略技能时模型"不知道自己不知道"；隐式匹配只靠 description | **抄**总量预算与"先截短再省略"；**改** OMB 应给 whenToUse |
| 8 | **Codex：hooks / auto-review / subagents** | hooks 文档存在（生命周期脚本或 MCP 工具）；auto-review 把沙箱越界审批交给**reviewer agent**；subagents 有独立配置 | auto-review=每越界动作一次模型调用；hooks=可注入/阻断 | [报告] learn.chatgpt.com/docs/hooks.md、…/sandboxing/auto-review.md、…/agent-configuration/subagents.md | "reviewer"不是答案复审；审批有延迟与成本 | **避**把 auto-review 当质量层；**抄**闸门归权限、质量归技能 |
| 9 | **Aider：repo map** | tree-sitter 抽取符号 + 文件依赖图 + **PageRank** 排序，按 token 预算裁剪；`--map-tokens` **默认 1,024**；`map_mul_no_files=8`（聊天里没有文件时放大到 ~8×）；随聊天状态动态伸缩；纯确定性、零 LLM；LLM 可据 map 再要具体文件 | ~1k token/请求（可配 0 关闭）；同一张 map 在会话内稳定 → 缓存友好；不加工具、不加消息 | [实测/源码] `aider/repomap.py:49,56,525,529`；[报告] aider.chat/docs/repomap.html | 只覆盖"有符号的语言"；大仓靠排序取舍，可能漏关键文件；不解决"为什么/决策" | **抄**（本报告最强推荐）：确定性索引 + token 预算 + 无文件时放大 |
| 10 | **Cline：Memory Bank** | 不是内置功能：把 6 个 md（projectbrief/productContext/activeContext/systemPatterns/techContext/progress）的维护**写成 custom instructions**，让模型在每个任务前后读写；需手动"initialize memory bank" | 每次读 6 个文件=大量上下文；写入靠模型想起 | [报告] docs.cline.bot/best-practices/memory-bank | 官方流程要求手动初始化；社区 issue 报"memory bank 不更新"（cline#1911，[报告]）；本质仍是模型自觉 | **避**：方法论没有执行器就只是提示词 |
| 11 | **OpenHands：Condenser / microagents** | Condenser 抽象：NoOp / LLMSummarizing / Pipeline；触发机制 + 滚动窗口；历史被**事件**替换（condensation event）；microagents/skills 提供按需指令 | 摘要=额外模型调用；窗口滚动=前缀重写 | [报告] docs.openhands.dev/sdk/arch/condenser、…/guides/context-condenser | 摘要丢信息、成本与压缩比强相关（与 R3 的 1.417 净成本相符） | **避**自造摘要；**抄**"替换成事件"的可追溯形态 |
| 12 | **Gemini CLI：GEMINI.md** | 全局 `~/.gemini/GEMINI.md` → 项目 → 子目录分层扫描；`/memory show` 看拼接结果、`/memory reload` 强制重扫；`@import` 模块化；extensions 分发 | 每会话全量；导入不省 token（与 CLAUDE.md 同构） | [报告] geminicli.com/docs/cli/gemini-md/ | 同 CLAUDE.md：层级越深越容易重复/矛盾 | **抄** `/memory show` 这类"可核验读法"；**避**层叠文本 |
| 13 | **Letta / Letta Code** | 记忆=**MemFS（git 版本化文件系统）** + memory blocks（进系统提示）；`/init` 让代理巡检仓库生成记忆；`/sleeptime` **dreaming**：后台子代理按步数或压缩触发整理记忆，可再开"应用前由代理复审"（更贵）；`/palace` 看记忆，`/doctor` **审计系统提示 token 占用**；技能目录 `~/.letta`、`.agents/skills`、代理内 MemFS | 记忆块=系统提示常驻成本（官方让 /doctor 专门审计）；dreaming=额外模型调用；MemFS 可 diff/回滚 | [报告] docs.letta.com/configuration/memory；[报告] github.com/letta-ai/letta-code README | Windows 原生默认关闭自动 dreaming（README 明说）；复审模式明确"多花 token 且不问你" | **抄** git 版本化 + 触发式整理 + token 审计；**避**把记忆放进系统提示常驻 |
| 14 | **Mem0 / Graphiti / LangMem** | Mem0 OSS v3：**single-pass ADD-only**（一次 LLM 调用，不 UPDATE/DELETE）；Graphiti：时序知识图（实体/事实有效期/episode/community），默认 OpenAI + Neo4j，默认低并发防 429；LangMem：**热路径记忆工具** + **后台记忆管理器**（抽取/整合） + LangGraph Store | Mem0 写入=1 次 LLM；Graphiti 摄入=多次 LLM；LangMem 后台=额外调用 | [报告/源码] mem0 README:68；graphiti README:142,159-164,255-257；langmem README:14-16,62,82 | Mem0 从图退回 ADD-only = "图不是必然"的最强反例；Graphiti 运维重；LangMem 热路径=模型决策、后台=钱 | **避**（OMB 现状）：写入时 LLM 抽取、图扩建、三级记忆；**抄**"生成/整合分离" |
| 15 | **MetaGPT / CrewAI / AutoGen / Goose / OpenCode / SWE-agent** | MetaGPT：`Code = SOP(Team)`，把软件公司 SOP 物化成角色流水线；CrewAI：Crews（自主协作）+ Flows（事件驱动、单 LLM 调用）；AutoGen：多代理团队（Magentic-One）；Goose：MCP 扩展 70+，配方/扩展生态；OpenCode：build/plan 双代理 + general 子代理；SWE-agent：ACI（agent-computer interface）单 yaml 配置 | 都是"过程/角色"编码，非记忆；上下文成本取决于各自编排 | [报告] 各 README（见 §8） | SOP/角色流水线在开放任务上脆弱（MetaGPT 自述面向软件公司流程）；多代理=token 放大（见 §3e） | **改**：只借"SOP=可复用过程"这一层，不借角色扮演 |

### 2.2 DSH 0.2.1-rc.2 原生机制（OMB 可直接用/已用）

| # | 宿主机制 | 契约要点（file:line） | token / 缓存 | 对 OMB 的含义 |
|---|---|---|---|---|
| 1 | **skill 目录 + `skill` 工具** | 目录=排序后的 name + 截断 description（`catalogDescriptionMaxLength` 默认 **500**，`:48`）；首个 pre-step 以 durable user 消息下发；变更时**整表替换**；`/name` 用户显式调用注入同一 `<skill_content>`；正文进工具历史 | 目录每轮常驻；正文一次；append-only 不破前缀（`:131-137`）；**整表替换**成本随目录线性（`:248`） | OMB 的方法卡可改造成宿主技能：**目录成本可预算、用户可 `/r3`、正文可改不用重启** |
| 2 | **skill-filesystem 发现根** | 项目 `.dsh/skills`(100)、`.agents/skills`(200)、custom(300)、`~/.dsh/skills`(400)、`~/.agents/skills`(500)、bundled(600)（`:46-56`）；bundle=`<name>/SKILL.md`，flat=`<name>.md`；chokidar 监听 | 只发现一层；正文重读、无版本协议（`:140-151`） | OMB 预设**已挂** `skill-filesystem` + `tool-skill`（`cordis.patch.yml:271-277`）→ 零新依赖即可发技能 |
| 3 | **hooks-claude-code** | 7 个事件（SessionStart/UserPromptSubmit/PreToolUse/PostToolUse/Stop/SubagentStart/SubagentStop，`:60-66`）；缺 23/30（`:175`）；`SessionStart` detached 可能错过首请求（`:176`）；`Stop` 阻断可强制多一轮 | hook 上下文 append-only；阻断省一次请求 | OMB 可发**外部可执行 `omb` 入口**，用 `Stop`/`SessionEnd` 做确定性捕获；**不能**靠它保证首请求注入 |
| 4 | **subagent** | 独立 Session、干净上下文、父侧只收结算通知；容量上限 `ACTIVATION_LIMIT_REACHED`；fork 才继承历史 | 结算通知=一次小结果；子会话 token 不摊到父（但真实花费仍在） | 用"把重活推进子代理"替代主会话准入/塑形（R3 结论） |
| 5 | **workflow / workflow-ptc** | 模型写 JS 脚本 `agent()/parallel()/pipeline()/phase()/log()`；每个子代理独立；父侧只拿最终 JSON | **无 token 预算词汇**（`workflow/README.md:129`）：引擎不管跨子代理的 token | 可用于"一次性批量审计"；**不要**用它做常驻推理 |
| 6 | **agent-team** | Lead + 命名队友 + durable 任务板（CAS）；消息走 inbox；同进程同 checkout；写入范围只是**告警**不阻塞（`:203-206`） | 队友消息=target 历史里的 user 消息（`:186-192`）；任务/名册 log-only 不占模型面 | 可与"三线程研究"类任务匹配；对编码任务要谨慎（见 §3e 15× token） |
| 7 | **plan-mode / goal / todo** | plan：`/plan` + `exit_plan_mode` 用户复核，工具目录全程不变（`plan-mode/README.md:91-93`）；goal：持久目标 + 轮次上限，**只计轮数不计 token**（`goal/README.md:158`）；todo：清单工具 | plan 激活时每请求加一节提示（`:141-143`）；goal 变更 0 token；todo 结果进历史 | plan 是"过程外置"的现成实现；OMB 不必自造"流程门" |
| 8 | **session-search 5 工具** | 根 realm 的 `sessionQuery` 只有精确读；FTS 实例在 isolate 组内拿不到；5 工具常驻 **3,976 字符 schema ≈1,105 token + 315 字符提示**，且当前 4/4 30s 超时（R4 §1.1/§2.3） | 常驻 ~1,190 token/请求；调用期冷读会话 | **建议关 bundle**（省 1,190 token）除非把索引修好；OMB `omb_recall` 不要镜像它 |
| 9 | **auto-review** | 每次原生/PTC 工具调用**执行前**由当前模型审一次，deny 转问人；官方自述"可能放行不安全操作、拒绝有用工作、多花 token"（`auto-review/README.md:12`） | 每工具一次模型调用 | 它是**权限闸门**，不是第二意见 reviewer；不要拿它做质量复审 |
| 10 | **ralph** | 每轮全新子代理，只给"不可变目标 + 轮次 + 上一轮结构化 handoff"，**workspace 就是长期记忆**（`tool-ralph/README.md:36`） | 轮间只传一个结构化报告；子代理不复用父上下文 | "用工作区当记忆"的最纯粹实现；OMB 的会话收尾捕获可借它的 handoff 形状 |
| 11 | **plugin-market** | 默认关闭的实验 bundle：自定义插件市场（Host `pluginMarket` + Web Discover 页）；打开后 Creator 预设多一个只读 `plugin_market` 工具（`plugin-market-bundle/README.md:12,27,46`） | 关闭时 0 token；打开时多一个工具 schema | OMB 分发可走这条路，但**不要**为了省事把能力塞进工具面 |

### 2.3 OMB 现状（对照用，file:line 见 §8）

| 组件 | 现在是什么 | 模型面成本 | 语料实测 | 与生态对照 |
|---|---|---|---|---|
| 推理 | 8 张卡（`methods.ts:43-92`）+ 1 句常驻（`residentHint`，≤`RESIDENT_HINT_MAX`）+ `omb_method`/`omb_focus`/`omb_verify` 工具 + `controlLine` 逐回合散文（`control.ts:73`，`focus.ts:70` 仅 deep 注入） | OMB 稳态 ≈500–520 token/请求（71 字符常驻 + 1,442 字符 schema，v3.7 §4） | `omb_method` 34 次/391 会话；`omb_verify` 56 次；`standard` 注入 0 字符 | 生态做法：技能目录 + 用户显式 `/name`；OMB 做成自定义工具 = 多付 schema、少拿宿主能力 |
| 记忆 | DB + FTS5/bigram + 可选向量 + 图边；写入口只有 `omb_remember`（模型自觉）；召回 `omb_recall`/`omb_relate` | 工具 schema 543 字符；单次 5 条召回 3,877 字符（v3.7 目标 ≤1,600） | 143 次写→83 准入；top-1 切题率 ≈30%；`omb_recall` 27/391 会话 | 生态：Codex 后台通道 / Claude Code 索引上限 / Letta git MemFS；OMB 都没有 |
| 上下文 | 压力投影 + 拉取台账 + admission（零消费者）+ 状态段 | 状态段均值 483 字符 | 68/68 status 自相矛盾（R3）；对 prompt token 贡献 0.00035% | 生态：索引/预算/压缩都在宿主；OMB 该只留"读数+建议" |
| 项目理解 | **没有**工作区索引；新会话靠工具调用现场发现 | 0 常驻 | — | 生态里有 Aider repo map / CLAUDE.md / Memory Bank 三种解，前两种便宜 |

---

## §3 五个焦点问题的横向答案

### (a) 没有模型主动性时，怎么"自主捕获记忆"？

生态里只有四种真实机制，按成本/可靠性排序：

1. **事件→确定性写入（零模型）**。Claude Code 的 hooks 在固定生命周期跑外部命令（PreToolUse 可硬阻断）；Codex 有 hooks 文档；DSH 的 `hooks-claude-code` 桥接 7 个事件。Ralph 更极端：每轮一个新子代理，**只把结构化 handoff 传给下一轮，工作区文件就是记忆**。**可捕获的是事实**（工具调用、改动文件、命令、退出码、commit、会话起止），**不是结论**。**[报告]**
2. **会话空闲后的后台抽取（要模型）**。Codex memories：默认关、空闲后生成、限流阈值以下跳过、`extract_model`/`consolidation_model` 分开、自动脱敏、可按会话禁写。Letta dreaming：按步数或压缩触发后台子代理，可选"应用前复审"（更贵）。LangMem 后台 memory manager 同构。**代价是一次额外模型调用，收益是模型不用"记得去记"。** **[报告]**
3. **模型自觉 + 强脚手架**。Claude Code auto memory：给触发条件（"同一个错误第二次""同一句纠正第二次"）与硬索引上限（200 行/25KB）。**它仍不是自主**，只是把"该记什么"写得足够具体。**[报告]**
4. **只有方法论（无执行器）**。Cline Memory Bank 把 6 个文件的维护写成 rules，要求用户"initialize memory bank"；社区有"不更新"的 issue。**这是 OMB 现状的近亲。** **[报告]**

→ **对 OMB 的结论**：要做到"不靠模型自觉"，只有两条路：(i) 订阅 DSH 会话事件，**确定性**记录事实台账并派生记忆行（零模型，符合 OMB 约束）；(ii) 明确引入一个有预算闸门的后台通道（要模型，违背"热路径零 LLM"但可放在会话后）。**建议先做 (i)，把 (ii) 作为可选开关**。不要做"Cline 式规则"。

### (b) 新会话怎么便宜地建立"深度项目理解"？

四个被验证的机制，单位成本从低到高：

| 机制 | 代表 | 成本 | 深度 | 关键设计 |
|---|---|---|---|---|
| **符号级 repo map** | Aider | **~1k token/会话**（`map_tokens=1024`，无文件时 ×8） | 中（结构/API，不含决策） | PageRank over 文件依赖图 + 按预算裁剪；确定性、可缓存 |
| **索引式记忆** | Claude Code auto memory | ≤200 行/25KB | 中（偏好/纠正/project 事实） | 索引常驻、主题文件按需；超限**报错要求压缩** |
| **层叠指令文件** | CLAUDE.md / AGENTS.md / GEMINI.md | 0.2–8k token（Codex 硬顶 32KiB） | 低–中（人写的规范） | 目录树拼接；**长=遵循度下降**；不能替代结构索引 |
| **人工记忆库** | Cline Memory Bank / Letta `/init` | 数千 token 或一次模型巡检 | 高（决策/上下文） | 需维护者；Letta 用一次 `/init` 模型巡检换取后续小索引 |

→ **对 OMB 的结论**：OMB 缺的是**第一行**。它不需要模型、不需要新工具：`git ls-files` + 语言无关符号正则 + 依赖近似（import/require/include）+ PageRank + 预算裁剪，就能在 ~600–900 token 内给新会话"这仓库有什么、哪些文件被反复改、上次结论是什么"。这也是 §5 提案 A 的核心。

### (c) 怎么把推理结构成"技能/过程"，而不是每轮提示词？

生态的共识形态：

- **技能 = 目录（name+description）+ 正文（按需）**，标准是 Agent Skills（agentskills.io）。Claude Code、Codex、Cline、OpenHands、Letta 都已接入。**[报告]**
- **用户显式调用**优先于模型猜：Claude Code `/skill-name`、Codex `$skill` / `/skills`；DSH 也有 `/name`（`tool-skill/README.md:56,89`）。**这是"推理过程"最便宜的入口：用户点名，零路由成本。**
- **确定性数据注入**：Claude Code 的 `!`cmd`` 在加载技能时执行命令并内联输出（例：`!`git diff HEAD``），让"过程"带着真实数据到达，而不是让模型先想起去取。**[报告]**
- **过程可以回写**：`/verify` 成功后把配方写进 `.claude/skills/verify/SKILL.md`；Codex 有 Record & Replay 把演示变成技能。**过程是资产，不是提示词。** **[报告]**
- **硬闸门用 hooks，不用散文**：Claude Code 官方明确"要在固定时点强制执行，写 hook，不要写 CLAUDE.md"。**[报告]**
- **SOP 化**：MetaGPT `Code = SOP(Team)` 证明"过程可以物化成阶段与角色"，但代价是刚性；OpenHands 用 Condenser + 技能折中。

→ **对 OMB 的结论**：8 张卡应变成 8 个**宿主技能**（OMB 预设已挂 skill 能力），常驻只留一句触发语；`omb_method` 工具删除；"何时用"必须写进 description（DSH 目录不渲染 `whenToUse`，`:244`）。**这正是提案 B。**

### (d) 怎么让上下文便宜（缓存稳定前缀 / JIT / 压缩）？

按杠杆从大到小，全部有实测或官方数字：

1. **少放常驻**：Anthropic Tool Search 把工具定义从 ~55K 降到 ~8.7K token（−85%），且**延迟加载不破 prompt caching**；准确率 49%→74%（Opus 4）。**[报告 R3]**
2. **前缀稳定**：任何逐回合变化的注入都是缓存缝（Anthropic/DeepSeek 缓存契约，R3 §2.2）。DSH 的设计也是"稳定段走 sections、易变段走 contexts"（R4 §4.5）。
3. **大输出文件化**：Cursor dynamic context discovery：长工具输出写文件、摘要只留引用；A/B 中调用 MCP 工具的 run 总 token **−46.9%**。**[报告 R3]**
4. **确定性裁剪**：DSH `tool-result-pruner` 8192 阈值、head 4096/tail 1024/marker；不需要模型。
5. **压缩是"未来省钱"，不是"现在省钱"**：本机 35 次压缩，输入/释放比中位 **1.417**（>1 = 一半以上样本净花 token）；R3 结论是"减少触发压缩"而不是自造压缩器。
6. **隔离**：子代理只回传结论；Anthropic 用"子代理把产物写文件、只回传引用"来避免电话游戏。但多代理本身 15× token（见 e）。
7. **预算硬顶**：Codex 技能列表 2%/8k 字符；AGENTS.md 32KiB；Claude Code MEMORY.md 200 行/25KB。**生态的"优化"大多是上限，不是算法。**

### (e) 哪些机制有负结果？

| 机制 | 负结果（原话/数字） | 证据 |
|---|---|---|
| **多代理** | agent 比 chat 多 **4×** token，多代理 **15×**；"多数编码任务真正可并行的部分比研究少""模型还不擅长实时协调与委派"；token 使用解释 BrowseComp 80% 方差（即"多花 token"本身是主因） | [报告] anthropic.com/engineering/multi-agent-research-system |
| **长指令文件** | "文件超过 200 行消耗更多上下文并可能降低遵循度"；"两条矛盾指令，Claude 可能任选一条"；`@import` **不减少**上下文 | [报告] Claude Code memory 文档 |
| **技能目录** | "列表里每个技能每轮都花 token，不管用不用"；描述被截短；技能多时省略并警告 | [报告] Claude Code skills、Codex build-skills |
| **记忆自动抽取** | Mem0 v3 退回 ADD-only；Graphiti 默认低并发防 429、要 Neo4j+OpenAI；LangMem 热路径=模型决策、后台=额外调用；Codex memories 默认关 | [报告] 各 README |
| **Memory Bank 方法论** | 需手动初始化；社区报不更新；6 文件全读=贵 | [报告] Cline 文档 + issue #1911 |
| **自动摘要/压缩** | 中位净花 token（本机 1.417）；OpenHands Condenser 也需要模型 | [报告 R3]/[实测] |
| **auto-review 当质量层** | 官方："可能放行不安全操作、拒绝有用工作、多花 token"；每工具一次模型调用 | [报告] DSH `auto-review/README.md:12` |
| **workflow 当预算工具** | 官方："没有 token 预算词汇"——引擎不知道跨子代理花了多少 | [报告] DSH `workflow/README.md:129` |
| **宿主会话搜索** | 5 工具 1,190 token/请求，且当前 4/4 30s 超时、391 会话仅 6 次使用 | [实测 R4] |
| **OMB 自身** | `omb_method` 34 次/391 会话、`omb_verify` 56 次、`standard` 档 0 字符、上下文组件 admission 零消费者、status 68/68 矛盾 | [报告 R1/R2/R3] |

---

## §4 抄 / 避 / 改

| 判决 | 机制 | 来源 | 在 OMB 落成什么 | 注意 |
|---|---|---|---|---|
| **抄** | 确定性 repo map（符号 + 依赖图 PageRank + token 预算 + 无文件时放大） | Aider | 提案 A 的 `brief` 生成器；预算默认 800 token | 只支持可解析语言；用 `git ls-files` 定范围 |
| **抄** | 索引 + 主题文件分离，索引硬上限 | Claude Code auto memory | 记忆索引进 brief（≤40 行），详情仍走 `omb_recall` | 上限要**报错**而不是静默截断 |
| **抄** | 技能 = name+description + 按需正文 + `/name` | Agent Skills / Claude Code / Codex / DSH | 8 张卡→8 个 `SKILL.md` | description 必须含"何时用"（DSH 不渲染 whenToUse） |
| **抄** | 技能列表总预算，"先截短 description 再省略" | Codex | 给 OMB 技能定总字符上限（如 1,200 字符） | 省略要可见（状态面写"已省略 N 个"） |
| **抄** | 后台捕获通道 + 限流闸门 + 生成/使用分离 + 脱敏 | Codex memories | 提案 A 的可选 `capture.background`（默认关） | 要与用户明说"会花模型调用" |
| **抄** | git 版本化记忆 + 触发式整理 + `/doctor` token 审计 | Letta MemFS | 记忆库导出/版本化（只读镜像，不引入新真源）；status 报"记忆常驻/写入成本" | 不要变成第二个真源 |
| **抄** | 技能加载时确定性注入（`!`cmd``） | Claude Code | brief 或 `/omb-brief` 技能里内联 `git status --short`、`git log -1` | 只跑只读、有超时的命令 |
| **抄** | 事件闸门（Stop/PreToolUse）而非常驻散文 | Claude Code hooks / DSH hooks | 收尾校验做一个 `/omb-verify` 技能 + 可选 Stop hook | 桥接缺 23/30 事件且 SessionStart detached，不押首请求 |
| **抄** | 子代理产物写文件、只回传引用 | Anthropic 多代理博客 | 研究/审计类任务：产物进 `docs/`，父会话只收路径 | 与 DSH subagent 的结算通知天然契合 |
| **避** | 把记忆放进系统提示常驻（memory blocks） | Letta | 不做；OMB 记忆只在工具结果里出现 | 常驻是每轮成本，且会挤掉真正的稳定前缀 |
| **避** | 写入时 LLM 抽取 / 图 + UPDATE/DELETE / 社区摘要 | Mem0/Graphiti/A-MEM | 不做（与 R1 §3.3 一致） | 71 行存量喂不起；ADD-only 是行业回退信号 |
| **避** | 用规则让模型自己维护多文件记忆库 | Cline | 不做；改为事件捕获 + 单点写入口 | 无执行器的方法论=提示词 |
| **避** | 长 CLAUDE.md 式"项目说明" | Claude Code 文档自述 | brief 只放**可从文件系统核验**的事实，不放散文 | 长文降低遵循度 |
| **避** | 用 auto-review / 多代理 / workflow 做质量或预算 | DSH/Anthropic | 质量归技能与人工复核；预算归硬上限 | 15× token、每工具一次审 |
| **避** | 自造压缩器 / KV 驱逐 / tool search | R3 结论 | 不做；宿主已有 compaction/pruner | 插件改不了模型与 serving |
| **改** | DSH skill 目录不渲染 `whenToUse`、正文无上限、整表替换 | DSH 源码 | OMB 技能 description 自带"何时用"；单技能正文 ≤4KB；目录变更频率降为"发版时" | 整表替换会破一次前缀 |
| **改** | DSH hooks 桥接只 7/30 事件 | DSH 源码 | OMB 只承诺 SessionStart/Stop/PostToolUse 三类；首请求注入不依赖它 | 明确写"可能错过首请求" |
| **改** | OMB 的 `omb_method` 索引视图（含 whenToUse） | 本仓 | 保留"whenToUse"信息，但搬到技能 description | 不要让索引视图和技能描述双写 |

---

## §5 三个激进重构提案

> 排名 = 影响/成本/风险 综合。三个提案互不排斥；建议 A+B 同轮做（都是"删/改"），C 单独立项。

### 5.1 提案 A（第一优先）：**Brief & Ledger —— 工作区简报 + 事件捕获**

**一句话**：把"新会话怎么懂这个项目"和"谁负责记"从模型手里拿走，交给两个确定性产物：会话开始时生成一次的工作区简报，和全程追加的事件台账。

**精确机制**

1. **`brief` 生成器（零 LLM，纯确定性）**
   - 触发：新会话首个 `agent/pre-step`（或 `/omb-brief` 强制重建），结果**冻结**在会话内（不逐回合变化）。
   - 输入：`git ls-files`（上限 20k 文件，超时 2s）、按扩展名分组的文件数与最近 mtime、**符号抽取**（正则：`class|def|func|function|interface|struct|impl|export`，不做 tree-sitter）、**依赖近似**（import/require/include/use 行）、改动热度（本仓会话台账里 `tool/call` 命中的文件计数）、最近 5 条 OMB 结论（`memory` 表按 `observed_at`，只取 title ≤60 字符）、`git rev-parse --short HEAD`。
   - 排序：对"文件-依赖"图跑 PageRank（或度中心性），按预算裁剪；无文件在上下文时 ×4（借鉴 Aider `map_mul_no_files`）。
   - 输出：`~/.dsh/omb/brief/<cwd-hash>.json`（缓存，含 `head`/`generatedAt`/`filesDigest`），渲染成 **≤900 字符**的稳定段。
   - 注入：作为**静态 systemPrompt section**（不是每轮 contexts），逐字节稳定，首请求后命中缓存。
2. **事件台账（零 LLM）**
   - 订阅宿主 `session/event`：`tool/call`、`tool/result`（只存 name/args 摘要/exit ok）、`user/message`（只存 hash+长度）、`compaction/*`、`turn/end`。
   - 会话结束（或每 N 步）落一行 `ledger`：`{sessionId, cwd, startedAt, steps, tools[], filesTouched[], commands[], compactions}`。
   - **派生边**：`session→file`、`session→command`、`file→memory`（当 `omb_remember` 的 `sourceRef` 指向该文件时）。这是提案 C 的零成本前置。
3. **结论写入仍由模型发起**（`omb_remember`），但触发条件改成 Claude Code 式硬条件：**同一纠正出现第二次 / 用户说"记住" / 决策被用户确认**；否则不写。回顾体护栏沿用 v3.7 M4。
4. **可选后台通道（默认关）**：`capture.background = true` 时，会话空闲 N 分钟后用一个小模型把台账总结成 1–3 条候选记忆，**先落 `pending` 再按策略应用**（借鉴 Codex memories 的"生成/使用分离"与限流闸门）。状态面必须写"本次后台用了一次模型调用"。

**五条抱怨映射**

| 抱怨 | A 的作用 | 测法 |
|---|---|---|
| 1 无自主捕获 | 台账 100% 会话自动生成；边自动生成；结论仍需模型（诚实标注） | 20 会话：台账行数 = 会话数；`filesTouched` 非空率 ≥95% |
| 2 记忆非网络 | 先建 `session/file/memory` 三类节点与边，`omb_relate` 返回 1-hop | 20 次 `omb_recall` 中带边结果 ≥30% |
| 3 新会话无深度理解 | brief 首轮给结构+热度+结论索引，省掉首轮探索调用 | 新会话首轮工具调用数 −30%；uncached input −20% |
| 4 负优化 | 上下文组件删剩"读数+建议"；不再有 admission | OMB 稳态 token ≤300/请求 |
| 5 推理未优化 | A 不动推理，但与 B 同轮做 | 见 B |

**成本**：新增 ~600–750 行（`brief.ts` 250、`ledger.ts` 150、`capture.ts` 100、注入/命令/状态 100），10–14 个测试；DB 加 2 张表（`ledger`、`edge`），迁移 1 次；无模型依赖。
**风险**：brief 事实错误会污染整场会话（必须可 `/omb-brief --dry` 查看、可一键关）；大仓 `git ls-files` 慢（超时就退化成"只给目录计数"）；缓存抖动（必须冻结、禁止逐回合重建）；隐私（git remote、路径、命令可能敏感 → 只存 hash 或截断）。
**Kill 判据**（20 会话 A/B，2 周内）：(i) 首轮工具调用或 uncached input 降幅 <15%；(ii) brief >900 字符 或 cacheRead 比例下降 >10 个百分点；(iii) 用户纠正 brief 事实 ≥3 次/20 会话；(iv) brief 生成 p95 >500ms。命中两条 → 关开关回滚（保留 `/omb-brief` 命令）。

### 5.2 提案 B（第二优先）：**Skillify & Delete —— 推理变成宿主技能，删掉逐回合散文**

**一句话**：8 张方法卡不是"工具"，是"技能"；把常驻的 schema 与散文删掉，改成 8 个 `SKILL.md` + 1 句常驻触发语 + 用户 `/rN` 显式调用。

**精确机制**

1. **搬卡**：`modules/reasoning/methods.ts` 的 8 条 `text` 变成 `skills/omb-r1..r8/SKILL.md`（bundle 目录），frontmatter：`name: omb-rN`、`description: "<title>。何时用：<whenToUse>。正文含动作清单。"`（≤300 字符，把 DSH 不渲染的 `whenToUse` 塞进 description）、`user-invocable: true`。放到 OMB 预设的 `customSkillDirs`（`cordis.patch.yml:271-277` 已挂 `skill-filesystem`，零新依赖）。
2. **删工具**：删 `omb_method` 工具注册、`renderIndex`/`renderCards`、`findCards` 的话题匹配（`:94-240`），省掉其 schema；常驻只留一句 ≤80 字符（"推理过程：/r1…/r8 或技能目录，卡里是动作不是概念"）。
3. **删散文**：删 `controlLine` 的验证/分支/复核/收尾表（v3.7 R2 已列）；删 `controlForBand`、紧档索引、`injectCard` 自动注入（≤1 张/档位）。
4. **保留**：`omb_focus` 只做**真实 `reasoningEffort` 映射**（v3.7 R1）+ 状态面一行；循环检测保留但**只在信号命中时注入**（零稳态成本）。
5. **验证改过程**：`omb_verify` 工具删除，改为 `/omb-verify` 技能（收尾清单 + 证据要求）；高风险时按 R2 建议用 subagent 复核，**不做逐回合循环依赖**。
6. **回写**：允许"技能即过程"的演进——用户可 `/skill-creator` 风格新增自己的推理过程；OMB 不再维护卡片正文。

**五条抱怨映射**

| 抱怨 | B 的作用 | 测法 |
|---|---|---|
| 1 无自主捕获 | 不涉及（交给 A） | — |
| 2 记忆非网络 | 不涉及（交给 C） | — |
| 3 新会话理解 | 部分：技能目录预载 name+desc（~600 字符），按需正文替代探索 | 目录总字符 ≤1,200 |
| 4 负优化 | 删工具 schema + 控制散文 + 自动注入卡，稳态 token ~500→≤250 | 稳态 token/请求；删除行数 |
| 5 推理未真优化 | 过程变显式（`/rN`）/按需/可编辑；`omb_focus` 真映射 `reasoningEffort` | 技能调用率；`quick` outputTokens ≤40% max |

**成本**：净删（−900~−1,100 行代码，+8 个 md，+测试重写）≈1–1.5 人日；风险中低。
**风险**：路由失败（description 写不好，模型不加载）；DSH 目录整表替换会破一次前缀（发版时一次性）；用户习惯 `/r3` 需引导；丢失"自动注入一张卡"的行为（可用 `deep` 档保留 1 张，但要测量）；供应商不支持 `reasoningEffort` 时降级要写在状态面。
**Kill 判据**：20 会话中，(i) 技能调用 <10% 且用户仍提"推理质量"类抱怨；(ii) OMB 稳态 token >300；(iii) 出现 2 次"循环没被提示"导致的重复劳动；(iv) 用户找不到 `/rN`。命中两条 → 恢复 `omb_method` 工具（保留技能双轨一个版本）。

### 5.3 提案 C（第三优先，最激进）：**Graph from Events —— 零 LLM 的记忆图**

**一句话**：记忆互联不靠 LLM 建图，靠**确定性实体抽取 + 事件来源**：每条记忆从哪来（session/turn/tool/file）、提到什么（路径/符号/命令/URL）、被谁取代，全部由写入路径和台账自动生成。

**精确机制**

1. **实体抽取（零 LLM）**：`omb_remember` 写入时对 `text` 跑正则/词法：绝对/相对路径、`file:line`、`symbol()`、`npm/pnpm/npx` 命令、URL、`session-<id>`、日期；归一化（Windows `\` → `/`、去根前缀）。
2. **边类型**：`mentions(memory→entity)`、`provenance(memory→session)`、`supersedes(memory→memory)`（同一 key 且新 observed_at）、`derived_from(memory→memory)`（模型显式给 `sourceRef` 时）。
3. **来源回填**：用根 realm 的 `sessionQuery` **精确读**（R4 证实根实例可用、零常驻 token）按需补 `session/turn`，**只读单个事件/surface，不整段回放**（最大会话解压 46MB）。
4. **检索**：`omb_recall` 结果每条附 ≤120 字符的 1-hop 边摘要（"来源 2 会话；同文件被 3 条结论提到；被 X 取代"）；`omb_relate` 返回 1–2 hop。**不做**社区摘要、PPR、GraphRAG。
5. **与 A 的关系**：A 的台账已经产出 `session→file/command` 边；C 只是把它推广到 memory 实体，并加 supersede 维护。

**五条抱怨映射**

| 抱怨 | C 的作用 | 测法 |
|---|---|---|
| 1 无自主捕获 | provenance 边自动写（每条结论可追到会话/事件），捕获仍由 A 台账驱动 | 带来源召回占比 |
| 2 记忆非网络 | 直接解决：mentions/provenance/supersedes 三类边，1-hop 摘要 | 带边召回 ≥30%；边:记忆 <10:1 |
| 3 新会话理解 | brief 可写"该文件被 N 会话改、M 条结论提到" | brief 中引用边的事实正确率 |
| 4 负优化 | 边替代已废弃的 `omb_files` 漂移视图；不新增常驻 token（只在工具结果里） | 常驻 token 不升 |
| 5 推理未优化 | 不涉及（交给 B） | — |
**成本**：DB 迁移 + 抽取器 + 回填 + 检索 ~800–1,000 行，2–3 人日；回填 391 会话要控制（只对已有 83 条记忆做，先不扫历史）。
**风险**：实体误报导致边爆炸（路径子串、通用词）；recall 延迟（边 join）；迁移风险（71 行小库，但 schema 一旦改就要回滚脚本）；隐私（URL/路径入图）。
**Kill 判据**：20 次真实召回人工判读：(i) 带边结果命中率 < 现状；(ii) 边:记忆 >10:1；(iii) recall p95 >250ms；(iv) 20 次里"边被用到" <3 次。任一 → 只留 provenance，删 mentions 边。

### 5.4 排序、门禁与彼此关系

| 顺序 | 提案 | 影响 | 成本 | 风险 | 回应抱怨 | 门禁 |
|---|---|---|---|---|---|---|
| 1 | A Brief & Ledger | 高（1/3/4） | 中（~700 行） | 中（污染/超时） | 1,2(部分),3,4 | 首轮调用 −30%、uncached −20%、brief ≤900 字符 |
| 2 | B Skillify & Delete | 高（4/5） | 低（净删） | 中低（路由） | 4,5,3(部分) | 稳态 ≤250–300 token；技能调用 ≥10% 会话 |
| 3 | C Graph from Events | 中高（2） | 高（~900 行） | 高（噪声/延迟） | 2,1(强化) | 边命中 ≥30%、p95 ≤250ms |

**共同门禁**：`npx tsc --noEmit` / `npx eslint .` / `npx vitest run` / `node scripts/build.mjs` 全绿；每个机制一个 config 开关；代码保留 legacy 分支一个版本（沿用 v3.7 §5）。**A 与 B 可同轮**（A 提供数据，B 提供减法）；C 必须在 A 的台账稳定 ≥20 会话后再做，否则边没有来源。

---

## §6 五条抱怨的终局映射

| 用户抱怨 | 生态证据（为什么现在是负担） | OMB 终局机制 | 验收指标（可测） |
|---|---|---|---|
| 1 无自主记忆捕获 | Cline 类"规则自觉"不可靠；Codex/Letta 都靠后台通道或事件 | A 台账（零模型）+ 可选后台通道（要模型，明示） | 台账覆盖 100% 会话；`filesTouched` 非空 ≥95% |
| 2 记忆不是网络 | Mem0 退回 ADD-only 说明"图"不是重点，"来源+关联"才是 | C 的 mentions/provenance/supersedes 边 | 带边召回 ≥30%；边:记忆 <10:1 |
| 3 workspace 记忆建不起深度理解、新会话烧 uncached | Aider 1k token 就能给全仓结构；OMB 0 索引 | A 的 brief（稳定段、一次生成、含结构与热度） | 首轮工具调用 −30%；uncached input −20% |
| 4 负优化 | 技能列表每轮都花钱；长指令降低遵循；OMB 500 token/req、admission 零消费者 | B 删散文与工具 schema；A 删上下文服务面 | OMB 稳态 ≤250–300 token/req |
| 5 推理/上下文没真正优化 | 生态把"过程"变成技能/闸门/命令，而不是每轮散文 | B 技能化 + `/rN` + hooks 收尾；`omb_focus` 真映射 effort | 技能调用 ≥10% 会话；`quick` outputTokens ≤40% max |

---

## §7 未核实 / 开放问题 / 最小探针

**未核实（不要当结论用）**

- Cursor rules 的具体形态（文档 404，只引了 dynamic-context-discovery 博客的 −46.9%）。
- Gemini CLI 的上下文压缩阈值与实现（只核了 GEMINI.md 发现与 `/memory`）。
- Goose recipes 的 schema 与 token 行为（只核了 MCP 扩展 70+）。
- AutoGen / CrewAI 的记忆默认值（只核了框架定位与 Magentic-One/Crews+Flows 存在）。
- OpenCode 的 AGENTS.md/插件细节（只核了 build/plan 双代理与 general 子代理）。
- Claude Code/Codex 的"技能列表每轮成本"没有本机数字，只有官方原话。
- 提案 A/B/C 的所有"预期效果"都是 [推测]，必须按 §5 的 kill 判据做 A/B。

**给 Lead 的最小探针（只读或一次性）**

1. **P1 brief 预算可行性**：在本仓跑一次 `git ls-files` + 符号正则 + PageRank，量"900 字符能放多少节点、覆盖多少文件、耗时多少"。产出 CSV，不写仓库。
2. **P2 首轮成本基线**：取 10 个新会话，数第一个 `assistant/message` 前的工具调用数、`usage.uncachedInputTokens`；作为 A 的对照。
3. **P3 技能目录成本**：把 8 张卡渲染成 name+description（≤300 字符），量总字符；与当前 `omb_method` schema 字符对比（R2 已有 1,442 字符基线）。若技能目录 > schema，B 的收益要重算。
4. **P4 `sessionQuery` 精确读延迟**：对 5 个会话各 `readEvent`/`readSurface` 一次，量 p95；决定 C 的 provenance 是否可行。
5. **P5 Stop hook 可行性**：在临时 profile 配 `hooks-claude-code` + 一个打印 `session_id/cwd` 的脚本，确认 Stop 能拿到会话目录（不要写正式 profile）。

**开放问题（需用户拍板）**

- 是否接受"后台模型调用"做自主捕获（Codex 式）？如果坚持零 LLM，则自主捕获只能是事实台账。
- 技能化后，用户是否愿意改用 `/r3` 而不是让模型自动选卡？
- brief 是否允许包含命令（可能含密钥）——只存 hash 还是脱敏？

---

## §8 证据索引

**本仓 / 本机（[实测]）**

- `docs/research/2026-10-18-memory.md` §1.8/§3（写入 143→83、召回 3,877 字符、top-1 30%）
- `docs/research/2026-10-18-reasoning.md` §0/§1.3（`omb_method` 34 次、`omb_verify` 56 次、`standard` 0 字符）
- `docs/research/2026-10-18-context.md` §1.7/§3.6（状态段 483 字符、admission 零消费者、方案 C 删 3,346 行）
- `docs/research/2026-10-18-dsh-capabilities.md` §1.1（5 工具 3,976 字符/1,105 token）、§2.3（30s 超时根因）、§3（6 次/391 会话）
- `docs/v3.7-redesign.md:9-15`（500–520 token/请求）、`:49`（R1 effort 映射）、`:75-80`（验收基线）
- `cordis.patch.yml:178-262`（goal/plan/workflow/todo 行）、`:271-277`（skill-filesystem + tool-skill）、`:216-232`（compaction 组）
- `modules/reasoning/methods.ts:43-92`（8 卡）、`:136-195`（常驻提示）、`:227-235`（索引渲染）
- `modules/reasoning/control.ts:73`（`controlLine`）、`modules/reasoning/focus.ts:70`（仅 deep 注入）
- DSH `packages/skill/tool-skill/README.md:48`（500 上限）、`:56`（`/name`）、`:131-137`（token/KV）、`:244-249`（限制）
- DSH `packages/skill/skill-filesystem/README.md:46-56`（发现根）、`:140-151`（限制）
- DSH `packages/experimental/hooks-claude-code/README.md:60-66`（7 事件）、`:175-183`（缺 23/30、SessionStart detached）
- DSH `packages/experimental/agent-team/README.md:104-107`（设计）、`:186-192`（token/KV）、`:203-206`（限制）
- DSH `packages/workflow/workflow/README.md:129`（无 token 预算）、`:126-130`（KV）
- DSH `packages/plan/plan-mode/README.md:91-93`（工具目录不变）、`:141-143`（token）
- DSH `packages/goal/goal/README.md:142-144`（token）、`:158`（只计轮数）
- DSH `packages/experimental/auto-review/README.md:12,48`（每调用一次模型审、可能放行/拒绝/多花）
- DSH `packages/experimental/tool-ralph/README.md:36`（每轮只给目标+handoff）
- DSH `packages/experimental/plugin-market-bundle/README.md:12,27,46`（默认关、工具面）
- `D:\Program\deepseek-harness\packages\experimental\session-search\cordis.patch.yml:1-14`（isolate 组）
- 本机 profile：`C:\Users\SuSeventeen\.dsh\profiles\web\package.json`（bundles 列表含 agent-team / session-search / ralph / terminal / cot-translation / worktree）

**外部（[报告]，2026-10 抓取）**

- Claude Code memory：<https://code.claude.com/docs/en/memory>（auto memory 4 类、MEMORY.md 200 行/25KB、CLAUDE.md <200 行/4MiB、导入不省 token、压缩后重注入）
- Claude Code skills：<https://code.claude.com/docs/en/skills>（Agent Skills 标准、`!`cmd`` 注入、`/verify` 回写配方、`context: fork`、"每个技能每轮都花 token"、`/skill-doctor`）
- Claude Code hooks：<https://code.claude.com/docs/en/hooks>（事件与硬阻断）
- Agent Skills 标准：<https://agentskills.io/specification>
- Codex AGENTS.md：<https://learn.chatgpt.com/docs/agent-configuration/agents-md.md>（32 KiB、逐层、override、每次重建）
- Codex skills：<https://learn.chatgpt.com/docs/build-skills.md>（2%/8,000 字符、10,000 上限、先截短再省略、`.agents/skills`）
- Codex memories：<https://learn.chatgpt.com/docs/customization/memories.md>（默认关、空闲后生成、限流跳过、脱敏、extract/consolidation 模型）
- Codex hooks / auto-review / subagents：<https://learn.chatgpt.com/docs/hooks.md>、<https://learn.chatgpt.com/docs/sandboxing/auto-review.md>、<https://learn.chatgpt.com/docs/agent-configuration/subagents.md>
- Anthropic 多代理：<https://www.anthropic.com/engineering/multi-agent-research-system>（4×/15× token、token 解释 80% 方差、编码任务并行度低、子代理写文件只回传引用）
- Aider repo map：<https://aider.chat/docs/repomap.html>；源码 `aider/repomap.py:49`（`map_tokens=1024`）、`:56`（`map_mul_no_files=8`）、`:525,529`（`nx.pagerank`）
- Letta 记忆：<https://docs.letta.com/configuration/memory>（MemFS、`/init`、dreaming、`/doctor` 审系统提示 token）
- Letta Code：<https://github.com/letta-ai/letta-code>（`/sleeptime`、`/palace`、MemFS、技能目录、Windows 默认关自动 dreaming）
- Mem0 v3：<https://github.com/mem0ai/mem0>（README:68 ADD-only；:65 managed 平台差异）
- Graphiti：<https://github.com/getzep/graphiti>（README:142 结构、:159-164 依赖、:255-257 低并发）
- LangMem：<https://github.com/langchain-ai/langmem>（README:14-16 热路径/后台、:62 Store、:82 模型决定）
- Cline Memory Bank：<https://docs.cline.bot/best-practices/memory-bank>；失败报告 <https://github.com/cline/cline/issues/1911>
- OpenHands Condenser：<https://docs.openhands.dev/sdk/arch/condenser>
- Gemini CLI GEMINI.md：<https://geminicli.com/docs/cli/gemini-md/>
- MetaGPT：<https://github.com/FoundationAgents/MetaGPT>（README:43-44 `Code = SOP(Team)`）
- CrewAI：<https://github.com/crewAIInc/crewAI>（README:58-62 Crews + Flows）
- Goose：<https://github.com/block/goose>（README:27 MCP 70+）
- OpenCode：<https://github.com/sst/opencode>（README:100-110 build/plan 双代理 + general 子代理）
- SWE-agent / ACI：<https://github.com/SWE-agent/SWE-agent>、<https://arxiv.org/abs/2405.15793>
- AGENTS.md 规范：<https://agents.md>
- Cursor dynamic context discovery：<https://cursor.com/blog/dynamic-context-discovery>（[报告 R3]：MCP run 总 token −46.9%）
