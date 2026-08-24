// layer 0：分享后自动初始化三线布局与只读 ACL（专项「进程内自动初始化」）。
// 背景：versions.git/stable/latest 均 gitignored、不随仓库分发 → 项目被分享（clone/拷贝）后
// 接收方必须手动初始化布局并重新施加只读 ACL，否则 /mode 无法加载版本线。本模块在插件启动时
// 自动检测布局缺失/损坏/ACL 丢失 → 初始化或保守修复（绝不删除 versions.git 或 worktree 内已有内容）。
//
// 锁安全性：git/icacls 均以短生命周期子进程（execFileSync）运行，DSH 进程不持有
// versions.git/stable/latest 的文件句柄（正式 worktree 运行只读）→ 进程内同步初始化无锁冲突。
// 健康时纯 fs 检查、零 git 子进程（插件每次启动都调用，必须零开销）。
// 只 import node: 内置与 substrate 内文件（CONVENTIONS §4：substrate 不得 import 任何上层）。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GIT_BIN, defaultLayout, presetRoot, type VersionLayout } from './snapshot.js';

export { defaultLayout };

/** 初始化/修复结果（ensureThreeLineLayout 绝不 throw：任何一步失败 → degraded + 原因） */
export interface LayoutBootstrapResult {
  status: 'ok' | 'initialized' | 'repaired' | 'degraded';
  detail: string;
}

/** initial 基线 manifest（与 tests/helpers/git.ts MANIFEST_INITIAL 完全等价：2 空格缩进 JSON） */
const MANIFEST_INITIAL = JSON.stringify(
  { name: 'omb-v2', version: '0.1.0', line: 'initial', components: {} },
  null,
  2,
);

/** latest 基线 manifest（main 分叉内容，与 helpers MANIFEST_LATEST 等价） */
const MANIFEST_LATEST = JSON.stringify(
  { name: 'omb-v2', version: '0.1.0', line: 'latest', components: {} },
  null,
  2,
);

/** 出厂基线认知对象（P1a 种子升级）：repo 的 kernel/policy + kernel/processes 快照（三线承载版本化认知对象；
 *  P1c：evolve.yaml 加入种子——线快照承载演化判定策略数据） */
const POLICY_FILES = ['budget.yaml', 'context.yaml', 'governor.yaml', 'evolve.yaml'];
const PROCESS_FILES = ['hypothesize-test.yaml', 'retrieve-verify.yaml'];

/** 把 repo kernel/policy + kernel/processes 快照复制进种子工作树（seed = 一次性种子目录；源 = presetRoot()） */
function seedKernelObjects(seedDir: string): void {
  const root = presetRoot();
  const policyDir = path.join(root, 'kernel', 'policy');
  const processesDir = path.join(root, 'kernel', 'processes');
  const policyOut = path.join(seedDir, 'kernel', 'policy');
  const processesOut = path.join(seedDir, 'kernel', 'processes');
  fs.mkdirSync(policyOut, { recursive: true });
  fs.mkdirSync(processesOut, { recursive: true });
  for (const f of POLICY_FILES) {
    fs.copyFileSync(path.join(policyDir, f), path.join(policyOut, f));
  }
  for (const f of PROCESS_FILES) {
    fs.copyFileSync(path.join(processesDir, f), path.join(processesOut, f));
  }
}

/** 瞬态锁错误（Windows 文件锁/杀软竞态）：短退避有限次重试（与 snapshot.ts 同款模式）；非锁错误/超次 → 直接抛错 */
const LOCK_RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);
const LOCK_RETRY_COUNT = 3;

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

interface GitRunOptions {
  /** 工作目录（缺省 process.cwd()；bare 操作传 lay.bareRepo，种子操作不传——与 helpers 等价） */
  cwd?: string;
  /** 一次性工作树（等价 --work-tree=<value>；种子提交用，配合 --git-dir） */
  workTree?: string;
}

