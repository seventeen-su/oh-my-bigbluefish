// 向量模型获取脚本（部署动作，一次即可）：把 BGE-small-zh-v1.5（ONNX 量化版）落到数据根。
//
// ## 为什么需要它
//
// 神经嵌入权重约 24MB（量化）/ 95MB（fp32），不适合进 git（clone 变慢、历史膨胀、无法 diff）。
// 而 `modules/memory/onnx.ts` **拒绝拿别的模型顶替**（它自己写着"绝不静默换语义"），
// 也**拒绝降级维度**——所以"没有权重"这件事只能靠把权重放对位置来解决，
// 没有"随便找个模型顶上"这条路。这个脚本就是那条唯一的正道。
//
// ## 目录与文件名（**不可自作聪明**）
//
// 落点是 `<仓库根>/models/bge-small-zh-v1.5/`，与 `modules/memory/onnx.ts` 的解析顺序对齐
// （① 显式 modelDir ② `$OMB_EMBEDDING_MODEL` ③ `<数据根>/models/bge-small-zh-v1.5`）。
//
// **外部权重数据的文件名被写进 ONNX 图内部**（图里记录的是 `model_quantized.onnx_data`），
// 改名会让推理会话创建直接失败。所以本脚本只把上游的 `onnx/` 前缀去掉，绝不重命名。
//
// ## 三个文件，不是一个
//
// 权重之外还必须有 `vocab.txt`：本仓库的分词器是自实现的 WordPiece，只依赖词表
// （`modules/memory/onnx.ts` 的 `WordPieceTokenizer.fromFile`，缺 `[CLS]`/`[SEP]` 即拒绝装载）。
// `onnx-community/bge-small-zh-v1.5-ONNX` **不含**词表，词表在原始仓库 `BAAI/bge-small-zh-v1.5`。
// 两头取，缺一不可——少一个词表的模型目录会被如实判为"不完整"，而不是被将就使用。
//
// ## 完整性
//
// 每个文件的期望 sha256 有两个来源，优先级如下：
//   ① 上游 LFS 指针（`GET /api/models/<repo>/tree/main/<dir>` 的 `lfs.oid`）——权威；
//   ② 本文件内置的常量（词表用它，因为 `vocab.txt` 不是 LFS 文件，API 不给 oid）。
// 词表常量是**独立核对过的**：与 git 历史中曾提交过的同一文件逐字节一致
// （sha256 `45bbac6b…`，109540 字节，见 v2 时代的 `THIRD-PARTY-NOTICES.md` §1.1）。
// 校验不通过 → 删除临时文件并报错，**绝不静默留半份模型**。
//
// 用法：
//   node scripts/fetch-embedding-model.mjs                  # 量化版（默认，约 24MB）
//   node scripts/fetch-embedding-model.mjs --variant fp32   # 未量化（约 95MB，质量略高）
//   node scripts/fetch-embedding-model.mjs --dir <目录>      # 自定义落点（等价于设 OMB_EMBEDDING_MODEL）
//   node scripts/fetch-embedding-model.mjs --verify          # 对已存在文件强制重新校验
// 环境变量：
//   OMB_MODEL_MIRROR=https://hf-mirror.com                   # 镜像前缀（大陆网络）
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/** 仓库根（本文件在 `<仓库根>/scripts/` 下）。 */
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * 默认落点。
 *
 * 与 `modules/memory/onnx.ts` 的解析顺序对齐：数据根 = 仓库根，
 * 于是"脚本下载的位置"与"模块去找的位置"是同一个，不需要额外设环境变量。
 * 状态面报"权重目录不存在"时会打印它试过的路径——那句里就是这里。
 */
const DEFAULT_DIR = join(REPO_ROOT, 'models', 'bge-small-zh-v1.5')

/** 权重来源：社区 ONNX 转换（MIT；底层模型 `BAAI/bge-small-zh-v1.5`）。 */
const WEIGHT_REPO = 'onnx-community/bge-small-zh-v1.5-ONNX'

/** 词表来源：原始模型仓库根目录（上面的 ONNX 仓库不含词表）。 */
const VOCAB_REPO = 'BAAI/bge-small-zh-v1.5'
const VOCAB_REMOTE = 'vocab.txt'

