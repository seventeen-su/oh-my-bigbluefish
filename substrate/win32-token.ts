// layer 0：受限令牌构建（照抄 DSH sandbox-windows-acl/src/token.ts 的 API 调用链）：
// 打开当前进程令牌 → 找登录 SID → well-known SID → CreateRestrictedToken(WRITE_RESTRICTED) →
// 默认 DACL 并入 restricting SID 的全权 ACE → 返回主令牌直接用于 CreateProcessAsUserW。
// 每个 API 调用都检查；任何失败抛 Win32Error（fail-closed，绝不静默以完整令牌运行子进程）。
import { allocBytes, allocPtrSlot, allocUint32, decodePtr, decodePtrAt, decodeUint32, encodeUint32, isNullPtr, ptrAddress, throwLastError, throwWin32 } from './win32-ffi.js'
import type { NativePtr, Win32Bindings } from './win32-ffi.js'
import { buildExplicitAccess } from './win32-acl.js'
import * as abi from './win32-abi.js'

/** 打开当前进程令牌（CreateRestrictedToken 所需权限）。GetCurrentProcess 伪句柄无法经 koffi 寻址 → OpenProcess 按 pid */
export function openCurrentProcessToken(api: Win32Bindings): NativePtr {
  const processHandle = api.openProcess(abi.PROCESS_QUERY_INFORMATION, 0, process.pid)
  if (isNullPtr(processHandle)) throwLastError(api, 'OpenProcess', `pid ${process.pid}`)

  const tokenSlot = allocPtrSlot()
  const opened = api.openProcessToken(
    processHandle,
    abi.TOKEN_QUERY | abi.TOKEN_DUPLICATE | abi.TOKEN_ADJUST_DEFAULT | abi.TOKEN_ASSIGN_PRIMARY,
    tokenSlot,
  )
  if (opened === 0) {
    const win32Code = api.getLastError()
    api.closeHandle(processHandle) // 错误路径尽力关句柄
    throwWin32(api, 'OpenProcessToken', win32Code, `pid ${process.pid}`)
  }
  if (api.closeHandle(processHandle) === 0) throwLastError(api, 'CloseHandle', 'OpenProcess process handle')
  const token = decodePtr(tokenSlot)
  if (token === null) throwWin32(api, 'OpenProcessToken', api.getLastError(), 'null token handle')
  return token
}

/** 从令牌组找登录会话 SID（S-1-5-5-x-y，SE_GROUP_LOGON_ID 属性）并拷贝 */
export function findLogonSid(api: Win32Bindings, token: NativePtr): NativePtr {
  const neededSlot = allocUint32()
  api.getTokenInformation(token, abi.TokenGroups, null, 0, neededSlot) // 预期 ERROR_INSUFFICIENT_BUFFER
  const needed = decodeUint32(neededSlot)
  if (needed === 0) throwLastError(api, 'GetTokenInformation', 'TokenGroups size query')
  if (needed < abi.TOKEN_GROUPS_OFFSET) throwWin32(api, 'GetTokenInformation', api.getLastError(), `implausible TokenGroups size ${needed}`)

  const groups = Buffer.alloc(needed)
  if (api.getTokenInformation(token, abi.TokenGroups, groups, groups.length, neededSlot) === 0) {
    throwLastError(api, 'GetTokenInformation', 'TokenGroups')
  }
  const groupCount = groups.readUInt32LE(0)
  for (let index = 0; index < groupCount; index++) {
    const sidPtr = decodePtrAt(groups, abi.TOKEN_GROUPS_OFFSET + index * abi.SID_AND_ATTRIBUTES_SIZE)
    const attributes = groups.readUInt32LE(abi.TOKEN_GROUPS_OFFSET + index * abi.SID_AND_ATTRIBUTES_SIZE + 8)
    // >>> 0：JS 位运算是 32 位有符号；SE_GROUP_LOGON_ID 高位为 1
    const isLogonId = ((attributes & abi.SE_GROUP_LOGON_ID) >>> 0) === (abi.SE_GROUP_LOGON_ID >>> 0)
    if (sidPtr === null || !isLogonId) continue
    const sidLength = api.getLengthSid(sidPtr)
    if (sidLength === 0) throwLastError(api, 'GetLengthSid', `logon SID group ${index}`)
    const copy = allocBytes(sidLength)
    if (api.copySid(sidLength, copy, sidPtr) === 0) throwLastError(api, 'CopySid', `logon SID group ${index}`)
    return copy
  }
  throw new Error(`CreateRestrictedToken prerequisite failed: no logon SID found among ${groupCount} token groups`)
}

/** 创建 well-known SID（68 字节缓冲）并断言有效 */
export function makeWellKnownSid(api: Win32Bindings, type: number): NativePtr {
  const sid = allocBytes(abi.SECURITY_MAX_SID_SIZE)
  const sizeSlot = allocUint32()
  encodeUint32(sizeSlot, abi.SECURITY_MAX_SID_SIZE)
  if (api.createWellKnownSid(type, null, sid, sizeSlot) === 0) {
    throwLastError(api, 'CreateWellKnownSid', `type ${type}`)
  }
  if (api.isValidSid(sid) === 0) throwLastError(api, 'IsValidSid', `CreateWellKnownSid type ${type}`)
  return sid
}

