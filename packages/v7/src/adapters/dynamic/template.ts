const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g

/**
 * 渲染 `{{name}}` 模板。
 * - `values` 里有的名字替换成字符串值；
 * - 没有对应 ref 的占位符原样保留（不静默丢信息，写错名字一眼可见）；
 * - ref 存在但取不到值时，调用方把空字符串放进 `values`。
 */
export function renderTemplate(template: string, values: ReadonlyMap<string, string>): string {
  return template.replace(PLACEHOLDER, (match, rawName: string) => {
    const name = rawName.trim()
    const replacement = values.get(name)
    return replacement === undefined ? match : replacement
  })
}
