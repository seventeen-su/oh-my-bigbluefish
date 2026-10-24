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

---

# OMB v4.9.2 交付记录（2026-10-20）

## 交付

| 项 | 结果 |
| --- | --- |
| 版本 | **4.9.2**（`24 功能 / 91 小功能`；x3 修复位：既有有效命中读数的细化，不是独立功能） |
| 构建 | **g113**；`generation: 113`、`outDir: lib-gen/g113`、`builtAt: 2026-10-19T19:03:27Z` |
| 门禁 | `tsc --noEmit` **0**；`eslint .` **0**；`vitest run` **117 files / 1453 passed | 1 skipped**；`node scripts/version.mjs` 一致 |
| 真机验收 | **待重启 `dsh web` 后核对**：`omb_status` 构建 113/113、版本 4.9.2；记忆行在"有效命中"后出现"命中排名 @1/@3/@5"，分母写明是使用命中数 |

## 本版内容（既有读数细化）

1. `usageTracker` 按召回顺序记录曝光排名；`used_tool` 命中时统计**使用命中的曝光排名**，
   同一 id 多次曝光取最好排名，分母是使用命中数（不是召回次数）。
2. 健康面新增 `retrieval.ranked/precisionAt1/precisionAt3/precisionAt5`，
   记忆行追加"命中排名 @1/@3/@5（used_tool 归因，分母是使用命中数）"。
3. `ranked=0` / 未接线时一个字不写（不印 "@1 0/0"）；文案由 `retrievalRankNote()` 生成。

详见 `docs/v4.9.2-retrieval-precision.md`。

## 文件

- 新增：`docs/v4.9.2-retrieval-precision.md`
- 修改：`modules/memory/feedback.ts`、`modules/memory/index.ts`、
  `tests/modules/memory/{utility-ledger,status-honesty}.test.ts`、版本文件

## 仍未做

- 这不是标注集上的 precision@k：没有被人用到的召回不进入分母；
- 只统计本进程，不做跨进程/跨模型对比实验。

---

# OMB v4.9.3 交付记录（2026-10-20）

## 交付

| 项 | 结果 |
| --- | --- |
| 版本 | **4.9.3**（`24 功能 / 92 小功能`；x3 修复位：既有项目证据功能的细化，不是独立功能） |
| 构建 | **g114**；`generation: 114`、`outDir: lib-gen/g114`、`builtAt: 2026-10-19T19:05:39Z` |
| 门禁 | `tsc --noEmit` **0**；`eslint .` **0**；`vitest run` 全量通过；`node scripts/version.mjs` 一致 |
| 真机验收 | **待重启 `dsh web` 后核对**：`omb_status` 构建 114/114、版本 4.9.3；`omb_project` L1 证据行出现"→ 文件"映射；旧的 `.omb/evidence.json`（v2）照常读取 |

## 本版内容（既有功能细化）

1. `extractEvidencePaths`：从命令里抽带扩展名的文件路径（相对/Windows 绝对路径），
   URL、目录、包名、符号不记；去重、按出现顺序、单条 ≤5 个；抽不出就不写 `paths`。
2. 证据落盘格式升 **v3**（paths 随条目写入）；v2 旧文件照常读取（路径缺省）；
   读取时对 paths 做类型过滤与截断。
3. `omb_project` L1 证据行追加文件映射（最多 2 个路径，更多写"等 N 个"）；
   `ProjectEvidenceView.paths` 与 `SERVICES.projectEvidence` 端口形状同步。

详见 `docs/v4.9.3-evidence-file-mapping.md`。

## 文件

- 新增：`docs/v4.9.3-evidence-file-mapping.md`
- 修改：`dsh/project-evidence.ts`、`modules/memory/project.ts`、`modules/memory/index.ts`、
  `tests/dsh/project-evidence.test.ts`、版本文件

## 仍未做

- 不解析符号（函数/类级映射需要类型解析）；
- 路径只表示"命令提到过"，不核验文件存在、也不声称测试覆盖范围；
- 命令里没写文件（如 `pnpm test` 跑全量）时没有映射，不猜。

---

# OMB v4.9.4 交付记录（2026-10-20）

## 交付

| 项 | 结果 |
| --- | --- |
| 版本 | **4.9.4**（`24 功能 / 93 小功能`；x3 修复位：项目画像细化 + 剩余项收口） |
| 构建 | **g115**；`generation: 115`、`outDir: lib-gen/g115` |
| 门禁 | `tsc --noEmit` **0**；`eslint .` **0**；`vitest run` 全量通过；`node scripts/version.mjs` 一致 |
| 真机验收 | **待重启 `dsh web` 后核对**：`omb_status` 构建 115/115、版本 4.9.4；`omb_project` 导入边包含跨 workspace 包名的文件边/调用边 |

## 本版内容

1. **包导出映射**：`readPackageEntryMap` 读 `packages/*/package.json` 的
   `main`/`types`/`typings`/`exports`；`resolveImportTarget` 在相对路径、tsconfig 别名之后
   按裸包名解析到仓库内入口文件（支持子路径），文件边/目录边/近似调用边都适用。
2. **剩余项收口**：`docs/v4-remaining-closure.md` 逐条给出处置与证据——
   类型图/三方合并 = 设计不变量，OOM 根因 = 宿主快照外部依赖，
   `dsh-path-guard selfProtection` = 用户设置；并列出已做项与能力边界。
3. AGENTS/README 的"仍未做"改为"已收口"，不再有可执行但无人做的条目。

详见 `docs/v4.9.4-import-graph-package-exports.md` 与 `docs/v4-remaining-closure.md`。

## 文件

- 新增：`docs/v4.9.4-import-graph-package-exports.md`、`docs/v4-remaining-closure.md`
- 修改：`dsh/project-profile.ts`、`tests/dsh/project-profile.test.ts`、
  `AGENTS.md`、`README.md`、版本文件

## 仍未做（能力边界，不是遗漏）

- 完整类型图/类型解析：需要 TS program，成本与画像预算冲突（见收口文档 §2.3）；
- 语义冲突提示依赖嵌入器与已编码向量；证据映射只到文件、不解析符号；
- precision@k 是使用归因口径，不是标注集评测。

---

# OMB v4.9.5 交付记录（2026-10-20）

## 交付

| 项 | 结果 |
| --- | --- |
| 版本 | **4.9.5**（`24 功能 / 93 小功能`；x3 修复位：命令简介与技能可见性收口） |
| 构建 | **g116**；`generation: 116`、`outDir: lib-gen/g116` |
| 门禁 | `tsc --noEmit` **0**；`eslint .` **0**；`vitest run` **117 files / 1460 passed | 1 skipped**；`node scripts/version.mjs` 一致 |
| 真机验收 | **待重启 `dsh web` 后核对**：`/` 菜单不再出现 `/omb-r*`；四个命令简介为新文案；`omb_status` 构建 116/116、版本 4.9.5 |

## 本版内容

1. **命令简介精简**（只改注册 description）：
   - `/omb-privacy`：设置当前对话的记忆隐私模式
   - `/omb-privacy-clean`：清理对话的隐私限制记录
   - `/omb-feedback`：标记记忆是否有用、过时或不对
   - `/omb-confirm`：确认候选记忆，可撤销
2. **过程卡隐藏 + 改名**：8 张技能 frontmatter 加 `user-invocable: false`（模型可加载、
   用户斜杠菜单不显示）；编号名改为 `omb-depth/goal/options/testable/cite/failure/honesty/conflict`，
   描述压到一行（≤120 字符、无括号）；常驻提示同步为 `过程卡见 skills：omb-depth 等。`
3. 测试改写字面量：`skills.test.ts` 钉住目录名/隐藏标记/短描述/正文锚点；
   `methods/module.test.ts` 跟随新提示与健康行。

