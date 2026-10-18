/**
 * 状态面**不得自相矛盾**：同一次 `omb_status` 里，两个面必须说同一件事。
 *
 * ## 这条测试针对的实测矛盾（2026-10-03）
 *
 * ```
 * - omb-artifact：正常——制品索引 0/500 条                       ← 挂载时快照
 * ### 制品索引（…）    已索引 2 条                                ← 实时
 *
 * - omb-notify：正常——宿主未安装 desktopNotify 服务              ← 挂载时快照
 * ### 桌面通知（…）    已接上宿主 desktopNotify（通道 notify）     ← 实时
 * ```
 *
 * 这些是**同一类缺陷**：模块行读的是内核健康面的**上报快照**
 * （`kernel/health.ts` 的 `report`/`snapshot`），而会动的那个面读**实时**状态。
 * 快照一旦没有人刷新，模块行就停在最后一次上报那一刻——读者看到的不是
 * "一个数字旧了"，而是**同一次输出里两个相反的说法**：一个"正常"的模块行
 * 配一个"降级/不可用"的组件自述（或反过来），于是没人知道该信哪个，
 * 整个状态面（唯一的模型可见诊断入口）一起失去可信度。
 *
 * v4：`omb-context` 组件已删除，压力读数只剩顶层 `## 上下文` 一个来源，
 * 不再存在"顶层 vs 组件段"两处读数的矛盾面；本文件保留制品/通知两条同类判据。
 *
 * ## 判据为什么必须是"两处一致"而不是"某处等于某个值"
 *
 * 断言"组件自述说 2 条"在原缺陷下**照样通过**（它本来就是实时的那一侧）；
 * 断言"模块行说 2 条"只钉住这一次的数值，换一处读数就再次漂开。
 * 所以每条用例都从**同一次渲染的文本**里取两个面，再比较它们。
 *
 * 渲染走 `buildStatusTool(...).run()`——即模型真正调用的那个入口，
 * 而不是测试自己拼装的一份近似输出。
 */
import { describe, expect, it } from 'vitest'
import { createKernel } from '../../kernel/index.js'
import type { StatusRegistry } from '../../kernel/abi/index.js'
import { SERVICES } from '../../kernel/abi/index.js'
import { buildStatusTool } from '../../dsh/status-tool.js'
import { createArtifactModule } from '../../modules/artifact/module.js'
import { createNotifyModule, NOTIFY_HOST_SERVICE } from '../../modules/notify/index.js'

/** 走**模型可见的那条路**：`omb_status` 工具本体。 */
function statusOf(handle: ReturnType<typeof createKernel>): string {
  const outcome = buildStatusTool(handle).run({})
  // `run` 的签名允许返回 Promise（模块工具多为异步）；`omb_status` 是同步的，
  // 这里断言"不是 Promise"，把契约漂移变成一条可读的失败而不是 await 一个假值。
  expect(outcome instanceof Promise, 'omb_status 必须是同步执行体').toBe(false)
  const sync = outcome as { kind: 'text' | 'error'; text: string }
  expect(sync.kind, `状态面渲染失败：${sync.text}`).toBe('text')
  return sync.text
}

/**
 * 取一段的正文：`## 上下文` 这类顶层段，或 `### 名字` 这类组件段。
 * 到下一个二/三级标题为止（组件段里的小节没有标题，因此不会截断）。
 */
