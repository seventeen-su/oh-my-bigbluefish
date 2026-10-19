#!/usr/bin/env node
/**
 * 流式读 V8 heap snapshot，建图并计算 dominator / retained size，回答
 * “Timeout / Error 到底被谁留住”。
 *
 * 算法：Lengauer–Tarjan（迭代 DFS + 路径压缩 eval），只存整型数组，
 * 不建 JS 对象图；26M 节点级别可用但耗时较长。
 *
 * 用法：node --max-old-space-size=16384 scripts/heap-dominators.mjs <file.heapsnapshot> [目标名...]
 * 默认：Timeout、Error
 */
import { closeSync, createReadStream, openSync, readSync } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'

const file = process.argv[2]
const targetNames = process.argv.slice(3).length > 0 ? process.argv.slice(3) : ['Timeout', 'Error']
if (!file) {
  console.error('用法：node --max-old-space-size=16384 scripts/heap-dominators.mjs <file.heapsnapshot> [名字...]')
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

function meta() {
  const prefix = readPrefix(file)
  const fields = prefix.match(/"node_fields":\s*(\[[^\]]*\])/)
  const edgeFields = prefix.match(/"edge_fields":\s*(\[[^\]]*\])/)
  const types = prefix.match(/"node_types":\s*\[\[([^\]]*)\]/)
  if (!fields || !edgeFields || !types) throw new Error('缺少 snapshot.meta')
  return {
    nodeFields: JSON.parse(fields[1]),
    edgeFields: JSON.parse(edgeFields[1]),
    typeNames: JSON.parse(`[${types[1]}]`),
  }
}

async function scan(onChar, isActive) {
  const stream = createReadStream(file, { highWaterMark: 1 << 20 })
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
  constructor(Type) { this.Type = Type; this.array = new Type(1 << 20); this.length = 0 }
  push(value) {
    if (this.length === this.array.length) {
      const next = new this.Type(Math.floor(this.array.length * 1.5))
      next.set(this.array)
      this.array = next
    }
    this.array[this.length] = value
    this.length += 1
  }
  get(index) { return this.array[index] }
  subarray() { return this.array.subarray(0, this.length) }
}

function readNodes(meta) {
  const width = meta.nodeFields.length
  const typeIdx = meta.nodeFields.indexOf('type')
  const nameIdx = meta.nodeFields.indexOf('name')
  const sizeIdx = meta.nodeFields.indexOf('self_size')
  const edgeIdx = meta.nodeFields.indexOf('edge_count')
  const type = new Grow(Uint8Array)
  const name = new Grow(Uint32Array)
  const size = new Grow(Float64Array)
  const edges = new Grow(Uint32Array)
  let inNodes = false, ended = false, pos = 0, value = ''
  const node = new Array(width)
  const onChar = (ch) => {
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
          type.push(node[typeIdx])
          name.push(node[nameIdx])
          size.push(node[sizeIdx])
          edges.push(node[edgeIdx])
        }
      }
      if (c === ']') { ended = true; inNodes = false; return }
    }
  }
  return scan(onChar, () => inNodes || ended).then(() => ({ type, name, size, edges }))
}

async function readStrings() {
  const strings = []
  let inStrings = false, done = false, inString = false, escaped = false, unicodeLeft = 0, unicode = '', current = ''
  const onChar = (ch) => {
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
        if (c === '"') { inString = true; escaped = false; current = '' }
        else if (c === ']') { done = true; return }
        continue
      }
      if (unicodeLeft > 0) {
        unicode += c; unicodeLeft -= 1
        if (unicodeLeft === 0) { current += String.fromCharCode(Number.parseInt(unicode, 16)); unicode = '' }
        continue
      }
      if (escaped) {
        escaped = false
        if (c === 'u') { unicodeLeft = 4; unicode = '' }
        else if (c === 'n') current += '\n'
        else if (c === 't') current += '\t'
        else if (c === 'r') current += '\r'
        else if (c === 'b') current += '\b'
        else if (c === 'f') current += '\f'
        else current += c
        continue
      }
      if (c === '\\') { escaped = true; continue }
      if (c === '"') { inString = false; strings.push(current); continue }
      current += c
    }
  }
  await scan(onChar, () => inStrings || done)
  return strings
}

