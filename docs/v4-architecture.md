# OMB v4：一个可拼装、但设计为一起使用的通用外挂层

> 本文回答结构问题：组件不是"各自有机制、彼此关联"，而是**同一层的五个共享契约**。
> 证据与裁决见 `docs/v4-decision.md`、`docs/research/2026-10-18-*.md`（11 份）。

## 1. 一句话

OMB 是 DSH 上的**一个**通用认知外挂层：用**共享状态**（世界 epoch / 会话状态 / 项目画像）、
**共享知识**（记忆 + 反馈 + 图）、**共享过程**（skills）、**共享裁决**（状态面 + 收益目标）
把"记事、理解项目、按需推理"合成一条链路。每个模块可单独关，但**关掉任何一个都不改变其余模块的契约**。

v4.1 在此之上加**一套共享坐标**：项目身份（git root）、资源级内容哈希（读集对账）、
`omb_project` 的 L0–L5 六层快照。它不新增工具，只让四个组件回答同一个"我在哪、离上次多久、什么变了"。
详见 §8。

## 2. 六个共享契约

| 契约 | 服务名 | 提供者 | 消费者 | 作用 |
| --- | --- | --- | --- | --- |
| **项目身份**（v4.1） | `omb:project-root` | `dsh/project-root.ts` | 记忆库、项目画像、`omb_project` | `git rev-parse --show-toplevel` 解析**项目根**；同步、2.5s 超时、缓存 128、失败退化为 cwd、绝不抛 |
| **会话/工作区状态** | `omb:session-state` | `dsh/state-machine.ts` | 记忆、项目画像、推理、状态面 | epoch（HEAD/脏集/热文件 stamp）、idle 分级、外部改动、读取戳（**内容哈希**）、目标/待办计数；v4.1 加 `situation()`（L2/L3 结构化事实） |
| **会话见证** | `omb:session-witness` | `dsh/session.ts` | 记忆写入准入 | 最近用户原话、真实执行台账、压缩代际 |
| **项目画像** | `omb:project-profile` | `dsh/project-profile.ts` | `omb_project`、记忆 | 栈/命令/目录/README/git 头；v4.1 在**项目根**构建，附 `root/cwdRel/identity/structure/history/gates` 结构化字段（文本 ≤1400 字符） |
| **记忆与反馈** | `stores` + `memory_utility`/`memory_feedback` | `omb-memory` | recall/relate/project/status | 逐字结论、边、效用账本、可逆归档、审计；v4.1 按项目根取库（`projectRootOf`） |
| **过程库** | `skills/omb-r*` + `reasoning:loop` | `skills/` + `omb-reasoning` | 模型（按需） | 8 张过程卡按需加载；循环/无进展只在真信号时注入一行 |

只有 `dsh/` 能接触宿主；模块之间不互相 import，只认这些结构化契约（ESLint 强制）。

## 3. 数据流（一次会话）

```
宿主会话事件
  → dsh/session.ts  ── user/message / tool/call / tool/result / compaction 事件
  → dsh/state-machine.ts（epoch、idle、read stamps、goal/todo）
  → kernel 服务/事件
      ├─ omb-memory：capture（自主记事实）+ 召回（中文 FTS + 图扩展）+ feedback 效用
      ├─ omb_project：读项目画像 + 项目结论（按需，不占常驻）
      ├─ omb-reasoning：仅在循环/无进展时注入一行；过程卡由 skills 按需加载
      └─ omb_status：状态/成本/收益读数（唯一诊断入口）
```

模型面只有三类文本：**工具描述**（每请求）、**skills 目录**（会话级）、**事件驱动的一行状态/循环提示**（真变化时）。
没有逐回合压力/摘要注入，没有第二个常驻提示。

## 4. 组合方式（可拼装）

| 组合 | 打开的模块 | 能力 |
| --- | --- | --- |
| 最小 | kernel + memory + status | 跨会话记忆、自主捕获、项目结论（`omb_project` 降级为记忆） |
| 标准 | + artifact/notify/profile | 制品索引、通知、显式偏好 |
| 完整 | + state + skills + `/omb-depth` | 工作区对账、长间隔恢复、过程卡、真实 effort |
| 团队 | 以上 + DSH agent-team/subagent | 探索隔离、并行复核（OMB 不重复实现） |

