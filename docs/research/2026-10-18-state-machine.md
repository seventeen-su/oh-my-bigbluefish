# R10 —— 状态机：并发编辑、长间隔恢复、自由目标跟踪与统一收益目标

- 线程：R10（任务 task-21）。唯一写盘产物：本文件。未改代码、未跑 git、未装包、未改 profile。
- 输入：`docs/v4-decision.md`、四份基础报告 + 学术前沿（R5）、`docs/research/2026-10-18-probe-followup.md`、AGENTS.md；DSH 源码 `D:\Program\deepseek-harness`（tag `dsh-v0.2.1-rc.2`）。
- 标签：**[实测]**＝本轮亲自跑出的读数或源码行号；**[报告]**＝论文/文档/厂商自述；**[推测]**＝由前两者推出的、可证伪判断。
- 本轮新增实测语料口径：`%USERPROFILE%\.dsh\sessions\**\session.v4.jsonl.zstd` 逐帧解压（Node 24 `zlib.zstdDecompressSync`，按 `28 b5 2f fd` 切帧），共 **394 会话 = 60 个根会话（origin=user）+ 334 个子代理会话**。下文未特别说明的数字一律指**根会话**。

---

## 0. 结论先行（12 条判词）

1. **状态机的价值不在"存",在"对账"**：一次认知连续 = 世界身份（epoch）+ 我信过什么（read stamps / goal ledger）+ 增量（delta）+ 时间（wall clock）四元组。OMB 现在只有"记忆条目"，四项全缺。
2. **本机证据支持用户三条抱怨**：根会话 5,777 次写/编辑中，**1,528 次（26.5%）写向本会话从未读过的既有文件**，另有 **357 次（6.2%）距上次读取 >20 步**；1,066 个回合里 **29 个（2.7%）异常结束**；35 个多回合根会话中 **19 个（54%）出现过 >1 小时的回合间隔**，最长 290 小时 [实测]。
3. **生产工具全部把"外部改动"当盲区**：Claude Code 的 checkpoint 只跟踪自家 file-edit 工具，**bash 改动、外部改动、子代理改动都不跟踪**（文档明说）[报告](https://code.claude.com/docs/en/checkpointing)；Cursor 把编辑拆成"规划 + 应用"，应用阶段以**当前文件字节**为条件 [报告](https://cursor.com/blog/instant-apply)；Aider 的对策是**编辑前先把脏文件提交成基线** [报告](https://aider.chat/docs/git.html)。⇒ 这正是 OMB 可以做出差异的地方，但机制必须是"对账"，不是"替用户回滚"。
4. **只读不拦 = 没用；只拦不导流 = 死锁**：DSH 的 `tools/pre-execute` 支持 `{kind:'deny', reason}`（`packages/core/tools/src/index.ts:154`，测试 `tests/tools.spec.ts:746,1764`），但 Claude Code 有"文件被改过"误报把 Edit/Write 永久卡死的 issue（#33856）⇒ 守卫必须有**逃生门 + 每路径每回合最多 2 次 + 失败降级为警告**。
5. **长间隔的"时间感"不能靠系统提示**：DSH 的运行时上下文是**尾部 user/message 快照**（`agent.ts:428-440`、`runtime-context.ts:152-163`），不是系统前缀；把"现在几点/过了多久"写进系统提示既破坏跨会话前缀稳定性，也拿不到真实事件时间。正确做法是**回合边界惰性计算 + 只在变化时注入一行**。
6. **"自由目标跟踪"只能做确定性台账**：数据源是宿主已提交的事件——`goal/change`、`todo/write`、`turn/end`（含 reason）、`user/message`（`known-event-types.ts:41,70,79,81`）；根会话实测 goal 事件 56 次、todo 快照 85 次、`working-directory/change` 0 次、`plan/mode` 0 次 [实测]。**不用 LLM 判断"完成没"**：内在自判不可靠（R5 §3.2），而且违反"热路径零 LLM"。
7. **自动集成 ≠ 自动学习**：记录（确定性、零 LLM）与学习（需要 outcome 信号 + 策略更新）是两件事。ACE/ReasoningBank/Dynamic Cheatsheet 都要"可判定的成败"，而自我判定存在结构性天花板（Self-Verification Cliff：54.7% 含解 vs 41.9% 自选）[报告](https://icml.cc/virtual/2026/82529)。状态机先解决"outcome 可观测"，不宣称"学会了"。
8. **统一效用目标可以写成一个可裁决的不等式**：机制 m 只在 `P_hit × C_err > C_tok + C_lat + C_att + C_cache` 时保留（metareasoning / value-of-computation 的工程化，[Russell & Wefald 1991](https://doi.org/10.1016/0004-3702(91)90015-C)）。状态行的 C_tok 是 120 字符 ≈ 33 token，C_err 是"基于陈旧文件改错 → 返工 1–3 个回合"，量级差 2 个数量级 ⇒ 值得做。
9. **宿主已经有现成的逐回合改动摘要，而且已经在跑**：`@deepseek-ai/dsh-workspace-changes`（v0.2.1-rc.2，web-app bundle `cordis.patch.yml:357-358` 引用）按回合用 git 工作树快照统计改动，公告 `workspace/changes`，并给出 turn 起止的 **git tree id**（`packages/deliverables/workspace-changes/src/index.ts:1-9`，服务 `:116-119`，仅根会话 `:59-62`，`types.ts:38-40`）[实测/源码]；本机语料实测 **520 个 `workspace/changes` 事件 / 27 个会话** [实测]。⇒ OMB 应**优先消费宿主**（tree id 可直接当 epoch，零 subprocess），只有 27/394 覆盖不到时回退自算；但仍需自己的读集与守卫（宿主只公告"改了什么"，不公告"模型信过什么"）。
10. **"不要后台 watcher"**：DSH 包内没有 `fs.watch`/chokidar（仅客户端构建配置出现 watch 字样）[实测]；VS Code 自己也建议"用简单 pattern、避免递归 watcher"[报告](https://raw.githubusercontent.com/microsoft/vscode/main/src/vscode-dts/vscode.d.ts)。⇒ 在 `step`/`turn` 边界做**有界 stat + 每回合一次 git status**，是唯一零句柄、可判死的方案；OS 级升级路径是 git fsmonitor（[git-update-index](https://git-scm.com/docs/git-update-index)）。
11. **一个 120 字符的状态行足够覆盖四类事实**：epoch id（8 hex）、外部改动计数、HEAD/branch 变化、间隔时长、未闭合目标数。**正常时注入 0 字节**；只有摘要变化才提交（宿主运行时上下文本身就是"仅变化才提交"，`runtime-context.ts:146-163`）。
12. **反模式要一开始就写死**：不做影子副本、不做自动提交/stash、不做"必须重读"的命令式提示、不把状态放进系统提示、不跟踪全仓库、不信任 shell 的读/写归属、不用 LLM 判完成。

---

## 1. 三个被误解的问题（逐条回应 ChatGPT 批判）

### 1.1 "存储 + 关联 ≠ 连续的项目认知"

**它说得对，而且可以用缺失的四元组精确表述**：

| 连续认知需要的 | OMB 现状 | 本设计补的 |
| --- | --- | --- |
| 世界身份：我面对的这棵树/这个分支是哪一版 | 无（只有文件路径） | `workspace epoch`（HEAD + 脏集摘要 + 热文件 stamp） |
| 我的信念：我读过什么、以什么版本为据 | 无（read 结果只在会话历史里） | `read stamps`（path → mtime/size/epoch/step/via） |
| 增量：自我上次观察后哪里变了、谁改的 | 无 | `explained/unexplained` 归因 + 外部改动计数 |
| 时间：现在与上次观察的墙钟差 | 无（模型只看得到"此刻"） | `lastEventAt` + 间隔分级 + 事件时间戳 |

记忆库解决"跨会话知道什么"，状态机解决"这次是否还成立"。两者不是同一层，也**不能互相替代**——这就是"存储 + 关联"看起来做了很多却仍不连续的机制原因。

### 1.2 "自动集成 ≠ 自动学习"

- **记录**：确定性、可审计、零 LLM（观测 → 归因 → 落盘）。状态机的全部内容属于这一层。
- **学习**：需要 (a) 可判定的结果信号、(b) 能改变未来策略的更新规则。ACE（agent +10.6%）[报告](https://arxiv.org/abs/2510.04618)、ReasoningBank（ICLR 2026）[报告](https://arxiv.org/abs/2509.25140)、Dynamic Cheatsheet（AIME 翻倍）[报告](https://arxiv.org/abs/2504.07952) 都建立在这两项上；而"模型自判成败"有结构性上限（Self-Verification Cliff）[报告](https://icml.cc/virtual/2026/82529)。
- **所以本文件的承诺边界**：状态机让"回合结果"变成可观测事实（`turn/end.reason`、测试退出码、git 提交、goal 关闭），为将来可能的技能/策略层提供标签；**不宣称 OMB 因此会学习**。谁要宣称，先拿出 20 会话 A/B（§12 AT-6）。

### 1.3 "推理/上下文缺统一效用目标"

ChatGPT 的四条批评（加输入 / 破前缀 / 引入不合规规则 / 拉长推理）可以压成一个不等式：

```
保留机制 m  ⟺  P_hit(m) · C_err(m)  >  C_tok(m) + C_lat(m) + C_att(m) + C_cache(m)
```

- `P_hit`：该机制拦到真问题的概率（本机可测，见 §2）。
- `C_err`：漏掉时的返工成本（错改一个文件 ≈ 1–3 个回合）。
- `C_tok`：每请求字符成本（DeepSeek 缓存命中价 $0.003–0.006/M，输出 $0.6–1.2/M ⇒ **输入侧成本几乎可忽略，注意力成本才是主项**，R5 §0）。
- `C_cache`：是否改动稳定前缀（本设计的注入走尾部快照，结构性为 0）。
- `C_att`：进入上下文后稀释指令遵循的代价（IFScale：500 条指令最好模型 68%）[报告](https://arxiv.org/abs/2507.11538)。

---

## 2. 本机实测：状态机要解决的具体缺口

### 2.1 根会话（origin=user，60 个）读数 [实测]

| 指标 | 值 | 对设计的含义 |
| --- | --- | --- |
| 会话 / 回合 / step / 工具调用 | 60 / 1,066 / 17,471 / 20,743 | 状态机只在根会话运行（子代理继承父状态，不建自己的台账） |
| 回合结束原因 | completed 1,037；aborted 22；error 5；interrupted 1；max-tokens 1 | **29/1,066 = 2.7% 异常结束** ⇒ 恢复路径是高频路径，不是边角 |
| 读 / 写+编辑 | 2,803 / 5,777 | 写比读多一倍：模型大量盲写 |
| 写向"本会话从未读过的既有文件" | **1,528（26.5%）** | 这是"状态判断错误"最直接的代理指标 |
| 写距上次读 >20 step | **357（6.2%）** | 陈旧读取后写入 |
| 多回合会话 / 其中出现 >1h 间隔 | 35 / **19（54%）** | 长间隔恢复是常态 |
| 回合间隔 | n=1,022；p50 4.2min；p90 36min；>1h 77；>24h 29；max 290h | 分级阈值：>5min idle、>1h stale、>24h deep-stale |
| `goal/change` / `todo/write` | 56 / 85 | 宿主目标状态**部分可用**，不能只靠它 |
| `working-directory/change` / `plan/mode` | 0 / 0 | 空间变化与本机几乎无关；plan 模式未被使用 |

### 2.2 全量语料（含子代理，394 个）对照 [实测]

| 指标 | 值 |
| --- | --- |
| 工具调用 top | pwsh 16,493；edit 10,655；read 9,343；grep 3,430；write 2,631 |
| 写/编辑总数 | 13,286；盲写既有文件 3,589（edit 1,793 + write 1,796）；edit 距上次读 >20 步 1,345 |
| 出现"任一风险写"的会话 | 214/394（54%） |
| `workspace/changes` 事件 | **520 个，覆盖 27 个会话**（宿主逐回合改动摘要已在跑） |
| 其他宿主事件 | `compaction/start|end|summary` 各 35；`request/context` 386；`sandbox/mode` 397；`fs/observed` 0；`approval/asked` 0 |
| `omb_recall` 使用率 | 27/391 会话（6.9%，既有报告） |

> **口径限制（必须写进实现注释）**：`pwsh` 有 16,493 次调用，很多"读文件"是 shell 完成的（Claude Code 官方承认"用 Bash 查看文件也满足读前置条件"[报告](https://code.claude.com/docs/en/tools-reference)）。所以本机"盲写率"是**上界**，且 shell 的读/写无法归因 ⇒ 守卫对 shell 只能"标记低置信"，不能硬拦。

---

## 3. 生态复核：并发编辑与外部改动（机制 / 盲区 / 可抄）

| 系统 | 机制 | 解决了什么 | 盲区/失败模式 | OMB 可抄什么 |
| --- | --- | --- | --- | --- |
| **Claude Code checkpoints / SDK** | 每个起回合的 prompt 前快照文件；保留 100 个 checkpoint；`/rewind` 恢复代码/对话/摘要；SDK 同样提供 file-checkpointing [报告](https://code.claude.com/docs/en/checkpointing)、[报告](https://code.claude.com/docs/en/agent-sdk/file-checkpointing) | 会话级"回到某个点" | **只跟踪自家 file-edit**；**Bash 改动不跟踪**；**外部改动不跟踪**；子代理改动多数不恢复；快照 ~30 天清理 | "回合边界快照"的概念；但**不要**学"替用户回滚" |
| **Claude Code Edit/Write** | 编辑要求本轮读过；Write 覆盖既有文件要求读过；部分读（PARTIAL）不满足；Bash 查看算读过 [报告](https://code.claude.com/docs/en/tools-reference) | 防盲写 | 误报会卡死（issue #33856）；同会话 MEMORY.md 被自动写入会失效读快照（issue #62336） | 读前置 + **逃生门 + 降级** |
| **Cursor fast apply** | 规划（前沿模型）与应用（专用模型）分离；应用以**当前文件全文**为条件；~1000 token/s、13× 加速 [报告](https://cursor.com/blog/instant-apply) | 大编辑的准确率与延迟 | 需要专用模型；外部并发改动仍靠编辑器状态 | 编辑的"条件"应该是**当前字节**，不是历史字节 |
| **Aider** | 编辑前把**脏文件先提交**成基线；自动提交每次编辑；`/undo`、`/diff`；author/committer 归属；repo map 按 token 预算生成并在文件变动时刷新 [报告](https://aider.chat/docs/git.html)、[报告](https://aider.chat/docs/repomap.html) | 人改与 AI 改可分离、可撤销；结构索引不腐化 | 需要仓库干净习惯；提交噪声；不能替代并发控制 | **归属**思想：先建立"基线"，再谈"谁改的"；索引必须能刷新 |
| **OpenHands** | 全量 typed event 流作为记忆与集成点；状态由事件 fold 出来 [报告](https://docs.openhands.dev/sdk/arch/events)、[报告](https://arxiv.org/abs/2407.16741) | 可回放、可观测、可恢复 | 事件多、需要投影；外部文件系统仍是副作用 | **事件溯源**：状态机必须能被事件重建，不能只存"最后状态" |
| **Codex CLI/IDE** | 沙箱 + 审批策略两层；auto-review 失败即拒（fail closed）；建议"委派前保持 git status 干净、优先 patch 工作流、频繁提交" [报告](https://learn.chatgpt.com/docs/agent-approvals-security) | 越权与破坏性操作 | 不解决"外部改动与陈旧读取" | 守卫要 **fail closed + 可审计**；但用户侧成本要低 |
| **VS Code** | 文件被外部改动时保存会报"content of the file is newer"，让用户比较/覆盖；`FileSystemWatcher` 建议简单 pattern 避免递归 [报告](https://stackoverflow.com/questions/79322283)、[报告](https://raw.githubusercontent.com/microsoft/vscode/main/src/vscode-dts/vscode.d.ts) | 冲突可见、由人裁决 | watcher 开销/平台差异；仍可能丢改动 | **冲突呈现给人**，不要自动合并 |
| **Git** | index 记 mtime/size，`--refresh` 只"重匹配 stat"不重算内容；`assume-unchanged` 可跳过检查；`fsmonitor` daemon 可加速 [报告](https://git-scm.com/docs/git-update-index) | 廉价变更检测 | mtime 粒度/racily clean 会漏判；网络盘 lstat 慢 | **stat 为主 + 可疑时 hash**（见 §5.4） |
| **理论** | OCC：读集/写集在提交时校验（Kung & Robinson 1981）[报告](https://doi.org/10.1145/319566.319567)；版本向量检测互不一致（Parker et al. 1983）[报告](https://doi.org/10.1109/TSE.1983.236733) | 并发正确性的最小充分条件 | 乐观并发会 abort；需要重试策略 | OMB 的 `read stamp` 就是读集，`epoch` 就是版本向量的一维 |
| **DSH 宿主** | `tools/pre-execute` 可 deny（`tools.spec.ts:746,1764`）；`workspace-changes` 插件逐回合用 git 快照算改动并公告 `workspace/changes`（web-app bundle `cordis.patch.yml:357-358`；服务 `workspace-changes/src/index.ts:116-119`；tree id `types.ts:38-40`），本机 520 事件/27 会话；`fs.watch` 服务存在（`fs/fs-local/src/index.ts:10`，`api/workspace-files/src/changes.ts:5,79` 消费 `fs/observed`）；`working-directory/change` 事件存在（`session/working-directory/src/index.ts:143,191`） | 有拦截点、现成改动摘要与 watcher 原语 | 改动摘要**只在 turn 结束**公告；只覆盖 27/394 会话；shell 副作用不可见；watcher 有句柄/平台代价 | 拦截用 pre-execute；epoch 优先用宿主 tree id；watcher 仅作可选增强 |

**结论**：外部改动检测在工业界是"编辑器级冲突提示 + 粗粒度 checkpoint"，**没有一家在 agent 层做读集校验**。OMB 的差异化机会是"把 OCC 的读集校验装进插件"，但必须极便宜、可降级、不阻塞。

---

## 4. 时间与陈旧：为什么"过了多久"必须由外部事实补

| 证据 | 结论 | 对 OMB |
| --- | --- | --- |
| FreshLLMs/FreshQA：所有模型（不分大小）在"快速变化的知识"和"错误前提"上挣扎；检索增强（FreshPrompt）显著提升；回答要求"简洁直接"能降低幻觉 [报告](https://arxiv.org/abs/2310.03214) | 模型没有内在时钟，且越自信越危险 | 时间必须作为**外部事实**注入，且只给事实不给指令 |
| context rot：长度增加性能一致下降；无关干扰一个就掉点；结构化长文反而更差 [报告](https://www.trychroma.com/research/context-rot) | 把"状态历史"越堆越多会反噬 | 状态行**只报计数与 id**，正文让模型自己去看 |
| lost-in-the-middle [报告](https://arxiv.org/abs/2307.03172) / RULER [报告](https://arxiv.org/abs/2404.06654) | 关键信息要放首尾 | 状态行走**尾部快照**，正好在"最近"位置 |
| Claude Code 外部改动不跟踪 [报告](https://code.claude.com/docs/en/checkpointing) | 工业界默认放弃这一层 | OMB 做"提示 + 守卫"，不做"回滚" |
| git stat 语义 [报告](https://git-scm.com/docs/git-update-index) | mtime+size 是主判据，但存在 racily-clean 与粒度问题 | 采 stamp 时记录 `stampAt`；`|stampAt − mtime| < 2s` 时降级 hash |
| 宿主运行时上下文仅"变化才提交"（`runtime-context.ts:146-163`）[实测/源码] | 注入成本 ≈ 变化次数 × 长度 | 状态行必须做摘要去重，否则每步一条尾部消息 |
| Temporal/LangGraph 的 durable execution（工作流级持久化与恢复）[报告](https://temporal.io/blog/temporal-langgraph-plugin-durable-execution) | 恢复的正确姿势是"重放 + 状态机"，不是"重试" | 状态机持久化采用事件 + 快照（§6.4） |

---

## 5. 工作区 Epoch（WE）：定义、采集、归因、误差

### 5.1 定义

```
Epoch = {
  id:        "e" + hex8(sha256(head + dirtyDigest + branch)[0..8]),
  head:      git rev-parse HEAD | null,
  branch:    git symbolic-ref --short HEAD | null,
  dirtyDigest: sha256(sorted "git status --porcelain=v2 -z" 输出) | null,
  trackedDigest?: sha256("git ls-files -s" 输出) | null,   // 可选，检测内容已暂存但工作树回退
  capturedAt: number,                                        // 采集时刻
  profile: { agentsMd: {size,mtimeMs,hash8}, ombProjectAsOf?: string }
}
```

- **身份**用 `id`；**增量**用与上一个 epoch 的差（head 变、branch 变、dirtyDigest 变、profile 变）。
- **优先用宿主 tree id**：若 `workspaceChanges.summary()` 可读，`snapshot.before/after` 已是一对 git tree id（`workspace-changes/src/types.ts:38-40`），可直接做 epoch 与 delta，**零 subprocess**；自算路径（L1）只是覆盖不到时的回退。
- 一个 epoch 只在**回合边界**（`turn/start`、`turn/end`）或**守卫触发时**更新；不追求实时。

### 5.2 采集（三级成本，任何一级失败都降级而非报错）

| 级别 | 内容 | 调用 | 成本 [实测/推测] | 触发 |
| --- | --- | --- | --- | --- |
| L0 便宜 | `stat` 热集（≤64 路径） | `fs.statSync` | 64 次 ≈ 0.5–2 ms（本机 NTFS） | 每个 `step/start`（节流 ≥2s） |
| L1 中 | `git rev-parse HEAD` + `git status --porcelain=v2 -z --untracked-files=normal` | 2 次 subprocess | 本仓 ~30–80 ms；大仓 0.5–3 s（用 3s 超时 + 跳过） | 仅 `turn/start`/`turn/end` |
| L2 可选 | `git ls-files -s` 或逐文件 hash（≤256KB） | 1 次 subprocess / N 次读 | 只在 L0 可疑（mtime 近 stampAt）时 | 守卫检查时 |
| 宿主 | `workspaceChanges.summary(sessionId, seq)`（若启用） | 服务调用 | O(1) | `workspace/changes` 事件后 |

**关于 watcher（更正）**：DSH **有** watcher 原语——`ctx.fs.watch(target, cb, signal)`（`fs-local` 用 chokidar 实现，`packages/fs/fs-local/src/index.ts:10`），`api/workspace-files/src/changes.ts:5,79` 就在消费 `fs/observed`。但本设计**默认仍用边界轮询**，理由三条：① watcher 只告诉你"变了"，不告诉你"变成哪一版"，落地仍要 stat（等价于事件 + 一次 stat）；② 插件持有常驻 watcher 要处理生命周期、Windows `fs.watch` 队列压力（DSH 自己的 HMR 测试注释就写"polling keeps Windows fs.watch queue pressure out of it"，`boot/hmr/tests/watch-config.spec.ts:129`）与 dispose 顺序；③ 用户要解决的是"回合内改错"，而守卫在 edit/write 前本来就要 stat，边界轮询已覆盖。**可选增强**（P0 探针通过才做）：对热集 ≤8 个文件挂 `ctx.fs.watch`，只为把"外部改动"的发现延迟从"下一步"降到"下一次编辑前"。

### 5.3 归因：谁改的？

不追求"人 vs AI"（不可知），只追求**可解释 vs 不可解释**：

```
writeIntent = 本会话内所有 edit/write 的 path（含时间、step）
             + 规则匹配到的 shell 写意图（git apply/checkout/restore/rm/mv/cp/sed -i/tee/> 等，低置信）
unexplained = dirty 集合 − writeIntent 集合（在 [lastEpoch, now] 窗口内）
```

- `unexplained` 的语义是"**非本会话可解释的改动**"（可能是用户、编辑器、formatter、构建产物、其他会话）。
- 每个 unexplained 路径记录首次发现时间与当时 stamp；**不自动读内容**（避免把用户隐私/大文件拉进模型面）。

### 5.4 精度与已知误差

| 误差源 | 现象 | 缓解 |
| --- | --- | --- |
| mtime 粒度（FAT/网络盘 2s） | 改动与读取同一时间片 → 漏判 | `|mtime − stampAt| < 2s` 时对 ≤256KB 文件做 hash（git 的 racy-clean 思路） |
| 同尺寸同 mtime 覆盖 | 极罕见 | 计入"不确定"，状态行报"1 处不确定" |
| shell 侧写 | edit 后文件被脚本重写 | 归入 unexplained（不等于外部），不硬拦 |
| 子代理写 | 父会话看到 unexplained | 父会话通过 `subagent/*` 事件把子代理写集并入 writeIntent（若可用），否则报"子代理改动" |
| 网络盘 stat 慢 | 每步 64 stat 可能 >50 ms | 单次 stat 超时 2 ms；连续 3 次超时 → 降级为"仅回合边界 L1" |
| git 不可用 | 非仓库/无 git | state=degraded，只统计文件工具改动（与宿主 workspace-changes 的降级语义一致） |

---

## 6. 会话状态机（核心交付）

### 6.1 状态（4 个主状态 + 3 个标记）

| 状态 | 定义 | 模型面行为 |
| --- | --- | --- |
| `active` | 有回合在跑（turn/start 之后、turn/end 之前） | 只做守卫与本地记账；状态行仅在真变化时注入（≤1 条/回合） |
| `idle` | 无回合在跑，且 `now − lastEventAt < 24h`，epoch 未变或变化 < 阈值 | **0 注入**；只更新 stamp |
| `stale` | `now − lastEventAt ≥ 24h` **或** epoch 变化（head/branch/dirty）**或** profile（AGENTS.md/项目画像）变化**或** unexplained ≥5 文件 | 下一次 `turn/start` 先进入 `recovering`，注入一行 |
| `recovering` | 恢复窗口：最多 3 个 step 或首次成功工具调用为止 | 恰好 1 行（含间隔、epoch delta、未闭合目标、外部改动数） |

标记（可与任一主状态共存）：`degraded`（git/stat 不可用）、`interrupted`（上次 `turn/end` 异常）、`unresolved`（存在未闭合目标且无完成证据）。

### 6.2 事件（全部来自宿主会话事件，OMB 已有桥接点）

| 事件 | 宿主来源 | OMB 用途 |
| --- | --- | --- |
| `turn/start` / `turn/end` | `known-event-types.ts:80,79`；OMB `dsh/session.ts:1006-1030` 已消费 step 边界 | 状态迁移、间隔计算、异常原因采集 |
| `step/start` | 同上（OMB 每步可见） | L0 stat、守卫检查节流 |
| `tool/call` / `tool/result` | `known-event-types.ts:75,78`；`dsh/session.ts:1034-1068` | read stamp、writeIntent、守卫 |
| `user/message` | `known-event-types.ts:81`；`dsh/session.ts:955-972` | 目标候选、用户确认/转向 |
| `goal/change` | `known-event-types.ts:41`；`packages/goal/goal/src/index.ts:613` | 权威目标 |
| `todo/write` | `known-event-types.ts:70`；`packages/todo/tool-todo/src/index.ts:199` | 开放项 |
| `plan/mode` | `known-event-types.ts:51` | 计划阶段（本机 0 次，仅兼容） |
| `working-directory/change` | `known-event-types.ts:83`；`session/working-directory/src/index.ts:143,191` | 空间位移 |
| `compaction/end` | `known-event-types.ts:32` | 压缩后"此前结论可能过期"标记 |
| `workspace/changes` | `known-event-types.ts:84`（宿主插件，未安装） | 逐回合改动摘要（可选数据源） |
| 定时 | **无**（不注册 timer） | 间隔在 `turn/start` 惰性计算 |

### 6.3 转移表

| 当前 | 事件/守卫 | 条件 | 下一状态 | 动作 |
| --- | --- | --- | --- | --- |
| any | `turn/start` | 首次出现 | active | 采集 L1 epoch；计算 gap；若 stale 条件成立 → recovering |
| idle | `turn/start` | gap < 5min | active | 不注入 |
| idle | `turn/start` | 5min ≤ gap < 24h 且 epoch 变 | active（`interrupted` 标记若上次异常） | 注入 1 行（若 digest 变） |
| idle | `turn/start` | gap ≥ 24h 或 epoch 大变 | recovering | 注入 1 行 + 标记 `unresolved` 目标 |
| recovering | 首个成功 `tool/result` 或 step≥3 | — | active | 清除恢复窗口；同摘要不再注入 |
| active | `tool/call` = edit/write | 命中守卫（§6.5） | active | `deny(reason)` 或放行 + stamp 更新 |
| active | `step/start` | L0 发现热文件 stamp 变 | active | 记账；若距上次注入 ≥2 step，候选注入 1 行 |
| active | `turn/end` | reason ∈ {error, aborted, interrupted, max-tokens} | idle（`interrupted`） | 记录中断 turn/step；目标打 `interruptedAt` |
| active | `turn/end` | 正常 | idle | 采集 L1 epoch；关闭有证据的目标；摘要落盘 |
| idle | 5min 无事件（惰性：下次访问时判定） | — | idle（不变） | 无动作（不写、不计时） |
| any | epoch/stat 连续 3 次失败 | — | 原状态 + `degraded` | 状态面写"未测量：git/stat 不可用" |
| any | 会话结束/宿主 dispose | — | 移除 | 状态文件保留（LRU ≤100），审计行保留 |

### 6.4 持久化

```
<cwd>/.omb/state/
  workspace.json          # 项目级：epoch、AGENTS.md 指纹、最近 turn 时间、热集 stamp
  sessions/<sid8>.json    # 会话级：状态、readStamps(LRU 64)、goals(≤8)、interrupt、lastLine
  state-events.jsonl      # 可选审计（append-only，环形 ≤1MB）
```

- **schema 带版本号**；未知版本 → 只读不写，状态面报"状态文件版本不识别"。
- **有界**：`readStamps` LRU 64；`goals` ≤8（超出丢最弱/最旧）；`sessions` ≤100（按 lastEventAt LRU）；单文件 ≤64KB。
- **隐私**：目标文本只存**逐字 ≤80 字符**（与记忆的逐字保真一致）；可配置 `state.storeQuotes=false` 只存 hash；不存文件内容、不存 diff、不存工具结果。
- **重建**：状态可由 `state-events.jsonl` 重放；但**运行时只读快照**（不做全量重放，成本不可控）。
- **原子写**：临时文件 + rename；损坏 → 从事件重建或从空开始（状态是派生数据，丢可重建）。

### 6.5 守卫（并发编辑的核心机制）

接入点：`tools/pre-execute`（agent-scoped 或根；DSH 事件签名 `packages/core/tools/src/index.ts:154`；deny 语义见 `tests/tools.spec.ts:746,1764`）。

**判定（对 `edit`）**：

```
allow ⟺ 文件不存在（新建）
       ∨ (stamp 存在 ∧ stamp.epoch == 当前 epoch ∧ stat 与 stamp 的 (size,mtimeMs) 相同)
       ∨ (stamp 存在 ∧ 文件 vanished)
deny(reason ≤120 字) 否则
```

**判定（对 `write` 覆盖既有文件）**：默认**警告放行**（只追加一行到状态面，不改模型面）；`state.strictWrite=true` 时才 deny。

**逃生门（必须有，否则复刻 issue #33856）**：

1. 同一路径同一回合 deny ≤2 次；第 3 次改为"放行 + 状态面记录"。
2. deny 的 reason 必须是**事实**，不含命令式话术：`文件在被读取后被外部改动（mtime 13:04 > 读取 12:58）；若要覆盖请先重读。`
3. 模型若在同一 step 重试同一 edit 且内容相同 → 第二次直接放行（说明它已看到 reason 但选择继续），只记账。
4. shell（`pwsh`）永不 deny；只把命令字符串里的路径标为 `via:shell` 低置信 stamp。
5. 守卫自身异常（stat 失败、状态文件损坏）→ 一律 allow + `degraded`，绝不让守卫成为单点故障。

**写后校验**：`edit/write` 的 `tool/result` 成功后 200ms 内 stat 一次；若 `mtime` 与预期不符或文件消失 → 记账 `write-clobbered`，状态行说"1 处写入被覆盖"。这比"相信工具成功"更接近真相。

---

## 7. 四个场景的端到端时序

### (a) 回合内发生外部编辑

| 步 | 事件 | 状态机动作 | 模型面 |
| --- | --- | --- | --- |
| 1 | `read src/a.ts` 成功 | stamp{a.ts, mtime 12:58, step 3} | — |
| 2 | 用户/VSCode 保存 a.ts（12:59） | 无事件（外部） | — |
| 3 | `step/start`（L0 节流命中） | stat 发现 a.ts mtime 12:59 ≠ stamp | 候选行；距上次注入 <2 step → 暂不注入 |
| 4 | `edit src/a.ts` | pre-execute：stamp 不匹配 → `deny(事实句)` | 工具结果：拒绝原因（≤120 字） |
| 5 | 模型 `read src/a.ts` | 更新 stamp；清除该路径 deny 计数 | 新内容进入上下文 |
| 6 | `edit src/a.ts` | 放行；成功后写后校验 | 正常 |

失败路径：模型不重读、连续第 3 次 edit → 放行并记 `guard-gave-up`；状态面累计，超过阈值自动降级为 warn-only。

### (b) 长间隔恢复（>24h）

`turn/start` → 采 L1 epoch → 与 `epochSeen` 比较：

```
注入（仅当摘要变化，≤120 字）：
[OMB] e7f3a19 距上次 26h14m · HEAD abc1234→def5678 · 外部改动 7 · 未闭合目标 2 · 结论可能过期
```

- 不写"你应当重读"，只给事实；模型自己决定是否重读。
- 若 `git` 不可用：`[OMB] 无 git（stat 计数）距上次 26h · 文件工具外改动 3 · 未闭合目标 2`
- 若间隔 <1h 且 epoch 未变：**什么都不注入**。

### (c) 中断后的目标重追踪

| 步骤 | 事实来源 | 动作 |
| --- | --- | --- |
| 1 | `turn/end.reason=aborted`，step 12 | 记录 `interrupt{turn,step}`；活跃目标打 `interruptedAt` |
| 2 | 同回合内工具失败（exit≠0） | 记录"最后失败动作"，不判定目标失败（模型可能只是试错） |
| 3 | 下次 `turn/start` | 进入 recovering；注入 1 行：`[OMB] e7f3a19 上次回合中断@step12 · 未闭合目标 1（"修 tsc 报错"）· 外部改动 2` |
| 4 | 用户新消息 | 若与未闭合目标语义无关（路径/关键词无交集且无指代），旧目标降级为 `paused`，不删除；状态行只报计数 |
| 5 | 完成证据（`vitest` exit 0 且目标含测试关键词 / `git commit` / todo 变 completed / 用户确认词） | 目标 `closed`，记证据；下一行不再包含它 |

**不做的**：不因"回合结束"就关目标（用户可能只是暂停）；不因"模型说完成"就关（自述不可信，R5 §3.2）。

### (d) 陈旧项目/记忆指针

| 指针 | 检测 | 行为 |
| --- | --- | --- |
| `AGENTS.md` | 每次 `turn/start` 取 size/mtime/hash8；与 `profile.agentsMd` 比 | 变了 → epoch 记 `profileChanged`，恢复行加"AGENTS.md 已变更" |
| `omb_project` 画像 | 画像文件存 `asOfEpoch` | 输出头带 `as of e7f3a19 (2h 前)`；epoch 变 → 标 `stale:true` |
| 记忆条目 `sourceRef` 指向的路径 | recall 时对 ≤5 条做 stat | 路径不存在 → `sourceMissing`；mtime > observedAt → `sourceChanged`；**只标不删** |
| 项目库路径 | 打开时 stat | 不可用 → 状态面"项目库未就绪（原因）"，不显示 0 |

---

## 8. 自由目标跟踪（零 LLM、事件驱动）

### 8.1 目标来源与置信度

| 优先级 | 来源 | 置信度 | 说明 |
| --- | --- | --- | --- |
| 1 | `goal/change` 的 objective + phase | 权威 | 宿主 goal 是用户/模型显式创建的目标 |
| 2 | `todo/write` 的 pending/in_progress 项 | 高 | 宿主 todo 是显式分解 |
| 3 | `exit_plan_mode` 工具结果里的计划标题/成功判据（若可解析） | 高 | 本机 plan/mode 0 次，仅兼容 |
| 4 | `user/message` 里的祈使诉求（规则：含"帮我/把/改成/修/实现/加上/去掉/先…再…"+ 疑问句排除） | 中 | 逐字 ≤80 字符 + seq + 时间 |
| 5 | 用户在无目标时的连续追问（≥2 条指向同一路径/关键词） | 低 | 只记账，默认不进状态行 |

### 8.2 生命周期

```
candidate ──(被后续工具调用强化)──> open ──(完成证据)──> closed
    │                                  │
    └──(3 回合无强化)──> decayed        └──(用户转向/中断)──> paused ──(再次提及)──> open
```

- 上限 8 条；超出按 `confidence → lastTouched` 淘汰。
- `paused` 不删除（与记忆"supersede 非破坏"一致）；状态行只报 `open + paused` 计数。

### 8.3 完成证据（白名单，零 LLM）

| 证据 | 判定 |
| --- | --- |
| `tool/result` 的 `pwsh` 退出码 0 且命令匹配 `test|vitest|tsc|eslint|build|gradle|mvn|pytest` | 与目标关键词（路径/模块）有交集 → 关闭 |
| `git commit` 成功（`tool/call` 含 commit 且 result 无错误） | 目标含"提交/commit"或工作区路径匹配 → 关闭 |
| `todo/write` 中该项 status=completed | 直接关闭 |
| `goal/change` phase=complete | 直接关闭 |
| 用户消息含"好了/可以了/谢谢/没问题/ok/done/继续下一个" | 关闭最近 `open` 目标（限 1 条） |

### 8.4 为什么不用 LLM 判完成

1. 热路径零 LLM（AGENTS.md 不变量 5）。
2. 自判不可靠：Self-Verification Cliff 显示"能生成"不等于"能自选"；弱验证器比不验证更差 [报告](https://icml.cc/virtual/2026/82529)。
3. 成本：一次 LLM 判完成 ≈ 一次完整请求（R5：输出 token 是主成本）。
4. 可证伪：若确定性证据的关闭准确率 <70%（人工判读 20 会话），再考虑离线（非热路径）的 LLM 复核，并作为独立实验。

### 8.5 与宿主 goal/todo/plan 的关系

- **只读不写**：OMB 不调用 `create_goal/update_goal`，不改 `todo`（避免与模型写入竞争）。
- 宿主 goal 存在时，OMB 台账只显示"未闭合项"，不重复 objective 文本（"同一件事只说一遍"）。
- 计划模式：本机 0 次；若未来使用，OMB 只读取 `exit_plan_mode` 结果的成功判据标题，不保存计划正文（长文本留给宿主历史）。

---

## 9. 模型面一行（≤120 字符，仅真实变化）

### 9.1 格式（确定性生成，无 LLM）

```
[OMB] e7f3a19 <变化1> · <变化2> · <变化3>            # 字段按固定顺序，空字段省略
字段候选：
  距上次 {d}h{m}m          （gap ≥ 5min）
  HEAD {a7}→{b7}           （head 变）
  分支 {branch}            （branch 变）
  外部改动 {n}             （unexplained 计数，n≥1）
  写入被覆盖 {n}           （write-clobbered，n≥1）
  未闭合目标 {n}           （open+paused，n≥1）
  上次回合中断@{step}       （interrupted）
  AGENTS.md 已变更          （profile 变）
  结论可能过期              （compaction 或 >24h 且未读关键文件）
  数据不确定                （degraded / 同尺寸同 mtime）
```

### 9.2 触发与抑制

- **摘要** = `sha256(epoch.id + sorted(changed facts) + openGoalIds + interruptTurn)`；与 `lastLine.digest` 相同 → **不提交**。
- 每回合 ≤1 行；同一事实类别冷却 ≥2 step；重复行永不出现。
- 正常状态（epoch 未变、无未闭合目标、gap <30min、无中断）→ **0 字节**。
- 注入位置：运行时上下文（尾部 user/message 快照）；**绝不写系统提示**（否则改跨会话前缀缓存，且 DSH 语义也不同）。

### 9.3 好/坏例子

| 例子 | 评价 |
| --- | --- |
| `[OMB] e7f3a19 距上次 26h14m · HEAD abc1234→def5678 · 外部改动 7 · 未闭合目标 2 · 结论可能过期` | ✅ 73 字符；全事实；可行动 |
| `[OMB] e7f3a19 外部改动 2（src/a.ts 13:04）· 未闭合目标 1` | ✅ 47 字符；只在有变化时 |
| `请先重读被修改的文件，然后再编辑；记住不要覆盖用户的改动` | ❌ 命令式散文（IFScale 指令稀释；R5 §8） |
| `你正在处理 OMB 仓库，当前分支 main，目标是为用户实现状态机……` | ❌ 叙述型上下文；稳定信息应进 AGENTS.md/项目画像 |
| 每步都发 `[OMB] 状态正常` | ❌ 无信息增量，却污染注意力 |

---

## 10. 与 AGENTS.md / 项目画像 / omb_project / 记忆的集成

| 面 | 现状（v4 裁决） | 状态机怎么接 |
| --- | --- | --- |
| `AGENTS.md` | 宿主 `dsh-agent-instructions` 自动加载，仓库根 2–4KB，写"模块地图/不变量/命令/坑"（v4 §3 L1） | **只作为稳定指令源**（R5：概览无效、指令有效，[2602.11988](https://arxiv.org/abs/2602.11988)）；其指纹进 epoch；变更时恢复行报一句 |
| 项目画像（`omb_project`） | 按需读，不进系统提示 | 输出头加 `as of <epoch> (<age>)`；epoch 变标 stale；schema ≤400 字符（v4 §4） |
| 记忆（L2） | 自主捕获 + 中文 bigram 检索 + supersede | recall 头带 epoch + 每条 ≤5 条的 `sourceMissing/sourceChanged` 标记；**不因陈旧而删** |
| goal/todo（宿主） | 模型可用 | 只读消费事件；不写 |
| `omb_status` | 唯一诊断入口 | 新增状态段（≤300 字符）：当前 state、epoch、gap、open goals、deny/allow 计数、degraded 原因 |

**工具面**：**不新增工具**（v4 目标 ≤600 token/请求）。所有能力通过事件 + `omb_status` 参数暴露；若必须暴露查询，用 `omb_status(scope:'state')`。

---

## 11. 统一收益目标与逐机制预算（VOC）

### 11.1 公式与参数

`U(m) = P_hit·C_err − (C_tok + C_lat + C_att + C_cache)`；数据来源：§2 实测频率 + R5 价格（cache hit $0.003–0.006/M，output $0.6–1.2/M）。

### 11.2 逐机制预算表

| 机制 | P_hit 依据（实测/报告） | C_err（量级） | C_tok | C_lat | C_cache | 裁决 |
| --- | --- | --- | --- | --- | --- | --- |
| M1 写守卫（stale edit deny） | 盲写既有 1,528 + 陈旧 357 / 5,777 写（根会话） | 错改 1–3 回合 ≈ 3–15k output token | 0（工具前置，不进模型上下文） | 1 次 stat ≈ 0.1ms | 0 | **保留（默认 warn-only 起步，14 天后评估 deny）** |
| M2 恢复行（长间隔/中断） | >1h 间隔 77；异常回合 29；多回合会话 54% 有长间隔 | 重复探索/改错 1–2 回合 | 120 字符 ≈ 33 token，仅变化时 | 0 | 0（尾部快照） | **保留** |
| M3 目标台账 | 未闭合目标数未知（需在 P4 测）；goal 56/todo 85 事件 | 丢失目标 → 用户重复说明 | 0（除状态行） | 落盘 ≈ 1ms/回合 | 0 | **保留（只读）** |
| M4 陈旧指针检查 | 记忆 71 行、项目库 14 个；路径失效频率未测 | 基于已删文件作答 | 0（recall 内） | ≤5 次 stat ≈ 1ms | 0 | **保留（只标不删）** |
| M5 写后覆盖校验 | 未知 | 静默覆盖 | 0 | 1 次 stat | 0 | **保留** |
| M6 宿主 `workspace/changes` | 已实测 520 事件/27 会话；`snapshot.before/after` 是现成 tree id | — | 0 | 宿主的 per-turn git 开销（已在付） | 0 | **首选数据源**；服务可读性需 P0 探针，覆盖不到时回退 M0 自算 |
| M7 后台 watcher | — | — | — | 持续句柄 | — | **不做** |

### 11.3 Kill criteria（任一触发即回滚/关闭）

| 机制 | 判死条件（可测） |
| --- | --- |
| M1 守卫 | ① deny 率 >5%/写；② 同路径同回合 ≥2 次 deny 出现 >0.1%；③ 20 会话审计出现 1 例"文件未变却 deny"（误报零容忍）→ 立即 warn-only |
| M2 恢复行 | 20 个 gap>1h 的会话里，注入后 3 step 内"重读关键文件/查询状态"比例 <20%，且用户纠正率不变 → 保留但不再扩展字段；若 120 字带来的 token 占比 >0.5% → 压缩 |
| M3 目标台账 | 20 会话人工判读：目标数/状态准确率 <70%，或"已关闭却仍显示" >2 例 → 删台账，只透传宿主 goal/todo |
| M4 指针检查 | 审计 20 条 recall：`sourceMissing` 误报 >1 例 → 改为只标"未校验" |
| 状态行总体 | `contextBreakdown.messageTokens` 中 OMB 状态行占比 >0.5%，或 20 会话 A/B 工具调用数无下降 → 降到"仅长间隔/中断"两类 |

---

## 12. 验收测试（可在无模型调用的测试夹具里跑）

| # | 名称 | 夹具 | 断言 |
| --- | --- | --- | --- |
| AT-1 | 外部改动拦截 | 读 a.ts → 外部改 a.ts → edit a.ts | pre-execute deny；reason ≤120 字且不含"必须/请"；文件未被改 |
| AT-2 | 逃生门 | 连续 3 次同路径 edit（不重读） | 前 2 次 deny，第 3 次放行并记 `guard-gave-up`；无死锁 |
| AT-3 | 重读后放行 | deny 后 read 同一路径 → edit | 放行；stamp 更新；deny 计数清零 |
| AT-4 | 长间隔恢复 | 伪造 `lastEventAt = now-26h` + epoch 变 + 2 个 open goal → turn/start | 恰好 1 行、≤120 字、含 gap/epoch/目标计数；第 2 个 step 不再注入 |
| AT-5 | 无变化静默 | 10 个 step，epoch 不变、无目标、gap 小 | 注入 0 字节（runtime-context 快照数不增） |
| AT-6 | 目标自动关闭 | user 消息 + `pwsh: npx vitest run` exit 0 + todo completed | 目标 closed 且带证据；全程 0 次 llm 调用（断言 meter） |
| AT-7 | 中断恢复 | turn/end reason=aborted@step12 → 下一 turn | 注入含 `上次回合中断@12`；目标 state=paused（不是 closed） |
| AT-8 | 陈旧指针 | 记忆条目 sourceRef 指向不存在文件 → recall | 输出含 `sourceMissing`；条目仍在库中 |
| AT-9 | 非 git 仓 | cwd 无 `.git` | state=degraded；行含"无 git"；不抛错；git 调用 0 |
| AT-10 | 有界性 | 1,000 个假会话 / 200 条目标 / 200 个 stamp | 状态目录 ≤ 设定大小；sessions ≤100；单文件 ≤64KB；解析失败可回退空状态 |
| AT-11 | 摘要去重 | 同一事实连续 5 个 step | 只提交 1 次快照（断言 `runtime-context` append 次数） |
| AT-12 | 守卫自身失败 | stat 抛错 / 状态文件损坏 | 一律 allow + degraded；无异常冒泡 |

---

## 13. 不做清单（有证据）

1. **不做常驻 watcher / timer（默认）**：宿主有 `ctx.fs.watch`，但常驻 watcher 带句柄与平台代价（DSH 自己的 HMR 测试为避免 Windows `fs.watch` 队列压力改用 polling，`boot/hmr/tests/watch-config.spec.ts:129`）；仅当 P0 探针证明 `fs` 服务可达且 ≤8 文件、dispose 干净时才启用。**不做 timer**：间隔在 `turn/start` 惰性计算。
2. **不做文件影子副本 / checkpoint 回滚**：Claude Code 的 checkpoint 明确只覆盖自家编辑工具，bash/外部/子代理都不跟踪 [报告](https://code.claude.com/docs/en/checkpointing)；做半套回滚比不做更危险。
3. **不做自动 commit / stash / 提交**：不可逆且越权；Aider 的"先提交脏文件"仅在其工具域内成立 [报告](https://aider.chat/docs/git.html)。
4. **不对 shell 做硬拦或语义解析**：16,493 次 `pwsh`，读/写不可归因；只做低置信标记。
5. **不用 LLM 判"目标是否完成/是否陈旧"**：自判不可靠（Self-Verification Cliff）+ 热路径零 LLM。
6. **不发命令式状态提示**（"你必须重读/不要覆盖"）：指令稀释（IFScale 500 条 68%）+ R5 结论；只发事实。
7. **不把状态写进系统提示**：DSH 运行时上下文是尾部快照；系统提示放状态会破坏跨会话前缀稳定性（v4 §1 已纠正）。
8. **不跟踪全仓库/不每步 git status**：turn 边界一次 L1；热集 ≤64；超时即降级。
9. **不在 AGENTS.md 里写易变状态**：会自我触发"文件变化"，且人写文档不能逐回合变。
10. **不新增工具**：状态能力走 `omb_status(scope:'state')` 与事件行（v4 §4 目标 ≤600 token/请求）。
11. **不把 `workspace/changes` 当唯一真源**：它只在 turn 结束公告，覆盖回合内要靠守卫；本机只覆盖 27/394 会话，且服务是否能在根 realm 读到需 P0 探针；shell 副作用它也看不见。
12. **不因为"用户没说话"就假定目标关闭**：paused 而非 closed。

---

## 14. 未核实 / 需要探针

| # | 问题 | 探针 | 判死 |
| --- | --- | --- | --- |
| P1 | 真实"外部改动"频率 | 在状态机里记账 7 天：`unexplained` 路径数/回合 | 若 0 次/周 → M1 降为 warn-only |
| P2 | 守卫 deny 的实际行为改变 | 20 会话 A/B：编辑后 3 step 内是否重读 | 无差别 → 只保留恢复行 |
| P3 | 目标台账准确率 | 20 会话人工判读 open/closed | <70% → 删台账 |
| P4 | 状态行是否抑制了"重复探索" | 统计长间隔后首 5 步的重复读/重复 grep | 无下降 → 保留但不再加字段 |
| P5 | 记忆指针陈旧率 | 对 71 条记忆的 sourceRef 做 stat | <5% 失效 → M4 降为"仅 recall 时提示" |
| P6 | 宿主 `workspaceChanges` 服务可读性与覆盖面 | 5 行探针：`ctx.get('workspaceChanges')` 是否非空；对 27 个有事件会话取 `summary(sid,seq)` 与 `snapshot.before/after`；统计为何 394 会话只有 27 个有事件 | 不可读/覆盖 <20% → epoch 自算为默认，宿主仅作交叉校验 |
| P0 | `ctx.fs` / `ctx.fs.watch` 是否在 OMB 根 realm 可达 | 探针：resolve 一个临时文件并 watch 1 秒后 abort；检查 dispose 后无监听器残留 | 不可达或 dispose 不干净 → 永不启用 watcher，只轮询 |
| P7 | `workspace/changes` 的 per-turn git 开销 | 在 3 个真实仓库分别跑 20 回合，测 `turn/end` 到事件出现的延迟 | >200ms/回合 → 不作为默认路径 |
| 未核实 | `turn/end.reason` 的完整取值域 | 只观测到 5 类；需在类型定义/日志里确认 | — |
| 未核实 | `workspace/changes` 是否计入 tools 前缀/缓存 | 文档未明说 | — |
| 未核实 | Windows 上 `mtimeMs` 精度与网络盘行为 | 需本机实测 FAT/NTFS 差异 | — |

---

## 15. 引用（URL / file:line）

**本机与源码**：`docs/v4-decision.md`｜`docs/research/2026-10-18-{memory,reasoning,context,dsh-capabilities}.md`｜`docs/research/2026-10-18-fundamental-reasoning-context-academic.md`（R5）｜`docs/research/2026-10-18-probe-followup.md`｜`dsh/session.ts:955-1068`（事件桥接）｜`packages/core/session/src/known-event-types.ts:22-85`（事件词汇）｜`packages/core/tools/src/index.ts:154`（pre-execute 契约）｜`packages/core/tools/tests/tools.spec.ts:746,1764`（deny）｜`packages/goal/goal/src/index.ts:613`（goal/change）｜`packages/todo/tool-todo/src/index.ts:199`（todo/write）｜`packages/session/working-directory/src/index.ts:143,191`（cwd 变化）｜`packages/core/agent-loop/src/agent.ts:428-440` + `runtime-context.ts:146-163`（尾部快照）｜`packages/deliverables/workspace-changes/src/index.ts:1-9,59-62,116-119` + `src/types.ts:79-107`（宿主改动摘要，未安装）。

**并发/生态**：[Claude Code checkpointing](https://code.claude.com/docs/en/checkpointing)｜[Claude Code tools reference](https://code.claude.com/docs/en/tools-reference)｜[issue #33856](https://github.com/anthropics/claude-code/issues/33856)｜[issue #62336](https://github.com/anthropics/claude-code/issues/62336)｜[Cursor fast apply](https://cursor.com/blog/instant-apply)｜[Aider git integration](https://aider.chat/docs/git.html)｜[OpenHands events](https://docs.openhands.dev/sdk/arch/events)｜[OpenHands paper](https://arxiv.org/abs/2407.16741)｜[Codex approvals & security](https://learn.chatgpt.com/docs/agent-approvals-security)｜[VS Code "file is newer"](https://stackoverflow.com/questions/79322283)｜[vscode.d.ts watcher note](https://raw.githubusercontent.com/microsoft/vscode/main/src/vscode-dts/vscode.d.ts)｜[git-update-index](https://git-scm.com/docs/git-update-index)｜[OCC (Kung & Robinson 1981)](https://doi.org/10.1145/319566.319567)｜[Version vectors (Parker et al. 1983)](https://doi.org/10.1109/TSE.1983.236733)｜[Temporal + LangGraph durable execution](https://temporal.io/blog/temporal-langgraph-plugin-durable-execution)

**时间/陈旧/收益**：[FreshLLMs 2310.03214](https://arxiv.org/abs/2310.03214)｜[context rot](https://www.trychroma.com/research/context-rot)｜[lost-in-the-middle 2307.03172](https://arxiv.org/abs/2307.03172)｜[RULER 2404.06654](https://arxiv.org/abs/2404.06654)｜[IFScale 2507.11538](https://arxiv.org/abs/2507.11538)｜[Self-Verification Cliff](https://icml.cc/virtual/2026/82529)｜[ACE 2510.04618](https://arxiv.org/abs/2510.04618)｜[ReasoningBank 2509.25140](https://arxiv.org/abs/2509.25140)｜[Dynamic Cheatsheet 2504.07952](https://arxiv.org/abs/2504.07952)｜[AGENTS.md 实证 2602.11988](https://arxiv.org/abs/2602.11988)｜[Metareasoning (Russell & Wefald 1991)](https://doi.org/10.1016/0004-3702(91)90015-C)｜[DeepSeek 缓存](https://api-docs.deepseek.com/guides/kv_cache)｜[DeepSeek 价格](https://api-docs.deepseek.com/quick_start/pricing)

---

### 交付回报

- 唯一写盘：本文件；未改代码/git/profile。
- 本文件给的是**可施工规格**（状态/事件/转移/持久化/守卫/状态行/验收/判死），不是提案散文；实现时每个机制一个 config 开关，按 §11.3 判死。