/** 在 layout.bareRepo 上运行 git（gitBin 缺省 GIT_BIN）；非 0 退出抛带 stderr 的错误（外层捕获转 degraded） */
function runGit(lay: VersionLayout, args: string[], opts: GitRunOptions = {}): string {
  const fullArgs: string[] = [];
  if (opts.workTree !== undefined) {
    fullArgs.push(`--git-dir=${lay.bareRepo}`, `--work-tree=${opts.workTree}`);
  }
  fullArgs.push(...args);
  const bin = lay.gitBin ?? GIT_BIN;
  let last: unknown;
  for (let attempt = 0; attempt < LOCK_RETRY_COUNT; attempt++) {
    try {
      const stdout = execFileSync(bin, fullArgs, {
        cwd: opts.cwd ?? process.cwd(),
        encoding: 'utf8',
        windowsHide: true,
      });
      return stdout.trimEnd();
    } catch (err) {
      last = err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code === undefined || !LOCK_RETRYABLE.has(code)) {
        break; // 非文件锁错误（git 逻辑错误/未知）→ 不重试，立即报错
      }
      if (attempt < LOCK_RETRY_COUNT - 1) {
        sleepMs(50 * (attempt + 1)); // 短退避（50ms/100ms）
      }
    }
  }
  const e = last as { status?: number; stderr?: Buffer | string };
  const detail = e && e.stderr ? String(e.stderr).trimEnd() : '(无 stderr)';
  const code = (last as NodeJS.ErrnoException).code;
  throw new Error(
    `git ${args.join(' ')} 失败 (exit=${(e as { status?: number }).status ?? '?'}${code === undefined ? '' : ` code=${code}`}): ${detail}`,
  );
}

/** 只读 ACL：icacls <dir> /inheritance:r /grant:r "Everyone:RX" /T /C（授权式只读，无 deny ACE/SYNCHRONIZE 副作用）。
 *  SystemRoot 缺失 → 抛错（外层捕获转 degraded）。瞬态锁错误短退避重试（同 runGit）。 */
function applyReadOnlyAcl(lay: VersionLayout, dir: string): void {
  const systemRoot = process.env.SystemRoot;
  if (systemRoot === undefined || systemRoot.length === 0) {
    throw new Error('icacls 解析失败：环境变量 SystemRoot 缺失（Windows 上恒存在，请检查运行环境）');
  }
  const icacls = path.join(systemRoot, 'System32', 'icacls.exe');
  let last: unknown;
  for (let attempt = 0; attempt < LOCK_RETRY_COUNT; attempt++) {
    try {
      execFileSync(icacls, [dir, '/inheritance:r', '/grant:r', 'Everyone:RX', '/T', '/C'], {
        encoding: 'utf8',
        windowsHide: true,
      });
      return;
    } catch (err) {
      last = err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code === undefined || !LOCK_RETRYABLE.has(code)) {
        break;
      }
      if (attempt < LOCK_RETRY_COUNT - 1) {
        sleepMs(50 * (attempt + 1));
      }
    }
  }
  const e = last as { status?: number; stderr?: Buffer | string };
  const detail = e && e.stderr ? String(e.stderr).trimEnd() : '(无 stderr)';
  throw new Error(`icacls ${dir} 只读 ACL 施加失败 (exit=${(e as { status?: number }).status ?? '?'}): ${detail}`);
}

/** 释放只读 ACL：icacls <dir> /reset /T /C（旧种子迁移删除旧 worktree 前置；与 applyReadOnlyAcl 同款锁重试） */
function resetReadOnlyAcl(dir: string): void {
  const systemRoot = process.env.SystemRoot;
  if (systemRoot === undefined || systemRoot.length === 0) {
    throw new Error('icacls 解析失败：环境变量 SystemRoot 缺失（Windows 上恒存在，请检查运行环境）');
  }
  const icacls = path.join(systemRoot, 'System32', 'icacls.exe');
  let last: unknown;
  for (let attempt = 0; attempt < LOCK_RETRY_COUNT; attempt++) {
    try {
      execFileSync(icacls, [dir, '/reset', '/T', '/C'], { encoding: 'utf8', windowsHide: true });
      return;
    } catch (err) {
      last = err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code === undefined || !LOCK_RETRYABLE.has(code)) {
        break;
      }
      if (attempt < LOCK_RETRY_COUNT - 1) {
        sleepMs(50 * (attempt + 1));
      }
    }
  }
  const e = last as { status?: number; stderr?: Buffer | string };
  const detail = e && e.stderr ? String(e.stderr).trimEnd() : '(无 stderr)';
  throw new Error(`icacls ${dir} 只读 ACL 释放失败 (exit=${(e as { status?: number }).status ?? '?'}): ${detail}`);
}

