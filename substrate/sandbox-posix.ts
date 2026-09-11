// layer 0（substrate/）：POSIX 受限执行通道实现（已知问题《Linux 适配不完整》主条：
// 「沙盒机制 = 仅 Windows」使 Linux 上候选验证 G3-exec 恒降级 → 候选可能一次真实执行都没跑就晋级）。
//
// 与 Windows 实现（substrate/sandbox-win32.ts，WRITE_RESTRICTED 受限令牌）的对齐点：
//   同一语义 —— 「写能力精确覆盖 writableDirs 集合，其余路径写被拒」，且**可用性经真实自检确认**
//   （自检跑一个探针脚本：允许目录写成功 + 非授权目录写被拒 → 才算通道可用；不可用即诚实降级）。
//
// 两条机制（按强度顺序探测，**真实自检**决定可用性，不做「有二进制就算可用」的乐观假设）：
//   1. `bwrap`（bubblewrap，现代 Linux 桌面/容器的标配沙箱器）：新 mount/pid/ipc/uts/net/user 命名空间
//      + 整机只读绑定 + 仅 writableDirs 可写绑定。写限制由挂载表强制（脚本内无任何绕过面）。
//   2. Node 权限模型（`node --permission --allow-fs-read=… --allow-fs-write=…`）：**零系统依赖**
//      （只用宿主自带的 node），对 Node 自带的 fs API 强制 deny（非授权路径写 → ERR_ACCESS_DENIED）。
//      限制面窄于机制 1（原生扩展/绕过 fs 的路径不经该判定），故自检结论里如实标注（`mechanism_note`）。
//
// 三条纪律（沿用 platform.ts 的提供者纪律）：
//   ① 显式降级并标注：两条机制自检都不过 → 返回不可用 + 原因，由上层 fail-closed 拒绝执行；
//   ② 不触碰 win32：本文件与 koffi 无关（POSIX 专属），Windows 上不会被加载（sandbox.ts 按平台惰性加载）；
//   ③ 自身永不阻塞：探测与自检都带超时、失败一律转结果对象（不抛穿到宿主）。
// layer 0：仅 node: 内置 + substrate 内文件（CONVENTIONS §4）。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RunRestrictedOptions, RunRestrictedResult, SandboxChannel } from './sandbox.js';

/** 机制标识（与 PlatformCapabilities.sandbox 枚举同值域） */
export const POSIX_BWRAP = 'posix-bwrap' as const;
export const POSIX_NODE_PERMISSION = 'posix-node-permission' as const;

/** 自检/探测子进程超时（秒级上限：探针只写一个文件） */
const SELF_TEST_TIMEOUT_MS = 20_000;

