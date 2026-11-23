import {
  DefaultIntrinsics,
  newQuickJSWASMModule,
  shouldInterruptAfterDeadline,
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSRuntime,
  type QuickJSWASMModule,
} from 'quickjs-emscripten'
import { fail, internal, type OmbError } from '../../domain/errors.js'
import { isJsonValue, isPlainObject, type JsonValue } from '../../domain/json.js'
import type { CodeSandbox, SandboxResult } from '../../ports/dynamic.js'

/** 默认 CPU 时间上限（毫秒）。 */
export const SANDBOX_DEFAULT_CPU_MS = 100
/** 默认内存上限（MB）。 */
export const SANDBOX_DEFAULT_MEMORY_MB = 16
/** 输出上限：32KB（字节，UTF-8）。 */
export const SANDBOX_OUTPUT_BYTES = 32 * 1024
/** CPU 时间上限的最大可配置值；再大就不是"小段代码"了。 */
export const SANDBOX_MAX_CPU_MS = 1000
/** 内存上限的最大可配置值。 */
export const SANDBOX_MAX_MEMORY_MB = 64
/** 沙箱源码上限，与 domain 的 MAX_CODE_BYTES 对齐。 */
export const SANDBOX_MAX_SOURCE_BYTES = 32 * 1024
/** 预加载引用载荷上限；超过说明引用太大，应改用 task/file 等通道。 */
export const SANDBOX_MAX_INPUT_BYTES = 1024 * 1024
/** QuickJS 栈上限；递归深的代码会得到 stack overflow 而不是进程崩溃。 */
export const SANDBOX_STACK_BYTES = 512 * 1024

/**
 * 沙箱内启用的语言特性：保留 JSON/RegExp/Map 等纯计算能力，
 * 关掉 Date（时间只能来自注入的 `now`，保证可缓存可审计）、
 * Promise（动态值必须是同步 JSON，异步会挂住到 CPU 上限）、Proxy（减少逃逸面）。
 *
 * Eval 不能关：quickjs-emscripten 的 `context.evalCode` 依赖该内置对象。
 * 沙箱里没有宿主对象、没有模块加载器、没有网络/文件句柄，`eval` 只能影响沙箱自身。
 */
const SANDBOX_INTRINSICS = { ...DefaultIntrinsics, Date: false, Promise: false, Proxy: false }

/**
 * 判断源码里是否存在真正的动态 `import(...)` 调用（跳过字符串/注释）。
 *
 * 存在的 import 会让 QuickJS 在 runtime 释放时残留对象；但字符串里的 "import("
 * （例如做代码文本分析）是合法内容，不能一刀切拒绝。
 * 正则字面量里的 `import\(` 带反斜杠，不会被误判。
 */
function containsDynamicImport(source: string): boolean {
  let index = 0
  while (index < source.length) {
    const char = source[index] as string
    const next = source[index + 1]
    if (char === '/' && next === '/') {
      index += 2
      while (index < source.length && source[index] !== '\n') index += 1
      continue
    }
    if (char === '/' && next === '*') {
      index += 2
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) index += 1
      index += 2
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      index += 1
      while (index < source.length) {
        const inner = source[index] as string
        if (inner === '\\') {
          index += 2
          continue
        }
        index += 1
        if (inner === char) break
      }
      continue
    }
    if (char === 'i' && source.startsWith('import', index)) {
      const before = index === 0 ? '' : (source[index - 1] as string)
      const isIdentifierChar = /[A-Za-z0-9_$]/u.test(before)
      if (!isIdentifierChar) {
        let cursor = index + 'import'.length
        while (cursor < source.length && /\s/u.test(source[cursor] as string)) cursor += 1
        if (source[cursor] === '(') return true
      }
    }
    index += 1
  }
  return false
}

interface SandboxFailure {
  readonly name: string
  readonly message: string
}

interface SandboxPayload {
  readonly refs: Record<string, Record<string, JsonValue | null>>
  readonly attrs: JsonValue
  readonly now: string
}

type EvaluateResult = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly failure: SandboxFailure }

/**
 * 共享 WASM 模块：runtime 之间彼此隔离，模块实例可以复用（否则每次求值都要重新编译 WASM）。
 * 一旦某个 runtime 因残留对象无法释放而污染模块，就丢弃模块，下次重新创建。
 */
