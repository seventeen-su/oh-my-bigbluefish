import type { DynamicSpec } from '../domain/entity.js'
import type { JsonValue } from '../domain/json.js'

/**
 * 动态值求值上下文（由 store / app 层实现，宿主能力只经这里进入解析器）。
 *
 * 端口契约：
 * - `depth`：当前解析深度基数，顶层为 0；解析器内部按嵌套 +1，超过 8 层报 `reference-cycle`。
 * - `now`：注入给动态代码的当前时间（ISO 8601）；沙箱内不提供真实的 Date。
 * - `projectRoot`：文件属性的读取根；缺省时 file 动态值一律拒绝。
 * - `getAttribute(entityId, attr?)`：返回属性的当前值。属性本身仍是动态值时返回
 *   `{ $dynamic: spec }`（与写入侧的 RawAttributeValue 约定一致），解析器会按深度继续解析；
 *   attr 省略表示取整个实体的属性集合。实体/属性不存在返回 undefined，不抛错。
 * - `readFile(path)`：`path` 已经由解析器解析并校验在 `projectRoot` 内；实现必须自己再做一次
 *   realpath 校验（`fs.realpath`）防止符号链接逃逸到根外，并且只读不写。
 *   实现应自行限制读取大小（解析器默认 256KB 上限，但大文件不应先整体读进内存）。
 *   文件不存在抛 `code='ENOENT'` 的错误（解析器转成 not-found）。
 * - `readTask(source, id, field?)`：读取 dsh 子代理/团队任务/后台任务；不存在返回 undefined。
 * - `signal`：取消信号，传递给 url 动态值的 fetch。
 */
export interface DynamicContext {
  readonly depth: number
  readonly now: string
  readonly projectRoot?: string
  readonly signal?: AbortSignal
  getAttribute(entityId: string, attr?: string): Promise<JsonValue | undefined>
  readFile(path: string): Promise<string>
  readTask(source: 'subagent' | 'team' | 'job', id: string, field?: string): Promise<JsonValue | undefined>
}

export interface DynamicResolver {
  resolve(spec: DynamicSpec, context: DynamicContext): Promise<JsonValue | undefined>
}

export interface SandboxResult {
  readonly value: JsonValue
  readonly durationMs: number
}

/**
 * 动态代码沙箱端口。
 *
 * - 输入载荷约定为 `{ refs, attrs, now }`：refs 是预加载的引用值（entityId → 属性名 → 值，
 *   缺失属性为 null），attrs 是当前实体自有属性，now 是注入时间。
 * - `source` 是纯函数体：单表达式直接作为结果；语句块需要显式 `return`。
 * - 输出必须是 JSON 值，否则 `sandbox-error`；超时/死循环 `sandbox-timeout`；抛错 `sandbox-error`。
 * - 默认 CPU 100ms、内存 16MB、输出 32KB；具体实现不得放宽这三条上限。
 */
export interface CodeSandbox {
  run(source: string, input: JsonValue, options?: { timeoutMs?: number; memoryMb?: number }): Promise<SandboxResult>
}
