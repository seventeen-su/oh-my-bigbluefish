#!/usr/bin/env node
/**
 * 把旧 DSH 会话从 omb / omb-daily 迁到 cordis（创造模式）。
 *
 * 为什么需要离线：DSH 正在写 session.v*.jsonl.zstd 和 session_projcache 记录；
 * 运行中改写会与追加/缓存写竞态。请先关闭 dsh web，再运行：
 *
 *   node scripts/v7-migrate-sessions.mjs --apply
 *
 * 默认 dry-run。--apply 会同时处理两层，缺一层都会让旧会话继续报
 * Unknown agent preset: omb：
 *   1) 日志：首帧 header.agentPreset 改成 cordis；日志里已有选择事件且最后仍
 *      指向 omb/omb-daily 的会话再追加一条 agent-preset/selected: cordis 事件
 *      （不区分空白/已开始）；没有选择事件时改 header 就足够；
 *   2) 投影缓存：只把 record.rows.agentPreset.val 从 omb/omb-daily 改成日志的
 *      effective 值 cordis；缓存身份不包含 preset，不能靠改 header 让它失效。
 *
 * 写入前逐文件备份，临时文件 + rename，写完回读校验。任一文件失败则保留
 * profile 临时 preset-omb 块，避免旧会话立即不可用。可重复执行；已迁移的
 * 会话会被跳过。
 *
 * 路径可用环境变量覆盖：
 *   OMB_SESSIONS_DIR、OMB_CACHE_DIR、OMB_PROFILE_PATCH
 */
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { copyFileSync, existsSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { connect } from 'node:net'

const ZSTD_MAGIC = 0xFD2FB528
const SOURCE = new Set(['omb', 'omb-daily'])
const TARGET = 'cordis'
const STAMP = new Date().toISOString().replace(/[:.]/g, '-')
const APPLY = process.argv.includes('--apply')
const SKIP_PROFILE = process.argv.includes('--skip-profile')
const KEEP_PRESET = process.argv.includes('--keep-preset')
const SKIP_DSH_CHECK = process.argv.includes('--skip-dsh-check')
const sessionsDir = resolve(process.env.OMB_SESSIONS_DIR ?? 'C:\\Users\\<user>\\.dsh\\sessions')
const cacheDir = resolve(
  process.env.OMB_CACHE_DIR ?? 'C:\\Users\\<user>\\.dsh\\storages\\session_projcache\\sessions',
)
const profilePatch = resolve(
  process.env.OMB_PROFILE_PATCH ?? 'C:\\Users\\<user>\\.dsh\\profiles\\web\\cordis.patch.yml',
)

function log(message) {
  process.stdout.write(`[preset-migrate] ${message}\n`)
}

function fail(message) {
  process.stderr.write(`[preset-migrate] ${message}\n`)
  process.exitCode = 1
}

function dshListening() {
  return new Promise(resolveListening => {
    const socket = connect({ host: '127.0.0.1', port: 3080 })
    const done = value => {
      socket.destroy()
      resolveListening(value)
    }
    socket.setTimeout(500, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

function scanFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) throw new Error(`不完整帧头 @${offset}`)
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`帧魔数错误 @${offset}`)
    offset += 4
    const descriptor = buffer.readUInt8(offset); offset += 1
    if ((descriptor & 0x18) !== 0) throw new Error(`保留帧头位 @${offset - 1}`)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    offset += (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    for (;;) {
      if (buffer.length - offset < 3) throw new Error(`不完整块头 @${offset}`)
      const blockHeader = buffer.readUIntLE(offset, 3); offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) throw new Error(`保留块类型 @${offset - 3}`)
      offset += blockType === 0x01 ? 1 : blockSize
      if (lastBlock) break
    }
    if (checksum) offset += 4
    if (offset > buffer.length) throw new Error(`不完整帧 @${start}`)
    frames.push({ start, end: offset })
  }
  return frames
}

function decompressFrame(buffer, frame) {
  return zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8')
}

function parseJsonLines(text, file) {
  const rows = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      rows.push(JSON.parse(line))
    } catch {
      throw new Error(`${file}: 非法 JSON 行`)
    }
  }
  return rows
}

