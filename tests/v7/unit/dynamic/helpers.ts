import { expect } from 'vitest'
import { OmbFailure, type OmbError, type OmbErrorCode } from '../../../../packages/v7/src/domain/errors.js'
import type { JsonValue } from '../../../../packages/v7/src/domain/json.js'
import type { DynamicContext } from '../../../../packages/v7/src/ports/dynamic.js'

export type TaskSource = 'subagent' | 'team' | 'job'

export interface FakeContextOptions {
  /** entityId → (属性名 → 值)；属性名为 '' 表示 getAttribute 省略 attr。 */
  readonly attributes?: Record<string, Record<string, JsonValue | undefined>>
  /** 解析后的绝对路径 → 文件内容。 */
  readonly files?: Record<string, string>
  /** `${source}:${id}` 或 `${source}:${id}.${field}` → 任务值。 */
  readonly tasks?: Record<string, JsonValue | undefined>
  readonly projectRoot?: string
  readonly now?: string
  readonly depth?: number
  readonly signal?: AbortSignal
}

export class FakeContext implements DynamicContext {
  readonly attributeCalls: Array<{ entityId: string; attr?: string }> = []
  readonly readFileCalls: string[] = []
  readonly taskCalls: Array<{ source: TaskSource; id: string; field?: string }> = []
  readonly now: string
  readonly depth: number
  readonly projectRoot?: string
  readonly signal?: AbortSignal
  private readonly attributes: Map<string, JsonValue | undefined>
  private readonly files: Map<string, string>
  private readonly tasks: Map<string, JsonValue | undefined>

  constructor(options: FakeContextOptions = {}) {
    this.now = options.now ?? '2026-11-22T00:00:00.000Z'
    this.depth = options.depth ?? 0
    if (options.projectRoot !== undefined) this.projectRoot = options.projectRoot
    if (options.signal !== undefined) this.signal = options.signal
    this.attributes = new Map()
    for (const [entityId, perAttribute] of Object.entries(options.attributes ?? {})) {
      for (const [attr, value] of Object.entries(perAttribute)) {
        this.attributes.set(attributeKey(entityId, attr === '' ? undefined : attr), value)
      }
    }
    this.files = new Map(Object.entries(options.files ?? {}))
    this.tasks = new Map(Object.entries(options.tasks ?? {}))
  }

  async getAttribute(entityId: string, attr?: string): Promise<JsonValue | undefined> {
    this.attributeCalls.push(attr === undefined ? { entityId } : { entityId, attr })
    return this.attributes.get(attributeKey(entityId, attr))
  }

  async readFile(path: string): Promise<string> {
    this.readFileCalls.push(path)
    const content = this.files.get(path)
    if (content === undefined) {
      const error = new Error(`ENOENT: ${path}`) as Error & { code: string }
      error.code = 'ENOENT'
      throw error
    }
    return content
  }

  async readTask(source: TaskSource, id: string, field?: string): Promise<JsonValue | undefined> {
    this.taskCalls.push(field === undefined ? { source, id } : { source, id, field })
    const direct = this.tasks.get(`${source}:${id}${field === undefined ? '' : `.${field}`}`)
    if (direct !== undefined) return direct
    return this.tasks.get(`${source}:${id}`)
  }
}

export function attributeKey(entityId: string, attr: string | undefined): string {
  return `${entityId}\u0000${attr ?? ''}`
}

/** 断言 Promise 以 OmbFailure 失败，且 code（可选消息）符合预期。 */
export async function expectOmbError(
  promise: Promise<unknown>,
  code: OmbErrorCode,
  message?: RegExp,
): Promise<OmbError> {
  const caught = await promise.then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error }),
  )
  expect(caught.ok).toBe(false)
  if (caught.ok) throw new Error('期望失败但调用成功了')
  expect(caught.error).toBeInstanceOf(OmbFailure)
  const error = (caught.error as OmbFailure).error
  expect(error.code).toBe(code)
  if (message !== undefined) expect(error.message).toMatch(message)
  return error
}
