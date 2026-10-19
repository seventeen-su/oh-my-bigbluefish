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
    zhDescription: '提供插件最小主体与必需项',
    enDescription: 'Plugin core and required row.',
    kind: 'module',
  },
  // 3.6：隐私模式并入记忆库，`omb-privacy` 那一行（连同它的组件包）已删除。
  // 隐私的**用户可见面一个字没变**（还是 `/omb-privacy` 那条命令、还是那两种档位），
  // 所以下面这行的说明必须写明"含隐私闸门"——否则用户会以为隐私功能没了。
  //
  // ⚠ 这段注释必须留在对象**外面**：`scripts/build.mjs` 用正则解析本文件
  // （`readComponentDisplay`），它要求 `en:` 与 `zhDescription:` 紧邻，
  // 注释插在两者之间会让整条记录解析不出来 → 构建报"行 … 没有对应组件"。
  {
    rowId: 'omb-memory',
    packageName: '@omb/memory',
    zh: '记忆库',
    en: 'Memory store',
    zhDescription: '提供外置跨会话记忆系统',
    enDescription: 'External cross-session memory system.',
    kind: 'module',
  },
  {
    rowId: 'omb-memory-vector',
    packageName: '@omb/memory-vector',
    zh: '向量检索',
    en: 'Vector retrieval',
    zhDescription: '提供记忆库的语义召回通道',
    enDescription: 'Semantic recall channel for the memory store.',
    kind: 'module',
  },
  {
    rowId: 'omb-profile',
    packageName: '@omb/profile',
    zh: '用户画像',
    en: 'User profile',
    zhDescription: '提供额外的用户显式偏好与画像条目记忆',
    enDescription: 'Extra explicit user preferences and profile entries.',
    kind: 'module',
  },
  {
    rowId: 'omb-reasoning',
    packageName: '@omb/reasoning',
    zh: '思维链质量',
    en: 'Chain-of-thought quality',
    zhDescription: '过程卡在 skills（omb-depth 等，不对用户暴露）；只在检测到循环/无进展时注入一行',
    enDescription: 'Process cards live in skills (omb-depth etc.); injects only on loop/no-progress signals.',
    kind: 'module',
  },
  {
    rowId: 'omb-artifact',
    packageName: '@omb/artifact',
    zh: '制品索引',
    en: 'Artifact index',
    zhDescription: '提供会话内产出文件的按需索引',
    enDescription: 'On-demand index of session artifacts.',
    kind: 'module',
  },
  {
    rowId: 'omb-notify',
    packageName: '@omb/notify',
    zh: '桌面通知',
    en: 'Desktop notifications',
    zhDescription: '提供与 dsh-desktop-notify 的联动通知',
    enDescription: 'Notifications through dsh-desktop-notify.',
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
