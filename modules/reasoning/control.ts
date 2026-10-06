/**
 * 档位 + 压力 → **控制参数**，以及失败分类器 + 恢复策略、循环触发时的"合法出口"段。
 *
 * 这一层存在的理由（用户判断，逐字）：
 * "不应该把'思考更多'作为质量的代理变量……`deep = 加更多规则文本` 不是正确终点。
 *  应该变成：`deep → 更高验证预算 / 更高证据要求 / 允许分支 / 允许复核 / 更严格停止条件`。"
 *
 * 因此档位差异的**唯一载体是这张表**，不是散在文案里的形容词：
 * 注入只多一行参数读数（`controlLine`），卡片自动注入数被钉死在 1 张以内。
 *
 * v3.6 起这张表多了**第二个来源维度：压力带**（`controlForBand`）。此前
 * `stopRule` / `evidenceLevel` 只由 depth 决定、与 band 完全无关，于是"压力最大"
 * 与"压力最小"拿到同一张表；而证据方向相反（压力升高 → 更倾向提前收尾、跳过验证）。
 * 现在 tight 只做一件事：**把这两个维度抬到不低于 standard 档的下限**（只升不降）。
 *
 * 失败处置也不再是"连续失败两次就禁止第三次"这种全局阈值，而是
 * **失败分类 → 恢复策略**：分类决定动作，动作带该类自己的预算（预算不是禁令）。
 * 分类的依据可以是模型给的定性，也可以是 Loop 观察到的结构信号
 * （`failureSignalsFromLoop`）——这就是 "Loop → Verify" 的接线处。
 *
 * 纯函数、零 I/O、零 mock 可测。
 */
import type { FocusDepth, PressureBand } from '../../kernel/abi/index.js'
import type { LoopSignal } from './loop.js'
import { isNoProgressSignal } from './loop.js'
import type { RuleId } from './methods.js'

// ─────────────────────────── 档位 → 控制参数 ───────────────────────────

/** 证据要求等级。 */
export type EvidenceLevel = 'none' | 'cite-source' | 'cite-and-label'

/** 停止（收尾）条件严格度。 */
export type StopRule = 'first-answer' | 'evidence-backed' | 'verified-or-labeled'

/**
 * 一个档位的**可执行控制参数**。字段全部是数字、枚举与卡号——
 * 没有一个是"你要思考"这类形容词。
 */
export interface DepthControl {
  readonly depth: FocusDepth
  /** 验证预算：本档期望的验证次数上限（0 = 不要求验证）。 */
  readonly verifyBudget: number
  /** 证据要求：什么算够格的证据。 */
  readonly evidenceLevel: EvidenceLevel
  /** 允许并列互斥方案的上限（1 = 不并列）。 */
  readonly branchBudget: number
  /** 允许回头复核已做结论的次数上限。 */
  readonly reviewBudget: number
  /** 收尾门槛。 */
  readonly stopRule: StopRule
  /** 本档**自动注入**的唯一一张卡（null = 不注入任何卡片正文）。 */
  readonly injectCard: RuleId | null
}

/**
 * 档位控制表。**这是档位差异的唯一真源**：
 * 逐档在五个维度上严格递增，且注入的卡片数不随档位增长（0/0/1）。
 */
export const CONTROL_BY_DEPTH: Readonly<Record<FocusDepth, DepthControl>> = {
  quick: {
    depth: 'quick',
    verifyBudget: 0,
    evidenceLevel: 'none',
    branchBudget: 1,
    reviewBudget: 0,
    stopRule: 'first-answer',
    injectCard: null,
  },
  standard: {
    depth: 'standard',
    verifyBudget: 1,
    evidenceLevel: 'cite-source',
    branchBudget: 2,
    reviewBudget: 1,
    stopRule: 'evidence-backed',
    injectCard: null,
  },
  deep: {
    depth: 'deep',
    verifyBudget: 3,
    evidenceLevel: 'cite-and-label',
    branchBudget: 3,
    reviewBudget: 2,
    stopRule: 'verified-or-labeled',
    injectCard: 'R4',
  },
}

