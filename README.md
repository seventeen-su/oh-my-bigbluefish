# 大肥鱼模式 v2（oh-my-bigbluefish）

## 简介

基于DeepSeek Harness的状态层综合插件，通过统一的认知增强系统，为大模型提供动态的任务分析、上下文优化、技能统合、工具调用与验证的能力。采用恢复根、内外双核分层架构等底层框架，支持虚拟化沙盒、版本控制、深度记忆、迭代共享，使模型能够以较低的上下文与计算开销持续积累经验并改进自身处理流程。

## 安装

### 前置条件

- Windows 11 >= 23H2
- Node.js ≥ 24
- Pnpm
- DeepSeek Harness >= 0.1.0-rc.7

### 步骤

1. **获取代码（git clone）**：`git clone <仓库地址> <目标目录>`，克隆到 `$DSH_HOME/.agent-presets/` 下。⚠️ 目录名即 preset id，须匹配 `^[a-z0-9][a-z0-9-]*$`（本项目为 `oh-my-bigbluefish`）。三线版本布局（`versions.git/`、`stable/`、`latest/`）与运行数据（`workspace/.omb/`）在 `.gitignore` 中、**不随仓库分发**——克隆后无需手动重建，首次启动 DSH 加载插件时自动初始化（见步骤 2）。
   仓库根自带**全量组合** `agent.cordis.yml`（standard 工具面 + omb-v2 认知行，含 `cognitiveRoot`/`model` 配置与 `?v=` 缓存约定），克隆后即为可用预设。
2. **三线版本布局（自动初始化，无需手动执行）**：`/mode` 版本加载依赖 `versions.git/`、`stable/`、`latest/`（与 `tests/helpers/git.ts` 的真实布局等价）。首次启动 DSH 加载插件时，进程内 bootstrap（`substrate/bootstrap.ts` 的 `ensureThreeLineLayout`）自动检测布局缺失/损坏/ACL 丢失并**初始化或保守修复**（不删除已有内容）：
   - `versions.git` bare repo（`initial` 基线 → `tag initial` + 分支 `stable`；`latest` 基线在 `main`）；
   - `stable/`、`latest/` 正式 worktree 及**只读 ACL**（架构要求；拷贝/检出会丢 ACL，启动时自动重新施加）；
   - `workspace/.omb/.evolution/` 候选目录（AI 演化工作区，含 `candidates/0000-bootstrap/` 临时可写 worktree）。
   布局健康时仅做只读检查（零 git 子进程）。可用 `config.bootstrap: false` 关闭自动初始化（见步骤 5）。
   手动/修复兜底（排障用，**正常无需执行**）：完成步骤 3 依赖安装后，项目根执行 `pnpm init-three-line`（复用同一实现；退出码 0 = 就绪、1 = degraded）。手动等价命令（仅参考，项目根执行）：
   ```powershell
   # 正常无需执行；启动自动初始化已覆盖。完整序列见 scripts/init-three-line.ts / substrate/bootstrap.ts
   git init --bare -b main versions.git
   # 建立 initial 基线（tag initial + 分支 stable）与 latest 基线（main 分支）后：
   git --git-dir=versions.git worktree add stable stable
   git --git-dir=versions.git worktree add latest main
   # 正式 worktree 只读 ACL（架构要求）
   icacls stable /inheritance:r /grant:r "Everyone:RX" /T /C
   icacls latest /inheritance:r /grant:r "Everyone:RX" /T /C
   ```
3. **依赖安装**：项目根执行 `pnpm install`。⚠️ 项目经拷贝/移动后 pnpm 顶层符号链接可能会损坏（表现为空目录，运行时 `Cannot find package`），必须重新 install 修复（`pnpm install --offline --frozen-lockfile` 可全离线重建）。
4. **构建**：`pnpm build`（tsc 输出 `lib/`；`lib/` 为编译产物，不入库）。修改源码后需重新 build。
5. **组合配置要点**：
   - `bootstrap`（默认 `true`）：启动时自动初始化三线布局与只读 ACL（见步骤 2）；设为 `false` 可关闭（测试/手动控制场景）。
   - `cognitiveRoot` 不提供时插件降级为仅命令模式（`/mode`、`/bench` 可用，无认知投影/事件采集）。
   - 行名尾缀 `?v=N` 用于破除宿主进程的 ESM 模块缓存（进程内文件修改不热重载）：修改 `lib/` 下代码并重新 build 后**须递增 `?v=`（或重启宿主）**，新会话才会加载新代码。
   - 组合必须保留完整的模型工具行：只有 `omb-v2` 一行的预设是**无工具会话**（模型无工具可用，实测会幻觉出不存在的工具名，自检/日常都无法执行）。
   - per-line 预设（`omb-v2-initial/stable/latest`）由 `pnpm deploy-lines` 部署（覆盖式写入 `$DSH_HOME/.agent-presets/`；内容基于本组合**文本级**生成——保留全部注释与工具行，仅把 omb-v2 行 `name` 指向主预设编译产物（`../<主预设目录名>/lib/runtime/plugin.js?v=N`）并在 `config` 注入 `line: <line>` 固定本线初始版本线）。部署后 `/mode` 切换可**真实 recompose** 重链到对应线预设；未部署时 `/mode` 降级为会话内版本线状态（既有行为）。
6. **验证**：重启宿主后新建会话选择「大肥鱼模式 v2」；`/mode`、`/bench` 命令可用；系统提示含认知投影段；`workspace/.omb/` 出现 `events.db`/`memory.db`。也可用 `agentPresets.standingKeyFor('oh-my-bigbluefish')` 做挂载审计（需挂载探针）。

### 卸载

1. **解除只读 ACL**（删除项目本体前必须执行，否则 `stable/`、`latest/` 删除被拒）：
   ```
   icacls <项目根>\stable /reset /T /C
   icacls <项目根>\latest /reset /T /C
   ```
2. **删除项目目录**：删除 `$DSH_HOME/.agent-presets/oh-my-bigbluefish/`（解除 ACL 后可直接删除整个目录）。
3. **恢复宿主配置**（如曾设置）：把 `$DSH_HOME/settings.yaml` 的 `agent-presets.default` 指向其它预设。

## 许可证

**GPL-3.0** —— 本插件以 GNU General Public License v3.0 发布，详见 [LICENSE](LICENSE)。
