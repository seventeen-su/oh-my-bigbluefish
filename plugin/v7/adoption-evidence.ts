/**
 * 采用证据的纯判定层：Exposure / Reference / Utilization / Validation / Refutation。
 *
 * 本模块不读宿主、不查库、不写会话态：
 * - `findReferences`：明确引用（标题/ID）→ Reference 候选，弱证据；
 * - `toolCallExplicitReferences`：完整 entity ID 进入工具参数 → Utilization 候选；
 * - `userConfirmationReferences`：人类用户在确认句里引用 → Validation 候选；
 * - `userRefutationReferences`：人类用户在否定句里引用 → Refutation 候选；
 * - `receiptVisibleHits`：只保留 receipt 里 kept 且未隔离的命中，作为采用候选；
 * - `evidenceFromSessionEvent`：把 DSH 事件归一化，并附带任务边界（goal/team task）。
 *
 * 采用候选只能来自真实注入的 T0/T1/T2 receipt：被隔离（原文未进入提示）或未展示
 * （预算/去重丢弃）的命中不能升采用，伪造 recall_event 也不能。
 *
 * 模型自述“我用了/验证成功”永远不产生 Validation；字符串匹配最多到 Reference/
 * Utilization，不能直接决定长期遗忘或强采用。
 */
import { asRecord } from '../../packages/v7/src/adapters/dsh/host.js'
import { entityReceiptsOf } from '../../packages/v7/src/app/adoption.js'
import { contentText, eventText } from './messages.js'
import { toolFailed } from './t1.js'

/** 一条被注入过、可以被引用/使用的命中；updatedAt 用于识别“引用时已过期”。 */
export interface AdoptionHit {
  readonly id: string
  readonly title?: string
  readonly updatedAt?: string
}

export type ReferenceKind = 'entity-id' | 'title'

/** 与装配器 `InjectionReceipt` 结构解耦的可见性输入。 */
export interface ReceiptVisibility {
  readonly keptIds: readonly string[]
  readonly quarantinedIds?: readonly string[]
}

/**
 * 只保留 receipt 判定为真正展示的命中。
 *
 * 首选 `entities`（逐实体 receipt）：只有 `state='kept'` 才可见；quarantined 与没有
 * 条目的未展示实体都排除。旧 receipt 没有 `entities` 时才退回块级 keptIds 交集。
 * `receipt` 缺省表示调用点没有装配器 receipt（T0 notice 走 build 结果的可见命中）。
 */
export function receiptVisibleHits<T extends AdoptionHit>(
  hits: readonly T[],
  receipt: ReceiptVisibility | undefined,
): T[] {
  if (receipt === undefined) return [...hits]
  const entities = entityReceiptsOf(receipt)
  if (entities !== undefined) {
    const kept = new Set(entities.filter(entity => entity.state === 'kept').map(entity => entity.entityId))
    return hits.filter(hit => kept.has(hit.id))
  }
  const kept = new Set(receipt.keptIds)
  const quarantined = new Set(receipt.quarantinedIds ?? [])
  return hits.filter(hit => kept.has(hit.id) && !quarantined.has(hit.id))
}

export interface HitReference {
  readonly hit: AdoptionHit
  readonly kind: ReferenceKind
}

export type EvidenceKind =
  | 'assistant-text'
  | 'tool-call'
  | 'tool-result'
  | 'user-message'
  | 'task-completed'
  | 'task-state'

/** 任务边界状态：active 建立/切换当前任务，cleared 清空，completed 用于验证。 */
export type TaskStatus = 'active' | 'completed' | 'cleared'

/** 从 DSH session/event 归一化后的一条采用证据。 */
export interface SessionEvidence {
  readonly kind: EvidenceKind
  /** 用于引用匹配的文本（消息正文、工具参数、任务描述…），不含事件元数据。 */
  readonly text: string
  /** tool/call 与 tool/result 的配对键；只有同一次调用才能升级。 */
  readonly callId?: string
  readonly toolName?: string
  /** tool/result 是否成功；失败/错误文本一律不算正向贡献。 */
  readonly success?: boolean
  /** 任务边界：`goal:<id>` / `team:<id>`；缺省表示该会话没有可追踪任务。 */
  readonly taskId?: string
  readonly taskStatus?: TaskStatus
  /** task-completed 时的验证种类；tool-result 的 test-pass 由调用方判定。 */
  readonly validationKind?: 'goal-complete' | 'task-complete'
  /** 原始事件类型，写进 validation_evidence 便于审计。 */
  readonly eventType?: string
}

/** 标题至少 4 个字符才参与弱引用，避免“日志”“配置”这类短词到处命中。 */
const MIN_TITLE_LENGTH = 4
const ASCII_WORD = /[A-Za-z0-9_.-]/

function isAsciiWord(char: string | undefined): boolean {
  return char !== undefined && ASCII_WORD.test(char)
}

