import { describe, expect, it } from 'vitest'
import { detectDurableSignals } from '../../../packages/v7/src/domain/memory-signal.js'

describe('主动记忆信号识别', () => {
  it('识别以后/不要再这类跨会话偏好', () => {
    const signals = detectDurableSignals('以后不要在我电脑生产端做实验')
    expect(signals[0]).toMatchObject({ kind: 'preference', strength: 'strong' })
    expect(signals[0]?.text).toContain('不要在我电脑生产端做实验')
  })

  it('识别第一人称环境事实', () => {
    expect(detectDurableSignals('我本机有 GitHub CLI，可以直接用 gh')[0]).toMatchObject({
      kind: 'fact',
      strength: 'strong',
    })
  })

  it('识别项目事实断言', () => {
    expect(detectDurableSignals('这个仓库用的是 pnpm，端口是 5432')[0]).toMatchObject({
      kind: 'fact',
      strength: 'strong',
    })
  })

  it('识别明确决定与纠正', () => {
    expect(detectDurableSignals('我们决定采用方案 B')[0]).toMatchObject({ kind: 'decision', strength: 'strong' })
    expect(detectDurableSignals('不是 A，而是 B')[0]).toMatchObject({ kind: 'correction', strength: 'strong' })
  })

  it('弱约束只返回 weak，供上层过滤掉，不主动提醒', () => {
    expect(detectDurableSignals('确保提醒机制和频率合理，时间线默认的是每24步')[0]).toMatchObject({
      strength: 'weak',
      kind: 'constraint',
    })
  })

  it('普通请求、代码修改指令和一次性任务细节不触发', () => {
    expect(detectDurableSignals('帮我看下这个报错')).toEqual([])
    expect(detectDurableSignals('这个函数要改成 async')).toEqual([])
    expect(detectDurableSignals('完成任务1后执行任务2')).toEqual([])
    expect(detectDurableSignals('我需要彻底高效优质的解决该问题')).toEqual([])
  })

  it('忽略代码块里的记忆措辞', () => {
    expect(detectDurableSignals('```ts\n// 以后不要这样写\nconst remember = true\n```\n帮我检查这段')).toEqual([])
  })

  it('同一句只返回一次并限制条数', () => {
    const signals = detectDurableSignals('以后用 pnpm；以后用 pnpm；我本机有 gh；我们决定采用方案 B；端口是 5432')
    expect(signals).toHaveLength(3)
    expect(new Set(signals.map(signal => signal.text)).size).toBe(signals.length)
  })
})
