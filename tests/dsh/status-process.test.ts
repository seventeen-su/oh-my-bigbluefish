/** v4.3：`omb_status` 的进程内存段（OOM 趋势可见）。 */
import { describe, expect, it } from 'vitest'
import { renderProcessSection } from '../../dsh/status-tool.js'

describe('omb_status 进程段', () => {
  it('渲染 rss/heap/external 与 uptime，数值以 MB 显示', () => {
    const lines = renderProcessSection(
      { rss: 512 * 1024 * 1024, heapUsed: 256 * 1024 * 1024, heapTotal: 300 * 1024 * 1024, external: 40 * 1024 * 1024 },
      65,
    )
    const text = lines.join('\n')
    expect(text).toContain('## 进程')
    expect(text).toContain('rss 512 MB')
    expect(text).toContain('heapUsed 256 MB')
    expect(text).toContain('heapTotal 300 MB')
    expect(text).toContain('external 40 MB')
    expect(text).toContain('uptime 1m')
    expect(text).toContain(`Node ${process.version}`)
  })

  it('非法读数写"未测量"，不写 NaN/负数', () => {
    const text = renderProcessSection({ rss: Number.NaN, heapUsed: -1, heapTotal: 0, external: 0 }, Number.NaN).join('\n')
    expect(text).toContain('rss 未测量')
    expect(text).toContain('heapUsed 未测量')
    expect(text).not.toContain('NaN')
    expect(text).toContain('uptime 未知')
  })
})
