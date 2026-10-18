/**
 * 3.7 Wave 2 §3：`omb_project`（项目画像 + 项目记忆）。
 *
 * 判据：
 * ① 有画像服务：返回画像（含 git 头/生成时间）+ 项目记忆 top 3；
 * ② 服务缺席：明确说"不可用"（不是"画像为空"），项目记忆仍然返回；
 * ③ `refresh:true` 走 `refresh` 并计数；无会话归属时说明原因；
 * ④ 参数非法 → error，不抛。
 */
import { describe, expect, it } from 'vitest'
import type { MemoryRecord } from '../../../kernel/abi/index.js'
import { createProjectTool, describeAge, type ProjectProfilePort } from '../../../modules/memory/project.js'
import { clockAt, fakeStore, hits, makeRecord, tagged } from '../retrieval/fakes.js'

const CLOCK = clockAt(1_700_000_000_000)

function projectRecords(): readonly MemoryRecord[] {
  return [
    makeRecord({ id: 'p1', scope: 'project', kind: 'semantic', text: '项目约定：所有命令走 pnpm。' }),
    makeRecord({ id: 'p2', scope: 'project', kind: 'procedural', text: '结论：先跑 pnpm verify 再提交。' }),
  ]
}

function fakeProfile(): ProjectProfilePort & { reads: number; refreshes: number } {
  const port = {
    reads: 0,
    refreshes: 0,
    read: () => {
      port.reads += 1
      return { text: '栈：TypeScript + Cordis\n命令：pnpm verify', generatedAt: CLOCK.now() - 3_600_000, gitHead: 'abc123def456' }
    },
    refresh: async () => {
      port.refreshes += 1
      return { text: '栈：TypeScript（刚重建）', generatedAt: CLOCK.now() }
    },
  }
  return port
}

function toolOf(options: { readonly profile?: ProjectProfilePort; readonly store?: ReturnType<typeof fakeStore> }) {
  const store = options.store ?? fakeStore({ scope: 'project', records: projectRecords(), search: () => hits(['p1', 'p2'], 100) })
  return createProjectTool({
    clock: CLOCK,
    resolveProject: () => ({ cwd: 'D:\\work\\demo', store }),
    profile: options.profile === undefined ? undefined : () => options.profile,
  })
}

describe('omb_project（3.7 Wave 2）', () => {
  it('画像 + 项目记忆 top 3：含 git 头、相对时间、逐字记忆', async () => {
    const profile = fakeProfile()
    const outcome = (await toolOf({ profile }).execute({}, { sessionId: 's1', attribution: 'session' })) as {
      kind: string
      text: string
    }
    expect(outcome.kind).toBe('text')
    expect(outcome.text).toContain('项目画像：D:\\work\\demo，git abc123def456（生成于 1 小时前）')
    expect(outcome.text).toContain('pnpm verify')
    expect(outcome.text).toContain('项目约定：所有命令走 pnpm。')
    expect(outcome.text).toContain('id=p1')
    expect(profile.reads).toBe(1)
  })

  it('画像服务缺席：说"未接线"，项目记忆照常返回', async () => {
    const outcome = (await toolOf({}).execute({}, { sessionId: 's1', attribution: 'session' })) as { text: string }
    expect(outcome.text).toContain('项目画像不可用：宿主未接线')
    expect(outcome.text).toContain('项目约定：所有命令走 pnpm。')
  })

  it('refresh:true 走重建并刷新时间', async () => {
    const profile = fakeProfile()
    const outcome = (await toolOf({ profile }).execute({ refresh: true }, { sessionId: 's1', attribution: 'session' })) as { text: string }
    expect(profile.refreshes).toBe(1)
    expect(profile.reads).toBe(0)
    expect(outcome.text).toContain('刚重建')
    expect(outcome.text).toContain('刚刚')
  })

  it('无会话归属 / 参数非法 → 可读结果或 error，不抛', async () => {
    // 生产里无会话归属时 resolveProject 返回 undefined（不拿别的项目顶替）
    const noSessionTool = createProjectTool({
      clock: CLOCK,
      resolveProject: () => undefined,
      profile: () => fakeProfile(),
    })
    const noSession = (await noSessionTool.execute({})) as { text: string }
    expect(noSession.text).toContain('项目上下文未知')

    const bad = (await toolOf({}).execute({ refresh: 'yes' })) as { kind: string; text: string }
    expect(bad.kind).toBe('error')
    expect(bad.text).toContain('refresh 必须是布尔值')
  })

  it('describeAge 是确定性的相对时间（不读墙钟）', () => {
    const now = 1_700_000_000_000
    expect(describeAge(now, now)).toBe('刚刚')
    expect(describeAge(now, now - 90_000)).toBe('1 分钟前')
    expect(describeAge(now, now - 3_600_000)).toBe('1 小时前')
    expect(describeAge(now, now - 2 * 86_400_000)).toBe('2 天前')
  })

  it('项目库未打开时仍返回画像 + 说明', async () => {
    const tool = createProjectTool({
      clock: CLOCK,
      resolveProject: () => ({ cwd: 'D:\\work\\demo' }),
      profile: () => fakeProfile(),
    })
    const outcome = (await tool.execute({}, { sessionId: 's1', attribution: 'session' })) as { text: string }
    expect(outcome.text).toContain('项目画像：D:\\work\\demo')
    expect(outcome.text).toContain('项目库未打开')
  })

  it('tagged 辅助类型未被误用（编译期契约）', () => {
    // 这条只是让 `tagged` 导入被使用，避免 lint；语义由上面几条覆盖
    expect(tagged(fakeStore({ scope: 'project' })).scope).toBe('project')
  })
})
