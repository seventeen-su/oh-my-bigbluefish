/**
 * `omb-privacy` 模块注册入口：一条斜杠命令控制的隐私模式。
 *
 * ## 它做什么
 *
 * 1. **状态**：每个会话一份模式，挂在内核会话运行态的槽上（`privacy:mode`），
 *    **不是**模块私有全局变量——理由见 `state.ts` 的文件头。
 * 2. **子代理继承**：血缘来自宿主会话头 `parentSession`，由本模块订阅宿主
 *    `session/event` 与命令 invocation 两处登记；解析是**读时向上查找**，
 *    因此父会话改模式后子会话立刻跟着变。
 * 3. **持久化**：独立 JSON 文件（原子写），**不放记忆库**——
 *    否则"清空记忆"会顺带解除隐私。fail-closed 且**粘性**，见 `codec.ts`。
 * 4. **强制**：判定发生在**库访问边界**（`modules/memory/store.ts` 的
 *    `forSession`/`peek`/`snapshot`/`forProject` 出口），因此
 *    "直接用 `service.forSession(id).store('user').put(...)` 写库"同样被拒。
 *    本模块**不做任何服务装饰**——装饰会被别人的重挂挤掉，那会留下"强制失效的窗口"。
 * 5. **可读性**：`omb_status` 里有一段（状态面贡献者），显示当前会话的模式、
 *    **来源**（命令设置 / 继承自谁 / 默认 / fail-closed）、状态文件与拒绝计数。
 *
 * ## 命令从哪注册
 *
 * 宿主能力 `ctx.commands`（模块经**收养视图**的 `kernel.service('commands')` 取到——
 * `kernel/adopt.ts` 的 `service()` 优先读宿主服务）。行级 `inject: ['omb:kernel','commands']`
 * 保证"等宿主门就绪"再挂载。
 */
import { z } from 'zod'
import type {
  Kernel,
  Logger,
  ModuleHealth,
  ModuleManifest,
  ModuleRegistration,
  StatusContributor,
  StatusRegistry,
  ToolDefinition,
} from '../../kernel/abi/index.js'
import { derivedCapabilities, derivedRequires, SERVICES, toolsServiceFor } from '../../kernel/abi/index.js'
import { SessionRuntimeTable } from '../../kernel/sessionRuntime.js'
import { heartbeat, toHostPlugin } from '../../kernel/hostEntry.js'
import type { PrivacyMode } from './modes.js'
import { modeTitle, originTitle, type ResolvedPrivacy } from './modes.js'
import { PrivacyState } from './state.js'
import { PrivacyGate } from './gate.js'
import { createPrivacyTool } from './tools.js'
import type { PrivacyDoc } from './codec.js'
import { createPrivacyDurable, resolvePrivacyPath, STORAGE_HOST_SERVICE } from './durable.js'
import type { CommandInvocationLike, CommandResultLike, PrivacyCommandApi } from './command.js'
import {
  PRIVACY_COMMAND_ID,
  PRIVACY_COMMAND_NAME,
  PRIVACY_USAGE,
  runPrivacyCommand,
  sessionOfInvocation,
} from './command.js'

/** 模块 id。必须与 `MODULE_CATALOG` 和 `cordis.patch.yml` 完全一致。 */
export const MODULE_ID = 'omb-privacy'

/** 对外服务名（判定端口；记忆模块在库访问边界惰性解析它）。 */
export const PRIVACY_SERVICE = SERVICES.privacy

