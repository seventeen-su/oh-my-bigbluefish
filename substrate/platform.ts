// layer 0（substrate/）：外核平台提供者（已知问题《Windows 绑定面与 Linux 迁移》/《外核平台抽象设计》）。
//
// 职责（外核 = 恢复根）：**识别 → 拉起 → 控制**三层里与平台相关的那部分，收敛到单一提供者接口，
// 使上层（supervisor / kernel / runtime）零改动即可跨平台：
//   - 识别（`platformProvider()`）：平台类型 + 能力探测（只读机制 / 沙盒机制）；
//   - 拉起（`readOnly.apply` / `reset`）：三线工作树只读施加与释放——Windows 用 icacls ACL，
//     Linux/macOS 用 POSIX 权限位（目录去写位，对目录即"不可增删改条目"）；
//   - 控制（`caps.sandbox`）：受限执行通道的可用性标注（实现仍在 substrate/sandbox.ts，
//     该模块的 Win32 原语为**惰性加载**，Linux 上不触碰 win32 模块与 koffi）。
//
// 三条纪律：
//   1. **显式降级并标注**：平台能力缺失（如 POSIX 权限位被 ACL/容器覆盖、受限令牌不可用）→ 返回
//      `degraded` 说明，不静默、不假装可用；安全语义变化在文档与状态面注明；
//   2. **Windows 现有能力保持**：win32 路径的调用序列与参数与本提供者引入前完全一致；
//   3. **自身永不阻塞宿主**：本模块只做探测与薄封装，任何失败都返回结果对象（不抛穿到宿主）。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** 平台类别（仅区分三类：windows / posix（Linux、macOS）/ 其它未知） */
export type PlatformKind = 'windows' | 'posix' | 'unknown';

/** 只读机制与沙盒机制的可用性（**识别**面的输出；degraded 非空 = 显式降级并标注） */
export interface PlatformCapabilities {
  platform: PlatformKind;
  /** 平台原始标识（process.platform，排障用） */
  raw: string;
  /** 只读机制：'icacls'（Windows）/ 'posix-mode'（Linux、macOS）/ 'none'（不可用） */
  read_only: 'icacls' | 'posix-mode' | 'none';
  /** 只读机制是否可用（false → 只读施加会降级；degraded 说明原因） */
  read_only_available: boolean;
  /** 沙盒机制：'win32-restricted-token'（Windows 受限令牌）/ 'none'（无可用受限执行通道） */
  sandbox: 'win32-restricted-token' | 'none';
  /** 沙盒机制是否可用（false → 候选执行走降级通道，安全语义变化已标注） */
  sandbox_available: boolean;
  /** 降级说明（空 = 全部能力可用） */
  degraded: string | null;
}

/** 只读施加/释放的提供者接口（按平台实现；失败语义：**抛错由调用方转 degraded**，与本模块引入前一致） */
export interface ReadOnlyMechanism {
  /** 施加只读（幂等；已只读时也应成功） */
  apply(dir: string): void;
  /** 解除只读（删除工作树前置；幂等） */
  reset(dir: string): void;
  /** 只读探测（真实写探测：写成功 = 可写） */
  isReadOnly(dir: string): boolean;
}

/** 平台提供者（识别 + 拉起 + 控制三面的统一出口） */
export interface PlatformProvider {
  readonly name: string;
  /** 能力快照（构造时探测一次；进程内不变） */
  readonly caps: PlatformCapabilities;
  /** 只读机制提供者（可用时返回实现；不可用 → null，调用方按"能力缺失 → 跳过并标注"处理） */
  readonly readOnly: ReadOnlyMechanism | null;
}

/** 瞬态锁错误（Windows ACL / POSIX chmod 均可能遇到；短退避重试） */
const LOCK_RETRYABLE = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY', 'EMFILE']);
const LOCK_RETRY_COUNT = 3;

function sleepMs(ms: number): void {
  const shared = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(shared), 0, 0, ms);
}

