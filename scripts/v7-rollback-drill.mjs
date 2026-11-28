#!/usr/bin/env node
/**
 * OMB v7 生产回滚演练。
 *
 * 目标：在**临时备份库**上完整走一遍
 *   备份 → 升级到 head → 写入演练数据 → 回滚到升级前备份 → 再次升级恢复
 * 并验证 schema_migrations、核心表指纹和演练标记。生产源库只读（只被 pg_dump 读取）。
 *
 * 设计约束：
 * * 目标库名必须包含 drill/rollback_drill；目标与源不能是同一个库。
 * * 目标库不存在时才创建；重复执行用 --recreate 显式重建。
 * * 任何破坏性动作前必须显式 --yes，且目标名受白名单约束。
 * * 失败不静默：进程退出码 1；默认清理临时库与临时目录，--keep 保留现场。
 * * 不依赖 pnpm；迁移调用仓库已有 scripts/v7-db-setup.mjs，避免两份迁移逻辑。
 *
 * 用法：
 *   node scripts/v7-rollback-drill.mjs --source=postgres://.../omb --yes
 *   node scripts/v7-rollback-drill.mjs --source=postgres://.../omb \
 *     --target=omb_rollback_drill_20261128 --admin=postgres://postgres@127.0.0.1:5432/postgres --yes
 *   node scripts/v7-rollback-drill.mjs --source-dump=D:\\backups\\omb-before.dump \
 *     --target=postgres://omb:omb@127.0.0.1:5432/omb_rollback_drill_20261128 --yes
 *
 * stdout 只输出一行 JSON 报告；进度写 stderr。
 */
import { createHash, randomUUID } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MIGRATIONS_DIR = join(ROOT, 'packages/v7/src/adapters/postgres/migrations')
const DB_SETUP = join(ROOT, 'scripts/v7-db-setup.mjs')
const DEFAULT_ADMIN_URL = 'postgres://postgres@127.0.0.1:5432/postgres'
const TARGET_PATTERN = /(^|[_-])(rollback[_-]?)?drill([_-]|$)/i
const MAX_HASH_ROWS_DEFAULT = 200_000
const COMMAND_TIMEOUT_MS_DEFAULT = 600_000
const CONNECT_TIMEOUT_MS = 8_000

function usage() {
  return [
    '用法：',
    '  node scripts/v7-rollback-drill.mjs --source=<url> [--target=<url|dbname>] [选项]',
    '  node scripts/v7-rollback-drill.mjs --source-dump=<file> --target=<url> [选项]',
    '',
    '必填：',
    '  --source=<url>        升级前/生产源库，只读；与 --source-dump 二选一',
    '  --source-dump=<file>  已有备份（pg_dump custom format）',
    '  --target=<url|dbname> 演练临时库；省略时按源库自动生成 rollback_drill 名',
    '  --yes                 确认允许在目标库执行 drop/create/restore',
    '',
    '可选：',
    '  --admin=<url>         建库/建扩展/删库用的管理连接；默认本地 postgres',
    '  --pg-bin=<dir>        pg_dump/pg_restore 所在目录；默认 OMB_PG_BIN 或本地 pg17',
    '  --recreate            目标库已存在时先删除（仅白名单目标）',
    '  --require-upgrade     源库必须落后于 head，否则失败（验证真实迁移路径）',
    '  --max-hash-rows=N     单表最多对多少行做内容指纹，默认 200000',
    '  --timeout=ms          单条外部命令超时，默认 600000',
    '  --keep                保留目标库与临时备份目录，便于排查',
    '  --help                显示本说明',
  ].join('\n')
}

function fail(message) {
  throw new Error(message)
}