function blockOf(text: string, heading: string): string {
  const at = text.indexOf(heading)
  if (at === -1) return ''
  const rest = text.slice(at + heading.length)
  const next = rest.search(/\n#{2,3} /)
  return next === -1 ? rest : rest.slice(0, next)
}

/** 「## 模块」段里某个模块的那一行（模块行 = 内核健康面的上报快照）。 */
function moduleRowOf(text: string, id: string): string {
  return new RegExp(`^- ${id}：.+$`, 'm').exec(text)?.[0] ?? ''
}

function registryOf(handle: ReturnType<typeof createKernel>): StatusRegistry {
  const registry = handle.kernel.service<StatusRegistry>(SERVICES.statusContributor)
  if (registry === undefined) throw new Error('状态面登记处缺失（内核未 provide）')
  return registry
}

describe('矛盾 2：制品索引条数——模块行与组件自述同一个数', () => {
  it('索引写入后，同一次 omb_status 里两处都报 2（模块行不许停在挂载那一刻）', () => {
    const handle = createKernel()
    handle.mount(createArtifactModule(), undefined)

    const service = handle.kernel.service<{ record(path: string): unknown }>(SERVICES.artifact)
    expect(service, '制品服务必须已注册').toBeDefined()
    service?.record('src/alpha.ts')
    service?.record('src/beta.ts')

    const text = statusOf(handle)
    const row = moduleRowOf(text, 'omb-artifact')
    const panel = blockOf(text, '### 制品索引（omb-artifact）')
    const rowCount = /制品索引 (\d+)\/(\d+) 条/.exec(row)?.[1]
    const panelCount = /已索引 (\d+) 条/.exec(panel)?.[1]

    expect(panelCount, '组件自述读实时：写了 2 条就说 2 条').toBe('2')
    expect(rowCount, '模块行必须跟上（停在 0 就是快照没被刷新）').toBe(panelCount)
    expect(row, '模块行同时要报出上限口径').toContain('/500 条')
    handle.dispose()
  })
})

describe('矛盾 3：通知服务可用性——模块行与组件自述同一口径', () => {
  it('宿主晚一步才接上 desktopNotify：同一次 omb_status 里两处都必须说"已接上"', () => {
    const handle = createKernel()
    handle.mount(createNotifyModule(), undefined)

    const before = statusOf(handle)
    expect(moduleRowOf(before, 'omb-notify')).toContain('未安装 desktopNotify')
    expect(blockOf(before, '### 桌面通知（omb-notify）')).toContain('未安装 desktopNotify')

    // 真实时序：`dsh-desktop-notify` 可能晚于 OMB 挂载；宿主服务每次推送都重新解析
    const unprovide = handle.kernel.provide(NOTIFY_HOST_SERVICE, { push: (): boolean => true })

    const after = statusOf(handle)
    const row = moduleRowOf(after, 'omb-notify')
    const panel = blockOf(after, '### 桌面通知（omb-notify）')
    expect(panel, '组件自述读实时：接上了就说接上了').toContain('已接上宿主 desktopNotify')
    expect(row, '模块行必须与组件自述同口径（这正是"修过一次又复发"的那处）')
      .toContain('已接上宿主 desktopNotify')
    expect(
      row.includes('未安装'),
      '两个面必须同时改口——一个说接上、一个说没装，读者就无法判断该信哪个',
    ).toBe(panel.includes('未安装'))

    // 反向也要一致：宿主服务被卸下 → 两处一起回到"未安装"
    unprovide()
    const gone = statusOf(handle)
    expect(moduleRowOf(gone, 'omb-notify')).toContain('未安装 desktopNotify')
    expect(blockOf(gone, '### 桌面通知（omb-notify）')).toContain('未安装 desktopNotify')
    handle.dispose()
  })
})

describe('机制：模块行必须在同一次渲染里反映贡献者的刷新', () => {
  it('贡献者在 render 里自报的健康，当场就出现在「## 模块」段', () => {
    const handle = createKernel()
    const scoped = handle.scopedKernel('omb-probe')
    // 先有一次快照：等价于模块在 apply 时报的那一次（那时的值此后就不该再用）
    scoped.report({ state: 'ok', detail: '计数 0' })
    registryOf(handle).register({
      name: '探针',
      render: (): string => {
        scoped.report({ state: 'ok', detail: '计数 1' })
        return '自述：计数 1'
      },
    })

    const text = statusOf(handle)
    expect(blockOf(text, '### 探针')).toContain('计数 1')
    // **判据是"同一次输出"**：先取健康面快照、再渲染段落，模块行就会落后一次调用
    // （症状正是「模块行 0/500 而组件自述 2 条」）。这条与具体模块无关，
    // 所以它挡的是"下一处同类缺陷"，而不只是这三个模块。
    expect(moduleRowOf(text, 'omb-probe'), '模块行不得落后于同一次渲染里的刷新').toContain('计数 1')
    handle.dispose()
  })
})
