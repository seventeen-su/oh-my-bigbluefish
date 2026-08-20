// layer 0：Win32 ABI 常量（WRITE_RESTRICTED 受限令牌沙盒用）。
// 值照抄 DSH sandbox-windows-acl/src/win32-abi.ts（其值经 MinGW 头文件 + abi-probe.cpp 双重核实），
// 仅保留本任务（T0.5）用到的子集。详见 task-0.5-report.md。

// ---- winnt.h ----

/** TOKEN_ASSIGN_PRIMARY：CreateProcessAsUser 所需 */
export const TOKEN_ASSIGN_PRIMARY = 0x0001
/** TOKEN_DUPLICATE：DuplicateTokenEx 所需 */
export const TOKEN_DUPLICATE = 0x0002
/** TOKEN_QUERY：GetTokenInformation 所需 */
export const TOKEN_QUERY = 0x0008
/** TOKEN_ADJUST_DEFAULT：修改令牌默认 DACL 所需 */
export const TOKEN_ADJUST_DEFAULT = 0x0080

/** SE_GROUP_LOGON_ID：标记令牌组 SID 为登录 SID（高位为 1，需 >>> 0 无符号比较） */
export const SE_GROUP_LOGON_ID = 0xC0000000

/** STANDARD_RIGHTS_WRITE（== READ_CONTROL） */
export const STANDARD_RIGHTS_WRITE = 0x00020000
/** FILE_GENERIC_WRITE：文件写权限全集 + SYNCHRONIZE */
export const FILE_GENERIC_WRITE = 0x00120116
/** DELETE：删除/改名对象 */
export const DELETE = 0x00010000
/** FILE_DELETE_CHILD：删除/改名目录子项 */
export const FILE_DELETE_CHILD = 0x0040
/**
 * GRANT_MASK：写+删除（Explorer/icacls 显示 "Modify"）。WRITE_DAC/WRITE_OWNER 刻意排除：
 * 授予它们会让受限进程改写 DACL/取所有权而逃出允许名单（安全边界）。
 */
export const GRANT_MASK = (FILE_GENERIC_WRITE | DELETE | FILE_DELETE_CHILD) & ~STANDARD_RIGHTS_WRITE // 0x00110156

/** FILE_ALL_ACCESS：并入受限令牌默认 DACL 的 ACE 掩码（新对象创建必须保持持有者全权） */
export const FILE_ALL_ACCESS = 0x1F01FF

// ---- CreateRestrictedToken flags ----
/** DISABLE_MAX_PRIVILEGE：剥离令牌的最大权限提升 */
export const DISABLE_MAX_PRIVILEGE = 0x1
/** LUA_TOKEN：产生受限用户（过滤管理员）令牌 */
export const LUA_TOKEN = 0x4
/** WRITE_RESTRICTED：写访问与 restricting SIDs 的 ACL 授予求交——本沙盒核心机制 */
export const WRITE_RESTRICTED = 0x8

// ---- WELL_KNOWN_SID_TYPE ----
/** WinWorldSid：S-1-1-0（Everyone）——受限令牌 keep-alive 组 */
export const WinWorldSid = 1

// ---- TOKEN_INFORMATION_CLASS ----
/** TokenGroups：令牌组 SID */
export const TokenGroups = 2
/** TokenDefaultDacl：令牌默认 DACL（新对象无显式 SD 时采用） */
export const TokenDefaultDacl = 6

// ---- SECURITY_INFORMATION ----
/** DACL_SECURITY_INFORMATION：只读写安全描述符的 DACL */
export const DACL_SECURITY_INFORMATION = 0x00000004

// ---- PROCESS access rights ----
/** PROCESS_QUERY_INFORMATION */
export const PROCESS_QUERY_INFORMATION = 0x0400

