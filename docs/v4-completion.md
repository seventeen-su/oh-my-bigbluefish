# OMB v4 完工记录（2026-10-18）

## 交付

| 项 | 结果 |
| --- | --- |
| 研究报告 | `docs/research/2026-10-18-*.md` 共 **12 份**（记忆/推理/上下文/DSH 能力、学术前沿、生态、DSH 组合、上下文重构、结构审计、产品审计、记忆反馈、状态机） |
| 裁决/架构 | `docs/v4-decision.md`、`docs/v4-architecture.md`、`AGENTS.md`、`README.md` |
| 版本 | **4.0.0**（根包 + 7 个组件 + 模块清单） |
| 代码 | 提交 `ce2816e` → `d81bdd9` → `4cebf8e` → `ca353bf` → `81bdc43` → `2039f3b` → `778e911` → `299a4ae` → `86bb176` |
| 构建 | **g88**（7 个组件包） |
| 门禁 | tsc 0、eslint 0、vitest **1287 passed | 1 skipped**、`scripts/build.mjs` 成功、`check-resolution` 7/7 |
| TS 7.1.0-dev canary | `tsc --noEmit` **0 类型错误**（不进门禁） |
| C: 副本 | `@omb/plugin` = `86bb176`，版本 **4.0.0**，组件 g88，git status clean，7 个组件 import OK |
| 云端 | `origin/main` = `86bb176`（已推送） |

## 真机验收（宿主重启到 g87 后；4.0.0/g88 已发布，需再重启加载版本号）

`omb_status` 实测：

- 构建：加载 87 / 磁盘 87；
- 模块：**6 个**（artifact、memory、memory-vector、notify、profile、reasoning），0 降级；
- 记忆库：schema **v2 → v4** 迁移成功；
- 上下文：压力 moderate / 0.577；cache 读 209,648,640（命中率 100%）；最贵块（消息/工具定义/系统提示）可见；
- **会话状态段**：`active / fresh`、epoch `e846ea214`（git HEAD、脏文件 0）、目标/待办 0、守卫计数；
- 常驻提示 **68/120**（memory 19 + reasoning 48）；
- 隐私：新命令文案 `/omb-privacy-clean` 已生效。

模型面实测：

- 记忆常驻句「跨会话结论用 omb_recall 查」已出现；
- 推理常驻句「过程卡见 skills：omb-r1…omb-r8」已出现；
- 状态机通知行 `[OMB] <epoch> HEAD 81bdc43→2039f3b` 在 HEAD 变化时自动注入；
- `omb_project` 返回项目画像（栈/命令/目录/git/README）+ 项目记忆 top 3；
- `skill` 目录已列出 **omb-r1…omb-r8**，正文可加载（当前工作区通过 `.dsh/skills` 项目根验证；插件包 `skills/` 的 customSkillDirs 修复在 `2039f3b`，重启后对任意项目生效）。

## 主要结构变化

- **删除** `omb-context` 组件（模块/包/行/测试，−1,769 行），压力/cache/压缩读数折叠进 `omb_status` 顶层；
- **推理技能化**：删 `omb_verify` / `omb_method` / `omb_focus` 工具及控制散文；8 张卡迁 `skills/omb-r1…r8`；常驻提示 71→48；循环检测保留（callId/代际/迟滞）；
- **记忆自主化**：新增 `capture.ts`（偏好/决定 + 项目活动 + 会话结果，零 LLM）、`project.ts`（`omb_project`）、`link.ts`（`related` 边 + 1-hop 扩展）、`utility.ts`/`feedback.ts`（`/omb-feedback`、隐式效用、自适应下限）、冷启动重试；
- **状态机**：新增 `dsh/state-machine.ts`（epoch/空闲分级/外部改动/读取戳/目标台账/edit 守卫），服务 `omb:session-state`；
- **真实 effort**：`/omb-depth` 用户命令 + 根 `agent/request` 映射（quick→low、deep→max、standard 继承；能力探测失败可见）；
- **隐私命令拆分**：`/omb-privacy` 只讲档位；`/omb-privacy-clean [会话id | clear]`，空参默认执行命令的会话。

## 二次重启后的补充验证（2026-10-18）

- **skills 走插件包 customSkillDirs 已生效**：删掉项目根 `.dsh/skills` 后，`skill omb-r1` 从
  `...\node_modules\@omb\plugin\skills\omb-r1` 加载成功，说明 `2039f3b` 的包根解析修复在真机成立。
- **session_search 恢复**：旧派生库损坏时报 `session history storage is unavailable`；
  清空 `C:\Users\SuSeventeen\.dsh\cache\session-search.sqlite*` 后，首次检索成功返回 5 条跨会话结果。
  中文 `fts5(unicode61)` 子串限制仍在（设计如此），中文语义检索仍由 OMB 的 bigram FTS 承担。
- 宿主 `omb_status` 已报 `recovering`（重启后状态机正确识别），epoch 为 `778e911`。

## 已知未闭合（不阻塞本目标）

