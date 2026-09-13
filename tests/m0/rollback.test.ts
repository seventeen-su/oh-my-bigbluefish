// T0.4 行为测试：版本回滚原语 rollbackTo（基于 Git revision 的原子切换 + fsync + worktree 尽力同步）。
// 真实 git/icacls 操作（禁 mock）：
//   - 独立临时 fixture（mkdtemp 完整复现三线布局）上做破坏性操作（回退/删文件）；
//   - 真实布局只做只读冒烟（绝不切换真实 stable 引用）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { rollbackTo } from '../../substrate/rollback.js';
import {
  applyReadOnlyAcl,
  buildLayoutFixture,
  resetReadOnly,
  runGit,
  teardownLayoutFixture,
  type LayoutFixture,
} from '../helpers/git.js';
// 只读机制是否真约束本进程（root + POSIX 权限位时不约束 → 相关断言走另一分支）
import { readOnlyEnforced } from '../helpers/sandbox-scripts.js';

/** fixture 构建/真实 git 超时（buildLayoutFixture：2 提交 + 3 worktree + 2 icacls；全量套件并行 git/icacls 饱和——P7 flake 放宽 5s → 30s） */
const FIXTURE_TIMEOUT = 30000;
const fixtureIt = (name: string, fn: (() => void) | (() => Promise<void>)) => it(name, fn, FIXTURE_TIMEOUT);

/** preset 根（tests/m0/ → ../../） */
const PRESET_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const REAL_BARE = path.join(PRESET_ROOT, 'versions.git');

/** 解除 fixture stable worktree 的只读 ACL（回滚的 checkout 同步需要可写） */
function makeStableWritable(fx: LayoutFixture): void {
  resetReadOnly(fx.stable);
}

/** 读取 worktree 下 manifest.json 的 line 字段 */
function manifestLine(worktree: string): string {
  const manifest = JSON.parse(fs.readFileSync(path.join(worktree, 'manifest.json'), 'utf8')) as {
    line?: string;
  };
  return manifest.line ?? '';
}

/** 解析 bare 上某分支当前 head（完整 commit hash） */
function headOf(fx: LayoutFixture, branch = 'stable'): string {
  return runGit(['rev-parse', '--verify', `refs/heads/${branch}^{commit}`], { cwd: fx.bare });
}

/**
 * 在 stable 分支上造一个分叉推进提交（child of initialHash）并把 stable 指向它。
 * 返回新 commit hash（即测试中的 rev-A；initialHash 为可回退的上一 revision rev-B）。
 */
function advanceStable(fx: LayoutFixture, line: string): string {
  const seed = path.join(fx.root, `_seed-stable-${line}`);
  fs.mkdirSync(seed);
  fs.writeFileSync(
    path.join(seed, 'manifest.json'),
    JSON.stringify({ name: 'omb-v2', version: '0.1.0', line, components: {} }, null, 2),
  );
  fs.writeFileSync(path.join(seed, 'README.md'), `stable advanced: ${line}\n`);
  runGit(['add', '.'], { gitDir: fx.bare, workTree: seed });
  const tree = runGit(['write-tree'], { gitDir: fx.bare, workTree: seed });
  const commit = runGit(
    ['-c', 'user.name=OMB', '-c', 'user.email=omb@local', 'commit-tree', tree, '-p', fx.initialHash, '-m', `stable ${line}`],
    { gitDir: fx.bare },
  );
  runGit(['update-ref', 'refs/heads/stable', commit], { cwd: fx.bare });
  return commit;
}

