# Oh-My-BigBlueFish (OMB v4.11.0)

DSH 的**通用认知增强插件**：让模型记得住、看得懂项目、按需思考，而不是每轮往上下文里塞提示。

不是编程专用——生活、情感陪伴、闲聊、一次性提问同样适用。v4 把它们组织成**一个可拼装、
但设计为一起使用的共享层**；v4.1 给四个组件加**同一套时空坐标**（项目身份 = git 根、资源级内容哈希、
`omb_project` 的 L0–L5 分层快照）；v4.2 把写可见性补到 shell、其他会话/子代理与规则文件；
v4.3 把内存增长点有界化并补跨模块导入图；v4.4 把版本号改为 **x1.x2.x3**（大版本 / 功能更新 / 修复），
并购入路径别名/文件级依赖/近似调用图、shell 推断写与冲突材料包；v4.5.3 修复依赖态、
heap 取证与捕获/守卫；v4.6.0 提高**主动记忆**积极性、给记忆加**生命周期阶段**并把构建/测试运行证据接进项目地图；
v4.6.1 修正证据退出码语义、临时约束误记与并发持久化；v4.7.0 引入**事件驱动记忆控制器**
（确定性决策 + 执行：persist 走既有写入并查回验证、lookup 找旧条目给 supersedes 用法、
任务约束 TTL/回合双过期；`dry-run`/`off` 为回滚档）；v4.8.0 补上**候选确认命令**
`/omb-confirm` 与**跨写入路径同内容去重**；v4.8.1 是该功能的收尾（x3 修复位）：
**确认撤销与审计**（schema v5、`/omb-confirm undo/log`、批量撤销、候选年龄）；
v4.9.0 新增独立能力**写入冲突提示**（回执给出共享实体键的既有条目，只提示不自动处理）；
v4.9.1 是它的语义通道收尾（x3）：有嵌入器时补充没有共享实体键的条目，回执标注判据来源；
v4.9.2 补上**检索命中排名读数**（使用命中时的 @1/@3/@5 分布）；
v4.9.3 给项目证据加**文件映射**（命令里提到的文件随证据落盘并在 L1 显示）；
v4.9.4 补上**workspace 包导出映射**并完成**剩余项收口**（类型图/三方合并为设计不变量、
OOM 为外部依赖、selfProtection 为用户设置）；
v4.9.5 精简四个用户命令的简介、把 8 张过程卡标成**用户不可见**（不再出现在 `/` 菜单）；
v4.9.6 补齐 `/omb-depth` 与 `/omb-heap` 的简介，六个命令文案统一；
v4.9.7 修复用户断言的模糊去重与压缩后追忆被拒（近似同内容、数字不同不合并）；
v4.10.0 给 `omb_recall` 加**状态/标签过滤与模糊回退**（schema v6 的 `memory.tags`）；
v4.10.1 **取消离线整合**，去重只发生在写入路径（确定性判据，不自动标失效）；
v4.11.0 加**活动日志**（写入/去重/升级/召回/错误）与 SIGKILL 崩溃窗口验证。详见
[`docs/v4-architecture.md`](docs/v4-architecture.md)、
[`docs/v4.1-spacetime.md`](docs/v4.1-spacetime.md)、
[`docs/v4.2-gap-closure.md`](docs/v4.2-gap-closure.md)、
[`docs/v4.3-bounded-and-imports.md`](docs/v4.3-bounded-and-imports.md)、
[`docs/v4.4-versioning-alias-and-oom.md`](docs/v4.4-versioning-alias-and-oom.md)、
[`docs/v4.5.3-review-fixes.md`](docs/v4.5.3-review-fixes.md)、
[`docs/v4.6.0-proactive-memory-and-evidence.md`](docs/v4.6.0-proactive-memory-and-evidence.md)、
[`docs/v4.6.1-review-fixes.md`](docs/v4.6.1-review-fixes.md)、
[`docs/v4.7.0-memory-controller.md`](docs/v4.7.0-memory-controller.md)、
[`docs/v4.8.0-lifecycle-confirm-and-dedupe.md`](docs/v4.8.0-lifecycle-confirm-and-dedupe.md)、
[`docs/v4.8.1-confirm-undo-and-audit.md`](docs/v4.8.1-confirm-undo-and-audit.md)、
[`docs/v4.9.0-conflict-hints.md`](docs/v4.9.0-conflict-hints.md)、
[`docs/v4.9.2-retrieval-precision.md`](docs/v4.9.2-retrieval-precision.md)、
[`docs/v4.9.3-evidence-file-mapping.md`](docs/v4.9.3-evidence-file-mapping.md)、
[`docs/v4.9.4-import-graph-package-exports.md`](docs/v4.9.4-import-graph-package-exports.md)、
[`docs/v4.9.5-naming-cleanup.md`](docs/v4.9.5-naming-cleanup.md)、
[`docs/v4.9.6-depth-heap-descriptions.md`](docs/v4.9.6-depth-heap-descriptions.md)、
[`docs/v4.9.7-fuzzy-dedupe.md`](docs/v4.9.7-fuzzy-dedupe.md)、
[`docs/v4.10.0-retrieval-filters.md`](docs/v4.10.0-retrieval-filters.md)、
[`docs/v4.10.1-write-time-dedupe.md`](docs/v4.10.1-write-time-dedupe.md)、
[`docs/v4.11.0-activity-log-and-crash-tests.md`](docs/v4.11.0-activity-log-and-crash-tests.md) 与
[`docs/v4-remaining-closure.md`](docs/v4-remaining-closure.md)。

