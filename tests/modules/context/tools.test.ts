/**
 * `omb_status` 的上下文段：数据组装（规划 §6.6）。
 *
 * 组装必须能承受**任何缺席**：没有健康面、没有压力读数、没有台账，
 * 都只是少几行并**写明原因**，不是抛异常、也不是输出假读数。
 */
import { describe, expect, it } from 'vitest'
import type { ContextPressure, ModuleHealth } from '../../../kernel/abi/index.js'
import { behaviorFor } from '../../../modules/context/pressure.js'
import { buildStatusPanel, createStatusContributor, renderStatusPanel } from '../../../modules/context/tools.js'
import { EMPTY_LEDGER, MIN_TURNS_FOR_VERDICT, VIEW_TOOLS, noteTurn, recordPull, summarize } from '../../../modules/context/watch.js'

const pressure = (over: Partial<ContextPressure> = {}): ContextPressure => ({
  totalTokens: 4200,
  fillRatio: 0.42,
  band: 'moderate',
  cacheReadTokens: 800,
  cacheWriteTokens: 200,
  nodes: [
    { name: 'omb_recall', tokens: 900 },
    { name: 'persona', tokens: 300 },
  ],
  ...over,
})

const health: Readonly<Record<string, ModuleHealth>> = {
  'omb-context': { state: 'ok', detail: '软档位 moderate' },
  'omb-memory-vector': { state: 'degraded', detail: 'onnxruntime-node 未安装，退回纯词法' },
  'omb-notify': { state: 'failed', detail: '依赖缺失：omb-kernel' },
}

const pullsAfter = (pulls: Readonly<Record<string, number>>, turns: number, session: string | null = 's') => {
  let ledger = noteTurn(EMPTY_LEDGER, turns)
  for (const [view, count] of Object.entries(pulls)) {
    for (let index = 0; index < count; index += 1) ledger = recordPull(ledger, view, turns)
  }
  return summarize(ledger, { views: VIEW_TOOLS }, session)
}

describe('buildStatusPanel：健康面与降级原因', () => {
  it('统计三态并逐条写明非 ok 模块的原因', () => {
    const panel = buildStatusPanel({ health })
    const text = renderStatusPanel(panel)
    expect(text).toContain('模块健康：3 个（正常 1 / 降级 1 / 失败 1）')
    expect(text).toContain('omb-memory-vector：degraded——onnxruntime-node 未安装，退回纯词法')
    expect(text).toContain('omb-notify：failed——依赖缺失：omb-kernel')
    expect(panel.metrics.modulesFailed).toBe(1)
  })

  it('没有健康面时整段省略（模块拿不到全局健康，不输出"0 个"这种假读数）', () => {
    const text = renderStatusPanel(buildStatusPanel({}))
    expect(text).not.toContain('模块健康')
    expect(text).not.toContain('0 个')
  })

  it('本模块自己的降级原因与附加说明逐条写出', () => {
    const text = renderStatusPanel(buildStatusPanel({
      health,
      degradations: ['压力读数不可用', '配置被收敛'],
      notes: ['无活跃会话：压力读数缺失，按宽松档处理'],
    }))
    expect(text).toContain('降级原因：压力读数不可用；配置被收敛')
    expect(text).toContain('说明：无活跃会话')
  })

  it('没有任何降级时明确写"降级原因：无"', () => {
    expect(renderStatusPanel(buildStatusPanel({ health }))).toContain('降级原因：无')
  })
})

describe('buildStatusPanel：压力与塑形行为', () => {
  it('档位、fillRatio、缓存命中率与最贵节点', () => {
    const panel = buildStatusPanel({ pressure: pressure(), behavior: behaviorFor('moderate') })
    const text = renderStatusPanel(panel)
    expect(text).toContain('压力档位：moderate（fillRatio 0.420')
    expect(text).toContain('缓存：读 800 / 写 200，命中率 0.80')
    expect(text).toContain('最贵 2 块：omb_recall(900)、persona(300)')
    expect(panel.cacheHitRate).toBeCloseTo(0.8, 6)
    expect(panel.metrics.fillRatio).toBeCloseTo(0.42, 6)
  })

  it('档位行为写清"最多推几条"与"被推迟内容仍可取回"', () => {
    const moderate = renderStatusPanel(buildStatusPanel({ pressure: pressure(), behavior: behaviorFor('moderate') }))
    expect(moderate).toContain('最多推 1 条')
    expect(moderate).toContain('仍可通过工具取回')
    const tight = renderStatusPanel(buildStatusPanel({ pressure: pressure({ band: 'tight' }), behavior: behaviorFor('tight') }))
    expect(tight).toContain('只保留索引')
  })

  it('fillRatio 为 null（宿主未声明窗口）→ normal 档行为 + 明确说明', () => {
    const panel = buildStatusPanel({ pressure: pressure({ fillRatio: null, band: 'relaxed' }) })
    expect(renderStatusPanel(panel)).toContain('未知（宿主未声明窗口）')
    expect(panel.metrics.fillRatio).toBeUndefined()
  })

  it('没有压力读数时写明原因，并按宽松档（不施压）', () => {
    const text = renderStatusPanel(buildStatusPanel({}))
    expect(text).toContain('压力读数：不可用')
    expect(text).toContain('按宽松档处理')
    expect(text).toContain('档位行为：none')
    expect(text).toContain('最多推 0 条')
  })

  it('无缓存读写时命中率写"不可测"，不是 0', () => {
    const text = renderStatusPanel(buildStatusPanel({ pressure: pressure({ cacheReadTokens: 0, cacheWriteTokens: 0 }) }))
    expect(text).toContain('不可测')
    expect(text).not.toContain('命中率 0.00')
  })
})

