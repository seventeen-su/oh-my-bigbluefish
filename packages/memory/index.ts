/**
 * `@omb/memory` 组件包入口 —— `cordis.patch.yml` 的 `omb-memory` 行加载的就是它。
 *
 * **为什么组件必须是独立顶层包**：插件页的中文名来自 DSH 的本地化元数据，
 * 而 `readPluginMeta` 只对**裸包名**生效（`barePackageName(specifier) === undefined`
 * 时直接返回 undefined，见 `packages/boot/app-boot/src/package-meta.ts:148`）：
 * 相对路径的行永远拿不到元数据；而"裸包名 + 子路径"宿主又解析不了。只有
 * "一个组件 = 一个顶层包"同时满足"能解析"与"有中文名"。详见 `kernel/display.ts`。
 *
 * 真源仍在 `modules/memory/`：本文件只做转发，**不复制任何实现**——
 * - 具名导出（含真正的 `registration`）供内核原生装配路径使用；
 * - `default` 供宿主逐行加载使用（它读的就是 default）。
 *
 * v4.15.0：本行同时承载**管理侧边栏**的宿主 HTTP 路由（`/omb/api`）与浏览器 bundle。
 * 路由只读、按宿主 `webServer` 存在与否动态挂载；没有 `webServer` 时不注册，
 * 侧边栏自然不出现——不假装已可用。浏览器 bundle 见同目录 `client.js`。
 */
import * as component from '../../modules/memory/index.js'
import { MODULE_ID } from '../../modules/memory/index.js'
import { registrationFor } from '../../dsh/modules.js'
import { resolveKernel, toHostPlugin } from '../../kernel/hostEntry.js'
import { installUiRoute } from '../../dsh/ui-route.js'

export * from '../../modules/memory/index.js'

const base = toHostPlugin(registrationFor(component, MODULE_ID))

/** 宿主插件的 `apply`：先按原有契约挂模块，再向宿主 `webServer` 注册只读路由。 */
function applyWithUiRoute(first: unknown, config?: unknown): () => void {
  const disposeModule = base.apply(first, config)
  let disposeRoute: (() => void) | undefined
  let routeError: string | undefined
  try {
    const inject = (first as { inject?: unknown } | undefined)?.inject
    if (typeof inject === 'function') {
      ;(inject as (deps: readonly string[], fn: (scope: unknown) => void) => unknown).call(
        first,
        ['webServer'],
        (webCtx: unknown) => {
          try {
            disposeRoute = installUiRoute(webCtx, () => resolveKernel(first))
          } catch (error) {
            routeError = error instanceof Error ? error.message : String(error)
          }
        },
      )
    }
  } catch (error) {
    routeError = error instanceof Error ? error.message : String(error)
  }
  if (routeError !== undefined) {
    // 路由注册失败不影响记忆功能本身；但要留声（侧边栏会缺失）。
    process.stderr.write(`OMB：管理侧边栏路由未注册——${routeError}\n`)
  }
  return () => {
    try {
      disposeRoute?.()
    } catch {
      // 注销失败不向宿主传播（内核注销时也会清理服务表）
    }
    disposeModule()
  }
}

export default { ...base, apply: applyWithUiRoute }
