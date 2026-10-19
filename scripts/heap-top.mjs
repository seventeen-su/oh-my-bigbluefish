#!/usr/bin/env node
/**
 * 流式粗读 V8 heap snapshot：按 self_size 聚合 top 对象/类型。
 *
 * 为什么不用 JSON.parse：快照 2–4GB，Node 单字符串上限 512MB；这里不把整份
 * JSON 读成字符串，而是分两遍流式扫描：
 *   ① 找 `"nodes":[`，逐数字解析，按 type/name/self_size 聚合；
 *   ② 找 `"strings":[`，逐字符串解析，只保留被节点引用的名字。
 * 不建 dominator tree；self_size 聚合用于回答“谁占了大头”。
 *
 * 用法：node --max-old-space-size=4096 scripts/heap-top.mjs <file.heapsnapshot> [topN]
 */
import { closeSync, createReadStream, openSync, readSync } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'

const file = process.argv[2]
const topN = Number(process.argv[3] ?? 40)
if (!file) {
  console.error('用法：node --max-old-space-size=4096 scripts/heap-top.mjs <file.heapsnapshot> [topN]')
  process.exit(2)
}

function readPrefix(path, bytes = 256 * 1024) {
  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(bytes)
    const read = readSync(fd, buffer, 0, bytes, 0)
    return buffer.subarray(0, read).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

function metaFromPrefix(prefix) {
  const fields = prefix.match(/"node_fields":\s*(\[[^\]]*\])/)
  const types = prefix.match(/"node_types":\s*\[\[([^\]]*)\]/)
  if (!fields || !types) throw new Error('缺少 snapshot.meta.node_fields/node_types')
  return {
    nodeFields: JSON.parse(fields[1]),
    typeNames: JSON.parse(`[${types[1]}]`),
  }
}

/** 流式逐块扫描；进入目标数组后不再保留跨块尾部，避免重复处理。 */
async function scan(path, onChar, isActive) {
  const stream = createReadStream(path, { highWaterMark: 1 << 20 })
  const decoder = new StringDecoder('utf8')
  let carry = ''
  for await (const chunk of stream) {
    const text = carry + decoder.write(chunk)
    onChar(text)
    carry = isActive() ? '' : text.slice(-64)
  }
  onChar(carry + decoder.end())
}