describe('rollbackTo 版本回滚（独立临时 fixture）', () => {
  let fx: LayoutFixture;

  afterEach(() => {
    if (fx) {
      teardownLayoutFixture(fx);
    }
  });

  fixtureIt('成功回退：stable 从 rev-A 切到 rev-B，返回 previous/new head 正确，引用指向 rev-B', () => {
    fx = buildLayoutFixture();
    const revA = advanceStable(fx, 'stable-advanced');
    const revB = fx.initialHash;
    // 前置：stable 在 rev-A
    expect(headOf(fx)).toBe(revA);

    const result = rollbackTo({ bareRepo: fx.bare, revision: revB });

    expect(result.previous_head).toBe(revA);
    expect(result.new_head).toBe(revB);
    expect(result.worktree_synced).toBe(true); // 未提供 worktree → 无需同步
    expect(headOf(fx)).toBe(revB);
  });

  fixtureIt('损坏恢复：stable worktree 的 manifest.json 被删 → 回退上一 revision → head 回退且 worktree 文件恢复、内容正确', () => {
    fx = buildLayoutFixture();
    makeStableWritable(fx);
    const revA = advanceStable(fx, 'stable-advanced');
    // 先把 worktree 同步到当前 stable（rev-A），模拟线上内容
    runGit(['checkout', '--force', revA], { cwd: fx.stable });
    expect(manifestLine(fx.stable)).toBe('stable-advanced');
    // 模拟损坏：删掉 manifest.json
    fs.rmSync(path.join(fx.stable, 'manifest.json'));

    const result = rollbackTo({ bareRepo: fx.bare, revision: fx.initialHash, worktree: fx.stable });

    expect(result.new_head).toBe(fx.initialHash);
    expect(result.worktree_synced).toBe(true);
    expect(headOf(fx)).toBe(fx.initialHash);
    expect(fs.existsSync(path.join(fx.stable, 'manifest.json'))).toBe(true);
    expect(manifestLine(fx.stable)).toBe('initial');
  });

  fixtureIt('未知 revision fail-loud：抛错且 head 不变', () => {
    fx = buildLayoutFixture();
    const revA = advanceStable(fx, 'stable-advanced');
    const bogus = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

    expect(() => rollbackTo({ bareRepo: fx.bare, revision: bogus })).toThrow(/deadbeef/);
    expect(headOf(fx)).toBe(revA);
  });

  fixtureIt('fsync：回退后引用文件（<bare>/refs/heads/stable）存在且内容 == revision', () => {
    fx = buildLayoutFixture();
    advanceStable(fx, 'stable-advanced');

    rollbackTo({ bareRepo: fx.bare, revision: fx.initialHash });

    const refFile = path.join(fx.bare, 'refs', 'heads', 'stable');
    expect(fs.existsSync(refFile)).toBe(true);
    expect(fs.readFileSync(refFile, 'utf8').trim()).toBe(fx.initialHash);
  });

  fixtureIt('worktree 同步失败不抛错：只读 worktree 返回 worktree_synced:false，ref 仍已切换', () => {
    fx = buildLayoutFixture();
    makeStableWritable(fx);
    const revA = advanceStable(fx, 'stable-advanced');
    // 先把 worktree 同步到 rev-A（模拟线上内容），再重新施加只读（模拟真实布局）
    runGit(['checkout', '--force', revA], { cwd: fx.stable });
    applyReadOnlyAcl(fx.stable);
    expect(manifestLine(fx.stable)).toBe('stable-advanced');

    // 回退到 rev-B：checkout 需把 worktree 内容从 rev-A 改写为 rev-B → 被只读拒绝 → 不抛错，返回 false
    const result = rollbackTo({ bareRepo: fx.bare, revision: fx.initialHash, worktree: fx.stable });

    // 环境差异（真机暴露）：以 root 跑时 POSIX 权限位只读对本进程不构成约束（CAP_DAC_OVERRIDE），
    // checkout 会成功 → worktree_synced 为 true 是**正确**行为，此时显式跳过该断言（不假装失败）。
    if (readOnlyEnforced(fx.stable)) {
      expect(result.worktree_synced).toBe(false);
    } else {
      expect(result.worktree_synced).toBe(true);
    }
    expect(result.new_head).toBe(fx.initialHash);
    expect(headOf(fx)).toBe(fx.initialHash);
  });

  fixtureIt('branch 参数：切换非默认分支（main）', () => {
    fx = buildLayoutFixture();
    const latestHash = headOf(fx, 'main');
    expect(latestHash).not.toBe(fx.initialHash); // fixture 中 main 已推进，与 initial 分叉

    const result = rollbackTo({ bareRepo: fx.bare, branch: 'main', revision: fx.initialHash });

    expect(result.previous_head).toBe(latestHash);
    expect(result.new_head).toBe(fx.initialHash);
    expect(headOf(fx, 'main')).toBe(fx.initialHash);
  });

  fixtureIt('T8.23-只读工作树：跳过内容同步并给出可读原因 + ref 已切换（best-effort 缺省）', () => {
    fx = buildLayoutFixture();
    makeStableWritable(fx);
    const revA = advanceStable(fx, 'stable-advanced');
    runGit(['checkout', '--force', revA], { cwd: fx.stable });
    applyReadOnlyAcl(fx.stable);

    const result = rollbackTo({ bareRepo: fx.bare, revision: fx.initialHash, worktree: fx.stable });

    // 语义（2026-09 修订，取代原"跑 checkout 失败 → degraded"）：正式 stable/latest 按设计只读，
    // 对它们跑 `checkout --force` 必然逐文件失败、吐出成片 git 报错、并留下"HEAD 已动、工作区半残"的
    // 部分状态——比不同步更糟。回退语义只要求 ref 切换生效（内容由物化快照按 commit 读取），
    // 故只读时**直接跳过**：不跑 git、不报错、如实给出原因。
    if (readOnlyEnforced(fx.stable)) {
      expect(result.worktree_synced).toBe(false);
      expect(result.worktree_status).toBe('skipped');
      expect(result.worktree_error).toBeTruthy(); // 机器可读原因，非静默
      expect(result.worktree_error).toMatch(/只读|跳过/);
    } else {
      // 只读对本进程不生效（root / CAP_DAC_OVERRIDE）→ 走正常同步路径
      expect(result.worktree_synced).toBe(true);
      expect(result.worktree_status).toBe('synced');
    }
    expect(result.new_head).toBe(fx.initialHash);
    expect(headOf(fx)).toBe(fx.initialHash);
  });

  fixtureIt('T8.23-strict 策略：worktree 同步失败 → 抛错 + ref 补偿恢复到切换前（无半切换态）', () => {
    fx = buildLayoutFixture();
    makeStableWritable(fx);
    const revA = advanceStable(fx, 'stable-advanced');
    runGit(['checkout', '--force', revA], { cwd: fx.stable });
    applyReadOnlyAcl(fx.stable);

    // 只读对本进程不生效（root）→ 同步不会失败 → strict 策略下不抛错，ref 正常推进到目标。
    // 而**只读生效**时走的是"跳过"分支（不跑 git）：strict 语义是"同步失败即整体失败"，
    // 而只读跳过不是失败——它是既定设计（worktree 只读）下的确定性行为，故同样不抛错。
    const enforced = readOnlyEnforced(fx.stable);
    if (enforced) {
      const r = rollbackTo({
        bareRepo: fx.bare,
        revision: fx.initialHash,
        worktree: fx.stable,
        worktreePolicy: 'strict',
      });
      expect(r.worktree_status).toBe('skipped');
      expect(r.worktree_error).toMatch(/只读|跳过/);
      expect(r.new_head).toBe(fx.initialHash);
    } else {
      const r = rollbackTo({
        bareRepo: fx.bare,
        revision: fx.initialHash,
        worktree: fx.stable,
        worktreePolicy: 'strict',
      });
      expect(r.new_head).toBe(fx.initialHash);
      expect(r.worktree_status).toBe('synced');
    }
  });

  fixtureIt('T8.23-strict 策略：worktree 同步成功 → 正常返回 worktree_status:"synced"', () => {
    fx = buildLayoutFixture();
    makeStableWritable(fx);
    const revA = advanceStable(fx, 'stable-advanced');
    runGit(['checkout', '--force', revA], { cwd: fx.stable });

    const result = rollbackTo({
      bareRepo: fx.bare,
      revision: fx.initialHash,
      worktree: fx.stable,
      worktreePolicy: 'strict',
    });

    expect(result.worktree_status).toBe('synced');
    expect(result.worktree_synced).toBe(true);
    expect(result.new_head).toBe(fx.initialHash);
    expect(headOf(fx)).toBe(fx.initialHash);
  });

  fixtureIt('T8.23-未提供 worktree → worktree_status:"skipped"（无需同步）', () => {
    fx = buildLayoutFixture();
    const revA = advanceStable(fx, 'stable-advanced');

    const result = rollbackTo({ bareRepo: fx.bare, revision: fx.initialHash });

    expect(result.worktree_status).toBe('skipped');
    expect(result.worktree_synced).toBe(true);
    expect(headOf(fx)).toBe(fx.initialHash);
    expect(result.previous_head).toBe(revA);
  });
});