let sharedModule: QuickJSWASMModule | undefined
let moduleGeneration = 0

async function acquireModule(): Promise<QuickJSWASMModule> {
  if (sharedModule !== undefined) return sharedModule
  const generation = moduleGeneration
  const module = await newQuickJSWASMModule()
  if (generation === moduleGeneration) sharedModule = module
  return module
}

function invalidateModule(): void {
  moduleGeneration += 1
  sharedModule = undefined
}

function clampOption(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

function describeHostError(error: unknown): SandboxFailure {
  if (error instanceof Error) return { name: error.name, message: error.message }
  return { name: 'Error', message: String(error) }
}

function describeThrownValue(context: QuickJSContext, handle: QuickJSHandle): SandboxFailure {
  try {
    const dumped: unknown = context.dump(handle)
    if (isPlainObject(dumped)) {
      const name = typeof dumped['name'] === 'string' ? dumped['name'] : 'Error'
      const message = typeof dumped['message'] === 'string' ? dumped['message'] : '未知错误'
      return { name, message }
    }
    if (dumped === undefined) return { name: 'Error', message: 'undefined' }
    return { name: 'Error', message: String(dumped) }
  } catch {
    return { name: 'Error', message: '无法读取沙箱异常（可能是栈溢出）' }
  }
}

function sandboxFailure(failure: SandboxFailure, timeoutMs: number, memoryMb: number): OmbError {
  if (failure.name === 'InternalError' && /interrupt/i.test(failure.message)) {
    return { code: 'sandbox-timeout', message: `动态代码执行超过 ${timeoutMs}ms，已中断`, retryable: false }
  }
  if (failure.name === 'InternalError' && /out of memory/i.test(failure.message)) {
    return { code: 'sandbox-error', message: `动态代码超过 ${memoryMb}MB 内存上限，已终止`, retryable: false }
  }
  if (failure.name === 'TypeError' && failure.message === 'not a function') {
    return {
      code: 'sandbox-error',
      message: '动态代码执行失败：TypeError: not a function（沙箱不提供 Promise/async/import 等异步或模块能力）',
      retryable: false,
    }
  }
  return {
    code: 'sandbox-error',
    message: `动态代码执行失败：${failure.name}: ${failure.message}`,
    retryable: false,
  }
}

/**
 * 翻译沙箱脚本返回的信封：`{ok:true,value:"<JSON 文本>"}` 或
 * `{ok:false,reason:"not-json"|"too-large"|"threw",detail:"..."}`。
 * 这样用户代码的 throw / 不可序列化值都在沙箱内被归类，宿主拿到的是明确原因。
 */
function decodeEnvelope(text: string, memoryMb: number): JsonValue {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw fail({
      code: 'sandbox-error',
      message: `沙箱返回结果不是合法 JSON：${describeHostError(error).message}`,
      retryable: false,
    })
  }
  if (!isPlainObject(parsed)) {
    throw fail({ code: 'sandbox-error', message: '沙箱返回结果不是对象', retryable: false })
  }
  if (parsed['ok'] === true) {
    const valueText = parsed['value']
    if (typeof valueText !== 'string') {
      throw fail({ code: 'sandbox-error', message: '沙箱返回结果缺少 value 文本', retryable: false })
    }
    if (utf8ByteLength(valueText) > SANDBOX_OUTPUT_BYTES) {
      throw fail({ code: 'sandbox-error', message: `动态代码输出超过 ${SANDBOX_OUTPUT_BYTES} 字节`, retryable: false })
    }
    let value: unknown
    try {
      value = JSON.parse(valueText)
    } catch (error) {
      throw fail({
        code: 'sandbox-error',
        message: `动态代码输出不是合法 JSON：${describeHostError(error).message}`,
        retryable: false,
      })
    }
    if (!isJsonValue(value)) {
      throw fail({ code: 'sandbox-error', message: '动态代码输出不是 JSON 值', retryable: false })
    }
    return value
  }
  const reason = typeof parsed['reason'] === 'string' ? parsed['reason'] : 'unknown'
  const detail = typeof parsed['detail'] === 'string' ? parsed['detail'] : ''
  if (reason === 'not-json') {
    throw fail({ code: 'sandbox-error', message: `动态代码输出不是 JSON：${detail}`, retryable: false })
  }
  if (reason === 'too-large') {
    throw fail({ code: 'sandbox-error', message: `动态代码输出超过 ${SANDBOX_OUTPUT_BYTES} 字节`, retryable: false })
  }
  if (reason === 'threw') {
    if (/out of memory/i.test(detail)) {
      throw fail({ code: 'sandbox-error', message: `动态代码超过 ${memoryMb}MB 内存上限，已终止`, retryable: false })
    }
    if (detail === 'not a function') {
      throw fail({
        code: 'sandbox-error',
        message:
          '动态代码抛出异常：TypeError: not a function（沙箱不提供 Promise/async/import 等异步或模块能力）',
        retryable: false,
      })
    }
    throw fail({ code: 'sandbox-error', message: `动态代码抛出异常：${detail}`, retryable: false })
  }
  throw fail({ code: 'sandbox-error', message: `沙箱返回了无法识别的结果：${reason}`, retryable: false })
}

