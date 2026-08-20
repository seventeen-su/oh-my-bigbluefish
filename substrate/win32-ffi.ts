// layer 0：koffi Win32 FFI 绑定（WRITE_RESTRICTED 受限令牌沙盒用）。
// 照抄 DSH sandbox-windows-acl/src/ffi.ts 的绑定模式（函数签名经 MinGW 头文件核实），
// 仅保留本任务用到的子集；去除管道/锁文件/控制台等无关绑定。koffi 3 指针为 BigInt。
import koffi from 'koffi'
import * as abi from './win32-abi.js'

/** koffi 3 原生指针（BigInt 地址；brand 防止误入数值上下文） */
declare const nativePtr: unique symbol
export type NativePtr = bigint & { readonly [nativePtr]: true }

/** 判定 NULL 指针（koffi 可能返回 null 或 0n） */
export function isNullPtr(value: NativePtr | null | undefined): value is null | undefined {
  return value === null || value === undefined || (value as bigint) === 0n
}

/** Win32 失败错误（fail-closed：每个 API 调用都检查，失败带 API 名与精确 Win32 码） */
export class Win32Error extends Error {
  readonly api: string
  readonly win32Code: number

  constructor(api: string, win32Code: number, detail?: string) {
    super(`${api} failed (Win32 ${win32Code})${detail === undefined ? '' : `: ${detail}`}`)
    this.name = 'Win32Error'
    this.api = api
    this.win32Code = win32Code
  }
}

/** STARTUPINFOW 输入子集（零初始化结构体只写 stdio 相关字段） */
export interface StartupInfoInput {
  cb: number
  dwFlags: number
  hStdInput: NativePtr
  hStdOutput: NativePtr
  hStdError: NativePtr
}

/** 解码后的 PROCESS_INFORMATION */
export interface ProcessInfoOutput {
  hProcess: NativePtr | null
  hThread: NativePtr | null
  dwProcessId: number
  dwThreadId: number
}

/** 本任务用到的 Win32 调用表（koffi 懒加载，非 Windows 进程不会打开 DLL） */
export interface Win32Bindings {
  openProcess(desiredAccess: number, inheritHandle: number, pid: number): NativePtr
  openProcessToken(process: NativePtr, desiredAccess: number, tokenHandle: NativePtr): number
  closeHandle(handle: NativePtr): number
  getLastError(): number
  formatMessageW(flags: number, source: null, messageId: number, languageId: number, buffer: Buffer, size: number, args: null): number
  localFree(memory: NativePtr): NativePtr
  convertStringSidToSidW(stringSid: string, sid: NativePtr): number
  createWellKnownSid(type: number, domainSid: null, sid: NativePtr, size: NativePtr): number
  isValidSid(sid: NativePtr): number
  getLengthSid(sid: NativePtr): number
  copySid(length: number, destination: NativePtr, source: NativePtr): number
  getTokenInformation(token: NativePtr, cls: number, info: Buffer | null, length: number, needed: NativePtr): number
  setTokenInformation(token: NativePtr, cls: number, info: Buffer, length: number): number
  createRestrictedToken(
    existing: NativePtr, flags: number,
    disableCount: number, disableSids: null,
    deletePrivilegeCount: number, privilegesToDelete: null,
    restrictCount: number, restrictingSids: Buffer,
    newToken: NativePtr,
  ): number
  setEntriesInAclW(count: number, entries: Buffer, oldAcl: NativePtr | null, newAcl: NativePtr): number
  setNamedSecurityInfoW(
    path: string, objectType: number, information: number,
    owner: null, group: null, dacl: NativePtr | null, sacl: null,
  ): number
  getNamedSecurityInfoW(
    path: string, objectType: number, information: number,
    owner: NativePtr, group: NativePtr, dacl: NativePtr, sacl: NativePtr, descriptor: NativePtr,
  ): number
  setHandleInformation(handle: NativePtr, mask: number, flags: number): number
  getStdHandle(stdHandle: number): NativePtr
  createProcessAsUserW(
    token: NativePtr, applicationName: null, commandLine: string,
    processAttributes: null, threadAttributes: null,
    inheritHandles: number, creationFlags: number, environment: null,
    currentDirectory: string | null, startupInfo: NativePtr, processInfo: NativePtr,
  ): number
  createJobObjectW(attributes: null, name: null): NativePtr
  setInformationJobObject(job: NativePtr, cls: number, information: Buffer, length: number): number
  assignProcessToJobObject(job: NativePtr, process: NativePtr): number
  terminateJobObject(job: NativePtr, exitCode: number): number
  terminateProcess(process: NativePtr, exitCode: number): number
  getExitCodeProcess(process: NativePtr, exitCode: NativePtr): number
  resumeThread(thread: NativePtr): number
}

