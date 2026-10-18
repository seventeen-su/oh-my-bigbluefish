/**
 * `omb_project`：项目画像 + 项目记忆（3.7 Wave 2，task-17 §3）。
 *
 * ## 为什么需要它
 *
 * 用户抱怨"AI 不理解这个项目、每次都要重新摸"。现有的 `omb_recall` 只能按**查询词**
 * 找记忆，任务开始时模型不知道"该问什么"。本工具给一个**稳定的项目入口**：
 * 一份确定性画像（由 `dsh/` 用文件系统/子进程生成，模块只读）+ 现有项目记忆 top 3。
 *
 * ## 边界
 *
 * - **只读**：画像构建在 `dsh/`（只有它允许碰文件系统），本模块 `read`/`refresh`；
 * - **服务可缺席**：`omb:project-profile` 没接线时，照样返回项目记忆 + 一句可读说明，
 *   **不抛**、不假装有画像（"未接线"与"画像为空"必须能区分）；
 * - **不新增常驻提示**：触发句放在工具描述里（与 `omb_recall` 同一分工，见 `docs/context-budget.md`）。
 */
import type {
  Clock,
  MemoryStore,
  ToolDefinition,
  ToolInputSchema,
  ToolOutcome,
} from '../../kernel/abi/index.js'
import { SERVICES } from '../../kernel/abi/index.js'
import { isoUtc } from './retrieve.js'

/** 工具名（目录白名单之外的新工具：3.7 Wave 2 经用户批准，工具面 10 → 11）。 */
export const PROJECT_TOOL = 'omb_project'

/** 画像端口服务名（唯一真源：`SERVICES.projectProfile`）。 */
export const PROJECT_PROFILE_SERVICE = SERVICES.projectProfile

/** 画像文本上限：任务入口要短，长内容留在仓库里按需读。 */
export const MAX_PROFILE_CHARS = 1600
/** 单条项目记忆展示上限。 */
export const MAX_MEMORY_CHARS = 200
/** 固定查询：不依赖模型猜词，只要项目里存过经验/约定就有机会命中。 */
export const PROJECT_MEMORY_QUERY = '项目 约定 结论 经验 进度 决策'

/** 画像视图（结构由 `dsh/project-profile.ts` 实现；模块不 import 宿主）。 */
export interface ProjectProfileView {
  readonly text: string
  readonly generatedAt: number
  readonly gitHead?: string
}

/** 画像端口（Lead 在 `dsh/` 实现并 provide `SERVICES.projectProfile`）。 */
export interface ProjectProfilePort {
  read(cwd: string): ProjectProfileView | undefined
  refresh(cwd: string): Promise<ProjectProfileView | undefined>
}

/** 工具依赖。 */
export interface ProjectToolDeps {
  readonly clock: Clock
  /**
   * 解析本会话的项目上下文。**没有会话/项目库未打开时返回 undefined**——
   * 不拿别的项目顶替（位置即权威，见规划 §5.3）。
   */
  readonly resolveProject: (
    sessionId?: string,
  ) => { readonly cwd?: string; readonly store?: MemoryStore } | undefined
  /** 画像服务（每次调用惰性解析：热插拔可能换实例/关闭）。 */
  readonly profile?: () => ProjectProfilePort | undefined
}

/** 参数 schema：`parse` + 给模型看的 `jsonSchema`。 */
interface ToolParameters extends ToolInputSchema {
  readonly jsonSchema: Record<string, unknown>
}