/**
 * 校验并规范化输入载荷。端口签名是 `JsonValue`，这里把它读成
 * `{ refs, attrs, now }`（缺省容错，避免宿主拼错时把任意对象塞进沙箱）。
 */
function normalizeInput(input: JsonValue): SandboxPayload {
  if (!isPlainObject(input)) fail({ code: 'invalid-input', message: '沙箱输入必须是 JSON 对象' })
  const refs: Record<string, Record<string, JsonValue | null>> = {}
  const rawRefs = input['refs']
  if (rawRefs !== undefined) {
    if (!isPlainObject(rawRefs)) fail({ code: 'invalid-input', message: '沙箱输入 refs 必须是对象' })
    for (const [entityId, perEntity] of Object.entries(rawRefs)) {
      if (!isPlainObject(perEntity)) fail({ code: 'invalid-input', message: `沙箱输入 refs.${entityId} 必须是对象` })
      const attrs: Record<string, JsonValue | null> = {}
      for (const [attr, value] of Object.entries(perEntity)) {
        if (!isJsonValue(value)) fail({ code: 'invalid-input', message: `沙箱输入 refs.${entityId}.${attr} 必须是 JSON` })
        attrs[attr] = value
      }
      refs[entityId] = attrs
    }
  }
  const rawAttrs = input['attrs']
  const attrs = rawAttrs === undefined ? {} : rawAttrs
  if (!isJsonValue(attrs)) fail({ code: 'invalid-input', message: '沙箱输入 attrs 必须是 JSON' })
  const now = typeof input['now'] === 'string' ? input['now'] : ''
  return { refs, attrs, now }
}

/**
 * 沙箱引导脚本：只往全局注入纯数据与纯 JS 函数，
 * 不注入任何宿主对象/回调（ref 是沙箱内部对预加载数据的查表）。
 */
function bootstrapProgram(payloadJson: string): string {
  const literal = JSON.stringify(payloadJson)
  return `(function () {
  "use strict"
  var payload = JSON.parse(${literal})
  var hasOwn = Object.prototype.hasOwnProperty
  function ref(id, attr) {
    var entity = payload.refs[id]
    var key = (attr === undefined || attr === null) ? "" : String(attr)
    if (!entity || !hasOwn.call(entity, key)) {
      throw new Error("ctx.ref 未预加载：" + String(id) + (key === "" ? "" : "." + key) + "；动态代码只能引用字面量 id/attr")
    }
    return entity[key]
  }
  var text = {
    trim: function (value) { return String(value === undefined || value === null ? "" : value).trim() },
    upper: function (value) { return String(value === undefined || value === null ? "" : value).toUpperCase() },
    lower: function (value) { return String(value === undefined || value === null ? "" : value).toLowerCase() },
    slice: function (value, start, end) { return String(value === undefined || value === null ? "" : value).slice(start, end) },
    split: function (value, separator) { return String(value === undefined || value === null ? "" : value).split(separator) },
    test: function (value, pattern) {
      var regex = pattern instanceof RegExp ? pattern : new RegExp(String(pattern))
      return regex.test(String(value === undefined || value === null ? "" : value))
    },
    match: function (value, pattern, group) {
      var regex = pattern instanceof RegExp ? pattern : new RegExp(String(pattern))
      var found = regex.exec(String(value === undefined || value === null ? "" : value))
      if (found === null) return null
      var index = group === undefined ? 0 : group
      return found[index] === undefined ? null : found[index]
    },
    replace: function (value, pattern, replacement) {
      var regex = pattern instanceof RegExp ? pattern : new RegExp(String(pattern))
      return String(value === undefined || value === null ? "" : value).replace(regex, replacement)
    }
  }
  var math = {
    min: Math.min, max: Math.max, round: Math.round, floor: Math.floor, ceil: Math.ceil,
    abs: Math.abs, pow: Math.pow, sqrt: Math.sqrt, log: Math.log, exp: Math.exp
  }
  globalThis.ctx = { ref: ref, attrs: payload.attrs }
  globalThis.ref = ref
  globalThis.attrs = payload.attrs
  globalThis.now = payload.now
  globalThis.json = {
    parse: function (value) { return JSON.parse(String(value)) },
    stringify: function (value) { return JSON.stringify(value) }
  }
  globalThis.text = text
  globalThis.math = math
  return "ready"
})()`
}

