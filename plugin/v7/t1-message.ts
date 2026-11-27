/**
 * T1（事件召回）注入宿主 pre-step 的纯装配层。
 *
 * 为什么单独一层：DSH 的 `PreStepDecision` 只有 `reject` 与
 * `{kind:'enter',messages,startsRequestSeries?}`，**没有** `additionalContexts`
 * （packages/core/agent/src/runtime-types.ts:139-146）。T1 想进入模型上下文，
 * 只能作为一条 producer-owned user message 追加进 `decision.messages`，由宿主
 * 准入时落成 durable `user/message`（正确范例：
 * packages/context/time-context/src/index.ts:199-242）。
 *
 * 消息形状错一次就会被会话日志的 `assertMessageEventShape` 拒绝
 * （packages/core/session/src/index.ts:337-363：id 非空、role=user、
 * source.kind 非空、content 为数组），所以这里只做纯数据变换，便于单测锁住。
 */
import { randomUUID } from 'node:crypto'

/**
 * 生产者身份。DSH 的 `source.kind` 是 merge-extensible 的字符串标识，没有共享的
 * catch-all `plugin` kind；外部插件用迁移器生成的规范形式 `plugin:<name>`，
 * 与 `tools/post-execute` 的 `additionalContexts` 保持同一个 kind。
 */
export const T1_SOURCE_KIND = 'plugin:oh-my-bigbluefish/v7'

/** 注入消息的身份前缀；与工具结果即时召回的 `additionalContexts` 同一命名空间。 */
export const T1_MESSAGE_ID_PREFIX = 'msg_omb_'

/** 一条模型可见的 T1 注入消息：结构对齐 DSH `UserMessage`，不带宿主私有字段。 */
export interface T1InjectedMessage {
  readonly id: string
  readonly role: 'user'
  readonly source: { readonly kind: typeof T1_SOURCE_KIND }
  readonly content: readonly { readonly type: 'text'; readonly text: string }[]
}

/**
 * 一次 pre-step 决策里我们能看到的形状。
 *
 * 只声明宿主契约里会读/会保留的字段：`messages` 原样保留宿主已排好的顺序，
 * `startsRequestSeries` 由宿主消费，追加时不得丢掉。
 */
export type PreStepEnterLike = {
  readonly kind: 'enter'
  readonly messages: readonly unknown[]
  readonly startsRequestSeries?: true
}

/** 形状判定：reject 没有 `messages`，只有 enter 才能追加注入消息。 */
export function isEnterDecisionLike(value: unknown): value is PreStepEnterLike {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return record['kind'] === 'enter' && Array.isArray(record['messages'])
}

/**
 * 把 T1 文本构造成 producer-owned user message；空白文本返回 `undefined`。
 * @param text - 已装配好的 T1 文本（预算裁剪由 recall 层负责）。
 * @returns 可追加进 `decision.messages` 的不可变消息，或空注入时的 `undefined`。
 */
export function createT1UserMessage(text: string): T1InjectedMessage | undefined {
  if (text.trim().length === 0) return undefined
  return {
    id: `${T1_MESSAGE_ID_PREFIX}${randomUUID()}`,
    role: 'user',
    source: { kind: T1_SOURCE_KIND },
    content: [{ type: 'text', text }],
  }
}

/**
 * 把 T1 追加到 enter decision 的 `messages` 末尾。
 *
 * 原 decision 不被修改（宿主决策按不可变值传递）；空白文本时原样返回，
 * 调用方因此可以无条件调用而不引入空注入。
 * @param decision - 宿主排好的 enter decision。
 * @param text - 本次要注入的 T1 文本。
 * @returns 追加了 T1 的新 decision，或原 decision（无 T1）。
 */
export function appendT1Message(decision: PreStepEnterLike, text: string): PreStepEnterLike {
  const message = createT1UserMessage(text)
  if (message === undefined) return decision
  return { ...decision, messages: [...decision.messages, message] }
}