function parseArgs(argv) {
  const options = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help' || argument === '-h') {
      options.set('help', true)
      continue
    }
    if (argument === '--yes' || argument === '--keep' || argument === '--recreate' || argument === '--require-upgrade') {
      options.set(argument.slice(2), true)
      continue
    }
    if (!argument.startsWith('--')) fail(`无法识别的参数：${argument}`)
    const body = argument.slice(2)
    const separator = body.indexOf('=')
    if (separator >= 0) {
      options.set(body.slice(0, separator), body.slice(separator + 1))
      continue
    }
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) fail(`参数 --${body} 缺少值`)
    options.set(body, next)
    index += 1
  }
  return options
}

function intOption(value, fallback, minimum, maximum, label) {
  if (value === undefined) return fallback
  const text = String(value).trim()
  if (!/^\d+$/.test(text)) fail(`${label} 必须是 ${minimum}..${maximum} 的整数，收到：${String(value)}`)
  const parsed = Number.parseInt(text, 10)
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    fail(`${label} 必须是 ${minimum}..${maximum} 的整数，收到：${String(value)}`)
  }
  return parsed
}

function databaseName(url) {
  const parsed = new URL(url)
  const name = decodeURIComponent(parsed.pathname.replace(/^\//, ''))
  if (name.length === 0) fail('连接串缺少数据库名')
  return name
}

function withDatabase(url, name) {
  const parsed = new URL(url)
  parsed.pathname = `/${name}`
  return parsed.toString()
}

function databaseInfo(url) {
  const parsed = new URL(url)
  return {
    database: databaseName(url),
    host: parsed.hostname,
    port: parsed.port === '' ? '5432' : parsed.port,
    user: decodeURIComponent(parsed.username),
  }
}

function connectionEnv(url) {
  const parsed = new URL(url)
  const env = {
    ...process.env,
    PGHOST: parsed.hostname,
    PGPORT: parsed.port === '' ? '5432' : parsed.port,
    PGUSER: decodeURIComponent(parsed.username),
    PGDATABASE: databaseName(url),
    PGSSLMODE: parsed.searchParams.get('sslmode') ?? process.env.PGSSLMODE ?? 'prefer',
  }
  if (parsed.password !== '') env.PGPASSWORD = decodeURIComponent(parsed.password)
  else delete env.PGPASSWORD
  return env
}

function redact(message, urls) {
  let text = String(message)
  for (const url of urls) {
    try {
      const parsed = new URL(url)
      if (parsed.password !== '') text = text.replaceAll(decodeURIComponent(parsed.password), '***')
      text = text.replaceAll(url, `${parsed.protocol}//${parsed.hostname}${parsed.port === '' ? '' : `:${parsed.port}`}/${databaseName(url)}`)
    } catch {
      // 忽略不是 URL 的输入；错误文本仍按原文返回。
    }
  }
  return text
}

function log(message) {
  process.stderr.write(`[v7-rollback-drill] ${message}\n`)
}

function tail(text, limit = 4_000) {
  const trimmed = String(text).trim()
  return trimmed.length <= limit ? trimmed : `…${trimmed.slice(-limit)}`
}

function runCommand(bin, args, env, timeoutMs) {
  return new Promise((resolvePromise, reject) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const child = spawn(bin, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      reject(new Error(`命令超时（${timeoutMs}ms）：${bin} ${args.join(' ')}`))
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      if (stdout.length < 2_000_000) stdout += chunk
    })
    child.stderr.on('data', chunk => {
      if (stderr.length < 2_000_000) stderr += chunk
    })
    child.on('error', error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', code => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code === 0) {
        resolvePromise({ stdout, stderr })
      } else {
        reject(new Error(`命令失败（退出码 ${String(code)}）：${bin} ${args.join(' ')}\n${tail(stderr) || tail(stdout)}`))
      }
    })
  })
}

function executableName(base) {
  return process.platform === 'win32' ? `${base}.exe` : base
}

