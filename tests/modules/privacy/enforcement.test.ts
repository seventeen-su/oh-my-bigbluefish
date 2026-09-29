/**
 * **单一强制点的证据**（Lead 明确要求的那条判据）。
 *
 * 判据：`sealed` 下**直接调库**（`stores.forSession(id).store('user').put(...)`，
 * 绕过工具层、绕过任何装饰、绕过模型）也必须被拒。
 *
 * 这个测试故意**不用假库**：用真实 `createStoresService` + 真实 `node:sqlite`
 * + 真实 `PrivacyGate`，注入方式与生产完全一致（`StoresServiceOptions.privacy`）。
 * 因此它证明的不是"某个 mock 会拒绝"，而是"库访问边界那一道真的在"。
 */
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { createStoresService } from '../../../modules/memory/store.js'
import { asVectorStore } from '../../../modules/memory/store.js'
import { createPrivacyRegistration, MODULE_ID } from '../../../modules/privacy/index.js'
import { PrivacyGate } from '../../../modules/privacy/gate.js'
import { PrivacyState } from '../../../modules/privacy/state.js'
import { SessionRuntimeTable } from '../../../kernel/sessionRuntime.js'
import { createKernel } from '../../../kernel/index.js'
import type { MemoryRecord } from '../../../kernel/abi/index.js'
import { capturingLogger, fixedClock, makeRecord, tempWorkspace, testPort } from '../memory/helpers.js'

interface Fixture {
  readonly stores: ReturnType<typeof createStoresService>
  readonly gate: PrivacyGate
  readonly state: PrivacyState
  readonly sessions: SessionRuntimeTable
  readonly workspace: ReturnType<typeof tempWorkspace>
  cleanup(): Promise<void>
}

function fixture(): Fixture {
  const workspace = tempWorkspace('omb-privacy-')
  const logger = capturingLogger()
  const clock = fixedClock()
  const port = testPort(workspace.dir)
  const sessions = new SessionRuntimeTable(clock)
  const state = new PrivacyState({
    sessions,
    clock,
    baseline: () => ({ mode: 'normal', origin: 'default', detail: '测试基线：未配置' }),
  })
  const gate = new PrivacyGate({ state, baselineRestricted: () => false })
  const stores = createStoresService({
    logger,
    clock,
    resolvePort: () => port,
    resolveSessionCwd: () => undefined, // 一律走"仅用户库"，测试只关心闸门
    // **与生产同一注入点**
    privacy: () => gate,
  })
  return {
    stores,
    gate,
    state,
    sessions,
    workspace,
    async cleanup() {
      try {
        await stores.dispose()
      } catch {
        // H-1：清理失败不影响结论
      }
      workspace.cleanup()
    },
  }
}

function record(id: string, text = '一条要被拦下的记忆'): MemoryRecord {
  return makeRecord({ id, text })
}

