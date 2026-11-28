/**
 * 进程级 Managed PostgreSQL 池。
 *
 * 为什么不是每个插件实例各持一个 `PostgresLifecycle`：DSH 的组件开关、bundle 重选
 * 和 HMR 都可能让新旧插件实例短暂重叠（cordis 在 `_unload` 里等旧 fiber，但 HMR 的
 * 模块替换会先启动新 fiber 再 await 旧 fiber）。如果两代各自持有生命周期，旧代
 * dispose 的 stop 会停掉新代正在使用的库，或者新代 adopt 后旧代又把它停掉。
 *
 * 这里把「同一 dataDir 只有一个生命周期」收进进程池：
 * - `acquire()` 增加引用并返回一个带**代**的 handle；
 * - 只有最后一个 handle `release()` 才真正 stop；
 * - handle 释放后，它迟到的 `ensureStarted()` 被拒绝（旧 boot 的异步初始化不能把
 *   已经关掉的库重新拉起来）；
 * - 代在每次 stop 时 +1；stop 期间新 acquire 的 handle 拿到新代，会排在 stop 之后启动。
 *
 * 跨进程（Web + Desktop 共享同一便携库）仍按 `adoptExisting` 语义处理：本池只保证
 * 单进程内不重复启停/不误停。多宿主共享同一 dataDir 时“谁负责停”需要外部租约，
 * 不在本模块伪造。
 */
import { resolve } from 'node:path'
import {
  PostgresLifecycle,
  type PostgresLifecycleOptions,
  type PostgresLifecycleStatus,
  type PostgresProbe,
} from './lifecycle.js'

export interface ManagedPostgresStatus extends PostgresLifecycleStatus {
  /** 当前进程内还持有该 dataDir 的插件实例数。 */
  readonly refs: number
  /** 真实 `pg_ctl status` 探测结果；`probe()` 每次调用都会执行一次。 */
  readonly probe: PostgresProbe
}

export interface ManagedPostgresHandle {
  /** 启动（幂等）；只有仍持有引用的 handle 才能启动。 */
  ensureStarted(): Promise<void>
  /** 释放本实例的引用；最后一个释放者负责停止。可重复调用。 */
  release(): Promise<void>
  /** 状态 + 真实探测。 */
  status(): Promise<ManagedPostgresStatus>
  /** 归属的 dataDir key（诊断用）。 */
  readonly key: string
}

/** 生命周期的最小接口；单测注入假实现，生产用 `PostgresLifecycle`。 */
export interface ManagedLifecycle {
  ensureStarted(generation?: number): Promise<void>
  stop(): Promise<void>
  status(): PostgresLifecycleStatus
  probe(): Promise<PostgresProbe>
}

interface Slot {
  readonly key: string
  readonly lifecycle: ManagedLifecycle
  refs: number
}

/** dataDir 的稳定 key：Windows 大小写/尾分隔符归一，避免同一目录被当成两个池项。 */
export function managedKey(dataDir: string): string {
  const normalized = resolve(dataDir).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

export type LifecycleFactory = (options: PostgresLifecycleOptions) => ManagedLifecycle

export class ManagedPostgresPool {
  private readonly slots = new Map<string, Slot>()

  constructor(private readonly create: LifecycleFactory = options => new PostgresLifecycle(options)) {}

  /** 取得一个引用；同一 dataDir 复用同一个生命周期实例。 */
  acquire(options: PostgresLifecycleOptions): ManagedPostgresHandle {
    const key = managedKey(options.dataDir)
    let slot = this.slots.get(key)
    if (slot === undefined) {
      slot = { key, lifecycle: this.create(options), refs: 0 }
      this.slots.set(key, slot)
    }
    slot.refs += 1
    return new ManagedPostgresHandleImpl(this, slot)
  }

  /** 诊断：当前进程内所有受管 dataDir 的引用数。 */
  snapshot(): readonly { readonly key: string; readonly refs: number; readonly status: PostgresLifecycleStatus }[] {
    return [...this.slots.values()].map(slot => ({
      key: slot.key,
      refs: slot.refs,
      status: slot.lifecycle.status(),
    }))
  }

  /** @internal — handle 释放时回调；最后一个引用才 stop。 */
  async release(slot: Slot): Promise<void> {
    slot.refs = Math.max(0, slot.refs - 1)
    if (slot.refs > 0) return
    await slot.lifecycle.stop()
  }
}

class ManagedPostgresHandleImpl implements ManagedPostgresHandle {
  private released = false
  /** 取 handle 时的代；stop 之后旧 handle 的迟到启动会被 lifecycle 拒绝。 */
  private readonly generation: number

  constructor(private readonly pool: ManagedPostgresPool, private readonly slot: Slot) {
    this.generation = slot.lifecycle.status().generation
  }

  get key(): string {
    return this.slot.key
  }

  async ensureStarted(): Promise<void> {
    if (this.released) throw new Error(`Managed PostgreSQL ${this.slot.key} 的句柄已释放，拒绝迟到的启动`)
    return this.slot.lifecycle.ensureStarted(this.generation)
  }

  async release(): Promise<void> {
    if (this.released) return
    this.released = true
    await this.pool.release(this.slot)
  }

  async status(): Promise<ManagedPostgresStatus> {
    const probe = await this.slot.lifecycle.probe()
    return { ...this.slot.lifecycle.status(), refs: this.slot.refs, probe }
  }
}

/** 进程级单例：同一 dataDir 在整条 DSH 进程里只有一个受管生命周期。 */
const poolHolder = globalThis as typeof globalThis & {
  __ombManagedPostgresPool?: ManagedPostgresPool
}

export function getManagedPostgresPool(): ManagedPostgresPool {
  return poolHolder.__ombManagedPostgresPool ??= new ManagedPostgresPool()
}