/**
 * 只读探测（实测修正，见报告）：fs.accessSync(dir, W_OK) 在 Windows 上对 Everyone:RX 目录
 * 仍返回"可写"（Node 的 access 检查不完整反映 ACL）→ 用真实写探测：创建探针文件成功 = 可写
 * （ACL 丢失）；EPERM/EACCES = 只读（ACL 有效）。写成功时立即删除探针（幂等，健康路径零残留）。
 */
function isReadOnlyDir(dir: string): boolean {
  if (!fs.existsSync(dir)) {
    return false; // 目录缺失 → 不算只读（由 worktree 修复负责）
  }
  const probe = path.join(dir, `.omb-acl-probe-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`);
  try {
    fs.writeFileSync(probe, '');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES') {
      return true; // 写被拒 → 只读（ACL 有效）
    }
    return false; // 其他错误（ENOENT 等）→ 目录不可用，保守按可写处理（worktree 修复兜底）
  }
  // 可写 → ACL 丢失；删除探针文件（失败不致命，重新施加 ACL 后为只读残留）
  try {
    fs.unlinkSync(probe);
  } catch {
    // 删除失败 → 忽略
  }
  return false;
}

/** worktree 的 .git gitfile 指向的有效 gitdir（不存在/非 gitfile → null） */
function gitdirTarget(wtDir: string): string | null {
  const gitfile = path.join(wtDir, '.git');
  let st: fs.Stats;
  try {
    st = fs.statSync(gitfile);
  } catch {
    return null;
  }
  if (!st.isFile()) {
    return null; // .git 为目录（独立仓库）→ 非 gitfile
  }
  let content: string;
  try {
    content = fs.readFileSync(gitfile, 'utf8');
  } catch {
    return null;
  }
  if (!content.startsWith('gitdir:')) {
    return null;
  }
  const target = path.resolve(path.dirname(gitfile), content.slice('gitdir:'.length).trim());
  return fs.existsSync(target) ? target : null;
}

/** worktree 健康：.git gitfile 存在且指向的 gitdir 存在（纯 fs，不跑 git） */
function worktreeHealthy(_lay: VersionLayout, wtDir: string): boolean {
  return gitdirTarget(wtDir) !== null;
}

/** 引用是否可解析（git 探测；失败 → false） */
function refExists(lay: VersionLayout, ref: string): boolean {
  try {
    runGit(lay, ['rev-parse', '--verify', ref], { cwd: lay.bareRepo });
    return true;
  } catch {
    return false;
  }
}

/** 找任意可达 commit（HEAD 优先，其次 stable/initial/main）；全空 bare → null */
function resolveAnyCommit(lay: VersionLayout): string | null {
  for (const ref of ['HEAD', 'refs/heads/stable', 'refs/tags/initial', 'refs/heads/main']) {
    try {
      return runGit(lay, ['rev-parse', '--verify', `${ref}^{commit}`], { cwd: lay.bareRepo });
    } catch {
      // 尝试下一个引用
    }
  }
  return null;
}

/**
 * 保守 worktree 建立/重建：绝不删除 worktree 内已有内容。
 * - 目录缺失 → mkdir 父目录 + worktree prune（清注册表旧项）+ worktree add；
 * - 目录仅含陈旧 .git 指针（指向不存在 gitdir，旧机器路径残留）→ 移除指针文件 + prune + add；
 * - 目录非空且无有效 .git → 抛错（→ degraded，保留用户数据，不自动处理）。
 */
