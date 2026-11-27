import { describe, expect, it } from 'vitest'
import { T1ContentWindow } from '../../../plugin/v7/t1.js'

const session = 's-window'
const content = '[OMB 事件召回]\n相关：[in_progress] 同一段内容'

describe('T1ContentWindow: 跨步/跨轮内容去重', () => {
  it('同一 turn 内 12 步窗口内重复内容不再注入', () => {
    const window = new T1ContentWindow()
    window.remember(session, content, { turn: 1, step: 1 })
    expect(window.isDuplicate(session, content, { turn: 1, step: 2 })).toBe(true)
    expect(window.isDuplicate(session, content, { turn: 1, step: 13 })).toBe(true)
  })

  it('超过 12 步后允许再次注入（上下文可能已压缩）', () => {
    const window = new T1ContentWindow()
    window.remember(session, content, { turn: 1, step: 1 })
    expect(window.isDuplicate(session, content, { turn: 1, step: 14 })).toBe(false)
  })

  it('A-B-A 中间插入别的召回时，A 仍按内容窗口去重', () => {
    const window = new T1ContentWindow()
    window.remember(session, content, { turn: 2, step: 1 })
    window.remember(session, '[OMB 事件召回]\n相关：另一段内容', { turn: 2, step: 2 })
    expect(window.isDuplicate(session, content, { turn: 2, step: 3 })).toBe(true)
  })

  it('不同内容不互相抑制', () => {
    const window = new T1ContentWindow()
    window.remember(session, content, { turn: 1, step: 1 })
    expect(window.isDuplicate(session, `${content}\n不同结尾`, { turn: 1, step: 2 })).toBe(false)
  })

  it('3 轮窗口内跨轮去重，超过后允许', () => {
    const window = new T1ContentWindow()
    window.remember(session, content, { turn: 1, step: 1 })
    expect(window.isDuplicate(session, content, { turn: 4, step: 1 })).toBe(true)
    expect(window.isDuplicate(session, content, { turn: 5, step: 1 })).toBe(false)
  })

  it('没有 turn/step 时按最近 12 次注入窗口去重', () => {
    const window = new T1ContentWindow()
    window.remember(session, content)
    expect(window.isDuplicate(session, content)).toBe(true)
    for (let index = 0; index < 13; index += 1) {
      window.remember(session, `[OMB 事件召回]\n相关：第 ${index} 段`)
    }
    expect(window.isDuplicate(session, content)).toBe(false)
  })

  it('空文本不参与去重，clear 只清指定会话', () => {
    const window = new T1ContentWindow()
    expect(window.isDuplicate(session, '   ')).toBe(false)
    window.remember(session, content, { turn: 1, step: 1 })
    window.remember('other', content, { turn: 1, step: 1 })
    window.clear(session)
    expect(window.isDuplicate(session, content, { turn: 1, step: 2 })).toBe(false)
    expect(window.isDuplicate('other', content, { turn: 1, step: 2 })).toBe(true)
  })
})
