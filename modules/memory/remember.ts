/**
 * `omb_remember`：记忆的**写入路径**（规划 §5.6 在线部分）。
 *
 * 为什么需要它：`omb_recall` / `omb_forget` / `omb_relate` 全是读；没有写入口，
 * 两个库会永远是空的，检索、整合、回响检测、向量通道全部结构上无从验证。
 *
 * 三条硬约束：
 * ① **在线只插入**：不调 LLM、不摘要、不合并（去重/回响/矛盾都是离线整合的事）
 * ② **准入启发式是纯函数**（`decideAdmission`），弃权必须给可读原因——
 *    "记录每一次弃权"是审计漏记率的唯一手段（§5.6）
 * ③ 执行体**绝不抛异常**（H-3）：参数非法、库未就绪、写入失败一律返回错误分支
 *
 * 归属（`assertedBy`）与准入依据（`AdmissionGround`）是**两个问题**，别混：
 * - 准入依据 = "这条值不值得写"（用户陈述 / 可由工件复现 / 执行结果确认）
 * - `assertedBy` = "谁在断言"（`user` 需要核对到用户真的这么说过；本次写入没有真的执行过，
 *   因此**永不**写 `execution`——那是需要真实执行轨迹才能claim的来源等级）
 */
import { z } from 'zod'
import type {
  AssertedBy,
  Clock,
  MemoryKind,
  MemoryRecord,
  MemoryScope,
  MemoryStore,
  ToolDefinition,
  ToolInputSchema,
  ToolOutcome,
} from '../../kernel/abi/index.js'
import { MEMORY_KINDS, MEMORY_SCOPES, RESERVED_SOURCE_PREFIX, SCOPE_BY_KIND } from '../../kernel/abi/index.js'

/** 工具名 = `MODULE_CATALOG` 里 `omb-memory` 的 tools 之一（目录是唯一契约）。 */
export const REMEMBER_TOOL = 'omb_remember'

/** 单条记忆的字符上限：逐字原文适合短陈述；长内容请落到制品索引（避免一条巨块污染召回）。 */
export const MAX_TEXT_CHARS = 4000

/** 太短的内容无法成为可核对的事实。 */
export const MIN_TEXT_CHARS = 4

/**
 * 内容哈希（精确去重的原语，§5.6 第 1 步）。
 *
 * 用 **64 位** FNV-1a（十六进制）而不是 32 位：32 位在万级记忆上已有可观的碰撞概率，
 * 而碰撞在这里的后果是**把两条不同的记忆当成重复而合并**——静默的有损操作。
 * 只哈希 `text`（不含 sourceRef）：同内容 = 同哈希，这正是回响检测要的性质。
 */
export function contentHashOf(text: string): string {
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  const mask = 0xffffffffffffffffn
  for (let index = 0; index < text.length; index++) {
    hash ^= BigInt(text.charCodeAt(index))
    hash = (hash * prime) & mask
  }
  return hash.toString(16).padStart(16, '0')
}

/** 准入依据。可审计：准入与弃权都必须说得出为什么。 */
export type AdmissionGround = 'user-declared' | 'reproducible-artifact' | 'execution-confirmed'

/** `assertedBy` 的可核对性等级（本次写入只有两档可用，见文件头）。 */
export type AssertionVerification = 'verified-in-user-message' | 'claimed-unverified' | 'not-user'

export interface AdmissionInput {
  readonly text: string
  readonly sourceRef: string
  /** 模型自报"这是用户的显式陈述"。**单独不构成依据**：有用户消息可核对时必须核对通过。 */
  readonly claimedUserAssertion: boolean
  /**
   * 会话里最近一条用户消息（宿主能力可得时提供）。
   * 给了就**核对**"用户是不是真的这么说过"；没给则只能记为"自报未核对"。
   */
  readonly userMessage?: string
}

export type AdmissionDecision =
  | {
      readonly ok: true
      readonly ground: AdmissionGround
      readonly assertedBy: AssertedBy
      readonly verification: AssertionVerification
      /** 写入回执里要显示的准入依据。 */
      readonly reason: string
    }
  | { readonly ok: false; readonly reason: string }