每行在 `cordis.patch.yml` 独立可拨；`kernel/abi/catalog.ts` 的 `requires` 只决定依赖门，不决定真实启动顺序。

## 5. 统一收益目标（VOC）

每个机制 m 只在下面不等式成立时保留：

```
P_hit(m) × C_err(m)  >  C_tok(m) + C_lat(m) + C_att(m) + C_cache(m)
```

- `C_tok`：每请求字符成本（输入侧缓存价 ≈1/50，几乎可忽略；注意力是主项）。
- `C_cache`：是否动稳定前缀（本设计全部走尾部快照或按需文件 = 0）。
- `C_err`：漏掉时的返工（错改文件 ≈1–3 回合；状态行 120 字符 ≈33 token，差两个数量级）。
- 每个机制在 `docs/v4-decision.md` 有验收与 kill 判据；**没有独立证据的机制默认关闭**。

## 6. 自由目标跟踪与并发编辑（状态机，R10）

- 每次 `turn/start` 惰性对账：`HEAD/branch`、脏文件摘要、热文件 stamp、上次读取步号、`goal/todo` 快照。
- **写守卫（v4.1）= 资源级内容哈希**：读取时固化文件 `sha256` 前 16 位（≤2MB）；`edit`/`write` 写前比较
  当前内容哈希，读到后被外部改 → `deny`（≤120 字符事实句）；同路径同回合第 3 次放行并计 `gaveUps`
  （逃生门）；成功后 `post-execute` 刷新自身印记（自己的写不误伤自己）；`writeIntent` 按回合清空。
- 分级：`active` <5min；`idle` >5min；`stale` >1h；`deep-stale` >24h。
- 外部改动（用户/IDE/其他进程）只产生**一行事实**（≤120 字符），不阻塞、不回滚、不要求重读；
  模型自行决定是否重读。正常时注入 0 字节。
- 目标来源：宿主 `goal/change`、`todo/write`、`turn/end.reason`；**不用 LLM 判完成**。
- 与 `AGENTS.md`/项目画像：epoch 变化 → `omb_project` 刷新；陈旧指针在召回里标注来源时间。

## 7. 新增组件的规则（防止回到"各做一套"）

1. 先问：它需要哪个共享契约？没有契约就先加契约，不要新建第二份状态表。
2. 模型面成本必须写清：工具 schema 字符、常驻字符、每会话一次性字符；没有按需路径的不加。
3. 接线必须有生产消费者与一条会失败的测试；"已注册"不算生效。
4. 状态面必须能报出它的读数与降级原因；不能自报"正常"而实际零调用。
5. 任何新机制都进 VOC 表，附验收/杀判据；一轮后无证据即删除。

## 8. v4.1：时空坐标（Spacetime）分层

> 契约：`docs/v4.1-spacetime.md`。实现：`dsh/project-root.ts`、`dsh/project-profile.ts`、
> `dsh/state-machine.ts`、`modules/memory/{project,index,store,capture}.ts`。
> 一句话：**不新增工具，只让四个组件共享同一套坐标**——一次 `omb_project` 给出 L0–L5，状态行只给增量。

### 8.1 为什么（v4.0 的四个组件各答半句）

| 组件 | v4.0 能回答 | 答不了 |
| --- | --- | --- |
| 项目画像 | "仓库有什么" | "这个会话现在在哪、离上次过了多久" |
| 状态机 | "epoch 变了、读印记旧了" | "这个仓库是什么、值不值得看" |
| 记忆库 | "以前记过什么" | 项目身份按 cwd 切分，子目录会话另起一个库 |
| 自主捕获 | "调用过什么工具" | `tool/call` 时写"编辑文件：x"——**尝试过**被记成**完成过** |

### 8.2 三维定义

| 轴 | 含义 | 事实来源 |
| --- | --- | --- |
| **空间** | 项目根 → 目录 → 文件 → 资源版本 | `projectRoot` / `projectProfile` / 读取印记的 `hash` |
| **时间** | 提交历史 → 工作区 epoch → 回合/步 → 空闲间隔 → 记忆 `observedAt/validTo` | `state-machine` / git / 记忆库 |
| **状态** | 读印记、写意图、外部改动、目标待办、记忆关联边 | `state-machine` / `link` 图 |

