/**
 * 八条方法卡的快照测试（规划 §4.3）。
 *
 * 卡片文本的**真源是 `modules/reasoning/methods.ts`**；这里用字面量把八条措辞冻住，
 * 任何改动都会在快照对比里被看见，同时必须更新 `docs/omb-v3-refactor-plan.md` §4.3。
 *
 * **本测试刻意不读文档**：规划是施工蓝图，不是运行时数据源；
 * 让代码测试解析文档 markdown 会把"文档排版"变成"实现回归"。
 */
import { describe, expect, it } from 'vitest'
import { RESIDENT_HINT_MAX } from '../../../kernel/abi/index.js'
import {
  CARDS_BY_DEPTH,
  DEEP_CARD_IDS,
  METHOD_CARDS,
  cardById,
  cardsFor,
  findCards,
  renderCard,
  renderCards,
  renderIndex,
  residentHint,
} from '../../../modules/reasoning/methods.js'

/** 八条正文的字面量快照。改动这里 = 改模型实际看到的东西。 */
const TEXT_SNAPSHOT: Readonly<Record<string, string>> = {
  R1: "先判断这个问题需要多少推理：简单确认/闲聊/事实问答 → 直接回答；需要推导/多方案权衡/信息不全 → 展开推理。不要为容易的问题展开长篇推理，也不要用一句话回答复杂问题。",
  R2: "在推理前先明确：什么样的结果算解决了这个问题？如果说不清，先向用户问清楚，别边做边猜。",
  R3: "在确定方案前，列出至少两个互斥的可能解释或做法，然后说明为什么选这一个。但不要为凑数列假备选——只有一个合理解释时直接说。",
  R4: "每个关键结论要能回答：如果它错了，会看到什么不一样？说不出来的结论，标成'待确认'而不是断言。",
  R5: "每条事实都要指出出处：用户原话、文件行号、命令输出、约定。指不出来源的不要当事实用——'通常''一般来说'都不是出处。",
  R6: "同一个方向连续失败两次，就不再重试第三次。停下来，说明为什么这个方向不行，换一个方向或问用户。",
  R7: "不知道就说不知道；缺的信息先去要，不要补出一个看起来合理的答案。编造的代价高于承认不确定。",
  R8: "发现信息互相矛盾（用户前后不一致、文档与代码不符、两个来源冲突）时，把两条都摆出来，并说明你倾向哪条、为什么；不要静默选一个。",
}

/** 哲学术语黑名单：规则是**动作**，不是概念解释。 */
const BANNED_TERMS = [
  '辩证',
  '认识论',
  '本体论',
  '异化',
  '扬弃',
  '唯物',
  '唯心',
  '否定之否定',
  '对立统一',
  '实践论',
  '绝对精神',
  '现象学',
]

