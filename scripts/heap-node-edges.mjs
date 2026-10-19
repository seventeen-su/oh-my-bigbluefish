#!/usr/bin/env node
/**
 * 打印指定 heap snapshot 节点的出边（属性名/目标类型/目标名），
 * 用于看清 Timeout/Error 这类“GC 根”对象到底挂着什么回调。
 *
 * 用法：node --max-old-space-size=8192 scripts/heap-node-edges.mjs <file> Timeout Error
 */
import { closeSync, createReadStream, openSync, readSync } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'

const file = process.argv[2]
const wantedNames = process.argv.slice(3).length > 0 ? process.argv.slice(3) : ['Timeout', 'Error']
if (!file) process.exit(2)

function prefix() {
  const fd = openSync(file, 'r')
  try {
    const b = Buffer.alloc(256 * 1024)
    const n = readSync(fd, b, 0, b.length, 0)
    return b.subarray(0, n).toString('utf8')
  } finally { closeSync(fd) }
}
function meta() {
  const p = prefix()
  const nf = JSON.parse(p.match(/"node_fields":\s*(\[[^\]]*\])/)[1])
  const ef = JSON.parse(p.match(/"edge_fields":\s*(\[[^\]]*\])/)[1])
  const nt = JSON.parse(`[${p.match(/"node_types":\s*\[\[([^\]]*)\]/)[1]}]`)
  const et = p.match(/"edge_types":\s*\[\[([^\]]*)\]/)
  return { nf, ef, nt, et: et ? JSON.parse(`[${et[1]}]`) : [] }
}
async function scan(onChar, active) {
  const s = createReadStream(file, { highWaterMark: 1 << 20 })
  const d = new StringDecoder('utf8')
  let carry = ''
  for await (const c of s) {
    const t = carry + d.write(c)
    onChar(t)
    carry = active() ? '' : t.slice(-64)
  }
  onChar(carry + d.end())
}
class Grow {
  constructor(T) { this.T = T; this.a = new T(1 << 20); this.n = 0 }
  push(v) {
    if (this.n === this.a.length) { const b = new this.T(Math.floor(this.a.length * 1.5)); b.set(this.a); this.a = b }
    this.a[this.n++] = v
  }
  get(i) { return this.a[i] }
}