详见 `docs/v4.9.5-naming-cleanup.md`。

## 文件

- 新增：`docs/v4.9.5-naming-cleanup.md`
- 修改：`modules/memory/{privacy/index,feedback,confirm}.ts`、`skills/omb-*`、
  `modules/reasoning/{methods,index}.ts`、`kernel/{abi/catalog,display}.ts`、
  `packages/reasoning/locale/{zh,en}.json`、`tests/modules/reasoning/{skills,methods,module}.test.ts`、
  `README.md`、`AGENTS.md`、版本文件

## 备注

- 旧技能 id `omb-r1…r8` 不再存在（有意收口）；
- 隐藏只影响用户菜单，模型技能目录仍可见（`modelInvocable` 保持 true）。

---

# OMB v4.9.6 交付记录（2026-10-20）

## 交付

| 项 | 结果 |
| --- | --- |
| 版本 | **4.9.6**（`24 功能 / 93 小功能`；x3 修复位：补齐 depth/heap 命令简介） |
| 构建 | **g117**；`generation: 117`、`outDir: lib-gen/g117` |
| 门禁 | `tsc --noEmit` **0**；`eslint .` **0**；`vitest run` 全量通过；`node scripts/version.mjs` 一致 |
| 真机验收 | **待重启 `dsh web` 后核对**：`/` 菜单六个命令简介为新文案；`omb_status` 构建 117/117、版本 4.9.6 |

## 本版内容

补齐上一版漏掉的两个用户命令简介（只改注册 description）：

- `/omb-depth`：设置本会话的思考深度
- `/omb-heap`：查看进程内存，可抓堆快照排查

六个用户命令现在统一为一行、无括号、无实现细节：参数枚举在 `input.hint`，
副作用（暂停事件循环、影响 reasoningEffort）留在回执与文档里。

详见 `docs/v4.9.6-depth-heap-descriptions.md`。

## 文件

- 新增：`docs/v4.9.6-depth-heap-descriptions.md`
- 修改：`dsh/depth-command.ts`、`dsh/heap-command.ts`、`README.md`、`AGENTS.md`、版本文件

---

# OMB v4.9.7 交付记录（2026-10-24）

## 交付

| 项 | 结果 |
| --- | --- |
| 版本 | **4.9.7**（`24 功能 / 93 小功能`；x3 修复位：用户断言模糊去重 + 压缩后追忆） |
| 构建 | **g118**；`generation: 118`、`outDir: lib-gen/g118` |
| 门禁 | `tsc --noEmit` **0**；`eslint .` **0**；`vitest run` **117 files / 1465 passed | 1 skipped**；`node scripts/version.mjs` 一致 |
| 真机验收 | **待重启 `dsh web` 后核对**：压缩后追忆旧断言不再被拒；用户断言命中候选时回执出现"已升级" |

## 本版内容

1. **模糊同内容判据**：`findSimilarContent` 在内容哈希之外用归一化 bigram（Dice ≥0.9）
   判近似；**数字不同不合并**（端口/版本/序号/测试名是事实）；仅认活跃、同 scope。
2. **用户断言升级**：用户断言命中既有候选/事件时，就地改 `assertedBy:user`
   （正文/id/sourceRef/observedAt 不改），回执"已升级"；已确认再写回执"无需重写"。
3. **压缩后兜底**：当前上下文无原话、但库里已有同内容且 `assertedBy:user` 时，
   记 `verification='previously-verified'` 继续写入；没有既有已确认记录仍拒绝。
4. 捕获路径与 `omb_remember` 共用同一模糊判据（`alreadyStored` 也改用 `findSimilarContent`）。

详见 `docs/v4.9.7-fuzzy-dedupe.md`。

## 文件

- 新增：`docs/v4.9.7-fuzzy-dedupe.md`
- 修改：`modules/memory/remember.ts`、`modules/memory/capture.ts`、
  `tests/modules/memory/remember.test.ts`、`README.md`、`AGENTS.md`、版本文件

---

# OMB v4.10.0 交付记录（2026-10-24）

## 交付

| 项 | 结果 |
| --- | --- |
| 版本 | **4.10.0**（`24 功能 / 95 小功能`；x2 新功能：检索过滤与模糊回退） |
| 构建 | **g119**；`generation: 119`、`outDir: lib-gen/g119` |
| 门禁 | `tsc --noEmit` **0**；`eslint .` **0**；`vitest run` **118 files / 1474 passed | 1 skipped**；`node scripts/version.mjs` 一致 |
| 真机验收 | **待重启 `dsh web` 后核对**：旧库打开后 schema v6；`omb_recall` 可用 status/tags/fuzzy；标签写读正常 |

## 本版内容

1. **schema v6**：`memory.tags`（JSON 数组，默认 `[]`，纯加法）；`SCHEMA_VERSION=6`；
   写入校验 ≤8 个、每个 ≤24 字符、去重；读库归一为 `[]`。
2. **omb_remember** 新增可选 `tags`；召回头部显示标签。
3. **omb_recall** 新增 `status`（active/stale/superseded/all）、`tags`（AND）、`fuzzy`（默认开）；
   过滤在 SQL 下推（`json_each`），非 JS 事后裁剪；显式查非活跃时跳过兜底过滤与过时探测。
4. **模糊回退**：词法 0 命中时 `searchFuzzy` 用 `LIKE ESCAPE` 有界子串匹配，通道标 `fuzzy`，
   信号显示"模糊子串"；`fuzzy=false` 为严格词法对照。
5. 测试：schema v6、标签往返/非法拒绝、AND 过滤、状态过滤、子串命中与对照；
   版本断言全部抬到 6。

详见 `docs/v4.10.0-retrieval-filters.md`。

## 文件

- 新增：`docs/v4.10.0-retrieval-filters.md`、`tests/modules/retrieval/filter-fuzzy.test.ts`
- 修改：`kernel/abi/{storage,ports,index}.ts`、`modules/memory/{migrate,store,retrieve,recall,remember}.ts`、
  `tests/modules/memory/*`、`README.md`、`AGENTS.md`、版本文件

## 备注

- 这是第 2 项指令；第 1 项（用户断言模糊去重）已在 4.9.7 交付。
- 后续项（离线整合取消、崩溃验证/日志、跨工作区状态机、控制器重构、主动性、侧边栏 UI）仍在目标中。

---

# OMB v4.10.1 交付记录（2026-10-24）

## 交付

| 项 | 结果 |
| --- | --- |
| 版本 | **4.10.1**（`24 功能 / 96 小功能`；x3：取消离线整合、写入时确定性去重） |
| 构建 | **g120**；`generation: 120`、`outDir: lib-gen/g120` |
| 门禁 | `tsc --noEmit` **0**；`eslint .` **0**；`vitest run` **116 files / 1449 passed | 1 skipped**；`node scripts/version.mjs` 一致 |
| 真机验收 | **待重启 `dsh web` 后核对**：版本 4.10.1/构建 120；健康面不再出现"离线整合"读数；重复写入仍按确定性判据处理 |

## 本版内容

1. 删除 `modules/memory/consolidate.ts`（0.7 近似合并、自动 supersedes/conflicts_with 边）、
   `turn/end` 订阅、`consolidationEveryTurns` 配置、整合台账与健康读数、预设行。
2. 写入路径维持并明确确定性去重：`contentHash` 精确 / 归一化 bigram ≥0.9（数字不同不合并）；
   用户断言命中候选就地升级；**不自动标失效**（supersedes 只能显式给出）。
3. 新测试：数字不同的近似内容不合并、两条都保持有效；既有模糊去重/升级/压缩兜底用例保留。
4. 清理 `consolidate.ts` 相关注释与测试（删除 2 个测试文件）。

详见 `docs/v4.10.1-write-time-dedupe.md`。

## 文件

