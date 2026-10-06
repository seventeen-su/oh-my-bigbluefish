/**
 * vitest 配置。存在的唯一理由是**测试隔离**：
 * `tests/setup/dsh-home.ts` 把 `$DSH_HOME` 指到本次运行的临时目录，
 * 免得少数用例去读开发者真实的 `~/.dsh/...`（隐私状态文件、用户库路径）。
 *
 * 之前仓库没有这个文件，跑的是 vitest 默认配置——所以那条隔离缺口
 * 一直没有统一的落点（见 `tests/modules/privacy/module.test.ts:81` 的注释）。
 */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    setupFiles: ['./tests/setup/dsh-home.ts'],
  },
})