> 版本规则：`x1.x2.x3`（大版本 / 功能更新 / 修复）。单一真源 `version-manifest.json`，
> 生成器 `scripts/version.mjs`；当前 **24 功能 / 97 小功能 → 4.11.0**。

## v4.4 结构（2026-10）

| 层 | 做什么 | 模型面成本 |
| --- | --- | --- |
| **记忆库（核心）** | 双库长期记忆、逐字召回、**自主捕获**（偏好/决定 + 项目活动 + 会话结果，确定性零 LLM；v4.1 起按 `tool/result` 生命周期写，失败写"未生效"）、多跳关联 + 自动连边、反馈效用（`/omb-feedback`）、隐私闸门（`/omb-privacy`）；v4.3 起会话/失败/索引缓存全部有界 | 只有工具描述；召回按需 |
| **项目层** | `omb_project` 读 **L0–L5 分层时空快照**（身份/结构/空间状态/时间/知识/意图，≤2,400 字符）：git 根身份、画像（含符号与跨模块导入摘要）、读取印记与外部改动、回合/空闲、项目记忆 top 3、开放目标；仓库根 `AGENTS.md` 由宿主自动加载 | 按需；不占常驻 |
| **状态层** | `omb:session-state`：工作区 epoch（含 `AGENTS.md`/`CLAUDE.md` 指纹）、空闲分级、外部改动、读取戳（**内容哈希**）、shell 写路径、跨会话写、目标/待办；**edit+write 写守卫**（读后被外部改 → 拒绝；覆盖既有文件且无读取印记默认也拒绝，v4.5.3），连续拒绝后须重读才放行；仅在真实变化时注入一行 ≤120 字符 | 正常 0 字节 |
| **过程层** | 8 张过程卡在 `skills/omb-*`（`user-invocable: false`，不出现在用户命令菜单），模型按需加载；循环/无进展才注入一行 | 技能目录会话级 |
| **诊断层** | `omb_status`：压力/cache/压缩/工具调用/收益读数 + 状态机守卫计数（拒写/盲写/无法核验/shell/其他会话）+ **进程内存 rss/heap/uptime**，带来源与时间 | 仅人工/按需 |

