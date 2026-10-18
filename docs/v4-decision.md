# OMB v4 裁决：从「三个提示组件」到「一个会记事的工作区大脑」

> 证据：`docs/research/2026-10-18-*.md` 共 10 份（记忆/推理/上下文/DSH 能力 + 学术前沿 + 生态 + DSH 组合 + 上下文重构 + 结构审计 + 产品审计），
> 数据来自本机 394 个真实会话 / 39,758 次请求 / 50,266 次工具调用。
> 本文件只写**裁决**；未获用户确认的删除项列在 §7。

## 1. 先纠正三个错误前提（它们导致了过去一半的施工）

| 过去的前提 | 实测/源码事实 | 后果 |
| --- | --- | --- |
| 常驻提示进系统提示稳定前缀，按回合变化会击穿全量缓存 | DSH 的 `systemPrompt.context()` 落成**尾部 `user/message` 快照**（`agent.ts:428-440`），不是系统提示段 | 「为了缓存而不敢注入」的论证作废；真正要稳定的是**跨会话项目前缀** |
| 新会话大量未缓存 token 是主要成本 | 首请求未缓存中位 **3,164 token**；379 个首请求合计 **$0.31 = 输入成本 0.4%** | 项目理解要解决的是「探索/重复读」与质量，不是这 0.4% |
| 上下文优化能省大钱 | 全账 $76.9：缓存读历史 **46.8%**、输出 **29.7%**、未缓存输入 19.9%；工具结果占 prompt **85.5%** | 钱袋是**输出/回合数/历史体积**，不是开场几十字符 |

**因此 v4 的方向不是「再优化注入」，而是：少注入、会记事、把项目理解写成宿主能加载的稳定前缀、把成本花在减少工具结果与回合。**

## 2. 根因（按影响排序，均有实测）

1. **写入靠模型自觉，且没有可判定成功的信号**：用户明说「记住」的 93 个会话中 **82% 没写**；无提示自写仅 12/394；全库 16 条记忆 / 1 条边 / 0 条 project scope。
2. **检索没有相关性信号**：真实召回 score 只有 0.0164/0.0328 两档（RRF 1/61、2/61）；中文 bigram + OR、无下限；实测错配（clash→Firefox 备份、vLLM→会话普查）。
3. **没有项目级持久理解**：read 的 **49.8% 是同会话重复读**，单文件最高 178 次；仓库没有 `AGENTS.md`（宿主已自带加载器），OMB 也没有项目画像。
4. **冷启动是未定义状态**：异步挂载发生在 apply 返回后；真实日志「项目库尚未就绪」283 次/26 会话、「记忆服务未就绪」152 次；首轮工具表/压力/状态半接。
5. **负优化**：9 个工具 schema ≈4,381 字符/请求（reasoning 三件占 1,436）；`omb_verify` 0.11% 使用且循环依赖；`omb_method` 34 次/391 会话；标准档注入恒 0；控制散文与 8 张卡无行为证据。
6. **状态与生命周期**：会话表无上界、无 session 结束语义、异步 disposer 宿主不等待；状态面是散文渲染器，出现「未测量 3,016 次」仍全绿。
7. **安全**：sealed 会话仍可经 `forProject`/`snapshot` 读项目画像；召回不带 `assertedBy`、无 untrusted 封装；真实库里有 SSH/DDNS/反代拓扑明文；embedding 混排 512 维与 256 维。
8. **ABI/部署**：服务名+字符串+白名单，无类型/版本/权限；构建-部署三套手工，C 盘副本易漂移。

## 3. v4 目标架构（分层，不叠加）

### L0 诊断层（替代 `omb-context`）
- 删除 `modules/context/**`（Wave 1 后 937 行）与 `packages/context`；压力/窗口/采样一行留在 `omb_status` 顶层。
- 所有读数带来源与时间；不再承诺未接线的行为。
- 外部核验器调度：验证 = tsc/eslint/vitest/git diff 的退出码与摘要，由模型显式调用；**不做内在自验证**。

### L1 项目层（宿主拥有，OMB 不重复造）
- 仓库根写 `AGENTS.md` 2–4 KB：模块地图、不变量、命令、坑；宿主 `dsh-agent-instructions` 自动加载（当前 1/379 会话出现，仓库文件缺失）。
- 任意工作区：`omb_project` 按需读项目画像（目录/栈/命令/git/README + 项目级决策），**不进系统提示、不逐回合注入**；schema 压到最小。
- 不造 repo-map 索引/工具（Aider 1k token 的证据不支持在本地仓库上净收益；列为观察项）。

