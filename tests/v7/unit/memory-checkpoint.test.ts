import { describe, expect, it } from 'vitest'
import { MemoryCheckpointLedger } from '../../../plugin/v7/memory-check.js'

describe('主动记忆检查点账本', () => {
  it('给定值得保存的用户话当首次 pre-step 则立即显示检查点', () => {
    const ledger = new MemoryCheckpointLedger()
    ledger.observeUserMessage('s1', '以后不要在我电脑生产端做实验', { turn: 1, step: 1 })

    const text = ledger.render('s1', { turn: 1, step: 1 })
    expect(text).toContain('[OMB 记忆检查点]')
    expect(text).toContain('以后不要在我电脑生产端做实验')
    expect(text).toContain('omb_remember')
    expect(text).toContain('不要只说“我会记住”')
  })

  it('同一轮已经显示后在升级步数之前不重复显示', () => {
    const ledger = new MemoryCheckpointLedger()
    ledger.observeUserMessage('s1', '我们决定采用方案 B', { turn: 1, step: 1 })
    expect(ledger.render('s1', { turn: 1, step: 1 })).not.toBe('')
    expect(ledger.render('s1', { turn: 1, step: 2 })).toBe('')
    expect(ledger.render('s1', { turn: 1, step: 3 })).toBe('')
    expect(ledger.render('s1', { turn: 1, step: 4 })).toContain('已连续多步未记录')
  })

  it('跨轮仍未写则升级为上一轮未记录', () => {
    const ledger = new MemoryCheckpointLedger()
    ledger.observeUserMessage('s1', '我本机有 GitHub CLI', { turn: 1, step: 1 })
    ledger.render('s1', { turn: 1, step: 1 })

    const nextTurn = ledger.render('s1', { turn: 2, step: 1 })
    expect(nextTurn).toContain('上一轮未记录')
    expect(nextTurn).toContain('先补写')
  })

  it('成功的写入销账后检查点立即消失，且同一用户消息不会重新入队', () => {
    const ledger = new MemoryCheckpointLedger()
    ledger.observeUserMessage('s1', '以后不要在我电脑生产端做实验', { turn: 1, step: 1 })
    ledger.render('s1', { turn: 1, step: 1 })

    ledger.noteWrite('s1', { turn: 1 })
    expect(ledger.pendingCount('s1')).toBe(0)
    expect(ledger.render('s1', { turn: 1, step: 2 })).toBe('')

    // 同一 turn 的同一文本在后续 pre-step 仍会看到；不能重新入队。
    ledger.observeUserMessage('s1', '以后不要在我电脑生产端做实验', { turn: 1, step: 2 })
    expect(ledger.pendingCount('s1')).toBe(0)
  })

  it('没有值得保存的信号时不产生检查点', () => {
    const ledger = new MemoryCheckpointLedger()
    ledger.observeUserMessage('s1', '帮我看下这个报错', { turn: 1, step: 1 })
    expect(ledger.render('s1', { turn: 1, step: 1 })).toBe('')
  })

  it('误判信号最多提醒三轮，之后过期，避免永久刷屏', () => {
    const ledger = new MemoryCheckpointLedger()
    ledger.observeUserMessage('s1', '以后不要在我电脑生产端做实验', { turn: 1, step: 1 })
    expect(ledger.render('s1', { turn: 1, step: 1 })).not.toBe('')
    expect(ledger.render('s1', { turn: 2, step: 1 })).toContain('上一轮未记录')
    expect(ledger.render('s1', { turn: 3, step: 1 })).toContain('上一轮未记录')
    expect(ledger.render('s1', { turn: 4, step: 1 })).toBe('')
    expect(ledger.pendingCount('s1')).toBe(0)
  })

  it('clear 与 dispose 清空会话态', () => {
    const ledger = new MemoryCheckpointLedger()
    ledger.observeUserMessage('s1', '以后用 pnpm', { turn: 1, step: 1 })
    ledger.clear('s1')
    expect(ledger.render('s1', { turn: 1, step: 1 })).toBe('')

    ledger.observeUserMessage('s2', '以后用 pnpm', { turn: 1, step: 1 })
    ledger.dispose()
    expect(ledger.render('s2', { turn: 1, step: 1 })).toBe('')
  })
})