v4.4 的关键变化（与 v4.3 的差别）：**版本号由 `version-manifest.json` 实际计算**
（`scripts/version.mjs`，当前 24 功能 / 82 小功能 → 4.6.0）、**导入图支持 tsconfig 别名 +
文件级边 + 近似调用边**、**shell 未知写按 git status 差分推断**、**守卫拒绝时写 base/current
冲突材料包**、**OOM 取证脚本与证据结论**。

v4.3 的关键变化（与 v4.2 的差别）：**无界增长点全部有界**（`turnBySession` 256 / `projectFailures` 32 /
artifact 索引 16 / reasoning 会话表 128）、**`## 进程` 内存读数**（OOM 趋势可见）、
**跨顶层目录相对导入图**（`structure.imports`，`omb_project` L1 摘要）。

v4.2 的关键变化：**指令文件指纹进 epoch**（规则变了会提示）、**shell 写路径可见**、
**子代理/跨会话写归因**（`otherSessionWrites`）、**符号级 repo-map**、**盲写策略可配置**。

v4.1 的关键变化（与 v4.0 的差别）：**项目身份 = git root**（子目录会话不再另起项目库）、
**守卫按文件内容哈希**（不是全局 epoch）、**捕获区分"尝试/完成/未生效"**、**`omb_project` 隐私先于读取**。

推理深度不再是提示词：`/omb-depth quick|deep` 由用户显式设置，`dsh/` 在请求头上映射
`reasoningEffort`（quick→low、deep→max、standard 继承）；provider 不支持时状态面写明未生效。

### 设计上的几个取舍

- **不再有逐回合压力/摘要注入**：宿主 `systemPrompt.context()` 是尾部快照，不是系统提示段；
  任何逐回合变化只会污染注意力。正常状态注入 0 字节。
- **规则卡不是工具**：8 张过程卡是 `skills/` 文件，由模型按需加载；`omb_method` 已删除；它们标了 `user-invocable: false`，不会出现在 `/` 命令菜单。
- **记忆逐字返回**：不做有损抽取。逐字原文 + 溯源（`sourceRef` + 时间）比摘要更可靠。
- **写入有准入**：用户原话/真实执行台账/工件核验才写；自主捕获只写可观测事实，密钥模式拒写。
- **冲突只呈现**：发现两个来源矛盾时不替你选择，把两条都摆出来。
- **一切降级都可见**：没有静默失效；`omb_status` 随时告诉你哪个组件降级、为什么。
- **收益目标**：机制只在 `P_hit×C_err > C_tok+C_lat+C_att+C_cache` 时保留；
  没有 A/B 证据的注入默认关闭（kill 判据见 `docs/v4-decision.md`）。

### 桌面通知的协议（对齐 dsh-desktop-notify 1.5.4）