function resolvePostgresBin(options) {
  const explicit = options.get('pg-bin') ?? process.env.OMB_PG_BIN
  const candidates = []
  if (explicit !== undefined && explicit !== '') candidates.push(resolve(explicit))
  if (process.platform === 'win32') candidates.push('D:\\Program\\pg17\\pgsql\\bin')
  const found = candidates.find(candidate =>
    existsSync(join(candidate, executableName('pg_dump'))) &&
    existsSync(join(candidate, executableName('pg_restore'))),
  )
  if (found !== undefined) {
    return {
      pgDump: join(found, executableName('pg_dump')),
      pgRestore: join(found, executableName('pg_restore')),
    }
  }
  if (explicit !== undefined && explicit !== '') {
    fail(`--pg-bin 目录里缺少 pg_dump/pg_restore：${resolve(explicit)}`)
  }
  const probe = spawnSync(executableName('pg_dump'), ['--version'], { encoding: 'utf8', windowsHide: true })
  const restoreProbe = spawnSync(executableName('pg_restore'), ['--version'], { encoding: 'utf8', windowsHide: true })
  if (probe.status !== 0 || restoreProbe.status !== 0) {
    fail('找不到 pg_dump/pg_restore；请用 --pg-bin 指向 PostgreSQL bin 目录，或设置 OMB_PG_BIN')
  }
  return { pgDump: executableName('pg_dump'), pgRestore: executableName('pg_restore') }
}

async function withClient(url, fn, { readOnly = false, timeoutMs = 120_000 } = {}) {
  const client = new pg.Client({
    connectionString: url,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    statement_timeout: timeoutMs,
  })
  await client.connect()
  try {
    if (readOnly) await client.query('set default_transaction_read_only = on')
    await client.query("set timezone = 'UTC'")
    await client.query("set datestyle = 'ISO, MDY'")
    await client.query("set intervalstyle = 'postgres'")
    await client.query('set extra_float_digits = 3')
    return await fn(client)
  } finally {
    await client.end().catch(() => {})
  }
}

async function queryOne(client, sql, params = []) {
  const result = await client.query(sql, params)
  const row = result.rows[0]
  if (row === undefined) fail(`查询没有返回行：${sql}`)
  return row
}

function quoteIdent(name) {
  return `"${String(name).replaceAll('"', '""')}"`
}

function migrationFiles() {
  return readdirSync(MIGRATIONS_DIR)
    .filter(name => name.endsWith('.sql'))
    .sort()
    .map(name => {
      const sql = readFileSync(join(MIGRATIONS_DIR, name), 'utf8')
      return { name, checksum: createHash('sha256').update(sql).digest('hex') }
    })
}

