// OMB v7 分层门禁：domain/app/retrieval 不得接触 IO；adapters 才允许。
// 根 eslint.config.mjs 仍管旧代码；v7 用独立配置，避免旧规则把新分层判错。
import tseslint from 'typescript-eslint'

const v7Files = ['packages/v7/**/*.ts', 'plugin/v7/**/*.ts', 'tests/v7/**/*.ts']

const forbid = patterns => ['error', { patterns }]

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/lib-gen/**', '**/*.d.ts'] },
  ...tseslint.configs.recommended,
  {
    files: v7Files,
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': 'off',
      eqeqeq: ['error', 'always'],
      'prefer-const': 'error',
    },
  },
  {
    files: ['packages/v7/src/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': forbid([
        { group: ['node:*', 'pg', 'pg-boss', 'quickjs-emscripten', '../adapters/*', '../app/*', '../retrieval/*', '../recall/*', '../jobs/*'], message: 'domain 必须纯净：不得依赖 IO/上层' },
      ]),
    },
  },
  {
    files: ['packages/v7/src/app/**/*.ts', 'packages/v7/src/retrieval/**/*.ts', 'packages/v7/src/recall/**/*.ts'],
    rules: {
      'no-restricted-imports': forbid([
        { group: ['pg', 'pg-boss', 'quickjs-emscripten', '../adapters/*', '../../adapters/*'], message: 'app/retrieval 只能依赖 ports，不得直接依赖适配器' },
      ]),
    },
  },
  {
    files: ['packages/v7/src/adapters/**/*.ts', 'plugin/v7/**/*.ts'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },
)
