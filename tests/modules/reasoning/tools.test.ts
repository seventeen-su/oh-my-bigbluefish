/**
 * `omb_method` / `omb_focus` 工具面。
 *
 * 核心契约（H-3）：**执行体绝不抛异常**——端口缺失、端口抛异常、
 * 参数非法，一律返回 `{kind:'error', text}`。
 */
import { describe, expect, it } from 'vitest'
import { createKernel } from '../../../kernel/index.js'
import { applyFocus, readFocus } from '../../../modules/reasoning/focus.js'
import type { LoopSignal } from '../../../modules/reasoning/loop.js'
import { cardById, residentHint } from '../../../modules/reasoning/methods.js'
import type { ReasoningToolPorts } from '../../../modules/reasoning/tools.js'
import { createFocusTool, createMethodTool, createReasoningTools } from '../../../modules/reasoning/tools.js'

/** 用真实内核搭一套最小端口；`overrides` 可注入会抛异常的坏端口。 */
function makePorts(session = 's1', overrides: Partial<ReasoningToolPorts> = {}) {
  const handle = createKernel()
  const ports: ReasoningToolPorts = {
    currentSession: session,
    readDepth: target => readFocus(handle.kernel, target).depth,
    applyDepth: (target, depth, reason) => applyFocus(handle.kernel, target, depth, reason),
    ...overrides,
  }
  return { handle, ports }
}

const outcomeText = (outcome: { kind: string; text: string }): string => outcome.text

describe('omb_method', () => {
  it('不传 topic：返回索引（八张编号 + 何时用），不给正文', () => {
    const { handle, ports } = makePorts()
    const tool = createMethodTool(ports)
    const outcome = tool.execute({})
    expect(outcome.kind).toBe('text')
    for (const id of ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8']) {
      expect(outcomeText(outcome)).toContain(id)
    }
    expect(outcomeText(outcome)).not.toContain(cardById('R3')?.text ?? '不可能匹配')
    handle.dispose()
  })

  it('传 topic："R3" / "备选" / "失败" 都能取到对应全文', () => {
    const { handle, ports } = makePorts()
    const tool = createMethodTool(ports)
    expect(outcomeText(tool.execute({ topic: 'R3' }))).toContain(cardById('R3')?.text ?? '')
    expect(outcomeText(tool.execute({ topic: '备选' }))).toContain(cardById('R3')?.text ?? '')
    expect(outcomeText(tool.execute({ topic: '失败' }))).toContain(cardById('R6')?.text ?? '')
    handle.dispose()
  })

  it('topic="all" 取八张全文', () => {
    const { handle, ports } = makePorts()
    const outcome = createMethodTool(ports).execute({ topic: 'all' })
    for (const id of ['R1', 'R8']) expect(outcomeText(outcome)).toContain(cardById(id)?.text ?? '')
    handle.dispose()
  })

  it('无匹配话题：错误分支 + 索引（模型能自行改话题重试）', () => {
    const { handle, ports } = makePorts()
    const outcome = createMethodTool(ports).execute({ topic: '不存在的词zzz' })
    expect(outcome.kind).toBe('error')
    expect(outcomeText(outcome)).toContain('没有匹配')
    expect(outcomeText(outcome)).toContain('R1')
    handle.dispose()
  })

  it('参数非法（topic 不是字符串）：错误分支，不抛', () => {
    const { handle, ports } = makePorts()
    const outcome = createMethodTool(ports).execute({ topic: 42 })
    expect(outcome.kind).toBe('error')
    expect(outcomeText(outcome)).toContain('omb_method')
    handle.dispose()
  })

  it('args 为 null / 字符串同样不抛', () => {
    const { handle, ports } = makePorts()
    const tool = createMethodTool(ports)
    expect(tool.execute(null).kind).toBe('text')
    expect(tool.execute('R3').kind).toBe('error')
    handle.dispose()
  })

  it('会话端口抛异常：仍然返回索引文本（该方法不需要会话）', () => {
    const { handle, ports } = makePorts('s1', {
      currentSession: () => {
        throw new Error('没有会话')
      },
    })
    const outcome = createMethodTool(ports).execute({})
    expect(outcome.kind).toBe('text')
    handle.dispose()
  })

  it('有循环信号时附上一句话提示；信号端口抛异常则静默略过', () => {
    const signal: LoopSignal = { kind: 'oscillation', detail: '来回两次', hint: '换个第三个选项。' }
    const ok = makePorts('s1', { loopSignal: () => signal })
    expect(outcomeText(createMethodTool(ok.ports).execute({}))).toContain(signal.hint)
    ok.handle.dispose()

    const bad = makePorts('s1', {
      loopSignal: () => {
        throw new Error('读数失败')
      },
    })
    expect(createMethodTool(bad.ports).execute({}).kind).toBe('text')
    bad.handle.dispose()
  })
})