/** 目录真实写探测（写成功 = 可写；EPERM/EACCES = 只读）——两条平台路径共用同一判据 */
function probeWritable(dir: string): boolean | null {
  if (!fs.existsSync(dir)) {
    return null; // 目录缺失 → 由调用方按"不可用"处理
  }
  const probe = path.join(dir, `.omb-acl-probe-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`);
  try {
    fs.writeFileSync(probe, '');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES') {
      return false; // 写被拒 → 只读
    }
    return true; // 其他错误 → 保守按可写处理（由工作树修复兜底）
  }
  try {
    fs.unlinkSync(probe);
  } catch {
    // 删除失败 → 忽略（重新施加只读后为残留）
  }
  return true;
}

/** Windows：icacls ACL（授权式只读，无 deny ACE/SYNCHRONIZE 副作用）——与引入本提供者前完全同参 */
function windowsReadOnly(): ReadOnlyMechanism | null {
  const systemRoot = process.env.SystemRoot;
  if (systemRoot === undefined || systemRoot.length === 0) {
    return null; // SystemRoot 缺失 → icacls 不可解析（能力缺失，由调用方标注降级）
  }
  const icacls = path.join(systemRoot, 'System32', 'icacls.exe');
  const run = (args: string[], what: string, dir: string): void => {
    let last: unknown;
    for (let attempt = 0; attempt < LOCK_RETRY_COUNT; attempt++) {
      try {
        execFileSync(icacls, args, { encoding: 'utf8', windowsHide: true });
        return;
      } catch (err) {
        last = err;
        const code = (err as NodeJS.ErrnoException).code;
        if (code === undefined || !LOCK_RETRYABLE.has(code)) break;
        if (attempt < LOCK_RETRY_COUNT - 1) sleepMs(50 * (attempt + 1));
      }
    }
    const e = last as { status?: number; stderr?: Buffer | string };
    const detail = e && e.stderr ? String(e.stderr).trimEnd() : '(无 stderr)';
    throw new Error(`icacls ${dir} ${what}失败 (exit=${(e as { status?: number }).status ?? '?'}): ${detail}`);
  };
  return {
    apply: (dir) => run([dir, '/inheritance:r', '/grant:r', 'Everyone:RX', '/T', '/C'], '只读 ACL 施加', dir),
    reset: (dir) => run([dir, '/reset', '/T', '/C'], '只读 ACL 释放', dir),
    isReadOnly: (dir) => probeWritable(dir) === false,
  };
}

/**
 * POSIX（Linux / macOS）：权限位只读——目录递归去写位（`a-w`）。
 * 语义说明（安全语义变化已在文档标注）：对目录而言，去写位即"不可在该目录内增删改条目"，
 * 与 Windows 的 `Everyone:RX` 授权式只读在工作树场景下等效；**不改变所有者读/执行位**，
 * 因此运行期按线读取（物化快照另存于 workspace/.omb/lines/）不受影响。
 * `chmod -R a-w` 经系统 chmod 执行（与 icacls 同为短生命周期子进程，不持句柄）。
 */
function posixReadOnly(): ReadOnlyMechanism | null {
  const run = (args: string[], what: string, dir: string): void => {
    let last: unknown;
    for (let attempt = 0; attempt < LOCK_RETRY_COUNT; attempt++) {
      try {
        execFileSync('chmod', args, { encoding: 'utf8' });
        return;
      } catch (err) {
        last = err;
        const code = (err as NodeJS.ErrnoException).code;
        if (code === undefined || !LOCK_RETRYABLE.has(code)) break;
        if (attempt < LOCK_RETRY_COUNT - 1) sleepMs(50 * (attempt + 1));
      }
    }
    const e = last as { status?: number; stderr?: Buffer | string; code?: string };
    const detail = e && e.stderr ? String(e.stderr).trimEnd() : (e?.code ?? '(无 stderr)');
    throw new Error(`chmod ${dir} ${what}失败 (exit=${(e as { status?: number }).status ?? '?'}): ${detail}`);
  };
  return {
    // a-w：目录去写位（含子项）；不触碰读/执行位
    apply: (dir) => run(['-R', 'a-w', dir], '只读权限施加', dir),
    // u+w：恢复所有者写位（删除工作树前置；其余位保持）
    reset: (dir) => run(['-R', 'u+w', dir], '只读权限释放', dir),
    isReadOnly: (dir) => probeWritable(dir) === false,
  };
}

