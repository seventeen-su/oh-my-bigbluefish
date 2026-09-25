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
  RECEIPT_ECHO_CHARS,
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
  const base = {
    sourceRef: 'session:s1#turn-3',
    claimedUserAssertion: false,
    // 准入判据对**可核验**的工件（文件/路径/行号）现在真的去核验存在。
    // 纯函数测试里用一个"一切皆存在"的核验器代表"文件确实在"；
    // 「核验失败」与「不给核验器（fail closed）」两条分支各自有独立用例。
    verifyArtifact: () => true,
  } as const

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
      { text: '改动在 src/memory/remember.ts:137 那一行', label: '行号' },
      { text: '改动在 remember.ts#L137', label: '行号' },
      { text: '见 line 137 的判据', label: '行号' },
    ]
    for (const item of cases) {
      const decision = decideAdmission({ ...base, text: item.text })
      expect(decision, item.text).toMatchObject({ ok: true, ground: 'reproducible-artifact', assertedBy: 'model' })
      expect(decision.ok && decision.reason).toContain(item.label)
    }
  })

  it('行号判据不认时间戳与比例（曾把日期里的 35:54 当成行号）', () => {
    // **这条来自一次真实自检报告**：写入
    // `OMB v3 自检标记：本次自检时间为 2026-09-26T05:35:54+08:00，执行者为本会话。`
    // 被记成「准入依据=reproducible-artifact（命中行号）」——而正文里没有任何行号。
    //
    // 根因是旧判据 `\b\d+:\d+\b`：它命中 `35:54`（时间）、`14:30`、`16:9`（比例），
    // 却**漏掉**真正的 `src/index.ts:120`（`:` 前是字母，`\b` 不成立）——两头都错。
    // 后果不只是漏收/错收：**判据给出的理由与内容不符，于是它的 verdict 不能当证据用**。
    const cases: readonly string[] = [
      'OMB v3 自检标记：本次自检时间为 2026-09-26T05:35:54+08:00，执行者为本会话。',
      '会议定在 14:30 开始，别迟到。',
      '屏幕比例是 16:9，录屏按这个来。',
    ]
    for (const text of cases) {
      const decision = decideAdmission({ ...base, text })
      // 要么被拒，要么即使通过也**不得**以"行号"为理由
      if (decision.ok) {
        expect(decision.reason, `不该以行号为由收下：${text}`).not.toContain('行号')
      } else {
        expect(decision.reason).toContain('没有准入依据')
      }
    }
  })

  it('编造的工件名不能当准入依据（核验不过 = 不是依据）', () => {
    // **这条来自一次真实自检报告**：负对照条引用一个不存在的文件名
    // `does-not-exist-9f3a.json`，**依然通过并落库**——因为旧判据只做形态匹配。
    // 字段叫 `reproducible-artifact`（可复现），行为却只是"长得像文件名"。
    //
    // 那时的后果很直接：**编造的工件与真实工件得到同一个准入结论**，
    // 于是这道闸门只是一种措辞。
    const decision = decideAdmission({
      ...base,
      text: '这个结论记在 does-not-exist-9f3a.json 里。',
      verifyArtifact: () => false, // 核验器说：这个文件不存在
    })
    expect(decision.ok, '核验不过的工件不能构成依据').toBe(false)
    expect(decision.ok === false && decision.reason).toContain('没有准入依据')
  })

  it('不给核验器时文件类工件不算依据（fail closed）', () => {
    // 契约选择"保守"而不是"乐观"：核验不了就不算依据。
    // 理由是不对称——**漏收**只是让用户补一个可核验的引用；
    // **错收**是假事实进库，并被后续会话当成有效结论召回。
    const decision = decideAdmission({
      sourceRef: 'session:s1#turn-3',
      claimedUserAssertion: false,
      text: '端口配置在 src/config/server.ts 里',
    })
    expect(decision.ok, '没有核验器就不该拿文件形态当依据').toBe(false)
  })

  it('核验器说"核验不了"（undefined）同样不算依据', () => {
    const decision = decideAdmission({
      ...base,
      text: '端口配置在 src/config/server.ts 里',
      verifyArtifact: () => undefined,
    })
    expect(decision.ok).toBe(false)
  })

  it('不可核验的类别（URL/命令/版本号/哈希）仍然只按形态算依据', () => {
    // 它们不是"存在性"声明，无法也无需核验文件系统；判据对它们保持原样。
    const cases: readonly { readonly text: string; readonly label: string }[] = [
      { text: '接口文档在 https://example.com/api 上', label: 'URL' },
      { text: '提交前跑 pnpm verify 全绿才算完成', label: '可复现命令' },
      { text: 'Node 版本固定为 24.12.0', label: '版本号' },
    ]
    for (const item of cases) {
      const decision = decideAdmission({ ...base, text: item.text, verifyArtifact: () => false })
      expect(decision, item.text).toMatchObject({ ok: true, ground: 'reproducible-artifact' })
      expect(decision.ok && decision.reason).toContain(item.label)
    }
  })

  it('显式 sourceRef 指向真实工件时，来源本身构成依据', () => {
    // **补的是一个真实操作摩擦**：用户按工具描述给出
    // `sourceRef=D:\...\build-generation.json`，正文里没有任何工件形态，于是被拒
    // ——而那个文件**确实存在**，溯源是成立的。
    //
    // 与"正文里有工件"的分工：这条看**来源**（陈述从哪来），那条看**正文**
    // （陈述自己说了什么）。两者都要求真实存在，所以编造的字符串都骗不过。
    const decision = decideAdmission({
      ...base,
      sourceRefExplicit: true,
      sourceRef: 'D:\\Program\\Oh-My-BigBlueFish\\build-generation.json',
      text: 'OMB v3 自检标记：执行者为本会话。',
      verifyArtifact: () => true,
    })
    expect(decision).toMatchObject({ ok: true, ground: 'reproducible-artifact' })
    expect(decision.ok && decision.reason).toContain('来源')
  })

  it('自动生成的 sourceRef 不算依据（只认调用方显式给的）', () => {
    // 工具自动生成的是 `session:<uuid>#turn-N`——那是内部标识符，不是工件。
    // 把它算进来就是让工具给自己发合格证；那个假阳性修过一次，不能重新打开。
    const decision = decideAdmission({
      ...base,
      text: '今天感觉还不错，学到了很多东西。',
      sourceRef: 'session:session-90730570-1717-4474-92ad-8086507e77d1#turn-5',
      // 没给 sourceRefExplicit ⇒ 不认来源；正文里也没有工件 ⇒ 必须弃权
      verifyArtifact: () => true,
    })
    expect(decision.ok, '自动生成的来源不该让模糊内容通过').toBe(false)
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

function writeFixture(
  overrides: Partial<MemoryWriteDeps> = {},
  wrapStore: (store: SqliteMemoryStore) => MemoryStore = store => store,
): WriteFixture {
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
    resolveStore: async (scope): Promise<MemoryStore | undefined> =>
      scope === 'user' ? wrapStore(user) : wrapStore(project),
    clock,
    currentSession: () => 's1',
    currentTurn: () => 7,
    currentProject: () => '/work/demo',
    // 工具级用例默认"工件都存在"。核验失败与 fail-closed 两条分支
    // 由专门的准入用例覆盖（它们直接调 `decideAdmission`）。
    verifyArtifact: () => true,
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

// ────────────────────────────────────────────────────────────────────────────
// 回显：写入当下就能自证"我存了什么"（原先只能靠事后 omb_recall 反证）
// ────────────────────────────────────────────────────────────────────────────

describe('omb_remember：写入回执回显逐字原文', () => {
  it('成功回执含存下的逐字原文与原文哈希（与库中 content_hash 一致即为逐字保真）', async () => {
    const fixture = writeFixture()
    const text = '提交前先跑 pnpm verify。'
    const outcome = await run(fixture.tool, { text, kind: 'procedural' })

    expect(outcome.kind).toBe('text')
    expect(outcome.text).toContain('已记住')
    expect(outcome.text).toContain(`存下的逐字原文（${text.length} 字符，全文如下）：`)
    expect(outcome.text).toContain(text)

    const record = await onlyRecord(fixture.project, 'pnpm verify')
    expect(outcome.text).toContain(`原文哈希=${record?.contentHash}`)
    expect(outcome.text).not.toContain('已截断')
    await fixture.close()
  })

  it('超长原文：回执截断到上限并**注明截断**与完整长度（不把截断伪装成全文）', async () => {
    const fixture = writeFixture()
    const tail = '（结尾标记TAIL）'
    const text = `实测结论（见 docs/notes.md#L1）：${'细'.repeat(RECEIPT_ECHO_CHARS + 50)}${tail}`
    expect(text.length).toBeGreaterThan(RECEIPT_ECHO_CHARS)
    expect(text.length).toBeLessThanOrEqual(MAX_TEXT_CHARS)

    const outcome = await run(fixture.tool, { text, kind: 'semantic' })
    expect(outcome.kind).toBe('text')
    expect(outcome.text).toContain(`回执只显示前 ${RECEIPT_ECHO_CHARS} 字符——已截断`)
    expect(outcome.text).toContain('（截断处）')
    expect(outcome.text).toContain(`完整长度是 ${text.length} 字符`)
    expect(outcome.text).toContain(text.slice(0, RECEIPT_ECHO_CHARS))
    expect(outcome.text).not.toContain(tail) // 截断就是截断

    // 库里存的仍是完整原文（回执截断 ≠ 存储截断）
    const record = await onlyRecord(fixture.user, '实测结论')
    expect(record?.text).toBe(text)
    await fixture.close()
  })

  it('弃权回执不回显"存下的原文"（没写入就不该说存了什么）', async () => {
    const fixture = writeFixture()
    const outcome = await run(fixture.tool, { text: '用户大概是个喜欢安静的人吧。', kind: 'semantic' })
    expect(outcome.text).toContain('未写入（准入弃权）')
    expect(outcome.text).not.toContain('存下的逐字原文')
    await fixture.close()
  })
})

// ────────────────────────────────────────────────────────────────────────────
// 推翻标注（supersedes）：过时结论必须能被标掉，且标注结果如实回执
// ────────────────────────────────────────────────────────────────────────────

/** 边只读的库：用来验证"标注失败必须如实说"，而不是静默成功。 */
function readOnlyEdgeStore(inner: SqliteMemoryStore): MemoryStore {
  return new Proxy(inner, {
    get(target, property, receiver): unknown {
      if (property === 'upsertEdge') {
        return async (): Promise<void> => {
          throw new Error('edge 表只读')
        }
      }
      const value = Reflect.get(target, property, receiver) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as MemoryStore
}

async function edgesOf(store: SqliteMemoryStore, fromId: string): Promise<readonly string[]> {
  const walk = await store.walkGraph({ fromId, depth: 1, types: ['supersedes'] })
  return walk.edges.map(edge => `${edge.fromId}->${edge.toId}:${edge.type}`)
}

describe('omb_remember：supersedes 推翻标注（非破坏性）', () => {
  it('标注成功：旧条目 validTo+supersededBy 已写、边方向 newer→older、正文一字未改', async () => {
    const fixture = writeFixture()
    const oldText = '旧的端口结论是 8080。'
    await run(fixture.tool, { text: oldText, kind: 'semantic', userAsserted: true })
    const old = await onlyRecord(fixture.user, '8080')
    expect(old?.validTo).toBeNull()

    const outcome = await run(fixture.tool, {
      text: '更正（见 src/config/server.ts）：端口实测不是 8080，而是 9090。',
      kind: 'semantic',
      supersedes: [old?.id ?? ''],
    })

    expect(outcome.kind).toBe('text')
    expect(outcome.text).toContain('推翻标注：1 条旧记忆已标为"被本条取代"')
    expect(outcome.text).toContain(old?.id ?? 'x')

    const marked = await fixture.user.get(old?.id ?? '')
    const fresh = await onlyRecord(fixture.user, '9090')
    expect(marked?.supersededBy).toBe(fresh?.id)
    expect(marked?.validTo).toBe(fresh?.observedAt)
    expect(marked?.text).toBe(oldText) // 非破坏性：正文与溯源都没动
    expect(marked?.sourceRef).toBe(old?.sourceRef)
    expect(await edgesOf(fixture.user, old?.id ?? '')).toEqual([`${fresh?.id}->${old?.id}:supersedes`])
    await fixture.close()
  })

  it('目标不存在：新条目照写，回执如实写"未找到"，绝不抛', async () => {
    const fixture = writeFixture()
    const outcome = await run(fixture.tool, {
      text: '更正（见 src/config/server.ts）：端口实测是 9090。',
      kind: 'semantic',
      supersedes: ['mem_不存在_1'],
    })
    expect(outcome.kind).toBe('text')
    expect(outcome.text).toContain('推翻标注：未找到 1 条：mem_不存在_1')
    expect((await fixture.user.stats()).rows).toBe(1) // 新条目仍然写进去了
    await fixture.close()
  })

  it('目标已在取代链里：保留原标注（不改写历史），只补边并说明', async () => {
    const fixture = writeFixture()
    await run(fixture.tool, { text: '第一版结论：端口是 8080。', kind: 'semantic', userAsserted: true })
    const first = await onlyRecord(fixture.user, '8080')
    await run(fixture.tool, {
      text: '更正一（见 src/a.ts）：端口不是 8080。CORRECTION-ONE',
      kind: 'semantic',
      supersedes: [first?.id ?? ''],
    })
    const second = await onlyRecord(fixture.user, 'CORRECTION-ONE')

    const outcome = await run(fixture.tool, {
      text: '更正二（见 src/b.ts）：端口确实不是 8080，且 8080 已被占用。CORRECTION-TWO',
      kind: 'semantic',
      supersedes: [first?.id ?? ''],
    })
    expect(outcome.text).toContain('早已在取代链里')
    expect(outcome.text).toContain(`原取代者 ${second?.id}`)

    const firstRecord = await fixture.user.get(first?.id ?? '')
    expect(firstRecord?.supersededBy).toBe(second?.id) // 未被改写
    const third = await onlyRecord(fixture.user, 'CORRECTION-TWO')
    const edges = await edgesOf(fixture.user, first?.id ?? '')
    expect(edges).toContain(`${third?.id}->${first?.id}:supersedes`)
    await fixture.close()
  })

  it('建边失败：旧条目已标注但回执**明说未完成**（不把没做成说成做成了）', async () => {
    const fixture = writeFixture({}, readOnlyEdgeStore)
    await run(fixture.tool, { text: '旧的端口结论是 8080。', kind: 'semantic', userAsserted: true })
    const old = await onlyRecord(fixture.user, '8080')

    const outcome = await run(fixture.tool, {
      text: '更正（见 src/config/server.ts）：端口实测不是 8080。',
      kind: 'semantic',
      supersedes: [old?.id ?? ''],
    })
    expect(outcome.kind).toBe('text')
    expect(outcome.text).toContain('推翻标注**未完成** 1 条')
    expect(outcome.text).toContain('edge 表只读')
    expect(outcome.text).toContain('新条目已写入')
    const marked = await fixture.user.get(old?.id ?? '')
    expect(marked?.supersededBy).not.toBeNull() // 记录标注其实成功了，只有边失败
    await fixture.close()
  })

  it('跨库取代：新条目落项目库、旧结论在用户库 —— 旧条目照样被标掉，边两边都建', async () => {
    const fixture = writeFixture()
    await run(fixture.tool, { text: '用户偏好：端口固定 8080。', kind: 'semantic', userAsserted: true })
    const old = await onlyRecord(fixture.user, '8080')

    const outcome = await run(fixture.tool, {
      text: '更正（见 src/config/server.ts）：端口实测不是 8080。',
      kind: 'procedural',
      supersedes: [old?.id ?? ''],
    })
    expect(outcome.text).toContain('落库=项目库')
    expect(outcome.text).toContain('推翻标注：1 条旧记忆已标为"被本条取代"')

    const marked = await fixture.user.get(old?.id ?? '')
    const fresh = await onlyRecord(fixture.project, '更正')
    expect(marked?.supersededBy).toBe(fresh?.id)
    // 边要落在**两个库**：从旧条目所在的用户库能找到，从新条目所在的项目库也能找到
    expect(await edgesOf(fixture.user, old?.id ?? '')).toEqual([`${fresh?.id}->${old?.id}:supersedes`])
    expect(await edgesOf(fixture.project, fresh?.id ?? '')).toEqual([`${fresh?.id}->${old?.id}:supersedes`])
    await fixture.close()
  })

  it('supersedes 参数非法（空 id / 超过上限）→ kind:error，且不写入任何东西', async () => {
    const fixture = writeFixture()
    const empty = await run(fixture.tool, {
      text: '更正（见 src/a.ts）：端口不是 8080。',
      kind: 'semantic',
      supersedes: [''],
    })
    expect(empty.kind).toBe('error')

    const tooMany = await run(fixture.tool, {
      text: '更正（见 src/a.ts）：端口不是 8080。',
      kind: 'semantic',
      supersedes: Array.from({ length: 21 }, (_, index) => `mem_x_${index}`),
    })
    expect(tooMany.kind).toBe('error')
    expect((await fixture.user.stats()).rows).toBe(0)
    await fixture.close()
  })

  it('schema 与校验同源：supersedes 出现在给模型看的 JSON Schema 里', () => {
    expect(JSON.stringify(REMEMBER_JSON_SCHEMA)).toContain('"supersedes"')
  })
})