describe('单一强制点：sealed 下直接调库被拒', () => {
  it('put/get/searchLexical 全被拒，且原因是可读的（失败路径必须给得出话来）', async () => {
    const f = fixture()
    try {
      f.state.setOverride('s1', 'sealed')
      const set = await f.stores.forSession('s1')
      expect(set).toBeDefined()
      const store = set?.store('user')
      expect(store).toBeDefined()

      await expect(store?.put(record('m1'))).rejects.toThrow(/sealed/)
      await expect(store?.put(record('m1'))).rejects.toThrow(/隐私模式/)
      await expect(store?.get('m1')).rejects.toThrow(/禁止读取记忆/)
      await expect(
        store?.searchLexical({ text: '记忆', scope: 'user', limit: 5 }),
      ).rejects.toThrow(/禁止读取记忆/)
      // 读也拒 = 库里确实没有这条；再确认一次"拒的是读"（不是恰好没数据）
      await expect(store?.getMany(['m1'])).rejects.toThrow(/禁止读取记忆/)
    } finally {
      await f.cleanup()
    }
  })

  it('read-only 下写被拒、读照常（语义与表格一字不差）', async () => {
    const f = fixture()
    try {
      f.state.setOverride('s1', 'normal')
      const open = await f.stores.forSession('s1')
      const store = open?.store('user')
      await store?.put(record('m-ok', '先正常写一条'))
      expect(await store?.get('m-ok')).toMatchObject({ id: 'm-ok' })

      f.state.setOverride('s1', 'read-only')
      const gated = (await f.stores.forSession('s1'))?.store('user')
      // 读：允许
      expect(await gated?.get('m-ok')).toMatchObject({ id: 'm-ok' })
      expect((await gated?.searchLexical({ text: '正常', scope: 'user', limit: 5 }))?.length).toBeGreaterThan(0)
      // 写：拒绝（边、事务里的写也走同一个视图 → 一样被拒）
      await expect(gated?.put(record('m2'))).rejects.toThrow(/read-only/)
      await expect(
        gated?.upsertEdge({ fromId: 'a', toId: 'b', type: 'derived_from', createdAt: 1 }),
      ).rejects.toThrow(/read-only/)
      await expect(gated?.forget(['m-ok'])).rejects.toThrow(/read-only/)
    } finally {
      await f.cleanup()
    }
  })

  it('normal 下读写都通（闸门不能把正常路径也堵上）', async () => {
    const f = fixture()
    try {
      f.state.setOverride('s1', 'normal')
      const store = (await f.stores.forSession('s1'))?.store('user')
      await store?.put(record('m-normal'))
      expect(await store?.get('m-normal')).toMatchObject({ id: 'm-normal' })
    } finally {
      await f.cleanup()
    }
  })

  it('peek() 出口同样过闸（工具路径走的正是 peek）', async () => {
    const f = fixture()
    try {
      await f.stores.start() // peek 只给"已打开的库"，所以先把用户库打开
      f.state.setOverride('s1', 'sealed')
      const peeked = f.stores.peek('s1')?.store('user')
      expect(peeked).toBeDefined()
      await expect(peeked?.put(record('m3'))).rejects.toThrow(/sealed/)
      await expect(peeked?.get('m3')).rejects.toThrow(/sealed/)
    } finally {
      await f.cleanup()
    }
  })

  it('`set.stores`（检索/整合迭代的那一份）也是视图，不是裸库', async () => {
    const f = fixture()
    try {
      f.state.setOverride('s1', 'sealed')
      const set = await f.stores.forSession('s1')
      const tagged = set?.stores.find(entry => entry.scope === 'user')
      expect(tagged).toBeDefined()
      await expect(tagged?.store.put(record('m4'))).rejects.toThrow(/sealed/)
      // 而且视图仍是"本实现"：否则向量通道会因 instanceof 失败而静默降级
      expect(asVectorStore(tagged!.store)).toBeDefined()
      await expect(
        asVectorStore(tagged!.store)?.putEmbedding({
          memoryId: 'm4',
          modelId: 'test',
          dim: 4,
          revision: 'r1',
          vector: new Float32Array([0, 0, 0, 0]),
        } as never),
      ).rejects.toThrow(/sealed/)
    } finally {
      await f.cleanup()
    }
  })

  it('向量编码路径（snapshot，归属未知）：有受限会话时禁写、无受限会话时照常', async () => {
    const f = fixture()
    try {
      await f.stores.start() // snapshot 只给"已打开的库"
      // 没有任何受限会话 → 归属未知也必须放行，否则隐私模块会变成静默的功能故障
      const free = f.stores.snapshot().user?.store('user')
      expect(free).toBeDefined()
      await free?.put(record('m-free', '没有隐私会话时，向量编码路径必须能写'))

      // 出现一个 sealed 会话 → 同一条写入被拒（这一条编码无法证明不属于那个会话）
      f.state.setOverride('s1', 'sealed')
      const blocked = f.stores.snapshot().user?.store('user')
      await expect(blocked?.put(record('m-blocked'))).rejects.toThrow(/归属/)
      // 读仍允许：快照的读路径不该被掐（否则状态面与编码水合都会失败）
      expect(await blocked?.get('m-free')).toMatchObject({ id: 'm-free' })
    } finally {
      await f.cleanup()
    }
  })
})