function readEdges(meta, edgeCounts) {
  const width = meta.edgeFields.length
  const toField = meta.edgeFields.indexOf('to_node')
  if (toField < 0) throw new Error('edge_fields 缺 to_node')
  const nodeWidth = meta.nodeFields.length
  const totalNodes = edgeCounts.length
  const from = new Grow(Uint32Array)
  const to = new Grow(Uint32Array)
  let source = 0
  let remaining = edgeCounts.get(0)
  while (remaining === 0 && source + 1 < totalNodes) {
    source += 1
    remaining = edgeCounts.get(source)
  }
  let inEdges = false, done = false, pos = 0, value = ''
  const edge = new Array(width)
  const onChar = (ch) => {
    if (done) return
    if (!inEdges) {
      const at = ch.indexOf('"edges":[')
      if (at < 0) return
      inEdges = true
      ch = ch.slice(at + '"edges":['.length)
    }
    for (let i = 0; i < ch.length; i += 1) {
      const c = ch[i]
      if (c === '-' || (c >= '0' && c <= '9')) {
        value += c
        continue
      }
      if (value.length > 0) {
        edge[pos] = Number(value)
        value = ''
        pos += 1
        if (pos === width) {
          pos = 0
          const target = Math.floor(edge[toField] / nodeWidth)
          if (target >= 0 && target < totalNodes) {
            from.push(source)
            to.push(target)
          }
          remaining -= 1
          while (remaining === 0 && source + 1 < totalNodes) {
            source += 1
            remaining = edgeCounts.get(source)
          }
        }
      }
      if (c === ']') { done = true; return }
    }
  }
  return scan(onChar, () => inEdges || done).then(() => ({ from: from.subarray(), to: to.subarray() }))
}

function buildCsr(n, from, to) {
  const outCount = new Uint32Array(n)
  const inCount = new Uint32Array(n)
  for (let i = 0; i < from.length; i += 1) {
    outCount[from[i]] += 1
    inCount[to[i]] += 1
  }
  const outStart = new Uint32Array(n + 1)
  const inStart = new Uint32Array(n + 1)
  for (let i = 0; i < n; i += 1) {
    outStart[i + 1] = outStart[i] + outCount[i]
    inStart[i + 1] = inStart[i] + inCount[i]
  }
  const outTo = new Uint32Array(from.length)
  const inFrom = new Uint32Array(from.length)
  const outPos = outStart.slice(0, n)
  const inPos = inStart.slice(0, n)
  for (let i = 0; i < from.length; i += 1) {
    outTo[outPos[from[i]]++] = to[i]
    inFrom[inPos[to[i]]++] = from[i]
  }
  return { outStart, outTo, inStart, inFrom }
}

function dominators(n, root, csr) {
  const dfsnum = new Int32Array(n).fill(-1)
  const vertex = new Int32Array(n)
  const parent = new Int32Array(n).fill(-1)
  const iter = new Uint32Array(n)
  const stack = new Int32Array(n + 1)
  let count = 0
  dfsnum[root] = 0
  vertex[0] = root
  count = 1
  let top = 0
  stack[0] = root
  while (top >= 0) {
    const v = stack[top]
    if (iter[v] < csr.outStart[v + 1] - csr.outStart[v]) {
      const to = csr.outTo[csr.outStart[v] + iter[v]]
      iter[v] += 1
      if (dfsnum[to] === -1) {
        dfsnum[to] = count
        vertex[count] = to
        count += 1
        parent[to] = v
        stack[++top] = to
      }
    } else {
      top -= 1
    }
  }
  const semi = new Int32Array(n)
  const label = new Int32Array(n)
  const ancestor = new Int32Array(n).fill(-1)
  const idom = new Int32Array(n).fill(-1)
  const bucketHead = new Int32Array(n).fill(-1)
  const bucketNext = new Int32Array(n).fill(-1)
  for (let i = 0; i < n; i += 1) {
    semi[i] = i
    label[i] = i
  }
  const evalNode = (v) => {
    if (ancestor[v] === -1) return label[v]
    const path = []
    let u = v
    while (ancestor[u] !== -1 && ancestor[ancestor[u]] !== -1) {
      path.push(u)
      u = ancestor[u]
    }
    for (let i = path.length - 1; i >= 0; i -= 1) {
      const x = path[i]
      const a = ancestor[x]
      if (a !== -1 && semi[label[a]] < semi[label[x]]) label[x] = label[a]
      if (a !== -1) ancestor[x] = ancestor[a]
    }
    return label[v]
  }
  for (let i = count - 1; i >= 1; i -= 1) {
    const w = vertex[i]
    for (let e = csr.inStart[w]; e < csr.inStart[w + 1]; e += 1) {
      const u = evalNode(csr.inFrom[e])
      if (semi[u] < semi[w]) semi[w] = semi[u]
    }
    const s = vertex[semi[w]]
    bucketNext[w] = bucketHead[s]
    bucketHead[s] = w
    const p = parent[w]
    if (p !== -1) ancestor[w] = p
    // process bucket of parent[w]
    if (p !== -1) {
      let v = bucketHead[p]
      while (v !== -1) {
        const next = bucketNext[v]
        const u = evalNode(v)
        idom[v] = semi[u] < semi[v] ? u : p
        v = next
      }
      bucketHead[p] = -1
    }
  }
  for (let i = 1; i < count; i += 1) {
    const w = vertex[i]
    if (idom[w] !== vertex[semi[w]]) idom[w] = idom[idom[w]]
  }
  idom[root] = root
  return { count, vertex, idom, dfsnum }
}

