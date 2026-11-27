import type { JsonValue } from './json.js'

/**
 * 动态属性值的 spec 形状（ARCHITECTURE-PLAN §3.2、SPEC §7）。
 *
 * spec 是**可持久化的数据**：落库在 `omb.attribute.expr`，由 DynamicResolver 在
 * 读取时解析（QuickJS/网络/文件都在适配器），domain 只定义形状与引用关系。
 * 静态值与动态值都在这里定义，避免 `entity.ts` 同时承载实体聚合与动态值契约。
 */

export interface RefSpec {
  readonly kind: 'ref'
  readonly entityId: string
  readonly attr?: string
  readonly fallback?: JsonValue
}

export interface TemplateSpec {
  readonly kind: 'template'
  readonly template: string
  readonly refs?: readonly { readonly entityId: string; readonly attr?: string; readonly as?: string }[]
}

export interface FileSpec {
  readonly kind: 'file'
  readonly path: string
  readonly extract?:
    | { readonly kind: 'text' }
    | { readonly kind: 'json'; readonly pointer?: string }
    | { readonly kind: 'regex'; readonly source: string; readonly flags?: string; readonly group?: number }
}

export interface RegexSpec {
  readonly kind: 'regex'
  readonly source: string
  readonly flags?: string
  readonly input: RefSpec | { readonly kind: 'literal'; readonly value: string }
  readonly group?: number
}

export interface CodeSpec {
  readonly kind: 'code'
  readonly source: string
  readonly timeoutMs?: number
  readonly memoryMb?: number
}

export interface TaskSpec {
  readonly kind: 'task'
  readonly source: 'subagent' | 'team' | 'job'
  readonly id: string
  readonly field?: string
}

export interface UrlSpec {
  readonly kind: 'url'
  readonly url: string
  readonly jsonPath?: string
  readonly allowlist?: readonly string[]
}

export type DynamicSpec = RefSpec | TemplateSpec | FileSpec | RegexSpec | CodeSpec | TaskSpec | UrlSpec

export interface StaticAttributeValue {
  readonly kind: 'static'
  readonly value: JsonValue
}

export interface DynamicAttributeValue {
  readonly kind: 'dynamic'
  readonly spec: DynamicSpec
  readonly cachedValue?: JsonValue
  readonly cachedAt?: string
  readonly staleAfterMs?: number
  readonly lastError?: string
}

export type AttributeValue = StaticAttributeValue | DynamicAttributeValue

/** 属性输入：普通 JSON 是静态值；`{ $dynamic: spec }` 是动态值。 */
export type RawAttributeValue = JsonValue | { readonly $dynamic: DynamicSpec }