### L2 记忆层（OMB 的核心价值）
- **自主捕获（零 LLM）**：事件台账 → 确定性规则（用户长期偏好/决定、测试/构建/提交/关键文件、会话结果）；按隐私门控、可分类关闭、带来源；不做「全量会话摘要」。
- **写入**：模型主动 `omb_remember` 保留；准入依据换成可核验事实（会话见证/执行台账/工件）；回顾体护栏。
- **检索**：中文 bigram FTS 保留；加分数下限、snippet-first、默认轻量重排；修 embedding 混排；真实回归集验收。
- **网络**：实体抽取（路径/包/命令/项目）自动连边 + 1-hop 扩展；边:记忆 <10:1。
- **生命周期**：可逆归档、冲突呈现、非破坏 supersede；跨项目用户库保留。

### L3 推理层（从「提示」变成「技能/可选旋钮」）
- 删除 `omb_verify` + 验证台账 + 验证段；删除控制散文、紧档索引、自动注入卡。
- 8 张方法卡 → DSH skill 文件（或压到 ≤2 条并进工具描述）；常驻只留一句 ≤80 字符的入口。
- `omb_focus` 唯一真实作用：在**显式改档/回合边界**映射 `reasoningEffort`（quick→low、deep→max），能力探测失败时状态面写明未生效；不按压力逐回合改档。
- 循环检测保留（callId 配对、压缩代际分区、迟滞），只在真信号出现时注入一行；阈值用日志标定。

## 4. 工具面（从 9 个 → 6–7 个）

| 现在 | 裁决 |
| --- | --- |
| `omb_recall` / `omb_remember` / `omb_forget` | 保留；`omb_relate` 合并为 recall 参数（或保留但压 schema） |
| `omb_files` | 保留（索引零上下文成本）或并入 `omb_status` |
| `omb_status` | 保留（唯一诊断入口，需压缩到 ≤2.5K 字符整段） |
| `omb_method` / `omb_focus` / `omb_verify` | 删除（技能化/真实 effort/外部核验替代）；如保留 focus，只留 effort |
| 新增 `omb_project` | 保留但 schema ≤400 字符，按需读画像 + 项目决策 |

目标：OMB 模型面固定开销 1,495 → **≤600 token/请求**；稳态注入 0；工具 schema 不再增长。

## 5. 施工顺序与门禁

| 阶段 | 内容 | 门禁/杀判据 |
| --- | --- | --- |
| S0（本轮已做/在做） | 真相层（投影形状/状态/台账）、记忆 Wave1（snippet/下限/见证）、自主捕获 + `omb_project` + 连边 + 冷启动、`AGENTS.md` | tsc/eslint/vitest/build 全绿；记忆写入率、召回 top-1、边数、冷启动失败数 |
| S1 | 删 `omb_verify` + 控制散文 + 紧档索引；技能化 8 卡；工具面压到 6–7 | 稳态 OMB token ≤600/请求；20 会话技能调用率 ≥10%；无回归 |
| S2 | 删 `omb-context` 模块，保留顶层压力行；生命周期协议（ready 状态机、LRU、session close、异步 disposer） | 状态面零矛盾；1,000 假会话后表 size 有界；首轮 0「未就绪」 |
| S3 | effort 映射接线（host-actions 单一表）+ 能力探测；隐私读边界/召回 untrusted 封装；embedding 空间隔离 | quick `outputTokens` ≤40% max；sealed 读路径测试；召回 header 带证据等级 |

## 6. 验收（全部可测）

- 自主写入：用户明说「记住」→ 落库率 **>90%**；无提示捕获出现在 ≥30% 根会话；0 明文密钥。
- 检索：真实回归集 top-1 切题率 30%→**≥60%**；5 条输出 ≤1.6K 字符；p95 延迟 ≤250ms（10k 行 ≤50ms）。
- 网络：project DB 边数 >0 且边:记忆 <10:1；带边召回 ≥30%。
- 项目理解：`AGENTS.md` 在 ≥90% 新会话被加载；20 会话 A/B 首次编辑前探索调用 −15%；重复读下降。
- 冷启动：「项目库尚未就绪」20 会话内 <10 次；首轮工具集合完整；状态面 ready 阶段可见。
- 成本：缓存读占比 ≥98%；工具结果字符/请求 −15%；稳态 OMB token ≤600/请求。
- 推理：技能调用 ≥10% 会话；循环提示 precision ≥70%（否则默认关）；quick outputTokens ≤40%。

