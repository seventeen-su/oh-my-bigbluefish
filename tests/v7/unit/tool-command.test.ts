import { describe, expect, it } from 'vitest'
import { toolCommandId } from '../../../plugin/v7/tool-command.js'

describe('工具调用稳定 commandId', () => {
  it('同一 callId 重试得到同一个键', () => {
    const first = toolCommandId('omb_remember', { sessionId: 'session-1', callId: 'call-1' }, { title: 'A' })
    const retry = toolCommandId('omb_remember', { sessionId: 'session-1', callId: 'call-1' }, { title: 'A' })
    expect(retry).toBe(first)
  })

  it('不同 callId（新的一次调用）不复用幂等键', () => {
    const first = toolCommandId('omb_remember', { sessionId: 'session-1', callId: 'call-1' }, { title: 'A' })
    const second = toolCommandId('omb_remember', { sessionId: 'session-1', callId: 'call-2' }, { title: 'A' })
    expect(second).not.toBe(first)
  })

  it('旧宿主没有 callId 时按会话+参数规范哈希兜底，且与对象键顺序无关', () => {
    const first = toolCommandId('omb_update', { sessionId: 's' }, { id: 'mem_x', attrs: { a: 1, b: 2 } })
    const reordered = toolCommandId('omb_update', { sessionId: 's' }, { attrs: { b: 2, a: 1 }, id: 'mem_x' })
    expect(reordered).toBe(first)
    const other = toolCommandId('omb_update', { sessionId: 's' }, { id: 'mem_x', attrs: { a: 1, b: 3 } })
    expect(other).not.toBe(first)
  })

  it('工具名/会话变化会换键，且长度不超过审计列上限', () => {
    const base = toolCommandId('omb_remember', { sessionId: 's' }, { x: 1 })
    expect(toolCommandId('omb_update', { sessionId: 's' }, { x: 1 })).not.toBe(base)
    expect(toolCommandId('omb_remember', { sessionId: 'other' }, { x: 1 })).not.toBe(base)
    const long = toolCommandId('omb_remember', { sessionId: 's'.repeat(400), callId: 'c'.repeat(400) }, {})
    expect(long.length).toBeLessThanOrEqual(200)
  })
})
