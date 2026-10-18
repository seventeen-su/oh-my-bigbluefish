# 上下文根本性重构：新会话成本、项目理解与"少即是多"架构

**日期**：2026-10-18
**作者**：research-context（续 `docs/research/2026-10-18-context.md`）
**问题**（用户原话拆解）：
1. 工作区记忆无法建立**深项目理解**；
2. **每个新会话都在烧未缓存 token**；
3. 上下文优化可能**是净负担**。

**证据纪律**：`[实测]` = 本机日志复算（只读脚本，未改代码/未跑 git）；`[源码]` = 本仓/DSH 源码；`[报告]` = 外部公开材料（URL）；`[推算]` = 基于实测数字与公开价格的换算；`[推测]` = 未验证。
**数据**：`C:\Users\SuSeventeen\.dsh\sessions` 下 394 个 `session.v4.jsonl.zstd`；379 个会话有 assistant usage、39,758 次请求。价格为 DeepSeek 官方页（deepseek-flash，off-peak/peak；见 §2.1）`[报告]` <https://api-docs.deepseek.com/quick_start/pricing>。
**只读声明**：本报告是唯一写入文件；未修改 OMB/DSH 代码，未跑 git/build。

---

## 0. 一页结论（TL;DR）

1. **"新会话烧未缓存 token"是真的，但金额可以忽略**：新会话首请求中位 **13,325 token**，其中 **58.8% 命中跨会话前缀缓存**，未缓存中位 **3,164 token**。379 个会话的首请求合计成本约 **$0.31**（占全部输入成本 **0.4%**）。`[实测]`+`[推算]`
2. **新会话 prompt 的构成不是历史，而是工具定义**：工具 schema **69.4%**（中位 9,298 token）、系统提示 **16.1%**（2,246）、技能目录 **8.6%**（1,292）、首条用户消息 3.8%、运行时快照 1.7%。历史为 0。`[实测]`（按字符比例 + 每会话密度 0.281 token/字符分配）
3. **全生命周期 prompt 的构成完全相反**：工具结果 **85.5%**、用户消息 9.4%、运行时快照 2.0%、系统提示 1.7%、技能目录 1.1%、工具 schema 0.13%。`[实测]`
4. **钱花在哪**（off-peak 估算，总计 **$76.9**）：缓存读历史 **$36.0（46.8%）**、输出 token **$22.9（29.7%）**、未缓存输入 **$15.3（19.9%）**、压缩摘要 **$2.8（3.6%）**。输入侧（可被上下文优化影响的部分）$54.0，其中缓存读占 **66.7%**。`[推算]`
5. **未缓存输入的归因**：活跃回合新内容 **$11.5（14.9%）**、空闲 >1h 后恢复 **$2.5（3.2%）**、压缩摘要 **$2.8（3.6%）**、新会话 **$0.31（0.4%）**；其余是 2–60 分钟间隔的恢复。**优化新会话前缀是 0.4% 的仗**。
6. **压缩是保险，不是省钱手段**：35 次压缩摘要调用吃 17.81 M 输入、缓存命中仅 1.17%、成本约 **$2.76**；以 12.58 M 释放量与 1/50 缓存价计算，**盈亏平衡约 71 次后续请求**；会话请求数中位 31、p90 187。短会话里压缩是净亏的保险。`[实测]`+`[推算]`
7. **宿主已经支持项目简报，只是本仓没用**：`dsh-agent-instructions` 默认加载 `AGENTS.md`/`CLAUDE.md` 链（全局→仓库根→cwd，65,536 B 预算，首次请求注入、后续变更增量更新）。全库 **379 个会话只有 1 个**出现过 `agent-instructions` 消息；OMB 仓库**没有 AGENTS.md/CLAUDE.md**。`[源码]`+`[实测]`
8. **所以"深项目理解"缺口的主因不是上下文组件弱，而是仓库没有写给 agent 的简报**。写一份 2–4 KB `AGENTS.md`（模块地图、不变量、命令、坑）是最高 ROI 的动作：成本约 **$0.00014/会话**、总计 **$0.05**，且由宿主加载、不占 OMB 代码。`[实测]`+`[推算]`
9. **repo map 不是当前答案**：Aider 默认 1k token、按图排序、随每次请求发送；RepoGraph 在 SWE-bench 上平均相对提升 32.8%，但 token 成本 +12–32%（RAG +31.5%，Agentless +11.7%，AutoCodeRover +16.7%）。本工作区有 `read/grep/glob/pwsh` 和宿主指令文件，先做简报；repo map 降级为**观察项**，不是 Wave 1 功能。`[报告]`
10. **推荐架构**：**"仓库简报 + 零 OMB 常驻上下文 + 按需工具 + 工具结果节食"**。OMB 不再做 session-start/per-turn 模型面注入；`omb-context` 组件删除或只留一行诊断；把省下的力气放在**减少工具结果体积与回合数**（子代理隔离、精简输出、按需读）——那是 85% 的上下文成本所在。`[实测]`+`[报告]`