describe('八条方法卡', () => {
  it('八张齐全，顺序固定 R1…R8', () => {
    expect(METHOD_CARDS.map(card => card.id)).toEqual(['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8'])
  })

  it('每张卡的正文与字面量快照逐字一致', () => {
    for (const card of METHOD_CARDS) {
      expect(card.text, `${card.id} 正文`).toBe(TEXT_SNAPSHOT[card.id])
    }
  })

  it('每张卡都有标题与"何时用"（无空字段）', () => {
    for (const card of METHOD_CARDS) {
      expect(card.title.length, `${card.id} 标题`).toBeGreaterThan(0)
      expect(card.whenToUse.length, `${card.id} 何时用`).toBeGreaterThan(0)
    }
  })

  it('R3 含"不要为凑数列假备选"这一句', () => {
    expect(cardById('R3')?.text).toContain('但不要为凑数列假备选——只有一个合理解释时直接说')
  })

  it('R6 含"连续失败两次，就不再重试第三次"', () => {
    expect(cardById('R6')?.text).toContain('连续失败两次，就不再重试第三次')
  })

  it('八张之间不互相重复：标题与正文两两不同，且没有一张的正文是另一张的子串', () => {
    const texts = METHOD_CARDS.map(card => card.text)
    const titles = METHOD_CARDS.map(card => card.title)
    expect(new Set(texts).size).toBe(texts.length)
    expect(new Set(titles).size).toBe(titles.length)
    for (const card of METHOD_CARDS) {
      for (const other of METHOD_CARDS) {
        if (other.id === card.id) continue
        expect(card.text.includes(other.text), `${card.id} 的正文整段重复了 ${other.id}`).toBe(false)
      }
    }
  })

  it('R5 与 R7 职责不重叠：出处归 R5，缺信息归 R7', () => {
    // 这两张曾经都在说"不知道/没核实"——同一句话写在两张卡里，模型只会读到两遍
    expect(cardById('R5')?.text).toContain('出处')
    expect(cardById('R5')?.text).not.toContain('不知道')
    expect(cardById('R7')?.text).toContain('不知道')
    expect(cardById('R7')?.text).not.toContain('出处')
  })

  it('正文不含 markdown 强调符（提示词里不渲染，`**` 只是噪声）', () => {
    for (const card of METHOD_CARDS) {
      expect(card.text.includes('**'), `${card.id} 正文含 **`).toBe(false)
    }
  })

  it('正文不是一句话口号：每条都长到能执行（≥ 25 字符）', () => {
    for (const card of METHOD_CARDS) {
      expect(card.text.length, `${card.id} 正文过短`).toBeGreaterThanOrEqual(25)
    }
  })

  it('措辞是动作，不含哲学术语（标题/正文/何时用都查）', () => {
    for (const card of METHOD_CARDS) {
      const haystack = `${card.title}\n${card.text}\n${card.whenToUse}`
      for (const term of BANNED_TERMS) {
        expect(haystack.includes(term), `${card.id} 出现术语「${term}」`).toBe(false)
      }
    }
  })

  it('cardById 大小写与空白不敏感；未知 id 返回 undefined（不抛）', () => {
    expect(cardById('r3')?.id).toBe('R3')
    expect(cardById(' R3 ')?.id).toBe('R3')
    expect(cardById('R99')).toBeUndefined()
  })
})

describe('residentHint 常驻提示', () => {
  it('默认不超过内核上限 RESIDENT_HINT_MAX', () => {
    expect(RESIDENT_HINT_MAX).toBe(120)
    expect(residentHint().length).toBeLessThanOrEqual(RESIDENT_HINT_MAX)
  })

  it('自身承载 R1 的动作，而不是只说"有规则卡可用"', () => {
    const hint = residentHint()
    expect(hint).toContain('先判断这个问题需要多少推理')
  })

  it('与 R1 正文用同一句动作措辞（压缩与展开不出现两种说法）', () => {
    const action = '先判断这个问题需要多少推理'
    expect(cardById('R1')?.text).toContain(action)
    expect(residentHint()).toContain(action)
  })

  it('说明何时用哪把工具（拉取式设计的入口）', () => {
    const hint = residentHint()
    expect(hint).toContain('omb_method')
    expect(hint).toContain('omb_focus')
  })

  it('不替 omb_method 承诺全文（不传 topic 只给索引）', () => {
    // 常驻提示曾经写"方法卡用 omb_method 按需拉"，容易被读成"一定会拿到正文"
    expect(residentHint()).not.toContain('取全文')
    expect(residentHint()).not.toContain('全文')
  })

  it('预算再小也先保住 R1 的动作（配置下限 20 字符）', () => {
    for (const budget of [120, 100, 80, 60, 50, 40, 30, 20]) {
      expect(residentHint(budget), `预算 ${budget}`).toContain('先判断这个问题需要多少推理')
    }
  })

  it('逐字节稳定：同参数多次调用完全相同（前缀缓存的前提）', () => {
    expect(residentHint()).toBe(residentHint())
    expect(residentHint(120)).toBe(residentHint(120))
  })

  it('预算更小时不越界；预算为 0 时返回空串', () => {
    for (const budget of [120, 100, 80, 60, 40, 30, 20, 1]) {
      const hint = residentHint(budget)
      expect(hint.length, `预算 ${budget}`).toBeLessThanOrEqual(budget)
    }
    expect(residentHint(0)).toBe('')
  })

  it('非法预算回落到默认上限（不抛）', () => {
    expect(residentHint(Number.NaN).length).toBeLessThanOrEqual(RESIDENT_HINT_MAX)
    expect(residentHint(-5)).toBe('')
  })
})

