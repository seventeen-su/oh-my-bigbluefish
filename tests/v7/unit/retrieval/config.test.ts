import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RETRIEVAL_CONFIG,
  createRetrievalConfig,
} from '../../../../packages/v7/src/retrieval/config.js'
import { RECALL_SCENARIOS } from '../../../../packages/v7/src/retrieval/constants.js'

describe('检索配置可审计', () => {
  it('给定默认配置当读取五个场景则都有权重与时间窗', () => {
    for (const scenario of RECALL_SCENARIOS) {
      const config = DEFAULT_RETRIEVAL_CONFIG.scenarios[scenario]
      expect(config.weights.fulltext).toBeGreaterThan(0)
      expect(config.weights.trigger).toBeGreaterThan(0)
      expect(config.timeWindowDays).toBeGreaterThan(0)
      expect(config.priors.category.fact).toBeGreaterThan(0)
    }
    expect(DEFAULT_RETRIEVAL_CONFIG.version).not.toHaveLength(0)
    expect(Object.isFrozen(DEFAULT_RETRIEVAL_CONFIG)).toBe(true)
  })

  it('给定 tool-before 当比较 manual 则触发匹配权重更高', () => {
    expect(DEFAULT_RETRIEVAL_CONFIG.scenarios['tool-before'].weights.trigger)
      .toBeGreaterThan(DEFAULT_RETRIEVAL_CONFIG.scenarios.manual.weights.trigger)
    expect(DEFAULT_RETRIEVAL_CONFIG.scenarios['tool-before'].weights.fulltext)
      .toBeLessThan(DEFAULT_RETRIEVAL_CONFIG.scenarios.manual.weights.fulltext)
  })

  it('给定 tool-error 当比较 manual 则事件类先验更高', () => {
    expect(DEFAULT_RETRIEVAL_CONFIG.scenarios['tool-error'].priors.category.event).toBeGreaterThan(1)
    expect(DEFAULT_RETRIEVAL_CONFIG.scenarios['tool-error'].priors.category.event)
      .toBeGreaterThan(DEFAULT_RETRIEVAL_CONFIG.scenarios.manual.priors.category.event)
  })

  it('给定 session-start 当比较其它场景则状态机看板权重最高', () => {
    const sessionStart = DEFAULT_RETRIEVAL_CONFIG.scenarios['session-start'].weights.state_board
    for (const scenario of RECALL_SCENARIOS) {
      if (scenario === 'session-start') continue
      expect(sessionStart).toBeGreaterThan(DEFAULT_RETRIEVAL_CONFIG.scenarios[scenario].weights.state_board)
    }
  })

  it('给定 last-time 当读取时间配置则窗口放宽到 60 天且时间通道权重最高', () => {
    const lastTime = DEFAULT_RETRIEVAL_CONFIG.scenarios['last-time']
    expect(lastTime.timeWindowDays).toBe(60)
    for (const scenario of RECALL_SCENARIOS) {
      if (scenario === 'last-time') continue
      expect(lastTime.weights.time).toBeGreaterThan(DEFAULT_RETRIEVAL_CONFIG.scenarios[scenario].weights.time)
    }
  })

  it('给定局部覆盖当生成配置则只替换显式字段且不动其它场景', () => {
    const config = createRetrievalConfig({
      fusedFloor: 0.02,
      channelFloors: { fulltext: 0.5 },
      scenarios: {
        manual: {
          weights: { trigger: 2 },
          priors: { category: { event: 1.3 } },
        },
      },
    })
    expect(config.fusedFloor).toBe(0.02)
    expect(config.channelFloors.fulltext).toBe(0.5)
    expect(config.channelFloors.vector).toBe(DEFAULT_RETRIEVAL_CONFIG.channelFloors.vector)
    expect(config.scenarios.manual.weights.trigger).toBe(2)
    expect(config.scenarios.manual.weights.fulltext).toBe(DEFAULT_RETRIEVAL_CONFIG.scenarios.manual.weights.fulltext)
    expect(config.scenarios.manual.priors.category.event).toBe(1.3)
    expect(config.scenarios.manual.priors.category.fact).toBe(DEFAULT_RETRIEVAL_CONFIG.scenarios.manual.priors.category.fact)
    const untouched = config.scenarios['tool-before']
    const base = DEFAULT_RETRIEVAL_CONFIG.scenarios['tool-before']
    expect(untouched.weights).toEqual(base.weights)
    expect(untouched.priors).toEqual(base.priors)
    expect(untouched.timeWindowDays).toBe(base.timeWindowDays)
    // 没有显式门控校准的场景，生成后带的是解析好的全局门控（计划/引擎直接可用）。
    expect(untouched.gate).toEqual(DEFAULT_RETRIEVAL_CONFIG.fusionGate)
  })
})
