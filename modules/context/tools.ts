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
import type { ContextPressure, ModuleHealth, PressureBand, SessionRef, StatusContributor } from '../../kernel/abi/index.js'
import type { BandBehavior } from './pressure.js'
import { behaviorFor } from './pressure.js'
import type { PullSnapshot } from './watch.js'
import { cacheHitRate, healthDetail } from './watch.js'

/**
 * 「注入裁决当前无调用方」的**如实标注**（规划 §4 S3-d）。
 *
 * 全仓 grep 的事实：`SERVICES.contextPressure` 零生产消费者；`SERVICES.contextMetrics`
 * 的生产消费者只有 `dsh/session.ts` 的 `recordPull` 一处——`select` / `marginalValue` /
 * `measuredCost` / `snapshot` / `killList` / `views` / `focusState` 都没有生产调用方，
 * `BandBehavior.announcePressure` 更是只被测试读过。
 *
 * 因此状态面必须把话说全：**"档位行为"描述的是"接上后会怎样"，不是正在发生的行为**。
 * 不写这一句，读者（与模型）会把 `最多推 1 条` 当成真的在推——
 * 这是"声明了但电不会来"的典型形态，而状态面是唯一的模型可见诊断入口。
 *
 * 接上真实消费者之后，这句话就不再成立，**必须同时删掉**（见规划 §4 S3-d 的"缓做"）。
 */
export const INJECTION_UNWIRED_NOTE =
  '注入裁决：当前无调用方（select / marginalValue / measuredCost / pushLimit / indexOnly / announcePressure '
  + '在生产代码里零消费者，只有测试与手动调用；在线的是拉取计数 recordPull）'
  + '——上面这句是"接上后会怎样"，不是正在发生的行为。'

export interface StatusPanelInput {
  /** 全部模块的健康面（来自内核 HealthTable 快照）。 */
  readonly health?: Readonly<Record<string, ModuleHealth>> | null
  /** 当前会话的上下文压力（软信号）。 */
  readonly pressure?: ContextPressure | null
  /** 当前档位行为；缺省由 `pressure.band` 推出。 */
  readonly behavior?: BandBehavior | null
  /** 拉取计数台账快照。 */
  readonly pulls?: PullSnapshot | null
  /**
   * **各会话**的台账快照（含"未知会话"桶）。
   *
   * 为什么要有它：会话归属只认"这次是谁"，没有"当前会话"可挑。若只渲染一份
   * `pulls`，读者无法判断那个数是哪个会话的——而那正是被投诉过的"这个数是谁的"。
   */
  readonly sessions?: readonly {
    readonly session: SessionRef | null
    /** 该会话的压力档位（有读数时）；没有就省略——**不借用别人的读数**。 */
    readonly band?: string
    readonly pulls: PullSnapshot
  }[] | null
  /**
   * `sessions` 的**截断口径**：{@link SESSIONS_LIST_MAX} 只控制"列几个"，
   * 分会话表本身另有 LRU 上界（`SESSION_TABLE_MAX`）。省略/为 null = 不说明
   * （老调用方与纯组装场景），不伪造一个"没有截断"的结论。
   */
  readonly sessionsScope?: {
    /** 实际列出的会话数。 */
    readonly listed: number
    /** 仍在内存表里、但这次没列出来的会话数。 */
    readonly hidden: number
    /** 被 LRU 淘汰掉的会话数（**计数已不再保留**）。 */
    readonly evicted: number
    /** 分会话表的 LRU 上界。 */
    readonly tableMax: number
  } | null
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
      + `${behavior.pushAllowed ? '' : '，不做主动推'}；被推迟的内容仍可通过工具取回（无静默丢失）。`
      + INJECTION_UNWIRED_NOTE,
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
      // **分子口径也要自报**（healthDetail 里已带一句，这里给出它的推算方式）：
      // 头条只算登记的拉取式视图，而下面的明细里还有 read/pwsh 这类非视图工具——
      // 两者混在一起就是"1.27 次/轮 与 五个视图全待删 同屏"那类矛盾。
      lines.push(
        pulls.scopedToViews
          ? `  口径：头条的 ${pulls.totalPulls} 次只计 ${pulls.countedViews} 个拉取式视图的调用；`
            + 'read/pwsh 等非视图工具的调用仍列在下面的明细里，但不进这个分子'
          : `  口径：头条计的是台账里出现过的全部工具名（${pulls.countedViews} 个）——没有视图清单时无法把"该删的视图"与"别的工具"分开`,
      )
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