/** 完整实体 ID 的边界匹配：`mem_...` 出现在更长的标识符里不算引用。 */
function containsEntityId(text: string, id: string): boolean {
  if (id.length === 0) return false
  let from = 0
  while (from <= text.length - id.length) {
    const index = text.indexOf(id, from)
    if (index < 0) return false
    if (!isAsciiWord(index === 0 ? undefined : text[index - 1])
      && !isAsciiWord(text[index + id.length])) return true
    from = index + 1
  }
  return false
}

/**
 * 标题匹配：
 * - 纯 ASCII 标题按 token 边界匹配，`config` 不会命中 `config.json` 或 `myconfig`；
 * - 中文/含标点的标题按精确子串匹配（中文没有天然空格边界，逐字边界反而会漏引用）。
 */
function containsTitle(text: string, title: string): boolean {
  const needle = title.trim()
  if (needle.length < MIN_TITLE_LENGTH) return false
  if (!/^[\x20-\x7e]+$/.test(needle)) return text.includes(needle)
  let from = 0
  while (from <= text.length - needle.length) {
    const index = text.indexOf(needle, from)
    if (index < 0) return false
    if (!isAsciiWord(index === 0 ? undefined : text[index - 1])
      && !isAsciiWord(text[index + needle.length])) return true
    from = index + 1
  }
  return false
}

/** 在文本里找命中引用；entity id 优先于标题，同一命中只返回最强的一种。 */
export function findReferences(text: string, hits: readonly AdoptionHit[]): HitReference[] {
  if (text.trim().length === 0) return []
  const references: HitReference[] = []
  const seen = new Set<string>()
  for (const hit of hits) {
    if (seen.has(hit.id)) continue
    if (containsEntityId(text, hit.id)) {
      references.push({ hit, kind: 'entity-id' })
      seen.add(hit.id)
      continue
    }
    if (hit.title !== undefined && containsTitle(text, hit.title)) {
      references.push({ hit, kind: 'title' })
      seen.add(hit.id)
    }
  }
  return references
}

/**
 * 工具使用：只认完整 entity id。标题出现在工具参数里很可能是路径/文件名巧合，
 * 因此不进入 Utilization（更不会进入 Validation）。
 */
export function toolCallExplicitReferences(argumentsText: string, hits: readonly AdoptionHit[]): HitReference[] {
  if (argumentsText.trim().length === 0) return []
  return hits
    .filter(hit => containsEntityId(argumentsText, hit.id))
    .map(hit => ({ hit, kind: 'entity-id' as const }))
}

/** 工具成功：宿主明确未报错，且结果文本没有失败特征（宁可少验证，不可误验证）。 */
export function toolResultSucceeded(isError: boolean, resultText: string): boolean {
  return !toolFailed(isError, resultText)
}

/**
 * 验证类工具：测试/类型检查/构建/lint 通过才能作为 Validation 的外部证据。
 * 普通工具成功最多说明“使用发生了”，不等于记忆被验证。
 */
const VERIFICATION_COMMAND = /(?:^|[\s;&|])(?:pnpm|npm|yarn|npx)\s+(?:(?:run|exec)\s+)?[\w:.-]*(?:test|vitest|jest|pytest|typecheck|lint|build|check)[\w:.-]*(?=$|[\s;&|])/i
export function isVerificationTool(toolName: string | undefined, argumentsText: string): boolean {
  const name = toolName ?? ''
  if (/\b(?:test|vitest|jest|pytest)\b/i.test(name)) return true
  return VERIFICATION_COMMAND.test(`${name} ${argumentsText}`)
}

const CONFIRMATION = /(?:^|[，,。.!！?？；;\s])(?:对|对的|对呀|是的|没错|正确|确认|同意|可以|好的|好|行|就这样|按这个|采用|采纳|就是(?:这个|这样)|ok|okay|yes|correct|confirmed?|sounds\s+good|go\s+ahead)(?=[，,。.!！?？；;\s]|$)/i

/** 否定/证伪词：只在同一句里同时出现记忆引用时成立。 */
const REFUTATION = /(?:不对|错了|不正确|不准确|有误|已经过时|过时了|不再适用|作废|推翻|不是这样|别用|不要用|wrong|incorrect|outdated|no\s+longer|not\s+true)/i

function sentencesOf(text: string, predicate: RegExp): string[] {
  return text
    .split(/[。！？!?\n；;]/)
    .map(sentence => sentence.trim())
    .filter(sentence => sentence.length > 0 && predicate.test(sentence))
}

/** 用户确认句里的引用：只有人类用户消息才调用；模型 assistant 文本不走这里。 */
export function userConfirmationReferences(text: string, hits: readonly AdoptionHit[]): HitReference[] {
  const sentences = sentencesOf(text, CONFIRMATION)
  if (sentences.length === 0) return []
  return findReferences(sentences.join('\n'), hits)
}

/** 用户否定/证伪句里的引用：负向证据，只由人类用户消息触发。 */
export function userRefutationReferences(text: string, hits: readonly AdoptionHit[]): HitReference[] {
  const sentences = sentencesOf(text, REFUTATION)
  if (sentences.length === 0) return []
  return findReferences(sentences.join('\n'), hits)
}

