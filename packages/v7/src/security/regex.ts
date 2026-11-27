import {
  newQuickJSWASMModule,
  shouldInterruptAfterDeadline,
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSRuntime,
  type QuickJSWASMModule,
} from 'quickjs-emscripten'

/**
 * 正则安全执行服务（R3）。
 *
 * 触发键里的正则来自用户属性，查询文本来自事件/工具输出，两者都不可信：
 * 主线程 `new RegExp(...).test(长输入)` 遇到嵌套量词会指数回溯，直接把召回拖死。
 *
 * 不变量：
 * - 所有匹配都在 QuickJS WASM 沙箱里执行；宿主只拿返回值，不执行用户正则。
 * - 单条正则最多 50ms CPU（REGEX_TIMEOUT_MS），超过由 QuickJS 中断处理器打断；
 *   不同步阻塞主线程到无限长。
 * - 单次 match 有总预算，输入/源码/候选数量都有上限；超限返回明确结果，不抛宿主。
 * - 静态长度/复杂度检查只做快速拒绝，真正的防线是运行时中断。
 * - 并发调用有上限；超过等待队列直接返回 busy，不无限堆积。
 */

/** 单条正则的 CPU 上限（毫秒）。 */
export const REGEX_TIMEOUT_MS = 50
/** 单次 match 调用的总预算（毫秒）；正常候选远低于它，恶意候选不能把一次召回拖垮。 */
export const REGEX_MAX_TOTAL_MS = 100
/** 匹配输入上限（字符）；超长查询不做正则匹配，避免把 CPU 交给不可控输入。 */
export const REGEX_MAX_INPUT_CHARS = 16_384
/** 单条正则源码上限（字符）。 */
export const REGEX_MAX_SOURCE_CHARS = 2_048
/** 单次最多评估多少条候选正则（与 store 的候选上限对齐）。 */
export const REGEX_MAX_CANDIDATES = 500
/** 同一服务内最多同时执行多少个 QuickJS 正则任务。 */
export const REGEX_MAX_CONCURRENCY = 4
/** 并发上限之外的等待队列长度；超过直接 busy。 */
export const REGEX_QUEUE_LIMIT = 8
/** 静态复杂度快速拒绝：量词超过该数量直接拒绝。 */
export const REGEX_MAX_QUANTIFIERS = 64

/** QuickJS 沙箱内存上限；正则只需要源码 + 输入 + 少量结果。 */
const REGEX_MEMORY_LIMIT_BYTES = 16 * 1024 * 1024
/** QuickJS 栈上限；回溯很深的病态正则会先撞栈，而不是让进程崩溃。 */
const REGEX_STACK_BYTES = 512 * 1024
/** QuickJS（2021+）支持的 flags：g/i/m/s/u/y + 索引 d + unicodeSets v。 */
const REGEX_ALLOWED_FLAGS = new Set(['d', 'g', 'i', 'm', 's', 'u', 'v', 'y'])
/** 一次 match 里允许出现的 flags 最大长度。 */
const REGEX_MAX_FLAGS_LENGTH = 8

export interface RegexCandidate {
  /** 调用方用来把结果映射回候选行的稳定 id（同一批里应唯一）。 */
  readonly id: string
  readonly source: string
  readonly flags?: string
}

export interface RegexMatchRequest {
  readonly input: string
  readonly candidates: readonly RegexCandidate[]
  /** 单条正则的 CPU 上限；缺省 50ms，传更大值也会被压到 50ms。 */
  readonly timeoutMs?: number
}

export type RegexRejectReason =
  | 'empty-source'
  | 'source-too-long'
  | 'invalid-flags'
  | 'too-complex'
  | 'invalid-source'
  | 'engine-error'

export interface RegexRejectedCandidate {
  readonly id: string
  readonly reason: RegexRejectReason
  readonly detail?: string
}

export type RegexMatchStatus = 'ok' | 'timeout' | 'busy' | 'invalid-input' | 'engine-error'

export interface RegexMatchResult {
  readonly status: RegexMatchStatus
  /** 命中的候选 id，按候选输入顺序；超时前已完成的命中仍保留。 */
  readonly matchedIds: readonly string[]
  /** 被静态检查或沙箱拒绝的候选；单个候选出错不影响其它候选。 */
  readonly rejected: readonly RegexRejectedCandidate[]
  /** 撞到 CPU/总预算的候选 id（通常是最后一条）。 */
  readonly timedOutIds: readonly string[]
  /** 本次调用的真实耗时（毫秒，含排队）。 */
  readonly durationMs: number
  readonly reason?: string
}