function addFormalWorktree(lay: VersionLayout, wtDir: string, branch: string): void {
  if (fs.existsSync(wtDir)) {
    const entries = fs.readdirSync(wtDir);
    const meaningful = entries.filter((e) => e !== '.git');
    if (meaningful.length > 0) {
      throw new Error(`worktree 目录非空且无有效 .git（保留用户数据，不自动处理）：${wtDir}`);
    }
    if (entries.includes('.git')) {
      const gitfile = path.join(wtDir, '.git');
      const st = fs.statSync(gitfile);
      if (st.isFile()) {
        fs.rmSync(gitfile); // 陈旧 gitfile（指向不存在 gitdir）→ 移除指针后重建
      } else {
        throw new Error(`worktree .git 非 gitfile（保留用户数据，不自动处理）：${wtDir}`);
      }
    }
  } else {
    fs.mkdirSync(path.dirname(wtDir), { recursive: true });
  }
  // 清理注册表旧项（worktree 目录缺失/失效场景；prune 失败不致命，add 自带冲突报错）
  try {
    runGit(lay, ['worktree', 'prune'], { cwd: lay.bareRepo });
  } catch {
    // prune 失败 → 忽略
  }
  runGit(lay, ['worktree', 'add', wtDir, branch], { cwd: lay.bareRepo });
}

/** workspace/.omb/.evolution/ 结构：candidates/ 目录 + README.md + 0000-bootstrap 候选 worktree（--detach @ initialHash）。
 *  与 tests/helpers/git.ts buildLayoutFixture 步骤 5 等价。 */
function ensureEvolution(lay: VersionLayout, initialHash: string): void {
  const evolution = path.join(path.dirname(lay.bareRepo), 'workspace', '.omb', '.evolution');
  const candidates = path.join(evolution, 'candidates');
  fs.mkdirSync(candidates, { recursive: true });
  const readme = path.join(evolution, 'README.md');
  if (!fs.existsSync(readme)) {
    fs.writeFileSync(
      readme,
      '.evolution = AI 演化工作区（候选临时可写工作树在 candidates/<id>/，正式 stable/latest 只读）。\n',
    );
  }
  const candidate = path.join(candidates, '0000-bootstrap');
  if (worktreeHealthy(lay, candidate)) {
    return;
  }
  if (fs.existsSync(candidate)) {
    const entries = fs.readdirSync(candidate);
    if (entries.some((e) => e !== '.git')) {
      throw new Error(`候选目录非空且无有效 .git（保留用户数据，不自动处理）：${candidate}`);
    }
    const gitfile = path.join(candidate, '.git');
    if (fs.existsSync(gitfile)) {
      const st = fs.statSync(gitfile);
      if (st.isFile()) {
        fs.rmSync(gitfile);
      } else {
        throw new Error(`候选目录 .git 非 gitfile（不自动处理）：${candidate}`);
      }
    }
  }
  runGit(lay, ['worktree', 'add', '--detach', candidate, initialHash], { cwd: lay.bareRepo });
}

/**
 * 种子基线（与 tests/helpers/git.ts buildLayoutFixture 步骤 1-5 完全等价）：
 * 1. git init --bare -b main <bareRepo>（initBare=false 时复用已有空 bare，规范 HEAD → main）
 * 2. 首个基线提交（manifest.json + README.md + kernel/policy/ + kernel/processes/，inline 作者）
 *    → tag initial + branch stable（出厂基线 = repo kernel/policy + kernel/processes 快照，P1a）
 * 3. main 再推进一版（与 stable 分叉，保证 git diff stable..main 非空）
 * 3.5. trusted-latest 分支 ← latest 基线提交（D1 裁决：latest = trusted head 指针，初始 = latest 基线）
 * 4. stable/ latest/ 正式 worktree（先 add 后加只读 ACL）
 * 5. workspace/.omb/.evolution/candidates/0000-bootstrap/ 候选临时可写 worktree（--detach @ initial）
 */