async function main() {
  const { nodeFields, typeNames } = metaFromPrefix(readPrefix(file))
  const width = nodeFields.length
  const typeIdx = nodeFields.indexOf('type')
  const nameIdx = nodeFields.indexOf('name')
  const sizeIdx = nodeFields.indexOf('self_size')
  if (typeIdx < 0 || nameIdx < 0 || sizeIdx < 0) throw new Error('node_fields 缺 type/name/self_size')

  // ── 第一遍：nodes ─────────────────────────────────────────────────────
  const nameAgg = new Map() // `${type}\0${nameIdx}` -> { type, nameIdx, count, size }
  const typeAgg = new Map() // typeIdx -> size
  let total = 0
  let nodeCount = 0
  let foundNodes = false
  let ended = false
  let inNodes = false
  let pos = 0
  let value = ''
  const node = new Array(width)
  const onNodesChar = (ch) => {
    if (ended) return
    if (!inNodes) {
      const at = ch.indexOf('"nodes":[')
      if (at < 0) return
      foundNodes = true
      inNodes = true
      ch = ch.slice(at + '"nodes":['.length)
    }
    for (let i = 0; i < ch.length; i += 1) {
      const c = ch[i]
      if (c === '-' || (c >= '0' && c <= '9') || c === '+' || c === '.' || c === 'e' || c === 'E') {
        value += c
        continue
      }
      if (value.length > 0) {
        node[pos] = Number(value)
        value = ''
        pos += 1
        if (pos === width) {
          pos = 0
          const type = node[typeIdx]
          const name = node[nameIdx]
          const size = node[sizeIdx]
          total += size
          nodeCount += 1
          typeAgg.set(type, (typeAgg.get(type) ?? 0) + size)
          const key = `${type}\u0000${name}`
          const entry = nameAgg.get(key) ?? { type, nameIdx: name, count: 0, size: 0 }
          entry.count += 1
          entry.size += size
          nameAgg.set(key, entry)
        }
      }
      if (c === ']') {
        ended = true
        inNodes = false
        return
      }
    }
  }
  await scan(file, onNodesChar, () => inNodes || ended)
  if (!foundNodes) throw new Error('未找到顶层的 "nodes":[')

  // ── 第二遍：strings（只保留被节点引用的名字）─────────────────────────────
  const wanted = new Set()
  let maxWanted = 0
  for (const entry of nameAgg.values()) {
    wanted.add(entry.nameIdx)
    if (entry.nameIdx > maxWanted) maxWanted = entry.nameIdx
  }
  const names = new Map()
  let foundStrings = false
  let inStrings = false
  let done = false
  let stringIndex = 0
  let current = ''
  let escaped = false
  let unicodeLeft = 0
  let unicode = ''
  let inString = false

  const flushString = () => {
    if (wanted.has(stringIndex)) names.set(stringIndex, current)
    if (stringIndex >= maxWanted) done = true
    stringIndex += 1
    current = ''
  }


  const onStringsChar = (ch) => {
    if (done) return
    if (!inStrings) {
      const at = ch.indexOf('"strings":[')
      if (at < 0) return
      foundStrings = true
      inStrings = true
      ch = ch.slice(at + '"strings":['.length)
    }
    for (let i = 0; i < ch.length; i += 1) {
      const c = ch[i]
      if (!inString) {
        if (c === '"') {
          inString = true
          escaped = false
        } else if (c === ']') {
          done = true
          return
        }
        continue
      }
      if (unicodeLeft > 0) {
        unicode += c
        unicodeLeft -= 1
        if (unicodeLeft === 0) {
          current += String.fromCharCode(Number.parseInt(unicode, 16))
          unicode = ''
        }
        continue
      }
      if (escaped) {
        escaped = false
        if (c === 'u') {
          unicodeLeft = 4
          unicode = ''
        } else if (c === 'n') current += '\n'
        else if (c === 't') current += '\t'
        else if (c === 'r') current += '\r'
        else if (c === 'b') current += '\b'
        else if (c === 'f') current += '\f'
        else current += c
        continue
      }
      if (c === '\\') {
        escaped = true
        continue
      }
      if (c === '"') {
        inString = false
        flushString()
        if (done) return
        continue
      }
      current += c
    }
  }
  await scan(file, onStringsChar, () => inStrings || done)
  if (!foundStrings) throw new Error('未找到顶层的 "strings":[')

  // ── 输出 ─────────────────────────────────────────────────────────────
  const top = [...nameAgg.values()]
    .map(entry => ({
      type: typeNames[entry.type] ?? `type#${entry.type}`,
      name: names.get(entry.nameIdx) ?? `#${entry.nameIdx}`,
      count: entry.count,
      size: entry.size,
    }))
    .sort((a, b) => b.size - a.size)
    .slice(0, topN)

  console.log(`# heap-top ${file}`)
  console.log(`# nodes=${nodeCount} self_size_total=${(total / 1024 / 1024).toFixed(1)} MB`)
  console.log('\n## by type (self_size)')
  for (const [type, size] of [...typeAgg.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`${(size / 1024 / 1024).toFixed(1).padStart(10)} MB  ${typeNames[type] ?? `type#${type}`}`)
  }
  console.log('\n## top objects (type / name / count / self_size)')
  for (const entry of top) {
    console.log(
      `${(entry.size / 1024 / 1024).toFixed(1).padStart(10)} MB  ${String(entry.count).padStart(8)}  ${entry.type.padEnd(12)}  ${entry.name}`,
    )
  }
  console.log('\n# 说明：这是 self_size 聚合，不是 retained size；下一步按 top 名字找持有链。')
}

main().catch((error) => {
  console.error(`[heap-top] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
