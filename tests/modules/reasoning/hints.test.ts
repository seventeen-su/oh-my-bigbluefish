/**
 * 事件驱动的出口段（v4：从 control.ts 挪到 hints.ts 并收紧到 ≤120 字符）。
 *
 * 三条硬约束都要有会失败的判据：
 * ① ≤120 字符；② 只由无进展信号触发；③ 不写反例清单里的措辞、不重述已删门槛。
 */
import { describe, expect, it } from 'vitest'
import type { LoopSignal } from '../../../modules/reasoning/loop.js'
import { NO_PROGRESS_KINDS } from '../../../modules/reasoning/loop.js'
import { EXIT_SEGMENT_MAX, renderExitOptions } from '../../../modules/reasoning/hints.js'

describe('renderExitOptions：合法出口段', () => {
  type LoopSignalKind = LoopSignal['kind']
  const signalOf = (kind: LoopSignalKind, hint = 'h'): LoopSignal => ({ kind, detail: '依据', hint })

  it('只有 stalled / no-new-evidence 触发；其余信号与空信号都是空串（不注入废话）', () => {
    for (const kind of NO_PROGRESS_KINDS) {
      expect(renderExitOptions(signalOf(kind)), `${kind} 应当触发`).not.toBe('')
    }
    expect(renderExitOptions(signalOf('repeat-action'))).toBe('')
    expect(renderExitOptions(signalOf('oscillation'))).toBe('')
    expect(renderExitOptions(null)).toBe('')
    expect(renderExitOptions(undefined)).toBe('')
    expect([...NO_PROGRESS_KINDS]).toEqual(['stalled', 'no-new-evidence'])
  })

  it('每种无进展信号都 ≤120 字符，并给出三个出口', () => {
    for (const kind of NO_PROGRESS_KINDS) {
      const line = renderExitOptions(signalOf(kind))
      expect(line.length, `${kind} 出口段过长`).toBeLessThanOrEqual(EXIT_SEGMENT_MAX)
      expect(EXIT_SEGMENT_MAX).toBe(120)
      expect(line).toContain('三个合法出口')
      expect(line).toContain('列出未解决项')
      expect(line).toContain('换向')
      expect(line).toContain('不确定')
    }
  })

  it('不重述已删除的控制表门槛（完成判据/证据要求/档位字段）', () => {
    const line = renderExitOptions(signalOf('stalled'))
    for (const banned of ['完成判据', '证据要求', '首选方案有证据支撑', '验证预算', '可复核', '并列 ≤']) {
      expect(line.includes(banned), `出口段仍出现"${banned}"：${line}`).toBe(false)
    }
  })

  it('不含"不许作弊 / 你被监控 / 加油"这类反例措辞', () => {
    for (const kind of NO_PROGRESS_KINDS) {
      const line = renderExitOptions(signalOf(kind))
      for (const banned of ['不许', '作弊', '被监控', '监控', '评测', '加油', '努力']) {
        expect(line.includes(banned), `出口段出现"${banned}"`).toBe(false)
      }
    }
  })

  it('纯函数：同参数同输出', () => {
    expect(renderExitOptions(signalOf('stalled'))).toBe(renderExitOptions(signalOf('stalled')))
  })
})
