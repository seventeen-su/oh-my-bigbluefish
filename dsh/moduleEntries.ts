/**
 * 模块入口的**静态**导入清单。
 *
 * 为什么必须是静态 import 而不是 `import.meta.glob` 或运行期扫描：
 *
 * 1. `import.meta.glob` 是 Vite 专有构造，**`tsc` 不会转换它**。编译产物里会留下
 *    `import.meta.glob(...)`，而插件的运行环境是宿主 Node 进程（不是 Vite），
 *    结果就是 `TypeError: import.meta.glob is not a function`——插件根本装不上。
 * 2. 运行期目录扫描 + 动态 `import()` 是异步的，而宿主要求所有注册在 `apply`
 *    **返回前**完成（热插拔 H-2：挂载审计只查一次，事后注册会触发进程级失败告警）。
 *
 * 静态 import 同时满足两条：编译后是普通 `import` 语句，且在 `apply` 之前完成。
 *
 * **代价**：新增模块需要在这里加一行。这是一处可接受的显式耦合——
 * 换来的是"插件能加载"这条底线。为避免漏加，`tests/dsh/modules.test.ts`
 * 会扫描 `cordis.patch.yml` 的模块行并要求每个都在此清单中。
 */
import * as memory from '../modules/memory/index.js'
import * as memoryVector from '../modules/memory/vector.js'
import * as profile from '../modules/profile/index.js'
import * as reasoning from '../modules/reasoning/index.js'
import * as context from '../modules/context/index.js'
import * as artifact from '../modules/artifact/module.js'
import * as notify from '../modules/notify/index.js'

/**
 * 入口路径 → 已加载命名空间。
 *
 * 键的格式与 `cordis.patch.yml` 的 `name` 落点对应，供诊断与契约测试比对。
 *
 * 注意 `modules/memory/graph.ts` **不在此清单**：它是 `omb-memory` 的工具工厂
 * （`relateToolFactory`），不是独立模块——工具是"始终存在、按需调用"的能力，
 * 给它单独一个模块行只会让插件页多出没有独立资源的开关。
 */
export const MODULE_ENTRIES: ReadonlyMap<string, unknown> = new Map<string, unknown>([
  ['modules/memory/index', memory],
  ['modules/memory/vector', memoryVector],
  ['modules/profile/index', profile],
  ['modules/reasoning/index', reasoning],
  ['modules/context/index', context],
  ['modules/artifact/module', artifact],
  ['modules/notify/index', notify],
])
