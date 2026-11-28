#!/usr/bin/env node
/**
 * OMB v7 数据库连接安全检查（单次、只读）。
 *
 * 只做一次系统目录查询：监听范围、TLS、pg_hba 认证方式（能读到时）、角色权限、
 * 默认口令与审计表所有权。不做后台监控、不轮询、不写任何表、不建扩展。
 *
 * 安全边界：
 * - 必须显式给 --url；不读环境变量、不连接任何默认库；
 * - 非 loopback 目标要求 --allow-remote，避免误连生产；
 * - 全程 `BEGIN TRANSACTION READ ONLY` + statement_timeout；
 * - 输出只显示 user@host:port/db，不打印口令，错误信息也做脱敏。
 */
import pg from 'pg'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost'])
const LOOPBACK_ADDRESS = /^(?:127\.\d+\.\d+\.\d+|::1|localhost)(?:\/\d+)?$/i

const HELP = `OMB v7 数据库连接安全检查（单次、只读）

用法：
  node scripts/v7-db-security-check.mjs --url <postgres-url> [选项]

选项：
  --url <dsn>      要检查的连接串（必填；不读环境变量，也不回落到任何默认库）。
  --json           以 JSON 输出结果（同样不含口令）。
  --allow-remote   允许检查非 loopback 地址；默认拒绝，避免误连生产。
  --strict         把 WARN 也视为失败（退出码 1）。
  --help, -h       显示本帮助。

检查内容（只读系统目录）：
  - 监听范围与当前连接入口；
  - 当前连接是否 TLS、服务端 ssl 设置、连接串 sslmode；
  - 当前角色是否 superuser / 表或 schema owner，是否对 omb.audit_log 有 DELETE/TRUNCATE；
  - 是否仍使用默认口令；
  - pg_hba_file_rules 的认证方式（权限不足时明确报 unverifiable）。

不做什么：
  - 不修改数据库、不建表、不安装扩展、不写审计；
  - 不做后台监控或轮询；
  - 不打印口令；连接串只显示 user@host:port/db；
  - 不替代 DBA 在服务器侧核对 pg_hba.conf、证书和防火墙。

退出码：0 无 FAIL；1 有 FAIL（或 --strict 下有 WARN）；2 用法错误。
`

function parseArgs(argv) {
  const options = { url: undefined, json: false, allowRemote: false, strict: false, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--json') options.json = true
    else if (arg === '--allow-remote') options.allowRemote = true
    else if (arg === '--strict') options.strict = true
    else if (arg === '--url') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) throw new Error('--url 需要一个连接串')
      options.url = value
      index += 1
    } else throw new Error(`未知参数：${arg}`)
  }
  return options
}

function parseTarget(connectionString) {
  let parsed
  try {
    parsed = new URL(connectionString)
  } catch {
    throw new Error('连接串不是合法 URL')
  }
  if (!/^postgres(?:ql)?:$/.test(parsed.protocol)) {
    throw new Error('只支持 postgres:// 或 postgresql:// 连接串')
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '')
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''))
  if (host.length === 0 || database.length === 0) throw new Error('连接串缺少主机名或数据库名')
  return {
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    host,
    port: parsed.port === '' ? '5432' : parsed.port,
    database,
    sslmode: parsed.searchParams.get('sslmode'),
    loopback: LOOPBACK_HOSTS.has(host.toLowerCase()),
  }
}

function maskTarget(target) {
  const user = target.user.length === 0 ? '' : `${encodeURIComponent(target.user)}@`
  return `postgres://${user}${target.host}:${target.port}/${target.database}`
}

function sanitize(text, password) {
  let output = String(text)
  if (password.length > 0) output = output.split(password).join('***')
  return output.replace(/postgres(?:ql)?:\/\/[^\s'"]+/gi, raw => {
    try {
      const target = parseTarget(raw)
      return maskTarget(target)
    } catch {
      return 'postgres://<已脱敏>'
    }
  })
}

