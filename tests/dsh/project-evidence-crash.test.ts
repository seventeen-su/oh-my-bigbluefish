/**
 * 证据落盘的崩溃窗口验证（v4.11.0，用户指令第 5 项）：
 * 子进程在**真实写入循环中**被 SIGKILL，父进程检查磁盘上的 `evidence.json`。
 *
 * 判据（都能在 CI 里失败）：
 * ① 文件始终是**可解析的完整 JSON**（原子替换：temp → rename，不会留下半截文件）；
 * ② 已提交的条目能被重新打开账本读到（快照非空）；
 * ③ 没有出现 `.corrupt-*` 现场（那说明文件被写坏过，而不是被杀在提交边界）。
 *
 * 边界：只覆盖证据文件的原子写；SQLite 的崩溃恢复由 SQLite/WAL 自身保证，
 * 不在本用例的观测范围内（不在文档里假装测了它）。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createProjectEvidence } from '../../dsh/project-evidence.js'
import { fixedClock } from '../modules/memory/helpers.js'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const EVIDENCE_MODULE = join(REPO_ROOT, 'dsh', 'project-evidence.ts')

const CHILD_SCRIPT = `import { pathToFileURL } from 'node:url'

const { createProjectEvidence } = await import(pathToFileURL(process.argv[2]).href)
const root = process.argv[3]
const ledger = createProjectEvidence({
  clock: { now: () => Date.now() },
  resolveRoot: () => root,
})
for (let index = 0; index < 100_000; index += 1) {
  ledger.port.record({
    sessionId: 's1',
    tool: 'pwsh',
    args: JSON.stringify({ command: 'pnpm test -t case-' + index }),
    text: 'ok\\n[exit code: 0]',
    at: 1_700_000_000_000 + index,
  })
  if (index % 10 === 0) console.log('tick')
}
`

interface KilledRun {
  readonly root: string
  readonly exitCode: number | null
  readonly stderr: string
}

/** 起子进程写证据，收到第一个 `tick` 后 SIGKILL，返回退出信息。 */
async function killDuringWrites(): Promise<KilledRun> {
  const root = mkdtempSync(join(tmpdir(), 'omb-evidence-crash-'))
  const script = join(root, 'child.mjs')
  writeFileSync(script, CHILD_SCRIPT)

  return await new Promise<KilledRun>((resolve, reject) => {
    const child = spawn(process.execPath, [script, EVIDENCE_MODULE, root], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    let killed = false
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`子进程未在超时内输出 tick（stderr=${stderr}）`))
    }, 20_000)
    child.stderr.on('data', chunk => {
      stderr += String(chunk)
    })
    child.stdout.on('data', chunk => {
      // 第一条 tick 已经意味着至少一次 record() 成功返回（而 record 是同步落盘的）
      if (!killed && String(chunk).includes('tick')) {
        killed = true
        child.kill('SIGKILL')
      }
    })
    child.on('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ root, exitCode: code, stderr })
    })
  })
}

describe('证据文件在 SIGKILL 下保持完整（v4.11.0）', () => {
  it('被杀之后 evidence.json 仍可解析、可读回，且没有损坏现场', async () => {
    const run = await killDuringWrites()
    try {
      expect(run.exitCode !== 0, `子进程似乎没有被杀（exit=${run.exitCode}）`).toBe(true)
      const file = join(run.root, '.omb', 'evidence.json')
      expect(existsSync(file), `没有落盘文件：${run.stderr}`).toBe(true)

      const raw = JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown; entries?: unknown }
      expect(raw.version).toBe(3)
      expect(Array.isArray(raw.entries)).toBe(true)
      expect((raw.entries as unknown[]).length).toBeGreaterThan(0)

      // 重新打开：已提交条目读得回来（文件不是半截）
      const reopened = createProjectEvidence({ clock: fixedClock(), resolveRoot: () => run.root })
      expect(reopened.port.snapshot(run.root).length).toBeGreaterThan(0)

      // 损坏现场只在解析失败时产生；这里应当没有
      const corrupt = readdirSync(join(run.root, '.omb')).filter(name => name.includes('.corrupt-'))
      expect(corrupt).toEqual([])
    } finally {
      rmSync(run.root, { recursive: true, force: true })
    }
  }, 30_000)
})
