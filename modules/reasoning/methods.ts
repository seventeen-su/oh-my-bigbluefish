/**
 * 八条方法论规则卡（规划 §4.3）。
 *
 * **卡片文本的真源是本文件**。`docs/omb-v3-refactor-plan.md` §4.3 是施工蓝图，
 * 不是运行时数据源——测试刻意不读文档（让实现回归去解析 markdown，会把排版变成契约）。
 * 两者的措辞允许短期漂移，**一律以本文件为准**。
 * `tests/modules/reasoning/methods.test.ts` 用字面量快照把八条文本冻住，
 * 任何改动都会被看见。
 *
 * **`text` 就是模型实际看到的东西**。
 * 措辞是**动作**（"列出至少两个互斥的可能解释"），不是概念解释：
 * 本文件不得出现任何哲学术语，新增文案也必须先过这一条。
 *
 * 注入策略（§4.3 / §6.4）：不是每轮注入全部八条。
 * 常驻的只有 `residentHint()` 那一句；全文由模型经 `omb_method` 按需拉取。
 *
 * R3/R6 的形态在 v3.1 改过一次（用户判断）：
 * - `R3` 不再写死"至少两个"备选，改为"不止一种就并列"——**份数**由档位的
 *   `branchBudget` 决定（见 `control.ts`），固定数字从文案里移出。
 * - `R6` 不再是"连续失败两次就不再重试第三次"这种全局阈值，改为
 *   **失败分类 → 恢复策略**（`FAILURE_PLAYBOOK`）；旧阈值降级为
 *   `transient` 一类下的重试预算，理由写在该策略的 `why` 里。
 */
import type { FocusDepth } from '../../kernel/abi/index.js'
import { RESIDENT_HINT_MAX } from '../../kernel/abi/index.js'

/** 规则卡编号。`R1`…`R8`，与规划 §4.3 表格一一对应。 */
export type RuleId = 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'R6' | 'R7' | 'R8'

export interface MethodCard {
  readonly id: RuleId
  /** 短标题，用于索引视图与 `omb_method` 的话题匹配。 */
  readonly title: string
  /** 规则正文——**模型实际看到的措辞**；编号与规划 §4.3 对应，措辞以本文件为准。 */
  readonly text: string
  /** 何时该拉这张卡；一条可判定的触发条件，不是泛泛的建议。 */
  readonly whenToUse: string
}

/**
 * 八张卡。顺序固定为 R1…R8（索引视图与测试都依赖这个顺序）。
 */
export const METHOD_CARDS: readonly MethodCard[] = [
  {
    id: 'R1',
    title: '匹配深度',
    text: "先判断这个问题需要多少推理：简单确认/闲聊/事实问答 → 直接回答；需要推导/多方案权衡/信息不全 → 展开推理。不要为容易的问题展开长篇推理，也不要用一句话回答复杂问题。",
    whenToUse: '开始处理任何请求时；不确定该展开推理还是直接回答',
  },
  {
    id: 'R2',
    title: '先立判据',
    text: "在推理前先明确：什么样的结果算解决了这个问题？如果说不清，先向用户问清楚，别边做边猜。",
    whenToUse: '目标含糊、做完可能才发现理解错了的时候',
  },
  {
    id: 'R3',
    title: '备选再收敛',
    text: "如果不止一种合理解释或做法，就把它们并列摆出来再选一个，并说明为什么选这一个；只有一个合理解释时直接说，不要为凑数列假备选。",
    whenToUse: '要在多个可能解释或做法里选一个时',
  },
  {
    id: 'R4',
    title: '结论可检验',
    text: "每个关键结论要能回答：如果它错了，会看到什么不一样？说不出来的结论，标成'待确认'而不是断言。",
    whenToUse: '准备把一个推断当成结论说出来时',
  },
  {
    id: 'R5',
    title: '锚定具体',
    text: "每条事实都要指出出处：用户原话、文件行号、命令输出、约定。指不出来源的不要当事实用——'通常''一般来说'都不是出处。",
    whenToUse: '要引用事实、数字、行号或用户原话时',
  },
  {
    id: 'R6',
    title: '失败先分类',
    text: "一次尝试失败后先分类再处置：瞬时的（超时、限流）重试，但要有次数上限；参数错的改参数再来；方向错的换方向，不要重试；环境错的先查环境（权限、依赖、网络）；分不清的先用 omb_verify 报一次失败，或直接问用户。",
    whenToUse: '一次尝试失败、或同一动作再做一次仍没有新结果时',
  },
  {
    id: 'R7',
    title: '不编造',
    text: "不知道就说不知道；缺的信息先去要，不要补出一个看起来合理的答案。编造的代价高于承认不确定。",
    whenToUse: '不知道、记不清，或要补全缺失信息时',
  },
  {
    id: 'R8',
    title: '冲突只呈现',
    text: "发现信息互相矛盾（用户前后不一致、文档与代码不符、两个来源冲突）时，把两条都摆出来，并说明你倾向哪条、为什么；不要静默选一个。",
    whenToUse: '发现两个来源或前后表述互相矛盾时',
  },
]

