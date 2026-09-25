/**
 * 内核插件入口 —— `@omb/kernel` 组件包的入口（`packages/kernel/index.ts`）
 * re-export 本文件，`cordis.patch.yml` 的 `omb-kernel` 行加载的就是它。
 *
 * 这一层是刻意的薄壳：文件名叫 `kernel` 是为了与 YAML 行 id 对应，
 * 实际实现在 `plugin.ts`（避免"内核"这个词同时指微内核与插件入口）。
 */
export { apply, inject, name } from './plugin.js'
export type { PluginConfig } from './plugin.js'
export { apply as default } from './plugin.js'
