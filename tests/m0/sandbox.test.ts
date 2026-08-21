// T0.5 行为测试：候选临时目录创建/清理 + Windows WRITE_RESTRICTED 受限子进程（koffi FFI）。
// 真实 Windows 令牌/ACL/进程操作（禁 mock）：
//   - 独立 mkdtemp fixture（workspace 根 + candidates 子目录）上做破坏性操作（受限写拒绝/允许、超时 kill）；
//   - 真实 workspace/.omb/.evolution/candidates 只做冒烟（建→清，零残留，不触碰真实候选 worktree 内容）。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createCandidateDir, runRestricted } from '../../substrate/sandbox.js';

/** preset 根（tests/m0/ → ../../） */
const PRESET_ROOT = fileURLToPath(new URL('../..', import.meta.url));
/** 真实候选根（冒烟专用，只读+建→清） */
const REAL_CANDIDATES = path.join(PRESET_ROOT, 'workspace', '.omb', '.evolution', 'candidates');

/** 宿主进程的 node 可执行文件（受限子进程 = node 跑 .cjs 脚本） */
const NODE = process.execPath;

/** mkdtemp 临时 workspace 根 + candidates 子目录（复刻真实布局结构） */
function buildFixture(): { root: string; candidates: string; writable: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omb-sandbox-'));
  const candidates = path.join(root, 'workspace', '.omb', '.evolution', 'candidates');
  fs.mkdirSync(candidates, { recursive: true });
  const writable = path.join(root, 'writable');
  fs.mkdirSync(writable, { recursive: true });
  return { root, candidates, writable };
}

/** 删除目录树并对 EPERM/EBUSY 短退避重试（teardown 竞态硬化）。
 * 背景：受限子进程被 TerminateJobObject 杀死后，其 cwd 目录句柄释放存在 OS 级时序竞态
 * （task-5.2-flake-report.md 关注点 2）——kill 返回后立刻 rmSync 偶发 EPERM。此处重试
 * 至多 attempts 次（线性退避 delayMs×n），非 EPERM/EBUSY 错误 fail-loud 不重试。
 * 仿 git.ts teardownLayoutFixture 的 "rmSync → catch → 处理 → retry" 模式。 */
async function removeDirRetry(
  target: string,
  opts: { attempts?: number; delayMs?: number; remove?: (p: string) => void } = {},
): Promise<void> {
  const { attempts = 5, delayMs = 100, remove = (p) => fs.rmSync(p, { recursive: true, force: true }) } = opts;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      remove(target);
      return;
    } catch (err) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== 'EPERM' && code !== 'EBUSY') throw err;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
      }
    }
  }
  throw lastErr;
}

/** 清理 fixture（host 侧不受限制；rmSync 对 EPERM/EBUSY 短退避重试，见 removeDirRetry） */
function teardownFixture(root: string): Promise<void> {
  return removeDirRetry(root);
}

/** 把路径安全嵌入生成的 JS 脚本源码（Windows 反斜杠 → JSON 字符串字面量） */
function jsLiteral(value: string): string {
  return JSON.stringify(value);
}

/** 在 fixture 中写一个 .cjs 脚本文件（宿主写入；受限子进程只需读） */
function writeScript(root: string, name: string, body: string): string {
  const script = path.join(root, `${name}.cjs`);
  fs.writeFileSync(script, body, 'utf8');
  return script;
}

/** 基本执行脚本：写结果文件 + 透传第一个 argv */
const SCRIPT_BASIC = `const fs = require('node:fs');
const resultFile = process.env.OMB_SANDBOX_RESULT_FILE;
if (!resultFile) { process.exit(3); }
fs.writeFileSync(resultFile, 'BASIC-OK:' + (process.argv[2] ?? ''));
`;

/** 写受限目录脚本：尝试写 target；结果写入结果文件（WRITE_OK / WRITE_FAILED:<code>） */
function scriptWriteTarget(target: string): string {
  return `const fs = require('node:fs');
const resultFile = process.env.OMB_SANDBOX_RESULT_FILE;
try {
  fs.writeFileSync(${jsLiteral(target)}, 'pwned');
  fs.writeFileSync(resultFile, 'WRITE_OK');
} catch (e) {
  fs.writeFileSync(resultFile, 'WRITE_FAILED:' + (e && e.code ? e.code : String(e)));
}
`;
}

