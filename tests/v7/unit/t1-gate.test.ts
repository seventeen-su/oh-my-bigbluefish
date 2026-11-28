import { describe, expect, it } from 'vitest'
import {
  hasRecallIntent,
  hasStrongSignal,
  isRecallTriggerEvent,
  recallContentFingerprint,
  shouldRecallOnPreStep,
  shouldRecallToolResult,
  stepKeyOf,
  toolFailed,
} from '../../../plugin/v7/t1.js'

describe('T1 步键', () => {
  it('给定 turn 与 step 当取步键则拼成 turn:step', () => {
    expect(stepKeyOf({ turn: 2, step: 3 })).toBe('2:3')
    expect(stepKeyOf({ turn: 0, step: 0 })).toBe('0:0')
  })

  it('给定缺 step 或非安全整数当取步键则返回 undefined', () => {
    expect(stepKeyOf({ turn: 2 })).toBeUndefined()
    expect(stepKeyOf({ step: 2 })).toBeUndefined()
    expect(stepKeyOf({ turn: 1.5, step: 1 })).toBeUndefined()
    expect(stepKeyOf({ turn: Number.NaN, step: 1 })).toBeUndefined()
    expect(stepKeyOf({ turn: -1, step: 1 })).toBeUndefined()
  })
})

describe('T1 跨 step 内容指纹', () => {
  const base = {
    sessionId: 'session-fp',
    query: 'ENOENT 工具失败 排查',
    result: 'ENOENT missing-file',
  }

  it('给定同一 session+query+result 当取内容指纹则稳定', () => {
    const first = recallContentFingerprint(base)
    expect(first).toMatch(/^[0-9a-f]{32}$/)
    expect(recallContentFingerprint({ ...base })).toBe(first)
  })

  it('给定 session/query/result 任一不同当取内容指纹则不同', () => {
    const first = recallContentFingerprint(base)
    expect(recallContentFingerprint({ ...base, sessionId: 'session-other' })).not.toBe(first)
    expect(recallContentFingerprint({ ...base, query: 'EACCES 工具失败 排查' })).not.toBe(first)
    expect(recallContentFingerprint({ ...base, result: 'EACCES' })).not.toBe(first)
  })
})

describe('T1 回忆意图', () => {
  it.each([
    ['上次那个报错怎么修的', true],
    ['继续之前的状态机改造', true],
    ['现在进度到哪了', true],
    ['重启后服务正常吗，之前失败过', true],
    ['continue from where we left off', true],
    ['列出当前目录', false],
    ['请在 README 里补一段说明', false],
    ['hello world', false],
  ])('给定 %s 当判断回忆意图则 %s', (text, expected) => {
    expect(hasRecallIntent(text)).toBe(expected)
  })
})

describe('T1 强信号', () => {
  it.each([
    ['cat E:\\Program\\Oh-My-BigBlueFish\\docs\\v7\\SPEC.md', true],
    ['plugin/v7/index.ts', true],
    ['ENOENT', true],
    ['missing-file', true],
    ['sessionProjections', true],
    ['ES2023', true],
    ['cat missing-file', true],
    ['git status', false],
    ['npm test', false],
    ['v7:typecheck', false],
    ['ls', false],
    ['hello world', false],
  ])('给定 %s 当判断强信号则 %s', (text, expected) => {
    expect(hasStrongSignal(text)).toBe(expected)
  })
})

describe('T1 工具失败', () => {
  it('给定 isError 当判断失败则为 true', () => {
    expect(toolFailed(true, '')).toBe(true)
  })

  it.each([
    ['exit code 1', true],
    ['构建失败：类型错误', true],
    ['EACCES permission denied', true],
    ['all good', false],
    ['total 0', false],
  ])('给定输出 %s 当判断失败则 %s', (text, expected) => {
    expect(toolFailed(false, text)).toBe(expected)
  })
})

describe('T1 事件触发', () => {
  it.each([
    ['compaction/start', true],
    ['subagent/end', true],
    ['team/task', true],
    ['task/changed', true],
    ['tool/result', false],
    ['goal/change', false],
    ['session/title', false],
  ])('给定事件 %s 当判断触发则 %s', (type, expected) => {
    expect(isRecallTriggerEvent(type)).toBe(expected)
  })
})

describe('T1 pre-step 闸门', () => {
  it('给定待消费事件当判断 pre-step 召回则为 true', () => {
    expect(shouldRecallOnPreStep({ pending: true, text: '' })).toBe(true)
  })

  it('给定明确回忆意图当判断 pre-step 召回则为 true', () => {
    expect(shouldRecallOnPreStep({ pending: false, text: '上次的失败日志在哪' })).toBe(true)
  })

  it('给定用户消息含路径当判断 pre-step 召回则为 true', () => {
    expect(shouldRecallOnPreStep({ pending: false, text: '看下 docs/ARCHITECTURE.md' })).toBe(true)
  })

  it('给定普通用户消息当判断 pre-step 召回则为 false', () => {
    expect(shouldRecallOnPreStep({ pending: false, text: '列出当前目录' })).toBe(false)
    expect(shouldRecallOnPreStep({ pending: false, text: '' })).toBe(false)
  })
})

describe('T1 工具结果闸门', () => {
  it('给定工具失败当判断工具结果召回则为 true', () => {
    expect(shouldRecallToolResult({ failed: true, argumentsText: '', resultText: '' })).toBe(true)
  })

  it('给定成功工具但参数含路径当判断工具结果召回则为 true', () => {
    expect(shouldRecallToolResult({
      failed: false,
      argumentsText: 'cat missing-file',
      resultText: 'ok',
    })).toBe(true)
  })

  it('给定成功工具但结果含错误码当判断工具结果召回则为 true', () => {
    expect(shouldRecallToolResult({
      failed: false,
      argumentsText: '',
      resultText: 'EACCES 拒绝访问',
    })).toBe(true)
  })

  it('给定无关成功工具当判断工具结果召回则为 false', () => {
    expect(shouldRecallToolResult({ failed: false, argumentsText: 'ls', resultText: 'total 0' })).toBe(false)
  })
})