describe('omb_focus', () => {
  it('合法档位：写进内核并回自解释文本', () => {
    const { handle, ports } = makePorts('s-focus')
    const outcome = createFocusTool(ports).execute({ depth: 'deep', reason: '多方案权衡' })
    expect(outcome.kind).toBe('text')
    expect(outcomeText(outcome)).toContain('deep')
    expect(outcomeText(outcome)).toContain('多方案权衡')
    expect(handle.kernel.focus('s-focus')).toBe('deep')
    handle.dispose()
  })

  it('reason 缺省也能用（记为"模型未给理由"）', () => {
    const { handle, ports } = makePorts('s2')
    const outcome = createFocusTool(ports).execute({ depth: 'quick' })
    expect(outcome.kind).toBe('text')
    expect(outcomeText(outcome)).toContain('模型未给理由')
    expect(handle.kernel.focus('s2')).toBe('quick')
    handle.dispose()
  })

  it('非法档位：错误分支且不改状态', () => {
    const { handle, ports } = makePorts('s3')
    const tool = createFocusTool(ports)
    const outcome = tool.execute({ depth: 'DEEP' })
    expect(outcome.kind).toBe('error')
    expect(outcomeText(outcome)).toContain('quick / standard / deep')
    expect(handle.kernel.focus('s3')).toBe('standard')
    expect(tool.execute({}).kind).toBe('error')
    expect(tool.execute({ depth: 7 }).kind).toBe('error')
    handle.dispose()
  })

  it('取不到会话：错误分支，明说未改变任何状态', () => {
    const { handle, ports } = makePorts('s4', { currentSession: '' })
    const outcome = createFocusTool(ports).execute({ depth: 'deep', reason: 'r' })
    expect(outcome.kind).toBe('error')
    expect(outcomeText(outcome)).toContain('会话')
    handle.dispose()
  })

  it('端口抛异常：错误分支，绝不抛', () => {
    const { handle, ports } = makePorts('s5', {
      applyDepth: () => {
        throw new Error('写不进去')
      },
    })
    const outcome = createFocusTool(ports).execute({ depth: 'deep' })
    expect(outcome.kind).toBe('error')
    expect(outcomeText(outcome)).toContain('写不进去')
    handle.dispose()
  })
})

describe('工具工厂', () => {
  it('返回两个工具，名字与目录一致', () => {
    const { handle, ports } = makePorts()
    const tools = createReasoningTools(ports)
    expect(tools.map(tool => tool.name)).toEqual(['omb_method', 'omb_focus'])
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(0)
      expect(typeof tool.parameters.parse).toBe('function')
    }
    handle.dispose()
  })

  it('描述里含常驻提示提到的那两把工具（模型看得到）', () => {
    const hint = residentHint()
    const { handle, ports } = makePorts()
    for (const tool of createReasoningTools(ports)) expect(hint).toContain(tool.name)
    handle.dispose()
  })

  it('两个工具的 execute 都是同步返回 ToolOutcome（不返回 Promise）', () => {
    const { handle, ports } = makePorts()
    for (const tool of createReasoningTools(ports)) {
      const outcome = tool.execute({})
      expect(outcome).not.toBeInstanceOf(Promise)
      expect(['text', 'error']).toContain(outcome.kind)
    }
    handle.dispose()
  })
})
