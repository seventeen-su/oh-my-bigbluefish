// layer 0（substrate/）：外核平台提供者（已知问题《Windows 绑定面与 Linux 迁移》/《外核平台抽象设计》）。
//
// 职责（外核 = 恢复根）：**识别 → 拉起 → 控制**三层里与平台相关的那部分，收敛到单一提供者接口，
// 使上层（supervisor / kernel / runtime）零改动即可跨平台：
//   - 识别（`platformProvider()`）：平台类型 + 能力探测（只读机制 / 沙盒机制）；
//   - 拉起（`readOnly.apply` / `reset`）：三线工作树只读施加与释放——Windows 用 icacls ACL，
//     Linux/macOS 用 POSIX 权限位（目录去写位，对目录即"不可增删改条目"）；
//   - 控制（`caps.sandbox`）：受限执行通道的**机制类别**标注（实现按平台惰性加载：
//     substrate/sandbox-win32.ts 用 Win32 原语 + koffi，substrate/sandbox-posix.ts 用
//     bwrap 命名空间或 Node 权限模型；Linux 上不触碰 win32 模块与 koffi）。
//     写限制是否**真的生效**由 substrate/sandbox.ts 的通道自检确认（sandboxStatusAsync）——
//     识别层不假装可用。
//
// 三条纪律：
//   1. **显式降级并标注**：平台能力缺失（如 POSIX 权限位被 ACL/容器覆盖、受限令牌不可用）→ 返回
//      `degraded` 说明，不静默、不假装可用；安全语义变化在文档与状态面注明；
//   2. **Windows 现有能力保持**：win32 路径的调用序列与参数与本提供者引入前完全一致；
//   3. **自身永不阻塞宿主**：本模块只做探测与薄封装，任何失败都返回结果对象（不抛穿到宿主）。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 平台类别（仅区分三类：windows / posix（Linux、macOS）/ 其它未知） */
export type PlatformKind = 'windows' | 'posix' | 'unknown';

/** 沙盒机制标识（识别面枚举；实现分别见 substrate/sandbox-win32.ts 与 substrate/sandbox-posix.ts） */
export type SandboxMechanism =
  | 'win32-restricted-token'
  | 'posix-bwrap'
  | 'posix-node-permission'
  | 'none';

/** 只读机制与沙盒机制的可用性（**识别**面的输出；degraded 非空 = 显式降级并标注） */
export interface PlatformCapabilities {
  platform: PlatformKind;
  /** 平台原始标识（process.platform，排障用） */
  raw: string;
  /** 只读机制：'icacls'（Windows）/ 'posix-mode'（Linux、macOS）/ 'none'（不可用） */
  read_only: 'icacls' | 'posix-mode' | 'none';
  /** 只读机制是否可用（false → 只读施加会降级；degraded 说明原因） */
  read_only_available: boolean;
  /** 沙盒机制：'win32-restricted-token'（Windows 受限令牌）/ 'posix-bwrap'（bubblewrap 命名空间）/
   *  'posix-node-permission'（Node 权限模型，零依赖）/ 'none'（无可用受限执行通道） */
  sandbox: SandboxMechanism;
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

/**
 * 子进程失败是否值得短退避重试（审查修复 M1）。
 * `execFileSync` 在"子进程以非 0 退出"时抛出的错误**只带 `status`/`stderr`，不带 `code`**（code 只在
 * spawn 级失败如 ENOENT 时存在）——旧判据只看 `code`，使重试分支对真实场景（icacls/chmod 因杀软、
 * 索引器、网络盘占用而退出 1）永远不可达，把一次性竞态变成长期降级。
 * 现在：spawn 级可重试码 → 重试；非 0 退出且 stderr 命中锁/占用特征 → 重试；其余 → 立即放弃。
 */
function isRetryableFailure(err: unknown): boolean {
  const e = err as NodeJS.ErrnoException & { status?: number; stderr?: Buffer | string };
  if (typeof e.code === 'string' && LOCK_RETRYABLE.has(e.code)) {
    return true;
  }
  if (typeof e.status === 'number' && e.status !== 0) {
    const stderr = e.stderr === undefined ? '' : String(e.stderr);
    return /access is denied|being used by another process|could not lock|permission denied|resource busy|device or resource busy/i.test(
      stderr,
    );
  }
  return false;
}

function sleepMs(ms: number): void {
  const shared = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(shared), 0, 0, ms);
}

