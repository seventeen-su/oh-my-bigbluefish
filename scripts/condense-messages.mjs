/**
 * 提交信息压缩规则。
 *
 * **为什么要有规则而不是手工改写**：历史有三百多条提交，手工改必然漏、必然不一致。
 * 规则是确定性的：同一条信息任何时候都得到同一个结果，可复核、可重跑。
 *
 * 目标形态：**一行、简练、不用破折号、少用括号**。
 *
 * **它只是一个库，没有 CLI**：唯一的消费者是 `scripts/msg-filter.mjs`
 * （`git filter-branch --msg-filter` 的过滤器）。
 * 这里曾经写着"用法：`node scripts/condense-messages.mjs`（dry-run）/ `--apply`"，
 * 但那两个模式在文件里**根本不存在**（全文只有一个 `export function`）——
 * 直接跑它是"无输出、退出码 0"，看起来像成功。声明已删除，别再加回来。
 */

/** 把一条提交信息压缩成简练单行。 */
export function condense(subject) {
  let text = subject.trim()

  // 去掉 scope 里的括号写法保留 type（feat(memory) → feat:）
  const scoped = /^(\w+)\(([^)]*)\):\s*(.*)$/.exec(text)
  if (scoped !== null) text = `${scoped[1]}: ${scoped[3]}`

  // 去掉所有括号及其中内容（"（…）"与"(…)"）
  text = text.replace(/（[^）]*）/g, '').replace(/\([^)]*\)/g, '')

  // 破折号之后通常是解释，截掉；` + ` 拼接保留但补齐空格
  text = text.split('——')[0]
  text = text.split(' -- ')[0]
  text = text.split('+').join(' + ')

  // 句末标点去掉
  text = text.replace(/[。；;，,、：:]+$/, '')

  // 折叠空白
  text = text.replace(/\s+/g, ' ').replace(/\s*\+\s*/g, ' + ').trim()

  // 仍过长时在第一个逗号处截断，再不行在词边界硬截（不要在词中间切断）
  if (text.length > 40) {
    const comma = text.indexOf('，')
    if (comma > 12) text = text.slice(0, comma)
  }
  if (text.length > 48) {
    const cut = text.slice(0, 48)
    const boundary = Math.max(cut.lastIndexOf(' '), cut.lastIndexOf('/'))
    text = (boundary > 24 ? cut.slice(0, boundary) : cut).trim()
  }

  // 括号被去掉后可能留下悬空的连接词与多余空格
  text = text.replace(/\s+(并|和|与|及)$/, '').replace(/\s{2,}/g, ' ').trim()

  return text
}
