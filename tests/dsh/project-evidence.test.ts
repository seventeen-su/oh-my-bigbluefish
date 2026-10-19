/**
 * 项目运行证据（v4.5.3 审查第 5 点）。
 *
 * 判据：只记录 dsh 亲眼看到的、能归类的构建/测试结果；无法归属或无法分类的
 * 一律跳过并计数，不猜。`omb_project` 的 L1 用这些结果与静态结构并排。
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  MAX_EVIDENCE_PER_PROJECT,
  classifyEvidenceCommand,
  createProjectEvidence,
  extractEvidenceCommand,
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
})

describe('证据账本', () => {
  it('只记 shell 工具 + 已知结果；成功/失败都记，未知结果跳过', () => {
    const ledger = createProjectEvidence({
      clock: fixedClock(),
      resolveRoot: () => '/repo',
      persist: false,
    })
    ledger.port.record({ sessionId: 's1', tool: 'pwsh', args: '{"command":"pnpm test"}', ok: true, at: 1 })
    ledger.port.record({ sessionId: 's1', tool: 'pwsh', args: '{"command":"pnpm test"}', ok: false, at: 2 })
    ledger.port.record({ sessionId: 's1', tool: 'pwsh', args: '{"command":"pnpm test"}', ok: undefined, at: 3 })
    ledger.port.record({ sessionId: 's1', tool: 'edit', args: '{"command":"pnpm test"}', ok: true, at: 4 })
    const entries = ledger.port.snapshot('/repo')
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({ kind: 'test', ok: false, at: 2 })
    expect(entries[1]).toMatchObject({ kind: 'test', ok: true, at: 1 })
    expect(ledger.port.stats()).toMatchObject({ recorded: 2, skipped: 2 })
  })

  it('无法归属项目 → 跳过（不写进别的项目）', () => {
    const ledger = createProjectEvidence({ clock: fixedClock(), resolveRoot: () => undefined, persist: false })
    ledger.port.record({ sessionId: 's1', tool: 'pwsh', args: '{"command":"pnpm test"}', ok: true, at: 1 })
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
    ledger.port.record({ sessionId: 's1', tool: 'pwsh', args: '{"command":"pnpm test"}', ok: true, at: 1 })
    ledger.port.record({ sessionId: 's2', tool: 'pwsh', args: '{"command":"pnpm test"}', ok: true, at: 2 })
    expect(ledger.port.snapshot('/repo')).toHaveLength(2)
    for (let index = 0; index < MAX_EVIDENCE_PER_PROJECT + 4; index += 1) {
      ledger.port.record({
        sessionId: 's1',
        tool: 'pwsh',
        args: '{"command":"pnpm test"}',
        ok: true,
        at: 100 + index,
      })
    }
    expect(ledger.port.snapshot('/repo')).toHaveLength(MAX_EVIDENCE_PER_PROJECT)
  })
})

describe('证据持久化与修复验证', () => {
  it('失败证据落盘，进程重启后仍可见；同命令再成功 → 标记修复已验证', () => {
    const root = mkdtempSync(join(tmpdir(), 'omb-evidence-'))
    try {
      const first = createProjectEvidence({ clock: fixedClock(), resolveRoot: () => root })
      first.port.record({
        sessionId: 's1',
        tool: 'pwsh',
        args: JSON.stringify({ command: 'pnpm test' }),
        ok: false,
        at: 1,
      })
      expect(existsSync(join(root, '.omb', 'evidence.json'))).toBe(true)
      first.dispose()

      const second = createProjectEvidence({ clock: fixedClock(), resolveRoot: () => root })
      expect(second.port.snapshot(root)[0]).toMatchObject({ kind: 'test', ok: false })
      second.port.record({
        sessionId: 's1',
        tool: 'pwsh',
        args: JSON.stringify({ command: 'pnpm test' }),
        ok: true,
        at: 2,
      })
      expect(second.port.snapshot(root)[0]).toMatchObject({ ok: true, verifiedFix: true })
      expect(renderProjectEvidence(second.port.snapshot(root), 3)).toContain('修复已验证')
      second.dispose()
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
        ok: true,
        at: 1,
      })
      expect(ledger.port.snapshot(root)[0]?.command).not.toContain('abc123')
      expect(ledger.port.snapshot(root)[0]?.command).toContain('***')
      ledger.dispose()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('L1 证据行', () => {
  it('未接线、暂无读数、有读数三种说法互不冒充', () => {
    expect(renderProjectEvidence(undefined, 1000)).toContain('证据未接线')
    expect(renderProjectEvidence([], 1000)).toContain('暂无构建/测试读数')
    const text = renderProjectEvidence([{ kind: 'test', command: 'pnpm test', ok: true, at: 0 }], 600_000)
    expect(text).toContain('测试✅')
    expect(text).toContain('10 分钟前')
  })
})
