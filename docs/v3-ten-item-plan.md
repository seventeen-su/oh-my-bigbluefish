# OMB v3 十项改造计划与实测发现

本文是**施工前的侦察结论**。每条都标注了证据位置与"可做性"，**没有证据的推测不写进来**。

基线：OMB `3.1.0` / 产物 g59 / 工作提交 `226bca0`。
宿主：DSH `0.2.0-rc.2`（`<dsh-checkout>`）。

---

## 一、实测确认的缺陷（有证据）

### 1.1 `MODULE_CATALOG` 是"看起来权威但不驱动运行时"的文档

grep `kernel/*.ts`、`kernel/abi/*.ts`、`dsh/*.ts`、`scripts/*.mjs`：

| 符号 | 生产代码里的使用 |
| --- | --- |
| `enabledByDefault` | **零处**——只在 `catalog.ts` 自身的定义与 6 条数据里出现 |
| `MODULE_CATALOG` | `catalog.ts:38` 定义；`kernel/index.ts:62` re-export；`dsh/plugin.ts:205` **仅在注释里**；其余引用全在 `tests/` |

`CatalogEntry.enabledByDefault` 的注释写"默认是否启用（对应 `disabled` 的缺省值）"，**但它不驱动任何行为**。

**为什么这比"多真源"更坏**：多真源至少每处都在起作用；这里有一处**根本不起作用**，而测试在断言它，于是给人一种"被保证"的错觉。

**结论**：必须二选一——让它真正驱动运行时，或把它降级为文档并**从测试的"真源"位置上撤下来**。不允许保持中间态。

### 1.2 环依赖只阻断单个节点，且结果依赖遍历顺序

`kernel/registry.ts:43-70` 的 `planModules`：

```ts
const visit = (id, chain) => {
  if (done.has(id)) return
  if (visiting.has(id)) { blocked.push({ id, reason: `依赖成环：…` }); return }
  …
}
for (const id of byId.keys()) visit(id, [])   // ← 第 66 行
```

三个后果：

1. **环外依赖环内的模块照样启动**：`A ↔ B` 成环、`C requires A`，若 `byId` 插入顺序是 `C, A, B`，`visit(C)` 先把 C 推进 `ordered`。
2. **环内可能只阻断一个**：`visiting` 在递归返回后 `delete`，B 可能被正常 `done` → "A blocked / B started"。
3. **结果依赖输入顺序**——同一张图换个顺序结论就变。

**修法**：Tarjan SCC 或 DFS 三色标记，整环一起 blocked，并做**传递性阻断**。
**判据必须含"打乱输入顺序后 `blocked` 集合恒等"**——否则只修了恰好复现的那一种顺序。

### 1.3 `mount()` 的 disposer 不在内核注销集合里；异步 disposer 不被等待

`kernel/index.ts`：

| 位置 | 事实 |
| --- | --- |
| `:234-273` `mount()` | `:266` 把 `registration.apply()` 的返回值**直接 return 给宿主**，**不 push 进 `disposers`** |
| `:298-299` `start()` | 同样拿到 disposer，**会** push 进 `disposers`（两条路径不一致） |
| `:320-336` `dispose()` | `:325` `void disposer()` ——**返回 Promise 的 disposer 不被 await** |
| `:91` | `Kernel.dispose(): void` 签名同步，装不下异步语义 |

后果：`mount()` 的返回值若宿主没收回，**该 disposer 永不执行**；异步清理在 `dispose()` 返回后仍在跑。

**修法**：统一 owner；`mount()` 的 disposer 也进同一集合且**幂等**（宿主自己调过就不重复调）；新增 `disposeAsync(): Promise<void>` 等待全部完成、`allSettled` 语义、单个失败不阻断其余。同步 `dispose()` 保留但要把"不保证异步完成"写进类型与注释。

### 1.4 工具执行上下文里**有**会话身份，是 OMB 自己丢掉了

这一条推翻了项目里一个流传的判断（"拿不到会话所以只能用 lastActiveSession"）。

