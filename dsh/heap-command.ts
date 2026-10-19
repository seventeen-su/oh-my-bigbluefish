/**
 * `/omb-heap`：用户手动触发进程内存读数 / V8 heap snapshot（v4.4 OOM 取证）。
 *
 * 为什么是用户命令：heap snapshot 会**同步暂停**事件循环、可能写出数 GB 文件，
 * 不能自动、不能模型触发；只有在用户看到 `omb_status` 的 `## 进程` 趋势、
 * 决定取证时才执行。
 *
 * 用法：
 *   /omb-heap              → 当前 rss/heapUsed/heapTotal/external + uptime
 *   /omb-heap snapshot     → 写 `<cwd>/.omb/heap/*.heapsnapshot` 并返回路径
 *
 * 快照用 Chrome DevTools → Memory → Load 打开，按 Retained Size 找根因。
 */
import { getHeapStatistics } from 'node:v8'
import type { HostContextLike } from './host.js'
import { readService } from './host.js'
import type { Kernel, Logger } from '../kernel/abi/index.js'
import { HEAP_SNAPSHOT_PRIVACY_NOTE, writeHeapSnapshotSafely } from './heap-snapshot.js'

interface CommandResultLike {
  readonly kind: 'success' | 'error'
  readonly text: string
}

interface CommandInvocationLike {
  readonly rawInput?: unknown
}

interface CommandsLike {
  register(definition: {
    readonly definitionId: string
    readonly name: string
    readonly description: string
    readonly input?: { readonly hint: string; readonly attachments?: boolean }
    readonly handler: (invocation: CommandInvocationLike) => CommandResultLike | Promise<CommandResultLike>
  }): unknown
}

export const HEAP_COMMAND_NAME = 'omb-heap'
export const HEAP_COMMAND_ID = 'omb-kernel/heap'

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`
}

/** 内存读数（纯函数，便于状态面/测试复用）。 */
export function describeMemory(input: {
  readonly rss: number
  readonly heapUsed: number
  readonly heapTotal: number
  readonly external: number
  readonly uptimeSec: number
}): string {
  const uptime = input.uptimeSec >= 3600
    ? `${Math.floor(input.uptimeSec / 3600)}h${Math.floor((input.uptimeSec % 3600) / 60)}m`
    : `${Math.floor(input.uptimeSec / 60)}m`
  const heap = getHeapStatistics()
  return `rss ${mb(input.rss)} / heapUsed ${mb(input.heapUsed)} / heapTotal ${mb(input.heapTotal)}`
    + ` / external ${mb(input.external)}（uptime ${uptime}）`
    + `；V8 heap_size_limit ${mb(heap.heap_size_limit)}`
}

/** 注册 `/omb-heap`（幂等 disposer；commands 不可用返回空）。 */
export function registerHeapCommand(options: {
  readonly ctx: HostContextLike
  readonly kernel: Kernel
  readonly logger: Logger
}): () => void {
  const { ctx, logger } = options
  const commands = readService<CommandsLike>(ctx, 'commands')
  if (commands === undefined || typeof commands.register !== 'function') {
    logger.warn('OMB：宿主 commands 服务不可用——/omb-heap 未注册（不影响内存读数）')
    return () => {}
  }
  try {
    const returned = commands.register({
      definitionId: HEAP_COMMAND_ID,
      name: HEAP_COMMAND_NAME,
      description: '进程内存读数；/omb-heap snapshot 写 V8 heap snapshot（会暂停事件循环，仅在取证时用）',
      input: { hint: '[snapshot]' },
      handler: invocation => {
        const raw = typeof invocation.rawInput === 'string' ? invocation.rawInput.trim().toLowerCase() : ''
        const memory = process.memoryUsage()
        const snapshot = { rss: memory.rss, heapUsed: memory.heapUsed, heapTotal: memory.heapTotal, external: memory.external, uptimeSec: process.uptime() }
        if (raw.length === 0 || raw === 'status') {
          return {
            kind: 'success',
            text: `内存：${describeMemory(snapshot)}。`
              + ' 取证：/omb-heap snapshot（会暂停事件循环；先确认磁盘空间）。',
          }
        }
        if (raw !== 'snapshot') {
          return { kind: 'error', text: `/omb-heap：可用参数 snapshot 或留空，收到 ${JSON.stringify(raw)}` }
        }
        try {
          // 磁盘检查 + 保留策略集中在 `heap-snapshot.ts`（与 omb_status 共用）。
          const written = writeHeapSnapshotSafely(process.cwd())
          if (!written.ok || written.file === null) {
            return { kind: 'error', text: `/omb-heap snapshot 失败：${written.detail}` }
          }
          return {
            kind: 'success',
            text: `已写 heap snapshot：${written.file}（${written.detail}）。`
              + ' 用 Chrome DevTools → Memory → Load 打开，按 Retained Size 排序定位。'
              + ` ⚠ ${HEAP_SNAPSHOT_PRIVACY_NOTE}`,
          }
        } catch (error) {
          return { kind: 'error', text: `/omb-heap snapshot 失败：${error instanceof Error ? error.message : String(error)}` }
        }
      },
    })
    return typeof returned === 'function' ? returned as () => void : () => {}
  } catch (error) {
    logger.warn(`OMB：/omb-heap 注册失败——${String(error)}`)
    return () => {}
  }
}
