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
    // 关联扩展（多跳）与多查询改写是**本模块的子能力**，各自提供工具而不是独立模块行：
    // 工具是"始终存在、按需调用"的东西，给它单独一行会让插件页多出两个没有独立资源的开关。
    capabilities: [
      'memory.write',
      'memory.recall',
      'memory.retain',
      'memory.recall.related',
      'memory.recall.multiquery',
    ],
    tools: ['omb_recall', 'omb_forget', 'omb_relate', 'omb_remember'],
  },
  {
    id: 'omb-memory-vector',
    enabledByDefault: true,
    requires: ['omb-memory'],
    // 保留为独立模块：它有独立资源（嵌入器实例 + 可选 ONNX 运行时与权重目录），
    // 关掉后纯词法路径完整可用。
    capabilities: ['memory.recall.semantic'],
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
 * 内核服务名契约。**三方一致**：模块 `provide` 的名字、`dsh/` 侧 `service()` 取用的名字、
 * 以及测试断言的名字。改任何一处都要同步。
 *
 * 命名约定（**只有这几条，不再扩张**）：
 * - 裸名 = 数据/能力服务（`stores` / `embedder` / `profile` / `artifact` / `notify`）
 * - `prompt:<id>` = 注入宿主的提示贡献（值符合 `host.ts` 的 `PromptContribution`）
 * - `tools:<id>` = 该模块声明的工具（`readonly ToolDefinition[]` 或 `ToolFactory`）。
 *   **统一用 `tools:<模块 id>`**：模块 id 天然唯一，`dsh/` 只需一段前缀遍历；
 *   曾经并存的 `<模块>:<功能>` 形式已废弃，避免两套遍历逻辑。
 * - `*:metrics` / `*:loop` / `*:methods` = 供状态面与 `dsh/` 读取的观测面
 */
export const SERVICES = {
  /**
   * 微内核自身。
   *
   * **为什么内核也要是服务**：在 DSH 0.1.7 的加载模型下，`cordis.patch.yml` 的
   * **每一行都是宿主独立加载的插件**，`apply(ctx, config)` 的 `ctx` 只能由宿主提供。
   * 因此模块入口不能再假设"第一个参数是我的内核"——它必须先判断拿到的是什么，
   * 若是宿主 ctx 就从本服务取内核。
   *
   * 这条也是实测教训：8 行全部激活失败报
   * `cannot get property "clock" without inject`，因为 Cordis 的 Guard 拦截了
   * 模块对宿主 ctx 的未声明属性读取。
   */
  kernel: 'omb:kernel',
  /** `StoresService`（见 `storage.ts`）。 */
  stores: 'stores',
  /** `Embedder` 槽（见 `ports.ts`）。 */
  embedder: 'embedder',
  /** `ProfileService`。 */
  profile: 'profile',
  /** `ArtifactService`（含 `record(path)` / `topFor(query, limit)`）。 */
  artifact: 'artifact',
  /** `NotifyBridge`。 */
  notify: 'notify',
  /** `PromptContribution`：思维链方法卡的常驻提示与易变上下文。 */
  promptReasoning: 'prompt:omb-reasoning',
  /**
   * 工具服务名的前缀。完整名 = `tools:<模块 id>`。
   * 用函数而不是枚举，避免"新增模块要改 ABI"。
   */
  toolsPrefix: 'tools:',
  /** 循环检测读数（`{ signal, window, reset }`）。 */
  reasoningLoop: 'reasoning:loop',
  /** 方法卡目录（`{ cardsFor(depth) }`）。 */
  reasoningMethods: 'reasoning:methods',
  /** `ContextPressure` 读数 + 档位行为。 */
  contextPressure: 'context:pressure',
  /** 拉取计数与缓存命中率的账本（供状态面）。 */
  contextMetrics: 'context:metrics',
  /** `StatusRegistry`：由微内核自己 provide，各模块 `register` 贡献段落。 */
  statusContributor: 'status:contributor',
  /**
   * `SecondaryChannelRegistry`：检索的第二通道登记处。
   *
   * 与 `statusContributor` 同构（单值登记处装 N 个），理由也同构：
   * 单值服务表装不下多个通道，而**依赖方向要求"推"而不是"拉"**——
   * `omb-memory-vector` 的 `requires` 包含 `omb-memory`，因此只能由
   * 向量模块把自己的通道注册进来，记忆模块读登记处消费。
   * 若反过来让记忆模块直接 import 向量模块，依赖方向就与目录声明相反了。
   */
  channelRegistry: 'retrieval:channels',
} as const

export type ServiceName = (typeof SERVICES)[keyof typeof SERVICES]

/**
 * 第二通道登记处。
 *
 * 泛型化以避免 ABI 反向依赖 `modules/`：`T` 由使用方以
 * `RetrievalChannel` 实例化（`RetrievalChannel` 定义在
 * `modules/memory/retrieve.ts`，属模块层）。
 */
export interface SecondaryChannelRegistry<T> {
  /** 登记一个通道。@returns 注销函数（幂等）。 */
  register(channel: T): () => void
  /** 当前全部通道，按 `name` 稳定排序。 */
  list(): readonly T[]
}

/** 构造某模块的工具服务名。唯一入口，避免各写各的拼法。 */
export function toolsServiceFor(moduleId: string): string {
  return `${SERVICES.toolsPrefix}${moduleId}`
}

/**
 * 保留的来源前缀。**离线整合必须跳过这些记录。**
 *
 * 为什么需要：画像这类"单文档、确定性 id、整体覆盖写"的记录，
 * 若被当作经验痕迹参与去重/回响合并/衰减排序，会被错误地塌缩或降权——
 * 它们不是"经验"，是结构化状态。
 *
 * 各模块用 `RESERVED_SOURCE_PREFIX + '<模块 id>'` 作为自己的 `sourceRef` 前缀。
 */
export const RESERVED_SOURCE_PREFIX = 'omb-doc:'

/**
 * 状态面贡献登记处。
 *
 * **为什么是登记处而不是单值服务**：单值服务表一个名字只能装一个实现，
 * 而 `omb-reasoning` 与 `omb-context` 等多个模块都要向 `omb_status` 贡献段落。
 * 让它们互相覆盖（后注册者胜）会**静默丢掉**前面的段落；让它们各自用
 * `status:contributor:<id>` 又需要在 `dsh/` 侧逐个探测、且新增模块要改 dsh。
 * 登记处一次注册、天然支持 N 个、dsh 侧一段代码遍历。
 *
 * 由微内核 `provide`（服务名 `SERVICES.statusContributor`），模块 `apply` 里同步 `register`。
 */
export interface StatusRegistry {
  /** 登记一个贡献者。@returns 注销函数（幂等）。 */
  register(contributor: StatusContributor): () => void
  /** 当前全部贡献者，按 `name` 稳定排序（输出确定，便于测试与阅读）。 */
  list(): readonly StatusContributor[]
}

/**
 * 状态面贡献者。任一模块可实现它，`omb_status` 汇总。
 *
 * `detail` 必填——这是"诚实降级"在类型上的体现：
 * 无法说明原因的降级不允许存在。
 */
export interface StatusContributor {
  /** 本贡献者的段落名（会作为 `omb_status` 输出的小节标题）。 */
  readonly name: string
  /** 生成当前段落。**不得抛异常**——失败由调用方包成一行错误文本。 */
  render(): string
  /** 可选的结构化指标，便于机器读取。 */
  readonly metrics?: () => Readonly<Record<string, number>>
}

/**
 * 工具工厂：模块**不能**自己注册工具（只有 `dsh/` 能接触宿主），
 * 因此模块提供工厂，由 `dsh/` 在正确作用域调用。
 */
export interface ToolFactory<TInput = unknown> {
  create(input: TInput): readonly import('./host.js').ToolDefinition[]
}

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
