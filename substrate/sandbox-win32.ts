// layer 0（substrate/）：Windows 受限执行通道实现（WRITE_RESTRICTED 受限令牌 + koffi FFI）。
//
// 拆分说明（已知问题《外核平台抽象设计》：沙盒模块改为惰性加载平台实现，Linux 不触碰 win32 模块与
// koffi）：本文件是**平台实现**，由 substrate/sandbox.ts 的 `runRestricted` 在 Windows 上**动态 import**
// 后才加载——非 Windows 平台上 win32-*.js 与 koffi 完全不会被载入。语义与拆分前逐字一致。
// 只 import node: 内置、koffi（经 win32-ffi）与 substrate 内文件（CONVENTIONS §4）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as abi from './win32-abi.js'
import { allocPtrSlot, decodePtr, isNullPtr, throwLastError, throwWin32, win32Sync } from './win32-ffi.js'
import type { NativePtr, Win32Bindings } from './win32-ffi.js'
import { grantWrite, revokeWrite } from './win32-acl.js'
import { createRestrictedToken, findLogonSid, makeWellKnownSid, openCurrentProcessToken, setTokenDefaultDaclGrant } from './win32-token.js'
import { readExitCode, spawnRestrictedInherited, terminateJob } from './win32-spawn.js'
import type { SpawnedRestricted } from './win32-spawn.js'
import { tempWriteSid, workspaceWriteSid } from './win32-sid.js'
// 受限子进程
// ---------------------------------------------------------------------------

export interface RunRestrictedOptions {
  /** 受限子进程要执行的脚本（绝对路径；node 以 .cjs/.js 运行，宿主写入，子进程只需读） */
  script: string
  /** 传给脚本的额外 argv */
  args?: string[]
  /** 子进程工作目录（绝对路径） */
  cwd: string
  /** 写允许目录集合（绝对路径，须已存在且为调用者所有）；写能力精确覆盖该集合 */
  writableDirs: string[]
  /** 私有 temp 目录（缺省自建：os.tmpdir() 下 mkdtemp，运行后删除；提供时须已存在，不删除） */
  tempDir?: string
  /** 结果文件路径：经 OMB_SANDBOX_RESULT_FILE 环境变量传给子进程（脚本写结果到 writableDirs 内路径） */
  resultFile?: string
  /** 超时毫秒（缺省 60000）；超时后 TerminateJobObject 杀整棵进程树 */
  timeoutMs?: number
}

export interface RunRestrictedResult {
  /** 退出码；timedOut 时恒为 null（被超时杀掉，退出码无意义） */
  code: number | null
  /** true = 超时被杀（TerminateJobObject 杀 job 树） */
  timedOut: boolean
}

const DEFAULT_TIMEOUT_MS = 60_000
/** GetExitCodeProcess 轮询间隔 */
const POLL_MS = 25
/** 超时 kill 后等待真正退出的上限（防 kill 失败挂死） */
const KILL_DRAIN_MS = 5_000

/** 规范化目录（realpath；失败回退 resolve） */
function canonicalDir(p: string): string {
  try {
    return fs.realpathSync.native(p)
  } catch {
    return path.resolve(p)
  }
}

/** SID 字符串 → 指针（ConvertStringSidToSidW，LocalAlloc，调用方负责 LocalFree） */
function parseSid(api: Win32Bindings, sid: string): NativePtr {
  const slot = allocPtrSlot()
  if (api.convertStringSidToSidW(sid, slot) === 0) throwLastError(api, 'ConvertStringSidToSidW', sid)
  const ptr = decodePtr(slot)
  if (ptr === null) throwWin32(api, 'ConvertStringSidToSidW', api.getLastError(), sid)
  return ptr
}

