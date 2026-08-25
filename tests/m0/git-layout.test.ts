// T0.2 行为测试：三线 git 布局（bare repo + 正式只读 worktree + 候选临时可写 worktree）。
// 真实 git/icacls 操作（禁 mock）：
//   - 独立临时目录（mkdtemp）完整复现布局并断言（不动真实布局）；
//   - 真实布局只读冒烟（读成功 + 写被拒，真实观察到拒绝，不许 mock）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildLayoutFixture,
  runGit,
  teardownLayoutFixture,
  type LayoutFixture,
} from '../helpers/git.js';

/** preset 根（tests/m0/ → ../../） */
const PRESET_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const REAL_STABLE = path.join(PRESET_ROOT, 'stable');
const REAL_EVOLUTION = path.join(PRESET_ROOT, 'workspace', '.omb', '.evolution');
const REAL_CANDIDATES = path.join(REAL_EVOLUTION, 'candidates');

/** 捕获写文件异常；返回 (error, code)。写成功则 error 为 null。 */
function captureWriteError(target: string): { error: NodeJS.ErrnoException | null; code: string | undefined } {
  try {
    fs.writeFileSync(target, 'probe');
    return { error: null, code: undefined };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return { error: e, code: e.code };
  }
}

describe('三线 git 布局（独立临时 fixture 完整复现）', () => {
  let fx: LayoutFixture;

  afterEach(() => {
    if (fx) {
      teardownLayoutFixture(fx);
    }
  });

  it('三个引用存在：refs/tags/initial、refs/heads/stable、refs/heads/main', () => {
    fx = buildLayoutFixture();
    const refs = runGit(['for-each-ref', '--format=%(refname)'], { cwd: fx.bare });
    expect(refs).toContain('refs/tags/initial');
    expect(refs).toContain('refs/heads/stable');
    expect(refs).toContain('refs/heads/main');
  });

  it('P1a 种子升级：trusted-latest 分支存在（latest = trusted head 指针，D1 裁决）', () => {
    fx = buildLayoutFixture();
    const refs = runGit(['for-each-ref', '--format=%(refname)'], { cwd: fx.bare });
    expect(refs).toContain('refs/heads/trusted-latest');
    // trusted-latest = latest 基线提交（main head）
    const trusted = runGit(['rev-parse', '--verify', 'refs/heads/trusted-latest^{commit}'], { cwd: fx.bare });
    const main = runGit(['rev-parse', '--verify', 'refs/heads/main^{commit}'], { cwd: fx.bare });
    expect(trusted).toBe(main);
    expect(trusted).toBe(fx.latestHash);
  });

  it('P1a 种子升级：基线提交含 kernel/policy + kernel/processes（出厂基线 = repo 快照），正式 worktree 可读到', () => {
    fx = buildLayoutFixture();
    // 提交树含认知对象
    const tree = runGit(['ls-tree', '-r', '--name-only', fx.initialHash], { cwd: fx.bare });
    expect(tree).toContain('kernel/policy/budget.yaml');
    expect(tree).toContain('kernel/policy/context.yaml');
    expect(tree).toContain('kernel/policy/governor.yaml');
    expect(tree).toContain('kernel/processes/hypothesize-test.yaml');
    expect(tree).toContain('kernel/processes/retrieve-verify.yaml');
    // 正式 worktree（stable = initial 基线 checkout）同样可读
    expect(fs.existsSync(path.join(fx.stable, 'kernel', 'policy', 'budget.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(fx.stable, 'kernel', 'processes', 'hypothesize-test.yaml'))).toBe(true);
  });

  it('正式 worktree（stable/）文件可读且内容正确', () => {
    fx = buildLayoutFixture();
    const manifest = JSON.parse(fs.readFileSync(path.join(fx.stable, 'manifest.json'), 'utf8')) as {
      name: string;
      version: string;
      line: string;
    };
    expect(manifest).toMatchObject({ name: 'omb-v2', version: '0.1.0', line: 'initial' });
  });

  it('正式 worktree（stable/）写被拒（真实 ACL：EPERM/EACCES）', () => {
    fx = buildLayoutFixture();
    const { error, code } = captureWriteError(path.join(fx.stable, 'probe.txt'));
    expect(error).not.toBeNull();
    expect(['EPERM', 'EACCES']).toContain(code);
  });

  it('正式 worktree（stable/）只读语义完整：可枚举、不可改既有文件、不可删', () => {
    fx = buildLayoutFixture();
    // 可枚举（目录列表可读）
    expect(fs.readdirSync(fx.stable)).toContain('manifest.json');
    // 改既有文件被拒
    const manifestPath = path.join(fx.stable, 'manifest.json');
    const { error: modifyErr, code: modifyCode } = captureWriteError(manifestPath);
    expect(modifyErr).not.toBeNull();
    expect(['EPERM', 'EACCES']).toContain(modifyCode);
    // 删既有文件被拒
    let deleteErr: NodeJS.ErrnoException | null = null;
    try {
      fs.unlinkSync(manifestPath);
    } catch (err) {
      deleteErr = err as NodeJS.ErrnoException;
    }
    expect(deleteErr).not.toBeNull();
    expect(['EPERM', 'EACCES']).toContain(deleteErr?.code);
  });

  it('候选临时 worktree（candidates/<id>/）可写且可读回', () => {
    fx = buildLayoutFixture();
    const probe = path.join(fx.candidate, 'candidate-probe.txt');
    fs.writeFileSync(probe, 'candidate write ok');
    expect(fs.readFileSync(probe, 'utf8')).toBe('candidate write ok');
    // 确认它确实是 git worktree（含 .git 指针）
    expect(fs.existsSync(path.join(fx.candidate, '.git'))).toBe(true);
  });

  it('git diff stable..main 可用且非空（两线已分叉）', () => {
    fx = buildLayoutFixture();
    const diff = runGit(['diff', '--stat', 'stable..main'], { cwd: fx.bare });
    expect(diff.length).toBeGreaterThan(0);
    expect(diff).toContain('manifest.json');
  });
});

describe('真实布局只读冒烟', () => {
  it('真实 stable/manifest.json 可读且为 initial 基线', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(REAL_STABLE, 'manifest.json'), 'utf8')) as {
      name: string;
      version: string;
      line: string;
    };
    expect(manifest).toMatchObject({ name: 'omb-v2', version: '0.1.0', line: 'initial' });
  });

  it('真实 stable/ 写被拒且只读语义完整（真实观察到拒绝，不许 mock）', () => {
    // 新文件写被拒
    const { error, code } = captureWriteError(path.join(REAL_STABLE, 'probe.txt'));
    expect(error).not.toBeNull();
    expect(['EPERM', 'EACCES']).toContain(code);
    // 目录可枚举（只读 ≠ 不可见）
    expect(fs.readdirSync(REAL_STABLE)).toContain('manifest.json');
    // 改既有文件被拒
    const manifestPath = path.join(REAL_STABLE, 'manifest.json');
    const { error: modifyErr, code: modifyCode } = captureWriteError(manifestPath);
    expect(modifyErr).not.toBeNull();
    expect(['EPERM', 'EACCES']).toContain(modifyCode);
    // 删既有文件被拒
    let deleteErr: NodeJS.ErrnoException | null = null;
    try {
      fs.unlinkSync(manifestPath);
    } catch (err) {
      deleteErr = err as NodeJS.ErrnoException;
    }
    expect(deleteErr).not.toBeNull();
    expect(['EPERM', 'EACCES']).toContain(deleteErr?.code);
  });

  it('真实布局三个引用存在且 stable/main 关系可 diff（分叉或对齐均确定性）', () => {
    const refs = runGit(['for-each-ref', '--format=%(refname)'], {
      cwd: path.join(PRESET_ROOT, 'versions.git'),
    });
    expect(refs).toContain('refs/tags/initial');
    expect(refs).toContain('refs/heads/stable');
    expect(refs).toContain('refs/heads/main');
    // 机器无关：真实仓库种子重建后 stable 可能 == main（无分叉）——只要求 diff 可执行且结果确定
    // （runGit 非 0 退出即抛 → 调用成立即 exit 0；返回字符串空/非空均合法）
    const diff = runGit(['diff', '--stat', 'stable..main'], {
      cwd: path.join(PRESET_ROOT, 'versions.git'),
    });
    expect(typeof diff).toBe('string');
  });

  it('真实候选 worktree 存在、是 worktree 且可写', () => {
    const entries = fs.readdirSync(REAL_CANDIDATES);
    expect(entries.length).toBeGreaterThan(0);
    const first = path.join(REAL_CANDIDATES, entries[0] ?? '');
    expect(fs.existsSync(path.join(first, '.git'))).toBe(true);
    const probe = path.join(first, 'smoke-probe.txt');
    fs.writeFileSync(probe, 'candidate writable');
    expect(fs.readFileSync(probe, 'utf8')).toBe('candidate writable');
    fs.rmSync(probe);
  });
});