describe('cardsFor：三档差异', () => {
  it('quick 不推任何卡片（本档位的动作是"别展开"）', () => {
    expect(cardsFor('quick')).toEqual([])
    expect(CARDS_BY_DEPTH.quick).toEqual([])
  })

  it('standard 至多一张', () => {
    expect(cardsFor('standard').length).toBeLessThanOrEqual(1)
    expect(CARDS_BY_DEPTH.standard.length).toBeLessThanOrEqual(1)
  })

  it('deep 给 R3/R4/R5 全文', () => {
    expect(cardsFor('deep').map(card => card.id)).toEqual(['R3', 'R4', 'R5'])
    expect(DEEP_CARD_IDS).toEqual(['R3', 'R4', 'R5'])
    for (const card of cardsFor('deep')) {
      expect(card.text).toBe(TEXT_SNAPSHOT[card.id])
    }
  })

  it('三档的卡片数量严格递增：quick < standard < deep', () => {
    expect(cardsFor('quick').length).toBeLessThan(cardsFor('standard').length)
    expect(cardsFor('standard').length).toBeLessThan(cardsFor('deep').length)
  })

  it('返回的是同一批卡片对象（无拷贝、可比较引用）', () => {
    expect(cardsFor('deep')[0]).toBe(cardById('R3'))
  })
})

describe('findCards 话题匹配（omb_method 的入口）', () => {
  it('编号、大小写、纯数字都能命中', () => {
    expect(findCards('R3').map(c => c.id)).toEqual(['R3'])
    expect(findCards('r3').map(c => c.id)).toEqual(['R3'])
    expect(findCards('3').map(c => c.id)).toEqual(['R3'])
  })

  it('话题别名命中', () => {
    expect(findCards('备选').map(c => c.id)).toEqual(['R3'])
    expect(findCards('失败').map(c => c.id)).toEqual(['R6'])
    expect(findCards('冲突').map(c => c.id)).toEqual(['R8'])
  })

  it('all / * 取全部八张', () => {
    expect(findCards('all').length).toBe(8)
    expect(findCards('*').length).toBe(8)
  })

  it('空话题与无匹配返回空数组（不抛）', () => {
    expect(findCards('')).toEqual([])
    expect(findCards('   ')).toEqual([])
    expect(findCards('这个词不存在zzz')).toEqual([])
    expect(findCards(null)).toEqual([])
    expect(findCards(42)).toEqual([])
  })
})

describe('渲染', () => {
  it('索引视图只给编号/标题/何时用，不给正文（廉价索引）', () => {
    const index = renderIndex()
    for (const card of METHOD_CARDS) {
      expect(index).toContain(card.id)
      expect(index).toContain(card.whenToUse)
    }
    expect(index).not.toContain(cardById('R3')?.text ?? '不可能匹配')
  })

  it('单卡渲染含编号、标题与逐字正文', () => {
    const card = cardById('R5')
    expect(card).toBeDefined()
    const rendered = renderCard(card!)
    expect(rendered).toContain('R5')
    expect(rendered).toContain(card!.text)
  })

  it('多卡渲染逐字保留正文；空数组给可读说明', () => {
    expect(renderCards(cardsFor('deep'))).toContain(cardById('R4')!.text)
    expect(renderCards([])).toBe('没有匹配的规则卡。')
  })
})