1. `pnpm-lock.yaml` 仍列已删除的 `@omb/context`；下次 `pnpm install` 刷新。
2. ~~状态机 edit 守卫按 R10 偏差：无读取戳的 edit 只计数不拦；write 只警告；目标只消费 goal/todo。~~
   → **v4.1 已修**：edit+write 统一按资源级内容哈希判定；无读取戳仍放行但显式计 `blindWrites`；
   目标来源仍是 goal/todo（契约 §8 明确不做 LLM 目标推断）。
3. `dsh-path-guard` 的 `selfProtection` 仍为 `false`（用户设置，未改）。

---

# OMB v4.1 交付记录（2026-10-18 晚）

## 交付

| 项 | 结果 |
| --- | --- |
| 版本 | **4.1.0**（根包 + 7 个组件 + 模块清单） |
| 基线 → 提交 | `18ec311`（v4.0.0 / g88）→ **`7842ab1`**（功能：`feat: v4.1 时空坐标与并发编辑守卫`）→ **`e6fbbbb`**（文档与 C1 清理）→ 发布提交（g90 构建记录，见 `git log` 最新） |
| 构建 | 目标 **g90**；`build-generation.json` 当前：`generation: 90`、`outDir: lib-gen/g90`、`builtAt: 2026-10-18T14:59:49Z` |
| 改动规模 | **32 files changed, +3,356 / −459**（提交 `7842ab1`；本文档的改动另计、由 Lead 统一提交） |
| 契约 | `docs/v4.1-spacetime.md`（208 行，L0–L5 / 服务 / 判定表 / 捕获生命周期） |
| 审查回应 | `docs/research/2026-10-18-v4-review-response.md`（逐条判定 + 证据命令） |
| 门禁 | `npx tsc --noEmit` **0**；`npx eslint .` **0**；`npx vitest run` **107 files / 1330 passed | 1 skipped**；`node scripts/build.mjs` 成功（g90）；`node scripts/check-resolution.mjs` **7/7** |
| 真机验收 | **待重启 `dsh web` 后核对**（本进程仍加载 g88/4.0.0；部署副本已是 4.1.0/g90，8 个入口 import 通过）。重启后核对：`omb_status` 报构建 90/90、模块版本 4.1.0；`omb_project` 返回 L0–L5；"读文件→外部改动→edit" 被 deny |

> 数字纪律：测试通过数、门禁耗时、真机 `omb_status` 读数一律由 Lead 实测后填；本段不写未测出的数。

## 改动文件清单（按层）

| 层 | 文件 |
| --- | --- |
| 宿主适配（新增） | `dsh/project-root.ts`（项目根解析，176 行） |
| 宿主适配（改） | `dsh/plugin.ts`（27 行变更，接线 projectRoot / situation / privacyAllowsRead / wireEditGuard）、`dsh/state-machine.ts`（476 行变更，内容哈希守卫/situation/writeIntent 回合清空）、`dsh/project-profile.ts`（596 行变更，git root 构建 + 结构化字段）、`dsh/status-tool.ts`（80 行变更，状态/守卫/六层读数） |
| 模块 | `modules/memory/{capture,project,store,index}.ts`（捕获生命周期 / 六层快照 / projectRootOf / situation+隐私接线）；`modules/{artifact,notify,profile,reasoning}/*` 与 `modules/memory/vector.ts` 仅版本号或一行对齐 |
| 内核/ABI | `kernel/abi/catalog.ts`（13 行变更：`projectRoot` 服务、能力说明） |
| 包壳 | `packages/*/package.json`（版本 4.1.0 + 代数指向） |
| 测试 | `tests/dsh/{state-machine,project-profile,project-root}.test.ts`、`tests/modules/memory/{capture,project-root,project-tool,registration}.test.ts`（合计 1,331 行变更，含新增文件）；全量 **107 files / 1330 passed | 1 skipped** |
| 文档 | `docs/v4.1-spacetime.md`（新）、`docs/research/2026-10-18-v4-review-response.md`（新）、`docs/v4-architecture.md`（§8）、`docs/v4-decision.md`（§9）、`docs/v4-completion.md`（本节）、`README.md`、`AGENTS.md` |
| 构建记账 | `build-generation.json`（g88 → g90） |

## 结构变化（v4.1 相对 v4.0）

- **项目身份**：新增 `SERVICES.projectRoot`（`omb:project-root`），记忆库与画像统一按 **git root**；
  子目录会话不再另起项目库。
- **写守卫**：全局 epoch 判定 → **资源级内容哈希**（sha256 前 16，≤2MB）；edit+write 统一；
  同路径同回合第 3 次放行（逃生门）；`post-execute` 成功刷新自身印记；`writeIntent` 按回合清空。
- **自主捕获**：`tool/call` 只挂 pending，`tool/result` 才决定写什么；失败写 `未生效：…`，未知不写；
  `turn/end` 未解决计 `unconfirmed`；无 callId 的旧路径显式计数。
