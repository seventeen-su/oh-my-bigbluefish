/**
 * 宿主适配：把 Cordis `Context` 收敛成内核需要的几个端口。
 *
 * **本层是唯一接触宿主的层，且刻意不 import 任何 `@deepseek-ai/*` 包**
 * （本仓库解析不到它们，顶层 import 会让插件加载直接失败）。
 * 因此这里全部用结构化最小接口，只经由 `ctx.get()` / `ctx.on()` / `ctx.effect()` 访问。
 */
import type { Clock, Logger } from '../kernel/abi/index.js'

/** 宿主日志服务的最小结构。 */
export interface HostLoggerLike {
  debug?(...args: unknown[]): void
  info?(...args: unknown[]): void
  warn?(...args: unknown[]): void
  error?(...args: unknown[]): void
}

/** Cordis 上下文的最小结构面。只声明真正用到的成员。 */
export interface HostContextLike {
  /** 服务解析；缺失返回 undefined（**不抛**）。 */
  get?(name: string): unknown
  /** 事件订阅（混入方法）。 */
  on?(event: string, fn: (...args: never[]) => void): unknown
  /** 副作用注册：返回 disposer，卸载时自动回收（热插拔的基础）。 */
  effect?(fn: () => unknown, label?: string): unknown
  logger?: HostLoggerLike | ((name?: string) => HostLoggerLike)
  baseUrl?: string
}

function asLoggerFunc(raw: unknown): HostLoggerLike | undefined {
  if (raw === undefined || raw === null) return undefined
  const candidate = raw as HostLoggerLike | ((name?: string) => HostLoggerLike)
  return typeof candidate === 'function' ? candidate() : candidate
}

/**
 * 造一个把宿主日志收敛成内核 `Logger` 的适配器。
 * 宿主日志服务缺失时**静默**——诊断能力下降不得影响加载。
 */
export function hostLogger(ctx: HostContextLike): Logger {
  const raw = ctx.logger
  const logger = typeof raw === 'function' ? asLoggerFunc(raw) : raw
  const forward = (level: 'debug' | 'info' | 'warn', message: string): void => {
    const fn = (logger as HostLoggerLike | undefined)?.[level]
    if (typeof fn === 'function') {
      try {
        fn(message)
      } catch {
        // 宿主日志本身失败不得影响内核
      }
    }
  }
  return {
    debug: m => forward('debug', m),
    info: m => forward('info', m),
    warn: m => forward('warn', m),
  }
}

/** 系统时钟。内核与模块禁止直接 `Date.now()`，一律经此注入。 */
export const systemClock: Clock = { now: () => Date.now() }

/**
 * 读一个宿主服务。
 *
 * 两层守卫：`ctx.get` 本身可能不存在（测试用 fake Context），
 * 且服务可能因热插拔刚被卸下——两种情形都返回 undefined，**绝不抛**。
 */
export function readService<T>(ctx: HostContextLike, name: string): T | undefined {
  if (typeof ctx.get !== 'function') return undefined
  try {
    return ctx.get(name) as T | undefined
  } catch {
    // Cordis 的 Guard 会对未声明的属性读取抛错；缺失即视为不可用
    return undefined
  }
}

/**
 * 注册一个副作用，返回幂等 disposer。
 *
 * **disposer 绝不抛异常**：宿主 `reconcileProfilePatches` 会 await 旧 fiber，
 * 一旦 reject 会让整次插件开关操作失败（热插拔 H-1）。
 */
export function registerEffect(ctx: HostContextLike, fn: () => void, label: string): () => void {
  let disposed = false
  const run = (): void => {
    if (disposed) return
    disposed = true
    try {
      fn()
    } catch {
      // 回收失败不得向上传播
    }
  }
  if (typeof ctx.effect !== 'function') return run
  try {
    ctx.effect(() => run, label)
  } catch {
    // 宿主不支持 effect → 退化为手工 disposer，行为不变
  }
  return run
}
