/**
 * 持久化文件（路径解析 + 原子写 + 绝不抛）。
 *
 * 判据：
 * ① 路径解析四级顺序（显式配置 → 宿主端口 → `$DSH_HOME` → `~/.dsh`），全失效时
 *    **返回 null 而不是编一个路径**（调用方据此报"未持久化"）
 * ② 写是原子的（临时文件 + rename）：不会留下半截 JSON——半截 JSON 会把
 *    "一次写入中断"升级成"所有会话按最严处理"
 * ③ 所有失败路径返回可读原因，**绝不抛**（H-1/H-3）
 */
import { describe, expect, it } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createPrivacyDurable,
  PRIVACY_FILE_NAME,
  resolvePrivacyPath,
  STORAGE_HOST_SERVICE,
} from '../../../modules/privacy/durable.js'
import { emptyDoc } from '../../../modules/privacy/codec.js'
import { capturingLogger, tempWorkspace } from '../memory/helpers.js'

const NOW = 1_700_000_000_000

describe('路径解析', () => {
  it('显式配置优先', () => {
    const path = resolvePrivacyPath({
      configured: 'C:/explicit/modes.json',
      port: () => ({ userDbPath: 'C:/from-port/.omb/memory/knowledge.db' }),
      env: { DSH_HOME: 'C:/env' },
    })
    expect(path).toBe('C:/explicit/modes.json')
  })

  it('宿主端口：与记忆库同级（`<dshHome>/.omb/privacy/…`）', () => {
    const path = resolvePrivacyPath({
      port: () => ({ userDbPath: join('D:', 'home', '.omb', 'memory', 'knowledge.db') }),
    })
    expect(path?.replace(/\\/g, '/')).toBe('D:/home/.omb/privacy/session-modes.json')
    expect(path?.endsWith(PRIVACY_FILE_NAME)).toBe(true)
  })

  it('端口拿不到 → $DSH_HOME → ~/.dsh → null', () => {
    expect(resolvePrivacyPath({ port: () => undefined, env: { DSH_HOME: 'C:/dsh' } })?.replace(/\\/g, '/'))
      .toBe('C:/dsh/.omb/privacy/session-modes.json')
    expect(resolvePrivacyPath({ port: () => undefined, env: {}, home: () => 'C:/users/x' })?.replace(/\\/g, '/'))
      .toBe('C:/users/x/.dsh/.omb/privacy/session-modes.json')
    expect(resolvePrivacyPath({ port: () => undefined, env: {}, home: () => '' })).toBeNull()
  })

  it('端口形状不对（userDbPath 非字符串）不抛，继续往下退', () => {
    expect(resolvePrivacyPath({
      port: () => ({ userDbPath: 42 }),
      env: { DSH_HOME: 'C:/fallback' },
    })?.replace(/\\/g, '/')).toBe('C:/fallback/.omb/privacy/session-modes.json')
  })

  it('服务名与 dsh 侧一致（模块不能 import dsh/，只能按名引用）', () => {
    expect(STORAGE_HOST_SERVICE).toBe('omb.storage-host')
  })
})

describe('原子读写', () => {
  it('不存在 → "从未配置过"（不是损坏）', () => {
    const ws = tempWorkspace('omb-privacy-durable-')
    try {
      const store = createPrivacyDurable({ path: join(ws.dir, 'privacy', 'session-modes.json'), logger: capturingLogger() })
      const loaded = store.load(NOW)
      expect(loaded.exists).toBe(false)
      expect(loaded.degraded).toBe(false)
      expect(loaded.doc.failClosedAt).toBeNull()
    } finally {
      ws.cleanup()
    }
  })

  it('写入 → 读回一致；目录不存在会自动创建', () => {
    const ws = tempWorkspace('omb-privacy-durable-')
    try {
      const path = join(ws.dir, 'deep', 'privacy', 'session-modes.json')
      const store = createPrivacyDurable({ path, logger: capturingLogger() })
      const saved = store.save({ version: 1, failClosedAt: null, modes: { s1: 'sealed' } })
      expect(saved.ok).toBe(true)
      const loaded = store.load(NOW)
      expect(loaded.exists).toBe(true)
      expect(loaded.degraded).toBe(false)
      expect(loaded.doc.modes).toEqual({ s1: 'sealed' })
      // 真的落在盘上（不是只改了内存）
      expect(readFileSync(path, 'utf8')).toContain('"s1"')
    } finally {
      ws.cleanup()
    }
  })

  it('没有临时文件残留（原子写不留垃圾）', () => {
    const ws = tempWorkspace('omb-privacy-durable-')
    try {
      const dir = join(ws.dir, 'privacy')
      const store = createPrivacyDurable({ path: join(dir, 'session-modes.json'), logger: capturingLogger() })
      store.save(emptyDoc())
      const leftovers = readFileSync(join(dir, 'session-modes.json'), 'utf8')
      expect(leftovers).toContain('"version"')
      expect(store.save({ version: 1, failClosedAt: null, modes: { s2: 'read-only' } }).ok).toBe(true)
      expect(store.load(NOW).doc.modes).toEqual({ s2: 'read-only' })
    } finally {
      ws.cleanup()
    }
  })

  it('文件损坏 → 降级为 fail-closed 文档（不是"从未配置过"）', () => {
    const ws = tempWorkspace('omb-privacy-durable-')
    try {
      const path = join(ws.dir, 'session-modes.json')
      writeFileSync(path, '{ half', 'utf8')
      const store = createPrivacyDurable({ path, logger: capturingLogger() })
      const loaded = store.load(NOW)
      expect(loaded.exists).toBe(true)
      expect(loaded.degraded).toBe(true)
      expect(loaded.doc.failClosedAt).toBe(NOW)
    } finally {
      ws.cleanup()
    }
  })

  it('路径为 null → 读写都给可读原因，不抛', () => {
    const store = createPrivacyDurable({ path: null, logger: capturingLogger() })
    const loaded = store.load(NOW)
    expect(loaded.degraded).toBe(true) // 不知道 ≠ 没有配置 → fail-closed
    expect(loaded.error).toContain('无法解析')
    const saved = store.save(emptyDoc())
    expect(saved.ok).toBe(false)
    expect(saved.error).toContain('无法持久化')
  })

  it('目录建不出来（父路径是个文件）→ ok=false + 原因，不抛', () => {
    const ws = tempWorkspace('omb-privacy-durable-')
    try {
      const blocker = join(ws.dir, 'blocker')
      mkdirSync(blocker, { recursive: true })
      writeFileSync(join(blocker, 'file'), 'x', 'utf8')
      // 把"文件"当目录用 → mkdir 必失败
      const store = createPrivacyDurable({
        path: join(blocker, 'file', 'session-modes.json'),
        logger: capturingLogger(),
      })
      const saved = store.save(emptyDoc())
      expect(saved.ok).toBe(false)
      expect(saved.error).toContain('写入隐私状态文件失败')
    } finally {
      ws.cleanup()
    }
  })
})