describe('子代理继承（库访问边界上的继承）', () => {
  it('子会话没有自己的设置时继承父会话的 sealed：子会话直接写库也被拒', async () => {
    const f = fixture()
    try {
      f.state.setOverride('parent', 'sealed')
      // 宿主会话头里的 parentSession 由本模块登记（生产：订阅 session/event）
      f.state.noteLineage({ sessionId: 'child', parentSessionId: 'parent', source: 'session-event' })

      expect(f.state.resolve('child')).toMatchObject({ mode: 'sealed', origin: 'inherited', inheritedFrom: 'parent' })

      const childStore = (await f.stores.forSession('child'))?.store('user')
      await expect(childStore?.put(record('m-child'))).rejects.toThrow(/继承自 parent/)
    } finally {
      await f.cleanup()
    }
  })

  it('父会话改模式后，子会话立刻跟着变（读时解析，不写副本）', async () => {
    const f = fixture()
    try {
      f.state.setOverride('parent', 'read-only')
      f.state.noteLineage({ sessionId: 'child', parentSessionId: 'parent', source: 'session-event' })
      expect(f.state.resolve('child').mode).toBe('read-only')

      f.state.setOverride('parent', 'normal')
      expect(f.state.resolve('child')).toMatchObject({ mode: 'normal', origin: 'inherited' })

      const childStore = (await f.stores.forSession('child'))?.store('user')
      await expect(childStore?.put(record('m-child-2'))).resolves.toBeUndefined()
    } finally {
      await f.cleanup()
    }
  })

  it('会话之间互不影响：A 的 sealed 不掐 B 的读写（范围必须按会话）', async () => {
    const f = fixture()
    try {
      f.state.setOverride('A', 'sealed')
      const bStore = (await f.stores.forSession('B'))?.store('user')
      await expect(bStore?.put(record('m-b'))).resolves.toBeUndefined()
      expect(await bStore?.get('m-b')).toMatchObject({ id: 'm-b' })
    } finally {
      await f.cleanup()
    }
  })
})

describe('没有隐私模块时行为不变（缺省=不受限）', () => {
  it('不注入 privacy → 直接调库与从前完全一致', async () => {
    const workspace = tempWorkspace('omb-privacy-none-')
    const logger = capturingLogger()
    const clock = fixedClock()
    const port = testPort(workspace.dir)
    const stores = createStoresService({
      logger,
      clock,
      resolvePort: () => port,
      resolveSessionCwd: () => undefined,
      // 故意不注入 privacy
    })
    try {
      const store = (await stores.forSession('s1'))?.store('user')
      await expect(store?.put(record('m-plain'))).resolves.toBeUndefined()
      expect(await store?.get('m-plain')).toMatchObject({ id: 'm-plain' })
    } finally {
      await stores.dispose()
      workspace.cleanup()
    }
  })
})

describe('行序无关（惰性解析，没有"等模块挂载"的窗口）', () => {
  it('记忆服务先建、隐私模块后到：同一个库服务立刻开始拒绝', async () => {
    const workspace = tempWorkspace('omb-privacy-late-')
    const logger = capturingLogger()
    const clock = fixedClock()
    const port = testPort(workspace.dir)
    const sessions = new SessionRuntimeTable(clock)
    const state = new PrivacyState({
      sessions,
      clock,
      baseline: () => ({ mode: 'normal', origin: 'default', detail: '未配置' }),
    })
    // 起手没有隐私模块（宿主按行加载时，omb-memory 可能排在 omb-privacy 之前）
    let available: PrivacyGate | undefined
    const stores = createStoresService({
      logger,
      clock,
      resolvePort: () => port,
      resolveSessionCwd: () => undefined,
      privacy: () => available,
    })
    try {
      const before = (await stores.forSession('s1'))?.store('user')
      await expect(before?.put(record('m-before'))).resolves.toBeUndefined()

      // "隐私模块挂载完成"：此刻起同一个 stores 实例就必须开始拒绝
      available = new PrivacyGate({ state, baselineRestricted: () => false })
      state.setOverride('s1', 'sealed')
      const after = (await stores.forSession('s1'))?.store('user')
      await expect(after?.put(record('m-after'))).rejects.toThrow(/sealed/)

      // 模块被关掉（服务消失）→ 回到不受限：这是"这一行就是开关"的语义
      available = undefined
      const off = (await stores.forSession('s1'))?.store('user')
      await expect(off?.put(record('m-off'))).resolves.toBeUndefined()
    } finally {
      await stores.dispose()
      workspace.cleanup()
    }
  })
})

describe('模块注册项与目录一致', () => {
  it(`模块 id 是 ${MODULE_ID}，且注册项能装配到内核、卸载后不留服务`, () => {
    const registration = createPrivacyRegistration()
    expect(registration.manifest.id).toBe(MODULE_ID)
    const handle = createKernel()
    const workspace = tempWorkspace('omb-privacy-reg-')
    const applied = registration.apply(handle.kernel, {
      failClosedMode: 'sealed',
      path: join(workspace.dir, 'session-modes.json'),
    })
    expect(typeof applied).toBe('function')
    // `apply` 的返回类型允许 void（内核契约如此）；测试里断言它确实给了 disposer
    if (typeof applied !== 'function') throw new Error('模块 apply 未返回 disposer（宿主无法卸载）')
    expect(handle.kernel.service('privacy')).toBeDefined()
    expect(() => applied()).not.toThrow()
    expect(handle.kernel.service('privacy')).toBeUndefined()
    workspace.cleanup()
  })
})