    // **分会话列账**：没有"当前会话"可挑，就把每个会话各自一行摆出来——
    // 读者因此永远知道"这个数是哪个会话的"（未知会话桶也单列，不并进任何一行）。
    //
    // **档位必须连塑形后果一起写**：只说"压力 tight"读者不知道行为会怎么变。
    // 顶层的"档位行为"行是**无会话口径**（拿不到会话=（relaxed, none）），
    // 不能代表任何具体会话的塑形——所以后果必须落在**该会话这一行**上。
    const sessions = input.sessions ?? null
    if (sessions !== null && sessions.length > 0) {
      lines.push('分会话拉取台账（每行一个会话，互不合并）：')
      for (const entry of sessions) {
        const who = entry.session === null ? '未知会话' : entry.session
        // 没有该会话的读数就**不写档位**（`band` 缺席）：不借用别人的档位
        const shaping = entry.band === undefined ? '' : `压力 ${entry.band}（${shapingOf(entry.band)}）｜`
        lines.push(`  - ${who}：${shaping}${healthDetail(entry.pulls)}`)
      }
      // **截断要说出来**：读者必须能分清"只有这几个会话"与"只列了这几个"。
      // 分会话表本身另有 LRU 上界，被淘汰的连计数都不在了——那也要点名。
      const scope = input.sessionsScope ?? null
      if (scope !== null && (scope.hidden > 0 || scope.evicted > 0)) {
        lines.push(
          `  截断口径：本段只列最近 ${scope.listed} 个会话（另有 ${scope.hidden} 个未列出）`
          + `；分会话表按最近活动保留最多 ${scope.tableMax} 个`
          + (scope.evicted > 0 ? `，已淘汰 ${scope.evicted} 个更早的会话（其计数不再保留）` : '')
          + '。',
        )
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
      // 分子口径也进机器可读面：`pullCountedViews` 与 `deadViews` 的判定集合同源
      metrics.pullCountedViews = pulls.countedViews
      metrics.pullScopedToViews = pulls.scopedToViews ? 1 : 0
    }
    // 截断口径进机器可读面（未提供 `sessionsScope` 时这些键不出现 = "未测量"）
    const sessionsScope = input.sessionsScope ?? null
    if (sessionsScope !== null) {
      metrics.sessionsListed = sessionsScope.listed
      metrics.sessionsHidden = sessionsScope.hidden
      metrics.sessionsEvicted = sessionsScope.evicted
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
 * 档位 → 一句**塑形后果**（进状态面的分会话行）。
 *
 * 状态面只说"压力 tight"是不够的：读者要知道这个档位**会怎么改变行为**。
 * 未知档位由 `behaviorFor` 回落 relaxed（纯函数不抛），因此这里不会抛。
 */
export function shapingOf(band: PressureBand | string): string {
  const behavior = behaviorFor(band as PressureBand)
  if (behavior.indexOnly) return '只保留索引'
  if (behavior.pushLimit > 0) return `最多推 ${behavior.pushLimit} 条`
  return '不做主动推'
}

/**
 * 带**可选会话形参**的状态贡献者。
 *
 * `StatusContributor` 在 ABI 里是 `render(): string`（`kernel/abi/catalog.ts:372-379`），
 * 而"少形参"的实现天然满足"多一个**可选**形参"的签名，所以状态面
 * （`dsh/status-tool.ts` 的 `SessionAwareContributor`）能在**不改 ABI、不动内核登记处**
 * 的前提下把"这次是谁"交给需要它的段落。这里把那个约定写成类型：
 * 上下文段的压力读数与顶层「## 上下文」必须来自**同一个会话**，会话因此必须能传进来。
 */
export interface SessionAwareStatusContributor extends StatusContributor {
  render(session?: SessionRef): string
  /** 机器可读面收同一个会话——两处不许各读各的（否则就是"两个面互相矛盾"）。 */
  metrics?(session?: SessionRef): Readonly<Record<string, number>>
}

/**
 * 造一个 `StatusContributor`（注册进 `StatusRegistry`）。
 *
 * ## 为什么 `read` 必须能收到**这一次**的会话
 *
 * 它曾经是 `() => StatusPanelInput`：状态面（`dsh/status-tool.ts`）把本次会话作为
 * `render` 的第一个实参传进来，而 `read` 接不住它，于是会话被**吞掉**——上下文模块
 * 只好自己重造一份贡献者（`modules/context/index.ts` 的 `statusContributor`），
 * 本函数则沦为"仍导出、仍被测试覆盖、没有生产调用方"的僵尸接缝。
 *
 * 吞掉会话的代价不是"少一个参数"：会话是段落与顶层读数一致的**唯一来源**，
 * 丢了它就退回实测过的那次矛盾——顶层 `moderate / 0.343`，模块段
 * `relaxed（fillRatio 未知）`。读者无从判断该信哪个，而本模块的塑形
 * （`pushLimit` / `indexOnly`）按 relaxed 走，"紧张就少说"等于没生效。
 *
 * 拿不到会话时交 `undefined`（= 真的没有会话）：模块据此走"未测量"，
 * **不借用任何别的会话的读数**（见 `modules/context/index.ts` 的 `resolveSession`）。
 *
 * `read` 允许抛异常——`render`/`metrics` 都兜住，因为登记处的调用方
 * 不该为某个模块的内部故障付出整份状态面的代价。
 *
 * @param read 组装入口；**必须把会话原样用上**（形参可省，旧调用方不破）。
 */
export function createStatusContributor(
  read: (session?: SessionRef) => StatusPanelInput,
  name = '上下文优化（omb-context）',
): SessionAwareStatusContributor {
  return {
    name,
    render: (session?: SessionRef): string => {
      try {
        return renderStatusPanel(buildStatusPanel(read(session)))
      } catch (error) {
        return `渲染失败（已隔离）：${error instanceof Error ? error.message : String(error)}`
      }
    },
    metrics: (session?: SessionRef): Readonly<Record<string, number>> => {
      try {
        return buildStatusPanel(read(session)).metrics
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
