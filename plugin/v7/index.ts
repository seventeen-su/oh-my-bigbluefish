/**
 * OMB v7 宿主入口：单行插件，无 HTTP、无浏览器 bundle。
 *
 * 组合根在 `apply.ts`，按职责拆成模块：
 * - `config.ts`：配置解析；
 * - `hooks.ts` + `t1-session.ts`：宿主钩子（pre-step / 工具钩子 / session 事件）与 T1 会话态；
 * - `boot.ts` + `event-runtime.ts` + `projection.ts` + `consolidation.ts`：运行时/启动/状态；
 * - `status.ts` + `tool-runtime.ts`：7 个 `omb_*` 工具的实现；
 * - `teardown.ts`：同步 disposer 的收尾顺序。
 *
 * 这里只保留对外导出面：`apply`、默认导出与配置解析（宿主/单测兼容）。
 */
export { apply, apply as default } from './apply.js'
export { parseConfig, type ParsedV7Config, type V7Config } from './config.js'
