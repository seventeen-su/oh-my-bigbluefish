import { describe, expect, it } from 'vitest'
import {
  DefaultCommandBus,
  actorKindOf,
  duplicateCommandFailure,
  mergePatchAttributes,
  preparePatchWrite,
  systemCommandMeta,
  type CommandMeta,
  type CommandOutcome,
  type CommandWriter,
  type PreparedCommand,
} from '../../../packages/v7/src/app/commands/index.js'
import type { Attribute, Entity, WriteEntityInput } from '../../../packages/v7/src/domain/entity.js'
import { OmbFailure, conflict } from '../../../packages/v7/src/domain/errors.js'
import type { Store } from '../../../packages/v7/src/ports/store.js'

const ID = 'mem_018f2a00-0000-7000-8000-000000000001'
const LINK_ID = 'lnk_018f2a00-0000-7000-8000-000000000002'

function meta(overrides: Partial<CommandMeta> = {}): CommandMeta {
  return {
    commandId: 'cmd-1',
    actor: { id: 'tester', kind: 'system' },
    origin: 'test',
    correlationId: 'corr-1',
    ...overrides,
  }
}

function staticAttribute(name: string, ordinal: number, value: Attribute['value'], required = true): Attribute {
  return { name, ordinal, value, required, source: 'model' }
}

function entity(kind: Entity['kind'], attributes: Attribute[], overrides: Partial<Entity> = {}): Entity {
  return {
    id: ID,
    kind,
    revision: 3,
    origin: 'job:extract',
    confidence: 0.4,
    pinned: true,
    salience: 0.5,
    accessCount: 0,
    adoptionCount: 0,
    isCurrent: true,
    createdAt: '2026-11-27T00:00:00.000Z',
    updatedAt: '2026-11-27T00:00:00.000Z',
    attributes,
    ...overrides,
  }
}

function memoryAttributes(title: string, body: string): Attribute[] {
  return [
    staticAttribute('id', 0, { kind: 'static', value: ID }),
    staticAttribute('category', 1, { kind: 'static', value: 'fact' }),
    staticAttribute('scope', 2, { kind: 'static', value: { kind: 'global' } }),
    { ...staticAttribute('title', 3, { kind: 'static', value: title }), required: false },
    { ...staticAttribute('body', 4, { kind: 'static', value: body }), required: false },
  ]
}

class FakeWriter implements CommandWriter {
  readonly commands: PreparedCommand[] = []
  readonly outcomes: CommandOutcome[] = []
  executeError: unknown
  replay: CommandOutcome | undefined
  resultCalls: string[] = []

  async execute(command: PreparedCommand, _meta: CommandMeta): Promise<CommandOutcome> {
    this.commands.push(command)
    if (this.executeError !== undefined) throw this.executeError
    return this.outcomes.shift() ?? {
      events: [],
      revision: 1,
      projectionToken: { entityId: ID, revision: 1, watermark: '10' },
    }
  }

  async result(commandId: string): Promise<CommandOutcome | undefined> {
    this.resultCalls.push(commandId)
    return this.replay
  }
}

function busWith(writer: FakeWriter, current?: Entity): DefaultCommandBus {
  const store = {
    get: async () => current,
  } as unknown as Pick<Store, 'get'>
  return new DefaultCommandBus({ store, writer })
}

function event(type: 'EntityCreated' | 'EntityPatched', entityId = ID): CommandOutcome['events'][number] {
  return {
    id: '42',
    seq: 42,
    streamId: entityId,
    streamVersion: 2,
    type,
    actor: { id: 'tester', kind: 'system' },
    origin: 'test',
    occurredAt: '2026-11-27T00:00:00.000Z',
    payload: { entityId, revision: 2 },
  }
}

