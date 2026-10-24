/**
 * 会话目录端口（v4.18.0）：给「项目」页列出**宿主里真实存在的会话**。
 *
 * 边界（为什么必须由 `dsh/` 提供）：
 * - 会话持久化、归档集合、标题投影都是宿主服务；`modules/` 不得 import 宿主包；
 * - 这里只给**结构最小面**：id、标题、cwd、创建时间、preset、是否归档、是否活着。
 *   不暴露 Session 对象、不暴露事件日志、不做任何读取正文的操作；
 * - 取不到宿主服务时 `list()` 返回 `available:false` 与原因，**不返回空列表冒充"没有会话"**。
 *
 * 归档语义：`archived` 来自宿主的 durable 归档集合；归档会话在 UI 中必须灰色显示且
 * 不可读（不取画像、不改隐私），这是用户的显式决定，不是前端猜测。
 */
export interface SessionCatalogEntry {
  readonly id: string
  /** 宿主标题投影；没有就是 null（页面不猜、不拿 cwd 冒充标题）。 */
  readonly title: string | null
  /** 会话头里的绝对 cwd（持久化头必有）。 */
  readonly cwd: string
  /** 会话创建时间（毫秒）。 */
  readonly createdAt: number
  /** 会话头里的 agentPreset；旧日志没有时为 null。 */
  readonly agentPreset: string | null
  /** 是否在宿主 durable 归档集合里。 */
  readonly archived: boolean
  /** 本进程内是否活着（宿主 sessions 里存在）。 */
  readonly live: boolean
  /**
   * 父会话 id（v4.20.0，子代理会话的 `header.parentSession`）；没有就是 null。
   *
   * 只用于「所有状态机」/项目页显示子会话归属与跟随母会话；不是血缘的权威来源
   * （隐私继承仍由隐私模块从宿主会话头自己登记）。
   */
  readonly parentId: string | null
}

/** 一次目录读取的结果；`available:false` 时 `items` 必为空且带原因。 */
export interface SessionCatalogListing {
  readonly available: boolean
  readonly reason?: string
  readonly items: readonly SessionCatalogEntry[]
}

/** 会话目录端口（内核服务 `SERVICES.sessionCatalog`）。 */
export interface SessionCatalogPort {
  list(): Promise<SessionCatalogListing>
}
