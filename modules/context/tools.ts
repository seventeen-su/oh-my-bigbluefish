/**
 * 上下文侧的状态面**数据组装**（`omb_status` 的一段）。
 *
 * `omb_status` 本身由 `dsh/` 注册（它属 `omb-kernel`，见 `abi/catalog.ts`），
 * 各模块经 `StatusRegistry` 贡献自己的段落。本文件只做两件事：
 * ① 把散落的读数组装成结构化面板（纯函数） ② 渲染成人可读的几行。
 *
 * 组装必须能承受**任何模块缺席**：模块健康缺失、度量桥缺失、台账为空，
 * 都只是少几行，并且**如实写出原因**（"无空降级"）。
 */
import type { ContextPressure, ModuleHealth, StatusContributor } from '../../kernel/abi/index.js'
import type { BandBehavior } from './pressure.js'
import { behaviorFor } from './pressure.js'
import type { PullSnapshot } from './watch.js'
import { cacheHitRate, healthDetail } from './watch.js'

export interface StatusPanelInput {
  /** 全部模块的健康面（来自内核 HealthTable 快照）。 */
  readonly health?: Readonly<Record<string, ModuleHealth>> | null
  /** 当前会话的上下文压力（软信号）。 */
  readonly pressure?: ContextPressure | null
  /** 当前档位行为；缺省由 `pressure.band` 推出。 */
  readonly behavior?: BandBehavior | null
  /** 拉取计数台账快照。 */
  readonly pulls?: PullSnapshot | null
  readonly budgets?: Readonly<Record<string, { readonly used: number; readonly limit: number }>> | null
  /** 本模块自己的降级原因（逐条写出，绝不折叠成"不可用"）。 */
  readonly degradations?: readonly string[] | null
  /** 附加说明，例如"度量桥未注入"。 */
  readonly notes?: readonly string[] | null
}

/** 组装结果。`lines` 是渲染结果，`metrics` 是给机器读的数字。 */
export interface StatusPanel {
  readonly lines: readonly string[]
  readonly metrics: Readonly<Record<string, number>>
  readonly cacheHitRate: number | null
  readonly degradations: readonly string[]
}

/**
 * 组装状态面板。**绝不抛异常**：任何内部失败都退化成一行可读原因
 * （状态面挂掉是最难排查的故障，所以它必须自己还能说话）。
 */
