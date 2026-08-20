// layer 0：ACL 编辑：SetEntriesInAclW + SetNamedSecurityInfoW 把写能力 SID 的全权 ACE
// 物化/撤销到目录（照抄 DSH sandbox-windows-acl/src/acl.ts 的调用链与内存契约）。
// 与 DSH 的差异（task-0.5-report.md 记录）：省略 per-path 跨进程锁（LockFileEx）——
// layer 0 单进程内 JS 单线程串行使用，无竞态；跨进程并发授权同一路径最坏是重复相同 ACE，无害。
// 保留 hasExactGrant 精确 ACE 跳过：ACE 已在时跳过 SetNamedSecurityInfoW 应用，
// 避免对整棵树重传播（大 worktree 上分钟级）。
import { allocPtrSlot, decodePtr, decodeUint8At, decodeUint16At, decodeUint32At, isNullPtr, ptrAddress, sameSidAt, throwLastError, throwWin32 } from './win32-ffi.js'
import type { NativePtr, Win32Bindings } from './win32-ffi.js'
import * as abi from './win32-abi.js'

/**
 * 打包一条 EXPLICIT_ACCESS_W（48 字节，布局经 DSH abi-probe 核实）：
 * perms@0, mode@4, inheritance@8, Trustee@16 { pMultipleTrustee@16, MultipleTrusteeOperation@24,
 * TrusteeForm@28, TrusteeType@32, ptstrName@40 }。
 * @param sidPtr - ACE 命名的 trustee SID。
 * @param mode - GRANT_ACCESS 或 REVOKE_ACCESS。
 * @param permissions - 授予的访问掩码（REVOKE_ACCESS 传 0）。
 */
export function buildExplicitAccess(sidPtr: NativePtr, mode: number, permissions: number): Buffer {
  const entry = Buffer.alloc(abi.EXPLICIT_ACCESS_W_SIZE)
  entry.writeUInt32LE(permissions, 0) // grfAccessPermissions
  entry.writeUInt32LE(mode, 4) // grfAccessMode
  entry.writeUInt32LE(abi.SUB_CONTAINERS_AND_OBJECTS_INHERIT, 8) // grfInheritance: OI|CI
  entry.writeUInt32LE(abi.NO_MULTIPLE_TRUSTEE, 24)
  entry.writeUInt32LE(abi.TRUSTEE_IS_SID, 28)
  entry.writeUInt32LE(abi.TRUSTEE_IS_UNKNOWN, 32)
  entry.writeBigUInt64LE(ptrAddress(sidPtr), 40) // Trustee.ptstrName = 能力 SID
  return entry
}

/** 读取目录当前显式 DACL（GetNamedSecurityInfoW）。分配契约：ACL 指针在 descriptor 分配内——只许 LocalFree descriptor */
function readCurrentDacl(api: Win32Bindings, path: string): { oldAcl: NativePtr | null; descriptor: NativePtr | null } {
  const ownerSlot = allocPtrSlot()
  const groupSlot = allocPtrSlot()
  const daclSlot = allocPtrSlot()
  const saclSlot = allocPtrSlot()
  const descriptorSlot = allocPtrSlot()
  const readResult = api.getNamedSecurityInfoW(
    path, abi.SE_FILE_OBJECT, abi.DACL_SECURITY_INFORMATION,
    ownerSlot, groupSlot, daclSlot, saclSlot, descriptorSlot,
  )
  if (readResult !== abi.ERROR_SUCCESS) throwWin32(api, 'GetNamedSecurityInfoW', readResult, path)
  return { oldAcl: decodePtr(daclSlot), descriptor: decodePtr(descriptorSlot) }
}

