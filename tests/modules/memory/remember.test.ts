/**
 * 写入路径测试（规划 §5.6 在线部分）。
 *
 * 两组断言：
 * ① **准入启发式是纯函数**——准入/弃权都要有可读原因（弃权率是审计漏记的唯一手段）
 * ② **工具执行体挂真实 SQLite**——路由、回执、事件、降级、绝不抛
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { MemoryStore, ToolDefinition, ToolOutcome } from '../../../kernel/abi/index.js'
import {
  MAX_TEXT_CHARS,
  REMEMBER_JSON_SCHEMA,
  REMEMBER_TOOL,
  contentHashOf,
  createRememberTool,
  decideAdmission,
  isGroundedInUserMessage,
  type MemoryWriteDeps,
} from '../../../modules/memory/remember.js'
import { openMemoryStore, type SqliteMemoryStore } from '../../../modules/memory/store.js'
import {
  capturingLogger,
  fixedClock,
  tempWorkspace,
  testPort,
  type TempWorkspace,
  type TestClock,
} from './helpers.js'

// ────────────────────────────────────────────────────────────────────────────
// ① 准入启发式（纯函数）
// ────────────────────────────────────────────────────────────────────────────

describe('准入启发式（纯函数，§5.6）', () => {
  const base = { sourceRef: 'session:s1#turn-3', claimedUserAssertion: false } as const

  it('用户显式陈述 → 准入；拿不到用户消息原文时如实记为"自报未核对"', () => {
    const decision = decideAdmission({
      ...base,
      text: '回答请简洁，不要分点。',
      claimedUserAssertion: true,
    })
    expect(decision).toMatchObject({
      ok: true,
      ground: 'user-declared',
      assertedBy: 'user',
      verification: 'claimed-unverified',
    })
    expect(decision.ok && decision.reason).toContain('用户显式陈述')
  })

  it('用户消息可核对：核对通过 → verified；核对不通过 → 弃权（自报拿不到 user 等级）', () => {
    const text = '回答请简洁，不要分点。'
    const verified = decideAdmission({
      ...base,
      text,
      claimedUserAssertion: true,
      userMessage: '以后所有回答请简洁一点——回答请简洁，不要分点。谢谢！',
    })
    expect(verified).toMatchObject({ ok: true, verification: 'verified-in-user-message', assertedBy: 'user' })

    const unverified = decideAdmission({
      ...base,
      text,
      claimedUserAssertion: true,
      userMessage: '今天天气不错，帮我看看这个 bug。',
    })
    expect(unverified.ok).toBe(false)
    expect(unverified.ok === false && unverified.reason).toContain('无法在会话的用户消息里核对到')
  })

  it('核对忽略大小写、空白与标点差异（格式差异不该造成假弃权）', () => {
    expect(isGroundedInUserMessage('使用 PNPM 安装依赖', '请记住：使用 pnpm 安装依赖！')).toBe(true)
    expect(isGroundedInUserMessage('完全不同的句子', '请记住：使用 pnpm 安装依赖！')).toBe(false)
    expect(isGroundedInUserMessage('短', '短')).toBe(false) // 太短不足以核对
  })

  it('可由具体工件复现 → 准入，但断言来源保守记为 model', () => {
    const cases: readonly { readonly text: string; readonly label: string }[] = [
      { text: '端口配置在 src/config/server.ts 里', label: '文件名' },
      { text: '提交前跑 pnpm verify 全绿才算完成', label: '可复现命令' },
      { text: '接口文档在 https://example.com/api 上', label: 'URL' },
      { text: '这个 bug 在 commit:a1b2c3d4 之后才出现', label: '提交哈希' },
      // 裸短哈希**不认**：形态上与标识符尾段无法区分（mem_..._3c6bf8ae）。
      // 宁可漏也不错收——错收会让假事实进库并被后续会话当结论召回。
      { text: 'Node 版本固定为 24.12.0', label: '版本号' },
    ]
    for (const item of cases) {
      const decision = decideAdmission({ ...base, text: item.text })
      expect(decision, item.text).toMatchObject({ ok: true, ground: 'reproducible-artifact', assertedBy: 'model' })
      expect(decision.ok && decision.reason).toContain(item.label)
    }
  })

  it('执行结果确认（来源标注）→ 准入；但**绝不**写 assertedBy=execution（本次没有真的执行过）', () => {
    const decision = decideAdmission({
      ...base,
      sourceRef: 'execution:pnpm test',
      text: '这条结论已由测试结果确认。',
    })
    expect(decision).toMatchObject({ ok: true, ground: 'execution-confirmed', assertedBy: 'model' })
  })

  it('模糊印象 → 弃权，并给出可读原因（不是静默丢弃）', () => {
    const decision = decideAdmission({ ...base, text: '用户大概是个喜欢安静的人吧。' })
    expect(decision.ok).toBe(false)
    expect(decision.ok === false && decision.reason).toContain('没有准入依据')
    expect(decision.ok === false && decision.reason).toContain('弃权并记录')
  })

  it('自动生成的 sourceRef 不得成为准入依据', () => {
    // **这条防的是一个真实漏收**：模糊内容被当成"可由具体工件复现"收进库。
    //
    // 原判据把 `正文 + sourceRef` 一起匹配，而 sourceRef 省略时由工具自动生成成
    // `session:<uuid>#turn-N`——UUID 的一段（8 位十六进制）命中了"提交哈希"。
    // 于是「今天感觉还不错，学到了很多东西。」以 `reproducible-artifact` 入账。
    //
    // 教训：`sourceRef` 是**溯源**（这条从哪来），不是**可复现工件**（凭什么可验证）。
    // 拿它当依据，等于让工具用自己生成的字符串给自己发合格证。
    const decision = decideAdmission({
      ...base,
      text: '今天感觉还不错，学到了很多东西。',
      sourceRef: 'session:session-90730570-1717-4474-92ad-8086507e77d1#turn-5',
    })
    expect(decision.ok, '自动生成的 sourceRef 不该让模糊内容通过准入').toBe(false)
  })

  it('空 / 纯标点 / 过短 / 过长 → 各自可读的弃权原因', () => {
    const empty = decideAdmission({ ...base, text: '   ' })
    expect(empty.ok === false && empty.reason).toContain('内容为空')

    const punctuation = decideAdmission({ ...base, text: '！！！。。。' })
    expect(punctuation.ok === false && punctuation.reason).toContain('不含任何文字或数字')

    const short = decideAdmission({ ...base, text: '好的' })
    expect(short.ok === false && short.reason).toContain('内容过短')

    const long = decideAdmission({ ...base, text: '细'.repeat(MAX_TEXT_CHARS + 1) })
    expect(long.ok === false && long.reason).toContain('内容过长')
  })

  it('缺少来源引用 → 弃权（source_ref 非空是投毒防御的必要条件）', () => {
    const decision = decideAdmission({ ...base, sourceRef: '', text: '一条有内容的陈述。' })
    expect(decision.ok === false && decision.reason).toContain('缺少来源引用')
  })

  it('保留来源前缀 omb-doc: 被拒（单文档状态不经这个工具写入）', () => {
    const decision = decideAdmission({ ...base, sourceRef: 'omb-doc:omb-profile', text: '一条有内容的陈述。' })
    expect(decision.ok === false && decision.reason).toContain('保留给')
  })
})

describe('内容哈希（离线精确去重的原语）', () => {
  it('同文本同哈希、不同文本不同哈希，且为 64 位十六进制', () => {
    const a = contentHashOf('长期记忆系统的设计要点')
    expect(a).toBe(contentHashOf('长期记忆系统的设计要点'))
    expect(a).not.toBe(contentHashOf('长期记忆系统的设计要点。'))
    expect(a).toMatch(/^[0-9a-f]{16}$/)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// ② 工具执行体（真实 SQLite）
// ────────────────────────────────────────────────────────────────────────────

interface WriteFixture {
  readonly tool: ToolDefinition
  readonly user: SqliteMemoryStore
  readonly project: SqliteMemoryStore
  readonly written: { id: string; scope: string; kind: string }[]
  readonly abstained: { reason: string; text: string }[]
  close(): Promise<void>
}

function writeFixture(overrides: Partial<MemoryWriteDeps> = {}): WriteFixture {
  const ws: TempWorkspace = tempWorkspace()
  const logger = capturingLogger()
  const clock: TestClock = fixedClock()
  const port = testPort(ws.dir)
  const user = openMemoryStore({ scope: 'user', dbPath: port.userDbPath, port, logger, clock })
  const project = openMemoryStore({
    scope: 'project',
    dbPath: join(ws.dir, 'proj', '.omb', 'memory', 'session.db'),
    port,
    logger,
    clock,
  })
  const written: { id: string; scope: string; kind: string }[] = []
  const abstained: { reason: string; text: string }[] = []

  const deps: MemoryWriteDeps = {
    resolveStore: async (scope): Promise<MemoryStore | undefined> => (scope === 'user' ? user : project),
    clock,
    currentSession: () => 's1',
    currentTurn: () => 7,
    currentProject: () => '/work/demo',
    onWritten: payload => void written.push(payload),
    onAbstained: info => void abstained.push(info),
    ...overrides,
  }

  return {
    tool: createRememberTool(deps),
    user,
    project,
    written,
    abstained,
    async close(): Promise<void> {
      await user.close()
      await project.close()
      ws.cleanup()
    },
  }
}

async function run(tool: ToolDefinition, args: unknown): Promise<ToolOutcome> {
  return await tool.execute(args)
}

/** 取某库里唯一一条记录（避免测试里写死 id 生成规则）。 */
async function onlyRecord(store: SqliteMemoryStore, query: string) {
  const hits = await store.searchLexical({ text: query, scope: store.scope, limit: 5 })
  expect(hits).toHaveLength(1)
  return await store.get(hits[0]?.id ?? '')
}

