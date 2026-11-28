import { cp, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { Logger } from '../../../packages/v7/src/ports/jobs.js'
import { EXPECTED_TOOL_NAMES } from '../../../plugin/v7/supervisor.js'
import {
  OMB_SKILL_NAMES,
  registerSkills,
  type OmbSkillDefinition,
  type OmbSkillProviderControl,
  type OmbSkillProviderLike,
} from '../../../plugin/v7/skills.js'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const SKILLS_ROOT = join(REPO_ROOT, 'skills')
const TEMP_DIRS: string[] = []

type CreateProvider = (control: OmbSkillProviderControl) => OmbSkillProviderLike

interface FakeHost {
  readonly ctx: { readonly skills: { registerProvider(create: CreateProvider): () => void } }
  readonly creates: CreateProvider[]
}

function fakeHost(disposeProvider: () => void = () => {}): FakeHost {
  const creates: CreateProvider[] = []
  return {
    creates,
    ctx: {
      skills: {
        registerProvider(create: CreateProvider): () => void {
          creates.push(create)
          return disposeProvider
        },
      },
    },
  }
}

interface RecordingLogger {
  readonly logger: Logger
  readonly warnings: string[]
}

function recordingLogger(): RecordingLogger {
  const warnings: string[] = []
  return {
    warnings,
    logger: {
      debug: () => {},
      info: () => {},
      warn: (message: string, details?: unknown) => {
        warnings.push(details === undefined ? message : `${message} ${String(details)}`)
      },
      error: () => {},
    },
  }
}

function providerOf(host: FakeHost, invalidate: () => void = () => {}): OmbSkillProviderLike {
  const create = host.creates[0]
  if (create === undefined) throw new Error('registerSkills 没有调用 registerProvider')
  return create({ signal: new AbortController().signal, invalidate })
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'omb-skills-'))
  TEMP_DIRS.push(root)
  return root
}

async function copySkill(root: string, name: string): Promise<void> {
  await cp(join(SKILLS_ROOT, name), join(root, name), { recursive: true })
}

async function copyAllSkills(root: string): Promise<void> {
  for (const name of OMB_SKILL_NAMES) await copySkill(root, name)
}

async function contentsOf(provider: OmbSkillProviderLike): Promise<Map<string, OmbSkillDefinition>> {
  const observation = await provider.list({})
  const loaded = new Map<string, OmbSkillDefinition>()
  for (const candidate of observation.candidates) {
    const definition = await provider.get(candidate, {})
    if (definition !== undefined) loaded.set(candidate.name, definition)
  }
  return loaded
}

function fabricatedCandidate(name: string): Parameters<OmbSkillProviderLike['get']>[0] {
  return {
    name,
    description: '占位描述',
    invocation: { modelInvocable: true, userInvocable: false },
    source: 'bundled',
    provider: 'omb-v7',
    rank: 600,
    locator: '',
  }
}