/**
 * 词表的期望 sha256。
 *
 * 为什么硬编码：`vocab.txt` 不是 LFS 文件，上游 API 不给 `lfs.oid`，
 * 于是它成了唯一一个"没有上游哈希可比"的文件——而那正是最需要校验的一个：
 * 词表错一位，全部 token id 都会错位，表现为"检索结果莫名其妙"，而不是报错。
 * 该值与 git 历史中曾提交过的同一文件逐字节一致，可独立复核。
 */
const VOCAB_SHA256 = '45bbac6b341c319adc98a532532882e91a9cefc0329aa57bac9ae761c27b291c'
const VOCAB_SIZE = 109540

/**
 * 变体 → 上游文件（落盘时去掉 `onnx/` 前缀）。
 *
 * 只有这两组能被 `modules/memory/onnx.ts` 接受（它的 `MODEL_PAIRS` 是白名单）。
 * 上游还有 fp16 / q4 / q4f16 三种，体积介于两者之间，但**本仓库不认**——
 * 列在这里只会让人以为可以用。要支持得先改模块的白名单，不是改这个脚本。
 */
const VARIANTS = {
  quantized: ['onnx/model_quantized.onnx', 'onnx/model_quantized.onnx_data'],
  fp32: ['onnx/model.onnx', 'onnx/model.onnx_data'],
}

function parseArgs(argv) {
  let dir = DEFAULT_DIR
  let variant = 'quantized'
  let verify = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dir') {
      const v = argv[++i]
      if (v === undefined || v.length === 0) throw new Error('--dir 需要目录参数')
      dir = resolve(v)
    } else if (a === '--variant') {
      const v = argv[++i]
      if (v !== 'quantized' && v !== 'fp32') throw new Error(`--variant 只支持 quantized|fp32（收到 ${String(v)}）`)
      variant = v
    } else if (a === '--verify') {
      verify = true
    } else if (a === '--help' || a === '-h') {
      console.log(
        '用法: node scripts/fetch-embedding-model.mjs [--dir <目录>] [--variant quantized|fp32] [--verify]\n'
        + '环境变量: OMB_MODEL_MIRROR（镜像前缀，如 https://hf-mirror.com）',
      )
      process.exit(0)
    } else {
      throw new Error(`未知参数: ${a}`)
    }
  }
  return { dir, variant, verify }
}