const PVOID: ReturnType<typeof koffi.pointer> = koffi.pointer('void')
const PPVOID: ReturnType<typeof koffi.pointer> = koffi.pointer(PVOID)

/** koffi STARTUPINFOW 布局；大小在加载时对照 abi.STARTUPINFOW_SIZE 断言 */
export const STARTUPINFOW = koffi.struct('STARTUPINFOW', {
  cb: 'uint32',
  lpReserved: 'str16',
  lpDesktop: 'str16',
  lpTitle: 'str16',
  dwX: 'uint32',
  dwY: 'uint32',
  dwXSize: 'uint32',
  dwYSize: 'uint32',
  dwXCountChars: 'uint32',
  dwYCountChars: 'uint32',
  dwFillAttribute: 'uint32',
  dwFlags: 'uint32',
  wShowWindow: 'uint16',
  cbReserved2: 'uint16',
  lpReserved2: koffi.pointer('uint8'),
  hStdInput: PVOID,
  hStdOutput: PVOID,
  hStdError: PVOID,
})

/** koffi PROCESS_INFORMATION 布局；大小在加载时对照 abi.PROCESS_INFORMATION_SIZE 断言 */
export const PROCESS_INFORMATION = koffi.struct('PROCESS_INFORMATION', {
  hProcess: PVOID,
  hThread: PVOID,
  dwProcessId: 'uint32',
  dwThreadId: 'uint32',
})

if (STARTUPINFOW.size !== abi.STARTUPINFOW_SIZE) {
  throw new Error(`STARTUPINFOW layout mismatch: koffi computed ${STARTUPINFOW.size}, expected ${abi.STARTUPINFOW_SIZE}`)
}
if (PROCESS_INFORMATION.size !== abi.PROCESS_INFORMATION_SIZE) {
  throw new Error(`PROCESS_INFORMATION layout mismatch: koffi computed ${PROCESS_INFORMATION.size}, expected ${abi.PROCESS_INFORMATION_SIZE}`)
}

/** 分配一个指针槽（T** 出参） */
export function allocPtrSlot(): NativePtr {
  const value: unknown = koffi.alloc(PVOID, 1)
  return value as NativePtr
}

/** 分配一个 uint32 槽 */
export function allocUint32(): NativePtr {
  const value: unknown = koffi.alloc('uint32', 1)
  return value as NativePtr
}

/** 写入 uint32 值到槽 */
export function encodeUint32(slot: NativePtr, value: number): void {
  koffi.encode(slot, 'uint32', value)
}

/** 解码指针槽（NULL → null） */
export function decodePtr(slot: NativePtr): NativePtr | null {
  const value: unknown = koffi.decode(slot, PVOID)
  if (isNullPtr(value as NativePtr | null | undefined)) return null
  return value as NativePtr
}

/** 解码 uint32 槽 */
export function decodeUint32(slot: NativePtr): number {
  const value: unknown = koffi.decode(slot, 'uint32')
  return value as number
}

/** 指针 → 数值地址（BigInt，用于原始结构打包） */
export function ptrAddress(ptr: NativePtr): bigint {
  return koffi.address(ptr)
}

/** 分配原始字节块（SID 拷贝、变长数组用；koffi GC 自动回收） */
export function allocBytes(length: number): NativePtr {
  const value: unknown = koffi.alloc('uint8', length)
  return value as NativePtr
}

/** 解码 buffer[offset] 处存储的指针值 */
export function decodePtrAt(buffer: Buffer, offset: number): NativePtr | null {
  const value: unknown = koffi.decode(buffer, offset, PVOID)
  if (isNullPtr(value as NativePtr | null | undefined)) return null
  return value as NativePtr
}

