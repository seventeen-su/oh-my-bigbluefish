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
  /** 受限执行通道是否可用（平台有受限机制 + 平台实现可加载 + **通道自检通过**） */
  available: boolean;
  /** 不可用原因（available=false 时非空；机器可读，含平台能力降级说明） */
  reason?: string;
  /** 通道实现标识（available=true 时非空：'win32-restricted-token' | 'posix-bwrap' | 'posix-node-permission'） */
  mechanism?: string;
  /** 平台标识（排障用） */
  platform?: string;
  /** 隔离强度（available=true 时：'write-restricted' = 写能力精确覆盖 writableDirs） */
  isolation?: SandboxIsolation;
  /** 机制说明（可用性口径/限制面；排障与诚实标注用） */
  mechanism_note?: string;
  /** 可用性是否经**真实自检**确认（true 时上方 available 为自检结论，而非"二进制存在"的乐观推断） */
  verified?: boolean;
  /** 自检结论说明（verified=true 时含授权/非授权写判定结果；false 时含跳过原因） */
  self_test_note?: string;
}

/** 通道隔离强度（与 Windows 受限令牌同一契约：写能力精确覆盖目标目录集合） */
export type SandboxIsolation = 'write-restricted';

/**
 * 平台受限执行通道（平台无关面；实现分别见 sandbox-win32.ts / sandbox-posix.ts，**按平台惰性加载**）。
 * `selfTest()` 是可用性的唯一权威判据：用一个真实探针跑一次「授权目录写成功 + 非授权目录写被拒」，
 * 两条都成立才算可用——「有二进制/模块能加载」不等于「写限制真的生效」。
 */
export interface SandboxChannel {
  /** 通道实现标识（与 PlatformCapabilities.sandbox 枚举同值域） */
  mechanism: string;
  isolation: SandboxIsolation;
  /** 机制说明（能力面/限制面；写入状态面，供使用者判断该通道的语义边界） */
  mechanism_note: string;
  selfTest(): Promise<SandboxSelfTest>;
  runRestricted(opts: RunRestrictedOptions): Promise<RunRestrictedResult>;
}

/** 通道自检结论 */
export interface SandboxSelfTest {
  ok: boolean;
  /** 结论说明（通过 → 授权/非授权写判定结果；不通过 → 具体原因） */
  note: string;
}

/**
 * 受限通道可用性探测（平台识别 + 实现可加载性 + **真实自检**）：**绝不抛**。
 * 顺序：外核平台提供者给出平台能力（read-only / sandbox）→ 取该平台的通道实现（Windows 动态加载
 * win32 模块；POSIX 选 bwrap/Node 权限模型）→ 自检一次（进程内缓存）。
 * 这是门禁侧（G3-exec）**应当使用**的探测入口：`sandboxStatus()`（同步版）只报平台能力面，
 * 不确认写限制是否真的生效。
 */
export async function sandboxStatusAsync(): Promise<SandboxStatus> {
  const caps = platformProvider().caps
  if (!caps.sandbox_available) {
    return {
      available: false,
      reason: `平台 ${caps.raw} 无受限执行通道（沙盒机制 = none）——安全语义变化已标注`,
      platform: caps.raw,
      verified: false,
      self_test_note: '未探测（平台能力面已判定无通道）',
    };
  }
  let channel: SandboxChannel | null
  try {
    channel = await loadSandboxChannel()
  } catch (err) {
    return {
      available: false,
      reason: `平台实现加载失败: ${(err as Error).message}`,
      platform: caps.raw,
      verified: false,
      self_test_note: '未探测（实现模块不可加载）',
    }
  }
  if (channel === null) {
    return {
      available: false,
      reason: `平台 ${caps.raw} 未找到可用受限执行实现（POSIX：bwrap 缺失且 Node 版本不支持权限模型）`,
      platform: caps.raw,
      verified: false,
      self_test_note: '未探测（无实现可加载）',
    }
  }
  const selfTest = await channel.selfTest()
  if (!selfTest.ok) {
    return {
      available: false,
      reason: `受限通道自检不通过：${selfTest.note}`,
      platform: caps.raw,
      mechanism: channel.mechanism,
      isolation: channel.isolation,
      mechanism_note: channel.mechanism_note,
      verified: true,
      self_test_note: selfTest.note,
    }
  }
  return {
    available: true,
    mechanism: channel.mechanism,
    platform: caps.raw,
    isolation: channel.isolation,
    mechanism_note: channel.mechanism_note,
    verified: true,
    self_test_note: selfTest.note,
  }
}

