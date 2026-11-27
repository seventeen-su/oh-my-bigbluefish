import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type AddressInfo, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

interface GuardResult {
  readonly allowed: boolean
  readonly reason: string
  readonly listening?: boolean
  readonly host?: string
  readonly port?: number
}

interface DeployGuardModule {
  probeTcp(options?: { host?: string; port?: number; timeoutMs?: number }): Promise<boolean>
  evaluateDeployGuard(input: {
    apply: boolean
    force?: boolean
    env?: Record<string, string | undefined>
    listening: boolean
  }): GuardResult
  ensureDeployAllowed(options: {
    apply: boolean
    force?: boolean
    env?: Record<string, string | undefined>
    host?: string
    port?: number
    timeoutMs?: number
    probe?: (options: { host: string; port: number; timeoutMs: number }) => Promise<boolean>
  }): Promise<GuardResult>
  describeDenied(result: GuardResult): string
}

// 部署脚本是 node ESM（.mjs），不被 tsconfig 类型检查；这里按运行时契约导入。
const guardUrl = new URL('../../../scripts/lib/deploy-guard.mjs', import.meta.url).href
const guard = await import(guardUrl) as DeployGuardModule
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const DEPLOY_SCRIPT = join(REPO_ROOT, 'scripts', 'v7-deploy.mjs')

interface ProbeServer {
  readonly port: number
  close(): Promise<void>
}

const servers: Server[] = []
const tempDirs: string[] = []

async function listenLocal(): Promise<ProbeServer> {
  const server = createServer(socket => socket.destroy())
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address() as AddressInfo
  return {
    port: address.port,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => (error === undefined ? resolve() : reject(error)))
    }),
  }
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'omb-deploy-guard-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('deploy guard Probe', () => {
  it('给定本地 TCP 服务在监听当探测则返回 true', async () => {
    const server = await listenLocal()
    await expect(guard.probeTcp({ host: '127.0.0.1', port: server.port, timeoutMs: 500 })).resolves.toBe(true)
  })

  it('给定本地端口已关闭当探测则返回 false', async () => {
    const server = await listenLocal()
    await server.close()
    await expect(guard.probeTcp({ host: '127.0.0.1', port: server.port, timeoutMs: 500 })).resolves.toBe(false)
  })
})

describe('deploy guard 策略', () => {
  it('给定 DSH 运行中当 apply 则拒绝并说明原因', () => {
    expect(guard.evaluateDeployGuard({ apply: true, listening: true })).toEqual({ allowed: false, reason: 'dsh-running' })
  })

  it('给定 DSH 运行中当 --force 则放行', () => {
    expect(guard.evaluateDeployGuard({ apply: true, force: true, listening: true })).toEqual({ allowed: true, reason: 'force' })
  })

  it('给定 DSH 运行中当 OMB_DEPLOY_ALLOW_RUNNING=1 则放行', () => {
    expect(guard.evaluateDeployGuard({
      apply: true,
      env: { OMB_DEPLOY_ALLOW_RUNNING: '1' },
      listening: true,
    })).toEqual({ allowed: true, reason: 'env' })
  })

  it('给定 DSH 未运行当 apply 则放行', () => {
    expect(guard.evaluateDeployGuard({ apply: true, listening: false })).toEqual({ allowed: true, reason: 'offline' })
  })

  it('给定 dry-run 当 DSH 运行中也不拦截（dry-run 不写）', () => {
    expect(guard.evaluateDeployGuard({ apply: false, listening: true })).toEqual({ allowed: true, reason: 'dry-run' })
  })

  it('给定空字符串放行变量当 apply 则不放行', () => {
    expect(guard.evaluateDeployGuard({
      apply: true,
      env: { OMB_DEPLOY_ALLOW_RUNNING: '' },
      listening: true,
    }).allowed).toBe(false)
  })

  it('给定 DSH 运行中当组合判定则给可操作提示', () => {
    const result = guard.evaluateDeployGuard({ apply: true, listening: true })
    const message = guard.describeDenied({ ...result, host: '127.0.0.1', port: 3080 })
    expect(message).toContain('127.0.0.1:3080')
    expect(message).toContain('--force')
    expect(message).toContain('OMB_DEPLOY_ALLOW_RUNNING=1')
  })
})

describe('deploy guard 探测次数', () => {
  it('给定 apply 且无放行开关当判定则只探测一次', async () => {
    let probes = 0
    const result = await guard.ensureDeployAllowed({
      apply: true,
      env: {},
      host: '127.0.0.1',
      port: 3080,
      probe: async () => {
        probes += 1
        return false
      },
    })
    expect(result).toMatchObject({ allowed: true, reason: 'offline', listening: false })
    expect(probes).toBe(1)
  })

  it('给定 --force 当判定则不连端口', async () => {
    const result = await guard.ensureDeployAllowed({
      apply: true,
      force: true,
      env: {},
      probe: async () => {
        throw new Error('force 不应探测端口')
      },
    })
    expect(result).toMatchObject({ allowed: true, reason: 'force', listening: undefined })
  })

  it('给定 OMB_DEPLOY_ALLOW_RUNNING=1 当判定则不连端口', async () => {
    const result = await guard.ensureDeployAllowed({
      apply: true,
      env: { OMB_DEPLOY_ALLOW_RUNNING: '1' },
      probe: async () => {
        throw new Error('env 放行不应探测端口')
      },
    })
    expect(result).toMatchObject({ allowed: true, reason: 'env' })
  })

  it('给定 dry-run 当判定则不连端口', async () => {
    const result = await guard.ensureDeployAllowed({
      apply: false,
      env: {},
      probe: async () => {
        throw new Error('dry-run 不应探测端口')
      },
    })
    expect(result).toMatchObject({ allowed: true, reason: 'dry-run' })
  })
})

describe('v7-deploy.mjs 运行中守卫', () => {
  it('给定本地端口在监听当 --apply 则拒绝且不写 profile', async () => {
    const server = await listenLocal()
    const profile = tempDir()
    const result = spawnSync(process.execPath, [DEPLOY_SCRIPT, '--apply'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 20_000,
      env: {
        ...process.env,
        OMB_DSH_HOST: '127.0.0.1',
        OMB_DSH_PORT: String(server.port),
        OMB_PROFILE_DIR: profile,
      },
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('拒绝写 profile')
    expect(result.stderr).toContain(`127.0.0.1:${server.port}`)
    expect(result.stderr).toContain('--force')
    // 拒绝发生在任何备份/复制/依赖安装之前：profile 目录必须仍然为空。
    expect(readdirSync(profile)).toEqual([])
  })

  it('给定 dry-run 当执行则退出 0 且不写 profile', async () => {
    const profile = tempDir()
    writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'tmp-profile', dependencies: {} }), 'utf8')
    const before = readdirSync(profile)
    const result = spawnSync(process.execPath, [DEPLOY_SCRIPT], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 20_000,
      env: {
        ...process.env,
        OMB_DSH_HOST: '127.0.0.1',
        // 故意指向一个不存在的端口：dry-run 不探测，因此不会因此失败。
        OMB_DSH_PORT: '1',
        OMB_PROFILE_DIR: profile,
      },
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('DRY-RUN')
    expect(readdirSync(profile)).toEqual(before)
  })
})