- 删除：`modules/memory/consolidate.ts`、`tests/modules/retrieval/consolidate.test.ts`、
  `tests/modules/memory/consolidation-wiring.test.ts`
- 修改：`modules/memory/{index,remember,retrieve,store,recall}.ts`、`cordis.patch.yml`、
  `tests/modules/memory/{registration,remember}.test.ts`、`README.md`、`AGENTS.md`、版本文件

## 备注

- 这是第 4 项指令；剩余：崩溃验证/日志、跨工作区状态机与项目认知、控制器重构、主动性、侧边栏 UI。

---

# OMB v4.11.0 交付记录（2026-10-24）

## 交付

| 项 | 结果 |
| --- | --- |
| 版本 | **4.11.0**（`24 功能 / 97 小功能`；x2 新功能：活动日志 + 崩溃窗口验证） |
| 构建 | **g121**；`generation: 121`、`outDir: lib-gen/g121` |
| 门禁 | `tsc --noEmit` **0**；`eslint .` **0**；`vitest run` **118 files / 1456 passed | 1 skipped**；`node scripts/version.mjs` 一致 |
| 真机验收 | **待重启 `dsh web` 后核对**：版本 4.11.0/构建 121；`omb_status` 记忆行出现"活动："读数；写入/召回后活动更新 |

## 本版内容

1. `modules/memory/activity.ts`：有界环形（200 条）活动日志，记录
   write/dedupe/promote/abstain/retrieve/confirm/error；详情截断、不含正文、不落盘；
   健康面只列发生过的事件、错误单列（`renderActivityNote`）。
2. 接线：`omb_remember` 写入/去重/升级/弃权/异常、`omb_recall` 检索、`/omb-confirm` 动作。
3. `tests/dsh/project-evidence-crash.test.ts`：子进程真实 SIGKILL 后验证 evidence.json
   仍是完整 JSON、可读回、无 `.corrupt-*` 现场（原子替换）。
4. 测试：活动日志 5 用例 + remember 活动事件断言 + SIGKILL 崩溃窗口用例。

详见 `docs/v4.11.0-activity-log-and-crash-tests.md`。

## 边界

- 活动日志不是审计（审计在 `memory_confirm`/`memory_feedback` 表），进程重启即清空；
- 崩溃验证只覆盖证据文件原子写；SQLite 的崩溃恢复由 SQLite/WAL 自身保证，未做 kill 测试。

## 文件

- 新增：`modules/memory/activity.ts`、`tests/modules/memory/activity.test.ts`、
  `tests/dsh/project-evidence-crash.test.ts`、`docs/v4.11.0-activity-log-and-crash-tests.md`
- 修改：`modules/memory/{index,remember}.ts`、`README.md`、`AGENTS.md`、版本文件

---

# OMB v4.12.0 交付记录（2026-10-24）

## 交付

| 项 | 结果 |
| --- | --- |
| 版本 | **4.12.0**（`24 功能 / 99 小功能`；x2 新功能：跨工作区状态机 + 文件索引） |
| 构建 | **g122**；`generation: 122`、`outDir: lib-gen/g122` |
| 门禁 | `tsc --noEmit` **0**；`eslint .` **0**；`vitest run` **118 files / 1460 passed | 1 skipped**；`node scripts/version.mjs` 一致 |
| 真机验收 | **待重启 `dsh web` 后核对**：`omb_project` L0 出现"本会话切换工作区 N 次"，L1 出现"文件索引"；版本 4.12.0/构建 122 |

## 本版内容

1. **跨工作区状态机**：`situation()` 惰性记录会话的 `workspace`
   `{root, cwd, since, switches, previousRoot}`；`rootOf` 由 `dsh/plugin.ts` 注入
   （git root 判定，子目录变化不算切换）；`omb_project` L0 显示切换次数/上一处。
2. **文件索引**：`ProjectProfileStructure.files`（`path/lines/symbols/imports`）按
   符号+导入数排序前 12；`omb_project` L1 显示前 4；确定性排序，复用同一次扫描。
3. 测试：状态机 root 切换用例、项目工具 L0/L1 用例、画像 files 排序/确定性用例。

详见 `docs/v4.12.0-workspace-state-and-file-index.md`。

## 文件

- 新增：`docs/v4.12.0-workspace-state-and-file-index.md`
- 修改：`dsh/{state-machine,project-profile,plugin}.ts`、`modules/memory/project.ts`、
  `tests/dsh/{state-machine,project-profile}.test.ts`、`tests/modules/memory/project-tool.test.ts`、
  `README.md`、`AGENTS.md`、版本文件

---

# OMB v4.13.0 交付记录（2026-10-24）

## 交付

| 项 | 结果 |
| --- | --- |
| 版本 | **4.13.0**（`24 功能 / 100 小功能`；x2：事件控制器显式状态机） |
| 构建 | **g123**；`generation: 123`、`outDir: lib-gen/g123` |
| 门禁 | `tsc --noEmit` **0**；`eslint .` **0**；`vitest run` **118 files / 1463 passed | 1 skipped**；`node scripts/version.mjs` 一致 |
| 真机验收 | **待重启 `dsh web` 后核对**：版本 4.13.0/构建 123；健康面控制器行出现失败分类/幂等跳过（仅在有发生时） |

## 本版内容

1. `ControllerSessionState` 增加 `phase`（idle/candidate-pending/tracking-tasks/mixed）
   与 `transition`（事件→阶段→动作）；由表内容推导，不在各分支各写一份。
2. 动作带确定性 `id`；`persist` 每会话幂等（最近 64 个候选 id），重复投递计
   `duplicateActions` 并跳过。
3. `ControllerStats.failures` 按 8 类统计（privacy/dedupe/cap/disabled/store-missing/
   verify-failed/lookup-failed/unknown）；健康面只在有失败时列 "失败分类：…"，
   metrics 按类输出。
4. 控制器动作/失败接入活动日志（`controller`/`error`，不含正文）。

详见 `docs/v4.13.0-controller-state-machine.md`。

## 文件

- 新增：`docs/v4.13.0-controller-state-machine.md`
- 修改：`modules/memory/{controller,capture,activity,index}.ts`、
  `tests/modules/memory/{controller,capture,status-honesty}.test.ts`、
  `README.md`、`AGENTS.md`、版本文件

---

# OMB v4.14.0 交付记录（2026-10-24）

## 交付

| 项 | 结果 |
| --- | --- |
| 版本 | **4.14.0**（`24 功能 / 101 小功能`；x2：主动提示扩展与跟进） |
| 构建 | **g124**；`generation: 124`、`outDir: lib-gen/g124` |
| 门禁 | `tsc --noEmit` **0**；`eslint .` **0**；`vitest run` **118 files / 1466 passed | 1 skipped**；`node scripts/version.mjs` 一致 |
| 真机验收 | **待重启 `dsh web` 后核对**：版本 4.14.0/构建 124；`omb_status` 记忆行出现"主动提示：命中 N 次"（仅在发生时） |

## 本版内容

1. `proactive.ts` 新增 `recall-first`（引用过去结论先 omb_recall）与
   `project-fact`（路径/命令/端口/版本/URL → 记 semantic 项目库并写来源）两类 cue。
2. execute 模式不再整体抑制提示：控制器精确提示优先；控制器没写时才给 cue
   （task-constraint 仍由 nudge 专门措辞）。
3. 未写入的 cue 在**下一条用户消息**给一次跟进（仅 execute 且偏好捕获开启；
   task-constraint 不跟进；回合结束保留 pendingCue 供下一轮判断）。
4. 活动日志加 `proactive`；`CaptureStats.proactiveCues/cueFollowUps`；
   健康面与 metrics 只报发生过的读数。
5. 用户补充的版本纪律写入 AGENTS：**新界面（含侧边栏 UI）也只升 x2，只有重构才升 x1**。