function seedBaseline(lay: VersionLayout, opts: { initBare: boolean }): void {
  if (opts.initBare) {
    fs.mkdirSync(path.dirname(lay.bareRepo), { recursive: true });
    runGit(lay, ['init', '--bare', '-b', 'main', lay.bareRepo]);
  } else {
    // 已有空 bare：规范 HEAD → refs/heads/main（unborn 分支场景；失败不致命，后续 ref 兜底）
    try {
      runGit(lay, ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: lay.bareRepo });
    } catch {
      // HEAD 已指向 main 或异常 → 忽略
    }
  }

  // 2. 首个基线提交 + tag initial + stable 分支（出厂基线 = manifest + README + kernel/policy + kernel/processes 快照）
  const seedInitial = fs.mkdtempSync(path.join(os.tmpdir(), 'omb-seed-initial-'));
  fs.writeFileSync(path.join(seedInitial, 'manifest.json'), MANIFEST_INITIAL);
  fs.writeFileSync(path.join(seedInitial, 'README.md'), 'OMB v2 版本树引导基线（initial）。\n');
  seedKernelObjects(seedInitial);
  runGit(lay, ['add', '.'], { workTree: seedInitial });
  runGit(
    lay,
    ['-c', 'user.name=OMB', '-c', 'user.email=omb@local', 'commit', '-m', 'initial baseline'],
    { workTree: seedInitial },
  );
  const initialHash = runGit(lay, ['rev-parse', 'HEAD'], { cwd: lay.bareRepo });
  if (!refExists(lay, 'refs/tags/initial')) {
    runGit(lay, ['tag', 'initial', initialHash], { cwd: lay.bareRepo });
  }
  if (!refExists(lay, 'refs/heads/stable')) {
    runGit(lay, ['branch', 'stable', initialHash], { cwd: lay.bareRepo });
  }

  // 3. main 推进一版（与 stable 分叉；同结构：manifest line=latest + README + kernel/policy + kernel/processes 快照）
  const seedLatest = fs.mkdtempSync(path.join(os.tmpdir(), 'omb-seed-latest-'));
  fs.writeFileSync(path.join(seedLatest, 'manifest.json'), MANIFEST_LATEST);
  fs.writeFileSync(path.join(seedLatest, 'README.md'), 'OMB v2 latest 基线（main 分支）。\n');
  seedKernelObjects(seedLatest);
  runGit(lay, ['add', '.'], { workTree: seedLatest });
  runGit(
    lay,
    ['-c', 'user.name=OMB', '-c', 'user.email=omb@local', 'commit', '-m', 'latest baseline'],
    { workTree: seedLatest },
  );
  // 确保 main 存在（HEAD 异常分支时兜底：main ← 最新提交）
  if (!refExists(lay, 'refs/heads/main')) {
    let head: string;
    try {
      head = runGit(lay, ['rev-parse', 'HEAD'], { cwd: lay.bareRepo });
    } catch {
      head = initialHash;
    }
    runGit(lay, ['branch', 'main', head], { cwd: lay.bareRepo });
  }

  // 3.5. trusted-latest ← main head（D1 裁决：latest = trusted head 指针；初始 = latest 基线提交。
  //      仅种子流程创建；修复分支不补——旧布局（无 trusted-latest/无 policy）由 ensureThreeLineLayout
  //      旧种子检测自动迁移重建（R1），不靠修补维持）
  if (!refExists(lay, 'refs/heads/trusted-latest')) {
    const mainHead = runGit(lay, ['rev-parse', '--verify', 'refs/heads/main^{commit}'], { cwd: lay.bareRepo });
    runGit(lay, ['branch', 'trusted-latest', mainHead], { cwd: lay.bareRepo });
  }

  // 4. 正式 worktree：先 add（需可写），后加只读 ACL
  addFormalWorktree(lay, lay.stableWorktree, 'stable');
  addFormalWorktree(lay, lay.latestWorktree, 'main');
  applyReadOnlyAcl(lay, lay.stableWorktree);
  applyReadOnlyAcl(lay, lay.latestWorktree);

  // 5. 候选临时可写 worktree（detach @ initial）+ .evolution/README.md
  ensureEvolution(lay, initialHash);

  // 清理种子临时目录（失败不致命）
  try {
    fs.rmSync(seedInitial, { recursive: true, force: true });
  } catch {
    // 忽略
  }
  try {
    fs.rmSync(seedLatest, { recursive: true, force: true });
  } catch {
    // 忽略
  }
}

