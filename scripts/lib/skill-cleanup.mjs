/**
 * profile 旧技能清理：deploy 只分发当前 4 个技能说明，v6 及更早的 8 张过程卡
 * （cite/conflict/depth/failure/goal/honesty/options/testable）必须从 profile 移除，
 * 否则 DSH 仍会把它们注册给模型。
 *
 * 只认精确的 `omb-*` 目录名：未知目录可能是用户自建技能，一律保留。
 * 本模块是纯逻辑 + 一次目录扫描，便于单测；deploy 只负责传 `apply` 与日志函数。
 */
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

export const LEGACY_SKILL_NAMES = [
  'omb-cite',
  'omb-conflict',
  'omb-depth',
  'omb-failure',
  'omb-goal',
  'omb-honesty',
  'omb-options',
  'omb-testable',
]

/**
 * 纯函数：从现有目录名里挑出需要删除的旧技能目录。
 * @param {readonly string[]} existing profile `skills/` 下现有的目录名
 * @returns {string[]} 命中的旧技能目录，按 LEGACY_SKILL_NAMES 的固定顺序
 */
export function staleSkillDirs(existing) {
  const present = new Set(existing)
  return LEGACY_SKILL_NAMES.filter(name => present.has(name))
}

/**
 * 删除（或 dry-run 只打印）profile 中的旧技能目录。
 * @param {{ skillsDir: string, apply: boolean, log?: (message: string) => void }} options
 * @returns {string[]} 计划删除（apply 时即实际删除）的目录名
 */
export function pruneStaleSkills(options) {
  const { skillsDir, apply } = options
  const log = options.log ?? (() => {})
  if (!existsSync(skillsDir)) return []
  const existing = readdirSync(skillsDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
  const stale = staleSkillDirs(existing)
  for (const name of stale) {
    const dir = join(skillsDir, name)
    if (!apply) {
      log(`将删除旧技能目录 ${dir}`)
      continue
    }
    rmSync(dir, { recursive: true, force: true })
    log(`删除旧技能目录 ${dir}`)
  }
  return stale
}