// ---- accctrl.h ----
/** SE_FILE_OBJECT：trusee 路径是文件系统对象 */
export const SE_FILE_OBJECT = 1
/** TRUSTEE_IS_UNKNOWN：TRUSTEE_TYPE 未知（形状由 TrusteeForm 表达） */
export const TRUSTEE_IS_UNKNOWN = 0
/** TRUSTEE_IS_SID：Trustee.ptstrName 是 SID 指针 */
export const TRUSTEE_IS_SID = 0
/** NO_MULTIPLE_TRUSTEE */
export const NO_MULTIPLE_TRUSTEE = 0
/** GRANT_ACCESS：SetEntriesInAclW 加 allow ACE */
export const GRANT_ACCESS = 1
/** REVOKE_ACCESS：SetEntriesInAclW 删除匹配 allow ACE */
export const REVOKE_ACCESS = 4
/** SUB_CONTAINERS_AND_OBJECTS_INHERIT：ACE 作用于目录、子目录与文件（OI|CI） */
export const SUB_CONTAINERS_AND_OBJECTS_INHERIT = 0x3

// ---- winbase.h ----
/** STARTF_USESTDHANDLES：子进程使用 hStd* 句柄（Node 启动时清除了 stdio 可继承位） */
export const STARTF_USESTDHANDLES = 0x00000100
/** HANDLE_FLAG_INHERIT：SetHandleInformation 重新启用句柄继承 */
export const HANDLE_FLAG_INHERIT = 0x1
/** MAX_PATH */
export const MAX_PATH = 260
/** CREATE_SUSPENDED：主线程挂起创建（先入 kill-on-close job 再运行） */
export const CREATE_SUSPENDED = 0x4
/** STD_INPUT_HANDLE */
export const STD_INPUT_HANDLE = -10
/** STD_OUTPUT_HANDLE */
export const STD_OUTPUT_HANDLE = -11
/** STD_ERROR_HANDLE */
export const STD_ERROR_HANDLE = -12

// ---- FormatMessageW flags ----
/** FORMAT_MESSAGE_FROM_SYSTEM */
export const FORMAT_MESSAGE_FROM_SYSTEM = 0x00001000
/** FORMAT_MESSAGE_IGNORE_INSERTS */
export const FORMAT_MESSAGE_IGNORE_INSERTS = 0x00000200

// ---- error codes ----
/** ERROR_SUCCESS */
export const ERROR_SUCCESS = 0
/** ERROR_INSUFFICIENT_BUFFER：尺寸探测成功但缓冲区需更大 */
export const ERROR_INSUFFICIENT_BUFFER = 122
/** STILL_ACTIVE：GetExitCodeProcess 在进程仍运行时的返回值 */
export const STILL_ACTIVE = 259

// ---- job object ----
/** JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE：宿主最后一个 job 句柄关闭时终止 job 内全部进程 */
export const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
/** JobObjectExtendedLimitInformation：JOBOBJECTINFOCLASS */
export const JobObjectExtendedLimitInformation = 9
/** sizeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)（x64，abi-probe 核实） */
export const JOBOBJECT_EXTENDED_LIMIT_SIZE = 144
/** LimitFlags 在 JOBOBJECT_EXTENDED_LIMIT_INFORMATION 内的偏移（abi-probe 核实） */
export const JOBOBJECT_EXTENDED_LIMIT_FLAGS_OFFSET = 16

// ---- ABI 布局（x64，abi-probe 核实） ----
/** SECURITY_MAX_SID_SIZE */
export const SECURITY_MAX_SID_SIZE = 68
/** SID_AND_ATTRIBUTES 步长：{ PSID Sid @0 (8); DWORD Attributes @8 (4) } + pad */
export const SID_AND_ATTRIBUTES_SIZE = 16
/** TOKEN_GROUPS.Groups[] 起始偏移（GroupCount @0 + 对齐） */
export const TOKEN_GROUPS_OFFSET = 8
/** sizeof(EXPLICIT_ACCESS_W)：perms@0 mode@4 inheritance@8 Trustee@16 */
export const EXPLICIT_ACCESS_W_SIZE = 48
/** ptstrName 在 TRUSTEE_W 内的偏移（=> 40 在 EXPLICIT_ACCESS_W 内） */
export const TRUSTEE_W_PTSTRNAME_OFFSET = 24
/** sizeof(STARTUPINFOW) */
export const STARTUPINFOW_SIZE = 104
/** sizeof(PROCESS_INFORMATION) */
export const PROCESS_INFORMATION_SIZE = 24

// ---- ACE_HEADER ----
/** ACCESS_ALLOWED_ACE_TYPE */
export const ACCESS_ALLOWED_ACE_TYPE = 0
/** SID_MAX_SUB_AUTHORITIES */
export const SID_MAX_SUB_AUTHORITIES = 15
