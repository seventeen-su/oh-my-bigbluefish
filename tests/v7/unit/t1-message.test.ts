import { describe, expect, it } from 'vitest'
import {
  appendT1Message,
  createT1UserMessage,
  isEnterDecisionLike,
  type PreStepEnterLike,
} from '../../../plugin/v7/t1-message.js'

/** 生产者身份是契约的一部分：测试里写字面量，改常量会直接变红。 */
const PRODUCER_KIND = 'plugin:oh-my-bigbluefish/v7'

const T1_TEXT = '[OMB 事件召回]\n相关：ENOENT 失败处理方式（mem_demo）'

/** DSH 基线 decision 里已有的消息（T0 runtime-context 也走同一条 messages 通道）。 */
const claimedMessage = {
  id: 'msg_claimed_1',
  role: 'user',
  source: { kind: 'user' },
  content: [{ type: 'text', text: 'ENOENT 上次失败的处理方式' }],
}

function enterDecision(messages: unknown[]): PreStepEnterLike {
  return { kind: 'enter', messages }
}

describe('T1 注入消息形状', () => {
  it('给定 T1 文本当构造注入消息则得到 producer-owned user message', () => {
    const message = createT1UserMessage(T1_TEXT)
    // DSH user/message 准入校验要求 id 非空、role=user、source.kind 非空、content 为数组：
    // packages/core/session/src/index.ts:337-363。
    expect(message?.id).toMatch(/^msg_omb_[0-9a-f-]{36}$/)
    expect(message?.role).toBe('user')
    expect(message?.source).toEqual({ kind: PRODUCER_KIND })
    expect(message?.content).toEqual([{ type: 'text', text: T1_TEXT }])
  })

  it('给定同一段 T1 文本当构造两次则身份不同（会话日志按 id 标识消息）', () => {
    const first = createT1UserMessage(T1_TEXT)
    const second = createT1UserMessage(T1_TEXT)
    expect(first?.id).not.toBe(second?.id)
  })

  it.each([
    ['空串', ''],
    ['空格', '   '],
    ['空白行', '\n\t '],
  ])('给定%s当构造注入消息则返回 undefined（空 T1 不追加）', (_label, text) => {
    expect(createT1UserMessage(text)).toBeUndefined()
  })

  it('给定 T1 文本当构造注入消息则不带宿主私有字段或 system 角色', () => {
    const message = createT1UserMessage(T1_TEXT)
    expect(message).not.toHaveProperty('plugin')
    expect(message).not.toHaveProperty('role', 'system')
    expect(message?.source).not.toHaveProperty('plugin')
  })
})

describe('T1 追加到 pre-step decision', () => {
  it('给定 enter decision 当追加 T1 则 T1 是最后一条且原有消息原样保留', () => {
    const decision = enterDecision([claimedMessage])
    const appended = appendT1Message(decision, T1_TEXT)
    expect(appended.messages).toHaveLength(2)
    // 宿主准入按 messages 顺序落 durable user/message；既有的认领消息不能被替换或重排。
    expect(appended.messages[0]).toBe(claimedMessage)
    expect(appended.messages[1]).toMatchObject({
      role: 'user',
      source: { kind: PRODUCER_KIND },
      content: [{ type: 'text', text: T1_TEXT }],
    })
  })

  it('给定 startsRequestSeries 当追加 T1 则保留该字段（宿主用它切分模型消息序列）', () => {
    const appended = appendT1Message({ kind: 'enter', messages: [], startsRequestSeries: true }, T1_TEXT)
    expect(appended.startsRequestSeries).toBe(true)
  })

  it('给定空白 T1 文本当追加则原 decision 不变且不追加消息', () => {
    const decision = enterDecision([claimedMessage])
    expect(appendT1Message(decision, '  ')).toBe(decision)
  })

  it('给定 enter decision 当追加 T1 则不修改原对象（宿主决策不可变）', () => {
    const decision = enterDecision([claimedMessage])
    appendT1Message(decision, T1_TEXT)
    expect(decision.messages).toHaveLength(1)
  })
})

describe('pre-step decision 形状判定', () => {
  it('给定带 messages 的 enter decision 当判定则为真', () => {
    expect(isEnterDecisionLike(enterDecision([]))).toBe(true)
    expect(isEnterDecisionLike({ kind: 'enter', messages: [], startsRequestSeries: true })).toBe(true)
  })

  it.each([
    ['reject', { kind: 'reject' }],
    ['缺 messages', { kind: 'enter' }],
    ['messages 非数组', { kind: 'enter', messages: 'x' }],
    ['null', null],
    ['undefined', undefined],
    ['字符串', 'enter'],
  ])('给定%s当判定则不是 enter decision', (_label, value) => {
    expect(isEnterDecisionLike(value)).toBe(false)
  })
})
