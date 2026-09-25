/**
 * 工具注册契约测试。
 *
 * 这里钉的是**宿主 `tools.register()` 的真实校验**——它们每一条都曾让
 * 工具在真实宿主里静默失效，而本机测试全绿：
 *
 * ① 必须声明 `output { schema, render, presentationMeta? }`
 *    （`packages/core/tools/src/index.ts:1066-1070`）
 * ② 参数 schema 必须是"只有可枚举字符串键的普通记录"
 *    （`isJsonSchemaRecord` → `hasOnlyEnumerableStringKeys`，
 *    `packages/core/tools/src/json-schema.ts:152`）
 *
 * ②尤其隐蔽：`z.toJSONSchema()` 的返回对象带一个**非枚举**键 `~standard`
 * （zod v4 的 Standard Schema 标记），于是**每个用 zod 生成参数的工具**都被拒绝，
 * 而手写 JSON Schema 的恰好通过——症状是"有的工具有、有的没有"。
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { cleanJsonRecord, toHostTool } from '../../dsh/tools.js'

/** 复刻宿主对参数 schema 的判据。 */
function isPureJsonRecord(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  if (Object.getPrototypeOf(value) !== Object.prototype) return false
  if (Object.getOwnPropertySymbols(value).length > 0) return false
  return Object.getOwnPropertyNames(value).every(
    key => Object.getOwnPropertyDescriptor(value, key)?.enumerable === true,
  )
}

describe('cleanJsonRecord', () => {
  it('去掉非枚举装饰键（zod 的 `~standard` 就是这类）', () => {
    const raw = z.toJSONSchema(z.object({ text: z.string() }))
    // 前提：zod 确实会加这个装饰——否则本测试失去意义，应当删掉
    expect(
      Object.getOwnPropertyNames(raw).filter(
        k => Object.getOwnPropertyDescriptor(raw, k)?.enumerable !== true,
      ),
      '若 zod 不再添加非枚举键，这条契约测试可以删除',
    ).toContain('~standard')

    const cleaned = cleanJsonRecord(raw)
    expect(isPureJsonRecord(cleaned)).toBe(true)
    // 内容不能丢：清洗只去装饰，不改语义
    expect(cleaned.type).toBe('object')
    expect((cleaned.properties as Record<string, unknown>).text).toEqual({ type: 'string' })
  })

  it('递归清洗嵌套对象与数组', () => {
    const raw: Record<string, unknown> = {
      type: 'object',
      properties: { a: { type: 'string' } },
      required: ['a'],
    }
    Object.defineProperty((raw.properties as Record<string, Record<string, unknown>>).a, 'hidden', {
      value: 1,
      enumerable: false,
    })
    const cleaned = cleanJsonRecord(raw)
    expect(isPureJsonRecord(cleaned)).toBe(true)
    // 嵌套对象也必须纯净，且装饰键已消失
    const nested = (cleaned.properties as Record<string, unknown>).a
    expect(isPureJsonRecord(nested)).toBe(true)
    expect(Object.hasOwn(nested as object, 'hidden')).toBe(false)
    expect(nested).toEqual({ type: 'string' })
    expect(cleaned.type).toBe('object')
    expect(cleaned.required).toEqual(['a'])
  })

  it('非对象输入返回空记录（不抛）', () => {
    expect(cleanJsonRecord(undefined)).toEqual({})
    expect(cleanJsonRecord('x')).toEqual({})
    expect(cleanJsonRecord([1, 2])).toEqual({})
  })
})

describe('toHostTool', () => {
  it('补齐 output，且参数 schema 纯净化', () => {
    const raw = z.toJSONSchema(z.object({ topic: z.string(), depth: z.enum(['quick', 'deep']) }))
    const host = toHostTool({
      name: 'x',
      description: 'y',
      parameters: raw as Record<string, unknown>,
      run: () => ({ kind: 'text', text: 'done' }),
    })
    // ① 宿主要求的 output
    expect(typeof host.output.render).toBe('function')
    expect(host.output.schema).toBeDefined()
    // ② 参数必须纯净，否则 `tools.schemas()` 会抛
    expect(isPureJsonRecord(host.parameters)).toBe(true)
    // 内容仍在（模型看得到参数）
    expect((host.parameters.properties as Record<string, unknown>).topic).toEqual({ type: 'string' })
  })

  it('执行体把 ToolOutcome 转成规范字符串，且绝不抛', async () => {
    const ok = toHostTool({ name: 'a', description: 'd', parameters: {}, run: () => ({ kind: 'text', text: '好' }) })
    expect(await ok.execute({})).toBe('好')

    const bad = toHostTool({ name: 'b', description: 'd', parameters: {}, run: () => ({ kind: 'error', text: '不行' }) })
    expect(await bad.execute({})).toBe('错误：不行')

    const throwing = toHostTool({
      name: 'c',
      description: 'd',
      parameters: {},
      run: () => {
        throw new Error('炸了')
      },
    })
    // 工具执行体抛异常必须变成可读文本，而不是中断回合
    await expect(throwing.execute({})).resolves.toContain('炸了')
  })
})
