/**
 * 巩固任务名清单（`omb.*`）：调度、队列 handler、workflow 定义三处共用的唯一真源。
 *
 * 单独成文件是为了避免 `schedule.ts`（调度）与 `runners.ts`（执行体）互相 import：
 * 两个模块都需要任务名，但依赖方向必须是 runners -> consolidate、schedule -> runners，
 * 任务名本身没有依赖。
 */
export const CONSOLIDATION_JOBS = [
  'omb.extract',
  'omb.reference-rot',
  'omb.clue-promote',
  'omb.dedupe',
  'omb.conflict',
  'omb.link-suggest',
  'omb.forget',
  'omb.attr-alias',
  'omb.refresh',
  'omb.embed-sweep',
] as const

/** 巩固任务名（`omb.*`）；调度、workflow 与事件 reaction 用它对齐。 */
export type ConsolidationJobName = (typeof CONSOLIDATION_JOBS)[number]