/**
 * 把 sidPtr 的全权 allow ACE 并入令牌默认 DACL——令牌持有者创建的每个新对象（无显式 SD）
 * 采用的 DACL。受限令牌继承用户默认 DACL 原样，其中没有 restricting SID：受限进程创建
 * 匿名管道/同步对象时写 pass-2 检查失败（ERROR_ACCESS_DENIED，Node 表现为 EPERM）。
 * 并入命名 restricting SID 的 ACE 后新对象自身 DACL 通过 pass-2，而对象创建仍由父容器
 * DACL 把关（允许名单外的文件仍不可创建）。fail-closed：任何失败在 spawn 前抛出。
 */
export function setTokenDefaultDaclGrant(api: Win32Bindings, token: NativePtr, sidPtr: NativePtr): void {
  const neededSlot = allocUint32()
  api.getTokenInformation(token, abi.TokenDefaultDacl, null, 0, neededSlot) // 预期 ERROR_INSUFFICIENT_BUFFER
  const needed = decodeUint32(neededSlot)
  if (needed === 0) throwLastError(api, 'GetTokenInformation', 'TokenDefaultDacl size query')
  const buffer = Buffer.alloc(needed)
  if (api.getTokenInformation(token, abi.TokenDefaultDacl, buffer, buffer.length, neededSlot) === 0) {
    throwLastError(api, 'GetTokenInformation', 'TokenDefaultDacl')
  }
  const currentDacl = decodePtrAt(buffer, 0)
  if (currentDacl === null) {
    throw new Error('setTokenDefaultDaclGrant: the token carries no default DACL to extend')
  }
  const newDaclSlot = allocPtrSlot()
  const result = api.setEntriesInAclW(
    1,
    buildExplicitAccess(sidPtr, abi.GRANT_ACCESS, abi.FILE_ALL_ACCESS),
    currentDacl,
    newDaclSlot,
  )
  if (result !== abi.ERROR_SUCCESS) throwWin32(api, 'SetEntriesInAclW', result, 'default DACL merge')
  const newDacl = decodePtr(newDaclSlot)
  if (newDacl === null) throwWin32(api, 'SetEntriesInAclW', result, 'null merged default DACL')
  // TOKEN_DEFAULT_DACL { PACL DefaultDacl; } —— 结构恰好是指针；SetTokenInformation 返回前拷贝 ACL
  const info = Buffer.alloc(8)
  info.writeBigUInt64LE(newDacl, 0)
  if (api.setTokenInformation(token, abi.TokenDefaultDacl, info, info.length) === 0) {
    const win32Code = api.getLastError()
    api.localFree(newDacl)
    throwWin32(api, 'SetTokenInformation', win32Code, 'TokenDefaultDacl')
  }
  api.localFree(newDacl)
}

/** 打包 SID_AND_ATTRIBUTES[count]（16 字节步长；Attributes 保持 0） */
function buildRestrictingSids(sids: readonly NativePtr[]): Buffer {
  const buffer = Buffer.alloc(abi.SID_AND_ATTRIBUTES_SIZE * sids.length)
  sids.forEach((sid, index) => {
    buffer.writeBigUInt64LE(ptrAddress(sid), abi.SID_AND_ATTRIBUTES_SIZE * index)
  })
  return buffer
}

/**
 * 创建写受限令牌。restricting 列表 = [logonSid, Everyone, ...writeSids]：
 * - logonSid + Everyone 是 keep-alive 组（缺它们早期 DLL 初始化 0xC0000142、CNG 失败——DSH 实测）；
 * - writeSids 是写能力 SID（workspace + temp），只有它们命中的 ACE 才放行受限进程的写；
 * - 无 Authenticated Users / INTERACTIVE / LOCAL：关闭 WMI 命名空间检查失败与 C:\ 根树创建逃逸（DSH README）。
 * CreateRestrictedToken 返回主令牌，可直接用于 CreateProcessAsUserW（DSH 实测链路，无需 DuplicateTokenEx）。
 */
export function createRestrictedToken(
  api: Win32Bindings,
  currentToken: NativePtr,
  logonSid: NativePtr,
  writeSids: readonly NativePtr[],
  worldSid: NativePtr,
): NativePtr {
  if (writeSids.length === 0) {
    throw new Error('createRestrictedToken: write-restricted restricting list requires at least one write SID')
  }
  const restrictingSids = buildRestrictingSids([logonSid, worldSid, ...writeSids])
  const tokenSlot = allocPtrSlot()
  const created = api.createRestrictedToken(
    currentToken,
    abi.DISABLE_MAX_PRIVILEGE | abi.LUA_TOKEN | abi.WRITE_RESTRICTED,
    0, null, // 不禁用 SID
    0, null, // 不删除特权
    restrictingSids.length / abi.SID_AND_ATTRIBUTES_SIZE,
    restrictingSids,
    tokenSlot,
  )
  if (created === 0) throwLastError(api, 'CreateRestrictedToken', `restricting SIDs: ${restrictingSids.length / abi.SID_AND_ATTRIBUTES_SIZE}`)
  const token = decodePtr(tokenSlot)
  if (token === null) throwWin32(api, 'CreateRestrictedToken', api.getLastError(), 'null token handle')
  return token
}