详见 `docs/v4.14.0-proactive-initiative.md`。

## 文件

- 新增：`docs/v4.14.0-proactive-initiative.md`
- 修改：`modules/memory/{proactive,capture,activity,index}.ts`、
  `tests/modules/memory/{proactive,capture}.test.ts`、`README.md`、`AGENTS.md`、版本文件

---

# OMB v4.15.0 交付记录（2026-10-24）

## 交付

| 项 | 结果 |
| --- | --- |
| 版本 | **4.15.0**（`24 功能 / 102 小功能`；x2：管理侧边栏，按用户口径新界面不升 x1） |
| 构建 | **g125**；`generation: 125`、`outDir: lib-gen/g125`、7 个组件包指向本代 |
| 门禁 | `tsc --noEmit` **0**；`eslint .` **0**；`vitest run` **120 files / 1474 passed | 1 skipped**；`node scripts/version.mjs` 一致 |
| 浏览器 bundle | `node --check packages/memory/client.js` 通过；`dsh.client` 声明（platform web、immediately）保留在 `packages/memory/package.json` |
| 真机验收 | **待重启 `dsh web` 后核对**：侧边栏出现"OMB 记忆"图标；概览/记忆库/候选/详情可读；`/omb/api/overview` 返回 JSON；版本 4.15.0/构建 125 |

## 本版内容

1. `modules/memory/ui.ts`：只读服务 `omb:ui`（overview/list/candidates/detail），
   数据源 `StoresService.snapshot()`；单页 ≤50、候选 ≤20、详情审计 ≤20、扫描 ≤500 行/库。
2. `dsh/ui-route.ts`：宿主 `webServer` 的 `/omb/api` 前缀路由，仅 GET、同源检查、
   no-store、服务缺席 503、无 webServer 不注册。
3. `packages/memory/client.js`：手写 `window.__ModuleLoader__` bundle，
   注册 `main`（key=omb-memory）与 `sidebar.panellist`；数据走 fetch。
4. 服务接线：记忆模块 `provide(SERVICES.ui)`，注销顺序含 ui 服务。
5. **写操作仍走 `/omb-confirm`**：UI 只读，不写库、不自动 supersede（写入口留给下一版 x3）。

详见 `docs/v4.15.0-sidebar-ui.md`。

## 文件

- 新增：`modules/memory/ui.ts`、`dsh/ui-route.ts`、`packages/memory/client.js`、
  `tests/modules/memory/ui.test.ts`、`tests/dsh/ui-route.test.ts`、`docs/v4.15.0-sidebar-ui.md`
- 修改：`modules/memory/index.ts`、`packages/memory/{index.ts,package.json}`、
  `kernel/abi/catalog.ts`、`README.md`、`AGENTS.md`、版本文件

---

# OMB v4.15.1 交付记录（2026-10-24）

## 交付

| 项 | 结果 |
| --- | --- |
| 版本 | **4.15.1**（`24 功能 / 102 小功能`；x3：4.15.0 侧边栏同功能收尾） |
| 构建 | **g126**；`generation: 126`、`outDir: lib-gen/g126` |
| 门禁 | `tsc --noEmit` **0**；`eslint .` **0**；`vitest run` **120 files / 1477 passed | 1 skipped**；`node scripts/version.mjs` 一致 |
| 浏览器 bundle | `node --check packages/memory/client.js` 通过 |
| 真机验收 | **待重启 `dsh web` 后核对**：候选详情出现"确认为已确认"，点击后阶段变化并刷新审计/列表；撤销确认同理；版本 4.15.1/构建 126 |

## 本版内容

1. `confirm.ts` 新增 `createConfirmAction(confirmDeps)`：复用 `/omb-confirm` 的
   promote/undo（查库、形态校验、写回、查回、审计、相关条目、观测口）。
2. `modules/memory/ui.ts` 新增 `act(id, action, sessionId?)`，与命令同一实现；
   未启用确认命令时如实拒绝。
3. `dsh/ui-route.ts` 新增 `POST /omb/api/confirm`：仅 JSON（415）、校验 id/action（400）、
   成功 200 / 业务拒绝 409；同源检查、no-store 沿用。
4. 客户端详情面板：候选→确认按钮、已确认且审计最后动作为 confirm→撤销按钮；
   动作后刷新详情/列表/概览并展示服务端回执。
5. **没有模型工具入口**；审计 sessionId 为 null（全局面板不绑定会话）。

详见 `docs/v4.15.1-sidebar-confirm-actions.md`。

## 文件

- 新增：`docs/v4.15.1-sidebar-confirm-actions.md`
- 修改：`modules/memory/{confirm,ui,index}.ts`、`dsh/ui-route.ts`、
  `packages/memory/client.js`、`tests/modules/memory/ui.test.ts`、
  `tests/dsh/ui-route.test.ts`、`README.md`、`AGENTS.md`、版本文件

---

# OMB v4.15.2 交付记录（2026-10-24）

## 交付

| 项 | 结果 |
| --- | --- |
| 版本 | **4.15.2**（`24 功能 / 102 小功能`；x3：4.15.0 侧边栏同功能收尾） |
| 构建 | **g127**；`generation: 127`、`outDir: lib-gen/g127` |
| 门禁 | `tsc --noEmit` **0**；`eslint .` **0**；`vitest run` **120 files / 1478 passed | 1 skipped**；`node scripts/version.mjs` 一致 |
| 真机验收 | **待重启 `dsh web` 后核对**：侧边栏出现"运行状态""项目画像"页签；运行状态显示版本/库/隐私/控制器/活动；画像显示根/分支/文件索引；版本 4.15.2/构建 127 |

## 本版内容

1. `ui.runtime()`：读已有台账（版本、库状态、隐私闸门 decideUnattributed、
   控制器/捕获读数、活动日志摘要与最近 8 条），不新增订阅。
2. `ui.profile()`：经 `SERVICES.projectProfile.read(activeSession.cwd())` 返回
   项目根/cwd 相对根/分支/HEAD/顶层目录/文件索引/画像摘要（≤1500 字符）；
   无 cwd 或服务未接线时如实返回原因。
3. 路由 `GET /omb/api/runtime`、`GET /omb/api/profile`（只读、同源、no-store）。
4. 客户端新增"运行状态""项目画像"两页签。

详见 `docs/v4.15.2-sidebar-runtime-profile.md`。

## 文件

- 新增：`docs/v4.15.2-sidebar-runtime-profile.md`
- 修改：`modules/memory/{ui,index}.ts`、`dsh/ui-route.ts`、`packages/memory/client.js`、
  `tests/modules/memory/ui.test.ts`、`tests/dsh/ui-route.test.ts`、
  `README.md`、`AGENTS.md`、版本文件

---

# OMB v4.15.3 交付记录（2026-10-24）

## 交付

| 项 | 结果 |
| --- | --- |
| 版本 | **4.15.3**（`24 功能 / 102 小功能`；x3：4.15.0 侧边栏同功能收尾） |
| 构建 | **g128**；`generation: 128`、`outDir: lib-gen/g128` |
| 门禁 | `tsc --noEmit` **0**；`eslint .` **0**；`vitest run` **120 files / 1480 passed | 1 skipped**；`node scripts/version.mjs` 一致 |
| 真机验收 | **待重启 `dsh web` 后核对**：详情页"可能相关/冲突"条目出现「建立关联」「本条取代该条」；动作后状态/图边可见；版本 4.15.3/构建 128 |

## 本版内容

1. `UiService.resolve({action: 'relate'|'supersede', fromId, toId})`：
   - `relate`：`related` 边（普通关联，无时序含义）；
   - `supersede`：旧条目 `validTo=max(now, observedAt)` + `supersededBy=fromId`，
     并建 `supersedes` 边（与 `omb_remember(supersedes=…)` 同一语义，非破坏）。
