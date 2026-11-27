import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

interface PruneOptions {
  readonly skillsDir: string
  readonly apply: boolean
  readonly log?: (message: string) => void
}

interface SkillCleanupModule {
  readonly LEGACY_SKILL_NAMES: readonly string[]
  staleSkillDirs(existing: readonly string[]): string[]
  pruneStaleSkills(options: PruneOptions): string[]
}

// 部署脚本是 node ESM（.mjs），不被 tsconfig 类型检查；这里按运行时契约导入。
const cleanup = await import(new URL('../../../scripts/lib/skill-cleanup.mjs', import.meta.url).href) as SkillCleanupModule

const LEGACY = ['omb-cite', 'omb-conflict', 'omb-depth', 'omb-failure', 'omb-goal', 'omb-honesty', 'omb-options', 'omb-testable']
const CURRENT = ['omb-memory', 'omb-recall', 'omb-state', 'omb-consolidate']
const USER_SKILL = 'team-conventions'

const tempDirs: string[] = []

function tempSkillsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'omb-skill-cleanup-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('staleSkillDirs', () => {
  it('给定旧技能与当前技能/用户目录混在一起当筛选则只返回旧技能并保持固定顺序', () => {
    const existing = [...USER_SKILL, ...[...LEGACY].reverse(), ...CURRENT, 'omb-goal']

    expect(cleanup.staleSkillDirs(existing)).toEqual(LEGACY)
    expect(cleanup.LEGACY_SKILL_NAMES).toEqual(LEGACY)
  })

  it('给定只有当前技能与用户目录当筛选则返回空', () => {
    expect(cleanup.staleSkillDirs([...CURRENT, USER_SKILL])).toEqual([])
  })

  it('给定空 profile 当筛选则返回空', () => {
    expect(cleanup.staleSkillDirs([])).toEqual([])
  })
})

describe('pruneStaleSkills', () => {
  it('给定 dry-run 当清理则只打印计划且目录原样保留', () => {
    const skillsDir = tempSkillsDir()
    mkdirSync(join(skillsDir, 'omb-goal'))
    mkdirSync(join(skillsDir, 'omb-memory'))
    mkdirSync(join(skillsDir, USER_SKILL))
    const logs: string[] = []

    const planned = cleanup.pruneStaleSkills({ skillsDir, apply: false, log: message => logs.push(message) })

    expect(planned).toEqual(['omb-goal'])
    expect(logs).toEqual([`将删除旧技能目录 ${join(skillsDir, 'omb-goal')}`])
    expect(readdirSync(skillsDir).sort()).toEqual([USER_SKILL, 'omb-goal', 'omb-memory'].sort())
  })

  it('给定 apply 当清理则删旧技能且保留当前技能与未知目录', () => {
    const skillsDir = tempSkillsDir()
    mkdirSync(join(skillsDir, 'omb-goal'))
    mkdirSync(join(skillsDir, 'omb-cite'))
    mkdirSync(join(skillsDir, 'omb-memory'))
    mkdirSync(join(skillsDir, USER_SKILL))
    const logs: string[] = []

    const removed = cleanup.pruneStaleSkills({ skillsDir, apply: true, log: message => logs.push(message) })

    expect(removed).toEqual(['omb-cite', 'omb-goal'])
    expect(logs).toEqual([
      `删除旧技能目录 ${join(skillsDir, 'omb-cite')}`,
      `删除旧技能目录 ${join(skillsDir, 'omb-goal')}`,
    ])
    expect(readdirSync(skillsDir).sort()).toEqual(['omb-memory', USER_SKILL].sort())
  })

  it('给定旧技能名对应的是文件当清理则保留用户数据', () => {
    const skillsDir = tempSkillsDir()
    const file = join(skillsDir, 'omb-goal')
    writeFileSync(file, '用户自己放的文件', 'utf8')

    const removed = cleanup.pruneStaleSkills({ skillsDir, apply: true })

    expect(removed).toEqual([])
    expect(existsSync(file)).toBe(true)
  })

  it('给定 skills 目录不存在当清理则返回空', () => {
    const missing = join(tempSkillsDir(), 'missing')

    expect(cleanup.pruneStaleSkills({ skillsDir: missing, apply: true })).toEqual([])
  })
})
