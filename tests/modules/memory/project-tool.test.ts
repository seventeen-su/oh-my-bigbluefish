/**
 * v4.1 §3.4：`omb_project` 的**六层时空快照**（L0–L5）+ 隐私门控。
 *
 * 判据：
 * ① 固定层序（身份/结构/空间状态/时间/知识/意图）、每层一行标题、总长 ≤2400；
 * ② 隐私先于读取：sealed / 判定抛错 → 不读画像、不读记忆，返回可读原因；
 *    read-only（allowRead=true）→ 画像与记忆都读；
 * ③ 无会话归属 → 只给画像（L3 写"无会话归属"、L4 不读记忆）；
 * ④ 缺服务降级：画像不可用/状态未知/暂无记忆/0（真的 0），绝不写成绿；
 * ⑤ 项目根统一：L0 的 git root 来自 projectRoot 依赖，cwd 相对根由根算出。
 */
import { describe, expect, it } from 'vitest'
import type { MemoryRecord } from '../../../kernel/abi/index.js'
import {
  createProjectTool,
  describeAge,
  MAX_SNAPSHOT_CHARS,
  type ProjectProfilePort,
  type ProjectProfileView,
  type SessionSituationView,
} from '../../../modules/memory/project.js'
import { clockAt, fakeStore, hits, makeRecord } from '../retrieval/fakes.js'

const CLOCK = clockAt(1_700_000_000_000)
const NOW = CLOCK.now()

function projectRecords(): readonly MemoryRecord[] {
  return [
    makeRecord({ id: 'p1', scope: 'project', kind: 'semantic', text: '项目约定：所有命令走 pnpm。', observedAt: NOW - 3_600_000 }),
    makeRecord({ id: 'p2', scope: 'project', kind: 'procedural', text: '结论：先跑 pnpm verify 再提交。', observedAt: NOW - 2 * 86_400_000 }),
  ]
}

function fakeProfile(): ProjectProfilePort & { reads: number; refreshes: number } {
  const port = {
    reads: 0,
    refreshes: 0,
    read: (): ProjectProfileView => {
      port.reads += 1
      return {
        text: '栈：TypeScript + Cordis\n命令：pnpm verify',
        generatedAt: NOW - 3_600_000,
        gitHead: 'abc123def456',
        root: 'D:\\work\\repo',
        cwdRel: 'sub',
        identity: {
          name: 'demo',
          version: '1.2.3',
          branch: 'main',
          head: 'abc123def456',
          headAt: NOW - 7_200_000,
        },
        structure: {
          topDirs: [{ name: 'modules', files: 12 }, { name: 'docs', files: 4 }],
          sources: [{ dir: 'modules/memory', files: 12, lines: 3456, tests: 120 }],
          entries: ['modules/memory/index.ts'],
          docs: [{ path: 'docs/a.md', title: '空间规格' }],
        },
        history: { commits: [{ hash: 'abc123def456', subject: 'feat: v4.1', at: NOW - 7_200_000 }], dirty: 3 },
        gates: [{ name: 'test', command: 'pnpm test' }],
      }
    },
    refresh: async (): Promise<ProjectProfileView> => {
      port.refreshes += 1
      return {
        text: '栈：TypeScript（刚重建）',
        generatedAt: NOW,
        root: 'D:\\work\\repo',
        cwdRel: 'sub',
        identity: { name: 'demo', version: '1.2.3', branch: 'main', head: 'abc123def456', headAt: NOW },
        structure: { topDirs: [{ name: 'modules', files: 13 }] },
      }
    },
  }
  return port
}

function fakeSituation(overrides: Partial<SessionSituationView> = {}): SessionSituationView {
  return {
    sessionId: 's1',
    cwd: 'D:\\work\\repo\\sub',
    state: 'active',
    tier: 'fresh',
    turn: 7,
    step: 3,
    lastEventAt: NOW - 60_000,
    idleMs: 60_000,
    lastTurnEndReason: 'done',
    interrupted: false,
    unresolved: true,
    goals: { open: 1, total: 2 },
    todos: { open: 0, total: 3 },
    epoch: { id: 'e1', dirtyCount: 3, degraded: false },
    reads: { count: 2, changed: 1, unknown: 0 },
    sideEffects: { blindWrites: 1, staleWrites: 0, denies: 2, gaveUps: 0, writeWarnings: 1, unverifiable: 3 },
    ...overrides,
  }
}

