import { z } from 'zod'
import type { LinkInput } from '../../domain/link.js'
import type { PatchEntityInput, RawAttributeValue, WriteEntityInput } from '../../domain/entity.js'
import type { Result } from '../../domain/errors.js'
import { MAX_TITLE } from '../../domain/validation.js'
import type { Logger } from '../../ports/jobs.js'
import type { HostContextLike, HostToolDefinition, HostToolsLike, ToolContext } from './host.js'
import { asRecord, readTools, resolveProjectKey, sessionFromExec } from './host.js'

const OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  properties: { ok: { type: 'boolean' }, text: { type: 'string' } },
  required: ['ok', 'text'],
  additionalProperties: false,
})

const JSON_VALUE = z.unknown()

/**
 * 工具参数上限：这些数字同时出现在宿主 JSON Schema 与 zod 校验里，
 * 保证模型看得见约束、超限输入也不会让 zod 逐元素累积 issue。
 */
const MAX_ID_CHARS = 64
const MAX_GROUP_ITEMS = 64
const MAX_STATUS_ITEMS = 32
const MAX_QUERY_CHARS = 4_096
const MAX_TIME_CHARS = 128
const MAX_ORIGIN_CHARS = 512

/** 校验失败摘要上限：最多 3 条 issue、单条 240 字符、整段 1024 字符，禁止把 17MB issue 文本回灌模型。 */
const MAX_ERROR_ISSUES = 3
const MAX_ERROR_ISSUE_CHARS = 240
const MAX_ERROR_CHARS = 1024

const STATUS_VALUES = ['completed', 'in_progress', 'waiting', 'blocked', 'not_started', 'discarded'] as const
const statusValue = z.enum(STATUS_VALUES)
const idText = z.string().min(1).max(MAX_ID_CHARS)

const rememberSchema = z.object({
  kind: z.enum(['memory', 'state', 'chain']).describe('memory=事实/线索/事件；state=状态机；chain=思维链/组'),
  category: z.enum(['fact', 'clue', 'event']).optional(),
  scope: z.enum(['global', 'project']).optional().describe('缺省 project；global 用于跨项目偏好'),
  title: z.string().max(MAX_TITLE).optional(),
  status: statusValue.optional(),
  time: z.string().max(MAX_TIME_CHARS).optional(),
  group: z.array(z.string().max(MAX_ID_CHARS)).max(MAX_GROUP_ITEMS).optional(),
  attrs: z.record(z.string(), JSON_VALUE).optional().describe('可选属性；普通值是静态，{"$dynamic":{...}} 是动态'),
  confidence: z.number().min(0).max(1).optional(),
  pinned: z.boolean().optional(),
  origin: z.string().max(MAX_ORIGIN_CHARS).optional(),
})

const recallSchema = z.object({
  query: z.string().min(1).max(MAX_QUERY_CHARS),
  scope: z.enum(['global', 'project']).optional(),
  category: z.enum(['fact', 'clue', 'event']).optional(),
  status: z.array(statusValue).max(MAX_STATUS_ITEMS).optional(),
  includeArchived: z.boolean().optional(),
  includeHistory: z.boolean().optional(),
  expand: z.enum(['none', 'links', 'chain', 'both']).optional(),
  hops: z.union([z.literal(1), z.literal(2)]).optional(),
  limit: z.number().int().min(1).max(50).optional(),
  timeFrom: z.string().max(MAX_TIME_CHARS).optional(),
  timeTo: z.string().max(MAX_TIME_CHARS).optional(),
})

const updateSchema = z.object({
  id: idText,
  expectedRevision: z.number().int().positive().describe('必须带；从 recall/history 读取，避免覆盖并发修改'),
  attrs: z.record(z.string(), z.union([JSON_VALUE, z.null()])).optional(),
  title: z.string().max(MAX_TITLE).optional(),
  status: statusValue.optional(),
  time: z.string().max(MAX_TIME_CHARS).optional(),
  category: z.enum(['fact', 'clue', 'event']).optional(),
  group: z.array(z.string().max(MAX_ID_CHARS)).max(MAX_GROUP_ITEMS).optional(),
  pinned: z.boolean().optional(),
  confidence: z.number().min(0).max(1).optional(),
})

const linkSchema = z.object({
  from: idText.optional(),
  to: idText.optional(),
  relation: z.string().min(1).max(64).optional(),
  directed: z.boolean().optional(),
  strength: z.number().min(0).max(1).optional(),
  allowArchived: z.boolean().optional(),
  unlinkId: idText.optional(),
}).refine(value => value.unlinkId !== undefined || (value.from !== undefined && value.to !== undefined && value.relation !== undefined), {
  message: '要么给 unlinkId，要么给 from/to/relation',
})

