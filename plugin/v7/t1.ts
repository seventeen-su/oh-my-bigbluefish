/**
 * T1（事件驱动召回）的纯判定层：步键、强触发闸门、去重指纹。
 *
 * 这些函数不读宿主、不查库、不保存状态，装配层只负责把它们的结论落到
 * additionalContexts / systemPrompt。把「何时召回」从事件处理里抽出来，
 * 才能用单测锁住：普通成功工具不召回、同一步只召回一次。
 */
import { createHash } from 'node:crypto'
import { extractQuerySignals } from '../../packages/v7/src/domain/text.js'

export interface StepPosition {
  readonly turn?: number
  readonly step?: number
}

/** 步键 = `turn:step`；只有 agent/pre-step 能拿到真实步号。 */
export function stepKeyOf(position: StepPosition): string | undefined {
  const { turn, step } = position
  if (turn === undefined || step === undefined) return undefined
  if (!Number.isSafeInteger(turn) || !Number.isSafeInteger(step)) return undefined
  if (turn < 0 || step < 0) return undefined
  return `${turn}:${step}`
}

/**
 * 用户的明确回忆意图。只认显式线索（上次/之前/继续/状态/进度/报错…），
 * 不做语义猜测：普通指令（列目录、读 README）不触发 T1。
 */
const RECALL_INTENT = /(?:上次|上回|上一次|之前|此前|以前|原来|早先|先前|刚才|刚刚|还记得|记得|忘了|继续|接着|回到|恢复|重试|状态|进度|进展|做到哪|到哪了|报错|错误|失败|异常|问题|为什么|怎么修|怎么改|排查|last\s+time|previously|earlier|remember|continue|resume|progress|\berror\b|\bfailed\b|\bfailure\b|\bexception\b)/i

export function hasRecallIntent(text: string): boolean {
  return text.trim().length > 0 && RECALL_INTENT.test(text)
}

/** 命令词/框架词不算「代码样式标识符」，否则每个工具调用都会触发 T1。 */
const COMMON_WORDS = new Set([
  'api', 'app', 'args', 'bash', 'build', 'cat', 'cd', 'cli', 'config', 'css', 'curl',
  'data', 'dev', 'dir', 'dist', 'docker', 'doc', 'docs', 'dom', 'echo', 'entry',
  'export', 'file', 'find', 'git', 'glob', 'grep', 'html', 'http', 'https', 'id',
  'import', 'index', 'json', 'js', 'lib', 'lint', 'list', 'log', 'main', 'master',
  'node', 'npm', 'ok', 'omb', 'packages', 'path', 'plugin', 'pnpm', 'read', 'rg',
  'run', 'sdk', 'sed', 'set', 'sql', 'ssh', 'src', 'status', 'test', 'tests', 'todo',
  'ts', 'tsc', 'tsx', 'typecheck', 'url', 'vitest', 'web', 'yaml', 'yml',
])

/** 代码样式标识符：带 `_ . -`、内部大写（camelCase）、全大写代号，或字母数字混合。 */
function isCodeLikeIdentifier(identifier: string): boolean {
  if (identifier.length < 3 || identifier.length > 80) return false
  if (COMMON_WORDS.has(identifier.toLowerCase())) return false
  if (/[_.-]/.test(identifier)) return true
  if (/[A-Z]/.test(identifier.slice(1))) return true
  return /\d/.test(identifier) && /[A-Za-z]/.test(identifier)
}

/** 强信号 = 路径 / 错误码 / 代码样式标识符；普通英文词与命令名都不算。 */
export function hasStrongSignal(text: string): boolean {
  if (text.trim().length === 0) return false
  const signals = extractQuerySignals(text)
  if (signals.paths.length > 0 || signals.errorCodes.length > 0) return true
  return signals.identifiers.some(isCodeLikeIdentifier)
}

const FAILURE_TEXT = /(?:error|failure|failed|fatal|exception|traceback|exit\s+code\s*[1-9]|enoent|eacces|eperm|econnrefused|eexist|etimeout|失败|报错|错误|异常|退出码|拒绝访问|超时)/i

/** 工具失败：isError 或输出里出现可辨识的失败文本。 */
export function toolFailed(isError: boolean, text: string): boolean {
  return isError || FAILURE_TEXT.test(text)
}

const TRIGGER_PREFIXES = ['compaction/', 'subagent/', 'team/', 'task/'] as const

/** 压缩/子代理/团队任务切换必须重建 T1；其它事件不在此处触发。 */
export function isRecallTriggerEvent(type: string): boolean {
  return TRIGGER_PREFIXES.some(prefix => type.startsWith(prefix))
}

export interface RecallFingerprintInput {
  readonly sessionId: string
  readonly query: string
  readonly result?: string
}

/**
 * 跨 step 的内容指纹：session + query + result，**不含 turn/step**。
 *
 * 同一步最多一次 T1 由装配层的步键配额（t1Step）负责；这里只回答
 * 「这段召回内容是否已经投递过」。把 turn/step 放进哈希会让同一个工具报错
 * 结果在下一步的 pre-step 因步号变化再次命中，所以内容指纹必须跨 step 稳定。
 */
export function recallContentFingerprint(input: RecallFingerprintInput): string {
  const digest = createHash('sha256')
  digest.update(input.sessionId)
  digest.update('\u0000')
  digest.update(input.query)
  digest.update('\u0000')
  digest.update(input.result ?? '')
  return digest.digest('hex').slice(0, 32)
}

export interface PreStepGateInput {
  /** compaction/subagent/team/task 等事件排队的召回。 */
  readonly pending: boolean
  readonly text: string
}

/** pre-step 只在待消费事件、明确回忆意图或路径/错误码/标识符时召回。 */
export function shouldRecallOnPreStep(input: PreStepGateInput): boolean {
  if (input.pending) return true
  if (input.text.trim().length === 0) return false
  return hasRecallIntent(input.text) || hasStrongSignal(input.text)
}

export interface ToolResultGateInput {
  readonly failed: boolean
  readonly argumentsText: string
  readonly resultText: string
}

/** 工具结果只在失败或参数/结果带强信号时召回；普通成功工具不召回。 */
export function shouldRecallToolResult(input: ToolResultGateInput): boolean {
  if (input.failed) return true
  return hasStrongSignal(input.argumentsText) || hasStrongSignal(input.resultText)
}
