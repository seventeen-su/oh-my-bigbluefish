/**
 * **前置条件必须被点名**：依赖没开时，依赖方不许把原因说成别的东西。
 *
 * ## 用户原始要求与这里的对应
 *
 * > 假设记忆库没开，前端UI自动关闭并变灰无打开依赖它的相关组件如向量检索，
 * > 如果配置文档中被强行写入也忽略
 *
 * 「组件变灰」不在本仓库范围（**本仓库没有前端**，插件页由 DSH 提供）。
 * 但「依赖没开 → 依赖方自动关闭」在没有前端时的等价形态是：
 *
 * **能力不可用，且原因可读地点名缺谁**——而不是静默降级成别的理由。
 *
 * ## 为什么这条测试必要（实测过的坏形态）
 *
 * 向量通道的库访问走 `SERVICES.stores`，那个服务由 `omb-memory` 提供。
 * 而它原来的 `report()` **从不检查这个依赖**：记忆库被关掉时，它照样报
 * 「权重目录不存在」——使用者会去修**错的东西**（去下载模型权重），
 * 而真正的问题是那一行被关了。
 *
 * ## 为什么不是"运行时硬阻断"
 *
 * 这条检查**不阻止模块挂载**、也不在 `apply` 返回后注册任何东西（H-2 不受影响）；
 * 它只让依赖方**不假装正常**。
 *
 * 硬阻断被**刻意否决**：模块行之间只有 `inject: ['omb:kernel']` 一道门，
 * **没有顺序保证**——硬阻断会把"依赖晚一点就绪"误判成"依赖缺失"→ 静默丢能力，
 * 那比现在更坏。所以检查放在 `report()` 里**每次实时查**：两种情况都得到正确结论。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createKernel } from '../../../kernel/index.js'
import { SERVICES } from '../../../kernel/abi/index.js'
import { createVectorModule } from '../../../modules/memory/vector.js'

describe('前置条件：依赖缺席必须被点名', () => {
  let dir = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'omb-precond-'))
  })

  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // 清理失败不影响断言
    }
  })

  it('`stores` 服务缺失（记忆库被关）→ 健康面点名缺 omb-memory', () => {
    const handle = createKernel()
    // 刻意**不**提供 SERVICES.stores：模拟 omb-memory 那一行被关掉
    const instance = createVectorModule()
    handle.mount(instance.registration, undefined)

    const health = handle.health()['omb-memory-vector']
    expect(health, '向量模块应当已上报健康').toBeDefined()
    expect(
      health?.detail,
      '必须点名缺的是 omb-memory，而不是让人去修权重目录',
    ).toContain('omb-memory')
    expect(health?.state, '依赖缺席时不许自称正常').toBe('degraded')
    handle.dispose()
  })

  it('`stores` 服务在位 → **不许**误报缺依赖（否则就是假告警）', () => {
    const handle = createKernel()
    handle.kernel.provide(SERVICES.stores, {
      snapshot: () => ({ user: undefined, projects: [] }),
      forSession: () => undefined,
      forProject: () => undefined,
      status: () => ({ ready: false, detail: '桩：只为满足前置条件', openProjects: [] }),
    })
    const instance = createVectorModule()
    handle.mount(instance.registration, undefined)

    const health = handle.health()['omb-memory-vector']
    expect(health).toBeDefined()
    expect(
      health?.detail,
      'stores 在位时不得出现"缺少必需依赖"——假告警会训练人无视真告警',
    ).not.toContain('缺少必需依赖')
    handle.dispose()
  })
})
