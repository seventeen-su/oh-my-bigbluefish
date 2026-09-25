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
 *
 * 回执要能**当场自证**两件事（缺一个都会让调用方只能事后反证）：
 * ① 存下的**逐字原文**（截断必注明）——"我存了什么"当场可见
 * ② 本次声明取代的旧条目**逐条结果**——"旧结论被标为推翻了没有"当场可见
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
 * 写入回执里**回显原文**的字符上限。
 *
 * 为什么需要回显：只回 `id=… / 落库=… / 准入依据=…` 时，"存下来的到底是不是我写的那句话"
 * 只能靠事后 `omb_recall` 反证——写入当下无法自证。而逐字保真是本系统的硬承诺
 * （Fidelity Before Structure），所以它必须在**写入那一刻**可见。
 *
 * 为什么截断：单条上限 4000 字符，整段回显会淹掉回执本身；240 字符足够核对措辞，
 * 且截断时**明确写出"已截断"与完整长度**——把截断说成全文才是真的骗人。
 */
export const RECEIPT_ECHO_CHARS = 240

/**
 * 一次写入允许声明取代的旧记忆条数上限。
 *
 * 不是语义限制，是**爆炸半径**限制：一条新结论顺手把几十条旧记忆扫进"已推翻"，
 * 事后无法逐条复核。超限请分批写，每批都能单独审计。
 */
export const MAX_SUPERSEDE_TARGETS = 20

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

/**
 * "可由具体工件复现"的可核对标记。命中即说明这条挂在某个具体东西上，不是模糊印象。
 *
 * ## 判据只对**正文**生效，不看 `sourceRef`
 *
 * 踩过的坑：原先匹配的是 `正文 + sourceRef`，而 `sourceRef` 在省略时由工具
 * 自动生成成 `session:<uuid>#turn-N`。于是
 *
 * ```
 * 正文：今天感觉还不错，学到了很多东西。        ← 不含任何工件
 * 命中：提交哈希（"90730570"）                 ← 其实是 UUID 的一段
 * ```
 *
 * 模糊内容被**当成可复现事实收下**——准入网在这个类别上直接漏。
 * 教训：`sourceRef` 是**溯源**（这条从哪来），不是**可复现工件**（这条凭什么能被验证）；
 * 拿它当依据等于让工具自己给自己发合格证。
 */