/** 任何档位自动注入的卡片数上限。**不随档位增长**，这是本次改造的硬指标。 */
export const AUTO_INJECT_CARD_CAP = 1

/** 控制读数一行的字符上限（注入里唯一的档位差异文本，测试会断言）。 */
export const CONTROL_LINE_MAX = 120

/** 取某档的控制参数；未知档位回落 `standard`（不抛）。 */
export function controlOf(depth: FocusDepth): DepthControl {
  return CONTROL_BY_DEPTH[depth] ?? CONTROL_BY_DEPTH.standard
}

/**
 * 两个"严格度"枚举的次序。**只用于"只升不降"的比较**，不是标定过的刻度：
 * 研究报告 §4.3 明确把具体档位的数字列为未标定，因此这里只做"谁不低于谁"的判断。
 */
const EVIDENCE_RANK: readonly EvidenceLevel[] = ['none', 'cite-source', 'cite-and-label']
const STOP_RANK: readonly StopRule[] = ['first-answer', 'evidence-backed', 'verified-or-labeled']

function atLeast<T extends string>(rank: readonly T[], current: T, floor: T): T {
  return rank.indexOf(current) >= rank.indexOf(floor) ? current : floor
}

/**
 * 压力带 → 控制参数（**只升不降**）。
 *
 * 为什么必须有这一层：`CONTROL_BY_DEPTH` 只由 depth 决定，于是"压力最大"与
 * "压力最小"拿到的是同一张表——而证据方向恰恰相反（研究报告 §3：预算/失败/评分
 * 压力升高时模型更倾向提前收尾、跳过验证），压力下**至少**要不低于默认档的门槛。
 *
 * 抬升的是**下限**，不是"压力越大越严"的连续量：`tight` 时把 `evidenceLevel` /
 * `stopRule` 抬到 `standard` 档的水平（`quick` 是唯一被抬到的一档；`standard`/`deep`
 * 本来就在下限之上，因此**逐字节不变**）。理由：证据只支持"要有一个更严的下限"，
 * 没有标定过"tight 具体该多严"，凭感觉加码就是又一条未验证直觉。
 *
 * 纯函数、不抛：`band` 不是 `tight` 时原样返回该档控制（未知取值同样不抛）。
 */
export function controlForBand(depth: FocusDepth, band: PressureBand): DepthControl {
  const base = controlOf(depth)
  if (band !== 'tight') return base
  const floor = CONTROL_BY_DEPTH.standard
  const evidenceLevel = atLeast(EVIDENCE_RANK, base.evidenceLevel, floor.evidenceLevel)
  const stopRule = atLeast(STOP_RANK, base.stopRule, floor.stopRule)
  if (evidenceLevel === base.evidenceLevel && stopRule === base.stopRule) return base
  return { ...base, evidenceLevel, stopRule }
}

/**
 * 压力**是否真的**抬升了这一档的门槛。
 *
 * 存在的理由：抬门槛却不告诉模型，就是一处静默行为变化。渲染层据此决定
 * "读数本来不注入的档位（`standard`/`quick`）也要把读数读出来"——
 * 只有真的发生了变化才多这一行，没变化就不加字。
 */
export function pressureRaisedFloor(depth: FocusDepth, band: PressureBand): boolean {
  const base = controlOf(depth)
  const effective = controlForBand(depth, band)
  return effective.evidenceLevel !== base.evidenceLevel || effective.stopRule !== base.stopRule
}

const EVIDENCE_TEXT: Readonly<Record<EvidenceLevel, string>> = {
  none: '不要求',
  'cite-source': '指出来源',
  'cite-and-label': '指出来源并标注未验证项',
}

const STOP_TEXT: Readonly<Record<StopRule, string>> = {
  'first-answer': '给出答案即可',
  'evidence-backed': '首选方案有证据支撑',
  'verified-or-labeled': '每条结论可核对或标注未验证',
}