function isLoopbackAddress(address) {
  return address === null || LOOPBACK_ADDRESS.test(address)
}

async function probe(client, sql, params = []) {
  await client.query('savepoint omb_security_check')
  try {
    const result = await client.query(sql, params)
    await client.query('release savepoint omb_security_check')
    return { ok: true, rows: result.rows }
  } catch (error) {
    await client.query('rollback to savepoint omb_security_check')
    return {
      ok: false,
      code: typeof error === 'object' && error !== null && typeof error.code === 'string' ? error.code : 'unknown',
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

function collect(client, target) {
  const findings = []
  const remote = !target.loopback
  const hard = (level) => (remote ? 'FAIL' : level)
  const add = (level, id, title, detail) => findings.push({ level, id, title, detail })

  return (async () => {
    add(
      'INFO',
      'target',
      `目标：${maskTarget(target)}`,
      remote ? '非 loopback：按远程/生产要求评估；--allow-remote 只表示允许检查，不代表目标安全。' : 'loopback：按本地开发默认评估。',
    )

    const role = await probe(
      client,
      'select current_user as role_name, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls, rolreplication from pg_roles where rolname = current_user',
    )
    if (!role.ok || role.rows.length === 0) {
      add('UNVERIFIABLE', 'role', '读不到当前角色属性', sanitize(role.ok ? 'pg_roles 没有当前角色行' : role.message, target.password))
    } else {
      const row = role.rows[0]
      if (row.rolsuper === true) add('FAIL', 'role-superuser', '应用角色是超级用户', 'superuser 可以绕过所有权限并重写审计；应用账号必须是非超级用户。')
      else add('PASS', 'role-superuser', '应用角色不是超级用户')

      if (row.rolcreatedb === true) {
        add(hard('WARN'), 'role-createdb', '应用角色有 CREATEDB', '运行时不需要建库；setup 用独立管理角色，之后回收该权限。')
      }
      if (row.rolcreaterole === true) {
        add(hard('WARN'), 'role-createrole', '应用角色有 CREATEROLE', '应用账号不应管理角色。')
      }
      if (row.rolbypassrls === true) add(hard('WARN'), 'role-bypassrls', '应用角色 BYPASSRLS', '绕过行级安全；应用账号不需要。')
      if (row.rolreplication === true) add(hard('WARN'), 'role-replication', '应用角色有 REPLICATION', '复制权限会扩大数据外带面。')

      const inherited = await probe(
        client,
        "select count(*)::int as inherited from pg_roles r where r.rolsuper and pg_has_role(current_user, r.oid, 'member')",
      )
      if (!inherited.ok) {
        add('UNVERIFIABLE', 'role-inherited-superuser', '读不到继承的超级用户成员关系', sanitize(inherited.message, target.password))
      } else if (Number(inherited.rows[0]?.inherited ?? 0) > 0) {
        add('FAIL', 'role-inherited-superuser', '应用角色继承了超级用户', '直接或间接成员身份都算超级用户；换独立角色。')
      }
    }

    const listen = await probe(client, "select current_setting('listen_addresses', true) as value")
    if (!listen.ok) {
      add('UNVERIFIABLE', 'listen', '读不到 listen_addresses', sanitize(listen.message, target.password))
    } else {
      const value = String(listen.rows[0]?.value ?? '')
      const entries = value.split(',').map(item => item.trim()).filter(item => item.length > 0)
      if (entries.length === 0) {
        add('INFO', 'listen', '未监听 TCP（listen_addresses 为空）', '只能通过 Unix socket 连接；Windows 上没有 Unix socket，等同不可用。')
      } else if (entries.every(item => LOOPBACK_HOSTS.has(item.toLowerCase()))) {
        add('PASS', 'listen', '只监听回环地址', value)
      } else if (entries.some(item => item === '*' || item === '0.0.0.0' || item === '::')) {
        add('WARN', 'listen', '监听所有地址', `listen_addresses=${value}；脚本看不到防火墙/安全组，确认只放行应用主机。`)
      } else {
        add('INFO', 'listen', '监听具体地址', `${value}；确认防火墙/安全组只放行应用主机。`)
      }
    }

    const endpoint = await probe(client, 'select inet_server_addr()::text as server_addr, inet_server_port() as server_port')
    if (endpoint.ok) {
      const serverAddr = endpoint.rows[0]?.server_addr
      const serverPort = endpoint.rows[0]?.server_port
      if (serverAddr === null || serverAddr === undefined) {
        add('INFO', 'endpoint', '当前连接走 Unix socket', `服务端端口 ${String(serverPort)}`)
      } else {
        add('INFO', 'endpoint', '当前连接入口', `${String(serverAddr)}:${String(serverPort)}`)
      }
    }

    const tls = await probe(client, 'select ssl, version, cipher, bits from pg_stat_ssl where pid = pg_backend_pid()')
    if (!tls.ok || tls.rows.length === 0) {
      add('UNVERIFIABLE', 'tls', '读不到当前连接的 TLS 状态', sanitize(tls.ok ? 'pg_stat_ssl 没有当前会话行' : tls.message, target.password))
    } else if (tls.rows[0].ssl === true) {
      add('PASS', 'tls', '当前连接已加密', `${String(tls.rows[0].version)} / ${String(tls.rows[0].cipher)} / ${String(tls.rows[0].bits)} bits`)
    } else {
      add(hard('WARN'), 'tls', '当前连接未加密', remote ? '非回环网络必须 TLS。' : 'loopback 开发可接受；共享/远程环境必须开 TLS。')
    }

    const serverSsl = await probe(client, "select current_setting('ssl', true) as value")
    if (serverSsl.ok && String(serverSsl.rows[0]?.value ?? '').toLowerCase() === 'off') {
      add(hard('WARN'), 'tls-server', '服务端 ssl=off', '即使连接串要求 sslmode，服务端不监听 TLS 也无法加密。')
    }

    if (remote) {
      const mode = target.sslmode
      if (mode === 'disable') add('FAIL', 'tls-sslmode', '连接串显式禁用 TLS', 'sslmode=disable 在非回环网络会明文传输口令与记忆内容。')
      else if (mode === null) add('WARN', 'tls-sslmode', '连接串未声明 sslmode', '非回环连接应用 sslmode=verify-full（至少 require）。')
      else if (mode === 'require') add('WARN', 'tls-sslmode', 'sslmode=require 不校验证书', '无法防中间人；用 verify-full 并配置可信 CA。')
      else if (mode === 'prefer' || mode === 'allow') add('FAIL', 'tls-sslmode', `sslmode=${mode} 允许回退明文`, '非回环连接必须 verify-full 或 verify-ca。')
      else if (mode !== 'verify-full' && mode !== 'verify-ca') add('WARN', 'tls-sslmode', `未知 sslmode=${mode}`, '按 libpq 语义核对连接参数。')
    }

    const hba = await probe(client, 'select type, database, user_name, address, auth_method from pg_hba_file_rules order by line_number')
    if (!hba.ok) {
      add(
        'UNVERIFIABLE',
        'hba',
        '读不到 pg_hba_file_rules',
        `${sanitize(hba.message, target.password)}；由 DBA 在服务器上确认应用来源行是 scram-sha-256（无该视图或权限不足时直接看 pg_hba.conf）。`,
      )
    } else {
      const rules = hba.rows
      const weak = rules.filter(rule => ['trust', 'password', 'md5'].includes(String(rule.auth_method)))
      const remoteWeak = weak.filter(rule => rule.type !== 'local' && !isLoopbackAddress(rule.address))
      if (remoteWeak.length > 0) {
        add('FAIL', 'hba-weak', '非回环来源使用弱认证', remoteWeak.map(rule => `${String(rule.type)} ${String(rule.address)} ${String(rule.database)} ${String(rule.user_name)} ${String(rule.auth_method)}`).join('；'))
      } else if (weak.length > 0) {
        add('WARN', 'hba-weak', '存在 trust/password/md5 规则', `${weak.length} 条；确认只用于本机 socket 或管理入口。`)
      } else {
        add('PASS', 'hba', 'pg_hba 没有 trust/password/md5 规则', `${rules.length} 条规则；应用来源应为 scram-sha-256。`)
      }
    }

    const auditTable = await probe(
      client,
      `select pg_get_userbyid(c.relowner) as owner
       from pg_class c where c.oid = to_regclass('omb.audit_log')`,
    )
    const auditOwner = auditTable.ok ? auditTable.rows[0]?.owner : undefined
    if (!auditTable.ok) {
      add('UNVERIFIABLE', 'audit-owner', '读不到 omb.audit_log 的所有者', sanitize(auditTable.message, target.password))
    } else if (auditOwner === undefined) {
      add('INFO', 'audit-owner', 'omb.audit_log 不存在', '数据库未迁移；迁移后再检查审计权限。')
    } else {
      const currentRole = role.ok ? String(role.rows[0]?.role_name ?? '') : ''
      if (currentRole.length > 0 && auditOwner === currentRole) {
        add(hard('WARN'), 'audit-owner', '应用角色拥有 omb.audit_log', '表 owner 可以 ALTER/DROP/重写审计，哈希链只能事后发现部分改动。')
      } else {
        add('PASS', 'audit-owner', '应用角色不是 omb.audit_log 的 owner', `owner=${String(auditOwner)}`)
      }
    }

    const schema = await probe(
      client,
      `select pg_get_userbyid(n.nspowner) as owner from pg_namespace n where n.nspname = 'omb'`,
    )
    const schemaOwner = schema.ok ? schema.rows[0]?.owner : undefined
    const currentRole = role.ok ? String(role.rows[0]?.role_name ?? '') : ''
    if (schema.ok && schemaOwner !== undefined && currentRole.length > 0 && schemaOwner === currentRole) {
      add(hard('WARN'), 'schema-owner', '应用角色拥有 omb schema', 'schema owner 可以 DROP/重建表；生产应把 owner 给管理角色。')
    } else if (schema.ok && schemaOwner !== undefined) {
      add('PASS', 'schema-owner', '应用角色不是 omb schema 的 owner', `owner=${String(schemaOwner)}`)
    }

    const privileges = await probe(
      client,
      `select has_table_privilege(current_user, 'omb.audit_log', 'select') as can_select,
              has_table_privilege(current_user, 'omb.audit_log', 'insert') as can_insert,
              has_table_privilege(current_user, 'omb.audit_log', 'update') as can_update,
              has_table_privilege(current_user, 'omb.audit_log', 'delete') as can_delete,
              has_table_privilege(current_user, 'omb.audit_log', 'truncate') as can_truncate`,
    )
    if (privileges.ok && privileges.rows[0]?.can_select !== null && privileges.rows[0]?.can_select !== undefined) {
      const row = privileges.rows[0]
      if (row.can_delete === true) add(hard('WARN'), 'audit-delete', '应用角色可 DELETE omb.audit_log', '运行时只需要 INSERT/UPDATE；删除审计会让链出现空档或被重写。')
      if (row.can_truncate === true) add(hard('WARN'), 'audit-truncate', '应用角色可 TRUNCATE omb.audit_log', '运行时不需要；TRUNCATE 会清空链。')
      if (row.can_insert !== true) add('WARN', 'audit-insert', '应用角色不能 INSERT omb.audit_log', '业务写事务会失败；检查授权。')
      if (row.can_update !== true) add('WARN', 'audit-update', '应用角色不能 UPDATE omb.audit_log', '回滚无法置 rolled_back_at；检查授权。')
      if (row.can_select !== true) add('WARN', 'audit-select', '应用角色不能 SELECT omb.audit_log', '审计查询（omb_admin audit）会失败。')
      if (row.can_delete === false && row.can_truncate === false) {
        add('PASS', 'audit-destructive', '应用角色不能删除/清空审计')
      }
    }

    const create = await probe(
      client,
      `select has_schema_privilege('omb', 'create') as schema_create,
              has_database_privilege(current_database(), 'create') as database_create`,
    )
    if (create.ok && create.rows[0]?.schema_create !== null && create.rows[0]?.schema_create !== undefined) {
      const row = create.rows[0]
      if (row.schema_create === true) add(hard('WARN'), 'schema-create', '应用角色可在 omb schema 建对象', 'DDL 权限可改表结构；迁移交给独立管理角色。')
      if (row.database_create === true) add('WARN', 'database-create', '应用角色可在当前库建 schema', 'pg-boss 首次启动/迁移才需要；生产建议预建 pgboss schema 后回收。')
    }

    if (target.user === 'omb' && target.password === 'omb') {
      add(hard('WARN'), 'default-credential', '仍在使用源码里的默认口令', '默认口令是公开信息，只能用于 loopback 开发；生产必须覆盖。')
    } else if (target.password.length === 0) {
      add('WARN', 'no-credential', '连接串没有口令', '确认依赖 .pgpass/证书/服务端认证；不要在非回环网络使用 trust。')
    } else {
      add('PASS', 'credential', '没有使用公开的默认口令')
    }

    return findings
  })()
}

function summarize(findings) {
  const counts = { pass: 0, warn: 0, fail: 0, info: 0, unverifiable: 0 }
  for (const finding of findings) counts[finding.level.toLowerCase()] += 1
  return counts
}

async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`用法错误：${error instanceof Error ? error.message : String(error)}`)
    console.error('运行 --help 查看用法。')
    process.exitCode = 2
    return
  }
  if (options.help) {
    console.log(HELP)
    return
  }

  const connectionString = options.url
  if (connectionString === undefined || connectionString.length === 0) {
    console.error('缺少连接串：必须用 --url 显式指定；本脚本不读环境变量，也不连接默认库。')
    process.exitCode = 2
    return
  }

  let target
  try {
    target = parseTarget(connectionString)
    if (!target.loopback && !options.allowRemote) {
      throw new Error('目标不是 loopback；如确需检查远程环境（含生产），加 --allow-remote（脚本仍只读）')
    }
  } catch (error) {
    console.error(`用法错误：${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 2
    return
  }

  const client = new pg.Client({
    connectionString,
    application_name: 'omb-db-security-check',
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
  })

  try {
    await client.connect()
    await client.query('begin transaction read only')
    const findings = await collect(client, target)
    await client.query('rollback')

    const counts = summarize(findings)
    const failed = counts.fail > 0
    const strictFailed = failed || (options.strict && counts.warn > 0)
    if (options.json) {
      console.log(JSON.stringify({ target: maskTarget(target), findings, summary: counts, exitCode: strictFailed ? 1 : 0 }, null, 2))
    } else {
      for (const finding of findings) console.log(`[${finding.level}] ${finding.id}: ${finding.title}${finding.detail ? ` — ${finding.detail}` : ''}`)
      console.log('')
      console.log(`汇总：PASS ${counts.pass} / WARN ${counts.warn} / FAIL ${counts.fail} / INFO ${counts.info} / UNVERIFIABLE ${counts.unverifiable}`)
      console.log(failed ? '结论：存在 FAIL；按上面的条目修复后重跑一次只读检查。' : '结论：没有 FAIL。WARN 是否阻断取决于目标环境（loopback 开发可接受，生产按清单处理）。')
    }
    process.exitCode = strictFailed ? 1 : 0
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`检查失败：${sanitize(message, target.password)}`)
    process.exitCode = 1
  } finally {
    await client.end().catch(() => {})
  }
}

main()
