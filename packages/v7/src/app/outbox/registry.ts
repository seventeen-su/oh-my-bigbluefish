import type { OutboxEvent } from './events.js'
import type { Reaction, ReactionContext, ReactionDispatch, ReactionFailure } from './reactions.js'

/**
 * topic → reaction 的注册表。relay 只通过它派发，不知道任何具体 reaction。
 *
 * 错误隔离：同一 topic 的多个 reaction 逐个执行，单个抛错只记进 failures，
 * 不会短路兄弟 handler，也不会把异常抛给 relay 的事件循环。
 */
export class ReactionRegistry {
  private readonly handlers = new Map<string, Map<string, Reaction>>()

  /**
   * 注册一个 reaction，返回注销函数。
   * 同一 topic 下同名 reaction 会被替换（supervisor 重启后重复注册是幂等的）；
   * 注销函数只移除“仍是这次注册进去的实例”，不会误删后来的替换者。
   */
  register(topic: string, reaction: Reaction): () => void {
    const normalized = topic.trim()
    if (normalized.length === 0) throw new Error('outbox reaction 的 topic 不能为空')
    if (reaction.name.trim().length === 0) throw new Error('outbox reaction 必须有 name')
    const bucket = this.handlers.get(normalized) ?? new Map<string, Reaction>()
    bucket.set(reaction.name, reaction)
    this.handlers.set(normalized, bucket)
    return () => {
      const current = this.handlers.get(normalized)
      if (current?.get(reaction.name) !== reaction) return
      current.delete(reaction.name)
      if (current.size === 0) this.handlers.delete(normalized)
    }
  }

  /** 按名字注销；返回是否真的移除了。 */
  unregister(topic: string, name: string): boolean {
    const bucket = this.handlers.get(topic.trim())
    if (bucket === undefined) return false
    const removed = bucket.delete(name)
    if (bucket.size === 0) this.handlers.delete(topic.trim())
    return removed
  }

  topics(): string[] {
    return [...this.handlers.keys()].sort()
  }

  has(topic: string): boolean {
    return (this.handlers.get(topic.trim())?.size ?? 0) > 0
  }

  count(topic?: string): number {
    if (topic !== undefined) return this.handlers.get(topic.trim())?.size ?? 0
    let total = 0
    for (const bucket of this.handlers.values()) total += bucket.size
    return total
  }

  /** 派发开始前对 handler 列表取快照：派发期间注册/注销不影响本次。 */
  async dispatch(event: OutboxEvent, ctx: ReactionContext): Promise<ReactionDispatch> {
    const bucket = this.handlers.get(event.topic)
    if (bucket === undefined || bucket.size === 0) return { kind: 'no-handlers' }
    const ran: string[] = []
    const failures: ReactionFailure[] = []
    for (const reaction of [...bucket.values()]) {
      try {
        await reaction.run(event, ctx)
        ran.push(reaction.name)
      } catch (error) {
        failures.push({ name: reaction.name, error: errorMessage(error) })
      }
    }
    if (failures.length === 0) return { kind: 'ok', ran }
    return { kind: 'failed', ran, failures }
  }
}

/** 错误转成可写进 `outbox.last_error` 的文本；不依赖 Error 的栈。 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.length > 0 ? error.message : error.name
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error) ?? String(error)
  } catch {
    return String(error)
  }
}
