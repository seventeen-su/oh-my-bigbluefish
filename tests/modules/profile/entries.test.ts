/**
 * 画像纯逻辑测试（零 mock、零 I/O）。
 *
 * 覆盖本轮三条验收：
 * ① 显式压过推断——**等级而非权重**（推断再多也压不过一条声明）
 * ② 冲突两条都保留且被标记（R8：只呈现不裁决）
 * ③ 文档编解码确定性 + 损坏输入不抛
 */
import { describe, expect, it } from 'vitest'
import type { ProfileEntry } from '../../../modules/profile/entries.js'
import {
  applyEntry,
  axisLabel,
  decodeDocument,
  fnv1a,
  listConflicts,
  normalizeEntry,
  PROFILE_DOC_VERSION,
  renderConflicts,
  renderDeclared,
  resolveConflict,
  sameKey,
  serializeDocument,
} from '../../../modules/profile/entries.js'

function entry(partial: Partial<ProfileEntry> & { value: string }): ProfileEntry {
  return {
    axis: 'stable',
    key: 'tone',
    provenance: 'declared',
    evidence: [],
    updated: 1,
    ...partial,
  }
}

describe('冲突消解：显式 vs 推断是来源等级', () => {
  it('无同键条目 → 新增', () => {
    const result = applyEntry(entry({ value: '简洁' }), [])
    expect(result.outcome).toBe('added')
    expect(result.entries).toHaveLength(1)
  })

  it('推断进不来：同键已有显式声明时，推断被拒绝（不覆盖）', () => {
    const declared = entry({ value: '简洁', provenance: 'declared' })
    const result = applyEntry(entry({ value: '冗长', provenance: 'inferred' }), [declared])
    expect(result.outcome).toBe('inferred-blocked-by-declared')
    expect(result.entries).toEqual([declared])
    // 生效取值仍是显式声明——没有任何"平均/投票"痕迹
    expect(result.entries[0]?.value).toBe('简洁')
  })

  it('新显式声明把同键旧推断整条替换（不是"多一票"）', () => {
    const inferred = entry({ value: '冗长', provenance: 'inferred', updated: 5 })
    const result = applyEntry(entry({ value: '简洁', provenance: 'declared', updated: 9 }), [inferred])
    expect(result.outcome).toBe('declared-overrides-inferred')
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]).toMatchObject({ value: '简洁', provenance: 'declared' })
  })

  it('等级压不过权重：三条互相矛盾的推断，被一条显式声明一次清掉', () => {
    // 用同一套消解规则把三条推断叠起来（它们互相冲突 → 三条都在）
    let entries: readonly ProfileEntry[] = []
    for (const [index, value] of ['A', 'B', 'C'].entries()) {
      entries = resolveConflict(
        entry({ value, provenance: 'inferred', updated: index + 1 }),
        entries,
      )
    }
    expect(entries).toHaveLength(3)

    entries = resolveConflict(entry({ value: '确定', provenance: 'declared', updated: 99 }), entries)
    // 如果这里是"权重"，三条推断的票数会压过一条声明；等级制下声明直接胜出。
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ value: '确定', provenance: 'declared' })
  })

  it('同等级同值 → 合并为一条并并集证据', () => {
    const first = entry({ value: '简洁', evidence: ['s1#3'], updated: 10 })
    const second = entry({ value: '简洁', evidence: ['s2#7'], updated: 20 })
    const result = applyEntry(second, [first])
    expect(result.outcome).toBe('merged')
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]?.evidence).toEqual(['s1#3', 's2#7'])
    expect(result.entries[0]?.updated).toBe(20)
  })

  it('同等级异值 → 冲突：两条都保留，不选一个', () => {
    const result = applyEntry(entry({ value: '简洁' }), [entry({ value: '详尽' })])
    expect(result.outcome).toBe('conflict')
    expect(result.entries).toHaveLength(2)
    expect(result.entries.map(e => e.value)).toEqual(['详尽', '简洁'])
  })

  it('两条推断互相矛盾时同样都保留（同等级没有裁决权）', () => {
    const result = applyEntry(
      entry({ value: 'B', provenance: 'inferred' }),
      [entry({ value: 'A', provenance: 'inferred' })],
    )
    expect(result.outcome).toBe('conflict')
    expect(result.entries).toHaveLength(2)
  })

  it('key 规范化：两侧空白不影响同键判定', () => {
    const result = applyEntry(entry({ key: ' tone ', value: '简洁' }), [entry({ value: '详尽' })])
    expect(result.outcome).toBe('conflict')
    expect(result.entries.map(e => e.key)).toEqual(['tone', 'tone'])
  })
})

