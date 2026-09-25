/**
 * `@omb/notify` 组件包入口 —— `cordis.patch.yml` 的 `omb-notify` 行加载的就是它。
 *
 * **为什么组件必须是独立顶层包**：插件页的中文名来自 DSH 的本地化元数据，
 * 而 `readPluginMeta` 只对**裸包名**生效（`barePackageName(specifier) === undefined`
 * 时直接返回 undefined，见 `packages/boot/app-boot/src/package-meta.ts:148`）：
 * 相对路径的行永远拿不到元数据；而"裸包名 + 子路径"宿主又解析不了。只有
 * "一个组件 = 一个顶层包"同时满足"能解析"与"有中文名"。详见 `kernel/display.ts`。
 *
 * 真源仍在 `modules/notify/`：本文件只做两件转发，**不复制任何实现**——
 * - 具名导出（含真正的 `notifyModule`）供内核原生装配路径使用；
 * - `default = toHostPlugin(registration)` 供宿主逐行加载使用（它读的就是 default）。
 */
import * as component from '../../modules/notify/index.js'
import { NOTIFY_MODULE_ID } from '../../modules/notify/index.js'
import { registrationFor } from '../../dsh/modules.js'
import { toHostPlugin } from '../../kernel/hostEntry.js'

export * from '../../modules/notify/index.js'

export default toHostPlugin(registrationFor(component, NOTIFY_MODULE_ID))