/**
 * 健康检查（廉价，纯 fs，不跑 git）：bare 结构完整 + 双 worktree .git gitfile 存在 +
 * manifest.json 可读 + 双 worktree 只读（写探测）。任一失败 → 返回原因（null = 健康）。
 */
function healthProblem(lay: VersionLayout): string | null {
  if (!fs.existsSync(lay.bareRepo)) {
    return `versions.git 缺失（${lay.bareRepo}）——需完整初始化`;
  }
  for (const sub of ['HEAD', 'objects', 'refs']) {
    if (!fs.existsSync(path.join(lay.bareRepo, sub))) {
      return `versions.git 不完整（缺 ${sub}）：${lay.bareRepo}`;
    }
  }
  for (const wt of [lay.stableWorktree, lay.latestWorktree]) {
    if (!fs.existsSync(path.join(wt, '.git'))) {
      return `worktree 缺 .git 指针（${wt}）`;
    }
    const manifest = path.join(wt, 'manifest.json');
    if (!fs.existsSync(manifest)) {
      return `manifest.json 缺失（${manifest}）`;
    }
    try {
      fs.readFileSync(manifest, 'utf8');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `manifest.json 不可读（${manifest}）：${msg}`;
    }
    if (!isReadOnlyDir(wt)) {
      return `只读 ACL 丢失（${wt} 可写）`;
    }
  }
  return null;
}

/**
 * 保守修复（versions.git 存在但不健康）；返回是否有实际修复动作。
 * 绝不删除 versions.git 或 worktree 内已有内容；引用缺失补引用、worktree 缺失/失效重建、
 * ACL 丢失重新施加。非空无 .git 的目录 → 抛错（→ degraded，保留用户数据）。
 */
function repairLayout(lay: VersionLayout): boolean {
  let acted = false;

  // 1. 引用修复：initial tag / stable / main 分支任一缺失
  const initialExists = refExists(lay, 'refs/tags/initial');
  const stableExists = refExists(lay, 'refs/heads/stable');
  const mainExists = refExists(lay, 'refs/heads/main');
  if (!initialExists || !stableExists || !mainExists) {
    const anyCommit = resolveAnyCommit(lay);
    if (anyCommit === null) {
      // 全空 bare（无任何可达 commit）→ 按 b 的种子流程补基线
      seedBaseline(lay, { initBare: false });
      acted = true;
    } else {
      if (!initialExists) {
        const base = stableExists
          ? runGit(lay, ['rev-parse', '--verify', 'refs/heads/stable^{commit}'], { cwd: lay.bareRepo })
          : anyCommit;
        runGit(lay, ['tag', 'initial', base], { cwd: lay.bareRepo });
        acted = true;
      }
      if (!stableExists) {
        const base = initialExists
          ? runGit(lay, ['rev-parse', '--verify', 'refs/tags/initial^{commit}'], { cwd: lay.bareRepo })
          : anyCommit;
        runGit(lay, ['branch', 'stable', base], { cwd: lay.bareRepo });
        acted = true;
      }
      if (!mainExists) {
        runGit(lay, ['branch', 'main', anyCommit], { cwd: lay.bareRepo });
        acted = true;
      }
    }
  }

  // 2. worktree 修复：缺失/失效 → prune 后重建
  for (const [wt, branch] of [
    [lay.stableWorktree, 'stable'],
    [lay.latestWorktree, 'main'],
  ] as const) {
    if (worktreeHealthy(lay, wt)) {
      continue;
    }
    addFormalWorktree(lay, wt, branch);
    acted = true;
  }

  // 3. ACL 修复：只读探测失败（目录可写）→ 重新施加只读 ACL
  for (const wt of [lay.stableWorktree, lay.latestWorktree]) {
    if (fs.existsSync(wt) && !isReadOnlyDir(wt)) {
      applyReadOnlyAcl(lay, wt);
      acted = true;
    }
  }

  return acted;
}