interface ToolOptions {
  readonly profile?: ProjectProfilePort
  readonly situation?: SessionSituationView
  readonly privacy?: (sessionId: string) => boolean
  readonly projectRoot?: (cwd: string) => string
  readonly cwd?: string
  readonly resolveProject?: (sessionId?: string) => { readonly cwd?: string; readonly store?: import('../../../kernel/abi/index.js').MemoryStore } | undefined
}

function toolOf(options: ToolOptions = {}) {
  const store = fakeStore({ scope: 'project', records: projectRecords(), search: () => hits(['p1', 'p2']) })
  return {
    store,
    tool: createProjectTool({
      clock: CLOCK,
      resolveProject:
        options.resolveProject ??
        (sessionId =>
          sessionId === undefined ? undefined : { cwd: options.cwd ?? 'D:\\work\\repo\\sub', store }),
      profile: options.profile === undefined ? undefined : () => options.profile as ProjectProfilePort,
      situation: options.situation === undefined ? undefined : () => options.situation,
      ...(options.privacy === undefined ? {} : { privacyAllowsRead: options.privacy }),
      ...(options.projectRoot === undefined ? {} : { projectRoot: options.projectRoot }),
    }),
  }
}

function textOf(outcome: { readonly kind: string; readonly text: string }): string {
  expect(outcome.kind).toBe('text')
  return outcome.text
}

