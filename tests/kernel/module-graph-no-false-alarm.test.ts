/**
 * 依赖图自检**不得产出假告警**。
 *
 * ## 这条测试防的是什么
 *
 * 真实宿主实测到的输出（`omb_status` 的「模块依赖图」段）：
 *
 * ```
 * ### 模块依赖图
 * 依赖未挂载 6 处（前置条件未满足，依赖方应已自行降级）：
 * - omb-privacy ← omb-kernel
 * - omb-memory ← omb-kernel
 * - omb-reasoning ← omb-kernel
 * …
 * ```
 *
 * **而同一次状态面里 8 个模块全部 `正常`、0 失败——内核显然在。**
 *
 * ## 根因
 *
 * 内核行（`dsh/plugin.ts` 的 `KERNEL_SELF`）的 `apply` 是**空操作**：内核在
 * `createKernel()` 里就建好了，那行只把"内核已就绪"发布到宿主 ctx，
 * **从不经过 `mount()`**。而 `recordMount()` 只在 `mount()` / `start()` 里调，
 * 于是账本里没有 `omb-kernel`，每个声明 `requires: ['omb-kernel']` 的模块都被
 * 判成"依赖未挂载"。
 *
 * ## 为什么必须钉住
 *
 * **自检若把"我没记录到的"当成"不存在"，它就会稳定地产出假告警；
 * 而假告警会训练人无视真告警**——那时自检比没有更坏。
 *
 * 这与「制品索引恒空」（订了一个永不触发的 `ctx.on('tool/call')`）同源：
 * 两次都是"看起来在工作，实际在空转或误报"。
 */
import { describe, expect, it } from 'vitest'

import type { ModuleRegistration } from '../../kernel/abi/index.js'
import { createKernel } from '../../kernel/index.js'

/** 一个最小模块，声明依赖。 */
function moduleRequiring(id: string, requires: readonly string[]): ModuleRegistration<unknown> {
  return {
    manifest: {
      id,
      version: '0.0.0',
      requires,
      capabilities: [],
      configSchema: { parse: () => ({}) },
      tools: [],
    },
    apply: () => () => {},
  } as unknown as ModuleRegistration<unknown>
}

describe('依赖图自检不得误报', () => {
  it('内核行自己入账：依赖 omb-kernel 的模块不报「依赖未挂载」', () => {
    const handle = createKernel()
    // 真实路径：模块经 mount() 挂载（内核行不走这条路，由内核自己入账）
    handle.mount(moduleRequiring('omb-memory', ['omb-kernel']), undefined)

    const graph = handle.moduleGraph()
    expect(graph.missingDependencies, '内核在，不该报它未挂载').toEqual([])
    expect(graph.orderViolations, '内核最早入账，不该报顺序违规').toEqual([])
    expect(graph.mounted).toContain('omb-kernel')
    handle.dispose()
  })

  it('多个模块依赖内核时也不误报（真实形态：8 个模块都依赖它）', () => {
    const handle = createKernel()
    for (const id of ['omb-privacy', 'omb-memory', 'omb-memory-vector', 'omb-reasoning', 'omb-context']) {
      handle.mount(moduleRequiring(id, ['omb-kernel']), undefined)
    }
    const graph = handle.moduleGraph()
    expect(graph.missingDependencies).toEqual([])
    expect(graph.orderViolations).toEqual([])
    handle.dispose()
  })

  it('真的缺依赖时仍要报（修假告警不能把真告警一起关掉）', () => {
    const handle = createKernel()
    handle.mount(moduleRequiring('omb-orphan', ['omb-not-mounted']), undefined)

    const graph = handle.moduleGraph()
    expect(graph.missingDependencies, '真缺失必须报出来').toEqual(['omb-orphan ← omb-not-mounted'])
    handle.dispose()
  })

  it('顺序违规仍要报（先挂依赖方才挂依赖）', () => {
    const handle = createKernel()
    // 先挂依赖方，再挂被依赖者 → 后者"来得太晚"
    handle.mount(moduleRequiring('omb-needs-b', ['omb-b']), undefined)
    handle.mount(moduleRequiring('omb-b', []), undefined)

    const graph = handle.moduleGraph()
    expect(graph.orderViolations).toEqual(['omb-needs-b ← omb-b'])
    expect(graph.missingDependencies).toEqual([])
    handle.dispose()
  })
})