export interface RegexServiceOptions {
  /** 覆盖并发上限（默认 4，最小 1）。 */
  readonly maxConcurrent?: number
  /** 覆盖等待队列上限（默认 8，最小 0）。 */
  readonly queueLimit?: number
}

interface ConcurrencyGate {
  acquire(): Promise<boolean>
  release(): void
}

/**
 * 有界并发门：活跃数达到上限后最多排队 `queueLimit` 个，再多直接失败。
 * JS 单线程下同步匹配本身不会真正并行，但异步模块加载/多路召回会让调用重叠，
 * 这里保证同一时刻最多 N 个 QuickJS 任务在跑，避免 CPU 抢占打爆 T1 预算。
 */
class BoundedConcurrencyGate implements ConcurrencyGate {
  private active = 0
  private readonly waiters: Array<() => void> = []

  constructor(private readonly maxConcurrent: number, private readonly queueLimit: number) {}

  async acquire(): Promise<boolean> {
    if (this.active < this.maxConcurrent) {
      this.active += 1
      return true
    }
    if (this.waiters.length >= this.queueLimit) return false
    await new Promise<void>(resolve => {
      this.waiters.push(resolve)
    })
    // 位置由 release() 直接转移，active 保持不变，避免两次递增。
    return true
  }

  release(): void {
    const next = this.waiters.shift()
    if (next !== undefined) {
      next()
      return
    }
    this.active = Math.max(0, this.active - 1)
  }
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 把任意字符串安全地嵌进 QuickJS 源码，避免 `"`、反斜杠和 U+2028/2029 破坏字面量。 */
function jsStringLiteral(value: string): string {
  return JSON.stringify(value)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

/** flags 白名单 + 去重预检；未知/重复 flag 直接快速拒绝，不送进沙箱。 */
function flagsAreValid(flags: string | undefined): boolean {
  if (flags === undefined) return true
  if (flags.length > REGEX_MAX_FLAGS_LENGTH) return false
  const seen = new Set<string>()
  for (const flag of flags) {
    if (!REGEX_ALLOWED_FLAGS.has(flag) || seen.has(flag)) return false
    seen.add(flag)
  }
  return true
}

/**
 * 量词计数（跳过转义、字符类和分组前缀）：超过上限直接拒绝。
 * 这不是 ReDoS 判定器——`(a+)+` 只有 3 个量词，照样放行给运行时中断兜底。
 */
function countQuantifiers(source: string): number {
  let count = 0
  let inClass = false
  let escaped = false
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (char === undefined) continue
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    if (inClass) {
      if (char === ']') inClass = false
      continue
    }
    if (char === '[') {
      inClass = true
      continue
    }
    if (char === '(' && source[index + 1] === '?') {
      const marker = source[index + 2]
      if (marker === ':' || marker === '=' || marker === '!') {
        index += 2
        continue
      }
      if (marker === '<') {
        if (source[index + 3] === '=' || source[index + 3] === '!') {
          index += 3
          continue
        }
        const close = source.indexOf('>', index + 3)
        if (close > 0) {
          index = close
          continue
        }
      }
    }
    if (char === '*' || char === '+' || char === '?') {
      count += 1
      continue
    }
    if (char === '{') {
      if (/^\{\d+(?:,\d*)?\}/.test(source.slice(index))) count += 1
    }
  }
  return count
}

/** 静态快速拒绝：只看长度/flags/复杂度，不负责判断正则是否灾难性。 */
function inspectCandidate(candidate: RegexCandidate): RegexRejectedCandidate | undefined {
  if (candidate.source.length === 0) {
    return { id: candidate.id, reason: 'empty-source' }
  }
  if (candidate.source.length > REGEX_MAX_SOURCE_CHARS) {
    return {
      id: candidate.id,
      reason: 'source-too-long',
      detail: `正则源码 ${candidate.source.length} 字符，超过上限 ${REGEX_MAX_SOURCE_CHARS}`,
    }
  }
  if (!flagsAreValid(candidate.flags)) {
    return { id: candidate.id, reason: 'invalid-flags', detail: `flags 非法：${candidate.flags ?? ''}` }
  }
  const quantifiers = countQuantifiers(candidate.source)
  if (quantifiers > REGEX_MAX_QUANTIFIERS) {
    return {
      id: candidate.id,
      reason: 'too-complex',
      detail: `量词 ${quantifiers} 个，超过上限 ${REGEX_MAX_QUANTIFIERS}（运行时中断仍是主防线）`,
    }
  }
  return undefined
}

function describeQuickJsError(context: QuickJSContext, handle: QuickJSHandle): { name: string; message: string } {
  try {
    const dumped: unknown = context.dump(handle)
    if (isRecord(dumped)) {
      return {
        name: typeof dumped['name'] === 'string' ? dumped['name'] : 'Error',
        message: typeof dumped['message'] === 'string' ? dumped['message'] : '未知 QuickJS 错误',
      }
    }
    return { name: 'Error', message: String(dumped) }
  } catch {
    return { name: 'Error', message: '无法读取 QuickJS 异常（可能是栈溢出）' }
  }
}

/** 共享 WASM 模块：runtime 相互隔离，模块实例可复用；被污染时整个丢弃重建。 */
let sharedModule: QuickJSWASMModule | undefined
let sharedModulePromise: Promise<QuickJSWASMModule> | undefined

async function acquireModule(): Promise<QuickJSWASMModule> {
  if (sharedModule !== undefined) return sharedModule
  if (sharedModulePromise === undefined) {
    sharedModulePromise = newQuickJSWASMModule()
      .then(module => {
        sharedModule = module
        return module
      })
      .catch((error: unknown) => {
        sharedModulePromise = undefined
        throw error
      })
  }
  return sharedModulePromise
}

function invalidateModule(): void {
  sharedModule = undefined
  sharedModulePromise = undefined
}

interface EngineOutcome {
  readonly matchedIds: string[]
  readonly rejected: RegexRejectedCandidate[]
  readonly timedOutIds: string[]
  readonly timedOut: boolean
}

/**
 * 在单个 QuickJS runtime 里逐条编译+匹配。每次求值前设置新的中断 deadline：
 * 中断由 QuickJS 在 VM/正则引擎内部轮询，宿主不执行用户正则，也不会无限挂起。
 * 中断错误不会被沙箱内 try/catch 吞掉（实测直接冒泡到 evalCode），宿主据此判定 timeout。
 */
async function executeInSandbox(
  input: string,
  candidates: readonly RegexCandidate[],
  perCandidateMs: number,
  executionStartedAt: number,
): Promise<EngineOutcome> {
  const module = await acquireModule()
  let runtime: QuickJSRuntime | undefined
  let context: QuickJSContext | undefined
  let contaminated = false
  try {
    try {
      runtime = module.newRuntime()
    } catch (error) {
      invalidateModule()
      throw error
    }
    runtime.setMemoryLimit(REGEX_MEMORY_LIMIT_BYTES)
    runtime.setMaxStackSize(REGEX_STACK_BYTES)
    context = runtime.newContext()
    runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + Math.max(1, perCandidateMs)))
    const inputResult = context.evalCode(
      `globalThis.__ombRegexInput = ${jsStringLiteral(input)}`,
      'omb-regex-input.js',
    )
    if (inputResult.error) {
      const failure = describeQuickJsError(context, inputResult.error)
      inputResult.error.dispose()
      throw new Error(`QuickJS 正则输入装载失败：${failure.name}: ${failure.message}`)
    }
    inputResult.value.dispose()