async function readMigrations(client) {
  const exists = await client.query(
    `select 1 from information_schema.tables
      where table_schema = 'omb' and table_name = 'schema_migrations'`,
  )
  if (exists.rowCount === 0) fail('源库不是 OMB v7 库：缺少 omb.schema_migrations')
  const result = await client.query('select name, checksum from omb.schema_migrations order by name')
  return result.rows.map(row => ({ name: row.name, checksum: row.checksum }))
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function compareMigrations(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

async function createScratch(adminUrl, targetUrl, recreate) {
  const targetName = databaseName(targetUrl)
  const owner = decodeURIComponent(new URL(targetUrl).username)
  const admin = new pg.Client({ connectionString: adminUrl, connectionTimeoutMillis: CONNECT_TIMEOUT_MS })
  await admin.connect()
  try {
    const exists = await admin.query('select 1 from pg_database where datname = $1', [targetName])
    if (exists.rowCount > 0 && !recreate) {
      fail(`目标库 ${targetName} 已存在；换一个名字，或显式加 --recreate`)
    }
    if (exists.rowCount > 0) await admin.query(`drop database if exists ${quoteIdent(targetName)} with (force)`)
    const ownerClause = owner === '' ? '' : ` owner ${quoteIdent(owner)}`
    await admin.query(`create database ${quoteIdent(targetName)}${ownerClause}`)
  } finally {
    await admin.end().catch(() => {})
  }

  // 扩展由管理连接安装；pg_restore 里的 CREATE EXTENSION IF NOT EXISTS 会变成 no-op。
  const targetAdminUrl = withDatabase(adminUrl, targetName)
  await withClient(targetAdminUrl, async client => {
    await client.query('create extension if not exists vector')
    await client.query('create extension if not exists pg_trgm')
  })
}

async function dropScratch(adminUrl, targetUrl) {
  const targetName = databaseName(targetUrl)
  if (!TARGET_PATTERN.test(targetName)) fail(`拒绝删除非演练库：${targetName}`)
  const admin = new pg.Client({ connectionString: adminUrl, connectionTimeoutMillis: CONNECT_TIMEOUT_MS })
  await admin.connect()
  try {
    await admin.query(`drop database if exists ${quoteIdent(targetName)} with (force)`)
  } finally {
    await admin.end().catch(() => {})
  }
}

async function dumpSource(sourceUrl, dumpPath, pgDump, timeoutMs) {
  const info = databaseInfo(sourceUrl)
  const result = await runCommand(
    pgDump,
    [
      `--dbname=${info.database}`,
      '--format=custom',
      `--file=${dumpPath}`,
      '--no-owner',
      '--no-privileges',
      '--lock-wait-timeout=60s',
    ],
    connectionEnv(sourceUrl),
    timeoutMs,
  )
  if (result.stderr.trim() !== '') log(`pg_dump 提示：${tail(result.stderr, 1_000)}`)
  const bytes = statSync(dumpPath).size
  if (bytes === 0) fail('pg_dump 生成了空文件')
  return { path: dumpPath, bytes, sha256: sha256File(dumpPath) }
}

async function restoreDump(targetUrl, dumpPath, pgRestore, timeoutMs) {
  const info = databaseInfo(targetUrl)
  const result = await runCommand(
    pgRestore,
    [
      `--dbname=${info.database}`,
      '--no-owner',
      '--no-privileges',
      '--no-comments',
      '--exit-on-error',
      dumpPath,
    ],
    connectionEnv(targetUrl),
    timeoutMs,
  )
  if (result.stderr.trim() !== '') log(`pg_restore 提示：${tail(result.stderr, 1_000)}`)
}

async function applyMigrations(targetUrl, adminUrl, timeoutMs) {
  const result = await runCommand(
    process.execPath,
    [DB_SETUP],
    {
      ...process.env,
      OMB_DATABASE_URL: targetUrl,
      OMB_ADMIN_DATABASE_URL: adminUrl,
    },
    timeoutMs,
  )
  const match = /已应用\s+(\d+)\s+个迁移/.exec(result.stdout)
  return {
    applied: match === null ? null : Number.parseInt(match[1], 10),
    output: result.stdout.trim(),
  }
}

async function listTables(client) {
  const result = await client.query(
    `select table_name from information_schema.tables
      where table_schema = 'omb' and table_type = 'BASE TABLE'
      order by table_name`,
  )
  return result.rows.map(row => row.table_name)
}

async function schemaFingerprint(client) {
  const columns = await queryOne(
    client,
    `select coalesce(md5(string_agg(
       table_name || '.' || column_name || ':' || data_type || ':' || is_nullable,
       E'\\n' order by table_name, ordinal_position)), '') as hash
     from information_schema.columns where table_schema = 'omb'`,
  )
  const indexes = await queryOne(
    client,
    `select coalesce(md5(string_agg(indexname || ':' || indexdef, E'\\n' order by indexname)), '') as hash
     from pg_indexes where schemaname = 'omb'`,
  )
  return { columns: columns.hash, indexes: indexes.hash }
}

async function fingerprint(client, maxHashRows) {
  const tables = await listTables(client)
  const digests = {}
  const unhashed = []
  for (const table of tables) {
    const quoted = quoteIdent(table)
    const count = await queryOne(client, `select count(*)::bigint as rows from omb.${quoted}`)
    const rows = Number(count.rows)
    if (rows > maxHashRows) {
      digests[table] = { rows, hash: null }
      unhashed.push(table)
      continue
    }
    const hash = await queryOne(
      client,
      `select coalesce(md5(string_agg(t::text, E'\\n' order by t::text)), '') as hash from omb.${quoted} t`,
    )
    digests[table] = { rows, hash: hash.hash }
  }
  return { tables: digests, schema: await schemaFingerprint(client), unhashed }
}

function compareFingerprints(left, right) {
  const differences = []
  const leftTables = Object.keys(left.tables).sort()
  const rightTables = Object.keys(right.tables).sort()
  for (const table of leftTables) {
    if (!(table in right.tables)) {
      differences.push(`表 ${table} 只存在于基线`)
      continue
    }
    const a = left.tables[table]
    const b = right.tables[table]
    if (a.rows !== b.rows) differences.push(`表 ${table} 行数 ${a.rows} -> ${b.rows}`)
    if (a.hash !== null && b.hash !== null && a.hash !== b.hash) differences.push(`表 ${table} 内容哈希不同`)
  }
  for (const table of rightTables) {
    if (!(table in left.tables)) differences.push(`表 ${table} 只存在于回滚后`)
  }
  if (left.schema.columns !== right.schema.columns) differences.push('列定义哈希不同')
  if (left.schema.indexes !== right.schema.indexes) differences.push('索引定义哈希不同')
  return differences
}

async function mutateDrillData(client, marker) {
  await client.query('begin')
  try {
    await client.query(
      `insert into omb.entity (id, kind, revision, origin, salience, created_at, updated_at)
       values ($1, 'memory', 1, 'rollback-drill', 0.5, now(), now())`,
      [marker],
    )
    await client.query(
      `insert into omb.entity_view
         (entity_id, kind, category, scope, project_key, title, attrs,
          search_text, updated_at)
       values ($1, 'memory', 'fact', 'global', '', '回滚演练标记',
               '{"title":"回滚演练标记"}'::jsonb,
               '回滚演练标记', now())`,
      [marker],
    )
    await client.query(
      `insert into omb.attribute
         (entity_id, name, ordinal, value_kind, value, is_required, source)
       values ($1, 'title', 0, 'static', '{"text":"回滚演练标记"}'::jsonb, false, 'rollback-drill')`,
      [marker],
    )
    await client.query(
      `insert into omb.audit_log
         (actor, action, target_ids, before, after, inverse)
       values ('rollback-drill', 'drill-write', array[$1]::text[],
               '{"drill":true}'::jsonb, '{"drill":true}'::jsonb,
               jsonb_build_object('action', 'remove_written', 'entityId', $1::text))`,
      [marker],
    )
    await client.query('commit')
  } catch (error) {
    await client.query('rollback').catch(() => {})
    throw error
  }

  const entity = await queryOne(client, 'select count(*)::int as n from omb.entity where id = $1', [marker])
  const view = await queryOne(client, 'select count(*)::int as n from omb.entity_view where entity_id = $1', [marker])
  const attribute = await queryOne(client, 'select count(*)::int as n from omb.attribute where entity_id = $1', [marker])
  const audit = await queryOne(
    client,
    'select count(*)::int as n from omb.audit_log where target_ids @> array[$1]::text[]',
    [marker],
  )
  return { entity: entity.n, view: view.n, attribute: attribute.n, audit: audit.n }
}

async function markerRows(client, marker) {
  const entity = await queryOne(client, 'select count(*)::int as n from omb.entity where id = $1', [marker])
  const audit = await queryOne(
    client,
    'select count(*)::int as n from omb.audit_log where target_ids @> array[$1]::text[]',
    [marker],
  )
  return { entity: entity.n, audit: audit.n }
}

async function health(client, expectedMigrations) {
  const current = await readMigrations(client)
  const orphanViews = await queryOne(
    client,
    `select count(*)::int as n from omb.entity_view v
      left join omb.entity e on e.id = v.entity_id where e.id is null`,
  )
  const orphanAttributes = await queryOne(
    client,
    `select count(*)::int as n from omb.attribute a
      left join omb.entity e on e.id = a.entity_id where e.id is null`,
  )
  const unknown = current.filter(row => !expectedMigrations.some(file => file.name === row.name))
  return {
    ok: current.length === expectedMigrations.length && unknown.length === 0 &&
      orphanViews.n === 0 && orphanAttributes.n === 0,
    migrations: current.map(row => row.name),
    orphanViews: orphanViews.n,
    orphanAttributes: orphanAttributes.n,
    unknownMigrations: unknown.map(row => row.name),
  }
}

function targetUrlFrom(options, sourceUrl, adminUrl) {
  const raw = options.get('target')
  if (raw === undefined) {
    const stamp = new Date().toISOString().replaceAll(/[-:TZ.]/g, '').slice(0, 14)
    const base = sourceUrl ?? adminUrl
    return withDatabase(base, `omb_rollback_drill_${stamp}`)
  }
  if (raw.includes('://')) return raw
  const base = sourceUrl ?? adminUrl
  return withDatabase(base, raw)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.get('help') === true) {
    process.stderr.write(`${usage()}\n`)
    return
  }
  const sourceUrl = args.get('source')
  const sourceDump = args.get('source-dump')
  if ((sourceUrl === undefined) === (sourceDump === undefined)) {
    fail('必须且只能提供 --source 或 --source-dump 之一\n\n' + usage())
  }
  if (args.get('yes') !== true) fail('回滚演练会 drop/create 临时库；确认请加 --yes')
  if (sourceDump !== undefined && !existsSync(sourceDump)) fail(`备份文件不存在：${sourceDump}`)

  const adminUrl = args.get('admin') ?? process.env.OMB_ADMIN_DATABASE_URL ?? DEFAULT_ADMIN_URL
  const targetUrl = targetUrlFrom(args, sourceUrl, adminUrl)
  const targetName = databaseName(targetUrl)
  if (!TARGET_PATTERN.test(targetName)) {
    fail(`目标库名 ${targetName} 不像演练库；必须包含 drill 或 rollback_drill`)
  }
  if (sourceUrl !== undefined && databaseName(sourceUrl) === targetName) {
    fail('目标库不能与源库相同')
  }
  const pgBin = resolvePostgresBin(args)
  const maxHashRows = intOption(args.get('max-hash-rows'), MAX_HASH_ROWS_DEFAULT, 0, 5_000_000, '--max-hash-rows')
  const timeoutMs = intOption(args.get('timeout'), COMMAND_TIMEOUT_MS_DEFAULT, 10_000, 3_600_000, '--timeout')
  const keep = args.get('keep') === true
  const recreate = args.get('recreate') === true
  const requireUpgrade = args.get('require-upgrade') === true
  const head = migrationFiles()
  const marker = `drill_${randomUUID()}`
  const startedAt = new Date().toISOString()
  const startedMs = Date.now()
  const tempDir = mkdtempSync(join(tmpdir(), 'omb-rollback-drill-'))
  const dumpPath = join(tempDir, 'baseline.dump')

  let targetCreated = false
  let baselineMigrations = []
  let baselineFingerprint = null
  let dump = null
  const report = {
    ok: false,
    marker,
    startedAt,
    source: sourceUrl === undefined ? { dump: sourceDump } : databaseInfo(sourceUrl),
    target: databaseInfo(targetUrl),
    headMigrations: head.map(file => file.name),
    baselineMigrations: [],
    upgrade: null,
    mutate: null,
    rollback: null,
    recovery: null,
    fingerprint: null,
    dump: null,
    warnings: [],
    cleanup: null,
  }

  try {
    log(`源：${sourceUrl === undefined ? sourceDump : databaseInfo(sourceUrl).database}；目标：${targetName}；head=${head.length} 个迁移`)

    if (sourceUrl !== undefined) {
      await withClient(sourceUrl, async client => {
        baselineMigrations = await readMigrations(client)
      }, { readOnly: true })
    }

    if (sourceDump !== undefined) {
      dump = { path: sourceDump, bytes: statSync(sourceDump).size, sha256: sha256File(sourceDump), provided: true }
      log(`使用现有备份 ${sourceDump}（${dump.bytes} bytes，sha256=${dump.sha256.slice(0, 12)}…）`)
    } else {
      log('1/5 生成升级前备份（pg_dump custom format）')
      dump = { ...(await dumpSource(sourceUrl, dumpPath, pgBin.pgDump, timeoutMs)), provided: false }
      log(`备份完成：${dump.bytes} bytes，sha256=${dump.sha256.slice(0, 12)}…`)
    }

    if (baselineMigrations.length === 0) {
      // source-dump 模式没有源连接，只能从恢复后的库里读基线迁移。
      log('未提供源连接，基线迁移表将在恢复后读取')
    }
    if (requireUpgrade && baselineMigrations.length === head.length) {
      fail('源库已经在 head；--require-upgrade 要求存在待升级迁移')
    }

    log('2/5 创建临时库并恢复升级前备份')
    await createScratch(adminUrl, targetUrl, recreate)
    targetCreated = true
    await restoreDump(targetUrl, dump.path, pgBin.pgRestore, timeoutMs)

    const baseline = await withClient(targetUrl, async client => {
      const migrations = await readMigrations(client)
      return { migrations, fingerprint: await fingerprint(client, maxHashRows) }
    })
    baselineMigrations = baseline.migrations
    baselineFingerprint = baseline.fingerprint
    if (baselineMigrations.length === 0) fail('恢复后的备份没有 schema_migrations')
    if (requireUpgrade && baselineMigrations.length === head.length) {
      fail('备份已经在 head；--require-upgrade 要求存在待升级迁移')
    }

    const initialHealth = await withClient(targetUrl, client => health(client, baselineMigrations))
    if (!initialHealth.ok) fail(`升级前基线健康检查失败：${JSON.stringify(initialHealth)}`)

    log(`3/5 升级：${baselineMigrations.length} -> ${head.length} 个迁移`)
    const upgrade = await applyMigrations(targetUrl, adminUrl, timeoutMs)
    const upgraded = await withClient(targetUrl, async client => {
      const migrations = await readMigrations(client)
      const currentHealth = await health(client, head)
      return { migrations, health: currentHealth }
    })
    if (!upgraded.health.ok) fail(`升级后健康检查失败：${JSON.stringify(upgraded.health)}`)
    const applied = upgraded.migrations.filter(row => !baselineMigrations.some(old => old.name === row.name))
    if (requireUpgrade && applied.length === 0) fail('升级没有应用任何迁移，无法验证迁移路径')
    report.upgrade = {
      before: baselineMigrations.map(row => row.name),
      after: upgraded.migrations.map(row => row.name),
      applied: applied.map(row => row.name),
      setupApplied: upgrade.applied,
      health: upgraded.health,
    }
    log(`升级完成：应用 ${applied.length} 个迁移（${applied.map(row => row.name).join(', ') || '无待应用'}）`)

    log('4/5 写入演练数据')
    const mutated = await withClient(targetUrl, client => mutateDrillData(client, marker))
    if (Object.values(mutated).some(count => count !== 1)) {
      fail(`演练写入不完整：${JSON.stringify(mutated)}`)
    }
    report.mutate = mutated
    log(`演练标记已写入：${marker}`)

    log('5/5 回滚：删除并重建临时库，恢复升级前备份')
    await dropScratch(adminUrl, targetUrl)
    targetCreated = false
    await createScratch(adminUrl, targetUrl, true)
    targetCreated = true
    await restoreDump(targetUrl, dump.path, pgBin.pgRestore, timeoutMs)

    const rolledBack = await withClient(targetUrl, async client => {
      const migrations = await readMigrations(client)
      const markers = await markerRows(client, marker)
      const currentFingerprint = await fingerprint(client, maxHashRows)
      const differences = compareFingerprints(baselineFingerprint, currentFingerprint)
      return { migrations, markers, fingerprint: currentFingerprint, differences }
    })
    const migrationsRestored = compareMigrations(rolledBack.migrations, baselineMigrations)
    const markerGone = rolledBack.markers.entity === 0 && rolledBack.markers.audit === 0
    const fingerprintEqual = rolledBack.differences.length === 0
    report.rollback = {
      migrations: rolledBack.migrations.map(row => row.name),
      migrationsRestored,
      markerRows: rolledBack.markers,
      markerGone,
      fingerprintEqual,
      differences: rolledBack.differences,
    }
    if (!migrationsRestored) fail('回滚后 schema_migrations 与基线不一致')
    if (!markerGone) fail('回滚后演练标记仍然存在')
    if (!fingerprintEqual) fail(`回滚后数据指纹不一致：${rolledBack.differences.join('；')}`)
    log(`回滚完成：迁移=${rolledBack.migrations.length}，标记已消失，指纹一致`)

    log('恢复：重新升级到 head 并做健康检查')
    await applyMigrations(targetUrl, adminUrl, timeoutMs)
    const recovered = await withClient(targetUrl, async client => {
      const migrations = await readMigrations(client)
      return { migrations, health: await health(client, head) }
    })
    report.recovery = {
      migrations: recovered.migrations.map(row => row.name),
      health: recovered.health,
    }
    if (!recovered.health.ok) fail(`恢复后健康检查失败：${JSON.stringify(recovered.health)}`)
    log(`恢复完成：迁移=${recovered.migrations.length}，健康检查通过`)

    report.dump = {
      bytes: dump.bytes,
      sha256: dump.sha256,
      path: keep ? dump.path : null,
      provided: sourceDump !== undefined,
    }
    report.baselineMigrations = baselineMigrations.map(row => row.name)
    report.fingerprint = {
      baseline: baselineFingerprint.schema,
      tables: Object.keys(baselineFingerprint.tables).length,
      unhashed: baselineFingerprint.unhashed,
    }
    report.ok = true
  } catch (error) {
    report.error = redact(error instanceof Error ? error.message : String(error), [sourceUrl, targetUrl, adminUrl].filter(Boolean))
    log(`失败：${report.error}`)
    process.exitCode = 1
  } finally {
    const cleanup = { targetDropped: false, tempRemoved: false, kept: keep }
    if (targetCreated && !keep) {
      try {
        await dropScratch(adminUrl, targetUrl)
        cleanup.targetDropped = true
      } catch (error) {
        cleanup.targetError = redact(error instanceof Error ? error.message : String(error), [targetUrl, adminUrl])
        report.warnings.push(`清理目标库失败：${cleanup.targetError}`)
        report.ok = false
        process.exitCode = 1
      }
    }
    if (!keep) {
      try {
        rmSync(tempDir, { recursive: true, force: true })
        cleanup.tempRemoved = true
      } catch (error) {
        cleanup.tempError = error instanceof Error ? error.message : String(error)
        report.warnings.push(`清理临时目录失败：${cleanup.tempError}`)
        report.ok = false
        process.exitCode = 1
      }
    }
    report.cleanup = cleanup
    report.finishedAt = new Date().toISOString()
    report.durationMs = Date.now() - startedMs
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  }
}

main().catch(error => {
  process.stderr.write(`[v7-rollback-drill] 未捕获失败：${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
