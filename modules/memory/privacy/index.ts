/**
 * **记忆库的隐私闸门**：一条斜杠命令控制的隐私模式（3.6 起并入记忆库）。
 *
 * ## 为什么不再是一个独立模块
 *
 * 3.6 的指令是"隐私模式不再是独立组件，而是**包含在记忆库内**"。于是这里从
 * "自己的 `apply`"变成"**由 `modules/memory/index.ts` 的 `apply` 调用的装配函数**"。
 * 三件事**一个字都没改**，这是"只改归属、不改契约"的全部要害：
 *
 * ① 服务名 `SERVICES.privacy` —— 两个消费者（库访问边界 `modules/memory/store.ts`、
 *    制品读写闸门 `modules/artifact/index.ts`）零改动；
 * ② 命令名 `/omb-privacy` —— 用户肌肉记忆与既有文档照旧；
 * ③ 状态文件位置 `<dshHome>/.omb/privacy/session-modes.json` —— 老用户的档位不丢。
 *
 * 消失的只有"独立一行 / 独立一个包"这层外壳：`cordis.patch.yml` 少一行、
 * `packages/privacy/**` 整包删除、能力名 `privacy.modes` 并入 `omb-memory` 的目录条目。
 *
 * ## 它做什么
 *
 * 1. **状态**：每个会话一份模式，挂在内核会话运行态的槽上（`privacy:mode`），
 *    **不是**模块私有全局变量——理由见 `state.ts` 的文件头。
 * 2. **子代理继承**：血缘来自宿主会话头 `parentSession`，由本文件订阅宿主
 *    `session/event` 与命令 invocation 两处登记；解析是**读时向上查找**，
 *    因此父会话改模式后子会话立刻跟着变。
 * 3. **持久化**：独立 JSON 文件（原子写），**不放记忆库**——
 *    否则"清空记忆"会顺带解除隐私。fail-closed 且**粘性**，见 `codec.ts`。
 * 4. **强制**：判定发生在**库访问边界**（`modules/memory/store.ts` 的
 *    `forSession`/`peek`/`snapshot`/`forProject` 出口）与**制品数据边界**
 *    （`modules/artifact/index.ts`），因此"直接用 `service.forSession(id).store('user').put(...)` 写库"
 *    同样被拒。这里**不做任何服务装饰**——装饰会被别人的重挂挤掉，
 *    那会留下"强制失效的窗口"。
 * 5. **可读性**：`omb_status` 里有一段（状态面贡献者），显示当前会话的模式、
 *    **来源**（命令设置 / 继承自谁 / 默认 / fail-closed）、状态文件与拒绝计数，
 *    并把受限记录分成**历史 N 条**与**本进程活跃 M 条**两个数——
 *    混成一个数就是 G1 那条 P0 在状态面上的形态（见 `gate.ts` 的 `#anyRestricted()`）。
 *    同一份读数也进记忆库的**健康面**（`modules/memory/index.ts` 的 `describeHealth`）。
 *
 * ## 命令从哪注册
 *
 * 宿主能力 `ctx.commands`（模块经**收养视图**的 `kernel.service('commands')` 取到——
 * `kernel/adopt.ts` 的 `service()` 优先读宿主服务）。行级
 * `inject: ['omb:kernel','commands']` 保证"等宿主门就绪"再挂载——
 * 这条 inject 现在挂在 **`omb-memory` 那一行**上（命令面随隐私一起并入了记忆库）。
 *
 * ## 为什么不做成 `ModuleRegistration`
 *
 * 隐私不再是模块，因此这里**没有** `manifest`/`MODULE_ID`：留给它的健康行与开关行
 * 都不存在了（目录、`MODULE_IDS`、`cordis.patch.yml` 三处的 `omb-privacy` 均已删除）。
 * 硬造一个 manifest 会让 `derivedRequires('omb-privacy')` 直接抛（目录纪律"未知 id 抛"），
 * 也会让 `loadModulesSync` 多出一个没有开关行的"野生模块"。
 */
import { z } from 'zod'
import type {
  Kernel,
  Logger,
  ModuleHealth,
  StatusContributor,
  StatusRegistry,
} from '../../../kernel/abi/index.js'
import { SERVICES } from '../../../kernel/abi/index.js'
import { heartbeat } from '../../../kernel/hostEntry.js'
import { SessionRuntimeTable } from '../../../kernel/sessionRuntime.js'
import type { PrivacyMode } from './modes.js'
import { modeTitle, originTitle, type ResolvedPrivacy } from './modes.js'
import { PrivacyState } from './state.js'
import { PrivacyGate } from './gate.js'
import type { PrivacyDoc } from './codec.js'
import { createPrivacyDurable, resolvePrivacyPath, type StoragePortLike } from './durable.js'
import type { CommandInvocationLike, CommandResultLike, PrivacyCommandApi } from './command.js'
import {
  PRIVACY_COMMAND_ID,
  PRIVACY_COMMAND_NAME,
  PRIVACY_USAGE,
  runPrivacyCommand,
  sessionOfInvocation,
} from './command.js'