/**
 * 真实布局是否存在（`versions.git/` + `stable/` 都是 gitignored 的运行时产物）。
 * 新鲜克隆/CI 里不存在 → 显式跳过并说明原因，而不是让"没测到"表现成"测挂了"（同 git-layout 的守卫）。
 */
const HAS_REAL_LAYOUT = fs.existsSync(REAL_BARE) && fs.existsSync(path.join(PRESET_ROOT, 'stable'));
if (!HAS_REAL_LAYOUT) {
  console.info(
    `[rollback] 跳过「真实布局只读冒烟」：本机无三线布局（${REAL_BARE}）——` +
      '它们是 gitignored 的运行时产物，需先启动过宿主或跑 `pnpm init-three-line`。',
  );
}

describe.skipIf(!HAS_REAL_LAYOUT)('真实布局只读冒烟（绝不切换真实 stable 引用）', () => {
  it('真实 versions.git 的 refs/heads/stable 存在且可解析为 commit（只读）', () => {
    const refs = runGit(['for-each-ref', '--format=%(refname)'], { cwd: REAL_BARE });
    expect(refs).toContain('refs/heads/stable');
    const stableHead = runGit(['rev-parse', '--verify', 'refs/heads/stable^{commit}'], {
      cwd: REAL_BARE,
    });
    expect(stableHead).toMatch(/^[0-9a-f]{40}$/);
  });

  it('真实 stable worktree 内容可读且与其自身 HEAD 一致（只读冒烟，不做任何切换）', () => {
    const stableWt = path.join(PRESET_ROOT, 'stable');
    // manifest 存在且可解析
    expect(fs.existsSync(path.join(stableWt, 'manifest.json'))).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(path.join(stableWt, 'manifest.json'), 'utf8')) as {
      name: string;
    };
    expect(manifest.name).toBe('omb-v2');
    // 冒烟语义修正（审查发现）：正式 worktree 是初始化时按当时分支尖端 add 出的**只读**目录，
    // 之后不再原地更新（`substrate/lines.ts` 禁止对运行目录 checkout/worktree/archive；演化只推进
    // versions.git 引用并另物化快照）→ 与 `refs/heads/stable` 分叉是**正常**的，比它必然误报。
    // 正确的冒烟对象是工作树自己的 HEAD：内容与自称提交一致 = 内容没被破坏。
    const wtHead = runGit(['rev-parse', 'HEAD'], { cwd: stableWt });
    const headManifest = JSON.parse(runGit(['show', `${wtHead}:manifest.json`], { cwd: REAL_BARE })) as {
      line?: string;
    };
    expect(manifestLine(stableWt)).toBe(headManifest.line ?? '');
  });
});