## 7. 需要用户确认的不可逆项

1. 删除 `omb_verify`、`omb_method`、`omb_focus` 三个工具（技能化/保留 effort 的替代方案见 §3）。
2. 删除 `omb-context` 组件（模块行、包、display 行、测试），只保留顶层压力行。
3. 把 8 张方法卡迁成 DSH skills（`skills/` 目录 + 预设 `customSkillDirs`），不再保留 `omb_method`。
4. 在仓库根新增 `AGENTS.md`（2–4 KB，宿主加载；不是 OMB 模块）。
5. 是否恢复 effort 映射（唯一真实算力旋钮；只在显式改档/回合边界改请求头）。

## 8. 不做（有证据）

- 不做内在自验证/自省式质量判断；不做写入时 LLM 抽取；不做 GraphRAG/社区摘要/三级记忆；不做 repo-map 工具（本轮）；不逐回合注入压力/摘要；不替换宿主压缩/pruner/session-search；不把新会话未缓存 token 当主成本；不为「项目理解」新增大 schema 工具；不恢复 `admission` 服务面。

---

## 9. v4.1 决策（2026-10-18 晚，提交 `7842ab1`（收尾清理 `e6fbbbb`），版本 4.1.0 / g90）

> 依据：`docs/v4.1-spacetime.md`、`docs/research/2026-10-18-v4-review-response.md`。
> v4.0 的组件各自正确，但**各自回答半句话**；v4.1 不新增工具，只让它们共享同一套时空坐标。

| # | 决策 | 为什么（证据） | 验收 | 明确不做 |
| --- | --- | --- | --- | --- |
| D1 | **写守卫改为资源级内容哈希**：读取时固化 `sha256` 前 16（≤2MB），`edit`+`write` 统一比较当前内容哈希；读后被改 → deny（≤120 事实句）；同路径同回合第 3 次放行计 `gaveUps`；`post-execute` 成功刷新自身印记；`writeIntent` 按 `turn/start` 清空 | v4.0 用**全局 epoch** 判定：无关文件变化会误伤、脏集不覆盖时漏判（`18ec311:dsh/state-machine.ts:38,350`）；`writeIntent` 从不清空导致外部改动被永久归因为己方 | 判定表逐行单测（`tests/dsh/state-machine.test.ts`）；真机"读后被外部改 → deny" | 缺读取戳不硬拦（shell 读不可见 + 防 #33856 死锁），只计 `blindWrites`/`unverifiable`；fail-open 保留但必须留声 |
| D2 | **自主捕获改为 pending → result 生命周期**：`tool/call` 只挂 pending；`tool/result` 决定写什么——成功写旧文本、失败写 `未生效：…`、未知不写；`turn/end` 未解决计 `unconfirmed`；无 `callId` 退回旧行为并显式计数 | v4.0 在 `tool/call` 时写"编辑文件：x"，**尝试过被记成完成过**（`18ec311:modules/memory/capture.ts:565`） | `tests/modules/memory/capture.test.ts`；`omb_status` 记忆段新增 failed/unconfirmed/unknownResult/noPending/unconfirmedCall | 不追回已写入的错误事实（逐字保真，supersede 修正）；无 callId 的降级保留并计数 |
| D3 | **项目身份 = git root**：新增 `SERVICES.projectRoot`（`dsh/project-root.ts`，同步 2.5s/缓存 60s·128/失败退化 cwd/绝不抛）；`stores.projectRootOf` 统一 `ensureProject/forProject/peek`；画像在根构建、`cwdRel` 保留"我在哪" | v4.0 按 cwd 开项目库，子目录会话另起一库，项目记忆被切成两半（`18ec311:modules/memory/store.ts:2031,2672,2847`） | `tests/dsh/project-root.test.ts`、`tests/modules/memory/project-root.test.ts`；子目录会话与根会话共享项目库 | 非 git 目录退化为 cwd（契约如此）；不做跨仓合并 |
| D4 | **隐私先于读取**：`omb_project` 在任何读取前调 `privacyAllowsRead`；`sealed` 拒绝画像与记忆并说明原因；隐私服务缺席=可读，判定抛错=不可读（fail-closed） | v4.0 的 `omb_project` 无隐私判断，画像不经过库边界，sealed 会话仍可读（`18ec311:modules/memory/project.ts` 无 privacy 匹配） | `tests/modules/memory/project-tool.test.ts`（sealed 全拒/read-only 允许/无归属只画像/服务缺席可读） | 不做字段级脱敏；其它读路径仍以库边界 `gateSet` 为准 |
| D5 | **`omb_project` 改为分层时空快照 L0–L5**（身份/结构/空间状态/时间/知识/意图），总长 ≤2,400 字符；新增 `sessionState.situation()` 供 L2/L3/L5 与状态面共用；缺项写"未接线/无会话归属/状态未知"，不写 0 | 四个组件缺同一套坐标；用户要"一次调用知道我在哪、什么变了、以前记过什么" | `tests/modules/memory/project-tool.test.ts`（六层顺序/缺服务降级/字符上限）；真机 `omb_project` 返回六层 | 符号级 repo-map、三方合并、shell 写追踪、子代理写集、`AGENTS.md` 指纹 → v4.2/不做（契约 §8） |

