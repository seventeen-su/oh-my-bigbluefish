import type {
  CodeSpec,
  DynamicSpec,
  FileSpec,
  RefSpec,
  RawAttributeValue,
  RegexSpec,
  TaskSpec,
  TemplateSpec,
  UrlSpec,
} from '../../domain/dynamic-spec.js'
import { OmbFailure, fail, internal, invalid, notFound, type OmbError } from '../../domain/errors.js'
import { isJsonValue, isPlainObject, type JsonValue } from '../../domain/json.js'
import type { CodeSandbox, DynamicContext, DynamicResolver, SandboxResult } from '../../ports/dynamic.js'
import { QuickJsSandbox } from '../quickjs/sandbox.js'
import {
  assertRegularFile,
  assertTextWithinLimit,
  defaultFileStat,
  DEFAULT_MAX_FILE_BYTES,
  resolveFilePath,
  type FileStat,
} from './file.js'
import { resolveJsonPath } from './json-pointer.js'
import { isInsideRoot } from './path-guard.js'
import { scanCodeRefs } from './ref-scan.js'
import { renderTemplate } from './template.js'
import { assertUrlAllowed, fetchUrlText, type UrlFetchPolicy } from './url.js'

/** SPEC：引用解析深度最多 8 层。 */
export const MAX_REFERENCE_DEPTH = 8
export { DEFAULT_MAX_FILE_BYTES }

export interface DynamicResolverOptions {
  /** 可注入替身；默认使用 QuickJS WASM 沙箱。 */
  readonly sandbox?: CodeSandbox
  /** url 动态值的宿主闸门；缺省表示 url 一律拒绝。 */
  readonly url?: UrlFetchPolicy
  readonly maxFileBytes?: number
  /** 生产宿主必须传 fs.realpath；解析符号链接后再校验是否仍在 projectRoot 内。 */
  readonly realpath?: (path: string) => Promise<string>
  /** stat 预检钩子；默认 lstat（不跟随符号链接），测试可注入替身。 */
  readonly statFile?: FileStat
}

/**
 * 动态属性解析器：实现 SPEC §5.2 的 ref/template/file/regex/code/task/url。
 *
 * 安全边界：
 * - 文件只能读 `context.projectRoot` 之内：词法拒绝 UNC/设备/`..`，realpath 后再验根，
 *   stat 预检拒绝符号链接/非普通文件/超限文件，读取后复核字节上限（见 file.ts）；
 * - url 默认拒绝，需要宿主显式启用 + allowlist 命中 + 私网/环回排除；实际请求走
 *   EgressBroker：DNS 后逐 IP 校验、固定 IP、禁重定向、流式字节上限（见 security/egress.ts）；
 * - 动态代码只进 QuickJS 沙箱，`ctx.ref` 由预扫描/预加载实现，宿主函数不进入沙箱。
 *
 * 深度与循环：嵌套动态值（属性值本身是 `{ $dynamic: spec }`）按深度 +1 继续解析，
 * 超过 8 层或同一 spec 在解析栈上重复出现时返回 `reference-cycle`，不会挂死。
 */
export class DefaultDynamicResolver implements DynamicResolver {
  private readonly sandbox: CodeSandbox
  private readonly url?: UrlFetchPolicy
  private readonly maxFileBytes: number
  private readonly realpath?: (path: string) => Promise<string>
  private readonly statFile: FileStat

  constructor(options: DynamicResolverOptions = {}) {
    this.sandbox = options.sandbox ?? new QuickJsSandbox()
    this.url = options.url
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
    this.realpath = options.realpath
    this.statFile = options.statFile ?? defaultFileStat
  }

  async resolve(spec: DynamicSpec, context: DynamicContext): Promise<JsonValue | undefined> {
    const startDepth = Number.isFinite(context.depth) ? Math.max(0, Math.trunc(context.depth)) : 0
    return this.resolveSpec(spec, context, startDepth, [])
  }

