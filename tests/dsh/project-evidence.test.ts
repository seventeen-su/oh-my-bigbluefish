/**
 * 项目运行证据（v4.5.3 审查第 5 点；v4.6.1 修 P1 成功语义）。
 *
 * 关键判据：**工具没报错 ≠ 命令成功**。shell 工具对非零退出码通常仍返回
 * `isError:false`，只在结果文本末尾附 `[exit code: N]`；证据必须解析该标记，
 * 没有标记一律 unknown，不能显示成测试通过。
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  MAX_EVIDENCE_PATHS,
  MAX_EVIDENCE_PER_PROJECT,
  classifyEvidenceCommand,
  createProjectEvidence,
  extractEvidenceCommand,
  extractEvidencePaths,
  parseCommandOutcome,
  redactEvidenceCommand,
} from '../../dsh/project-evidence.js'
import { renderProjectEvidence } from '../../modules/memory/project.js'
import { fixedClock } from '../modules/memory/helpers.js'

describe('命令抽取与分类', () => {
  it('从 JSON 参数里抽 command；纯命令行原样返回', () => {
    expect(extractEvidenceCommand(JSON.stringify({ command: 'pnpm test' }))).toBe('pnpm test')
    expect(extractEvidenceCommand('npx vitest run')).toBe('npx vitest run')
    expect(extractEvidenceCommand('{"path":"src/a.ts"}')).toBeUndefined()
  })

  it('构建/测试/类型/Lint/验收/安装各有类别', () => {
    expect(classifyEvidenceCommand('pnpm test')).toBe('test')
    expect(classifyEvidenceCommand('npx vitest run tests')).toBe('test')
    expect(classifyEvidenceCommand('node scripts/build.mjs')).toBe('build')
    expect(classifyEvidenceCommand('npx tsc --noEmit')).toBe('typecheck')
    expect(classifyEvidenceCommand('npx eslint .')).toBe('lint')
    expect(classifyEvidenceCommand('node scripts/check-resolution.mjs')).toBe('verify')
    expect(classifyEvidenceCommand('pnpm install')).toBe('install')
    expect(classifyEvidenceCommand('git status')).toBeNull()
  })

  it('从命令里抽文件路径（证据 → 文件映射）；URL/目录不记', () => {
    expect(extractEvidencePaths('npx vitest run tests/modules/memory/store.test.ts')).toEqual([
      'tests/modules/memory/store.test.ts',
    ])
    expect(extractEvidencePaths('npx tsc --noEmit modules/memory/confirm.ts')).toContain('modules/memory/confirm.ts')
    expect(extractEvidencePaths('./src/a.ts')).toEqual(['src/a.ts'])
    expect(extractEvidencePaths('C:\\repo\\src\\a.ts')).toEqual(['C:/repo/src/a.ts'])
    expect(extractEvidencePaths('curl https://example.com/api/v1.json')).toEqual([])
    expect(extractEvidencePaths('pnpm test')).toEqual([])
    expect(extractEvidencePaths('')).toEqual([])
  })

  it('路径去重且有界（单条最多 MAX_EVIDENCE_PATHS 个）', () => {
    const command = Array.from({ length: MAX_EVIDENCE_PATHS + 3 }, (_, index) => `src/f${index}.ts`).join(' ')
    expect(extractEvidencePaths(command)).toHaveLength(MAX_EVIDENCE_PATHS)
    expect(extractEvidencePaths('src/a.ts src/a.ts')).toEqual(['src/a.ts'])
  })
})

describe('命令结论解析：退出码而不是 isError', () => {
  it('exit 0 → succeeded；非零 → failed；null/无标记 → unknown', () => {
    expect(parseCommandOutcome('ok\n[exit code: 0]')).toEqual({ commandOutcome: 'succeeded', exitCode: 0 })
    expect(parseCommandOutcome('fail\n[exit code: 2]')).toEqual({ commandOutcome: 'failed', exitCode: 2 })
    expect(parseCommandOutcome('timeout\n[exit code: null]')).toEqual({ commandOutcome: 'unknown', exitCode: null })
    // 关键：没有退出码标记时不能当成通过
    expect(parseCommandOutcome('all tests passed')).toEqual({ commandOutcome: 'unknown' })
    expect(parseCommandOutcome(undefined)).toEqual({ commandOutcome: 'unknown' })
  })

  it('被信号终止 → failed（exitCode null）', () => {
    expect(parseCommandOutcome('killed\n[killed by signal: SIGKILL]')).toEqual({
      commandOutcome: 'failed',
      exitCode: null,
    })
  })
})

describe('证据账本', () => {
  it('成功/失败/未知都记录，但未知不显示为通过；非 shell 工具跳过', () => {
    const ledger = createProjectEvidence({
      clock: fixedClock(),
      resolveRoot: () => '/repo',
      persist: false,
    })
    ledger.port.record({ sessionId: 's1', tool: 'pwsh', args: '{"command":"pnpm test"}', text: 'ok\n[exit code: 0]', at: 1 })
    ledger.port.record({ sessionId: 's1', tool: 'pwsh', args: '{"command":"pnpm test"}', text: 'fail\n[exit code: 1]', at: 2 })
    ledger.port.record({ sessionId: 's1', tool: 'pwsh', args: '{"command":"pnpm test"}', text: 'all passed', at: 3 })
    ledger.port.record({ sessionId: 's1', tool: 'edit', args: '{"command":"pnpm test"}', text: 'ok\n[exit code: 0]', at: 4 })
    const entries = ledger.port.snapshot('/repo')
    expect(entries).toHaveLength(3)
    expect(entries[0]).toMatchObject({ kind: 'test', commandOutcome: 'unknown', at: 3 })
    expect(entries[1]).toMatchObject({ kind: 'test', commandOutcome: 'failed', exitCode: 1, at: 2 })
    expect(entries[2]).toMatchObject({ kind: 'test', commandOutcome: 'succeeded', exitCode: 0, at: 1 })
    expect(ledger.port.stats()).toMatchObject({ recorded: 3, skipped: 1 })
  })

  it('无法归属项目 → 跳过（不写进别的项目）', () => {
    const ledger = createProjectEvidence({ clock: fixedClock(), resolveRoot: () => undefined, persist: false })
    ledger.port.record({ sessionId: 's1', tool: 'pwsh', args: '{"command":"pnpm test"}', text: 'ok\n[exit code: 0]', at: 1 })
    expect(ledger.port.snapshot('/repo')).toHaveLength(0)
    expect(ledger.port.stats().skipped).toBe(1)
  })

  it('子目录会话归到同一个项目根；每项目有界', () => {
    const roots = new Map([['s1', '/repo'], ['s2', '/repo']])
    const ledger = createProjectEvidence({
      clock: fixedClock(),
      resolveRoot: sessionId => roots.get(sessionId),
      persist: false,
    })
    ledger.port.record({ sessionId: 's1', tool: 'pwsh', args: '{"command":"pnpm test"}', text: 'ok\n[exit code: 0]', at: 1 })
    ledger.port.record({ sessionId: 's2', tool: 'pwsh', args: '{"command":"pnpm test"}', text: 'ok\n[exit code: 0]', at: 2 })
    expect(ledger.port.snapshot('/repo')).toHaveLength(2)
    for (let index = 0; index < MAX_EVIDENCE_PER_PROJECT + 4; index += 1) {
      ledger.port.record({
        sessionId: 's1',
        tool: 'pwsh',
        args: '{"command":"pnpm test"}',
        text: 'ok\n[exit code: 0]',
        at: 100 + index,
      })
    }
    expect(ledger.port.snapshot('/repo')).toHaveLength(MAX_EVIDENCE_PER_PROJECT)
  })

  it('记录命令里的文件路径（证据 → 文件映射）', () => {
    const ledger = createProjectEvidence({ clock: fixedClock(), resolveRoot: () => '/repo', persist: false })
    ledger.port.record({
      sessionId: 's1',
      tool: 'pwsh',
      args: JSON.stringify({ command: 'npx vitest run tests/a.test.ts' }),
      text: 'ok\n[exit code: 0]',
      at: 1,
    })
    expect(ledger.port.snapshot('/repo')[0]?.paths).toEqual(['tests/a.test.ts'])
  })
})

describe('证据持久化、失败后恢复与损坏现场', () => {
  it('失败证据落盘，重启后仍可见；紧邻失败后成功才标"失败后再次成功"', () => {
    const root = mkdtempSync(join(tmpdir(), 'omb-evidence-'))
    try {
      const first = createProjectEvidence({ clock: fixedClock(), resolveRoot: () => root })
      first.port.record({
        sessionId: 's1',
        tool: 'pwsh',
        args: JSON.stringify({ command: 'pnpm test' }),
        text: 'fail\n[exit code: 1]',
        at: 1,
      })
      expect(existsSync(join(root, '.omb', 'evidence.json'))).toBe(true)
      first.dispose()

      const second = createProjectEvidence({ clock: fixedClock(), resolveRoot: () => root })
      expect(second.port.snapshot(root)[0]).toMatchObject({ commandOutcome: 'failed' })
      second.port.record({
        sessionId: 's1',
        tool: 'pwsh',
        args: JSON.stringify({ command: 'pnpm test' }),
        text: 'ok\n[exit code: 0]',
        at: 2,
      })
      expect(second.port.snapshot(root)[0]).toMatchObject({ commandOutcome: 'succeeded', recoveredFromFailure: true })
      expect(renderProjectEvidence(second.port.snapshot(root), 3)).toContain('失败后再次成功')
      // 连续成功不再重复标记
      second.port.record({
        sessionId: 's1',
        tool: 'pwsh',
        args: JSON.stringify({ command: 'pnpm test' }),
        text: 'ok\n[exit code: 0]',
        at: 3,
      })
      expect(second.port.snapshot(root)[0]?.recoveredFromFailure).toBeUndefined()
      second.dispose()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('两个进程各自的旧快照：写入时合并磁盘条目，不丢另一个进程新增的证据', () => {
    const root = mkdtempSync(join(tmpdir(), 'omb-evidence-'))
    try {
      const first = createProjectEvidence({ clock: fixedClock(), resolveRoot: () => root })
      first.port.record({
        sessionId: 's1',
        tool: 'pwsh',
        args: '{"command":"pnpm test"}',
        text: 'ok\n[exit code: 0]',
        at: 1,
      })
      // second 读到 at=1 后，first 又新增 at=2；second 再写 at=3
      const second = createProjectEvidence({ clock: fixedClock(), resolveRoot: () => root })
      expect(second.port.snapshot(root)).toHaveLength(1)
      first.port.record({
        sessionId: 's1',
        tool: 'pwsh',
        args: '{"command":"pnpm build"}',
        text: 'ok\n[exit code: 0]',
        at: 2,
      })
      second.port.record({
        sessionId: 's1',
        tool: 'pwsh',
        args: '{"command":"pnpm lint"}',
        text: 'ok\n[exit code: 0]',
        at: 3,
      })
      const times = second.port.snapshot(root).map(entry => entry.at)
      expect(times).toEqual([3, 2, 1])
      first.dispose()
      second.dispose()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('损坏的 evidence.json 被保留为 .corrupt-*，不静默覆盖', () => {
    const root = mkdtempSync(join(tmpdir(), 'omb-evidence-'))
    try {
      const file = join(root, '.omb', 'evidence.json')
      mkdirSync(join(root, '.omb'), { recursive: true })
      writeFileSync(file, '{ not json')
      const ledger = createProjectEvidence({ clock: fixedClock(), resolveRoot: () => root })
      expect(ledger.port.snapshot(root)).toEqual([])
      expect(readdirSync(join(root, '.omb')).some(name => name.startsWith('evidence.json.corrupt-'))).toBe(true)
      expect(ledger.port.stats().persistFailures).toBe(1)
      ledger.dispose()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('旧版 v1 的 ok=true 不能当成命令成功（降为 unknown）', () => {
    const root = mkdtempSync(join(tmpdir(), 'omb-evidence-'))
    try {
      const file = join(root, '.omb', 'evidence.json')
      mkdirSync(join(root, '.omb'), { recursive: true })
      writeFileSync(file, JSON.stringify({
        version: 1,
        entries: [{ kind: 'test', command: 'pnpm test', ok: true, at: 1 }],
      }))
      const ledger = createProjectEvidence({ clock: fixedClock(), resolveRoot: () => root })
      expect(ledger.port.snapshot(root)[0]).toMatchObject({ commandOutcome: 'unknown' })
      ledger.dispose()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('命令里的凭据形态先脱敏再记录/落盘', () => {
    expect(redactEvidenceCommand('pnpm test --token=abc123')).toBe('pnpm test --token=***')
    const bearer = redactEvidenceCommand('curl -H "Authorization: Bearer abc.def"')
    expect(bearer).not.toContain('abc.def')
    expect(bearer).toContain('***')

    const root = mkdtempSync(join(tmpdir(), 'omb-evidence-'))
    try {
      const ledger = createProjectEvidence({ clock: fixedClock(), resolveRoot: () => root })
      ledger.port.record({
        sessionId: 's1',
        tool: 'pwsh',
        args: JSON.stringify({ command: 'pnpm test --token abc123' }),
        text: 'ok\n[exit code: 0]',
        at: 1,
      })
      expect(ledger.port.snapshot(root)[0]?.command).not.toContain('abc123')
      expect(ledger.port.snapshot(root)[0]?.command).toContain('***')
      ledger.dispose()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('路径随证据落盘（JSON v3），重启后仍可见', () => {
    const root = mkdtempSync(join(tmpdir(), 'omb-evidence-'))
    try {
      const first = createProjectEvidence({ clock: fixedClock(), resolveRoot: () => root })
      first.port.record({
        sessionId: 's1',
        tool: 'pwsh',
        args: JSON.stringify({ command: 'npx vitest run tests/modules/memory/store.test.ts' }),
        text: 'ok\n[exit code: 0]',
        at: 1,
      })
      first.dispose()

      const raw = JSON.parse(readFileSync(join(root, '.omb', 'evidence.json'), 'utf8')) as { version: number }
      expect(raw.version).toBe(3)

      const second = createProjectEvidence({ clock: fixedClock(), resolveRoot: () => root })
      expect(second.port.snapshot(root)[0]?.paths).toEqual(['tests/modules/memory/store.test.ts'])
      second.dispose()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('L1 证据行', () => {
  it('未接线、暂无读数、有读数三种说法互不冒充', () => {
    expect(renderProjectEvidence(undefined, 1000)).toContain('证据未接线')
    expect(renderProjectEvidence([], 1000)).toContain('暂无构建/测试读数')
    const text = renderProjectEvidence(
      [{ kind: 'test', command: 'pnpm test', commandOutcome: 'succeeded', exitCode: 0, at: 0 }],
      600_000,
    )
    expect(text).toContain('测试✅')
    expect(text).toContain('10 分钟前')
  })

  it('unknown 显示 ⚠️未知，不显示 ✅', () => {
    const text = renderProjectEvidence(
      [{ kind: 'test', command: 'pnpm test', commandOutcome: 'unknown', at: 0 }],
      1,
    )
    expect(text).toContain('⚠️未知')
    expect(text).not.toContain('✅')
  })

  it('证据行显示文件映射（命令被截断也能看见覆盖了哪些文件）', () => {
    const text = renderProjectEvidence(
      [{
        kind: 'test',
        command: 'npx vitest run 一个非常长长长长长长长长长长长长长长长长长长的路径名称/tests/a.test.ts',
        commandOutcome: 'succeeded',
        at: 0,
        paths: ['testers/a.test.ts', 'src/b.ts', 'src/c.ts'],
      }],
      1000,
    )
    expect(text).toContain('→ testers/a.test.ts、src/b.ts')
    expect(text).toContain('等 3 个')
  })
})
