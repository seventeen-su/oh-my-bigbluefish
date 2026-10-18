# R9 —— 记忆反馈与生命周期：隐式效用、薄显式反馈、自适应阈值

- 研究线程：R9（记忆效用/反馈/生命周期），输入：R1 记忆报告、产品审计、结构审计、`docs/v4-decision.md`、OMB 记忆模块源码 + 本机真实库（只读）
- 本文件只写**研究与设计**，不含实现、不改代码、不跑 git。
- 证据分级：**[实测]** = 本次跑命令/读真实库/读源码行；**[报告]** = 论文、官方文档、产品文档原话（未独立复现）；**[推测]** = 由前两者推导、未端到端验证。
- 与既有线程的分工：R1 管"写什么、怎么检索"；R6 管"生态机制"；本文只管**效用评价与生命周期**（优先级、回收、归档），不重复前两者的结论。
- 全文术语：**真值（truth）** = 这条结论现在是否成立（`valid_to`/`superseded_by`）；**效用（utility）** = 需要时它是否帮上忙；**注意力（attention）** = 它被注入/被看到的次数。**本文的核心判断是：当前 OMB 把注意力当成了效用。**

---

## §0 结论速览（12 条）

1. **用户的原话需要拆成两半**：如果"让 AI 主动评价记忆"指**模型给自己的记忆打分**，证据明确反对（§3.3：自偏好、自验证悬崖、不能自我纠错）；如果指**系统主动维护评价**，可行路径是"隐式信号 + 用户薄反馈 + 自适应阈值"，本文给这三个候选。**[报告]**
2. **固定分数下限不是"错在 0.5"，而是错在"用相关性阈值解决效用问题"**。0.5 是用 52 条真实查询 / 539 条命中标定的（p25=0.72、p50=1.39；保留 77.7% 命中、98% 查询保住 top-1），在**那个库、那个分词、那个长度分布**下是合理的；库从 16 条涨到 160 条后 bm25 分布会漂移，任何绝对值都会过期。**[实测源码]**
3. **OMB 目前唯一"效用信号"是 `use_count`，而它是曝光计数**：本机用户库 16 条记忆、`use_count` 合计 34；历史 43 次有效召回注入 156 条 → 覆盖率 ~22%。更关键的是**首条命中 32/43 集中在 9 条记录**、单条最高被召回 7 次——**富者愈富的反馈环已经在发生，只是还没有名字**。**[实测 R1 + R9]**
4. **`use_count/(1+use_count)` 在数学上是"曝光后仍被再注入"的饱和函数**，不是效用；它奖励"被反复注入"的记忆，恰好放大第 3 条的偏差。`usage` 权重 0.12 虽小，但方向错了。**[实测源码 `retrieve.ts:570-581`]**
5. **正确的最小改造是给它一个分母**：`utility = P(被后续使用 | 被注入)`，用 Beta 后验 + 经验贝叶斯收缩估计；这是隐式反馈推荐系统的标准做法（置信度加权，Hu/Koren/Volinsky 2008），不是新发明。**[报告]**
6. **显式反馈在生态里是"管理"而不是"评分"**：ChatGPT/Claude/Letta/Codex 的记忆 UX 都是**查看/编辑/删除/开关**，没有 5 星评分。用户薄反馈应做成 `/omb-feedback` **命令**（零模型、零 schema），而不是新工具或常驻问卷。**[报告 + 推测]**
7. **"likes 提权、mixed 改进、dislikes 自动回收"三种偏好可以同时满足**，只要把动作分级：`useful` 只动**排序/优先级**；`wrong` 走**真值**轴（冲突边 + 二次确认才 supersede）；`stale/noise` 只把条目移入**可逆归档**（永不删除，除隐私擦除）；"mixed"由 Beta 后验自然表达（一次正一次负 ≈ 0.5，停在 watch，不归档）。**[推测，基于 §3 的机制]**
8. **可逆归档必须有迟滞**：≥2 次**独立**负事件（不同会话/不同来源）才降级；1 次差评不回收。反过来，1 次 `useful` 即可复活。这是控制误杀的唯一便宜手段。**[推测]**
9. **阈值应从"绝对值"改为"每查询分布内的相对分位"**：保留 `score ≥ max(top×ρ, Q_q(候选))`，q 用"目标精度"在线校准（EWMA，步长 ≤0.05，夹在 [0.3,0.8]）；再用绝对夹紧 [0.2,1.5] 兜住小库 bm25≈1e-6 的极端。这既保留现有小库保护，又不再依赖一次性标定。**[推测，基于检索阈值/选择性预测的常规做法]**
10. **bandit/Thompson 只适合做"平局裁决"，不适合做主排序**：奖励稀疏且延迟（记忆可能 3 个会话后才被用）、真值非平稳（会被更正）、样本量 19 条/34 次使用、探索会故意注入低效用记忆。这些都与 bandit 的 i.i.d. 奖励假设冲突。**[报告 + 推测]**
11. **遗忘曲线可用，但方向是"排序先验 + 分类半衰期"，不是删除计划**：MemoryBank 的艾宾浩斯式强化、Duolingo 的 half-life regression、FSRS 的 D/S/R 模型都说明"每条/每类自己的衰减参数"优于一个全局 30 天；但 OMB 已有"衰减排序、不衰减行"的正确骨架（`consolidate.ts:13`），只需按 kind 分档 + 设界。**[报告]**
12. **推荐：主机制 C1（隐式效用账本 + 曝光归一），后备 C3（自适应相对阈值 + 可逆生命周期）；C2（薄显式反馈）作为两者的高精度人工覆盖层随附，不单独承载系统。** C3 的相对下限可以先行落地（成本最低、不依赖新信号），但**没有 C1 就没有校准目标**。**[推测]**