const ARTIFACT_MARKERS: readonly { readonly pattern: RegExp; readonly label: string }[] = [
  { pattern: /(?:^|[\s("'`])[A-Za-z]:\\/, label: 'Windows 路径' },
  { pattern: /(?:^|[\s("'`])(?:\.{0,2}\/)[\w.-]+\//, label: '文件路径' },
  /**
   * 行号。**判据只认三种无歧义形态，且必须排在「文件名」之前**。
   *
   * 为什么不能是 `\b\d+:\d+\b`——那条两头都错，实测：
   *
   * - **假阳性**：`…T05:35:54+08:00` 里的 `35:54`、`14:30`（时间）、`16:9`（比例）全命中。
   *   自检报告里 `OMB v3 自检标记：本次自检时间为 2026-09-26T05:35:54+08:00，…`
   *   被记成「命中行号」——**理由与内容不符**，于是判据的 verdict 不能当证据用。
   * - **假阴性**：真正的 `src/index.ts:120` **不**命中（`ts:120` 里 `:` 前是字母，
   *   `\b` 不成立）。它漏掉了自己本来要认的那一种。
   *
   * 为什么排在「文件名」之前：`ARTIFACT_MARKERS.find()` 取**第一个**命中，
   * 而 `remember.ts:137` 同时命中「文件名」与「行号」。行号更具体、更接近"可核对"，
   * 理应优先；否则回执会报一个比实际证据更弱的理由。
   *
   * 宁可漏：漏了补个 `#L120` 就能过；错收是把与"可复现"无关的内容当成有实据。
   */
  {
    pattern:
      /#L\d+|\bline\s*\d+\b|\b[\w.-]+\.(?:ts|tsx|js|mjs|cjs|json|md|yml|yaml|toml|ini|py|go|rs|java|kt|sql|sh|ps1|css|html|txt|csv):\d+\b/,
    label: '行号',
  },
  {
    pattern:
      /\b[\w.-]+\.(?:ts|tsx|js|mjs|cjs|json|md|yml|yaml|toml|ini|py|go|rs|java|kt|sql|sh|ps1|css|html|txt|csv)\b/,
    label: '文件名',
  },
  { pattern: /https?:\/\/\S+/, label: 'URL' },
  /**
   * 提交哈希。**不能用裸 `\b[0-9a-f]{7,40}\b`**：UUID 的每一段（8 位十六进制）
   * 都符合，于是任何自动生成的 `session:<uuid>` 溯源都会命中——实测就是这样
   * 把一句"今天感觉还不错"当成"命中提交哈希"收进来的。
   *
   * 而且**形态上无法区分**裸短哈希与标识符片段：
   * `a1b2c3d4`（短哈希）与 `mem_muhg9mlv_1_3c6bf8ae` 的尾段长得一模一样。
   * 所以短哈希一律要求**显式语境**；只有 ≥12 位才认裸写
   * （12 位以上就不是 UUID 段或常见 id 尾段了）。
   *
   * 取舍是**宁可漏，不错收**：漏了只是让用户补个 `commit:` 前缀重写；
   * 错收的代价是假事实进库，并被后续会话当成有效结论召回——那比漏更贵。
   */
  {
    pattern:
      /\b[0-9a-f]{40}\b|\b(?:commit|hash|sha|revision)\W{0,3}[0-9a-f]{7,40}\b|@[0-9a-f]{7,40}\b|\b[0-9a-f]{12,40}\b/i,
    label: '提交哈希',
  },
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
  //
  // **只看正文**，不看 `sourceRef`：`sourceRef` 是溯源（这条从哪来），不是
  // 可复现工件（这条凭什么能被验证）。把它算进判据，等于让工具用自己自动生成的
  // `session:<uuid>#turn-N` 给自己发合格证——实测就是这样把一句模糊感想收下的
  // （UUID 的一段 8 位十六进制命中了"提交哈希"）。
  const marker = ARTIFACT_MARKERS.find(candidate => candidate.pattern.test(trimmed))
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
  supersedes: z
    .array(z.string().min(1))
    .max(MAX_SUPERSEDE_TARGETS)
    .optional()
    .describe(
      `本条目**取代**的旧记忆 id 列表（最多 ${MAX_SUPERSEDE_TARGETS} 条；id 从 omb_recall / omb_relate 的溯源行里拿）。` +
        '只在旧结论已被新证据或实测推翻时给：会把旧条目标为"已被本条取代"（validTo + supersededBy，非破坏性、' +
        '历史仍可查）并建立 supersedes 边，使后续会话召回到它时能立刻看出它不再有效。不要用它表达"内容相近"。',
    ),
})

export type RememberArgs = z.infer<typeof rememberArgsSchema>

/** 与 `parse` 同源生成：模型侧的参数说明因此不可能与校验器漂移。 */
export const REMEMBER_JSON_SCHEMA: Record<string, unknown> = z.toJSONSchema(rememberArgsSchema) as Record<
  string,
  unknown
>

/**
 * 一条 supersedes 标注的结果。
 *
 * 分四档而不是"成功/失败"两档：**"早已被取代"与"这次标成功"是两件事**，
 * 把它们合并会让审计看不出"我这条更正到底改动了什么"。
 */
export type SupersedeStatus =
  /** 已标为本条取代：旧条目 validTo + supersededBy 已写，supersedes 边已建。 */
  | 'superseded'
  /** 旧条目早已在取代链里：**保留原标注**（改写会让"谁取代了谁"失真），只补 supersedes 边。 */
  | 'already-superseded'
  /** 找不到这条 id（拼错、已被隐私擦除，或不在任何已打开的库里）。 */
  | 'missing'
  /** 找得到但标注/建边失败。**新条目已写入**，但旧条目没有被标为已推翻——回执必须说清。 */
  | 'failed'

export interface SupersedeEntry {
  readonly id: string
  readonly status: SupersedeStatus
  /** `already-superseded` 时是既有的取代者 id；`failed` 时是失败原因。 */
  readonly detail?: string
}

export interface SupersedeReport {
  /** 去重后的请求列表（顺序即调用方给的顺序，便于逐条核对）。 */
  readonly requested: readonly string[]
  readonly entries: readonly SupersedeEntry[]
}

/** 写入结果的可读回执（供 `renderRemember` 与测试断言）。 */
export interface RememberOutcome {
  readonly written: boolean
  readonly id?: string
  readonly scope?: MemoryScope
  readonly kind?: MemoryKind
  readonly ground?: AdmissionGround
  readonly verification?: AssertionVerification
  readonly reason: string
  /** 存下的**逐字原文**（回执回显；超长时渲染层截断并注明）。 */
  readonly text?: string
  /** 内容哈希；与库里的 `content_hash` 一致 = 逐字保真的当场证据。 */
  readonly contentHash?: string
  /** 本次声明了 `supersedes` 时：逐条标注结果。 */
  readonly supersede?: SupersedeReport
}

export interface MemoryWriteDeps {
  /**
   * 解析目标库。**可异步**：写入路径允许等库打开（读路径不行，它有延迟预算）。
   * 未就绪返回 undefined（**不抛**），工具据此给出可读错误。
   *
   * `supersedes` 的旧条目可能在**另一个库**（如新条目落项目库、旧结论在用户库），
   * 因此本函数会被按两个作用域各问一次；实现必须能对任一作用域给出句柄或 undefined。
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

/** 回显原文（截断必注明；不把截断伪装成全文）。 */
function echoLines(text: string, contentHash: string | undefined): readonly string[] {
  const truncated = text.length > RECEIPT_ECHO_CHARS
  const shown = truncated ? text.slice(0, RECEIPT_ECHO_CHARS) : text
  const lines = [
    `存下的逐字原文（${text.length} 字符${truncated ? `，回执只显示前 ${RECEIPT_ECHO_CHARS} 字符——已截断` : '，全文如下'}）：`,
    truncated ? `${shown}…（截断处）` : shown,
  ]
  if (truncated) {
    lines.push(
      `（回执已截断，不假装是全文：本条目在库里的完整长度是 ${text.length} 字符，用 omb_recall 可复核全文。）`,
    )
  }
  if (contentHash !== undefined) {
    lines.push(`原文哈希=${contentHash}（与库中 content_hash 一致即为逐字保真）`)
  }
  return lines
}

/**
 * 推翻标注的逐条回执。**只列实际发生过的事**：
 * "没标上"绝不写成"已标"——那会让下一个会话以为旧结论已被处理，比不标更坏。
 */
function renderSupersede(report: SupersedeReport): readonly string[] {
  const marked = report.entries.filter(entry => entry.status === 'superseded')
  const already = report.entries.filter(entry => entry.status === 'already-superseded')
  const missing = report.entries.filter(entry => entry.status === 'missing')
  const failed = report.entries.filter(entry => entry.status === 'failed')
  const lines: string[] = []
  if (marked.length > 0) {
    lines.push(
      `推翻标注：${marked.length} 条旧记忆已标为"被本条取代"（validTo + supersededBy + supersedes 边）：` +
        marked.map(entry => entry.id).join('、'),
    )
    lines.push(
      '（非破坏性：旧条目仍在库里，"我当时相信什么"仍可回答；它不会再作为有效结论注入召回，用 omb_relate 可追。）',
    )
  }
  if (already.length > 0) {
    lines.push(
      `推翻标注：${already.length} 条早已在取代链里，**保留原标注**（未改写历史），只补了 supersedes 边：` +
        already.map(entry => `${entry.id}（原取代者 ${entry.detail ?? '未知'}）`).join('、'),
    )
  }
  if (missing.length > 0) {
    lines.push(
      `推翻标注：未找到 ${missing.length} 条：${missing.map(entry => entry.id).join('、')}` +
        '（id 拼错、已被隐私擦除，或不在任何已打开的库里）',
    )
  }
  if (failed.length > 0) {
    lines.push(
      `推翻标注**未完成** ${failed.length} 条（新条目已写入，但这些旧条目没有被标为已推翻）：` +
        failed.map(entry => `${entry.id}（${entry.detail ?? '未知原因'}）`).join('、'),
    )
  }
  return lines
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
  if (outcome.text !== undefined) lines.push(...echoLines(outcome.text, outcome.contentHash))
  if (outcome.supersede !== undefined) lines.push(...renderSupersede(outcome.supersede))
  return lines.join('\n')
}

// ────────────────────────────────────────────────────────────────────────────
// 推翻标注（supersedes）
// ────────────────────────────────────────────────────────────────────────────

/** 旧条目在哪：三态而不是 `undefined | MemoryRecord`——"查库失败"与"没有这条"必须分开。 */
type SupersedeLookup =
  | { readonly kind: 'found'; readonly store: MemoryStore; readonly record: MemoryRecord }
  | { readonly kind: 'missing' }
  | { readonly kind: 'error'; readonly reason: string }

/**
 * 找一条旧记忆：先在新条目所在的库找，再问另一个作用域。
 *
 * 为什么允许跨库：结论按 kind 路由（semantic→用户库、episodic/procedural→项目库），
 * 而"这条结论被推翻"完全可能跨库发生（项目里实测推翻了用户库里记下的偏好）。
 * 找不到就如实报 missing，不猜。
 */
async function findSupersedeTarget(
  deps: MemoryWriteDeps,
  primary: MemoryStore,
  id: string,
): Promise<SupersedeLookup> {
  const stores: MemoryStore[] = [primary]
  const otherScope: MemoryScope = primary.scope === 'user' ? 'project' : 'user'
  try {
    const other = await deps.resolveStore(otherScope)
    if (other !== undefined && other !== primary) stores.push(other)
  } catch {
    // 另一个库拿不到不影响在本库找；找不到会如实报 missing
  }
  const failures: string[] = []
  for (const store of stores) {
    try {
      const record = await store.get(id)
      if (record !== undefined) return { kind: 'found', store, record }
    } catch (error) {
      failures.push(`库 ${store.scope} 查询失败（${messageOf(error)}）`)
    }
  }
  return failures.length > 0 ? { kind: 'error', reason: failures.join('；') } : { kind: 'missing' }
}

/** 建 `supersedes` 边（newer → older）。失败返回可读原因，**不抛**。 */
async function linkSupersedes(
  store: MemoryStore,
  fromId: string,
  toId: string,
  createdAt: number,
): Promise<string | undefined> {
  try {
    await store.upsertEdge({ fromId, toId, type: 'supersedes', createdAt })
    return undefined
  } catch (error) {
    return messageOf(error)
  }
}

/**
 * 把请求里的旧条目标为"已被本条取代"。
 *
 * 语义（与离线整合一致，见 `consolidate.ts`）：
 * ① **非破坏性**：只写 `validTo` + `supersededBy`，**不删行**——"我当时相信什么"必须可回答
 * ② 边方向 `newer → older`，便于 `omb_relate` 顺着链往下走
 * ③ 已在取代链里的条目**不改写**既有标注（改写会让"谁取代了谁"失真），只补边
 *
 * 任何一条失败都不影响新条目已写入这个事实，但结果必须如实回执。
 */
async function applySupersedes(
  deps: MemoryWriteDeps,
  primary: MemoryStore,
  requested: readonly string[],
  record: MemoryRecord,
  now: number,
): Promise<SupersedeReport> {
  const ids: string[] = []
  for (const raw of requested) {
    const id = raw.trim()
    if (id.length === 0 || ids.includes(id)) continue
    ids.push(id)
  }
  const entries: SupersedeEntry[] = []
  for (const id of ids) {
    if (id === record.id) {
      // 极端防御：新 id 由时钟 + 序号 + 内容哈希生成，撞上既有 id 实际上不可能。
      entries.push({ id, status: 'failed', detail: '目标 id 与本条新记录相同，不能自己取代自己' })
      continue
    }
    const lookup = await findSupersedeTarget(deps, primary, id)
    if (lookup.kind === 'missing') {
      entries.push({ id, status: 'missing' })
      continue
    }
    if (lookup.kind === 'error') {
      entries.push({ id, status: 'failed', detail: lookup.reason })
      continue
    }
    const target = lookup.record
    const crossStore = lookup.store === primary ? undefined : primary

    if (target.supersededBy !== null) {
      const edgeError = await linkSupersedes(lookup.store, record.id, target.id, now)
      const crossError = crossStore === undefined ? undefined : await linkSupersedes(crossStore, record.id, target.id, now)
      const problem = edgeError ?? crossError
      if (problem !== undefined) {
        entries.push({
          id,
          status: 'failed',
          detail: `旧条目早已被 ${target.supersededBy} 取代（保留原标注），但补 supersedes 边失败：${problem}`,
        })
      } else {
        entries.push({ id, status: 'already-superseded', detail: target.supersededBy })
      }
      continue
    }

    try {
      await lookup.store.put({
        ...target,
        // 与 consolidate.ts 同一口径：失效时间取"新证据时间"与"旧条目时间"的较晚者
        validTo: Math.max(now, target.observedAt),
        supersededBy: record.id,
      })
    } catch (error) {
      entries.push({ id, status: 'failed', detail: `标注旧条目失败：${messageOf(error)}` })
      continue
    }

    const edgeError = await linkSupersedes(lookup.store, record.id, target.id, now)
    const crossError = crossStore === undefined ? undefined : await linkSupersedes(crossStore, record.id, target.id, now)
    const problem = edgeError ?? crossError
    if (problem !== undefined) {
      entries.push({ id, status: 'failed', detail: `旧条目已标为被取代，但 supersedes 边写入失败：${problem}` })
    } else {
      entries.push({ id, status: 'superseded' })
    }
  }
  return { requested: ids, entries }
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

        // 推翻标注在 put 成功**之后**做：标注一个不存在的取代者是没有意义的。
        // 标不出来也不影响"新条目已写入"，但结果必须原样进回执（见 renderSupersede）。
        const supersede =
          input.supersedes === undefined || input.supersedes.length === 0
            ? undefined
            : await applySupersedes(deps, store, input.supersedes, record, now)

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
            text: record.text,
            contentHash: record.contentHash,
            ...(supersede === undefined ? {} : { supersede }),
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