/** 合并 entry 进 oldAcl 并应用；先释放 descriptor（含 oldAcl 块）再 SetNamedSecurityInfoW，最后释放合并 ACL */
function mergeAndApply(
  api: Win32Bindings,
  path: string,
  entry: Buffer,
  oldAcl: NativePtr | null,
  descriptor: NativePtr | null,
  label: string,
): void {
  const newAclSlot = allocPtrSlot()
  const mergeResult = api.setEntriesInAclW(1, entry, oldAcl, newAclSlot)
  if (mergeResult !== abi.ERROR_SUCCESS) {
    if (descriptor !== null) api.localFree(descriptor) // 连带释放 ACL 块
    throwWin32(api, 'SetEntriesInAclW', mergeResult, `${label}(${path})`)
  }
  const newAcl = decodePtr(newAclSlot)
  if (newAcl === null) {
    if (descriptor !== null) api.localFree(descriptor)
    throwWin32(api, 'SetEntriesInAclW', api.getLastError(), `${label}(${path}): null new ACL`)
  }

  const freedDescriptor = descriptor !== null ? api.localFree(descriptor) : null
  const applyResult = api.setNamedSecurityInfoW(
    path, abi.SE_FILE_OBJECT, abi.DACL_SECURITY_INFORMATION,
    null, null, newAcl, null,
  )
  const freedNew = api.localFree(newAcl)
  if (applyResult !== abi.ERROR_SUCCESS) throwWin32(api, 'SetNamedSecurityInfoW', applyResult, `${label}(${path})`)
  if (freedDescriptor !== null && !isNullPtr(freedDescriptor)) throwLastError(api, 'LocalFree', `${label}(${path}) descriptor`)
  if (!isNullPtr(freedNew)) throwLastError(api, 'LocalFree', `${label}(${path}) new ACL`)
}

/** 显式 DACL 是否已携带 EXACT 授权 ACE（Allow、OI|CI、GRANT_MASK、能力 SID）——所有字段经 koffi.decode 偏移读取 */
function hasExactGrant(oldAcl: NativePtr, sidPtr: NativePtr): boolean {
  const aclSize = decodeUint16At(oldAcl, 2)
  const aceCount = decodeUint16At(oldAcl, 4)
  if (aclSize < 8 || aclSize > 1_048_576) return false
  let offset = 8 // ACL 头 8 字节后是第一个 ACE
  for (let index = 0; index < aceCount; index++) {
    // ACE_HEADER: AceType@0, AceFlags@1, AceSize@2 (WORD); ACCESS_ALLOWED_ACE: Mask@4, inline SID@8
    const aceSize = decodeUint16At(oldAcl, offset + 2)
    if (aceSize < 8 || offset + aceSize > aclSize) return false
    const exact = decodeUint8At(oldAcl, offset) === abi.ACCESS_ALLOWED_ACE_TYPE
      && decodeUint8At(oldAcl, offset + 1) === abi.SUB_CONTAINERS_AND_OBJECTS_INHERIT
      && decodeUint32At(oldAcl, offset + 4) === abi.GRANT_MASK
    if (exact && sameSidAt(oldAcl, offset + 8, sidPtr, 0)) return true
    offset += aceSize
  }
  return false
}

/**
 * 把 GRANT_MASK（写+删除，显示 "Modify"）授予能力 SID，继承到子容器与对象。幂等：
 * 目录显式 DACL 已携带 EXACT ACE 时跳过应用（避免整树重传播）。目录须为调用者所有
 * （所有者隐含 WRITE_DAC）——mkdtemp/候选目录天然满足。
 */
export function grantWrite(api: Win32Bindings, path: string, sidPtr: NativePtr): void {
  const { oldAcl, descriptor } = readCurrentDacl(api, path)
  if (oldAcl !== null && hasExactGrant(oldAcl, sidPtr)) {
    if (descriptor !== null) {
      const freed = api.localFree(descriptor)
      if (!isNullPtr(freed)) throwLastError(api, 'LocalFree', `grantWrite(${path}) descriptor`)
    }
    return
  }
  mergeAndApply(api, path, buildExplicitAccess(sidPtr, abi.GRANT_ACCESS, abi.GRANT_MASK), oldAcl, descriptor, 'grantWrite')
}

/** 从目录 DACL 移除能力 SID 的全部 ACE（REVOKE_ACCESS 合并，其余条目保留）。返回是否尝试过移除 */
export function revokeWrite(api: Win32Bindings, path: string, sidPtr: NativePtr): boolean {
  const { oldAcl, descriptor } = readCurrentDacl(api, path)
  if (oldAcl === null) {
    if (descriptor !== null) {
      const freed = api.localFree(descriptor)
      if (!isNullPtr(freed)) throwLastError(api, 'LocalFree', `revokeWrite(${path}) descriptor`)
    }
    return false
  }
  mergeAndApply(api, path, buildExplicitAccess(sidPtr, abi.REVOKE_ACCESS, 0), oldAcl, descriptor, 'revokeWrite')
  return true
}