const BY_ID = new Map<string, MethodCard>(METHOD_CARDS.map(card => [card.id.toLowerCase(), card]))

/** 按 id 取卡；未知 id 返回 undefined（不抛）。 */
export function cardById(id: string): MethodCard | undefined {
  return BY_ID.get(String(id).trim().toLowerCase())
}

/**
 * 每个深度档位**声明需要**的卡片 id（§4.6 的反向接口）。
 *
 * 这里是**拉取建议**，不是注入计划：真正自动注入的卡片由 `control.ts` 的
 * `injectCard` 决定，且任何档位都 ≤ 1 张（`AUTO_INJECT_CARD_CAP`）。
 * 档位差异的载体是**控制参数**（验证预算 / 证据要求 / 分支 / 复核 / 收尾），
 * 不是"给你更多规则文本"。
 *
 * - `quick`：一张都不要——本档位的动作是"别展开"，不是"读规则"
 * - `standard`：至多一张（R1 匹配深度）——它的动作已由常驻提示逐字承载，故不额外注入正文
 * - `deep`：R3/R4/R5 声明需要，自动注入 R4（可检验），其余按需用 `omb_method` 拉
 */
export const CARDS_BY_DEPTH: Readonly<Record<FocusDepth, readonly RuleId[]>> = {
  quick: [],
  standard: ['R1'],
  deep: ['R3', 'R4', 'R5'],
}

/** `deep` 档声明需要的卡片（供测试与状态面引用，避免各处硬写）。 */
export const DEEP_CARD_IDS: readonly RuleId[] = CARDS_BY_DEPTH.deep

/**
 * 某档位**声明需要**的规则卡。**纯函数**：同一 depth 永远返回同一批卡（顺序固定）。
 *
 * 注意它返回的是"声明"，不是"会注入什么"——注入预算见 `control.ts`。
 */
export function cardsFor(depth: FocusDepth): readonly MethodCard[] {
  const ids = CARDS_BY_DEPTH[depth] ?? []
  return ids.flatMap(id => {
    const card = BY_ID.get(id.toLowerCase())
    return card === undefined ? [] : [card]
  })
}

/**
 * 常驻提示：**一条** ≤ `RESIDENT_HINT_MAX` 字符的句子，说明有规则卡可用与何时用。
 *
 * 它进的是逐字节稳定的静态前缀（§6.5），因此必须：
 * ① 不含时间戳/计数/会话 id ② 同一 `maxChars` 下输出逐字节相同。
 *
 * 内容上有一条硬要求：**它自己就承载 R1 的动作**（"先判断这个问题需要多少推理"）。
 * R1 是最关键的一条（情感陪伴域的过度推理就栽在它上），而标准档不推卡片全文，
 * 因此常驻提示不能只说"有规则卡可用"。
 *
 * 措辞与 R1 正文的**同一句话**对齐：压缩与展开两种形态用词一致，模型不会看到两种说法。
 * 工具只点到名字、不承诺返回什么——`omb_method` 不带 topic 时只给索引，
 * 常驻提示里说"取全文"就是替它做了它不做的事。
 *
 * `maxChars` 只用于**变体选择**：取能装下的最长变体；都装不下才截断
 * （截断保留省略号，不假装是完整句）。
 */
export function residentHint(maxChars: number = RESIDENT_HINT_MAX): string {
  const limit = Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : RESIDENT_HINT_MAX
  const variants = RESIDENT_HINT_VARIANTS
  for (const variant of variants) {
    if (variant.length <= limit) return variant
  }
  const shortest = variants[variants.length - 1] ?? ''
  if (shortest.length <= limit) return shortest
  if (limit <= 0) return ''
  if (limit === 1) return shortest.slice(0, 1)
  return `${shortest.slice(0, limit - 1)}…`
}

