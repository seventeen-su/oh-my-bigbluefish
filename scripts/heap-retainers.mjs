#!/usr/bin/env node
/**
 * 流式读 heap snapshot，给指定对象名找一条“根 ← … ← 对象”的父链。
 *
 * 目的：self_size 聚合只能说明“谁大”，不能说明“谁留住”。V8 snapshot 的
 * edges 按 nodes 顺序排列；这里建立第一父边（parent），因此能回答
 * “Timeout / system Context 被谁引用”，而不需要在内存里建完整图。
 *
 * 用法：node --max-old-space-size=8192 scripts/heap-retainers.mjs <file.heapsnapshot> [名字...]
 * 默认名字：Timeout、system / Context、system / CallSiteInfo
 */
import { closeSync, createReadStream, openSync, readSync } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'

const file = process.argv[2]
const targets = process.argv.slice(3)
if (!file) {
  console.error('用法：node --max-old-space-size=8192 scripts/heap-retainers.mjs <file.heapsnapshot> [名字...]')
  process.exit(2)
}
const targetNames = targets.length > 0 ? targets : ['Timeout', 'system / Context', 'system / CallSiteInfo']

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

function parseMeta(prefix) {
  const fields = prefix.match(/"node_fields":\s*(\[[^\]]*\])/)
  const edgeFields = prefix.match(/"edge_fields":\s*(\[[^\]]*\])/)
  const types = prefix.match(/"node_types":\s*\[\[([^\]]*)\]/)
  if (!fields || !edgeFields || !types) throw new Error('缺少 snapshot.meta 字段')
  return {
    nodeFields: JSON.parse(fields[1]),
    edgeFields: JSON.parse(edgeFields[1]),
    typeNames: JSON.parse(`[${types[1]}]`),
  }
}

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

class Grow {
  constructor(Type) {
    this.Type = Type
    this.array = new Type(1 << 20)
    this.length = 0
  }
  push(value) {
    if (this.length === this.array.length) {
      const next = new this.Type(Math.floor(this.array.length * 1.5))
      next.set(this.array)
      this.array = next
    }
    this.array[this.length] = value
    this.length += 1
  }
  get(index) {
    return this.array[index]
  }
  subarray() {
    return this.array.subarray(0, this.length)
  }
}

