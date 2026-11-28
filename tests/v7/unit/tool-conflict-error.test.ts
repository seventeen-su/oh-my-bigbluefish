import { describe, expect, it } from 'vitest'
import { createToolDefinitions, type ToolRuntime } from '../../../packages/v7/src/adapters/dsh/tools.js'
import type { OmbError, Result } from '../../../packages/v7/src/domain/errors.js'

/**
 * 冲突错误必须是“可行动的完整差异”，不是一句 `conflict: 版本已变化`。
 *
 * 工具结果文本是模型唯一看得到的错误面：两侧 revision、当前状态/标题、冲突字段、
 * actor/source 缺一项，调用方就只能猜；同时文本有上限，不能把大属性对象回灌。
 */

const CWD = 'D:\\Program\\Oh-My-BigBlueFish'
const CONTEXT = { sessionId: 'session-1', cwd: CWD, projectKey: CWD }
const EXEC = { agent: { session: { id: 'session-1', header: { cwd: CWD } } }, sessionId: 'session-1' }
const STATE_ID = 'st_12345678-1234-4123-8123-123456789abc'

function runtimeWith(update: (input: unknown) => Promise<Result<string>>): ToolRuntime {
  const unused = async (): Promise<never> => {
    throw new Error('本用例不触达该工具')
  }
  return {
    context: async () => CONTEXT,
    remember: unused,
    recall: unused,
    update: update as ToolRuntime['update'],
    link: unused,
    unlink: unused,
    history: unused,
    status: unused,
    admin: unused,
  }
}

function toolOf(runtime: ToolRuntime, name: string) {
  const definition = createToolDefinitions(runtime).find(item => item.name === name)
  if (definition === undefined) throw new Error(`缺少工具：${name}`)
  return definition
}

const CONFLICT: OmbError = {
  code: 'conflict',
  message: '实体版本已变化（期望 1，当前 2）；当前状态 blocked；冲突字段 status、title',
  details: {
    entityId: STATE_ID,
    expectedRevision: 1,
    currentRevision: 2,
    currentStatus: 'blocked',
    currentTitle: '用户改的标题',
    currentTime: '2026-11-29T00:00:00.000Z',
    conflictingFields: [
      { field: 'status', incoming: 'completed', current: 'blocked' },
      { field: 'title', incoming: 'AI 覆盖', current: '用户改的标题' },
    ],
    conflictingFieldCount: 2,
    actor: { id: 'model', kind: 'model' },
    source: 'model',
  },
}

describe('工具冲突错误体', () => {
  it('给定冲突当执行 omb_update 则文本带两侧版本、当前状态、冲突字段与 actor/source', async () => {
    const definition = toolOf(runtimeWith(async () => ({ ok: false, error: CONFLICT })), 'omb_update')
    const result = await definition.execute({ id: STATE_ID, expectedRevision: 1, status: 'completed' }, EXEC)
    expect(result.ok).toBe(false)
    expect(result.text).toContain('conflict: 实体版本已变化')
    expect(result.text).toContain('expectedRevision=1 currentRevision=2')
    expect(result.text).toContain('currentStatus=blocked')
    expect(result.text).toContain('currentTitle=用户改的标题')
    expect(result.text).toContain('actor=model(model)')
    expect(result.text).toContain('source=model')
    expect(result.text).toContain('conflictingFields=')
    expect(result.text).toContain('status: incoming="completed" current="blocked"')
    expect(result.text).toContain('title: incoming="AI 覆盖" current="用户改的标题"')
  })

  it('给定非冲突错误当执行工具则只输出 code: message，不拼接无关细节', async () => {
    const definition = toolOf(runtimeWith(async () => ({
      ok: false,
      error: { code: 'invalid-input', message: 'expectedRevision 必须是正整数', details: { field: 'expectedRevision' } },
    })), 'omb_update')
    const result = await definition.execute({ id: STATE_ID, expectedRevision: 1, attrs: {} }, EXEC)
    expect(result.ok).toBe(false)
    expect(result.text).toBe('invalid-input: expectedRevision 必须是正整数')
  })

  it('给定冲突字段很多当执行工具则文本有上限且标明字段总数', async () => {
    const fields = Array.from({ length: 20 }, (_, index) => ({
      field: `field_${index}`,
      incoming: 'x'.repeat(200),
      current: 'y'.repeat(200),
    }))
    const definition = toolOf(runtimeWith(async () => ({
      ok: false,
      error: { ...CONFLICT, details: { ...CONFLICT.details as object, conflictingFields: fields, conflictingFieldCount: 25 } },
    })), 'omb_update')
    const result = await definition.execute({ id: STATE_ID, expectedRevision: 1, attrs: {} }, EXEC)
    expect(result.text.length).toBeLessThanOrEqual(2048 + 1)
    expect(result.text).toContain('conflictingFieldCount=25')
    expect(result.text.endsWith('…')).toBe(true)
  })
})
