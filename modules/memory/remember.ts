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
 * - `assertedBy` = "谁在断言"（`user` 需要核对到用户真的这么说过；`execution` 需要
 *   `SessionWitnessPort.hasExecution` 命中真实调用记录——**不再**认 `sourceRef` 前缀自证，
 *   那条路径实测产出的是模型自己的会话回顾体）
 *
 * 3.7（W1-M4）新增两条模块侧护栏：
 * - **回顾体护栏**：>240 字符 + ≥3 个不同路径 + 总结词（本会话/回顾/完成/总结）→
 *   强制 `episodic` + 项目库；只有调用方**同时显式**给 `kind:'semantic'` 与
 *   `scope:'user'` 才允许进用户库（"写错"比"少写"更难回收）。
 * - **弃权分档**：每种弃权带 `category`，供健康面按原因计数（旧实现只有一句自由文本）。
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
import type { ToolCallContext } from '../../kernel/sessionRuntime.js'
import { hasSecret } from './secrets.js'
import { stageLabel, stageOfMemory } from './lifecycle.js'
import type { LifecycleStage } from './lifecycle.js'
import type { SessionWitnessPort } from './witness.js'

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

/**
 * 在**同一个库**里找"正文完全相同"的活跃条目（v4.8.0：跨写入路径去重）。
 *
 * 为什么必须有它：库按 `id` upsert，但没有正文唯一索引；同一条内容从
 * 控制器自动写入、模型 `omb_remember`、重复捕获三条路进来会变成多条记录，
 * 召回时彼此挤占名额，冲突判断也会把"同一条"当成"两条不同结论"。
 *
 * 判据与捕获路径的 `alreadyStored` 完全一致：正文前 60 字符做词法探测 +
 * `contentHash` 精确比对。只认**活跃**条目（`searchLexical` 已过滤失效/被取代），
 * 所以"旧结论被取代后再次写同一句"仍会正常落库（那是新的事实，不是重复）。
 *
 * 失败一律返回 `undefined`（去重是优化，不是安全边界；查询失败不能阻断写入）。
 */
export async function findSameContent(store: MemoryStore, text: string): Promise<MemoryRecord | undefined> {
  const hash = contentHashOf(text)
  try {
    const probe = text.slice(0, 60)
    const hits = await store.searchLexical({ text: probe, scope: store.scope, limit: 5 })
    if (hits.length === 0) return undefined
    const records = await store.getMany(hits.map(hit => hit.id))
    return records.find(record => record.contentHash === hash)
  } catch {
    return undefined
  }
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
  /**
   * **工件存在的核验器**：给定一个"看起来像工件"的候选串，回答它是不是真的存在。
   *
   * ## 为什么必须有它
   *
   * 判据原本只做**形态匹配**——于是字段名叫 `reproducible-artifact`（可复现），
   * 实际却只验"长得像文件名"。自检报告的负对照当场打穿：
   *
   * ```
   * 引用 does-not-exist-9f3a.json        → 通过并落库
   * 结论记在 totally-made-up.md 里       → 通过并落库
   * ```
   *
   * **编造的工件与真实工件得到同一个准入结论**，那这道闸门就只是一种措辞。
   *
   * ## 契约
   *
   * - 返回 `true` = 核验通过（工件确实存在）
   * - 返回 `false` = 核验不通过（不存在）
   * - 返回 `undefined` = **这个候选核验不了**（例如 URL 需要联网、命令需要执行）。
   *   调用方按**保守**处理：核验不了就不算依据——宁可让用户补一个可核验的引用，
   *   也不要收下一条引用不存在工件的事实。
   * - 不给这个核验器时：**文件类工件一律不算依据**（fail closed）。
   *   纯函数测试只需传 `() => true` 即可覆盖"通过"分支。
   */
  readonly verifyArtifact?: (candidate: string, kind: ArtifactKind) => boolean | undefined
  /**
   * `sourceRef` 是不是**调用方显式给的**（而不是工具自动生成的 `session:<uuid>#turn-N`）。
   *
   * 只有显式来源才可能是"可复现工件"：自动生成的那个是内部标识符，
   * 拿它当依据等于让工具给自己发合格证——那个假阳性修过一次，不要再打开。
   */
  readonly sourceRefExplicit?: boolean
  /**
   * **真实执行台账命中**（3.7-M4）。
   *
   * 由调用方从 `SessionWitnessPort.hasExecution(sessionId, sourceRef)` 取来：
   * `true` = 本会话真的执行过与 `sourceRef` 对应的调用。
   *
   * 旧实现只看 `sourceRef` 是否以 `execution:` 开头——那是模型可以自己写的字符串，
   * 等于自签合格证。实测项目库 3/3 条就是这么进来的**会话回顾体**。
   * `undefined`/`false` 一律不算依据（fail closed）。
   */
  readonly executionConfirmed?: boolean
}

/** 工件类别。只有**可核验**的类别才可能成为准入依据。 */
export type ArtifactKind = 'path' | 'command' | 'url' | 'hash' | 'version' | 'line'

/**
 * 弃权原因分档（3.7-M4）。
 *
 * 为什么必须分类：旧实现只给一句自由文本，健康面只能数"弃权总数"——
 * 而"没有依据"（可能是噪声，也可能是没带工件的真结论）与"来源缺失"（接线/归属问题）
 * 的修法完全不同。分类让它们各自变成可读的读数。
 */
export type AbstentionCategory =
  /** 正文为空。 */
  | 'empty'
  /** 正文不含任何文字或数字（纯标点/符号）。 */
  | 'no-content'
  /** 短于最小长度。 */
  | 'too-short'
  /** 长于单条上限。 */
  | 'too-long'
  /** 没有来源引用（投毒防御的必要条件）。 */
  | 'missing-source'
  /** 来源前缀保留给单文档状态（画像一类）。 */
  | 'reserved-source'
  /** 自称用户陈述但核对不到原话。 */
  | 'user-claim-unverified'
  /** 正文含凭据形态（3.7 Wave 2：与自主捕获共用 `./secrets.js` 的同一张模式表）。 */
  | 'secret'
  /** 看不出任何准入依据。 */
  | 'no-ground'