| 证据 | 位置 |
| --- | --- |
| `ToolRunContext` 上运行时**有** `agent` | `packages/core/tools/src/index.ts:1397` `const agent = exec.agent`；`:1410-1417` `...agent !== undefined ? { agent } : {}` |
| `tools/execute` 事件的载荷也有 `agent`，且是 around-dispatch | 同文件 `:1604-1606` `scopeTarget(this, exec.agent)` + `ctx.waterfall(carrier, 'tools/execute', mutableExec, …)` |
| agent loop **真的传了** | `packages/core/agent-loop/src/tool-calls.ts:78`、`packages/core/agent-loop/src/index.ts:612` |
| **别人已经在用** | `packages/fs/tool-fs/src/sandbox.ts:101` `agent: exec.agent` |

而 OMB 的桥把它丢了：

```ts
// dsh/tool-bridge.ts
run: (args: unknown) => definition.execute(args)   // ← exec 从未上传
```

**结论**：会话身份**可以**按"这次调用自己的 agent"取得，从而不需要全局"最近活跃会话"。这是消除交错会话污染的正解。

**注意**：`ToolRunContext` 的**类型声明**（`:418` `interface ToolRunContext extends ToolExecution`）里没有列出 `agent`，只有运行时对象上有。取用时要么用类型断言，要么按 `ToolExecutionInput.agent`（`:339` 有 `readonly agent?: Agent`）来写。**别假设类型上有就一定有值。**

### 1.5 两处独立的 `lastActiveSession`

| 模块 | 位置 |
| --- | --- |
| reasoning | `modules/reasoning/index.ts:200` 定义；`:341` 赋值；`:229`/`:358` 使用（**`omb_focus` 的工具归属靠它**） |
| memory | `modules/memory/index.ts:275` 定义；`:278`/`:282`/`:296`/`:310` 赋值；`:292`/`:316`/`:324`/`:326`/`:334` 使用 |

`kernel/activeSession.ts` 的注释已承认这段历史（"`lastActiveSession` 而那个变量永远停在 null"）。

**风险**：两个 session 的工具调用一旦交错，A 的状态可能写进 B。
**注意**：修好 1.4 之后，工具路径可以拿到确定的会话；**其余路径未必有 agent**，所以"拿不到时不猜"仍是必须的。

### 1.6 `3.0.0` 已交付却仍在原地改的风险（已处理）

`3.0.0` 已提交、已推送、已装进 profile，因此本次内容变化已按规范进到 `3.1.0`。后续改造完成后应再次进位。

---

## 二、十项的可做性与依赖

| # | 项目 | 可做性 | 说明 |
| --- | --- | --- | --- |
| 1 | DSH `0.2.0-rc.2` 兼容 + peer 依赖 | ✅ 可做 | 根 `package.json` **完全没有 `peerDependencies`**。需先核实真实用到的宿主契约，再定版本范围。`0.2.0-rc.2` 是预发布版，范围语义要验证后再写 |
| 2 | 恢复自动压缩 | ✅ 可做 | `cordis.patch.yml` 约 `:118` 把 `compaction` 组整组注释掉。要分清**真冲突**（改同一份历史／判据互相污染）与**概念重叠**（各干各的），有选择地恢复 |
| 4 | 状态围绕 Session 原子化 | ✅ 可做（依据 1.4） | 见 §一.4、§一.5 |
| 5 | P0 缺陷 | ✅ 可做 | 见 §一.1、§一.2、§一.3 |
| 6 | 推理改验证预算 + Control Loop | ✅ 可做 | `R6` 固定阈值在 `modules/reasoning/methods.ts:70-73` |
| 7 | 模块开关前置条件 | ⚠️ 部分 | 本仓库**没有前端**（`glob **/*.tsx` 为空），UI 变灰不在本仓库范围。**后端可做**：声明前置条件 + 依赖未开时强制忽略配置 + 可读原因。与 §一.1 同源 |
| 8 | 隐私模式命令 | ✅ 可做 | `ctx.commands.register({ definitionId, name, description, handler })`（`packages/compaction/command-compact/src/index.ts:101`）。且 `CommandInvocation`（`packages/interaction/commands/src/index.ts:41`）**有 `agent: Agent`** → "跟随会话"有落点 |
| 9 | TS 升级 | ✅ 已完成主体 | 见 §三 |
| 10 | 工程结构与隐性缺陷 | ⏳ 持续 | §一 的六条即其一部分 |

