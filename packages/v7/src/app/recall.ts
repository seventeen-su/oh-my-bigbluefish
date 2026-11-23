import type { Category, StateStatus } from '../domain/entity.js'
import { err, ok, type Result } from '../domain/errors.js'
import type { RecallEngine } from '../retrieval/engine.js'
import type { RecallRequest, RecallResult, RecallScenario } from '../retrieval/types.js'
import type { RuntimeContext } from '../ports/context.js'
import type { DynamicService } from './dynamic.js'

export interface RecallToolInput {
  readonly query: string
  readonly scope?: 'global' | 'project'
  readonly category?: Category
  readonly status?: readonly StateStatus[]
  readonly includeArchived?: boolean
  readonly includeHistory?: boolean
  readonly expand?: 'none' | 'links' | 'chain' | 'both'
  readonly hops?: 1 | 2
  readonly limit?: number
  readonly timeFrom?: string
  readonly timeTo?: string
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
  return lines.join('\n')
}

export function formatRecall(result: RecallResult): string {
  if (result.hits.length === 0) {
    const reason = result.emptyReason
    const channels = result.channels.map(channel => `${channel.channel}:${channel.status}`).join(', ')
    return `未命中（trace ${result.traceId}）：${reason?.message ?? '没有通过门控的结果'}；通道=${channels}`
  }
  const header = `命中 ${result.hits.length} 条（trace ${result.traceId}，场景 ${result.scenario}，扩展种子 ${result.expansion.seeds}）`
  const body = result.hits.map((hit, index) => formatHit(index, hit)).join('\n')
  const warnings = result.warnings.length > 0 ? `\n注意：${result.warnings.join('；')}` : ''
  return `${header}\n${body}${warnings}`
}

export interface RecallInjection {
  readonly sessionId: string
  readonly traceId: string
  readonly hits: readonly { readonly id: string; readonly title?: string }[]
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
      ...(input.hops !== undefined ? { hops: input.hops } : {}),
      ...(input.expand !== undefined ? { expand: input.expand } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
      ...(timeWindow !== undefined ? { timeWindow } : {}),
      ...(context.sessionId !== undefined ? { sessionId: context.sessionId } : {}),
      injected: false,
    }
    try {
      const result = await this.engine.recall(request)
      if (this.dynamic !== undefined && result.hits.length > 0) {
        await Promise.all(result.hits.slice(0, 5).map(hit =>
          this.dynamic!.refreshById(hit.entityId, {
            ...(projectKey !== undefined ? { projectRoot: projectKey } : {}),
            caller: context.sessionId,
            max: 2,
          }).catch(() => undefined),
        ))
      }
      this.onRecall?.({
        sessionId: context.sessionId,
        traceId: result.traceId,
        hits: result.hits.map(hit => ({ id: hit.entityId, ...(hit.title !== undefined ? { title: hit.title } : {}) })),
      })
      return ok(formatRecall(result))
    } catch (error) {
      return err({ code: 'internal', message: error instanceof Error ? error.message : String(error) })
    }
  }
}