- **`omb_project`**：从"单段画像 + top3 记忆"改为 **L0–L5 分层时空快照（≤2,400 字符）**，
  隐私先于读取、无会话归属只给画像、缺项写"未接线/无会话归属/状态未知"。
- **状态面**：新增 `situation()`（L2/L3 结构化事实）与守卫计数（blind/stale/deny/gaveUp/unverifiable）。

## 已知未闭合（v4.1 结束时）

1. `pnpm-lock.yaml` 仍列 `@omb/context`（1 处；下次 `pnpm install` 刷新）。
2. 缺读取戳时仍放行（计 `blindWrites`）——是否升级为硬拦需先量 shell 读占比。
3. shell 写文件、子代理写集、`AGENTS.md` 指纹、符号级 repo-map：契约 §8 明确不做/留 v4.2。
4. `dsh-path-guard` 的 `selfProtection` 仍为 `false`（用户设置）。
5. **已修（v4.1 收尾）**：`situation().sideEffects.writeWarnings` 无递增点、状态面恒显 0——已从 `situation` 删除该字段，状态面回退行不再显示恒 0 的 write 警告；`SessionStateSnapshot.guard.writeWarnings` 仅作旧快照兼容保留（见审查回应 §3.1 C1）。

---

# OMB v4.2 交付记录（2026-10-19 凌晨）

## 交付

| 项 | 结果 |
| --- | --- |
| 版本 | **4.2.0**（根包 + 7 个组件 + 模块清单） |
| 基线 | `79feb7e`（v4.1.0 / g90）→ 本版提交（`git log` 最新） |
| 构建 | **g91**；`generation: 91`、`outDir: lib-gen/g91`、`builtAt: 2026-10-18T16:23:32Z` |
| 契约/决策 | `docs/v4.2-gap-closure.md`、`docs/v4-decision.md` §10 |
| 门禁 | `tsc --noEmit` **0**；`eslint .` **0**；`vitest run` **107 files / 1335 passed | 1 skipped**；`build` 成功（g91）；`check-resolution` **7/7** |
| 真机验收 | **待重启 `dsh web` 后核对**（本进程仍加载旧代；部署副本同步后应为 4.2.0 / g91）。重启后核对：`omb_status` 构建 91/91、状态行含「指令已变 / shell 写 / 其他会话写」、`omb_project` L1 含「符号 …」 |

## 收掉的五个留白

1. **指令文件指纹**：`AGENTS.md`/`CLAUDE.md` 变化 → 状态行「指令已变」（首次见到不误报）。
2. **shell 写可见性**：重定向/`-Path`/`sed -i`/`git checkout` 路径提取；提取不到显式计 `shellUnknown`；
   读取时 hash 不可用且读后被 shell 写 → deny。
3. **跨会话/子代理写**：`recentWrites` + `otherSessionWrites`；hash 不可用时保守 deny 并写明"其他会话"。
4. **符号级 repo-map**：画像 `sources[].symbols/exports`（正则、有界）；`omb_project` L1 摘要展示。
5. **盲写策略**：新增 `blindWritePolicy`（默认 allow；deny 时逃生门仍生效）。

## 文件

- `dsh/state-machine.ts`：指令指纹、shell 提取/写表、`recentWrites`、盲写策略、通知字段、situation 计数。
- `dsh/project-profile.ts`：`extractSymbols`/`analyzeSource`、`sources[].symbols/exports`、`AGENTS.md`/`CLAUDE.md` 入口。
- `modules/memory/project.ts`：L1 符号摘要、L2 shell/其他会话写展示。
- `dsh/status-tool.ts`：守卫行追加 shell/其他会话写计数。
- `pnpm-lock.yaml`：删除 `@omb/context` 残留 importer。
- 测试：`tests/dsh/state-machine.test.ts`（+5 用例）、`tests/dsh/project-profile.test.ts`（符号/入口）。
- 版本：8 个 `package.json`、6 个模块常量、`KERNEL_SELF`、注册测试。

## 仍未做

- 完整导入图/调用图与语言服务级符号解析（v4.3）。
- shell 未知写的路径级归因；`git apply`/构建脚本的写集。
- 三方合并/自动补丁；`dsh-path-guard` 的 `selfProtection`（用户设置，本版不动）。

---

# OMB v4.3 交付记录（2026-10-19）

## 交付

| 项 | 结果 |
| --- | --- |
| 版本 | **4.3.0**（根包 + 7 个组件 + 模块清单） |
| 构建 | **g92**；`generation: 92`、`outDir: lib-gen/g92`、`builtAt: 2026-10-19T15:23:19Z` |
| 门禁 | `tsc --noEmit` **0**；`eslint .` **0**；`vitest run` **109 files / 1339 passed | 1 skipped**；`build` 成功（g92）；`check-resolution` **7/7** |
| 真机验收 | **待重启 `dsh web` 后核对**：`omb_status` 构建 92/92 + `## 进程` 段；`omb_project` L1 含「依赖 …」 |

## 本版内容

1. **审查指出的两个无界增长点**：`turnBySession` 256 条 LRU；`projectFailures` 32 条 +
   文本截断 + 状态只显示前 5 条（计数仍全量）。