---

## 三、TypeScript 升级（第 9 项）

### 实测结果

| 版本 | `npx tsc --noEmit` |
| --- | --- |
| `5.5.4`（原） | 通过 |
| **`6.0.3`** | **通过，零错误** |
| `7.0.2` | 初次运行报 6 处 `disposeAsync` 不存在——**但那不是 TS7 的不兼容**，是并行施工的中间态（`kernel/index.ts` 尚未补 `disposeAsync`，而测试已引用） |

### 决定

- **升级到 `6.0.3`**：与宿主 DSH 自己的 `^6.0.3` **保持一致**。宿主与插件用同一大版本，避免"宿主能编译、插件不能"这类漂移。
- **TS7 作为独立 canary**，不与主版本混淆：`7.0.2` 的失败信号会被并行施工污染，所以它要**在施工静止时单独跑**，且不进主门禁。
- 类型检查已经证明**有价值**：升级到 6.0.3 立刻抓出队友的两处类型错误（`disposeAsync` 缺失、`SessionRuntime.noteLineage` 不存在）。

### 为 TS7 做的准备

1. 公共 API 不开隐式 `any`。
2. 判别联合的判别属性写显式字面量类型（TS7 收紧了判别推断）。
3. 保持 `skipLibCheck: false` 的可行性评估——现在为 `true`，需确认关掉后是否干净。
4. 不依赖任何在 6→7 之间被移除的编译选项。

---

## 四、施工纪律（本轮）

- **只有 Lead 执行 git**。绝不 `git add -A`（曾扫走他人改动）。
- 产物（`lib-gen/`）**由 Lead 在最后统一构建**；并行施工期间构建会互相污染。
- **队友不跑** `plugin_manager`、`scripts/build.mjs`、任何 git 命令。
- 每个任务必须**实际运行** `npx tsc --noEmit`、`npx eslint .`、`npx vitest run` 并贴输出；基线 **888 passed / 2 skipped**。
- 回报必须含**"任何没做到或不确定的点"**，直说不美化。

### 写入范围（避免互相覆盖）

| 任务 | 范围 |
| --- | --- |
| task-5 DSH 兼容 + 压缩 | `package.json`、`cordis.patch.yml`、`docs/**` |
| task-6 内核 P0 + 单真源 | `kernel/registry.ts`、`kernel/index.ts`、`kernel/abi/**`、`kernel/hostEntry.ts`、`dsh/host.ts`、`cordis.patch.yml` 的 requires/inject、`tests/kernel/**`、`tests/dsh/**` |
| task-7 会话原子化 | **新建** `kernel/sessionRuntime.ts`、`modules/{reasoning,memory,context,profile}/**`、`tests/modules/**` |
| task-8 隐私模式 | 新建 `modules/privacy/**`（或 `packages/privacy/**`）、`cordis.patch.yml` 新增行、对应测试 |
| task-9 推理改造 | `modules/reasoning/**`、`tests/modules/reasoning/**` |

**已知重叠点**（需 Lead 协调）：`kernel/index.ts`（task-6 与 task-7）、`cordis.patch.yml`（task-5、task-6、task-8）。

---

## 五、待验证与明确未做

以下项**尚未验证**，本节如实记录，不用"应该没问题"糊过去：

