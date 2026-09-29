/**
 * `@omb/privacy` 组件包入口 —— `cordis.patch.yml` 的 `omb-privacy` 行加载的就是它。
 *
 * 与其它组件同构（见 `packages/notify/index.ts` 的说明）：行名只能是**裸顶层包名**，
 * 才能既有中文名（`readPluginMeta` 只认裸包名）又能被宿主解析。
 * 真源仍在 `modules/privacy/`：本文件只做两件转发，**不复制任何实现**。
 */
import * as component from '../../modules/privacy/index.js'
import { MODULE_ID } from '../../modules/privacy/index.js'
import { registrationFor } from '../../dsh/modules.js'
import { toHostPlugin } from '../../kernel/hostEntry.js'

export * from '../../modules/privacy/index.js'

export default toHostPlugin(registrationFor(component, MODULE_ID))