describe('preparePatchWrite 合并规则', () => {
  it('给定记忆当补丁新增/删除可选属性则保留必填与实体级字段', () => {
    const current = entity('memory', memoryAttributes('旧标题', '旧正文'))
    const input = preparePatchWrite(current, { id: ID, attrs: { body: '新正文', extra: 1 }, origin: 'model' })
    expect(input.kind).toBe('memory')
    expect(input).toMatchObject({ kind: 'memory', category: 'fact' })
    expect(input.origin).toBe('model')
    expect(input.scope).toEqual({ kind: 'global' })
    expect(input.attrs).toEqual({ title: '旧标题', body: '新正文', extra: 1 })
    expect(input.pinned).toBe(true)
    expect(input.confidence).toBe(0.4)
  })

  it('给定记忆当补丁把属性置 null 则删除该可选属性', () => {
    const current = entity('memory', memoryAttributes('标题', '正文'))
    const input = preparePatchWrite(current, { id: ID, attrs: { title: null } })
    expect(input.attrs).toEqual({ body: '正文' })
  })

  it('给定状态机当补丁只改 status 则 title/time/scope 保留', () => {
    const current = entity('state', [
      staticAttribute('id', 0, { kind: 'static', value: ID }),
      staticAttribute('scope', 1, { kind: 'static', value: { kind: 'project', projectKey: 'proj' } }),
      staticAttribute('title', 2, { kind: 'static', value: '状态标题' }),
      staticAttribute('status', 3, { kind: 'static', value: 'in_progress' }),
      staticAttribute('time', 4, { kind: 'static', value: '2026-11-27T00:00:00.000Z' }),
    ], { kind: 'state' })
    const input = preparePatchWrite(current, { id: ID, status: 'blocked' })
    expect(input).toMatchObject({
      kind: 'state',
      title: '状态标题',
      status: 'blocked',
      time: '2026-11-27T00:00:00.000Z',
      scope: { kind: 'project', projectKey: 'proj' },
    })
  })

  it('给定思维链当补丁不带 group 则沿用原成员组', () => {
    const current = entity('chain', [
      staticAttribute('id', 0, { kind: 'static', value: ID }),
      staticAttribute('scope', 1, { kind: 'static', value: { kind: 'global' } }),
      staticAttribute('title', 2, { kind: 'static', value: '链标题' }),
      staticAttribute('group', 3, { kind: 'static', value: [ID] }),
    ], { kind: 'chain' })
    const input = preparePatchWrite(current, { id: ID, title: '新链标题' })
    expect(input).toMatchObject({ kind: 'chain', title: '新链标题', group: [ID] })
  })

  it('给定历史版本当补丁则拒绝（历史不可直接更新）', () => {
    const current = entity('state_version', memoryAttributes('历史', '旧'))
    expect(() => preparePatchWrite(current, { id: ID, attrs: { body: 'x' } })).toThrow(OmbFailure)
  })

  it('给定补丁属性当合并则 null 表示删除而不是写 null 值', () => {
    const current = entity('memory', memoryAttributes('标题', '正文'))
    const merged = mergePatchAttributes(current.attributes, { id: ID, attrs: { body: null, note: '备注' } })
    expect(merged).toEqual({ title: '标题', note: '备注' })
  })
})