2. 判据：两条存在、不同、同作用域同库、都活跃；写后查回验证；边失败如实分档。
3. `POST /omb/api/resolve`（JSON、同源、200/409/400）；活动日志记 `write`（不含正文）。
4. 客户端详情页相关条目给两个裁决按钮，动作后刷新详情/列表/概览。
5. **没有模型工具入口**：仍是用户点击（本机回环 + 同源）。

详见 `docs/v4.15.3-sidebar-conflict-resolution.md`。

## 文件

- 新增：`docs/v4.15.3-sidebar-conflict-resolution.md`
- 修改：`modules/memory/{ui,index}.ts`、`dsh/ui-route.ts`、`packages/memory/client.js`、
  `tests/modules/memory/ui.test.ts`、`tests/dsh/ui-route.test.ts`、
  `README.md`、`AGENTS.md`、版本文件

---

# OMB v4.15.4 交付记录（2026-10-24）

## 交付

| 项 | 结果 |
| --- | --- |
| 版本 | **4.15.4**（`24 功能 / 102 小功能`；x3：4.15.x 收尾） |
| 构建 | **g129**；`generation: 129`、`outDir: lib-gen/g129` |
| 门禁 | `tsc --noEmit` **0**；`eslint .` **0**；`vitest run` **121 files / 1482 passed | 1 skipped**；`node scripts/version.mjs` 一致 |
| 真机验收 | **待重启 `dsh web` 后核对**：运行状态页出现"会话状态机"（状态/回合/空闲/目标/待办/工作区切换）；版本 4.15.4/构建 129 |

## 本版内容

1. `UiRuntime.situation`：`activeSession.current()` + `sessionState.situation()` 的
   state/tier/turn/idle/lastTurnEndReason/interrupted/unresolved/goals/todos/
   workspace{root,switches,previousRoot,since}；页面"运行状态"新增"会话状态机"一节。
2. `tests/dsh/ui-bundle.test.ts`：钉住 `dsh.client`、`exports["./client"]`、文件存在、
   `__ModuleLoader__`/id/slots/写端点，防部署漂移。

详见 `docs/v4.15.4-runtime-situation-and-bundle-contract.md`。

## 文件

- 新增：`tests/dsh/ui-bundle.test.ts`、`docs/v4.15.4-runtime-situation-and-bundle-contract.md`
- 修改：`modules/memory/{ui,index}.ts`、`packages/memory/client.js`、
  `tests/modules/memory/ui.test.ts`、`README.md`、`AGENTS.md`、版本文件

---

# 九项升级总验收（OMB 4.9.7 → 4.15.4，2026-10-24）

用户指令是"按 9 条自主完成 OMB 记忆系统升级；每项都要有测试、文档、版本按 x1.x2.x3、
构建与部署同步并核验"。逐项证据如下（全部已推送、部署副本与 HEAD 一致）：

| 指令 | 交付 | 版本 | 契约/证据 |
| --- | --- | --- | --- |
| ① 用户断言模糊去重（压缩后追忆不被全量匹配拒绝） | `findSimilarContent` 归一化 bigram ≥0.9（数字不同不合并）；用户断言命中候选就地升级；压缩后 `previously-verified` 放行 | 4.9.7（x3） | `docs/v4.9.7-fuzzy-dedupe.md`、remember 测试 |
| ② 检索模糊搜索 + 类型/状态/标签过滤 | schema v6 `memory.tags`；`omb_recall` 的 `status/tags/fuzzy`；SQL 下推（`json_each`），词法 0 命中走 LIKE 回退 | 4.10.0（x2） | `docs/v4.10.0-retrieval-filters.md`、filter-fuzzy 测试 |
| ③ 侧边栏前端 UI（记忆库/状态机/画像/确认/审计/冲突） | 侧边栏"OMB 记忆"面板：概览、记忆库（搜索/过滤/详情/审计/相关）、候选确认（确认/撤销）、运行状态（控制器/会话状态机/隐私/活动）、项目画像（目录/文件索引）；手动冲突裁决（关联/取代） | 4.15.0→4.15.4（x2 + x3 收尾） | `docs/v4.15.0..4.15.4-*.md`、ui/ui-route/ui-bundle 测试 |
| ④ 取消每 32 回合离线整合，改写入时确定性去重 | 删除 `consolidate.ts`、`turn/end` 订阅与配置；去重只在写入路径（contentHash / bigram ≥0.9，不自动 supersede） | 4.10.1（x3） | `docs/v4.10.1-write-time-dedupe.md` |
| ⑤ 崩溃验证 + 日志系统 | 有界活动日志（200 条，7+2 类动作，健康面/metrics）；SIGKILL 子进程验证证据文件原子写 | 4.11.0（x2） | `docs/v4.11.0-activity-log-and-crash-tests.md` |
| ⑥ 跨工作区状态机 + 文件索引级项目认知 | `situation().workspace`（git root 切换计数/上一处）；画像 `files`（符号+导入排序前 12），L1 显示前 4 | 4.12.0（x2） | `docs/v4.12.0-workspace-state-and-file-index.md` |
| ⑦ 系统化事件驱动控制器 | `phase` + `transition` 转移审计；动作 id 与 persist 幂等；8 类失败分类；控制器动作进活动日志 | 4.13.0（x2） | `docs/v4.13.0-controller-state-machine.md` |
| ⑧ 提高模型自主记忆主动性 | 新增 `recall-first`/`project-fact` cue；控制器精确提示优先、未写才提示；未写入 cue 下一轮跟进 | 4.14.0（x2） | `docs/v4.14.0-proactive-initiative.md` |
| ⑨ 其它修复与优化 | 去重后升级/候选确认/审计撤销、状态面诚实性、ACTIVITY 边界、bundle 发布契约、运行状态页、测试加固等 | 见上各版 | 各版 doc + 全量测试 |

## 最终门禁与部署

- `tsc --noEmit` 0；`eslint .` 0；`vitest run` **121 files / 1482 passed | 1 skipped**；
- `node scripts/version.mjs`：4.15.4（24 功能 / 102 小功能）一致；`build-generation.json` = **g129**；
- git：HEAD = origin/main = `92961e5`，工作树干净；部署副本已同步 g129 并 relink 8/8，
  `@omb/plugin` 部署版本 = **4.15.4**，`@omb/memory/client.js` 存在且包含侧边栏注册；
- **唯一未做的一步是浏览器页面级人工确认**：需要用户重启 `dsh web` 后打开侧边栏核对
  （本会话无法重启宿主进程，也不应另起替代服务器）。重启后应看到：版本 4.15.4/构建 129、
  侧边栏 OMB 记忆图标、五个页签、候选确认/撤销、冲突关联/取代、运行状态含会话状态机、项目画像。

---

# OMB v4.16.0 交付记录（2026-10-24）

## 交付

| 项 | 结果 |
| --- | --- |
| 版本 | **4.16.0**（`24 功能 / 102 小功能`；x2：侧边栏控件与弹性排版规范化） |
| 构建 | **g130**；`generation: 130`、`outDir: lib-gen/g130` |
| 门禁 | `tsc --noEmit` **0**；`eslint .` **0**；`vitest run` **121 files / 1487 passed | 1 skipped**；`node scripts/version.mjs` 一致 |
| 真机验收 | **待重启 `dsh web` 后核对**：页签/输入/按钮为 DSH 标准控件；窄窗口自动堆叠；未选条目时详情为空态且 Network 无 `/detail` 无 id 请求 |

## 本版内容

1. **修复 HTTP 400 missing id（前端 bug）**：详情组件挂载时 `selectedId=null` 仍请求
   `/omb/api/detail`，参数被跳过 → 请求无 id → 宿主 400 → 前端误显示错误。
   现在 effect 先判空再请求；空态显示"从左侧选择一条记忆"。
