/** 记忆记录的分类学。纯枚举，零依赖。 */

/**
 * 记忆类型。三值，不是三个存储：
 * 它设定写入策略与检索先验，不决定物理位置。
 */
export type MemoryKind = 'episodic' | 'semantic' | 'procedural'

export const MEMORY_KINDS: readonly MemoryKind[] = ['episodic', 'semantic', 'procedural']

/**
 * 记忆作用域。物理位置即权威：
 * `user` 落跨项目库，`project` 落跨会话库。不存在第三层。
 */
export type MemoryScope = 'user' | 'project'

export const MEMORY_SCOPES: readonly MemoryScope[] = ['user', 'project']

/**
 * 断言来源——这是**可检验的**置信度替代品。
 *
 * 不使用 0~1 的标量 confidence：没有证据表明 LLM 输出的标量置信度是校准的，
 * 而未校准的浮点数是"与决策相关的谎言"。这里的取值可被核对：
 * - `user`      用户显式陈述（最高来源等级，推断无法覆盖）
 * - `execution` 被执行结果确认（工程域最强）
 * - `model`     模型推断（最低）
 */
export type AssertedBy = 'user' | 'execution' | 'model'

export const ASSERTED_BY: readonly AssertedBy[] = ['user', 'execution', 'model']

/**
 * 边的类型。四种，布尔事实，**没有权重**（未归一化的权重是量纲不可比错误）。
 *
 * `related` 是 v3.7 新增的**自动关联**（实体/路径/命令重合），与三条
 * "裁决边"分开：它只表示"这两条记忆相关"，不代表时序替代或事实冲突。
 */
export type EdgeType = 'supersedes' | 'conflicts_with' | 'derived_from' | 'related'

export const EDGE_TYPES: readonly EdgeType[] = ['supersedes', 'conflicts_with', 'derived_from', 'related']

/** 思维链的推理深度档位，由模型自己设定（见规划 §4.4）。 */
export type FocusDepth = 'quick' | 'standard' | 'deep'

export const FOCUS_DEPTHS: readonly FocusDepth[] = ['quick', 'standard', 'deep']

/** 当前会话上下文压力的软档位（**不是硬上限**，见规划 §6.3）。 */
export type PressureBand = 'relaxed' | 'moderate' | 'tight'
