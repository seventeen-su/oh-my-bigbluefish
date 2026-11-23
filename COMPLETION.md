# OMB v7 完成清单（迁移记录与终审后）

| # | 任务 | 状态 | 证据 | 理由 |
|---|---|---|---|---|
| 1 | 任务最终失败持久化、恢复与状态告警 | done | `pnpm exec vitest run tests/v7/unit/job-failures.test.ts tests/v7/integration/queue.test.ts` → unit 10/10、PG 4/4；同名任务成功写 `job-recovered` 后 `jobFinalFailures` 从 1 归零；恢复日志写失败不把成功任务变失败 | — |
| 2 | T0 常驻 trace 与偏好采用 | done | `pnpm exec vitest run tests/v7/unit/resident-trace.test.ts tests/v7/integration/plugin.test.ts` → 2/2、6/6；pre-step 后 `resident_trace` 有行，偏好 `recall_event` 在 assistant 采用后 `adopted_at` 非空 | — |
| 3 | T1 工具调用前预取/结果即时注入 | done | `pnpm exec vitest run tests/v7/integration/plugin.test.ts` → 6/6；post-execute 的 `additionalContexts.source.kind=plugin:oh-my-bigbluefish/v7`，下一 pre-step 不重复召回 | — |
| 4 | 10 万实体/1 万链接基准 | done | `OMB_BENCH_REUSE=1 pnpm v7:bench` → fixtures 100000/10000/100000，stage1 p95=1.33ms、total p95=4.08ms、write p95=504.02ms，fullScale=true PASS | — |
| 5 | 终审修复 | done | 见 `docs/v7/VERIFICATION.md` 第 5 节；`pnpm v7:test` 257/257、`pnpm v7:test:pg` 49/49；DSH v4 source 校验 old=FAIL / new=OK；link-suggest 链成员回归测试由红转绿 | — |
| 6 | 全量闸门 | done | `pnpm v7:verify` → typecheck PASS、lint PASS、257 unit、49 PG、build g31（bytes=820619、inputs=130）；根 `tsconfig` 覆盖 plugin/tests/scripts | — |
| 7 | 迁移、构建与 profile smoke | done | `pnpm v7:db:setup` → 本轮应用 1 个迁移，总计 7 个；`pnpm v7:deploy --apply` → SMOKE_OK，profile exports 指向 g31；g31 profile 实际路径 smoke → 7 工具、db=ok | jobs=false 的 smoke 不查询最终失败，不能拿它证明当前进程 jobs 状态 |
| 8 | 重启 DSH 加载 g31 | blocked-external | 命令：重启 DSH；当前会话仍运行旧插件代，重启会结束当前会话；profile 已指向 `./lib-gen/v7-g31/plugin/v7/index.js` | 运行中的宿主进程替换不能在当前会话内完成 |
| 9 | 迁移记录与脚本核验 | done | 664 个会话全部解析；545 个 header 备份全为 omb 且现均为 cordis，547 个缓存备份全为 omb 且现均为 cordis，二者并集 552，当前 0 个 omb header/effective/cache；`node scripts/v7-migrate-sessions.mjs --skip-dsh-check` → 664 scanned / 0 pending；临时 fixture 验证 header-only、event-only、cache patch 三层均正确 | 旧脚本只改 header，已替换为同时处理日志与投影缓存的完整迁移脚本 |
| 10 | Git 收尾、备份与清理 | done | 旧历史已生成全量 zip（211MB）与 .omb 数据归档；14 个 .omb、2.4GB 旧临时目录、旧 profile 构建与备份已清理；仓库重置为单提交 main，远端只保留同一首次提交 | 备份在 `D:\Backups`，旧历史不推云端 |

## 本轮验证范围

已跑：`pnpm v7:verify`（typecheck/lint/257 单元/49 真实 PG/build g31）、根 `tsconfig` 全量 typecheck、`OMB_BENCH_REUSE=1 pnpm v7:bench`（满规模）、`pnpm v7:db:setup`（7 个迁移）、`pnpm v7:deploy --apply`（SMOKE_OK）、g31 profile 实际路径 `omb_status`、迁移脚本 dry-run 与临时 fixture 写入/回读、DSH v4 source 校验对照、completion-integrity checker（源码与清单）。

未跑：当前 DSH 主进程内的 g31 事件/工具矩阵、jobs 恢复与 `jobFinalFailures` 归零；需要重启宿主，见 #8。仓库已重置为单提交 `main`，旧历史备份在 `D:\Backups`，不再保留旧提交历史。

## 补齐路径

- #8：解除条件 = 重启一次 DSH；解阻塞后第一条命令 = `omb_status`，确认 `db=ok`、`jobs=on`、`jobFailures=0`、`jobFinalFailures=0`；随后触发一次 pre-step 并查 `omb.resident_trace` 最新行。
- 生产库当前仍有 10 条 `job-final-failure`（旧进程每 10 分钟重试一次 link-suggest，数量可能继续增加）；g31 重启后一次成功的 link-suggest 会写 `job-recovered` 并归零，旧审计不删除。
