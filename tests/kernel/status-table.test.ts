/**
 * `StatusTable` 的**按名去重**契约（热重载时同名段落不得出现两条）。
 *
 * ## 这次踩的坑
 *
 * `register()` 过去只是 `push` 进数组，**没有按名去重**。热重载时新实例先挂上、
 * 旧实例的 disposer 稍后才被调用（宿主的 dispose 与 apply 不在同一个同步块里），
 * 这中间的每一次 `omb_status` 都会**同名渲染两遍**：
 *
 * ```
 * ### 常驻提示预算（omb 提示注入）   常驻提示 104/120 字符（未截断，余量 16）
 * ### 常驻提示预算（omb 提示注入）   常驻提示 0/120 字符（无贡献者）      ← 旧实例，尚未注销
 * ```
 *
 * 代价不是"多两行字"：两段同名文字给出**互相矛盾的数字**，而读者无法判断哪一段是
 * 活的（`omb_status` 是唯一的模型可见诊断入口）；更糟的是它把"重载成功与否"这件
 * 事实弄成不可读——同一个名字出现两次，说明旧实例还没退场。
 *
 * ## 现有模块一行都不用改
 *
 * 判据是"每个名字在渲染里只出现一次"，与贡献者由谁注册、注册顺序如何无关；
 * 不同名字照旧各自成段（`modules/context/module.test.ts` 那条多贡献者用例不变）。
 */
import { describe, expect, it, vi } from 'vitest'
import type { StatusContributor } from '../../kernel/abi/index.js'
import { StatusTable } from '../../kernel/status.js'

/** 造一个只回一行文字的贡献者。 */
function section(name: string, text: string): StatusContributor {
  return { name, render: () => text }
}

/** 渲染结果里某个段落的标题出现几次（同名双段就是 2）。 */
function headingCount(table: StatusTable, name: string): number {
  return table.render().filter(line => line === `### ${name}`).length
}

describe('StatusTable：按名去重（同名的新贡献替换旧的）', () => {
  it('同名注册两次 → 渲染只出现一条，且是后注册的那一条', () => {
    const table = new StatusTable()
    table.register(section('X', '旧实例的账目'))
    table.register(section('X', '新实例的账目'))

    expect(headingCount(table, 'X'), '同名段落只许出现一次').toBe(1)
    const text = table.render().join('\n')
    expect(text).toContain('新实例的账目')
    expect(text, '被替换的旧段落不许再渲染').not.toContain('旧实例的账目')
    // `list()` 与 `render()` 必须是同一份事实（否则状态面名字列表与实际段落不一致）
    expect(table.list().map(c => c.name)).toEqual(['X'])
  })

  it('被替换者的注销动作是**无操作**：不许删掉顶替它的新段', () => {
    const table = new StatusTable()
    const offOld = table.register(section('X', '旧实例的账目'))
    table.register(section('X', '新实例的账目'))

    // 热重载的真实时序：新的先挂上，旧的 disposer 稍后才跑
    offOld()

    expect(headingCount(table, 'X'), '旧实例的注销不得把新段带走').toBe(1)
    expect(table.render().join('\n')).toContain('新实例的账目')
    expect(table.list()).toHaveLength(1)
  })

  it('注销新段后旧的**不复活**（被替换即已退场，不许出现"删一个新的冒出两个"）', () => {
    const table = new StatusTable()
    const offOld = table.register(section('X', '旧实例的账目'))
    const offNew = table.register(section('X', '新实例的账目'))

    offNew()
    expect(table.list()).toEqual([])
    // 旧实例早已被顶替：它的 disposer 此后仍是无操作，改不了"这一段已经没了"的事实
    expect(() => offOld()).not.toThrow()
    expect(table.list()).toEqual([])
    expect(table.render().join('\n')).not.toContain('旧实例的账目')
  })

  it('注销幂等：重复调用不会误删别的段落', () => {
    const table = new StatusTable()
    const offX = table.register(section('X', 'X 的内容'))
    table.register(section('Y', 'Y 的内容'))

    offX()
    offX()
    expect(table.list().map(c => c.name)).toEqual(['Y'])
    expect(table.render().join('\n')).toContain('Y 的内容')
  })

  it('同一名字连续注册三次：只留最后一次（重载多次也只有一条）', () => {
    const table = new StatusTable()
    table.register(section('X', '第一代'))
    table.register(section('X', '第二代'))
    table.register(section('X', '第三代'))

    expect(headingCount(table, 'X')).toBe(1)
    const text = table.render().join('\n')
    expect(text).toContain('第三代')
    expect(text).not.toContain('第一代')
    expect(text).not.toContain('第二代')
  })

  it('同一个贡献者对象重复注册同名也只算一条（身份相同也走替换）', () => {
    const table = new StatusTable()
    const same = section('X', '同一份内容')
    const offFirst = table.register(same)
    table.register(same)

    expect(headingCount(table, 'X')).toBe(1)
    // 第一次的注销动作不该把第二次注册的那条带走（它已被顶替）
    offFirst()
    expect(headingCount(table, 'X'), '注销动作必须认"哪一次注册"，不能按对象身份删').toBe(1)
  })
})

describe('StatusTable：向后兼容（现有模块一行都不用改）', () => {
  it('不同名字各自成段，且按名字稳定排序（输出确定）', () => {
    const table = new StatusTable()
    table.register(section('乙', '乙的内容'))
    table.register(section('甲', '甲的内容'))
    table.register(section('丙', '丙的内容'))

    expect(table.list().map(c => c.name)).toEqual(['丙', '乙', '甲'].sort())
    const text = table.render().join('\n')
    for (const content of ['甲的内容', '乙的内容', '丙的内容']) expect(text).toContain(content)
    // 每段都是 `### 名字` + 正文 + 空行
    expect(table.render().slice(0, 3)).toEqual(['### 丙', '丙的内容', ''])
  })

  it('单个贡献者抛异常仍只影响它自己（同名去重不得破坏异常隔离）', () => {
    const table = new StatusTable()
    table.register(section('X', '旧实例的账目'))
    table.register({
      name: 'X',
      render: () => { throw new Error('渲染炸了') },
    })
    table.register(section('Y', 'Y 的内容'))

    const text = table.render().join('\n')
    expect(headingCount(table, 'X')).toBe(1)
    expect(text).toContain('该段落渲染失败：渲染炸了')
    expect(text).toContain('Y 的内容')
    expect(text).not.toContain('旧实例的账目')
  })

  it('render 只调用**本次该渲染**的那些贡献者（被替换的不许被调用）', () => {
    const table = new StatusTable()
    const oldRender = vi.fn(() => '旧')
    const newRender = vi.fn(() => '新')
    table.register({ name: 'X', render: oldRender })
    table.register({ name: 'X', render: newRender })

    table.render()
    expect(newRender).toHaveBeenCalledTimes(1)
    expect(oldRender, '被替换的贡献者一次都不该被渲染').not.toHaveBeenCalled()
  })

  it('名字是空串也不抛（诊断路径不许因为脏数据整份挂掉）', () => {
    const table = new StatusTable()
    expect(() => {
      table.register({ name: '', render: () => '无名内容' })
      table.register({ name: '', render: () => '无名内容（新）' })
    }).not.toThrow()
    expect(table.render().join('\n')).toContain('无名内容（新）')
  })
})
