/**
 * 状态面的**两条诊断判据**。
 *
 * ① 「## 构建」段必须把**加载代数**与**磁盘代数**并排印，并且四种组合各有明确措辞。
 *    只印加载代数时，"我跑的是旧代"没有任何信号——实测真机报「第 77 代（产物目录
 *    lib-gen/g77）」，而磁盘上只有 g79，g77 早被下一次构建清理，读者据此去仓库里
 *    找一个不存在的目录，也无从知道该重启宿主。
 *
 * ② 「## 上下文」段在**没有活跃会话**时不能只说"取不到读数"：那有三种成因
 *    （宿主还没观测到会话 / 宿主没注册 contextPressure 投影 / 宿主从没上报过 usage），
 *    修法完全不同。原因由度量桥给出，状态面负责转述；度量桥没接线时**也要说**
 *    （"未测量"与"没问题"必须看着不一样）。
 */
import { describe, expect, it } from 'vitest'
import { createKernel } from '../../kernel/index.js'
import { SERVICES } from '../../kernel/abi/index.js'
import { buildStatusTool, renderBuildSection } from '../../dsh/status-tool.js'

/** 走**模型可见的那条路**：`omb_status` 工具本体。 */
function statusOf(handle: ReturnType<typeof createKernel>): string {
  const outcome = buildStatusTool(handle).run({})
  expect(outcome instanceof Promise, 'omb_status 必须是同步执行体').toBe(false)
  const sync = outcome as { kind: 'text' | 'error'; text: string }
  expect(sync.kind, `状态面渲染失败：${sync.text}`).toBe('text')
  return sync.text
}

describe('构建段：加载代数与磁盘代数并排', () => {
  it('两者不一致 → 明说"加载的代码不是最新的"并给出重启指引', () => {
    const lines = renderBuildSection(2, 5).join('\n')
    expect(lines).toContain('第 2 代')
    expect(lines).toContain('第 5 代')
    expect(lines).toContain('不是最新的')
    expect(lines).toContain('重启 dsh web')
    expect(lines).toContain('lib-gen/g2')
  })

  it('两者一致 → 如实说一致（不是沉默）', () => {
    const lines = renderBuildSection(5, 5).join('\n')
    expect(lines).toContain('第 5 代')
    expect(lines).toContain('与加载代数一致')
  })

  it('读不到磁盘代数 → "未测量"，且明确不是"没有新代"', () => {
    const lines = renderBuildSection(2, undefined).join('\n')
    expect(lines).toContain('未测量')
    expect(lines).toContain('不是"没有新代"')
  })

  it('源码树里跑（拿不到加载代数）→ 说"无法比对"，不假装一致', () => {
    const lines = renderBuildSection(undefined, 5).join('\n')
    expect(lines).toContain('未知')
    expect(lines).toContain('无法比对')
    expect(lines).not.toContain('与加载代数一致')
  })
})

describe('上下文段：没有活跃会话时必须给原因', () => {
  it('度量桥在位 → 转述它的原因（三种成因靠它区分）', () => {
    const handle = createKernel()
    handle.kernel.provide(SERVICES.pressureReading, {
      reason: () => '宿主尚未注册 contextPressure 投影',
    })
    const text = statusOf(handle)
    expect(text).toContain('无活跃会话')
    expect(text).toContain('宿主尚未注册 contextPressure 投影')
  })

  it('度量桥缺席 → 如实说"未接线"，不省略原因行', () => {
    const handle = createKernel()
    const text = statusOf(handle)
    expect(text).toContain('无活跃会话')
    expect(text).toContain('度量桥未接线')
  })
})
