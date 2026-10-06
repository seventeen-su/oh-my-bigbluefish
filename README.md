# Oh-My-BigBlueFish (OMB v3)

DSH 的**通用认知增强插件**：让模型想得更准、记得更久、上下文更省。

不是编程专用——生活、情感陪伴、闲聊、一次性提问同样适用。三个组件都按"通用"
设计，没有任何一个依赖代码库、任务类型或领域词汇。

## 三个组件

| 组件 | 做什么 | 关掉会怎样 |
| --- | --- | --- |
| **思维链质量** | 八张方法卡（`omb_method` 按需拉）、循环检测、三档推理深度（`omb_focus`） | 模型仍能答，但思考长度失控与反复绕圈不会被提示 |
| **记忆库** | 双库长期记忆、逐字召回（`omb_recall`）、多跳关联（`omb_relate`）、写入准入（`omb_remember`）、硬删除（`omb_forget`）、**隐私闸门**（`/omb-privacy`：`read-only` / `sealed`，按会话生效、子代理继承） | 每轮从零开始，跨会话经验丢失；**隐私档位与 `/omb-privacy` 命令面也一起消失** |
| **上下文优化** | 软压力档位、拉取式上下文、拉取台账与杀死判据 | 上下文只增不减 |

另有三个小件：**制品索引**（`omb_files`，只记路径不注入）、**用户画像**（显式偏好，
冲突只呈现不裁决）、**桌面通知**（可选，宿主装了才生效）。

### 设计上的几个取舍

- **没有每回合 token 上限**：只有软压力档位（宽松 <0.3 / 适中 0.3–0.6 / 紧张 ≥0.6）。
  档位切换**行为**，不丢内容；被推迟的内容随时可按需取回。
- **拉取式优先**：常驻提示只有一句（**实测 104 字符**，承"先判断这个问题需要多少推理"
  这一动作，上限 120），其余全部按需拉取。默认不往上下文里塞东西。
  这个数字**以状态面为准**：`omb_status` 的「常驻提示预算」段报的是运行时**实际选中**的那条
  （`residentHint()` 有多个变体，最长 104、最短 26；本行此前写的"82"是过期值）。
  **规则卡全文只在 deep 档注入**，且"到底注入了没有"是可核验的：
  `omb_status` 的组件自述会写「上次注入：成功（R3/R4/R5，N 字符）」或
  「只给了指令未含卡片」——**回执不承诺结果，只报实际发生了什么**。
- **记忆逐字返回**：不做有损抽取。逐字原文 + 溯源（`sourceRef` + 时间）比摘要更可靠，
  也便于判断证据新旧。
- **写入有准入**：用户明确说过的原话、可由具体工件复现的事实、被执行结果确认过的结论
  才写。模糊印象与推测会被拒绝并给出原因，弃权率记入状态面。
- **冲突只呈现**：发现两个来源矛盾时不替你选择，把两条都摆出来。
- **一切降级都可见**：没有静默失效。`omb_status` 随时告诉你哪个组件降级、为什么。

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
| 项目库（随 cwd） | `<cwd>/.omb/memory/session.db` |
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

- **不接管 Agent Loop**：不代替宿主决定回合推进、**不阻断工具调用**、不在 `apply` 返回后注册工具或提示段
  （宿主挂载审计只查一次）。
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
