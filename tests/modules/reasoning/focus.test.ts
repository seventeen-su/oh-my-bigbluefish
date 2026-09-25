/**
 * 深度档位投影层（规划 §4.4）。
 *
 * 状态由内核持有，这里测两件事：投影是否正确、读写是否**绝不抛**。
 * 用真实微内核（`createKernel`），不用 mock。
 */
import { describe, expect, it } from 'vitest'
import { createKernel } from '../../../kernel/index.js'
import type { Kernel } from '../../../kernel/abi/index.js'
import {
  DEEP_DIRECTIVE,
  QUICK_DIRECTIVE,
  applyFocus,
  describeDepthEffect,
  isFocusDepth,
  peekFocus,
  projectFocus,
  readFocus,
  renderProjection,
  resolveDepth,
} from '../../../modules/reasoning/focus.js'
import { cardById } from '../../../modules/reasoning/methods.js'

describe('projectFocus：三档声明的差异', () => {
  it('quick：只给抑制指令，不要卡片', () => {
    const projection = projectFocus('quick')
    expect(projection.directive).toBe(QUICK_DIRECTIVE)
    expect(projection.needs).toEqual([])
    expect(projection.cards).toEqual([])
  })

  it('standard：默认档不加戏，声明至多一张', () => {
    const projection = projectFocus('standard')
    expect(projection.directive).toBe('')
    expect(projection.needs.length).toBeLessThanOrEqual(1)
    expect(projection.cards.length).toBeLessThanOrEqual(1)
  })

  it('deep：声明并给出 R3/R4/R5 全文', () => {
    const projection = projectFocus('deep')
    expect(projection.directive).toBe(DEEP_DIRECTIVE)
    expect(projection.needs).toEqual(['R3', 'R4', 'R5'])
    expect(projection.cards.map(card => card.text)).toEqual([
      cardById('R3')?.text,
      cardById('R4')?.text,
      cardById('R5')?.text,
    ])
  })

  it('纯函数：同档位多次调用结果相同', () => {
    expect(projectFocus('deep')).toEqual(projectFocus('deep'))
  })
})

describe('renderProjection', () => {
  it('默认渲染指令 + 卡片全文', () => {
    const text = renderProjection(projectFocus('deep'))
    expect(text).toContain(DEEP_DIRECTIVE)
    expect(text).toContain(cardById('R3')?.text ?? '')
  })

  it('includeCards=false 时只留指令（紧张档：内容转工具拉取，指令保留）', () => {
    const text = renderProjection(projectFocus('deep'), false)
    expect(text).toBe(DEEP_DIRECTIVE)
    expect(text).not.toContain(cardById('R3')?.text ?? '')
  })

  it('standard 档渲染 = 声明的卡片正文（推不推由上下文层按压力裁决，见 module 测试）', () => {
    const projection = projectFocus('standard')
    const text = renderProjection(projection)
    if (projection.cards.length === 0) {
      expect(text).toBe(projection.directive)
    } else {
      for (const card of projection.cards) expect(text).toContain(card.text)
      expect(text).toContain(cardById('R1')?.title ?? '不可能匹配')
    }
  })
})

describe('isFocusDepth / resolveDepth', () => {
  it('只认三个合法取值', () => {
    expect(isFocusDepth('quick')).toBe(true)
    expect(isFocusDepth('standard')).toBe(true)
    expect(isFocusDepth('deep')).toBe(true)
    expect(isFocusDepth('DEEP')).toBe(false)
    expect(isFocusDepth('')).toBe(false)
    expect(isFocusDepth(null)).toBe(false)
    expect(isFocusDepth(3)).toBe(false)
  })

  it('显式档位优先于配置默认档', () => {
    expect(resolveDepth('quick', 'deep')).toBe('deep')
    expect(resolveDepth('quick', undefined)).toBe('quick')
    expect(resolveDepth('standard', undefined)).toBe('standard')
  })
})