describe('omb_project 六层时空快照（v4.1 §2）', () => {
  it('固定层序 L0–L5，每层一行标题，内容来自画像/状态机/记忆库', async () => {
    const profile = fakeProfile()
    const outcome = await toolOf({ profile, situation: fakeSituation() }).tool.execute(
      {},
      { sessionId: 's1', attribution: 'session' },
    )
    const text = textOf(outcome as { kind: string; text: string })
    const lines = text.split('\n')
    expect(lines).toHaveLength(6)
    expect(lines[0]?.startsWith('L0 身份：')).toBe(true)
    expect(lines[1]?.startsWith('L1 结构：')).toBe(true)
    expect(lines[2]?.startsWith('L2 空间状态：')).toBe(true)
    expect(lines[3]?.startsWith('L3 时间：')).toBe(true)
    expect(lines[4]?.startsWith('L4 知识：')).toBe(true)
    expect(lines[5]?.startsWith('L5 意图：')).toBe(true)

    expect(lines[0]).toContain('demo v1.2.3')
    expect(lines[0]).toContain('git root D:\\work\\repo')
    expect(lines[0]).toContain('cwd 相对根 sub')
    expect(lines[0]).toContain('分支 main')
    expect(lines[0]).toContain('HEAD abc123def456（2 小时前）')

    expect(lines[1]).toContain('顶层 modules(12)、docs(4)')
    expect(lines[1]).toContain('modules/memory(12 文件/3456 行/120 测试)')
    expect(lines[1]).toContain('入口 modules/memory/index.ts')
    expect(lines[1]).toContain('文档 空间规格')
    expect(lines[1]).toContain('构建 test:pnpm test')
    expect(lines[1]).toContain('未提交 3')

    expect(lines[2]).toContain('epoch e1')
    expect(lines[2]).toContain('脏文件 3')
    expect(lines[2]).toContain('读取印记 2（已变化 1/无法核验 0）')
    expect(lines[2]).toContain('守卫 拒写 2/放弃 0/盲写 1/无法核验 3')

    expect(lines[3]).toContain('回合 7/步 3')
    expect(lines[3]).toContain('空闲 fresh（1m）')
    expect(lines[3]).toContain('上次结束 done')
    expect(lines[3]).toContain('中断 否')

    expect(lines[4]).toContain('[1]')
    expect(lines[4]).toContain('id=p1')
    expect(lines[4]).toContain('近况：近 7 天有更新')
    expect(lines[4]).toContain('关联边 0')

    expect(lines[5]).toContain('开放目标 1/2')
    expect(lines[5]).toContain('待办 0/3')
    expect(lines[5]).toContain('未解决 是')

    expect(profile.reads).toBe(1)
  })

  it('sealed（allowRead=false）：不读画像、不读记忆，返回可读原因', async () => {
    const profile = fakeProfile()
    const built = toolOf({ profile, situation: fakeSituation(), privacy: () => false })
    const outcome = (await built.tool.execute({}, { sessionId: 's1', attribution: 'session' })) as {
      kind: string
      text: string
    }
    expect(outcome.kind).toBe('text')
    expect(outcome.text).toContain('不可读')
    expect(outcome.text).toContain('/omb-privacy normal')
    expect(outcome.text).not.toContain('L0 身份')
    expect(profile.reads).toBe(0)
    expect(built.store.calls.searchLexical).toBe(0)
  })

  it('read-only（allowRead=true）：画像与记忆都读（写仍由库闸门另行拒绝）', async () => {
    const profile = fakeProfile()
    const built = toolOf({ profile, situation: fakeSituation(), privacy: () => true })
    const outcome = await built.tool.execute({}, { sessionId: 's1', attribution: 'session' })
    const text = (outcome as { text: string }).text
    expect(profile.reads).toBe(1)
    expect(built.store.calls.searchLexical).toBe(1)
    expect(text).toContain('项目约定：所有命令走 pnpm。')
  })

  it('隐私判定抛错 → 视为不可读（fail-closed），不读任何东西', async () => {
    const profile = fakeProfile()
    const built = toolOf({
      profile,
      privacy: () => {
        throw new Error('gate down')
      },
    })
    const outcome = await built.tool.execute({}, { sessionId: 's1', attribution: 'session' })
    expect((outcome as { text: string }).text).toContain('不可读')
    expect(profile.reads).toBe(0)
    expect(built.store.calls.searchLexical).toBe(0)
  })

  it('无会话归属：只给画像，L3 写"无会话归属"、L4 不读记忆', async () => {
    const profile = fakeProfile()
    const built = toolOf({
      profile,
      resolveProject: () => ({ cwd: 'D:\\work\\repo\\sub' }),
    })
    const outcome = (await built.tool.execute({})) as { text: string }
    expect(outcome.text).toContain('git root D:\\work\\repo')
    expect(outcome.text).toContain('cwd 相对根 sub')
    expect(outcome.text).toContain('L3 时间：无会话归属')
    expect(outcome.text).toContain('L4 知识：暂无记忆（无会话归属：不读项目记忆）')
    expect(profile.reads).toBe(1)
  })

  it('缺服务降级：画像不可用/状态未知/无会话归属/0 都写明来源', async () => {
    const outcome = (await toolOf({ resolveProject: () => ({ cwd: 'D:\\work\\repo' }) }).tool.execute(
      {},
      { sessionId: 's1', attribution: 'session' },
    )) as { text: string }
    const lines = outcome.text.split('\n')
    expect(lines[0]).toContain('项目名未接线')
    expect(lines[0]).toContain('git root D:\\work\\repo')
    expect(lines[1]).toContain('画像不可用')
    expect(lines[2]).toContain('状态未知')
    expect(lines[3]).toContain('无会话归属（状态机未接线）')
    expect(lines[4]).toContain('项目库未打开')
    expect(lines[5]).toContain('0（状态机未接线：无法统计）')
  })

  it('refresh:true 走重建；L0 的 headAt 随之更新', async () => {
    const profile = fakeProfile()
    const outcome = (await toolOf({ profile, situation: fakeSituation() }).tool.execute(
      { refresh: true },
      { sessionId: 's1', attribution: 'session' },
    )) as { text: string }
    expect(profile.refreshes).toBe(1)
    expect(profile.reads).toBe(0)
    expect(outcome.text.split('\n')[1]).toContain('modules(13)') // 重建后的结构
    expect(outcome.text).toContain('HEAD abc123def456（刚刚）')
  })

  it('项目根统一：L0 的 git root 来自 projectRoot，cwd 相对根由根算出（不依赖画像字段）', async () => {
    const profile: ProjectProfilePort = {
      read: () => ({
        text: '无结构字段的旧画像',
        generatedAt: NOW,
        // 故意不提供 root/cwdRel
        identity: { name: 'demo', head: 'deadbeef' },
      }),
      refresh: async () => undefined,
    }
    const outcome = (await toolOf({
      profile,
      situation: fakeSituation(),
      projectRoot: () => 'D:\\work\\repo',
    }).tool.execute({}, { sessionId: 's1', attribution: 'session' })) as { text: string }
    const l0 = outcome.text.split('\n')[0] ?? ''
    expect(l0).toContain('git root D:\\work\\repo')
    expect(l0).toContain('cwd 相对根 sub')
    // 旧画像没有结构字段 → L1 退回画像文本（不是"结构为空"）
    expect(outcome.text.split('\n')[1]).toContain('无结构字段的旧画像')
  })

  it('总长 ≤ 2400：超限时按层压缩正文，六层标题都在，且同一输入同一文本', async () => {
    const many = Array.from({ length: 30 }, (_, index) => ({ name: `dir-${index}`, files: index }))
    const bigProfile: ProjectProfilePort = {
      read: () => ({
        text: 'x'.repeat(8000),
        generatedAt: NOW,
        identity: { name: 'big', head: 'abc123' },
        structure: {
          topDirs: many,
          sources: many.map((dir, index) => ({ dir: dir.name, files: index, lines: index * 10, tests: index })),
          entries: many.map(dir => `${dir.name}/index.ts`),
          docs: many.map((dir, index) => ({ path: `docs/${index}.md`, title: `标题-${index}` })),
        },
        gates: many.map((dir, index) => ({ name: `gate-${index}`, command: `command-${index}` })),
      }),
      refresh: async () => undefined,
    }
    const built = toolOf({ profile: bigProfile, situation: fakeSituation() })
    const first = (await built.tool.execute({}, { sessionId: 's1', attribution: 'session' })) as { text: string }
    const second = (await built.tool.execute({}, { sessionId: 's1', attribution: 'session' })) as { text: string }
    expect(first.text.length).toBeLessThanOrEqual(MAX_SNAPSHOT_CHARS)
    expect(first.text).toBe(second.text)
    for (const prefix of ['L0 身份：', 'L1 结构：', 'L2 空间状态：', 'L3 时间：', 'L4 知识：', 'L5 意图：']) {
      expect(first.text).toContain(prefix)
    }
  })

  it('项目记忆最多 3 条', async () => {
    const records = ['p1', 'p2', 'p3', 'p4', 'p5'].map(id =>
      makeRecord({ id, scope: 'project', kind: 'semantic', text: `项目约定 ${id}`, observedAt: NOW - 1000 }),
    )
    const store = fakeStore({ scope: 'project', records, search: () => hits(['p1', 'p2', 'p3', 'p4', 'p5']) })
    const tool = createProjectTool({
      clock: CLOCK,
      resolveProject: () => ({ cwd: 'D:\\work\\repo', store }),
      situation: () => fakeSituation(),
    })
    const outcome = (await tool.execute({}, { sessionId: 's1', attribution: 'session' })) as { text: string }
    const l4 = outcome.text.split('\n')[4] ?? ''
    expect(l4).toContain('[3]')
    expect(l4).not.toContain('[4]')
  })

  it('参数非法 → error，不抛', async () => {
    const outcome = (await toolOf({}).tool.execute({ refresh: 'yes' })) as { kind: string; text: string }
    expect(outcome.kind).toBe('error')
    expect(outcome.text).toContain('refresh 必须是布尔值')
  })

  it('describeAge 是确定性的相对时间（不读墙钟）', () => {
    const now = 1_700_000_000_000
    expect(describeAge(now, now)).toBe('刚刚')
    expect(describeAge(now, now - 90_000)).toBe('1 分钟前')
    expect(describeAge(now, now - 3_600_000)).toBe('1 小时前')
    expect(describeAge(now, now - 2 * 86_400_000)).toBe('2 天前')
  })
})
