# Oh-My-Bigbluefish

基于DeepSeek Harness的综合插件，通过统一的认知增强系统，为大模型提供动态的任务分析、上下文优化、技能统合、工具调用与验证的能力。采用恢复根、内外双核分层架构等底层框架，支持虚拟化沙盒、版本控制、深度记忆、迭代共享，使模型能够以较低的上下文与计算开销持续积累经验并改进自身处理流程。

## ⚠️ 实验性警告（使用前必读）

本插件是**实验性**的，会主动修改运行环境，进而影响DSH历史会话，其可能会造成严重的加载错误，请勿在实际生产环境中使用。

## 功能一览

- **认知投影与运行时契约**：每轮注入工作状态/记忆候选/认知过程 + 三层运行时契约（固定契约 → 动态能力行 → omb-runtime 技能渐进层）。
- **三线版本切换**：`initial | stable | latest` 三线承载版本化策略/过程，`/mode` 与 `kern_switch` 切换，ls-tree 物化快照、启动自动初始化/修复/旧种子迁移。
- **记忆与跨项目画像**：SQLite+FTS5 记忆库、六阶段检索（覆盖链 Session→Project→Global）；`kern_profile` 写入用户画像（Global 跨项目可检索）、`kern_memory` 读取。
- **自演化与候选晋升**：信号 → 判定 → 候选管线（G1 结构 / G2 跳过 / G3 基准回放 / G3-exec 执行 / G4 shadow）→ trusted-latest 推进 + stable 晋升门禁（三层信号 + 验证契约信任门禁 fail-closed）。
- **统一验证契约**：PASS/FAIL/UNKNOWN 三态（UNKNOWN 合法终态）、hard 约束不可被 LLM judge 覆盖、VerifierTrust L0-L4、防循环自证、数据面四库（事实/基线/任务/验证器）、验证债务队列。
- **维护调度**：ROI 排序维护队列、债务语义（成功清偿/失败保留/中断累计）、请求间隙小量子、S2 观测数据化；队列与债务**跨重启同源**（`queue.json` 重建执行体），关停真正排空（等静默点而非只等标志）。
- **修复系统**：损坏六分类 + 七类对象契约化重验证 + 真实验证执行器 + 处置语义（降级/隔离/保持怀疑/清除存疑）。
- **kern 工具**：`kern_status` / `kern_bench` / `kern_evolve` / `kern_switch` / `kern_memory` / `kern_profile`等。
- **制品索引**：事件驱动发现（`tool/result` → 路径提取 → manifest），上下文候选含最近制品。
- **跨平台受限执行**：候选验证的执行型门（G3-exec）在 Windows 走受限令牌、Linux/macOS 走 bubblewrap 或 Node 权限模型；通道可用性经**真实自检**确认，通道不可用时缺省拒绝该候选晋升（`evolve.policy.candidate_gate.require_execution_verification`）。
- **桌面通知（可选）**：宿主装了 `dsh-desktop-notify` 时，只对少数"值得打扰"的事件出声（内核未加载/启动回退/晋升回退/债务 critical/组件健康异常），带节流与去重。
- **神经向量检索（可选）**：接入 BGE-small-zh-v1.5（ONNX，512 维）做中文语义检索——同义改写与跨语言查询能召回哈希词袋召不回的记忆。权重不进仓库，用 `pnpm fetch-embedding-model` 获取；未装权重时**诚实降级**回纯 JS 哈希词袋，状态面写明原因。

## 架构说明

- 实际施工架构：`docs/architecture.md`（分层、三线版本、记忆、演化、验证契约、维护、修复、工具面、数据落盘）。
- **§15 开放问题解决记录**：本地未入库问题清单的逐条落地与**取向理由**（含"明确不在本仓库范围内的一层"）。

## 安装插件

