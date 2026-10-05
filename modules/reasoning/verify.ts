/**
 * **Verify** —— 控制环里此前缺的那一环（用户判断：已有 Act / Memory / Loop / Focus，"只差 Verify"）。
 *
 * 形态取舍（写在最前面，便于复核）：
 * - Verify 是**动作**，所以它落在一条工具调用上（`omb_verify`），而不是又一张规则卡。
 *   只加卡片等于把"验证"又变回一句要求模型自觉的话——这正是本次要改掉的。
 * - 判定做的是**形式核对**：来源能不能指出来、结论能不能被否证。
 *   它**不判断内容是否为真**——真值要靠核对该来源。回执与状态面都如实这么说，
 *   不允许把"形式可核对"写成"已证实"。
 * - 结果落**台账**（每会话），因此"本回合验证了几次 / 结果如何"在状态面可读，
 *   并驱动注入里的验证段（有未闭合项才出现，不是随档位出现的散文）。
 *
 * 纯函数、零 I/O、零 mock 可测。
 */
import type { FocusDepth } from '../../kernel/abi/index.js'

/** 形式核对的结论。 */
export type VerifyVerdict = 'checkable' | 'needs-evidence' | 'self-report' | 'needs-falsifier'

export const VERIFY_VERDICTS: readonly VerifyVerdict[] = [
  'checkable',
  'needs-evidence',
  'self-report',
  'needs-falsifier',
]

/** 证据的**形式**（能不能指出来源），与内容真值无关。 */
export type EvidenceForm = 'none' | 'citable' | 'uncited'

export interface VerifyRequest {
  readonly claim: string
  readonly evidence?: string
  readonly falsifier?: string
}

export interface VerifyJudgement {
  readonly verdict: VerifyVerdict
  /** 被核对的结论（逐字保留，便于状态面复盘）。 */
  readonly claim: string
  readonly evidenceForm: EvidenceForm
  /** 判定说明。 */
  readonly note: string
  /** 下一步动作（模型可执行）。 */
  readonly next: string
}

/**
 * 可核对来源的形式。**这是形式清单，不是真值判断**：
 * 命中只说明"指得出来源"，不说明来源支持该结论。
 */