---

## 1. 方法

- 日志：同前一份报告，Node 24 `zlib.zstdDecompressSync` 逐 zstd frame 解压（实现等价于 `packages/session/session-persistence-jsonl/src/zstd.ts:48-104` 的 `scanZstdFrames`）。
- 会话/请求：以 `assistant/message.data.usage` 为一次请求；`prompt = inputTokens + cacheReadTokens + cacheWriteTokens`。
- 首请求：每个会话第一条带 usage 的 assistant 消息；其前的 `system/message`、`user/message`（按 `source.kind` 拆：`runtime-context` / `skill-catalog` / `time-context` / `agent-instructions` / 普通用户）、`request/header.header.tools` 作为构成快照。
- 构成分配：因为宿主不落盘逐块 token，本报告用**字符比例 × 该会话首请求的 provider prompt token** 做比例分配；每会话密度中位 **0.281 token/字符**（p10 0.263 / p90 0.295），即中文+JSON 混合的实际密度。`[推算]`
- 价格：DeepSeek `deepseek-flash`（V4.1-Flash-1017）官方页：cache hit **$0.003/M off-peak**（peak $0.006），cache miss **$0.15/M**（peak $0.30），输出 **$0.60/M**（peak $1.20）。**缓存价/未缓存价 = 1/50**。`[报告]`
- 未计入：标题生成、web search/fetch 内部请求、embedding、子代理未落库的临时调用；压缩摘要单独统计。所以 §2 是**输入侧的下界**，不是总账单上界。

---

## 2. 本工作区真实成本结构

### 2.1 总账（off-peak 估算）

| 项 | token 量 | 单价 | 成本 | 占比 |
|---|---:|---:|---:|---:|
| assistant 未缓存输入 | 102.00 M | $0.15/M | **$15.30** | 19.9% |
| assistant 缓存读 | 12,001.8 M | $0.003/M | **$36.00** | 46.8% |
| assistant 输出 | 38.08 M | $0.60/M | **$22.85** | 29.7% |
| 压缩摘要输入 | 17.81 M | $0.15/M | **$2.67** | 3.5% |
| 压缩摘要输出 | 0.147 M | $0.60/M | **$0.09** | 0.1% |
| **合计** | — | — | **≈$76.9** | 100% |

- **每请求均摊** $76.9 / 39,758 ≈ **$0.0019**。`[推算]`
- **输入侧**（上下文优化唯一能影响的部分）：$53.97；其中缓存读 **66.7%**、未缓存输入 28.3%、压缩 5.0%。输出 token $22.85 不属于上下文层，但"回合数/输出长度"会同时放大它。
- 全库 394 个会话 / 379 个有 usage；缓存读占比 **99.15%**，未缓存 **0.84%**。`[实测]`

### 2.2 新会话（首请求）到底花了什么

| 构成 | 中位 token/会话 | 占首请求 | 说明 |
|---|---:|---:|---|
| 工具 schema | **9,298** | **69.4%** | `request/header.header.tools` 的 JSON；33 KB 字符中位 |
| 系统提示 | 2,246 | 16.1% | 7,913 字符中位；harness 身份/部署/工具指引 |
| 技能目录 | 1,292 | 8.6% | 4,609 字符；`<available_skills>` 名称+截断描述 |
| 首条用户消息 | 439 | 3.8% | 任务 prompt/团队消息 |
| 运行时快照 | 237 | 1.7% | 工作目录/沙箱/审批/OMB 常驻提示/时间等 |
| 时间上下文 | 73 | 0.4% | 每请求变化的 time snapshot |
| **首请求 prompt** | **13,325** | 100% | p90 14,553；max 17,980 |
| 其中未缓存 | **3,164 中位** | 40.5% 均值 | 58.8% 跨会话 cache hit（358/379 会话首请求命中） |

