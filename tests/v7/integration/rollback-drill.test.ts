import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * 生产回滚演练脚本的真实 PostgreSQL 回归。
 *
 * 不碰生产 `omb` 库：先建一个只到 007 的源库，模拟“升级前备份”，再让脚本
 * 在随机目标库上执行备份→008/009/010 升级→写演练标记→恢复备份→再次升级。
 * 断言脚本报告、目标库清理和源库不受影响。
 */
const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '../../..')
const MIGRATIONS_DIR = join(REPO_ROOT, 'packages/v7/src/adapters/postgres/migrations')
const SCRIPT = join(REPO_ROOT, 'scripts/v7-rollback-drill.mjs')
const ADMIN_URL =
  process.env.OMB_ADMIN_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/postgres'
const BASE_URL = process.env.OMB_DRILL_TEST_BASE_URL ?? 'postgres://omb:omb@127.0.0.1:5432'
const RUN = `${process.pid.toString(36)}_${Date.now().toString(36)}`
const SOURCE_DB = `omb_v7_test_drill_src_${RUN}`
const TARGET_DB = `omb_rollback_drill_test_${RUN}`
const SOURCE_URL = `${BASE_URL}/${SOURCE_DB}`
const PG_BIN =
  process.env.OMB_PG_BIN ??
  (existsSync('D:\\Program\\pg17\\pgsql\\bin') ? 'D:\\Program\\pg17\\pgsql\\bin' : '')

const execFileAsync = promisify(execFile)

function migrationFiles() {
  return readdirSync(MIGRATIONS_DIR)
    .filter(name => name.endsWith('.sql'))
    .sort()
}

function checksumOf(name: string): string {
  return createHash('sha256').update(readFileSync(join(MIGRATIONS_DIR, name), 'utf8')).digest('hex')
}

async function withAdmin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: ADMIN_URL, connectionTimeoutMillis: 5_000 })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end().catch(() => {})
  }
}

async function dropDatabase(name: string): Promise<void> {
  await withAdmin(async admin => {
    await admin.query(`drop database if exists "${name.replaceAll('"', '""')}" with (force)`)
  })
}

async function createSourceDatabase(): Promise<void> {
  await dropDatabase(SOURCE_DB)
  await withAdmin(async admin => {
    const owner = decodeURIComponent(new URL(SOURCE_URL).username)
    await admin.query(`create database "${SOURCE_DB}" owner "${owner.replaceAll('"', '""')}"`)
  })

  const admin = new pg.Client({
    connectionString: `${ADMIN_URL.replace(/\/[^/]*$/, `/${SOURCE_DB}`)}`,
    connectionTimeoutMillis: 5_000,
  })
  await admin.connect()
  try {
    await admin.query('create extension if not exists vector')
    await admin.query('create extension if not exists pg_trgm')
  } finally {
    await admin.end().catch(() => {})
  }

  const client = new pg.Client({ connectionString: SOURCE_URL, connectionTimeoutMillis: 5_000 })
  await client.connect()
  try {
    const files = migrationFiles().filter(name => name < '008_v7_expand.sql')
    await client.query('begin')
    try {
      await client.query('create schema if not exists omb')
      await client.query(`
        create table if not exists omb.schema_migrations (
          name text primary key,
          checksum text not null,
          applied_at timestamptz not null default now()
        )
      `)
      for (const name of files) {
        await client.query(readFileSync(join(MIGRATIONS_DIR, name), 'utf8'))
        await client.query('insert into omb.schema_migrations (name, checksum) values ($1, $2)', [
          name,
          checksumOf(name),
        ])
      }
      await client.query(
        `insert into omb.entity (id, kind, revision, origin, salience, created_at, updated_at)
         values ('mem_drill_fixture', 'memory', 1, 'test', 0.5, '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z')`,
      )
      await client.query(
        `insert into omb.entity_view
           (entity_id, kind, category, scope, project_key, title, attrs, attr_names,
            search_text, triggers, revision, updated_at)
         values ('mem_drill_fixture', 'memory', 'fact', 'global', '', '回滚演练基线',
                 '{"title":"回滚演练基线"}'::jsonb, '{title}'::text[], '回滚演练基线',
                 '{}'::text[], 1, '2026-11-01T00:00:00Z')`,
      )
      await client.query(
        `insert into omb.attribute
           (entity_id, name, ordinal, value_kind, value, is_required, source)
         values ('mem_drill_fixture', 'title', 0, 'static', '{"text":"回滚演练基线"}'::jsonb, false, 'test')`,
      )
      await client.query(
        `insert into omb.audit_log (actor, action, target_ids, before, after, inverse)
         values ('test', 'fixture', array['mem_drill_fixture']::text[], null, null, null)`,
      )
      await client.query('commit')
    } catch (error) {
      await client.query('rollback').catch(() => {})
      throw error
    }
  } finally {
    await client.end().catch(() => {})
  }
}

