/**
 * 模块目录（canonical）。**这是 `cordis.patch.yml` 行 id 与模块清单 id 之间的唯一契约。**
 *
 * 三方必须一致，改任何一处都要同步另两处：
 * ① 本文件的 `id` ② `cordis.patch.yml` 的行 id ③ 插件管理页显示的开关 id
 *
 * 依赖是**树不是网**：除记忆的三个子能力依赖 `omb-memory` 外，
 * 其余模块只依赖内核，彼此经事件通信——这样任一模块关闭，其订阅者收到的是
 * "事件不再来"，而不是"服务解析失败"。
 */
import type { MemoryKind, MemoryScope } from './kinds.js'

/** 全部模块 id。`preset-omb` 不是模块（是预设声明），故不在表内。 */
export const MODULE_IDS = [
  'omb-kernel',
  'omb-memory',
  'omb-memory-vector',
  'omb-memory-graph',
  'omb-memory-multiquery',
  'omb-profile',
  'omb-reasoning',
  'omb-context',
  'omb-artifact',
  'omb-notify',
] as const

export type ModuleId = (typeof MODULE_IDS)[number]

/** 一个模块在目录里的登记项。 */
export interface CatalogEntry {
  readonly id: ModuleId
  /** 默认是否启用（对应 `disabled` 的缺省值）。 */
  readonly enabledByDefault: boolean
  readonly requires: readonly ModuleId[]
  readonly capabilities: readonly string[]
  /** 该模块注册的模型可见工具。关掉模块 → 工具消失。 */
  readonly tools: readonly string[]
}

export const MODULE_CATALOG: readonly CatalogEntry[] = [
  {
    id: 'omb-kernel',
    enabledByDefault: true,
    requires: [],
    capabilities: ['kernel.services', 'kernel.events', 'kernel.health', 'kernel.metrics'],
    tools: ['omb_status'],
  },
  {
    id: 'omb-memory',
    enabledByDefault: true,
    requires: ['omb-kernel'],
    capabilities: ['memory.write', 'memory.recall', 'memory.retain'],
    tools: ['omb_recall', 'omb_forget'],
  },
  {
    id: 'omb-memory-vector',
    enabledByDefault: true,
    requires: ['omb-memory'],
    capabilities: ['memory.recall.semantic'],
    tools: [],
  },
  {
    id: 'omb-memory-graph',
    enabledByDefault: true,
    requires: ['omb-memory'],
    capabilities: ['memory.recall.related'],
    tools: ['omb_relate'],
  },
  {
    id: 'omb-memory-multiquery',
    enabledByDefault: false,
    requires: ['omb-memory'],
    capabilities: ['memory.recall.multiquery'],
    tools: [],
  },
  {
    id: 'omb-profile',
    enabledByDefault: true,
    requires: ['omb-memory'],
    capabilities: ['profile.declared'],
    tools: [],
  },
  {
    id: 'omb-reasoning',
    enabledByDefault: true,
    requires: ['omb-kernel'],
    capabilities: ['reasoning.methods', 'reasoning.depth', 'reasoning.loop-detect'],
    tools: ['omb_method', 'omb_focus'],
  },
  {
    id: 'omb-context',
    enabledByDefault: true,
    requires: ['omb-kernel'],
    capabilities: ['context.pressure', 'context.admission', 'context.metrics'],
    tools: [],
  },
  {
    id: 'omb-artifact',
    enabledByDefault: true,
    requires: ['omb-kernel'],
    capabilities: ['artifact.index'],
    tools: ['omb_files'],
  },
  {
    id: 'omb-notify',
    enabledByDefault: true,
    requires: ['omb-kernel'],
    capabilities: ['notify.external'],
    tools: [],
  },
]

/** 状态面用的常量。 */
export const STATUS_TOOL = 'omb_status'

/**
 * 写入路由：记忆该落哪个库。
 *
 * 位置即权威——不存在可漂移的 `scope` 标签。
 * `episodic`/`procedural` 高度依赖具体项目情境，抽掉情境会变成误导性结论，
 * 因此落跨会话库；其余落跨项目库。
 */
export const SCOPE_BY_KIND: Readonly<Record<MemoryKind, MemoryScope>> = {
  episodic: 'project',
  procedural: 'project',
  semantic: 'user',
}

/** 校验目录自身一致：依赖存在、无环、id 唯一。 */
export function validateCatalog(entries: readonly CatalogEntry[] = MODULE_CATALOG): readonly string[] {
  const problems: string[] = []
  const byId = new Map<string, CatalogEntry>()
  for (const e of entries) {
    if (byId.has(e.id)) problems.push(`模块 id 重复：${e.id}`)
    byId.set(e.id, e)
  }
  for (const e of entries) {
    for (const dep of e.requires) {
      if (dep === e.id) problems.push(`${e.id} 依赖自己`)
      else if (!byId.has(dep)) problems.push(`${e.id} 依赖不存在的模块：${dep}`)
    }
  }
  // 环检测
  const state = new Map<string, 'visiting' | 'done'>()
  const visit = (id: string, chain: readonly string[]): void => {
    if (state.get(id) === 'done') return
    if (state.get(id) === 'visiting') {
      problems.push(`依赖成环：${[...chain, id].join(' → ')}`)
      return
    }
    state.set(id, 'visiting')
    for (const dep of byId.get(id)?.requires ?? []) visit(dep, [...chain, id])
    state.set(id, 'done')
  }
  for (const e of entries) visit(e.id, [])
  return problems
}
