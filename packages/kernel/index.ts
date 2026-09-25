/**
 * `@omb/kernel` 组件包入口 —— `cordis.patch.yml` 的 `omb-kernel` 行加载的就是它。
 *
 * **为什么组件必须是独立顶层包**：插件页的中文名来自 DSH 的本地化元数据，
 * 而 `readPluginMeta` 只对**裸包名**生效（`barePackageName(specifier) === undefined`
 * 时直接返回 undefined，见 `packages/boot/app-boot/src/package-meta.ts:148`）：
 * 相对路径的行永远拿不到元数据；而"裸包名 + 子路径"宿主又解析不了。只有
 * "一个组件 = 一个顶层包"同时满足"能解析"与"有中文名"。详见 `kernel/display.ts`。
 *
 * 本文件与 `dsh/kernel.ts` 一样是**薄壳**：微内核的实现全在 `dsh/plugin.ts`
 * 与 `kernel/`，这里只把宿主需要的导出转出去，不复制任何实现。
 *
 * 导出形状与换代前的行目标完全一致（`apply` / `inject` / `name` + `default`）：
 * 宿主逐行加载时读的是 `default`。
 */
export * from '../../dsh/kernel.js'
export { default } from '../../dsh/kernel.js'