async function main() {
  const metaInfo = meta()
  console.time('nodes')
  const nodes = await readNodes(metaInfo)
  console.timeEnd('nodes')
  const n = nodes.type.length
  console.log(`nodes=${n}`)

  console.time('strings')
  const strings = await readStrings()
  console.timeEnd('strings')
  console.log(`strings=${strings.length}`)

  console.time('edges')
  const { from, to } = await readEdges(metaInfo, nodes.edges)
  console.timeEnd('edges')
  console.log(`edges=${from.length}`)

  console.time('csr')
  const csr = buildCsr(n, from, to)
  console.timeEnd('csr')

  console.time('dominators')
  const dom = dominators(n, 0, csr)
  console.timeEnd('dominators')
  console.log(`reachable=${dom.count}`)

  const retained = new Float64Array(n)
  for (let i = 0; i < n; i += 1) retained[i] = nodes.size.get(i)
  for (let i = dom.count - 1; i >= 1; i -= 1) {
    const w = dom.vertex[i]
    retained[dom.idom[w]] += retained[w]
  }

  const names = (i) => strings[nodes.name.get(i)] ?? `#${nodes.name.get(i)}`
  const typeName = (i) => metaInfo.typeNames[nodes.type.get(i)] ?? `type#${nodes.type.get(i)}`
  const rootName = (i) => {
    if (i < 0) return '<none>'
    return `${typeName(i)} ${JSON.stringify(names(i))}`
  }

  for (const targetName of targetNames) {
    console.log(`\n## ${JSON.stringify(targetName)} retained-size ranking`)
    const found = []
    for (let i = 0; i < n; i += 1) {
      if (names(i) === targetName) found.push(i)
    }
    console.log(`# matches=${found.length}`)
    found.sort((a, b) => retained[b] - retained[a])
    for (const i of found.slice(0, 3)) {
      console.log(`\nnode ${i} retained=${(retained[i] / 1024 / 1024).toFixed(1)}MB self=${(nodes.size.get(i) / 1024).toFixed(1)}KB`)
      let cur = i
      for (let depth = 0; depth < 20 && cur >= 0; depth += 1) {
        console.log(`${'  '.repeat(depth)}← ${rootName(cur)} retained=${(retained[cur] / 1024 / 1024).toFixed(1)}MB`)
        const next = dom.idom[cur]
        if (next === cur) break
        cur = next
      }
    }
  }

  // top retained objects overall（用于找真正的大块持有者）
  const top = []
  const pushTop = (i) => {
    if (top.length < 20) {
      top.push(i)
      top.sort((a, b) => retained[a] - retained[b])
      return
    }
    if (retained[i] <= retained[top[0]]) return
    top[0] = i
    top.sort((a, b) => retained[a] - retained[b])
  }
  for (let i = 0; i < n; i += 1) pushTop(i)
  console.log('\n## top retained objects overall')
  for (const i of [...top].sort((a, b) => retained[b] - retained[a])) {
    console.log(`\nnode ${i} retained=${(retained[i] / 1024 / 1024).toFixed(1)}MB self=${(nodes.size.get(i) / 1024).toFixed(1)}KB ${rootName(i)}`)
    let cur = i
    for (let depth = 0; depth < 8 && cur >= 0; depth += 1) {
      console.log(`${'  '.repeat(depth)}← ${rootName(cur)}`)
      const next = dom.idom[cur]
      if (next === cur) break
      cur = next
    }
  }
}

main().catch((error) => {
  console.error(`[heap-dominators] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