- **关键纠正**：跨会话前缀缓存让"新会话"通常只付约 **3.2 K 未缓存 token**，而不是 13.3 K；21/379 个会话首请求零命中（新 profile/缓存过期），这些才付全额。`[实测]`
- 首请求中 **OMB 自有工具 schema 中位 5,319 字符 ≈ 1,495 token（占 11.2% 首请求 / 16% 工具 schema）**；OMB 常驻提示 71 字符 ≈ 20 token；运行时快照里的 `omb:cognitive` 段中位 104 字符 ≈ 29 token。**OMB 的模型面固定开销 ≈ 1.5 K token，其中 96% 是工具 schema。**`[实测]`+`[推算]`
- 新会话总成本：379 次首请求合计未缓存 1.98 M + 缓存读 2.88 M；折价后 **$0.31**，占全账 **0.4%**。`[推算]`

### 2.3 全生命周期 prompt 的构成（按 token 加权）

| 构成 | 占比 | 含义 |
|---|---:|---|
| 工具结果（tool/result） | **85.5%** | 被后续每个请求反复重读的主体 |
| 用户消息（任务/团队/反馈） | 9.4% | 含多次追加的 user 输入 |
| 运行时快照（runtime-context） | 2.0% | 每次变化追加一份，旧快照仍在历史里 |
| 系统提示 | 1.7% | 首请求后缓存命中 |
| 技能目录 | 1.1% | 首请求后的稳定前缀 |
| 时间上下文 | 0.25% | 每请求变化的小尾巴 |
| 工具 schema | 0.13% | 固定在首请求，不再增长 |
| assistant 文本 | 0.04% | 多数 assistant 内容被 reasoning 挤出文本时才是 0；本口径只计 text block |

- 会话请求数：中位 **31**、p90 **187**、max 3,555；prompt 大小：p50 **278.6 K**、p90 **600.7 K**、p99 673 K。**46.5% 的请求 prompt 已超过 300 K，10.1% 超过 600 K。**`[实测]`
- 工具结果字符总量 104.7 M；按 2,633 字符/请求新增，约占每请求新增未缓存内容的一半；另一半主要是 assistant 输出（958 token/请求）。`[实测]`+`[推算]`
- **结论**：长会话的成本不是"开头塞了什么"，而是"每回合新增的工具结果被之后每个回合重读"。工具结果既是 85.5% 的存量，也是每回合新增未缓存内容的主要来源之一。

### 2.4 未缓存输入的归因（成本优化的真正靶子）

| 请求类型 | 未缓存 token | 成本 | 占未缓存输入 |
|---|---:|---:|---:|
| 活跃回合（间隔 <2 min） | 76.64 M | $11.49 | 75.1% |
| 恢复（2–60 min） | 6.80 M | $1.02 | 6.7% |
| 恢复（1–6 h） | 2.76 M | $0.41 | 2.7% |
| 恢复（>6 h） | 13.83 M | $2.07 | 13.6% |
| **新会话首请求** | **1.98 M** | **$0.31** | **1.9%** |
| 压缩摘要（额外） | 17.61 M | $2.67 | — |

- 空闲恢复（≥1 h）占未缓存输入 **16.3%**，是"新会话"的 **8.4 倍**：缓存 TTL 到期后，恢复会话要重付整个历史。`[实测]`
- 压缩摘要本身几乎全是 cache miss（命中 1.17%），成本 $2.76，是"新会话"的 **8.9 倍**。`[实测]`
- **"新会话烧 token"不是主要矛盾**；主要矛盾是**历史体积 × 重读次数**与**压缩/恢复**。

### 2.5 缓存行为（DeepSeek 官方规则）

- 前缀缓存按"完整匹配的 cache prefix unit"命中；请求边界与固定 token 间隔都会落 prefix unit；best-effort、数秒构建、闲置数小时到几天清除。`[报告]` <https://api-docs.deepseek.com/guides/kv_cache>
- 本机：cache read 占 99.15%，且首次请求已有 58.8% 命中 → **稳定前缀（系统提示+工具 schema）是跨会话共享的**。任何每个会话都变的前缀（时间、计数器、动态项目摘要）都会把这份共享打折。
- 缓存读价格是未缓存价的 1/50，但**量是 118 倍**，所以缓存读仍占总输入成本 2/3。**"命中缓存"不等于"免费"**；减少历史体积在 1/50 价格下依然有效。

---

## 3. 宿主已经做了什么，成本/收益如何