describe('冲突呈现（R8：只呈现，不裁决）', () => {
  it('同键异值 → 检出一组冲突，两个取值都在', () => {
    const entries = [entry({ value: '简洁' }), entry({ value: '详尽', updated: 2 })]
    const conflicts = listConflicts(entries)
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]?.values.map(v => v.value)).toEqual(['详尽', '简洁'])
  })

  it('同键同值（历史重复）不算冲突', () => {
    const conflicts = listConflicts([entry({ value: '简洁' }), entry({ value: '简洁', updated: 2 })])
    expect(conflicts).toEqual([])
  })

  it('不同轴同键不算冲突', () => {
    const conflicts = listConflicts([
      entry({ axis: 'stable', value: '简洁' }),
      entry({ axis: 'collaboration', value: '详尽' }),
    ])
    expect(conflicts).toEqual([])
  })

  it('渲染文本包含全部取值与"不替你选择"的说明；无冲突时为空串', () => {
    const text = renderConflicts(listConflicts([entry({ value: '简洁' }), entry({ value: '详尽' })]))
    expect(text).toContain('简洁')
    expect(text).toContain('详尽')
    expect(text).toContain('不替你选择')
    expect(renderConflicts([])).toBe('')
  })

  it('渲染顺序稳定（轴、键排序），便于逐字节比较', () => {
    const a = listConflicts([
      entry({ axis: 'stable', key: 'b', value: '1' }),
      entry({ axis: 'stable', key: 'b', value: '2' }),
      entry({ axis: 'intent', key: 'a', value: 'x' }),
      entry({ axis: 'intent', key: 'a', value: 'y' }),
    ])
    expect(a.map(c => `${c.axis}:${c.key}`)).toEqual(['intent:a', 'stable:b'])
  })
})

describe('显式条目渲染', () => {
  it('只列显式，排除推断与能力轴；limit 生效', () => {
    const entries: ProfileEntry[] = [
      entry({ key: 'a', value: '1' }),
      entry({ key: 'b', value: '2' }),
      entry({ key: 'c', value: '3', provenance: 'inferred' }),
      entry({ axis: 'capability', key: 'd', value: '4', provenance: 'inferred' }),
    ]
    const text = renderDeclared(entries, 1)
    expect(text).toContain('a')
    expect(text).not.toContain('c')
    expect(text).not.toContain('d')
    expect(renderDeclared([], 5)).toBe('')
  })

  it('轴标签可读', () => {
    expect(axisLabel('capability')).toContain('能力')
    expect(axisLabel('intent')).toContain('意图')
  })
})

describe('文档编解码', () => {
  it('序列化与输入顺序无关（内容未变即逐字节相同）', () => {
    const a = [entry({ key: 'b', value: '2' }), entry({ key: 'a', value: '1' })]
    const b = [entry({ key: 'a', value: '1' }), entry({ key: 'b', value: '2' })]
    expect(serializeDocument(a)).toBe(serializeDocument(b))
  })

  it('往返一致', () => {
    const entries = [entry({ value: '简洁', evidence: ['s1'] }), entry({ key: 'x', value: 'y', axis: 'intent' })]
    const decoded = decodeDocument(serializeDocument(entries))
    expect(decoded.error).toBeNull()
    expect(decoded.dropped).toBe(0)
    expect(decoded.entries).toHaveLength(2)
  })

  it('坏 JSON / 未知版本 / entries 非数组 → 可读错误，不抛', () => {
    expect(decodeDocument('{').error).toContain('不是合法 JSON')
    expect(decodeDocument(JSON.stringify({ version: 99, entries: [] })).error).toContain('不认识的画像文档版本')
    expect(decodeDocument(JSON.stringify({ version: PROFILE_DOC_VERSION, entries: {} })).error).toContain('entries 不是数组')
    expect(decodeDocument('null').error).toContain('顶层不是对象')
  })

  it('非法条目被丢弃并计数（不静默）', () => {
    const text = JSON.stringify({
      version: PROFILE_DOC_VERSION,
      entries: [
        { axis: 'stable', key: 'ok', value: 'v', provenance: 'declared', evidence: [], updated: 1 },
        { axis: 'nope', key: 'k', value: 'v', provenance: 'declared' },
        { axis: 'stable', key: '', value: 'v', provenance: 'declared' },
        { axis: 'stable', key: 'k', value: 42, provenance: 'declared' },
        { axis: 'stable', key: 'k', value: 'v', provenance: 'guessed' },
        'not-an-object',
      ],
    })
    const decoded = decodeDocument(text)
    expect(decoded.entries).toHaveLength(1)
    expect(decoded.dropped).toBe(5)
  })

  it('normalizeEntry 不改写取值（逐字优先）但清理 key 与证据', () => {
    const normalized = normalizeEntry(entry({ key: ' k ', value: ' 原话  ', evidence: ['', 'e', 'e'] }))
    expect(normalized.key).toBe('k')
    expect(normalized.value).toBe(' 原话  ')
    expect(normalized.evidence).toEqual(['e'])
  })

  it('sameKey 只比较轴与键', () => {
    expect(sameKey(entry({ key: 'a', value: '1' }), entry({ key: ' a ', value: '2' }))).toBe(true)
    expect(sameKey(entry({ key: 'a', value: '1' }), entry({ axis: 'intent', key: 'a', value: '2' }))).toBe(false)
  })
})

describe('fnv1a', () => {
  it('确定且区分内容', () => {
    expect(fnv1a('abc')).toBe(fnv1a('abc'))
    expect(fnv1a('abc')).not.toBe(fnv1a('abd'))
    expect(fnv1a('')).toHaveLength(8)
  })
})