/** 写可写目录脚本：写 proof 文件 + 在 os.tmpdir() 建临时文件（证明 TMP/TEMP 已改写） */
function scriptWriteAllowed(proof: string): string {
  return `const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const resultFile = process.env.OMB_SANDBOX_RESULT_FILE;
fs.writeFileSync(${jsLiteral(proof)}, 'PROOF');
const t = fs.mkdtempSync(path.join(os.tmpdir(), 'omb-t-'));
fs.writeFileSync(path.join(t, 'x.txt'), 'TMP');
fs.writeFileSync(resultFile, 'WRITE_OK+TMP_OK');
`;
}

/** 挂起脚本（超时测试用） */
const SCRIPT_HANG = `setTimeout(() => {}, 60000);
`;

describe('createCandidateDir 候选临时目录（mkdtemp fixture）', () => {
  let fx: { root: string; candidates: string; writable: string };

  it('目录创建于 candidates/ 下、前缀含 id；cleanup() 后目录消失', () => {
    fx = buildFixture();
    const h = createCandidateDir('cand', { root: fx.candidates });
    try {
      expect(path.dirname(h.dir)).toBe(fx.candidates);
      expect(path.basename(h.dir)).toMatch(/^cand-/);
      expect(fs.existsSync(h.dir)).toBe(true);
      expect(fs.statSync(h.dir).isDirectory()).toBe(true);
    } finally {
      h.cleanup();
    }
    expect(fs.existsSync(h.dir)).toBe(false);
  });

  it('非法 id（含路径分隔符）fail-loud', () => {
    fx = buildFixture();
    expect(() => createCandidateDir('..\\evil', { root: fx.candidates })).toThrow();
    expect(() => createCandidateDir('a/b', { root: fx.candidates })).toThrow();
  });

  afterEach(async () => {
    if (fx) {
      await teardownFixture(fx.root);
    }
  });
});

describe('runRestricted 受限子进程（WRITE_RESTRICTED 令牌，koffi FFI）', () => {
  let fx: { root: string; candidates: string; writable: string };

  afterEach(async () => {
    if (fx) {
      await teardownFixture(fx.root);
    }
  });

  it('基本执行：受限进程跑脚本成功（code 0），结果文件内容正确（脚本经 OMB_SANDBOX_RESULT_FILE 写结果）', async () => {
    fx = buildFixture();
    const script = writeScript(fx.root, 'basic', SCRIPT_BASIC);
    const resultFile = path.join(fx.writable, 'result.txt');

    const r = await runRestricted({
      script,
      args: ['hello'],
      cwd: fx.writable,
      writableDirs: [fx.writable],
      resultFile,
      timeoutMs: 30000,
    });

    expect(r.code).toBe(0);
    expect(r.timedOut).toBe(false);
    expect(fs.readFileSync(resultFile, 'utf8')).toBe('BASIC-OK:hello');
  });

  it('写受限目录被拒：脚本写非 writableDirs 路径（fixture 根）→ 结果文件含 WRITE_FAILED，目标文件不存在', async () => {
    fx = buildFixture();
    const target = path.join(fx.root, 'forbidden.txt');
    const script = writeScript(fx.root, 'denied', scriptWriteTarget(target));
    const resultFile = path.join(fx.writable, 'result.txt');

    const r = await runRestricted({
      script,
      cwd: fx.writable,
      writableDirs: [fx.writable],
      resultFile,
      timeoutMs: 30000,
    });

    expect(r.code).toBe(0); // 脚本捕获了写失败并写入结果标记
    const text = fs.readFileSync(resultFile, 'utf8');
    // 实测错误码（EPERM/EACCES 均为写拒绝语义；具体值记录进 task-0.5-report.md）
    expect(text).toMatch(/^WRITE_FAILED:(EPERM|EACCES)/);
    expect(fs.existsSync(target)).toBe(false);
  });

  it('写可写目录成功：脚本写 writableDirs 内文件 + 在 os.tmpdir() 建临时文件（证明 TMP/TEMP 已改写为私有目录）', async () => {
    fx = buildFixture();
    const proof = path.join(fx.writable, 'proof.txt');
    const script = writeScript(fx.root, 'allowed', scriptWriteAllowed(proof));
    const resultFile = path.join(fx.writable, 'result.txt');

    const r = await runRestricted({
      script,
      cwd: fx.writable,
      writableDirs: [fx.writable],
      resultFile,
      timeoutMs: 30000,
    });

    expect(r.code).toBe(0);
    expect(r.timedOut).toBe(false);
    expect(fs.readFileSync(proof, 'utf8')).toBe('PROOF');
    expect(fs.readFileSync(resultFile, 'utf8')).toBe('WRITE_OK+TMP_OK');
  });

  it('超时：timeoutMs 很小 → timedOut true、code null，进程被 kill 且不挂起', async () => {
    fx = buildFixture();
    const script = writeScript(fx.root, 'hang', SCRIPT_HANG);
    const started = Date.now();

    const r = await runRestricted({
      script,
      cwd: fx.writable,
      writableDirs: [fx.writable],
      timeoutMs: 800,
    });

    expect(r.timedOut).toBe(true);
    expect(r.code).toBeNull();
    expect(Date.now() - started).toBeLessThan(15000); // 不挂起（实测 kill 远快于此）
  });
});

