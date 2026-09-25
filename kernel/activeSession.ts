/**
 * 活跃会话登记处——会话是**内核级事实**。
 *
 * ## 为什么必须由内核记，而不是让模块自己记
 *
 * 模块经 `toHostPlugin` 拿到的内核是**收养视图**（`kernel/adopt.ts`），
 * 而收养视图的 `on` **优先绑定宿主的事件面**。于是出现一个没有任何报错的断链：
 *
 * - 模块 `kernel.on('turn/start', …)` → 实际订到了**宿主**的事件面
 * - `dsh/session.ts` 在 `step/start` 时 `kernel.emit('turn/start', …)` → 发在**内核总线**
 * - 两者永远碰不到。订阅注册成功、disposer 正常、健康面全绿，症状只是
 *   "事件好像没来"
 *
 * 实测代价：`omb_focus` 一直报"取不到当前会话标识"——它读模块自己记的
 * `lastActiveSession`，而那个变量永远停在 null。
 *
 * 结论：会话这种**全局事实**不能建立在"模块能收到某条事件"之上。
 * 由 `dsh/` 观测到就写进来，模块按需读取即可，与事件订阅是否成立无关。
 */
import type { SessionRef } from './abi/index.js'

export class ActiveSessionTable {
  #current: SessionRef | null = null
  #cwd: string | null = null

  /**
   * 记录一次观测。
   *
   * 空串**不覆盖**已有值：宁可用稍旧的有效会话，也不要被一次空值清掉——
   * 宿主事件里字段缺失是可能的，而"取不到会话"会让一批工具直接失效。
   *
   * `cwd` 可选，且**带了才更新**：不是每次观测都带它，不带的观测不该把已知的 cwd 抹掉。
   */
  remember(session: SessionRef, cwd?: string | undefined): void {
    if (typeof session !== 'string' || session.trim() === '') return
    this.#current = session
    if (typeof cwd === 'string' && cwd.trim() !== '') this.#cwd = cwd
  }

  /** 当前活跃会话；从未观测到时为 null。 */
  current(): SessionRef | null {
    return this.#current
  }

  /**
   * 当前会话的**工作目录**；未知时为 null。
   *
   * ## 为什么内核要存它
   *
   * 模块拿不到会话 cwd（`turn/start` 只有 `sessionId`/`turn`），于是只能退回
   * `process.cwd()`——而那是**宿主进程**的工作目录，不是用户会话的。
   * 用户在别的目录里干活时，相对路径会按宿主 cwd 解析，把真实存在的文件判成
   * 不存在（准入核验因此误拒）。
   *
   * 会话 cwd 是会话级事实，本来就该由观测它的 `dsh/` 交给内核持有。
   */
  cwd(): string | null {
    return this.#cwd
  }

  /** 内核关闭时清空（旧会话在新一轮里不再可信）。 */
  clear(): void {
    this.#current = null
    this.#cwd = null
  }
}