/**
 * 旧种子快速预检（纯 fs，健康路径零 git 调用）：trusted-latest 松散 ref 缺失 或 stable worktree
 * 缺 kernel/policy → 「可能旧种子」（需 git 确认，防 packed-refs/worktree 失效误判）；
 * 两者皆在 → 非旧种子（新种子特征，零 git 开销直接放行）。
 */
function legacySeedHint(lay: VersionLayout): boolean {
  const hasTrustedLoose = fs.existsSync(path.join(lay.bareRepo, 'refs', 'heads', 'trusted-latest'));
  const hasPolicyWorktree = fs.existsSync(path.join(lay.stableWorktree, 'kernel', 'policy'));
  return !hasTrustedLoose || !hasPolicyWorktree;
}

/**
 * 旧种子 git 确认（R1 种子自动重建判定）：versions.git 存在且基线引用齐全（initial tag + stable +
 * main——真实三线旧种子形态）但（a）无 refs/heads/trusted-latest 或（b）stable 分支基线树缺
 * kernel/policy（P1a 种子特征）→ 旧种子。引用缺失（损坏/空库）→ false（走既有修复路径，不迁移）。
 */
function isLegacySeed(lay: VersionLayout): boolean {
  if (!fs.existsSync(lay.bareRepo)) {
    return false;
  }
  if (
    !refExists(lay, 'refs/tags/initial') ||
    !refExists(lay, 'refs/heads/stable') ||
    !refExists(lay, 'refs/heads/main')
  ) {
    return false; // 引用缺失 = 损坏/空库 → 修复分支处理（不触发迁移）
  }
  if (refExists(lay, 'refs/heads/trusted-latest')) {
    // trusted-latest 存在 → 检查 stable 基线树含 kernel/policy（对象级，与 worktree 状态无关）
    const tree = runGit(lay, ['ls-tree', 'refs/heads/stable', 'kernel/policy'], { cwd: lay.bareRepo });
    return tree.trim().length === 0;
  }
  return true;
}

/**
 * 旧种子自动迁移（仅 ensureThreeLineLayout 旧种子判定后调用；幂等由判定保证——重建后不再命中）：
 * 1. 释放旧正式 worktree 只读 ACL 并删除 stable/ latest/（内容 = 旧种子 commit checkout，对象数据
 *    保留在备份 bare，不丢失）；
 * 2. 移动 versions.git → versions.git.legacy-<ts>（保留数据不删除）；
 * 3. 清理 workspace/.omb/lines/ 旧快照目录与 .evolution/candidates/ 旧候选 worktree
 *    （指向旧 bare 的 gitfile/注册项，重建后旧 commit 快照失效）；
 * 4. 走既有完整初始化流程重建新种子（含 policy/processes 快照 + trusted-latest + 只读 ACL + 候选 worktree）；
 * 5. console.info 中文说明。返回备份目录路径（versions.git.legacy-<ts>）。
 */