| 宿主能力 | 本机实测 | 成本/收益判断 |
|---|---|---|
| `compaction-basic`（0.8/0.16/65,536；窗口 1 M、输出预留 256 K 时阈值 ≈678 K）`[源码]` `packages/compaction/compaction-basic/src/config.ts:20-23,75-78,153-217` | 17 个会话发生过压缩，35 次 summary；17.81 M 输入、12.58 M 释放、缓存命中 1.17%；**摘要输入/释放 token 比中位 1.417** | 成本 $2.76；盈亏平衡 = 1.417×0.15/0.003 ≈ **71 次后续请求**。会话请求中位 31 → 多数压缩是"防溢出保险"而非省钱。**不要自己再压，也不要用上下文膨胀把它逼早触发** |
| `tool-result-pruner`（8192/4096/1024，只在压缩触发后运行）`[源码]` `compaction-tool-result-pruner/src/config.ts:9-16` | 342 次 prune | 确定性、无模型调用；**但 0.6–0.678 的软紧张窗口里不生效**。工具结果节食要靠模型行为，不是这个 pruner |
| `token-meter` 投影（contextPressure/tokenUsage/contextBreakdown）`[源码]` | 本报告新增 T1 修复后形状正确；反馈给状态面 | 读数来源可靠；不要自己估算 token（4 字符/token 低估 CJK 3–4×） |
| `agent-instructions`（AGENTS.md/CLAUDE.md 链，65,536 B，首请求加载、变更增量更新）`[源码]` `packages/bundle/base/cordis.patch.yml:303-306`；README | **379 会话仅 1 个**出现 agent-instructions（在 `--D-Program-project-130--`）；OMB 仓库无 AGENTS.md/CLAUDE.md | **已具备项目简报能力却闲置**。写 AGENTS.md 的成本约 $0.00014/会话，是最高 ROI 的项目理解动作 |
| `skill` 技能目录（名称+截断描述，正文按需 `skill` 加载）`[源码]` | 首请求 **8.6%**（≈1,292 token），全生命周期 1.1% | 目录成本真实但可接受；正文渐进披露是对的模式，不要复制成 OMB 自己的目录 |
| `session-search`（FTS5，`:memory:` + `openAt:first-search`，隔离组）`[源码]` | 全库仅 6 次调用；4 个并行全部 30 s 超时；391 文件/283 MB 冷建 | 不能做 per-turn 自动上下文；作为模型显式工具保留即可 |
| prompt caching（provider 侧）`[报告]` | cache read 99.15% | 稳定前缀便宜；**逐回合变化的内容是 50 倍价的** |

**结论**：宿主已经把"有状态上下文"的大部分做完了——压缩、裁剪、投影、项目指令、技能披露、会话搜索。OMB 继续做"上下文注入"的边际价值很低，且容易与这些机制打架。

---

## 4. 方案评估：项目理解该放在哪

### 4.1 六种做法与 token/缓存数学

记 $P_{miss}=0.15$/M、$P_{hit}=0.003$/M（off-peak），会话请求数 $R$（中位 31）。

| 方案 | 每次会话新增 token | 缓存行为 | 成本/会话（off-peak） | 证据 | 裁决 |
|---|---:|---|---:|---|---|
| **A. 仓库简报 AGENTS.md（2–4 KB）** | 575–1,150（首请求未缓存，之后命中） | 稳定前缀；变更一次只增量更新 | $0.00014–$0.00028 | Codex/Gemini/Cursor/OpenHands/Claude Code 均采用；AGENTS.md 60k+ 仓库 `[报告]` | ✅ **推荐（但作为仓库文件，不是 OMB 功能）** |
| B. 自动 repo map 于会话开始（1 K token） | 1,000 | 稳定则缓存；文件一变则改写 | $0.00024 | Aider 默认 1k、随请求发送；RepoGraph +32.8% 但 token +12–32% `[报告]` | ⏸ 观察项；本仓库工具够用 |
| C. 按需 repo-map 工具（≤1.2 K 输出） | 0（未调用）；调用时 1.2 K | 工具 schema 稳定、结果追加 | 调用 1 次 ≈ $0.0003 | Anthropic tool search/渐进披露；Cursor 动态发现 −46.9% token `[报告]` | ⏸ 若 A 不足再做，需单独验收 |
| D. OMB 会话开始常驻段（如 1 K） | 1,000 | 稳定则便宜；但常驻预算只剩 49 字符（`RESIDENT_HINT_MAX=120`，reasoning 已用 71） | 需先扩预算/挤掉别人 | 与 A 重复；`docs/context-budget.md` 已论证 | ❌ 不做 |
| E. 逐回合注入项目片段（1 K 变化） | 31,000（R=31，全部未缓存） | **每次都是新 token，≈19.4× 稳定方案** | $0.00465 | 前缀缓存规则；context rot/distractor 证据 | ❌ 不做 |
| F. 完全无模型面上下文（现状） | 0 | — | $0 | 用户不满意"没有项目理解" | ❌ 单独不够 |
| G. 保留 OMB context 诊断 vs 删除 | 0/回合；`omb_status` 调用时约 136 token | 追加历史 | 68 次调用合计 ≈$0.0014 | 本报告 §2；删除省维护不省钱 | ✅ 删除代码 / 最多留一行 |

