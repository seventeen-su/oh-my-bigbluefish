/**
 * 会话见证端口（`omb:session-witness`）。
 *
 * ## 为什么需要它
 *
 * 记忆的写入准入有两条依据需要"宿主真实观测到的证据"：
 * - **用户原话**（`userAsserted: true`）：必须能核对到本会话最近一条用户消息，
 *   否则只能记成"自报未核对"——那是 `remember.ts` 旧实现里名字对、行为假的链路；
 * - **执行结果确认**：旧实现只看 `sourceRef` 是不是以 `execution:` 开头，
 *   等于让模型**给自己发合格证**（实测项目库里 3/3 行就是这么进来的回顾体）。
 *
 * 两条事实都只有集成层（`dsh/session.ts`）看得到：它订阅宿主 `session/event`，
 * 能看到 `user/message` 与 `tool/call`。因此这里定义一个**最小只读端口**，
 * 由 Lead 在 `dsh/` 侧实现并 `provide('omb:session-witness', …)`；
 * 记忆模块在**每次执行/准入时惰性解析**它——拿走服务就等于回到旧行为（降级可见）。
 *
 * ## 为什么是服务而不是 `MemoryModuleOptions`
 *
 * 生产里注册项是模块级单例（`export const registration = createMemoryRegistration()`），
 * 构造时拿不到任何"活信号"；把端口塞进 options 只能给测试用，生产永远为空。
 * 服务名走内核服务表，与 `SERVICES.stores` / `SERVICES.privacy` 同一条装配路径。
 *
 * ## 契约（三方法全部**只读、同步、绝不抛**）
 *
 * - `lastUserMessage(sessionId)`：本会话最近一条用户消息原文；没见过 → `undefined`。
 *   调用方必须把 `undefined` 当作"没观测到"，**不得**把它当成"用户没说过"。
 * - `hasExecution(sessionId, reference)`：本会话是否**真实执行过**与 `reference`
 *   匹配的调用（工具名 + 参数摘要）。`true` 才能作为 `execution-confirmed` 依据。
 * - `surfaceGeneration(sessionId)`：本会话的压缩/表面代数（单调递增）。
 *   记忆模块暂不消费，留给后续"压缩后不沿用旧窗口"类判据；先定契约，
 *   免得集成层为同一件事提供两个形状。
 */
import { SERVICES } from '../../kernel/abi/index.js'

export interface SessionWitnessPort {
  /** 本会话最近一条用户消息原文（`undefined` = 尚未观测到）。 */
  lastUserMessage(sessionId: string): string | undefined
  /** 本会话是否真实执行过与 `reference` 匹配的调用。 */
  hasExecution(sessionId: string, reference: string): boolean
  /** 本会话的压缩/表面代数（单调递增）。 */
  surfaceGeneration(sessionId: string): number
}

/**
 * 服务名：**唯一真源是 `SERVICES.sessionWitness`**（Lead 已在 `kernel/abi/catalog.ts` 落地）。
 *
 * 这里 re-export 一个本模块可读的名字，避免两处字符串字面量漂移；
 * 记忆模块不直接依赖目录里的其它服务名，因此 import 面很小。
 */
export const SESSION_WITNESS_SERVICE = SERVICES.sessionWitness

/**
 * 惰性解析见证服务。
 *
 * **绝不抛**：服务表不可用、服务实现抛异常、返回畸形值，一律当"没有见证"处理——
 * 宁可退化为旧行为（自报未核对 / 不算执行确认），也不要让记忆写入因为一个
 * 只读端口而整条崩掉。
 */
export function readSessionWitness(
  service: ((name: string) => unknown) | undefined,
): SessionWitnessPort | undefined {
  if (service === undefined) return undefined
  try {
    const found = service(SESSION_WITNESS_SERVICE)
    if (found === undefined || found === null || typeof found !== 'object') return undefined
    const candidate = found as Partial<SessionWitnessPort>
    if (typeof candidate.lastUserMessage !== 'function') return undefined
    if (typeof candidate.hasExecution !== 'function') return undefined
    return found as SessionWitnessPort
  } catch {
    return undefined
  }
}