describe('退出即清', () => {
  it('cleanup() 后临时目录不存在', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omb-sandbox-'));
    const candidates = path.join(root, 'workspace', '.omb', '.evolution', 'candidates');
    fs.mkdirSync(candidates, { recursive: true });
    try {
      const h = createCandidateDir('clean', { root: candidates });
      expect(fs.existsSync(h.dir)).toBe(true);
      h.cleanup();
      expect(fs.existsSync(h.dir)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('进程退出路径（process.on("exit") 兜底）：子进程 createCandidateDir 后不调用 cleanup 直接退出 → 目录被 exit 处理器删除', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omb-sandbox-'));
    const candidates = path.join(root, 'workspace', '.omb', '.evolution', 'candidates');
    fs.mkdirSync(candidates, { recursive: true });
    try {
      // 真实 substrate 代码经 tsc 编译后由独立 node 子进程导入（node 24 原生 strip-types 不把 .js specifier 重写为 .ts，
      // 实测 ERR_MODULE_NOT_FOUND——见 task-0.5-report.md；故先 tsc 产出真实 .js 再导入）。
      // 产物目录放 node_modules/.cache 下：ESM bare specifier（koffi）从导入文件位置向上找 node_modules，
      // 在系统临时目录找不到 koffi（实测 ERR_MODULE_NOT_FOUND）→ 放 node_modules 祖先之下即可解析。
      const emitBase = path.join(PRESET_ROOT, 'node_modules', '.cache');
      fs.mkdirSync(emitBase, { recursive: true });
      const emitDir = fs.mkdtempSync(path.join(emitBase, 'omb-sandbox-emit-'));
      try {
        const tscBin = path.join(PRESET_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
        // 显式文件参数时 tsc 忽略 tsconfig.json（含 compilerOptions）→ 必须显式传编译选项
        execFileSync(
          NODE,
          [
            tscBin,
            '--outDir', emitDir,
            '--noEmit', 'false',
            '--module', 'nodenext',
            '--moduleResolution', 'nodenext',
            '--target', 'es2023',
            '--esModuleInterop',
            '--strict',
            '--skipLibCheck',
            'substrate/sandbox.ts',
          ],
          { cwd: PRESET_ROOT, encoding: 'utf8', windowsHide: true, timeout: 60000 },
        );
        // 单文件显式参数 → rootDir 即 substrate/，产物平铺在 emitDir 根（sandbox.js + 依赖）
        const sandboxEmitted = path.join(emitDir, 'sandbox.js');
        expect(fs.existsSync(sandboxEmitted)).toBe(true);

        const childCode = `import { createCandidateDir } from ${jsLiteral('file:///' + sandboxEmitted.replaceAll('\\', '/'))};
const h = createCandidateDir('exit-probe', { root: ${jsLiteral(candidates)} });
console.log('DIR=' + h.dir);
// 故意不调用 cleanup —— 验证进程退出时 process.on('exit') 兜底清理
`;
        const stdout = execFileSync(NODE, ['--input-type=module', '-e', childCode], {
          cwd: PRESET_ROOT,
          encoding: 'utf8',
          windowsHide: true,
          timeout: 30000,
        });
        const match = /^DIR=(.+)$/m.exec(stdout);
        expect(match).not.toBeNull();
        const childDir = match?.[1] ?? '';
        expect(childDir.length).toBeGreaterThan(0);
        // 子进程已退出且未调用 cleanup → exit 兜底处理器应已删除该目录
        expect(fs.existsSync(childDir)).toBe(false);
      } finally {
        fs.rmSync(emitDir, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('removeDirRetry（teardown EPERM/EBUSY 竞态硬化：短退避重试）', () => {
  it('EPERM 瞬态：前两次删除失败（EPERM）第三次成功 → 最终成功，共调用 3 次', async () => {
    const calls: string[] = [];
    const fake = (p: string): void => {
      calls.push(p);
      if (calls.length < 3) {
        const e = new Error('EPERM') as NodeJS.ErrnoException;
        e.code = 'EPERM';
        throw e;
      }
    };
    await removeDirRetry('C:\\fake\\dir', { attempts: 5, delayMs: 0, remove: fake });
    expect(calls).toHaveLength(3);
  });

  it('EBUSY 同样被重试（句柄占用常见 EBUSY）', async () => {
    const calls: string[] = [];
    const fake = (p: string): void => {
      calls.push(p);
      if (calls.length === 1) {
        const e = new Error('EBUSY') as NodeJS.ErrnoException;
        e.code = 'EBUSY';
        throw e;
      }
    };
    await removeDirRetry('C:\\fake\\dir', { attempts: 5, delayMs: 0, remove: fake });
    expect(calls).toHaveLength(2);
  });

  it('非 EPERM/EBUSY 错误 fail-loud 立即抛（不重试、不吞错）', async () => {
    const fake = (): void => {
      const e = new Error('EACCES') as NodeJS.ErrnoException;
      e.code = 'EACCES';
      throw e;
    };
    await expect(removeDirRetry('C:\\fake\\dir', { attempts: 5, delayMs: 0, remove: fake })).rejects.toThrow('EACCES');
  });

  it('重试耗尽仍失败 → 抛出最后一次错误', async () => {
    const fake = (): void => {
      const e = new Error('EPERM') as NodeJS.ErrnoException;
      e.code = 'EPERM';
      throw e;
    };
    await expect(removeDirRetry('C:\\fake\\dir', { attempts: 3, delayMs: 0, remove: fake })).rejects.toThrow('EPERM');
  });

  it('默认 remove=rmSync：真实临时目录树删除成功', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omb-sandbox-'));
    fs.mkdirSync(path.join(root, 'sub'));
    await removeDirRetry(root);
    expect(fs.existsSync(root)).toBe(false);
  });
});

describe('真实布局冒烟（workspace/.omb/.evolution/candidates，零残留）', () => {
  it('createCandidateDir + runRestricted 在真实 candidates 根上可用：受限进程写结果文件成功，cleanup 后零残留', async () => {
    expect(fs.existsSync(REAL_CANDIDATES)).toBe(true);
    const h = createCandidateDir('m0-smoke');
    try {
      expect(path.dirname(h.dir)).toBe(REAL_CANDIDATES);
      const resultFile = path.join(h.dir, 'smoke-result.txt');
      const script = writeScript(h.dir, 'smoke', SCRIPT_BASIC);

      const r = await runRestricted({
        script,
        args: ['smoke'],
        cwd: h.dir,
        writableDirs: [h.dir],
        resultFile,
        timeoutMs: 30000,
      });

      expect(r.code).toBe(0);
      expect(r.timedOut).toBe(false);
      expect(fs.readFileSync(resultFile, 'utf8')).toBe('BASIC-OK:smoke');
    } finally {
      h.cleanup();
    }
    expect(fs.existsSync(h.dir)).toBe(false);
  });
});