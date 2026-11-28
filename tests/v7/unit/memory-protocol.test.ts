import { describe, expect, it } from 'vitest'
import {
  MEMORY_PROTOCOL_SECTION,
  MEMORY_PROTOCOL_TEXT,
  registerMemoryProtocol,
} from '../../../plugin/v7/memory-protocol.js'
import type { HostContextLike } from '../../../packages/v7/src/adapters/dsh/host.js'

function fakeHost(input: { section?: boolean; getSectionOrder?: () => number } = {}) {
  const registered: unknown[] = []
  const service = {
    ...(input.section === false ? {} : {
      section: (arg: unknown) => {
        registered.push(arg)
        return () => {}
      },
    }),
    ...(input.getSectionOrder === undefined ? {} : { getSectionOrder: input.getSectionOrder }),
  }
  return {
    ctx: { get: (name: string) => (name === 'systemPrompt' ? service : undefined) } as HostContextLike,
    registered,
  }
}

describe('常驻记忆协议', () => {
  it('注册为 systemPrompt section，并把关键行为写进正文', () => {
    const host = fakeHost({ getSectionOrder: () => 500 })
    const handle = registerMemoryProtocol(host.ctx)

    expect(handle.available).toBe(true)
    const section = host.registered[0] as { name: string; order: number; text: string; interpolate: boolean }
    expect(section.name).toBe(MEMORY_PROTOCOL_SECTION)
    expect(section.order).toBe(510)
    expect(section.interpolate).toBe(false)
    expect(section.text).toBe(MEMORY_PROTOCOL_TEXT)
    expect(section.text).toContain('必须调用工具')
    expect(section.text).toContain('Timeline 任务树只是计划')
    expect(section.text).toContain('expectedRevision')
  })

  it('宿主没有 section 时只降级，不抛异常', () => {
    const host = fakeHost({ section: false })
    const handle = registerMemoryProtocol(host.ctx)
    expect(handle.available).toBe(false)
    expect(handle.reason).toContain('systemPrompt.section')
    expect(() => handle.dispose()).not.toThrow()
  })
})