/** 规范化目录（realpath；失败回退 resolve） */
function canonicalDir(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

/** 可执行文件是否在 PATH 上（零依赖探测；不用 which/where 子进程） */
function hasExecutable(name: string): boolean {
  const pathEnv = process.env.PATH ?? '';
  if (pathEnv.length === 0) {
    return false;
  }
  for (const dir of pathEnv.split(path.delimiter)) {
    if (dir.length === 0) {
      continue;
    }
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) {
        return true;
      }
    } catch {
      // 不在该目录 → 继续
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// 探针脚本（自检用）：允许目录写必须成功、非授权目录写必须被拒
// ---------------------------------------------------------------------------

/**
 * 自检探针：argv = [allowedDir, deniedDir, resultFile]。
 * 判定：allowedDir 写成功 **且** deniedDir 写被拒（EACCES/EPERM/EROFS）→ 通道对写能力真实生效。
 * 任一不成立 → 该机制不可用（乐观假设会给出「可用」的假象，正是已知问题要修的那类错误）。
 */
const SELF_TEST_SCRIPT = `const fs = require('node:fs');
const path = require('node:path');
const [allowed, denied, resultFile] = process.argv.slice(2);
const probe = (dir) => {
  try {
    fs.writeFileSync(path.join(dir, '.omb-self-test'), 'x');
    return 'ALLOW';
  } catch (err) {
    return (err && err.code) ? err.code : String(err);
  }
};
const allowedResult = probe(allowed);
const deniedResult = probe(denied);
fs.writeFileSync(resultFile, JSON.stringify({ allowedResult, deniedResult }));
`;

// ---------------------------------------------------------------------------
// 机制 1：bwrap（bubblewrap）
// ---------------------------------------------------------------------------

/**
 * bwrap 可用性探测（**仅存在性**；真正可用性由 selfTest 的真实自检决定——用户命名空间被
 * 发行版/容器策略禁用时 bwrap 会以非 0 退出，自检会如实给出不可用）。
 */
export function bwrapPresent(): boolean {
  return process.platform !== 'win32' && process.platform !== 'darwin' && hasExecutable('bwrap');
}

/**
 * bwrap 参数构造（整机只读绑定 + 仅 writableDirs 可写绑定 + 私有 temp；命名空间隔离）。
 * 顺序纪律：`--ro-bind / /` 必须在所有 `--bind` 之前（后写的绑定覆盖先写的挂载）。
 *
 * ⚠️ **不要**在这里加 `--tmpfs /tmp`（真机实测踩过的坑：Debian 13 / bwrap 0.12.0）。
 * 私有 temp 目录建在 `os.tmpdir()` 下（Linux 上就是 `/tmp/omb-sandbox-XXXX`），而 `--tmpfs /tmp`
 * 会把 `/tmp` 换成**空 tmpfs** → `--bind` 的**绑定源**在命名空间里不存在 → bwrap 直接失败
 * （实测脚本根本没跑起来：`Cannot find module '/tmp/.../verify.cjs'`），自检因此不通过、
 * 整条 bwrap 通道静默失效（回落到较弱的权限模型通道）。
 * 去掉它之后：`/tmp` 继承 `--ro-bind / /` 的只读绑定，而 `--bind <私有temp> <私有temp>` 是显式覆盖
 * → 私有 temp 仍可写；实测 `allowed=ALLOW, denied=EROFS`，正是我们要的写限制语义。
 *
 * 网络安全语义：**不**加 `--unshare-net`——与 Windows 通道（受限令牌不拦网络）保持同一契约，
 * 不擅自收紧候选验证脚本的能力面（收紧会让原本合法的验证脚本无故失败）。
 */
export function bwrapArgs(opts: {
  writableDirs: string[];
  tempDir: string;
  resultFile: string | undefined;
  cwd: string;
  script: string;
  args: string[];
}): string[] {
  const a: string[] = [
    '--ro-bind', '/', '/',
    '--dev', '/dev',
    '--proc', '/proc',
    '--unshare-user',
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    '--new-session',
    '--die-with-parent',
  ];
  // 脚本所在目录：`--ro-bind / /` 已让它只读可见，**不要**再单独 ro-bind 一次。
  // ⚠️ 真机实测踩过的第二个坑：如果在下面的可写绑定**之后**再 `--ro-bind <scriptDir> <scriptDir>`，
  // 后写的挂载会覆盖先写的 —— 当脚本目录是 writableDirs/私有 temp 的祖先时（候选目录与结果目录
  // 同在一个 mkdtemp 根下就是这种形态），它会**把可写绑定重新挂成只读**，
  // 于是候选脚本写结果文件直接 EROFS（实测 `errno: -30, code: 'EROFS'`），
  // 而自检只会笼统报"未产出结果文件"——这种"自己把自己的写权限抹掉"的失败极难从现象反推。
  // 挂载顺序纪律：**只读绑定一律在前，可写绑定一律在后**。
  for (const dir of opts.writableDirs) {
    a.push('--bind', dir, dir);
  }
  // 私有 temp 显式可写绑定（覆盖 `--ro-bind / /` 给它的只读；绑定源在宿主上真实存在即可）
  a.push('--bind', opts.tempDir, opts.tempDir);
  a.push('--chdir', opts.cwd);
  if (opts.resultFile !== undefined) {
    a.push('--setenv', 'OMB_SANDBOX_RESULT_FILE', opts.resultFile);
  }
  a.push('--setenv', 'TMPDIR', opts.tempDir);
  a.push('--setenv', 'TMP', opts.tempDir);
  a.push('--setenv', 'TEMP', opts.tempDir);
  a.push(process.execPath, opts.script, ...opts.args);
  return a;
}

// ---------------------------------------------------------------------------
// 机制 2：Node 权限模型（零系统依赖）
// ---------------------------------------------------------------------------

/**
 * Node 权限模型可用性（版本面判定：`--permission` 自 Node 20 起提供；实际生效由 selfTest 自检确认）。
 * 该机制只用宿主自带的 node 可执行文件（`process.execPath`），**无任何新依赖**。
 */
export function nodePermissionPresent(): boolean {
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  return Number.isFinite(major) && major >= 20;
}

/** 权限模型参数（逐路径单独一个标志：逗号分隔列表自 Node 22 起已不再支持，实测会告警且不生效） */
function nodePermissionArgs(opts: {
  writableDirs: string[];
  tempDir: string;
  cwd: string;
  script: string;
  args: string[];
}): string[] {
  const readRoots = [...new Set([opts.cwd, opts.script, ...opts.writableDirs, opts.tempDir, path.dirname(process.execPath)])];
  const writeRoots = [...new Set([...opts.writableDirs, opts.tempDir])];
  const argv: string[] = ['--permission'];
  for (const dir of readRoots) {
    argv.push(`--allow-fs-read=${dir}`);
  }
  for (const dir of writeRoots) {
    argv.push(`--allow-fs-write=${dir}`);
  }
  // 验证脚本常需派生被测程序（如跑单测）——允许派生，但派生进程同样受权限模型约束（写面不扩大）
  argv.push('--allow-child-process');
  argv.push(opts.script, ...opts.args);
  return argv;
}

// ---------------------------------------------------------------------------
// 子进程执行（两条机制共用：超时 SIGKILL + 退出码）
// ---------------------------------------------------------------------------

interface SpawnInvocation {
  command: string;
  argv: string[];
  cwd: string;
  env: Record<string, string | undefined>;
}

/** 执行一次受限子进程；超时 SIGKILL（bwrap 的 pid 命名空间随其退出整体回收；node 直跑则是单进程） */
async function spawnWithTimeout(
  inv: SpawnInvocation,
  timeoutMs: number,
): Promise<RunRestrictedResult> {
  return await new Promise<RunRestrictedResult>((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    const child = spawn(inv.command, inv.argv, {
      cwd: inv.cwd,
      env: inv.env as NodeJS.ProcessEnv,
      stdio: 'ignore',
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // 已退出 → 忽略
      }
    }, timeoutMs);
    timer.unref?.();
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: timedOut ? null : code, timedOut });
    });
  });
}