const historySchema = z.object({
  id: idText,
  limit: z.number().int().min(1).max(100).optional(),
})

const adminSchema = z.object({
  action: z.enum(['audit', 'rollback', 'archive', 'unarchive']),
  auditId: z.number().int().positive().optional(),
  targetId: idText.optional(),
  reason: z.string().min(1).max(200).optional(),
  limit: z.number().int().min(1).max(100).optional(),
})

export type RecallToolArgs = z.infer<typeof recallSchema>
export type AdminToolArgs = z.infer<typeof adminSchema>

export interface ToolRuntime {
  context(exec: unknown): Promise<ToolContext | undefined>
  remember(input: WriteEntityInput, context: ToolContext): Promise<Result<string>>
  recall(input: RecallToolArgs, context: ToolContext): Promise<Result<string>>
  update(input: PatchEntityInput, context: ToolContext): Promise<Result<string>>
  link(input: LinkInput, context: ToolContext): Promise<Result<string>>
  unlink(id: string, context: ToolContext): Promise<Result<string>>
  history(id: string, limit: number): Promise<Result<string>>
  status(): Promise<Result<string>>
  admin(input: AdminToolArgs): Promise<Result<string>>
}

function toolParameters(schema: z.ZodType): object {
  const raw = z.toJSONSchema(schema as z.ZodType<unknown>) as Record<string, unknown>
  const copy = { ...raw }
  delete copy['$schema']
  return copy
}

function resultOf(result: Result<string>): { ok: boolean; text: string } {
  return result.ok ? { ok: true, text: result.value } : { ok: false, text: `${result.error.code}: ${result.error.message}` }
}

interface ArrayLimit {
  readonly field: string
  readonly max: number
}

const REMEMBER_ARRAY_LIMITS: readonly ArrayLimit[] = [{ field: 'group', max: MAX_GROUP_ITEMS }]
const RECALL_ARRAY_LIMITS: readonly ArrayLimit[] = [{ field: 'status', max: MAX_STATUS_ITEMS }]
const UPDATE_ARRAY_LIMITS: readonly ArrayLimit[] = [{ field: 'group', max: MAX_GROUP_ITEMS }]

type ParsedArgs<Schema extends z.ZodType> =
  | { readonly ok: true; readonly data: z.output<Schema> }
  | { readonly ok: false; readonly text: string }

/**
 * 解析前长度闸门：超限数组直接拒绝，不进入 zod 的元素循环。
 * 只读 `length`，不复制、不遍历元素，100k 非法元素也不会产生 issue。
 */
function arrayLimitViolation(rawArgs: unknown, limits: readonly ArrayLimit[]): string | undefined {
  const record = asRecord(rawArgs)
  if (record === undefined) return undefined
  for (const limit of limits) {
    const value = record[limit.field]
    if (!Array.isArray(value) || value.length <= limit.max) continue
    return `invalid-input: ${limit.field} 最多 ${limit.max} 项（收到 ${value.length} 项）`
  }
  return undefined
}

/** 摘要化失败：只用 issues 的前几条，绝不读取 `error.message`（它会把全部 issue 序列化回灌）。 */
function summarizeIssues(error: { readonly issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[] }): string {
  const prefix = 'invalid-input: '
  const details: string[] = []
  // 预留“另有 N 个问题”后缀的最长篇幅，保证整段不超过 MAX_ERROR_CHARS。
  let budget = MAX_ERROR_CHARS - prefix.length - 32
  for (const issue of error.issues.slice(0, MAX_ERROR_ISSUES)) {
    const path = issue.path.map(segment => String(segment)).join('.')
    const raw = path.length === 0 ? issue.message : `${path}: ${issue.message}`
    const detail = raw.length > MAX_ERROR_ISSUE_CHARS ? `${raw.slice(0, MAX_ERROR_ISSUE_CHARS)}…` : raw
    const cost = detail.length + (details.length === 0 ? 0 : 1)
    if (cost > budget) break
    details.push(detail)
    budget -= cost
  }
  const hidden = error.issues.length - details.length
  const suffix = hidden > 0 ? `（另有 ${hidden} 个问题）` : ''
  return details.length === 0 ? `${prefix}参数格式不正确${suffix}` : `${prefix}${details.join('；')}${suffix}`
}