async function main() {
  const m = meta()
  const width = m.nf.length
  const typeIdx = m.nf.indexOf('type'), nameIdx = m.nf.indexOf('name'), edgeIdx = m.nf.indexOf('edge_count')
  const types = new Grow(Uint8Array), names = new Grow(Uint32Array), edgeCounts = new Grow(Uint32Array)
  let inNodes = false, nodesDone = false, pos = 0, value = ''
  const node = new Array(width)
  const onNode = (ch) => {
    if (nodesDone) return
    if (!inNodes) {
      const at = ch.indexOf('"nodes":[')
      if (at < 0) return
      inNodes = true; ch = ch.slice(at + '"nodes":['.length)
    }
    for (let i = 0; i < ch.length; i++) {
      const c = ch[i]
      if (c === '-' || (c >= '0' && c <= '9')) { value += c; continue }
      if (value.length) {
        node[pos++] = Number(value); value = ''
        if (pos === width) {
          pos = 0; types.push(node[typeIdx]); names.push(node[nameIdx]); edgeCounts.push(node[edgeIdx])
        }
      }
      if (c === ']') { nodesDone = true; inNodes = false; return }
    }
  }
  await scan(onNode, () => inNodes || nodesDone)
  const n = types.value === undefined ? types.n : types.n
  console.log(`nodes=${n}`)

  const strings = []
  let inStr = false, strDone = false, inS = false, esc = false, ul = 0, uni = '', cur = ''
  const onStr = (ch) => {
    if (strDone) return
    if (!inStr) { const at = ch.indexOf('"strings":['); if (at < 0) return; inStr = true; ch = ch.slice(at + '"strings":['.length) }
    for (let i = 0; i < ch.length; i++) {
      const c = ch[i]
      if (!inS) { if (c === '"') { inS = true; esc = false; cur = '' } else if (c === ']') { strDone = true; return } continue }
      if (ul > 0) { uni += c; ul--; if (ul === 0) { cur += String.fromCharCode(parseInt(uni, 16)); uni = '' } continue }
      if (esc) { esc = false; if (c === 'u') { ul = 4; uni = '' } else if (c === 'n') cur += '\n'; else if (c === 't') cur += '\t'; else if (c === 'r') cur += '\r'; else cur += c; continue }
      if (c === '\\') { esc = true; continue }
      if (c === '"') { inS = false; strings.push(cur); continue }
      cur += c
    }
  }
  await scan(onStr, () => inStr || strDone)
  console.log(`strings=${strings.length}`)

  const nameOf = i => strings[names.get(i)] ?? `#${names.get(i)}`
  const typeOf = i => m.nt[types.get(i)] ?? `type#${types.get(i)}`
  const targets = []
  for (let i = 0; i < n; i++) {
    if (typeOf(i) === 'object' && wantedNames.includes(nameOf(i))) {
      targets.push(i)
      if (targets.length >= 4) break
    }
  }
  console.log(`targets=${targets.map(i => `${i}:${typeOf(i)}:${JSON.stringify(nameOf(i))}`).join(', ')}`)
  if (targets.length === 0) return

  const collect = (sourceSet) => {
    const edgeWidth = m.ef.length
    const toField = m.ef.indexOf('to_node'); const nameField = m.ef.indexOf('name_or_index'); const typeField = m.ef.indexOf('type')
    const result = new Map()
    let source = 0, remaining = edgeCounts.get(0), ep = 0, ev = ''
    const edge = new Array(edgeWidth)
    let started = false, done = false
    while (remaining === 0 && source + 1 < n) { source++; remaining = edgeCounts.get(source) }
    const onEdge = (ch) => {
      if (done) return
      if (!started) { const at = ch.indexOf('"edges":['); if (at < 0) return; started = true; ch = ch.slice(at + '"edges":['.length) }
      for (let i = 0; i < ch.length; i++) {
        const c = ch[i]
        if (c === '-' || (c >= '0' && c <= '9')) { ev += c; continue }
        if (ev.length) {
          edge[ep++] = Number(ev); ev = ''
          if (ep === edgeWidth) {
            ep = 0
            if (sourceSet.has(source)) {
              const list = result.get(source) ?? []; list.push({ type: edge[typeField], name: edge[nameField], to: Math.floor(edge[toField] / width) })
              result.set(source, list)
            }
            remaining--
            while (remaining === 0 && source + 1 < n) { source++; remaining = edgeCounts.get(source) }
          }
        }
        if (c === ']') { done = true; return }
      }
    }
    return scan(onEdge, () => started || done).then(() => result)
  }

  let edges = await collect(new Set(targets))
  // 第二遍：目标 closure 的出边（找 shared/function info）
  const closures = new Set()
  for (const list of edges.values()) for (const e of list) if (typeOf(e.to) === 'closure') closures.add(e.to)
  if (closures.size > 0) {
    const more = await collect(closures)
    edges = new Map([...edges, ...more])
  }
  for (const t of targets) {
    console.log(`\n## ${typeOf(t)} ${JSON.stringify(nameOf(t))} node=${t}`)
    for (const e of (edges.get(t) ?? []).slice(0, 25)) {
      const edgeType = m.et[e.type] ?? `edge#${e.type}`
      const isProp = edgeType === 'property' || edgeType === 'shortcut'
      const label = isProp ? (strings[e.name] ?? `#${e.name}`) : `${edgeType}:${e.name}`
      console.log(`  - ${label} → ${typeOf(e.to)} ${JSON.stringify(nameOf(e.to))} (node ${e.to})`)
    }
    if (closures.size > 0) {
      for (const e of (edges.get(t) ?? [])) {
        if (typeOf(e.to) !== 'closure') continue
        console.log(`  closure ${e.to} edges:`)
        for (const c of (edges.get(e.to) ?? []).slice(0, 15)) {
          const edgeType = m.et[c.type] ?? `edge#${c.type}`
          const isProp = edgeType === 'property' || edgeType === 'shortcut'
          const label = isProp ? (strings[c.name] ?? `#${c.name}`) : `${edgeType}:${c.name}`
          console.log(`    · ${label} → ${typeOf(c.to)} ${JSON.stringify(nameOf(c.to))} (node ${c.to})`)
        }
      }
    }
  }
}
main().catch(e => { console.error(e?.message ?? e); process.exit(1) })
