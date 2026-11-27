import type { OmbError } from './errors.js'

/**
 * 校验结果契约：领域层统一用「字段级 issue 列表」表达输入错误，
 * 入口层（app/adapters）再把它转成 `OmbError`。
 */

export interface ValidationIssue {
  readonly field: string
  readonly message: string
}

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly ValidationIssue[] }

export function validationError(errors: readonly ValidationIssue[]): OmbError {
  return {
    code: 'invalid-input',
    message: errors.map(issue => `${issue.field}: ${issue.message}`).join('；'),
    details: errors,
  }
}