// ---------------------------------------------------------------------------
// 通道构造
// ---------------------------------------------------------------------------

/** 自检超时预算（探针脚本自身极短；超时即视为该机制不可用——诚实降级，不无限等待） */
function selfTestEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_OPTIONS; // 自检自身不得继承宿主的权限模型开关（会干扰探针的写判定）
  return env;
}

/** 自检结果（{allowedResult, deniedResult}）→ 是否通过 + 说明 */
function judgeSelfTest(probeJson: string | null, mechanism: string): { ok: boolean; note: string } {
  if (probeJson === null) {
    return { ok: false, note: `${mechanism} 自检未产出结果文件` };
  }
  let parsed: { allowedResult?: unknown; deniedResult?: unknown };
  try {
    parsed = JSON.parse(probeJson) as { allowedResult?: unknown; deniedResult?: unknown };
  } catch (err) {
    return { ok: false, note: `${mechanism} 自检结果不可解析（${(err as Error).message}）` };
  }
  const allowed = String(parsed.allowedResult);
  const denied = String(parsed.deniedResult);
  if (allowed !== 'ALLOW') {
    return { ok: false, note: `${mechanism} 自检失败：授权目录写被拒（${allowed}）——通道过紧，候选无法写结果文件` };
  }
  if (denied === 'ALLOW') {
    return { ok: false, note: `${mechanism} 自检失败：非授权目录写成功——写限制未生效（fail-closed 拒绝）` };
  }
  return { ok: true, note: `${mechanism} 自检通过：授权目录写成功 + 非授权目录写被拒（${denied}）` };
}

/** 自检夹具：授权目录（可写）+ 非授权目录（须被拒）+ 结果文件 + 脚本 */
function makeSelfTestFixture(): { root: string; allowed: string; denied: string; script: string; resultFile: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omb-sandbox-selftest-'));
  const allowed = path.join(root, 'allowed');
  const denied = path.join(root, 'denied');
  fs.mkdirSync(allowed, { recursive: true });
  fs.mkdirSync(denied, { recursive: true });
  const script = path.join(root, 'self-test.cjs');
  fs.writeFileSync(script, SELF_TEST_SCRIPT, 'utf8');
  const resultFile = path.join(allowed, 'self-test-result.json');
  return {
    root,
    allowed,
    denied,
    script,
    resultFile,
    cleanup: () => {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        // 清理失败 → 残留于系统临时目录（无害；exit 兜底由 createCandidateDir 一族负责）
      }
    },
  };
}

