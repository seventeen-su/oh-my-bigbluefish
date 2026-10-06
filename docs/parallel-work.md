# 并行施工纪律

本项目有过两次**自己造成的返工**，都发生在"多件事同时改一个工作树"的时候：

1. `git add -A` 把队友没写完的改动扫进了我的提交。
2. 为了清理历史执行 `git reset --hard`，**冲掉了当时未提交的修复**（未提交的东西不进 reflog，找不回来）。

这份文档把纪律写死，避免第三次。

## 一、只有 Lead 碰 git

**队友一行 git 命令都不执行**（不 add / commit / stash / checkout / reset）。

- 提交由 Lead 按**文件显式 add**，**永远不用 `git add -A`**。
- 理由：`add -A` 无法表达"只提交我这部分"。并行时它必然扫走别人的半成品。

## 二、写入范围必须互不重叠

每个共享任务在 `write_scopes` 里声明自己要改的目录，**并且验收标准里重复一遍**。

分配时按**目录**切分，不按"功能"切分——两个任务都要"改一点 `kernel/`"是分配错误，不是协作。

当前切分：

| 范围 | 归属 |
| --- | --- |
| `modules/context/`、`tests/modules/context/` | 上下文任务 |
| `modules/reasoning/`、`tests/modules/reasoning/` | 思维链任务 |
| `modules/memory/`、`tests/modules/memory/` | 记忆任务 |
| `kernel/`、`dsh/`、`scripts/`、`package.json`、产物 | Lead |

## 三、产物是公共输出，只在最后构建

`lib-gen/` 与 8 个组件包的 `package.json`（`main`/`exports` 指向当前代数）是**所有模块的公共输出**。

- 并行期间**任何人都不跑 `node scripts/build.mjs`**。
- 全部改完后由 Lead 构建**一次**。
- 理由：同一目录既被某任务使用、又被构建刷新时，两边会互相覆盖——这是典型的"公共资源要串行化"。

## 四、装插件与重启是 Lead 的事

- 队友**不执行 `plugin_manager`**，也不重启宿主。
- 原因不只是纪律：装插件会改 profile 组合，而 profile 里跑着 `dsh-path-guard`（自我保护开启时 `plugin_manager` 只读）。

## 五、验收命令由 Lead 复跑

队友必须**贴出实际输出**，但 Lead 在提交前**自己再跑一遍**：

```bash
npx tsc --noEmit
npx eslint .
npx vitest run
```

理由：队友的"我验证过了"是转述，不是证据。基线数字要记下来（当前 **1271 passed / 1 skipped**，2026-10-03 实测），
数字变化必须能解释。

## 六、宿主有 ESM 缓存，验证要认代数

**行名不变时，宿主按包名命中 Node 的 ESM 缓存，会继续跑旧代代码**——卸载/重装插件行也清不掉。

判据只有一条：`omb_status` 的「构建」代数 == `build-generation.json` 的 `generation`。

不等就是缓存旧代，**必须重启 `dsh web`**；此时任何"改完就验证"的结论都不成立。
这一点本项目踩过整整一轮（构建已到 g41，宿主仍跑 g39，期间所有验证结论作废）。

## 七、交付回报的格式

队友回报必须含：

1. 改了什么、**判据**是什么
2. 上面三条命令的**实际输出摘要**
3. 新增用例名
4. **任何没做到或不确定的点**（直说，不许美化）
5. **你怎么知道它"真的生效"**——不是"我接上了"，而是"电来过"（见 §十）。要给出可复现的观测：
   真机读数、状态面字样、计数器、日志行之一；**"代码里有这条路径"不算证据**。

第 4 条最重要：本项目多条真缺陷是靠"报告里那句不确定"定位的。
第 5 条是补上第 4 条的另一半：**不确定会被说出口，但"确定"必须先被观测过**。

## 八、worktree 与 junction：一次真实事故（2026-10-03）

**事故**：为了给并行 worktree 省一次安装，把它的 node_modules 做成指向主仓库的 **junction**。
之后执行 `git worktree remove --force <探针 worktree>`，删除**穿过 junction 把主仓库的 node_modules 清空**（实测 files=0）。
侥幸只损失依赖目录：`.omb`（记忆库 4 文件）、`models`（权重 3 文件）、`lib-gen`（86 文件）、全部源码与 `git status` 均完好，
`pnpm install --prefer-offline` **2.1 秒**复原（store 是热的）。

**规则**：

1. **不用 junction 共享 node_modules**。每个 worktree 各自 `pnpm install --prefer-offline`——实测 992ms–2.1s，比一次误删便宜得多。
2. 若已经建了 junction，删 worktree 前先 `cmd /c rmdir <junction>`（只删链接、不碰目标）；**不要用 `Remove-Item -Recurse`**。
3. 任何递归删除之前，先确认路径里没有 reparse point。

## 九、子代理 fan-out 的三条硬约束（2026-10-03 实测）

1. **并发 ≤ 4，且每个代理必须把结果 write 落盘**。实测 7 并发审计整批失败：7 个子代理会话的 turn/end 全是
   `429 GoUsageLimitError`，而 workflow 作业通知仍报 `status: completed, 7 agents`——**作业"完成"不等于代理有产出**。
2. **后台作业的结果会丢**。长空闲（实测 2h16m）后 `job_output <id>` 报 `unknown job`、`job_list` 返回空，
   已完成作业的结果**永久取不回**。落盘是主副本，作业返回值只是副本。
3. **`subagent` 启动后无法中断**：`send_message` 只路由 teammate（报 `active teammate not found`）、`list_agents` 不含子代理、
   `job_list` 不含子代理，因此 `job_kill` / `interrupt_agent` 都用不上。需要可中断的并行施工请用 `spawn_teammate`。
## 十、第一条测试原则：**存在 ≠ 生效**

这条不是洁癖，是三次实测事故的总结。三处的共同形态是：**代码里有这条线、类型对、测试绿，而电从来没来过**。

| 事故 | 当时的"证据" | 真相 |
| --- | --- | --- |
| 制品索引恒为空 | 订了 `ctx.on('tool/call')`，订阅"成功"、disposer 正常 | `tool/call` 不是 ctx 层事件，只有 `session/event` 会发；**订阅语法对、事件永不到来** |
| 模块健康面假绿 | 订阅了 `kernel/module-health` | 那个事件**从未被发射过**（发射点与订阅名不一致） |
| 上下文压力恒为 relaxed | 内核压力桥"已接线" | 宿主 `tokenMeter` **根本没接**，读数是占位常量 |

**判据（写测试和写回报时都要过这一关）**：

1. **断言"电会来"，不只断言"线接上了"**：喂**真实事件形状**进订阅点，断言副作用发生了（写入了、计数涨了、状态面出现字样）。
   只断言 `typeof off === 'function'`、只断言服务能解析出来——那是"线"的证据，不是"电"的证据。
2. **每个新接线点都要有一个"不生效就会红"的用例**：能想到的最便宜的反证是"把发射端去掉/改名，这条测试会不会红"。
3. **声明与实际要双向对齐**：`catalog.ts` 声明了但生产没注册 → 红；生产注册了但 catalog 没声明 → **也要红**
   （3.6 实测到的真缺陷：`omb_verify` 已实现却漏登记，而当时的断言方向是"声明 ⊆ 实际"，于是漏登记永远不红）。
4. **文档里的数字要能被运行时读数核对**（例如常驻提示字符数、代数、计数），写死一个实测值并给出取数口径；
   值变了而文档没变，就是下一轮要修的漂移。