- **稳定 vs 逐回合的倍率**：稳定内容成本 ≈ $S·(P_{miss}+(R-1)P_{hit})$；逐回合变化 ≈ $S·R·P_{miss}$；比值 ≈ $R/(1+(R-1)/50)$ ≈ **19.4×**（R=31）。`[推算]`
- 项目简报 2 KB 约 575 token，摊到 R=31 的会话约 **$0.00014**——比一次 `omb_status` 还便宜。**成本不是反对简报的理由；重复、过期和维护才是。**
- 3 KB 的"完整仓库摘要"约 860 token，仍然便宜；但它会**过期**，且不如"决策/不变量"稳定。写成 AGENTS.md 的**约束与坑**，而不是文件摘要。

### 4.2 与其他 agent 的做法对照

| Agent | 会话开始的项目上下文 | 大上下文如何进入 | 历史管理 | 来源 |
|---|---|---|---|---|
| **Claude Code** | `CLAUDE.md` 项目/用户/local 记忆 + imports + `/memory` | 工具按需读；Skills 渐进披露；子代理隔离 | 自动/手动 compaction、tool result clearing、prompt caching | `[报告]` <https://code.claude.com/docs/en/memory>、<https://code.claude.com/docs/en/context-window>、<https://code.claude.com/docs/en/prompt-caching> |
| **Codex CLI** | `AGENTS.md` 三层合并：`~/.codex/AGENTS.md` → 仓库根 → cwd | shell/read 工具按需 | 会话压缩/上下文管理（CLI 侧） | `[报告]` <https://mintlify.wiki/openai/codex/advanced/custom-instructions> |
| **Gemini CLI** | `GEMINI.md` 全局/项目/组件层级 + imports + `/memory` | 工具按需 | 上下文管理/压缩 | `[报告]` <https://mintlify.wiki/google-gemini/gemini-cli/concepts/context> |
| **Aider** | 无强制项目文件（可 `read: AGENTS.md`） | **repo map**：tree-sitter 符号 + PageRank 图排序，默认 **1k token**，随每次请求发送、按聊天动态扩张 | 用户显式加文件；无自动压缩 | `[报告]` <https://aider.chat/docs/repomap.html>、<https://agents.md/> |
| **OpenHands** | `AGENTS.md` 自动加载；trigger/path 触发规则；Skills 渐进披露 | 触发式加载 + 工具 | Condenser（`LLMSummarizingCondenser` / `PipelineCondenser` / rolling window） | `[报告]` <https://docs.openhands.dev/sdk/guides/skill>、<https://docs.openhands.dev/sdk/arch/condenser> |
| **Cline** | `.clinerules` + **Memory Bank** 结构化文件（projectbrief / systemPatterns / techContext / activeContext / progress） | 规则指示 agent 读取 Memory Bank 文件（按需 read） | 上下文窗口管理/截断 | `[报告]` <https://docs.cline.bot/best-practices/memory-bank> |
| **Cursor** | `.cursor/rules`（always/intelligent/glob/manual）+ `AGENTS.md` | **dynamic context discovery**：长工具输出写文件、MCP 工具描述按需读、历史文件、Skills 元数据；MCP 场景 token −46.9% | 摘要 + 历史文件引用 | `[报告]` <https://cursor.com/docs/rules>、<https://cursor.com/blog/dynamic-context-discovery> |
| **Continue** | rules/prompts | 显式 `@` 上下文提供者；`@Repository Map`（Aider 风格，按需） | 工具/上下文按需 | `[报告]` <https://docs.continue.dev/customize/deep-dives/custom-providers> |

**共同模式**：
1. **会话开始只放"稳定、可版本化、短"的项目指令**（AGENTS/CLAUDE/GEMINI/rules/Memory Bank）——不是仓库摘要；
2. **大上下文一律按需**（read/grep/工具检索/skills 正文/repo map 按需）；
3. **历史靠压缩/裁剪**，且压缩是安全阀不是优化器；
4. **只有 Aider/Continue 把 repo map 作为常规 prompt 内容**，且默认预算只有 1k token；RepoGraph 证明结构化仓库图能提升 SWE-bench 相对 32.8%，但 token 成本 +12–32%。