/** 解码原生指针 + 偏移处的 uint8（ACL 走查的字段读取原语） */
export function decodeUint8At(ptr: NativePtr, offset: number): number {
  const value: unknown = koffi.decode(ptr, offset, 'uint8')
  return value as number
}

/** 解码原生指针 + 偏移处的 uint16 */
export function decodeUint16At(ptr: NativePtr, offset: number): number {
  const value: unknown = koffi.decode(ptr, offset, 'uint16')
  return value as number
}

/** 解码原生指针 + 偏移处的 uint32 */
export function decodeUint32At(ptr: NativePtr, offset: number): number {
  const value: unknown = koffi.decode(ptr, offset, 'uint32')
  return value as number
}

/** 分配零初始化 STARTUPINFOW */
export function allocStartupInfo(): NativePtr {
  const value: unknown = koffi.alloc(STARTUPINFOW, 1)
  return value as NativePtr
}

/** 写入 STARTUPINFOW 的 stdio 相关字段（其余保持零初始化） */
export function encodeStartupInfo(startupInfo: NativePtr, fields: StartupInfoInput): void {
  koffi.encode(startupInfo, STARTUPINFOW, fields)
}

/** 分配零初始化 PROCESS_INFORMATION */
export function allocProcessInfo(): NativePtr {
  const value: unknown = koffi.alloc(PROCESS_INFORMATION, 1)
  return value as NativePtr
}

/** CreateProcessAsUserW 后解码 PROCESS_INFORMATION */
export function decodeProcessInfo(processInfo: NativePtr): ProcessInfoOutput {
  const value: unknown = koffi.decode(processInfo, PROCESS_INFORMATION)
  return value as ProcessInfoOutput
}

/** 有界偏移读取比较两个 SID（revision/count/authority/subauthorities），防越界 */
export function sameSidAt(left: NativePtr, leftOffset: number, right: NativePtr, rightOffset: number): boolean {
  const leftRevision = decodeUint8At(left, leftOffset)
  const rightRevision = decodeUint8At(right, rightOffset)
  if (leftRevision !== rightRevision) return false
  const leftCount = decodeUint8At(left, leftOffset + 1)
  const rightCount = decodeUint8At(right, rightOffset + 1)
  if (leftCount !== rightCount || leftCount > abi.SID_MAX_SUB_AUTHORITIES) return false
  for (let index = 0; index < 6; index++) {
    if (decodeUint8At(left, leftOffset + 2 + index) !== decodeUint8At(right, rightOffset + 2 + index)) return false
  }
  for (let index = 0; index < leftCount; index++) {
    if (decodeUint32At(left, leftOffset + 8 + index * 4) !== decodeUint32At(right, rightOffset + 8 + index * 4)) return false
  }
  return true
}

let cached: Win32Bindings | undefined

