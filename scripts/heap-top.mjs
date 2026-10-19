#!/usr/bin/env node
/**
 * 粗读 V8 heap snapshot：按 self_size 聚合 top 对象（不建 dominator tree）。
 *
 * 用法：node --max-old-space-size=8192 scripts/heap-top.mjs <file.heapsnapshot> [topN]
 *
 * 为什么需要：Chrome DevTools 能看 Retained Size，但自动化环境里没有浏览器；
 * self_size 聚合足以先回答"谁占了大头"（大字符串/数组/事件对象），再决定是否
 * 深入 dominator 分析。快照 JSON 可能数 GB，需要足够 Node 堆，解析失败就报错退出。
 */
import { readFileSync } from 'node:fs'

const file = process.argv[2]
const topN = Number(process.argv[3] ?? 30)
if (!file) {
  console.error('用法：node --max-old-space-size=8192 scripts/heap-top.mjs <file.heapsnapshot> [topN]')
  process.exit(2)
}

let snapshot
try {
  snapshot = JSON.parse(readFileSync(file, 'utf8'))
} catch (error) {
  console.error(`[heap-top] 解析失败：${error instanceof Error ? error.message : String(error)}`)
  console.error('提示：用 node --max-old-space-size=8192 运行；快照可能比堆上限更大。')
  process.exit(1)
}

const meta = snapshot?.snapshot?.meta
const nodes = snapshot?.nodes
const strings = snapshot?.strings
if (!meta || !Array.isArray(nodes) || !Array.isArray(strings)) {
  console.error('[heap-top] 不是合法的 .heapsnapshot（缺 snapshot.meta/nodes/strings）')
  process.exit(1)
}
const fields = meta.node_fields
const width = fields.length
const typeIdx = fields.indexOf('type')
const nameIdx = fields.indexOf('name')
const sizeIdx = fields.indexOf('self_size')
const typeNames = meta.node_types?.[0] ?? []
if (typeIdx < 0 || nameIdx < 0 || sizeIdx < 0) {
  console.error('[heap-top] node_fields 缺少 type/name/self_size')
  process.exit(1)
}

const byName = new Map()
const byType = new Map()
let total = 0
let count = 0
for (let i = 0; i + width <= nodes.length; i += width) {
  const type = typeNames[nodes[i + typeIdx]] ?? 'unknown'
  const name = strings[nodes[i + nameIdx]] ?? '(unnamed)'
  const size = nodes[i + sizeIdx] ?? 0
  total += size
  count += 1
  const key = `${type}\u0000${name}`
  const entry = byName.get(key) ?? { type, name, count: 0, size: 0 }
  entry.count += 1
  entry.size += size
  byName.set(key, entry)
  byType.set(type, (byType.get(type) ?? 0) + size)
}

const top = [...byName.values()].sort((a, b) => b.size - a.size).slice(0, topN)
console.log(`# heap-top ${file}`)
console.log(`# nodes=${count} self_size_total=${(total / 1024 / 1024).toFixed(1)} MB`)
console.log('\n## by type (self_size)')
for (const [type, size] of [...byType.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`${(size / 1024 / 1024).toFixed(1).padStart(10)} MB  ${type}`)
}
console.log('\n## top objects (type / name / count / self_size)')
for (const entry of top) {
  console.log(
    `${(entry.size / 1024 / 1024).toFixed(1).padStart(10)} MB  ${entry.count.toString().padStart(8)}  ${entry.type.padEnd(12)}  ${entry.name}`,
  )
}
