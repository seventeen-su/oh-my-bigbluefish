#!/usr/bin/env node
/**
 * OMB v7 数据库初始化/迁移。
 *
 * 只做三件事：确保数据库存在、按文件名顺序执行 migrations、记录校验和。
 * 迁移在单事务里执行；并发进程用 advisory lock 串行化。
 */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MIGRATIONS = join(ROOT, 'packages/v7/src/adapters/postgres/migrations')
const DEFAULT_URL = 'postgres://omb:omb@127.0.0.1:5432/omb'

const url = process.env.OMB_DATABASE_URL ?? DEFAULT_URL
const parsed = new URL(url)
const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''))
if (!database) throw new Error('OMB_DATABASE_URL 缺少数据库名')

async function ensureDatabase() {
  const client = new pg.Client({ connectionString: url })
  try {
    await client.connect()
    const extensions = await client.query("select 1 from pg_extension where extname in ('vector','pg_trgm')")
    if (extensions.rowCount === 2) return
  } catch (error) {
    if (error?.code !== '3D000') throw error
  } finally {
    await client.end().catch(() => {})
  }

  const adminConnection = process.env.OMB_ADMIN_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/postgres'
  const admin = new pg.Client({ connectionString: adminConnection })
  await admin.connect()
  try {
    const found = await admin.query('select 1 from pg_database where datname = $1', [database])
    if (found.rowCount === 0) {
      const safe = database.replaceAll('"', '""')
      const owner = decodeURIComponent(parsed.username)
      const ownerClause = owner.length === 0 ? '' : ` owner "${owner.replaceAll('"', '""')}"`
      await admin.query(`create database "${safe}"${ownerClause}`)
    }
    const target = new URL(adminConnection)
    target.pathname = `/${database}`
    const targetClient = new pg.Client({ connectionString: target.toString() })
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

function migrationFiles() {
  return readdirSync(MIGRATIONS)
    .filter(name => name.endsWith('.sql'))
    .sort()
    .map(name => {
      const sql = readFileSync(join(MIGRATIONS, name), 'utf8')
      return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') }
    })
}

async function migrate() {
  await ensureDatabase()
  const client = new pg.Client({ connectionString: url })
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

    const applied = await client.query('select name, checksum from omb.schema_migrations order by name')
    const byName = new Map(applied.rows.map(row => [row.name, row.checksum]))
    const files = migrationFiles()
    const pending = []
    for (const file of files) {
      const previous = byName.get(file.name)
      if (previous !== undefined) {
        if (previous !== file.checksum) {
          throw new Error(`迁移 ${file.name} 的校验和变了（已应用 ${previous.slice(0, 12)}，当前 ${file.checksum.slice(0, 12)}）`)
        }
        continue
      }
      pending.push(file)
    }

    for (const file of pending) {
      await client.query(file.sql)
      await client.query('insert into omb.schema_migrations (name, checksum) values ($1, $2)', [file.name, file.checksum])
    }
    await client.query('commit')
    await client.query('select pg_advisory_unlock(hashtext($1))', ['omb-v7-migrations'])

    const exts = await client.query(`
      select extname, extversion from pg_extension where extname in ('vector', 'pg_trgm') order by extname
    `)
    const tables = await client.query(`
      select table_name from information_schema.tables
      where table_schema = 'omb' and table_type = 'BASE TABLE' order by table_name
    `)
    console.log(`[v7:db] ${url}`)
    console.log(`[v7:db] 已应用 ${pending.length} 个迁移；总计 ${files.length} 个`)
    console.log(`[v7:db] extensions: ${exts.rows.map(row => `${row.extname}@${row.extversion}`).join(', ')}`)
    console.log(`[v7:db] tables: ${tables.rows.map(row => row.table_name).join(', ')}`)
  } catch (error) {
    await client.query('rollback').catch(() => {})
    throw error
  } finally {
    await client.end().catch(() => {})
  }
}

migrate().catch(error => {
  console.error(`[v7:db] 失败：${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
