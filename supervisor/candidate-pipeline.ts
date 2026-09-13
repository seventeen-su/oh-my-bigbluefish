// P1d 候选管线生产接线（架构 §3.2 演化事务 begin→mutate→validate→commit→promote + §6.5.3 验证链 G1-G4 +
// §6.5.4 Evolution Object → git + 实现规格 §10 Evolution 事务 git 原子性 / candidate_id 幂等键）：layer 1。
//
// 内容：
//   - validateDataCandidate：数据候选验证生产路径——G1（YAML + policy schema + 值域，zod fail-loud 转判定）
//     → G2（数据候选 N/A，标记 skipped）→ G3-replay（候选应用到临时目录（createCandidateDir 标准化
//     候选验证环境 + diff 覆盖）→ 捆绑校验（supervisor 侧 loadPolicy 语义）→ 冻结基准回放 fitness
//     （runBenchV2 回放执行器，passed 不降 + 成本代理不显著劣化）→ 目录用后清理）→ G3-exec（P3 执行型
//     验证门：候选附执行型验证脚本（draft.verify，L0 数据候选无 → N/A 标记）→ 经 substrate/sandbox.ts
//     WRITE_RESTRICTED 受限通道执行 + 结果文件方案回传（受限进程不能管道捕获孙进程输出）+ 沙盒语义
//     写拒绝断言；受限通道不可用（koffi 缺失等）→ degraded 降级记录（D5），不阻塞门禁语义）→
//     G4（通过 G1+G3 → shadow exposure log 契约接线，.evolution/shadows/；真实放量依赖真实会话
//     流量，文档化）。
//   - promoteDataCandidate：晋升与合并——临时 worktree（线工作副本）覆盖式 diff 提交（作者 OMB <omb@local>，
//     消息 `evolve: <candidate_id> <motivation 摘要>`）→ 防误删检查（ls-tree/diff 比对，不删除其余文件）→
//     `git update-ref refs/heads/trusted-latest` 原子推进（幂等键 candidate_id：同候选重复提交拒绝）→
//     main 快进（best-effort）→ 信任池 promote → Evolution Object 写入提交内 .evolution-objects/<id>.json
//     （随线内容版本化）→ evolution/promoted 事件入链。commit/update-ref 失败 → 候选标记 rejected（留痕）。
//   - runCandidatePipeline：端到端（幂等早退 → 验证 → 注册 → 晋升 → outcome）。
//
// 层 DAG（CONVENTIONS §4）：仅 import node: 内置 + kernel/schemas/（IR 契约例外）+ supervisor/ + substrate/。
// ⚠️ 捆绑校验在 supervisor 侧自实现（js-yaml 解析 + kernel/schemas zod 校验），不 import kernel/policy-loader
//   （layer 2 禁止）——语义与 loadPolicy 对齐（四策略文件解析 + schema 校验，fail-loud 转判定）。
import { execFileSync } from 'node:child_process';
import { readFile, readdir, writeFile, mkdir, mkdtemp, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { load as parseYaml } from 'js-yaml';
import { GIT_BIN, type VersionLayout } from '../substrate/snapshot.js';
import { resolveLineCommit } from '../substrate/lines.js';
import { createCandidateDir, runRestricted, sandboxStatusAsync, type SandboxStatus } from '../substrate/sandbox.js';
// S9：dynamicCordisRunner 候选验证增强通道（宿主面存在 → 候选验证脚本经 runner 动态定义/运行/回退；
// 缺失/部分缺失/通道失败 → 降级回退受限子进程路径——接口守卫与通道见 dynamic-runner.ts）
import { inspectDynamicRunner, runCandidateViaRunner, type DynamicCordisRunnerLike } from './dynamic-runner.js';
import { canonicalJson, makeImmutableId, makeMutableId } from '../kernel/schemas/base.js';
// R6：dsh_version 唯一宿主版本来源（kernel/schemas IR 契约层例外，supervisor(1) → kernel/schemas/ ✓）
import { hostVersion } from '../kernel/schemas/host-version.js';
import {
  BudgetPolicySchema,
  ContextPolicySchema,
  EvolvePolicySchema,
  GovernorPolicySchema,
  type EvolvePolicy,
} from '../kernel/schemas/policy.js';
import { EventSchema, EvolutionObjectSchema, type EvolutionObject, type Event } from '../kernel/schemas/m.js';
import type { CandidateDraft } from '../kernel/schemas/evolution.js';
import { CandidatePool, candidateDirName, type CandidateRecord } from './candidates.js';
import type { EventStore } from './event-store.js';
import { bucketFor, logExposure } from './shadow.js';
import {
  loadBenchContractsV2,
  loadBenchFixturesV2,
  makeReplayExecutorV2,
  runBenchV2,
} from './bench-v2.js';
import type { GateResult } from './validate.js';

// ---- 常量与类型 ----

/** 可演化策略文件（target 白名单；G1 拒绝未知目标/路径穿越） */
const POLICY_FILE_SCHEMAS = {
  'governor.yaml': GovernorPolicySchema,
  'budget.yaml': BudgetPolicySchema,
  'context.yaml': ContextPolicySchema,
  'evolve.yaml': EvolvePolicySchema,
} as const;
type PolicyTargetFile = keyof typeof POLICY_FILE_SCHEMAS;

/** G3 成本代理缺省容忍（evolve.policy.candidate_gate 缺失/不可用时的兜底；数据化门禁见 parsePolicyBundle） */
const DEFAULT_COST_TOLERANCE = 0.1;

/** G3 成本代理：context_budget_tokens（Context Compiler 投影预算 = 最坏 token 开销代理；§6.1/§17） */
function costProxyOf(bundle: PolicyBundleLike | undefined): number {
  const b = bundle?.budget as { context_budget_tokens?: number } | undefined;
  return b?.context_budget_tokens ?? 0;
}

/** 数据候选 G4 门结果（validate.ts GateName 不含 G4——管线自有） */
export interface G4GateResult {
  gate: 'G4';
  ok: boolean;
  detail: string;
}

/** G3-replay 门结果（冻结基准回放——附 bench 对照；P3 起与 G3-exec 并列记录） */
export interface G3GateResult extends GateResult {
  /** 门型：G3-replay（冻结基准回放 fitness；与 G3-exec 执行型验证并列记录） */
  mode: 'replay';
  /** 冻结基准 fitness 对照（§6.5.3：passed 不降 + 成本代理不显著劣化；门禁判定数据化） */
  bench?: BenchCompare;
}

/** G3-exec 门结果（P3 执行型验证：受限通道 + 结果文件方案；与 G3-replay 并列记录） */
export interface G3ExecGateResult extends GateResult {
  /** 执行型门态：exec=受限通道执行 | na=候选无执行型验证脚本（N/A） | degraded=受限通道不可用跳过（D5） */
  kind: 'exec' | 'na' | 'degraded';
  /** 降级原因（kind='degraded' 时非空；机器可读） */
  degraded?: string;
  /** 受限执行结果（kind='exec' 且走受限子进程路径时；code/timedOut） */
  exec?: { code: number | null; timedOut: boolean };
  /**
   * 本次执行是否**真实发生**（kind='exec'）——即「候选带着验证脚本真的在受限通道里跑过一次」。
   * 已知问题《Linux 适配不完整》派生条的观测位：kind='degraded'/'na' → false。
   * 消费方（候选记录/Evolution Object/promotion gate）据此区分「验过」与「没验」。
   */
  strict: boolean;
  /** 实际使用的受限通道标识（kind='exec' 时；排障与审计用） */
  channel?: string;
  /** 通道机制说明（可用性口径/限制面；kind='exec' 时记录） */
  channel_note?: string;
  /** S9：dynamicCordisRunner 通道执行详情（kind='exec' 且经 runner 通道时；受限子进程路径无此字段） */
  runner?: {
    pluginId: string;
    packageId: string;
    pluginRunId: string;
    /** invoke 读取的脚本裁决（结果读取契约：host 半 harness.handle('verify', handler)） */
    verdict: { ok: boolean; detail: string };
    /** 回滚记录：stop（回退 dispose）是否成功 */
    stopped: boolean;
    /** 回滚记录：undefine（先停后忘）是否成功 */
    undefined: boolean;
  };
  /** S9：runner 通道失败 → 降级回退受限子进程路径的记录（无 → 未走回退） */
  runnerFallback?: string;
}

/** 冻结基准 fitness 对照（§6.5.3：passed 不降 + 成本代理不显著劣化；门禁判定数据化） */
export interface BenchCompare {
  baseline: { passed: number; total: number };
  candidate: { passed: number; total: number };
  /** 成本代理劣化率（相对；≤ candidate_gate.cost_degradation_tolerance 通过） */
  cost_degradation_ratio: number;
}

/** validateDataCandidate 结果（brief 契约：{passed, gates: {g1?, g3?, g3Exec?, g4?}} + G2 + bench） */
export interface DataCandidateValidation {
  passed: boolean;
  gates: { g1?: GateResult; g2?: GateResult; g3?: G3GateResult; g3Exec?: G3ExecGateResult; g4?: G4GateResult };
  reason: string;
  /** G3 冻结基准对照（晋升 Evolution Object.bench 用；未跑 G3 → undefined） */
  bench?: BenchCompare;
  /**
   * 执行型验证完整性（晋升与审计的可读结论）：
   *   - `exec`：候选附验证脚本且**真实执行通过**（受限通道跑过）；
   *   - `na`：候选未附执行型验证脚本（L0 数据候选；无内容可执行——非「跳过」）；
   *   - `degraded`：候选附了脚本但受限通道不可用/异常 → **没跑过**（旧实现把它当通过，是已知问题）；
   *   - `rejected`：脚本执行了但报告失败/裁决问题 → 候选不通过。
   */
  execution_verification: 'exec' | 'na' | 'degraded' | 'rejected';
}

/** 验证依赖（baselinePolicyDir = 当前线生效策略目录；bench 目录缺省冻结基准 v2） */
export interface DataCandidateValidationDeps {
  /** 当前线策略目录（G3 基线策略/捆绑校验基准） */
  baselinePolicyDir: string;
  /** 冻结基准 v2 契约目录（缺省 bench-v2 默认） */
  contractsDir?: string;
  /** 冻结基准 v2 夹具目录（缺省 bench-v2 默认） */
  fixturesDir?: string;
  /** G4 shadow exposure log 路径（.evolution/shadows/exposure.log；未提供 → 仅契约说明不落盘） */
  shadowLogPath?: string;
  /** 候选验证临时目录根（P3 标准化：createCandidateDir；缺省 substrate 默认 candidates 根；测试注入 fixture 根） */
  candidateRoot?: string;
  /** 受限通道可用性探测（P3/D5 降级注入：缺省真实 sandboxStatusAsync——**带通道自检**的精确判定；
   *  测试注入不可用模拟） */
  sandboxStatus?: () => Promise<SandboxStatus>;
  /** S9：dynamicCordisRunner 注入面（宿主 ctx.dynamicCordisRunner 结构最小面；缺失/部分缺失 → 守卫降级受限子进程路径） */
  dynamicRunner?: DynamicCordisRunnerLike;
  /** S9：会话归属（runner 通道 define.sessionId/agent.id 契约；缺省 'anon'） */
  sessionId?: string;
  /**
   * 附执行型验证脚本的候选是否必须真实执行通过（evolve.policy.candidate_gate.require_execution_verification；
   * 缺省 true = fail-closed）。见 runG3Exec 的降级语义段。
   */
  requireExecutionVerification?: boolean;
}

/** 晋升依赖（§3.2 事务 + §6.5.4 对象 + 实现规格 §10 幂等） */
export interface PromoteDataCandidateDeps {
  layout: VersionLayout;
  /** 信任池根（.evolution；CandidatePool） */
  evolutionRoot: string;
  /** 已注册候选记录（untrusted；晋升成功后 pool.promote → trusted） */
  record: CandidateRecord;
  /** 冻结基准 fitness 对照（Evolution Object.bench） */
  bench: BenchCompare;
  /** 通过的验证门（Evolution Object.verifications；如 ['G1','G3']） */
  verifications: string[];
  /** 来源信号事件（provenance.source_events） */
  sourceEvents: string[];
  /** 动机（provenance.motivation + 提交消息摘要） */
  motivation: string;
  /** 提交身份（缺省 OMB <omb@local>） */
  identity?: { name: string; email: string };
  /** 事件库（提供 → evolution/promoted 入链；失败尽力而为不阻断晋升） */
  eventStore?: EventStore;
  sessionId?: string;
  /** 事件/对象 provenance runtime_snapshot */
  snapshotHash?: string;
  /** P4：验证契约判定 payload（Evolution Object.verification 挂载；可选——未提供 → 对象无验证字段） */
  verification?: { verdict: string; verifier_trust: string; contract_id: string };
}

/** 晋升结果 */
export interface PromoteDataCandidateResult {
  promoted: boolean;
  candidate_id: string;
  commit_hash?: string;
  object_id?: string;
  /** 失败/重复原因；成功且事件入链失败时 = 告警说明 */
  reason?: string;
  /** main 分支是否同步快进（best-effort；分叉 → false） */
  main_synced?: boolean;
}

/** 单候选管线 outcome（/evolve 摘要单元） */
export interface CandidateOutcome {
  candidate_id: string;
  seq: number;
  target: string;
  signal: string;
  /** G1+G3 通过（含 G2 skipped/G4 标记） */
  validated: boolean;
  gates: DataCandidateValidation['gates'];
  promoted: boolean;
  commit_hash?: string;
  object_id?: string;
  reason?: string;
  /** 执行型验证完整性（'exec' 真实跑过 / 'na' 无脚本 / 'degraded' 没跑成 / 'rejected' 跑失败） */
  execution_verification?: DataCandidateValidation['execution_verification'];
}

/** P4：候选验证契约门禁结果（deps 注入回调产物；verification 为晋升 Evolution Object 挂载 payload——ok=true 时携带） */
export interface CandidateVerificationGateResult {
  ok: boolean;
  reason: string;
  /** 契约判定 payload（晋升对象挂载：verdict/verifier_trust/contract_id；ok=true 时通常携带） */
  verification?: { verdict: string; verifier_trust: string; contract_id: string };
}

/** 端到端管线依赖 */
export interface CandidatePipelineDeps extends DataCandidateValidationDeps {
  layout: VersionLayout;
  evolutionRoot: string;
  eventStore?: EventStore;
  sessionId?: string;
  snapshotHash?: string;
  /** provenance.source_events（缺省 []） */
  sourceEvents?: string[];
  identity?: { name: string; email: string };
  /**
   * P4：候选验证契约门禁（deps 注入回调——supervisor 不 import kernel 逻辑，实现由 runtime 层装配注入
   * kernel/candidate-contract.ts runCandidateGate；层 DAG 零改动）。validate 通过（passed=true）后、
   * promoteDataCandidate 前调用；未提供 → 跳过（既有行为不变）；ok=false → 不触碰 versions.git。
   */
  verificationGate?: (ctx: {
    draft: { id: string };
    validation: DataCandidateValidation;
  }) => Promise<CandidateVerificationGateResult>;
}

// ---- git 工具（substrate 风格：非 0 退出抛错带 stderr；Windows 瞬态锁不在此重试——调用频率低） ----

function git(cwd: string, args: string[], gitBin?: string): string {
  try {
    const stdout = execFileSync(gitBin ?? GIT_BIN, args, { cwd, encoding: 'utf8', windowsHide: true });
    return stdout.trimEnd();
  } catch (err) {
    const e = err as { status?: number; stderr?: Buffer | string };
    const detail = e.stderr ? String(e.stderr).trimEnd() : '(无 stderr)';
    throw new Error(`git ${args.join(' ')} 失败 (exit=${e.status ?? '?'}): ${detail}`);
  }
}

/** git show <commit>:<path>（文件缺失 → null；晋升幂等/对象读取用） */
function gitShow(layout: VersionLayout, commit: string, path: string): string | null {
  try {
    return git(layout.bareRepo, ['show', `${commit}:${path}`], layout.gitBin);
  } catch {
    return null;
  }
}

// ---- G1 静态门（YAML + policy schema + 值域约束；zod fail-loud 转判定） ----

function formatIssues(issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>): string {
  return issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
}

/** target 白名单校验（kernel/policy/<file>.yaml；防路径穿越与未知目标） */
function validateTarget(target: string): { ok: boolean; file?: PolicyTargetFile; detail?: string } {
  const file = basename(target);
  if (target !== `kernel/policy/${file}` || !(file in POLICY_FILE_SCHEMAS)) {
    return {
      ok: false,
      detail: `未知候选目标 ${target}（合法：kernel/policy/{governor,budget,context,evolve}.yaml）`,
    };
  }
  return { ok: true, file: file as PolicyTargetFile };
}

function runG1(draft: CandidateDraft): GateResult {
  const t = validateTarget(draft.target);
  if (!t.ok) {
    return { gate: 'G1', ok: false, detail: `G1 拒绝: ${t.detail}` };
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(draft.content);
  } catch (err) {
    return { gate: 'G1', ok: false, detail: `G1 拒绝: YAML 解析失败（${(err as Error).message}）` };
  }
  const schema = POLICY_FILE_SCHEMAS[t.file!];
  const result = schema.safeParse(parsed);
  if (!result.success) {
    return {
      gate: 'G1',
      ok: false,
      detail: `G1 拒绝: ${t.file} 经 ${schema.constructor.name} 校验失败（zod fail-loud 转判定，含值域约束 strength≤1/预算非负等）: ${formatIssues(result.error.issues)}`,
    };
  }
  return { gate: 'G1', ok: true, detail: `G1 通过: ${t.file} YAML 解析 + schema 校验（值域约束）通过` };
}

/** G2（数据候选 N/A：策略参数为数据，G2 面向解释器纯函数单测；标记 skipped 并注释说明） */
const G2_SKIPPED: GateResult = {
  gate: 'G2',
  ok: true,
  detail: 'G2 skipped（数据候选 N/A：策略参数为数据，G2 单元/属性测试面向解释器纯函数与代码候选——数据候选无单测契约，不执行）',
};

// ---- 捆绑校验（supervisor 侧 loadPolicy 语义：四策略文件解析 + zod 校验；layer 2 禁止 import） ----

interface PolicyBundleLike {
  governor: unknown;
  budget: unknown;
  context: unknown;
  evolve: EvolvePolicy;
}

async function parsePolicyBundle(dir: string): Promise<{ ok: boolean; detail: string; bundle?: PolicyBundleLike }> {
  const out: Record<string, unknown> = {};
  for (const [file, schema] of Object.entries(POLICY_FILE_SCHEMAS)) {
    const filePath = join(dir, file);
    let raw: string;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch (err) {
      return { ok: false, detail: `捆绑加载失败: ${file} 缺失（${(err as Error).message}）` };
    }
    let parsed: unknown;
    try {
      parsed = parseYaml(raw);
    } catch (err) {
      return { ok: false, detail: `捆绑加载失败: ${file} YAML 解析错误（${(err as Error).message}）` };
    }
    const r = schema.safeParse(parsed);
    if (!r.success) {
      return {
        ok: false,
        detail: `捆绑加载失败: ${file} schema 校验拒绝（${formatIssues(r.error.issues)}）`,
      };
    }
    out[file] = r.data;
  }
  return {
    ok: true,
    detail: '捆绑加载 OK（governor/budget/context/evolve 解析 + schema 校验通过）',
    bundle: {
      governor: out['governor.yaml'],
      budget: out['budget.yaml'],
      context: out['context.yaml'],
      evolve: out['evolve.yaml'] as EvolvePolicy,
    },
  };
}

/** 递归复制目录（G3 临时目录 = 不可变物化副本基线 + diff 覆盖） */
async function copyDirRecursive(src: string, dst: string): Promise<void> {
  await mkdir(dst, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const dstPath = join(dst, entry.name);
    if (entry.isDirectory()) {
      await copyDirRecursive(srcPath, dstPath);
    } else if (entry.isFile()) {
      await copyFile(srcPath, dstPath);
    }
  }
}

// ---- G3 冻结基准回放 fitness（G3-replay，数据候选）+ G3-exec 执行型验证（P3 沙盒门禁） ----

/** G3-exec 验证脚本固定文件名（白名单：仅候选目录内固定名；不接受外部路径——防路径穿越） */
const VERIFY_SCRIPT_NAME = 'verify.cjs';
/** G3-exec 受限执行超时（验证脚本 30s；超时 TerminateJobObject 杀整棵进程树） */
const G3_EXEC_TIMEOUT_MS = 30_000;

/** 递归快照目录（相对路径 → 内容；G3-exec 宿主侧沙盒语义断言用） */
async function snapshotDir(root: string): Promise<Map<string, string>> {
  const snap = new Map<string, string>();
  const walk = async (rel: string): Promise<void> => {
    const abs = rel === '' ? root : join(root, rel);
    for (const entry of await readdir(abs, { withFileTypes: true })) {
      const childRel = rel === '' ? entry.name : join(rel, entry.name);
      const childAbs = join(abs, entry.name);
      if (entry.isDirectory()) {
        await walk(childRel);
      } else if (entry.isFile()) {
        snap.set(childRel, await readFile(childAbs, 'utf8'));
      }
    }
  };
  await walk('');
  return snap;
}

/** 快照差异（文件集合变化 / 内容变化 → 描述；一致 → null） */
function diffSnapshot(before: Map<string, string>, after: Map<string, string>): string | null {
  const added = [...after.keys()].filter((k) => !before.has(k));
  const removed = [...before.keys()].filter((k) => !after.has(k));
  if (added.length > 0 || removed.length > 0) {
    return `文件集合变化（新增 ${added.join(', ') || '无'}；删除 ${removed.join(', ') || '无'}）`;
  }
  for (const [key, value] of before) {
    if (after.get(key) !== value) {
      return `文件内容被修改: ${key}`;
    }
  }
  return null;
}

/**
 * G3-replay（数据候选语义）：候选应用到候选验证环境（createCandidateDir 标准化临时目录：
 * 不可变物化副本 + diff 覆盖）→ 捆绑校验（loadPolicy 语义）→ 冻结基准回放 fitness
 * （runBenchV2 回放执行器；与当前线基准对照：passed 不降 + 成本代理不显著劣化，
 * 门禁判定数据化——cost_degradation_tolerance 入 evolve.policy.candidate_gate）→ 目录用后清理。
 * ⚠️ 回放执行器输出为冻结 fixture（策略无关）——passed/成本对照为回归护栏语义；策略敏感度经成本代理
 *   （context_budget_tokens 投影预算）体现；真实放量 fitness 依赖真实会话（G4 shadow，文档化）。
 */
async function runG3(draft: CandidateDraft, deps: DataCandidateValidationDeps): Promise<G3GateResult> {
  const cand = createCandidateDir(candidateDirName(draft.id), { root: deps.candidateRoot });
  try {
    await copyDirRecursive(deps.baselinePolicyDir, cand.dir);
    await writeFile(join(cand.dir, basename(draft.target)), draft.content, 'utf8');
    const candidateBundle = await parsePolicyBundle(cand.dir);
    if (!candidateBundle.ok || candidateBundle.bundle === undefined) {
      return { gate: 'G3', mode: 'replay', ok: false, detail: `G3-replay 拒绝: 候选应用到临时目录后捆绑校验失败——${candidateBundle.detail}` };
    }
    // 冻结基准回放 fitness（与当前线基准对照）
    const contracts = await loadBenchContractsV2(deps.contractsDir);
    const fixtures = await loadBenchFixturesV2(deps.fixturesDir);
    const baseline = await runBenchV2({
      contracts,
      fixtures,
      line: 'latest',
      executor: makeReplayExecutorV2(fixtures),
      mode: 'replay',
    });
    const candidate = await runBenchV2({
      contracts,
      fixtures,
      line: 'latest',
      executor: makeReplayExecutorV2(fixtures),
      mode: 'replay',
    });
    // 成本代理对照（门禁数据化：容忍入 evolve.policy.candidate_gate）
    const baselineBundle = await parsePolicyBundle(deps.baselinePolicyDir);
    const tolerance =
      baselineBundle.bundle?.evolve.candidate_gate?.cost_degradation_tolerance ?? DEFAULT_COST_TOLERANCE;
    const baseProxy = costProxyOf(baselineBundle.bundle);
    const candProxy = costProxyOf(candidateBundle.bundle);
    const ratio = baseProxy > 0 ? (candProxy - baseProxy) / baseProxy : 0;
    const bench: BenchCompare = {
      baseline: { passed: baseline.passed, total: baseline.total },
      candidate: { passed: candidate.passed, total: candidate.total },
      cost_degradation_ratio: Math.round(ratio * 1000) / 1000,
    };
    if (candidate.passed < baseline.passed) {
      return {
        gate: 'G3',
        mode: 'replay',
        ok: false,
        detail: `G3-replay 拒绝: 回放 fitness 下降（候选 ${candidate.passed}/${candidate.total} < 基线 ${baseline.passed}/${baseline.total}，passed 不得降）`,
        bench,
      };
    }
    if (ratio > tolerance) {
      return {
        gate: 'G3',
        mode: 'replay',
        ok: false,
        detail: `G3-replay 拒绝: 成本显著劣化（成本代理 ${candProxy} vs 基线 ${baseProxy}，劣化 ${(ratio * 100).toFixed(1)}% > 容忍 ${(tolerance * 100).toFixed(1)}%）`,
        bench,
      };
    }
    return {
      gate: 'G3',
      mode: 'replay',
      ok: true,
      detail: `G3-replay 通过: 临时目录捆绑加载 OK + 回放 fitness ${candidate.passed}/${candidate.total}（基线 ${baseline.passed}/${baseline.total}，passed 不降）+ 成本代理劣化 ${(ratio * 100).toFixed(1)}% ≤ 容忍 ${(tolerance * 100).toFixed(1)}%`,
      bench,
    };
  } finally {
    cand.cleanup();
  }
}

/**
 * G3-exec（执行型验证门，P3 接线 + S9 dynamicCordisRunner 增强通道；设计 §3.4 + §4.5 混合路线 + D5 降级裁决）：
 * 候选附执行型验证脚本（draft.verify.script；当前 L0 数据候选无脚本 → N/A 标记「无执行型验证内容」，
 * L1 代码候选未来复用）。两条执行通道：
 *   1. dynamicCordisRunner 通道（S9，宿主面存在且守卫通过时优先）：候选验证脚本 = Cordis host 半包——
 *      define（无副作用登记，host-only → run 无人工审批往返）→ run（生效）→ invoke verify（结果读取契约：
 *      host 半 harness.handle('verify', handler)）→ stop（回退 dispose）→ undefine（先停后忘）。
 *      verdict.ok=false（脚本报告失败）≠ 通道失败——按受限路径同语义拒绝候选。
 *      通道失败（define/run/invoke 抛错或拒绝）→ 记录 runnerFallback → 回退受限子进程路径。
 *   2. 受限子进程路径（平台无关：Windows 受限令牌 / POSIX bwrap 或 Node 权限模型）：候选验证环境
 *      （createCandidateDir：基线 policy 物化副本 + 候选覆盖 + verify.cjs 宿主写入——白名单固定名，
 *      仅候选目录内）→ WRITE_RESTRICTED 受限通道执行（cwd=候选目录，writableDirs=[结果目录]，
 *      结果文件经 OMB_SANDBOX_RESULT_FILE 回传——受限进程不能管道捕获孙进程输出 → 结果文件方案）
 *      → 宿主读结果 JSON 判定（{ok, detail} 契约）+ 沙盒语义验证（脚本尝试写候选目录必须被拒；
 *      宿主侧执行前后快照比对——候选目录被改 → 沙盒失效 fail-closed 拒绝）。
 *
 * **降级语义（已知问题《Linux 适配不完整》派生条，本次修复的核心）**：
 * `opts.requireExecution`（缺省 true，来自 evolve.policy.candidate_gate.require_execution_verification）
 * 决定「带脚本的候选在通道不可用/抛错时」的走向：
 *   - true（缺省，fail-closed）：`ok=false` + `kind='degraded'` → 候选**不通过**，不入晋升。
 *     旧实现在此处返回 `ok=true`，且晋升门禁不读降级位 → 无沙盒的机器上候选可能一次真实执行都没跑
 *     就晋级。现在「没验过」不再等于「验过了」。
 *   - false（部署方显式接受降级）：`ok=true` + `kind='degraded'`（既有 D5 语义），但 `strict=false`
 *     随候选记录/演化学对象一路留痕（谁在什么通道下验的，可审计）。
 * 无论哪种取向：已经跑过的脚本报失败（verdict.ok=false / 非零退出 / 结果文件缺失 / 沙盒语义失效 /
 * 超时）一律**拒绝**——降级策略只放宽「没跑成」，绝不放宽「跑失败」。
 */
async function runG3Exec(draft: CandidateDraft, deps: DataCandidateValidationDeps): Promise<G3ExecGateResult> {
  const requireExecution = deps.requireExecutionVerification ?? true;
  if (draft.verify === undefined) {
    return {
      gate: 'G3',
      ok: true,
      kind: 'na',
      strict: false,
      detail:
        'G3-exec N/A（L0 数据候选无执行型验证脚本——受限执行通道就绪，候选未附带验证内容；L1 代码候选未来复用）',
    };
  }

  // ---- S9：dynamicCordisRunner 增强通道（宿主面存在且守卫通过 → 优先；失败 → 回退受限子进程路径） ----
  let runnerFallback: string | undefined;
  if (deps.dynamicRunner !== undefined) {
    const guard = inspectDynamicRunner(deps.dynamicRunner);
    if (guard.available) {
      try {
        const outcome = await runCandidateViaRunner({
          runner: deps.dynamicRunner,
          sessionId: deps.sessionId ?? 'anon',
          name: `verify-${candidateDirName(draft.id)}`,
          purpose: 'OMB 候选验证（dynamicCordisRunner 通道）',
          script: draft.verify.script,
        });
        if (outcome.ok) {
          const runnerDetail = {
            pluginId: outcome.pluginId!,
            packageId: outcome.packageId!,
            pluginRunId: outcome.pluginRunId!,
            verdict: outcome.verdict!,
            stopped: outcome.stopped,
            undefined: outcome.undefined,
          };
          const detailText = outcome.verdict?.detail ?? '';
          if (outcome.verdict?.ok === true) {
            return {
              gate: 'G3',
              ok: true,
              kind: 'exec',
              strict: true,
              channel: 'dynamic-cordis-runner',
              channel_note: 'dynamicCordisRunner 通道（define→run→invoke verify→stop→undefine）',
              runner: runnerDetail,
              detail: `G3-exec 通过: dynamicCordisRunner 通道执行 OK（define→run→invoke verify→stop→undefine；verdict=${detailText}）`,
            };
          }
          // verdict.ok=false（脚本报告失败）≠ 通道失败——脚本已执行并给出裁决，按受限路径同语义拒绝候选
          return {
            gate: 'G3',
            ok: false,
            kind: 'exec',
            strict: true,
            channel: 'dynamic-cordis-runner',
            runner: runnerDetail,
            detail: `G3-exec 拒绝: 验证脚本报告失败（${detailText}）——dynamicCordisRunner 通道`,
          };
        }
        // 通道失败 → 降级回退受限子进程路径 + 记录
        runnerFallback = `dynamicCordisRunner 通道失败（${outcome.reason ?? '未知原因'}）→ 回退受限子进程路径`;
      } catch (err) {
        runnerFallback = `dynamicCordisRunner 通道异常（${(err as Error).message}）→ 回退受限子进程路径`;
      }
    } else {
      runnerFallback = `dynamicCordisRunner 守卫降级（${guard.reason ?? '未知原因'}）→ 回退受限子进程路径`;
    }
  }

  // ---- 受限子进程路径（平台无关；runner 通道缺失/失败时回退至此） ----
  const status = await (deps.sandboxStatus ?? sandboxStatusAsync)();
  if (!status.available) {
    // D5 降级记录 + 门禁语义按配置取舍：缺省 fail-closed（没验过 ≠ 验过了）
    const degradedReason = [status.reason ?? '受限通道不可用', runnerFallback].filter(Boolean).join('；');
    if (requireExecution) {
      return {
        gate: 'G3',
        ok: false,
        kind: 'degraded',
        strict: false,
        degraded: degradedReason,
        detail:
          `G3-exec 拒绝: 候选附有执行型验证脚本但受限通道不可用（${status.reason ?? '未知原因'}` +
          `${runnerFallback !== undefined ? `；${runnerFallback}` : ''}）——` +
          'require_execution_verification=true（fail-closed）：没有真实执行过的候选不进入晋升；' +
          '如需在无沙盒环境接受降级跳过，请显式设置 evolve.policy.candidate_gate.require_execution_verification=false',
      };
    }
    return {
      gate: 'G3',
      ok: true,
      kind: 'degraded',
      strict: false,
      degraded: degradedReason,
      detail: `G3-exec 跳过（受限通道不可用：${status.reason ?? '未知原因'}${runnerFallback !== undefined ? `；${runnerFallback}` : ''}——D5 降级记录，部署方已显式接受降级跳过；strict=false 随候选留痕）`,
    };
  }
  const name = candidateDirName(draft.id);
  const cand = createCandidateDir(`${name}-verify`, { root: deps.candidateRoot });
  const out = createCandidateDir(`${name}-verify-result`, { root: deps.candidateRoot });
  try {
    await copyDirRecursive(deps.baselinePolicyDir, cand.dir);
    await writeFile(join(cand.dir, basename(draft.target)), draft.content, 'utf8');
    const scriptPath = join(cand.dir, VERIFY_SCRIPT_NAME);
    await writeFile(scriptPath, draft.verify.script, 'utf8');

    // 沙盒语义断言（宿主侧）：受限进程不得改动候选目录（执行前后快照比对——写拒绝）
    const before = await snapshotDir(cand.dir);
    const resultFile = join(out.dir, 'result.json');
    const exec = await runRestricted({
      script: scriptPath,
      args: [cand.dir],
      cwd: cand.dir,
      writableDirs: [out.dir],
      resultFile,
      timeoutMs: G3_EXEC_TIMEOUT_MS,
    });
    const channelInfo = { channel: status.mechanism, channel_note: status.mechanism_note };
    const tampered = diffSnapshot(before, await snapshotDir(cand.dir));
    if (tampered !== null) {
      return {
        gate: 'G3',
        ok: false,
        kind: 'exec',
        strict: true,
        ...channelInfo,
        exec,
        detail: `G3-exec 拒绝: 沙盒语义失效——受限进程改写了候选目录（${tampered}），WRITE_RESTRICTED 未生效`,
      };
    }
    if (exec.timedOut) {
      return {
        gate: 'G3',
        ok: false,
        kind: 'exec',
        strict: true,
        ...channelInfo,
        exec,
        detail: 'G3-exec 拒绝: 验证脚本超时（受限进程被终止，结果文件未回传）',
      };
    }
    if (exec.code !== 0) {
      return {
        gate: 'G3',
        ok: false,
        kind: 'exec',
        strict: true,
        ...channelInfo,
        exec,
        detail: `G3-exec 拒绝: 验证脚本非零退出（code=${exec.code}）`,
      };
    }
    // 结果文件方案：宿主读受限进程写的结果 JSON（stdout 不可管道捕获 → 结果文件回传）
    let verdict: { ok?: unknown; detail?: unknown };
    try {
      verdict = JSON.parse(await readFile(resultFile, 'utf8')) as { ok?: unknown; detail?: unknown };
    } catch (err) {
      return {
        gate: 'G3',
        ok: false,
        kind: 'exec',
        strict: true,
        ...channelInfo,
        exec,
        detail: `G3-exec 拒绝: 验证脚本未写合法结果文件（结果文件方案失败：${(err as Error).message}）`,
      };
    }
    if (verdict.ok !== true) {
      return {
        gate: 'G3',
        ok: false,
        kind: 'exec',
        strict: true,
        ...channelInfo,
        exec,
        detail: `G3-exec 拒绝: 验证脚本报告失败（${typeof verdict.detail === 'string' ? verdict.detail : '无 detail'}）`,
      };
    }
    const detailText = typeof verdict.detail === 'string' ? verdict.detail : '';
    return {
      gate: 'G3',
      ok: true,
      kind: 'exec',
      strict: true,
      ...channelInfo,
      exec,
      detail: `G3-exec 通过: 受限通道（${status.mechanism ?? 'unknown'}）执行 OK（code=${exec.code}）+ 结果文件回传（${detailText}）+ 沙盒语义验证（候选目录写拒绝）${runnerFallback !== undefined ? `；${runnerFallback}` : ''}`,
    };
  } catch (err) {
    // 受限执行异常（Win32/POSIX 通道失败、koffi 缺失等）→ 与「通道不可用」同一取舍（requireExecution）
    const degradedReason = [(err as Error).message, runnerFallback].filter(Boolean).join('；');
    if (requireExecution) {
      return {
        gate: 'G3',
        ok: false,
        kind: 'degraded',
        strict: false,
        degraded: degradedReason,
        detail:
          `G3-exec 拒绝: 受限执行异常（${(err as Error).message}` +
          `${runnerFallback !== undefined ? `；${runnerFallback}` : ''}）——` +
          'require_execution_verification=true（fail-closed）：没有真实执行过的候选不进入晋升',
      };
    }
    return {
      gate: 'G3',
      ok: true,
      kind: 'degraded',
      strict: false,
      degraded: degradedReason,
      detail: `G3-exec 跳过（受限执行异常：${(err as Error).message}${runnerFallback !== undefined ? `；${runnerFallback}` : ''}——D5 降级记录，部署方已显式接受降级跳过；strict=false 随候选留痕）`,
    };
  } finally {
    cand.cleanup();
    out.cleanup();
  }
}

/** G4（shadow 契约接线）：通过 G1+G3 的候选标记 shadow——候选 id/时间/域记入 .evolution/shadows/；
 *  真实放量（isExposed 桶分配进入真实会话）依赖真实会话流量，此处仅契约接线（文档化）。 */
async function runG4(draft: CandidateDraft, deps: DataCandidateValidationDeps): Promise<G4GateResult> {
  if (deps.shadowLogPath === undefined) {
    return {
      gate: 'G4',
      ok: true,
      detail: 'G4 shadow 未接线（无 shadowLogPath——候选未落 exposure 记录；真实放量依赖真实会话流量，文档化）',
    };
  }
  await logExposure(deps.shadowLogPath, {
    ts: Date.now(),
    candidate_id: draft.id,
    seed: draft.id,
    bucket: bucketFor(draft.id),
    layer: 'L0',
    decision: 'shadow',
  });
  return {
    gate: 'G4',
    ok: true,
    detail: `G4 shadow 记录已写入 ${deps.shadowLogPath}（候选 id/时间/域= L0；真实放量 = 桶分配进入真实会话，依赖真实流量，文档化）`,
  };
}

/**
 * 数据候选验证生产路径（§6.5.3 G1-G4）：G1 静态 → G2 skipped → G3-replay 冻结基准回放 fitness →
 * G3-exec 执行型验证（受限通道 + 结果文件方案；无脚本 N/A / 通道不可用按 requireExecutionVerification
 * 取舍）→ G4 shadow。G1/G3-replay 任一失败 → passed=false + reason（门禁短路：后续门不跑在失败后）。
 */
export async function validateDataCandidate(
  draft: CandidateDraft,
  deps: DataCandidateValidationDeps,
): Promise<DataCandidateValidation> {
  const g1 = runG1(draft);
  if (!g1.ok) {
    return { passed: false, gates: { g1, g2: G2_SKIPPED }, reason: `验证失败: ${g1.detail}`, execution_verification: 'na' };
  }
  const g3 = await runG3(draft, deps);
  if (!g3.ok) {
    return {
      passed: false,
      gates: { g1, g2: G2_SKIPPED, g3 },
      reason: `验证失败: ${g3.detail}`,
      bench: g3.bench,
      execution_verification: 'na',
    };
  }
  const g3Exec = await runG3Exec(draft, deps);
  if (!g3Exec.ok) {
    // G3-exec 拒绝：脚本报告失败 / 结果文件方案失败 / 沙盒语义失效 / 降级且 require_execution_verification
    // → 候选不通过（后者 = 已知问题《Linux 适配不完整》派生条的修复点：没验过不再等于验过了）
    return {
      passed: false,
      gates: { g1, g2: G2_SKIPPED, g3, g3Exec },
      reason: `验证失败: ${g3Exec.detail}`,
      bench: g3.bench,
      execution_verification: g3Exec.kind === 'degraded' ? 'degraded' : 'rejected',
    };
  }
  const g4 = await runG4(draft, deps);
  const g3ExecNote =
    g3Exec.kind === 'exec' ? '+G3-exec' : g3Exec.kind === 'degraded' ? '+G3-exec(降级跳过)' : '';
  return {
    passed: true,
    gates: { g1, g2: G2_SKIPPED, g3, g3Exec, g4 },
    reason: `验证通过（G1+G3-replay${g3ExecNote}；G2 skipped；G4 shadow 已标记）`,
    bench: g3.bench,
    execution_verification: g3Exec.kind === 'exec' ? 'exec' : g3Exec.kind === 'degraded' ? 'degraded' : 'na',
  };
}

/** 执行型验证完整性 → 候选记录 gates_passed 的留痕条目（跨进程可审计：谁在什么通道下验的） */
export function executionVerificationGateNote(v: DataCandidateValidation): string {
  const exec = v.gates.g3Exec;
  switch (v.execution_verification) {
    case 'exec':
      return `G3-exec:strict${exec?.channel !== undefined ? `(${exec.channel})` : ''}`;
    case 'degraded':
      return 'G3-exec:degraded(no-channel)';
    case 'rejected':
      return 'G3-exec:rejected';
    default:
      return 'G3-exec:na(no-script)';
  }
}

// ---- Evolution Object（§6.5.4：parent/diff/provenance/compat/bench/verifications → git） ----

/**
 * 当前线 .evolution-objects/ 链头（未引用为任何对象 parent 的对象 id）；无对象 → null。
 * 导出供 runtime 层晋升检查（P1e）复用——stable 晋升的 evolution/promoted 事件引用该链头
 * （P1d 的 latest 晋升对象链 = trusted-latest 线内 Evolution Object 集合的链头）。
 */
export async function latestObjectId(layout: VersionLayout, commit: string): Promise<string | null> {
  let names: string[];
  try {
    names = git(layout.bareRepo, ['ls-tree', '-r', '--name-only', commit], layout.gitBin)
      .split('\n')
      .filter((n) => n.startsWith('.evolution-objects/') && n.endsWith('.json'));
  } catch {
    return null; // 布局/提交不可枚举 → 无已知对象（首个晋升 parent=null）
  }
  const objects: EvolutionObject[] = [];
  for (const name of names) {
    const raw = gitShow(layout, commit, name);
    if (raw === null) {
      continue;
    }
    try {
      objects.push(EvolutionObjectSchema.parse(JSON.parse(raw)));
    } catch {
      continue; // 损坏对象不阻断链推导（fail-loud 留给消费方）
    }
  }
  if (objects.length === 0) {
    return null;
  }
  const parentSet = new Set(objects.filter((o) => o.parent !== null && o.parent !== undefined).map((o) => o.parent!));
  const head = objects.find((o) => !parentSet.has(o.id));
  return head?.id ?? null;
}

/**
 * R8：读取指定提交内 `.evolution-objects/<hex>.json` 的 Evolution Object（不存在/损坏/ID 不匹配 → null）。
 * /evolve share（发布机制级对象：trusted-latest 演化链头 → 本地 registry）复用；与 latestObjectId 配对——
 * 先取链头 id 再读对象内容。CAS 语义：文件内容 id 必须等于请求 id（防 swap 篡改）。
 */
export async function loadEvolutionObject(
  layout: VersionLayout,
  commit: string,
  id: string,
): Promise<EvolutionObject | null> {
  const raw = gitShow(layout, commit, `.evolution-objects/${candidateDirName(id)}.json`);
  if (raw === null) {
    return null;
  }
  try {
    const obj = EvolutionObjectSchema.parse(JSON.parse(raw));
    return obj.id === id ? obj : null;
  } catch {
    return null; // 损坏对象不阻断（fail-loud 留给消费方）
  }
}

/** Evolution Object 构造（M4：id = sha256(canonical(除 id 外全字段))；immutable） */
async function buildEvolutionObject(
  draft: CandidateDraft,
  opts: {
    parent: string | null;
    bench: BenchCompare;
    verifications: string[];
    sourceEvents: string[];
    motivation: string;
    snapshotHash?: string;
    /** P4：验证契约判定 payload（Evolution Object.verification 挂载；可选——无 → 对象无验证字段） */
    verification?: { verdict: string; verifier_trust: string; contract_id: string };
  },
): Promise<EvolutionObject> {
  const ts = new Date().toISOString();
  const snapshot = opts.snapshotHash ?? 'rs:assembly';
  const body: Omit<EvolutionObject, 'id'> = {
    ir_version: '2.0',
    schema: 'omb/M4',
    scope: 'Project',
    lifecycle: 'active',
    immutable: true,
    owner: 'kernel',
    created: ts,
    updated: ts,
    provenance: {
      source: 'evolution/generator',
      event: 'evolution/promoted',
      actor: 'omb-v2',
      environment: { os: process.platform, node: process.version, dsh_version: hostVersion(), project: 'omb-v2' }, // R6：唯一宿主版本来源
      runtime_snapshot: snapshot,
      timestamp: ts,
      transformation_chain: ['evolution/generator', 'candidate-validation', 'promote'],
      verification: 'G1+G3',
    },
    refs: [],
    protocol_version: 'omb/M4',
    parent: opts.parent,
    diff: draft.diff,
    compat: 'policy/v1',
    bench: JSON.stringify(opts.bench),
    spdx: 'MIT',
    verifications: opts.verifications,
  };
  // P4：验证契约判定挂载（可选——仅当可用时入 body；undefined 不写键，保证内容寻址 id 与落盘 JSON 一致）
  if (opts.verification !== undefined) {
    body.verification = opts.verification;
  }
  const id = makeImmutableId(canonicalJson(body));
  return { ...body, id };
}

/** evolution/promoted 事件（M3；payload 含 object id/candidate id/commit） */
function buildPromotedEvent(
  draft: CandidateDraft,
  object: EvolutionObject,
  commitHash: string,
  deps: { sessionId?: string; snapshotHash?: string },
): Event {
  const ts = new Date().toISOString();
  const snapshot = deps.snapshotHash ?? 'rs:assembly';
  const ev: Event = {
    ir_version: '2.0',
    id: makeMutableId('evt'),
    schema: 'omb/M3',
    scope: 'Session',
    lifecycle: 'active',
    immutable: false,
    owner: 'kernel',
    created: ts,
    updated: ts,
    provenance: {
      source: 'supervisor/candidate-pipeline',
      event: 'evolution/promoted',
      actor: 'omb-v2',
      environment: { os: process.platform, node: process.version, dsh_version: hostVersion(), project: 'omb-v2' }, // R6：唯一宿主版本来源
      runtime_snapshot: snapshot,
      timestamp: ts,
      transformation_chain: ['evolution/generator', 'candidate-validation', 'promote'],
      verification: 'G1+G3',
    },
    refs: [],
    type: 'evolution/promoted',
    session_id: deps.sessionId ?? 'anon',
    runtime_snapshot: snapshot,
    parent_event: null,
    payload: { object_id: object.id, candidate_id: draft.id, commit: commitHash, target: draft.target, bench: object.bench },
    timestamp: ts,
  };
  const checked = EventSchema.safeParse(ev);
  if (!checked.success) {
    throw new Error(`promoted 事件构造失败（EventSchema）: ${checked.error.message}`);
  }
  return ev;
}

// ---- 晋升与合并（txn → main → trusted-latest；幂等键 candidate_id） ----

/**
 * 晋升（§3.2 commit+promote）：临时 worktree（线工作副本 = trusted-latest commit）覆盖式写入候选内容 +
 * .evolution-objects/<id>.json → `git add` + commit（作者 OMB <omb@local>）→ 防误删检查（diff 无删除）→
 * `git update-ref refs/heads/trusted-latest` 原子推进 → main 快进（best-effort）→ 信任池 promote →
 * evolution/promoted 事件。幂等：候选已 trusted / 内容已在 trusted-latest → 拒绝（duplicate）。
 * 失败即 rejected：commit/update-ref 失败 → pool.reject（rejected/ 留痕 reason.txt）→ {promoted:false}。
 */
export async function promoteDataCandidate(
  draft: CandidateDraft,
  deps: PromoteDataCandidateDeps,
): Promise<PromoteDataCandidateResult> {
  const pool = new CandidatePool(deps.evolutionRoot);

  // ---- 幂等（candidate_id 幂等键：同候选重复提交拒绝） ----
  try {
    const existing = await pool.load(draft.id);
    if (existing.status === 'trusted') {
      return { promoted: false, candidate_id: draft.id, reason: `duplicate（候选 ${draft.id} 已晋升）` };
    }
    if (existing.status === 'rejected') {
      return { promoted: false, candidate_id: draft.id, reason: `候选 ${draft.id} 已被拒绝（rejected/）` };
    }
  } catch {
    // 未注册 → 继续（调用方应先 registerCandidate）
  }

  const identity = deps.identity ?? { name: 'OMB', email: 'omb@local' };
  let baseCommit: string;
  try {
    baseCommit = resolveLineCommit(deps.layout, 'latest');
  } catch (err) {
    const reason = `晋升失败: trusted-latest 解析失败（${(err as Error).message}）`;
    await rejectQuietly(pool, deps.record, reason);
    return { promoted: false, candidate_id: draft.id, reason };
  }
  // 内容级幂等：同 target 同内容已在 trusted-latest → 拒绝（防重复提交同一变更）
  const current = gitShow(deps.layout, baseCommit, draft.target);
  if (current !== null && current === draft.content) {
    return { promoted: false, candidate_id: draft.id, reason: `duplicate（候选内容已在 trusted-latest ${baseCommit.slice(0, 12)}）` };
  }

  // ---- 晋升事务（临时 worktree 提交；失败即 rejected） ----
  const tmpTree = await mkdtemp(join(tmpdir(), 'omb-promote-'));
  try {
    // 线工作副本：trusted-latest commit 的临时 worktree（可写；不动正式 stable/latest 只读 worktree）
    // `-q`：抑制 git 进度输出（"Preparing worktree …" 由 git 直写 stderr，不走本仓库的诊断闸门）
    git(deps.layout.bareRepo, ['worktree', 'add', '-q', '--detach', tmpTree, baseCommit], deps.layout.gitBin);

    // 覆盖式 diff 提交：写候选内容 + Evolution Object（不删除其余文件）
    const policyAbs = join(tmpTree, draft.target);
    await mkdir(dirname(policyAbs), { recursive: true });
    await writeFile(policyAbs, draft.content, 'utf8');
    const parentId = await latestObjectId(deps.layout, baseCommit);
    const object = await buildEvolutionObject(draft, {
      parent: parentId,
      bench: deps.bench,
      verifications: deps.verifications,
      sourceEvents: deps.sourceEvents,
      motivation: deps.motivation,
      snapshotHash: deps.snapshotHash,
      verification: deps.verification,
    });
    const objAbs = join(tmpTree, '.evolution-objects', `${candidateDirName(object.id)}.json`);
    await mkdir(dirname(objAbs), { recursive: true });
    await writeFile(objAbs, JSON.stringify(object, null, 2), 'utf8');

    git(tmpTree, ['add', '.']);
    const message = `evolve: ${draft.id} ${deps.motivation.slice(0, 80)}`;
    git(
      tmpTree,
      ['-c', `user.name=${identity.name}`, '-c', `user.email=${identity.email}`, 'commit', '-m', message],
    );
    const commitHash = git(tmpTree, ['rev-parse', 'HEAD']);

    // 防误删检查：覆盖式 diff（候选提交不得删除基线文件；ls-tree/diff 语义比对）
    const statuses = git(deps.layout.bareRepo, ['diff', '--name-status', baseCommit, commitHash], deps.layout.gitBin);
    const deletions = statuses.split('\n').filter((line) => /^D/i.test(line.trim()));
    if (deletions.length > 0) {
      throw new Error(`防误删检查失败: 候选提交删除了 ${deletions.length} 个文件（${deletions.join('; ')}）`);
    }

    // 原子推进 trusted-latest（update-ref = lock+rename，同 rollback.ts 语义）
    git(deps.layout.bareRepo, ['update-ref', 'refs/heads/trusted-latest', commitHash], deps.layout.gitBin);

    // main 快进（best-effort：main 为 commit 祖先 → 推进；分叉 → 跳过记录——latest 权威 = trusted-latest，D1 ⑤）
    let mainSynced = false;
    try {
      git(deps.layout.bareRepo, ['merge-base', '--is-ancestor', 'refs/heads/main', commitHash], deps.layout.gitBin);
      git(deps.layout.bareRepo, ['update-ref', 'refs/heads/main', commitHash], deps.layout.gitBin);
      mainSynced = true;
    } catch {
      mainSynced = false;
    }

    // 信任池晋升（谱系校验后移入 trusted/；仅实际合并的候选成为 trusted）
    await pool.promote(deps.record);

    // evolution/promoted 事件入链（尽力而为：入链失败不撤销已合并提交——事件为日志）
    let reason: string | undefined;
    if (deps.eventStore !== undefined) {
      try {
        await deps.eventStore.append(
          buildPromotedEvent(draft, object, commitHash, { sessionId: deps.sessionId, snapshotHash: deps.snapshotHash }),
        );
      } catch (err) {
        reason = `promoted 事件入链失败（${(err as Error).message}）——提交与指针已生效`;
      }
    }
    return {
      promoted: true,
      candidate_id: draft.id,
      commit_hash: commitHash,
      object_id: object.id,
      reason,
      main_synced: mainSynced,
    };
  } catch (err) {
    const reason = `晋升失败: ${(err as Error).message}`;
    await rejectQuietly(pool, deps.record, reason);
    return { promoted: false, candidate_id: draft.id, reason };
  } finally {
    await cleanupWorktree(deps.layout, tmpTree);
  }
}

/** 失败留痕（rejected/ + reason.txt；记录不存在/已拒绝 → 忽略——幂等） */
async function rejectQuietly(pool: CandidatePool, record: CandidateRecord, reason: string): Promise<void> {
  try {
    await pool.reject(record, reason);
  } catch {
    // 未注册/已拒绝 → 忽略（reject 幂等语义）
  }
}

/** 清理临时 worktree（worktree remove --force + 目录删除；失败忽略——fixture 拆除兜底） */
async function cleanupWorktree(layout: VersionLayout, dir: string): Promise<void> {
  try {
    git(layout.bareRepo, ['worktree', 'remove', '--force', dir], layout.gitBin);
  } catch {
    // 注册删除失败 → 目录 rm 兜底
  }
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    // 删除失败（锁）→ 残留（%TEMP%/omb-promote-*；无害）
  }
}

