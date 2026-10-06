/**
 * 模块目录（canonical）。**模块的 requires / capabilities / tools 只在这里写一次**，
 * 其余各处派生或由契约测试比对。
 *
 * ## 这份表到底驱动什么（2026-09 实测核对，别再靠推断）
 *
 * | 字段 | 消费者 | 性质 |
 * |---|---|---|
 * | `requires` | 各模块 manifest 经 `derivedRequires(id)` **派生** | 派生 → 进入运行时（`planModules` 的依赖规划） |
 * | `capabilities` | 各模块 manifest 经 `derivedCapabilities(id)` 派生 | 派生 |
 * | `tools` | `tests/dsh/assembly.smoke.test.ts`（声明的工具必须真有 `tools:<id>` 服务） | 测试强制 |
 * | `enabledByDefault` | `tests/dsh/module-graph-source.test.ts`（必须与 `cordis.patch.yml` 的 `disabled` 互为镜像） | 测试强制 |
 * | `id` | `cordis.patch.yml` 行 id、`MODULE_IDS`、插件页开关 id | 测试强制（一一对应） |
 *
 * ⚠️ **`requires` 不决定真实启动顺序**：生产路径上模块由宿主按 `cordis.patch.yml`
 * **行序**逐行加载（`dsh/plugin.ts` 明确不调用 `handle.start()`）。行级 `inject` 里只放**门**
 * （`omb:kernel` = 等内核就绪；少量已登记的宿主服务，如 `commands`），**不放模块 id**——
 * 宿主服务表里没有模块 id 这个键，写了会让整行永远 pending。因此模块→模块的边靠**行序**满足，
 * 由 `tests/dsh/module-graph-source.test.ts` 断言行序符合本表依赖图，并校验 inject 白名单。
 *
 * ⚠️ **开关前置条件（"依赖没开就自动关掉依赖方"）尚未实现为运行时硬阻断。**
 * 现在的保证是三件：① 行序（守卫测试）② 行级 `inject` 的门（内核 + 已登记宿主服务）
 * ③ 内核的**启动自检**（`KernelHandle.moduleGraph()`：真实挂载顺序 vs 依赖图，
 * 违规写进状态面与日志）。为什么不做硬阻断：模块行之间没有顺序保证，硬阻断会把
 * "晚一点就绪"误判成"依赖缺失"→ 静默丢失能力；把 `apply` 挪到 `mount` 返回之后
 * 又会让宿主的一次性安装审计（H-2）失效。**不要在注释或文档里假装它已经成立。**
 *
 * 三方一致（历史契约）：① 本文件的 `id` ② `cordis.patch.yml` 的行 id ③ 插件页开关 id。
 *
 * 依赖是**树不是网**：`omb-memory` 的子能力（向量、画像）与**制品索引**依赖它，
 * 其余模块只依赖内核，彼此经事件通信——这样任一模块关闭，其订阅者收到的是
 * "事件不再来"，而不是"服务解析失败"。
 *
 * ⚠️ 3.6 起 `omb-privacy` **不再是独立模块**：隐私闸门并入 `omb-memory`
 * （能力名 `privacy.modes` 跟着搬进记忆库的条目，**名字不变**）。
 * 因此 `omb-artifact` 的 `requires` 显式加上 `omb-memory`——它的制品读写闸门
 * 就是 `SERVICES.privacy`，而那个服务现在由记忆库提供：**缺服务必须能被依赖图点名**，
 * 而不是靠运行时降级才发现（`KernelHandle.moduleGraph()` 的 `missingDependencies`）。
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
  /**
   * 默认是否启用。**与 `cordis.patch.yml` 的 `disabled` 互为镜像**，
   * 由 `tests/dsh/module-graph-source.test.ts` 双向核对：
   * `enabledByDefault === true` ⇔ 该行**不得**写 `disabled: true`（条件式 `!!js` 除外）。
   *
   * 它不驱动运行时（真正的开关是那一行的 `disabled`）——所以这里只放"默认值"这一件事，
   * **不要再往本接口加没有消费者的字段**：一份"看起来权威、实际不驱动"的声明
   * 比没有更坏（测试会把它当真源断言）。
   */
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
    //
    // `privacy.modes` 同理（3.6 从 `omb-privacy` 搬来，**名字一个字没改**）：
    // 隐私闸门住在记忆库里，控制面是 `/omb-privacy` 一条用户命令（**不是**工具——
    // 隐私是用户的决定，模型不能自己解除限制）。搬过来的只有归属，不是契约：
    // 服务名仍是 `SERVICES.privacy`，所以制品索引与库访问边界零改动。
    capabilities: [
      'memory.write',
      'memory.recall',
      'memory.retain',
      'memory.recall.related',
      'memory.recall.multiquery',
      'privacy.modes',
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
    // `omb_verify` 是**已经实现并注册**的第三个工具（`modules/reasoning/tools.ts:228`、
    // `verify.ts`），此前目录里漏登记了它：而 `tests/modules/reasoning/module.test.ts`
    // 的断言方向是"目录声明 ⊆ 实际注册"，**漏登记永远不会变红**——这正是
    // "看起来权威、实际不驱动"的那类漂移。补登记后，`tests/dsh/assembly.smoke.test.ts`
    // 的"目录声明的每个工具都必须真有 tools:<id> 服务"重新覆盖它。
    // ⚠️ 反向断言（实际注册 ⊆ 目录声明）由 Lead 在两条流合并后统一补——
    // 那才是这次漏登记的方向，别以为本行改完就永久免疫了。
    tools: ['omb_method', 'omb_focus', 'omb_verify'],
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
    // **显式依赖 omb-memory**（3.6）：制品索引的读/写都要过隐私闸门，而闸门
    // （`SERVICES.privacy`）现在由记忆库提供。原先写成"只依赖内核"时，闸门缺席
    // 只能靠运行时降级发现——而 design 的硬纪律是"依赖缺席必须点名"：
    // 依赖图自检（`moduleGraph().missingDependencies`）要能说出
    // `omb-artifact ← omb-memory`，而不是让制品索引静默地不带闸门工作。
    requires: ['omb-kernel', 'omb-memory'],
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
 * 按 id 取登记项。未知 id 返回 `undefined`（**不抛**）——诊断路径要能安全探测。
 */
export function catalogEntryOf(id: string): CatalogEntry | undefined {
  return MODULE_CATALOG.find(entry => entry.id === id)
}

/**
 * 取登记项；未知 id → **抛**（这是编程错误，不是运行时缺服务）。
 *
 * 为什么抛：模块 id 不在目录里，意味着"这个模块没被登记"，而它的 requires/capabilities
 * 就会变成猜的默认值——静默漂移的典型来源（旧写法 `CATALOG?.requires ?? ['omb-kernel']`
 * 正是如此）。宁可在模块构建时炸掉，也不要让一份猜出来的依赖图进运行时。
 */
function requireEntry(id: string): CatalogEntry {
  const entry = catalogEntryOf(id)
  if (entry === undefined) {
    throw new Error(`模块 ${id} 不在 MODULE_CATALOG 里——先登记，再派生 requires/capabilities`)
  }
  return entry
}

/**
 * 模块 manifest 的 `requires` —— **唯一真源是本文件**。
 *
 * 各模块这样用（不要在模块里再抄一遍依赖）：
 * ```ts
 * const manifest: ModuleManifest<C> = { id: MODULE_ID, requires: derivedRequires(MODULE_ID), ... }
 * ```
 */
export function derivedRequires(id: string): readonly string[] {
  return [...requireEntry(id).requires]
}

/** 模块 manifest 的 `capabilities` —— 同上，唯一真源是本文件。 */
export function derivedCapabilities(id: string): readonly string[] {
  return [...requireEntry(id).capabilities]
}

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
  /**
   * 向量编码队列（`VectorEncoder`）：订阅 `memory/written` → 批量编码 → 落盘。
   *
   * 名字是"编码器"而不是"索引"：它做的是待编码队列 + 批量冲刷 + 读数，
   * **不是**可查询的检索索引——叫 Index 会让人以为它能查。
   * 由 `dsh/` 在回合边界驱动 `encodePending()`；不驱动则向量表恒空。
   */
  vectorEncoder: 'vectorEncoder',
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
  /**
   * 当前活跃会话。
   *
   * **为什么需要它**：模块经 `toHostPlugin` 拿到的内核是**收养视图**，
   * 而收养视图的 `on` **优先绑定宿主的事件面**（`kernel/adopt.ts`）——于是
   * 模块订阅的 `turn/start` 与 `dsh/` 在内核总线上发出的 `turn/start`
   * **永远碰不到**。订阅注册成功、不报任何错，症状只是"事件好像没来"。
   *
   * 实测代价：`omb_focus` 一直报"取不到当前会话标识"（它读模块自己记的
   * `lastActiveSession`，而那个变量永远停在 null）。诊断到这一步花了很久，
   * 因为发送端与订阅端看起来都对。
   *
   * 会话是**内核级事实**（由 `dsh/` 从宿主的 `session/event` 观测而来），
   * 不该依赖"模块能不能收到某条事件"。放在内核里，模块随时可以问。
   */
  activeSession: 'omb:active-session',
  /**
   * **会话运行态容器**（`SessionRuntimeTable`，见 `kernel/sessionRuntime.ts`）。
   *
   * 与 `activeSession` 的分工（别混）：
   * - `activeSession` = 「会话 → cwd」的事实 + "最后一次观测到的会话"（**读历史可以，当归属不行**）
   * - 本服务 = **按会话键控的运行态**：`for(A)` 永远拿不到 B 的槽，`note()` 拿不到会话就拒绝并计数
   *
   * 为什么由内核 provide 而不是让需要它的模块自己建：运行态容器一旦有多份，
   * "同一个会话的隐私/推理/记忆状态"就会被拆到不同的表里——那正是
   * `lastActiveSession` 那类缺陷的翻版（每个模块各记一份"当前会话"）。
   * 模块一律 `kernel.service(SERVICES.sessionRuntime)` **复用**；取不到时
   * 允许自己建一份兜底（隔离测试等场景），但**不得**在能拿到时另建。
   */
  sessionRuntime: 'omb:session-runtime',
  /**
   * **隐私判定端口**（`PrivacyGatePort`，形状定义在 `modules/memory/store.ts`）。
   *
   * 为什么是服务而不是模块间 import：分层规则禁止模块互相 import，双方只认形状。
   * 为什么必须存在这个服务：**两个数据边界的强制点**靠它——
   * ① 记忆库在 `forSession`/`peek`/`snapshot`/`forProject` 的出口惰性解析它，
   *    因此直接调库（绕过工具层、绕过任何装饰）也一样被拒；
   * ② 制品索引（`modules/artifact/index.ts`）在同一层解析它，
   *    所以"记忆读不到、但文件足迹照样列得出来"那半个隐私不存在。
   *
   * **谁提供**：3.6 起由 `omb-memory` 提供（隐私闸门并入记忆库；见
   * `modules/memory/privacy/index.ts`）。服务名与形状都没变——只有归属换了地方。
   *
   * 取不到 = 不受限（那一行没装上时语义就是"没有隐私模式"）；
   * 但"取不到"**必须留声**：制品索引会把它计成 `ungatedWrites` 并写进状态面
   * （静默放行才是缺陷，见 `modules/artifact/module.ts` 的 `GateReadiness`）。
   */
  privacy: 'privacy',
  /**
   * **上下文压力读数的"为什么"**（形状：`{ reason(): string; stats(): {...} }`）。
   *
   * 压力读数本身走内核的 `pressure()`（`measure` 由 `dsh/pressure.ts` 提供），
   * 本服务只多给一件东西：**当前为什么量不到**。
   *
   * 为什么需要它：`fillRatio === null` 至少有四种完全不同的成因——
   * 宿主没提供投影服务、宿主还没上报过 provider usage、宿主没声明窗口容量、
   * 或者 OMB 根本没观察到那个会话。四者的修法完全不同，而状态面能显示的
   * 只有同一个 `null`。这正是自检报告反复记的"无法区分『没观察过』与
   * 『没在工作』"。把原因放进内核服务表，两条造 `omb_status` 的路径
   * （`apply` 里那条与 `collectToolSpecs` 那条）就都能拿到同一份答案。
   */
  pressureReading: 'omb:pressure-reading',
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
  /**
   * 登记一个贡献者。@returns 注销函数（幂等）。
   *
   * **同名替换**：同一个 `name` 再登记会**顶替**旧的那一个，渲染只出现一条。
   * 为什么：热重载时新实例先 `register`、旧实例的 disposer 稍后才跑（两者不在同一个
   * 同步块里），中间任何一次 `omb_status` 都会把同名段落渲染两遍——两段数字互相矛盾，
   * 而状态面是唯一的诊断入口，自相矛盾等于整段失去可信度。顶替者的 disposer
   * 因此变成**无操作**（否则它会把新段删掉）。
   *
   * 已知取舍：去重同时遮住了一个信号——"旧实例还没退场"原本是可见的（双段），
   * 现在不显示了。旧实例若真的还活着（服务/订阅未撤），要靠 StatusTable 的顶替计数
   * 才能发现；那需要扩这个接口，暂未做。
   */
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