2. **同类缓存有界**：artifact 索引 16、reasoning `explicit` 128、`capabilities` 64。
3. **进程内存读数**：`omb_status` 新增 `## 进程`（rss/heapUsed/heapTotal/external/uptime）。
4. **跨模块导入图**：画像 `structure.imports`（≤12 条边）+ `omb_project` L1 展示；
   正则、相对路径、仓库内解析，不是完整调用图。
5. **关于 OOM**：两个增长点属实但不是主因（条目小、事件驱动；空闲仍增长）。
   根因仍需宿主 heap snapshot；`## 进程` 段用于观察趋势。

## 文件

- `modules/memory/index.ts`（`rememberTurn`/`MAX_TRACKED_TURNS`）
- `modules/memory/store.ts`（失败记录上限/截断/状态只显示 5 条）
- `modules/memory/artifacts.ts`（索引缓存 16）
- `dsh/reasoning-effort.ts`（explicit/capabilities 上限）
- `dsh/project-profile.ts`（`extractRelativeImports`/`resolveImportTarget`/`structure.imports`）
- `modules/memory/project.ts`（L1 依赖展示）
- `dsh/status-tool.ts`（`## 进程`）
- 测试：`tests/modules/memory/bounded-growth.test.ts`、`tests/dsh/status-process.test.ts`、
  `tests/dsh/project-profile.test.ts`（导入边）

## 仍未做

- 完整调用图/类型图、路径别名与包导出映射（v4.4）。
- shell 未知写路径级归因、三方合并。
- OOM 根因（宿主侧快照）。

---

# OMB v4.4 交付记录（2026-10-19）

## 交付

| 项 | 结果 |
| --- | --- |
| 版本 | **4.5.2**（`24 功能 / 79 小功能`，由 `version-manifest.json` 计算） |
| 构建 | **g97**；`generation: 97`、`outDir: lib-gen/g97`、`builtAt: 2026-10-19T17:03:46Z` |
| 门禁 | `tsc --noEmit` **0**；`eslint .` **0**；`vitest run` **110 files / 1344 passed | 1 skipped**；`build` 成功（g97）；`check-resolution` **7/7**；`node scripts/version.mjs` 一致 |
| 真机验收 | **待重启 `dsh web` 后核对**：`omb_status` 构建 97/97、版本 4.5.2、`## 进程` 段；`omb_project` L1 含 `别名/文件依赖/调用` |

## 本版内容

1. **版本号实测计算**：`version-manifest.json` + `scripts/version.mjs`；所有包/模块常量/注册测试
   从 `kernel/version.ts` 的 `OMB_VERSION` 读取，不再手写 4.x。
2. **导入图升级**：tsconfig `paths`/`baseUrl` 别名；`structure.fileImports`（文件级边）与
   `structure.calls`（近似调用边）；`omb_project` L1 展示。
3. **shell 未知写推断**：命令前后 `git status` 基线差分 → `shellInferred`，参与守卫与状态行。
4. **冲突材料包**：读取时缓存 base；拒绝时写 `.omb/conflicts/*.md`（base/current + 事实说明）。
5. **OOM 取证**：`scripts/heap-snapshot.ps1` + 证据链文档。

## 文件

- `version-manifest.json`、`scripts/version.mjs`、`kernel/version.ts`（生成）
- `dsh/project-profile.ts`（别名/文件边/调用边）、`dsh/state-machine.ts`（shell 推断 + 冲突材料）
- `dsh/status-tool.ts`（shell 推断写计数）
- `scripts/heap-snapshot.ps1`
- 测试：`tests/dsh/state-machine.test.ts`（+2）、`tests/dsh/project-profile.test.ts`（别名用例）
- 版本：8 个 `package.json` 由脚本写入；模块常量统一引用 `OMB_VERSION`

## 仍未做

- 完整类型图/类型解析与包导出映射（v4.5）。
- 真正三方自动合并（当前只出材料）。
- OOM 根因最终定位（依赖宿主 heap snapshot；脚本已备）。

---

# OMB v4.5.3 交付记录（2026-10-19）

## 交付

| 项 | 结果 |
| --- | --- |
| 版本 | **4.5.3**（`24 功能 / 79 小功能`，由 `version-manifest.json` 计算） |
| 构建 | **g99**；`generation: 99`、`outDir: lib-gen/g99`、`builtAt: 2026-10-20T01:39Z` |
| 门禁 | `tsc --noEmit` **0**；`eslint .` **0**；`vitest run` **111 files / 1355 passed | 1 skipped**；`build` 成功（g99）；`check-resolution` **7/7**；`node scripts/version.mjs` 一致 |
| 真机验收 | **待重启 `dsh web` 后核对**：`omb_status` 构建 99/99、版本 4.5.3；关闭 `omb-memory` 后画像行显示"降级——依赖未挂载" |

## 本版内容（七点审查的 1–4，以及 6/7 的第一刀）