1. **位置**：克隆到 `$DSH_HOME/.agent-presets/oh-my-bigbluefish/`（目录名即 preset id，须匹配 `^[a-z0-9][a-z0-9-]*$`）。`versions.git/`、`stable/`、`latest/`、`workspace/.omb/` 均 gitignored，首次启动自动初始化三线布局。
2. **挂载**：仓库根自带全量组合 `agent.cordis.yml`（standard 工具面 + `omb-v2` 认知行，`name: './lib/runtime/plugin.js?v=9'`）；克隆后 `pnpm install && pnpm build`（`lib/` 为编译产物）。修改源码重新 build 后须递增 `?v=N` 或重启宿主。
3. **生效**：重启 DSH，新建会话选择「大肥鱼模式 v2」。验证：
   - `/bench` → 冻结基准（回放或真实执行）；
   - `kern_status` → 版本线/快照哈希/维护债务/信号数/组件健康；

> **ACL 提醒（三线只读）**：三线布局（`versions.git/` + `stable/` + `latest/`）由启动时自动初始化并施加**只读 ACL**（架构要求：`stable/`、`latest/` 仅 `Everyone:RX`——实现用 well-known SID `*S-1-1-0`，免本地化名称解析，非英文 Windows 同样可用）。拷贝/检出会丢失 ACL，启动时自动重新施加。若遇 `EPERM`/`EACCES` 等权限错误，先检查 `stable/`、`latest/` 的 ACL，排障可 `pnpm init-three-line` 重新初始化。**卸载前必须先解除只读 ACL**：`icacls <项目根>\stable /reset /T /C` 与 `icacls <项目根>\latest /reset /T /C`，否则目录删除被拒（详见下文「卸载」）。

## 构建与测试

- `pnpm build`（tsc → `lib/`）、`pnpm test`（vitest）、`pnpm typecheck`、`pnpm lint`。
- 工具脚本：`pnpm init-three-line`（三线布局初始化/修复兜底）、`pnpm deploy-lines`（部署 per-line 后备预设，可选）。
- `pnpm fetch-embedding-model`：获取神经嵌入权重（BGE-small-zh-v1.5 ONNX 量化版，约 23MB）到 `<preset>/workspace/.omb/models/`。
  - 中国大陆网络可加镜像：`OMB_MODEL_MIRROR=https://hf-mirror.com pnpm fetch-embedding-model`。
  - 幂等：按上游 sha256 校验，已就绪则跳过；下载不完整或校验失败会删除半份文件并报错。
  - 可选参数：`--dir <目录>`（自定义位置，配合配置项 `embeddingModelDir` 或环境变量 `OMB_EMBEDDING_MODEL`）、`--variant fp32`（未量化版，质量略高、约 90MB）。
  - 还需要推理运行时 `onnxruntime-node`（**optionalDependency**，解包约 296MB——只想用哈希词袋的部署不必装）：`pnpm add -O onnxruntime-node@1.29.0 --fetch-timeout 1800000 --fetch-retries 5`。脚本结束时会探测并提示。

### 神经嵌入的配置面

| 键 | 作用 | 缺省 |
| --- | --- | --- |
| `embeddingModelDir` | 权重目录绝对路径 | 按 `OMB_EMBEDDING_MODEL` → `<数据根>/models/bge-small-zh-v1.5/` 探测 |
| `embeddingThreads` | ONNX 推理线程数（1~64） | `2`；本地小机可设 `1` 避免与主对话抢核 |

两个键都可在 `agent.cordis.yml` 的 `config` 下配置；非法值只记降级、不阻断加载。未装权重时向量通道自动回落哈希词袋（功能仍可用，语义能力弱），原因见 `kern_status` 的状态面。

## 卸载

先释放只读 ACL（`icacls <根>\stable /reset /T /C`、`icacls <根>\latest /reset /T /C`），再删除项目目录即可。

## 许可证

**GPL-3.0**，详见 [LICENSE](LICENSE)。随仓库分发的第三方文件（中文词表等）与运行期依赖的许可归属见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
