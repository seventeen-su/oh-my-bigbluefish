import type { Category, StateStatus } from '../domain/entity.js'
import { err, ok, type Result } from '../domain/errors.js'
import { LIFECYCLE_LABELS } from '../domain/lifecycle.js'
import type { RecallEngine } from '../retrieval/engine.js'
import type { RecallHit, RecallRequest, RecallResult, RecallScenario } from '../retrieval/types.js'
import type { RuntimeContext } from '../ports/context.js'
import type { DynamicService } from './dynamic.js'

export interface RecallToolInput {
  readonly query: string
  readonly scope?: 'global' | 'project'
  readonly category?: Category
  readonly status?: readonly StateStatus[]
  readonly includeArchived?: boolean
  readonly includeHistory?: boolean
  /** 历史检索：允许被取代/被证伪的旧事实进入结果（带生命周期标记）。 */
  readonly includeSuperseded?: boolean
  readonly expand?: 'none' | 'links' | 'chain' | 'both'
  readonly hops?: 1 | 2
  readonly limit?: number
  readonly timeFrom?: string
  readonly timeTo?: string
}

/**
 * 历史命中的标记：旧事实可以检索出来，但必须清楚说明「已于某时被谁取代」或「已被证伪」，
 * 不能让它看起来还是当前有效。
 */
function lifecycleNote(hit: RecallHit): string | undefined {
  if (hit.lifecycle === 'active') return undefined
  const parts = [LIFECYCLE_LABELS[hit.lifecycle]]
  if (hit.lifecycle === 'superseded') {
    if (hit.supersededAt !== undefined) {
      parts.push(`已于 ${hit.supersededAt} 被 ${hit.supersededBy ?? '未知条目'} 取代`)
    }
  } else if (hit.lifecycle === 'retracted' && hit.retractedAt !== undefined) {
    parts.push(`已于 ${hit.retractedAt} 证伪`)
  }
  if (hit.validFrom !== undefined || hit.validTo !== undefined) {
    parts.push(`有效期 ${hit.validFrom ?? '未知'} ~ ${hit.validTo ?? '现在'}`)
  }
  return parts.join('；')
}

function formatHit(index: number, hit: RecallResult['hits'][number]): string {
  const label = [hit.category, hit.status].filter(value => value !== undefined).join('/')
  const head = hit.title !== undefined && hit.title.length > 0 ? hit.title : hit.snippet
  const lines = [`${index + 1}. ${label.length > 0 ? `[${label}] ` : ''}${head}（${hit.entityId}）`]
  if (hit.snippet.length > 0 && hit.snippet !== head) lines.push(`   ${hit.snippet}`)
  lines.push(`   通道：${hit.channels.join(', ')}；分数：${hit.score.toFixed(3)}`)
  if (hit.why.length > 0) lines.push(`   依据：${hit.why.slice(0, 4).join('；')}`)
  if (hit.chainSiblings.length > 0) lines.push(`   同组：${hit.chainSiblings.join('、')}`)
  if (hit.historyCount > 0) lines.push(`   历史：${hit.historyCount} 个版本`)
  const note = lifecycleNote(hit)
  if (note !== undefined) lines.push(`   生命周期：${note}（历史证据，不是当前有效）`)
  return lines.join('\n')
}

export function formatRecall(result: RecallResult, extraWarnings: readonly string[] = []): string {
  if (result.hits.length === 0) {
    const reason = result.emptyReason
    const channels = result.channels.map(channel => `${channel.channel}:${channel.status}`).join(', ')
    return `未命中（trace ${result.traceId}）：${reason?.message ?? '没有通过门控的结果'}；通道=${channels}`
  }
  const header = `命中 ${result.hits.length} 条（trace ${result.traceId}，场景 ${result.scenario}，扩展种子 ${result.expansion.seeds}）`
  const body = result.hits.map((hit, index) => formatHit(index, hit)).join('\n')
  const warnings = [...result.warnings, ...extraWarnings]
  const warningText = warnings.length > 0 ? `\n注意：${warnings.join('；')}` : ''
  const historical = result.hits.some(hit => hit.lifecycle !== 'active')
    ? '\n含历史条目：标注「已被取代/已被证伪」的条目只作旧事实证据，不能当作当前有效。'
    : ''
  return `${header}\n${body}${historical}${warningText}`
}

export interface RecallInjection {
  readonly sessionId: string
  readonly traceId: string
  readonly hits: readonly { readonly id: string; readonly title?: string; readonly updatedAt?: string }[]
}

