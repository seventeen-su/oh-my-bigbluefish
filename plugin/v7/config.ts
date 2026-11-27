/**
 * 插件配置解析：从宿主传入的 `rawConfig` 读字段、给默认值、收集问题。
 *
 * 纯函数：不读环境变量以外的外部状态（环境变量只在缺省时兜底，与旧实现一致），
 * 不做 IO、不持有状态；`apply` 只消费结果，问题以 `problems` 返回给组合根记日志。
 */
export interface V7Config {
  readonly databaseUrl: string
  readonly adminDatabaseUrl?: string
  readonly embeddingModelDir?: string
  readonly residentBudget: number
  readonly jobs: boolean
  readonly autoMigrate: boolean
  readonly managePostgres: boolean
  readonly postgresBinDir?: string
  readonly postgresDataDir?: string
  readonly postgresLogPath?: string
  readonly adoptExisting: boolean
  /** 空数组表示 url 动态值保持关闭；配置后仍需 allowlist + 私网/环回排除。 */
  readonly urlAllowlist: readonly string[]
  readonly urlAllowPrivateAddresses: boolean
  readonly urlTimeoutMs: number
  readonly urlMaxBytes: number
}

export interface ParsedV7Config {
  readonly config: V7Config
  readonly problems: readonly string[]
}

const DEFAULT_DATABASE_URL = 'postgres://omb:omb@127.0.0.1:5432/omb'

export function parseConfig(raw: unknown): ParsedV7Config {
  const record = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
  const problems: string[] = []
  const stringValue = (key: string): string | undefined => {
    const value = record[key]
    if (value === undefined) return undefined
    if (typeof value !== 'string' || value.trim().length === 0) {
      problems.push(`${key} 必须是非空字符串`)
      return undefined
    }
    return value
  }
  const boolValue = (key: string, fallback: boolean): boolean => {
    const value = record[key]
    if (value === undefined) return fallback
    if (typeof value !== 'boolean') {
      problems.push(`${key} 必须是 boolean`)
      return fallback
    }
    return value
  }
  const numberValue = (key: string, fallback: number, min: number, max: number): number => {
    const value = record[key]
    if (value === undefined) return fallback
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
      problems.push(`${key} 必须在 ${min}-${max} 之间`)
      return fallback
    }
    return Math.floor(value)
  }
  const stringArrayValue = (key: string): readonly string[] => {
    const value = record[key]
    if (value === undefined) return []
    if (!Array.isArray(value) || !value.every(item => typeof item === 'string' && item.trim().length > 0)) {
      problems.push(`${key} 必须是非空字符串数组`)
      return []
    }
    return value
  }
  const databaseUrl = stringValue('databaseUrl') ?? process.env.OMB_DATABASE_URL ?? DEFAULT_DATABASE_URL
  const adminDatabaseUrl = stringValue('adminDatabaseUrl') ?? process.env.OMB_ADMIN_DATABASE_URL
  const embeddingModelDir = stringValue('embeddingModelDir') ?? process.env.OMB_EMBEDDING_MODEL
  const managePostgres = boolValue('managePostgres', false)
  const postgresBinDir = stringValue('postgresBinDir') ?? process.env.OMB_PG_BIN_DIR
  const postgresDataDir = stringValue('postgresDataDir') ?? process.env.OMB_PG_DATA_DIR
  const postgresLogPath = stringValue('postgresLogPath') ?? process.env.OMB_PG_LOG_PATH
  if (managePostgres && (postgresBinDir === undefined || postgresDataDir === undefined)) {
    problems.push('managePostgres=true 时必须同时配置 postgresBinDir 和 postgresDataDir')
  }
  return {
    config: {
      databaseUrl,
      ...(adminDatabaseUrl !== undefined ? { adminDatabaseUrl } : {}),
      ...(embeddingModelDir !== undefined ? { embeddingModelDir } : {}),
      ...(postgresBinDir !== undefined ? { postgresBinDir } : {}),
      ...(postgresDataDir !== undefined ? { postgresDataDir } : {}),
      ...(postgresLogPath !== undefined ? { postgresLogPath } : {}),
      residentBudget: numberValue('residentBudget', 600, 100, 2000),
      jobs: boolValue('jobs', true),
      autoMigrate: boolValue('autoMigrate', true),
      managePostgres,
      adoptExisting: boolValue('adoptExisting', false),
      urlAllowlist: stringArrayValue('urlAllowlist'),
      urlAllowPrivateAddresses: boolValue('urlAllowPrivateAddresses', false),
      urlTimeoutMs: numberValue('urlTimeoutMs', 5_000, 250, 60_000),
      urlMaxBytes: numberValue('urlMaxBytes', 256 * 1024, 1024, 4 * 1024 * 1024),
    },
    problems,
  }
}
