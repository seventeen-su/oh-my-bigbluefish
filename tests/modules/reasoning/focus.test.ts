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
  AUTO_INJECT_CARD_CAP,
  CONTROL_BY_DEPTH,
  CONTROL_LINE_MAX,
  controlLine,
  describeControl,
} from '../../../modules/reasoning/control.js'
import {
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

describe('projectFocus：三档的差异在控制参数，不在卡片数量', () => {
  it('quick：只给抑制指令，不要卡片，验证预算为 0', () => {
    const projection = projectFocus('quick')
    expect(projection.directive).toBe(QUICK_DIRECTIVE)
    expect(projection.needs).toEqual([])
    expect(projection.cards).toEqual([])
    expect(projection.control.verifyBudget).toBe(0)
    expect(projection.controlText).toBe('')
  })

  it('standard：默认档不加戏，也不注入卡片正文', () => {
    const projection = projectFocus('standard')
    expect(projection.directive).toBe('')
    expect(projection.controlText).toBe('')
    expect(projection.cards).toEqual([])
    expect(projection.needs.length).toBeLessThanOrEqual(1)
  })

  it('deep：声明 R3/R4/R5，但只自动注入 R4 一张，并带上控制读数', () => {
    const projection = projectFocus('deep')
    expect(projection.needs).toEqual(['R3', 'R4', 'R5'])
    expect(projection.cards.map(card => card.id)).toEqual(['R4'])
    expect(projection.cards[0]?.text).toBe(cardById('R4')?.text)
    expect(projection.controlText).toBe(controlLine('deep', 0))
    expect(projection.controlText.length).toBeLessThanOrEqual(CONTROL_LINE_MAX)
  })

  it('自动注入的卡片数不随档位增长（0/0/1，且都 ≤ 上限）', () => {
    for (const depth of ['quick', 'standard', 'deep'] as const) {
      const projection = projectFocus(depth)
      expect(projection.cards.length, `${depth} 自动注入 ${projection.cards.length} 张`).toBeLessThanOrEqual(
        AUTO_INJECT_CARD_CAP,
      )
    }
    expect(projectFocus('deep').cards.length).toBe(projectFocus('standard').cards.length + 1)
  })

  it('三档的控制参数严格递增（档位差异的载体是这些数字与枚举）', () => {
    const quick = CONTROL_BY_DEPTH.quick
    const standard = CONTROL_BY_DEPTH.standard
    const deep = CONTROL_BY_DEPTH.deep
    expect(quick.verifyBudget).toBeLessThan(standard.verifyBudget)
    expect(standard.verifyBudget).toBeLessThan(deep.verifyBudget)
    expect(quick.branchBudget).toBeLessThan(standard.branchBudget)
    expect(standard.branchBudget).toBeLessThan(deep.branchBudget)
    expect(quick.reviewBudget).toBeLessThanOrEqual(standard.reviewBudget)
    expect(standard.reviewBudget).toBeLessThan(deep.reviewBudget)
    expect(quick.stopRule).not.toBe(standard.stopRule)
    expect(standard.stopRule).not.toBe(deep.stopRule)
    expect(quick.evidenceLevel).not.toBe(standard.evidenceLevel)
    expect(standard.evidenceLevel).not.toBe(deep.evidenceLevel)
    // 五个维度逐档都不同 —— 这就是"deep 变的是什么"
    expect(projectFocus('deep').control).not.toEqual(projectFocus('standard').control)
  })

  it('纯函数：同档位同 verifyUsed 结果相同', () => {
    expect(projectFocus('deep')).toEqual(projectFocus('deep'))
    expect(projectFocus('deep', 2).controlText).toBe(controlLine('deep', 2))
  })
})

describe('renderProjection', () => {
  it('deep：控制读数 + R4 正文；不再注入 R3/R5 全文', () => {
    const text = renderProjection(projectFocus('deep'))
    expect(text).toContain(controlLine('deep', 0))
    expect(text).toContain(cardById('R4')?.text ?? '')
    expect(text).not.toContain(cardById('R3')?.text ?? '不可能匹配')
    expect(text).not.toContain(cardById('R5')?.text ?? '不可能匹配')
  })

  it('includeCards=false：读数与指令保留，卡片不给（紧张档转工具拉取）', () => {
    const text = renderProjection(projectFocus('deep'), false)
    expect(text).toBe(controlLine('deep', 0))
    expect(text).not.toContain(cardById('R4')?.text ?? '不可能匹配')
  })

  it('standard 档渲染为空串（默认档不加戏，R1 的动作由常驻提示承载）', () => {
    expect(renderProjection(projectFocus('standard'))).toBe('')
  })

  it('quick 档只渲染抑制指令', () => {
    expect(renderProjection(projectFocus('quick'))).toBe(QUICK_DIRECTIVE)
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
    expect(readFocus(handle.kernel, 's1').projection.cards.map(c => c.id)).toEqual(['R4'])
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
    expect(readFocus(handle.kernel, 'sd').projection.cards.map(card => card.id)).toEqual(['R4'])
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
    expect(describeDepthEffect('deep')).toContain('R4')
    expect(describeDepthEffect('standard')).toContain('omb_method')
  })

  it('回执的主语是控制参数，不是"给你更多规则文本"', () => {
    const deep = describeDepthEffect('deep')
    expect(deep).toContain('验证预算 3 次')
    expect(deep).toContain('可复核 2 次')
    expect(deep).toContain(describeControl('deep'))
    // 声明的其余卡片只承诺"按需取"，不承诺自动注入
    expect(deep).toContain('R3/R5')
    expect(describeDepthEffect('quick')).toContain('验证预算 0 次')
    expect(describeDepthEffect('standard')).toContain('验证预算 1 次')
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