/**
 * 会话运行态服务的名字。
 *
 * **内核自己 provide 这张表**（`kernel/index.ts`，`SERVICES.sessionRuntime`）——
 * 本模块因此走"复用优先"：拿不到才自建一张并 provide（兜底只在
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
    readonly handler: (invocation: CommandInvocationLike) => CommandResultLike | Promise<CommandResultLike>
  }): unknown
}

/** 宿主存储端口的最小结构面（只为拿 `userDbPath` 推路径）。 */
interface StoragePortLike {
  readonly userDbPath?: unknown
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export interface PrivacyModuleOptions {
  readonly version?: string
}

export function createPrivacyRegistration(options: PrivacyModuleOptions = {}): ModuleRegistration<PrivacyConfig> {
  let state: PrivacyState | undefined
  let gate: PrivacyGate | undefined
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
  let config: PrivacyConfig = PRIVACY_DEFAULT_CONFIG

  /**
   * **同步**健康函数：既能进清单，也能直接 `report`。
   *
   * `manifest.health` 的类型允许返回 Promise（内核契约如此），但 `kernel.report`
   * 只收同步值；并且自报健康在 `apply` 里完成（H-2：返回后不再注册）。
   * 因此这里算一份同步的，两处共用同一个函数——避免"清单里的健康"与
   * "上报的健康"漂移成两份实现。
   */
  const health = (): ModuleHealth => {
    const current = state
    if (current === undefined) {
      return { state: 'degraded', detail: '模块未启动：apply 尚未执行（或已被卸载）' }
    }
    const entries = current.overrides()
    const restricted = entries.filter(entry => entry.mode !== 'normal').length
    const stats = gate?.stats()
    const fileState = durableError !== null
      ? `状态文件降级：${durableError}`
      : durablePath === null
        ? '无法解析状态文件路径（**未持久化**）'
        : `状态文件=${durablePath}${savedAt === null ? '' : `（最近写入 ${savedAt}）`}`
    const baseline = stickyFailClosed
      ? `基线=${modeTitle(config.failClosedMode)}（fail-closed 粘性标记生效）`
      : '基线=normal（从未配置过）'
    const detail =
      `${entries.length} 个会话有显式设置（其中受限 ${restricted} 个）；${baseline}；${fileState}；`
      + `拒绝计数：读 ${stats?.readDenials ?? 0}、写 ${stats?.writeDenials ?? 0}、`
      + `归属未知写 ${stats?.unattributedWriteDenials ?? 0}`
    return {
      state: durableError !== null || durablePath === null ? 'degraded' : 'ok',
      detail,
      metrics: {
        sessionsWithMode: entries.length,
        restrictedSessions: restricted,
        readDenials: stats?.readDenials ?? 0,
          writeDenials: stats?.writeDenials ?? 0,
          unattributedWriteDenials: stats?.unattributedWriteDenials ?? 0,
        },
      }
  }

  const manifest: ModuleManifest<PrivacyConfig> = {
    id: MODULE_ID,
    version: options.version ?? '3.2.0',
    requires: derivedRequires(MODULE_ID),
    capabilities: derivedCapabilities(MODULE_ID),
    configSchema: privacyConfigSchema,
    health,
  }

  return {
    manifest,

    apply(kernel: Kernel, parsed: PrivacyConfig): () => void {
      config = parsed
      const disposers: (() => void)[] = []
      const logger: Logger = kernel.logger

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
      const port = (): StoragePortLike | undefined => {
        try {
          return kernel.service<StoragePortLike>(STORAGE_HOST_SERVICE)
        } catch {
          return undefined
        }
      }
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
      })
      gate = createdGate
      try {
        disposers.push(kernel.provide(PRIVACY_SERVICE, createdGate))
      } catch (error) {
        logger.warn(`OMB 隐私：判定端口注册失败（**库不会被强制**）——${messageOf(error)}`)
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
        const lines: string[] = ['隐私模式（omb-privacy）']
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
        if (entries.length > 0) {
          lines.push(
            ' 有显式设置的会话：'
            + entries.map(entry => `${entry.sessionId}=${entry.mode}`).join('、'),
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
      }

      // ── 4) 命令注册（宿主能力；缺失时如实说明，不抛）──────────────────
      //
      // ⚠️ 实测（2026-09-30，真实 Web GUI）：**这条命令在 Web 界面里够不着**——
      // 在会话里发出 `/omb-privacy normal` 后，`omb_status` 显示
      // `显式设置 0 个会话`、状态文件从未被创建；grep 整个 DSH Web 客户端
      // **没有任何斜杠命令处理**。所以命令保留（TUI/CLI 可用），
      // 但**不再是唯一入口**——下面第 4b 步补一条模型可调用的工具。
      try {
        const commands = kernel.service<CommandsLike>(COMMANDS_SERVICE)
        if (commands === undefined || typeof commands.register !== 'function') {
          commandState = '**未注册**：宿主 commands 服务不可用（行缺 inject: commands？）'
          logger.warn(
            'OMB 隐私：宿主 commands 服务不可用（行缺 inject: commands？）——'
            + '隐私模式仍会被强制，用户无法用 /omb-privacy 切换（工具面不受影响）。',
          )
        } else {
          const returned = commands.register({
            definitionId: PRIVACY_COMMAND_ID,
            name: PRIVACY_COMMAND_NAME,
            description:
              '隐私模式：read-only（可读不可写）/ sealed（不可读不可写）/ normal；'
              + '按会话生效、子代理继承、重启不丢。',
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
           * 起因：用户在 Web 界面发 `/omb-privacy normal` 时既没有回执、又被当成
           * 普通文本送进模型。而"命令有没有注册进宿主"这件事，我**从未验证过**——
           * 注册代码有 `catch` 分支（失败只写日志），所以"注册成功"一直是假设。
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

      // ── 4b) 工具面：Web 界面里唯一能用的控制入口 ──────────────────────
      //
      // 原设计刻意不给工具（"隐私模式是用户的决定，不该由模型自己改"）——那个意图
      // **是对的**，但它假定命令够得着，而实测证明 Web 里够不着。
      // 所以补工具，同时用**结构性手段**保住原意图：
      //   · 模型只能**收紧**（normal→read-only→sealed）；
      //   · **放宽必须传 `allowLoosen: true`**（用户明确要求时才可传），回执留审计痕迹；
      //   · `trust`（清 fail-closed 粘性）**不提供**——那是人类动作。
      // 于是"模型无法把自己放出来"这条约束在结构上成立。
      try {
        const privacyTool = createPrivacyTool({
          statusText: sessionId => renderStatus(sessionId),
          setMode: (sessionId, mode) => api.setMode(sessionId, mode),
          // 用**当前生效的**模式比较，而不是模型以为的模式——后者可以被谎报。
          modeOf: sessionId => (sessionId === null ? 'normal' : created.resolve(sessionId).mode),
          // 工具调用带自己的会话（`dsh/tools.ts` 从宿主 `exec.agent` 取，见 task-7）。
          // 工具执行体自己从 call.sessionId 取会话（见 tools.ts 的说明）；xecute 拿不到时才走这里。
          currentSession: () => null,
        })
        disposers.push(kernel.provide(toolsServiceFor(MODULE_ID), [privacyTool]))
      } catch (error) {
        logger.warn(`OMB 隐私：工具面注册失败（已隔离）——${messageOf(error)}`)
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
      try {
        const registry = kernel.service<StatusRegistry>(SERVICES.statusContributor)
        if (registry === undefined || typeof registry.register !== 'function') {
          logger.warn('OMB 隐私：状态面登记处不可用——隐私模式不会出现在 omb_status 里')
        } else {
          const contributor: StatusContributor = {
            name: '隐私',
            render: () => {
              try {
                const entries = created.overrides()
                const stats = createdGate.stats()
                const restricted = entries.filter(entry => entry.mode !== 'normal')
                const baseline = stickyFailClosed
                  ? `基线 ${modeTitle(parsed.failClosedMode)}（fail-closed）`
                  : '基线 normal'
                const listed = restricted.length === 0
                  ? '无受限会话'
                  : restricted.map(entry => `${entry.sessionId}=${entry.mode}`).join('、')
                return [
                  `${baseline}；显式设置 ${entries.length} 个会话（受限 ${restricted.length} 个：${listed}）`,
                  `拒绝计数：读 ${stats.readDenials}、写 ${stats.writeDenials}、`
                  + `归属未知写 ${stats.unattributedWriteDenials}`,
                  durablePath === null
                    ? '状态文件不可用（**未持久化**）'
                    : `状态文件 ${durablePath}${durableError === null ? '（正常）' : `（降级：${durableError}）`}`,
                  '当前会话的模式：用 /omb-privacy status 查看（状态面拿不到"这次是谁在问"）',
                ].join('；')
              } catch (error) {
                return `隐私状态渲染失败：${messageOf(error)}`
              }
            },
            metrics: () => {
              const entries = created.overrides()
              const stats = createdGate.stats()
              return {
                sessionsWithMode: entries.length,
                restrictedSessions: entries.filter(entry => entry.mode !== 'normal').length,
                readDenials: stats.readDenials,
                writeDenials: stats.writeDenials,
                unattributedWriteDenials: stats.unattributedWriteDenials,
              }
            },
          }
          const off = registry.register(contributor)
          if (typeof off === 'function') disposers.push(off)
        }
      } catch (error) {
        logger.warn(`OMB 隐私：状态面贡献注册失败（已隔离）——${messageOf(error)}`)
      }

      kernel.report(health())

      // ── 7) 卸载：全部步骤不抛（H-1）──────────────────────────────────
      let disposed = false
      return () => {
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
        gate = undefined
      }
    },
  }
}

/** 工具声明：本模块**没有工具**（隐私是用户的决定，模型不能自己解除限制）。 */
export const privacyTools: readonly ToolDefinition[] = []

export const registration = createPrivacyRegistration()

export default toHostPlugin(registration)