宿主装了 [`dsh-desktop-notify`](https://github.com/Mvyvn/dsh-desktop-notify) 时，
OMB 通过它注册的 Cordis 服务 `desktopNotify` 推送。**载荷是对象**：

| 方法 | 行为 |
| --- | --- |
| `push({…})` | 走聚焦门控：只有"你正在看的那个会话"被静默 |
| `pushAlways({…})` | 绕过门控，始终推送 |
| `notify({…})` | 同上但返回明细 `{ ok, queued, silenced, reason }` |

| 字段 | 约束 |
| --- | --- |
| `title` | **必填**。为空时对方一律拒绝并返回 `false` |
| `message` | 上限 400 字符（标题 160），超出由对方截断且不切断代理对 |
| `urgency` | `'low' \| 'normal' \| 'critical'`，缺省 `normal` |
| `sessionId` | 可传会话对象/id/数组；**传了才按会话门控**，不传则始终推送 |
| `url` | 点击要打开的地址，只接受 http/https |

**返回值必须检查**：对方在标题为空、聚焦门控静默、1.5 秒同文案去重、或当前平台
没有通知后端时都返回 `false`。OMB 因此把 `false` 记为"被抑制"并写明原因——
早期实现不看返回值，于是"一条都没发出去"被记成"已发 N 条"，状态面在骗人。

OMB 自己另加三条抗噪约束（`modules/notify/bridge.ts`）：同类型 30 分钟一次、
同会话内同内容只发一次、单会话上限 10 条。会话门控交给对方，不重复实现。

当前推送的种类只有一个：**模块运行中失败**（`ok → failed` 的转变，默认关闭，
配置 `notifyModuleFailures: true` 开启）。启动期的健康结果不推送——管理页已经显示了。

## 安装

作为**插件包**安装（不是 Agent 预设；预设内不含任何 OMB 认知行，因此所有模式都能用）：

```
plugin_manager install_bundle <本仓库绝对路径>
```

装的是**包装配包**（`@omb/plugin`：一份 `cordis.patch.yml`），它把 8 个组件包
（`@omb/kernel`、`@omb/memory`、…）作为 workspace 依赖挂在**自己的** `node_modules` 下——
而这正是行名的解析落点（宿主从补丁文件所在目录起按 Node 规则向上找）。

因此有一条前提：**本仓库要先装过一次依赖**

```bash
pnpm install      # 建出 node_modules/@omb/<组件> → packages/<组件> 的链接
```

少了它，profile 里的 8 行会解析不到包（`failed to import`）。构建脚本会在
`node_modules/@omb/*` 缺席时打印提醒；`node scripts/check-resolution.mjs`
可以在不碰 profile 的前提下把这条路走一遍。

安装后 OMB 的行出现在 profile 根层，插件页可逐行开关，并显示中文组件名。

### 目录位置

| 数据 | 位置 |
| --- | --- |
| 用户库（跨项目） | `$DSH_HOME/.omb/memory/knowledge.db` |
| 项目库（随项目根） | `<git root>/.omb/memory/session.db`（v4.1 起按 git 根；非 git 目录退化为 cwd） |
| 构建代数 | `build-generation.json` |
| 产物 | `lib-gen/g<N>/`（不入库） |
| 组件包 | `packages/<组件>/`（`locale/` 入库，`lib-gen/` 不入库） |
| 诊断心跳 | `<本包根>/.omb-heartbeat.jsonl` —— **默认不产生**，见下 |

### 诊断心跳（默认关闭）

心跳是排查"模块到底有没有被装上/被调用"用的追加式日志。它**默认一行都不写**：
早期版本每回合都同步追加，实测 4.6 天涨到 19MB（单日 37,727 行），
而绝大多数部署从不需要它。

要开就设环境变量 `OMB_HEARTBEAT`（重启宿主后生效）：

| 值 | 行为 |
| --- | --- |
| 未设置 / `0` / `off` / `false` / `no` | **不写**——心跳是零 IO 的空操作（默认） |
| `1` / `on` / `true` / `yes` | 写 `<本包根>/.omb-heartbeat.jsonl` |
| 其它非空值 | 当成路径写（相对路径按本包根解析） |

开了也不会无限涨：单文件超过 **4MB** 轮转成 `.1`（只保留一份），磁盘占用硬上界 8MB；
轮转失败就停写，而不是回到"无上限追加"。**默认落点**已在 `.gitignore` 里
（改成自定义路径的话，忽略规则自负）。

## 构建

```bash
pnpm install
node scripts/build.mjs     # 或 pnpm build
```

**每次构建都会换代**（`lib-gen/g1` → `g2` → …），并把每个组件包的
`package.json` 的 `main`/`exports` 刷到本代：

```
packages/<组件>/lib-gen/g<N>/index.js   ← 生成的一层转发（URL 里带代数）
  ↓ export * / export { default }
lib-gen/g<N>/packages/<组件>/index.js   ← tsc 产物（实现都在仓库根的 lib-gen/g<N>/）
```

`cordis.patch.yml` 里**不出现代数号**（行名是裸包名 `@omb/<组件>`，见下节），
换代完全由上面这条链承担：URL 变 = 不会命中 Node 的 ESM 按 URL 缓存。
构建后需要**重新启用该行**（关掉再打开）才会加载新代号。

### 为什么必须换代

DSH 的**插件行**可以免重启动态增删，但**模块代码走 Node ESM 按 URL 缓存**。
改了源码而产物路径没变时，宿主加载的仍是**旧模块实例**——于是"功能没生效"
这类现象可能只是陈旧代码，极易误判。

构建脚本还会做**陈旧检测**（两条判据，都会让构建当场失败）：
① 源码目录下每个 `.ts` 都必须在产物里有同名 `.js`——`tsconfig` 的 include/exclude
漏了文件时，点名到具体文件（这类缺陷装到宿主后表现为"某个模块凭空消失"，
而构建本身是绿的）；
② 源码 mtime 晚于**本次构建开始时刻**——构建过程中还有人改源码，那份产物是旧快照。

### 开发循环

```bash
pnpm verify          # typecheck + lint + test + check-resolution
node scripts/build.mjs
node scripts/check-resolution.mjs   # 全部行名可解析/可加载、OMB 行有中文名（不碰 profile）
plugin_manager remove_bundle @omb/plugin && plugin_manager install_bundle <路径>
```

安装后 `omb_status` 的代数应等于 `build-generation.json` 里的值。不等就说明装的是旧代。

## 组件的中文显示名

插件页每一行的标题/说明来自 DSH 的本地化元数据：`readPluginMeta` 在
`barePackageName(specifier) === undefined` 时直接返回 undefined
（`packages/boot/app-boot/src/package-meta.ts:148`），只有**裸包名**才有元数据，
名字取自 `<包名>/locale/zh.json` 的 `meta.title`/`meta.description`。

而宿主加载器又要能**解析**行名。三种写法只有一种同时成立：

| 行名写法 | 能解析 | 有中文名 |
| --- | --- | --- |
| `./lib-gen/g<N>/modules/memory/index.js` | ✅ | ❌ 相对路径没有元数据，插件页显示 `file:///` 路径 |
| `@omb/plugin/omb-memory` | ❌ 实测 8 行 `failed to import` | ✅ |
| `@omb/memory`（**当前**） | ✅ | ✅ |

于是每个组件是一个**独立顶层包**（`packages/<组件>/`，`name: @omb/<组件>`），
中文名的唯一真源是 [`kernel/display.ts`](kernel/display.ts)：

```bash
node scripts/build.mjs    # 由 display.ts 生成 packages/<组件>/locale/{zh,en}.json
```

改文案只改 `kernel/display.ts`，不要在 locale 文件里手改——测试会核对两者逐字一致。

## 测试

```bash
pnpm test        # vitest
pnpm typecheck
pnpm lint
pnpm verify      # 上面三件 + check-resolution（行名解析是发布前必须过的一关）
node scripts/check-resolution.mjs   # 行名解析 + 中文名（不需要装进 profile）
```

测试里有两类**只有真宿主才会暴露**的契约，已固化：

- `tests/dsh/tools.test.ts`：工具注册要求 `output { schema, render }`，
  且参数 schema 必须是"只有可枚举字符串键的普通记录"。
  后者尤其隐蔽：`z.toJSONSchema()` 的返回对象带一个**非枚举**键 `~standard`，
  会让每个用 zod 生成的工具被宿主拒绝。
- `tests/dsh/assembly.smoke.test.ts`：用真实清单、真实内核装配，并让假宿主
  **复刻真宿主的校验**。假宿主不复刻校验，测试就会对"全被拒绝"保持全绿（踩过两次）。

另有一组**形状契约**（`tests/dsh/modules.test.ts`、`tests/kernel/abi.contract.test.ts`）
把「行名 = 裸包名 = `packages/<组件>` 的包名 = `kernel/display.ts` 的 `packageName`」
与「`main`/`exports` 指向当前代数」「locale 文案与 display.ts 逐字一致」钉在一起：
任一处漂移都会失败，而不是变成插件页上一串看不懂的路径。

## 神经向量检索（可选）

接入 BGE-small-zh-v1.5（ONNX，512 维）做中文语义检索：同义改写能召回哈希词袋
召不回的记忆。

**权重不进仓库**。未装权重时向量通道**降级**为纯 JS 哈希词袋。

> **降级路径不是语义通道，别当语义通道用。** 这一句是实测校正过的——
> 原先这里写"同义改写能召回哈希词袋召不回的记忆"，那句话只对**神经**通道成立。
> 实测五组对照（判据冻结在 `tests/modules/memory/vector-discrimination.test.ts`）：
>
> | 对照 | 余弦 |
> | --- | --- |
> | 同义改写 `这个函数太长了需要拆分` ↔ `这个方法篇幅过大应当分解` | ≈ **0.10** |
> | 无关 `这个函数太长了需要拆分` ↔ `今天天气不错适合散步` | 0.00 |
> | **语义相反但字面重合** `删除记忆` ↔ `添加记忆` | ≈ **0.33** |
>
> 它度量的是**哈希字符袋的重合度**：同义改写只比噪声高一点点，而反义词拿到最高分。
> 所以余弦下限取 0 是**正确的防御**（任何正阈值都会误杀同义改写），
> 代价是字面重合的相反内容也会进来。**这是降级路径的固有权衡，不是配置失误。**
> 要真正的语义召回，只能装权重。状态面会直接写出这段特征。

推理运行时 `onnxruntime-node` 是 **optionalDependency**（解包约 296MB），
只想用哈希词袋的部署不必装。

## 边界

边界分两层，**改动过的那一层要写清为什么改**（2026-10-06，用户拍板）：

**一、绝不越过的一层**

- **不接管 Agent Loop**：不代替宿主决定回合推进、不在 `apply` 返回后注册工具或提示段
  （宿主挂载审计只查一次）。**v4.1 例外（明示）**：写守卫在 `tools/pre-execute` 上对单次
  `edit`/`write` 返回 deny——**只在"读后内容哈希不符"或"覆盖既有文件但无可核验读取印记"时拒绝**
  （≤120 字符事实句）；连续 deny 到阈值后不再自动放行，须先重新读取（v4.5.3），
  不接管回合推进、不重试、不回滚、不修改历史；这是宿主明示的扩展缝，不是劫持。
  守卫的校验与宿主真正写入之间仍有非原子窗口，因此它**不能保证绝不覆盖**，只能缩小竞态。
- 所有 `apply` 与 disposer **绝不抛异常**——抛异常会让整个插件行加载失败。
- 不猜路径：取不到会话 cwd 时如实报"宿主尚未告知"，而不是猜一个可能写错地方的路径。

**二、改过的这一层：从"只观察与注入"改为"只通过宿主明示的扩展缝"**

早期版本写的是"**不写会话日志、不改会话历史**"。那是一条自缚规则，与"做一个上下文压缩组件"直接冲突——
压缩**按定义**就要替换会话内容。现在的规则是：

> **只通过宿主明示的扩展缝修改会话内容**（当前是 `toolResultPruner` 与 `compaction` 两个服务），
> **绝不劫持宿主内部**：不 monkey-patch 未声明的内部方法、不绕过宿主的阴影（shadow）与重放协议。

配套两条硬约束（都来自别人的真实事故，不是我们的洁癖）：

- **改完必须回读校验**：写进去的到底是不是原文，要立刻读回来核对
  （billion-context 的 issue #1340 就是把占位符当原文持久化了）；
- **省下的量必须能被独立核对**：不接受只由自己统计的"省了 N token"
  （同一项目的 issue #2193：面板报 netSaved 355.9M，而 1510 条锚点早已永久失配）。


## 许可证

**GPL-3.0**，详见 [LICENSE](LICENSE)。第三方文件与运行期依赖的许可归属见
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