/** bwrap 通道（自检真实跑一次：整机只读 + 单目录可写 + 非授权目录写必须被拒） */
function bwrapChannel(): SandboxChannel {
  return {
    mechanism: POSIX_BWRAP,
    isolation: 'write-restricted',
    mechanism_note:
      'bubblewrap：新 mount/pid/ipc/uts/user 命名空间 + 整机只读绑定 + 仅 writableDirs 可写绑定（写限制由挂载表强制）',
    async selfTest() {
      const fx = makeSelfTestFixture();
      try {
        const inv: SpawnInvocation = {
          command: 'bwrap',
          argv: bwrapArgs({
            writableDirs: [fx.allowed],
            tempDir: fx.allowed,
            resultFile: fx.resultFile,
            cwd: fx.allowed,
            script: fx.script,
            args: [fx.allowed, fx.denied, fx.resultFile],
          }),
          cwd: fx.allowed,
          env: selfTestEnv(),
        };
        try {
          const r = await spawnWithTimeout(inv, SELF_TEST_TIMEOUT_MS);
          if (r.timedOut) {
            return { ok: false, note: 'bwrap 自检超时（用户命名空间/系统策略可能禁用了 bwrap）' };
          }
        } catch (err) {
          return { ok: false, note: `bwrap 无法启动（${(err as Error).message}）` };
        }
        return judgeSelfTest(fs.existsSync(fx.resultFile) ? fs.readFileSync(fx.resultFile, 'utf8') : null, 'bwrap');
      } finally {
        fx.cleanup();
      }
    },
    async runRestricted(opts: RunRestrictedOptions): Promise<RunRestrictedResult> {
      const script = path.resolve(opts.script);
      if (!fs.existsSync(script) || !fs.statSync(script).isFile()) {
        throw new Error(`runRestricted: 脚本不存在或不是文件: ${script}`);
      }
      if (!Array.isArray(opts.writableDirs) || opts.writableDirs.length === 0) {
        throw new Error('runRestricted: 需要至少一个 writableDirs');
      }
      const writableDirs = opts.writableDirs.map(canonicalDir);
      for (const dir of writableDirs) {
        if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
          throw new Error(`runRestricted: writableDir 不存在或不是目录: ${dir}`);
        }
      }
      const cwd = canonicalDir(opts.cwd);
      if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
        throw new Error(`runRestricted: cwd 不存在或不是目录: ${cwd}`);
      }
      const selfCreatedTemp = opts.tempDir === undefined;
      const tempDir = opts.tempDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'omb-sandbox-'));
      try {
        const inv: SpawnInvocation = {
          command: 'bwrap',
          argv: bwrapArgs({
            writableDirs,
            tempDir: canonicalDir(tempDir),
            resultFile: opts.resultFile,
            cwd,
            script,
            args: opts.args ?? [],
          }),
          cwd,
          env: selfTestEnv(),
        };
        return await spawnWithTimeout(inv, opts.timeoutMs ?? 60_000);
      } finally {
        if (selfCreatedTemp) {
          try {
            fs.rmSync(tempDir, { recursive: true, force: true });
          } catch {
            // 自建 temp 删除失败 → 残留（无害）
          }
        }
      }
    },
  };
}