/** 改写子进程环境（TMP/TEMP → 私有 temp；结果文件路径）；返回原值快照用于恢复 */
function rewriteChildEnv(tempDir: string, resultFile: string | undefined): Array<[string, string | undefined]> {
  const previous: Array<[string, string | undefined]> = [
    ['TMP', process.env.TMP],
    ['TEMP', process.env.TEMP],
  ]
  process.env.TMP = tempDir
  process.env.TEMP = tempDir
  if (resultFile !== undefined) {
    previous.push(['OMB_SANDBOX_RESULT_FILE', process.env.OMB_SANDBOX_RESULT_FILE])
    process.env.OMB_SANDBOX_RESULT_FILE = resultFile
  }
  return previous
}

/** 恢复环境（原值回写；原值未设置则删除） */
function restoreEnv(previous: Array<[string, string | undefined]>): void {
  for (const [name, value] of previous) {
    if (value === undefined) {
      delete process.env[name]
    } else {
      process.env[name] = value
    }
  }
}

/** 轮询退出码；超时 TerminateJobObject 杀 job 树并等真正退出（KILL_DRAIN_MS 上限） */
async function waitExit(api: Win32Bindings, spawned: SpawnedRestricted, timeoutMs: number): Promise<RunRestrictedResult> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const code = readExitCode(api, spawned.process)
    if (code !== abi.STILL_ACTIVE) return { code, timedOut: false }
    if (Date.now() >= deadline) {
      terminateJob(api, spawned.job, spawned.process, 1)
      const killDeadline = Date.now() + KILL_DRAIN_MS
      for (;;) {
        const afterKill = readExitCode(api, spawned.process)
        if (afterKill !== abi.STILL_ACTIVE) return { code: null, timedOut: true }
        if (Date.now() >= killDeadline) {
          throw new Error('sandbox: 子进程在 TerminateJobObject 后仍未退出（kill 失败）')
        }
        await new Promise<void>((resolve) => setTimeout(resolve, POLL_MS))
      }
    }
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_MS))
  }
}

/**
 * 在 WRITE_RESTRICTED 受限令牌下运行脚本（node <script> <args...>，cwd=opts.cwd）。
 * 步骤：writableDirs/temp 授权 ACE → 令牌链（openCurrentProcessToken → findLogonSid →
 * CreateRestrictedToken([logon, Everyone, writeSid, tempSid]) → setTokenDefaultDaclGrant）→
 * 环境改写 → CreateProcessAsUserW（kill-on-close job）→ 轮询退出码/超时杀 → 清理。
 * 失败即抛（fail-closed）；writableDirs ACE 常驻，私有 temp ACE 撤销 + 自建目录删除。
 * 调用方应在执行前经 sandboxStatus() 探测通道可用性（P3/D5：不可用 → 上层降级记录跳过）。
 */
