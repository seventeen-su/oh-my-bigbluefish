/**
 * 组件显示元数据（插件页那一列的名字与说明）。
 *
 * **为什么需要它**：插件页的每一行显示的是**行的 `name`**，而中文名只能来自
 * DSH 的本地化元数据机制（`packages/boot/app-boot/src/package-meta.ts:148`）：
 *
 * ```ts
 * if (barePackageName(specifier) === undefined) return undefined
 * ```
 *
 * - 行名用相对路径（`./lib-gen/g14/...`）时 `barePackageName` 返回 undefined，
 *   `readPluginMeta` 直接放弃 → 插件页显示的是一串 `file:///C:/...` 路径，
 *   既不知道哪个开关对应哪个组件，也看不出开的是哪一代产物。
 * - 行名用**裸包名 + 子路径**（`@omb/plugin/omb-reasoning`）时，宿主解析器按
 *   `barePackageName(request)` 查拦截路由，拿到的是 `@omb/plugin`——它不是
 *   任何已注册依赖，于是退回 Node 原生解析并失败（实测 8 行全部 failed to import）。
 * - 名字取自 `<specifier>/locale/zh.json` 的 `meta.title`，说明取自 `meta.description`。
 *
 * **结论**：只有"每个组件都是一个独立顶层包"才能同时满足"解析得到"与"有元数据"。
 * 因此行名就是本文件里的 `packageName`，它必须与 `packages/<目录>/package.json`
 * 的 `name` 完全一致。
 *
 * 本文件是**显示名的唯一真源**：构建脚本据此生成
 * `packages/<目录>/locale/{en,zh}.json`。改名只改这里，不要在 locale 文件里手改。
 */
export interface ComponentDisplay {
  /** 行 id，与 `MODULE_IDS` / `cordis.patch.yml` 的行 id 一致。 */
  readonly rowId: string
  /**
   * 组件包的**裸顶层包名**（行名，`cordis.patch.yml` 的 `name`）。
   * 不得带子路径、不得带 `?v=`。对应目录 `packages/<去掉 scope 的部分>`。
   */
  readonly packageName: string
  /** 中文名（插件页显示）。 */
  readonly zh: string
  /** 英文名（语言回退用）。 */
  readonly en: string
  /** 中文说明（插件页显示，告诉用户这个开关做什么）。 */
  readonly zhDescription: string
  readonly enDescription: string
  /**
   * 这一行的性质。
   *
   * - `module`：认知模块，与 `MODULE_IDS` 一一对应
   * - `preset`：预设声明行（不是模块、不提供能力），但**同样需要中文名**——
   *   否则插件页显示的是上游包 `@deepseek-ai/dsh-agent-preset` 的英文描述，
   *   而它恰好是"每个 Agent 能力的组合声明"，与我们的预设毫无关系。
   */
  readonly kind: 'module' | 'preset'
}

export const COMPONENT_DISPLAY: readonly ComponentDisplay[] = [
  {
    rowId: 'omb-kernel',
    packageName: '@omb/kernel',
    zh: '微内核',
    en: 'Microkernel',
    zhDescription: '插件本体与必需项：服务总线、事件总线、健康面、状态面、工具注册网关。关掉它整个 OMB 都不会工作。',
    enDescription: 'Plugin body and required row: service bus, event bus, health, status surface, tool registration gateway.',
    kind: 'module',
  },
  {
    rowId: 'omb-memory',
    packageName: '@omb/memory',
    zh: '记忆库',
    en: 'Memory store',
    zhDescription: '双库长期记忆（用户库跨项目、项目库随 cwd），含写入准入、逐字召回、关联多跳、遗忘。',
    enDescription: 'Dual-store long-term memory with admission control, verbatim recall, multi-hop relations, and forgetting.',
    kind: 'module',
  },
  {
    rowId: 'omb-memory-vector',
    packageName: '@omb/memory-vector',
    zh: '向量检索',
    en: 'Vector retrieval',
    zhDescription: '语义召回通道（BGE 中文嵌入）。关掉后纯词法召回完整可用，只是同义改写召不回。',
    enDescription: 'Semantic recall channel. Turning it off keeps lexical recall fully working.',
    kind: 'module',
  },
  {
    rowId: 'omb-profile',
    packageName: '@omb/profile',
    zh: '用户画像',
    en: 'User profile',
    zhDescription: '显式偏好与画像条目，冲突只呈现不替你裁决。能力轴默认关闭且永不落盘。',
    enDescription: 'Explicit preferences and profile entries; conflicts are surfaced, never auto-resolved.',
    kind: 'module',
  },
  {
    rowId: 'omb-reasoning',
    packageName: '@omb/reasoning',
    zh: '思维链质量',
    en: 'Chain-of-thought quality',
    zhDescription: '八张方法卡与循环检测：让思考不偏长也不偏短。含常驻提示与按需拉取的 omb_method。',
    enDescription: 'Eight method cards plus loop detection; keeps reasoning neither too long nor too short.',
    kind: 'module',
  },
  {
    rowId: 'omb-context',
    packageName: '@omb/context',
    zh: '上下文优化',
    en: 'Context optimization',
    zhDescription: '软压力档位与拉取式上下文：默认不主动推送，按需取回；含拉取台账与杀死判据。',
    enDescription: 'Soft pressure bands and pull-based context; includes a pull ledger and kill criteria.',
    kind: 'module',
  },
  {
    rowId: 'omb-artifact',
    packageName: '@omb/artifact',
    zh: '制品索引',
    en: 'Artifact index',
    zhDescription: '本会话产出文件的索引（路径/类型/时间），不注入上下文，只由 omb_files 按需读取。',
    enDescription: 'Index of session artifacts, read on demand by omb_files; never injected into context.',
    kind: 'module',
  },
  {
    rowId: 'omb-notify',
    packageName: '@omb/notify',
    zh: '桌面通知',
    en: 'Desktop notifications',
    zhDescription: '把少数值得打扰的事件推到宿主桌面通知，带节流与去重。宿主没装通知服务时全静默。',
    enDescription: 'Pushes a few noteworthy events to the host desktop notification service, throttled and deduplicated.',
    kind: 'module',
  },
]

/** 按行 id 取显示元数据。 */
export function displayFor(rowId: string): ComponentDisplay | undefined {
  return COMPONENT_DISPLAY.find(entry => entry.rowId === rowId)
}

/**
 * 包名 → `packages/` 下的目录名（`@omb/memory-vector` → `memory-vector`）。
 *
 * 契约：目录名 = 包名去掉 scope。构建脚本按同一规则生成
 * `packages/<目录>/locale/*.json`，测试按同一规则核对三者一致
 * （行名 ↔ 组件包 ↔ locale 文件）——只留一条规则，避免三处各写一遍。
 */
export function componentDirOf(packageName: string): string {
  const slash = packageName.indexOf('/')
  return packageName.startsWith('@') && slash !== -1 ? packageName.slice(slash + 1) : packageName
}
