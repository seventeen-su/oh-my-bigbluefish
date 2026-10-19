/**
 * 统一知识生命周期（v4.6.0；七点审查第 6 点）。
 *
 * ## 为什么是"推导"而不是再加一列
 *
 * 用户的要求是"层级之间不能自动晋升"，不是"层级数量越多越好"。数据库里已有的
 * `kind` + `assertedBy` 已经能确定一条记录当前处在哪一层：
 *
 * | 记录形态 | 阶段 | 含义 |
 * | --- | --- | --- |
 * | `episodic` | `event` | 一次观察到的事件 |
 * | `semantic` + `user` | `confirmed` | 用户确认的结论/偏好 |
 * | `semantic` + 其他 | `candidate` | 有依据但未经用户确认的结论 |
 * | `procedural` + `user` | `experience` | 用户确认的可复用做法 |
 * | `procedural` + 其他 | `candidate` | 一次成功不等于可复用经验 |
 *
 * 因此**没有自动晋升路径**：写入时是什么证据，就停在对应的阶段；
 * 想升级只能由用户显式确认（后续命令入口），不能靠"又被召回了几次"自动提级。
 * 召回/画像只**展示**阶段，不据此改写记录。
 */
import type { AssertedBy, MemoryKind } from '../../kernel/abi/index.js'

export type LifecycleStage = 'event' | 'candidate' | 'confirmed' | 'experience'

export interface LifecycleInput {
  readonly kind: MemoryKind
  readonly assertedBy: AssertedBy
}

/**
 * 由记录事实推导阶段。**纯函数**；不读时间、不读使用计数。
 *
 * 特别注意：`useCount`/召回次数**不参与**推导——曝光多不等于结论更可信，
 * 这条约束防止"被引用了 10 次 → 自动升级为经验"的伪晋升。
 */
export function stageOfMemory(input: LifecycleInput): LifecycleStage {
  if (input.kind === 'episodic') return 'event'
  if (input.assertedBy === 'user') {
    return input.kind === 'procedural' ? 'experience' : 'confirmed'
  }
  return 'candidate'
}

/** 展示用中文名（状态面/召回回执共用，避免两处措辞漂移）。 */
export function stageLabel(stage: LifecycleStage): string {
  switch (stage) {
    case 'event':
      return '事件'
    case 'candidate':
      return '候选'
    case 'confirmed':
      return '已确认'
    case 'experience':
      return '经验'
  }
}