/**
 * 同步版通道探测（兼容既有调用方）：只依据平台能力判断，不触发实现模块加载与自检。
 * 需要"写限制是否真的生效"的精确判断时用 `sandboxStatusAsync()`（门禁侧用后者）。
 */
export function sandboxStatus(): SandboxStatus {
  const caps = platformProvider().caps
  if (!caps.sandbox_available) {
    return {
      available: false,
      reason: `平台 ${caps.raw} 无受限执行通道（沙盒机制 = none）——安全语义变化已标注`,
      platform: caps.raw,
      verified: false,
      self_test_note: '未探测（同步版只读平台能力面）',
    }
  }
  return {
    available: true,
    mechanism: caps.sandbox,
    platform: caps.raw,
    isolation: 'write-restricted',
    verified: false,
    self_test_note: '未探测（同步版只读平台能力面；精确判定请用 sandboxStatusAsync）',
  }
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
  /** 超时毫秒（缺省 60000）；超时后杀整棵进程树（Windows：TerminateJobObject；POSIX：SIGKILL + 命名空间回收） */
  timeoutMs?: number
}

export interface RunRestrictedResult {
  /** 退出码；timedOut 时恒为 null（被超时杀掉，退出码无意义） */
  code: number | null
  /** true = 超时被杀（杀整棵进程树） */
  timedOut: boolean
}

let channelPromise: Promise<SandboxChannel | null> | null = null

/**
 * 取当前平台的受限执行通道（**按平台惰性加载**；进程内缓存）：
 *   - Windows：动态 import `sandbox-win32.js`（非 Windows 平台完全不加载 win32-*.js 与 koffi）；
 *   - POSIX：`sandbox-posix.js`（bwrap → Node 权限模型；Windows 上不加载）。
 * 无可用实现 → null（调用方按能力缺失处理）。
 */
function loadSandboxChannel(): Promise<SandboxChannel | null> {
  if (channelPromise === null) {
    channelPromise = (async (): Promise<SandboxChannel | null> => {
      if (process.platform === 'win32') {
        const impl = (await import('./sandbox-win32.js')) as unknown as {
          win32SandboxChannel(): SandboxChannel
        }
        return impl.win32SandboxChannel()
      }
      const impl = (await import('./sandbox-posix.js')) as unknown as {
        posixSandboxChannel(): SandboxChannel | null
      }
      return impl.posixSandboxChannel()
    })()
  }
  return channelPromise
}

/** 清空通道缓存与自检缓存（仅测试用：同一进程内模拟不同平台/机制） */
export function resetSandboxChannelCache(): void {
  channelPromise = null
}

/**
 * 受限执行（平台无关门面）：
 *   ① 入参校验（脚本存在、writableDirs/cwd 存在）——fail-loud，与拆分前一致；
 *   ② 平台通道检查：无可用受限机制 → **拒绝执行**（fail-closed 不变量：绝不以完整权限静默运行；
 *      调用方应先经 sandboxStatusAsync() 探测并记录 degraded）；
 *   ③ 委派平台实现（Windows：sandbox-win32.js；POSIX：sandbox-posix.js）。
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
      `runRestricted: 平台 ${caps.raw} 无受限执行通道（沙盒机制 = none）——fail-closed 拒绝以完整权限运行候选`,
    )
  }
  const channel = await loadSandboxChannel()
  if (channel === null) {
    throw new Error(`runRestricted: 平台 ${caps.raw} 未找到可用受限执行实现——fail-closed 拒绝以完整权限运行候选`)
  }
  return channel.runRestricted(opts)
}

/** 候选目录根（测试/排障可读；平台无关） */
export function sandboxCandidatesRoot(): string {
  return candidatesRoot()
}

/** 临时目录根候选（平台无关；仅供实现模块复用同一口径） */
export function sandboxTempRoot(): string {
  return os.tmpdir()
}