/**
 * 控制读数：一行参数，供注入。
 *
 * 它**不是**"你要思考"的文字：说的是本档要求几次验证、允许并列几个方案、
 * 允许复核几次、收尾门槛是什么——模型据此决定动作，而非据此"更用力"。
 *
 * `band` 是**来源维度**（研究报告 §5.2 设计 A 第 1 条）：读数里必须能看出这一行
 * 是在什么压力下读出来的，否则 `tight` 抬了下限而模型只看到一个更严的数字、
 * 不知道它为什么变了。门槛经 `controlForBand` 计算，因此压力抬升会直接反映在
 * 「证据」「收尾」两段上（只升不降）。
 *
 * 默认 `band='relaxed'`：不传压力 = **不施加耦合**（不是"把 tight 猜成 relaxed"）。
 * 调用方拿不到压力读数时，唯一诚实的做法就是不加码；真实渲染路径总是显式传宿主给的 band。
 */
export function controlLine(depth: FocusDepth, verifyUsed = 0, band: PressureBand = 'relaxed'): string {
  const control = controlForBand(depth, band)
  const used = clampInt(verifyUsed, 0, control.verifyBudget)
  const branch = control.branchBudget <= 1 ? '不并列' : `并列 ≤${control.branchBudget}`
  return [
    `档位 ${control.depth}`,
    `压力 ${band}`,
    `验证 ${used}/${control.verifyBudget}`,
    branch,
    `复核 ≤${control.reviewBudget}`,
    `证据 ${EVIDENCE_TEXT[control.evidenceLevel]}`,
    `收尾 ${STOP_TEXT[control.stopRule]}`,
    '失败先分类',
  ].join('｜')
}

/**
 * 人可读的档位控制摘要（工具回执与状态面用，不进每轮注入）。
 *
 * 与 `controlLine` 同一份 `controlForBand`：回执说的"证据要求 / 收尾"必须与
 * 下一轮注入里读到的**同一件事**，两个面不许各说一套（G2 的教训）。
 */
export function describeControl(depth: FocusDepth, band: PressureBand = 'relaxed'): string {
  const control = controlForBand(depth, band)
  const branch = control.branchBudget <= 1 ? '不并列方案' : `可并列至多 ${control.branchBudget} 个互斥方案`
  const raised = pressureRaisedFloor(depth, band) ? `；压力 ${band}：门槛只升不降` : ''
  return [
    `验证预算 ${control.verifyBudget} 次`,
    `证据要求：${EVIDENCE_TEXT[control.evidenceLevel]}`,
    branch,
    `可复核 ${control.reviewBudget} 次`,
    `收尾：${STOP_TEXT[control.stopRule]}`,
  ].join('；') + raised
}

// ─────────────────── 合法出口段（研究报告 §5.2 设计 B） ───────────────────

/** 出口段的字符上限（研究报告给设计 B 的硬约束：≤200 字符）。 */
export const EXIT_SEGMENT_MAX = 200

/**
 * 哪些循环信号触发出口段：**只认"无进展"两类**（`loop.ts` 的 `NO_PROGRESS_KINDS`
 * 是判据的唯一真源，这里只负责文案）。
 *
 * `repeat-action` / `oscillation` 不在这里：它们各自的 `hint` 已经点明了一个
 * 具体出口（"别原样再来一次"/"需要第三个选项或先向用户确认"），再叠一段通用出口
 * 只是更长、更不具体——而"更长的提示"不是本次要的东西。
 */
const EXIT_LEAD: Readonly<Record<string, string>> = {
  stalled: '同一件事反复做且没有进展',
  'no-new-evidence': '连续几轮没有新增证据',
}