const PROJECT_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    refresh: {
      type: 'boolean',
      description: '强制重建画像（默认 false：读缓存；重建可能较慢）',
    },
  },
  additionalProperties: false,
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 相对时间：只用于"画像多久前生成"，精度到分钟即可。 */
export function describeAge(now: number, at: number): string {
  if (!Number.isFinite(now) || !Number.isFinite(at)) return '时间未知'
  const deltaMs = Math.max(0, now - at)
  const minutes = Math.floor(deltaMs / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1))}…`
}

/** 行渲染：header + 正文（逐字，但截断可见）。 */
function renderProfile(view: ProjectProfileView, cwd: string, now: number): string[] {
  const head = view.gitHead === undefined || view.gitHead.length === 0 ? '' : `，git ${view.gitHead.slice(0, 12)}`
  return [
    `项目画像：${cwd}${head}（生成于 ${describeAge(now, view.generatedAt)}）`,
    clip(view.text.trim(), MAX_PROFILE_CHARS),
  ]
}

/** 造 `omb_project` 工具。**执行体绝不抛**（H-3）。 */
export function createProjectTool(deps: ProjectToolDeps): ToolDefinition {
  const parameters: ToolParameters = {
    jsonSchema: PROJECT_JSON_SCHEMA,
    parse(input: unknown): unknown {
      if (input === undefined || input === null) return {}
      if (typeof input !== 'object' || Array.isArray(input)) throw new Error('参数必须是对象：{ refresh?: boolean }')
      const raw = input as { refresh?: unknown }
      if (raw.refresh !== undefined && typeof raw.refresh !== 'boolean') {
        throw new Error('refresh 必须是布尔值')
      }
      return raw.refresh === undefined ? {} : { refresh: raw.refresh }
    },
  }

  return {
    name: PROJECT_TOOL,
    description:
      '任务开始时先读项目画像：返回当前项目的持久画像（技术栈/常用命令/目录/README 要点/git 头）与最近的项目记忆 top 3。'
      + '画像由宿主确定性生成并缓存；需要最新内容时传 refresh:true。'
      + '项目画像不可用时仍返回项目记忆，并说明原因。',
    parameters,
    async execute(args: unknown, call?: { readonly sessionId?: string; readonly attribution?: string }): Promise<ToolOutcome> {
      try {
        if (typeof args === 'object' && args !== null && !Array.isArray(args)) {
          const raw = args as { refresh?: unknown }
          if (raw.refresh !== undefined && typeof raw.refresh !== 'boolean') {
            return { kind: 'error', text: `${PROJECT_TOOL} 参数非法：refresh 必须是布尔值` }
          }
        } else if (args !== undefined && args !== null) {
          return { kind: 'error', text: `${PROJECT_TOOL} 参数非法：参数必须是对象 { refresh?: boolean }` }
        }
        const refresh = (args as { refresh?: boolean } | undefined)?.refresh === true
        const sessionId = call?.attribution === 'session' ? call.sessionId : undefined
        const resolved = deps.resolveProject(sessionId)
        const now = deps.clock.now()
        const lines: string[] = []

        // ── 画像 ───────────────────────────────────────────────────────────
        const profile = (() => {
          try {
            return deps.profile?.()
          } catch {
            return undefined
          }
        })()
        if (resolved?.cwd === undefined) {
          lines.push('项目上下文未知：本次调用没有会话归属（或项目库尚未打开），无法确定当前项目目录。')
          lines.push('（按项目召回/画像需要在本会话回合内调用。）')
        } else if (profile === undefined) {
          lines.push(`项目画像不可用：宿主未接线 ${PROJECT_PROFILE_SERVICE} 服务（这不是"画像为空"）。`)
        } else {
          let view: ProjectProfileView | undefined
          try {
            view = refresh ? await profile.refresh(resolved.cwd) : profile.read(resolved.cwd)
          } catch (error) {
            lines.push(`项目画像${refresh ? '重建' : '读取'}失败（已隔离）：${messageOf(error)}`)
          }
          if (view !== undefined) {
            lines.push(...renderProfile(view, resolved.cwd, now))
          } else if (refresh) {
            lines.push('项目画像：重建失败（宿主没有返回画像；项目记忆仍然可用）。')
          } else {
            lines.push('项目画像：尚未生成（用 refresh:true 让宿主生成一次；项目记忆仍然可用）。')
          }
        }

        // ── 项目记忆 top 3 ────────────────────────────────────────────────
        lines.push('', '项目记忆（按词法相关度取前 3 条；无则为空）：')
        const store = resolved?.store
        if (store === undefined) {
          lines.push('（项目库未打开：没有可读的项目记忆。）')
        } else {
          try {
            const hits = await store.searchLexical({ text: PROJECT_MEMORY_QUERY, scope: 'project', limit: 3 })
            if (hits.length === 0) {
              lines.push('（本项目还没有记忆：用 omb_remember 写结论，或让自主捕获积累。）')
            } else {
              const records = await store.getMany(hits.map(hit => hit.id))
              const byId = new Map(records.map(record => [record.id, record]))
              let rank = 0
              for (const hit of hits) {
                const record = byId.get(hit.id)
                if (record === undefined || record.validTo !== null) continue
                rank += 1
                lines.push(
                  `[${rank}] id=${record.id} · ${record.kind} · observedAt=${isoUtc(record.observedAt)}` +
                    ` · sourceRef=${record.sourceRef}`,
                )
                lines.push(`  ${clip(record.text, MAX_MEMORY_CHARS)}`)
              }
              if (rank === 0) lines.push('（命中的项目记忆都已失效。）')
            }
          } catch (error) {
            lines.push(`（项目记忆读取失败，已隔离：${messageOf(error)}）`)
          }
        }
        return { kind: 'text', text: lines.join('\n') }
      } catch (error) {
        return { kind: 'error', text: `${PROJECT_TOOL} 执行失败：${messageOf(error)}` }
      }
    },
  }
}