/** 对外服务名（判定端口；记忆库与制品索引在数据边界惰性解析它）。 */
export const PRIVACY_SERVICE = SERVICES.privacy

/**
 * 会话运行态服务的名字。
 *
 * **内核自己 provide 这张表**（`kernel/index.ts`，`SERVICES.sessionRuntime`）——
 * 这里因此走"复用优先"：拿不到才自建一张并 provide（兜底只在
 * "内核没装"的隔离测试里走到，不能删）。
 */
export const SESSION_RUNTIME_SERVICE = SERVICES.sessionRuntime

/** 宿主命令服务名。 */
export const COMMANDS_SERVICE = 'commands'

export interface PrivacyConfig {
  /**
   * 状态文件读不出时的基线档位（fail-closed）。
   * `sealed` = 最严（默认）；`read-only` = 只禁写。
   */
  readonly failClosedMode: 'sealed' | 'read-only'
  /** 显式指定状态文件路径；缺省按 `<dshHome>/.omb/privacy/session-modes.json` 解析。 */
  readonly path: string | null
}

export const PRIVACY_DEFAULT_CONFIG: PrivacyConfig = { failClosedMode: 'sealed', path: null }

export const privacyConfigSchema = z
  .object({
    failClosedMode: z.enum(['sealed', 'read-only']).default('sealed'),
    path: z.string().min(1).nullable().default(null),
  })
  .default(PRIVACY_DEFAULT_CONFIG)