    const matchedIds: string[] = []
    const rejected: RegexRejectedCandidate[] = []
    const timedOutIds: string[] = []
    let timedOut = false
    const callDeadline = executionStartedAt + REGEX_MAX_TOTAL_MS

    for (const candidate of candidates) {
      const now = performance.now()
      const remaining = Math.min(perCandidateMs, callDeadline - now)
      if (remaining <= 0) {
        timedOut = true
        timedOutIds.push(candidate.id)
        break
      }
      runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + Math.max(1, Math.floor(remaining))))
      const flags = candidate.flags ?? ''
      const result = context.evalCode(
        `new RegExp(${jsStringLiteral(candidate.source)}, ${jsStringLiteral(flags)}).test(globalThis.__ombRegexInput)`,
        'omb-regex-match.js',
      )
      if (result.error) {
        const failure = describeQuickJsError(context, result.error)
        result.error.dispose()
        if (failure.name === 'InternalError' && /interrupt/i.test(failure.message)) {
          timedOut = true
          timedOutIds.push(candidate.id)
          break
        }
        rejected.push({
          id: candidate.id,
          reason: failure.name === 'SyntaxError' ? 'invalid-source' : 'engine-error',
          detail: failure.message,
        })
        continue
      }
      let matched: unknown
      try {
        matched = context.dump(result.value)
      } catch {
        matched = undefined
      } finally {
        result.value.dispose()
      }
      if (matched === true) matchedIds.push(candidate.id)
    }
    return { matchedIds, rejected, timedOutIds, timedOut }
  } finally {
    try {
      context?.dispose()
    } catch {
      contaminated = true
    }
    try {
      runtime?.dispose()
    } catch {
      contaminated = true
    }
    if (contaminated) invalidateModule()
  }
}