function parseSession(buffer, file) {
  if (buffer.length < 4 || buffer.readUInt32LE(0) !== ZSTD_MAGIC) {
    const rows = parseJsonLines(buffer.toString('utf8'), file)
    if (rows.length === 0 || rows[0]?.type !== 'session') throw new Error(`${file}: 首行不是 session header`)
    const header = rows[0]
    const events = rows.slice(1)
    let effective = header.agentPreset ?? null
    for (const event of events) {
      if (event?.type === 'agent-preset/selected') {
        const next = event.data?.agentPreset
        if (typeof next === 'string') effective = next
      }
    }
    return { raw: true, frames: undefined, header, events, effective }
  }
  const frames = scanFrames(buffer)
  if (frames.length === 0) throw new Error(`${file}: 没有 zstd 帧`)
  const firstLines = parseJsonLines(decompressFrame(buffer, frames[0]), file)
  if (firstLines.length !== 1) throw new Error(`${file}: 首帧不是单一 header`)
  const header = firstLines[0]
  if (header?.type !== 'session') throw new Error(`${file}: 首帧不是 session header`)
  const events = []
  for (let index = 1; index < frames.length; index += 1) {
    events.push(...parseJsonLines(decompressFrame(buffer, frames[index]), file))
  }
  let effective = header.agentPreset ?? null
  for (const event of events) {
    if (event?.type === 'agent-preset/selected') {
      const next = event.data?.agentPreset
      if (typeof next === 'string') effective = next
    }
  }
  return { raw: false, frames, header, events, effective }
}

function rewriteSession(buffer, session) {
  const { header, events, effective } = session
  const headerNeedsChange = SOURCE.has(header.agentPreset)
  // 没有选择事件时 effective 就是 header：改 header 足够。只有日志里已有
  // 选择事件且最后仍指向 omb 时，才必须追加一条新事件覆盖投影。
  const eventNeedsChange = SOURCE.has(effective)
    && events.some(event => event?.type === 'agent-preset/selected')
  if (!headerNeedsChange && !eventNeedsChange) return undefined

  let next = buffer
  if (headerNeedsChange) {
    if (session.raw) {
      const text = buffer.toString('utf8')
      const lineEnd = text.indexOf('\n')
      const firstLine = lineEnd === -1 ? text : text.slice(0, lineEnd)
      const nextLine = firstLine.replace(/("agentPreset"\s*:\s*)"(?:omb|omb-daily)"/, `$1"${TARGET}"`)
      if (nextLine === firstLine) throw new Error('header 中没有可替换的 agentPreset')
      next = Buffer.from(lineEnd === -1 ? nextLine : nextLine + text.slice(lineEnd), 'utf8')
    } else {
      const firstFrame = session.frames[0]
      const plaintext = decompressFrame(buffer, firstFrame)
      const lineEnd = plaintext.indexOf('\n')
      const firstLine = lineEnd === -1 ? plaintext : plaintext.slice(0, lineEnd)
      const nextLine = firstLine.replace(/("agentPreset"\s*:\s*)"(?:omb|omb-daily)"/, `$1"${TARGET}"`)
      if (nextLine === firstLine) throw new Error('header 中没有可替换的 agentPreset')
      const rewritten = lineEnd === -1 ? nextLine : nextLine + plaintext.slice(lineEnd)
      const compressed = zstdCompressSync(Buffer.from(rewritten, 'utf8'), {
        params: { [constants.ZSTD_c_checksumFlag]: 1 },
      })
      next = Buffer.concat([compressed, buffer.subarray(firstFrame.end)])
    }
  }

  if (eventNeedsChange) {
    const seq = events.reduce((max, event) => {
      const value = typeof event?.seq === 'number' && Number.isFinite(event.seq) ? event.seq : -1
      return Math.max(max, value + 1)
    }, 0)
    const event = {
      type: 'agent-preset/selected',
      seq,
      time: Date.now(),
      data: { agentPreset: TARGET },
    }
    const bytes = Buffer.from(`${JSON.stringify(event)}\n`, 'utf8')
    if (session.raw) {
      next = Buffer.concat([next, bytes])
    } else {
      const frame = zstdCompressSync(bytes, { params: { [constants.ZSTD_c_checksumFlag]: 1 } })
      next = Buffer.concat([next, frame])
    }
  }
  return { bytes: next, headerChanged: headerNeedsChange, eventAppended: eventNeedsChange }
}