/**
 * 显式"合法出口" + 完成判据重述（仅在触发信号出现时注入，非每轮）。
 *
 * 依据（研究报告 §3.7、§3.6 T4）：**"诚实解仍可行"是压制生效的前提**，
 * 而"合法选项被封闭"会把 misalignment 从 0% 推到 96%。所以这里写的不是
 * "别绕圈"，而是**把出口写出来**——说"卡住了 / 需要更多信息 / 这条做不了"是被允许的，
 * 且回收尾条件是什么。
 *
 * 三条硬约束（都是反例清单换来的，不许放宽）：
 * 1. **≤ `EXIT_SEGMENT_MAX` 字符**——由测试逐（信号 × 档位 × 压力）组合断言。
 *    这里**不做静默截断**：截掉后半句恰好会截掉判据重述，等于把这条注入变成半句话。
 * 2. **不写"不许作弊"、不写"你被监控"**——前者只部分有效，后者会提高评测意识、
 *    触发表演式合规（§3.5、§3.9）。
 * 3. **判据重述的是本会话当前生效的门槛**（`controlForBand` 的收尾条件与证据要求），
 *    不是任务原文——本模块不读会话内容，只能把控制面里那个可核对的判据说清楚；
 *    拿不到任务原文这件事本身不假装。
 *
 * 无信号、或信号不触发时返回空串：**不注入"没有出口"这类废话**。
 */
export function renderExitOptions(signal: LoopSignal | null, control: DepthControl): string {
  if (!isNoProgressSignal(signal)) return ''
  const lead = EXIT_LEAD[signal.kind]
  if (lead === undefined) return ''
  return `${lead}——三个合法出口：① 给出带来源的部分结论并列出未解决项；`
    + `② 写明这条路为什么走不通并换向；③ 直接说不确定，并说明需要什么信息。`
    + `完成判据：${STOP_TEXT[control.stopRule]}；证据要求：${EVIDENCE_TEXT[control.evidenceLevel]}。`
}

// ───────────────────────── 失败分类 → 恢复策略 ─────────────────────────

export type FailureClass =
  | 'transient'
  | 'parameter-error'
  | 'strategy-error'
  | 'environment-error'
  | 'unknown'

export const FAILURE_CLASSES: readonly FailureClass[] = [
  'transient',
  'parameter-error',
  'strategy-error',
  'environment-error',
  'unknown',
]

export function isFailureClass(value: unknown): value is FailureClass {
  return typeof value === 'string' && (FAILURE_CLASSES as readonly string[]).includes(value)
}

export type RecoveryStrategy = 'retry' | 'alter' | 'branch' | 'inspect' | 'verify' | 'ask'

export interface RecoveryPolicy {
  readonly failureClass: FailureClass
  readonly strategy: RecoveryStrategy
  /**
   * 这一类下的尝试上限。**是预算，不是禁令**：
   * 它不禁止第三次尝试，只说明这一类值不值得再试。
   */
  readonly budget: number
  /** 立刻可执行的动作。 */
  readonly action: string
  /** 为什么这一类这么处置（进回执与状态面，不进每轮注入）。 */
  readonly why: string
}

/**
 * 失败处置表。旧的固定阈值（"连续失败两次就不再重试第三次"）在这里被
 * **降级为 `transient` 一类下的预算**，理由写在 `why` 里：
 * 瞬时失败重试有意义，但要有界；其它类别根本不靠"再试一次"解决。
 */
export const FAILURE_PLAYBOOK: Readonly<Record<FailureClass, RecoveryPolicy>> = {
  transient: {
    failureClass: 'transient',
    strategy: 'retry',
    budget: 2,
    action: '重试一次，并记下两次的差异（时间、参数、返回）。',
    why: '瞬时失败（超时、限流、竞争）重试有意义，但要有界；两次是这一类的上限，不是对其它失败也成立的禁令。',
  },
  'parameter-error': {
    failureClass: 'parameter-error',
    strategy: 'alter',
    budget: 1,
    action: '改参数或格式后再试一次，不要原样重试。',
    why: '参数或格式类报错不因重试而改变，只有改动输入才可能通过。',
  },
  'strategy-error': {
    failureClass: 'strategy-error',
    strategy: 'branch',
    budget: 1,
    action: '换一个方向或换一个手段，并写出上一个方向失败的原因。',
    why: '同一方向重复尝试而没有新增证据时，问题多半在方向而不在运气。',
  },
  'environment-error': {
    failureClass: 'environment-error',
    strategy: 'inspect',
    budget: 1,
    action: '先查环境：权限、依赖是否就位、网络是否可达、路径是否存在。',
    why: '环境不满足时，重试与改参数都不会改变结果，先看环境。',
  },
  unknown: {
    failureClass: 'unknown',
    strategy: 'verify',
    budget: 1,
    action: '把已看到的证据摆出来（错误原文、已试过的动作）；仍然分不清就问用户。',
    why: '分类不明时最省成本的动作是补证据或问人，而不是再试一次。',
  },
}