1. **依赖态统一**：`omb_status` 用内核 `moduleGraph().missingDependencies` 现算覆盖模块行；
   画像 `availability()` 先探 `stores` 服务再看缓存，记忆库热卸载后不再显示运行中。
2. **heap 取证**：`scripts/heap-snapshot.ps1` 拆 `repro`/`early` 双模式，合并 `NODE_OPTIONS`、
   核对快照 PID 职责、磁盘检查/保留/敏感提示；进程内快照统一走 `dsh/heap-snapshot.ts`。
3. **自主捕获**：无 `callId` 时只挂派生 pending、不写完成；配不上结果计 `unknownCorrelation`，
   回合结束计 `unconfirmed`。
4. **写守卫**：修 `dsh/plugin.ts` 注释漂移；默认 `blindWritePolicy='deny'`；
   连续 deny 后须**重读**才放行（不再第 3 次自动放行）；记录非原子窗口。
5. **生命周期闸门**：`execution-confirmed` 不能直接写 `procedural`
   （降级为 `episodic` 并在回执说明，`decideLifecycle`）；`semantic` 仍需准入依据。
6. **有效命中读数**：记忆健康面给 `retrieval.exposed/used/effectiveRate`，
   `exposed=0` 明确为"暂无读数"而不是 0%。

详见 `docs/v4.5.3-review-fixes.md`。5–7 中：6 已落"执行确认不得晋升"闸门、7 已落
有效命中读数；5（项目地图与构建/测试证据闭环）与 6/7 的完整链仍是下一阶段，未在本版声称完成。

## 文件

- `dsh/heap-snapshot.ts`（新增）、`dsh/heap-command.ts`、`dsh/status-tool.ts`
- `modules/profile/storage.ts`、`modules/memory/capture.ts`、`modules/memory/index.ts`
- `dsh/state-machine.ts`、`dsh/plugin.ts`
- `scripts/heap-snapshot.ps1`、`version-manifest.json`（4.5.3）
- 测试：`tests/dsh/heap-snapshot.test.ts`（新增）、`tests/dsh/status-diagnostics.test.ts`、
  `tests/dsh/state-machine.test.ts`、`tests/modules/memory/capture.test.ts`、
  `tests/modules/profile/storage.test.ts`

---

# OMB v4.6.0 交付记录（2026-10-20）

## 交付

| 项 | 结果 |
| --- | --- |
| 版本 | **4.6.0**（`24 功能 / 82 小功能`，由 `version-manifest.json` 计算；x2 功能更新） |
| 构建 | **g102**；`generation: 102`、`outDir: lib-gen/g102`、`builtAt: 2026-10-19T17:48:03Z` |
| 门禁 | `tsc --noEmit` **0**；`eslint .` **0**；`vitest run` **114 files / 1374 passed | 1 skipped**；`build` 成功（g102）；`check-resolution` **7/7**；`node scripts/version.mjs` 一致 |
| 真机验收 | **待重启 `dsh web` 后核对**：`omb_status` 构建 102/102、版本 4.6.0；`omb_project` L1 出现"证据："行、L4 行含阶段；用户说"记住…"后下一轮出现主动提示 |

## 本版内容

1. **主动记忆（用户新增需求）**：
   - 常驻提示改为 `长期偏好/决定主动 omb_remember；跨会话结论先 omb_recall`（≤40 字符，合计预算内）；
   - `omb_remember`/`omb_recall` 描述把触发条件前置；
   - `modules/memory/proactive.ts` 识别"显式要求记住/纠正旧结论/项目决定/长期偏好"，
     通过 `prompt:omb-memory` 的**易变 context 槽**给一行提示；回合结束清空。
2. **项目运行证据（审查第 5 点）**：
   - `dsh/project-evidence.ts` + `SERVICES.projectEvidence`：记录 dsh 亲眼看到的
     build/test/typecheck/lint/verify/install 结果；落盘 `.omb/evidence.json`、
     凭据脱敏、同一命令失败→成功标"修复已验证"；
   - `omb_project` L1 与结构并排显示"证据："行；未接线/暂无读数/有读数三种说法分开。
3. **审查 1–4 的修复**保持 v4.5.3 内容不变（依赖态、heap 取证、capture、守卫）。
4. **知识生命周期阶段**：`modules/memory/lifecycle.ts` 按 `kind + assertedBy` 推导
   事件/候选/已确认/经验；召回回执与 `omb_project` L4 展示阶段；`useCount`/召回次数
   不参与推导，没有自动晋升路径。

详见 `docs/v4.6.0-proactive-memory-and-evidence.md`。第 6 点的用户显式晋升命令与
第 7 点 precision@k/排序对照实验仍未做；第 5 点的故障复现与"已验证修复"自动关联、
证据与具体节点映射也仍是下一阶段。

## 文件

- 新增：`modules/memory/proactive.ts`、`modules/memory/lifecycle.ts`、
  `dsh/project-evidence.ts`、`tests/modules/memory/proactive.test.ts`、
  `tests/modules/memory/lifecycle.test.ts`、`tests/dsh/project-evidence.test.ts`