---

## §1 现状：OMB 现在到底有哪些信号（[实测]）

### 1.1 真实库（本次只读打开，2026-10-18）

| 面 | 值 | 说明 |
|---|---|---|
| 用户库 `C:\Users\SuSeventeen\.dsh\.omb\memory\knowledge.db` | 270,336 B；`schema_version=2` | 跨项目 |
| 用户库 `memory` | **16 行**（semantic 13 / procedural 3）；`asserted_by` model 12 / user 4；平均 484 字符、最大 1,098 | 与 R1 §1.8 一致；v4 后未明显增长 |
| 用户库 `use_count` 直方图 | 0:3、1:4、2:3、3:3、4:1、5:1、6:1（合计 **34**） | 分布右偏；最高一条被用 6 次 |
| 用户库 `edge` | **1 条**（`supersedes`） | 网络仍不成立（审计 P2） |
| 用户库失效面 | `valid_to` 非空 1、`superseded_by` 非空 1 | 非破坏性 supersede 有效 |
| 项目库 `<repo>/.omb/memory/session.db` | 110,592 B；**3 行**，全 `procedural`/`model`，`use_count` 全 0，平均 706 字符，edge 0 | 项目级结论稀少 |
| 历史召回 | 43 次有命中、注入 **156 条**、3.6 条/次；首条集中 32/43 在 9 条 | R1 §1.8c/d |
| 历史写入 | 143 次 → 83 准入（58%）；47 次"没有准入依据" | R1 §1.8b |

**读法**：19 条记忆、1 条边、34 次"使用"、156 次"注入"。`use_count` 的覆盖率 ~22%，且集中度极高。**任何以 `use_count` 为输入的排序/晋升，在 19 条样本上都无法与"这几条恰好被问得多"区分开。**

### 1.2 代码里已有的信号与它们真正的语义

| 信号 | 位置 | 现在用在哪 | 真实语义 | 缺口 |
|---|---|---|---|---|
| `use_count` / `last_used_at` | `migrate.ts:222-223` | 重排 `usage`（权重 0.12） | **曝光计数**（`markUsed` 只在注入时调用：`recall.ts:375`、`store.ts:861-873`） | 没有分母、没有后续使用、饱和函数奖励高频 |
| `valid_to` / `superseded_by` | `migrate.ts:220-221` | 检索排除失效（`store.ts:1132-1133`）+ 旁路探测（`overturned.ts`） | **真值**（被推翻） | 与"没用/过时"混在一起；无独立归档轴 |
| `edge`（supersedes/conflicts_with/derived_from/related） | `migrate.ts:234-240,357-374` | 1-hop 弱通道、召回尾部提示 | **关系**（真值与派生） | 无 utility 类边；1 条边 |
| `asserted_by` | `migrate.ts:218` | 重排 `asserted`（0.08）；consolidate 判定 supersede 资格 | **来源等级**（user>execution>model，`consolidate.ts:41`） | 召回 header **不渲染** `assertedBy`（审计 S-04），用户/模型看不到证据等级 |
| `observed_at` | `migrate.ts:219` | 重排 `recency`（半衰期 30 天） | 写入时间 | 全局半衰期，未按 kind/稳定性分档 |
| 词法原始分 | `retrieve.ts:56-95` | 后置下限 `min(top×0.5, 0.5)`（`retrieve.ts:640-684`） | **相关性**（通道内） | 绝对值随库/长度/语言漂移；只滤候选，不改 top-1 |
| RRF 融合分 | `retrieve.ts:443-477` | 排序 | 仅排序（0.0164/0.0328 两档） | 不是相关度（代码注释已承认） |
| 召回 snippet 预算 | `recall.ts:48-57` | 输出 | 每条 240、单次 1500 字符 | 加反馈提示会挤占预算 |
| 捕获实体键 | `capture.ts`（`extractEntityKeys`，被 `link.ts:1-20` 复用） | 自动连边 | 路径/命令/包/项目名 | **可复用为"后续工具调用是否用到这条记忆"的匹配器** |

**结论**：OMB 已有"曝光、时间、来源、真值、关系"五类事实，**缺的是"效用"这一轴**。不是数据不够，是数据被用错了位置。

---

## §2 文献与生态：机制、证据质量、负结果

### 2.1 记忆系统怎么处理"重要性/效用"（**作者自报，未复现**）

