// layer 0（T0.5）：候选临时目录创建/清理 + 平台受限子进程通道（**平台无关门面**）。
//
// 已知问题《Windows 绑定面与 Linux 迁移》/《外核平台抽象设计》修复：
//   - 本文件**不静态 import 任何 win32 模块**——受限执行实现（substrate/sandbox-win32.ts）在
//     Windows 上按需**动态 import**，非 Windows 平台完全不加载 win32-*.js 与 koffi；
//   - 平台能力经外核平台提供者（substrate/platform.ts）**识别**：可用 → 受限通道；不可用 →
//     显式降级并标注（`sandboxStatus()` 返回 reason），上层（candidate-pipeline G3-exec）记录
//     degraded 并跳过，门禁语义保持（fail-closed 不变量不变：绝不以完整令牌静默运行候选）。
//
// 平台无关部分（本文件保留）：
// - createCandidateDir：mkdtemp 于 workspace/.omb/.evolution/candidates/<id>-<rand>/；
//   返回 { dir, cleanup }；cleanup() 删目录树并从进程级兜底注册表移除；
//   进程退出兜底：模块级 process.on('exit') 同步 rmSync 全部未清理候选目录。
// - sandboxStatus：受限通道可用性（平台识别 + 实现可加载性）——绝不抛。
// - runRestricted：门面守护（脚本/目录校验 + 通道可用性检查）→ 委派平台实现。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// 外核平台提供者（识别层）：本文件据此决定"是否有可用受限通道"，不做任何 win32 静态依赖
import { platformProvider } from './platform.js'

// ---------------------------------------------------------------------------
// 候选临时目录（平台无关）
// ---------------------------------------------------------------------------

/** 真实候选根：<preset>/workspace/.omb/.evolution/candidates/
 *  布局回退（第二轮审查 H1）：编译部署下本模块位于 `<preset>/lib/substrate/`，`..` 只到 `<preset>/lib`，
 *  而数据根与 bootstrap 管理的候选目录都在 `<preset>/workspace/...` → 不做回退会把候选目录（含 baseline
 *  policy 副本与 verify.cjs）写进已部署代码树、且永不被布局迁移/清理覆盖。判定与 PLUGIN_ROOT 同款：
 *  `<cand>/kernel/policy` 存在 → cand 即 preset 根；否则回退一层。 */
function candidatesRoot(): string {
  const here = fileURLToPath(new URL('..', import.meta.url))
  const candidates = [here, path.join(here, '..')]
  for (const cand of candidates) {
    if (fs.existsSync(path.join(cand, 'kernel', 'policy'))) {
      return path.join(cand, 'workspace', '.omb', '.evolution', 'candidates')
    }
  }
  return path.join(here, 'workspace', '.omb', '.evolution', 'candidates')
}

/** 进程级兜底清理注册表（未显式 cleanup 的候选目录；进程退出时同步删除） */
const pendingDirs = new Set<string>()
let exitHandlerRegistered = false

function ensureExitHandler(): void {
  if (exitHandlerRegistered) return
  exitHandlerRegistered = true
  process.on('exit', () => {
    for (const dir of pendingDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {
        // exit 处理器内不得抛（异常会被忽略且可能打断其余清理）
      }
    }
    pendingDirs.clear()
  })
}

/** 候选 id 白名单（防路径穿越；与调用方 candidate_id 形状一致） */
const CANDIDATE_ID_RE = /^[A-Za-z0-9._-]+$/u

export interface CandidateDir {
  /** 候选目录绝对路径（已创建） */
  dir: string
  /** 幂等清理（删目录树并从兜底注册表移除；重复调用安全） */
  cleanup: () => void
}

/** 创建候选临时目录（<root>/<id>-<rand>/；id 白名单校验 fail-loud） */
export function createCandidateDir(id: string, opts: { root?: string } = {}): CandidateDir {
  if (!CANDIDATE_ID_RE.test(id)) {
    throw new Error(`createCandidateDir: 非法候选 id: ${id}`)
  }
  const root = opts.root ?? candidatesRoot()
  fs.mkdirSync(root, { recursive: true })
  const dir = fs.mkdtempSync(path.join(root, `${id}-`))
  ensureExitHandler()
  pendingDirs.add(dir)
  let cleaned = false
  return {
    dir,
    cleanup: () => {
      if (cleaned) return
      cleaned = true
      pendingDirs.delete(dir)
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {
        // 清理失败 → 退出兜底与后续清理仍会尝试（尽力而为）
      }
    },
  }
}

