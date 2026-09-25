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

理由：队友的"我验证过了"是转述，不是证据。基线数字要记下来（当前 789 passed / 2 skipped），
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

第 4 条最重要：本项目多条真缺陷是靠"报告里那句不确定"定位的。