function migrateLegacySeed(lay: VersionLayout): string {
  const root = path.dirname(lay.bareRepo);
  // 1. 释放并删除旧正式 worktree（数据在备份 bare 的对象库，不丢失）
  for (const wt of [lay.stableWorktree, lay.latestWorktree]) {
    if (!fs.existsSync(wt)) {
      continue;
    }
    try {
      resetReadOnlyAcl(wt);
    } catch {
      // ACL 释放失败不致命——rmSync force 再试（仍失败则整体 degraded，数据保留）
    }
    fs.rmSync(wt, { recursive: true, force: true });
  }
  // 2. 移动 versions.git → versions.git.legacy-<ts>
  const legacy = `${lay.bareRepo}.legacy-${Date.now()}`;
  fs.renameSync(lay.bareRepo, legacy);
  // 3. 清理旧快照与旧候选 worktree（指向旧 bare 的 gitfile，重建后失效）
  const linesDir = path.join(root, 'workspace', '.omb', 'lines');
  if (fs.existsSync(linesDir)) {
    fs.rmSync(linesDir, { recursive: true, force: true });
  }
  const candidatesDir = path.join(root, 'workspace', '.omb', '.evolution', 'candidates');
  if (fs.existsSync(candidatesDir)) {
    for (const name of fs.readdirSync(candidatesDir)) {
      const dir = path.join(candidatesDir, name);
      try {
        const gitfile = path.join(dir, '.git');
        if (fs.existsSync(gitfile) && fs.statSync(gitfile).isFile()) {
          // 旧候选 worktree（gitdir 指向已移走的 bare）→ 删除（内容 = 旧提交 checkout，不丢失）
          fs.rmSync(dir, { recursive: true, force: true });
        }
      } catch {
        // 单个候选清理失败 → 保留（ensureEvolution 兜底 degraded，新种子主流程不受阻）
      }
    }
  }
  // 4. 完整初始化重建新种子（含 policy/processes + trusted-latest）
  seedBaseline(lay, { initBare: true });
  const still = healthProblem(lay);
  if (still !== null) {
    throw new Error(`迁移重建后布局仍不健康：${still}`);
  }
  // 5. 记录（中文说明；插件 apply 另经 status 输出「自动修复完成」）
  console.info(
    `[omb-v2] 旧种子已自动迁移重建：versions.git → ${legacy}（数据备份保留；新种子含 policy/processes 快照与 trusted-latest）`,
  );
  return legacy;
}

/**
 * 进程内自动初始化/修复三线布局（同步；绝不 throw——失败 → {status:'degraded', detail: 原因}）。
 * 幂等：健康布局重复调用 → 'ok'，零副作用（不产生任何 git 子进程）。
 * R1：旧种子（无 trusted-latest / 基线缺 kernel/policy）→ 启动时自动备份 versions.git（移动为
 * versions.git.legacy-<ts>）并重建新种子——先于健康检查（旧种子可能结构健康——worktree/ACL 完好）。
 * @param layout 布局覆盖（测试注入临时 fixture；缺省用真实 preset 布局）
 */
export function ensureThreeLineLayout(layout?: VersionLayout): LayoutBootstrapResult {
  const lay = layout ?? defaultLayout();
  try {
    // R1 旧种子自动迁移（仅启动时调用面执行；幂等：重建后新种子不再命中判定；修复分支不触发迁移）
    if (fs.existsSync(lay.bareRepo) && legacySeedHint(lay) && isLegacySeed(lay)) {
      const legacy = migrateLegacySeed(lay);
      return {
        status: 'repaired',
        detail: `旧种子已自动迁移重建（versions.git → ${legacy} 备份保留；新种子含 policy/processes 快照与 trusted-latest）`,
      };
    }
    const problem = healthProblem(lay);
    if (problem === null) {
      return { status: 'ok', detail: '三线布局完整（versions.git 引用/正式 worktree/只读 ACL 均正常）' };
    }
    if (!fs.existsSync(lay.bareRepo)) {
      // 缺失（versions.git 不存在）→ 完整初始化（与 buildLayoutFixture 步骤完全等价）
      seedBaseline(lay, { initBare: true });
      const still = healthProblem(lay);
      if (still !== null) {
        throw new Error(`初始化后布局仍不健康：${still}`);
      }
      return {
        status: 'initialized',
        detail: `已初始化三线布局（versions.git=${lay.bareRepo}；stable/latest 只读 ACL 已施加，含候选 worktree）`,
      };
    }
    // 修复（versions.git 存在但不健康）
    const acted = repairLayout(lay);
    const still = healthProblem(lay);
    if (still !== null) {
      throw new Error(`修复后布局仍不健康：${still}`);
    }
    return acted
      ? { status: 'repaired', detail: `已修复三线布局（versions.git=${lay.bareRepo}）` }
      : { status: 'ok', detail: '三线布局完整（无修复动作）' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: 'degraded', detail: msg };
  }
}