export function buildStatusPanel(input: StatusPanelInput = {}): StatusPanel {
  try {
    // 模块拿不到全局健康面（`Kernel` 没有 health()）：只在调用方给了健康面时才渲染，
    // 否则整段省略——绝不输出"模块健康：0 个"这种假读数。
    const healthGiven = input.health !== undefined && input.health !== null
    const health = input.health ?? {}
    const ids = healthGiven ? Object.keys(health).sort() : []
    const problems: string[] = []
    let ok = 0
    let degraded = 0
    let failed = 0
    for (const id of ids) {
      const entry = health[id]
      const state = entry?.state ?? 'ok'
      if (state === 'failed') failed += 1
      else if (state === 'degraded') degraded += 1
      else ok += 1
      if (state !== 'ok') problems.push(`${id}：${state}——${entry?.detail ?? '（未写明原因）'}`)
    }

    const pressure = input.pressure ?? null
    const behavior = input.behavior ?? behaviorFor(pressure?.band ?? 'relaxed')
    const pulls = input.pulls ?? null
    const degradations = normalizeList(input.degradations)
    const notes = normalizeList(input.notes)

    const lines: string[] = []
    if (healthGiven) {
      lines.push(`模块健康：${ids.length} 个（正常 ${ok} / 降级 ${degraded} / 失败 ${failed}）`)
      for (const problem of problems) lines.push(`  - ${problem}`)
    }

    if (pressure === null) {
      lines.push('压力读数：不可用（度量桥未注入或宿主未声明窗口）——按宽松档处理，不施压、不臆断。')
    } else {
      const ratio = pressure.fillRatio === null || pressure.fillRatio === undefined
        ? '未知（宿主未声明窗口）'
        : pressure.fillRatio.toFixed(3)
      lines.push(`压力档位：${pressure.band}（fillRatio ${ratio}，总 ${pressure.totalTokens} token）`)
    }
    lines.push(
      `档位行为：${behavior.mode}，最多推 ${behavior.pushLimit} 条${behavior.indexOnly ? '，只保留索引' : ''}`
      + `${behavior.pushAllowed ? '' : '，不做主动推'}；被推迟的内容仍可通过工具取回（无静默丢失）。`,
    )

    const hit = cacheHitRate(pressure)
    lines.push(
      `缓存：读 ${pressure?.cacheReadTokens ?? 0} / 写 ${pressure?.cacheWriteTokens ?? 0}`
      + `，命中率 ${hit === null ? '不可测（无缓存读写）' : hit.toFixed(2)}`,
    )

    const nodes = (pressure?.nodes ?? [])
      .filter(node => node !== null && node !== undefined)
      .slice()
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, 5)
    if (nodes.length > 0) {
      lines.push(`最贵 ${nodes.length} 块：${nodes.map(node => `${node.name}(${node.tokens})`).join('、')}`)
    }

    if (pulls === null) {
      lines.push('拉取台账：无（尚无拉取记录）。')
    } else {
      lines.push(`拉取台账：${healthDetail(pulls)}`)
      // 口径必须写清：这个数是谁的、分母是什么。
      if (pulls.session === null) {
        lines.push('  口径：拿不到本会话标识——这些计数落在"未知会话"桶，不并入任何具体会话')
      } else if (!pulls.turnsKnown) {
        lines.push(`  口径：本会话回合数未知（本会话内未观察到回合边界）——pullsPerTurn 分母未知，判定需 ${pulls.minTurns} 轮`)
      }
      // **零拉取视图列表同样要过判定门槛**：刚开的新会话里五个视图必然全是 0，
      // 那不是"该删"，是"还没样本"。轮数不足时只写"不下结论"，不给列表。
      //
      // **但字段本身必须出现**。原先"为空就不渲染"的写法会让读者无法分辨
      // "这项没有可删的"与"这项根本没被统计"——自检报告正是这么记的：
      // 「返回里没有『零拉取视图』字段」。**空集与缺字段是两件事，状态面必须能分开。**
      const silent = pulls.settled ? pulls.views.filter(view => view.pulls === 0).map(view => view.view) : []
      if (silent.length > 0) {
        lines.push(`  零拉取视图：${silent.join('、')}（持续为零即按杀死判据删除）`)
      } else if (pulls.settled) {
        lines.push('  零拉取视图：（无——本会话已达到判定轮数，登记的视图都有拉取记录）')
      } else {
        lines.push(`  零拉取视图：（暂不判定——本会话尚未达到 ${pulls.minTurns} 轮，现在下"该删"的结论会把"没样本"当成"没人用"）`)
      }
    }

    const budgetKeys = Object.keys(input.budgets ?? {}).sort()
    if (budgetKeys.length > 0) {
      const rendered = budgetKeys.map(key => {
        const slot = input.budgets?.[key]
        return slot === undefined ? key : `${key} ${slot.used}/${slot.limit}`
      })
      lines.push(`预算：${rendered.join('、')}`)
    }

    lines.push(degradations.length > 0 ? `降级原因：${degradations.join('；')}` : '降级原因：无')
    for (const note of notes) lines.push(`说明：${note}`)

    const metrics: Record<string, number> = {
      totalTokens: numberOr(pressure?.totalTokens, 0),
      cacheReadTokens: numberOr(pressure?.cacheReadTokens, 0),
      cacheWriteTokens: numberOr(pressure?.cacheWriteTokens, 0),
      pushLimit: behavior.pushLimit,
      degradations: degradations.length,
    }
    if (healthGiven) {
      metrics.modules = ids.length
      metrics.modulesOk = ok
      metrics.modulesDegraded = degraded
      metrics.modulesFailed = failed
    }
    if (typeof pressure?.fillRatio === 'number' && Number.isFinite(pressure.fillRatio)) {
      metrics.fillRatio = pressure.fillRatio
    }
    if (hit !== null) metrics.cacheHitRate = hit
    if (pulls !== null) {
      metrics.pullTurns = pulls.turns
      // 0/1：`pullTurns` 为 0 时它区分"本会话真的一轮都没有"与"轮数未知（分母未知）"
      metrics.pullTurnsKnown = pulls.turnsKnown ? 1 : 0
      metrics.pullSessionKnown = pulls.session === null ? 0 : 1
      metrics.totalPulls = pulls.totalPulls
      metrics.pullsPerTurn = pulls.pullsPerTurn
      metrics.deadViews = pulls.deadViews.length
    }

    return { lines, metrics, cacheHitRate: hit, degradations }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      lines: [`状态面组装失败（已隔离）：${message}`],
      metrics: { renderError: 1 },
      cacheHitRate: null,
      degradations: [`状态面组装失败：${message}`],
    }
  }
}

/** 渲染组装结果。纯投影，不做二次计算。 */
export function renderStatusPanel(panel: StatusPanel): string {
  return panel.lines.join('\n')
}

/**
 * 造一个 `StatusContributor`（注册进 `StatusRegistry`）。
 *
 * `read` 允许抛异常——`render`/`metrics` 都兜住，因为登记处的调用方
 * 不该为某个模块的内部故障付出整份状态面的代价。
 */
export function createStatusContributor(
  read: () => StatusPanelInput,
  name = '上下文优化（omb-context）',
): StatusContributor {
  return {
    name,
    render: (): string => {
      try {
        return renderStatusPanel(buildStatusPanel(read()))
      } catch (error) {
        return `渲染失败（已隔离）：${error instanceof Error ? error.message : String(error)}`
      }
    },
    metrics: (): Readonly<Record<string, number>> => {
      try {
        return buildStatusPanel(read()).metrics
      } catch {
        return { renderError: 1 }
      }
    },
  }
}

function normalizeList(value: readonly string[] | null | undefined): readonly string[] {
  if (!Array.isArray(value)) return []
  return value.filter(item => typeof item === 'string' && item.trim() !== '')
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}
