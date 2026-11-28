import type { Attribute, Entity, Scope } from '../domain/entity.js'
import type { DynamicSpec } from '../domain/dynamic-spec.js'
import { scopeOf } from '../domain/entity-access.js'
import type { JsonValue } from '../domain/json.js'
import { OmbFailure, toOmbError } from '../domain/errors.js'
import type { Clock } from '../ports/clock.js'
import type { DynamicContext, DynamicResolver } from '../ports/dynamic.js'
import type { TaskReader } from '../ports/task.js'
import type { Store } from '../ports/store.js'

const DEFAULT_STALE_MS = 5 * 60 * 1000

export interface DynamicServiceDeps {
  readonly store: Store
  readonly resolver: DynamicResolver
  readonly clock: Clock
  readonly readFile?: (path: string) => Promise<string>
  readonly taskReader?: TaskReader
}

export interface DynamicRefreshOptions {
  readonly projectRoot?: string
  readonly max?: number
  readonly signal?: AbortSignal
  readonly force?: boolean
  /** 发起读取的会话；task 动态值读取 owned job 时必须传。 */
  readonly caller?: string
}

/** 动态属性必须以 `$dynamic` 原样交给解析器，才能递归解析 A→B→C；静态属性返回值本身。 */
function rawValueOf(attribute: Attribute): JsonValue {
  return attribute.value.kind === 'dynamic'
    ? { $dynamic: attribute.value.spec } as unknown as JsonValue
    : attribute.value.value
}

function staleAt(attribute: Attribute): number | undefined {
  if (attribute.value.kind !== 'dynamic') return undefined
  const cachedAt = attribute.value.cachedAt
  if (cachedAt === undefined) return 0
  const parsed = Date.parse(cachedAt)
  if (!Number.isFinite(parsed)) return 0
  return parsed + (attribute.value.staleAfterMs ?? DEFAULT_STALE_MS)
}

export class DynamicService {
  constructor(private readonly deps: DynamicServiceDeps) {}

  /** 读取实体并只刷新过期的动态属性；失败写 last_error，不清旧缓存。 */
  async refreshEntity(entity: Entity, options: DynamicRefreshOptions = {}): Promise<Entity> {
    const now = this.deps.clock.iso()
    const nowMs = Date.parse(now)
    const dynamic = entity.attributes.filter(attribute => attribute.value.kind === 'dynamic')
    if (dynamic.length === 0) return entity
    const scope = scopeOf(entity)
    // 后台 refresh 没有调用方传入 projectRoot：projectKey 现在是稳定 projectId（remote URL /
    // 指纹），**不是路径**。只有 file 动态值需要路径根，所以按需从身份注册表取该项目的
    // 最近工作区根；查不到时退回旧语义（迁移前的 projectKey 就是 git root 路径），两者都
    // 没有时 file 动态值被 path-guard 拒绝——宁可不读，也不把 projectId 当路径去猜。
    const needsProjectRoot = dynamic.some(attribute => attribute.value.kind === 'dynamic' && attribute.value.spec.kind === 'file')
    const projectRoot = options.projectRoot ?? (needsProjectRoot ? await this.projectRootFor(scope) : undefined)
    const effectiveOptions: DynamicRefreshOptions = {
      ...options,
      ...(projectRoot !== undefined ? { projectRoot } : {}),
    }
    let refreshed = 0
    for (const attribute of dynamic) {
      if (attribute.value.kind !== 'dynamic') continue
      const due = staleAt(attribute)
      if (options.force !== true && due !== undefined && due > nowMs) continue
      if (refreshed >= (options.max ?? 4)) break
      refreshed += 1
      const context = this.contextFor(entity.id, effectiveOptions)
      try {
        const value = await this.deps.resolver.resolve(attribute.value.spec, context)
        await this.deps.store.setAttributeCache(entity.id, attribute.name, attribute.ordinal, value, now)
      } catch (error) {
        await this.deps.store.setAttributeCache(
          entity.id,
          attribute.name,
          attribute.ordinal,
          undefined,
          now,
          toOmbError(error).message,
        )
      }
    }
    return (await this.deps.store.get(entity.id, { includeArchived: true })) ?? entity
  }

  async refreshById(id: string, options: DynamicRefreshOptions = {}): Promise<Entity | undefined> {
    const entity = await this.deps.store.get(id, { includeArchived: true })
    if (entity === undefined) return undefined
    return this.refreshEntity(entity, options)
  }

  /** 动态文件属性的 path-guard 根：身份注册表 > 旧 projectKey（迁移前就是路径）。 */
  private async projectRootFor(scope: Scope): Promise<string | undefined> {
    if (scope.kind !== 'project') return undefined
    const lookup = this.deps.store.projectRootOf
    if (lookup !== undefined) {
      try {
        const root = await lookup.call(this.deps.store, scope.projectKey)
        if (root !== undefined && root.trim().length > 0) return root
      } catch {
        // 注册表不可读（未迁移/库抖动）时退回旧语义，不让动态刷新整批失败。
      }
    }
    return scope.projectKey
  }

  private contextFor(entityId: string, options: DynamicRefreshOptions): DynamicContext {
    return {
      depth: 0,
      now: this.deps.clock.iso(),
      ...(options.projectRoot !== undefined ? { projectRoot: options.projectRoot } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      getAttribute: async (targetId: string, attr?: string): Promise<JsonValue | undefined> => {
        const entity = await this.deps.store.get(targetId, { includeArchived: true })
        if (entity === undefined) return undefined
        if (attr !== undefined) {
          const attribute = entity.attributes.find(item => item.name === attr)
          return attribute === undefined ? undefined : rawValueOf(attribute)
        }
        const record: Record<string, JsonValue> = {}
        // 引用不带 attr 时返回全部属性，包括 title/status/time 等必填属性；
        // 不能只返回可选属性，否则 ref 只能取到用户随手写的字段。
        for (const attribute of entity.attributes) record[attribute.name] = rawValueOf(attribute)
        return record
      },
      readFile: async (path: string): Promise<string> => {
        if (this.deps.readFile === undefined) {
          throw new OmbFailure({ code: 'unsupported', message: '宿主未提供文件读取能力' })
        }
        return this.deps.readFile(path)
      },
      readTask: async (source, id, field): Promise<JsonValue | undefined> => {
        if (this.deps.taskReader === undefined) return undefined
        return this.deps.taskReader.read(source, id, field, options.caller)
      },
    }
  }
}

export function dynamicSpecsOf(entity: Entity): DynamicSpec[] {
  const specs: DynamicSpec[] = []
  for (const attribute of entity.attributes) {
    if (attribute.value.kind === 'dynamic') specs.push(attribute.value.spec)
  }
  return specs
}