- 修改：`modules/memory/capture.ts`、`modules/memory/index.ts`、
  `modules/memory/remember.ts`、`modules/memory/recall.ts`、`modules/memory/retrieve.ts`、
  `modules/memory/project.ts`、`dsh/plugin.ts`、`kernel/abi/catalog.ts`
- 版本：`version-manifest.json`（4.6.0 / 82 小功能）

---

# OMB v4.6.1 交付记录（2026-10-20）

## 交付

| 项 | 结果 |
| --- | --- |
| 版本 | **4.6.1**（`24 功能 / 82 小功能`；x3 修复位） |
| 构建 | **g104**；`generation: 104`、`outDir: lib-gen/g104`、`builtAt: 2026-10-19T18:18:55Z` |
| 门禁 | `tsc --noEmit` **0**；`eslint .` **0**；`vitest run` **115 files / 1387 passed | 1 skipped**；`build` 成功（g104）；`check-resolution` **7/7**；`node scripts/version.mjs` 一致 |
| 真机验收 | **待重启 `dsh web` 后核对**：`omb_status` 构建 104/104、版本 4.6.1；失败测试后再次成功显示"失败后再次成功"；"这次不要联网"不写长期记忆 |

## 本版内容（审查 P1/P2）

1. **证据成功语义**：解析 shell 结果 `[exit code: N]`，`isError` 不再当命令成功；
   无标记 = `unknown`（显示 ⚠️未知）；旧 v1 的 `ok` 降为 unknown。
2. **记忆意图分流**：新增 `modules/memory/intent.ts`；临时任务约束/候选不自动写长期；
   `proactive` 对临时约束给"不要写成长期记忆"提示。
3. **恢复标记收紧**：`verifiedFix` → `recoveredFromFailure`，仅"紧邻失败后成功"，
   连续成功不重复标记，展示为"失败后再次成功"。
4. **并发持久化**：目录锁 + 临时文件 + 原子 `rename` + 磁盘合并 + 损坏现场保留。

详见 `docs/v4.6.1-review-fixes.md`。P2 的"主动记忆有限状态工作流"仍未实现，
当前仍是行动建议；`precision@k`、用户显式晋升命令、证据与节点映射仍是后续。

## 文件

- 新增：`modules/memory/intent.ts`、`tests/modules/memory/intent.test.ts`、
  `docs/v4.6.1-review-fixes.md`
- 修改：`dsh/project-evidence.ts`、`modules/memory/project.ts`、`modules/memory/index.ts`、
  `modules/memory/capture.ts`、`modules/memory/proactive.ts`、
  `tests/dsh/project-evidence.test.ts`、`tests/modules/memory/capture.test.ts`、
  `tests/modules/memory/proactive.test.ts`
- 版本：`version-manifest.json`（4.6.1 / 82 小功能）

---

# OMB v4.7.0 交付记录（2026-10-20）

## 交付

| 项 | 结果 |
| --- | --- |
| 版本 | **4.7.0**（`24 功能 / 85 小功能`；x2 功能更新，决策与执行在同一功能内完成） |
| 构建 | **g108**；`generation: 108`、`outDir: lib-gen/g108`、`builtAt: 2026-10-19T18:37:11Z` |
| 门禁 | `tsc --noEmit` **0**；`eslint .` **0**；`vitest run` **116 files / 1414 passed | 1 skipped**；`build` 成功（g108）；`check-resolution` **7/7**；`node scripts/version.mjs` 一致 |
| 真机验收 | **待重启 `dsh web` 后核对**：`omb_status` 构建 108/108、版本 4.7.0；记忆行显示 `事件控制器（执行）` 及 `写入/查回` 计数；`memoryController: dry-run`/`off` 可回滚 |

## 本版内容（决策 + 执行）

1. `modules/memory/controller.ts` 纯 reducer：user-message / tool-result / turn-end /
   memory-written → persist / lookup / request-model / track-task / expire-task；
   任务 TTL 在事件到达时清算，回合结束清空剩余任务。
2. 安全闸门：临时约束永不 persist、显式记住优先、纠正不自动写、工具结果不产生动作、
   同文本去重、候选/任务有界；疑问/命令/代码/偏好标记判据抽到
   `modules/memory/message-filter.ts`，捕获与控制器共用一份。
3. `capture.ts` 在 `execute` 模式执行动作：persist 走既有隐私/去重/冷启动写入并
   查回验证（id + contentHash）、lookup 走词法检索给旧 id 与 supersedes 用法、
   request-model 只注入一行；显式记住 `assertedBy=user`（已确认、不受上限），
   非显式推断 `assertedBy=model`（候选）。
4. execute 且自动捕获开启时抑制 proactive 提示，避免模型重复 `omb_remember`；
   `memoryController` 三档（execute/dry-run/off）；健康面 `controllerHealthNote()`
   区分执行与 dry-run，决策计数与执行计数分开。

详见 `docs/v4.7.0-memory-controller.md`。

## 文件

