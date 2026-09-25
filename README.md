# Oh-My-BigBlueFish (OMB v3)

DSH 的**通用认知增强插件**：让模型想得更准、记得更久、上下文更省。

不是编程专用——生活、情感陪伴、闲聊、一次性提问同样适用。三个组件都按"通用"
设计，没有任何一个依赖代码库、任务类型或领域词汇。

## 三个组件

| 组件 | 做什么 | 关掉会怎样 |
| --- | --- | --- |
| **思维链质量** | 八张方法卡（`omb_method` 按需拉）、循环检测、三档推理深度（`omb_focus`） | 模型仍能答，但思考长度失控与反复绕圈不会被提示 |
| **记忆库** | 双库长期记忆、逐字召回（`omb_recall`）、多跳关联（`omb_relate`）、写入准入（`omb_remember`）、硬删除（`omb_forget`） | 每轮从零开始，跨会话经验丢失 |
| **上下文优化** | 软压力档位、拉取式上下文、拉取台账与杀死判据 | 上下文只增不减 |

另有三个小件：**制品索引**（`omb_files`，只记路径不注入）、**用户画像**（显式偏好，
冲突只呈现不裁决）、**桌面通知**（可选，宿主装了才生效）。

### 设计上的几个取舍

- **没有每回合 token 上限**：只有软压力档位（宽松 <0.3 / 适中 0.3–0.6 / 紧张 ≥0.6）。
  档位切换**行为**，不丢内容；被推迟的内容随时可按需取回。
- **拉取式优先**：常驻提示只有一句（当前约 70 字符，承"先判断这个问题值多少思考"
  这一动作，上限 120），其余全部按需拉取。默认不往上下文里塞东西。
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

构建脚本还会做**陈旧检测**：产物比源码旧就报错，不让"改了源码忘了重建"混过去。

### 开发循环

```bash
pnpm verify          # typecheck + lint + test
node scripts/build.mjs
node scripts/check-resolution.mjs   # 8 行可解析、可加载、有中文名（不碰 profile）
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
pnpm verify      # 上面三件一起
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

**权重不进仓库**。未装权重时向量通道**诚实降级**为纯 JS 哈希词袋，
纯词法召回完整可用，状态面写明原因。

推理运行时 `onnxruntime-node` 是 **optionalDependency**（解包约 296MB），
只想用哈希词袋的部署不必装。

## 边界

- 认知层**只观察与注入，不接管 Agent Loop**：不写会话日志、不阻断工具调用。
- 所有 `apply` 与 disposer **绝不抛异常**——抛异常会让整个插件行加载失败。
- 不注册任何在 `apply` 返回后才出现的工具或提示段（宿主挂载审计只查一次）。
- 不猜路径：取不到会话 cwd 时如实报"宿主尚未告知"，而不是猜一个可能写错地方的路径。

## 许可证

**GPL-3.0**，详见 [LICENSE](LICENSE)。第三方文件与运行期依赖的许可归属见
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