describe('readFocus / applyFocus：走内核，绝不抛', () => {
  it('applyFocus 合法档位写进内核并可读回', () => {
    const handle = createKernel()
    const result = applyFocus(handle.kernel, 's1', 'deep', '要权衡多方案')
    expect(result.ok).toBe(true)
    expect(result.depth).toBe('deep')
    expect(handle.kernel.focus('s1')).toBe('deep')
    expect(result.text).toContain('deep')
    expect(readFocus(handle.kernel, 's1').projection.cards.map(c => c.id)).toEqual(['R3', 'R4', 'R5'])
    handle.dispose()
  })

  it('未设置过的会话读回默认 standard', () => {
    const handle = createKernel()
    const snapshot = readFocus(handle.kernel, '从未出现过')
    expect(snapshot.depth).toBe('standard')
    expect(snapshot.projection.depth).toBe('standard')
    handle.dispose()
  })

  it('applyFocus 非法取值：不改状态，并回可读错误与可用取值', () => {
    const handle = createKernel()
    applyFocus(handle.kernel, 's2', 'deep', '先设成 deep')
    const bad = applyFocus(handle.kernel, 's2', 'DEEP', '大小写错')
    expect(bad.ok).toBe(false)
    expect(bad.depth).toBe('deep')
    expect(bad.text).toContain('quick / standard / deep')
    expect(handle.kernel.focus('s2')).toBe('deep')
    handle.dispose()
  })

  it('applyFocus reason 缺省记为"模型未给理由"（不因此拒绝）', () => {
    const handle = createKernel()
    const result = applyFocus(handle.kernel, 's3', 'quick', undefined)
    expect(result.ok).toBe(true)
    expect(result.text).toContain('模型未给理由')
    handle.dispose()
  })

  it('deep 正证：写入 → 回读 deep → 回执说"请求注入"，且不承诺结果', () => {
    const handle = createKernel()
    const result = applyFocus(handle.kernel, 'sd', 'deep', '多方案权衡')
    expect(result.ok).toBe(true)
    expect(result.depth).toBe('deep')
    expect(handle.kernel.focus('sd')).toBe('deep')
    expect(readFocus(handle.kernel, 'sd').projection.cards.map(card => card.id)).toEqual(['R3', 'R4', 'R5'])
    expect(result.text).toContain('已回读核实')
    expect(result.text).toContain('请求注入')
    expect(result.text).not.toContain('会带上')
    handle.dispose()
  })

  it('内核静默丢弃写入（deep 没落地）：报未生效，不假装成功', () => {
    const handle = createKernel()
    const swallowing: Kernel = {
      ...handle.kernel,
      setFocus: () => {
        // 不抛、也不写：这正是"回读核实"要抓的情况
      },
    }
    const result = applyFocus(swallowing, 'sw', 'deep', '试试')
    expect(result.ok).toBe(false)
    expect(result.depth).toBe('standard')
    expect(result.text).toContain('未生效')
    expect(result.text).toContain('deep')
    expect(result.text).toContain('standard')
    handle.dispose()
  })

  it('写入后读不回档位：如实说无法核实，不假装成功', () => {
    const handle = createKernel()
    const unreadable: Kernel = {
      ...handle.kernel,
      focus: () => {
        throw new Error('读不了')
      },
    }
    const result = applyFocus(unreadable, 'ur', 'quick', 'r')
    expect(result.ok).toBe(true)
    expect(result.text).toContain('无法核实')
    handle.dispose()
  })

  it('内核 setFocus 抛异常时返回错误文本（不抛）', () => {
    const handle = createKernel()
    const broken: Kernel = {
      ...handle.kernel,
      setFocus: () => {
        throw new Error('内核炸了')
      },
    }
    const result = applyFocus(broken, 's4', 'quick', '试试')
    expect(result.ok).toBe(false)
    expect(result.text).toContain('内核炸了')
    handle.dispose()
  })

  it('内核 focus 抛异常时 readFocus 回落 standard 且 applyFocus 仍可读当前档', () => {
    const handle = createKernel()
    const broken: Kernel = {
      ...handle.kernel,
      focus: () => {
        throw new Error('读不了')
      },
    }
    expect(readFocus(broken, 's5').depth).toBe('standard')
    const bad = applyFocus(broken, 's5', 'nope', 'r')
    expect(bad.ok).toBe(false)
    expect(bad.depth).toBe('standard')
    handle.dispose()
  })
})

describe('describeDepthEffect', () => {
  it('三档都有自解释回执', () => {
    expect(describeDepthEffect('quick')).toContain('直接回答')
    expect(describeDepthEffect('deep')).toContain('R3')
    expect(describeDepthEffect('standard')).toContain('omb_method')
  })

  it('deep 回执只说"请求注入"，不承诺结果（注入是下一轮渲染期的事）', () => {
    const text = describeDepthEffect('deep')
    expect(text).toContain('请求注入')
    expect(text).not.toContain('会带上')
    expect(text).not.toContain('已注入')
    // 紧张档会降级成索引，回执必须自己交代出口
    expect(text).toContain('omb_method')
  })

  it('三档回执都交代"此后每轮"（档位是持续状态，不是一次性动作）', () => {
    for (const depth of ['quick', 'standard', 'deep'] as const) {
      expect(describeDepthEffect(depth)).toContain('每轮')
    }
  })
})

describe('peekFocus：不隐藏读取失败', () => {
  it('正常内核读回当前档；未设置过读回 standard', () => {
    const handle = createKernel()
    expect(peekFocus(handle.kernel, 'p1')).toBe('standard')
    handle.kernel.setFocus('p1', 'deep', '测试')
    expect(peekFocus(handle.kernel, 'p1')).toBe('deep')
    handle.dispose()
  })

  it('内核抛异常 / 读到非法值时返回 null（与 readFocus 的回落分工）', () => {
    const handle = createKernel()
    const broken: Kernel = {
      ...handle.kernel,
      focus: () => {
        throw new Error('读不了')
      },
    }
    expect(peekFocus(broken, 'p2')).toBeNull()
    // readFocus 仍然回落 standard —— 渲染路径要的是能用的档位
    expect(readFocus(broken, 'p2').depth).toBe('standard')
    handle.dispose()
  })
})