/**
 * 正则执行服务：静态快速拒绝 → 有界并发 → QuickJS 沙箱逐条匹配。
 * 任何超时/非法/引擎错误都以 `RegexMatchResult` 返回，不向宿主抛异常。
 */
export class RegexService {
  private readonly gate: ConcurrencyGate

  constructor(options: RegexServiceOptions = {}) {
    this.gate = new BoundedConcurrencyGate(
      clampInteger(options.maxConcurrent, REGEX_MAX_CONCURRENCY, 1, 32),
      clampInteger(options.queueLimit, REGEX_QUEUE_LIMIT, 0, 64),
    )
  }

  async match(request: RegexMatchRequest): Promise<RegexMatchResult> {
    const startedAt = performance.now()
    const elapsed = (): number => Math.round((performance.now() - startedAt) * 1000) / 1000

    if (request.input.length > REGEX_MAX_INPUT_CHARS) {
      return {
        status: 'invalid-input',
        matchedIds: [],
        rejected: [],
        timedOutIds: [],
        durationMs: elapsed(),
        reason: `正则输入长度 ${request.input.length} 超过上限 ${REGEX_MAX_INPUT_CHARS}`,
      }
    }
    if (request.candidates.length > REGEX_MAX_CANDIDATES) {
      return {
        status: 'invalid-input',
        matchedIds: [],
        rejected: [],
        timedOutIds: [],
        durationMs: elapsed(),
        reason: `候选正则 ${request.candidates.length} 条超过上限 ${REGEX_MAX_CANDIDATES}`,
      }
    }

    const rejected: RegexRejectedCandidate[] = []
    const prepared: RegexCandidate[] = []
    for (const candidate of request.candidates) {
      const failure = inspectCandidate(candidate)
      if (failure === undefined) prepared.push(candidate)
      else rejected.push(failure)
    }
    if (prepared.length === 0) {
      return { status: 'ok', matchedIds: [], rejected, timedOutIds: [], durationMs: elapsed() }
    }

    const perCandidateMs = clampInteger(request.timeoutMs, REGEX_TIMEOUT_MS, 1, REGEX_TIMEOUT_MS)
    const admitted = await this.gate.acquire()
    if (!admitted) {
      return {
        status: 'busy',
        matchedIds: [],
        rejected,
        timedOutIds: [],
        durationMs: elapsed(),
        reason: '正则执行并发已达上限',
      }
    }
    const executionStartedAt = performance.now()
    try {
      const outcome = await executeInSandbox(request.input, prepared, perCandidateMs, executionStartedAt)
      return {
        status: outcome.timedOut ? 'timeout' : 'ok',
        matchedIds: outcome.matchedIds,
        rejected: [...rejected, ...outcome.rejected],
        timedOutIds: outcome.timedOutIds,
        durationMs: elapsed(),
        ...(outcome.timedOut ? { reason: `正则执行超过 ${perCandidateMs}ms CPU 上限，已中断` } : {}),
      }
    } catch (error) {
      return {
        status: 'engine-error',
        matchedIds: [],
        rejected,
        timedOutIds: [],
        durationMs: elapsed(),
        reason: error instanceof Error ? error.message : String(error),
      }
    } finally {
      this.gate.release()
    }
  }
}

/** 进程级默认服务：store 共用同一个并发闸门与 QuickJS 模块。 */
export const defaultRegexService = new RegexService()
