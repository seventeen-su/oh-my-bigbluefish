export type OmbErrorCode =
  | 'invalid-input'
  | 'not-found'
  | 'conflict'
  | 'forbidden'
  | 'archived'
  | 'db-unavailable'
  | 'sandbox-timeout'
  | 'sandbox-error'
  | 'reference-cycle'
  | 'unsupported'
  | 'internal'

export interface OmbError {
  readonly code: OmbErrorCode
  readonly message: string
  readonly details?: unknown
  readonly retryable?: boolean
}

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: OmbError }

export function ok<T>(value: T): Result<T> {
  return { ok: true, value }
}

export function err<T = never>(error: OmbError): Result<T> {
  return { ok: false, error }
}

export function invalid(message: string, details?: unknown): OmbError {
  return { code: 'invalid-input', message, details }
}

export function notFound(message: string, details?: unknown): OmbError {
  return { code: 'not-found', message, details }
}

export function conflict(message: string, details?: unknown): OmbError {
  return { code: 'conflict', message, details }
}

/** 越权/授权失败：调用方已通过参数校验，但当前 actor/租户对目标没有权限。 */
export function forbidden(message: string, details?: unknown): OmbError {
  return { code: 'forbidden', message, details, retryable: false }
}

export function internal(message: string, details?: unknown): OmbError {
  return { code: 'internal', message, details }
}

export class OmbFailure extends Error {
  readonly error: OmbError

  constructor(error: OmbError) {
    super(error.message)
    this.name = 'OmbFailure'
    this.error = error
  }
}

export function fail(error: OmbError): never {
  throw new OmbFailure(error)
}

export function toOmbError(value: unknown, fallback = 'internal' as OmbErrorCode): OmbError {
  if (value instanceof OmbFailure) return value.error
  if (value instanceof Error) {
    return { code: fallback, message: value.message }
  }
  return { code: fallback, message: String(value) }
}