describe('CommandBus 命令校验与结果映射', () => {
  it('给定空 commandId 当执行命令则返回 invalid-input 且不触碰 writer', async () => {
    const writer = new FakeWriter()
    const bus = busWith(writer)
    const result = await bus.execute({ type: 'CreateEntity', input: memoryInput() }, meta({ commandId: ' ' }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('invalid-input')
    expect(writer.commands).toHaveLength(0)
  })

  it('给定非法 actor.kind 当执行命令则返回 invalid-input', async () => {
    const writer = new FakeWriter()
    const result = await busWith(writer).execute(
      { type: 'CreateEntity', input: memoryInput() },
      meta({ actor: { id: 'x', kind: 'robot' as never } }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('invalid-input')
  })

  it('给定补丁没有 expectedRevision 当执行 PatchEntity 则返回 invalid-input', async () => {
    const writer = new FakeWriter()
    const current = entity('memory', memoryAttributes('标题', '正文'))
    const result = await busWith(writer, current).execute(
      { type: 'PatchEntity', input: { id: ID, attrs: { body: '新' } } },
      meta(),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toContain('expectedRevision')
    expect(writer.commands).toHaveLength(0)
  })

  it('给定命令 meta.expectedRevision 当执行 PatchEntity 则写入补丁并归一化', async () => {
    const writer = new FakeWriter()
    const current = entity('memory', memoryAttributes('标题', '正文'))
    const outcome: CommandOutcome = {
      events: [event('EntityPatched')],
      revision: 4,
      projectionToken: { entityId: ID, revision: 4, watermark: '77' },
    }
    writer.outcomes.push(outcome)
    const result = await busWith(writer, current).execute(
      { type: 'PatchEntity', input: { id: ID, attrs: { body: '新' } } },
      meta({ expectedRevision: 3 }),
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.revision).toBe(4)
      expect(result.value.events[0]?.type).toBe('EntityPatched')
      expect(result.value.projectionToken.watermark).toBe('77')
    }
    expect(writer.commands).toHaveLength(1)
    const command = writer.commands[0]
    expect(command?.type).toBe('PatchEntity')
    if (command?.type === 'PatchEntity') {
      expect(command.patch.expectedRevision).toBe(3)
      expect(command.input.attributes.find(item => item.name === 'body')?.value).toEqual({ kind: 'static', value: '新' })
    }
  })

  it('给定 writer 返回 currentRevision 当执行命令则冲突带顶层 currentRevision', async () => {
    const writer = new FakeWriter()
    writer.executeError = new OmbFailure(conflict('实体版本已变化', { currentRevision: 7 }))
    const current = entity('memory', memoryAttributes('标题', '正文'))
    const result = await busWith(writer, current).execute(
      { type: 'PatchEntity', input: { id: ID, attrs: { body: '新' }, expectedRevision: 6 } },
      meta(),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('conflict')
      expect(result.error.currentRevision).toBe(7)
    }
  })

  it('给定重复 commandId 当 writer 抛重复信号则返回首次结果且只执行一次', async () => {
    const writer = new FakeWriter()
    writer.executeError = new OmbFailure(duplicateCommandFailure('cmd-1'))
    writer.replay = {
      events: [event('EntityCreated')],
      revision: 1,
      projectionToken: { entityId: ID, revision: 1, watermark: '42' },
    }
    const result = await busWith(writer).execute({ type: 'CreateEntity', input: memoryInput() }, meta())
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.events[0]?.id).toBe('42')
      expect(result.value.revision).toBe(1)
      expect(result.value.projectionToken).toEqual({ entityId: ID, revision: 1, watermark: '42' })
    }
    expect(writer.resultCalls).toEqual(['cmd-1'])
    expect(writer.commands).toHaveLength(1)
  })

  it('给定必填属性改名当执行 RenameAttribute 则拒绝且不写', async () => {
    const writer = new FakeWriter()
    const result = await busWith(writer).execute(
      { type: 'RenameAttribute', from: 'id', to: 'uid', reason: 'test' },
      meta(),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('invalid-input')
    expect(writer.commands).toHaveLength(0)
  })

  it('给定合法改名当执行则归一化空白并交给 writer', async () => {
    const writer = new FakeWriter()
    const result = await busWith(writer).execute(
      { type: 'RenameAttribute', from: ' 旧名 ', to: ' 新名 ', reason: 'test' },
      meta(),
    )
    expect(result.ok).toBe(true)
    expect(writer.commands[0]).toEqual({ type: 'RenameAttribute', from: '旧名', to: '新名', reason: 'test' })
  })

  it('给定 CreateEntity 当执行则归一化 id/必填属性后再写', async () => {
    const writer = new FakeWriter()
    const result = await busWith(writer).execute({ type: 'CreateEntity', input: memoryInput() }, meta())
    expect(result.ok).toBe(true)
    const command = writer.commands[0]
    expect(command?.type).toBe('CreateEntity')
    if (command?.type === 'CreateEntity') {
      expect(command.input.id).toMatch(/^mem_/)
      expect(command.input.attributes.map(item => item.name)).toEqual(
        expect.arrayContaining(['id', 'category', 'scope', 'title', 'body']),
      )
    }
  })

  it('给定非法 CreateEntity 当执行则返回 validation 错误且不写', async () => {
    const writer = new FakeWriter()
    const result = await busWith(writer).execute(
      { type: 'CreateEntity', input: { kind: 'memory', category: 'fact', scope: { kind: 'global' }, attrs: {} } },
      meta(),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('invalid-input')
    expect(writer.commands).toHaveLength(0)
  })
})

describe('命令元数据', () => {
  it('给定 actor 字符串当推导 kind 则 job/user/system/model 可区分', () => {
    expect(actorKindOf('job:extract')).toBe('job')
    expect(actorKindOf('user')).toBe('user')
    expect(actorKindOf('system:boot')).toBe('system')
    expect(actorKindOf('external:webhook')).toBe('external')
    expect(actorKindOf('model')).toBe('model')
  })

  it('给定旧写入路径当合成 meta 则每次都有独立 commandId 与 correlationId', () => {
    const first = systemCommandMeta('job:extract')
    const second = systemCommandMeta('job:extract')
    expect(first.commandId).not.toBe(second.commandId)
    expect(first.correlationId).not.toBe(second.correlationId)
    expect(first.actor).toEqual({ id: 'job:extract', kind: 'job' })
    expect(first.origin).toBe('job:extract')
    expect(LINK_ID).toBeTruthy()
  })
})

function memoryInput(): WriteEntityInput {
  return {
    kind: 'memory',
    category: 'fact',
    scope: { kind: 'global' },
    attrs: { title: '标题', body: '正文' },
  }
}