/** Node 权限模型通道（自检真实跑一次：授权目录写成功 + 非授权目录写被拒） */
function nodePermissionChannel(): SandboxChannel {
  return {
    mechanism: POSIX_NODE_PERMISSION,
    isolation: 'write-restricted',
    mechanism_note:
      'Node 权限模型（--permission + --allow-fs-read/--allow-fs-write）：零系统依赖；对 Node fs API 强制 deny，' +
      '但原生扩展/绕过 fs 的路径不经该判定——限制面窄于 bwrap（自检已确认写被拒）',
    async selfTest() {
      const fx = makeSelfTestFixture();
      try {
        const probe = nodePermissionProbe(fx);
        if (probe.timedOut) {
          return { ok: false, note: 'Node 权限模型自检超时' };
        }
        return judgeSelfTest(
          fs.existsSync(fx.resultFile) ? fs.readFileSync(fx.resultFile, 'utf8') : null,
          'Node 权限模型',
        );
      } finally {
        fx.cleanup();
      }
    },
    async runRestricted(opts: RunRestrictedOptions): Promise<RunRestrictedResult> {
      const script = path.resolve(opts.script);
      if (!fs.existsSync(script) || !fs.statSync(script).isFile()) {
        throw new Error(`runRestricted: 脚本不存在或不是文件: ${script}`);
      }
      if (!Array.isArray(opts.writableDirs) || opts.writableDirs.length === 0) {
        throw new Error('runRestricted: 需要至少一个 writableDirs');
      }
      const writableDirs = opts.writableDirs.map(canonicalDir);
      for (const dir of writableDirs) {
        if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
          throw new Error(`runRestricted: writableDir 不存在或不是目录: ${dir}`);
        }
      }
      const cwd = canonicalDir(opts.cwd);
      if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
        throw new Error(`runRestricted: cwd 不存在或不是目录: ${cwd}`);
      }
      const selfCreatedTemp = opts.tempDir === undefined;
      const tempDir = opts.tempDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'omb-sandbox-'));
      try {
        const argv = nodePermissionArgs({
          writableDirs,
          tempDir: canonicalDir(tempDir),
          cwd,
          script,
          args: opts.args ?? [],
        });
        // 权限模型也可经 NODE_OPTIONS 传递（避免宿主 shell 对长参数列表的差异）——
        // 这里显式走 argv：可见、可审计（NODE_OPTIONS 会继承给孙进程，语义更隐晦）。
        const inv: SpawnInvocation = {
          command: process.execPath,
          argv,
          cwd,
          env: selfTestEnv(),
        };
        return await spawnWithTimeout(inv, opts.timeoutMs ?? 60_000);
      } finally {
        if (selfCreatedTemp) {
          try {
            fs.rmSync(tempDir, { recursive: true, force: true });
          } catch {
            // 自建 temp 删除失败 → 残留（无害）
          }
        }
      }
    },
  };
}

/** 权限模型自检（同步等待：探针极短，且自检只在首次状态探测时跑一次） */
function nodePermissionProbe(fx: { allowed: string; denied: string; script: string; resultFile: string }): { timedOut: boolean } {
  const argv = nodePermissionArgs({
    writableDirs: [fx.allowed],
    tempDir: fx.allowed,
    cwd: fx.allowed,
    script: fx.script,
    args: [fx.allowed, fx.denied, fx.resultFile],
  });
  const r = spawnSync(process.execPath, argv, {
    cwd: fx.allowed,
    env: selfTestEnv(),
    encoding: 'utf8',
    timeout: SELF_TEST_TIMEOUT_MS,
    windowsHide: true,
  });
  if (r.error !== undefined && (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
    return { timedOut: true };
  }
  return { timedOut: false };
}

// ---------------------------------------------------------------------------
// 导出：机制选择（强度顺序：bwrap → Node 权限模型）
// ---------------------------------------------------------------------------

/**
 * 候选通道（**按强度顺序**；可用性由调用方经 `selfTest()` 决定）。
 *
 * 为什么是"候选列表"而不是"选一个返回"：真机实测发现 bwrap **存在但自检不通过**是常见形态
 * （例如用户命名空间被策略限制、或参数构造与该版本 bwrap 不兼容）——此时正确的行为是
 * **继续尝试下一个候选**，而不是直接判"平台无沙箱"。旧实现只看 `bwrapPresent()` 就返回 bwrap，
 * 自检失败后整条 POSIX 通道变成不可用，较弱的权限模型兜底通道被白白浪费。
 */
export function posixSandboxCandidates(): SandboxChannel[] {
  const out: SandboxChannel[] = [];
  if (bwrapPresent()) {
    out.push(bwrapChannel());
  }
  if (nodePermissionPresent()) {
    out.push(nodePermissionChannel());
  }
  return out;
}

/**
 * POSIX 受限执行通道（**兼容入口**）：返回强度最高的候选，其可用性仍需调用方自检确认。
 * 新代码请用 `posixSandboxCandidates()`（支持自检失败后回落下一个候选）。
 */
export function posixSandboxChannel(): SandboxChannel | null {
  return posixSandboxCandidates()[0] ?? null;
}

/** 清空通道缓存（仅测试用）——通道改为"每次新建候选 + 门面层缓存自检"后，本函数只保留兼容语义 */
export function resetPosixSandboxCache(): void {
  // 无进程内缓存需要清（候选在每次调用时按存在性重新构造；自检结论缓存由 substrate/sandbox.ts 持有）
}