2. **标准控件**：浏览器 bundle 复用 `@deepseek-ai/dsh-client-ui-primitives` 的
   Button/Input/Pill/Tag/SegmentedTabs/SegmentedControl/StateDot；
   颜色/圆角走 `--dsw-*` token，不写死色值。
3. **弹性排版**：页面 flex 纵向、列表/详情独立滚动、卡片 `auto-fit minmax`、
   工作区窄单列/宽两列 `minmax(0,5fr)/minmax(0,7fr)`。
4. **其它修复**：候选先过滤再截断；概览 `scanLimited` 如实标注 500 行扫描上限；
   搜索输入防抖（不再每键一次请求）；宿主护栏按"文件+说明符"放行浏览器共享模块请求并防过期例外。

详见 `docs/v4.16.0-sidebar-ui-standardization.md`。

## 文件

- 修改：`packages/memory/client.js`、`modules/memory/ui.ts`、
  `tests/dsh/{ui-bundle,no-host-imports}.test.ts`、`tests/modules/memory/ui.test.ts`、
  `README.md`、`AGENTS.md`、版本文件
- 新增：`docs/v4.16.0-sidebar-ui-standardization.md`

---

# OMB v4.17.0 交付记录（2026-10-24）

## 交付

| 项 | 结果 |
| --- | --- |
| 版本 | **4.17.0**（`24 功能 / 104 小功能`；x2：OMB 设置页二级侧边栏/动效与会话隐私管理） |
| 构建 | **g132**；`generation: 132`、`outDir: lib-gen/g132` |
| 门禁 | `tsc --noEmit` **0**；`eslint .` **0**；`vitest run` **121 files / 1498 passed | 1 skipped**；`node scripts/version.mjs` 一致 |
| 真机验收 | **待重启 `dsh web` 后核对**：标题「OMB 设置」、左侧二级侧边栏、窄容器图标轨、详情栏未选中时收起、会话隐私页读写、动效与 `prefers-reduced-motion` |

## 本版内容（对应用户六点）

1. **响应式 + 弹性**：`container-type: inline-size` + `@container omb-panel`
   （720px 展开导航文字、900px 列表/详情并排），flex/grid、`minmax(min(180px,100%),1fr)`、
   `min-width:0` 与独立滚动；触屏放大点击目标。
2. **二级侧边栏而非顶部菜单栏**：主导航改为左侧 `nav`（六项，`aria-current="page"`），
   `SegmentedTabs` 主导航移除；窄容器收成 46px 图标轨（`title` 保留文字）。
3. **DSH 标准控件**：Button/Input/Pill/Tag/SegmentedControl/StateDot 与标准图标来自
   `@deepseek-ai/dsh-client-ui-primitives`；颜色/圆角/焦点环走 `--dsw-*`。
4. **优雅动效**：页面 160ms 淡入、详情栏 220ms `flex-basis`/`translateX` 展开收起、
   hover 100–120ms；`prefers-reduced-motion: reduce` 取消运动。**未选中条目时详情栏收起**
   （`data-detail="closed"` + `inert` + `aria-hidden`），Escape/关闭按钮/再次点同行均可收起。
5. **命令消失排查**：根因是 DSH 客户端斜杠菜单规则——带 `input.hint` 的命令只在 `/`
   位于草稿最前（leading）时显示（`ui-commands` 的 `c.position` 过滤、`ui-input-trigger`
   的 `draft.search(/\S/) === index` 计算；`+` 菜单同样按草稿前缀算 position）。
   OMB 六个命令与 `/goal`、`/plan`、`/feedback` 都带 hint，因此草稿里 `/` 前有文字时
   整类消失；`/compact`、`/export`、`/file`、`/model`（无 hint）仍显示。
   会话日志佐证 OMB 命令确实执行过（`/omb-privacy` 8 次等），注册与执行正常。
   本轮未改 DSH 客户端（跨仓库），文档给出可用性建议与 DSH 侧最小改法。
6. **标题与隐私页**：`TITLE = 'OMB 设置'`（面板 label 与 h2 同源）；新增「会话隐私」页：
   基线/当前会话解析/状态文件/受限会话（未测量不写 0）/当前会话一键设置/按会话 id 设置/
   显式设置列表（活跃、继承来源、父会话）/危险操作二次确认/命令面与拒绝计数。
   数据面 `UiPrivacyView` + `PrivacyAdminPort`，`GET/POST /omb/api/privacy`
   （set/clear/clear-inactive/trust；400/409；同源、no-store、415、4KB）；
   **没有模型工具入口**。

## 自主阶段追加（界面打磨与补漏）

- 品牌头（图标块 + 实时状态点）、页头分隔线、内容最大宽 1120px；
- 二级导航条目计数（活跃/候选）、每页标题 + 一句话说明、概览快捷入口；
- 加载态统一 `TextShimmer`；空状态用虚线容器 + 标题 + 建议；
- 卡片改用 DSH 设置页同源 token（`--dsw-alias-settings-card-fill/stroke`）；
- 隐私操作结果改为顶部通知条（`StateDot` + `aria-live`），危险操作改标准 `Modal` 二次确认；
- 首屏 `loading` 初值 true 消除"暂无数据"闪帧；详情 404 友好空态；详情等待首帧不闪空态；
- 隐私分段控件首屏显示真实档位（避免误点放宽 sealed）；按会话 id 设置限 200 字符；
- **补漏**：批量清理"已结束会话"不再把宿主当前会话当已结束（避免刚设的档位被顺手放宽），
  设置页 `active` 展示用同一判据；
- 技能护栏：responsive audit A1/A3/A4 全过；motion audit 0 硬违规（reduced-motion 用
  `transition: none` 已注释说明无 `transitionend` 依赖）。

## 已知边界

- 浏览器视觉/交互人工核对需用户重启 `dsh web` 后完成（本会话无浏览器控制，也不另起服务器）；
- 隐私页显示会话 id，不显示会话标题：模块层没有会话标题服务，`sessionTitle` 只对活会话可取；
- DSH 斜杠菜单的 inline 隐藏规则是 DSH 仓库行为，本轮只定位并写清改法，未改 DSH 源码。

## 文件

- 新增：`modules/memory/privacy/contract.ts`、`docs/v4.17.0-settings-navigation-and-privacy.md`
- 修改：`packages/memory/client.js`、`modules/memory/ui.ts`、`modules/memory/index.ts`、
  `modules/memory/privacy/index.ts`、`dsh/ui-route.ts`、
  `tests/dsh/{ui-bundle,ui-route}.test.ts`、`tests/modules/memory/ui.test.ts`、
  `README.md`、`AGENTS.md`、版本文件

---

# OMB v4.17.1 交付记录（2026-10-24，x3）

| 项 | 结果 |
| --- | --- |
| 版本 | **4.17.1**（`24 功能 / 104 小功能`；x3：隐私设置页降级态如实标注） |
| 构建 | **g133**；`generation: 133`、`outDir: lib-gen/g133` |
| 门禁 | `tsc --noEmit` **0**；`eslint .` **0**；`vitest run` **121 files / 1498 passed | 1 skipped**；`node scripts/version.mjs` 一致 |
| 真机验收 | **待重启 `dsh web` 后核对**（与 4.17.0 相同的界面清单；4.17.1 只改降级态文案） |

## 修复

- 隐私视图不可用/读取失败时，页面不再把占位值画成"基线 normal / 状态文件可读写"：
  四张卡片写"未接线 / 未测量"并给出原因；
- `omb:ui` 读取失败时命令面状态写"读取失败"（不冒充"未接线"）；
- 隐私管理端口在视图异常时保留真实 `commandState`（视图坏了不等于命令没注册）。
- 契约详情见 `docs/v4.17.0-settings-navigation-and-privacy.md` §6。

---

