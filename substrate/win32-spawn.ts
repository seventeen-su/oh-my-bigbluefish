// layer 0：受限进程启动（照抄 DSH sandbox-windows-acl/src/spawn.ts 的 CreateProcessAsUserW 链）：
// kill-on-close job → 宿主 std 句柄重开可继承位 → STARTUPINFOW(STARTF_USESTDHANDLES) →
// CreateProcessAsUserW(CREATE_SUSPENDED) → 入 job → ResumeThread。退出码轮询 GetExitCodeProcess；
// 超时 TerminateJobObject 杀整棵进程树（job 内所有进程）。
// 受限进程内 stdio:'pipe' 会 EPERM（研究结论，research-dsh.md §3.4）→ 输出走结果文件（写允许名单内）。
import { allocProcessInfo, allocStartupInfo, allocUint32, decodeProcessInfo, decodeUint32, encodeStartupInfo, isNullPtr, throwLastError, throwWin32 } from './win32-ffi.js'
import type { NativePtr, Win32Bindings } from './win32-ffi.js'
import * as abi from './win32-abi.js'

/** 按 CommandLineToArgvW 规则引用一个参数（反斜杠只在引号字符前加倍——含结尾引号前） */
export function quoteArg(argument: string): string {
  if (argument === '') return '""'
  if (!/[\s"]/u.test(argument)) return argument
  let quoted = '"'
  for (let index = 0; index < argument.length; index++) {
    let backslashes = 0
    while (index < argument.length && argument.charAt(index) === '\\') {
      backslashes++
      index++
    }
    if (index === argument.length) {
      quoted += '\\'.repeat(backslashes * 2)
    } else if (argument.charAt(index) === '"') {
      quoted += '\\'.repeat(backslashes * 2 + 1) + '"'
    } else {
      quoted += '\\'.repeat(backslashes) + argument.charAt(index)
    }
  }
  return quoted + '"'
}

/** 拼 CreateProcess 解析的单条命令行 */
export function buildCommandLine(program: string, args: readonly string[]): string {
  return [program, ...args].map(quoteArg).join(' ')
}

/** 受限令牌下已启动的子进程：进程句柄 + kill-on-close job */
export interface SpawnedRestricted {
  pid: number
  process: NativePtr
  job: NativePtr
}

/** 创建 kill-on-close job（JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE 于 LimitFlags 偏移 16）。宿主死亡 → job 内全部进程终止 */
function createKillOnCloseJob(api: Win32Bindings): NativePtr {
  const job = api.createJobObjectW(null, null)
  if (isNullPtr(job)) throwLastError(api, 'CreateJobObjectW')
  const information = Buffer.alloc(abi.JOBOBJECT_EXTENDED_LIMIT_SIZE)
  information.writeUInt32LE(abi.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, abi.JOBOBJECT_EXTENDED_LIMIT_FLAGS_OFFSET)
  if (api.setInformationJobObject(job, abi.JobObjectExtendedLimitInformation, information, information.length) === 0) {
    const win32Code = api.getLastError()
    api.closeHandle(job)
    throwWin32(api, 'SetInformationJobObject', win32Code)
  }
  return job
}

/**
 * 受限令牌下以继承 stdio 创建进程（stdio 直通宿主管道）。Node 启动时清除 stdio 可继承位
 * （uv_disable_stdio_inheritance）→ 必须先重开可继承位并显式经 STARTF_USESTDHANDLES 传入，
 * 否则子进程收到 INVALID std 句柄（DSH 实测）。子进程挂起创建以便先入 kill-on-close job 再运行。
 * 环境块：lpEnvironment 传 NULL（继承调用者环境；koffi 显式传环境块会触发
 * ERROR_INVALID_PARAMETER——DSH 实测），调用者 spawn 前经 SetEnvironmentVariableW 改写。
 */
export function spawnRestrictedInherited(
  api: Win32Bindings,
  token: NativePtr,
  options: { command: string; args: readonly string[]; cwd: string },
): SpawnedRestricted {
  const job = createKillOnCloseJob(api)
  const stdIn = api.getStdHandle(abi.STD_INPUT_HANDLE)
  const stdOut = api.getStdHandle(abi.STD_OUTPUT_HANDLE)
  const stdErr = api.getStdHandle(abi.STD_ERROR_HANDLE)
  if (isNullPtr(stdIn) || isNullPtr(stdOut) || isNullPtr(stdErr)) {
    api.closeHandle(job)
    throwLastError(api, 'GetStdHandle', 'null standard handle')
  }

  const makeInheritable = (handle: NativePtr, label: string): void => {
    if (api.setHandleInformation(handle, abi.HANDLE_FLAG_INHERIT, abi.HANDLE_FLAG_INHERIT) === 0) {
      throwLastError(api, 'SetHandleInformation', `${label} (enable inherit)`)
    }
  }
  const restoreInherit = (handle: NativePtr): void => {
    // 尽力而为的卫生清理；失败不得掩盖子进程结果 → 故意不检查
    api.setHandleInformation(handle, abi.HANDLE_FLAG_INHERIT, 0)
  }
  makeInheritable(stdIn, 'stdin')
  makeInheritable(stdOut, 'stdout')
  makeInheritable(stdErr, 'stderr')

  const startupInfo = allocStartupInfo()
  encodeStartupInfo(startupInfo, {
    cb: abi.STARTUPINFOW_SIZE,
    dwFlags: abi.STARTF_USESTDHANDLES,
    hStdInput: stdIn,
    hStdOutput: stdOut,
    hStdError: stdErr,
  })

  const processInfo = allocProcessInfo()
  const commandLine = buildCommandLine(options.command, options.args)
  const created = api.createProcessAsUserW(
    token, null, commandLine,
    null, null,
    1, // bInheritHandles：重开可继承位的 std 句柄必须可继承
    abi.CREATE_SUSPENDED, // 挂起创建，先入 job 再运行
    null, options.cwd,
    startupInfo, processInfo,
  )
  restoreInherit(stdIn)
  restoreInherit(stdOut)
  restoreInherit(stdErr)
  if (created === 0) {
    const win32Code = api.getLastError()
    api.closeHandle(job)
    throwWin32(api, 'CreateProcessAsUserW', win32Code, `command: ${options.command}, cwd: ${options.cwd}`)
  }

  const info = decodeProcessInfo(processInfo)
  const processHandle = info.hProcess
  const threadHandle = info.hThread
  if (processHandle === null || threadHandle === null) {
    api.closeHandle(job)
    throw new Error(`CreateProcessAsUserW succeeded but returned null process/thread handles (pid ${info.dwProcessId})`)
  }

  if (api.assignProcessToJobObject(job, processHandle) === 0) {
    // 挂起中的子进程不在 job 里：关句柄会永久挂起 → 先终止再关
    const win32Code = api.getLastError()
    api.terminateProcess(processHandle, 1)
    api.closeHandle(threadHandle)
    api.closeHandle(processHandle)
    api.closeHandle(job)
    throwWin32(api, 'AssignProcessToJobObject', win32Code, `pid ${info.dwProcessId}`)
  }
  if (api.resumeThread(threadHandle) === 0xFFFFFFFF) {
    const win32Code = api.getLastError()
    api.closeHandle(threadHandle)
    api.closeHandle(processHandle)
    api.closeHandle(job) // 关 job 触发 kill-on-close → 挂起子进程死掉
    throwWin32(api, 'ResumeThread', win32Code, `pid ${info.dwProcessId}`)
  }
  api.closeHandle(threadHandle)

  return { pid: info.dwProcessId, process: processHandle, job }
}

/** 读退出码（STILL_ACTIVE=259 表示仍在运行） */
export function readExitCode(api: Win32Bindings, process: NativePtr): number {
  const exitCodeSlot = allocUint32()
  if (api.getExitCodeProcess(process, exitCodeSlot) === 0) throwLastError(api, 'GetExitCodeProcess')
  return decodeUint32(exitCodeSlot)
}

/** 终止整个 job（含子进程树）并返回其最终退出码 */
export function terminateJob(api: Win32Bindings, job: NativePtr, process: NativePtr, exitCode: number): void {
  if (api.terminateJobObject(job, exitCode) === 0) {
    // TerminateJobObject 失败（罕见）→ 退而终止直接子进程
    const win32Code = api.getLastError()
    if (api.terminateProcess(process, exitCode) === 0) {
      throwWin32(api, 'TerminateJobObject', win32Code, `and TerminateProcess also failed (Win32 ${api.getLastError()})`)
    }
  }
}