describe('omb_remember：写入与路由', () => {
  it('schema 与校验同源（jsonSchema 与 parse 出自同一个 zod schema）', () => {
    expect(REMEMBER_TOOL).toBe('omb_remember')
    expect(REMEMBER_JSON_SCHEMA).toMatchObject({ type: 'object', required: ['text', 'kind'] })
    expect(JSON.stringify(REMEMBER_JSON_SCHEMA)).toContain('"episodic"')
  })

  it('写入成功：回执含 id 与落库，记录字段逐字保真（默认来源=会话+回合）', async () => {
    const fixture = writeFixture()
    const outcome = await run(fixture.tool, {
      text: '提交前先跑 pnpm verify',
      kind: 'procedural',
      userAsserted: true,
    })

    expect(outcome.kind).toBe('text')
    expect(outcome.text).toContain('已记住')
    expect(outcome.text).toContain('项目库')
    expect(outcome.text).toContain('kind=procedural')

    const record = await onlyRecord(fixture.project, 'pnpm verify')
    expect(record).toMatchObject({
      text: '提交前先跑 pnpm verify',
      kind: 'procedural',
      scope: 'project',
      sourceRef: 'session:s1#turn-7',
      assertedBy: 'user',
      validTo: null,
      supersededBy: null,
      useCount: 0,
      project: '/work/demo',
    })
    expect(record?.contentHash).toBe(contentHashOf('提交前先跑 pnpm verify'))
    expect(fixture.written).toHaveLength(1)
    await fixture.close()
  })

  it('按 SCOPE_BY_KIND 路由：semantic → 用户库；episodic/procedural → 项目库', async () => {
    const fixture = writeFixture()
    await run(fixture.tool, { text: '用户偏好：回答要简洁', kind: 'semantic', userAsserted: true })
    await run(fixture.tool, { text: '今天定位了一个端口冲突', kind: 'episodic', userAsserted: true })
    await run(fixture.tool, { text: '排查端口冲突先看 netstat', kind: 'procedural', userAsserted: true })

    expect((await fixture.user.stats()).rows).toBe(1)
    expect((await fixture.project.stats()).rows).toBe(2)
    expect(await fixture.user.searchLexical({ text: '端口冲突', scope: 'user', limit: 5 })).toHaveLength(0)
    expect(await fixture.project.searchLexical({ text: '简洁', scope: 'project', limit: 5 })).toHaveLength(0)
    await fixture.close()
  })

  it('显式 scope 覆盖 kind 的默认路由', async () => {
    const fixture = writeFixture()
    const outcome = await run(fixture.tool, {
      text: '这条语义结论留在项目里',
      kind: 'semantic',
      scope: 'project',
      userAsserted: true,
    })
    expect(outcome.text).toContain('项目库')
    expect((await fixture.project.stats()).rows).toBe(1)
    expect((await fixture.user.stats()).rows).toBe(0)
    await fixture.close()
  })

  it('写入即可检索：FTS 命中且逐字返回（在线路径只插入，不摘要）', async () => {
    const fixture = writeFixture()
    const text = '长期记忆系统的词法通道用 FTS5'
    await run(fixture.tool, { text, kind: 'semantic', userAsserted: true })
    const record = await onlyRecord(fixture.user, '记忆')
    expect(record?.text).toBe(text)
    expect(record?.sourceRef).toBe('session:s1#turn-7')
    await fixture.close()
  })
})

