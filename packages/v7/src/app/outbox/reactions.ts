import type { OutboxEvent } from './events.js'

export interface ReactionContext {
  /** `omb.outbox.id`。 */
  readonly id: number
  /** `omb.audit_log.id`；reaction 的幂等键。 */
  readonly eventId: number
  readonly topic: string
  /** 本次是第几次尝试（1 起）：`outbox.attempts + 1`。 */
  readonly attempt: number
  readonly now: Date
}

export interface Reaction {
  readonly name: string
  /** 同 topic 的多个 reaction 相互隔离；抛错不会阻止兄弟 handler 执行。 */
  run(event: OutboxEvent, ctx: ReactionContext): Promise<void> | void
}

export interface ReactionFailure {
  readonly name: string
  readonly error: string
}

/** 一次派发的结果；`no-handlers` 由 relay 按 unknownTopic 策略处理。 */
export type ReactionDispatch =
  | { readonly kind: 'ok'; readonly ran: readonly string[] }
  | { readonly kind: 'failed'; readonly ran: readonly string[]; readonly failures: readonly ReactionFailure[] }
  | { readonly kind: 'no-handlers' }

/** 未注册 topic 的显式策略：死信（可注册后人工重放）或直接丢弃。 */
export type UnknownTopicPolicy = 'dead' | 'skip'
