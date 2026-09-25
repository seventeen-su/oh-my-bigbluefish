/**
 * 制品索引的**生产者**接线：宿主 `tool/call` → `ArtifactService.record()`。
 *
 * 这个文件补的是一个**接线缺失**（自检报告发现、实测确认）：
 *
 * `modules/artifact/module.ts` 的 `record()` 注释写着
 * 「由 `dsh/hooks.ts` 从宿主会话事件（`tool/call` 参数）提取路径后调用」，
 * 但那个文件不存在，全仓库也没有任何地方调用 `record()`。
 *
 * 后果：`omb_files` 索引**恒为 0**，而模块正常挂载、健康面全绿、工具可调用、
 * 返回"制品索引为空"——每一层单独看都对，只是中间少了一根线。
 * 自检报告把它正确地标为"无法区分『没观察过』与『没在工作』"，答案是后者。
 */
import { describe, expect, it } from 'vitest'

import { pathsFromToolCall, wireArtifactIndex } from '../../dsh/hooks.js'
import { SERVICES } from '../../kernel/abi/index.js'
import { createKernel } from '../../kernel/index.js'

describe('制品索引接线', () => {
  it('只从**带路径的工具白名单**里取路径，不看自由文本', () => {
    expect(pathsFromToolCall('read', { file_path: 'a/b.ts' })).toEqual(['a/b.ts'])
    expect(pathsFromToolCall('glob', { pattern: '**/*.ts', path: 'modules' })).toEqual(['modules'])
    // `command` 是自由文本：里面出现 `x.ts` 不算"产出了制品"。
    // **这正是本项目反复踩的"形态匹配当语义"**——不重蹈。
    expect(pathsFromToolCall('pwsh', { command: 'Get-Content x.ts' })).toEqual([])
    // 未知工具一律不猜
    expect(pathsFromToolCall('some-other-tool', { file_path: 'a.ts' })).toEqual([])
  })

  it('空/非字符串路径不产生条目（不臆造）', () => {
    expect(pathsFromToolCall('read', { file_path: '   ' })).toEqual([])
    expect(pathsFromToolCall('read', {})).toEqual([])
    expect(pathsFromToolCall('read', undefined)).toEqual([])
  })

  it('订阅 tool/call 后，工具调用参数里的路径真的进了索引', () => {
    // **这是"接线存在"的判据**：不是"模块能挂载"，而是"调用一次工具后索引里真有东西"。
    const handle = createKernel()
    const recorded: string[] = []
    handle.kernel.provide(SERVICES.artifact, {
      record: (path: string) => {
        recorded.push(path)
        return undefined
      },
    })

    const handlers = new Map<string, (...args: never[]) => void>()
    const ctx = {
      on: (event: string, fn: (...args: never[]) => void) => {
        handlers.set(event, fn)
        return () => handlers.delete(event)
      },
    }

    const dispose = wireArtifactIndex({ ctx, kernel: handle.kernel })
    expect(handlers.has('tool/call'), '必须订阅 tool/call').toBe(true)

    handlers.get('tool/call')?.({ name: 'read', args: { file_path: 'src/x.ts' } } as never)
    expect(recorded).toEqual(['src/x.ts'])

    // 自由文本工具不该产出条目
    handlers.get('tool/call')?.({ name: 'pwsh', args: { command: 'cat y.ts' } } as never)
    expect(recorded).toEqual(['src/x.ts'])

    dispose()
    expect(handlers.has('tool/call')).toBe(false)
    handle.dispose()
  })

  it('没有制品服务时不抛（H-3：缺失即降级）', () => {
    const handle = createKernel()
    const handlers = new Map<string, (...args: never[]) => void>()
    const ctx = {
      on: (event: string, fn: (...args: never[]) => void) => {
        handlers.set(event, fn)
        return () => handlers.delete(event)
      },
    }
    const dispose = wireArtifactIndex({ ctx, kernel: handle.kernel })
    expect(() => {
      handlers.get('tool/call')?.({ name: 'read', args: { file_path: 'a.ts' } } as never)
    }).not.toThrow()
    dispose()
    handle.dispose()
  })

  it('disposer 绝不抛，且可重复调用（H-1）', () => {
    const handle = createKernel()
    const ctx = { on: () => () => {} }
    const dispose = wireArtifactIndex({ ctx, kernel: handle.kernel })
    expect(() => {
      dispose()
      dispose()
    }).not.toThrow()
    handle.dispose()
  })
})