/** 宿主 commands 服务的最小结构面。 */
interface CommandsLike {
  register(definition: {
    readonly definitionId: string
    readonly name: string
    readonly description: string
    /**
     * **可选，但"带参数的命令能用"必须声明它。**
     *
     * 形状取 DSH 的 `CommandInputDescriptor`（`packages/interaction/commands/src/types.ts:20`）：
     * `{ hint: string; attachments?: boolean }`。只要 `hint`。
     *
     * 为什么必须有：DSH 客户端 `ui-commands` 只在 `desc.input !== undefined` 时
     * 才认领命令后面的参数（`client/service.ts:269` 与 `:282`）。
     * 没声明时，`/omb-privacy read-only` 会被当成普通文本送进模型。
     */
    readonly input?: { readonly hint: string; readonly attachments?: boolean }
    readonly handler: (invocation: CommandInvocationLike) => CommandResultLike | Promise<CommandResultLike>
  }): unknown
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 受限会话的两个数：**历史记录**条数 与 **本进程活跃**条数。
 *
 * 措辞只写在这里，健康面与状态面共用——两处各写一遍就会漂移成两种说法，
 * 而这个模块已经出现过一次"同一个事实在三个面上口径不同"的缺陷（G1）。
 *
 * `counts === null` = **未测量**（读会话状态失败）：这时不许写 0。
 * "读不出来"与"一条都没有"是两件事，混报就是下一轮的自相矛盾。
 */
function describeRestrictedCounts(
  counts: { readonly history: number; readonly active: number } | null,
): string {
  if (counts === null) return '历史受限记录 **未测量**（读取会话状态失败）'
  return `历史受限记录 ${counts.history} 条（其中本进程活跃 ${counts.active} 条）`
}

export interface PrivacyInstallOptions {
  /**
   * 宿主存储端口——**由调用方（记忆库的 `apply`）传进来**，这里不再自己
   * `kernel.service(STORAGE_HOST_SERVICE)` 查一次。
   *
   * 为什么复用调用方那一份解析结果（而不各查各的）：
   * ① 状态文件与记忆库必须落在同一个 `<dshHome>/.omb/` 下，路径只留**一条**来源；
   * ② 测试里注入的临时端口会把隐私状态文件一并带进临时目录——否则单测会去读
   *    开发者真实的 `~/.dsh/.omb/privacy/session-modes.json`（隔离性缺陷：
   *    "测试通过与否取决于跑测试的人自己设过什么档位"）。
   */
  readonly storagePort?: StoragePortLike | undefined
}

/**
 * 装配产物。
 *
 * `dispose` 与老的模块 `apply` 的 disposer 同契约：**幂等、绝不抛**（H-1）。
 */
export interface PrivacyInstallation {
  /** 判定端口（记忆库把它 provide 到 `SERVICES.privacy`，两个消费者都认这个名字）。 */
  readonly gate: PrivacyGate
  /** 隐私读数（记忆库把它并进自己的健康面）。 */
  health(): ModuleHealth
  /** 状态段贡献者（记忆库的 `apply` 注册它；段落名保持 `隐私`）。 */
  readonly statusContributor: StatusContributor
  /** 命令面读数（`已注册/未注册 + 原因`，进 `/omb-privacy status`）。 */
  readonly commandState: () => string
  dispose(): void
}

/**
 * 装配隐私闸门。**全部注册都在本函数返回前完成**（H-2：宿主的一次性挂载审计）。
 *
 * 绝不抛：每一步失败都只写日志并记进读数（`health()` 的 detail），
 * 因为调用方是记忆库的 `apply`——隐私装不上不该把整个记忆库拖成 failed。
 */
export function installPrivacy(
  kernel: Kernel,
  parsed: PrivacyConfig,
  options: PrivacyInstallOptions = {},
): PrivacyInstallation {
  const disposers: (() => void)[] = []
  const logger: Logger = kernel.logger
  let state: PrivacyState | undefined
  let durableError: string | null = null
  let durablePath: string | null = null
  let savedAt: number | null = null
  let stickyFailClosed = false
  /**
   * **命令注册结果**（可读事实，进状态面）。
   *
   * 起因：用户在 Web 界面发 `/omb-privacy normal` 时既无回执、又被当普通文本送进模型。
   * 而"命令有没有注册进宿主"这件事我**从未验证过**——注册代码有 `catch`，
   * 失败只写日志，所以"注册成功"一直是假设。
   *
   * 实测证据（2026-09-30）：DSH 的 `commands.execute` 每次调用都会写
   * `command/run` 生命周期事件；扫**全部会话日志**，含该事件的文件数为 **0** ——
   * 命令**从未进入执行器**。所以要么没注册（本字段会显示"未注册"），
   * 要么注册了但前端 `/` 触发流水线没接。
   *
   * 这个字段把"假设"变成界面上一行可读文本。
   */
  let commandState = '（尚未尝试注册）'

  // ── 1) 会话运行态容器（复用别人的，没有才自己建）──────────────────
  let sessions = kernel.service<SessionRuntimeTable>(SESSION_RUNTIME_SERVICE)
  if (sessions === undefined) {
    sessions = new SessionRuntimeTable(kernel.clock)
    try {
      disposers.push(kernel.provide(SESSION_RUNTIME_SERVICE, sessions))
    } catch (error) {
      logger.warn(`OMB 隐私：会话运行态服务注册失败（已隔离）——${messageOf(error)}`)
    }
  }
  const runtimeTable = sessions

  // ── 2) 持久化状态：**同步**读，必须在第一个工具调用之前就位 ────────
  //
  // 端口由调用方给（见 `PrivacyInstallOptions.storagePort` 的两条理由）；
  // 这里只做一次惰性读取，避免"调用方给了还是没给"在校验上分叉。
  const port = (): StoragePortLike | undefined => options.storagePort
  durablePath = resolvePrivacyPath({ configured: parsed.path, port })
  const durable = createPrivacyDurable({ path: durablePath, logger })
  const loaded = durable.load(kernel.clock.now())
  stickyFailClosed = loaded.doc.failClosedAt !== null
  durableError = loaded.error
  if (loaded.degraded) {
    // 把**粘性标记写回**：否则下次启动可能因为文件已被重写而"解析成功"，
    // 于是那次兜底白做、隐私被悄悄放宽（详见 codec.ts 的文件头）。
    const repaired = durable.save(loaded.doc)
    if (!repaired.ok) durableError = `${loaded.error ?? '状态损坏'}；${repaired.error ?? '写回失败'}`
  }

  const baseline = (): { mode: PrivacyMode; origin: 'default' | 'fail-closed'; detail: string } =>
    stickyFailClosed
      ? {
          mode: parsed.failClosedMode,
          origin: 'fail-closed',
          detail:
            `隐私状态读不出（${durableError ?? '未知原因'}）：按 fail-closed 取`
            + `${modeTitle(parsed.failClosedMode)}。修好状态文件后用 /omb-privacy trust 解除。`,
        }
      : { mode: 'normal', origin: 'default', detail: '该会话没有隐私设置（默认 normal）' }

  const created = new PrivacyState({ sessions: runtimeTable, clock: kernel.clock, baseline })
  state = created
  for (const [sessionId, mode] of Object.entries(loaded.doc.modes)) {
    // 重放进来的条目**只建容器条目、不标活跃**（`setOverride` → `ensure()`，
    // 没有任何 `note()` 观测）。这是刻意的：
    // ① 它们必须能被 `resolve()` 命中——用户在新进程里真的回到同一个会话时，
    //    限制照旧生效（`decide()` 不看活跃）；
    // ② 但它们**不得**再参与 `#anyRestricted()`——已结束的会话不该继续
    //    掐住全进程的归属未知写（G1，P0）。判据见 `PrivacyState.isActive()`。
    created.setOverride(sessionId, mode)
  }

  const createdGate = new PrivacyGate({
    state: created,
    // 基线是否受限 = 是否处于 fail-closed 粘性标记下。
    //
    // `failClosedMode` 的类型只有 `'sealed' | 'read-only'`（两种都受限），
    // 所以这里**不能再判一次 `!== 'normal'`**：那个分支永远为真，
    // 写上去会让人误以为"配置成 normal 时基线不受限"（配置项根本不允许 normal）。
    baselineRestricted: () => stickyFailClosed,
    // "是否存在受限会话"只看**本进程内真的活跃过**的会话（G1 的修法核心）。
    isActive: sessionId => created.isActive(sessionId),
    // 判据本身走 `PrivacyState`（与 `decide()` 同一套解析，含继承）：
    // 继承不写回子会话，所以"活跃的受限会话"不能靠扫 overrides() 找齐。
    hasRestrictedActiveSession: () => created.hasRestrictedActiveSession(),
  })
  try {
    disposers.push(kernel.provide(PRIVACY_SERVICE, createdGate))
  } catch (error) {
    logger.warn(`OMB 隐私：判定端口注册失败（**库不会被强制**）——${messageOf(error)}`)
  }

  /**
   * **同步**健康函数：进记忆库的健康面。
   *
   * 记忆库的 `manifest.health` 是异步的，它会把这份读数并进去
   * （`modules/memory/index.ts` 的 `describeHealth`）；这里保持同步，
   * 因为 `kernel.report` 只收同步值。
   */
  const health = (): ModuleHealth => {
    const current = state
    if (current === undefined) {
      return { state: 'degraded', detail: '隐私闸门未启动：installPrivacy 尚未执行（或已被卸载）' }
    }
    const entries = current.overrides()
    const counts = createdGate.restrictedCounts()
    const stats = createdGate.stats()
    const fileState = durableError !== null
      ? `状态文件降级：${durableError}`
      : durablePath === null
        ? '无法解析状态文件路径（**未持久化**）'
        : `状态文件=${durablePath}${savedAt === null ? '' : `（最近写入 ${savedAt}）`}`
    const baselineTitle = stickyFailClosed
      ? `基线=${modeTitle(parsed.failClosedMode)}（fail-closed 粘性标记生效）`
      : '基线=normal（从未配置过）'
    const detail =
      `${entries.length} 个会话有显式设置；${describeRestrictedCounts(counts)}；${baselineTitle}；${fileState}；`
      + `命令面：${PRIVACY_COMMAND_NAME} ${commandState}；`
      + `拒绝计数：读 ${stats.readDenials}、写 ${stats.writeDenials}、`
      + `归属未知写 ${stats.unattributedWriteDenials}`
    return {
      state: durableError !== null || durablePath === null ? 'degraded' : 'ok',
      detail,
      metrics: {
        sessionsWithMode: entries.length,
        ...(counts === null ? {} : { restrictedSessions: counts.history, restrictedSessionsActive: counts.active }),
        readDenials: stats.readDenials,
        writeDenials: stats.writeDenials,
        unattributedWriteDenials: stats.unattributedWriteDenials,
      },
    }
  }

  // ── 3) 命令与状态面所需的共享操作 ────────────────────────────────
  const persist = (): CommandResultLike => {
    const doc: PrivacyDoc = {
      version: 1,
      failClosedAt: stickyFailClosed ? kernel.clock.now() : null,
      modes: Object.fromEntries(created.overrides().map(entry => [entry.sessionId, entry.mode])),
    }
    const result = durable.save(doc)
    durablePath = durable.path
    if (!result.ok) {
      durableError = result.error
      return {
        kind: 'error',
        text: `模式已在**当前进程内**生效，但**未能持久化**（重启后会回到 fail-closed 兜底）：${result.error ?? '未知原因'}`,
      }
    }
    durableError = null
    savedAt = kernel.clock.now()
    return { kind: 'success', text: '已持久化（重启后同一会话仍然生效）。' }
  }

  const renderStatus = (sessionId: string | null): string => {
    const lines: string[] = ['隐私模式（记忆库的隐私闸门，命令 /omb-privacy）']
    if (sessionId === null) {
      lines.push(' 当前会话：**拿不到**（宿主未提供会话身份）——无法显示按会话的模式')
    } else {
      const resolved: ResolvedPrivacy = created.resolve(sessionId)
      lines.push(
        ` 当前会话 ${sessionId}：${modeTitle(resolved.mode)}`,
        ` 来源：${originTitle(resolved.origin)}`
        + `${resolved.inheritedFrom === null ? '' : `（继承自 ${resolved.inheritedFrom}）`}`
        + ` —— ${resolved.detail}`,
      )
      const parent = runtimeTable.for(sessionId)?.parentSessionId ?? null
      if (parent !== null) lines.push(` 父会话：${parent}（子代理继承父会话的模式）`)
    }
    const entries = created.overrides()
    const counts = createdGate.restrictedCounts()
    if (entries.length > 0) {
      // 逐条标出"本进程活跃/已结束"：读者要能自己看出哪些记录还在生效，
      // 而不是从"受限 N 个"里猜（G1 的状态面修法）。
      lines.push(
        ' 有显式设置的会话：'
        + entries
          .map(entry => `${entry.sessionId}=${entry.mode}${created.isActive(entry.sessionId) ? '（活跃）' : '（已结束）'}`)
          .join('、'),
      )
    }
    lines.push(` ${describeRestrictedCounts(counts)}`)
    if (counts !== null && counts.history > counts.active) {
      lines.push(
        ' 已结束会话的记录不再掐住新会话；要清掉它们：'
        + '/omb-privacy clear（全部已结束的）或 /omb-privacy forget <会话id>（单条）。',
      )
    }
    lines.push(
      stickyFailClosed
        ? ` 基线：${modeTitle(parsed.failClosedMode)}（**fail-closed 粘性标记生效**：${durableError ?? '状态文件损坏'}）`
        : ' 基线：normal（从未配置过）',
      durablePath === null
        ? ' 状态文件：**不可用**（无法持久化：宿主端口、$DSH_HOME、~/.dsh 都取不到）'
        : ` 状态文件：${durablePath}${durableError === null ? '' : `（降级：${durableError}）`}`
        + `${savedAt === null ? '' : `，最近写入 ${savedAt}`}`,
    )
    const stats = createdGate.stats()
    lines.push(
      ` 拒绝计数：判定 ${stats.decisions} 次、读 ${stats.readDenials}、写 ${stats.writeDenials}、`
      + `归属未知写 ${stats.unattributedWriteDenials}`,
    )
    lines.push(` 命令面：/omb-privacy —— ${commandState}`)
    lines.push(` ${PRIVACY_USAGE}`)
    return lines.join('\n')
  }

  /**
   * 该会话是不是**本进程内活跃会话的父会话**（血缘来源）。
   *
   * 批量清理**不得**碰它：父会话的模式是子会话继承的**唯一来源**
   * （`state.ts` 的读时解析），清掉它会让仍在跑的子孙会话静默失去继承——
   * 那是 fail-open。
   *
   * 而留着它不堵任何东西：归属未知的写只看活跃会话（`#anyRestricted()`），
   * 这个已结束的父会话本身不算数；它留下的唯一作用就是给子孙继承。
   */
  const isInheritanceSource = (sessionId: string): boolean =>
    runtimeTable.list().some(
      runtime => runtime.parentSessionId === sessionId && created.isActive(runtime.sessionId),
    )

  /**
   * 清除一个会话的显式设置，并**尽量**回收它的运行态条目。
   *
   * 不回收的两种情形（都必须留着）：
   * ① 活跃会话——那张表是全内核共享的，条目里还有别的模块的槽与血缘，
   *    删掉会连别人的状态一起删；
   * ② 活跃会话的父会话——见 `isInheritanceSource()`。
   *
   * `SessionRuntimeTable.forget()` 在生产代码里此前**零消费者**，历史会话
   * 因此在表里只增不减；这里是它的第一个真实调用点。
   */
  const clearOne = (sessionId: string): void => {
    created.clearOverride(sessionId)
    if (!created.isActive(sessionId) && !isInheritanceSource(sessionId)) {
      runtimeTable.forget(sessionId)
    }
  }

  const api: PrivacyCommandApi = {
    statusText: sessionId => renderStatus(sessionId),
    setMode: (sessionId, mode) => {
      const written = created.setOverride(sessionId, mode)
      if (written === null) {
        return { kind: 'error', text: `无法为会话 ${sessionId} 设置隐私模式（会话 id 非法）` }
      }
      const persisted = persist()
      return {
        kind: persisted.kind,
        text:
          `会话 ${sessionId} 的隐私模式已设为 ${modeTitle(mode)}（立即生效：库访问边界会拒绝对应的读/写）。`
          + `\n${persisted.text}`,
      }
    },
    trust: () => {
      if (!stickyFailClosed) {
        return { kind: 'success', text: '当前没有 fail-closed 兜底标记（状态文件本来就是可读的）。' }
      }
      stickyFailClosed = false
      durableError = null
      const persisted = persist()
      return {
        kind: persisted.kind,
        text:
          '已清除 fail-closed 兜底标记：基线回到 normal。'
          + '（这是显式的人类动作——请确认状态文件已经修好或确实不需要保留旧限制。）'
          + `\n${persisted.text}`,
      }
    },
    forget: rawSessionId => {
      const sessionId = typeof rawSessionId === 'string' ? rawSessionId.trim() : ''
      if (sessionId.length === 0) {
        return {
          kind: 'error',
          text: 'forget 需要指明会话：/omb-privacy forget <会话id>（/omb-privacy status 可以列出有哪些）。',
        }
      }
      const before = created.overrideOf(sessionId)
      if (before === undefined) {
        return {
          kind: 'success',
          text: `会话 ${sessionId} 没有显式隐私设置（本来就走继承/基线，没有可清除的记录）。`,
        }
      }
      const wasActive = created.isActive(sessionId)
      const keptForInheritance = isInheritanceSource(sessionId)
      clearOne(sessionId)
      const persisted = persist()
      const notes: string[] = []
      if (wasActive) {
        notes.push('注意：该会话在本进程内是活跃的，这条清除对它立即生效（若它还在跑，请重新设档）。')
      }
      if (keptForInheritance) {
        notes.push('它的运行态条目已保留：本进程内有活跃会话正从它继承模式，删掉会让那些会话静默失去继承。')
      }
      return {
        kind: persisted.kind,
        text:
          `已清除会话 ${sessionId} 的受限记录（原为 ${modeTitle(before.mode)}）：该会话回到继承/基线。`
          + (notes.length === 0 ? '' : `\n${notes.join('')}`)
          + `\n${persisted.text}`,
      }
    },
    clearInactive: () => {
      const entries = created.overrides()
      const removed: string[] = []
      const activeKept: string[] = []
      const inheritanceKept: string[] = []
      for (const entry of entries) {
        if (created.isActive(entry.sessionId)) {
          activeKept.push(entry.sessionId)
          continue
        }
        if (isInheritanceSource(entry.sessionId)) {
          // 活跃会话正从它继承：批量清理不碰它（否则是静默放宽一条正在生效的限制）
          inheritanceKept.push(entry.sessionId)
          continue
        }
        clearOne(entry.sessionId)
        removed.push(entry.sessionId)
      }
      const summary =
        `已清除 ${removed.length} 个已结束会话的受限记录`
        + (removed.length === 0 ? '' : `（${removed.join('、')}）`)
        + `；本进程内活跃的 ${activeKept.length} 个会话的设置原样保留`
        + (inheritanceKept.length === 0
          ? ''
          : `；另有 ${inheritanceKept.length} 个已结束会话是活跃会话的继承来源，保留（${inheritanceKept.join('、')}）`)
      if (removed.length === 0) {
        // 没有可清的就不写盘：避免为一次空操作刷新状态文件时间戳
        return { kind: 'success', text: `${summary}。` }
      }
      const persisted = persist()
      return { kind: persisted.kind, text: `${summary}。\n${persisted.text}` }
    },
  }

  // ── 4) 命令注册（宿主能力；缺失时如实说明，不抛）──────────────────
  //
  // ⚠️ 实测（2026-09-30，真实 Web GUI）：**这条命令在 Web 界面里够不着**——
  // 在会话里发出 `/omb-privacy normal` 后，`omb_status` 显示
  // `显式设置 0 个会话`、状态文件从未被创建；grep 整个 DSH Web 客户端
  // **没有任何斜杠命令处理**。后来查清根因是注册时没声明 `input` 描述符
  // （见下面 `input` 的注释），补上后带参数的命令可用。工具面**始终没有**
  // 隐私入口（隐私是用户的决定，模型不能自己解除限制）。
  try {
    const commands = kernel.service<CommandsLike>(COMMANDS_SERVICE)
    if (commands === undefined || typeof commands.register !== 'function') {
      commandState = '**未注册**：宿主 commands 服务不可用（行缺 inject: commands？）'
      logger.warn(
        'OMB 隐私：宿主 commands 服务不可用（omb-memory 行缺 inject: commands？）——'
        + '隐私模式仍会被强制，用户无法用 /omb-privacy 切换（工具面不受影响）。',
      )
    } else {
      const returned = commands.register({
        definitionId: PRIVACY_COMMAND_ID,
        name: PRIVACY_COMMAND_NAME,
        description:
          '隐私模式：read-only（可读不可写）/ sealed（不可读不可写）/ normal；'
          + '按会话生效、子代理继承、重启不丢；'
          + 'forget <会话id> / clear 清除已结束会话留下的受限记录。',
        /**
         * ⚠️ **声明 `input` 是"带参数的命令能用"的前提**——这一行是缺了它才出的 bug。
         *
         * ## 实测症状（用户报告，2026-09-30）
         *
         * `/omb-privacy`（不带参数）**可用**，回执正常显示；
         * `/omb-privacy read-only`（带参数）**不可用**——被当成普通文本送进模型，没有回执。
         *
         * ## 根因（DSH 客户端 `ui-commands` 的判定表）
         *
         * `packages/client/ui-commands/src/client/service.ts`：
         * ```ts
         * if (desc.input !== undefined) return { claim: this.leadingClaim(…) }   // 认领参数
         * …
         * if (desc === undefined || desc.input === undefined) return undefined    // 空格不认领
         * ```
         * 以及注释写明的决策表：
         * `host input → claim; host bare → detached execute`。
         *
         * **不带参数走 `host bare`（直接执行），带参数走 `host input → claim`——
         * 而 claim 只在命令声明了 `input` 时才成立。** 没声明时，
         * 带参数的行**不被认领为命令**，于是照常作为文本提交给模型。
         *
         * 这也解释了为什么我之前扫会话日志找不到 `command/run`：
         * 我试的那几条**恰好都带参数**（`status` / `normal` / `read-only`），
         * 全都没进命令执行器；而不带参数的那次进了。
         *
         * `hint` 会在输入框里作为占位提示显示，也顺便告诉用户参数怎么给。
         */
        input: { hint: '[status | normal | read-only | sealed | trust | forget <会话id> | clear]' },
        handler: (invocation: CommandInvocationLike): CommandResultLike => {
          // 用户手打的命令：先把血缘登记下来（子代理的父链），再执行。
          const session = sessionOfInvocation(invocation)
          if (session.sessionId !== null) {
            created.noteLineage({
              sessionId: session.sessionId,
              parentSessionId: session.parentSessionId,
              delegationDepth: session.delegationDepth,
              source: 'explicit',
            })
          }
          const raw = typeof invocation.rawInput === 'string' ? invocation.rawInput : ''
          return runPrivacyCommand(raw, session, api)
        },
      })
      if (typeof returned === 'function') disposers.push(returned as () => void)
      /**
       * **命令注册结果必须留痕。**
       *
       * 这条心跳把假设变成可读事实：`registered: true/false` +
       * 宿主返回了什么。若为 false，说明 `/omb-privacy` 在界面里不可能出现。
       */
      heartbeat('privacy-command', {
        name: PRIVACY_COMMAND_NAME,
        registered: true,
        returned: typeof returned,
      })
      commandState = `已注册（宿主返回 ${typeof returned}）`
    }
  } catch (error) {
    commandState = `**未注册**：注册抛错——${messageOf(error)}`
    heartbeat('privacy-command', { name: PRIVACY_COMMAND_NAME, registered: false, error: messageOf(error) })
    logger.warn(`OMB 隐私：命令注册失败（已隔离）——${messageOf(error)}`)
  }

  // ── 5) 血缘登记：宿主会话头是 `parentSession` 的唯一来源 ──────────
  //
  // 为什么订宿主事件面：`kernel/adopt.ts` 的 `on` 对**宿主独有事件**
  // （`session/event` 在白名单里）走宿主面。会话头里的 `parentSession`
  // （`packages/core/session/src/types.ts:107`）正是子代理继承的依据。
  try {
    const onAny = kernel.on as unknown as (
      event: string,
      handler: (...args: unknown[]) => void,
    ) => () => void
    disposers.push(
      onAny('session/event', (...args: unknown[]) => {
        const [session] = args
        const header = (session as { header?: unknown } | undefined)?.header
        const sessionId = typeof (header as { id?: unknown } | undefined)?.id === 'string'
          ? ((header as { id: string }).id)
          : undefined
        if (sessionId === undefined) return
        const parentSession = (header as { parentSession?: unknown } | undefined)?.parentSession
        const depth = (header as { delegationDepth?: unknown } | undefined)?.delegationDepth
        created.noteLineage({
          sessionId,
          parentSessionId: typeof parentSession === 'string' ? parentSession : null,
          delegationDepth: typeof depth === 'number' ? depth : null,
          source: 'session-event',
        })
      }),
    )
  } catch (error) {
    logger.warn(`OMB 隐私：订阅 session/event 失败（子代理继承会退化）——${messageOf(error)}`)
  }

  // ── 6) 状态面贡献 ────────────────────────────────────────────────
  /**
   * 段落名保持 `隐私`（用户与文档都在找这一段）。
   *
   * **没有搬进记忆库的「存储」段**：那一段每次读实时状态，而这里读的是
   * 隐私自己的状态文件与拒绝计数——两件事混成一段会让"哪一行说错了"更难查。
   * 记忆库的**健康面**是另一回事：那里必须并进隐私读数，否则插件页那一行
   * 会显示"记忆库正常"而对隐私的降级只字不提（没有静默失效）。
   */
  const statusContributor: StatusContributor = {
    name: '隐私',
    render: () => {
      try {
        const entries = created.overrides()
        const stats = createdGate.stats()
        const counts = createdGate.restrictedCounts()
        const restricted = entries.filter(entry => entry.mode !== 'normal')
        const baselineTitle = stickyFailClosed
          ? `基线 ${modeTitle(parsed.failClosedMode)}（fail-closed）`
          : '基线 normal'
        const listed = restricted.length === 0
          ? '：无'
          : `：${restricted
            .map(entry => `${entry.sessionId}=${entry.mode}${created.isActive(entry.sessionId) ? '（活跃）' : '（已结束）'}`)
            .join('、')}`
        return [
          `${baselineTitle}；显式设置 ${entries.length} 个会话；${describeRestrictedCounts(counts)}${listed}`,
          `拒绝计数：读 ${stats.readDenials}、写 ${stats.writeDenials}、`
          + `归属未知写 ${stats.unattributedWriteDenials}`,
          durablePath === null
            ? '状态文件不可用（**未持久化**）'
            : `状态文件 ${durablePath}${durableError === null ? '（正常）' : `（降级：${durableError}）`}`,
          '当前会话的模式：用 /omb-privacy status 查看（状态面拿不到"这次是谁在问"）',
          '清理已结束会话的记录：/omb-privacy clear 或 /omb-privacy forget <会话id>',
        ].join('；')
      } catch (error) {
        return `隐私状态渲染失败：${messageOf(error)}`
      }
    },
    metrics: () => {
      const entries = created.overrides()
      const stats = createdGate.stats()
      const counts = createdGate.restrictedCounts()
      return {
        sessionsWithMode: entries.length,
        ...(counts === null ? {} : { restrictedSessions: counts.history, restrictedSessionsActive: counts.active }),
        readDenials: stats.readDenials,
        writeDenials: stats.writeDenials,
        unattributedWriteDenials: stats.unattributedWriteDenials,
      }
    },
  }
  try {
    const registry = kernel.service<StatusRegistry>(SERVICES.statusContributor)
    if (registry === undefined || typeof registry.register !== 'function') {
      logger.warn('OMB 隐私：状态面登记处不可用——隐私模式不会出现在 omb_status 里')
    } else {
      const off = registry.register(statusContributor)
      if (typeof off === 'function') disposers.push(off)
    }
  } catch (error) {
    logger.warn(`OMB 隐私：状态面贡献注册失败（已隔离）——${messageOf(error)}`)
  }

  // ── 7) 卸载：全部步骤不抛（H-1）──────────────────────────────────
  let disposed = false
  return {
    gate: createdGate,
    health,
    statusContributor,
    commandState: () => commandState,
    dispose: () => {
      if (disposed) return
      disposed = true
      for (const dispose of disposers.reverse()) {
        try {
          dispose()
        } catch (error) {
          logger.warn(`OMB 隐私：卸载步骤抛异常（已隔离）——${messageOf(error)}`)
        }
      }
      disposers.length = 0
      state = undefined
    },
  }
}

/**
 * **隐私没有工具。**
 *
 * 不变量：模型不能自己解除限制（"这条记忆很有价值，我先把 sealed 关掉"——那不是隐私，是自证）。
 * 这条不变量靠"**根本没有那条路**"成立：记忆库的 `tools:omb-memory` 里只有
 * 召回 / 遗忘 / 关联 / 写入四个工具，没有一个能碰隐私档位；控制面只有用户手打的
 * `/omb-privacy`。判据见 `tests/modules/privacy/module.test.ts` 的
 * 「不变量：模型不能自己解除限制」一节（工具名白名单 + 参数面里不许出现隐私档位关键词）。
 *
 * 3.5 时这里是一个空数组 `privacyTools`（"模块不注册任何工具"的证据）；
 * 现在模块本身没了，证据改成上面那条更强的**目的性**断言——守目的，不守手段。
 */