describe('buildStatusPanel：拉取计数（杀死判据可见）', () => {
  it('汇总拉取率、零拉取视图与待删除列表，并写明是**本会话**口径', () => {
    const panel = buildStatusPanel({ pulls: pullsAfter({ omb_recall: 30 }, MIN_TURNS_FOR_VERDICT) })
    const text = renderStatusPanel(panel)
    expect(text).toContain('拉取台账：本会话拉取 30 次')
    expect(text).toContain('/ 20 轮')
    expect(text).toContain('待删除视图：omb_files')
    expect(text).toContain('零拉取视图：')
    expect(panel.metrics.totalPulls).toBe(30)
    expect(panel.metrics.deadViews).toBe(4)
    expect(panel.metrics.pullSessionKnown).toBe(1)
    expect(panel.metrics.pullTurnsKnown).toBe(1)
  })

  it('轮数不足 → 不给"待删除视图"、不下"该删"结论（样本不够就不装懂）', () => {
    const panel = buildStatusPanel({ pulls: pullsAfter({ omb_recall: 2 }, 3) })
    const text = renderStatusPanel(panel)
    expect(text).toContain('本会话拉取 2 次 / 3 轮')
    expect(text).toContain('轮数不足')
    expect(text).toContain('暂不下删除结论')
    expect(text).not.toContain('待删除视图')
    // **字段本身仍要出现**，只是内容写"暂不判定"。
    //
    // 原先"为空就整行不渲染"，于是读者无法分辨"没有可删的"与"根本没统计"
    // ——自检报告正是这么记的：「返回里没有『零拉取视图』字段」。
    // **空集与缺字段是两件事。**
    expect(text, '字段必须出现，内容说明为什么不判定').toContain('零拉取视图：（暂不判定')
    expect(text, '轮数不足时不得给出可删名单').not.toContain('零拉取视图：omb_')
    expect(panel.metrics.deadViews).toBe(0)
    expect(panel.metrics.pullTurnsKnown).toBe(1)
  })

  it('轮数未知 ⇒ 分母未知：如实写"未知"，不拿别的数顶替、也不下结论', () => {
    const panel = buildStatusPanel({ pulls: pullsAfter({ omb_recall: 2 }, 0) })
    const text = renderStatusPanel(panel)
    expect(text).toContain('本会话拉取 2 次 / 轮数未知')
    expect(text).toContain('口径：本会话回合数未知')
    expect(text).toContain('分母未知')
    expect(text).not.toContain('待删除视图')
    expect(panel.metrics.pullTurns).toBe(0)
    expect(panel.metrics.pullTurnsKnown).toBe(0)
  })

  it('拿不到会话 → 明说"未知会话"桶，不并入任何具体会话', () => {
    const panel = buildStatusPanel({ pulls: pullsAfter({ omb_recall: 1 }, 1, null) })
    const text = renderStatusPanel(panel)
    expect(text).toContain('未知会话拉取 1 次')
    expect(text).toContain('口径：拿不到本会话标识')
    expect(text).toContain('不并入任何具体会话')
    expect(panel.metrics.pullSessionKnown).toBe(0)
  })

  it('没有台账时写"无"，不留空', () => {
    expect(renderStatusPanel(buildStatusPanel({}))).toContain('拉取台账：无')
  })
})

describe('buildStatusPanel：预算与健壮性', () => {
  it('预算面与 metrics 都是数字', () => {
    const panel = buildStatusPanel({ budgets: { calls: { used: 3, limit: 10 } } })
    expect(renderStatusPanel(panel)).toContain('预算：calls 3/10')
    for (const value of Object.values(panel.metrics)) expect(Number.isFinite(value)).toBe(true)
  })

  it('畸形输入（null / NaN / 垃圾）不抛，且不产生非有限数', () => {
    const panel = buildStatusPanel({
      health: null,
      pressure: { totalTokens: Number.NaN, fillRatio: Number.NaN, band: 'bogus' as never, cacheReadTokens: Number.NaN, cacheWriteTokens: -5, nodes: null as never },
      // 畸形台账先过 summarize（它负责把 NaN 计数收敛成 0，不污染 pullsPerTurn）
      pulls: summarize(
        { views: { omb_recall: { pulls: Number.NaN, firstTurn: null, lastTurn: null } }, turns: Number.NaN } as never,
        { views: VIEW_TOOLS },
      ),
      degradations: null,
    })
    expect(panel.lines.length).toBeGreaterThan(0)
    expect(panel.cacheHitRate).toBeNull()
    expect(panel.metrics.totalPulls).toBe(0)
    expect(panel.metrics.turns === undefined || Number.isFinite(panel.metrics.turns)).toBe(true)
    for (const value of Object.values(panel.metrics)) expect(Number.isFinite(value)).toBe(true)
  })
})

describe('createStatusContributor', () => {
  it('名字默认是上下文模块，render/metrics 都可用', () => {
    const contributor = createStatusContributor(() => ({ pressure: pressure(), behavior: behaviorFor('moderate') }))
    expect(contributor.name).toBe('上下文优化（omb-context）')
    expect(contributor.render()).toContain('压力档位：moderate')
    expect(contributor.metrics?.().pushLimit).toBe(1)
  })

  it('读取函数抛异常时 render 返回一行可读原因（绝不抛），metrics 也不抛', () => {
    const contributor = createStatusContributor(() => {
      throw new Error('存储炸了')
    })
    expect(contributor.render()).toContain('存储炸了')
    expect(contributor.metrics?.()).toEqual({ renderError: 1 })
  })
})
