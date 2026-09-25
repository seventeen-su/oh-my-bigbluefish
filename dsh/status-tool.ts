/**
 * 状态面工具 `omb_status`。
 *
 * 由 `dsh/` 组装（`omb_status` 属 `omb-kernel`，见 `kernel/abi/catalog.ts`），
 * 内容来自三处：
 * ① 内核健康面（每模块的 `state` + `detail`——`detail` 必填，无法说明原因的降级不允许存在）
 * ② 状态面登记处（各模块贡献的段落，见 `StatusRegistry`）
 * ③ 预算面与上下文度量
 *
 * **这是唯一的模型可见诊断入口**，因此它必须在任何模块缺席时仍然可用——
 * 状态面本身挂了是最难排查的故障。
 */
import type { ContextPressure, ModuleHealth, StatusRegistry, StoresService } from '../kernel/abi/index.js'
import { SERVICES } from '../kernel/abi/index.js'
import type { KernelHandle } from '../kernel/index.js'
import type { ToolSpec } from './tools.js'
import { PARAM } from './tools.js'
import type { SessionTable } from './session.js'
import { generationFromUrl } from '../kernel/buildInfo.js'

const STATE_LABEL: Record<ModuleHealth['state'], string> = {
  ok: '正常',
  degraded: '降级',
  failed: '失败',
}

export interface StatusToolOptions {
  /** 用 `KernelHandle` 而非模块面的 `Kernel`：全局健康面与预算面**不应**暴露给模块。 */
  readonly handle: KernelHandle
  readonly sessions: SessionTable
}

/** 组装 `omb_status` 的输出文本。纯组装，无副作用，便于测试。 */
export function renderStatus(options: StatusToolOptions, sessionId?: string): string {
  const { handle, sessions } = options
  const kernel = handle.kernel
  const lines: string[] = ['# OMB 状态', '']

  // ── 构建代数 ──────────────────────────────────────────────────────────
  // **这一行是防误判的关键**：插件行能免重启动态增删，但模块代码走 Node ESM
  // 按 URL 缓存——改了源码而 URL 没变时，宿主跑的还是**旧模块实例**，
  // 此时任何"模块异常"的报错都不反映当前源码。
  // 代数直接印在状态里，"到底跑的是哪一代"就成了可观测事实。
  const generation = generationFromUrl(import.meta.url)
  lines.push(
    '## 构建',
    '',
    generation === undefined
      ? '- 代数：未知（非换代产物运行，或从源码直接运行；无法据此判断代码新旧）'
      : `- 代数：第 ${generation} 代（产物目录 lib-gen/g${generation}）`,
    '',
  )

  // ── 模块健康 ──────────────────────────────────────────────────────────
  const health = handle.health()
  const ids = Object.keys(health).sort()
  lines.push('## 模块', '')
  if (ids.length === 0) {
    lines.push('（无模块上报健康）', '')
  } else {
    for (const id of ids) {
      const entry = health[id]
      if (entry === undefined) continue
      lines.push(`- ${id}：${STATE_LABEL[entry.state]}——${entry.detail}`)
    }
    const failed = ids.filter(id => health[id]?.state === 'failed')
    const degraded = ids.filter(id => health[id]?.state === 'degraded')
    lines.push('', `合计：${ids.length} 个模块，${degraded.length} 降级，${failed.length} 失败。`, '')
  }

  // ── 存储 ──────────────────────────────────────────────────────────────
  const stores = kernel.service<StoresService>(SERVICES.stores)
  lines.push('## 存储', '')
  if (stores === undefined) {
    lines.push('（存储服务未注册）', '')
  } else {
    const status = stores.status()
    lines.push(`- 就绪：${status.ready ? '是' : '否'}——${status.detail}`)
    if (status.openProjects.length > 0) {
      lines.push(`- 已打开项目库：${status.openProjects.length} 个`)
    }
    lines.push('')
  }

  // ── 上下文度量（软压力，不是上限）─────────────────────────────────────
  const activeSession = sessionId ?? sessions.sessions()[0] ?? ''
  lines.push('## 上下文', '')
  if (activeSession.length === 0) {
    lines.push('（无活跃会话）', '')
  } else {
    const pressure: ContextPressure = kernel.pressure(activeSession)
    const ratio = pressure.fillRatio === null ? '未知（宿主未声明窗口）' : pressure.fillRatio.toFixed(3)
    lines.push(`- 压力档位：${pressure.band}（fillRatio ${ratio}）`)
    lines.push(`- 总 token：${pressure.totalTokens}`)
    lines.push(`- 缓存：读 ${pressure.cacheReadTokens} / 写 ${pressure.cacheWriteTokens}`)
    if (pressure.nodes.length > 0) {
      const top = [...pressure.nodes].sort((a, b) => b.tokens - a.tokens).slice(0, 5)
      lines.push(`- 最贵的 ${top.length} 块：${top.map(n => `${n.name}(${n.tokens})`).join('、')}`)
    }
    lines.push(`- 推理深度档位：${kernel.focus(activeSession)}`, '')
  }

  // ── 预算 ──────────────────────────────────────────────────────────────
  const budgets = handle.budgets()
  const budgetKeys = Object.keys(budgets).sort()
  if (budgetKeys.length > 0) {
    lines.push('## 预算', '')
    for (const key of budgetKeys) {
      const slot = budgets[key]
      if (slot === undefined) continue
      lines.push(`- ${key}：${slot.used}/${slot.limit}`)
    }
    lines.push('')
  }

  // ── 模块贡献的段落 ────────────────────────────────────────────────────
  const registry = kernel.service<StatusRegistry>(SERVICES.statusContributor)
  const contributed = registry?.list() ?? []
  if (contributed.length > 0) {
    lines.push(...registryLines(registry))
  } else {
    lines.push('## 组件自述', '', '（尚无模块贡献状态段落）', '')
  }

  return lines.join('\n')
}

function registryLines(registry: StatusRegistry | undefined): readonly string[] {
  if (registry === undefined) return []
  // 渲染由登记处负责（它已隔离单个贡献者的异常）；这里只加一层小标题
  const rendered: string[] = ['## 组件自述', '']
  for (const c of registry.list()) {
    try {
      rendered.push(`### ${c.name}`, c.render(), '')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      rendered.push(`### ${c.name}`, `（渲染失败：${message}）`, '')
    }
  }
  return rendered
}

/**
 * 造 `omb_status` 的工具定义。
 *
 * 参数只有一个可选的 `session`——便于诊断"某个特定会话"的上下文压力。
 * 执行体**绝不抛异常**：任何内部失败都转成一条可读的错误文本，
 * 因为状态面失败时最需要它自己还能说明原因。
 */
export function buildStatusTool(handle: KernelHandle, sessions: SessionTable): ToolSpec {
  return {
    name: 'omb_status',
    description:
      '查看 OMB 认知层的运行状态：各模块健康与降级原因、记忆库路径与就绪情况、'
      + '当前上下文压力档位与缓存命中、推理深度档位、以及各组件自述。'
      + '当某个功能表现异常、或需要确认哪个模块被关闭时使用。',
    parameters: {
      type: 'object',
      properties: {
        session: PARAM.optionalString('要查看的会话 id；缺省取当前活跃会话'),
      },
      additionalProperties: false,
    },
    run: (args: unknown) => {
      try {
        const session = typeof (args as { session?: unknown } | undefined)?.session === 'string'
          ? (args as { session: string }).session
          : undefined
        return { kind: 'text' as const, text: renderStatus({ handle, sessions }, session) }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { kind: 'error' as const, text: `状态面渲染失败——${message}` }
      }
    },
  }
}
