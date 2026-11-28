import type { Attribute } from './entity.js'
import { scopeKey } from './entity-access.js'
import { isPlainObject, type JsonValue } from './json.js'
import type { NormalizedWrite } from './validation.js'

/**
 * 内容指纹：判定“完全相同的事实”的唯一口径（Content Idempotency 第一层之外的实体级去重）。
 *
 * 参与指纹的部分（缺一不可，否则不同事实会被误合并）：
 * - kind 与 scope：不同项目/全局作用域的事实永远可以并存；
 * - category：事实/线索/事件是不同语义层，不能互相顶替；
 * - 全部非易失可选属性 + 必填内容属性（title/body/tags/time…）：文本、数字、时间任一不同
 *   就是不同内容；
 * - 状态机的 time 参与指纹（同一状态不同观测时间可以是两条事实）；
 * - 思维链的 group 按排序后的成员 id 参与（同一成员组视为同一链）。
 *
 * 不参与指纹：
 * - `id`/`scope`/`group`（单独编码，避免每次写入的随机 id 破坏相等性）；
 * - 易失溯源属性（evidence/artifactId/promoted* 等）：这些是“证据/出处”，重复写入同一内容
 *   应当把新证据并入原实体，而不是产生第二条重复记忆。
 *
 * 本函数只返回规范字符串；哈希与列写入在适配器（writer）里做，domain 不碰 node:crypto。
 */
const VOLATILE_ATTRIBUTES: ReadonlySet<string> = new Set([
  'evidence',
  'artifactId',
  'promotedFrom',
  'promotedAt',
  'userConfirmed',
  'assertedBy',
  'verified',
])

/** 规范 JSON：对象键排序、字符串 NFKC + trim，保证同一内容跨进程/跨调用得到同一指纹。 */
function canonicalJson(value: JsonValue): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value.normalize('NFKC').trim())
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key] as JsonValue)}`).join(',')}}`
  }
  return 'null'
}

function attributeCanonical(attribute: Attribute): string {
  if (attribute.value.kind === 'dynamic') return `dynamic:${canonicalJson(attribute.value.spec as unknown as JsonValue)}`
  return `static:${canonicalJson(attribute.value.value)}`
}

/**
 * 规范化内容指纹；`undefined` 表示该写入不参与内容级去重（目前只有 memory 参与）。
 *
 * 状态机/思维链有自己的收敛键（goalId/taskId/autoGroupKey），在这里再做实体级内容合并会
 * 改变抽取/成组语义，所以只对 memory 生效。
 */
export function contentFingerprint(input: NormalizedWrite): string | undefined {
  if (input.kind !== 'memory') return undefined
  const parts = [
    `kind:${input.kind}`,
    `scope:${input.scope.kind}:${scopeKey(input.scope)}`,
  ]
  for (const attribute of input.attributes) {
    if (attribute.name === 'id' || attribute.name === 'scope' || attribute.name === 'group') continue
    if (VOLATILE_ATTRIBUTES.has(attribute.name)) continue
    parts.push(`${attribute.name}=${attributeCanonical(attribute)}`)
  }
  // 空内容（只有 id/scope 等必填）不参与去重：否则所有空记忆会撞成一条。
  if (parts.length <= 2) return undefined
  return parts.join('\n')
}