/**
 * 由长到短：能装下哪条用哪条，保证常驻提示永远在预算内。
 *
 * 四条都以 R1 的动作**逐字**开头（"先判断这个问题需要多少推理"）；
 * 预算变小时先舍工具名、再舍后半句——动作本身留到最后（只有截断才可能丢）。
 * 三条常用工具（方法卡 / 档位 / 验证）只在预算够时点名：工具本身在工具面里可见，
 * 常驻提示的职责是"何时用"，不是"有哪些工具"。
 */
const RESIDENT_HINT_VARIANTS: readonly string[] = [
  '先判断这个问题需要多少推理：简单/闲聊/事实问答直接答，需推导或多方案再展开。规则卡 R1–R8 用 omb_method 取，深度档位用 omb_focus 设，结论核对与失败定性用 omb_verify。',
  '先判断这个问题需要多少推理：简单直接答，需推导或多方案再展开。卡 omb_method，档位 omb_focus，验证 omb_verify。',
  '先判断这个问题需要多少推理：简单直接答，复杂再展开；omb_method / omb_focus / omb_verify。',
  '先判断这个问题需要多少推理：简单直接答，复杂再展开。',
]

/** 话题别名：让 `omb_method({topic:'失败'})` 也能命中 R6，而不必记编号。 */
const TOPIC_ALIASES: Readonly<Record<RuleId, readonly string[]>> = {
  R1: ['深度', '长度', '思考量', '过度推理', '匹配'],
  R2: ['判据', '目标', '成功标准', '验收', '什么算解决'],
  R3: ['备选', '方案', '收敛', '过早收敛', '互斥', '选择', '分支'],
  R4: ['可检验', '验证', '断言', '待确认', '证伪'],
  R5: ['具体', '事实', '锚定', '核实', '出处'],
  R6: ['失败', '换向', '重试', '卡住', '换方向', '分类', '处置', '恢复', '瞬时', '环境'],
  R7: ['编造', '不知道', '不确定', '幻觉', '猜'],
  R8: ['冲突', '矛盾', '不一致', '前后矛盾'],
}

/**
 * 按话题找卡（供 `omb_method`）。纯函数，永不抛。
 *
 * 命中规则（任一满足）：`all`/`*` 取全部；编号（`R3`/`r3`/`3`）；
 * 标题或正文包含话题；别名表命中。
 */
export function findCards(topic: unknown): readonly MethodCard[] {
  const raw = typeof topic === 'string' ? topic.trim() : ''
  if (raw === '') return []
  const key = raw.toLowerCase()
  if (key === 'all' || key === '*') return METHOD_CARDS

  const numeric = /^r?([1-8])$/.exec(key)
  if (numeric !== null) {
    const card = BY_ID.get(`r${numeric[1]}`)
    return card === undefined ? [] : [card]
  }

  const hits = METHOD_CARDS.filter(card => {
    if (card.title.toLowerCase().includes(key)) return true
    if (card.text.toLowerCase().includes(key)) return true
    if (card.whenToUse.toLowerCase().includes(key)) return true
    return TOPIC_ALIASES[card.id].some(alias => alias.includes(key) || key.includes(alias))
  })
  return hits
}

/** 单卡渲染：标题 + 正文（正文逐字，不改写）。 */
export function renderCard(card: MethodCard): string {
  return `【${card.id} ${card.title}】${card.text}`
}

/**
 * 索引视图：只给编号、标题与触发条件，**不给正文**——
 * 这是 §6.4 拉取式设计里的"廉价索引"，模型据此决定拉哪张。
 */
export function renderIndex(cards: readonly MethodCard[] = METHOD_CARDS): string {
  if (cards.length === 0) return '没有匹配的规则卡。'
  const lines = cards.map(card => `${card.id} ${card.title}｜何时用：${card.whenToUse}`)
  return [
    `规则卡 ${cards.length} 张（取全文：omb_method { topic: "R3" }，或 topic: "all"）：`,
    ...lines,
  ].join('\n')
}

/** 全文渲染（多卡）。 */
export function renderCards(cards: readonly MethodCard[]): string {
  if (cards.length === 0) return '没有匹配的规则卡。'
  return cards.map(renderCard).join('\n')
}
