/**
 * skills 目录（v4）：8 张方法卡从代码迁到 DSH skills。
 *
 * 判据（都能在 CI 里失败）：
 * ① `skills/omb-r1..r8/SKILL.md` 存在，frontmatter 有 name/description；
 * ② description ≤300 字符且**包含"何时用"**（DSH 的技能目录只渲染 name+description，
 *    when-to-use 不单独展示，所以必须写进 description——见研究报告 §5.2 提案 B）；
 * ③ 正文来自原 `methods.ts` 的卡片文本（用锚点句钉住，防被静默改写）；
 * ④ 正文不再引用已删除的 `omb_verify`（R6 改成外部核验器/问用户）。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'skills')

interface ParsedSkill {
  readonly frontmatter: Readonly<Record<string, string>>
  readonly body: string
}

/** 最小 frontmatter 解析：只认 `key: value` 与带引号的值（够本仓库的 skill 用）。 */
function parseSkill(raw: string): ParsedSkill {
  const text = raw.replace(/\r\n/g, '\n')
  if (!text.startsWith('---\n')) throw new Error('SKILL.md 必须以 YAML frontmatter 开头')
  const end = text.indexOf('\n---\n', 4)
  if (end < 0) throw new Error('SKILL.md frontmatter 未闭合')
  const front = text.slice(4, end)
  const body = text.slice(end + 5)
  const frontmatter: Record<string, string> = {}
  for (const line of front.split('\n')) {
    if (line.trim() === '') continue
    const match = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line)
    if (match === null) throw new Error(`无法解析 frontmatter 行：${line}`)
    const key = match[1] as string
    let value = (match[2] as string).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    frontmatter[key] = value
  }
  return { frontmatter, body }
}

function readSkill(name: string): ParsedSkill {
  return parseSkill(readFileSync(join(SKILLS_DIR, name, 'SKILL.md'), 'utf8'))
}

/** 8 张卡的锚点句（正文里必须出现，防止正文被清空或换掉）。 */
const ANCHORS: Readonly<Record<string, string>> = {
  'omb-r1': '不要为容易的问题展开长篇推理',
  'omb-r2': '什么样的结果算解决了这个问题',
  'omb-r3': '把它们并列摆出来再选一个',
  'omb-r4': '如果它错了，会看到什么不一样',
  'omb-r5': '每条事实都要指出出处',
  'omb-r6': '先分类再处置',
  'omb-r7': '不知道就说不知道',
  'omb-r8': '把两条都摆出来',
}

const NAMES = Array.from({ length: 8 }, (_, index) => `omb-r${index + 1}`)

describe('skills/omb-r1..r8 存在且格式正确', () => {
  it('目录里恰好有 8 个 skill 目录', () => {
    const dirs = readdirSync(SKILLS_DIR).filter(name => statSync(join(SKILLS_DIR, name)).isDirectory())
    expect(dirs.sort()).toEqual([...NAMES].sort())
  })

  it('每个 SKILL.md 的 frontmatter.name 与目录名一致', () => {
    for (const name of NAMES) {
      const skill = readSkill(name)
      expect(skill.frontmatter['name'], `${name} 的 name 漂移`).toBe(name)
    }
  })

  it('description ≤300 字符且包含"何时用"（DSH 只渲染 name+description）', () => {
    for (const name of NAMES) {
      const description = readSkill(name).frontmatter['description'] ?? ''
      expect(description.length, `${name} 的 description 为空`).toBeGreaterThan(10)
      expect(description.length, `${name} 的 description 超过 300 字符`).toBeLessThanOrEqual(300)
      expect(description, `${name} 的 description 缺少"何时用"`).toContain('何时用')
    }
  })

  it('正文来自原方法卡（锚点句在），且非空', () => {
    for (const name of NAMES) {
      const skill = readSkill(name)
      expect(skill.body.trim().length, `${name} 正文为空`).toBeGreaterThan(30)
      const anchor = ANCHORS[name] as string
      expect(skill.body, `${name} 正文丢失锚点句：${anchor}`).toContain(anchor)
    }
  })

  it('正文不再引用已删除的工具（omb_verify / omb_method / omb_focus）', () => {
    for (const name of NAMES) {
      const body = readSkill(name).body
      for (const banned of ['omb_verify', 'omb_method', 'omb_focus']) {
        expect(body.includes(banned), `${name} 正文仍引用 ${banned}`).toBe(false)
      }
    }
  })

  it('R6 的"分不清"出口改成外部核验器/问用户', () => {
    const body = readSkill('omb-r6').body
    expect(body).toContain('退出码')
    expect(body).toContain('tsc')
    expect(body).toContain('vitest')
    expect(body).toContain('问用户')
  })
})