### 8.3 六层输出（`omb_project`，总长 ≤2,400 字符）

| 层 | 内容 | 缺失时 |
| --- | --- | --- |
| **L0 身份** | name/version、git root、cwd 相对根、branch/head/headAt | 写"非 git/未接线" |
| **L1 结构** | 顶层目录、源码目录（文件数/行数/测试数）、入口、docs 标题、构建命令 | 写"画像不可用（不是空）" |
| **L2 空间状态** | epoch id、脏文件数、外部改动数、读取印记（已变化/无法核验）、守卫计数 | 写"状态未知" |
| **L3 时间** | 回合/步、空闲档位与间隔、上次回合结束原因、是否中断 | 写"无会话归属" |
| **L4 知识** | 项目记忆 top 3（时间/类型/摘要）、项目记忆近况、关联边数量 | 写"暂无记忆" |
| **L5 意图** | 开放目标/待办、未解决标记 | 写 0（真的 0，不是未知） |

渲染顺序固定、每层一行标题；同一输入产出同一文本（记忆/状态变化除外）。超限按固定顺序压缩各层正文。

### 8.4 服务与组合点

| 服务 | 形状要点 | 降级 |
| --- | --- | --- |
| `omb:project-root`（新） | `resolve(cwd): string`；`git rev-parse --show-toplevel`；同步 2.5s；缓存 TTL 60s/128；非 git→cwd | 绝不抛，失败退化为 cwd |
| `omb:project-profile`（升级） | `text ≤1400` + `generatedAt/gitHead/root/cwdRel/identity/structure/history/gates`；在**项目根**构建；扫描 ≤2,000 文件，跳过依赖/生成物 | 单段失败只丢该段 |
| `omb:session-state`（升级） | 既有 epoch/idle/goal/todo + **`situation(sessionId)`**：`state/tier/turn/step/idleMs/lastTurnEndReason/interrupted/unresolved/goals/todos/epoch/reads{count,changed,unknown,entries≤16}/sideEffects{blindWrites,staleWrites,denies,gaveUps,unverifiable}` | 只读、同步、绝不抛；缺会话→`undefined` |

**组合点 `omb_project`**：`createProjectTool` 通过可选依赖注入 `situation` / `privacyAllowsRead` / `projectRoot`
（全缺省则降级）。读取顺序固定：**隐私先于读取** → 无会话归属只给画像 → 画像 + 记忆 + L2/L3/L5。
`sealed`（或隐私判定抛错）不读画像、不读记忆，返回一句可读原因。

### 8.5 数据流

```
                    ┌──────────── dsh/project-root.ts ────────────┐
 cwd ──────────────▶│ git rev-parse --show-toplevel → root (缓存)  │──▶ 记忆库 projectRootOf
                    └─────────────────────────────────────────────┘
                                            │
 宿主会话事件 ──▶ dsh/session.ts ──▶ dsh/state-machine.ts ──▶ situation() ─┐
                                            │                    │         │
                   dsh/project-profile.ts ◀─┘                    │         │
                   （在 root 构建，cwdRel 保留"我在哪"）           │         │
                                                                 ▼         ▼
                                                     modules/memory/project.ts
                                                     omb_project：L0 L1 L2 L3 L4 L5
                                                     隐私门控 → 画像 → 记忆 → 状态
```

- 模块层不碰文件系统/子进程：画像、根解析、`situation` 都在 `dsh/`；模块只消费结构化端口。
- 模型面成本：`omb_project` 按需调用，总长 ≤2,400 字符；状态行只在真变化时 ≤120 字符；常驻 0 增量。

### 8.6 v4.1 边界（不假装）

- **不做**符号级 repo-map（函数/类调用图）→ v4.2；
- **不做**三方合并/补丁生成：守卫只做"读后被改 → 拒绝并让模型重读"；
- **不做** shell 写文件追踪：`pwsh` 副作用仍是盲区，状态面如实计数；
- **不做**子代理写集并入与 `AGENTS.md` 指纹（契约 §8 明列）。