export interface SandboxStatus {
  /** 受限执行通道是否可用（平台有受限机制 + 平台实现可加载） */
  available: boolean;
  /** 不可用原因（available=false 时非空；机器可读，含平台能力降级说明） */
  reason?: string;
  /** 通道实现标识（available=true 时非空：'win32-restricted-token'） */
  mechanism?: string;
  /** 平台标识（排障用） */
  platform?: string;
}

/**
 * 受限通道可用性探测（平台识别 + 实现可加载性）：**绝不抛**。
 * 顺序：外核平台提供者给出平台能力（read-only / sandbox）→ Windows 上动态加载实现模块
 * （模块加载失败即视为通道不可用——koffi/DLL 缺失的真实降级面）。
 */
export async function sandboxStatusAsync(): Promise<SandboxStatus> {
  const caps = platformProvider().caps
  if (!caps.sandbox_available) {
    return {
      available: false,
      reason: `平台 ${caps.raw} 无受限执行通道（沙盒机制 = none）——安全语义变化已标注`,
      platform: caps.raw,
    };
  }
  try {
    await loadWin32Impl()
    return { available: true, mechanism: caps.sandbox, platform: caps.raw };
  } catch (err) {
    return { available: false, reason: `平台实现加载失败: ${(err as Error).message}`, platform: caps.raw };
  }
}

/**
 * 同步版通道探测（兼容既有调用方）：只依据平台能力判断，不触发实现模块加载。
 * 需要"实现是否真的可加载"的精确判断时用 `sandboxStatusAsync()`。
 */
export function sandboxStatus(): SandboxStatus {
  const caps = platformProvider().caps
  if (!caps.sandbox_available) {
    return {
      available: false,
      reason: `平台 ${caps.raw} 无受限执行通道（沙盒机制 = none）——安全语义变化已标注`,
      platform: caps.raw,
    };
  }
  return { available: true, mechanism: caps.sandbox, platform: caps.raw };
}

// ---------------------------------------------------------------------------
// 受限子进程（门面 → 平台实现）
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

/** 平台实现模块的最小结构面（动态 import；仅 Windows 有实现） */
interface Win32Impl {
  runRestricted(opts: RunRestrictedOptions): Promise<RunRestrictedResult>
}

let win32Impl: Promise<Win32Impl> | null = null

/** 动态加载平台实现（**仅 Windows**；非 Windows 直接失败——调用方已由能力检查挡住） */
function loadWin32Impl(): Promise<Win32Impl> {
  if (win32Impl === null) {
    if (process.platform !== 'win32') {
      return Promise.reject(new Error(`无平台受限实现（平台 ${process.platform}）`));
    }
    win32Impl = import('./sandbox-win32.js') as unknown as Promise<Win32Impl>;
  }
  return win32Impl;
}

/**
 * 受限执行（平台无关门面）：
 *   ① 入参校验（脚本存在、writableDirs/cwd 存在）——fail-loud，与拆分前一致；
 *   ② 平台通道检查：无可用受限机制 → **拒绝执行**（fail-closed 不变量：绝不以完整令牌静默运行；
 *      调用方应先经 sandboxStatusAsync() 探测并记录 degraded）；
 *   ③ 委派平台实现（Windows：动态加载 sandbox-win32.js）。
 */
export async function runRestricted(opts: RunRestrictedOptions): Promise<RunRestrictedResult> {
  const script = path.resolve(opts.script)
  if (!fs.existsSync(script) || !fs.statSync(script).isFile()) {
    throw new Error(`runRestricted: 脚本不存在或不是文件: ${script}`)
  }
  if (!Array.isArray(opts.writableDirs) || opts.writableDirs.length === 0) {
    throw new Error('runRestricted: 需要至少一个 writableDirs')
  }
  for (const dir of opts.writableDirs) {
    const resolved = path.resolve(dir)
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      throw new Error(`runRestricted: writableDir 不存在或不是目录: ${dir}`)
    }
  }
  const cwd = path.resolve(opts.cwd)
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    throw new Error(`runRestricted: cwd 不存在或不是目录: ${opts.cwd}`)
  }
  const caps = platformProvider().caps
  if (!caps.sandbox_available) {
    throw new Error(
      `runRestricted: 平台 ${caps.raw} 无受限执行通道（沙盒机制 = none）——fail-closed 拒绝以完整令牌运行候选`,
    )
  }
  const impl = await loadWin32Impl()
  return impl.runRestricted(opts)
}

/** 候选目录根（测试/排障可读；平台无关） */
export function sandboxCandidatesRoot(): string {
  return candidatesRoot()
}

/** 临时目录根候选（平台无关；仅供实现模块复用同一口径） */
export function sandboxTempRoot(): string {
  return os.tmpdir()
}