1. **`MODULE_CATALOG` 是否真的一处都不驱动运行时**——已 grep，但可能有间接路径未覆盖（`validateCatalog` 的调用方、`kernel/index.ts:62` re-export 的消费者）。task-6 会复核。
2. **`exec.agent` → 会话 id 的确切取值路径**——`Agent` 的 `session` 字段名待核实（已知 `ToolExecutionInput.agent?: Agent` 存在）。
3. ~~**DSH `0.1.7-rc.2` → `0.2.0-rc.2` 的破坏面**——尚未逐项对照，task-5 负责。~~
   **✅ task-5 已做**：逐条核对见 `docs/dsh-compatibility.md` §3（10 项契约，每条带两侧 `文件:行号`）。
   结论：4 项匹配；**1 项不匹配**（`ctx.on('tool/call')` 在 0.2.0 不触发 → 制品索引静默失效，修法见该档 §6.2）；
   另发现内核压力桥未接宿主 `tokenMeter`（§6.1）。**完整破坏面仍不能确证**（DSH 仓库禁止 git、无 CHANGELOG 可比），
   只核对了任务点名的 5 类契约 + OMB 实际读到的全部服务。
4. ~~**压缩组与 OMB 上下文优化的真实冲突边界**——尚未读实现，task-5 负责。~~
   **✅ task-5 已做**：四个压缩包逐一读过实现，判定为**概念重叠 + 测量耦合，不是真冲突**
   （OMB 只读 tokenMeter、从不改会话历史；两者改的是两条轴），已在 `cordis.patch.yml` 的 `preset-omb` 里
   **有选择地恢复** `compaction-basic` + `command-compact` + `tool-result-pruner` 三行（`image-offload` 不加，留宿主平面）。
   完整证据、开/关理由与装配级解析输出见 `docs/dsh-compatibility.md` §4。
5. **本仓库外是否有 `StoresService` / `SessionTable` 的消费方**——`3.1.0` 删除了这两个接口成员，已 grep 仓库内无遗留，但仓库外未知。

---

## 六、真机验证结果（2026-09-30 00:20，宿主重启到 g61 之后）

**这是本项目唯一承认的权威信号**：`tsc` / `eslint` / `vitest` 全绿只说明代码自洽，
不说明它在真实宿主里工作。以下每一条都来自**真实调用返回**。

| 验证项 | 实测结果 |
| --- | --- |
| 产物代数 | `代数：第 61 代`（重启前旧进程报 59——它启动于构建之前，一直在跑内存里的旧模块） |
| 模块装载 | **8 个模块，1 降级，0 失败**；`omb-privacy` 在位且状态文件路径正确 |
| **第 10 项：制品索引** | **索引真的有内容了**（3 条真实路径）。这是"订了 `ctx.on('tool/call')` 却永不触发"那个缺陷修复后的首次真机确认——**上一轮我曾以为修好了，实际从未生效** |
| **第 6 项：`omb_verify`** | 形式核对四态可用；含糊结论被判"缺来源"；超预算时如实说"预算不是禁令"；失败分类 `transient → retry`，`why` 逐字含"两次是这一类的上限，不是对其它失败也成立的禁令" |
| **第 6 项：`omb_focus`** | 回执是**结构化控制参数**（验证预算 3 / 证据要求 / 并列 ≤3 / 复核 ≤2 / 收尾规则），**不再是"注入更多规则卡文本"** |
| **第 4 项：会话原子化** | 状态面出现「分会话拉取台账」两行（`session-4062e896` 32 次/31 轮、`session-bf365d80` 6 次/7 轮），**互不合并**；`跟踪会话 2` |
| **第 8 项：隐私** | `omb-privacy` 正常、基线 normal、状态文件在位、拒绝计数在位 |
| 深度档位 | `推理深度档位：deep` + `会话 session-4062e896…：深度 deep（理由：…）`——**按会话存储**，且回读了理由 |

### 真机发现的新缺陷（已修）

状态面**自己打自己的脸**：

```
### 模块依赖图
依赖未挂载 6 处（前置条件未满足，依赖方应已自行降级）：
- omb-privacy ← omb-kernel …（6 个模块全说内核未挂载）

而同一份输出里：合计 8 个模块，0 失败
```