  private async resolveSpec(
    spec: DynamicSpec,
    context: DynamicContext,
    depth: number,
    trail: string[],
  ): Promise<JsonValue | undefined> {
    if (!isPlainObject(spec) || typeof spec['kind'] !== 'string') {
      throw fail(invalid('动态值必须是带 kind 的对象'))
    }
    const typed = spec as DynamicSpec
    if (depth > MAX_REFERENCE_DEPTH) {
      throw fail({
        code: 'reference-cycle',
        message: `引用解析深度超过 ${MAX_REFERENCE_DEPTH} 层`,
        details: { depth, limit: MAX_REFERENCE_DEPTH, trail: [...trail] },
      })
    }
    const key = specKey(typed)
    if (trail.includes(key)) {
      throw fail({
        code: 'reference-cycle',
        message: `检测到循环引用：${trail[trail.length - 1] ?? ''} -> ${key}`,
        details: { key, trail: [...trail, key] },
      })
    }
    trail.push(key)
    try {
      switch (typed.kind) {
        case 'ref':
          return await this.resolveRef(typed, context, depth, trail)
        case 'template':
          return await this.resolveTemplate(typed, context, depth, trail)
        case 'file':
          return await this.resolveFile(typed, context)
        case 'regex':
          return await this.resolveRegex(typed, context, depth, trail)
        case 'code':
          return await this.resolveCode(typed, context, depth, trail)
        case 'task':
          return await this.resolveTask(typed, context)
        case 'url':
          return await this.resolveUrl(typed, context)
        default:
          throw fail(invalid(`未知动态值类型：${String((typed as { kind?: unknown }).kind)}`))
      }
    } finally {
      trail.pop()
    }
  }

  private async resolveRef(spec: RefSpec, context: DynamicContext, depth: number, trail: string[]): Promise<JsonValue | undefined> {
    const value = await this.readRef(context, spec.entityId, spec.attr, depth + 1, trail)
    if (value !== undefined) return value
    return spec.fallback
  }

  private async resolveTemplate(spec: TemplateSpec, context: DynamicContext, depth: number, trail: string[]): Promise<JsonValue> {
    const values = new Map<string, string>()
    for (const ref of spec.refs ?? []) {
      const name = ref.as ?? ref.entityId
      if (values.has(name)) continue
      const value = await this.readRef(context, ref.entityId, ref.attr, depth + 1, trail)
      values.set(name, templateText(value))
    }
    return renderTemplate(spec.template, values)
  }

  private async resolveRegex(spec: RegexSpec, context: DynamicContext, depth: number, trail: string[]): Promise<JsonValue | undefined> {
    const regex = compileRegex(spec.source, spec.flags, '动态正则')
    let input: string
    if (spec.input.kind === 'literal') {
      input = spec.input.value
    } else {
      const value = await this.readRef(context, spec.input.entityId, spec.input.attr, depth + 1, trail)
      if (value === undefined) return undefined
      input = typeof value === 'string' ? value : JSON.stringify(value)
    }
    const match = regex.exec(input)
    if (match === null) return undefined
    const captured = match[spec.group ?? 0]
    return captured === undefined ? undefined : captured
  }

  private async resolveFile(spec: FileSpec, context: DynamicContext): Promise<JsonValue | undefined> {
    const root = context.projectRoot
    if (root === undefined || root.trim().length === 0) {
      throw fail(invalid(`文件动态值需要 context.projectRoot 才能限制读取范围：${spec.path}`))
    }
    const resolved = resolveFilePath(root, spec.path)
    let readable = resolved
    if (this.realpath !== undefined) {
      const [realRoot, realFile] = await Promise.all([
        this.realpath(root).catch(error => { throw fail(notFound(`项目根不可读：${root}（${messageOf(error)}）`)) }),
        this.realpath(resolved).catch(error => { throw fail(notFound(`文件不存在：${spec.path}（${messageOf(error)}）`)) }),
      ])
      if (!isInsideRoot(realRoot, realFile)) {
        throw fail(invalid(`文件符号链接越过项目根：${spec.path}`))
      }
      readable = realFile
    }
    const info = await this.statFile(readable).catch(error => { throw fail(statError(error, spec.path)) })
    assertRegularFile(spec.path, info, this.maxFileBytes)
    const text = await this.readTextFile(context, readable, spec.path)
    const extract = spec.extract
    if (extract === undefined || extract.kind === 'text') return text
    if (extract.kind === 'json') {
      const document = parseJsonText(text, `文件 ${spec.path} 不是合法 JSON`)
      if (extract.pointer === undefined || extract.pointer.trim().length === 0) return document
      const pointer = resolveJsonPath(document, extract.pointer)
      if (!pointer.found) throw fail(notFound(`JSON 路径未命中：${extract.pointer}（${spec.path}）`))
      return pointer.value
    }
    const regex = compileRegex(extract.source, extract.flags, `文件 ${spec.path} 的提取正则`)
    const match = regex.exec(text)
    if (match === null) return undefined
    const captured = match[extract.group ?? 0]
    return captured === undefined ? undefined : captured
  }