afterEach(async () => {
  for (const root of TEMP_DIRS.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('registerSkills', () => {
  it('给定宿主 skills 服务当注册则同步捕获 provider，且注册期不读盘', async () => {
    const root = await tempRoot()
    let providerDisposed = false
    const host = fakeHost(() => { providerDisposed = true })
    const { logger, warnings } = recordingLogger()

    const dispose = registerSkills(host.ctx, logger, { skillRoot: root })

    // 注册只发生一次；此时 root 还是空目录，任何加载期读盘都会把「四项都不存在」固化。
    expect(host.creates).toHaveLength(1)
    expect(warnings).toEqual([])
    expect(typeof dispose).toBe('function')

    // 注册后把四篇说明放进去，list 才第一次读盘并看到它们。
    await copyAllSkills(root)
    const observation = await providerOf(host).list({})
    expect(observation.complete).toBe(true)
    expect(observation.candidates.map(candidate => candidate.name)).toEqual([...OMB_SKILL_NAMES])

    dispose()
    expect(providerDisposed).toBe(true)
  })

  it('给定仓库四篇功能说明当 list/get 则返回名称、描述、正文与调用策略', async () => {
    const host = fakeHost()
    registerSkills(host.ctx, recordingLogger().logger)
    const provider = providerOf(host)

    const observation = await provider.list({})
    expect(observation.complete).toBe(true)
    expect(observation.candidates.map(candidate => candidate.name)).toEqual([...OMB_SKILL_NAMES])
    expect(observation.candidates.map(candidate => candidate.description)).toEqual([
      '需要长期记住、去重、归档或组织事实/线索/事件时用；单库属性化记忆的写入规则。',
      '用户提到上次/之前/原来，或需要旧结论、项目状态、错误签名、相关链接时用；检索与展开规则。',
      '任务开始/推进/阻塞/完成，或需要状态机历史与链接时用；状态、归档与历史规则。',
      '需要查看/回滚后台巩固、合并冲突、清理低显著度记忆、核对证据来源时用；巩固调度、幂等与证据规则。',
    ])
    for (const candidate of observation.candidates) {
      expect(candidate.provider).toBe('omb-v7')
      expect(candidate.source).toBe('bundled')
      expect(candidate.rank).toBe(600)
      expect(candidate.invocation).toEqual({ modelInvocable: true, userInvocable: false })
      const definition = await provider.get(candidate, {})
      expect(definition).toBeDefined()
      expect(definition?.name).toBe(candidate.name)
      expect(definition?.description).toBe(candidate.description)
      expect(definition?.content.startsWith('# ')).toBe(true)
      expect(definition?.content).not.toContain('---\nname:')
    }
    const contents = await contentsOf(provider)
    expect(contents.get('omb-memory')?.content).toContain('# 写记忆')
    expect(contents.get('omb-recall')?.content).toContain('# 召回')
    expect(contents.get('omb-state')?.content).toContain('# 状态机')
    expect(contents.get('omb-consolidate')?.content).toContain('# 后台巩固与审计')
  })

  it('给定缺一篇 SKILL.md 当 list 则降级为三条候选且不抛宿主', async () => {
    const root = await tempRoot()
    await mkdir(root, { recursive: true })
    await copyAllSkills(root)
    await rm(join(root, 'omb-state', 'SKILL.md'))

    let invalidations = 0
    const host = fakeHost()
    registerSkills(host.ctx, recordingLogger().logger, { skillRoot: root })
    const provider = providerOf(host, () => { invalidations += 1 })

    const observation = await provider.list({})
    expect(observation.candidates.map(candidate => candidate.name)).toEqual([
      'omb-memory',
      'omb-recall',
      'omb-consolidate',
    ])
    // ENOENT 在文件出现前不会自愈：目录仍算完整，只是少一条，避免每轮重读。
    expect(observation.complete).toBe(true)

    await expect(provider.get(fabricatedCandidate('omb-state'), {})).resolves.toBeUndefined()
    expect(invalidations).toBe(1)
    // 已有的三篇仍可正常加载。
    await expect(provider.get(observation.candidates[0]!, {})).resolves.toMatchObject({ name: 'omb-memory' })
  })

  it('给定 SKILL.md 是目录当 list 则标记不完整，get 返回 undefined 且不抛', async () => {
    const root = await tempRoot()
    await mkdir(root, { recursive: true })
    await copyAllSkills(root)
    await rm(join(root, 'omb-state', 'SKILL.md'))
    await mkdir(join(root, 'omb-state', 'SKILL.md'))

    let invalidations = 0
    const host = fakeHost()
    registerSkills(host.ctx, recordingLogger().logger, { skillRoot: root })
    const provider = providerOf(host, () => { invalidations += 1 })

    const observation = await provider.list({})
    expect(observation.candidates).toHaveLength(3)
    // EISDIR 可能随环境消失：目录必须标记不完整，让注册表下一轮重试。
    expect(observation.complete).toBe(false)

    await expect(provider.get(fabricatedCandidate('omb-state'), {})).resolves.toBeUndefined()
    expect(invalidations).toBe(1)

    // 失败不会被缓存成「完整」：第二次 list 仍是不完整。
    const second = await provider.list({})
    expect(second.complete).toBe(false)
  })

  it('给定宿主没有 skills 服务当注册则 warn 并返回空 disposer', () => {
    const { logger, warnings } = recordingLogger()
    const dispose = registerSkills({}, logger)
    expect(typeof dispose).toBe('function')
    expect(() => dispose()).not.toThrow()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('技能说明未注册')
    expect(warnings[0]).toContain('skills')

    expect(() => registerSkills(undefined)).not.toThrow()
  })

  it('给定 registerProvider 重名抛错当注册则 warn 并返回空 disposer', () => {
    const host = {
      skills: {
        registerProvider(): () => void {
          throw new Error('a skill provider named "omb-v7" is already registered')
        },
      },
    }
    const { logger, warnings } = recordingLogger()
    const dispose = registerSkills(host, logger)
    expect(typeof dispose).toBe('function')
    expect(() => dispose()).not.toThrow()
    expect(warnings[0]).toContain('registerProvider 失败')
    expect(warnings[0]).toContain('already registered')
  })
})

describe('skills 分发清单', () => {
  it('给定仓库 skills 目录当检查则只剩四个功能说明', async () => {
    const entries = (await readdir(SKILLS_ROOT, { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort()
    expect(entries).toEqual([...OMB_SKILL_NAMES].sort())
  })

  it('给定 package.json files 当检查则不含八个旧过程卡', async () => {
    const manifest = JSON.parse(await readFile(join(REPO_ROOT, 'package.json'), 'utf8')) as { files?: unknown }
    expect(Array.isArray(manifest.files)).toBe(true)
    const files = manifest.files as string[]
    expect(files).toContain('skills')
    const legacy = ['omb-cite', 'omb-conflict', 'omb-depth', 'omb-failure', 'omb-goal', 'omb-honesty', 'omb-options', 'omb-testable']
    for (const name of legacy) {
      expect(files.some(entry => entry.includes(name))).toBe(false)
    }
  })

  it('给定 deploy 脚本当检查则技能复制清单只含四个功能说明', async () => {
    const deploy = await readFile(join(REPO_ROOT, 'scripts', 'v7-deploy.mjs'), 'utf8')
    const match = /for \(const skill of \[([^\]]*)\]\)/.exec(deploy)
    expect(match).not.toBeNull()
    const copied = [...(match?.[1] ?? '').matchAll(/'([^']+)'/g)].map(item => item[1])
    expect(copied).toEqual([...OMB_SKILL_NAMES])
  })
})

describe('skills 说明与实现一致', () => {
  it('给定四篇说明当提取 omb_ 引用则只引用真实存在且都有说明的工具', async () => {
    const host = fakeHost()
    registerSkills(host.ctx, recordingLogger().logger)
    const contents = await contentsOf(providerOf(host))

    const mentioned = new Set<string>()
    for (const definition of contents.values()) {
      for (const match of definition.content.matchAll(/omb_[a-z][a-z0-9_]*/g)) mentioned.add(match[0])
    }
    // 说明里不许出现不存在的工具名，否则模型会调用一个没有注册的工具。
    expect([...mentioned].sort()).toEqual([...EXPECTED_TOOL_NAMES].sort())
  })

  it('给定四篇说明当检查旧漂移说法则已改写为当前实现', async () => {
    const host = fakeHost()
    registerSkills(host.ctx, recordingLogger().logger)
    const contents = await contentsOf(providerOf(host))

    for (const definition of contents.values()) {
      expect(definition.content).not.toContain('从 `omb_recall` 或 `omb_history` 拿')
      expect(definition.content).not.toContain('每次更新自动写历史版本')
      expect(definition.content).not.toContain('旧条目保留，不物理删除')
    }
    const state = contents.get('omb-state')?.content ?? ''
    expect(state).toContain('`expectedRevision` 是必填')
    expect(state).toContain('只有状态机更新会自动写历史快照')
    const recall = contents.get('omb-recall')?.content ?? ''
    expect(recall).toContain('同组成员会作为独立命中参与计分')
    expect(recall).not.toContain('只「带出同组标题」')
  })
})