/**
 * 目录真实写探测（写成功 = 可写；权限拒绝/只读介质 = 只读）——两条平台路径共用同一判据。
 *
 * 判定完备性（已知问题《只读介质被判"可写"》）：此前只把 `EPERM`/`EACCES` 当只读，其余错误一律
 * 「保守按可写」——但**只读介质**给出的不是权限错误而是文件系统错误：`EROFS`（容器只读挂载、
 * 光盘镜像、写保护分区——最常见）、`ENOSPC`（空间耗尽/配额用尽，表现为"看起来可写、写就失败"）、
 * `EBUSY`/`ETXTBSY`（介质/文件被占用）。这些一律判"不可写"，让上层走"只读已成立"的分支，
 * 而不是每次启动都报"只读丢失"并反复施加（反复子进程 + 反复降级）。
 * 其余错误（路径不存在、名太长等）同样按不可写返回——写能力未被证实就不该当作已证实。
 * 返回 null 仅保留给「目录缺失」这一语义明确的第三种状态。
 */
function probeWritable(dir: string): boolean | null {
  if (!fs.existsSync(dir)) {
    return null; // 目录缺失 → 由调用方按"不可用"处理
  }
  const probe = path.join(dir, `.omb-acl-probe-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`);
  try {
    fs.writeFileSync(probe, '');
  } catch {
    return false; // 写失败 = 不可写（权限/只读介质/占用/空间——原因不改变结论）
  }
  try {
    fs.unlinkSync(probe);
  } catch {
    // 删除失败 → 忽略（重新施加只读后为残留）；写成功本身即证明可写
  }
  return true;
}

/**
 * 可执行文件是否在 PATH 上（零依赖探测；不引子进程）。
 * **必须同时是常规文件**：只查 `X_OK` 会把目录判成可执行——POSIX 上目录的可执行位表示"可进入"，
 * 且 PATH 里出现同名**目录**完全可能（`bwrap/` 源码目录、构建产物目录等）。漏了这一步，
 * 平台能力面会报出 `posix-bwrap` 这个**错的机制类别**（随后自检失败 → available:false），
 * 排障时指向错误的方向。POSIX 侧的同类探测（substrate/sandbox-posix.ts 的 whichFile）已有 isFile 检查。
 */
function hasExecutable(name: string): boolean {
  const pathEnv = process.env.PATH ?? '';
  if (pathEnv.length === 0) {
    return false;
  }
  for (const dir of pathEnv.split(path.delimiter)) {
    if (dir.length === 0) continue;
    const candidate = path.join(dir, name);
    try {
      if (!fs.statSync(candidate).isFile()) continue; // 同名目录/设备 → 不算可执行文件
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      // 不在该目录 → 继续
    }
  }
  return false;
}

/** bwrap（bubblewrap）是否在 PATH 上（POSIX 首选受限通道；真正可用性由 substrate/sandbox.ts 自检确认） */
function hasBwrap(): boolean {
  return process.platform === 'linux' && hasExecutable('bwrap');
}

/** Node 权限模型是否可用（`--permission` 自 Node 20 起；真正生效由自检确认——零系统依赖的兜底通道） */
function nodePermissionCapable(): boolean {
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  return Number.isFinite(major) && major >= 20;
}

/**
 * 只读 ACL 授予主体（**用 well-known SID 而非账户名**——已知问题《icacls 用 Everyone 而非 SID》）。
 *
 * 语义与账户名 `Everyone` 完全等价：icacls 的 SID 形式（`*<SID>`）由系统直接使用，不做名称解析；
 * 而账户名字符串需要按**系统语言/本地化**解析——德语 `Jeder`、法语 `Tout le monde` 等非英文
 * Windows 上 `Everyone` 可能解析失败 → 只读施加抛错 → 工作树保持可写（安全语义静默降级）。
 *
 * 常量与同仓 `substrate/win32-abi.ts` 的 `WinWorldSid`（= Win32 枚举 WELL_KNOWN_SID_TYPE.WinWorldSid
 * = 1，用于受限令牌 keep-alive 组）指同一个 SID：该处是**枚举值**（FFI 入参用），本处需要**字符串形式**
 * （icacls 命令行用），两者不是可互换的表示——故此处以字符串常量声明并交叉标注，不假装复用同一个值。
 */
const WORLD_SID_STRING = 'S-1-1-0';