/**
 * 用户程序包装：先按"单表达式"求值（对象字面量不会退化成 block），
 * 编译期 SyntaxError 时再按"语句块"求值（此时需要显式 `return`）。
 * 两种形式都在沙箱内归类 throw / undefined / 不可序列化 / 超 32KB，
 * 返回一个 JSON 信封字符串给宿主。
 */
function userProgram(source: string, mode: 'expression' | 'body'): string {
  const expressionSource = source.replace(/;\s*$/u, '')
  const inner = mode === 'expression' ? `  return (\n${expressionSource}\n  )` : source
  return `(function () {
  "use strict"
  var __stringify = JSON.stringify
  function __utf8Bytes(__text) {
    var __total = 0
    for (var __index = 0; __index < __text.length; __index += 1) {
      var __code = __text.charCodeAt(__index)
      if (__code < 0x80) __total += 1
      else if (__code < 0x800) __total += 2
      else if (__code >= 0xd800 && __code <= 0xdbff) {
        var __next = __text.charCodeAt(__index + 1)
        if (__next >= 0xdc00 && __next <= 0xdfff) { __total += 4; __index += 1 }
        else __total += 3
      } else __total += 3
    }
    return __total
  }
  function __envelope(__outcome) {
    try {
      var __json = __stringify(__outcome)
      return typeof __json === "string" ? __json : '{"ok":false,"reason":"not-json","detail":"envelope"}'
    } catch (__error) {
      return '{"ok":false,"reason":"not-json","detail":"envelope"}'
    }
  }
  var __value
  try {
    __value = (function () {
${inner}
    })()
  } catch (__error) {
    return __envelope({ ok: false, reason: "threw", detail: String(__error && __error.message !== undefined ? __error.message : __error) })
  }
  if (__value === undefined) {
    return __envelope({ ok: false, reason: "not-json", detail: "undefined（语句块需要显式 return）" })
  }
  var __text
  try {
    __text = __stringify(__value)
  } catch (__error) {
    return __envelope({ ok: false, reason: "not-json", detail: String(__error && __error.message !== undefined ? __error.message : __error) })
  }
  if (typeof __text !== "string") {
    return __envelope({ ok: false, reason: "not-json", detail: typeof __value })
  }
  var __bytes = __utf8Bytes(__text)
  if (__bytes > ${SANDBOX_OUTPUT_BYTES}) {
    return __envelope({ ok: false, reason: "too-large", detail: String(__bytes) })
  }
  return __envelope({ ok: true, value: __text })
})()`
}

/**
 * QuickJS WASM 沙箱：每次求值新建 runtime + context，无宿主对象、无网络、无文件、无模块加载器。
 * 默认 CPU 100ms、内存 16MB、输出 32KB；超时/死循环/抛错/非 JSON 输出都映射成明确的 OmbError。
 */
