import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { assertDestructiveAllowed } from '../../security/trust.js'

/**
 * 源码测试时 migrations 与 migrate.ts 同目录；esbuild 单文件产物在
 * `lib-gen/v7-gN/plugin/v7/index.js`，迁移目录要从包根 `packages/v7/...` 找。
 * 两条候选都保留，部署时也可把 migrations 复制到产物旁边。
 */
function resolveMigrationsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    join(here, 'migrations'),
    resolve(here, '../../../../packages/v7/src/adapters/postgres/migrations'),
    resolve(here, '../../../packages/v7/src/adapters/postgres/migrations'),
    process.env.OMB_MIGRATIONS_DIR ?? '',
  ].filter(candidate => candidate.length > 0)
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return candidates[0] as string
}

const MIGRATIONS_DIR = resolveMigrationsDir()
const CONNECT_TIMEOUT_MS = 5_000

export interface MigrationReport {
  readonly applied: readonly string[]
  readonly total: number
}

function databaseName(connectionString: string): string {
  const parsed = new URL(connectionString)
  const name = decodeURIComponent(parsed.pathname.replace(/^\//, ''))
  if (name.length === 0) throw new Error('连接串缺少数据库名')
  return name
}

function withDatabase(connectionString: string, name: string): string {
  const parsed = new URL(connectionString)
  parsed.pathname = `/${name}`
  return parsed.toString()
}

export async function ensureDatabase(connectionString: string, adminConnectionString?: string): Promise<void> {
  const target = databaseName(connectionString)
  const adminUrl = adminConnectionString ?? process.env.OMB_ADMIN_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/postgres'
  let exists = false
  const probe = new pg.Client({ connectionString, connectionTimeoutMillis: CONNECT_TIMEOUT_MS })
  try {
    await probe.connect()
    exists = true
    const extensions = await probe.query("select 1 from pg_extension where extname in ('vector','pg_trgm')")
    if (extensions.rowCount === 2) return
  } catch (error) {
    if ((error as { code?: string }).code !== '3D000') throw error
  } finally {
    await probe.end().catch(() => {})
  }

  const admin = new pg.Client({ connectionString: adminUrl, connectionTimeoutMillis: CONNECT_TIMEOUT_MS })
  await admin.connect()
  try {
    const owner = decodeURIComponent(new URL(connectionString).username)
    if (!exists) {
      const quoted = target.replaceAll('"', '""')
      const ownerClause = owner.length === 0 ? '' : ` owner "${owner.replaceAll('"', '""')}"`
      await admin.query(`create database "${quoted}"${ownerClause}`)
    }
    // 扩展必须由有权限的角色安装；业务角色只使用已安装的扩展。
    const targetClient = new pg.Client({
      connectionString: withDatabase(adminUrl, target),
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    })
    await targetClient.connect()
    try {
      await targetClient.query('create extension if not exists vector')
      await targetClient.query('create extension if not exists pg_trgm')
    } finally {
      await targetClient.end()
    }
  } finally {
    await admin.end()
  }
}

export async function migrateDatabase(connectionString: string, adminConnectionString?: string): Promise<MigrationReport> {
  await ensureDatabase(connectionString, adminConnectionString)
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: CONNECT_TIMEOUT_MS })
  await client.connect()
  try {
    await client.query('select pg_advisory_lock(hashtext($1))', ['omb-v7-migrations'])
    await client.query('begin')
    await client.query('create schema if not exists omb')
    await client.query(`
      create table if not exists omb.schema_migrations (
        name text primary key,
        checksum text not null,
        applied_at timestamptz not null default now()
      )
    `)
    const files = readdirSync(MIGRATIONS_DIR)
      .filter(name => name.endsWith('.sql'))
      .sort()
    const applied = await client.query<{ name: string; checksum: string }>('select name, checksum from omb.schema_migrations')
    const known = new Map(applied.rows.map(row => [row.name, row.checksum]))
    const pending: string[] = []
    for (const name of files) {
      const sql = readFileSync(join(MIGRATIONS_DIR, name), 'utf8')
      const checksum = createHash('sha256').update(sql).digest('hex')
      const previous = known.get(name)
      if (previous !== undefined) {
        if (previous !== checksum) throw new Error(`迁移 ${name} 校验和变化`)
        continue
      }
      await client.query(sql)
      await client.query('insert into omb.schema_migrations (name, checksum) values ($1,$2)', [name, checksum])
      pending.push(name)
    }
    await client.query('commit')
    await client.query('select pg_advisory_unlock(hashtext($1))', ['omb-v7-migrations'])
    return { applied: pending, total: files.length }
  } catch (error) {
    await client.query('rollback').catch(() => {})
    throw error
  } finally {
    await client.end().catch(() => {})
  }
}

export async function truncateAll(connectionString: string): Promise<void> {
  // 破坏性操作在建立连接之前就被授权判定拦住（ADR-0010）：
  // 生产库名、NODE_ENV=production、缺少显式 flag 的路径都碰不到任何一行。
  const databaseName = assertDestructiveAllowed(connectionString)
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: CONNECT_TIMEOUT_MS })
  await client.connect()
  try {
    const schema = await client.query("select 1 from information_schema.schemata where schema_name = 'omb'")
    if (schema.rowCount === 0) return
    await client.query(`
      truncate table
        omb.recall_event,
        omb.resident_trace,
        omb.audit_log,
        omb.reference,
        omb.dynamic_stale,
        omb.dynamic_dependency,
        omb.trigger_key,
        omb.chain_member,
        omb.link,
        omb.embedding,
        omb.attribute,
        omb.entity_view,
        omb.entity,
        omb.attr_registry,
        omb.artifact,
        omb.conflict_suppression,
        omb.project_identity
      restart identity cascade
    `)
    // 审计链被清空后重新从空链开始：这条日志只是给误操作留可追溯线索，不写库。
    if (process.env.NODE_ENV !== 'test') {
      console.warn(`[omb] 已清空数据库 ${databaseName} 的 omb schema 数据`)
    }
  } finally {
    await client.end()
  }
}
