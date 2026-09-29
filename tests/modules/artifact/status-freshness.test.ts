/**
 * 制品索引的**状态面不得冻结**。
 *
 * ## 实测过的症状（真机，2026-09-30）
 *
 * 同一次 `omb_status` 输出里：
 *
 * ```
 * 模块行  omb-artifact：正常——制品索引 0/500 条
 * 而 omb_files 立刻返回 3 条真实路径
 * ```
 *
 * ## 根因
 *
 * 模块行读的是 `kernel.report()` 的**快照**，而制品模块原来只在 `apply` 时报一次
 * （那时索引还空着）；工具读的是实时索引。两者必然分叉。
 *
 * 更根本的一点：**`omb_status` 不会调用模块的 health 函数**——它只渲染已登记的
 * 「组件自述」段（`dsh/status-tool.ts` 的 `registry.list()`）。所以**没有状态段的
 * 模块，其快照永远冻结**。制品索引原先连一个状态面出口都没有。
 *
 * ## 修法
 *
 * 登记一个状态段，并在 `render` 里**先自报一次**——于是模块行与组件段在
 * **同一次调用内**读到同一份状态，结构上不可能再分叉。
 * `omb-notify` 用的是同一条路子。
 *
 * ## 这条测试盯什么
 *
 * 不是"段存在"，而是：**索引写入后，模块行的读数跟着变**。
 * 只断言段存在会放过原缺陷（原来也没段，但真正的问题是数字不动）。
 */
import { describe, expect, it } from 'vitest'

import { SERVICES } from '../../../kernel/abi/index.js'
import type { StatusRegistry } from '../../../kernel/abi/index.js'
import { createKernel } from '../../../kernel/index.js'
import { createArtifactModule } from '../../../modules/artifact/module.js'

describe('制品索引状态面：数字必须跟着索引走', () => {
  it('写入制品后，模块行与状态段都反映真实条数（不再冻结在 apply 那一刻）', () => {
    const handle = createKernel()
    // `createArtifactModule()` 返回的就是注册项本身（不是带 `.registration` 的工厂对象）
    handle.mount(createArtifactModule(), undefined)

    const moduleLineBefore = (): string => handle.health()['omb-artifact']?.detail ?? ''
    expect(moduleLineBefore(), '启动时索引为空').toContain('0/500')

    // 经真实服务写入两条路径（生产里由 dsh/hooks.ts 解析工具参数后调用）
    const service = handle.kernel.service<{ record(path: string): unknown }>(SERVICES.artifact)
    expect(service, '制品服务必须已注册').toBeDefined()
    service?.record('src/alpha.ts')
    service?.record('src/beta.ts')

    // 关键：**渲染状态段**（omb_status 的真实路径），它会在渲染前自报
    const registry = handle.kernel.service<StatusRegistry>(SERVICES.statusContributor)
    expect(registry, '制品模块必须登记状态段——否则快照永远冻结').toBeDefined()
    const section = registry?.list().find(c => c.name.includes('制品索引'))
    expect(section, '状态段必须可找到').toBeDefined()
    const rendered = section?.render() ?? ''
    expect(rendered, '状态段必须报出真实条数').toContain('2')

    // 渲染之后，模块行也必须跟上——这是"两个面同一次调用内一致"的判据
    expect(moduleLineBefore(), '模块行必须已跟上，不许停在 0').not.toContain('0/500')
    handle.dispose()
  })

  it('dispose 后不留悬空状态段（注册了就必须注销）', () => {
    const handle = createKernel()
    const dispose = handle.mount(createArtifactModule(), undefined)

    const registry = handle.kernel.service<StatusRegistry>(SERVICES.statusContributor)
    expect(registry?.list().some(c => c.name.includes('制品索引'))).toBe(true)

    dispose()
    expect(
      registry?.list().some(c => c.name.includes('制品索引')),
      '热插拔后不该留下指向已 dispose 实例的段落（它闭包捕获了被清空的索引）',
    ).toBe(false)
    handle.dispose()
  })
})