  private async resolveCode(spec: CodeSpec, context: DynamicContext, depth: number, trail: string[]): Promise<JsonValue | undefined> {
    const refs: Record<string, Record<string, JsonValue | null>> = {}
    for (const ref of scanCodeRefs(spec.source)) {
      const value = await this.readRef(context, ref.entityId, ref.attr, depth + 1, trail)
      const perEntity = refs[ref.entityId] ?? {}
      perEntity[ref.attr ?? ''] = value === undefined ? null : value
      refs[ref.entityId] = perEntity
    }
    const input: JsonValue = { refs, attrs: {}, now: context.now }
    const options: { timeoutMs?: number; memoryMb?: number } = {}
    if (spec.timeoutMs !== undefined) options.timeoutMs = spec.timeoutMs
    if (spec.memoryMb !== undefined) options.memoryMb = spec.memoryMb
    const result: SandboxResult = await this.sandbox.run(spec.source, input, options)
    return result.value
  }

  private async resolveTask(spec: TaskSpec, context: DynamicContext): Promise<JsonValue | undefined> {
    let value: JsonValue | undefined
    try {
      value = await context.readTask(spec.source, spec.id, spec.field)
    } catch (error) {
      throw fail(contextError(error, `读取任务 ${spec.source}/${spec.id} 失败`))
    }
    if (value === undefined) {
      throw fail(notFound(`任务不存在或没有该字段：${spec.source}/${spec.id}${spec.field === undefined ? '' : `.${spec.field}`}`))
    }
    if (!isJsonValue(value)) throw fail(invalid(`任务 ${spec.source}/${spec.id} 返回的不是 JSON`))
    return value
  }

  private async resolveUrl(spec: UrlSpec, context: DynamicContext): Promise<JsonValue | undefined> {
    const url = assertUrlAllowed(spec, this.url)
    const policy = this.url
    if (policy === undefined) throw fail({ code: 'unsupported', message: 'url 动态值默认关闭：需要宿主显式启用并配置 allowlist' })
    const text = await fetchUrlText(url, policy, context.signal)
    if (spec.jsonPath === undefined || spec.jsonPath.trim().length === 0) return text
    const document = parseJsonText(text, `url ${url.toString()} 的响应不是合法 JSON`)
    const pointer = resolveJsonPath(document, spec.jsonPath)
    if (!pointer.found) throw fail(notFound(`JSON 路径未命中：${spec.jsonPath}（${url.toString()}）`))
    return pointer.value
  }

  private async readTextFile(context: DynamicContext, resolvedPath: string, originalPath: string): Promise<string> {
    let text: unknown
    try {
      text = await context.readFile(resolvedPath)
    } catch (error) {
      const omb = contextError(error, `读取文件失败：${originalPath}`)
      if (omb.code !== 'internal') throw fail(omb)
      const code = (error as { code?: unknown } | null)?.code
      if (code === 'ENOENT' || code === 'ENOTDIR') throw fail(notFound(`文件不存在：${originalPath}`))
      throw fail(omb)
    }
    if (typeof text !== 'string') throw fail(invalid(`readFile 必须返回字符串：${originalPath}`))
    assertTextWithinLimit(originalPath, text, this.maxFileBytes)
    return text
  }

  private async readRef(
    context: DynamicContext,
    entityId: string,
    attr: string | undefined,
    depth: number,
    trail: string[],
  ): Promise<JsonValue | undefined> {
    let raw: JsonValue | undefined
    try {
      raw = await context.getAttribute(entityId, attr)
    } catch (error) {
      throw fail(contextError(error, `读取引用 ${entityId}${attr === undefined ? '' : `.${attr}`} 失败`))
    }
    if (raw === undefined) return undefined
    if (!isJsonValue(raw)) throw fail(invalid(`引用 ${entityId}${attr === undefined ? '' : `.${attr}`} 返回的不是 JSON`))
    return this.resolveNested(raw, context, depth, trail)
  }