/** 取恢复策略；未知分类回落 `unknown`（不抛）。 */
export function recoveryFor(failureClass: FailureClass): RecoveryPolicy {
  return FAILURE_PLAYBOOK[failureClass] ?? FAILURE_PLAYBOOK.unknown
}

/** 结构信号：同动作重复且没有新证据的次数达到多少次，就足以怀疑是方向问题。 */
export const REPEAT_WITHOUT_EVIDENCE_HINT = 2

export interface FailureSignals {
  /** 模型给出的分类（权威；`unknown` 会被下面的结构信号细化）。 */
  readonly declared?: FailureClass
  /** 参数或格式类线索（校验失败、字段缺失、格式不合法）。 */
  readonly parameterHint?: boolean
  /** 环境类线索（权限、依赖缺失、不可达、路径不存在）。 */
  readonly environmentHint?: boolean
  /** 观察到的"同动作重复且无新证据"次数。 */
  readonly repeatedWithoutEvidence?: number
}

/**
 * 失败分类器。**纯函数**，永不抛。
 *
 * 优先级：模型给的分类（除 `unknown`）＞ 参数线索 ＞ 环境线索 ＞ 结构信号 ＞ unknown。
 * 结构信号来自 Loop（见 `failureSignalsFromLoop`），因此"绕圈"会被自动归到
 * `strategy-error`（换方向），而不是笼统的"再试一次"。
 */
export function classifyFailure(signals: FailureSignals = {}): FailureClass {
  const declared = signals.declared
  if (declared !== undefined && isFailureClass(declared) && declared !== 'unknown') return declared
  if (signals.parameterHint === true) return 'parameter-error'
  if (signals.environmentHint === true) return 'environment-error'
  const repeats = finiteOr(signals.repeatedWithoutEvidence, 0)
  if (repeats >= REPEAT_WITHOUT_EVIDENCE_HINT) return 'strategy-error'
  return 'unknown'
}

/**
 * Loop → 失败分类的结构信号。
 *
 * 这是 "Reasoning Control Loop" 的接线处：循环检测本身不知道"失败"是什么，
 * 但它观察得到"同一个动作反复做、没有新增证据"，那正是 `strategy-error`
 * 的可观测形状。于是模型说"失败，但我分不清是哪类"时，分类器仍然能给出动作。
 */
export function failureSignalsFromLoop(signal: LoopSignal | null): FailureSignals {
  if (signal === null) return {}
  switch (signal.kind) {
    case 'repeat-action':
    case 'oscillation':
    case 'stalled':
      return { repeatedWithoutEvidence: REPEAT_WITHOUT_EVIDENCE_HINT }
    case 'no-new-evidence':
      return { repeatedWithoutEvidence: 1 }
    default:
      return {}
  }
}

/** 工具回执文本：一次拉起处置动作与依据。 */
export function renderRecovery(policy: RecoveryPolicy): string {
  return `失败分类 ${policy.failureClass} → ${policy.strategy}（预算 ${policy.budget} 次）：${policy.action}\n依据：${policy.why}`
}

function clampInt(value: unknown, min: number, max: number): number {
  const number = finiteOr(value, min)
  if (number < min) return min
  if (number > max) return max
  return Math.floor(number)
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}
