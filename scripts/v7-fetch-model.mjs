#!/usr/bin/env node
/**
 * 获取 BGE-small-zh-v1.5 量化 ONNX（MIT）。默认落到 `models/bge-small-zh-v1.5/`。
 * 只下载；不修改文件名（外部数据文件名写在 ONNX 图内部）。
 */
import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TARGET = process.env.OMB_EMBEDDING_MODEL ?? join(ROOT, 'models', 'bge-small-zh-v1.5')
const FILES = [
  {
    url: 'https://huggingface.co/onnx-community/bge-small-zh-v1.5-ONNX/resolve/main/onnx/model_quantized.onnx',
    name: 'model_quantized.onnx',
    bytes: 168002,
  },
  {
    url: 'https://huggingface.co/onnx-community/bge-small-zh-v1.5-ONNX/resolve/main/onnx/model_quantized.onnx_data',
    name: 'model_quantized.onnx_data',
    bytes: 23_774_208,
  },
  {
    url: 'https://huggingface.co/BAAI/bge-small-zh-v1.5/resolve/main/vocab.txt',
    name: 'vocab.txt',
    bytes: 109_540,
  },
]

async function download(file) {
  const response = await fetch(file.url, { redirect: 'follow' })
  if (!response.ok) throw new Error(`${file.name}: HTTP ${response.status}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.byteLength !== file.bytes) {
    throw new Error(`${file.name}: 大小 ${buffer.byteLength} != 预期 ${file.bytes}`)
  }
  writeFileSync(join(TARGET, file.name), buffer)
  console.log(`[v7:model] ${file.name} ${buffer.byteLength} bytes`)
}

mkdirSync(TARGET, { recursive: true })
for (const file of FILES) {
  try {
    const existing = statSync(join(TARGET, file.name))
    if (existing.size === file.bytes) {
      console.log(`[v7:model] 跳过已存在 ${file.name}`)
      continue
    }
  } catch {
    // 不存在则下载。
  }
  await download(file)
}
console.log(`[v7:model] 完成：${TARGET}`)
