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

/** 台账上限：只用于状态面复盘，不参与判定。 */
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

export interface VerifySummary {
  /** 台账里的调用次数（本会话累计）。 */
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
