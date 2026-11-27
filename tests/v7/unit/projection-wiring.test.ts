import { describe, expect, it } from 'vitest'
import type { Attribute, Entity, EntityKind } from '../../../packages/v7/src/domain/entity.js'
import type { JsonValue } from '../../../packages/v7/src/domain/json.js'
import {
  boardProjectionsFor,
  boardProjectionsForRename,
} from '../../../packages/v7/src/adapters/postgres/projection.js'

/**
 * writer 入队谓词的纯函数证据（PLAN Task 10 接线、ARCHITECTURE-PLAN §4.4）。
 *
 * 入队条件必须与 `PREFERENCE_DERIVE_SQL`/`STATE_DERIVE_SQL` 的看板成员谓词一致：
 * 只有“当前会出现在看板里的实体”才需要任务，否则每写一条记忆都产生一次无意义投影。
 */

const ENTITY_ID = 'mem_00000000-0000-0000-0000-000000000001'

function attr(name: string, value: JsonValue): Attribute {
  return { name, ordinal: 0, value: { kind: 'static', value }, required: false, source: 'model' }
}

function dynamicAttr(name: string, cachedValue: JsonValue): Attribute {
  return {
    name,
    ordinal: 0,
    value: { kind: 'dynamic', spec: { kind: 'ref', entityId: ENTITY_ID }, cachedValue },
    required: false,
    source: 'dynamic',
  }
}

function entityOf(overrides: Partial<Entity> & { readonly kind?: EntityKind } = {}): Entity {
  return {
    id: ENTITY_ID,
    kind: 'memory',
    revision: 1,
    origin: 'test',
    pinned: false,
    salience: 0.5,
    accessCount: 0,
    adoptionCount: 0,
    isCurrent: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    attributes: [],
    ...overrides,
  }
}

const PROJECT_SCOPE = attr('scope', { kind: 'project', projectKey: 'D:/proj/a' })

describe('投影注册：writer 入队谓词（纯函数）', () => {
  it('给定全局记忆 tags 含偏好当判定则需要 preference_board', () => {
    expect(boardProjectionsFor(entityOf({ attributes: [attr('tags', ['偏好'])] }))).toEqual(['preference_board'])
  })

  it('给定全局记忆 标签=偏好 或动态缓存值为偏好当判定则需要 preference_board', () => {
    expect(boardProjectionsFor(entityOf({ attributes: [attr('标签', '偏好')] }))).toEqual(['preference_board'])
    expect(boardProjectionsFor(entityOf({ attributes: [dynamicAttr('tags', ['偏好'])] }))).toEqual(['preference_board'])
  })

  it('给定全局记忆没有偏好标签当判定则不入队（避免无意义任务）', () => {
    expect(boardProjectionsFor(entityOf({ attributes: [attr('body', '普通正文')] }))).toEqual([])
    expect(boardProjectionsFor(entityOf({ attributes: [attr('tags', ['工作'])] }))).toEqual([])
  })

  it('给定项目内偏好记忆当判定则不进入全局偏好看板', () => {
    expect(boardProjectionsFor(entityOf({ attributes: [PROJECT_SCOPE, attr('tags', ['偏好'])] }))).toEqual([])
  })

  it('给定归档或历史版本当判定则两个看板都不需要投影', () => {
    expect(
      boardProjectionsFor(entityOf({ archivedAt: '2026-01-02T00:00:00.000Z', attributes: [attr('tags', ['偏好'])] })),
    ).toEqual([])
    expect(boardProjectionsFor(entityOf({ isCurrent: false, attributes: [attr('tags', ['偏好'])] }))).toEqual([])
    expect(
      boardProjectionsFor(entityOf({ kind: 'state_version', attributes: [PROJECT_SCOPE, attr('status', 'in_progress')] })),
    ).toEqual([])
  })

  it('给定状态机处于进行中/阻塞/等待当判定则需要 state_board，其余状态不需要', () => {
    for (const status of ['in_progress', 'blocked', 'waiting']) {
      expect(boardProjectionsFor(entityOf({ kind: 'state', attributes: [PROJECT_SCOPE, attr('status', status)] }))).toEqual([
        'state_board',
      ])
    }
    for (const status of ['completed', 'discarded', 'not_started']) {
      expect(boardProjectionsFor(entityOf({ kind: 'state', attributes: [PROJECT_SCOPE, attr('status', status)] }))).toEqual([])
    }
  })

  it('给定状态机是全局作用域或缺少项目键当判定则不进入项目状态看板', () => {
    expect(boardProjectionsFor(entityOf({ kind: 'state', attributes: [attr('status', 'in_progress')] }))).toEqual([])
    expect(
      boardProjectionsFor(entityOf({
        kind: 'state',
        attributes: [attr('scope', { kind: 'project', projectKey: '   ' }), attr('status', 'in_progress')],
      })),
    ).toEqual([])
  })

  it('给定 memory 同时带有状态属性当判定则仍不进入状态看板（kind 决定看板）', () => {
    expect(
      boardProjectionsFor(entityOf({ kind: 'memory', attributes: [PROJECT_SCOPE, attr('status', 'in_progress')] })),
    ).toEqual([])
  })

  it('给定归档命令收到的已是归档行当显式传 archived=false 则按归档前状态入队', () => {
    const archived = entityOf({ archivedAt: '2026-01-02T00:00:00.000Z', attributes: [attr('tags', ['偏好'])] })
    expect(boardProjectionsFor(archived)).toEqual([])
    expect(boardProjectionsFor(archived, { archived: false })).toEqual(['preference_board'])
  })

  it('给定可影响看板成员的属性改名当判定则要求重新入队，不相关改名返回空', () => {
    for (const name of ['tags', '标签', 'status', 'title', 'time']) {
      expect(boardProjectionsForRename(name, 'renamed', 'memory')).toEqual(['preference_board'])
    }
    expect(boardProjectionsForRename('tags', '标签', 'state')).toEqual(['state_board'])
    expect(boardProjectionsForRename('项目名', 'project_name', 'memory')).toEqual([])
    expect(boardProjectionsForRename('tags', '标签', 'chain')).toEqual([])
    expect(boardProjectionsForRename('tags', '标签', 'state_version')).toEqual([])
  })
})