**论文侧**：
- Context Rot（18 模型，输入越长越不稳定；干扰项随长度放大；聚焦 ~300 token 优于全长 113 k）`[报告]` <https://www.trychroma.com/research/context-rot>
- Lost in the Middle（相关信息在中间显著退化）`[报告]` <https://aclanthology.org/2024.tacl-1.9/>
- Anthropic 上下文工程（JIT、progressive disclosure、compaction、note-taking、subagents）`[报告]` <https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents>
- RepoGraph（repo 级代码图检索，SWE-bench 平均相对 +32.8%）`[报告]` <https://ar5iv.labs.arxiv.org/html/2410.14684>
- 这些证据共同支持：**项目知识要"短而稳定 + 按需展开"**，而不是"会话开始塞一份长摘要"或"每回合追加"。

---

## 5. 推荐架构

### 5.1 一句话

**把项目理解交给仓库里的 `AGENTS.md`（宿主已有加载器），OMB 不再提供任何常驻/逐回合模型面上下文；把上下文预算花在"减少工具结果体积与回合数"上；`omb-context` 删除代码或只留一行诊断。**

### 5.2 组成部分

1. **仓库简报（新增，repo artifact）**：`AGENTS.md` 2–4 KB，内容四块：模块地图（8 个模块 + 入口 + 数据流）、不变量（kernel ABI 单一真源、宿主只读、前缀稳定、压缩不可替换）、命令（`npx tsc --noEmit`、`npx vitest run …`、`node scripts/build.mjs`）、坑（投影 host state 形状、resident 120 字符、session-search 冷启动、compaction 隔离组）。可选 `modules/AGENTS.md` 放模块级坑（宿主按最近文件优先级加载）。
2. **零 OMB 常驻/逐回合上下文**：保留 reasoning 71 字符；如 v3.7 M1 记忆常驻句落地，合计 ≤120；`omb:cognitive` 不再增长；无 session-start OMB 段、无逐回合压力/摘要注入。
3. **按需工具**：现有 `omb_recall`/`omb_method`/`omb_files` + 宿主 `read/grep/glob/session_search` 足够；**不新增 repo-map 工具**（观察项，见 §5.4）。
4. **记忆只存决策/约束**：不存仓库结构摘要（会过期）；每条带文件/行号指针；通过 `omb_recall` 按需取，不在会话开始注入。
5. **工具结果节食**：这是唯一能显著影响 85.5% 存量的杠杆：
   - 探索类工作优先用子代理（独立上下文，只回传结论）；
   - 工具输出走"先 grep/范围读，后整文件"；
   - 大输出写文件再按需读（Cursor 动态发现模式，宿主已有 fs 工具）；
   - 精简 `omb_recall`/`omb_status` 输出（记忆报告 M2；本报告 C2）。
6. **诊断**：`omb_status` 顶层保留压力/窗口/采样一行；删除 `omb-context` 组件段落与模块代码（或只留一行拉取台账）。诊断不是成本问题（全生命周期 ≈$0.0014），是**真话与维护**问题。
7. **压缩**：保持宿主默认（安全），不替换、不并行；不要用膨胀上下文把它逼早触发。若用户想省钱，可在长任务里**手动 `/compact`**（比自动阈值更可控），但这不是 OMB 代码能做的。

### 5.3 Token/cache 数学（推荐 vs 现状）

| 指标 | 现状 | 推荐后 | 依据 |
|---|---:|---:|---|
| 新会话固定 token（首请求） | 13,325（未缓存中位 3,164） | +575~1,150（AGENTS.md），未缓存中位 ≤4.3 K | `[实测]`+`[推算]` |
| AGENTS.md 成本 | 0 | $0.00014–$0.00028/会话；全库 $0.05–$0.11 | 1/50 缓存价 |
| OMB 模型面固定开销 | 1,495 token（工具 schema 96%） | 不新增；删除 context 段 | `[实测]` |
| 逐回合 OMB 注入 | 0 | 保持 0 | 前缀缓存 19.4× 差 |
| `omb_status` 上下文段 | 483 字符/次（68 次） | ≤400 字符；或删 | C2 已实现 |
| 工具结果占 prompt | 85.5% | 目标 −15~20%（子代理/范围读/精简输出） | `[实测]`+`[报告]` |
| 缓存读占比 | 99.15% | ≥98%（任何逐回合注入都会拉低） | `[实测]` |

### 5.4 具体文件计划（不在本任务实施；供 Lead 决策）