/** 逐个探测平台能力（不抛：任何异常都转成 degraded 说明） */
function detect(): PlatformCapabilities {
  const raw = process.platform;
  const platform: PlatformKind = raw === 'win32' ? 'windows' : raw === 'linux' || raw === 'darwin' ? 'posix' : 'unknown';
  const notes: string[] = [];
  let readOnly: ReadOnlyMechanism | null = null;
  let mech: PlatformCapabilities['read_only'] = 'none';
  if (platform === 'windows') {
    readOnly = windowsReadOnly();
    mech = 'icacls';
    if (readOnly === null) {
      notes.push('icacls 不可用（SystemRoot 缺失）——只读 ACL 施加降级为跳过（工作树将保持可写，安全语义变化）');
    }
  } else if (platform === 'posix') {
    readOnly = posixReadOnly();
    mech = 'posix-mode';
    // 探测 chmod 是否真的可用（容器/只读挂载下可能失败；失败 → 显式降级）
    try {
      const probeDir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'omb-chmod-probe-'));
      try {
        execFileSync('chmod', ['-R', 'a-w', probeDir], { encoding: 'utf8' });
        execFileSync('chmod', ['-R', 'u+w', probeDir], { encoding: 'utf8' });
      } finally {
        fs.rmSync(probeDir, { recursive: true, force: true });
      }
    } catch (err) {
      readOnly = null;
      notes.push(`chmod 不可用（${(err as Error).message}）——只读权限施加降级为跳过（工作树将保持可写，安全语义变化）`);
    }
  } else {
    notes.push(`未识别的平台 "${raw}"——只读机制不可用，只读施加降级为跳过`);
  }
  // 沙盒机制：Windows 受限令牌（实现见 substrate/sandbox.ts，Win32 原语惰性加载）；POSIX 无等价实现
  const sandboxAvailable = platform === 'windows';
  const sandbox: PlatformCapabilities['sandbox'] = sandboxAvailable ? 'win32-restricted-token' : 'none';
  if (!sandboxAvailable) {
    notes.push(`平台 ${raw} 无受限执行通道（沙盒机制 = none）——候选执行走降级通道，安全语义变化已标注`);
  }
  return {
    platform,
    raw,
    read_only: readOnly === null ? 'none' : mech,
    read_only_available: readOnly !== null,
    sandbox,
    sandbox_available: sandboxAvailable,
    degraded: notes.length === 0 ? null : notes.join('；'),
  };
}

/** 进程内单例（探测一次；能力在进程生命周期内视为不变） */
let cached: PlatformProvider | null = null;

/** 当前平台提供者（识别 + 拉起 + 控制三面的统一出口；**永不抛**） */
export function platformProvider(): PlatformProvider {
  if (cached !== null) return cached;
  let caps: PlatformCapabilities;
  try {
    caps = detect();
  } catch (err) {
    caps = {
      platform: 'unknown',
      raw: process.platform,
      read_only: 'none',
      read_only_available: false,
      sandbox: 'none',
      sandbox_available: false,
      degraded: `平台探测异常（${(err as Error).message}）——按"能力缺失"处理（不阻塞宿主）`,
    };
  }
  cached = {
    name: `platform:${caps.platform}`,
    caps,
    readOnly: caps.read_only_available ? (caps.platform === 'windows' ? windowsReadOnly() : posixReadOnly()) : null,
  };
  return cached;
}

/** 清空平台探测缓存（仅测试用：同一进程内模拟不同平台） */
export function resetPlatformProviderCache(): void {
  cached = null;
}