describe('omb_remember：弃权、事件与降级', () => {
  it('准入拒绝：不写入 + 可读原因 + 记入弃权账本', async () => {
    const fixture = writeFixture()
    const outcome = await run(fixture.tool, { text: '用户大概是个喜欢安静的人吧。', kind: 'semantic' })

    expect(outcome.kind).toBe('text')
    expect(outcome.text).toContain('未写入（准入弃权）')
    expect(outcome.text).toContain('没有准入依据')
    expect((await fixture.user.stats()).rows).toBe(0)
    expect((await fixture.project.stats()).rows).toBe(0)
    expect(fixture.abstained).toHaveLength(1)
    expect(fixture.abstained[0]?.reason).toContain('没有准入依据')
    expect(fixture.written).toHaveLength(0) // 弃权不触发编码
    await fixture.close()
  })

  it('memory/written 只在 put 成功后触发，载荷为 {id, scope, kind}', async () => {
    const fixture = writeFixture()
    const outcome = await run(fixture.tool, { text: '提交前先跑 pnpm verify', kind: 'procedural' })
    expect(outcome.kind).toBe('text')
    expect(fixture.written).toHaveLength(1)
    expect(fixture.written[0]).toMatchObject({ scope: 'project', kind: 'procedural' })
    expect(fixture.written[0]?.id).toMatch(/^mem_/)
    await fixture.close()
  })

  it('onWritten 的订阅者抛异常不影响写入结果（事件通道失败 ≠ 写入失败）', async () => {
    const fixture = writeFixture({
      onWritten: () => {
        throw new Error('订阅者爆炸')
      },
    })
    const outcome = await run(fixture.tool, { text: '提交前先跑 pnpm verify', kind: 'procedural' })
    expect(outcome.kind).toBe('text')
    expect(outcome.text).toContain('已记住')
    expect((await fixture.project.stats()).rows).toBe(1)
    await fixture.close()
  })

  it('库未就绪 → kind:error 且带上降级原因（不抛）', async () => {
    const fixture = writeFixture({
      resolveStore: async () => undefined,
      degradeReason: () => '项目库打开失败：磁盘只读',
    })
    const outcome = await run(fixture.tool, { text: '提交前先跑 pnpm verify', kind: 'semantic' })
    expect(outcome.kind).toBe('error')
    expect(outcome.text).toContain('用户库尚未就绪')
    expect(outcome.text).toContain('磁盘只读')
    await fixture.close()
  })

  it('底层 put 抛异常 → kind:error（执行体绝不抛）', async () => {
    const fixture = writeFixture({
      resolveStore: async () =>
        ({
          put: async () => {
            throw new Error('SQLITE_FULL')
          },
        }) as unknown as MemoryStore,
    })
    const outcome = await run(fixture.tool, { text: '提交前先跑 pnpm verify', kind: 'semantic' })
    expect(outcome.kind).toBe('error')
    expect(outcome.text).toContain('SQLITE_FULL')
    expect(fixture.written).toHaveLength(0)
    await fixture.close()
  })

  it('参数非法 → kind:error（绝不抛）', async () => {
    const fixture = writeFixture()
    expect((await run(fixture.tool, { kind: 'semantic' })).kind).toBe('error')
    expect((await run(fixture.tool, { text: '有内容的一句话', kind: 'bogus' })).kind).toBe('error')
    expect((await run(fixture.tool, null)).kind).toBe('error')
    expect((await fixture.user.stats()).rows).toBe(0)
    await fixture.close()
  })

  it('无会话上下文且未给 sourceRef：弃权并说明缺少来源，不写一条无来源的记忆', async () => {
    const fixture = writeFixture({ currentSession: () => undefined, currentTurn: () => undefined })
    const outcome = await run(fixture.tool, { text: '提交前先跑 pnpm verify', kind: 'semantic' })
    expect(outcome.kind).toBe('text')
    expect(outcome.text).toContain('未写入（准入弃权）')
    expect(outcome.text).toContain('缺少来源引用')
    expect((await fixture.user.stats()).rows).toBe(0)
    expect(fixture.abstained).toHaveLength(1)
    await fixture.close()
  })

  it('显式 sourceRef 覆盖默认来源（无会话上下文也能写）', async () => {
    const fixture = writeFixture({ currentSession: () => undefined, currentTurn: () => undefined })
    const outcome = await run(fixture.tool, {
      text: '提交前先跑 pnpm verify',
      kind: 'semantic',
      sourceRef: 'file:docs/contributing.md#L12',
    })
    expect(outcome.kind).toBe('text')
    const record = await onlyRecord(fixture.user, 'pnpm verify')
    expect(record?.sourceRef).toBe('file:docs/contributing.md#L12')
    await fixture.close()
  })

  it('没有向量模块（无 embedder/channel）时写入与词法召回都不受影响（§5.7）', async () => {
    const fixture = writeFixture() // 依赖里根本没有 embedder
    await run(fixture.tool, { text: '纯词法路径必须完整可用', kind: 'semantic', userAsserted: true })
    expect(await fixture.user.searchLexical({ text: '词法', scope: 'user', limit: 5 })).toHaveLength(1)
    await fixture.close()
  })
})