function parseToolArgs<Schema extends z.ZodType>(
  schema: Schema,
  rawArgs: unknown,
  limits: readonly ArrayLimit[] = [],
): ParsedArgs<Schema> {
  const violation = arrayLimitViolation(rawArgs, limits)
  if (violation !== undefined) return { ok: false, text: violation }
  const parsed = schema.safeParse(rawArgs)
  if (!parsed.success) return { ok: false, text: summarizeIssues(parsed.error) }
  return { ok: true, data: parsed.data }
}

function projectScope(context: ToolContext, scope: 'global' | 'project' | undefined): { kind: 'global' } | { kind: 'project'; projectKey: string } | undefined {
  if (scope === 'global') return { kind: 'global' }
  const projectKey = context.projectKey ?? context.cwd
  return projectKey === undefined ? undefined : { kind: 'project', projectKey }
}

function buildRemember(input: z.infer<typeof rememberSchema>, context: ToolContext): WriteEntityInput | undefined {
  const scope = projectScope(context, input.scope)
  if (scope === undefined) return undefined
  const attrs = input.attrs as Record<string, RawAttributeValue> | undefined
  const base = {
    scope,
    ...(attrs !== undefined ? { attrs } : {}),
    ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
    ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
    ...(input.origin !== undefined ? { origin: input.origin } : {}),
  }
  if (input.kind === 'memory') {
    if (input.category === undefined) return undefined
    return { ...base, kind: 'memory', category: input.category }
  }
  if (input.kind === 'state') {
    if (input.title === undefined || input.status === undefined || input.time === undefined) return undefined
    return { ...base, kind: 'state', title: input.title, status: input.status, time: input.time }
  }
  if (input.title === undefined || input.group === undefined || input.group.length === 0) return undefined
  return { ...base, kind: 'chain', title: input.title, group: input.group }
}

export function createToolDefinitions(runtime: ToolRuntime): HostToolDefinition[] {
  const definitions: HostToolDefinition[] = []

  const add = (
    name: string,
    description: string,
    parameters: object,
    execute: (args: unknown, exec: unknown) => Promise<{ ok: boolean; text: string }>,
  ): void => {
    definitions.push({
      name,
      description,
      parameters,
      output: {
        schema: OUTPUT_SCHEMA,
        render: (_args, value) => {
          const record = value as { text?: unknown } | undefined
          return [{ type: 'text', text: typeof record?.text === 'string' ? record.text : '' }]
        },
      },
      execute,
    })
  }

  add(
    'omb_remember',
    '当用户给出长期偏好、已确认事实、任务线索、项目状态或需要分组的内容时调用。状态机可用可选动态属性 statusRule 让后台刷新自动推进状态。返回相似属性名、相似记忆与归档冲突，先复用/去重/建链再写。',
    toolParameters(rememberSchema),
    async (rawArgs, exec) => {
      const parsed = parseToolArgs(rememberSchema, rawArgs, REMEMBER_ARRAY_LIMITS)
      if (!parsed.ok) return { ok: false, text: parsed.text }
      const context = await runtime.context(exec)
      if (context === undefined) return { ok: false, text: 'missing-session: 无法确定会话/项目' }
      const input = buildRemember(parsed.data, context)
      if (input === undefined) return { ok: false, text: 'invalid-input: 缺少该 kind 的必填字段或项目作用域' }
      return resultOf(await runtime.remember(input, context))
    },
  )

  add(
    'omb_recall',
    '用户提到“上次/之前/原来的决定”，或当前任务需要项目状态、旧结论、错误签名、相关链接时调用。默认只返回未归档；沿链接/思维链展开用 expand。',
    toolParameters(recallSchema),
    async (rawArgs, exec) => {
      const parsed = parseToolArgs(recallSchema, rawArgs, RECALL_ARRAY_LIMITS)
      if (!parsed.ok) return { ok: false, text: parsed.text }
      const context = await runtime.context(exec)
      if (context === undefined) return { ok: false, text: 'missing-session: 无法确定会话/项目' }
      return resultOf(await runtime.recall(parsed.data, context))
    },
  )

  add(
    'omb_update',
    '实体有明确 id、需要改属性/状态/标题时调用；归档/取消归档用 omb_admin。状态机更新会自动存档历史。必须带 expectedRevision 以避免覆盖并发修改。',
    toolParameters(updateSchema),
    async (rawArgs, exec) => {
      const parsed = parseToolArgs(updateSchema, rawArgs, UPDATE_ARRAY_LIMITS)
      if (!parsed.ok) return { ok: false, text: parsed.text }
      const context = await runtime.context(exec)
      if (context === undefined) return { ok: false, text: 'missing-session: 无法确定会话/项目' }
      const rawAttrs = parsed.data.attrs as Record<string, RawAttributeValue | null> | undefined
      const patch: PatchEntityInput = {
        id: parsed.data.id,
        ...(parsed.data.expectedRevision !== undefined ? { expectedRevision: parsed.data.expectedRevision } : {}),
        ...(rawAttrs !== undefined ? { attrs: rawAttrs } : {}),
        ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
        ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
        ...(parsed.data.time !== undefined ? { time: parsed.data.time } : {}),
        ...(parsed.data.category !== undefined ? { category: parsed.data.category } : {}),
        ...(parsed.data.group !== undefined ? { group: parsed.data.group } : {}),
        ...(parsed.data.pinned !== undefined ? { pinned: parsed.data.pinned } : {}),
        ...(parsed.data.confidence !== undefined ? { confidence: parsed.data.confidence } : {}),
      }
      return resultOf(await runtime.update(patch, context))
    },
  )

  add(
    'omb_link',
    '两个实体之间存在依赖/来源/冲突/合并自等关系时调用；relation 用短英文。需要建组用 omb_remember(kind=chain)。',
    toolParameters(linkSchema),
    async (rawArgs, exec) => {
      const parsed = parseToolArgs(linkSchema, rawArgs)
      if (!parsed.ok) return { ok: false, text: parsed.text }
      const context = await runtime.context(exec)
      if (context === undefined) return { ok: false, text: 'missing-session: 无法确定会话/项目' }
      if (parsed.data.unlinkId !== undefined) return resultOf(await runtime.unlink(parsed.data.unlinkId, context))
      const input: LinkInput = {
        fromId: parsed.data.from as string,
        toId: parsed.data.to as string,
        relation: parsed.data.relation as string,
        ...(parsed.data.directed !== undefined ? { directed: parsed.data.directed } : {}),
        ...(parsed.data.strength !== undefined ? { strength: parsed.data.strength } : {}),
        ...(parsed.data.allowArchived !== undefined ? { allowArchived: parsed.data.allowArchived } : {}),
      }
      return resultOf(await runtime.link(input, context))
    },
  )

  add(
    'omb_history',
    '需要查看状态机的历史版本时调用；历史不可回滚，只返回快照与时间。',
    toolParameters(historySchema),
    async (rawArgs) => {
      const parsed = parseToolArgs(historySchema, rawArgs)
      if (!parsed.ok) return { ok: false, text: parsed.text }
      return resultOf(await runtime.history(parsed.data.id, parsed.data.limit ?? 20))
    },
  )

  add(
    'omb_status',
    '需要确认数据库/队列/嵌入/索引是否可用时调用。只报实测读数；未测量会明确写“未测量”。',
    toolParameters(z.object({})),
    async () => resultOf(await runtime.status()),
  )

  add(
    'omb_admin',
    '需要查看审计、回滚某次后台操作，或手工归档/取消归档时调用；rollback 只支持有 inverse 的审计记录。',
    toolParameters(adminSchema),
    async rawArgs => {
      const parsed = parseToolArgs(adminSchema, rawArgs)
      if (!parsed.ok) return { ok: false, text: parsed.text }
      return resultOf(await runtime.admin(parsed.data))
    },
  )

  return definitions
}

