/**
 * 检索模块的运行时枚举值。
 *
 * 与 types.ts 分开放，是为了让公共类型面（types.ts）保持窄：
 * 运行时值只有调用方真正需要的这几个，导出面不超过架构检查阈值。
 */

/** 阶段一真正并行执行的通道（single_char 依赖 fulltext 结果，见 channels.ts）。 */
export const STAGE_ONE_CHANNELS = ['trigger', 'fulltext', 'single_char', 'vector', 'time', 'state_board'] as const

/**
 * 召回结果里可见的通道。`links` 是阶段二图扩展产生的伪通道：
 * 它没有存储查询，但和阶段一通道一起参与 RRF 与原始分门控。
 */
export const RECALL_CHANNELS = [...STAGE_ONE_CHANNELS, 'links'] as const

/** 调用场景；权重差异集中在 config.ts 的 scenarios 表，不散落在引擎里。 */
export const RECALL_SCENARIOS = ['manual', 'tool-before', 'tool-error', 'session-start', 'last-time'] as const

/** 阶段二图扩展模式；T2 工具的 `expand` 参数直接映射到这里。 */
export const EXPANSION_MODES = ['none', 'links', 'chain', 'both'] as const
