# R5 —— 无权重更新下的推理/上下文根本性重构：2023–2026 学术前沿机制级复核

- 线程：academic frontier（任务 task-11）。唯一写盘产物：本文件。未改代码、未跑 git、未装包。
- 输入：`docs/research/2026-10-18-{memory,reasoning,context,dsh-capabilities}.md`、`docs/v3.7-redesign.md`、`docs/context-budget.md`、`docs/research/2026-10-18-probe-followup.md`。
- 标签：**[报告]**＝论文/厂商/仓库自述，我读了原文但未独立复现；**[实测]**＝我本轮亲自跑出的读数或源码行号；**[推测]**＝由前两者推出的、可证伪的判断。
- 本报告相对四份既有报告的增量：① 把"harness 层可实施性"作为一级判据（既有报告按系统综述，本报告按机制裁决）；② 补 2026 年新证据（两篇 AGENTS.md 实证、Self-Verification Cliff、IFScale、Danger of Overthinking、ACE v3、Leyline、ACON、ReasoningBank、mini-swe-agent）；③ **新增本机实测**：OMB 注入的真实体量、DSH 注入的缓存语义、DeepSeek 价格结构；④ 给出四个激进架构选项 + 判死条件。

---

## 0. 结论先行（12 条判词）

1. **用户在"成本"上的直觉方向对、归因错**：按 DeepSeek 现价，**输出/思考 token 是缓存输入 token 的 100–200 倍价**（flash：cache hit $0.003–0.006/M、miss $0.15–0.30/M、output $0.60–1.20/M）[报告](https://api-docs.deepseek.com/quick_start/pricing)。所以"上下文优化省 token"在钱上近乎无意义，**`reasoningEffort`/思考长度才是唯一的钱袋**；上下文优化真正的收益在**决策正确率与延迟**。
2. **OMB 的全部模型面足迹很小**：本机 394 会话 / 39,710 step，OMB 运行时上下文快照 **1,716 条 / 1,395,193 字符 ≈ 35 字符/step**；工具 schema ≈ 450 token/请求。全生命周期（394 会话）合计约 2,000 万输入 token 量级，**折价不到 2 美元** [实测，见 §2]。所以"负优化"不是"贵"，而是**占注意力、干扰指令遵循、且大概率不生效**。
3. **注入不毁缓存**：DSH 的 `systemPrompt.context()` 不是系统提示段，而是**追加为尾部 user/message 快照**（`agent.ts:428-440`、`runtime-context.ts:152-163`，仅在文本变化时提交）[实测/源码]。`docs/context-budget.md` §二"常驻提示进系统前缀、逐字节稳定否则全量缓存失效"的前提**在本宿主上不成立**；真正需要逐字节稳定的是**跨会话项目前缀**（DeepSeek 磁盘缓存按"前缀单元/公共前缀探测"命中，best-effort、几小时到几天过期）[报告](https://api-docs.deepseek.com/guides/kv_cache)。
4. **测试时算力是真杠杆，但插件只能拨粗档**：s1 证明"少想/多想"必须作用在**生成长度**上（budget forcing；AIME24 50→57）[报告](https://arxiv.org/abs/2501.19393)；在 agent 任务上"想太多"反而更差（4,018 条 SWE-bench Verified 轨迹；overthinking 分数越高成功率越低；挑低分方案可 +~30% 且算力 −43%）[报告](https://arxiv.org/abs/2502.08235)。插件没有 token 级控制，只有 `reasoningEffort` 三档 ⇒ **R1 映射是唯一真实机制，且必须只在回合边界改档**（probe-followup E4：effort 计入 header 变化，每步改会抖缓存）。
5. **内在自验证是死路**：无外部反馈的自我纠错在推理上不成立、甚至更差（ICLR 2024）[报告](https://arxiv.org/abs/2310.01798)；2026 的 Self-Verification Cliff 给出机制级天花板——k=8 时 GPT-5.4-mini 有 54.7% 概率含正解，自选只 41.9%（回收 36% 余量）；**弱于生成器的外部验证器比自选更差（−2.3 点）**，强跨族验证器才 +3.5 点 [报告](https://icml.cc/virtual/2026/82529)。⇒ `omb_verify`（形式自述）应当删除；要"核查"只能接**可外部判定**的检查器（tsc/eslint/vitest/git diff/编译）。
6. **"更多指令"是负优化，且有量化上限**：IFScale（500 条关键词指令，20 个前沿模型）最好模型仅 68% 遵循率，且**明显偏向靠前指令** [报告](https://arxiv.org/abs/2507.11538)。OMB 的 8 张方法卡 + 控制行 + 常驻句是同一类东西，且全语料 `omb_method` 仅 34 次。
7. **项目级上下文文件：有效的是"指令"，无效的是"仓库概览"**：两篇 2026 实证——AGENTS.md 使中位运行时 −28.64%、输出 token −16.58%、完成率相当（10 repo/124 PR）[报告](https://arxiv.org/abs/2601.20404)；但另一篇在 SWE-bench 与真实仓库上发现**成功率普遍不升、推理成本 +20%+，"repository overview"类内容无益**，只有"非标准实践指令"有用 [报告](https://arxiv.org/abs/2602.11988)。⇒ 用户抱怨 3 的正确解法是**项目指令/决策索引 + 仓库地图（结构索引）**，不是往上下文里灌项目概览。
8. **仓库地图是唯一被工程验证过的"项目理解"压缩件**：tree-sitter 抽符号 + PageRank 排序 + 二分拟合 token 预算（默认 1,024）；Aider 报 SWE-bench Lite 26.3%、文件定位正确率 70.3%，示例"87 token 取代约 12,000 token 全读" [报告](https://aider.chat/2023/10/22/repomap.html)。但**<20 文件的小仓无收益**、元编程重仓会失真、高频变更仓不如 agentic search [报告](https://raw.githubusercontent.com/agentpatterns-ai/website/refs/heads/main/context-engineering/repository-map-pattern.md)。
9. **技能/过程库有最强正面证据，但都是"2023–24 弱先验模型 + 离线 LLM 归纳"**：Voyager（3.3× 物品、15.3× 科技树）[报告](https://arxiv.org/abs/2305.16291)、AWM（Mind2Web +24.6%、WebArena +51.1% 相对）[报告](https://arxiv.org/abs/2409.07429)、ACE（agent +10.6%、finance +8.6%，ICLR 2026）[报告](https://arxiv.org/abs/2510.04618)、Dynamic Cheatsheet（AIME 翻倍、Game of 24 10%→99%）[报告](https://arxiv.org/abs/2504.07952)、ReasoningBank（ICLR 2026）[报告](https://arxiv.org/abs/2509.25140)。**没有一个在 2026 前沿模型 + 中文桌面插件 + 71 行存量上被复现**；它们的共同前提是"离线 LLM 预算 + 可判定的成败信号"，OMB 只有后者的一半。
10. **上下文方面的最强负面证据是 context rot**：18 个模型、只变长度不变难度，性能一致下降；LongMemEval 同题"聚焦输入约 300 token" vs "全量约 113k token"，全模型显著下降；**一个 distractor 就掉点**；甚至"打乱顺序的 haystack 反而更好" [报告](https://www.trychroma.com/research/context-rot)。⇒ 长上下文不是记忆，**"把工作区灌进去换深度理解"在学术上没有任何支持**。
11. **压缩/裁剪是有效但需调参的**：ACON 在 AppWorld/OfficeBench 把峰值 token 降 26–54% 且成功率不降反升（ICML 2026）[报告](https://arxiv.org/abs/2510.00615)；Anthropic 的 compaction 经验是"先最大化 recall 再压 precision、工具结果清理是最安全的一刀" [报告](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)。**但压缩会侵蚀细节（"context collapse/brevity bias"）**[报告](https://arxiv.org/abs/2510.04618)，且 2026 的 Leyline 指出生产 harness 每次编辑都重付 prefill——编辑策略本身有缓存代价 [报告](https://arxiv.org/abs/2606.01065)。
12. **最小脚手架 > 复杂脚手架**：mini-swe-agent 用 ~100 行、只用 bash、线性历史，在 SWE-bench Verified 上 >74% [报告](https://pypi.org/project/mini-swe-agent/)；作者明说"一年后，很多为模型定制的工具/接口已不必要"。这与用户第 4/5 条同向：**OMB 的加法规避不了"模型本身变强后脚手架边际收益为负"的趋势**，减法才是 2026 的正确方向。

---

## 1. 证据质量分级（决定上面数字怎么用）

| 等级 | 判据 | 本报告归入的证据 |
| --- | --- | --- |
| E1 独立审计/复现 | 有第三方审计或开源可复跑基准 | SWE-bench Pro 被 OpenAI/Datacurve/独立审计判"Flawed"（≥20–30% 任务有评分缺陷）[报告](https://epoch.ai/benchmarks/swe-bench-pro/review)；IFScale 开源基准；context rot 开源代码；MemoryBench 作者自评"SOTA 远不令人满意" |
| E2 作者自报 + 代码/数据开放 | 可复跑但无独立复现 | s1、ACE、AWM、Voyager、Dynamic Cheatsheet、GEPA、DSPy、TextGrad、ACON、LongMemEval、MemoryAgentBench |
| E3 作者自报 + 无代码或不可比 | 只能当方向 | Reflexion（HumanEval 91% vs 80%）、ExpeL（无统一榜单）、多数记忆产品榜（Mem0/Zep/MIRIX 均为厂商或作者自评） |
| E4 单点/workshop 级 | 方向可信、幅度不可外推 | Self-Verification Cliff（86 题 AIME、workshop）、ReasoningBank 博客数字 |
| 已污染/不要引用 | 分数不可比 | SWE-bench Pro 主榜（评分缺陷 + reward hacking）[报告](https://epoch.ai/benchmarks/swe-bench-pro/review)；GAIA/AgentBench/τ-bench 只作**能力方向**引用（GAIA：人 92% vs GPT-4+插件 15%；τ-bench：gpt-4o <50%、pass^8 <25%） |

**一条纪律**：凡"提升 X%"来自作者自报，本报告一律不用于估算 OMB 的预期收益；只用于判断**机制是否存在**。OMB 的任何收益必须在本机 391 会话语料上自测（§9 探针）。

---

## 2. 本机实测：OMB 在模型面上的真实足迹与缓存语义（本轮新增）

### 2.1 注入体量 [实测]

复跑方式：对 `%USERPROFILE%\.dsh\sessions\**\session.v4.jsonl.zstd` 逐帧解压（Node 24 `zlib.zstdDecompressSync`，按 `28 b5 2f fd` magic 切帧；单文件最多 12,341 帧），统计 `user/message` 且 `data.source.kind === 'runtime-context'` 的条数与文本长度。

| 读数 | 值 |
| --- | --- |
| 会话 / 事件 / step | 394 / 261,173 / 39,710 |
| OMB 运行时上下文快照条数 | **1,716**（379/394 会话出现过，96%） |
| 快照文本总量 | **1,395,193 字符**（≈ 388–423k token，按 3.3–3.6 字符/token） |
| 摊到每 step | **35.1 字符/step；中位 51.7**（≈ 11–16 token/step） |
| 单会话最大 | 122 条 / **83,545 字符**（≈ 23–25k token）；≥20 条的会话 22 个 |
| 对照：`omb_recall` 使用率 | 27/391 会话（6.9%）；`omb_method` 34 次；`omb_verify` 56 次（占工具调用 0.11%）[既有报告] |

### 2.2 缓存语义核实 [实测/源码]

| 事实 | 证据 |
| --- | --- |
| `systemPrompt.context()` 的产物**不是**系统提示段，而是渲染成 `user/message` 追加进会话 | `packages/core/agent-loop/src/agent.ts:411-413,428-440`：`renderContextSections` → `runtimeContext.project` → `session.append('user/message', context, {surfaceOp:'append'})` |
| 只在文本变化时提交新快照 | `runtime-context.ts:146-163`：`if (this.retained?.text === snapshot) return`；宿主语义为"新快照取代旧运行时上下文快照" |
| 系统提示是另一条通道（`section`/`renderPrompt`），变更走 in-history 更新 | `agent.ts:407,416-424`；`llm-deepseek/src/serialize.ts:64,106-116`（`systemPromptUpdate: 'in-history'`：新系统提示作为 system update 追加，而非改写历史） |
| 因此：**尾部快照不会使系统前缀缓存失效**；每请求变化的是最后一条消息，与"新用户回合"同性质 | 由上行推出 [推测，可证伪：对照开关 OMB 看 `prompt_cache_hit_tokens`] |
| DeepSeek 磁盘缓存按"前缀单元 + 公共前缀探测"命中；best-effort；几小时到几天清空；返回 `prompt_cache_hit_tokens` | [报告](https://api-docs.deepseek.com/guides/kv_cache) |
| 价格：flash cache hit $0.003–0.006/M、miss $0.15–0.30/M、output $0.60–1.20/M（off-peak/peak） | [报告](https://api-docs.deepseek.com/quick_start/pricing) |

**三个推论（用于裁决用户五条抱怨）**

- **[实测+推测] 钱的杠杆在输出侧**：一次请求 20k 输入（多数命中缓存）＋2k 输出 ≈ 输入 $0.00012 + 输出 $0.0024，**输出占 95%**。省输入的 ROI 低于省思考 2 个数量级。⇒ 抱怨 5（"当前优化可能是净负担"）在**成本维度成立**，但原因不是 OMB 花了钱，而是**它没有碰到真正的成本项**。
- **[实测] 每步 35 字符的注入，任何"再优化注入措辞"的动作上限收益都极小**；OMB 的收益只能来自"是否改变模型行为"（触发检索、改变档位、接外部核验），而不是"省字符"。
- **[推测] 长会话里快照可能累积**：单会话最大 122 条 / 83.5k 字符；若 surface 未替换旧快照，长会话尾部存在大量过期读数文本（context rot 的直接配方）。§9 给判死探针 P4。

### 2.3 用户五条抱怨的机制归因（本报告的统一口径）

| 用户抱怨 | 真实机制根因（本报告判定） | 学术对应机制 | 可实施性 |
| --- | --- | --- | --- |
| ① 不主动记、经验流失 | 写入 100% 靠模型自觉；**没有"可判定成功"的信号触发写入**；准入看字符串前缀而非工件 | 经验记忆/技能库（Voyager/ExpeL/AWM/RB/DC/ACE）；但都需"成败可判定" | 插件可做，但只能从**可核验事件**（测试通过、命令退出码、diff 落地）触发 |
| ② 记忆不是严谨互联网络 | 现存 71 行、1 条边；检索是 bigram OR 无下限；触发只有一句工具描述 | 记忆图（Zep/A-MEM/HippoRAG2）在 71 行上无收益；**多信号融合**才是可抄项 | 插件可做（零 LLM），但 ROI 取决于数据量 |
| ③ 项目理解浅、新会话烧未缓存 token | 新会话前缀与上次不同 ⇒ 只能吃"公共前缀"；且 OMB 没有项目级持久产物 | **跨会话稳定前缀 + 仓库地图 + 项目指令索引**（AGENTS.md 两篇 + Aider） | 插件可做（不写系统提示，写"稳定 section/文件"） |
| ④ 存在负优化 | 注入不生效（默认档 0 字符）、指令稀释（IFScale）、过度思考（2502.08235）、自验证天花板（Cliff） | 同上 | 删除即可 |
| ⑤ 无权重更新下推理/上下文优化或为净负担 | 多数机制"成本≈0、收益≈0"；真正有效的三个旋钮：**effort、检索、外部核验** | s1 / context rot / self-correct 三条负结果 | 插件可做，但幅度有限、需 A/B |

---

## 3. 机制级横向表（按机制而非按系统）

> 每行固定六列：机制要点 / 硬数字 / 证据等级 / 成本（token·时延·缓存）/ 插件可实施性 / 失败模式。**"插件可实施性"指不碰模型权重、不碰解码、只用 DSH 事件/工具/提示/请求参数。**

### 3.1 测试时算力与自适应努力

| 机制 | 硬数字 | 证据 | 成本 | 插件可实施 | 失败模式 |
| --- | --- | --- | --- | --- | --- |
| s1 budget forcing（强制截断/追加"Wait"） | 超 o1-preview 至多 27%；AIME24 50→57 | E2 [报告](https://arxiv.org/abs/2501.19393) | 需解码级控制或 SFT；采样成本×长度 | ❌ 无 token 级控制；只有 effort 三档 | 提示词写"不要展开"无强制力（既有 R2 §2.1 同结论） |
| 过度思考（overthinking） | o1 类在 2+3 上分配过量算力；提出过程/结果效率指标 | E2 [报告](https://arxiv.org/abs/2412.21187) | 指标免费 | ✅ 只借**指标**（outputTokens/步、正确但冗长率） | 用准确率单指标会奖励啰嗦 |
| Agent 场景过度思考 | 4,018 轨迹；Analysis Paralysis / Rogue Actions / Premature Disengagement；overthinking 分越高越差；选低分方案 +~30%、算力 −43% | E2 [报告](https://arxiv.org/abs/2502.08235) | 选优需 k 个样本 ⇒ 不可免费 | ⚠️ 只能做**回合边界降档**+事后指标；不能选优 | 需要多轨迹才能挑，单回合拿不到 |
| 思考不足（underthinking） | 频繁切换思路与错误相关；TIP 解码惩罚早切换 | E2 [报告](https://arxiv.org/abs/2501.18585) | 解码级 | ❌ 解码；只能借"切换/回退次数"做行为代理 | 与 loop 检测同层，阈值未标定 |
| 自适应预算（隐状态预测） | 同准确率下省 20–60% 思考 token | E3（见 R2 §2.1） | 需 adapter/隐状态 | ❌ | 不可实施 |
| `reasoningEffort` 三档 | DeepSeek `off/low/high/max`；DSH 已接线到 request header | [报告](https://api-docs.deepseek.com/guides/thinking_mode) + 本机 probe | 改档会改 header ⇒ **缓存失效**（E4） | ✅ 唯一真实旋钮 | 每 step 改档会把省下的钱赔进缓存；不支持该参数的模型会硬失败（E2） |
| 元认知"何时该想" | 在线只能离散三档 + 显式信号 | [推测] | 零 | ✅ 但只做"用户显式档位/任务类型" | 逐题预测做不到，别用规则文本假装 |

### 3.2 自验证 / 过程奖励 / 元认知

| 机制 | 硬数字 | 证据 | 成本 | 插件可实施 | 失败模式 |
| --- | --- | --- | --- | --- | --- |
| 内在自我纠错（无外部反馈） | 推理任务上无法自纠，**有时更差** | E1 [报告](https://arxiv.org/abs/2310.01798) | 一次额外调用 | ✅ 但**应删** | 与 OMB `omb_verify` 同形态：读自述，读不出对错 |
| Self-Verification Cliff | 54.7% 含正解 vs 41.9% 自选（回收 36%）；跨族强验证 +3.5、弱验证 −2.3；多数投票救不了 | E4 [报告](https://icml.cc/virtual/2026/82529) | 验证器一次调用 | ⚠️ 只有"另一个模型/可执行检查"可行 | 用同模型自审 ≈ 自选；弱审查更差 |
| 过程奖励 PRM | 过程监督 > 结果监督（78% MATH） | E2 [报告](https://arxiv.org/abs/2305.20050) | 需训练 PRM | ❌ | 插件给不了 PRM；只能给"可核对产物"（file:line、命令、diff） |
| 自一致性/多数投票 | 数学显著提升，但需可比答案 | E2 [报告](https://arxiv.org/abs/2203.11171) | 成本×k | ❌ 单轨迹无 vote 面 | agent 输出不可比对 |
| "think" 工具 | τ-bench：think+提示 0.570 vs 裸 think 0.404 vs extended thinking 0.412 vs baseline 0.332；SWE-bench +1.6%（n=30）；官方 2025-12 说多数场景直接用 extended thinking | E3 [报告](https://www.anthropic.com/engineering/claude-think-tool) | 工具 schema + 每次回执 | ✅ 形态可抄，**但收益主要来自"提示协同"**，OMB 缺的正是协同 | 裸工具≈无收益；长指引放系统提示更有效 |
| Agent-as-a-Judge | 与人工基线相当，远好于 LLM-as-judge | E2 [报告](https://arxiv.org/abs/2410.10934) | 一条 agent 轨迹/评审 | ⚠️ 只在显式要求时用 subagent | 成本=一次完整调用；评审者弱则负收益（见 Cliff） |

### 3.3 经验 → 技能库 / 程序记忆（"无权重自改进"主线）

| 机制 | 硬数字 | 证据 | 成本 | 插件可实施 | 失败模式 |
| --- | --- | --- | --- | --- | --- |
| Voyager 技能库 | 3.3× 物品、2.3× 距离、15.3× 更快科技树；技能=可执行代码，检索后组合 | E2 [报告](https://arxiv.org/abs/2305.16291) | 离线归纳 LLM 调用；在线检索少量 token | ⚠️ 插件侧要"可执行技能"=脚本+说明，DSH 可行 | 2023 年 GPT-4 弱先验环境；代码技能与 Minecraft 强绑定 |
| Reflexion 言语强化 | HumanEval 91% pass@1 vs GPT-4 80% | E3 [报告](https://arxiv.org/abs/2303.11366) | 每 trial 一次反思 | ✅ 形态简单（反思文本进缓冲） | 依赖外部反馈信号；无信号时退化为自我安慰（见 2310.01798） |
| ExpeL 经验学习 | 无参数更新，跨任务迁移（定性） | E3 [报告](https://arxiv.org/abs/2308.10144) | 离线抽取 | ✅ | 抽取质量未量化；与 AWM 同类 |
| Agent Workflow Memory | Mind2Web +24.6%、WebArena +51.1%（相对）；在线版本在分布差拉大时 +8.9–14.0 绝对点；步骤更少 | E2（ICML 2025）[报告](https://arxiv.org/abs/2409.07429) | 离线归纳 + 每任务注入一个 workflow | ⚠️ 需要"重复任务族"；OMB 的跨项目任务族不明 | Web 导航专用；工作流与站点强绑定 |
| ACE 演化 playbook | agent +10.6%、finance +8.6%；AppWorld 平均追平榜首、难 split 超过；**显式对抗 brevity bias 与 context collapse** | E2（ICLR 2026）[报告](https://arxiv.org/abs/2510.04618) | 离线/在线反思循环；结构化增量更新 | ⚠️ 需要"执行反馈"与一个 curator；可作为**离线整合**的理论依据 | 迭代重写会侵蚀细节——正是"记忆库不如原文"的机制解释 |
| ReasoningBank | 从自判成败中蒸馏"可泛化推理策略"；MaTTS 记忆感知的测试时扩展 | E2（ICLR 2026）[报告](https://arxiv.org/abs/2509.25140) | 需要成败信号与额外 rollout | ⚠️ 同 ACE | 自判成败本身不可靠（Cliff） |
| Dynamic Cheatsheet | AIME 翻倍、Game of 24 10%→99%、GPQA-D +9%、MMLU-Pro +8%；**自 curated、短片段、不需标签** | E2 [报告](https://arxiv.org/abs/2504.07952) | 在线维护小抄（一次 LLM 调用/任务） | ⚠️ 可做"项目小抄"，但需要写入触发 | 无标签时靠自判；错的小抄会复利 |
| 睡眠时计算 | 同精度下测试时算力降 ~5×；accuracy +13%/+18%；**收益与"查询可预测性"强相关** | E2 [报告](https://arxiv.org/abs/2504.13171) | 离线预算；按可预测查询摊薄 | ✅ 离线整合只在"高频问题模板"上做 | 不可预测查询上纯亏 |

**这一组的总判决**：机制真实、方向一致（"把经验压成少量可复用片段，而不是塞更多提示"），但**全部依赖一个 OMB 目前没有的东西：可判定的成败信号**。OMB 有 `execution:` 字符串（自签），没有"这次任务成了"的事件。⇒ 技能库路线的前置条件是**先建"任务结束 + 可核验结果"的事件模型**，否则是在给自说自话建索引（与既有 memory 报告同结论）。

### 3.4 上下文工程

| 机制 | 硬数字 | 证据 | 成本 | 插件可实施 | 失败模式 |
| --- | --- | --- | --- | --- | --- |
| Context rot | 18 模型、长度↑性能↓；LongMemEval 聚焦 ~300 token vs 全量 ~113k，全模型下降；1 个 distractor 即掉点；结构化 haystack 反而更差 | E2（开源可复跑）[报告](https://www.trychroma.com/research/context-rot) | — | 提供判据：任何"多塞"方案先证伪 | 别把 NIAH 当长上下文能力 |
| Lost in the middle | 相关信息在中段显著掉点（TACL 2023） | E1 [报告](https://arxiv.org/abs/2307.03172) | — | 决定"把什么放哪"：关键在首尾 | 中段注入 = 白写 |
| RULER | 17 个长上下文模型，宣称 32K+，仅一半在 32K 保持可用 | E2 [报告](https://arxiv.org/abs/2404.06654) | — | 同上 | 厂商标称窗口不可信 |
| 指令密度（IFScale） | 500 条时最好模型 68%；偏向靠前指令；三种退化形态 | E1（开源基准）[报告](https://arxiv.org/abs/2507.11538) | — | 直接判 OMB"控制散文"死刑 | 长 system prompt 里越靠后越无效 |
| 渐进披露 / Skills | 元数据（name+description）常驻，正文按需读；三级（SKILL.md → 引用文件 → 代码） | E3 厂商 [报告](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills) | 常驻≈每技能一行；正文只在触发时付费 | ✅ DSH 有 read/glob/grep + 文件系统，可原样实现 | 需要"技能被想起来"的触发设计；否则等于没有 |
| 动态工具加载 / tool search | 工具多时按需检索工具定义 | E3 厂商 [报告](https://code.claude.com/docs/en/agent-sdk/tool-search) | 省工具 schema 常驻 | ⚠️ DSH 工具目录稳定是缓存策略（本地 dsh-capabilities §2），改动会抖缓存 | 工具少时无收益（OMB 只有 10 个工具） |
| JIT 检索 / agentic search | Claude Code 不建索引，glob/grep/read 按需；文件夹/命名/时间戳本身是元数据 | E3 厂商 [报告](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) | 每步少量工具结果 | ✅ 已经是宿主能力，OMB 不应重复 | 比预计算慢；需要好的启发式 |
| 子代理隔离 | 子代理返回 1–2k token 摘要；多代理系统比单代理 +90.2%，但 token ×15（agent 本身 ×4）；token 用量解释 80% 方差 | E3 厂商 [报告](https://www.anthropic.com/engineering/multi-agent-research-system) | 4–15× token | ✅ DSH subagent/agent-team 已有 | 编码任务并行度低；同步等待成瓶颈；成本高 |
| Compaction / 工具结果清理 | ACON：峰值 token −26–54% 且成功率不降反升；小模型 +46% | E2（ICML 2026）[报告](https://arxiv.org/abs/2510.00615) | 一次摘要调用 | ✅ 宿主已做 compaction；OMB 不应自造 pruner | 过度压缩丢细节（brevity bias）；压缩点选择影响大 |
| 上下文编辑与缓存 | 生产 harness 每次编辑都重付 prefill；Leyline 的 splice 把 replay cache-hit +11.2pp、延迟 −241ms；十行截断规则 +14.3pp solve rate | E2 [报告](https://arxiv.org/abs/2606.01065) | 编辑策略=缓存代价 | ⚠️ 宿主内部机制，OMB 只能"少改历史" | 每步改注入/改 effort 都会抖缓存 |
| 工具返回值设计 | detailed 206 token vs concise 72 token（~1/3）；工具描述精修曾把 Sonnet 3.5 推到 SWE-bench Verified SOTA | E3 厂商 [报告](https://www.anthropic.com/engineering/writing-tools-for-agents) | 直接省 token | ✅ OMB 工具回执可抄（snippet 默认、按需 full） | 过度精简丢续调所需 ID |

### 3.5 记忆架构与评测

| 机制 | 硬数字 | 证据 | 对 OMB 的含义 |
| --- | --- | --- | --- |
| MemGPT/Letta 虚拟上下文 | 分页/换出；函数调用搬数据 | E2 [报告](https://arxiv.org/abs/2310.08560) | "精简索引 + 按需展开"与 120 预算同构；但 71 行不需要分页 |
| Mem0 | LoCoMo 相对 +26%（judge）；p95 延迟 −91%；**OSS v3 已从图退回 ADD-only** | E3 [报告](https://arxiv.org/abs/2504.19413) | 抄"多信号融合"，不抄"写入时 LLM 抽取"；图不是必然方向 |
| A-MEM | Zettelkasten 笔记 + 回溯更新旧笔记 | E2 [报告](https://arxiv.org/abs/2502.12110) | "演化旧笔记"破坏逐字保真 ⇒ 不做 |
| Zep/Graphiti | 双时间轴 + 混合检索；DMR 94.8 vs MemGPT 93.4 | E3 [报告](https://arxiv.org/abs/2501.13956) | 只有"双时间轴字段语义"值得补（OMB 已有 validTo） |
| HippoRAG 2 | KG + PPR 多跳；联想 +7% | E2（ICML 2025）[报告](https://arxiv.org/abs/2502.14802) | 索引需 OpenIE（LLM）⇒ 不做 |
| MemoryOS | 短/中/长三级；F1 +49.11（GPT-4o-mini 基线） | E3 [报告](https://arxiv.org/abs/2506.06326) | 三级在 71 行上无收益 |
| MIRIX | 六类记忆；ScreenshotVQA +35%、存储 −99.9% | E3 [报告](https://arxiv.org/abs/2507.07957) | 只借"原始材料 vs 结论分离"（= 会话留 DSH、结论留 OMB） |
| MemoryBank | 艾宾浩斯遗忘曲线 | E3 [报告](https://arxiv.org/abs/2305.10250) | OMB 已有半衰期排序先验，够了 |
| LongMemEval | 500 题/5 能力；商业助手与长上下文模型掉 30%；给 indexing/retrieval/reading 三阶段与三条优化 | E2 [报告](https://arxiv.org/abs/2410.10813) | 直接用作 OMB 自评口径："知识更新/拒答"对应 supersede 与零命中 |
| MemoryAgentBench | 四能力（准确检索/测试时学习/长程理解/选择性遗忘）；**没有方法全部掌握** | E2 [报告](https://arxiv.org/abs/2507.05257) | 别指望"补一个模块"解决记忆 |
| MemoryBench | 用户反馈式持续学习；作者自评 SOTA"远不令人满意" | E2 [报告](https://arxiv.org/abs/2510.17281) | 说明"记忆不行"是行业普遍问题，不是 OMB 落后 |

### 3.6 提示/程序优化与"脚手架税"

| 机制 | 硬数字 | 证据 | 对 OMB 的含义 |
| --- | --- | --- | --- |
| DSPy | 编译后比标准 few-shot 高 25%/65%；需 metric + 训练集 | E2 [报告](https://arxiv.org/abs/2310.03714) | 需要"可自动打分"的任务集；OMB 没有 gold answer ⇒ 只能离线做小范围 |
| TextGrad | GPQA 51→55；LeetCode-Hard 相对 +20% | E2 [报告](https://arxiv.org/abs/2406.07496) | 同上；适合优化"固定几段文本"，不适合在线 |
| GEPA | 比 GRPO 平均 +6%（至多 +20%）、rollout 少 35×；超 MIPROv2 10%+（AIME-2025 +12%） | E2（ICLR 2026 oral）[报告](https://arxiv.org/abs/2507.19457) | 若要做"提示进化"，GEPA 是当前最优选；但需要评测集与多次 rollout |
| mini-swe-agent | ~100 行、只用 bash、线性历史，SWE-bench Verified >74% | E2 [报告](https://pypi.org/project/mini-swe-agent/) | **脚手架税**的直接证据：复杂脚手架不是必需品 |
| AGENTS.md（效率） | 10 repo/124 PR：中位运行时 −28.64%、输出 token −16.58%、完成行为相当 | E2 [报告](https://arxiv.org/abs/2601.20404) | 项目级指令能省时省 token，**但不提升成功率** |
| AGENTS.md（成功率） | SWE-bench + 真实仓库：成功率普遍不升、推理成本 +20%+；"repository overview"无益；指令被良好遵循 | E2 [报告](https://arxiv.org/abs/2602.11988) | ⇒ 只写"非标准实践/约定"，不写"项目概览/架构导览" |
| 最小外部工具原则（position） | 工具只在"认知上必要"时调用；过度委派阻碍内部推理发展 | E3 [报告](https://arxiv.org/abs/2506.00886) | 反"更多工具/更多检索"的规范依据；OMB 工具数是 10，不是瓶颈 |
| 仓库地图 | 默认 1,024 token；SWE-bench Lite 26.3%、文件定位 70.3%；示例 87 token 代替 12,000 | E2 [报告](https://aider.chat/2023/10/22/repomap.html) | 唯一有工程验证的"项目理解压缩"；小仓/元编程仓不适用 |

---

## 4. 证据排序：harness 层什么有效、什么无效、什么未知（交付项 1）

> 判据三条：① 机制不依赖模型内部；② 有不依赖厂商自报的机制证据；③ 本机可测。

### 4.1 有效（建议保留/实施）

| # | 机制 | 证据强度 | 预期幅度（对 OMB 的可测上限） | 备注 |
| --- | --- | --- | --- | --- |
| W1 | `reasoningEffort` 真实降档（回合边界） | 强（厂商参数 + s1/overthinking 机制） | outputTokens 可测下降；准确率影响未测 | 唯一碰"输出成本"的旋钮；每 step 改会抖缓存 |
| W2 | 上下文裁剪：工具结果清理、snippet-first 回执、compaction | 强（ACON/Anthropic/本机 3,877→1,600 字符目标） | 峰值 token −20–50%；决策质量不降 | 宿主已做 compaction，OMB 只应做"回执形态" |
| W3 | JIT 检索 + 渐进披露（不常驻正文） | 中（厂商 + 机制一致） | 常驻 token↓、触发率↑（待测） | DSH 已具备 read/glob/grep |
| W4 | 外部可核验器（tsc/eslint/vitest/git diff/退出码） | 强（2310.01798 + Cliff 反向证明） | 直接提升"结论可核验率" | OMB 的 verify 应改成"跑检查器"，不是"读自述" |
| W5 | 跨会话逐字节稳定的项目前缀 | 强（DeepSeek 缓存语义 + 价格） | 新会话输入成本 −30–50×（命中部分）；首 token 延迟↓ | 必须无时间戳/会话 id/计数器 |
| W6 | 项目级"非标准实践"指令文件 | 中（两篇实证方向一致：只指令有效） | 运行时间 −28% 量级（外推，不可承诺） | 不写概览；写约定/命令/坑 |
| W7 | 仓库地图（结构索引，按 token 预算拟合） | 中（Aider 工程数据） | 定位步数↓（大仓）；小仓零收益 | tree-sitter 是新增依赖，需评估 |
| W8 | 子代理隔离（显式、少量） | 中（Anthropic + DSH 原生） | 主上下文噪声↓；成本 ×4–15 | 只在显式要求/高风险时用 |

### 4.2 无效或负收益（建议删除/不做）

| # | 机制 | 反向证据 | 在 OMB 里的形态 |
| --- | --- | --- | --- |
| L1 | 内在自我纠错 / 形式验证台账 | 2310.01798；Cliff | `omb_verify` + 验证段（3 会话/391） |
| L2 | "多想想/更仔细/别展开"类散文 | s1（长度不可由提示控制）；2502.08235（想太多更差）；IFScale（指令越多越不遵循） | `controlLine` 五段表、档位散文、R2/R3 卡 |
| L3 | 更多规则/卡片（8 张方法卡） | IFScale 偏差 + 近零使用（34 次） | `methods.ts` 8 张 + 3 个工具 schema 1,442 字符 |
| L4 | 项目概览式上下文（"这是本项目架构…"） | 2602.11988（无益、+20% 成本） | 若未来做"项目记忆"，只能写指令/决策，不写概览 |
| L5 | 写入时 LLM 抽取 / 在线改写记忆 | brevity bias + context collapse（ACE）；Mem0 回退 ADD-only；本机 71 行 | 明确不做 |
| L6 | 图/社区/多级/六类记忆扩建 | mem0 图回退；MemoryOS/MIRIX 规模不匹配 | 保留 edge，不扩建 |
| L7 | 自一致/多采样投票/选优 | 成本×k；Cliff 说投票救不了 | 单轨迹 agent 没有 vote 面 |
| L8 | 每次变化都注入的"读数段" | 本机：96% 会话有注入、每 step 35 字符、单会话最大 83.5k 字符；context rot | 运行时快照（压力/拉取/循环/验证行） |

### 4.3 未知（需要实验，不要先写代码）

| # | 问题 | 已知 | 缺什么 |
| --- | --- | --- | --- |
| U1 | 降 effort 对真实编码任务的成功率影响 | 机制上省 token；overthinking 文献支持"降档可能更好" | 本机 A/B（P1） |
| U2 | 跨会话项目前缀能吃到多少缓存 | 语义支持；价格差 50× | 本机 `prompt_cache_hit_tokens` 对照（P2） |
| U3 | 技能库在 2026 前沿模型 + 中文项目上是否还有增量 | 弱先验时代证据强；AGENTS.md 说明"指令有效、概览无效" | 20 回合 A/B（P3） |
| U4 | 运行时快照是否在 surface 累积 | 单会话 122 条/83.5k 字符 | 读 `contextBreakdown.messageTokens` 对照（P4） |
| U5 | 中文检索精度（bigram OR 无下限）能靠零 LLM 修到多少 | 既有报告：top-1 30% | 53 条真实查询回归集（已有） |

---

## 5. 四个激进架构选项（交付项 2）

> 每个选项给：机制 / 对五条抱怨的预期 / 成本 / 风险 / 判死条件（kill criteria）/ 最小实验。**所有选项都默认"不碰模型内部、不碰解码、只用一个插件"。**

### 选项 A：技能/过程库（Skill & Process Library）——"把提示换成可检索的程序性文件"

- **机制**：删除 8 张方法卡、控制散文、验证段；改为项目内 `.omb/skills/*.md`（每份 = 触发条件 + 步骤 + 判据 + 失败模式）。常驻只有**索引行**（每技能 name+一句话；10 个技能约 150–250 字符，需与现有常驻句共享预算或压进工具描述），正文由模型用 read/glob 按需加载（DSH 渐进披露的原生形态）。写入不靠模型自觉，而靠**可核验事件**触发（一次 `vitest`/`tsc`/`git diff` 成功或失败后，提示一次性"把这次的可复用步骤存为技能"）。
- **学术对应**：Voyager 技能库、AWM、ACE、Dynamic Cheatsheet、Anthropic Skills 三级披露。
- **对五条抱怨**：① 部分（经验以文件形式沉淀，但写入仍需触发）；② 部分（技能之间用路径/引用形成"网络"，比 DB 边更可读）；③ 否；④ 是（删掉最重的散文）；⑤ 是（把"想"换成"查"）。
- **成本估算**：常驻索引 ≈ 150–250 字符（10 技能）；正文每次触发 200–800 token；离线无 LLM（写入由模型在自己回合内完成）。开发：新增 2 个工具（`omb_skill_save`/`omb_skill_list`）+ 文件约定，约 400–600 行 + 测试。缓存：技能文件不进系统提示 ⇒ 不抖前缀。
- **风险**：技能腐化（写进去的步骤过时）、触发不到（和 recall 同病：模型想不到读）、技能间冲突、用户不可见。
- **判死条件**：20 回合实验内，"技能被读取率" < 20%，或读技能后的回合成功/少走弯路无可观测差异；或技能文件 30 天内无人更新且命中 0 次 ⇒ 回滚为 B。
- **最小实验**：同一批真实任务（取 10 个本机历史任务）A/B：有技能库 vs 无；指标 = 工具调用数、重复动作率、人工判读"是否少走弯路"。

### 选项 B：项目记忆优先 + 仓库地图（Project-Memory-First + Repo Map）——"为每个项目造一个稳定、可复用的前缀"

- **机制**：每个项目生成并维护三件只读产物：① `repo map`（tree-sitter 抽符号 + PageRank + 二分拟合到 ~1,024 token）；② `DECISIONS.md`（结论/约定/命令/坑，逐条带来源与日期，逐字稳定）；③ 索引行（放进**系统提示 section**，不是运行时快照）。**关键约束**：这三件必须逐字节稳定（无时间戳、无会话 id、无计数），才能吃到 DeepSeek 的跨会话公共前缀缓存；会话内变量（压力、拉取台账）继续走尾部快照。写入用事件驱动：`git commit`/测试通过/用户显式纠正时，提示一次性更新 DECISIONS（不自动写）。
- **学术对应**：Aider repo map（1,024 预算、87 vs 12,000 token）、AGENTS.md 两篇（只写指令不写概览）、DeepSeek 前缀缓存、Anthropic "CLAUDE.md + glob/grep 混合"。
- **对五条抱怨**：① 是（决策有落点）；② 部分（决策/技能按项目成网，跨项目用户库仍在）；③ **直接命中**（新会话第一请求就有稳定前缀 ⇒ 缓存命中 + 项目理解）；④ 是（替代"每回合灌读数"）；⑤ 部分（把"上下文优化"从"每步注入"改成"一次生成、长期复用"）。
- **成本估算**：repo map 生成 CPU 秒级（无 LLM）；1,024 token/请求 **但命中缓存**（价格约 1/50）；DECISIONS 注入 ~300–600 token（缓存）。新依赖：tree-sitter（或先用 `git ls-files` + 正则/ctags 降级）。开发：map 生成器 500–800 行 + 文件生命周期 200 行。
- **风险**：map 过期（每次会话开头重算，成本可接受）；元编程仓失真；小仓无收益（阈值 <20 文件跳过）；**字节稳定性极易被破坏**（任何时间戳/排序不稳定就废掉缓存）；DECISIONS 变成第二个"记忆库垃圾场"（需准入）。
- **判死条件**：实现后 20 个新会话对照，`prompt_cache_hit_tokens / (hit+miss)` 相对基线提升 <10 个百分点；或"首步即定位到正确文件"的比例无提升；或 map 生成 >3s 且会话数 <50 时不值得。
- **最小实验**：先在**只读脚本**里为 OMB 仓库与本机另两个真实项目生成 map（不接线），人工判读"是否覆盖架构主干"；再测同一 prompt 两次请求的 cache hit 差异（P2）。

### 选项 C：诊断优先 / 观测器（Diagnostics-Only）——"先承认不知道，再只报能核对的数"

- **机制**：删除所有认知注入与控制散文；OMB 只保留：① 读数（压力/缓存/压缩/工具调用/重复动作，全部带来源与时间）；② 检索台账（拉取次数、命中率、跳过原因）；③ 外部核验器调度（把 tsc/eslint/vitest/git diff 的退出码与摘要作为"验证"的唯一形态，由模型显式调用）；④ 一条**事件驱动**的 ≤80 字符提示（只在真触发时：循环信号、压缩后结论过期、未闭合结论）。不写"你应当…"，只写"事实：X 发生了"。
- **学术对应**：2310.01798（自纠失败）、Cliff（自验证天花板）、Anthropic "最小高信号 token"、mini-swe-agent（少脚手架）、Leyline（少改历史）。
- **对五条抱怨**：④ 是（直接删）；⑤ 是（承认无权重下优化幅度有限，把 OMB 定位成仪器）；① 部分（观测到"该记"的时刻，但不自动记）；② 否；③ 否（不造项目前缀）。
- **成本估算**：模型面 token 从 ~500–520/请求 降到 ~50–150/请求；开发是**删代码**（−1,500～−2,000 行）；零新依赖。收益：噪声归零，为 A/B 提供干净基线。
- **风险**：用户感知"什么都没了"；失去唯一的差异化；宿主的 status/工具已覆盖部分功能 ⇒ 可能被完全替代（这本身是有效的判死结果）。
- **判死条件**：若删除后 10 个会话的"用户显式抱怨/纠正率"与"任务完成判读"不劣于基线，则 OMB 的认知注入永久删除；若明显变差，说明注入有真实价值，需保留最小版（反向证据，也算收益）。
- **最小实验**：配置开关关闭全部注入（保留工具），跑 10 个真实任务，与开启状态对照 outputTokens、工具调用数、人工判读。

### 选项 D：分层混合（推荐）——C 为底座 + B 为项目层 + A 为经验层

- **机制**：三层各只贡献一种信息，禁止跨层重复：
  - **L0 诊断层（C）**：读数 + 外部核验器 + 台账；零散文。
  - **L1 项目层（B）**：稳定项目前缀（repo map + DECISIONS 指令 + 索引行）进系统提示 section；逐字节稳定；缓存友好。
  - **L2 经验层（A）**：技能/结论文件，JIT 读取；写入由可核验事件触发、由用户或模型显式确认。
  - **唯一常驻句**（若保留）：≤80 字符，"跨会话结论用 omb_recall 查；项目约定见 DECISIONS.md"——且必须与 L1 的索引行合并，不新增第二条。
- **对五条抱怨**：① L2 触发 + L1 落点；② L2 文件引用 + 既有边；③ L1 直接命中；④ L0 删除负优化；⑤ 承认边界：能做的只有 effort、检索、核验、缓存四件事。
- **成本估算**（保守）：模型面常驻 150–300 token（大部分命中缓存）；每会话一次性 map 生成 CPU 秒级；离线无 LLM（技能写入在模型回合内）；开发 ~1,200–1,800 行（其中约 1,000 行是删除）。**不做**：GraphRAG、写入时抽取、多级记忆、LLM 重排、PRM。
- **风险**：三层职责漂移（又变成"到处都注入"）；DECISIONS 质量差；map 依赖 tree-sitter；L1 的字节稳定性由多人/多会话协作破坏。
- **判死条件**：阶段门——L1 若在 20 会话内无法把 cache-hit 比例提升 ≥10pp 或无法证明"首步定位"提升，砍掉 map 只留 DECISIONS；L2 若 30 天内技能命中 <10 次，砍掉；L0 若被证明注入有正面价值，把最小事件行加回。**任何一层不得以"以后会更好"为由保留。**
- **最小实验**：按 L0 → L1 → L2 顺序上线，每层单独 A/B，不叠加；每层留 config 开关与一个可回滚 commit。

---

## 6. 推荐排序与删/留清单（交付项 3）

### 6.0 推荐序列与五条抱怨的对应（先看这张表）

| 序 | 动作 | 直接命中 | 不命中 | 可测幅度（保守） |
| --- | --- | --- | --- | --- |
| 1 | L0 诊断层（删注入/删 verify/接外部核验器） | ④ ⑤ | ①②③ | 模型面 token −60%~−80%；噪声归零；"可核验结论率"可测 |
| 2 | R1 effort 映射（回合边界） | ⑤（成本） | ①②③④ | outputTokens 可测下降；准确率影响待 P1 |
| 3 | L1 项目层（DECISIONS + repo map + 稳定前缀） | ③（直接）①（落点） | ②④⑤ | 新会话缓存命中率↑；首步定位率↑ |
| 4 | L2 经验层（技能库，事件触发） | ① ②（部分） | ③④⑤ | 技能读取率、重复动作率 |
| 5 | 检索精度/输出形态（M3/M2） | ② ① | ③④⑤ | top-1 30%→60%；3,877→1,600 字符 |

> 若只能做一件事：**1**（纯删、证据最硬）。若只能解决"项目理解"：**3**。**2** 与 **1** 不冲突，可同批。**4** 必须等 1 落地并跑通"可判成败事件"再做。

### 6.1 排序（按"证据强度 × 可实施性 ÷ 风险"）

| 序 | 动作 | 理由 | 与 v3.7 Wave 1 的关系 |
| --- | --- | --- | --- |
| 1 | **L0 诊断层落地（删注入/删散文/删 verify，接外部核验器）** | 负结果证据最硬（2310.01798 / Cliff / IFScale / 2502.08235）；纯删代码、零新风险 | 比 Wave 1 的 R2 更激进：R2 只删控制散文，本报告建议连"验证段/读数段/档位散文"一起删，只留事件行 |
| 2 | **R1 effort 映射（回合边界）** | 唯一真实算力旋钮；输出 token 是成本的 95% | 与 Wave 1 一致；补"只在 `omb_focus`/回合边界改档"（probe E4） |
| 3 | **L1 项目层（DECISIONS + repo map + 稳定前缀）** | 直接命中抱怨 3；有两篇 AGENTS.md + Aider 工程证据；缓存收益可测 | Wave 1 未覆盖（新） |
| 4 | **L2 经验层（技能库，事件触发写入）** | 机制证据强但属"弱先验时代"；需先有可判定成败信号 | 取代 Wave 2 的 D1/D2 讨论；方法与 Wave 1 的 M4（写入可核验）同源 |
| 5 | 记忆检索精度（M3）与输出形态（M2） | 已有回归集与目标（top-1 30%→60%、3,877→1,600 字符） | 与 Wave 1 一致，保持 |

### 6.2 应删除（有证据）

| 删除项 | 证据 |
| --- | --- |
| `omb_verify` 工具 + 验证台账 + 验证段 | 2310.01798；Cliff；本机 0.11% 使用、3 会话注入 |
| `controlLine` 五段表 / `controlForBand` / 档位散文 | IFScale（指令密度）；s1（提示控不住长度） |
| 8 张方法卡（或压到 ≤2 张并入工具描述） | 34 次使用 vs 1,442 字符 schema/请求；IFScale |
| 运行时读数段（压力/拉取/循环/验证逐回合文字） | 本机 96% 会话有注入、每 step 35 字符；context rot；改为事件行 |
| `admission.ts` 服务面与零消费者的 context 服务 | 既有 context 报告：零生产消费者 |
| 第二个常驻提示 / 常驻预算抬升 | `docs/context-budget.md` §一；"同一件事只说一遍" |
| 写入时 LLM 抽取、GraphRAG/社区摘要、三级/六类记忆、LLM 重排、PRM、self-consistency | §3 各行；mem0 图回退；MemoryOS/MIRIX 规模不匹配 |

### 6.3 应保留（有独立理由）

- **中文词法检索通道**（bigram FTS）：DSH `fts5(unicode61)` 实测不能中文子串匹配，这是 OMB 唯一不可替代的能力（既有 memory §4）。
- **结论的有效性/溯源**：`valid_to`/`superseded_by`/逐字保真——DSH 只有原始事件，没有"这条结论已被推翻"的语义。
- **写入准入的方向**（精度优先），但依据要换成**工件核验**（本报告额外建议：把"执行成功"定义成可核验事件，而不是字符串前缀）。
- **`reasoningEffort` 映射**（新）：唯一真实算力杠杆。
- **外部核验器调度**（新）：把"验证"从文本自述换成退出码/测试结果。
- **跨项目用户库**（semantic）：DSH 工作区授权是精确 cwd，跨项目面只有 OMB。

---

## 7. 对 v3.7 计划的三处修正（避免把错误前提施工进去）

| # | v3.7 的前提 | 本报告核实 | 建议 |
| --- | --- | --- | --- |
| 1 | "常驻提示进入系统提示稳定前缀；任何跨轮变化都会使其后的整段前缀缓存失效"（`docs/context-budget.md` §二） | `systemPrompt.context()` 产物是**尾部 user/message 快照**（`agent.ts:428-440`），不是系统提示 | 修正文档；把"逐字节稳定"的要求移到**跨会话项目前缀（L1）**上；常驻句的字节稳定仍有价值（减少快照提交次数），但不是"否则全量缓存失效" |
| 2 | M1 内存常驻句与推理常驻句争夺 120 字符 | 若两者都在同一快照里，成本是"每 step 字符数"，量级 ~几十 token；真正稀缺的是**注意力**不是字符 | 合并为一条 ≤80 字符的"入口句"，其余全部进工具描述/文件（与 `context-budget.md` §四一致） |
| 3 | R1 effort 映射只需"下一请求生效" | probe-followup E4：effort 计入 header 变化，**每次变化都会抖 request 缓存** | 只在 `omb_focus`/回合边界改；不随压力/循环自适应改档（除非先测出收益 > 缓存损失） |

---

## 8. "不要做"清单（带引用，交付项 4）

1. **不要做内在自我纠错/自省式验证**：无外部反馈时推理不能自纠、可能更差（[2310.01798](https://arxiv.org/abs/2310.01798)，ICLR 2024）；自我验证存在结构性天花板，弱验证器比自选更差（[Self-Verification Cliff](https://icml.cc/virtual/2026/82529)）。
2. **不要用散文控制思考长度/深度**：长度只能作用在生成上（[s1](https://arxiv.org/abs/2501.19393)）；agent 场景"想更多"与更低成功率相关（[2502.08235](https://arxiv.org/abs/2502.08235)）。
3. **不要自一致/多采样投票/PRM**：成本×k 且单回合无 vote 面（[Self-Consistency](https://arxiv.org/abs/2203.11171)）；PRM 需训练（[2305.20050](https://arxiv.org/abs/2305.20050)）。
4. **不要往提示里继续加规则/卡片/读数段**：500 条指令下最好模型 68%、偏向靠前（[IFScale](https://arxiv.org/abs/2507.11538)）；长上下文本身在掉点（[context rot](https://www.trychroma.com/research/context-rot)、[RULER](https://arxiv.org/abs/2404.06654)、[lost-in-the-middle](https://arxiv.org/abs/2307.03172)）。
5. **不要写"仓库概览/架构导览"式项目记忆**：两篇 2026 实证——概览无益、成本 +20%+；只有"非标准实践指令"有效（[2602.11988](https://arxiv.org/abs/2602.11988)、[2601.20404](https://arxiv.org/abs/2601.20404)）。
6. **不要把写入交给 LLM 抽取/在线改写**：brevity bias 与 context collapse 是结构性缺陷（[ACE](https://arxiv.org/abs/2510.04618)）；mem0 已从图退回 ADD-only（[2504.19413](https://arxiv.org/abs/2504.19413)）；本机存量 71 行喂不起。
7. **不要扩建图/社区/多级/六类记忆**：在 71 行、1 条边上无收益；MemoryBench 自评 SOTA 远不令人满意（[2510.17281](https://arxiv.org/abs/2510.17281)）；MemoryAgentBench 显示没有方法掌握四能力（[2507.05257](https://arxiv.org/abs/2507.05257)）。
8. **不要每 step 改注入内容或 effort**：会重付 prefill/缓存（[Leyline](https://arxiv.org/abs/2606.01065)；probe-followup E4；[DeepSeek 缓存语义](https://api-docs.deepseek.com/guides/kv_cache)）。
9. **不要把会话历史搬进 OMB**：DSH 已索引更全的 `tool/result`、带血缘与精确读取，OMB 再存一份必然不同步（既有 memory §4）。
10. **不要把"工具多/检索多"当解法**：工具/检索只在认知必要处用（[position paper](https://arxiv.org/abs/2506.00886)）；工具返回值本身就该精简（[writing-tools](https://www.anthropic.com/engineering/writing-tools-for-agents)）。
11. **不要相信厂商榜单数字**：SWE-bench Pro 已被审计判 Flawed（[epoch](https://epoch.ai/benchmarks/swe-bench-pro/review)）；所有记忆榜为作者自报且无独立复现。
12. **不要为了"未来可能有用"保留无消费者的机制**：`admission.ts` 零生产消费者（既有 context 报告）就是先例。

---

## 9. 未核实 / 不确定 + 可判死探针（给 Lead 的执行清单）

| # | 探针 | 判死条件 | 成本 |
| --- | --- | --- | --- |
| P1 | effort 降档 A/B：同任务 `high` vs `max`，看 `tokenUsage.outputTokens`、工具调用数、人工判读质量 | outputTokens 降幅 <20% 或质量明显下降 ⇒ 不做自动降档 | 20 回合 |
| P2 | 跨会话前缀缓存：同项目连续两次新会话，第一次后第二次看 `prompt_cache_hit_tokens` 比例；再对照"把时间戳/会话 id 去掉"的版本 | 提升 <10pp ⇒ 放弃 L1 的缓存论证（只留项目理解价值） | 2 会话 |
| P3 | 技能库 20 回合 A/B：有/无技能目录，指标=工具调用数、重复动作率、人工判读 | 读取率 <20% 或无差异 ⇒ 砍 L2 | 20 回合 |
| P4 | 快照累积：读 `contextBreakdown.messageTokens`，对比"注入开关"两状态的长会话；或数 surface 中 runtime-context 条数 | 若累积 >5k token/会话 ⇒ 必须让快照"替换"而非"追加"（宿主能力或 OMB 侧抑制） | 只读 |
| P5 | 中文检索回归：53 条真实查询，top-1 切题率、零命中率 | 修不到 60% ⇒ 保留但不再投入 | 离线 |
| P6 | 外部核验器价值：对有测试的项目，记录"运行 tsc/vitest 并读结果"的回合 vs 不运行 | 不改变后续动作 ⇒ 核验器只是装饰 | 10 任务 |

**未核实项（明说）**：Sonata 类自适应预算、ACE/RB 在中文项目上的迁移、repo map 对 OMB 仓库（~3 万行 TS）的实际定位收益、DeepSeek 缓存对 tools 字段的命中细节（未见文档明说 tools 是否计入前缀单元）——这些都**没有**在本机验证，报告中按 [推测] 处理。

---

## 10. 附录：复跑与引用

### 10.1 本机实测复跑（只读）

```js
// 会话日志是多帧 zstd；Node 24 的 zstdDecompressSync 只解第一帧，必须按 magic 切帧
const fs=require('node:fs'), z=require('node:zlib')
const MAGIC=Buffer.from([0x28,0xb5,0x2f,0xfd])
function readAll(p){const b=fs.readFileSync(p);const o=[];let i=0
  while((i=b.indexOf(MAGIC,i))!==-1){o.push(i);i+=4}
  if(o.length<=1){try{return z.zstdDecompressSync(b)}catch{return Buffer.alloc(0)}}
  const out=[];for(let k=0;k<o.length;k++){const s=o[k],e=k+1<o.length?o[k+1]:b.length
    try{out.push(z.zstdDecompressSync(b.subarray(s,e)))}catch{}}
  return Buffer.concat(out)}
// 对每个 <sessions>/<workspace>/<session>/session.v4.jsonl.zstd 解压后逐行 JSON.parse：
//   step/start 计数 = step 数
//   user/message 且 data.source.kind==='runtime-context' = OMB 运行时上下文快照
//   字数 = data.content 中 type==='text' 的 text.length 之和
```

- 统计口径：`data.source.kind === 'runtime-context'` 的 `user/message`；字符数取 text block 长度；step 数取 `step/start` 事件。
- 读数：394 会话 / 39,710 step / 1,716 条 / 1,395,193 字符 / 中位 51.7 字符每 step / 单会话最大 122 条 83,545 字符。
- 注意：本口径数的是**事件日志里的原始提交**；模型可见 surface 是否只保留最新快照，需探针 P4 判定（宿主 `RuntimeContextProjection` 语义为"新快照取代旧快照"，但提交 intent 是 `append`，两者需实测对齐）。

### 10.2 引用（按主题）

**测试时算力/过度思考**：[s1 2501.19393](https://arxiv.org/abs/2501.19393)｜[overthinking 2412.21187](https://arxiv.org/abs/2412.21187)｜[underthinking 2501.18585](https://arxiv.org/abs/2501.18585)｜[Danger of Overthinking 2502.08235](https://arxiv.org/abs/2502.08235)｜[Snell 2408.03314](https://arxiv.org/abs/2408.03314)
**自验证/过程奖励**：[self-correct 2310.01798](https://arxiv.org/abs/2310.01798)｜[Self-Verification Cliff](https://icml.cc/virtual/2026/82529)｜[PRM 2305.20050](https://arxiv.org/abs/2305.20050)｜[Self-Consistency 2203.11171](https://arxiv.org/abs/2203.11171)｜[think tool](https://www.anthropic.com/engineering/claude-think-tool)｜[Agent-as-a-Judge 2410.10934](https://arxiv.org/abs/2410.10934)
**技能/经验**：[Voyager 2305.16291](https://arxiv.org/abs/2305.16291)｜[Reflexion 2303.11366](https://arxiv.org/abs/2303.11366)｜[ExpeL 2308.10144](https://arxiv.org/abs/2308.10144)｜[AWM 2409.07429](https://arxiv.org/abs/2409.07429)｜[ACE 2510.04618](https://arxiv.org/abs/2510.04618)｜[ReasoningBank 2509.25140](https://arxiv.org/abs/2509.25140)｜[Dynamic Cheatsheet 2504.07952](https://arxiv.org/abs/2504.07952)｜[sleep-time 2504.13171](https://arxiv.org/abs/2504.13171)
**上下文工程**：[context rot](https://www.trychroma.com/research/context-rot)｜[lost-in-the-middle 2307.03172](https://arxiv.org/abs/2307.03172)｜[RULER 2404.06654](https://arxiv.org/abs/2404.06654)｜[IFScale 2507.11538](https://arxiv.org/abs/2507.11538)｜[Anthropic context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)｜[Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)｜[tool search](https://code.claude.com/docs/en/agent-sdk/tool-search)｜[writing tools](https://www.anthropic.com/engineering/writing-tools-for-agents)｜[multi-agent research](https://www.anthropic.com/engineering/multi-agent-research-system)｜[ACON 2510.00615](https://arxiv.org/abs/2510.00615)｜[Leyline 2606.01065](https://arxiv.org/abs/2606.01065)
**记忆**：[MemGPT 2310.08560](https://arxiv.org/abs/2310.08560)｜[Mem0 2504.19413](https://arxiv.org/abs/2504.19413)｜[A-MEM 2502.12110](https://arxiv.org/abs/2502.12110)｜[Zep 2501.13956](https://arxiv.org/abs/2501.13956)｜[HippoRAG2 2502.14802](https://arxiv.org/abs/2502.14802)｜[MemoryOS 2506.06326](https://arxiv.org/abs/2506.06326)｜[MIRIX 2507.07957](https://arxiv.org/abs/2507.07957)｜[MemoryBank 2305.10250](https://arxiv.org/abs/2305.10250)｜[LongMemEval 2410.10813](https://arxiv.org/abs/2410.10813)｜[MemoryAgentBench 2507.05257](https://arxiv.org/abs/2507.05257)｜[MemoryBench 2510.17281](https://arxiv.org/abs/2510.17281)
**优化/评测/工程**：[DSPy 2310.03714](https://arxiv.org/abs/2310.03714)｜[TextGrad 2406.07496](https://arxiv.org/abs/2406.07496)｜[GEPA 2507.19457](https://arxiv.org/abs/2507.19457)｜[mini-swe-agent](https://pypi.org/project/mini-swe-agent/)｜[Aider repo map](https://aider.chat/2023/10/22/repomap.html)｜[SWE-bench 2310.06770](https://arxiv.org/abs/2310.06770)｜[SWE-bench Pro 审计](https://epoch.ai/benchmarks/swe-bench-pro/review)｜[GAIA 2311.12983](https://arxiv.org/abs/2311.12983)｜[AgentBench 2308.03688](https://arxiv.org/abs/2308.03688)｜[τ-bench 2406.12045](https://arxiv.org/abs/2406.12045)｜[epistemic necessity 2506.00886](https://arxiv.org/abs/2506.00886)｜[DeepSeek 缓存](https://api-docs.deepseek.com/guides/kv_cache)｜[DeepSeek 价格](https://api-docs.deepseek.com/quick_start/pricing)｜[DeepSeek thinking](https://api-docs.deepseek.com/guides/thinking_mode)

### 10.3 交付回报口径

- 唯一写盘：本文件。
- 未做：改代码、跑 git、装包、改 profile。
- 与其它线程的边界：不重复审计（memory/reasoning/context/dsh-capabilities 已做）；本报告只做"机制裁决 + 激进选项 + 删留 + 探针"。
