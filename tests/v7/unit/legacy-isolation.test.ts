import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = new URL('../../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const TARGETS = ['packages/v7/src', 'plugin/v7', 'scripts']

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...await sourceFiles(path))
    else if (entry.isFile() && /\.(?:ts|mjs|js)$/.test(entry.name)) files.push(path)
  }
  return files
}

describe('docs/legacy 与 .research 隔离', () => {
  it('生产代码/脚本不 import 历史文档或研究账本', async () => {
    const offenders: string[] = []
    for (const target of TARGETS) {
      const dir = join(ROOT, target)
      for (const file of await sourceFiles(dir)) {
        const text = await readFile(file, 'utf8')
        if (/(?:from|import\s*\()\s*['"][^'"]*(?:docs\/legacy|\.research)/.test(text)) {
          offenders.push(relative(ROOT, file).replaceAll('\\', '/'))
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