async function main() {
  const { nodeFields, typeNames } = parseMeta(readPrefix(file))
  const width = nodeFields.length
  const typeIdx = nodeFields.indexOf('type')
  const nameIdx = nodeFields.indexOf('name')
  const sizeIdx = nodeFields.indexOf('self_size')
  const edgeIdx = nodeFields.indexOf('edge_count')
  if ([typeIdx, nameIdx, sizeIdx, edgeIdx].some(index => index < 0)) throw new Error('node_fields 不完整')

  // ── nodes ────────────────────────────────────────────────────────────
  const types = new Grow(Uint8Array)
  const names = new Grow(Uint32Array)
  const sizes = new Grow(Float64Array)
  const edgeCounts = new Grow(Uint32Array)
  let inNodes = false
  let ended = false
  let pos = 0
  let value = ''
  const node = new Array(width)
  const onNode = (ch) => {
    if (ended) return
    if (!inNodes) {
      const at = ch.indexOf('"nodes":[')
      if (at < 0) return
      inNodes = true
      ch = ch.slice(at + '"nodes":['.length)
    }
    for (let i = 0; i < ch.length; i += 1) {
      const c = ch[i]
      if (c === '-' || (c >= '0' && c <= '9') || c === '.' || c === 'e' || c === 'E' || c === '+') {
        value += c
        continue
      }
      if (value.length > 0) {
        node[pos] = Number(value)
        value = ''
        pos += 1
        if (pos === width) {
          pos = 0
          types.push(node[typeIdx])
          names.push(node[nameIdx])
          sizes.push(node[sizeIdx])
          edgeCounts.push(node[edgeIdx])
        }
      }
      if (c === ']') {
        ended = true
        inNodes = false
        return
      }
    }
  }
  await scan(file, onNode, () => inNodes || ended)
  const nodeCount = types.length
  console.log(`# nodes=${nodeCount}`)

  // ── strings（全部，用于名字与父链展示）──────────────────────────────
  const strings = []
  let inStrings = false
  let done = false
  let inString = false
  let escaped = false
  let unicodeLeft = 0
  let unicode = ''
  let current = ''
  const onString = (ch) => {
    if (done) return
    if (!inStrings) {
      const at = ch.indexOf('"strings":[')
      if (at < 0) return
      inStrings = true
      ch = ch.slice(at + '"strings":['.length)
    }
    for (let i = 0; i < ch.length; i += 1) {
      const c = ch[i]
      if (!inString) {
        if (c === '"') {
          inString = true
          escaped = false
          current = ''
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
        strings.push(current)
        continue
      }
      current += c
    }
  }
  await scan(file, onString, () => inStrings || done)
  console.log(`# strings=${strings.length}`)

  // ── edges：第一父边 ──────────────────────────────────────────────────
  const { edgeFields } = parseMeta(readPrefix(file))
  const edgeWidth = edgeFields.length
  const toField = edgeFields.indexOf('to_node')
  if (toField < 0) throw new Error('edge_fields 缺 to_node')
  const parent = new Int32Array(nodeCount).fill(-1)
  let source = 0
  let remaining = edgeCounts.get(0)
  let edgePos = 0
  let edgeValue = ''
  let edgesDone = false
  const edge = new Array(edgeWidth)
  const onEdge = (ch) => {
    if (edgesDone || source >= nodeCount) return
    for (let i = 0; i < ch.length; i += 1) {
      const c = ch[i]
      if (c === '-' || (c >= '0' && c <= '9')) {
        edgeValue += c
        continue
      }
      if (edgeValue.length > 0) {
        edge[edgePos] = Number(edgeValue)
        edgeValue = ''
        edgePos += 1
        if (edgePos === edgeWidth) {
          edgePos = 0
          const to = Math.floor(edge[toField] / width)
          if (to >= 0 && to < nodeCount && parent[to] === -1) parent[to] = source
          remaining -= 1
          while (remaining === 0 && source + 1 < nodeCount) {
            source += 1
            remaining = edgeCounts.get(source)
          }
        }
      }
      if (c === ']') {
        edgesDone = true
        return
      }
    }
  }
  // edges 数组在 nodes 之后；跳过 nodes 字节直到 `"edges":[`
  let inEdges = false
  await scan(file, (ch) => {
    if (inEdges) {
      onEdge(ch)
      return
    }
    const at = ch.indexOf('"edges":[')
    if (at < 0) return
    inEdges = true
    onEdge(ch.slice(at + '"edges":['.length))
  }, () => inEdges)
  console.log(`# edges parent map ready`)

  // ── 找目标节点，打印父链（每个名字最多 3 个）────────────────────────────
  for (const targetName of targetNames) {
    let shown = 0
    for (let i = 0; i < nodeCount && shown < 3; i += 1) {
      const name = strings[names.get(i)] ?? ''
      if (name !== targetName) continue
      shown += 1
      const typeName = typeNames[types.get(i)] ?? `type#${types.get(i)}`
      console.log(`\n## ${typeName} ${JSON.stringify(name)} (node ${i})`)
      let index = i
      for (let depth = 0; depth < 30 && index >= 0; depth += 1) {
        const parentType = typeNames[types.get(index)] ?? `type#${types.get(index)}`
        const parentName = strings[names.get(index)] ?? `#${names.get(index)}`
        console.log(`${'  '.repeat(depth)}← ${parentType} ${JSON.stringify(parentName)} self=${(sizes.get(index) / 1024).toFixed(1)}KB`)
        index = parent[index]
      }
    }
    if (shown === 0) console.log(`\n## ${JSON.stringify(targetName)}：未找到`)
  }
}

main().catch((error) => {
  console.error(`[heap-retainers] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