**与 §3 的关系**：§3 的 L0–L3 分层不变；v4.1 是 L1 项目层与 L2 记忆层之间的**坐标/守卫**升级，不新增层、不新增工具。**与 §7 的关系**：§7 的不可逆项（删 `omb_verify`/`omb_method`/`omb_focus`、删 `omb-context`、技能化 8 卡、`AGENTS.md`）已在 v4.0 落地，v4.1 不重开。

## 10. v4.2 决策（2026-10-19，版本 4.2.0 / g91）

> 依据：`docs/v4.2-gap-closure.md`。v4.1 的五个明确留白逐条收尾；`dsh-path-guard` 不在本版范围。

| # | 决策 | 为什么（证据） | 验收 | 明确不做 |
| --- | --- | --- | --- | --- |
| D6 | **指令文件指纹进 epoch**：`AGENTS.md`/`CLAUDE.md`（≤256KB）sha256 前 12 → `WorkspaceEpoch.instructions`；`turn/start` 真变化才提示"指令已变"；首次见到只记录 | v4.1 明确留白"AGENTS.md 指纹"；规则文件变了模型却不知道，等于继续按旧规则工作 | `tests/dsh/state-machine.test.ts` 指令指纹用例；状态行/`omb_project` L1 可见 | 不把指纹混进 `epoch.id`（宿主 tree 形状不变）；不做规则内容 diff |
| D7 | **shell 写路径提取**：`shellTools` 可配置；`extractShellWritePaths` 覆盖重定向/-Path/sed -i/git checkout，提取不到标 `unknown`；shell 成功并入 `writeIntent` | v4.1 明确留白"shell 写文件追踪"；宿主 shell 是最大盲区 | `extractShellWritePaths` 单测 + "读后 shell 写过且 hash 不可用 → deny"；`situation.sideEffects.shellWrites/shellUnknown` | 不执行命令、不猜未列出的路径；`git apply`/构建脚本的未知写只计数 |
| D8 | **跨会话/子代理写归因**：全局有界 `recentWrites`（cwd+absPath → 最近写入者/时刻）；`otherSessionWrites` 计入 situation；hash 不可用时保守 deny | v4.1 明确留白"子代理写集并入"；内容哈希能拦"内容变了"，但无法在**无法核验**时给归因 | 双会话单测（A 读、B 写 → A 的 edit deny 且理由含"其他会话"）；`omb_project` L2 显示 | 不做父/子会话拓扑推断；不做按路径精确归属的合并 |
| D9 | **符号级 repo-map**：`extractSymbols`（TS/JS/Py/Go/Rust 导出名，频次排序 ≤6）+ `ProjectProfileSource.exports/symbols`；`omb_project` L1 只展示前两个有符号目录的短摘要 | 审查与用户都指出"画像不是深入项目理解"；完整语言服务成本高、收益未验证 | 临时仓库单测（`export const alpha/beta` → symbols）；`PROFILE_TEXT_MAX` 与扫描上限不变 | 完整导入图/调用图/类型解析（v4.3）；不新增常驻提示 |
| D10 | **盲写策略可配置**：`blindWritePolicy: 'allow' \| 'deny'`（默认 allow）；deny 时无印记+文件存在 → deny，逃生门第 3 次放行 | v4.1 留白"缺读取戳是否硬拦"；shell 读不可见使默认硬拦有误伤风险，但需要更严的项目应有开关 | `tests/dsh/state-machine.test.ts` deny 两次→第 3 次 allow；`blindWrites` 两策略都计数 | 默认不改（避免误伤 shell 读）；不做按项目自动切换 |