async function databaseExists(name: string): Promise<boolean> {
  return withAdmin(async admin => {
    const result = await admin.query('select 1 from pg_database where datname = $1', [name])
    return (result.rowCount ?? 0) > 0
  })
}

function drillEnv(): NodeJS.ProcessEnv {
  return { ...process.env, OMB_ADMIN_DATABASE_URL: ADMIN_URL }
}

function pgBinArgs(): string[] {
  return PG_BIN === '' ? [] : [`--pg-bin=${PG_BIN}`]
}

async function expectDrillFailure(args: string[], expected: string): Promise<void> {
  try {
    await execFileAsync(process.execPath, [SCRIPT, ...args], {
      env: drillEnv(),
      timeout: 60_000,
      maxBuffer: 1_000_000,
    })
    throw new Error('演练脚本本应失败，但退出码为 0')
  } catch (error) {
    const failure = error as { stderr?: string; message?: string }
    expect(failure.stderr ?? failure.message ?? '').toContain(expected)
  }
}

describe('生产回滚演练脚本（真实 PostgreSQL）', () => {
  let productionDbExisted = false

  beforeAll(async () => {
    productionDbExisted = await databaseExists('omb')
    await createSourceDatabase()
  }, 120_000)

  afterAll(async () => {
    await dropDatabase(TARGET_DB).catch(() => {})
    await dropDatabase(SOURCE_DB).catch(() => {})
  }, 120_000)

  it('给定 007 源库当在临时库执行演练则升级/回滚/恢复全部通过且目标库被清理', async () => {
    const result = await execFileAsync(
      process.execPath,
      [
        SCRIPT,
        `--source=${SOURCE_URL}`,
        `--target=${TARGET_DB}`,
        `--admin=${ADMIN_URL}`,
        '--yes',
        '--require-upgrade',
        '--max-hash-rows=1000',
        ...pgBinArgs(),
      ],
      { env: drillEnv(), timeout: 180_000, maxBuffer: 4_000_000 },
    )
    expect(result.stderr).toContain('[v7-rollback-drill] 恢复完成')
    const report = JSON.parse(result.stdout) as {
      ok: boolean
      baselineMigrations: string[]
      upgrade: { before: string[]; after: string[]; applied: string[] }
      mutate: { entity: number; view: number; attribute: number; audit: number }
      rollback: { migrationsRestored: boolean; markerGone: boolean; fingerprintEqual: boolean }
      recovery: { health: { ok: boolean } }
      cleanup: { targetDropped: boolean }
    }

    const all = migrationFiles()
    expect(report.ok).toBe(true)
    expect(report.baselineMigrations).toEqual(all.filter(name => name < '008_v7_expand.sql'))
    expect(report.upgrade.before).toEqual(report.baselineMigrations)
    expect(report.upgrade.after).toEqual(all)
    expect(report.upgrade.applied).toEqual(all.filter(name => name >= '008_v7_expand.sql'))
    expect(report.mutate).toEqual({ entity: 1, view: 1, attribute: 1, audit: 1 })
    expect(report.rollback).toMatchObject({
      migrationsRestored: true,
      markerGone: true,
      fingerprintEqual: true,
    })
    expect(report.recovery.health.ok).toBe(true)
    expect(report.cleanup.targetDropped).toBe(true)
    expect(await databaseExists(TARGET_DB)).toBe(false)
    expect(await databaseExists(SOURCE_DB)).toBe(true)
  }, 240_000)

  it('缺少 --yes 时拒绝执行，且不创建目标库', async () => {
    const target = `omb_rollback_drill_guard_${RUN}`
    await expectDrillFailure(
      [`--source=${SOURCE_URL}`, `--target=${target}`, `--admin=${ADMIN_URL}`],
      '确认请加 --yes',
    )
    expect(await databaseExists(target)).toBe(false)
  })

  it('目标名不含 drill 时拒绝执行，且不碰生产库 omb', async () => {
    await expectDrillFailure(
      [
        `--source=${SOURCE_URL}`,
        '--target=omb',
        `--admin=${ADMIN_URL}`,
        '--yes',
      ],
      '不像演练库',
    )
    expect(await databaseExists('omb')).toBe(productionDbExisted)
  })
})
