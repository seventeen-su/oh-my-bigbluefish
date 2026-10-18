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
2. 状态机 edit 守卫按 R10 偏差：无读取戳的 edit 只计数不拦；write 只警告；目标只消费 goal/todo。
3. `dsh-path-guard` 的 `selfProtection` 仍为 `false`（用户设置，未改）。