export async function runRestricted(opts: RunRestrictedOptions): Promise<RunRestrictedResult> {
  const script = path.resolve(opts.script)
  if (!fs.existsSync(script) || !fs.statSync(script).isFile()) {
    throw new Error(`runRestricted: 脚本不存在或不是文件: ${script}`)
  }
  if (!Array.isArray(opts.writableDirs) || opts.writableDirs.length === 0) {
    throw new Error('runRestricted: 需要至少一个 writableDirs')
  }
  const writableDirs = opts.writableDirs.map(canonicalDir)
  for (const dir of writableDirs) {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      throw new Error(`runRestricted: writableDir 不存在或不是目录: ${dir}`)
    }
  }
  const cwd = canonicalDir(opts.cwd)
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    throw new Error(`runRestricted: cwd 不存在或不是目录: ${cwd}`)
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const selfCreatedTemp = opts.tempDir === undefined
  const tempDir = opts.tempDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'omb-sandbox-'))

  const api = win32Sync()
  const writeSidPtr = parseSid(api, workspaceWriteSid(writableDirs))
  const tempSidPtr = parseSid(api, tempWriteSid(tempDir))

  let currentToken: NativePtr | undefined
  let restrictedToken: NativePtr | undefined
  let spawned: SpawnedRestricted | undefined
  let grantedTemp = false

  const cleanup = (failures: unknown[]): void => {
    // fail-closed 清理（幂等由单次调用保证）：句柄 → temp 授权撤销 → SID 释放 → 自建 temp 删除。
    // writableDirs 的 ACE 常驻（确定性 SID reuse cache，DSH 语义），不撤销。
    if (spawned !== undefined) {
      try {
        if (api.closeHandle(spawned.job) === 0) throwLastError(api, 'CloseHandle', 'kill-on-close job')
      } catch (error) {
        failures.push(error)
      }
      try {
        if (api.closeHandle(spawned.process) === 0) throwLastError(api, 'CloseHandle', 'restricted child process')
      } catch (error) {
        failures.push(error)
      }
    }
    if (restrictedToken !== undefined) {
      try {
        if (api.closeHandle(restrictedToken) === 0) throwLastError(api, 'CloseHandle', 'restricted token')
      } catch (error) {
        failures.push(error)
      }
    }
    if (currentToken !== undefined) {
      try {
        if (api.closeHandle(currentToken) === 0) throwLastError(api, 'CloseHandle', 'current process token')
      } catch (error) {
        failures.push(error)
      }
    }
    if (grantedTemp) {
      try {
        revokeWrite(api, tempDir, tempSidPtr)
      } catch (error) {
        failures.push(error)
      }
    }
    try {
      const freed = api.localFree(writeSidPtr)
      if (!isNullPtr(freed)) throwLastError(api, 'LocalFree', 'workspace write SID')
    } catch (error) {
      failures.push(error)
    }
    try {
      const freed = api.localFree(tempSidPtr)
      if (!isNullPtr(freed)) throwLastError(api, 'LocalFree', 'temp write SID')
    } catch (error) {
      failures.push(error)
    }
    if (selfCreatedTemp) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true })
      } catch (error) {
        failures.push(error)
      }
    }
  }

  try {
    // 1. 授权：writableDirs（常驻）+ 私有 temp（可撤销；先记录再授权，grant 抛错也能撤销）
    for (const dir of writableDirs) {
      grantWrite(api, dir, writeSidPtr)
    }
    grantedTemp = true
    grantWrite(api, tempDir, tempSidPtr)

    // 2. 令牌链（fail-closed；CreateRestrictedToken 返回主令牌，可直接 CreateProcessAsUserW）
    currentToken = openCurrentProcessToken(api)
    const logonSid = findLogonSid(api, currentToken)
    const worldSid = makeWellKnownSid(api, abi.WinWorldSid)
    restrictedToken = createRestrictedToken(api, currentToken, logonSid, [writeSidPtr, tempSidPtr], worldSid)
    // 默认 DACL 并入 temp 写 SID 的全权 ACE：受限进程创建的新对象（匿名管道等）通过写 pass-2
    setTokenDefaultDaclGrant(api, restrictedToken, tempSidPtr)
    if (api.closeHandle(currentToken) === 0) throwLastError(api, 'CloseHandle', 'current process token')
    currentToken = undefined

    // 3. 环境改写（TMP/TEMP → 私有 temp；结果文件路径）+ spawn（lpEnvironment=NULL 继承改写后的环境块）
    const envSnapshot = rewriteChildEnv(tempDir, opts.resultFile)
    try {
      spawned = spawnRestrictedInherited(api, restrictedToken, {
        command: process.execPath,
        args: [script, ...(opts.args ?? [])],
        cwd,
      })
    } finally {
      restoreEnv(envSnapshot) // spawn 返回后立即恢复宿主环境
    }

    // 4. 等待退出 / 超时杀
    const result = await waitExit(api, spawned, timeoutMs)
    const failures: unknown[] = []
    cleanup(failures)
    if (failures.length > 0) {
      throw new AggregateError(failures, `runRestricted 清理完成但 ${failures.length} 项清理失败`)
    }
    return result
  } catch (error) {
    const failures: unknown[] = []
    cleanup(failures)
    if (failures.length > 0) {
      throw new AggregateError([error, ...failures], `runRestricted 失败且 ${failures.length} 项清理也失败`)
    }
    throw error
  }
}