function messageContent(data: Record<string, unknown> | undefined): string {
  return data === undefined ? '' : contentText(data['content'])
}

function recordContent(record: Record<string, unknown> | undefined): string {
  return record === undefined ? '' : contentText(record['content'])
}

function taskSnapshotText(task: Record<string, unknown> | undefined): string {
  if (task === undefined) return ''
  return [task['subject'], task['description']]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .join('\n')
}

/**
 * 把 DSH `session/event` 的 `data` 归一化成采用证据。
 *
 * 只认已知形状；未知事件返回空数组，绝不“看见字符串就记引用”。
 */
export function evidenceFromSessionEvent(type: string, data: unknown): readonly SessionEvidence[] {
  const dataRecord = asRecord(data)
  if (dataRecord === undefined) return []

  if (type === 'assistant/message') {
    // 模型自述：只产生 Reference 候选，永远不在此产生 Validation。
    // DSH 真实事件把消息放在 data.message；测试/简化宿主也允许直接 data.content。
    const message = asRecord(dataRecord['message'])
    const text = message === undefined ? recordContent(dataRecord) : messageContent(message)
    return text.trim().length > 0 ? [{ kind: 'assistant-text', text }] : []
  }

  if (type === 'user/message') {
    const source = asRecord(dataRecord['source'])
    // 只认人类用户；T1 自己注入的 plugin:oh-my-bigbluefish/v7 消息不算确认。
    if (source?.['kind'] !== 'user') return []
    const text = recordContent(dataRecord)
    return text.trim().length > 0 ? [{ kind: 'user-message', text }] : []
  }

  if (type === 'tool/call') {
    const callId = typeof dataRecord['callId'] === 'string' ? dataRecord['callId'] : undefined
    const toolName = typeof dataRecord['name'] === 'string' ? dataRecord['name'] : undefined
    const text = eventText(dataRecord['arguments'])
    return text.trim().length > 0
      ? [{
          kind: 'tool-call',
          text,
          ...(callId === undefined ? {} : { callId }),
          ...(toolName === undefined ? {} : { toolName }),
        }]
      : []
  }

  if (type === 'tool/result') {
    const message = asRecord(dataRecord['message'])
    const source = asRecord(message?.['source'])
    const callId = typeof message?.['toolCallId'] === 'string'
      ? message['toolCallId']
      : typeof source?.['callId'] === 'string'
        ? source['callId']
        : undefined
    const error = asRecord(dataRecord['error'])
    const errorText = [error?.['name'], error?.['code'], error?.['reason']]
      .filter((part): part is string => typeof part === 'string' && part.length > 0)
      .join(' ')
    const text = [contentText(message?.['content']), errorText].filter(part => part.length > 0).join('\n')
    const isError = message?.['isError'] === true || error !== undefined
    return [{
      kind: 'tool-result',
      text,
      success: toolResultSucceeded(isError, text),
      ...(callId === undefined ? {} : { callId }),
      eventType: type,
    }]
  }

  if (type === 'goal/change') {
    const goal = asRecord(dataRecord['goal'])
    const goalId = typeof goal?.['id'] === 'string' ? goal['id'] : undefined
    const taskId = goalId === undefined ? undefined : `goal:${goalId}`
    const completed = dataRecord['operation'] === 'complete' || goal?.['phase'] === 'complete'
    if (completed) {
      const objective = typeof goal?.['objective'] === 'string' ? goal['objective'] : ''
      return objective.trim().length > 0 && taskId !== undefined
        ? [{
            kind: 'task-completed',
            text: objective,
            taskId,
            taskStatus: 'completed',
            validationKind: 'goal-complete',
            eventType: type,
          }]
        : []
    }
    if (dataRecord['operation'] === 'clear') {
      return taskId === undefined
        ? []
        : [{ kind: 'task-state', text: '', taskId, taskStatus: 'cleared', eventType: type }]
    }
    return taskId === undefined
      ? []
      : [{ kind: 'task-state', text: '', taskId, taskStatus: 'active', eventType: type }]
  }

  if (type === 'team/task') {
    const task = asRecord(dataRecord['task'])
    const taskId = typeof task?.['id'] === 'string' ? `team:${task['id']}` : undefined
    if (taskId === undefined) return []
    const status = task?.['status']
    if (status === 'completed') {
      const text = taskSnapshotText(task)
      return text.trim().length > 0
        ? [{
            kind: 'task-completed',
            text,
            taskId,
            taskStatus: 'completed',
            validationKind: 'task-complete',
            eventType: type,
          }]
        : []
    }
    if (status === 'deleted') {
      return [{ kind: 'task-state', text: '', taskId, taskStatus: 'cleared', eventType: type }]
    }
    return [{ kind: 'task-state', text: '', taskId, taskStatus: 'active', eventType: type }]
  }

  return []
}