export type AdmissionDecision =
  | {
      readonly ok: true
      readonly ground: AdmissionGround
      readonly assertedBy: AssertedBy
      readonly verification: AssertionVerification
      /** 写入回执里要显示的准入依据。 */
      readonly reason: string
    }
  | { readonly ok: false; readonly reason: string; readonly category: AbstentionCategory }

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
const ARTIFACT_MARKERS: readonly {
  readonly pattern: RegExp
  readonly label: string
  readonly kind: ArtifactKind
  /**
   * **能不能核验存在**。
   *
   * `true` 的类别必须经 `verifyArtifact` 核验通过才算依据——否则
   * "命中文件名"这种理由会把编造的文件名也收进来（自检报告实测打穿过）。
   *
   * `false` 的类别只在**原位出现**时才算线索（命令里有可执行名与参数、
   * 版本号有具体数字），它们不是"存在性"声明，无法也无需核验文件系统。
   */
  readonly verifiable: boolean
}[] = [
  { pattern: /(?:^|[\s("'`])[A-Za-z]:\\/, label: 'Windows 路径', kind: 'path', verifiable: true },
  { pattern: /(?:^|[\s("'`])(?:\.{0,2}\/)[\w.-]+\//, label: '文件路径', kind: 'path', verifiable: true },
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
   * 行号依赖被引用的文件存在，所以归入可核验类：`verifyArtifact` 拿到的候选是
   * 被引用的文件名，存在才算数。
   */
  {
    pattern:
      /#L\d+|\bline\s*\d+\b|\b[\w.-]+\.(?:ts|tsx|js|mjs|cjs|json|md|yml|yaml|toml|ini|py|go|rs|java|kt|sql|sh|ps1|css|html|txt|csv):\d+\b/,
    label: '行号',
    kind: 'line',
    verifiable: true,
  },
  {
    pattern:
      /\b[\w.-]+\.(?:ts|tsx|js|mjs|cjs|json|md|yml|yaml|toml|ini|py|go|rs|java|kt|sql|sh|ps1|css|html|txt|csv)\b/,
    label: '文件名',
    kind: 'path',
    verifiable: true,
  },
  { pattern: /https?:\/\/\S+/, label: 'URL', kind: 'url', verifiable: false },
  /**
   * 提交哈希。**不能用裸 `\b[0-9a-f]{7,40}\b`**：UUID 的每一段（8 位十六进制）
   * 都符合，于是任何自动生成的 `session:<uuid>` 溯源都会命中——实测就是这样
   * 把一句"今天感觉还不错"当成"命中提交哈希"收进来的。
   *
   * 而且**形态上无法区分**裸短哈希与标识符片段：
   * `a1b2c3d4`（短哈希）与 `mem_muhg9mlv_1_3c6bf8ae` 的尾段长得一模一样。
   * 所以短哈希一律要求**显式语境**；只有 ≥12 位才认裸写。
   */
  {
    pattern:
      /\b[0-9a-f]{40}\b|\b(?:commit|hash|sha|revision)\W{0,3}[0-9a-f]{7,40}\b|@[0-9a-f]{7,40}\b|\b[0-9a-f]{12,40}\b/i,
    label: '提交哈希',
    kind: 'hash',
    verifiable: false,
  },
  { pattern: /\bv?\d+\.\d+(?:\.\d+)*\b/, label: '版本号', kind: 'version', verifiable: false },
  {
    pattern:
      /\b(?:pnpm|npm|yarn|npx|node|git|docker|kubectl|curl|cargo|go|python|pip|pytest|tsc|vitest|eslint|make)\b\s+[\w./-]+/,
    label: '可复现命令',
    kind: 'command',
    verifiable: false,
  },
]

/**
 * 回顾体护栏（3.7-M4）。
 *
 * ## 为什么需要它
 *
 * 实测：用户库 16 条里 12 条是 `asserted_by=model` 的**会话回顾/自检记录**
 * （"本会话完成了…"、"自检标记…"），项目库 3/3 条是 `execution:` 回顾体。
 * 它们能进库是因为正文里顺手提到了几个**真实存在的**文件路径——工件核验通过，
 * 但核验通过的是"提到了这个工件"，不是"这条陈述是项目知识"。
 *
 * ## 判据（三个条件同时成立，宁可漏判不可错杀）
 *
 * ① 长度 > `RECAP_MIN_CHARS`（240）：短结论才是记忆该有的形状；
 * ② 正文里出现 ≥ `RECAP_MIN_PATHS`（3）个**不同**路径/文件名；
 * ③ 出现总结词（本会话/本轮/回顾/完成/总结）。
 *
 * 命中后**不弃权**（它仍可能是有价值的经验），而是**改路由**：
 * 强制 `episodic` + 项目库；只有调用方同时显式给 `kind:'semantic'` 与
 * `scope:'user'` 才允许进用户库（"写错"比"少写"难回收——用户库是跨项目的）。
 */
export const RECAP_MIN_CHARS = 240
export const RECAP_MIN_PATHS = 3
const RECAP_MARKERS: readonly string[] = ['本会话', '本轮', '回顾', '完成', '总结']
const RECAP_PATH_PATTERNS: readonly RegExp[] = [
  // Windows 绝对路径
  /[A-Za-z]:\\[^\s"'`）)，,。；;]+/g,
  // 相对路径（至少两级）
  /(?:\.{0,2}\/)[\w.@-]+(?:\/[\w.@-]+)+/g,
  // 裸文件名（与 ARTIFACT_MARKERS 的扩展名表同源）
  /\b[\w.-]+\.(?:ts|tsx|js|mjs|cjs|json|md|yml|yaml|toml|ini|py|go|rs|java|kt|sql|sh|ps1|css|html|txt|csv)\b/g,
]

/** 这条文本像不像"会话回顾体"（纯函数，**不做 I/O**）。 */
export function looksLikeRecap(text: string): boolean {
  if (typeof text !== 'string' || text.length <= RECAP_MIN_CHARS) return false
  const paths = new Set<string>()
  for (const pattern of RECAP_PATH_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const value = match[0]
      if (value.length > 0) paths.add(value)
    }
  }
  if (paths.size < RECAP_MIN_PATHS) return false
  return RECAP_MARKERS.some(marker => text.includes(marker))
}

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
 * 知识生命周期（v4.5.3，七点审查第 6 点）。
 *
 * 层级不是重点，**层级之间不能自动晋升**才是：
 * - `event`：原始事件（`episodic`）——一次调用/一次观察，永远可以记录；
 * - `confirmed`：可核对的结论/偏好（`semantic`）——需要用户陈述、可复现工件或执行台账；
 *   纯模型推断没有 ground，连准入都过不了；
 * - `experience`：可复用做法（`procedural`）——当前只允许用户显式陈述。
 *
 * 本函数只拦**一个明确会出错的晋升**：执行结果确认（`execution-confirmed`）只能证明
 * "这次发生了什么"，不能证明"以后都这样"，因此不能直接成为可复用经验。
 * 被拦下的条目不会丢弃，而是降级为 `episodic` 事件并给出可读原因——
 * 保留事实，不保留未经确认的层级。
 */
export type { LifecycleStage } from './lifecycle.js'

export interface LifecycleDecision {
  readonly kind: MemoryKind
  readonly stage: LifecycleStage
  /** 被降级前的 kind；未降级为 undefined。 */
  readonly downgradedFrom?: MemoryKind
  /** 未降级为 null。 */
  readonly reason: string | null
}

export function decideLifecycle(input: {
  readonly kind: MemoryKind
  readonly ground: AdmissionGround
}): LifecycleDecision {
  // 只拦"一次执行 → 可复用经验"这一条自动晋升。
  // `semantic` 不走这条：执行台账是它的准入依据之一（例如"实测更正"），
  // 而纯模型推断根本没有 ground，连准入都过不了。
  if (input.ground === 'execution-confirmed' && input.kind === 'procedural') {
    return {
      kind: 'episodic',
      stage: 'event',
      downgradedFrom: input.kind,
      reason:
        '生命周期护栏：执行结果确认只能证明"这次发生了什么"，不足以直接成为可复用经验；'
        + '先按事件记录，待用户确认或重复验证后再升级。',
    }
  }
  const assertedBy = input.ground === 'user-declared'
    ? 'user'
    : input.ground === 'execution-confirmed'
      ? 'execution'
      : 'model'
  return {
    kind: input.kind,
    stage: stageOfMemory({ kind: input.kind, assertedBy }),
    reason: null,
  }
}

/**
 * 准入启发式（**纯函数**，规划 §5.6）：写，当且仅当
 * ① 用户显式陈述（且能在会话用户消息里核对到，或明确记为"自报未核对"）
 * ② 可由具体工件复现（路径/命令/URL/哈希/版本号，可核验类别要真的核验通过）
 * ③ 被执行结果确认（**本会话真实执行台账命中**，由调用方给 `executionConfirmed`）
 * 否则**弃权**并给出可读原因 + 可计数的 `category`。
 */
export function decideAdmission(input: AdmissionInput): AdmissionDecision {
  const text = typeof input.text === 'string' ? input.text : ''
  const trimmed = text.trim()

  if (trimmed.length === 0) return { ok: false, reason: '内容为空：没有可写入的陈述', category: 'empty' }
  if (!hasReadableContent(trimmed)) {
    return { ok: false, reason: '内容不含任何文字或数字：无法成为一条可检索、可核对的记忆', category: 'no-content' }
  }
  if (trimmed.length < MIN_TEXT_CHARS) {
    return {
      ok: false,
      reason: `内容过短（${trimmed.length} < ${MIN_TEXT_CHARS} 字符）：太短的内容无法成为可核对的事实`,
      category: 'too-short',
    }
  }
  if (trimmed.length > MAX_TEXT_CHARS) {
    return {
      ok: false,
      reason: `内容过长（${trimmed.length} > ${MAX_TEXT_CHARS} 字符）：逐字原文适合短陈述；长内容请落到制品索引，避免一条巨块污染召回`,
      category: 'too-long',
    }
  }
  if (typeof input.sourceRef !== 'string' || input.sourceRef.length === 0) {
    return {
      ok: false,
      reason: '缺少来源引用（source_ref 非空是投毒防御与证据独立的必要条件，§5.2）',
      category: 'missing-source',
    }
  }
  if (isReservedSource(input.sourceRef)) {
    return {
      ok: false,
      reason: `来源前缀 ${RESERVED_SOURCE_PREFIX} 保留给"单文档结构化状态"（画像一类）：它不是经验痕迹，请由对应模块写入`,
      category: 'reserved-source',
    }
  }
  // 凭据形态一律拒：记忆库是**明文 SQLite**，"先存后删"不构成保护
  // （WAL/备份/历史读都可能留痕）。自主捕获走同一张模式表（`capture.ts`）。
  if (hasSecret(trimmed) || hasSecret(input.sourceRef)) {
    return {
      ok: false,
      reason: '正文或来源含凭据形态（密钥/令牌/私钥/明文口令）：记忆库不存凭据，请改用环境变量或密钥管理',
      category: 'secret',
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

  // ③ 被执行结果确认（**真实台账命中**，3.7-M4）
  //
  // 旧实现按 `sourceRef` 前缀（`execution:` / `test:` …）判——那是模型自己写的字符串，
  // 等于自签合格证。现在只认 `SessionWitnessPort.hasExecution` 的结论：
  // 调用方把命中的布尔值放进 `executionConfirmed`，纯函数不做 I/O。
  if (input.executionConfirmed === true) {
    return {
      ok: true,
      ground: 'execution-confirmed',
      // 这次**真的**有执行轨迹（见 `SessionWitnessPort.hasExecution`），
      // 因此写 `execution` 是如实溯源，而不是旧实现里那个保守的 `model`。
      assertedBy: 'execution',
      verification: 'not-user',
      reason: '可由执行结果确认（本会话真实执行台账命中，见 sourceRef）',
    }
  }

  // ② 可由具体工件复现
  //
  // **只看正文**，不看 `sourceRef`：`sourceRef` 是溯源（这条从哪来），不是
  // 可复现工件（这条凭什么能被验证）。把它算进判据，等于让工具用自己自动生成的
  // `session:<uuid>#turn-N` 给自己发合格证——实测就是这样把一句模糊感想收下的
  // （UUID 的一段 8 位十六进制命中了"提交哈希"）。
  //
  // **可核验的类别必须真的核验通过**。只做形态匹配时，编造的文件名与真实文件名
  // 得到同一个结论——自检报告的负对照当场打穿（`does-not-exist-9f3a.json` 被收下）。
  // 那时"可复现"只是措辞。
  for (const candidate of ARTIFACT_MARKERS) {
    const hit = candidate.pattern.exec(trimmed)
    if (hit === null) continue

    if (!candidate.verifiable) {
      // 命令/版本号/哈希/URL：不是"存在性"声明，无法也无需核验文件系统。
      return {
        ok: true,
        ground: 'reproducible-artifact',
        assertedBy: 'model',
        verification: 'not-user',
        reason: `可由具体工件复现（命中${candidate.label}）`,
      }
    }

    const probe = input.verifyArtifact
    const verified = probe === undefined ? undefined : probe(hit[0], candidate.kind)
    if (verified === true) {
      return {
        ok: true,
        ground: 'reproducible-artifact',
        assertedBy: 'model',
        verification: 'not-user',
        reason: `可由具体工件复现（${candidate.label} ${hit[0]} 已核验存在）`,
      }
    }
    // **核验不过或核验不了，就换下一个类别**：正文里可能同时出现一个编造的文件名
    // 与一个真实的 URL。全部都不成立时才弃权。
    //
    // 这里**不**因为"看到了文件名却不存在"就直接判否：文本里出现一个假文件名
    // 不等于整条陈述是假的。但**它绝不能成为准入依据**——这正是原来的漏洞。
  }

  // ②b `sourceRef` **显式给出且指向真实工件**时，它本身就是溯源依据。
  //
  // 这条补的是一个真实的操作摩擦：用户按工具描述给出
  // `sourceRef=D:\...\build-generation.json`，正文里没有任何工件形态，
  // 于是被拒——而那个文件**确实存在**，溯源是成立的。
  //
  // 与 ② 的分工很关键：② 看**正文**（陈述自己说了什么工件），这里看**来源**
  // （这条陈述是从哪来的）。两者都要求"真实存在"，所以都不会被编造的字符串骗过。
  // 注意**只认调用方显式给的**：工具自动生成的 `session:<uuid>#turn-N` 不是工件，
  // 把它算进来就是让工具给自己发合格证（那个漏洞修过，见 ARTIFACT_MARKERS 注释）。
  if (input.sourceRefExplicit === true) {
    const probe = input.verifyArtifact
    const verified = probe === undefined ? undefined : probe(input.sourceRef, 'path')
    if (verified === true) {
      return {
        ok: true,
        ground: 'reproducible-artifact',
        assertedBy: 'model',
        verification: 'not-user',
        reason: `可由具体工件复现（来源 ${input.sourceRef} 已核验存在）`,
      }
    }
  }

  if (input.claimedUserAssertion) {
    return {
      ok: false,
      category: 'user-claim-unverified',
      reason:
        '自称用户陈述但无法在会话的用户消息里核对到原话，且看不出可由具体工件复现或被执行结果确认——' +
        '弃权（自报不能用来取得 user 来源等级，§5.8 的等级差是结构性的）',
    }
  }

  return {
    ok: false,
    category: 'no-ground',
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
    .describe('逐字原文/结论；不要转述或摘要'),
  kind: z
    .enum(['episodic', 'semantic', 'procedural'])
    .describe('episodic=情境；semantic=结论/偏好；procedural=做法。决定落库。'),
  scope: z
    .enum(['user', 'project'])
    .optional()
    .describe('覆盖落库位置；省略按 kind 路由（semantic→用户库，其余→项目库）'),
  sourceRef: z
    .string()
    .optional()
    .describe('来源引用（会话/轮次/文件/命令）；省略用当前会话与回合号'),
  userAsserted: z
    .boolean()
    .optional()
    .describe('仅当用户原话时 true'),
  supersedes: z
    .array(z.string().min(1))
    .max(MAX_SUPERSEDE_TARGETS)
    .optional()
    .describe(
      `本条目取代的旧记忆 id（最多 ${MAX_SUPERSEDE_TARGETS} 条；id 见 omb_recall/omb_relate 溯源行）。` +
        '仅当旧结论已被新证据或实测推翻时给；会标旧条目为"已被取代"并建 supersedes 边（非破坏性、历史可查）。',
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
  /**
   * 找不到这条 id。**只在两个作用域都真的查过之后才会出现**（见 `findSupersedeTarget`）：
   * 少查一个库就报 missing，等于把"我没看"说成"它不存在"——回执给的理由会全是假的。
   */
  | 'missing'
  /** 没做成。**新条目已写入**；"没做成"发生在哪一步决定旧条目当前是否仍会被注入（见 `stage`）。 */
  | 'failed'

/**
 * 失败发生在哪一步。**它决定回执能对"旧条目现在是否仍会被注入召回"说什么**：
 *
 * - `lookup`：这条 id **根本没查全**（库没打开、或查询抛错）→ 状态未知，
 *   既不能说它仍有效、也不能说已标掉，回执必须如实说"无法确认"；
 * - `mark`：查到了，但 `validTo`/`supersededBy` 没写成 → 它**仍会**作为有效结论注入；
 * - `edge`：标注已写成，只有 `supersedes` 边没建成 → 它**已不会**再被注入；
 *   缺的只是 `omb_relate` 能走的那一跳（追溯历史痕迹），不是"当前结论对不对"。
 *
 * 为什么必须分档：把三种失败压成一句"这些旧条目没有被标为已推翻"，
 * 对 `edge` 那一类恰好说反——同一份回执的 detail 还会自相矛盾（M4）。
 */
export type SupersedeStage = 'lookup' | 'mark' | 'edge'

interface SupersedeEntryBase {
  readonly id: string
  /** `already-superseded` 时是既有的取代者 id；`failed` 时是失败原因。 */
  readonly detail?: string
}

/**
 * 判别式联合而不是可选字段：**`failed` 必须带 `stage`**，
 * 这样"没分档的失败"在类型层就不可能出现（宁编译不过，不要回执说谎）。
 */
export type SupersedeEntry =
  | (SupersedeEntryBase & { readonly status: 'superseded' | 'already-superseded' | 'missing' })
  | (SupersedeEntryBase & { readonly status: 'failed'; readonly stage: SupersedeStage })

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
  /**
   * 回顾体护栏改变了路由（3.7-M4）。
   *
   * 回执必须说清"你写的是 semantic/user，实际落的是 episodic/project"——
   * 静默改路由比拒绝更坏：调用方会以为用户库里有了这条偏好。
   */
  readonly routing?: {
    readonly reason: string
    readonly requestedKind: MemoryKind
    readonly requestedScope: MemoryScope
    readonly kind: MemoryKind
    readonly scope: MemoryScope
  }
}

export interface MemoryWriteDeps {
  /**
   * 解析目标库。**可异步**：写入路径允许等库打开（读路径不行，它有延迟预算）。
   * 未就绪返回 undefined（**不抛**），工具据此给出可读错误。
   *
   * `sessionId` 是**本次调用**的会话（`ToolCallContext.sessionId`，归属确定时才有）：
   * 没有会话 → 调用方只给用户库，不猜"最近一个会话"的项目库。
   *
   * `supersedes` 的旧条目可能在**另一个库**（如新条目落用户库、旧结论在项目库），
   * 因此本函数会被按两个作用域各问一次；实现必须能对任一作用域给出句柄或 undefined。
   *
   * ⚠️ 调用方**必须**把本次调用的 `sessionId` 一起传下来：真实实现
   * （`modules/memory/index.ts`）在 `sessionId === undefined` 时只解析得用户库，
   * 传丢了会话就等于第二个作用域永远打不开——那会让"跨库取代"永远报 missing（M2）。
   * 拿不到句柄时回执说"无法确认"（不猜），见 `findSupersedeTarget` 的判据。
   */
  readonly resolveStore: (scope: MemoryScope, sessionId?: string) => Promise<MemoryStore | undefined>
  /** 时钟。模块层不读墙钟，一律由 `dsh/` 传 `kernel.clock`。 */
  readonly clock: Clock
  /** 某会话的回合号；用于默认 `sourceRef`（拿不到就退化成 `session:<id>`）。 */
  readonly currentTurn?: (sessionId?: string) => number | undefined
  /**
   * 会话里最近一条用户消息（宿主能力可得时提供；缺省即"自报未核对"）。
   *
   * 3.7-M4 起优先用 `witness()` 的 `lastUserMessage`（按会话取）；
   * 本字段保留给只有单会话读数的旧装配/测试。
   */
  readonly lastUserMessage?: () => string | undefined
  /**
   * **会话见证**（3.7-M4）：`userAsserted` 核对与 `execution-confirmed` 的唯一来源。
   *
   * 生产里由 `modules/memory/index.ts` 惰性解析内核服务
   * `SessionWitnessPort`（服务名 `omb:session-witness`，见 `./witness.js`）；
   * 拿不到（单测、旧装配、宿主未接线）→ 退化为旧行为：
   * - 用户陈述只能记成 `claimed-unverified`；
   * - 执行依据一律不成立（比"自签合格证"更安全的方向）。
   */
  readonly witness?: () => SessionWitnessPort | undefined
  /**
   * 写入成功后的附加索引（3.7 Wave 2：图自动连边）。
   *
   * 在 `put` 成功之后、回执之前调用；**失败不影响"已写入"**（由调用方隔离）。
   */
  readonly onStored?: (store: MemoryStore, record: MemoryRecord) => Promise<void>
  /** 可读日志口（附加索引失败时留声；缺省不日志）。 */
  readonly logger?: { warn(message: string): void }
  /** 某会话的项目身份（cwd 的规范化形式），作为 `project` 溯源写入。 */
  readonly currentProject?: (sessionId?: string) => string | undefined
  /**
   * **工件存在性核验**（准入判据的"可复现"靠它）。
   *
   * 判据自己做不了这件事：它是纯函数，不碰文件系统。而只做形态匹配的后果实测过——
   * `does-not-exist-9f3a.json` 这种编造的文件名与真实文件名得到同一个准入结论，
   * 字段却叫 `reproducible-artifact`。
   *
   * `sessionId` 是本次调用的会话：核验基准目录应当是**这个会话**的 cwd，
   * 而不是别的会话的（拿错 cwd 只会让核验更保守：判成不存在 → 不算依据）。
   *
   * 缺省时**文件类工件一律不算依据**（fail closed）：宁可让用户补一个可核验的引用，
   * 也不要收下一条引用不存在工件的事实。
   */
  readonly verifyArtifact?: (candidate: string, kind: ArtifactKind, sessionId?: string) => boolean | undefined
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
  readonly onAbstained?: (info: {
    readonly reason: string
    readonly text: string
    /** 弃权分档（3.7-M4）；健康面按它计数。 */
    readonly category: AbstentionCategory
  }) => void
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
 *
 * 反过来同样成立（M4）：**"标注已写成、只有边失败"也绝不能写成"没有被标为已推翻"**。
 * 所以失败的断言按 `stage` 分三档说，每档都只说自己知道的那部分：
 * `lookup` = 没查全（状态未知，两个方向都不许断言）、`mark` = 仍会注入、
 * `edge` = 不再注入、只是追不到那一跳。
 */
function renderSupersede(report: SupersedeReport): readonly string[] {
  const marked = report.entries.filter(entry => entry.status === 'superseded')
  const already = report.entries.filter(entry => entry.status === 'already-superseded')
  const missing = report.entries.filter(entry => entry.status === 'missing')
  const failed = report.entries.filter(entry => entry.status === 'failed')
  const unknown = failed.filter(entry => entry.stage === 'lookup')
  const unmarked = failed.filter(entry => entry.stage === 'mark')
  const edgesOnly = failed.filter(entry => entry.stage === 'edge')
  const detailOf = (entry: SupersedeEntry): string => entry.detail ?? '未知原因'
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
        '（用户库与项目库都查过了：id 拼错，或已被隐私擦除）',
    )
  }
  if (unknown.length > 0) {
    lines.push(
      `推翻标注：无法确认 ${unknown.length} 条（这次**没能查全**它们可能所在的库，` +
        `所以既不能说它们仍会作为有效结论注入，也不能说已被标掉）：` +
        unknown.map(entry => `${entry.id}（${detailOf(entry)}）`).join('、'),
    )
  }
  if (unmarked.length > 0) {
    lines.push(
      `推翻标注**未完成** ${unmarked.length} 条（新条目已写入，但这些旧条目没有被标为已推翻——` +
        `**它们仍会作为有效结论注入召回**）：${unmarked.map(entry => `${entry.id}（${detailOf(entry)}）`).join('、')}`,
    )
  }
  if (edgesOnly.length > 0) {
    lines.push(
      `推翻标注：${edgesOnly.length} 条旧条目已标为"被本条取代"（新条目已写入；**已不再作为有效结论注入召回**），` +
        `但 supersedes 边未建成——omb_relate 追不到这一跳：` +
        edgesOnly.map(entry => `${entry.id}（${detailOf(entry)}）`).join('、'),
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
  if (outcome.routing !== undefined) {
    // 护栏改了路由就必须在回执里说清：调用方按 semantic/user 写的，实际进了 episodic/project。
    lines.push(`⚠ 路由已调整：${outcome.routing.reason}`)
    lines.push(
      `   请求 ${outcome.routing.requestedKind}/${outcome.routing.requestedScope}` +
        ` → 实际 ${outcome.routing.kind}/${outcome.routing.scope}`,
    )
  }
  if (outcome.text !== undefined) lines.push(...echoLines(outcome.text, outcome.contentHash))
  if (outcome.supersede !== undefined) lines.push(...renderSupersede(outcome.supersede))
  return lines.join('\n')
}

/**
 * 同内容去重的回执（v4.8.0）。
 *
 * 必须在回执里给出**已存在条目的 id 与阶段**：只说"重复了"会让调用方无从判断
 * 该改为 supersedes、该请用户确认，还是该放弃——那等于把去重变成一条静默丢失。
 */
export function renderDuplicateRemember(input: { readonly duplicate: MemoryRecord }): string {
  const { duplicate } = input
  const stage = stageOfMemory({ kind: duplicate.kind, assertedBy: duplicate.assertedBy })
  const excerpt = duplicate.text.length > 120
    ? `${duplicate.text.slice(0, 120)}…（共 ${duplicate.text.length} 字符）`
    : duplicate.text
  const lines = [
    `未写入：库中已有同内容条目 id=${duplicate.id}（${duplicate.scope}/${duplicate.kind} · 阶段 ${stageLabel(stage)}）。`,
    `原文：${excerpt}`,
  ]
  if (stage === 'candidate') {
    lines.push(`这条目前是"候选"：用户可用 /omb-confirm ${duplicate.id} 确认；模型不能自行确认。`)
  }
  lines.push('重复写入不会新增条目；若要更正内容，请用 supersedes 指向这个 id。')
  return lines.join('\n')
}

// ────────────────────────────────────────────────────────────────────────────
// 推翻标注（supersedes）
// ────────────────────────────────────────────────────────────────────────────

/**
 * 旧条目在哪：三态而不是 `undefined | MemoryRecord`——"查库失败"与"没有这条"必须分开。
 *
 * `missing` 的语义被收紧成**"两个作用域都真的查过、都没有"**：
 * 另一个库没打开（或拿不到句柄）时只能说 `error`（回执渲染成"无法确认"）。
 * 把"我没查"说成"它不存在"会让回执给出的三个理由全是假的（M2 的真机后果）。
 */
type SupersedeLookup =
  | { readonly kind: 'found'; readonly store: MemoryStore; readonly record: MemoryRecord }
  | { readonly kind: 'missing' }
  | { readonly kind: 'error'; readonly reason: string }

/** 作用域的中文名。回执要指名道姓地说"哪个库没查到/没查过"。 */
function scopeLabel(scope: MemoryScope): string {
  return scope === 'user' ? '用户库' : '项目库'
}

/**
 * 找一条旧记忆：先在新条目所在的库找，再问另一个作用域。
 *
 * 为什么允许跨库：结论按 kind 路由（semantic→用户库、episodic/procedural→项目库），
 * 而"这条结论被推翻"完全可能跨库发生（项目里实测推翻了用户库里记下的偏好）。
 *
 * **判据：只有两个作用域都真的查过，才允许返回 missing。**
 * 另一个库的门必须用**本次调用的 `sessionId`** 去开：`resolveStore('project', undefined)`
 * 在真实实现（`index.ts`）里只会拿到 userOnlySet → 恒 undefined，
 * 于是"新条目落用户库、旧结论在项目库"这个方向**永远报 missing**（M2）。
 * 而 missing 的三条理由全是假的，库里 validTo/supersededBy 一个字没改——
 * 被推翻的结论继续作为有效结论注入召回。找不到就如实报，不猜：
 * 没查过的库只能报"无法确认"。
 */
async function findSupersedeTarget(
  deps: MemoryWriteDeps,
  primary: MemoryStore,
  id: string,
  sessionId: string | undefined,
): Promise<SupersedeLookup> {
  const otherScope: MemoryScope = primary.scope === 'user' ? 'project' : 'user'
  const failures: string[] = []

  // ① 先在新条目自己的库里找（这也是唯一一个不依赖 sessionId 的库）
  try {
    const record = await primary.get(id)
    if (record !== undefined) return { kind: 'found', store: primary, record }
  } catch (error) {
    failures.push(`${scopeLabel(primary.scope)}查询失败（${messageOf(error)}）`)
  }

  // ② 再问另一个作用域。**必须带上本次调用的会话**，否则拿不到项目库。
  let other: MemoryStore | undefined
  try {
    other = await deps.resolveStore(otherScope, sessionId)
  } catch (error) {
    failures.push(`${scopeLabel(otherScope)}解析失败（${messageOf(error)}）`)
  }

  if (other !== undefined && other !== primary) {
    try {
      const record = await other.get(id)
      if (record !== undefined) return { kind: 'found', store: other, record }
    } catch (error) {
      failures.push(`${scopeLabel(otherScope)}查询失败（${messageOf(error)}）`)
    }
    // 两个作用域都真的查过了，才允许说"没有这条"
    return failures.length > 0 ? { kind: 'error', reason: failures.join('；') } : { kind: 'missing' }
  }

  // ③ 另一个库没拿到句柄（或解析回了同一个实例）→ 这个作用域**根本没查过**
  failures.push(
    other === primary
      ? `${scopeLabel(otherScope)}解析回了同一个库实例，第二个作用域没有被真正查询`
      : `${scopeLabel(otherScope)}尚未打开（本次调用${
          sessionId === undefined ? '没有会话归属' : `的会话 ${sessionId} 下解析不到它`
        }），该作用域没有被查询`,
  )
  return { kind: 'error', reason: failures.join('；') }
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
 * 任何一条失败都不影响新条目已写入这个事实，但结果必须如实回执——
 * 而且要说清失败**发生在哪一步**（`stage`），否则回执对"旧条目现在还回不回被注入"
 * 的断言会与库里的实际值相反（M4）。
 *
 * `sessionId` 是**本次调用**的会话：跨库找旧条目必须用它去开另一个库的门
 * （真实实现里 `resolveStore('project', undefined)` 恒拿不到项目库，见 `findSupersedeTarget`）。
 */
async function applySupersedes(
  deps: MemoryWriteDeps,
  primary: MemoryStore,
  requested: readonly string[],
  record: MemoryRecord,
  now: number,
  sessionId: string | undefined,
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
      entries.push({
        id,
        status: 'failed',
        stage: 'mark',
        detail: '目标 id 与本条新记录相同，不能自己取代自己（它仍是有效结论）',
      })
      continue
    }
    const lookup = await findSupersedeTarget(deps, primary, id, sessionId)
    if (lookup.kind === 'missing') {
      entries.push({ id, status: 'missing' })
      continue
    }
    if (lookup.kind === 'error') {
      // 没查全：库里什么都没改，但"它现在是否仍会被注入"**未知**——交给渲染层说"无法确认"
      entries.push({ id, status: 'failed', stage: 'lookup', detail: lookup.reason })
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
          stage: 'edge',
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
      // 查到但没标上 → 它**仍会**作为有效结论注入（stage: 'mark'）
      entries.push({ id, status: 'failed', stage: 'mark', detail: `标注旧条目失败：${messageOf(error)}` })
      continue
    }

    const edgeError = await linkSupersedes(lookup.store, record.id, target.id, now)
    const crossError = crossStore === undefined ? undefined : await linkSupersedes(crossStore, record.id, target.id, now)
    const problem = edgeError ?? crossError
    if (problem !== undefined) {
      // 标注已写成 → 它**已不会**再被注入；缺的只是可追溯的那条边（stage: 'edge'）
      entries.push({ id, status: 'failed', stage: 'edge', detail: `旧条目已标为被取代，但 supersedes 边写入失败：${problem}` })
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
      '用户表达长期偏好/决定、纠正旧结论、或你得到可复用结论时**主动调用**，不要等用户提醒。'
      + '将值得记住的内容写入记忆库（逐字原文+溯源）。仅在满足准入时写入：用户原话、可由工件（文件/命令/URL/提交）复现的事实、'
      + '或执行结果确认的结论；模糊印象会被拒绝并给出原因。纠正旧结论时先 omb_recall 查到旧 id，再用 supersedes 标注。即时生效。',
    parameters,

    async execute(args: unknown, call?: ToolCallContext): Promise<ToolOutcome> {
      try {
        const parsed = rememberArgsSchema.safeParse(args)
        if (!parsed.success) {
          return { kind: 'error', text: `omb_remember 参数非法：${parsed.error.issues.map(i => i.message).join('；')}` }
        }
        const input = parsed.data
        /**
         * **本次调用**的会话（宿主 `exec.agent` → `ToolCallContext`）。
         *
         * 归属不确定时是 `undefined`：此时默认 `sourceRef` 也拿不到，
         * 准入会如实弃权（"缺少来源引用"）——**不编造**一个别的会话的溯源。
         */
        const sessionId = call?.attribution === 'session' ? call.sessionId : undefined

        /**
         * **见证服务**（3.7-M4）：每次执行惰性解析，拿不到就退化为旧行为。
         *
         * 只解析一次：`lastUserMessage` 与 `hasExecution` 必须看**同一时刻**的见证，
         * 否则两次调用之间刚好来了新消息，会让"核对"与"执行确认"互相矛盾。
         */
        let witness: SessionWitnessPort | undefined
        try {
          witness = deps.witness?.()
        } catch {
          witness = undefined
        }

        const sourceRef = input.sourceRef ?? defaultSourceRef(sessionId, deps.currentTurn?.(sessionId))
        // 用户消息：见证优先（按会话取），旧字段兜底（单会话装配/测试）
        const userMessage = (sessionId === undefined ? undefined : witness?.lastUserMessage(sessionId)) ?? deps.lastUserMessage?.()
        // 执行确认：只有真实台账命中才算（sourceRef 是"要确认的那条轨迹"）
        let executionConfirmed = false
        if (sessionId !== undefined && sourceRef !== undefined && witness !== undefined) {
          try {
            executionConfirmed = witness.hasExecution(sessionId, sourceRef) === true
          } catch {
            executionConfirmed = false
          }
        }
        const decision = decideAdmission({
          text: input.text,
          sourceRef: sourceRef ?? '',
          claimedUserAssertion: input.userAsserted === true,
          ...(userMessage === undefined ? {} : { userMessage }),
          ...(executionConfirmed ? { executionConfirmed: true } : {}),
          // 核验基准目录用**本次调用的会话**（判据本身不变，只是把会话传进去）
          ...(deps.verifyArtifact === undefined
            ? {}
            : {
                verifyArtifact: (candidate: string, kind: ArtifactKind) =>
                  deps.verifyArtifact?.(candidate, kind, sessionId),
              }),
          // 自动生成的来源（`session:<uuid>#turn-N`）不算工件；显式给的才算。
          sourceRefExplicit: input.sourceRef !== undefined && input.sourceRef.length > 0,
        })

        if (!decision.ok) {
          try {
            deps.onAbstained?.({ reason: decision.reason, text: input.text, category: decision.category })
          } catch {
            // 记账失败不得改变"没写入"这个结论
          }
          return { kind: 'text', text: renderRemember({ written: false, reason: decision.reason }) }
        }

        /**
         * **生命周期护栏**（v4.5.3）：执行结果确认不能直接晋升为结论/经验。
         * 拦下时降级为事件（不丢事实），回执说明为什么没有按请求的 kind 落库。
         */
        const lifecycle = decideLifecycle({ kind: input.kind, ground: decision.ground })
        const requestedScope: MemoryScope = input.scope ?? SCOPE_BY_KIND[lifecycle.kind]
        const lifecycleRouting = lifecycle.reason === null
          ? undefined
          : {
              reason: lifecycle.reason,
              requestedKind: input.kind,
              requestedScope: input.scope ?? SCOPE_BY_KIND[input.kind],
              kind: lifecycle.kind,
              scope: input.scope ?? SCOPE_BY_KIND[lifecycle.kind],
            }

        /**
         * **回顾体护栏**（3.7-M4）：命中则不写进用户库。
         *
         * 只在调用方**没有同时显式**给 `kind:'semantic'` + `scope:'user'` 时改路由：
         * 两个都写出来是一次"我知道我在做什么"的显式声明，护栏不再覆盖它。
         */
        const recap = looksLikeRecap(input.text)
        const explicitUserSemantic = lifecycle.kind === 'semantic' && input.scope === 'user'
        const recapRouting = recap && !explicitUserSemantic
          ? {
              reason:
                `回顾体护栏：正文 ${input.text.length} 字符（>${RECAP_MIN_CHARS}）、`
                + '含 ≥3 个不同路径且出现总结词——按经验（episodic）落项目库，不进跨项目用户库。'
                + '若这确是用户级结论，请显式同时给 kind:"semantic" 与 scope:"user"。',
              requestedKind: lifecycle.kind,
              requestedScope,
              kind: 'episodic' as MemoryKind,
              scope: 'project' as MemoryScope,
            }
          : undefined
        const routing = recapRouting ?? lifecycleRouting
        const kind: MemoryKind = routing?.kind ?? lifecycle.kind
        const scope: MemoryScope = routing?.scope ?? requestedScope

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

        const store = await deps.resolveStore(scope, sessionId)
        if (store === undefined) {
          const why = deps.degradeReason?.()
          return {
            kind: 'error',
            text: `omb_remember 无法写入：${scope === 'user' ? '用户库' : '项目库'}尚未就绪${
              why === undefined ? '' : `——${why}`
            }`,
          }
        }

        /**
         * **跨路径同内容去重**（v4.8.0）。
         *
         * 控制器自动写入、重复捕获、模型主动写入走的是同一条库；库按 id upsert 但
         * 没有正文唯一约束，同一条内容会变成多条记录。命中时**不写、不触发向量事件**，
         * 回执给出已存在条目的 id 与阶段（候选还会附上 `/omb-confirm` 用法）。
         *
         * 放在准入之后：准入是"该不该记"的判断，去重是"是否已经记过"的事实；
         * 先准入再查重能保证弃权计数与既有权重逻辑完全不变。
         */
        const duplicate = await findSameContent(store, input.text)
        if (duplicate !== undefined) {
          return { kind: 'text', text: renderDuplicateRemember({ duplicate }) }
        }

        const now = deps.clock.now()
        const contentHash = contentHashOf(input.text)
        const record: MemoryRecord = {
          id: newMemoryId(deps.clock, contentHash),
          scope,
          kind,
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
          project: deps.currentProject?.(sessionId) ?? null,
        }

        await store.put(record)

        // 事件必须在 put **成功之后**发：失败的写入不该触发向量编码。
        // 订阅者的异常由事件总线隔离；这里再包一层，确保写入结果不被影响。
        try {
          deps.onWritten?.({ id: record.id, scope: record.scope, kind: record.kind })
        } catch {
          // 事件通道失败不改变"已写入"这个事实
        }
        // 自动连边（3.7 Wave 2）：附加索引，失败不影响写入结果
        try {
          await deps.onStored?.(store, record)
        } catch (error) {
          deps.logger?.warn?.(`OMB：自动连边失败（已隔离）——${messageOf(error)}`)
        }

        // 推翻标注在 put 成功**之后**做：标注一个不存在的取代者是没有意义的。
        // 标不出来也不影响"新条目已写入"，但结果必须原样进回执（见 renderSupersede）。
        const supersede =
          input.supersedes === undefined || input.supersedes.length === 0
            ? undefined
            : await applySupersedes(deps, store, input.supersedes, record, now, sessionId)

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
            ...(routing === undefined ? {} : { routing }),
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