# OMB v4.18.0 交付记录（2026-10-24，x2）

| 项 | 结果 |
| --- | --- |
| 版本 | **4.18.0**（`25 功能 / 110 小功能`；x2：OMB 设置重做） |
| 构建 | **g134**；`generation: 134`、`outDir: lib-gen/g134` |
| 门禁 | `tsc --noEmit` **0**；`eslint .` **0**；`vitest run` **122 files / 1521 passed | 1 skipped**；`node scripts/version.mjs` 一致 |
| 真机验收 | **待重启 `dsh web` 后核对**：四页二级侧边栏、二级/三级卡片、方向感子页动效、手动记忆增删改标记、项目页归档灰显、个人画像、子页无滚动条、控件无蓝色描边 |

## 用户 15 点对应

1. **手动记忆操作**：新建/编辑/删除/标记（确认/过时/恢复）全部前端可达，
   `POST /omb/api/memory`，经隐私闸门、写后查回。
2. **合并重叠页**：概览+运行状态 → 概览；记忆库+候选确认 → 记忆；隐私+项目画像 → 项目。
3. **项目页**：只列 `agentPreset==='omb'` 的会话；工作区/推理深度/隐私/归档；
   归档灰显不可读；新增 `SERVICES.sessionCatalog`（宿主持久化/活会话/标题/归档集合）。
4. **个人画像页**：读 `SERVICES.profile`，按轴分组、冲突并列、状态卡片。
5. **多级卡片**：二级卡 `bg-layer-2`+`elevation-panel`，三级卡 `bg-layer-3`+`elevation-soft`；
   不再“同底色 + 边框”，亮色主题层色相同时靠阴影立住。
6. **控件锁定**：选中用填充、焦点环仅 `:focus-visible`、不覆盖 primitive 边框/圆角，
   逐控件矩阵见 `DESIGN.md` §5。
7. **间距/字号**：20/15/13/14/12、行高 28/22/20/22/18、字重 400/500/600、间距 4/8/12/16/24。
8. **弹性对齐**：概览 4 卡 2×2、网格 `minmax(0,1fr)`+stretch，无 flex-wrap 3+1 孤行。
9. **动效**：刷新旋转、hover、详情 220ms、页面方向浮动；reduced-motion 去运动。
10. **短文案**：页头只留一句短语；技术信息折叠进运行状态/说明。
11. **文本选择**：骨架不可选、内容可选。
12. **二级卡一致**：导航与内容都是同样的圆角卡片。
13. **层级修正**：二级卡有表面+阴影，不再只剩框。
14. **子页滚动条隐藏**：滚动仍可用。
15. **方向感子页浮动**：按导航顺序左右浮入（220ms），不再单纯淡入。

## 文件

- 新增：`dsh/session-catalog.ts`、`kernel/abi/session-catalog.ts`、
  `tests/dsh/session-catalog.test.ts`、`docs/v4.18.0-ui-contract.md`、
  `docs/v4.18.0-settings-redesign.md`、`DESIGN.md`
- 修改：`packages/memory/client.js`、`modules/memory/ui.ts`、`modules/memory/index.ts`、
  `modules/memory/privacy/{contract,index}.ts`、`dsh/ui-route.ts`、`kernel/abi/{index,catalog}.ts`、
  `tests/dsh/{ui-bundle,ui-route}.test.ts`、`tests/modules/memory/ui.test.ts`、
  `README.md`、`AGENTS.md`、版本文件

---

# OMB v4.18.1 交付记录（2026-10-24，x3）

| 项 | 结果 |
| --- | --- |
| 版本 | **4.18.1**（`25 功能 / 110 小功能`；x3：记忆列表分页） |
| 构建 | **g135**；`generation: 135`、`outDir: lib-gen/g135` |
| 门禁 | `tsc --noEmit` **0**；`eslint .` **0**；`vitest run` **122 files / 1521 passed | 1 skipped**；`node scripts/version.mjs` 一致 |
| 真机验收 | **待重启 `dsh web` 后核对**：记忆页“上一页/下一页”、页码与当前页条数、末页下一页禁用 |

## 修复/补充

- 用户指出“超出单页上限这种应该有换页按键或者干脆不设上限”：
  - `UiListQuery.offset` + `GET /list?offset=`（`clampOffset` 0..4000）；
  - 后端 `list()` 按 offset 切片，`truncated` 如实表示下一页是否还有；
    搜索/空查询都按同一分页语义；
  - 前端记忆页：单页 50、上一页/下一页、`第 N 页 · 本页 M 条`；
    过滤条件/搜索变化自动回第 1 页；
  - 分页补测试：后端两页不重叠且覆盖全部；路由解析 offset；bundle 契约钉住按钮与参数。

---

# OMB v4.19.0 交付记录（2026-10-24，x2）

| 项 | 结果 |
| --- | --- |
| 版本 | **4.19.0**（`25 功能 / 113 小功能`；x2：设置台手动编辑扩展） |
| 构建 | **g136**；`generation: 136`、`outDir: lib-gen/g136` |
| 门禁 | `tsc --noEmit` **0**；`eslint .` **0**；`vitest run` **123 files / 1540 passed | 1 skipped**；`node scripts/version.mjs` 一致 |
| 真机验收 | **待重启 `dsh web` 后核对**：项目页“状态机”增删任务/候选、个人画像新增/编辑/删除、记忆详情“取代…” |

## 补充（用户确认“以上都要”）

- **控制器状态机**：`SERVICES.memoryControllerAdmin`（ABI `controller-admin.ts`）；
  `capture.controllerState/editController` 五动作（任务 TTL/上限/去重、候选移除/清空）；
  `GET/POST /omb/api/controller`；项目页“状态机”区手动增删清空。
- **个人画像**：`ProfileService.retract`（只删同轴同键显式声明、写后查回、不抛）；
  `POST /omb/api/personal` 的 declare/retract；页面新增条目、编辑（声明先撤旧再写新）、删除、
  推断条目“改为确认”。
- **记忆生命周期**：详情“取代…”Modal 选目标，复用 `/resolve` supersede（非破坏）。

详见 `docs/v4.19.0-manual-editing.md`。

---

# OMB v4.19.1 交付记录（2026-10-24，x3）

| 项 | 结果 |
| --- | --- |
| 版本 | **4.19.1**（`25 功能 / 113 小功能`；x3：状态机隐私保护） |
| 构建 | **g137**；`generation: 137`、`outDir: lib-gen/g137` |
| 门禁 | `tsc --noEmit` **0**；`eslint .` **0**；`vitest run` **123 files / 1540 passed | 1 skipped**；`node scripts/version.mjs` 一致 |

## 修复

- 项目页状态机遵守会话隐私：**封存**会话不展示状态机（不读控制器状态）；
  **只读**会话可查看但所有编辑禁用；隐私档位不可读时也不展示。
- 避免手动编辑入口绕过“封存/只读”的隐私边界。

---

# OMB v4.20.0 交付记录（2026-10-24，x2）

| 项 | 结果 |
| --- | --- |
| 版本 | **4.20.0**（`25 功能 / 119 小功能`；x2：大肥鱼增强设置台） |
| 构建 | **g138**；`generation: 138`、`outDir: lib-gen/g138` |
| 门禁 | `tsc --noEmit` **0**；`eslint .` **0**；`vitest run` **124 files / 1548 passed | 1 skipped**；`node scripts/version.mjs` 一致 |
| 真机验收 | **待重启 `dsh web` 后核对**：标题“大肥鱼增强”、无阴影卡片、无刷新按钮、五页导航、项目工作区折叠、记忆滚动加载、状态机总页、命令菜单无 OMB 条目 |

## 用户 11 点 + 改名