export interface ToolSurface {
  readonly registered: readonly string[]
  readonly unavailable: readonly { readonly name: string; readonly reason: string }[]
  dispose(): void
}

export function registerTools(ctx: HostContextLike | undefined, runtime: ToolRuntime, logger?: Logger): ToolSurface {
  const surface: HostToolsLike | undefined = readTools(ctx)
  const definitions = createToolDefinitions(runtime)
  const registered: string[] = []
  const unavailable: { name: string; reason: string }[] = []
  const disposers: (() => void)[] = []
  if (surface === undefined) {
    for (const definition of definitions) unavailable.push({ name: definition.name, reason: '宿主没有 tools.register' })
    return { registered, unavailable, dispose: () => {} }
  }
  for (const definition of definitions) {
    try {
      const returned = surface.register(definition)
      registered.push(definition.name)
      if (typeof returned === 'function') disposers.push(returned as () => void)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      unavailable.push({ name: definition.name, reason })
      logger?.warn(`工具注册失败：${definition.name}`, reason)
    }
  }
  return {
    registered,
    unavailable,
    dispose: () => {
      for (const disposer of disposers.splice(0)) {
        try {
          disposer()
        } catch {
          // 注销失败不阻断卸载。
        }
      }
    },
  }
}

export async function resolveToolContext(exec: unknown): Promise<ToolContext | undefined> {
  const base = sessionFromExec(exec)
  if (base === undefined) return undefined
  const projectKey = await resolveProjectKey(base.cwd)
  return { ...base, ...(projectKey !== undefined ? { projectKey } : {}) }
}