- 新增：`modules/memory/controller.ts`、`modules/memory/message-filter.ts`、
  `tests/modules/memory/controller.test.ts`、`docs/v4.7.0-memory-controller.md`
- 修改：`modules/memory/capture.ts`、`modules/memory/index.ts`、
  `tests/modules/memory/{capture,registration,status-honesty}.test.ts`、版本文件

## 仍未做（本版结束时）

- 不自动 supersedes（旧 id 交给模型核对）；
- 任务约束不跨会话/进程持久化；
- lookup 只走词法，不做向量/语义；
- 候选晋升命令仍未实现；
- 模型主动 `omb_remember` 与控制器写入之间仍无正文唯一约束（靠提示抑制降低重复概率）。

---

# OMB v4.8.0 交付记录（2026-10-20）

## 交付

| 项 | 结果 |
| --- | --- |
| 版本 | **4.8.0**（`24 功能 / 87 小功能`；x2 功能更新） |
| 构建 | **g109**；`generation: 109`、`outDir: lib-gen/g109`、`builtAt: 2026-10-19T18:44:49Z` |
| 门禁 | `tsc --noEmit` **0**；`eslint .` **0**；`vitest run` **117 files / 1433 passed | 1 skipped**；`node scripts/version.mjs` 一致 |
| 真机验收 | **待重启 `dsh web` 后核对**：`omb_status` 构建 109/109、版本 4.8.0；`/omb-confirm` 能列出候选并把阶段从"候选"改为"已确认"；重复 `omb_remember` 返回"未写入：库中已有同内容条目" |

## 本版内容

1. **`/omb-confirm [id]` 候选确认命令**（用户命令，不新增模型工具）：不带参数列出候选
   （每库最近 50 条里筛、最多 5 条）；带 id 把 `assertedBy` 从 `model` 改为 `user`，
   正文/id/来源/时间一字不改，写回后查回验证。sealed 不读、read-only/未知归属不写。
2. **跨写入路径同内容去重**：`remember.ts` 的 `findSameContent` 由捕获路径与
   `omb_remember` 共用；同内容命中时不写、不触发 `memory/written`/向量编码，回执给出
   已存在条目的 id/阶段（候选附 `/omb-confirm` 用法）。只认活跃条目，旧结论被取代后
   重写同一句仍会正常落库。
3. **健康面**：`confirm.commands/listed/promoted/refused`；记忆行只在按过命令后追加
   `候选确认：已确认 N 条（命令 M 次…）`，文案由 `confirmHealthNote()` 生成并有单测。
4. 配置新增 `confirmCommand`（默认 true），关掉只影响确认入口，候选本身仍在。

详见 `docs/v4.8.0-lifecycle-confirm-and-dedupe.md`。

## 文件

- 新增：`modules/memory/confirm.ts`、`tests/modules/memory/confirm.test.ts`、
  `docs/v4.8.0-lifecycle-confirm-and-dedupe.md`
- 修改：`modules/memory/remember.ts`、`modules/memory/capture.ts`、`modules/memory/index.ts`、
  `tests/modules/memory/{remember,registration,status-honesty}.test.ts`、
  `tests/modules/privacy/module.test.ts`、版本文件

## 仍未做（v4.8.0 结束时）

- 没有自动晋升（候选只能由用户确认，这是不变量）；
- 确认不可撤销（没有"退回候选"命令）；
- 候选列表有界（最近 50 条/库、最多显示 5 条），更早的候选从 `omb_recall` 回执拿 id 确认；
- 去重只认精确同内容，不做向量近似与跨作用域去重。

---

# OMB v4.8.1 交付记录（2026-10-20）

## 交付

| 项 | 结果 |
| --- | --- |
| 版本 | **4.8.1**（`24 功能 / 88 小功能`；x3 修复位：4.8.0 候选确认功能的收尾，不是独立功能） |
| 构建 | 中间版本不单独构建/部署；随下一个功能版本一起构建（代数以最终版本为准） |
| 门禁 | `tsc --noEmit` **0**；`eslint .` **0**；`vitest run` 全量通过；`node scripts/version.mjs` 一致 |
| 真机验收 | 不适用（中间版本）；撤销/审计随下一次重启一起核对 |

## 本版内容（4.8.0 功能的收尾）

1. **存储 schema v5**：只增审计表 `memory_confirm`（confirm/undo），v4→v5 纯加法；
   `SCHEMA_VERSION` 抬到 5，漂移自检继续生效；结构能力 `asConfirmStore`，
   探测不到时撤销 fail-closed。
2. **`/omb-confirm undo <id>...`**：只在"审计最后一次动作是 confirm + 条目仍活跃"时执行，
   只改 `assertedBy`（user→model），写回后查回验证；批量撤销 ≤10 条、逐条报告。
3. **`/omb-confirm log <id>`**：列出确认/撤销审计与当前状态（只读）。
4. **列表分页与年龄**：`list [offset]`，回执写明总数与"还有 N 条未显示"；
   候选超过 30 天未确认时给出 stale 建议。
5. 健康面新增 `confirm.undone/logged`，文案只在按过命令后出现。

