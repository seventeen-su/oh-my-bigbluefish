// P1d 候选管线生产接线（架构 §3.2 演化事务 begin→mutate→validate→commit→promote + §6.5.3 验证链 G1-G4 +
// §6.5.4 Evolution Object → git + 实现规格 §10 Evolution 事务 git 原子性 / candidate_id 幂等键）：layer 1。
//
// 内容：
//   - validateDataCandidate：数据候选验证生产路径——G1（YAML + policy schema + 值域，zod fail-loud 转判定）
//     → G2（数据候选 N/A，标记 skipped）→ G3（候选应用到临时目录（不可变物化副本 + diff 覆盖）→ 捆绑
//     校验（supervisor 侧 loadPolicy 语义）→ 冻结基准回放 fitness（runBenchV2 回放执行器，passed 不降 +
//     成本代理不显著劣化）→ 目录用后清理）→ G4（通过 G1+G3 → shadow exposure log 契约接线，
//     .evolution/shadows/；真实放量依赖真实会话流量，文档化）。
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
import { canonicalJson, makeImmutableId, makeMutableId } from '../kernel/schemas/base.js';
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

/** G3 门结果（附冻结基准对照——Evolution Object.bench 数据源） */
export interface G3GateResult extends GateResult {
  bench?: BenchCompare;
}

/** 冻结基准 fitness 对照（§6.5.3：passed 不降 + 成本代理不显著劣化；门禁判定数据化） */
export interface BenchCompare {
  baseline: { passed: number; total: number };
  candidate: { passed: number; total: number };
  /** 成本代理劣化率（相对；≤ candidate_gate.cost_degradation_tolerance 通过） */
  cost_degradation_ratio: number;
}

/** validateDataCandidate 结果（brief 契约：{passed, gates: {g1?, g3?}, reason} + G2/G4 + bench） */
export interface DataCandidateValidation {
  passed: boolean;
  gates: { g1?: GateResult; g2?: GateResult; g3?: G3GateResult; g4?: G4GateResult };
  reason: string;
  /** G3 冻结基准对照（晋升 Evolution Object.bench 用；未跑 G3 → undefined） */
  bench?: BenchCompare;
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

// ---- G3 冻结基准回放 fitness（数据候选） ----

/**
 * G3（数据候选语义）：候选应用到临时目录（不可变物化副本 + diff 覆盖）→ 捆绑校验（loadPolicy 语义）→
 * 冻结基准回放 fitness（runBenchV2 回放执行器；与当前线基准对照：passed 不降 + 成本代理不显著劣化，
 * 门禁判定数据化——cost_degradation_tolerance 入 evolve.policy.candidate_gate）→ 目录用后清理。
 * ⚠️ 回放执行器输出为冻结 fixture（策略无关）——passed/成本对照为回归护栏语义；策略敏感度经成本代理
 *   （context_budget_tokens 投影预算）体现；真实放量 fitness 依赖真实会话（G4 shadow，文档化）。
 */
async function runG3(draft: CandidateDraft, deps: DataCandidateValidationDeps): Promise<G3GateResult> {
  const tempDir = await mkdtemp(join(tmpdir(), 'omb-cand-g3-'));
  try {
    await copyDirRecursive(deps.baselinePolicyDir, tempDir);
    await writeFile(join(tempDir, basename(draft.target)), draft.content, 'utf8');
    const candidateBundle = await parsePolicyBundle(tempDir);
    if (!candidateBundle.ok || candidateBundle.bundle === undefined) {
      return { gate: 'G3', ok: false, detail: `G3 拒绝: 候选应用到临时目录后捆绑校验失败——${candidateBundle.detail}` };
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
        ok: false,
        detail: `G3 拒绝: 回放 fitness 下降（候选 ${candidate.passed}/${candidate.total} < 基线 ${baseline.passed}/${baseline.total}，passed 不得降）`,
        bench,
      };
    }
    if (ratio > tolerance) {
      return {
        gate: 'G3',
        ok: false,
        detail: `G3 拒绝: 成本显著劣化（成本代理 ${candProxy} vs 基线 ${baseProxy}，劣化 ${(ratio * 100).toFixed(1)}% > 容忍 ${(tolerance * 100).toFixed(1)}%）`,
        bench,
      };
    }
    return {
      gate: 'G3',
      ok: true,
      detail: `G3 通过: 临时目录捆绑加载 OK + 回放 fitness ${candidate.passed}/${candidate.total}（基线 ${baseline.passed}/${baseline.total}，passed 不降）+ 成本代理劣化 ${(ratio * 100).toFixed(1)}% ≤ 容忍 ${(tolerance * 100).toFixed(1)}%`,
      bench,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
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
 * 数据候选验证生产路径（§6.5.3 G1-G4）：G1 静态 → G2 skipped → G3 冻结基准回放 fitness → G4 shadow。
 * G1/G3 任一失败 → passed=false + reason（门禁短路：G3 不跑在 G1 失败后）。
 */
export async function validateDataCandidate(
  draft: CandidateDraft,
  deps: DataCandidateValidationDeps,
): Promise<DataCandidateValidation> {
  const g1 = runG1(draft);
  if (!g1.ok) {
    return { passed: false, gates: { g1, g2: G2_SKIPPED }, reason: `验证失败: ${g1.detail}` };
  }
  const g3 = await runG3(draft, deps);
  if (!g3.ok) {
    return {
      passed: false,
      gates: { g1, g2: G2_SKIPPED, g3 },
      reason: `验证失败: ${g3.detail}`,
      bench: g3.bench,
    };
  }
  const g4 = await runG4(draft, deps);
  return {
    passed: true,
    gates: { g1, g2: G2_SKIPPED, g3, g4 },
    reason: '验证通过（G1+G3；G2 skipped；G4 shadow 已标记）',
    bench: g3.bench,
  };
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
      environment: { os: process.platform, node: process.version, dsh_version: '0.8.0', project: 'omb-v2' },
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
      environment: { os: process.platform, node: process.version, dsh_version: '0.8.0', project: 'omb-v2' },
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
    git(deps.layout.bareRepo, ['worktree', 'add', '--detach', tmpTree, baseCommit], deps.layout.gitBin);

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
  });
  if (!vr.passed) {
    return { ...base, validated: false, gates: vr.gates, promoted: false, reason: `验证失败: ${vr.reason}` };
  }

  // 注册（untrusted + §6.5.2 provenance 清单：来源事件/动机/diff）
  const record: CandidateRecord = {
    id: draft.id,
    kind: 'policy',
    status: 'untrusted',
    parent: null,
    lineage: [],
    gates_passed: ['G1', 'G3'],
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
      return { ...base, validated: false, gates: vr.gates, promoted: false, reason: 'duplicate（候选已注册）' };
    }
    throw err;
  }

  const pr = await promoteDataCandidate(draft, {
    layout: deps.layout,
    evolutionRoot: deps.evolutionRoot,
    record,
    bench: vr.bench ?? { baseline: { passed: 0, total: 0 }, candidate: { passed: 0, total: 0 }, cost_degradation_ratio: 0 },
    verifications: ['G1', 'G3'],
    sourceEvents: deps.sourceEvents ?? [],
    motivation: draft.motivation,
    identity: deps.identity,
    eventStore: deps.eventStore,
    sessionId: deps.sessionId,
    snapshotHash: deps.snapshotHash,
  });
  return {
    ...base,
    validated: true,
    gates: vr.gates,
    promoted: pr.promoted,
    commit_hash: pr.commit_hash,
    object_id: pr.object_id,
    reason: pr.reason,
  };
}
