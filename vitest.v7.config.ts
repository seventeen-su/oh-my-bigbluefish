import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/v7/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
    setupFiles: [],
  },
})