const LAST_TIME_QUERY = /(?:上次|上回|之前|以前|原来|早先|先前|去年|last\s+time|previously|earlier|used\s+to)/i

/** T2/T1 的确定性场景选择：用户提到“上次/之前”时切到 last-time 放宽时间窗。 */
export function recallScenarioForQuery(query: string): RecallScenario {
  return LAST_TIME_QUERY.test(query) ? 'last-time' : 'manual'
}

export class RecallService {
  constructor(
    private readonly engine: RecallEngine,
    private readonly dynamic?: DynamicService,
    private readonly onRecall?: (injection: RecallInjection) => void,
  ) {}

  async recall(input: RecallToolInput, context: RuntimeContext): Promise<Result<string>> {
    if (input.query.trim().length === 0) return err({ code: 'invalid-input', message: 'query 不能为空' })
    const projectKey = context.projectKey ?? context.cwd
    // path-guard 根是工作区路径，不是 projectId；没有 identity（旧调用/旧测试）时
    // 退回旧语义——那时 projectKey 就是 git root 路径。
    const projectRoot = context.projectIdentity?.projectRoot
      ?? (context.projectIdentity === undefined ? projectKey : undefined)
    if (input.scope !== 'global' && projectKey === undefined) {
      return err({ code: 'invalid-input', message: '缺少项目作用域（session cwd）' })
    }
    const timeWindow = input.timeFrom !== undefined || input.timeTo !== undefined
      ? {
          from: input.timeFrom ?? '1970-01-01T00:00:00.000Z',
          to: input.timeTo ?? new Date().toISOString(),
        }
      : undefined
    const request: RecallRequest = {
      query: input.query,
      scenario: recallScenarioForQuery(input.query),
      ...(input.scope !== undefined ? { scope: input.scope } : {}),
      ...(projectKey !== undefined ? { projectKey } : {}),
      ...(input.category !== undefined ? { category: input.category } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.includeArchived !== undefined ? { includeArchived: input.includeArchived } : {}),
      ...(input.includeHistory !== undefined ? { includeHistory: input.includeHistory } : {}),
      // 显式时间窗就是历史问题（“去年/上次迁移之前”）：默认放开旧事实，但仍带生命周期标记。
      // 显式 includeSuperseded 优先，不受时间窗隐含默认影响。
      ...(input.includeSuperseded !== undefined
        ? { includeSuperseded: input.includeSuperseded }
        : timeWindow !== undefined
          ? { includeSuperseded: true }
          : {}),
      ...(input.hops !== undefined ? { hops: input.hops } : {}),
      ...(input.expand !== undefined ? { expand: input.expand } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
      ...(timeWindow !== undefined ? { timeWindow } : {}),
      ...(context.sessionId !== undefined ? { sessionId: context.sessionId } : {}),
      // T2 的格式化结果会作为工具结果回到模型上下文，属于“真正投递”；
      // 与 T1 的延迟投递不同，这里没有额外 gate，检索成功即算 Retrieved。
      injected: true,
    }
    try {
      const result = await this.engine.recall(request)
      const dependencyWarnings = new Set<string>()
      if (this.dynamic !== undefined && result.hits.length > 0) {
        await Promise.all(result.hits.slice(0, 5).map(async hit => {
          const refreshed = await this.dynamic!.refreshById(hit.entityId, {
            ...(projectRoot !== undefined ? { projectRoot } : {}),
            caller: context.sessionId,
            max: 2,
          }).catch(() => undefined)
          if (refreshed === undefined) return
          for (const attribute of refreshed.attributes) {
            if (attribute.value.kind !== 'dynamic' || attribute.value.staleReason === undefined) continue
            // 依赖失效且本轮没刷新成功：结果里显式标 stale，不把旧缓存当成当前值。
            dependencyWarnings.add(`依赖失效待刷新 ${hit.entityId}.${attribute.name}（${attribute.value.staleReason}）`)
          }
        }))
      }
      this.onRecall?.({
        sessionId: context.sessionId,
        traceId: result.traceId,
        hits: result.hits.map(hit => ({
          id: hit.entityId,
          ...(hit.title !== undefined ? { title: hit.title } : {}),
          updatedAt: hit.updatedAt,
        })),
      })
      return ok(formatRecall(result, [...dependencyWarnings].sort()))
    } catch (error) {
      return err({ code: 'internal', message: error instanceof Error ? error.message : String(error) })
    }
  }
}