/** Windows：icacls ACL（授权式只读，无 deny ACE/SYNCHRONIZE 副作用）。 */
function windowsReadOnly(): ReadOnlyMechanism | null {
  const systemRoot = process.env.SystemRoot;
  if (systemRoot === undefined || systemRoot.length === 0) {
    return null; // SystemRoot 缺失 → icacls 不可解析（能力缺失，由调用方标注降级）
  }
  const icacls = path.join(systemRoot, 'System32', 'icacls.exe');
  // 唯一参数变化：授予主体 'Everyone'（账户名，需本地化解析）→ '*S-1-1-0'（SID，免解析）
  const grantee = `*${WORLD_SID_STRING}`;
  const run = (args: string[], what: string, dir: string): void => {
    let last: unknown;
    for (let attempt = 0; attempt < LOCK_RETRY_COUNT; attempt++) {
      try {
        execFileSync(icacls, args, { encoding: 'utf8', windowsHide: true });
        return;
      } catch (err) {
        last = err;
        if (!isRetryableFailure(err)) break;
        if (attempt < LOCK_RETRY_COUNT - 1) sleepMs(50 * (attempt + 1));
      }
    }
    const e = last as { status?: number; stderr?: Buffer | string };
    const detail = e && e.stderr ? String(e.stderr).trimEnd() : '(无 stderr)';
    throw new Error(`icacls ${dir} ${what}失败 (exit=${(e as { status?: number }).status ?? '?'}): ${detail}`);
  };
  return {
    apply: (dir) => run([dir, '/inheritance:r', '/grant:r', `${grantee}:RX`, '/T', '/C'], '只读 ACL 施加', dir),
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
        if (!isRetryableFailure(err)) break;
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
    // u+w：仅恢复**所有者**写位（组/其他写位不恢复——审查记录：更彻底的恢复需要 apply 前留存原模式，
    // 当前实现不保存，故注释如实说明，不宣称"其余位保持"）
    reset: (dir) => run(['-R', 'u+w', dir], '只读权限释放', dir),
    // 只读判定（审查修复 H1）：**模式位优先**——root（CAP_DAC_OVERRIDE）下真实写探测恒成功，
    // 仅凭写探测会把"权限位已去写"误判成"可写"，于是每次启动都报"只读 ACL 丢失"并反复 chmod，
    // 而实际可写性又由 root 自身豁免（机制对该进程本就不构成约束）。模式位判定如实反映施加结果；
    // 目录缺失/stat 失败 → 回落到写探测（保守）。
    isReadOnly: (dir) => {
      try {
        const mode = fs.statSync(dir).mode;
        if ((mode & 0o222) === 0) {
          return true; // 三个写位全清 = 已施加只读（与 Windows ACL 判定等价的可观测口径）
        }
      } catch {
        // stat 失败 → 交给写探测（不存在/不可访问）
      }
      return probeWritable(dir) === false;
    },
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
    // 探测 chmod 是否真的可用（容器/只读挂载下可能失败；失败 → 显式降级）。
    // 审查修复 L1：探测目录改用 os.tmpdir()（不再读 TMPDIR——TMPDIR 指向不可写目录时会把
    // "临时目录不可用"误报成"chmod 不可用"，从而永久跳过只读施加，原因也是错的）。
    try {
      const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omb-chmod-probe-'));
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
    // root 运行时的诚实标注（审查修复 H1）：CAP_DAC_OVERRIDE 使权限位对**本进程**不构成约束，
    // 机制在语义上降级为"对其它进程有效"。不假称"可用即不可写"。
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      notes.push(
        '以 root 运行：POSIX 权限位只读对本进程不构成约束（CAP_DAC_OVERRIDE）——只读语义降级为"对其它用户/进程有效"，请勿据此断言工作树不可写',
      );
    }
  } else {
    notes.push(`未识别的平台 "${raw}"——只读机制不可用，只读施加降级为跳过`);
  }
  // 沙盒机制（**识别层只报机制类别**；写限制是否真的生效由 substrate/sandbox.ts 的通道自检确认）：
  //   - Windows：受限令牌（实现见 sandbox-win32.ts，Win32 原语惰性加载）；
  //   - POSIX：bwrap（命名空间 + 只读绑定）优先，其次 Node 权限模型（零系统依赖）——两者都不可用 → none。
  //     已知问题《Linux 适配不完整》主条：此前 POSIX 恒 none → 候选验证 G3-exec 恒降级 → 候选可能
  //     一次真实执行都没跑就晋级。现在 POSIX 有真实受限通道（可用性由自检确认），机制缺失时才降级。
  const posixMech: SandboxMechanism = hasBwrap() ? 'posix-bwrap' : nodePermissionCapable() ? 'posix-node-permission' : 'none';
  const sandbox: SandboxMechanism =
    platform === 'windows' ? 'win32-restricted-token' : platform === 'posix' ? posixMech : 'none';
  const sandboxAvailable = sandbox !== 'none';
  if (!sandboxAvailable) {
    notes.push(`平台 ${raw} 无可用受限执行通道（沙盒机制 = none）——候选执行走降级通道，安全语义变化已标注`);
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
