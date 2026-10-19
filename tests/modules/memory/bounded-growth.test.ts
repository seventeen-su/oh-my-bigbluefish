/**
 * v4.3：有界化回归测试（ChatGPT 审查指出的两个增长点 + 同类缓存）。
 *
 * ① `turnBySession`：有上限、同一会话刷新 LRU；
 * ② `projectFailures`：有上限、错误文本截断、状态面只展示前 N 条；
 * ③ 项目库失败不应拖垮用户库（降级语义保持）。
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SqliteLike } from '../../../kernel/abi/index.js'
import { MAX_TRACKED_TURNS, rememberTurn } from '../../../modules/memory/index.js'
import {
  MAX_PROJECT_FAILURES,
  MAX_PROJECT_FAILURE_TEXT,
  createStoresService,
} from '../../../modules/memory/store.js'
import {
  capturingLogger,
  fixedClock,
  nodeSqlite,
  tempWorkspace,
  testPort,
} from './helpers.js'

describe('v4.3 有界化', () => {
  it('turnBySession：超过上限按插入序淘汰；同一会话 set 会刷新 LRU', () => {
    const map = new Map<string, number>()
    for (let i = 0; i < MAX_TRACKED_TURNS + 5; i += 1) {
      rememberTurn(map, `s${i}`, i)
    }
    expect(map.size).toBe(MAX_TRACKED_TURNS)
    expect(map.has('s0')).toBe(false)
    expect(map.has(`s${MAX_TRACKED_TURNS + 4}`)).toBe(true)

    // 刷新 s5（仍在表内）→ 再插入 1 条时被淘汰的是当前最旧 s6，而不是 s5
    rememberTurn(map, 's5', 999)
    rememberTurn(map, 'fresh', 1)
    expect(map.has('s5')).toBe(true)
    expect(map.has('s6')).toBe(false)
  })

  it('projectFailures：最多保留 32 条、错误文本截断、状态只显示前 5 条', async () => {
    const ws = tempWorkspace()
    const logger = capturingLogger()
    const port = testPort(ws.dir, {
      openDatabase: (path: string): SqliteLike => {
        if (path.endsWith('session.db')) {
          throw new Error(`项目库打不开：${'x'.repeat(400)}`)
        }
        return nodeSqlite(path)
      },
    })
    const service = createStoresService({
      logger,
      clock: fixedClock(),
      resolvePort: () => port,
    })

    for (let i = 0; i < MAX_PROJECT_FAILURES + 8; i += 1) {
      await service.forProject(join(ws.dir, `project-${i}`))
    }

    const status = service.status()
    const detail = status.detail
    expect(detail).toContain(`项目库失败 ${MAX_PROJECT_FAILURES} 个`)
    expect(detail).toContain('只显示前 5 条')
    // 单条原因被截断：不应出现 400 个连续 x
    expect(detail.includes('x'.repeat(MAX_PROJECT_FAILURE_TEXT + 1))).toBe(false)
    expect(detail.length).toBeLessThan(3000)
    // 用户库仍可用（降级而非全失）
    expect(status.ready).toBe(true)
    expect(status.openProjects.length).toBe(0)

    await service.close()
    ws.cleanup()
  })
})
