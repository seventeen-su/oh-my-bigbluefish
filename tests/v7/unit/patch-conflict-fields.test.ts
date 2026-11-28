import { describe, expect, it } from 'vitest'
import { patchConflictFields } from '../../../packages/v7/src/app/commands/patch.js'
import type { Attribute, Entity, EntityKind, StateStatus } from '../../../packages/v7/src/domain/entity.js'
import type { JsonValue } from '../../../packages/v7/src/domain/json.js'

function attr(ordinal: number, name: string, value: JsonValue, required = false): Attribute {
  return { name, ordinal, value: { kind: 'static', value }, required, source: 'test' }
}

function entity(kind: EntityKind, attributes: readonly Attribute[], extra: Partial<Entity> = {}): Entity {
  return {
    id: kind === 'state' ? 'st_12345678-1234-4123-8123-123456789abc' : 'mem_12345678-1234-4123-8123-123456789abc',
    kind,
    revision: 2,
    origin: 'model',
    pinned: false,
    salience: 0.5,
    accessCount: 0,
    adoptionCount: 0,
    isCurrent: true,
    createdAt: '2026-11-29T00:00:00.000Z',
    updatedAt: '2026-11-29T00:00:00.000Z',
    attributes,
    ...extra,
  }
}

function state(status: StateStatus, attrs: readonly Attribute[] = [], extra: Partial<Entity> = {}): Entity {
  return entity('state', [
    attr(0, 'scope', { kind: 'global' }, true),
    attr(1, 'title', '并发标题', true),
    attr(2, 'status', status, true),
    attr(3, 'time', '2026-11-29T00:00:00.000Z', true),
    ...attrs,
  ], extra)
}

describe('patchConflictFields：冲突差异只报真正会被写的字段', () => {
  it('给定状态机补丁当值与当前不同则只报 status 与变化的可选属性', () => {
    const current = state('in_progress', [attr(4, 'note', '旧')])
    const fields = patchConflictFields(current, {
      id: current.id,
      expectedRevision: 1,
      status: 'blocked',
      attrs: { note: '新' },
    })
    expect(fields).toEqual([
      { field: 'status', incoming: 'blocked', current: 'in_progress' },
      { field: 'note', incoming: '新', current: '旧' },
    ])
  })

  it('给定补丁值与当前一致当计算则没有冲突字段', () => {
    const current = state('in_progress', [attr(4, 'note', '同')])
    expect(patchConflictFields(current, {
      id: current.id,
      expectedRevision: 1,
      status: 'in_progress',
      attrs: { note: '同' },
    })).toEqual([])
  })

  it('给定补丁带该 kind 不会写的字段当计算则不误报（memory 的 title 由 attrs 决定）', () => {
    const current = entity('memory', [
      attr(0, 'scope', { kind: 'global' }, true),
      attr(1, 'category', 'fact', true),
      attr(2, 'title', '记忆标题'),
    ])
    expect(patchConflictFields(current, { id: current.id, expectedRevision: 1, title: '顶层标题' })).toEqual([])
    expect(patchConflictFields(current, { id: current.id, expectedRevision: 1, category: 'clue' })).toEqual([
      { field: 'category', incoming: 'clue', current: 'fact' },
    ])
  })

  it('给定 pinned/confidence 是实体行字段当比较则用实体现值而不是属性行', () => {
    const current = state('in_progress', [], { pinned: false, confidence: 0.4 })
    expect(patchConflictFields(current, { id: current.id, expectedRevision: 1, pinned: false })).toEqual([])
    expect(patchConflictFields(current, { id: current.id, expectedRevision: 1, pinned: true })).toEqual([
      { field: 'pinned', incoming: true, current: false },
    ])
    expect(patchConflictFields(current, { id: current.id, expectedRevision: 1, confidence: 0.9 })).toEqual([
      { field: 'confidence', incoming: 0.9, current: 0.4 },
    ])
  })

  it('给定删除存在的可选属性当计算则 incoming 为 null；删除不存在的属性不报冲突', () => {
    const current = state('in_progress', [attr(4, 'note', '旧')])
    expect(patchConflictFields(current, { id: current.id, expectedRevision: 1, attrs: { note: null } })).toEqual([
      { field: 'note', incoming: null, current: '旧' },
    ])
    expect(patchConflictFields(current, { id: current.id, expectedRevision: 1, attrs: { absent: null } })).toEqual([])
  })
})