1. 去掉所有 `box-shadow`：二级/三级卡改为 settings-card fill + 0.5px stroke；条目圆角。
2. 概览去掉“去记忆/去项目”；运行状态 4 卡直接并入概览网格；去掉右上状态。
3. 响应式：侧边栏/内容/页面内边距 180ms 过渡、标签 opacity、图标固定左对齐。
4. 去掉所有刷新按钮与右上“记忆库就绪”；数据每 8 秒/聚焦自动重读。
5. 记忆/项目条目加圆角与间距。
6. 新增“状态机”总页（`GET /machines`，按工作区聚合全部 OMB 会话）。
7. 记忆列表 30 条无限滚动（滚动触底追加）；单字检索放开 `searchFuzzy` 最小长度到 1。
8. 筛选使用 SegmentedControl/Pill，无滑块。
9. 栅格 2/4 列按容器断点，工具栏/行内 `min-width:0`、控件不拉伸。
10. 项目页默认折叠工作区，点击展开到会话；子会话按 `parentId` 缩进跟随母会话。
11. 删除全部 OMB 用户命令（depth/heap/confirm/feedback/privacy/privacy-clean），
    深度/反馈/确认/隐私/状态机全部走前端；新增 `POST /depth`、`POST /feedback`。
- 标题与侧边栏：“大肥鱼增强”。

详见 `docs/v4.20.0-settings-console.md`。

---

# OMB v4.21.0 交付记录（2026-10-24，x2）

| 项 | 结果 |
| --- | --- |
| 版本 | **4.21.0**（`25 功能 / 124 小功能`；x2：设置台精修） |
| 构建 | **g139**；`generation: 139`、`outDir: lib-gen/g139` |
| 门禁 | `tsc --noEmit` **0**；`eslint .` **0**；`vitest run` **124 files / 1552 passed | 1 skipped**；`node scripts/version.mjs` 一致 |
| 真机验收 | **待重启 `dsh web` 后核对**：拼接单卡、空白默认页、下拉框、状态机有内容、母子会话折叠箭头/动效/缩进、运行中会话设置灰显 |

## 本轮修复（用户 7 点）

1. 侧边栏与主卡拼接为一张 2D 大卡，同色 0.5px 竖线分隔。
2. 删除概览页；默认 `page=null`，右侧主卡空白，点击侧边栏才进入子页。
3. 记忆筛选/新建/项目设置/画像轴全部改原生 `<select>`，不再用 SegmentedControl/Pill；无滑块。
4. 状态机“未接线”根因：`createUiService` 漏传 `controllerAdmin`；已注入
   `kernel.service<ControllerAdminPort>(SERVICES.memoryControllerAdmin)`，并有契约测试。
5. 母子会话：只有同工作区且真实挂在母会话下才标“子会话”；旧 OMB 会话（无 agentPreset）
   不再被过滤；无标题时用“会话 短id”不冒充 cwd；子会话 padding 缩进不溢出；
   工作区与母会话默认收起，箭头 ▾/▴ + grid-rows 200ms 动效。
6. 运行中的会话：推理深度/隐私下拉框禁用（灰色）+“设置已锁定”提示。
7. 记忆库滚动加载后筛选失效：筛选变化时立即清空列表、失效分页请求并重置 seq，
   加载中禁止 loadMore，避免旧页追加到新筛选。

---

# OMB v4.22.0 交付记录（2026-10-24，x2）

| 项 | 结果 |
| --- | --- |
| 版本 | **4.22.0**（`25 功能 / 129 小功能`；x2：设置台打磨） |
| 构建 | **g140**；`generation: 140`、`outDir: lib-gen/g140` |
| 门禁 | `tsc --noEmit` **0**；`eslint .` **0**；`vitest run` **124 files / 1560 passed | 1 skipped**；`node scripts/version.mjs` 一致 |
| 真机验收 | **待重启 `dsh web` 后核对**：极窄宽度、侧栏 56px、历史标题、状态机卡片间距/搜索/编辑、Toast、弹窗与控件样式 |

## 本轮 13 点

1. 极窄宽度：min-width/max-width/overflow-wrap 全面收敛，新增 ≤380px 紧凑断点。
2. ≤617px 侧栏宽 56px、padding 6，图标居中。
3. 历史会话标题：`SessionCatalogPort.title(id)` 读持久化最后一个 `session/title`，
   `GET /session-title?id=`，项目页/状态机页按需补读，失败才短 id。
4. 子会话宽度按缩进削减（calc + margin），右侧对齐不溢出。
5. 会话行去掉重复 cwd，工作区只显示一次路径。
6. 工作区/母会话右侧统一 DSH 上下 chevron，垂直居中；选择器小三角用 `::after`。
7. 状态机总页：卡片 8px 间距、搜索 + 阶段筛选、任务/候选增删与清空。
8. 窄屏详情打开时列表 opacity 归零 + 180ms 过渡，圆角缝隙不再透出。
9. 二级卡背景 #232324。
10. 选择框/文本域仿 dsh-desktop-notify CONTROL（32px、无边框、填充面、8px 圆角）。
11. 弹窗表单包 `.omb-form`，统一 12px 间距。
12. `omb-meta` 与 `omb-row-meta` 统一 4×8 间距与字级。
13. 新增/编辑/删除/反馈/隐私/深度/状态机等写操作统一 Toast，不再堆内联回执。

---

# OMB v4.22.1 交付记录（2026-10-25，x3）

| 项 | 结果 |
| --- | --- |
| 版本 | **4.22.1**（`25 功能 / 129 小功能`；x3：DSH rc.3 适配 + 发布依赖修复） |
| 构建 | 见下方交付时的 `build-generation.json`（本轮起一次构建） |
| 门禁 | `tsc --noEmit` **0**；`eslint .` **0**；`vitest run` **125 files / 1570 passed | 1 skipped**；`version.mjs` 一致 |
| 契约 | `docs/v4.22.1-host-rc3-and-install-fix.md` |

## 背景

1. 用户把 DSH 升到 `0.2.1-rc.3`（源码运行，实际 HEAD 在 tag 之后 1533 个提交），
   紧急修了阻塞性的两处（`tool-subagent-control/list-agents` 子路径、`modelSelectionSettings`）。
2. 另有插件报告：`@omb/plugin@4.22.0` 的 `@omb/artifact@workspace:*` 让该 profile 的
   **所有插件装/卸/切换**以 `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND` 失败。

## 本轮处置

1. `engines.dsh` 精确钉到 **`=0.2.1-rc.3`**；36 条 peer 同步 `^0.2.1-rc.3`。
2. 母子会话判据改 `origin === 'subagent'`（`dsh/session-catalog.ts` 的 `parentIdOf`）：
   普通 fork 不再被误标/缩进，历史残留父 id 也不算父子（与宿主同一条规则）。
3. 导航 hover 改用 `--dsw-alias-interactive-bg-hover`（旧 token 已被宿主删除）。
4. 投影读取优先 `sessionProjections.snapshot()`（非弃用、wire view），`stateOf` 留旧宿主退路；
   两种形状都解析（pressure/usage/breakdown）。
5. 7 个 `@omb/*` 从 `dependencies` 移到 `devDependencies`（仍 `workspace:*`）：
   外部 profile 的 pnpm 不再看到 `workspace:`；仓库与部署副本靠 `node_modules/@omb/*`
   链接解析组件行不变。构建脚本新增"dependencies 不得含组件"的失败项。
6. 新增护栏 `tests/dsh/installable-manifest.test.ts`；补 rc.3 语义/主题/预设断言。

## 未验证 / 边界

- 外部 profile 的 pnpm 操作只做了最小复现与修法验证，未在别人机器上实跑。
- UI 视觉（hover、子会话缩进、极窄宽度）需重启 `dsh web` 后实际复核。
- `engines.dsh` 是精确钉版：宿主升到未核验构建时 bundle 会被跳过（启动会打印一行）。