/** "可由具体工件复现"的可核对标记。命中即说明这条挂在某个具体东西上，不是模糊印象。 */
const ARTIFACT_MARKERS: readonly { readonly pattern: RegExp; readonly label: string }[] = [
  { pattern: /(?:^|[\s("'`])[A-Za-z]:\\/, label: 'Windows 路径' },
  { pattern: /(?:^|[\s("'`])(?:\.{0,2}\/)[\w.-]+\//, label: '文件路径' },
  {
    pattern:
      /\b[\w.-]+\.(?:ts|tsx|js|mjs|cjs|json|md|yml|yaml|toml|ini|py|go|rs|java|kt|sql|sh|ps1|css|html|txt|csv)\b/,
    label: '文件名',
  },
  { pattern: /#L\d+|\bline\s*\d+\b|\b\d+:\d+\b/, label: '行号' },
  { pattern: /https?:\/\/\S+/, label: 'URL' },
  { pattern: /\b[0-9a-f]{7,40}\b/, label: '提交哈希' },
  { pattern: /\bv?\d+\.\d+(?:\.\d+)*\b/, label: '版本号' },
  {
    pattern:
      /\b(?:pnpm|npm|yarn|npx|node|git|docker|kubectl|curl|cargo|go|python|pip|pytest|tsc|vitest|eslint|make)\b\s+[\w./-]+/,
    label: '可复现命令',
  },
]

/** "被执行结果确认"的显式来源标注（`sourceRef` 前缀）。 */
const EXECUTION_SOURCE_PREFIXES: readonly string[] = ['execution:', 'command:', 'test:', 'run:', 'observed:']

/** 保留来源前缀（画像一类的单文档状态）——不该经本工具写入。 */
function isReservedSource(sourceRef: string): boolean {
  return sourceRef.startsWith(RESERVED_SOURCE_PREFIX)
}

/** 规范化：用于"用户是不是真的这么说过"的核对（大小写、空白、标点差异不该阻断核对）。 */
function normalizeForCompare(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[.,;:!?'"“”‘’()（）[\]{}<>《》—–-]+/g, '')
}

/**
 * 核对"用户消息里是否真的包含这条陈述"。
 *
 * 判据是**包含**（去空白与标点后），不是相似度：相似度会让"用户提到过类似的事"通过，
 * 而 §5.6 明确警告"相关性痕迹导致的假晋升"。
 */
export function isGroundedInUserMessage(text: string, userMessage: string | undefined): boolean {
  if (userMessage === undefined || userMessage.length === 0) return false
  const needle = normalizeForCompare(text)
  if (needle.length < MIN_TEXT_CHARS) return false
  return normalizeForCompare(userMessage).includes(needle)
}

function hasReadableContent(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text)
}

/**
 * 准入启发式（**纯函数**，规划 §5.6）：写，当且仅当
 * ① 用户显式陈述（且能在会话用户消息里核对到，或明确记为"自报未核对"）
 * ② 可由具体工件复现（路径/命令/URL/哈希/版本号）
 * ③ 被执行结果确认（`sourceRef` 带 `execution:` 一类前缀）
 * 否则**弃权**并给出可读原因。
 */
export function decideAdmission(input: AdmissionInput): AdmissionDecision {
  const text = typeof input.text === 'string' ? input.text : ''
  const trimmed = text.trim()

  if (trimmed.length === 0) return { ok: false, reason: '内容为空：没有可写入的陈述' }
  if (!hasReadableContent(trimmed)) {
    return { ok: false, reason: '内容不含任何文字或数字：无法成为一条可检索、可核对的记忆' }
  }
  if (trimmed.length < MIN_TEXT_CHARS) {
    return { ok: false, reason: `内容过短（${trimmed.length} < ${MIN_TEXT_CHARS} 字符）：太短的内容无法成为可核对的事实` }
  }
  if (trimmed.length > MAX_TEXT_CHARS) {
    return {
      ok: false,
      reason: `内容过长（${trimmed.length} > ${MAX_TEXT_CHARS} 字符）：逐字原文适合短陈述；长内容请落到制品索引，避免一条巨块污染召回`,
    }
  }
  if (typeof input.sourceRef !== 'string' || input.sourceRef.length === 0) {
    return {
      ok: false,
      reason: '缺少来源引用（source_ref 非空是投毒防御与证据独立的必要条件，§5.2）',
    }
  }
  if (isReservedSource(input.sourceRef)) {
    return {
      ok: false,
      reason: `来源前缀 ${RESERVED_SOURCE_PREFIX} 保留给"单文档结构化状态"（画像一类）：它不是经验痕迹，请由对应模块写入`,
    }
  }

  // ① 用户显式陈述
  const verified = isGroundedInUserMessage(trimmed, input.userMessage)
  if (input.claimedUserAssertion && (verified || input.userMessage === undefined)) {
    return {
      ok: true,
      ground: 'user-declared',
      assertedBy: 'user',
      verification: verified ? 'verified-in-user-message' : 'claimed-unverified',
      reason: verified
        ? '用户显式陈述（已在会话的用户消息里核对到原话）'
        : '用户显式陈述（自报；本进程拿不到用户消息原文，未核对）',
    }
  }

  // ③ 被执行结果确认（按 `sourceRef` 的显式标注）
  const source = input.sourceRef.toLowerCase()
  if (EXECUTION_SOURCE_PREFIXES.some(prefix => source.startsWith(prefix))) {
    return {
      ok: true,
      ground: 'execution-confirmed',
      // 断言来源保守记为 model：本次写入并没有真的执行过任何东西（写 execution 会是假溯源）
      assertedBy: 'model',
      verification: 'not-user',
      reason: `可由执行结果确认（来源标注 ${input.sourceRef.split(':')[0]}）`,
    }
  }

  // ② 可由具体工件复现
  const haystack = `${trimmed}\n${input.sourceRef}`
  const marker = ARTIFACT_MARKERS.find(candidate => candidate.pattern.test(haystack))
  if (marker !== undefined) {
    return {
      ok: true,
      ground: 'reproducible-artifact',
      assertedBy: 'model',
      verification: 'not-user',
      reason: `可由具体工件复现（命中${marker.label}）`,
    }
  }

  if (input.claimedUserAssertion) {
    return {
      ok: false,
      reason:
        '自称用户陈述但无法在会话的用户消息里核对到原话，且看不出可由具体工件复现或被执行结果确认——' +
        '弃权（自报不能用来取得 user 来源等级，§5.8 的等级差是结构性的）',
    }
  }

  return {
    ok: false,
    reason:
      '没有准入依据：既不是用户显式陈述，也看不出可由具体工件复现或被执行结果确认——' +
      '弃权并记录（§5.6 要求精度优先于召回，宁可漏记也不要写入模糊印象）',
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 工具
// ────────────────────────────────────────────────────────────────────────────

/** 参数 schema：`parse` 校验 + `jsonSchema` 给模型看（模型看不到我们的校验器）。 */
interface ToolParameters extends ToolInputSchema {
  readonly jsonSchema: Record<string, unknown>
}

const rememberArgsSchema = z.object({
  text: z
    .string()
    .describe('要逐字记住的原话/结论。不要转述、不要摘要——逐字原文比有损抽取更可靠。'),
  kind: z
    .enum(['episodic', 'semantic', 'procedural'])
    .describe('episodic=情境记录；semantic=长期结论/偏好；procedural=做法与经验。决定落哪个库。'),
  scope: z
    .enum(['user', 'project'])
    .optional()
    .describe('显式覆盖落库位置。省略时按 kind 路由：semantic→用户库，episodic/procedural→项目库。'),
  sourceRef: z
    .string()
    .optional()
    .describe('来源引用（会话/轮次/文件/命令）。省略时用当前会话与回合号；没有来源就无法建立证据独立。'),
  userAsserted: z
    .boolean()
    .optional()
    .describe('仅当这句是用户自己明确说过的原话时置 true。不要为了写入而声称是用户说的。'),
})

export type RememberArgs = z.infer<typeof rememberArgsSchema>

/** 与 `parse` 同源生成：模型侧的参数说明因此不可能与校验器漂移。 */
export const REMEMBER_JSON_SCHEMA: Record<string, unknown> = z.toJSONSchema(rememberArgsSchema) as Record<
  string,
  unknown
>

/** 写入结果的可读回执（供 `renderRemember` 与测试断言）。 */
export interface RememberOutcome {
  readonly written: boolean
  readonly id?: string
  readonly scope?: MemoryScope
  readonly kind?: MemoryKind
  readonly ground?: AdmissionGround
  readonly verification?: AssertionVerification
  readonly reason: string
}

export interface MemoryWriteDeps {
  /**
   * 解析目标库。**可异步**：写入路径允许等库打开（读路径不行，它有延迟预算）。
   * 未就绪返回 undefined（**不抛**），工具据此给出可读错误。
   */
  readonly resolveStore: (scope: MemoryScope) => Promise<MemoryStore | undefined>
  /** 时钟。模块层不读墙钟，一律由 `dsh/` 传 `kernel.clock`。 */
  readonly clock: Clock
  /** 当前会话 id（来自回合事件）；用于默认 `sourceRef` 与"用户陈述"核对。 */
  readonly currentSession?: () => string | undefined
  /** 当前回合号；用于默认 `sourceRef`。 */
  readonly currentTurn?: () => number | undefined
  /** 会话里最近一条用户消息（宿主能力可得时提供；缺省即"自报未核对"）。 */
  readonly lastUserMessage?: () => string | undefined
  /** 当前项目身份（cwd 的规范化形式），作为 `project` 溯源写入。 */
  readonly currentProject?: () => string | undefined
  /**
   * 库未就绪时的可读原因（来自 `stores.status()`），拼进错误文本。
   */
  readonly degradeReason?: () => string | undefined
  /** 写入**成功后**触发（唯一触发点：向量落盘）。抛异常不得影响写入结果。 */
  readonly onWritten?: (payload: {
    readonly id: string
    readonly scope: MemoryScope
    readonly kind: MemoryKind
  }) => void
  /** 每一次弃权（准入拒绝）都要记录：弃权率是审计漏记的唯一手段。 */
  readonly onAbstained?: (info: { readonly reason: string; readonly text: string }) => void
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

let idSeq = 0

/** 记忆 id：时间 + 序号 + 内容哈希前缀 → 唯一、可读、可按时间粗排。 */
export function newMemoryId(clock: Clock, contentHash: string): string {
  idSeq = (idSeq + 1) % 0xffff
  return `mem_${clock.now().toString(36)}_${idSeq.toString(36)}_${contentHash.slice(0, 8)}`
}

/** 默认来源：会话 + 回合（可审计的最小溯源）。 */
export function defaultSourceRef(session: string | undefined, turn: number | undefined): string | undefined {
  if (session === undefined || session.length === 0) return undefined
  return turn === undefined ? `session:${session}` : `session:${session}#turn-${turn}`
}

/** 回执渲染（纯函数，便于断言）。 */
export function renderRemember(outcome: RememberOutcome): string {
  if (!outcome.written) {
    return [
      `未写入（准入弃权）：${outcome.reason}`,
      '本次弃权已记录（弃权率是审计漏记的唯一手段）。若这条确实值得记住，请补上可核对的来源或工件。',
    ].join('\n')
  }
  const lines = [
    `已记住：id=${outcome.id ?? '?'}`,
    `落库=${outcome.scope === 'user' ? '用户库（跨项目）' : '项目库（跨会话）'}，kind=${outcome.kind ?? '?'}`,
    `准入依据=${outcome.ground ?? '?'}（${outcome.reason}）`,
  ]
  if (outcome.verification === 'claimed-unverified') {
    lines.push('注意：断言来源按"用户陈述"记录，但本进程拿不到用户消息原文，未能核对。')
  }
  return lines.join('\n')
}

/** `omb_remember` 工具定义。**由模块的 `apply` 装配**（模块不接触宿主）。 */
export function createRememberTool(deps: MemoryWriteDeps): ToolDefinition {
  const parameters: ToolParameters = {
    parse: (input: unknown) => rememberArgsSchema.parse(input),
    jsonSchema: REMEMBER_JSON_SCHEMA,
  }

  return {
    name: REMEMBER_TOOL,
    description:
      '把一条值得记住的内容写进记忆库（逐字原文 + 溯源）。只在满足准入时写入：' +
      '用户明确说过的原话、可由具体工件（文件/命令/URL/提交）复现的事实、或被执行结果确认过的结论。' +
      '模糊印象与推测会被拒绝（会给出原因）。写入是即时生效的，不需要额外确认。',
    parameters,

    async execute(args: unknown): Promise<ToolOutcome> {
      try {
        const parsed = rememberArgsSchema.safeParse(args)
        if (!parsed.success) {
          return { kind: 'error', text: `omb_remember 参数非法：${parsed.error.issues.map(i => i.message).join('；')}` }
        }
        const input = parsed.data

        const scope: MemoryScope = input.scope ?? SCOPE_BY_KIND[input.kind]
        const sourceRef = input.sourceRef ?? defaultSourceRef(deps.currentSession?.(), deps.currentTurn?.())
        const decision = decideAdmission({
          text: input.text,
          sourceRef: sourceRef ?? '',
          claimedUserAssertion: input.userAsserted === true,
          ...(deps.lastUserMessage?.() === undefined ? {} : { userMessage: deps.lastUserMessage?.() }),
        })

        if (!decision.ok) {
          try {
            deps.onAbstained?.({ reason: decision.reason, text: input.text })
          } catch {
            // 记账失败不得改变"没写入"这个结论
          }
          return { kind: 'text', text: renderRemember({ written: false, reason: decision.reason }) }
        }

        if (sourceRef === undefined) {
          // 防御性守卫：空来源已在准入里被拒（"缺少来源引用"），正常到不了这里。
          // 保留它是为了**类型收窄**，也为了将来有人放宽准入规则时不至于写入无来源记录。
          return {
            kind: 'error',
            text:
              'omb_remember 无法写入：缺少来源引用。没有会话上下文时请在参数里显式给出 sourceRef ' +
              '（会话/轮次/文件/命令）——source_ref 非空是投毒防御与证据独立的必要条件。',
          }
        }

        const store = await deps.resolveStore(scope)
        if (store === undefined) {
          const why = deps.degradeReason?.()
          return {
            kind: 'error',
            text: `omb_remember 无法写入：${scope === 'user' ? '用户库' : '项目库'}尚未就绪${
              why === undefined ? '' : `——${why}`
            }`,
          }
        }

        const now = deps.clock.now()
        const contentHash = contentHashOf(input.text)
        const record: MemoryRecord = {
          id: newMemoryId(deps.clock, contentHash),
          scope,
          kind: input.kind,
          text: input.text,
          contentHash,
          sourceRef,
          assertedBy: decision.assertedBy,
          observedAt: now,
          // 在线路径只插入：不知道事实何时停止为真，也不做更正（那是离线整合的事）
          validTo: null,
          supersededBy: null,
          lastUsedAt: now,
          useCount: 0,
          project: deps.currentProject?.() ?? null,
        }

        await store.put(record)

        // 事件必须在 put **成功之后**发：失败的写入不该触发向量编码。
        // 订阅者的异常由事件总线隔离；这里再包一层，确保写入结果不被影响。
        try {
          deps.onWritten?.({ id: record.id, scope: record.scope, kind: record.kind })
        } catch {
          // 事件通道失败不改变"已写入"这个事实
        }

        return {
          kind: 'text',
          text: renderRemember({
            written: true,
            id: record.id,
            scope: record.scope,
            kind: record.kind,
            ground: decision.ground,
            verification: decision.verification,
            reason: decision.reason,
          }),
        }
      } catch (error) {
        // H-3：执行体绝不抛异常
        return { kind: 'error', text: `omb_remember 执行失败：${messageOf(error)}` }
      }
    },
  }
}

/** 工具数组形式，便于与其它工具一起装配。 */
export function createRememberTools(deps: MemoryWriteDeps): readonly ToolDefinition[] {
  return [createRememberTool(deps)]
}

/** 供契约测试断言：本工具允许的 kind/scope 取值来自 ABI 枚举，不另立一套。 */
export const REMEMBER_ALLOWED_KINDS: readonly MemoryKind[] = MEMORY_KINDS
export const REMEMBER_ALLOWED_SCOPES: readonly MemoryScope[] = MEMORY_SCOPES