function bindings(): Win32Bindings {
  if (cached !== undefined) return cached
  const kernel32 = koffi.load('kernel32.dll')
  const advapi32 = koffi.load('advapi32.dll')

  const bind = (lib: ReturnType<typeof koffi.load>, name: string, result: ReturnType<typeof koffi.pointer> | string, args: Array<ReturnType<typeof koffi.pointer> | string>): unknown =>
    lib.func('__stdcall', name, result, args)

  cached = {
    openProcess: bind(kernel32, 'OpenProcess', PVOID, ['uint32', 'int', 'uint32']),
    openProcessToken: bind(advapi32, 'OpenProcessToken', 'int', [PVOID, 'uint32', PPVOID]),
    closeHandle: bind(kernel32, 'CloseHandle', 'int', [PVOID]),
    getLastError: bind(kernel32, 'GetLastError', 'uint32', []),
    formatMessageW: bind(kernel32, 'FormatMessageW', 'uint32', ['uint32', PVOID, 'uint32', 'uint32', PVOID, 'uint32', PVOID]),
    localFree: bind(kernel32, 'LocalFree', PVOID, [PVOID]),
    convertStringSidToSidW: bind(advapi32, 'ConvertStringSidToSidW', 'int', ['str16', PPVOID]),
    createWellKnownSid: bind(advapi32, 'CreateWellKnownSid', 'int', ['int', PVOID, PVOID, koffi.pointer('uint32')]),
    isValidSid: bind(advapi32, 'IsValidSid', 'int', [PVOID]),
    getLengthSid: bind(advapi32, 'GetLengthSid', 'uint32', [PVOID]),
    copySid: bind(advapi32, 'CopySid', 'int', ['uint32', PVOID, PVOID]),
    getTokenInformation: bind(advapi32, 'GetTokenInformation', 'int', [PVOID, 'int', PVOID, 'uint32', koffi.pointer('uint32')]),
    setTokenInformation: bind(advapi32, 'SetTokenInformation', 'int', [PVOID, 'int', PVOID, 'uint32']),
    createRestrictedToken: bind(advapi32, 'CreateRestrictedToken', 'int', [PVOID, 'uint32', 'uint32', PVOID, 'uint32', PVOID, 'uint32', PVOID, PPVOID]),
    setEntriesInAclW: bind(advapi32, 'SetEntriesInAclW', 'uint32', ['uint32', PVOID, PVOID, PPVOID]),
    setNamedSecurityInfoW: bind(advapi32, 'SetNamedSecurityInfoW', 'uint32', ['str16', 'int', 'uint32', PVOID, PVOID, PVOID, PVOID]),
    getNamedSecurityInfoW: bind(advapi32, 'GetNamedSecurityInfoW', 'uint32', ['str16', 'int', 'uint32', PPVOID, PPVOID, PPVOID, PPVOID, PPVOID]),
    setHandleInformation: bind(kernel32, 'SetHandleInformation', 'int', [PVOID, 'uint32', 'uint32']),
    getStdHandle: bind(kernel32, 'GetStdHandle', PVOID, ['int']),
    createProcessAsUserW: bind(advapi32, 'CreateProcessAsUserW', 'int', [
      PVOID, 'str16', 'str16', PVOID, PVOID, 'int', 'uint32', PVOID, 'str16',
      koffi.pointer(STARTUPINFOW), koffi.pointer(PROCESS_INFORMATION),
    ]),
    createJobObjectW: bind(kernel32, 'CreateJobObjectW', PVOID, [PVOID, 'str16']),
    setInformationJobObject: bind(kernel32, 'SetInformationJobObject', 'int', [PVOID, 'int', PVOID, 'uint32']),
    assignProcessToJobObject: bind(kernel32, 'AssignProcessToJobObject', 'int', [PVOID, PVOID]),
    terminateJobObject: bind(kernel32, 'TerminateJobObject', 'int', [PVOID, 'uint32']),
    terminateProcess: bind(kernel32, 'TerminateProcess', 'int', [PVOID, 'uint32']),
    getExitCodeProcess: bind(kernel32, 'GetExitCodeProcess', 'int', [PVOID, koffi.pointer('uint32')]),
    resumeThread: bind(kernel32, 'ResumeThread', 'uint32', [PVOID]),
  } as unknown as Win32Bindings
  return cached
}

/** 同步解析懒加载 Win32 绑定（首个绑定失败即抛——fail-closed） */
export function win32Sync(): Win32Bindings {
  return bindings()
}

/** Win32 错误码 → 可读文本（FormatMessageW） */
export function errorText(api: Win32Bindings, win32Code: number): string {
  const buffer = Buffer.alloc(1024)
  const length = api.formatMessageW(
    abi.FORMAT_MESSAGE_FROM_SYSTEM | abi.FORMAT_MESSAGE_IGNORE_INSERTS,
    null, win32Code, 0, buffer, buffer.length / 2, null,
  )
  if (length === 0) return ''
  return buffer.subarray(0, length * 2).toString('utf16le').trim()
}

/** 抛 Win32Error（BOOL 风格 API：失败后立即调用取 GetLastError） */
export function throwLastError(api: Win32Bindings, name: string, detail?: string): never {
  const win32Code = api.getLastError()
  throw new Win32Error(name, win32Code, detail ?? errorText(api, win32Code))
}

/** 抛 Win32Error（HRESULT 风格 API：返回值本身就是错误码） */
export function throwWin32(api: Win32Bindings, name: string, win32Code: number, detail?: string): never {
  throw new Win32Error(name, win32Code, detail ?? errorText(api, win32Code))
}
