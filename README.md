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
   ⚠️ **种子升级**（旧布局 → 新种子）：删除 `versions.git` 后重新执行 `pnpm init-three-line`（或重启宿主走启动自动初始化）即重建**新种子**——新种子含 `kernel/policy` + `kernel/processes` 快照与 `trusted-latest` 分支（P1a 种子升级语义：演化管线/晋升检查/按线加载依赖这些特征；旧种子会以「降级记录」运行，不报错）。
3. **依赖安装**：项目根执行 `pnpm install`。⚠️ 项目经拷贝/移动后 pnpm 顶层符号链接可能会损坏（表现为空目录，运行时 `Cannot find package`），必须重新 install 修复（`pnpm install --offline --frozen-lockfile` 可全离线重建）。
4. **构建**：`pnpm build`（tsc 输出 `lib/`；`lib/` 为编译产物，不入库）。修改源码后需重新 build。
5. **组合配置要点**：
   - `bootstrap`（默认 `true`）：启动时自动初始化三线布局与只读 ACL（见步骤 2）；设为 `false` 可关闭（测试/手动控制场景）。
   - `cognitiveRoot` 不提供时插件降级为仅命令模式（`/mode`、`/bench` 可用，无认知投影/事件采集）。
   - `benchVersion`（默认 `'v2'`）：`/bench` 运行 **v2 契约基准**（benchmark-v2-contract——输入工件 + requirement + output_schema + verifier rules 四要素单一权威，fixture 由 reference 纯函数生成，prompt 直接序列化 output_schema 为唯一权威输出形状）；设为 `'v1'` 可切回 **legacy 录制基准**（benchmark-v1-legacy，`kernel/bench-tasks/{tasks,fixtures}/` 原位保留）。两版本并存，可对比「修复了基准契约」与「模型真的进步」两个因素。
   - 行名尾缀 `?v=N` 用于破除宿主进程的 ESM 模块缓存（进程内文件修改不热重载）：修改 `lib/` 下代码并重新 build 后**须递增 `?v=`（或重启宿主）**，新会话才会加载新代码。
   - 组合必须保留完整的模型工具行：只有 `omb-v2` 一行的预设是**无工具会话**（模型无工具可用，实测会幻觉出不存在的工具名，自检/日常都无法执行）。
   - **`kern_*` 工具面（示例清单非必须全集）**：`kern_*` 为领域标准词命名示例清单——当前实现 `kern_status`（认知运行时状态摘要：版本线/快照/lineSnapshot/债务/信号数/组件健康）；`kern_bench`/`kern_evolve`/`kern_switch`/`kern_memory` 按需注册（runtime/kern-tools.ts）；工具数 <10 纪律（最小工具面）。
   - `/evolve` 命令：`now`（演化判定 + 维护量子）｜ `share`（发布**机制级** Evolution Object——trusted-latest 演化链头 → 本地 registry，缺省 `workspace/.omb/.evolution/registry`；返回对象 id/发布结果）｜ `absorb <id>`（显式吸收：从 registry 本地验证（schema/签名）→ 入库 → 共识回传）。**生产默认不自动发布/吸收**（evolve.policy `share.publish_mechanism_objects=false`/`auto_discover=false`——隐私原则：仅发布机制数据，绝不发布私人记忆/会话内容；配置为未来自动路径预留，显式命令始终可用）。
   - `/mode`：切换 **OMB 当前版本线**（`initial | stable | latest`）——OMB 内部版本线切换（**单模式**）：load 校验 + 空白会话守卫 + 版本激活记录；**不涉及 DSH 预设切换**（DSH 侧恒为「大肥鱼模式 v2」单一模式）。
   - per-line 预设（`omb-v2-initial/stable/latest`）由 `pnpm deploy-lines` 部署（覆盖式写入 `$DSH_HOME/.agent-presets/`；内容基于本组合**文本级**生成——保留全部注释与工具行，仅把 omb-v2 行 `name` 指向主预设编译产物（`../<主预设目录名>/lib/runtime/plugin.js?v=N`）并在 `config` 注入 `line: <line>` 固定本线初始版本线）。**后备/兼容机制（可选）**：供宿主兼容测试/开发调试/未来多预设场景；正常生产为单模式 + `/mode` 内部版本线切换，**无需部署**。
6. **验证**：重启宿主后新建会话选择「大肥鱼模式 v2」；`/mode`、`/bench` 命令可用；系统提示含认知投影段；`workspace/.omb/` 出现 `events.db`/`memory.db`。`/bench` 默认运行 v2 契约基准（回放降级明细 `replay-v2-<line>-<ts>.jsonl`；配 `model` 且有 DSH llm 服务时真实执行，明细 `real-v2-<line>-<ts>.jsonl`）——真实执行预期通过率显著改善（契约化 prompt + output_schema 单一权威，修复 v1 实测的 prompt/输入/输出/verifier 四者漂移；v1 legacy 仍可用 `config.benchVersion: 'v1'` 切回对比）。也可用 `agentPresets.standingKeyFor('oh-my-bigbluefish')` 做挂载审计（需挂载探针）。
   - **真实会话冒烟（投影注入可观测）**：认知投影经 DSH `systemPrompt.context` 钩子（名 `cognitive:projection`）注入系统提示——可观测点 = 系统提示中的认知投影段（Goal/事实/矛盾/进度等）+ `events.db` 的 `context/injected` 事件（投影 id/total_tokens/views；Model-visible ⟺ logged，注入必有对应事件）。
   - **S4 world/self 模型接线（约定层，留下游）**：S4Schema（WorldModel/SelfModel 双变体）为已定契约（OMB_OBJECTS.S4）；运行时世界/自我模型**未接线**——checkpoint/事件流归约的 world/self 为 `null`（reducer 诚实"未知"，非缺陷）；S4 实体采集与接线留下游里程碑（约定：save 不机械校验内嵌 state，调用方保证 schema 合规）。

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