**根因**：内核行（`dsh/plugin.ts` 的 `KERNEL_SELF`）的 `apply` 是**空操作**——内核在
`createKernel()` 里就建好了，那行只负责把"内核已就绪"发布到宿主 ctx，**从不经过
`mount()`**；而 `recordMount()` 只在 `mount()` / `start()` 里调。于是账本里没有
`omb-kernel`，每个声明 `requires: ['omb-kernel']` 的模块都被判"依赖未挂载"。

**修法**：内核行自己最先入账（`kernel/index.ts` 的 `KERNEL_ROW_ID`）。
新增 `tests/kernel/module-graph-no-false-alarm.test.ts`（4 例）钉住，并**同时保留
"真缺失仍要报"与"顺序违规仍要报"**两条反向断言——不能把真告警一起关掉。

**为什么这条重要**：自检若把"我没记录到的"当成"不存在"，就会**稳定产出假告警**；
而假告警会训练人无视真告警，那时自检比没有更坏。这与"制品索引空转"同源——
**两次都是"看起来在工作，实际在空转或误报"。**

### 第 7 项最终结论（**未达用户原始要求的部分，如实记录**）

用户要求"依赖没开 → 依赖方自动关闭并变灰；配置里强行写入也忽略"。实际做到与未做：

- ✅ **行序守卫**：`tests/dsh/module-graph-source.test.ts` 断言行序满足依赖图，并用构造出的漂移证明判据会失败。
- ✅ **启动自检**：`moduleGraph()` 把"顺序违规"与"依赖未挂载"分开报。
- ✅ **修法指引**（本轮补）：依赖未挂载段现在给出含义 + 修法 + **明写"运行时不硬阻断"**。
- ✅ **依赖方不假装正常**：内核在模块未自报健康时标 `degraded`（"已挂载但未自报健康"），H-3 保证缺服务给可读错误。
- ✅ **依赖缺席时依赖方点名缺谁**（本轮补，`40adefb`）：向量通道的库访问走 `SERVICES.stores`（由 `omb-memory` 提供），
  原来的 `report()` **从不检查这个依赖**——记忆库被关掉时它照样报「权重目录不存在」，
  使用者会去修**错的东西**（下载模型权重），而真正的问题是那一行被关了。
  现在每次上报实时查 `stores`，缺失就在健康面写「缺少必需依赖：omb-memory」。
  判据：`tests/modules/memory/precondition.test.ts`（缺 → 必须点名 / 在位 → **不许误报**）。
  两个细节是实测逼出来的：① 检查放在 `report()` 里**每次实时查**而不是 `apply` 时查一次
  （行序无保证，apply 时查会把"晚一点就绪"误判成"缺失"）；② **已 dispose 的模块不查**
  （"已关闭"不该被说成"缺依赖"——这条是加上检查后弄坏了既有测试才发现的）。
- ❌ **运行时不硬阻断**——**刻意不做**。理由：模块行之间只有 `inject: ['omb:kernel']` 这一道门，
  **没有顺序保证**；硬阻断会把"依赖晚一点就绪"误判成"依赖缺失"→ **静默丢能力**（比现在更坏）；
  把 `apply` 挪到 `mount` 返回之后又会让宿主的一次性安装审计（H-2）失效。
- ❌ **"变灰"**——不在本仓库范围：**本仓库没有前端**（`glob **/*.tsx` 为空），插件页由 DSH 提供。

**"配置里强行写入也忽略"这条**的等价形态**已经成立**：依赖缺席时依赖方**不会自称正常**，
健康面**直接点名缺哪个依赖**，状态面的依赖图段落也给出含义与修法。
但它不是"拒绝启动"，而是"启动但如实降级并指名"。
**这一点写进了 `kernel/abi/catalog.ts` 头部、依赖图段落本身与本节，没有假装硬阻断已实现。**