| 系统 | 机制 | 是否用反馈 | 证据 | 对 OMB 的含义 |
|---|---|---|---|---|
| **MemoryBank**（[AAAI](https://ojs.aaai.org/index.php/AAAI/article/download/29946/31654)、[arXiv 2305.10250](https://arxiv.org/abs/2305.10250)） | 艾宾浩斯遗忘曲线 `R=e^(−t/S)`；**被召回会增强 S**；importance 由用户画像 + 事件重要性 | 召回=强化 | [报告] 定性 + 模拟对话，无统一榜单 | **"召回即强化"正是 OMB `use_count` 的同类错误**；可抄的是"按条强度"而非"按次数" |
| **MemoryOS**（[arXiv 2506.06326](https://arxiv.org/abs/2506.06326)） | 短/中/长期三级 + 热度（访问频率+时间）驱动的淘汰/晋升 | 访问=热度 | [报告] LoCoMo 自报 F1 +49% | 热度≠效用；三级层次 OMB 已明确不做 |
| **A-MEM**（[arXiv 2502.12110](https://arxiv.org/abs/2502.12110)） | Zettelkasten：写入时 LLM 生成关键词/标签/链接，并回溯更新旧笔记 | 无使用反馈 | [报告] 六基座自报优于 SOTA | 链接思想可零 LLM 化（OMB 已有 `related` 边），**"演化旧笔记"不做** |
| **Mem0**（[arXiv 2504.19413](https://arxiv.org/abs/2504.19413)） | 论文版 ADD/UPDATE/DELETE/NOOP；OSS v3 改为 **single-pass ADD-only**，无覆盖 | 无显式反馈 | [报告] 平台自报 LoCoMo 92.5，OSS 不同 | 连商业实现都不做"模型自评效用"，OMB 更无理由做 |
| **Zep/Graphiti**（[arXiv 2501.13956](https://arxiv.org/abs/2501.13956)） | 双时间轴（valid_at/invalid_at）+ 混合检索 | 无效用分 | [报告] 作者自报 | **"真值轴"与"效用轴"分离**是它做对的表示法；OMB 已有 `valid_to`，缺独立 utility 轴 |
| **Letta** | MemFS git 版本化 + memory blocks + `/sleeptime` dreaming 整理 | 后台模型整理 | [报告] 官方文档 | 整理要有预算闸门；OMB 不做后台 LLM |
| **ChatGPT Memory** | 模型决定保存；用户可查看/删除/关闭；"Memory updated"提示 | 用户删除=最强负反馈 | [报告] OpenAI Memory FAQ | 生态的显式反馈是**删除/编辑**，不是评分 |
| **Claude / Claude Code** | 项目记忆/自动记忆；`/memory` 浏览编辑、auto memory 开关、`/doctor` 审计 token | 用户删除/编辑 | [报告] code.claude.com/docs/en/memory | 同上；且**给用户看成本**（token 审计）值得抄 |
| **Codex memories** | 默认关；后台空闲生成；限流阈值跳过；`disable_on_external_context` | 会话级开关 | [报告] learn.chatgpt.com/docs/customization/memories.md | "生成/使用分离 + 可关"是自主捕获的正确形态（见 R6） |

### 2.2 隐式 vs 显式反馈（推荐系统 → 记忆检索的迁移）

| 机制 | 关键结论 | 证据 | 对 OMB 的直接含义 |
|---|---|---|---|
| **隐式反馈没有负样本** | 只有"被看到且被消费"的正信号；未注入≠不喜欢。Hu/Koren/Volinsky 用置信度 `c=1+α·r` 加权，而不是把 0 当负 | [报告] ICDM 2008 | `use_count` 必须配"曝光/未曝光"分母；未召回不是负反馈 |
| **点击/使用受位置与曝光偏置** | 只有排在前面的才可能被点；需要 IPS/倾向加权或随机化才能估真实效用 | [报告] Joachims et al., IJCAI 2018（[链接](https://www.ijcai.org/proceedings/2018/738)） | 只对"被注入的条目"观测使用 → 天然 MNAR；要么记曝光并按位置加权，要么接受"只能估相对提升" |
| **MNAR（数据缺失非随机）** | 评分/使用数据缺失与条目本身相关，直接训练会偏 | [报告] Steck, KDD 2010 | 不能用"被用过的记忆"当正样本全集 |
| **显式反馈稀疏且非代表** | 愿意评价的用户是少数，且倾向极端体验；评分量表语义不一致 | [报告] recsys 常识 + 生态 UX 证据 | 薄反馈只做"高精度先验"，不做主排序；不要做 5 星 |
| **算法混淆/反馈环** | 推荐系统会放大早期优势，同质化上升、效用下降 | [报告] Chaney et al., RecSys 2018（[链接](https://dl.acm.org/doi/10.1145/3240323.3240370)） | **OMB 的 32/43 集中度就是前兆**；提权必须做曝光归一 + 上限 |
| **RAG 侧** | 主流做法是 LLM-judge（RAGAS/MT-Bench 式）或需训练的 Self-RAG；**没有"用户反馈闭环"的标准基准** | [报告] | 不要引用"RAG 已证明反馈有效"；证据要从 recsys/bandit 借，且要打折 |

### 2.3 模型自评/自选：为什么会坏（这是对用户"让 AI 评价"最重要的一条）

| 结果 | 内容 | 证据 |
|---|---|---|
| **自偏好偏差** | LLM 评估器能识别自己的输出并偏好它；换作者名可缓解 | [报告] Panickssery et al. 2024（[arXiv 2404.13076](https://arxiv.org/abs/2404.13076)）；AAAI 2026 缓解论文（[链接](https://dl.acm.org/doi/10.1609/aaai.v40i44.41105)）；"Do LLM Evaluators Prefer Themselves for a Reason?"（[arXiv 2504.03846](https://arxiv.org/abs/2504.03846)） |
| **自验证悬崖** | 生成能力越强，自选/自验证能力越跟不上，且**差距随能力扩大** | [报告] ICML 2026《The Self-Verification Cliff》（[链接](https://icml.cc/virtual/2026/82529)） |
| **不能自我纠错** | 无外部反馈时，LLM 的自我纠错不能可靠提升推理，甚至会变差 | [报告] Huang et al. 2023（[arXiv 2310.01798](https://arxiv.org/abs/2310.01798)） |
| **LLM-as-judge 的位置/冗长偏差** | 评委偏好靠前答案与更长答案 | [报告] MT-Bench 论文（[arXiv 2306.05685](https://arxiv.org/abs/2306.05685)）、"not fair evaluators"（[arXiv 2305.17926](https://arxiv.org/abs/2305.17926)） |

**判决**：**"让模型评价自己的记忆"在任何规模上都不该做**——它既没有外部真值，又系统性偏好自己写的东西，而且随模型变强而更糟。模型可以做的是**引用/使用**（行为），不是**打分**（判断）。

### 2.4 bandit / Thompson：能借什么、不能借什么

- Thompson sampling 有严格 regret 保证，但依赖**奖励分布平稳、可观测、独立**（[Chapelle & Li 2011](https://papers.nips.cc/paper/4321-an-empirical-evaluation-of-thompson-sampling)；[Agrawal & Goyal 2012](https://arxiv.org/abs/1111.1797)）。OMB 的奖励：延迟（可能 3 会话后才用到）、非平稳（会被更正）、样本极少（19 条/34 次）。
- **可借的只有"后验 + 探索"的思想**：用 Beta 后验表达不确定性、对低曝光条目**收缩**（不主动注入）；**不可借的是"为学习而探索"**——在记忆场景里，注入一条已知低效用的记忆去"学"，成本由用户承担。**[推测]**
- 若未来要做 A/B：必须有**曝光日志 + 随机化**（例如 5% 查询强制注入一条候选），否则无法归因（Joachims 的 IPS 同理）。

### 2.5 遗忘曲线：可迁移的是"每类参数"，不是"删除"

| 来源 | 机制 | 证据 | 迁移 |
|---|---|---|---|
| MemoryBank | 艾宾浩斯 `R=e^(−t/S)`，召回增强 S | [报告] 定性 | 只借"强度随时间衰减、按条不同"，不借"召回=增强" |
| Duolingo HLR | 预测每个词/用户的**半衰期**（半衰期回归） | [报告] Settles & Meeder, ACL 2016（[链接](https://aclanthology.org/P16-1174/)） | 半衰期应按 kind/长度/来源分档并可估 |
| 自适应遗忘曲线 | 个体化遗忘参数优于全局曲线 | [报告] arXiv 2004.11327 | 支持"分类半衰期 + 界" |
| FSRS | D/S/R 三参数调度，逐条难度/稳定性 | [报告] 开源实现（[链接](https://github.com/open-spaced-repetition/free-spaced-repetition-scheduler)） | 过度工程；OMB 只借"每类参数 + 复习/使用事件更新" |
| OMB 现状 | 全局 30 天半衰期做排序先验，不删行（`retrieve.ts:49`、`consolidate.ts:13`） | [实测] | 方向正确，粒度太粗 |

### 2.6 主动学习/何时问人

- 不确定性采样（[Settles 2009 综述](https://burrsettles.com/pub/settles.activelearning.pdf)）适合"标注贵、样本少"；OMB 的"标注"是用户注意力，更贵。
- 可行判据：**只在"归档边缘 + 高不确定性 + 该条最近被召回"时问一次**（每题 ≤1 条、每会话 ≤1 次、不阻塞）；不要每次召回都问，也不要在低曝光条目上问（用户没见过它，无法评价）。**[推测]**
- "learning to defer"思想：系统应能判断"这个判断我不可靠，交给用户"；对应到 OMB 就是 `watch` 状态 + 可选确认，而不是自动决策。**[报告/推测]**

### 2.7 人在环记忆 UX（生态事实）

- **ChatGPT**：记忆可查看、删除、关闭；删除即时生效；有"临时聊天"；用户感知的核心是"它记错了什么"，不是"它给我打分"。[报告]
- **Claude / Claude Code**：`/memory` 打开记忆文件、auto memory 开关、`/doctor` 审计上下文成本；Claude Code 明确建议"要强制执行的规则用 hook，不要写进 CLAUDE.md"。[报告]
- **Letta**：`/palace` 查看记忆；**Codex**：`/memories` 控制读写；**均无评分 UI**。[报告]
- 结论：**"管理"比"评分"更符合用户心智**；OMB 的反馈面应该是 `/omb-memory`（list/show/archive/revive）+ 极简 `useful/wrong` 两三个动词，而不是 1–5 星。

### 2.8 负结果汇总（这一节决定哪些路不要走）

| # | 负结果 | 证据 | 后果 |
|---|---|---|---|
| N1 | 曝光→提权→更多曝光（富者愈富） | Chaney 2018；OMB 实测 32/43 集中 9 条、单条 7 次 | 不做曝光归一就做"likes 提权"= 加速同质化 |
| N2 | 隐式反馈无负样本、MNAR | Hu 2008；Steck 2010 | 未召回不能当负反馈；只用"被注入"样本会高估 |
| N3 | 位置偏差使"使用"不可比 | Joachims 2018 | 第 1 位被用≠比第 5 位更有用 |
| N4 | 显式反馈稀疏且偏 | recsys 常识 | 薄反馈只能是先验，不能是主信号 |
| N5 | 模型自评有自偏好且随能力恶化 | §2.3 | **禁止模型给记忆打分** |
| N6 | 无外部反馈的自我纠错不可靠 | Huang 2023 | 不做"模型复审记忆" |
| N7 | 全局固定阈值随分布漂移 | 本地 52 查询标定 + 库增长外推 [推测] | 阈值必须相对化/在线化 |
| N8 | 召回次数被当效用 | MemoryBank/MemoryOS 的同类设计 + OMB 现状 | 循环论证 |
| N9 | bandit 探索有用户成本、样本不足 | §2.4 | 只做后验收缩，不做主动探索 |
| N10 | 首次差评即删=不可逆误杀 | 用户明确"dislikes auto-recycle"但要求研究 | 必须迟滞 + 可逆 |

---

## §3 三个候选机制（精确设计）

> 三个机制都只用**本机已有信号**，热路径零 LLM，新增常驻 token 为 0（反馈走命令，不走 schema）。公式与阈值为设计值，落地前用真实回归集校准。

### C1（主推）：**隐式效用账本（Utility Ledger）——给"使用"一个分母**

**问题**：`use_count` 是曝光计数，`usage=useCount/(1+useCount)` 单调奖励高频；没有"用没用上"的观测。

**精确机制**

1. **信号表**（迁移 v4，新表，不删旧列）：
   `memory_signal(memory_id, session_id, kind, signal, at, weight)`，`kind ∈ {exposed, used_tool, used_cite, survived, corrected, explicit_useful, explicit_wrong, explicit_stale}`。
2. **信号定义（全部确定性、零 LLM）**：
   - `exposed`：召回注入时写（复用 `recall.ts:375` 的 `markUsed` 路径，**拆成 exposed + used 两步**）。
   - `used_tool`：注入后**同会话 20 步内**，任一 `tool/call` 的参数串命中该条记忆的实体键（复用 `capture.ts` 的 `extractEntityKeys`：路径/命令/包/项目名；要求 ≥2 键或 ≥1 长路径），且不是 OMB 自己的工具。**这是"引用了结论"的最强廉价近似。**
   - `used_cite`：后续 `omb_remember` 的 `sourceRef` 显式指向该 id（模型主动引用，权重低于 `used_tool`）。
   - `survived`：写入后 30 天内未被 `supersedes`/`conflicts_with` 指向（生存信号，用于降权"刚写就过时"的条目）。
   - `corrected`：用户纠正类消息（`capture.ts` 已有 correction 分类器）命中同一实体键 → **只进真值轴，不进效用轴**。
3. **效用估计**：
   `utility = λ·BetaPosterior + (1−λ)·base_rate(kind)`，
   `BetaPosterior = (α0 + used) / (α0 + used + β0 + (exposed − used))`，`α0=1`、`β0=4`（先验均值 0.2，接近本地"34 使用/156 暴露≈0.22"的基率）；
   `λ = exposed/(exposed+10)`（经验贝叶斯收缩：曝光 0 条时完全用基率，曝光 ≥30 条才基本信自己）；`exposed` 超过 20 按 20 计（防单条刷分）。
4. **接入排序**：`retrieve.ts:570-581` 的 `usage` 项由 `useCount/(1+useCount)` 换成 `utility`；**权重先保持 0.12 不变**（不做第二处改动），20 会话 A/B 有正向收益再谈 0.15–0.18。
5. **优先级/生命周期读法**：`utility` 只影响**排序**与 `watch` 标记；**绝不影响 `valid_to`**。
6. **可观测**：`omb_status` 记忆段显示 `暴露/使用/utility 中位/最高` 与 `信号覆盖率`（已接线才显示，否则写"未测量"）。

**预期效果**：打断"曝光→提权"环；首条集中度下降；"注入了但没用"的比例可测并下降。**[推测]**

**证据质量**：隐式反馈加权有强文献（[报告] Hu 2008）；"实体键命中=被引用"的效度是 **[推测]**，必须先用 20 条人工判读验证。

**成本**：`~450 行`（迁移 + 信号写入 + 窗口匹配 + 估计器 + 状态 + 测试），1.5–2 人日；无模型、无常驻 token。

**风险**：`used_tool` 误报（`README.md`、`package.json` 这类通用路径 → 要求 ≥2 键或长路径）；循环论证（用了是因为被注入 → 用位置/曝光加权缓解，但无法完全消除）；19 条样本上后验很宽（收缩项兜住）；旧数据无曝光日志 → 冷启动（明确写"历史不可回填"）。

**验收**：20 会话 / ≥50 次召回：`utility` 与人工"是否帮上忙"判读的 Spearman ≥0.4；注入后未被使用的比例 −20%；首条集中度（top-3 记录占首条命中）≤30%；召回 p95 不升 >10ms。
**Kill**：相关性 <0.1；或 `used_tool` 人工抽检误报 >30%；或 20 会话信号覆盖率（有至少一次 `used_*` 的召回占比）<30%。命中任一 → 只保留曝光计数，排序退回 `use_count`（保留回滚开关）。

### C2（随附，薄）：**显式用户反馈——命令而非工具，管理而非评分**

**问题**：用户说"likes 提权 / dislikes 回收"，但生态证明显式反馈稀疏；模型自评又被禁止。所以只做**用户发起**的最小通道。

**精确机制**

1. **`/omb-feedback` 命令**（DSH `commands` 注册路径见 `dsh/plugin.ts:69,324`：`inject:['commands']` + `registerDepthCommand`；`/omb-privacy` 的解析器已存在，见 `modules/memory/privacy/command.ts:57-58`）：`/omb-feedback <id|#rank> useful|wrong|stale|noise`。零模型调用、零工具 schema、任意会话可用。
2. **配套 `/omb-memory` 命令**：`list [--archived]`、`show <id>`、`archive <id>`、`revive <id>`。这是"管理"面，覆盖"我想自己看一眼"的需求。
3. **发现性**：只在 `omb_recall` 的 `detail:"full"` 尾部加一句 ≤55 字符的提示（默认 `snippet` 路径**零成本**；snippet 单次预算 1,500 字符，不加提示）。**不做常驻提示**。
4. **语义映射**（关键：三轴分离）：
   | 动作 | 轴 | 效果 |
   |---|---|---|
   | `useful` | 效用 | `α += 2`；1 次即可把 `archived` 复活为 `active` |
   | `wrong` | **真值** | 写 `conflicts_with`；**第二次**独立确认（不同会话）才 supersede；不删除 |
   | `stale` | 效用 | `β += 1.5` + 归档候选；不删 |
   | `noise` | 效用 | `β += 1`（弱负） |
5. **迟滞**：降级需要 ≥2 次**独立**负事件（会话不同；同一会话连点算 1 次）；1 次差评永不回收。复活只需 1 次正事件。
6. **不做的**：不做 5 星量表、不做每次召回问卷、不做"模型代填"、不为它新增第 10 个工具（v4 工具面目标 6–7）。

**预期效果**：给用户一个"这不对"的出口（当前只能靠 `omb_remember` 纠正或 `omb_forget` 删除）；为 C1/C3 提供高精度先验与校准标签。**[推测]**

**证据质量**：UX 形态有生态事实（§2.7，[报告]）；"薄反馈能改善排序"在 OMB 规模上无证据（[推测]），只能当先验。

**成本**：命令 + 存储 + 状态 `~150 行`，0.5 人日；无模型、无常驻成本（full 模式 +55 字符）。

**风险**：无人用（大概率）；误操作（`wrong` 需二次确认兜住）；id 泄漏（id 本身不是秘密，但 `show` 会输出正文 → 走隐私门禁）；与 `omb_forget` 语义混淆（文档要写清"归档≠删除"）。

**验收**：2 周内 ≥5 次显式反馈、来自 ≥2 个会话；显式与 C1 隐式信号一致率 ≥70%（一致才算有效标注）；默认 `snippet` 路径输出字符不增。
**Kill**：2 周 <5 次 → 删提示、只留命令；`wrong→supersede` 人工抽检误判 >10% → 退回"只记冲突、不 supersede"。

### C3（后备/可先行）：**自适应相对阈值 + 可逆生命周期**

**问题**：固定 `0.5` 绝对值会随库/长度/语言漂移；且"没命中/低分"与"过时/低效用"没有区分。

**精确机制**

1. **相对下限**：保留 `score ≥ max(top×ρ, Q_q(本次查询候选分))`，`ρ=0.35`（比现 0.5 松，让 Q_q 主导），`Q_q` 取本次 top-10 候选分的 q 分位；**绝对夹紧** `[0.2, 1.5]` 只用于小库（bm25≈1e-6）保护，形态与现 `min(相对, 绝对)` 兼容（`retrieve.ts:82-89`）。
2. **在线校准 q（目标精度，而非固定分位）**：目标"注入条目中后续被使用/未被纠正"的比例 `target=0.6`。每 20 次召回更新一次 EWMA：`q ← clamp(q + 0.05·sign(precision−target), 0.3, 0.8)`，初始 `q=0.5`。只用 C1 的 `used_*`/`corrected` 作标签；C1 未上线时**不启动自适应**（避免拿召回次数当标签）。
3. **分类半衰期**（替换全局 30 天）：`procedural 90d / semantic 60d / episodic 21d`，夹在 `[7d, 180d]`；依据 HLR/自适应遗忘曲线的"每类参数"证据（§2.5）。
4. **生命周期（独立于真值）**：新增 `status ∈ {active, watch, archived}`、`status_since`、`status_reason`。
   - `active → watch`：≥2 次独立负事件，或（180 天无曝光且无边）。
   - `watch → archived`：再 ≥2 次独立负事件，或 90 天无使用。
   - `archived`：**不参与注入**，但 `omb_status` 计数、`/omb-memory list --archived` 可见；`useful`/新记忆共享 ≥2 实体键 → 复活。
   - **禁止**用 `valid_to` 表达"低效用"；`archived` 与 `superseded` 是两个轴，`omb_relate` 分别标注。
5. **排序权重不动**：只把 `usage` 换成 C1 的 `utility`（若 C1 未上线则保持现状），其余 0.55/0.25/0.08 不变，避免一次改两处无法归因。

**预期效果**：阈值不再依赖一次性标定；低效用条目自然退出注入面但可召回可复活；"过时"与"不成立"分开。**[推测]**

**证据质量**：阈值相对化/选择性预测的常规做法（[报告] 选择性分类 Geifman & El-Yaniv 2017 等）；"目标精度 EWMA"是 [推测]，需 A/B。

**成本**：`~350 行`（阈值函数 + 校准器 + 状态列/迁移 + 命令/状态 + 测试），1–1.5 人日；无常驻 token、无模型。

**风险**：自适应 q 震荡（步长上限 + 夹紧 + 每 20 次才动）；归档误杀（迟滞 + 可逆 + 人工判读抽检）；`archived` 被误读为删除（文案与状态计数必须写清）；`watch` 状态膨胀（上限：watch ≤20% 库）。

**验收**：20 会话：top-1 切题率 ≥60%（v4 目标）；零命中率 ≤基线+2pp；归档率 ≤20%，误归档 ≤5%（20 条人工判读）；召回 p95 ≤250ms。
**Kill**：q 收敛后 top-1 提升 <5pp，或零命中率升 >5pp，或误归档 >5% → 退回固定 `0.5` + 关闭 `archived`（保留 `watch` 只读）。

---

## §4 推荐：主线 + 后备 + 关系

| 位置 | 机制 | 理由 | 依赖 |
|---|---|---|---|
| **主推** | **C1 隐式效用账本** | 唯一直接修复"把曝光当效用"的机制；给 C3 提供校准标签、给 C2 提供一致性检验；零 LLM、无常驻 token | 无（实体键复用 capture.ts） |
| **后备** | **C3 自适应阈值 + 可逆生命周期** | 不依赖新信号也能修掉"固定阈值"；即使 C1 信号太噪也可独立成立 | C1 仅用于"启动自适应"；可先只做相对下限 |
| **随附** | **C2 薄显式反馈** | 成本最低、给用户出口、给系统高精度先验；但不能承载系统 | `/omb-feedback` 命令 |

**施工顺序（建议）**：① C3 的"相对下限 + 分类半衰期"（1 天，风险最低，直接回应"固定阈值不稳定"）；② C1 信号表 + 估计器 + 排序替换（1.5–2 天，主收益）；③ C2 命令 + full 提示（0.5 天）；④ C3 的在线校准 + 生命周期（在 C1 有 ≥20 会话数据后）。**不允许**在没有 C1 标签的情况下启动第 ④ 步的自适应。

**与五条抱怨/用户偏好的映射**

| 用户诉求 | 落点 | 说明 |
|---|---|---|
| likes 提权 | C1 `utility` 进排序 + `useful` → `active` | 提权幅度受 0.12 权重与曝光上限约束，不会一条好评通吃 |
| mixed 可改进 | Beta 后验 | 1 正 1 负 ≈ 0.5 → `watch`，不归档、不删除 |
| dislikes 自动回收 | C3 `archived`（可逆） | 需 ≥2 次独立负事件；`/omb-memory revive` 可复活 |
| 不要不稳定固定阈值 | C3 相对分位 + 目标精度校准 | 绝对值只作小库夹紧 |
| "AI 主动评价" | C1（系统主动维护）+ C2（用户薄反馈） | **不做模型自评**（§2.3） |
| 研究而非实现 | 本文 | 所有设计附 kill 判据，无代码改动 |

---

## §5 明确不做（每条有证据）

1. **不让模型给记忆打分/自评/自选**：自偏好（2404.13076）、自验证悬崖（ICML 2026）、无外部反馈不能自我纠错（2310.01798）。**[报告]**
2. **不把 `use_count`/召回次数当效用**：曝光≠效用；本地已 32/43 集中 9 条；Hu 2008 要求置信度/分母。**[实测/报告]**
3. **不在第一次差评时删除或永久回收**：不可逆误杀；用户要的是"回收"不是"销毁"。**[推测 + 用户原话]**
4. **不使用单一全局绝对分数下限**：52 查询标定只对当时分布成立；库增长后必然漂移。**[实测 + 推测]**
5. **不把 supersede 当"差记忆"**：它是真值更新（`valid_to`），与效用正交；混用会把"曾经正确"错杀。**[实测源码 `overturned.ts`]**
6. **不在热路径调 LLM 做效用判断/查询改写/答案复审**：成本 + 延迟 + 偏置；v4 §8 已列。**[报告]**
7. **不用 bandit 主动探索注入低效用记忆**：样本 19 条、奖励延迟非平稳、探索成本由用户承担。**[报告/推测]**
8. **不在无曝光日志/随机化的情况下做 A/B**：无法归因（Joachims IPS）。**[报告]**
9. **不做 5 星量表或每次召回问卷**：显式反馈稀疏；生态 UX 都是"管理"不是"评分"。**[报告]**
10. **不为反馈新增第 10 个工具**：v4 目标 6–7 个工具；反馈走命令；`full` 模式提示 ≤55 字符。**[报告 v4-decision]**
11. **不按用户单次情绪改真值**：`wrong` 需二次独立确认才 supersede；情绪化"这条没用"只进效用轴。**[推测]**
12. **不把 archived 当删除**：必须可 list/revive；删除只有隐私擦除一种入口。**[报告 v4 §L2]**

---

## §6 未核实 / 开放问题 / 探针

**未核实**

- Hu/Koren/Volinsky 2008、Joachims 2018、Steck 2010、Thompson/Agrawal、Duolingo HLR、FSRS、Settles 综述：均为标准文献，未逐字抓取页面（URL 见 §7）；引用时按 [报告]。
- MemoryOS 的"热度"公式与 MemoryBank 的强化细节：只核到论文摘要/二手综述，未逐行读实现。
- ChatGPT/Claude 记忆 UX 的当前按钮文案：以官方帮助中心/文档为准，未逐版本核对。
- 所有候选机制的预期效果均为 [推测]，必须 A/B。

**开放问题（需用户拍板）**

1. 别名/归档是否允许模型触发（例如 `omb_remember` 带 `supersede`）？本文默认**只有用户命令与 consolidate 能降级**，模型只能写冲突。
2. `archived` 是否计入召回输出（作为"弱提示"）？本文默认**不计入**（避免常驻噪声）。
3. 是否接受"20 会话后才自适应"的等待期？若要求立即，只能先上相对下限，不做在线校准。
4. 显式反馈是否要进用户库（跨项目）？本文默认**进用户库**（偏好类），但 `wrong` 只作用于项目库同名条目。

**给 Lead 的最小探针（只读/一次性）**

- P1：对现有 19 条记忆，人工标注"是否曾帮上忙"（0/1），与当前 `use_count`、C1 的 `used_tool` 代理做 Spearman；**决定 C1 是否值得做**。
- P2：重放 52 条历史查询，记录每次 top-10 候选分，算 `Q_q` 分布与现 0.5 的差异；**决定 C3 的下限形态**。
- P3：统计 43 次召回中后续工具调用命中实体键的比例（用 `extractEntityKeys` 离线跑日志）；**决定 `used_tool` 误报率**。
- P4：检查 `omb_recall` 的 `full` 输出尾部加 55 字符后是否超 1,500 预算（snippet 默认不受影响）。
- P5：查 2 周内是否有用户主动表达"这条不对/没用"的消息（`capture.ts` 的纠正分类器可离线跑），**决定 C2 的自然需求**。

---

## §7 证据索引

**本机/本仓 [实测]**

- `modules/memory/migrate.ts:211-240`（memory 表、`use_count`/`last_used_at`/`valid_to`/`superseded_by`、edge 三型）、`:357-374`（edge v3 加 `related`）
- `modules/memory/retrieve.ts:47-49`（权重 0.55/0.25/0.12/0.08、半衰期 30d）、`:58-89`（0.5 的 52 查询标定过程、相对系数）、`:640-684`（下限应用与 dropped 计数）、`:570-581`（`usage=useCount/(1+useCount)`）
- `modules/memory/recall.ts:48-57`（snippet 240/1,500/60）、`:329-375`（`markInjectedAsUsed`→`markUsed`）、`:492-568`（header 渲染含 id/signals/validity）
- `modules/memory/store.ts:843-873`（`markUsed` 语义）、`:1094,1132-1133`（失效排除）、`:1177-1192`（被取代旁路探测）
- `modules/memory/consolidate.ts:1-19`（四级整合 + 回响检测）、`:33-38`（近重复/矛盾阈值、半衰期）、`:41`（ASSERTED_RANK 3/2/1）、`:88,121,260-270`（独立来源 ≥2 才够格晋升）
- `modules/memory/capture.ts:11-20`（三个事件 + 零 LLM 规则）、`:59-60`（每会话上限 5/10）、`:108-159`（偏好/活动分类器）
- `modules/memory/overturned.ts:1-16`（"没有结论"与"有过结论、已被推翻"必须分开）
- `dsh/plugin.ts:69,324`（`inject:['commands']`、`registerDepthCommand`——反馈命令的注册路径）、`modules/memory/privacy/command.ts:57-58`（既有 `/omb-privacy` 命令名与解析器）
- 本次只读库：用户库 16 行/34 次使用/1 边；项目库 3 行/0 使用/0 边；`use_count` 直方图 0:3,1:4,2:3,3:3,4:1,5:1,6:1
- `docs/research/2026-10-18-memory.md:131-172`（存量/漏斗/召回质量/32-of-43 集中）、`:180-193`（M1–M14 缺陷）
- `docs/research/2026-10-18-audit-product.md:93-121`（P1 自主写入、P2 1 条边、P3 错配）、`:225`（`use_count` 34/13-of-16）
- `docs/research/2026-10-18-audit-architecture.md:57-62`（S-04 召回丢 assertedBy）、`:111-116`（S-10 检索扩展性）、`:179`（<2,000 条且使用率 <10% 则"库上限 + 冷归档"）
- `docs/v4-decision.md:41-45`（L2 生命周期：可逆归档/冲突呈现/非破坏 supersede）、`:69-83`（验收：top-1 60%、零命中不升、p95 250ms）

**外部 [报告]**

- Hu, Koren, Volinsky. Collaborative Filtering for Implicit Feedback Datasets. ICDM 2008. <https://ieeexplore.ieee.org/document/4781121>
- Joachims et al. Unbiased Learning-to-Rank with Biased Feedback. IJCAI 2018. <https://www.ijcai.org/proceedings/2018/738>
- Steck. Training and Testing of Recommender Systems on Data Missing Not at Random. KDD 2010. <https://dl.acm.org/doi/10.1145/1835804.1835895>
- Chaney et al. How Algorithmic Confounding in Recommendation Systems Increases Homogeneity and Decreases Utility. RecSys 2018. <https://dl.acm.org/doi/10.1145/3240323.3240370>
- Panickssery et al. LLM Evaluators Recognize and Favor Their Own Generations. 2024. <https://arxiv.org/abs/2404.13076>
- "Do LLM Evaluators Prefer Themselves for a Reason?" 2025. <https://arxiv.org/abs/2504.03846>
- The Self-Verification Cliff: Generation Outpaces Self-Selection in Frontier LLMs. ICML 2026. <https://icml.cc/virtual/2026/82529>
- Huang et al. Large Language Models Cannot Self-Correct Reasoning Yet. 2023. <https://arxiv.org/abs/2310.01798>
- Zheng et al. Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena. 2023. <https://arxiv.org/abs/2306.05685>
- Wang et al. Large Language Models are not Fair Evaluators. 2023. <https://arxiv.org/abs/2305.17926>
- Chapelle & Li. An Empirical Evaluation of Thompson Sampling. NeurIPS 2011. <https://papers.nips.cc/paper/4321-an-empirical-evaluation-of-thompson-sampling>
- Agrawal & Goyal. Analysis of Thompson Sampling for the Multi-armed Bandit Problem. 2012. <https://arxiv.org/abs/1111.1797>
- Settles. Active Learning Literature Survey. 2009. <https://burrsettles.com/pub/settles.activelearning.pdf>
- Settles & Meeder. A Trainable Spaced Repetition Model for Language Learning. ACL 2016. <https://aclanthology.org/P16-1174/>
- Adaptive Forgetting Curves for Spaced Repetition Language Learning. 2020. <https://arxiv.org/abs/2004.11327>
- FSRS（Free Spaced Repetition Scheduler）. <https://github.com/open-spaced-repetition/free-spaced-repetition-scheduler>
- MemoryBank. AAAI 2024. <https://ojs.aaai.org/index.php/AAAI/article/download/29946/31654>；<https://arxiv.org/abs/2305.10250>
- MemoryOS. <https://arxiv.org/abs/2506.06326>
- A-MEM. <https://arxiv.org/abs/2502.12110>
- Mem0. <https://arxiv.org/abs/2504.19413>
- Zep/Graphiti. <https://arxiv.org/abs/2501.13956>
- Letta memory. <https://docs.letta.com/configuration/memory>
- Codex memories. <https://learn.chatgpt.com/docs/customization/memories.md>
- Claude Code memory. <https://code.claude.com/docs/en/memory>
- OpenAI Memory FAQ. <https://help.openai.com/en/articles/8590148-memory-faq>
- Claude memory（产品公告）. <https://www.anthropic.com/news/memory>