/** 镜像前缀；未设则直连 Hugging Face。 */
function mirrorBase() {
  const m = process.env.OMB_MODEL_MIRROR
  return typeof m === 'string' && m.length > 0 ? m.replace(/\/+$/, '') : 'https://huggingface.co'
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function human(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)}KB`
  return `${bytes}B`
}

/**
 * 取上游目录的 LFS 期望值（路径 → {sha256, size}）。
 *
 * **为什么不用 `resolve/...` 的响应体**：Hugging Face 对 LFS 文件在 `resolve/main/<路径>`
 * 上直接返回二进制本体（`application/octet-stream`），不是 `oid sha256:…` 指针文本。
 * 拿响应体当指针解析，得到的永远是 undefined → 校验退化成"只比大小"，
 * 同尺寸的损坏或替换会被静默接受。正确来源是仓库文件列表 API。
 *
 * 镜像不提供该 API → 返回空表，调用方如实说明"无权威哈希"，而不是假装校验过。
 */
async function fetchExpectations(dir) {
  const map = new Map()
  try {
    const res = await fetch(`${mirrorBase()}/api/models/${WEIGHT_REPO}/tree/main/${dir}`, { redirect: 'follow' })
    if (res.ok) {
      const items = await res.json()
      for (const item of items) {
        if (typeof item.path !== 'string') continue
        const oid = typeof item.lfs?.oid === 'string' && /^[0-9a-f]{64}$/.test(item.lfs.oid) ? item.lfs.oid : undefined
        const size = typeof item.lfs?.size === 'number' ? item.lfs.size
          : typeof item.size === 'number' ? item.size : undefined
        map.set(item.path, { ...(oid === undefined ? {} : { sha256: oid }), ...(size === undefined ? {} : { size }) })
      }
    }
  } catch {
    // 网络失败或镜像不提供该 API → 空表；调用方按"无权威哈希"如实处理
  }
  return map
}

/** 单文件下载：流式 → 临时文件 → 校验 → rename。已存在且校验通过则跳过。 */
async function fetchFile(url, dest, expect, forceVerify) {
  if (existsSync(dest)) {
    const size = statSync(dest).size
    const sizeOk = expect.size === undefined ? size > 0 : size === expect.size
    if (sizeOk && expect.sha256 !== undefined) {
      if (sha256File(dest) === expect.sha256) return 'skipped'
      console.log(`  校验失败，重新下载：${dest.split(/[\\/]/).pop()}`)
    } else if (sizeOk) {
      if (forceVerify) console.log(`  无权威哈希可比，按大小视为完整：${dest.split(/[\\/]/).pop()}`)
      return 'skipped'
    }
  }
  mkdirSync(dirname(dest), { recursive: true })
  const tmp = `${dest}.part`
  try {
    const res = await fetch(url, { redirect: 'follow' })
    if (!res.ok || res.body === null) throw new Error(`HTTP ${res.status}`)
    await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp))
    const got = statSync(tmp).size
    if (expect.size !== undefined && got !== expect.size) {
      throw new Error(`大小不符：期望 ${expect.size}，实得 ${got}`)
    }
    if (expect.sha256 !== undefined) {
      const actual = sha256File(tmp)
      if (actual !== expect.sha256) throw new Error(`sha256 不符：期望 ${expect.sha256}，实得 ${actual}`)
    }
    renameSync(tmp, dest)
    return 'downloaded'
  } catch (error) {
    // 绝不静默留半份模型：半份权重会让 ONNX 会话创建以看不懂的方式失败
    try { rmSync(tmp, { force: true }) } catch { /* 清理失败不遮蔽真正的错误 */ }
    throw error
  }
}

async function main() {
  const { dir, variant, verify } = parseArgs(process.argv.slice(2))
  const remotePaths = VARIANTS[variant]
  console.log(`OMB 向量模型获取：${variant}`)
  console.log(`  来源  ${mirrorBase()}/${WEIGHT_REPO}`)
  console.log(`  词表  ${mirrorBase()}/${VOCAB_REPO}/${VOCAB_REMOTE}`)
  console.log(`  落点  ${dir}`)

  const expectations = await fetchExpectations('onnx')
  if (expectations.size === 0) {
    console.log('  ⚠ 拿不到上游哈希（镜像不提供文件列表 API 或网络受限）→ 只能按大小校验，如实说明')
  }

  const jobs = remotePaths.map((remote) => ({
    remote,
    dest: join(dir, remote.replace(/^onnx\//, '')),
    expect: expectations.get(remote) ?? {},
    url: `${mirrorBase()}/${WEIGHT_REPO}/resolve/main/${remote}`,
  }))
  jobs.push({
    remote: VOCAB_REMOTE,
    dest: join(dir, VOCAB_REMOTE),
    // 词表的内置常量优先于 API（API 对它不给 oid）
    expect: { sha256: VOCAB_SHA256, size: VOCAB_SIZE },
    url: `${mirrorBase()}/${VOCAB_REPO}/resolve/main/${VOCAB_REMOTE}`,
  })

  let downloaded = 0
  for (const job of jobs) {
    const name = job.dest.split(/[\\/]/).pop()
    process.stdout.write(`  ${name} … `)
    const outcome = await fetchFile(job.url, job.dest, job.expect, verify)
    if (outcome === 'skipped') {
      console.log('已存在且校验通过，跳过')
    } else {
      downloaded += 1
      console.log(`完成（${human(statSync(job.dest).size)}）`)
    }
  }

  console.log(`\n就绪：${dir}`)
  console.log(`  ${downloaded} 个文件已下载，${jobs.length - downloaded} 个已存在`)
  console.log('  生效方式：重启 dsh（模块在挂载时装载嵌入器），然后看 omb_status 的 omb-memory-vector 行')
  console.log('  预期：通道从「哈希词袋 hash-bow-256」变为「bge-small-zh-v1.5-512」')
}

main().catch((error) => {
  console.error(`\n失败：${error instanceof Error ? error.message : String(error)}`)
  console.error('未留下半份模型（临时文件已清理）。可设 OMB_MODEL_MIRROR=https://hf-mirror.com 后重试。')
  process.exit(1)
})