export class QuickJsSandbox implements CodeSandbox {
  async run(source: string, input: JsonValue, options: { timeoutMs?: number; memoryMb?: number } = {}): Promise<SandboxResult> {
    if (typeof source !== 'string') fail({ code: 'invalid-input', message: '动态代码必须是字符串' })
    if (source.trim().length === 0) fail({ code: 'invalid-input', message: '动态代码不能为空' })
    if (utf8ByteLength(source) > SANDBOX_MAX_SOURCE_BYTES) {
      fail({ code: 'invalid-input', message: `动态代码超过 ${SANDBOX_MAX_SOURCE_BYTES} 字节` })
    }
    if (containsDynamicImport(source)) {
      fail({ code: 'sandbox-error', message: '动态代码禁止使用 import()：沙箱没有模块加载器', retryable: false })
    }
    if (!isJsonValue(input)) fail({ code: 'invalid-input', message: '沙箱输入必须是 JSON' })
    const payload = normalizeInput(input)
    const payloadJson = JSON.stringify({ refs: payload.refs, attrs: payload.attrs, now: payload.now })
    if (utf8ByteLength(payloadJson) > SANDBOX_MAX_INPUT_BYTES) {
      fail({ code: 'sandbox-error', message: `沙箱输入超过 ${SANDBOX_MAX_INPUT_BYTES} 字节`, retryable: false })
    }
    const timeoutMs = clampOption(options.timeoutMs, SANDBOX_DEFAULT_CPU_MS, 1, SANDBOX_MAX_CPU_MS)
    const memoryMb = clampOption(options.memoryMb, SANDBOX_DEFAULT_MEMORY_MB, 1, SANDBOX_MAX_MEMORY_MB)

    let module: QuickJSWASMModule
    try {
      module = await acquireModule()
    } catch (error) {
      throw fail(internal(`QuickJS 沙箱模块加载失败：${describeHostError(error).message}`))
    }

    let contaminated = false
    let runtime: QuickJSRuntime
    try {
      runtime = module.newRuntime()
    } catch (error) {
      invalidateModule()
      throw fail(internal(`QuickJS runtime 创建失败：${describeHostError(error).message}`))
    }
    try {
      runtime.setMemoryLimit(memoryMb * 1024 * 1024)
      runtime.setMaxStackSize(SANDBOX_STACK_BYTES)
      const context = runtime.newContext({ intrinsics: SANDBOX_INTRINSICS })
      try {
        const bootstrap = this.evaluate(context, bootstrapProgram(payloadJson), 'omb-sandbox-bootstrap.js')
        if (!bootstrap.ok) throw fail(sandboxFailure(bootstrap.failure, timeoutMs, memoryMb))
        // CPU 上限只约束用户代码：引导脚本是固定小常量，不应吃掉用户预算。
        runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + timeoutMs))
        const startedAt = performance.now()
        const value = this.runUserProgram(context, source, timeoutMs, memoryMb)
        const durationMs = Math.max(0, Math.round((performance.now() - startedAt) * 1000) / 1000)
        return { value, durationMs }
      } finally {
        try {
          context.dispose()
        } catch {
          contaminated = true
        }
      }
    } finally {
      try {
        runtime.dispose()
      } catch {
        // 异步/import 代码可能留下无法回收的对象，QuickJS 的泄漏断言会抛错；
        // 丢弃被污染的模块，避免把残留堆叠带到后续求值。
        contaminated = true
      }
      if (contaminated) invalidateModule()
    }
  }

  private evaluate(context: QuickJSContext, program: string, filename: string): EvaluateResult {
    const result = context.evalCode(program, filename)
    if (result.error) {
      const failure = describeThrownValue(context, result.error)
      result.error.dispose()
      return { ok: false, failure }
    }
    try {
      const dumped: unknown = context.dump(result.value)
      if (typeof dumped !== 'string') {
        return { ok: false, failure: { name: 'TypeError', message: `沙箱返回了非字符串结果（${typeof dumped}）` } }
      }
      return { ok: true, text: dumped }
    } catch (error) {
      return { ok: false, failure: describeHostError(error) }
    } finally {
      result.value.dispose()
    }
  }

  private runUserProgram(context: QuickJSContext, source: string, timeoutMs: number, memoryMb: number): JsonValue {
    const expression = this.evaluate(context, userProgram(source, 'expression'), 'dynamic-expression.js')
    if (expression.ok) return decodeEnvelope(expression.text, memoryMb)
    if (expression.failure.name !== 'SyntaxError') {
      throw fail(sandboxFailure(expression.failure, timeoutMs, memoryMb))
    }
    const body = this.evaluate(context, userProgram(source, 'body'), 'dynamic-body.js')
    if (!body.ok) throw fail(sandboxFailure(body.failure, timeoutMs, memoryMb))
    return decodeEnvelope(body.text, memoryMb)
  }
}
