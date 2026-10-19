/** v4.4：`/omb-heap` 命令（内存读数与快照入口）。 */
import { describe, expect, it } from 'vitest'
import {
  HEAP_COMMAND_ID,
  HEAP_COMMAND_NAME,
  describeMemory,
  registerHeapCommand,
} from '../../dsh/heap-command.js'
import type { Kernel, Logger } from '../../kernel/abi/index.js'

describe('/omb-heap', () => {
  it('describeMemory 渲染 rss/heap/external/uptime 与 V8 上限，不出现 NaN', () => {
    const text = describeMemory({
      rss: 512 * 1024 * 1024,
      heapUsed: 256 * 1024 * 1024,
      heapTotal: 300 * 1024 * 1024,
      external: 40 * 1024 * 1024,
      uptimeSec: 65,
    })
    expect(text).toContain('rss 512 MB')
    expect(text).toContain('heapUsed 256 MB')
    expect(text).toContain('external 40 MB')
    expect(text).toContain('uptime 1m')
    expect(text).toContain('heap_size_limit')
    expect(text).not.toContain('NaN')
  })

  it('注册命令并处理空参数/非法参数（不触发真实快照）', () => {
    let definition: { name: string; definitionId: string; handler: (i: { rawInput?: unknown }) => unknown } | undefined
    const ctx = {
      get: (name: string) => name === 'commands' ? {
        register: (input: typeof definition) => {
          definition = input
          return () => {}
        },
      } : undefined,
    }
    const logger: Logger = { debug: () => {}, info: () => {}, warn: () => {} }
    const dispose = registerHeapCommand({ ctx: ctx as never, kernel: {} as Kernel, logger })
    expect(definition?.name).toBe(HEAP_COMMAND_NAME)
    expect(definition?.definitionId).toBe(HEAP_COMMAND_ID)

    const empty = definition?.handler({}) as { kind: string; text: string }
    expect(empty.kind).toBe('success')
    expect(empty.text).toContain('内存：')
    expect(empty.text).toContain('/omb-heap snapshot')

    const bad = definition?.handler({ rawInput: 'oops' }) as { kind: string; text: string }
    expect(bad.kind).toBe('error')
    expect(bad.text).toContain('可用参数')
    dispose()
  })
})