详见 `docs/v4.8.1-confirm-undo-and-audit.md`。

## 文件

- 新增：`docs/v4.8.1-confirm-undo-and-audit.md`
- 修改：`kernel/abi/storage.ts`（SCHEMA_VERSION 5）、`modules/memory/migrate.ts`、
  `modules/memory/store.ts`（确认审计面）、`modules/memory/confirm.ts`、
  `modules/memory/index.ts`、`tests/modules/memory/*`、版本文件

## 仍未做

- 没有自动晋升/自动撤销（确认与撤销都是用户命令）；
- 撤销只逐条或 ≤10 条批量，没有"全库撤销"；
- 写入冲突提示不在本版（独立能力，见下一个功能版本）。

---

# OMB v4.9.0 交付记录（2026-10-20）

## 交付

| 项 | 结果 |
| --- | --- |
| 版本 | **4.9.0**（`24 功能 / 89 小功能`；x2 功能更新：写入冲突提示，独立于 4.8.0/4.8.1 的候选确认链路） |
| 构建 | **g111**；`generation: 111`、`outDir: lib-gen/g111`、`builtAt: 2026-10-19T18:57:07Z` |
| 门禁 | `tsc --noEmit` **0**；`eslint .` **0**；`vitest run` 全量通过；`node scripts/version.mjs` 一致 |
| 真机验收 | **待重启 `dsh web` 后核对**：`omb_status` 构建 111/111、版本 4.9.0；`omb_remember` 成功回执出现"可能的既有结论（只提示，未改库）"；`/omb-confirm <id>` 回执同样给出相关条目 |

## 本版内容（独立功能）

1. `link.ts` 新增只读 `findRelatedRecords`：同作用域、活跃、内容不同、共享实体键 ≥2
   的既有条目（每库候选 20、最多返回 3），失败返回空数组。
2. 通过 `MemoryWriteDeps.findRelated` 端口进入 `omb_remember` 成功回执与
   `/omb-confirm` 确认回执，作为"可能的既有结论"提示。
3. **不自动 supersedes、不自动拒绝写入、不建边、不改库**：判据只能证明"相关"，
   判断交给用户/模型。
4. 模块不直接依赖 `link.ts`（避免 remember → link → capture → remember 循环）。

详见 `docs/v4.9.0-conflict-hints.md`。

## 文件

- 新增：`docs/v4.9.0-conflict-hints.md`
- 修改：`modules/memory/link.ts`、`modules/memory/remember.ts`、`modules/memory/confirm.ts`、
  `modules/memory/index.ts`、`tests/modules/memory/{link-related,remember,confirm}.test.ts`、
  版本文件

## 仍未做

- 冲突提示是启发式：共享实体键说明"相关"，不保证"矛盾"；近义改写、无实体键的
  纯自然语言矛盾仍不可见（语义通道属后续）；
- 提示只出现在写入/确认回执，召回结果里不标注相关关系。

---

# OMB v4.9.1 交付记录（2026-10-20）

## 交付

| 项 | 结果 |
| --- | --- |
| 版本 | **4.9.1**（`24 功能 / 90 小功能`；x3 修复位：4.9.0 冲突提示的语义通道收尾，不是独立功能） |
| 构建 | **g112**；`generation: 112`、`outDir: lib-gen/g112`、`builtAt: 2026-10-19T19:01:11Z` |
| 门禁 | `tsc --noEmit` **0**；`eslint .` **0**；`vitest run` 全量通过；`node scripts/version.mjs` 一致 |
| 真机验收 | **待重启 `dsh web` 后核对**：`omb_status` 构建 112/112、版本 4.9.1；`omb_remember` 回执在向量可用时出现"语义相近"条目并标注通道；无嵌入器时退回词法 |

## 本版内容（4.9.0 功能收尾）

1. `link.ts` 新增 `findSemanticRelated`：嵌入新条目正文 → `searchVector`
   （归属 model/dim/revision 由库校验）→ 同作用域、活跃、内容不同、排除自身，最多 2 条。
2. 装配层 `relatedFor`：**先词法后语义**、按 id 去重、最多 3 条；无嵌入器/无向量/
   维度不符/检索异常时静默退回词法。
3. 回执标注判据来源：词法条目带共享键并标注"词法"，语义条目标注"语义"；
   标题写作"共享实体键 / 语义相近"。
4. 确认回执同样走这条合并通道（`ConfirmDeps.findRelated`）。

详见 `docs/v4.9.0-conflict-hints.md` §3.1。

## 文件

- 修改：`modules/memory/link.ts`、`modules/memory/remember.ts`、`modules/memory/confirm.ts`、
  `modules/memory/index.ts`、`tests/modules/memory/{link-related,remember,confirm}.test.ts`、
  `docs/v4.9.0-conflict-hints.md`、版本文件

## 仍未做

- 语义相似不等于矛盾：提示仍由用户/模型判断是否 supersedes；
- 向量通道依赖 `omb-memory-vector` 与已编码向量；未编码的近期条目不参与语义提示。