function uniqueBackup(file, label) {
  let backup = `${file}.bak-${label}-${STAMP}`
  let suffix = 1
  while (existsSync(backup)) {
    backup = `${file}.bak-${label}-${STAMP}-${suffix}`
    suffix += 1
  }
  return backup
}

function atomicWrite(file, bytes) {
  const temp = `${file}.tmp-preset-migrate-${process.pid}`
  writeFileSync(temp, bytes)
  try {
    renameSync(temp, file)
  } catch (error) {
    try {
      unlinkSync(temp)
    } catch (cleanupError) {
      process.stderr.write(
        `[preset-migrate] 临时文件清理失败：${temp}：${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}\n`,
      )
    }
    throw error
  }
}

function writeWithBackup(file, bytes, label) {
  const backup = uniqueBackup(file, label)
  copyFileSync(file, backup)
  atomicWrite(file, bytes)
  return backup
}

function cacheFileFor(id) {
  return join(cacheDir, `${id}.json`)
}

function readCache(id) {
  const file = cacheFileFor(id)
  if (!existsSync(file)) return undefined
  try {
    return { file, value: JSON.parse(readFileSync(file, 'utf8')) }
  } catch (error) {
    throw new Error(`${file}: 缓存 JSON 解析失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

function patchCache(id, file, cache, seq) {
  const row = cache?.record?.rows?.agentPreset
  if (row === undefined) return { status: 'missing-row' }
  if (row.val === TARGET) return { status: 'current' }
  if (!SOURCE.has(row.val)) return { status: 'unexpected', value: row.val }
  if (typeof row.seq === 'number' && typeof seq === 'number' && row.seq > seq) {
    return { status: 'seq-ahead', seq: row.seq }
  }
  row.val = TARGET
  const backup = writeWithBackup(file, Buffer.from(`${JSON.stringify(cache, null, 2)}\n`, 'utf8'), 'agentPreset')
  return { status: 'patched', backup }
}

function collect(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) collect(path, out)
    else if (entry.name.endsWith('.jsonl.zstd') || entry.name.endsWith('.jsonl')) out.push(path)
  }
  return out
}

function removePresetBlock() {
  if (SKIP_PROFILE) return { skipped: true }
  if (!existsSync(profilePatch)) return { skipped: true, reason: 'profile patch 不存在' }
  const text = readFileSync(profilePatch, 'utf8')
  const marker = '# ── 临时恢复：大肥鱼模式'
  const at = text.indexOf(marker)
  if (at === -1) return { skipped: true, reason: '没有临时 preset-omb 块' }
  const next = `${text.slice(0, at).replace(/\s+$/u, '')}\n`
  if (APPLY) {
    const backup = uniqueBackup(profilePatch, 'preset-omb')
    copyFileSync(profilePatch, backup)
    writeFileSync(profilePatch, next, 'utf8')
    log(`已删除 profile 临时 preset-omb 块；备份 ${backup}`)
  } else {
    log('dry-run：将删除 profile 临时 preset-omb 块')
  }
  return { removed: true }
}

async function main() {
  if (!SKIP_DSH_CHECK && await dshListening()) {
    fail('检测到 127.0.0.1:3080 仍在监听。请先关闭 dsh web，或加 --skip-dsh-check（不推荐）。')
    return
  }
  if (!existsSync(sessionsDir)) {
    fail(`sessions 目录不存在：${sessionsDir}`)
    return
  }
  if (!existsSync(cacheDir)) {
    fail(`session_projcache 目录不存在：${cacheDir}`)
    return
  }
  const files = collect(sessionsDir)
  const pending = []
  const failed = []
  let changed = 0
  let cachePatched = 0
  let already = 0

  for (const file of files) {
    try {
      const buffer = readFileSync(file)
      const session = parseSession(buffer, file)
      const headerNeedsChange = SOURCE.has(session.header.agentPreset)
      const eventNeedsChange = SOURCE.has(session.effective)
        && session.events.some(event => event?.type === 'agent-preset/selected')
      const id = typeof session.header.id === 'string' && session.header.id.length > 0
        ? session.header.id
        : basename(dirname(file))
      const cache = readCache(id)
      const cacheRow = cache?.value?.record?.rows?.agentPreset
      const cacheNeedsChange = cacheRow !== undefined && SOURCE.has(cacheRow.val)
      if (!headerNeedsChange && !eventNeedsChange && !cacheNeedsChange) {
        already += 1
        continue
      }
      pending.push({
        file,
        id,
        headerNeedsChange,
        eventNeedsChange,
        cacheNeedsChange,
        cache: cache?.file,
      })
      if (!APPLY) continue

      let next = buffer
      let rewrite
      if (headerNeedsChange || eventNeedsChange) {
        rewrite = rewriteSession(buffer, session)
        if (rewrite === undefined) throw new Error('计划改写但 rewriteSession 返回空')
        next = rewrite.bytes
      }
      if (rewrite !== undefined) {
        writeWithBackup(file, next, 'preset-to-cordis')
        const verify = parseSession(readFileSync(file), file)
        if (SOURCE.has(verify.effective)) throw new Error(`回读后 effective 仍是 ${verify.effective}`)
        changed += 1
      }
      if (cacheNeedsChange) {
        if (cache === undefined) throw new Error('缓存计划改写但缓存文件不存在')
        const patched = patchCache(id, cache.file, cache.value, session.events.length)
        if (patched.status === 'patched') {
          const verifyCache = readCache(id)
          if (verifyCache?.value?.record?.rows?.agentPreset?.val !== TARGET) {
            throw new Error('回读后缓存 agentPreset 不是 cordis')
          }
          cachePatched += 1
        } else if (patched.status === 'unexpected' || patched.status === 'seq-ahead') {
          throw new Error(`缓存未改写：${patched.status} ${JSON.stringify(patched)}`)
        }
      }
    } catch (error) {
      failed.push({ file, error: error instanceof Error ? error.message : String(error) })
    }
  }

  log(`扫描 ${files.length} 个会话文件；待改写 ${pending.length} 个；已一致 ${already} 个；失败 ${failed.length} 个。`)
  for (const item of pending) {
    log(
      `${APPLY ? '改写' : '将改写'} ${relative(sessionsDir, item.file)}`
      + ` header=${item.headerNeedsChange ? 'yes' : 'no'}`
      + ` event=${item.eventNeedsChange ? 'yes' : 'no'}`
      + ` cache=${item.cacheNeedsChange ? 'yes' : 'no'}`,
    )
  }
  for (const item of failed) log(`失败：${relative(sessionsDir, item.file)}：${item.error}`)
  if (!APPLY) {
    log('dry-run 完成；加 --apply 才会写入。')
    return
  }
  log(`已改写 ${changed} 个会话日志，已修正 ${cachePatched} 个投影缓存。`)
  if (failed.length === 0 && KEEP_PRESET !== true) removePresetBlock()
  else if (failed.length > 0) log('有失败文件，保留 preset-omb 块，避免旧会话立即不可用。')
  log('完成。现在可以重新启动 dsh web。')
}

main().catch(error => {
  fail(error instanceof Error ? error.message : String(error))
})
