/**
 * 构建期注入的元信息类型。
 *
 * `import.meta.glob` 由 Vite/Vitest 与构建管线提供（不是 TypeScript 内置），
 * 因此在这里补最小声明而不是引入 `vite/client`（那会把整个前端类型面拖进来，
 * 而本插件是 Host 侧代码）。
 */
interface ImportMeta {
  /**
   * 静态展开的模块映射。
   * @param pattern glob 模式，相对当前模块。
   * @param options `eager: true` 表示同步静态导入（默认是异步函数返回 Promise）。
   */
  glob(pattern: string, options?: { eager?: boolean; import?: string }): Record<string, unknown>
}