- **新增** `AGENTS.md`（仓库根，2–4 KB）。这是仓库文件，不是 OMB 模块，不占常驻预算、不需代码、由宿主 `dsh-agent-instructions` 自动加载。可选 `modules/AGENTS.md`（模块坑）。
- **删除/收敛 OMB context**（Wave 2 D3）：
  - 删 `modules/context/**`（Wave 1 后 937 行）、`packages/context/`、`cordis.patch.yml` 的 `omb-context` 行、`kernel/abi/catalog.ts` 的 `omb-context` 条目与 `kernel/display.ts:106` 行；
  - 把"压力/窗口/采样"一行留在 `dsh/status-tool.ts` 顶层（Lead 已计划 C3，现成数据在 `kernel.pressure`）；
  - 删 `tests/modules/context/**`。
- **记忆**：约定"决策/不变量"条目格式（结论 + 文件:行 + 日期）；不写 repo 摘要；`omb_recall` 输出 ≤1.6 K 字符（M2）。
- **工具描述**：把"何时用 grep/范围读/子代理"写进工具描述或 AGENTS.md（不占常驻预算）。
- **无新增 repo-map 索引/工具**；若 3 个月后仍缺导航，再立项。

### 5.5 验收判据

**项目简报（A）**
- `AGENTS.md` 存在且 ≤4 KB；OMB 工作区新会话中 ≥90% 出现 `agent-instructions` 消息（当前 1/379）。
- 新会话首请求未缓存中位 ≤4.5 K（基线 3.16 K；AGENTS.md 2 KB ≈ +575）。
- 20 个新会话 A/B（有/无 AGENTS.md）：首次编辑前的探索调用（read/grep/glob/pwsh）中位下降 ≥15%，或任务成功率不降且调用数不升。

**上下文零负担（B）**
- 无 OMB 新增逐回合模型面文本（`omb_status` 除外）；`omb:cognitive` 常驻合计 ≤120 字符且逐字节稳定。
- 连续两请求的 OMB 段文本相同率 100%（除 `omb_focus` 显式改档）；缓存读占比 ≥98%。
- 删除 context 组件后：`omb_status` 不再出现 `omb-context` 段；顶层压力行仍在；代码 −937 行。

**工具结果节食（C）**
- 工具结果字符/请求中位较基线下降 ≥15%（基线 2,633 字符/请求）；
- 压缩频率不升（≤17/394 会话），单会话平均请求数不升；
- 任务成功率/人工验收不降（20 会话抽样）。

### 5.6 杀死判据

| 机制 | 判据（满足即回滚/删除） |
|---|---|
| AGENTS.md | 30 个新会话后探索调用未降 ≥10%，或文件 >4 KB 且未带来收益 → 缩到 ≤1 KB 或删除 |
| repo-map 工具（若未来做） | 50 个会话内调用率 <20%，或任务成功无提升 → 删除 |
| 工具结果节食 | 14 天内工具字符/请求未降 ≥10%，或任务成功率下降 → 回滚提示文案 |
| 任何逐回合 OMB 注入 | 缓存读占比 <98%，或输入成本/会话 +5% → 立即删除 |
| 保留诊断 vs 删除 | 删除后 10 个会话内出现"没有压力读数"的误判 >1 次 → 只恢复顶层一行 |
| 压缩策略调整（若动 host config） | 溢出重试/失败率上升，或压缩后 71 请求内成本未回收 → 回默认 0.8 |

---

## 6. 明确不做（NOT-do list）

1. **不做 OMB 的 session-start 项目简报**：宿主已有 `AGENTS.md`/`CLAUDE.md` 加载器；再写一份是重复、会漂移、还要维护。
2. **不做自动 repo-map 索引/工具**（本轮）：Aider 1k 默认、RepoGraph token 成本 +12–32%；本仓库有 read/grep/glob，先 AGENTS.md。
3. **不做逐回合注入**（压力、摘要、项目片段）：稳定性差、缓存价差 19.4×、context rot 证据反对。
4. **不把仓库摘要写进记忆库**：会过期；记忆只存决策/不变量 + 指针。
5. **不替换宿主压缩/pruner/session-search**：一个 context 一个压缩实现；反向双压互相拆台。
6. **不把"新会话未缓存 token"当主要成本问题**：它占 0.4%；主要成本是缓存读历史（46.8%）与输出（29.7%）。
7. **不把 heuristic token 当钱**：用 provider usage + 官方价格；缓存 1/50 价比值会改变一切结论。
8. **不为项目理解新增大 schema 工具**：每个工具定义都在每次请求里（cached，但仍 1/50 价）；先证明旧工具不够。
9. **不做"会话开始注入记忆摘要"**：检索质量不足时它只是噪声；用 `omb_recall` 按需。
10. **不用 `omb_status` 做逐回合心跳**：它是诊断，不是上下文；68 次/394 会话已经足够。

---

