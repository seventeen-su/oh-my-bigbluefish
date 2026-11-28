/**
 * 组合根的消息/文本工具：从 DSH 消息与工具结果里提取可检索文本，格式化工具返回值。
 *
 * 这些函数不读宿主、不查库、不保存状态；宿主形状的解析集中在 `asRecord` 与这里的
 * 提取函数，钩子层只负责把结果拼进注入消息与工具返回值。
 */
import { asRecord } from '../../packages/v7/src/adapters/dsh/host.js'
import { OmbFailure, err, type Result } from '../../packages/v7/src/domain/errors.js'
import type { RememberService } from '../../packages/v7/src/app/remember.js'
import type { UpdateService } from '../../packages/v7/src/app/update.js'

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function resultError(error: unknown): Result<never> {
  if (error instanceof OmbFailure) return err(error.error)
  return err({ code: 'internal', message: messageOf(error) })
}

export function lastUserText(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = typeof messages[index] === 'object' && messages[index] !== null ? messages[index] as Record<string, unknown> : undefined
    if (message === undefined) continue
    const source = typeof message['source'] === 'object' && message['source'] !== null ? message['source'] as Record<string, unknown> : undefined
    const content = message['content']
    const text = typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map(block => {
            if (typeof block === 'string') return block
            const record = typeof block === 'object' && block !== null ? block as Record<string, unknown> : undefined
            return typeof record?.['text'] === 'string' ? record['text'] as string : ''
          }).filter(Boolean).join('\n')
        : ''
    if (text.trim().length > 0 && (source?.['kind'] === 'user' || source?.['kind'] === undefined)) return text.trim()
  }
  return undefined
}

export function lastToolText(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = typeof messages[index] === 'object' && messages[index] !== null ? messages[index] as Record<string, unknown> : undefined
    if (message === undefined) continue
    const source = typeof message['source'] === 'object' && message['source'] !== null ? message['source'] as Record<string, unknown> : undefined
    if (source?.['kind'] !== 'tool' && message['role'] !== 'tool') continue
    const content = message['content']
    const text = typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map(block => {
            if (typeof block === 'string') return block
            const record = typeof block === 'object' && block !== null ? block as Record<string, unknown> : undefined
            return typeof record?.['text'] === 'string' ? record['text'] as string : ''
          }).filter(Boolean).join('\n')
        : ''
    if (text.trim().length > 0) return text
  }
  return undefined
}

/** 取最近 N 条非空消息文本；用于 T1 查询的“最近几轮”，而不是只看最后一条。 */
export function lastRoundsText(messages: unknown, rounds: number): string | undefined {
  if (!Array.isArray(messages) || rounds <= 0) return undefined
  const texts: string[] = []
  for (let index = messages.length - 1; index >= 0 && texts.length < rounds; index -= 1) {
    const message = typeof messages[index] === 'object' && messages[index] !== null ? messages[index] as Record<string, unknown> : undefined
    if (message === undefined) continue
    const content = message['content']
    const text = typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map(block => {
            if (typeof block === 'string') return block
            const record = typeof block === 'object' && block !== null ? block as Record<string, unknown> : undefined
            return typeof record?.['text'] === 'string' ? record['text'] as string : ''
          }).filter(Boolean).join('\n')
        : ''
    if (text.trim().length > 0) texts.push(text.trim())
  }
  return texts.length === 0 ? undefined : texts.reverse().join('\n')
}

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(undefined), timeoutMs)
    timer.unref?.()
    promise.then(value => {
      clearTimeout(timer)
      resolve(value)
    }).catch(() => {
      clearTimeout(timer)
      resolve(undefined)
    })
  })
}

export function formatWrite(result: Awaited<ReturnType<RememberService['remember']>>): string {
  if (!result.ok) return ''
  const written = result.value
  const lines = [`已写入 ${written.entity.kind} ${written.entity.id}（revision ${written.entity.revision}，嵌入 ${written.embedding}）`]
  if (written.similarAttributes.length > 0) {
    lines.push(`相似属性：${written.similarAttributes.slice(0, 8).map(item => `${item.name}(${item.usageCount})`).join('、')}`)
  }
  if (written.similarEntities.length > 0) {
    lines.push(`相似记忆：${written.similarEntities.slice(0, 5).map(item => `${item.title ?? item.id}(${item.id})`).join('；')}`)
  }
  if (written.archivedMatches.length > 0) {
    lines.push(`已归档冲突：${written.archivedMatches.slice(0, 3).map(item => `${item.title ?? item.id}(${item.id})`).join('；')}`)
  }
  return lines.join('\n')
}

export function formatPatch(result: Awaited<ReturnType<UpdateService['update']>>): string {
  if (!result.ok) return ''
  const patched = result.value
  return `已更新 ${patched.entity.kind} ${patched.entity.id}（revision ${patched.entity.revision}）` +
    (patched.history === undefined ? '' : `；历史 ${patched.history.id}`)
}

/** 从 DSH content block 数组提取可检索文本；图片等非文本块跳过。 */
export function contentText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(contentText).filter(part => part.length > 0).join('\n')
  const record = asRecord(value)
  if (record === undefined) return ''
  if (typeof record['text'] === 'string') return record['text']
  if (typeof record['content'] === 'string') return record['content']
  return ''
}

export function toolResultText(result: unknown): string {
  const record = asRecord(result)
  if (record === undefined) return ''
  const parts = [contentText(record['content']), contentText(record['value'])]
  const error = asRecord(record['error'])
  if (error !== undefined) {
    parts.push([error['name'], error['code'], error['reason']]
      .filter((part): part is string => typeof part === 'string' && part.length > 0)
      .join(' '))
  }
  return parts.filter(part => part.length > 0).join('\n')
}

/** 事件载荷的可检索文本：字符串原样，对象尽力 JSON 序列化（失败按空串）。 */
export function eventText(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}