// ---- 端到端管线（幂等早退 → 验证 → 注册 → 晋升） ----

/**
 * 单候选端到端（§6.5.2 → §6.5.3 → §3.2）：幂等早退（已注册/内容已在 trusted-latest → duplicate，不做
 * 验证/晋升——量子重复执行廉价）→ validateDataCandidate（G1/G2/G3/G4）→ 未过 → outcome(validated=false)
 * → 通过 → registerCandidate（untrusted + provenance 清单）→ promoteDataCandidate → outcome。
 */
export async function runCandidatePipeline(
  draft: CandidateDraft,
  deps: CandidatePipelineDeps,
): Promise<CandidateOutcome> {
  const base = { candidate_id: draft.id, seq: draft.seq, target: draft.target, signal: draft.signal };
  const pool = new CandidatePool(deps.evolutionRoot);

  // 幂等早退（验证前；quantum 重复执行路径）
  try {
    const existing = await pool.load(draft.id);
    if (existing.status === 'trusted') {
      return { ...base, validated: false, gates: {}, promoted: false, reason: 'duplicate（候选已晋升）' };
    }
    if (existing.status === 'rejected') {
      return { ...base, validated: false, gates: {}, promoted: false, reason: '候选已被拒绝（rejected/）' };
    }
  } catch {
    // 未注册
  }
  try {
    const head = resolveLineCommit(deps.layout, 'latest');
    const current = gitShow(deps.layout, head, draft.target);
    if (current !== null && current === draft.content) {
      return { ...base, validated: false, gates: {}, promoted: false, reason: 'duplicate（内容已在 trusted-latest）' };
    }
  } catch {
    // 布局不可用 → 继续验证（G3 会记录基线不可用）
  }

  const vr = await validateDataCandidate(draft, {
    baselinePolicyDir: deps.baselinePolicyDir,
    contractsDir: deps.contractsDir,
    fixturesDir: deps.fixturesDir,
    shadowLogPath: deps.shadowLogPath,
    candidateRoot: deps.candidateRoot,
    sandboxStatus: deps.sandboxStatus,
    requireExecutionVerification: deps.requireExecutionVerification,
    dynamicRunner: deps.dynamicRunner,
    sessionId: deps.sessionId,
  });
  if (!vr.passed) {
    return {
      ...base,
      validated: false,
      gates: vr.gates,
      promoted: false,
      reason: `验证失败: ${vr.reason}`,
      execution_verification: vr.execution_verification,
    };
  }

  // P4：验证契约门禁（deps 注入回调——supervisor 不 import kernel 逻辑；未提供 → 跳过，既有行为不变；
  // ok=false → outcome 记录 promoted=false + degraded 原因，不触碰 versions.git、不注册候选）
  let gateResult: CandidateVerificationGateResult | undefined;
  if (deps.verificationGate !== undefined) {
    gateResult = await deps.verificationGate({ draft: { id: draft.id }, validation: vr });
    if (!gateResult.ok) {
      return {
        ...base,
        validated: true,
        gates: vr.gates,
        promoted: false,
        reason: `验证契约门禁拒绝（degraded，不触碰版本库）: ${gateResult.reason}`,
        execution_verification: vr.execution_verification,
      };
    }
  }

  // 注册（untrusted + §6.5.2 provenance 清单：来源事件/动机/diff）
  const record: CandidateRecord = {
    id: draft.id,
    kind: 'policy',
    status: 'untrusted',
    parent: null,
    lineage: [],
    // 执行型验证完整性一并留痕（跨进程可审计：候选是靠真实执行通过的，还是靠降级跳过/无脚本通过的）
    gates_passed: ['G1', 'G3', executionVerificationGateNote(vr)],
    created: Date.now(),
    provenance: 'evolution/generator',
  };
  try {
    await pool.registerCandidate(record, draft.content, {
      source_events: deps.sourceEvents ?? [],
      motivation: draft.motivation,
      diff: draft.diff,
      created: Date.now(),
    });
  } catch (err) {
    if (err instanceof Error && /已注册/.test(err.message)) {
      return {
        ...base,
        validated: false,
        gates: vr.gates,
        promoted: false,
        reason: 'duplicate（候选已注册）',
        execution_verification: vr.execution_verification,
      };
    }
    throw err;
  }

  const pr = await promoteDataCandidate(draft, {
    layout: deps.layout,
    evolutionRoot: deps.evolutionRoot,
    record,
    bench: vr.bench ?? { baseline: { passed: 0, total: 0 }, candidate: { passed: 0, total: 0 }, cost_degradation_ratio: 0 },
    verifications: ['G1', 'G3', executionVerificationGateNote(vr)],
    sourceEvents: deps.sourceEvents ?? [],
    motivation: draft.motivation,
    identity: deps.identity,
    eventStore: deps.eventStore,
    sessionId: deps.sessionId,
    snapshotHash: deps.snapshotHash,
    // P4：验证契约判定 payload（门禁结果可用 → Evolution Object.verification 挂载）
    verification: gateResult?.verification,
  });
  return {
    ...base,
    validated: true,
    gates: vr.gates,
    promoted: pr.promoted,
    commit_hash: pr.commit_hash,
    object_id: pr.object_id,
    reason: pr.reason,
    execution_verification: vr.execution_verification,
  };
}