  private async resolveNested(
    raw: JsonValue,
    context: DynamicContext,
    depth: number,
    trail: string[],
  ): Promise<JsonValue | undefined> {
    if (isPlainObject(raw) && Object.prototype.hasOwnProperty.call(raw, '$dynamic')) {
      const marker = raw['$dynamic']
      if (!isPlainObject(marker) || typeof marker['kind'] !== 'string') {
        throw fail(invalid('$dynamic 必须是动态值 spec'))
      }
      return this.resolveSpec(marker as unknown as DynamicSpec, context, depth, trail)
    }
    return raw
  }
}

/**
 * 解析一个属性原始值：静态 JSON 原样返回；`{ $dynamic: spec }` 交给解析器。
 * 供 store / app 层在读取属性时区分静态与动态值。
 */
export async function resolveRawValue(
  raw: RawAttributeValue | undefined,
  context: DynamicContext,
  resolver: DynamicResolver,
): Promise<JsonValue | undefined> {
  if (raw === undefined) return undefined
  if (isPlainObject(raw) && Object.prototype.hasOwnProperty.call(raw, '$dynamic')) {
    if (Object.keys(raw).length !== 1) throw fail(invalid('$dynamic 必须是对象里唯一的键'))
    const marker = raw['$dynamic']
    if (!isPlainObject(marker) || typeof marker['kind'] !== 'string') {
      throw fail(invalid('$dynamic 必须是动态值 spec'))
    }
    return resolver.resolve(marker as unknown as DynamicSpec, context)
  }
  if (!isJsonValue(raw)) throw fail(invalid('属性值必须是 JSON'))
  return raw
}

function templateText(value: JsonValue | undefined): string {
  if (value === undefined) return ''
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}

function compileRegex(source: string, flags: string | undefined, label: string): RegExp {
  try {
    return new RegExp(source, flags)
  } catch (error) {
    throw fail(invalid(`${label}非法：${error instanceof Error ? error.message : String(error)}`))
  }
}

function parseJsonText(text: string, message: string): JsonValue {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw fail(invalid(`${message}（${error instanceof Error ? error.message : String(error)}）`))
  }
  if (!isJsonValue(parsed)) throw fail(invalid(`${message}（值超出 JSON 范围）`))
  return parsed
}

function contextError(error: unknown, action: string): OmbError {
  if (error instanceof OmbFailure) return error.error
  return internal(`${action}：${error instanceof Error ? error.message : String(error)}`)
}

function hashText(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** 解析栈身份：同一 spec 重复出现即循环引用。 */
function specKey(spec: DynamicSpec): string {
  switch (spec.kind) {
    case 'ref':
      return `ref|${spec.entityId}|${spec.attr ?? ''}`
    case 'template':
      return `template|${hashText(spec.template)}|${(spec.refs ?? [])
        .map(ref => `${ref.entityId}:${ref.attr ?? ''}:${ref.as ?? ''}`)
        .join(',')}`
    case 'file':
      return `file|${spec.path}|${fileExtractKey(spec)}`
    case 'regex':
      return `regex|${spec.source}|${spec.flags ?? ''}|${
        spec.input.kind === 'literal' ? `literal:${spec.input.value}` : `ref:${spec.input.entityId}:${spec.input.attr ?? ''}`
      }|${spec.group ?? 0}`
    case 'code':
      return `code|${hashText(spec.source)}|${spec.timeoutMs ?? ''}|${spec.memoryMb ?? ''}`
    case 'task':
      return `task|${spec.source}|${spec.id}|${spec.field ?? ''}`
    case 'url':
      return `url|${spec.url}|${spec.jsonPath ?? ''}`
  }
}

function fileExtractKey(spec: FileSpec): string {
  const extract = spec.extract
  if (extract === undefined) return ''
  if (extract.kind === 'text') return 'text'
  if (extract.kind === 'json') return `json:${extract.pointer ?? ''}`
  return `regex:${extract.source}:${extract.flags ?? ''}:${extract.group ?? 0}`
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** stat 预检失败的错误映射：文件不存在 → not-found；其余（权限/IO）→ internal。 */
function statError(error: unknown, displayPath: string): OmbError {
  if (error instanceof OmbFailure) return error.error
  const code = (error as { code?: unknown } | null)?.code
  if (code === 'ENOENT' || code === 'ENOTDIR') return notFound(`文件不存在：${displayPath}`)
  return internal(`无法检查文件：${displayPath}（${messageOf(error)}）`)
}