## 7. 未决问题与最小探针

| # | 问题 | 探针 | 预期分辨 |
|---|---|---|---|
| Q1 | AGENTS.md 是否真的降低探索成本？ | 20 个新会话 A/B：首次编辑前 read/grep/glob/pwsh 调用数；任务成功粗判 | 若中位下降 ≥15%，保留；否则缩到 ≤1 KB |
| Q2 | 本仓还有哪些"项目知识"只能靠读代码获得？ | 人工统计过去 20 个会话中"重复解释架构"的消息 | 决定 AGENTS.md 内容，不写泛泛摘要 |
| Q3 | 工具结果节食的可行动作是什么？ | 按工具统计输出字符分布：pwsh/read/web_fetch 前 3 名；找可截断/写文件模式 | 决定改工具描述还是宿主配置，不是加组件 |
| Q4 | 压缩阈值 0.678 是否过于激进？ | 17 个压缩会话的"压缩后请求数"；<71 的比例 | 若多数 <71，可考虑把自动阈值调高/关自动（host config，非 OMB） |
| Q5 | 空闲恢复成本能否降低？ | 按会话统计 >1 h 恢复次数；是否可提示用户"长任务保持活跃"或 provider 提高 TTL | 缓存 TTL 是 provider 侧；插件只能减少历史体积 |
| Q6 | 删除 omb-context 后谁需要压力读数？ | 10 个会话内 `omb_status` 调用与用户询问 | 若无人用，直接删；否则顶层留一行 |
| Q7 | `agent-instructions` 在本仓为何从未触发？ | 检查 profile 是否禁用该行、AGENTS.md 是否存在 | 已确认仓库无 AGENTS.md；宿主行在 base patch:303-306 |

---

## 附录 A：复算口径

- 会话文件：`C:\Users\SuSeventeen\.dsh\sessions\<workspace>\<session>\session.v4.jsonl.zstd`；zstd 多帧逐帧解压。
- 请求：`assistant/message.data.usage`，`prompt = input + cacheRead + cacheWrite`；39,758 次。
- 首请求构成：`system/message`（`data.message.content`）+ `request/header.header.tools` 的 JSON 字符 + 首请求前的 `user/message`（`data.content`，按 `source.kind` 分类）。
- 构成分配：每会话密度 = 首请求 prompt ÷（系统字符 + 工具 schema 字符 + 首请求前消息字符）；中位 0.281；按各段字符占比分配 token。`[推算]`
- 成本：DeepSeek 官方价（2026-10-18 页面）；cache hit $0.003/M、miss $0.15/M、output $0.60/M（off-peak）；peak 翻倍。
- 压缩：`compaction/summary` 的 `usage` 与 `shadowedTokenCount`，35 条。
- 未计入：标题/搜索/embedding/未落库子调用。

## 附录 B：外部来源

- DeepSeek Models & Pricing — <https://api-docs.deepseek.com/quick_start/pricing>
- DeepSeek Context Caching — <https://api-docs.deepseek.com/guides/kv_cache>
- Chroma Context Rot — <https://www.trychroma.com/research/context-rot>
- Lost in the Middle (TACL 2024) — <https://aclanthology.org/2024.tacl-1.9/>
- Anthropic Effective context engineering — <https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents>
- Anthropic Advanced tool use (Tool Search Tool) — <https://www.anthropic.com/engineering/advanced-tool-use>
- Claude Code memory — <https://code.claude.com/docs/en/memory>；context window — <https://code.claude.com/docs/en/context-window>；prompt caching — <https://code.claude.com/docs/en/prompt-caching>
- Codex Custom Instructions (AGENTS.md) — <https://mintlify.wiki/openai/codex/advanced/custom-instructions>
- Gemini CLI Context Management (GEMINI.md) — <https://mintlify.wiki/google-gemini/gemini-cli/concepts/context>
- Aider Repository map — <https://aider.chat/docs/repomap.html>；AGENTS.md open format — <https://agents.md/>
- OpenHands Agent Skills & Context — <https://docs.openhands.dev/sdk/guides/skill>；Condenser — <https://docs.openhands.dev/sdk/arch/condenser>
- Cline Memory Bank — <https://docs.cline.bot/best-practices/memory-bank>
- Cursor Rules — <https://cursor.com/docs/rules>；Dynamic context discovery — <https://cursor.com/blog/dynamic-context-discovery>
- Continue Context Providers（含 @Repository Map）— <https://docs.continue.dev/customize/deep-dives/custom-providers>
- RepoGraph (ICLR 2025) — <https://ar5iv.labs.arxiv.org/html/2410.14684>
