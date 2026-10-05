/**
 * 心跳落盘的**边界与开关**。
 *
 * ## 为什么这几条判据必须有
 *
 * 旧实现无条件写、每回合写、永不轮转：实测 `.omb-heartbeat.jsonl` 在 4.6 天长到
 * **19,779,245 字节**，抽样 66,807 行里 78.7% 来自"每回合/每订阅"（`session-event`
 * 33,090 行、`adopt-on` 15,579 行）。代价是同步写盘 + 无上限磁盘占用 + 诊断价值被淹没。
 *
 * 所以这一组钉住四件事：
 * ① **默认关**（不设 `OMB_HEARTBEAT` 时零 IO）；
 * ② 设了路径才写，且**每进程只解析一次**（改环境不再影响已生效的落点）；
 * ③ 开启状态下有**硬上界**：超限轮转一次，旧文件进 `.1`；
 * ④ 落点不可写时**绝不抛**（H-1：诊断不得影响功能）。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { heartbeat, heartbeatSink, resetHeartbeat } from '../../kernel/hostEntry.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'omb-heartbeat-'))
})

afterEach(() => {
  delete process.env['OMB_HEARTBEAT']
  resetHeartbeat()
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // 清理失败不影响判据
  }
})

describe('心跳默认关闭、显式开启', () => {
  it('不设 OMB_HEARTBEAT：不写任何文件（sink 为 undefined，零 IO）', () => {
    delete process.env['OMB_HEARTBEAT']
    resetHeartbeat()
    heartbeat('should-not-write', { n: 1 })
    heartbeat('should-not-write', { n: 2 })
    expect(heartbeatSink()).toBeUndefined()
    expect(existsSync(join(dir, '.omb-heartbeat.jsonl'))).toBe(false)
  })

  it('设成路径即开启：写入该路径，一行一条，含 stage 与载荷', () => {
    const file = join(dir, 'hb.jsonl')
    process.env['OMB_HEARTBEAT'] = file
    resetHeartbeat()
    heartbeat('kernel-apply', { readyPublished: true })
    expect(existsSync(file)).toBe(true)
    const lines = readFileSync(file, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(1)
    const record = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>
    expect(record['stage']).toBe('kernel-apply')
    expect(record['readyPublished']).toBe(true)
    expect(typeof record['at']).toBe('string')
  })

  it('`0` / `off` / `false` 都当作关闭（三态里的假值）', () => {
    for (const flag of ['0', 'off', 'false', 'no', '']) {
      process.env['OMB_HEARTBEAT'] = flag
      resetHeartbeat()
      heartbeat('x')
      expect(heartbeatSink(), `flag=${flag} 必须视为关闭`).toBeUndefined()
    }
  })

  it('落点每进程只解析一次：改环境不影响已生效的落点（缓存生效）', () => {
    const first = join(dir, 'first.jsonl')
    const second = join(dir, 'second.jsonl')
    process.env['OMB_HEARTBEAT'] = first
    resetHeartbeat()
    heartbeat('a')
    process.env['OMB_HEARTBEAT'] = second
    heartbeat('b') // 不 reset → 仍写 first
    expect(heartbeatSink()?.file).toBe(first)
    expect(existsSync(second)).toBe(false)
    expect(readFileSync(first, 'utf8').trim().split('\n')).toHaveLength(2)
  })
})

describe('开启状态下的硬上界', () => {
  it('已有文件超过上限时轮转一次：旧内容进 .1，新文件从头开始', () => {
    const file = join(dir, 'hb.jsonl')
    const cap = 4 * 1024 * 1024
    writeFileSync(file, 'x'.repeat(cap + 1))
    process.env['OMB_HEARTBEAT'] = file
    resetHeartbeat()
    heartbeat('after-rotate')
    expect(existsSync(`${file}.1`), '超限后必须留下 .1 备份').toBe(true)
    expect(statSync(`${file}.1`).size).toBeGreaterThan(cap)
    expect(statSync(file).size).toBeLessThan(1024)
    expect(readFileSync(file, 'utf8')).toContain('after-rotate')
  })

  it('未超限时**不**轮转（不能每写一行就把日志搬一次）', () => {
    const file = join(dir, 'hb.jsonl')
    process.env['OMB_HEARTBEAT'] = file
    resetHeartbeat()
    heartbeat('a')
    heartbeat('b')
    expect(existsSync(`${file}.1`)).toBe(false)
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(2)
  })
})

describe('诊断绝不反过来打断功能', () => {
  it('落点不可写（指向一个目录）时不抛，且后续仍可经 reset 切到好落点', () => {
    process.env['OMB_HEARTBEAT'] = dir // 目录 → appendFileSync 抛 EISDIR
    resetHeartbeat()
    expect(() => heartbeat('boom')).not.toThrow()

    const good = join(dir, 'good.jsonl')
    process.env['OMB_HEARTBEAT'] = good
    resetHeartbeat()
    heartbeat('ok')
    expect(readFileSync(good, 'utf8')).toContain('ok')
  })
})