const CITABLE_PATTERNS: readonly { readonly id: string; readonly re: RegExp }[] = [
  /** 文件 + 行号：`src/a.ts:42` */
  { id: 'file-line', re: /[\w./\\-]+\.[a-z0-9]{1,6}:\d+/i },
  /** 路径：至少一层目录分隔 */
  { id: 'path', re: /(?:^|[\s(（"'`])(?:[\w.@-]+[/\\])+[\w.@-]+/ },
  /** 命令：`$ cmd` / `> cmd` / 带 `--flag` */
  { id: 'command', re: /(?:^|\s)[$>]\s*\S|--[a-z][\w-]{1,}/i },
  /** 引用（用户原话）：成对引号包住 2 个字以上 */
  { id: 'quote', re: /[「『“"'][^」』”"']{2,}[」』”"']/ },
  /** 提交号 / 内容哈希 */
  { id: 'hash', re: /\b[0-9a-f]{7,40}\b/i },
  /** URL */
  { id: 'url', re: /https?:\/\/\S+/i },
]

/** 证据是否指得出可核对的来源（形式判断）。 */
export function isCitableEvidence(text: unknown): boolean {
  const value = typeof text === 'string' ? text.trim() : ''
  if (value === '') return false
  return CITABLE_PATTERNS.some(pattern => pattern.re.test(value))
}

export function evidenceFormOf(text: unknown): EvidenceForm {
  const value = typeof text === 'string' ? text.trim() : ''
  if (value === '') return 'none'
  return isCitableEvidence(value) ? 'citable' : 'uncited'
}

/**
 * 核对一条结论的形式。**永不抛**：任何畸形输入都落到 `needs-evidence` 并给出下一步。
 */
export function judgeClaim(request: VerifyRequest): VerifyJudgement {
  const claim = typeof request?.claim === 'string' ? request.claim.trim() : ''
  if (claim === '') {
    return {
      verdict: 'needs-evidence',
      claim: '',
      evidenceForm: 'none',
      note: '结论是空的，没有可核对的对象。',
      next: '用一句话写出要核对的结论，再给它的来源。',
    }
  }
  const form = evidenceFormOf(request?.evidence)
  if (form === 'none') {
    return {
      verdict: 'needs-evidence',
      claim,
      evidenceForm: 'none',
      note: '没说这条结论的来源。',
      next: '给出可核对的来源（文件行号、命令输出、用户原话、工件路径），或把这条标为待确认。',
    }
  }
  if (form === 'uncited') {
    return {
      verdict: 'self-report',
      claim,
      evidenceForm: 'uncited',
      note: '这条证据指不出来源，等于没有出处。',
      next: '补上出处（文件行号 / 命令输出 / 用户原话 / 工件路径），或把这条标为待确认。',
    }
  }
  const falsifier = typeof request?.falsifier === 'string' ? request.falsifier.trim() : ''
  if (falsifier === '') {
    return {
      verdict: 'needs-falsifier',
      claim,
      evidenceForm: 'citable',
      note: '来源指得出来，但没说"如果它错了会看到什么不一样"。',
      next: '补一句否证条件；补不出来就把结论降级为待确认，不要当断言用。',
    }
  }
  return {
    verdict: 'checkable',
    claim,
    evidenceForm: 'citable',
    note: `来源可查、否证条件已给：${truncate(falsifier, 40)}。这只说明形式可核对，不代表内容为真——真值要靠核对该来源。`,
    next: '可以把它当结论用；若来源核对不上，回来改成待确认。',
  }
}

export const VERDICT_TEXT: Readonly<Record<VerifyVerdict, string>> = {
  checkable: '形式可核对',
  'needs-evidence': '缺来源',
  'self-report': '来源指不出来',
  'needs-falsifier': '缺否证条件',
}

export interface VerifyRecord {
  readonly claim: string
  readonly verdict: VerifyVerdict
  readonly at: number
  readonly depth: FocusDepth
  /** 本记录发生在第几回合（供状态面回答"本回合验证了几次"）。 */
  readonly turn: number
  /** 本次调用是否超过了本档验证预算（预算不是禁令，只是读数）。 */
  readonly overBudget: boolean
}

export type VerifyLedger = readonly VerifyRecord[]

/**
 * 台账上限：**它只限制"复盘窗口"**（最近 `VERIFY_LEDGER_MAX` 条记录）。
 *
 * ⚠️ 这句话以前与实现相反（G3）：回执里的"这是第 N 次"、`overBudget` 判据、
 * 状态面的"验证 N 次"读的都是被这个上限截断后的长度，于是同一个会话里
 * 第 33 次之后永远说"这是第 33 次"、状态面永远停在"验证：32 次"，
 * 而同一次输出里健康行报的是模块级真实累计——两个面互相矛盾。
 *
 * 现在**累计量一律走 `VerifyTracker` 的单调计数器**（`total`/`checkable`/`overBudget`），
 * 台账只回答"最近发生了什么"（最近结论、最近判定、本回合几次）。
 * 改这个数字前请先看：它只影响复盘窗口的深度，不影响任何判定。
 */
export const VERIFY_LEDGER_MAX = 32

/** 追加一条记录，保留最近 `max` 条。纯函数。 */
export function recordVerify(
  ledger: VerifyLedger,
  record: VerifyRecord,
  max: number = VERIFY_LEDGER_MAX,
): VerifyLedger {
  const base = Array.isArray(ledger) ? ledger.filter(item => item !== null && item !== undefined) : []
  const limit = Number.isFinite(max) ? Math.max(1, Math.floor(max)) : VERIFY_LEDGER_MAX
  const next = [...base, normalizeRecord(record)]
  return next.length > limit ? next.slice(next.length - limit) : next
}

/**
 * 每会话的验证读数（`SessionState` 持有）。**两套记账，回答两个不同的问题**：
 *
 * - `ledger`：**滚动窗口**（最近 `VERIFY_LEDGER_MAX` 条）——复盘"最近发生了什么"；
 * - `total` / `checkable` / `overBudget`：**单调累计**——回答"这个会话一共核对了几次"；
 * - `latest`：每条结论的**最新判定**，只增改、不随窗口滚动淘汰——未闭合结论是
 *   **待办**，待办不该因为发生得早而被忘掉（否则它被挤出窗口后，注入里的验证段
 *   会直接消失，模型再也不会被提醒还有没核对的结论）。
 *
 * 可变对象（与 `PrivacyState` 的槽持有者同一处理方式）：`apply` 内每会话一份。
 */
export interface VerifyTracker {
  ledger: VerifyLedger
  /** 累计核对次数（**不受台账上限影响**）。 */
  total: number
  /** 累计判定为"形式可核对"的次数。 */
  checkable: number
  /** 累计超预算次数。 */
  overBudget: number
  /** 结论 → 最新判定（键与 `summarizeVerify` 内部同一把，见 `claimKey`）。 */
  latest: Map<string, VerifyVerdict>
  /** 最近一条记录所在的回合号。 */
  turn: number
  /** 该回合内的核对次数。 */
  thisTurn: number
}

export function createVerifyTracker(): VerifyTracker {
  return { ledger: [], total: 0, checkable: 0, overBudget: 0, latest: new Map(), turn: 0, thisTurn: 0 }
}

/** 记一条核对：窗口照旧滚动，**累计与最新判定只增不减**。变异同一个 tracker 并返回。 */
export function trackVerify(
  tracker: VerifyTracker,
  record: VerifyRecord,
  max: number = VERIFY_LEDGER_MAX,
): VerifyTracker {
  const normalized = normalizeRecord(record)
  tracker.ledger = recordVerify(tracker.ledger, normalized, max)
  tracker.total += 1
  if (normalized.verdict === 'checkable') tracker.checkable += 1
  if (normalized.overBudget) tracker.overBudget += 1
  tracker.latest.set(claimKey(normalized.claim), normalized.verdict)
  if (normalized.turn !== tracker.turn) {
    tracker.turn = normalized.turn
    tracker.thisTurn = 0
  }
  tracker.thisTurn += 1
  return tracker
}

export interface VerifySummary {
  /**
   * 核对次数（本会话累计）。
   *
   * 由 `summarizeTracker` 汇总时是**单调累计**（不受台账上限影响）；
   * 直接传台账给 `summarizeVerify` 时是窗口内的条数。
   */
  readonly calls: number
  /**
   * **本回合**的调用次数；调用方没给回合号时为 null（不猜、不写 0）。
   */
  readonly thisTurn: number | null
  /** 判定为"形式可核对"的次数。 */
  readonly checkable: number
  /**
   * **未闭合**的结论数：按结论文本取最新一条，仍未过形式核对的条数。
   * 同一条结论补上来源后重核，数字会降下来——它衡量的是待办，不是历史。
   *
   * 由 `summarizeTracker` 汇总时取自"最新判定表"，**不随台账滚动消失**（G3）。
   */
  readonly unresolved: number
  /** 超预算的调用次数。 */
  readonly overBudget: number
  readonly budget: number
  readonly lastVerdict: VerifyVerdict | null
  readonly lastClaim: string
}

/**
 * 汇总台账。纯函数；畸形台账按"每条都规整成合法记录"处理（不抛、不产出 undefined）。
 *
 * `currentTurn` 给定时额外回答"本回合验证了几次"（状态面要的那一问）；
 * 不给时 `thisTurn` 为 null，而不是假装 0。
 */
export function summarizeVerify(ledger: VerifyLedger, budget: number, currentTurn?: number): VerifySummary {
  const records = (Array.isArray(ledger) ? ledger : [])
    .filter(item => item !== null && item !== undefined)
    .map(item => normalizeRecord(item))
  const latest = new Map<string, VerifyRecord>()
  let checkable = 0
  let overBudget = 0
  let thisTurn = 0
  const trackTurn = typeof currentTurn === 'number' && Number.isFinite(currentTurn)
  for (const record of records) {
    if (record.verdict === 'checkable') checkable += 1
    if (record.overBudget === true) overBudget += 1
    if (trackTurn && record.turn === currentTurn) thisTurn += 1
    latest.set(claimKey(record.claim), record)
  }
  let unresolved = 0
  for (const record of latest.values()) if (record.verdict !== 'checkable') unresolved += 1
  const last = records.length === 0 ? null : (records[records.length - 1] as VerifyRecord)
  return {
    calls: records.length,
    thisTurn: trackTurn ? thisTurn : null,
    checkable,
    unresolved,
    overBudget,
    budget: Number.isFinite(budget) ? Math.max(0, Math.floor(budget)) : 0,
    lastVerdict: last === null ? null : last.verdict,
    lastClaim: last === null ? '' : last.claim,
  }
}

/**
 * 汇总 **tracker**：累计量取单调计数器，窗口量取台账。
 *
 * 台账能回答的问题（最近结论、最近判定、本回合几次）从台账取；
 * 累计量（一共几次 / 可核对几次 / 超预算几次 / 还有几条未闭合）从计数器取——
 * 被 `slice` 掉的记录只影响"最近"，不影响"一共"（G3）。
 *
 * `currentTurn` 给定时 `thisTurn` 是**该回合**的累计（回合没变才用计数器）；
 * 不给时为 null（不猜、也不写 0）。
 */
export function summarizeTracker(
  tracker: VerifyTracker,
  budget: number,
  currentTurn?: number,
): VerifySummary {
  const base = summarizeVerify(tracker.ledger, budget, currentTurn)
  const trackTurn = typeof currentTurn === 'number' && Number.isFinite(currentTurn)
  let unresolved = 0
  for (const verdict of tracker.latest.values()) if (verdict !== 'checkable') unresolved += 1
  return {
    ...base,
    calls: tracker.total,
    checkable: tracker.checkable,
    overBudget: tracker.overBudget,
    thisTurn: trackTurn ? (tracker.turn === currentTurn ? tracker.thisTurn : 0) : null,
    unresolved,
  }
}

/** 验证段的字符上限（注入里唯一由验证驱动的文本，且有未闭合项才出现）。 */
export const VERIFY_SEGMENT_MAX = 120

/**
 * 注入用的验证段。**没有未闭合项时返回空串**——不注入"当前没有待验证项"这类废话。
 * 有的话只说两件事：还差几条、下一步做什么。
 */
export function verifyLine(summary: VerifySummary): string {
  if (summary.unresolved <= 0) return ''
  const last = summary.lastVerdict
  const tail = last === null ? '' : `（最近一条：${VERDICT_TEXT[last]}）`
  const used = summary.calls
  const budget = summary.budget
  const budgetText = budget <= 0 ? '本档不要求验证' : `本档验证预算 ${Math.min(used, budget)}/${budget}`
  const line = `验证：${summary.unresolved} 条结论未过形式核对${tail}；补可核对来源或标为待确认。${budgetText}。`
  return line.length <= VERIFY_SEGMENT_MAX ? line : `${line.slice(0, VERIFY_SEGMENT_MAX - 1)}…`
}

/** 状态面里的一行：验收到什么程度、本回合几次、超没超预算。 */
export function describeVerify(summary: VerifySummary): string {
  if (summary.calls === 0) return '验证：尚无（本会话还没核对过结论）'
  const last = summary.lastVerdict === null ? '无' : VERDICT_TEXT[summary.lastVerdict]
  const claim = summary.lastClaim === '' ? '' : `（最近：${truncate(summary.lastClaim, 24)}）`
  const thisTurn = summary.thisTurn === null ? '' : `本回合 ${summary.thisTurn} 次，`
  return [
    `验证：${summary.calls} 次（${thisTurn}形式可核对 ${summary.checkable}，未闭合 ${summary.unresolved}`,
    summary.overBudget > 0 ? `，超预算 ${summary.overBudget}` : '',
    `）；最近结论 ${last}${claim}`,
  ].join('')
}

function normalizeRecord(record: VerifyRecord): VerifyRecord {
  return {
    claim: typeof record?.claim === 'string' ? record.claim : '',
    verdict: (VERIFY_VERDICTS as readonly string[]).includes(record?.verdict) ? record.verdict : 'needs-evidence',
    at: typeof record?.at === 'number' && Number.isFinite(record.at) ? record.at : 0,
    depth: record?.depth ?? 'standard',
    turn: typeof record?.turn === 'number' && Number.isFinite(record.turn) ? record.turn : 0,
    overBudget: record?.overBudget === true,
  }
}

function claimKey(claim: string): string {
  const value = typeof claim === 'string' ? claim.trim() : ''
  return value === '' ? '(空结论)' : value
}

function truncate(text: string, max: number): string {
  const value = String(text ?? '')
  return value.length <= max ? value : `${value.slice(0, max)}…`
}
