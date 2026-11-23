import { createHash } from 'node:crypto'
import type { Store } from '../../ports/store.js'
import type { Logger } from '../../ports/jobs.js'
import { resolveProjectKey } from './host.js'
import type { HostContextLike } from './host.js'
import { asRecord } from './host.js'

// DSH 没有 report 事件：报告来自 subagent/end.lastAssistantMessage、job/settled.result
// 或子会话最后一条 assistant/message；这里按事件前缀捕获，后台抽取再解释。
const CAPTURE_PREFIXES = ['goal/', 'team/', 'task/', 'subagent/', 'job/', 'compaction/', 'session/title']
const MAX_CONTENT = 16_384

export interface EventCaptureHandle {
  readonly events: number
  readonly captured: number
  readonly errors: number
  dispose(): void
}

function sessionIdOf(session: unknown): string | undefined {
  const record = asRecord(session)
  const id = record?.['id'] ?? record?.['sessionId']
  return typeof id === 'string' && id.trim().length > 0 ? id : undefined
}

function eventId(sessionId: string, seq: number): string {
  return `art_${createHash('sha256').update(`${sessionId}:${seq}`).digest('hex').slice(0, 32)}`
}

export function createEventCapture(options: {
  ctx: HostContextLike | undefined
  store: Store
  logger?: Logger
  /** 原始事件观察者：adoption / T1 触发用；不改变 artifact 捕获语义。 */
  onEvent?: (sessionId: string, type: string, data: unknown) => void
}): EventCaptureHandle {
  let events = 0
  let captured = 0
  let errors = 0
  let disposed = false
  let off: (() => void) | undefined

  const listener = (session: unknown, event: unknown): void => {
    if (disposed) return
    events += 1
    const sessionId = sessionIdOf(session)
    const sessionRecord = asRecord(session)
    const header = asRecord(sessionRecord?.['header'])
    const cwd = typeof header?.['cwd'] === 'string' && header['cwd'].trim().length > 0 ? header['cwd'] : undefined
    const record = asRecord(event)
    if (record === undefined) return
    const type = typeof record['type'] === 'string' ? record['type'] : undefined
    const seq = typeof record?.['seq'] === 'number' && Number.isSafeInteger(record['seq']) ? record['seq'] : undefined
    if (sessionId === undefined || type === undefined || seq === undefined) return
    try {
      options.onEvent?.(sessionId, type, record['data'])
    } catch (error) {
      options.logger?.warn('session/event 观察者失败', error instanceof Error ? error.message : String(error))
    }
    if (!CAPTURE_PREFIXES.some(prefix => type.startsWith(prefix))) return
    const raw = JSON.stringify(record['data'] ?? null)
    const content = raw.length > MAX_CONTENT ? raw.slice(0, MAX_CONTENT) : raw
    void (async () => {
      // projectKey 必须是 git root，不能把 session cwd 的子目录写进状态作用域；
      // 否则 T0 的当前项目查询（git root）会漏掉后台抽取出来的状态机。
      const projectKey = cwd === undefined ? undefined : await resolveProjectKey(cwd)
      await options.store.recordArtifact({
        id: eventId(sessionId, seq),
        sessionId,
        kind: type,
        content,
        source: 'dsh-event',
        metadata: {
          seq,
          ...(cwd !== undefined ? { cwd } : {}),
          ...(projectKey !== undefined ? { projectKey } : {}),
          ...(typeof record['time'] === 'number' ? { time: record['time'] } : {}),
          ...(raw.length > MAX_CONTENT ? { truncated: true, length: raw.length } : {}),
        },
      })
    })().then(() => {
      captured += 1
    }).catch(error => {
      errors += 1
      options.logger?.warn('事件原文落盘失败', error instanceof Error ? error.message : String(error))
    })
  }

  try {
    if (typeof options.ctx?.on === 'function') {
      const returned = options.ctx.on('session/event', listener as never)
      if (typeof returned === 'function') off = returned as () => void
    } else {
      options.logger?.warn('宿主没有 on()，事件原文捕获未接线')
    }
  } catch (error) {
    options.logger?.warn('订阅 session/event 失败', error instanceof Error ? error.message : String(error))
  }

  return {
    get events() {
      return events
    },
    get captured() {
      return captured
    },
    get errors() {
      return errors
    },
    dispose() {
      if (disposed) return
      disposed = true
      try {
        off?.()
      } catch {
        // 注销失败不扩散。
      }
    },
  }
}
