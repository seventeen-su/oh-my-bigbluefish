// layer 2：认知系统装配（组合根，架构 §12.2 运行形态 / T8.3 装配进插件生命周期）。
// T8.26.2：三能力拆分（Loop Integration 专项 §3）——prepareTurn（turn 开始：快照/工作状态/决策/检索/
// 投影编译/注入）+ observeEvent（运行中：事件入链 + 归约）+ finalizeTurn（收尾：decision/made +
// Experience 候选 + 信号聚合 + checkpoint + maintenance）；handleRequest = 三者组合（行为不变）。
// 纯函数助手在 runtime/turn-helpers.ts（LOC 预算拆分，本文件 ≤400）。
//
// 层 DAG（CONVENTIONS §4）：runtime(2) → supervisor(1)/memory(2)/kernel(2) 均满足
// "import 目标层 ≤ 源层"（eslint no-cross-layer-import 同款语义，tests/m0/dag-lint.test.ts 钉住）。
// 策略/过程为"机制即数据"（P3）：懒加载（首次请求），改 YAML 即生效。
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { cpus, totalmem } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { GIT_BIN, defaultLayout, runGit } from '../substrate/snapshot.js';
import { ensureLineSnapshot, isVersionLine, resolveLineCommit, type VersionLine, type VersionLayout } from '../substrate/lines.js';
import {
  createSnapshot,
  SnapshotRegistry,
  type ComponentHashes,
  type LineHashInput,
} from '../supervisor/versioning.js';
import { computeComponentHashes, computeDirContentHash } from './snapshot-hash.js';
import { makeMutableId } from '../kernel/schemas/base.js';
import type { Fingerprint } from '../kernel/schemas/base.js';
// R6：宿主版本唯一来源注入面（kernel/schemas IR 契约层，runtime(2) → kernel/schemas(2) ✓）
import { hostVersion, setHostVersion } from '../kernel/schemas/host-version.js';
import type { ContextProjection } from '../kernel/schemas/a.js';
import { EventSchema, type Event, type Checkpoint, type RuntimeSnapshot } from '../kernel/schemas/m.js';
import { StateSchema, type State, type SelfModel, type WorldModel } from '../kernel/schemas/s.js';
import type { ModelAdapter } from '../kernel/schemas/model-adapter.js';
import { loadPolicy, loadProcesses, type PolicyBundle, type ProcessDef } from '../kernel/policy-loader.js';
import { EventStore } from '../supervisor/event-store.js';
import { latest as latestCheckpoint, restore as restoreCheckpoint, save as saveCheckpoint } from '../supervisor/checkpoint.js';
import { MaintenanceScheduler, DeferredMaintenanceError, type MaintenanceDebt, type QuantumReport } from '../supervisor/maintenance.js';
import { reduce, type Projections, type ReducedState, type UtilityCounts } from '../supervisor/state-reducer.js';
import { RetrievalBackend } from '../memory/backend-retrieval.js';
import { retrieve, type RankedMemory } from '../memory/retrieve.js';
import { assessApplicability, type WorkingState } from './generator-ops.js';
import { decide, type GovernorDecision, type GovernorInput, type ProcessDecisionInfo } from './governor.js';
import { buildPrompt, type BuiltPrompt, type PromptWorkingState } from './prompt.js';
import { buildContextProjection, buildExperienceCandidate, experienceToStageEvent, EXPERIENCE_STAGE_PRIORITY, makeRuntimeEvent, MAX_EXPERIENCES_STAGED_PER_TURN, toPromptWorkingState, toProcessSection } from './turn-helpers.js';
import { ProcessScheduler } from './scheduler.js';
import type { Experience } from '../kernel/schemas/c.js';
// R4（P0）：Experience → Memory 长期学习闭环——staging（准入）+ consolidate（dedup/merge/relation/decay）
import { StagingManager } from '../memory/staging.js';
import { consolidate } from '../memory/consolidate.js';
// P1c：演化信号落盘 + 判定/债务纯函数 + L1 采集器输出面（层 DAG：runtime(2) → kernel(2)/runtime(2) ✓）
import { appendSignals, readSignals, signalsDirOf } from './evolution-signals.js';
import { collectGeneralizationSignals } from './signal-collectors.js';
import {
  candidateValidationAccrual,
  countsToSignalRecords,
  debtAccrualsFromSummary,
  decideEvolution,
  evaluationSignalsToRecords,
  memoryConsolidationAccrual,
  repairAccrual,
  summarizeSignals,
} from '../kernel/evolve-decision.js';
import type { EvolutionDecision, CapabilityDecayRecord, ArtifactRef } from '../kernel/schemas/evolution.js';
// P7：Predictive Invalidation 环境指纹（§14.5/§15.4——指纹 diff 纯函数 + 采集 + 衰减记录构造）
import {
  buildCapabilityDecayRecord,
  collectEnvironmentFingerprint,
  diffFingerprints,
} from '../kernel/environment-fingerprint.js';
// P1d：候选生成（kernel 纯函数）→ 候选管线（supervisor 层 1；runtime(2) → supervisor(1) ✓）
import { generatePolicyAdjustmentCandidates } from '../kernel/candidate-generator.js';
import { runCandidatePipeline, latestObjectId, loadEvolutionObject, type CandidateOutcome } from '../supervisor/candidate-pipeline.js';
// R8：集体共享显式命令（架构 §13——/evolve share 发布 / /evolve absorb 吸收；GitRegistry 本地 registry +
// share-pipeline 既有 absorb 管线；layer 2 → supervisor(1) ✓）
import { absorb, GitRegistry, type AbsorbDeps } from '../supervisor/share.js';
// P1e：晋升门禁判定（kernel 纯函数，layer 2 → 2 ✓）+ 晋升执行/回滚契约（supervisor 层 1）+ 基准回放对照
import { resolvePromotionGate, shouldPromoteToStable } from '../kernel/promotion-gate.js';
import {
  promoteToStable,
  readShadowSignals,
  SHADOW_LOG_REL,
} from '../supervisor/promotion.js';
import {
  loadBenchContractsV2,
  loadBenchFixturesV2,
  makeReplayExecutorV2,
  runBenchV2,
} from '../supervisor/bench-v2.js';
// S1：基准明细目录（WorldModel bench 状态查询——最近 real/replay 报告存在性）
import { BENCH_REPORTS_DIR } from '../supervisor/bench.js';
// P2：组件注册表装配（实现落 supervisor 层 1——runtime(2) 持有注册表，层 DAG 禁 runtime → components，
// tests/m0/dag-lint.test.ts 钉住；components/registry.ts 为 ABI 出口）+ 能力注册表衔接 + kern_status 数据源
import { ComponentRegistry, type ComponentHealthResult, type ComponentManifest } from '../supervisor/component-registry.js';
import { CapabilityRegistry } from '../supervisor/capability.js';
import { memoryRetrievalComponent } from '../memory/memory-retrieval.js';
import type { KernStatusSummary } from './kern-tools.js';
// S1：World/Self 模型运行接线——运行时状态视图 → 模型组装（纯读取、确定性）
import { degradationLog } from './loop-hooks.js';
import { buildSelfModel, buildWorldModel, type RuntimeView } from './models.js';

/** 仓库根候选（本文件 src 布局在 <preset>/runtime/ → 上一级即 preset 根；编译布局 <preset>/lib/runtime/ → 多一层） */
const HERE_CANDIDATE = fileURLToPath(new URL('..', import.meta.url));
/** 仓库根：存在性回退（src 布局 HERE_CANDIDATE 即根；编译布局其下无 kernel/policy → 取上级） */
const HERE = existsSync(join(HERE_CANDIDATE, 'kernel', 'policy')) ? HERE_CANDIDATE : dirname(HERE_CANDIDATE);

/** S1：插件（preset）版本——package.json 读取（只读；不可读 → 'unknown' 诚实回退，不臆造） */
function readPluginVersion(): string {
  try {
    const raw = readFileSync(join(HERE, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' && parsed.version.length > 0 ? parsed.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** RuntimeSnapshot.id（sha256:<64hex>）→ 运行时快照哈希字符串（rs:<前16hex>，D1⑤ 格式） */
function runtimeHashOf(snapshot: RuntimeSnapshot): string {
  return `rs:${snapshot.id.slice('sha256:'.length, 'sha256:'.length + 16)}`;
}

/** 全降级占位组件（64-hex 合法；仅结构完整供 registry 构造，不参与生效哈希） */
const DEGRADED_COMPONENTS: ComponentHashes = {
  scheduler: '00'.repeat(32),
  memory: '00'.repeat(32),
  verifier: '00'.repeat(32),
  renderer: '00'.repeat(32),
  capability: '00'.repeat(32),
  philosophy: '00'.repeat(32),
};

function errorDetail(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * R8：本地发布签名（`git:<signer>:<keyid-hex>:<base64>` 格式，过 share.ts 签名格式门）。
 * keyid 由宿主版本 + 平台派生（本地身份标记，同宿主稳定）；签名体 = `omb-local:<object_id>`
 * （同对象确定性——publish 幂等/去重友好）。真实 Git 签名（git tag -s / verify-tag）留外部 signer，
 * 本地发布以格式门 + 内容寻址（id=sha256(canonical(body))）保证完整性。
 */
function localPublishSignature(objectId: string): string {
  const keyid = `${hostVersion()}${process.platform}`
    .replace(/[^0-9a-f]/gi, '')
    .padEnd(16, '0')
    .slice(0, 16);
  return `git:omb:${keyid}:${Buffer.from(`omb-local:${objectId}`, 'utf8').toString('base64')}`;
}

/**
 * R8：机制级对象判定（隐私原则：集体共享仅发布/吸收**机制数据**，绝不发布私人记忆/会话内容）。
 * 机制来源 = provenance.source 以 'evolution/' 开头（candidate-pipeline buildEvolutionObject 产出），
 * 且 diff 非空（携带机制变更内容）；其余来源（memory/experience/session 等）→ 拒绝。
 */
function mechanismOrigin(obj: { provenance: { source?: string }; diff?: string }): { ok: boolean; detail?: string } {
  const source = obj.provenance?.source ?? '';
  if (!source.startsWith('evolution/')) {
    return {
      ok: false,
      detail: `对象来源 "${source}" 非机制级——集体共享仅发布/吸收 evolution/* 来源的机制数据（不发布私人记忆/会话内容，隐私原则）`,
    };
  }
  if (typeof obj.diff !== 'string' || obj.diff.length === 0) {
    return { ok: false, detail: '对象 diff 为空——机制级对象必须携带机制变更内容（diff）' };
  }
  return { ok: true };
}

/**
 * P2：组件 manifest 声明的能力 → 能力注册表（supervisor/capability.ts 语义复用：重复 id fail-loud、
 * 同层同名冲突 fail-loud；异层同名允许——分级基础，§8.1）。组件能力默认 authority_scope='kernel'
 *（组件机制归内核底座）、reliability='high'；软接管/路由留既有 Broker（M6 库级）不动。返回登记数。
 */
export function registerComponentCapabilities(
  capabilityRegistry: CapabilityRegistry,
  manifest: Pick<ComponentManifest, 'manifest_id' | 'capabilities'>,
): number {
  const names = manifest.capabilities ?? [];
  for (const name of names) {
    capabilityRegistry.register({
      id: `capability:${manifest.manifest_id}:${name}`,
      name,
      authority_scope: 'kernel',
      reliability: 'high',
    });
  }
  return names.length;
}

/** 回退路径 git HEAD（既有实现：defaultLayout().bareRepo rev-parse HEAD）；失败 → 抛错（调用方全降级） */
function gitHeadOfDefaultLayout(): string {
  return execFileSync(GIT_BIN, ['rev-parse', 'HEAD'], {
    cwd: defaultLayout().bareRepo,
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
}

/**
 * P1b：快照身份构建（提交级运行时快照，D1⑤：请求运行于「线 stable + commit a81f + 快照 rs:7c91」）。
 * 哈希输入 = 当前版本线 commit（lines 指针 commit，P1a lineSnapshot.commit）+ 实际生效目录内容哈希
 * （policy/processes 文件内容——P1a 注入目录；未注入（回退 repo 默认）则 repo 目录内容）+ 六组件内容哈希。
 * 确定性：同线同 commit 同内容 → 同哈希；不同线 commit → 不同哈希（测试钉住）。
 * 失败降级：lines 不可用时回退既有实现（git HEAD + 内容哈希）；任一步失败 → 抛错（调用方降级 'rs:assembly'，不崩）。
 */
function buildSnapshotIdentity(dirs: LineDirResolution, presetRoot: string): RuntimeSnapshot {
  const dirContentHash = computeDirContentHash(dirs.policyDir, dirs.processesDir);
  const components = computeComponentHashes(presetRoot);
  // 线 commit（lines 指针；P1a 注入目录自然覆盖）→ 哈希 gitRevision；未注入（回退 repo 默认）→ 既有 git HEAD
  const gitRevision = dirs.lineSnapshot !== null ? dirs.lineSnapshot.commit : gitHeadOfDefaultLayout();
  const lineInput: LineHashInput | undefined =
    dirs.lineSnapshot !== null
      ? { line: dirs.lineSnapshot.line, commit: dirs.lineSnapshot.commit, dirContentHash }
      : undefined;
  return createSnapshot({ components, gitRevision, line: lineInput });
}

export interface CognitiveAssemblyOptions {
  /** 用户态目录（缺省 workspace/.omb，架构 §3；memory.db/events.db 落此） */
  root?: string;
  memoryDb?: string;
  eventDb?: string;
  policyDir?: string;
  processesDir?: string;
  /** P1a：当前版本线（缺省 stable，架构 §11.1）——按线加载 policy/processes（lines/ 物化快照注入）；
   *  非法值 → 回退 stable；显式提供 policyDir/processesDir 时忽略（显式目录注入优先）。 */
  line?: VersionLine;
  /** P1a：lines 布局覆盖（测试注入 fixture；缺省真实 preset 布局 defaultLayout()） */
  layout?: VersionLayout;
  /** Governor 输入 state_snapshot（缺省 'rs:assembly'） */
  snapshotHash?: string;
  /** T8.12：ModelAdapter（DSH 模型调用适配器）——组合根经 deps 注入；未注入 → 缺省受限（纯规则阶梯） */
  modelAdapter?: ModelAdapter;
  /** T8.26.2：checkpoint 目录（finalizeTurn 保存 / prepareTurn 恢复；缺省不接） */
  checkpointDir?: string;
  /** T8.26.2：维护调度器（finalizeTurn 信号聚合入队；缺省不接） */
  maintenance?: MaintenanceScheduler;
  /** P1c：演化信号落盘目录（缺省 <root>/.evolution/signals；finalizeTurn 收尾写入 + 演化判定读取） */
  signalsDir?: string;
  /** P1d：演化工作区根（CandidatePool 信任池；缺省 <root>/.evolution） */
  evolutionRoot?: string;
  /** P7：环境指纹采集器注入（environment_check 任务用；缺省 collectEnvironmentFingerprint——测试注入可变序列） */
  environmentFingerprint?: () => Fingerprint;
  /** S1：基准明细目录（WorldModel bench 状态——最近 real/replay 报告存在性；缺省 BENCH_REPORTS_DIR =
   *  <preset>/workspace/.omb/bench；测试注入临时目录隔离真实 workspace） */
  benchReportsDir?: string;
  /** R6：宿主 DSH 版本唯一来源注入（可选；提供 → setHostVersion 覆写——运行时指纹采集与
   *  事件 provenance 的 dsh_version 全部经 hostVersion() 读取同一值；缺省 DSH_HOST_VERSION） */
  hostVersion?: string;
}

/** 请求（最小链输入）：会话事实 + 任务契约 + 工作状态 */
export interface CognitiveRequest {
  session_id: string;
  goal: string;
  success_criteria: string[];
  constraints?: string[];
  working_state: PromptWorkingState;
  environment?: string;
  /** 证据充分性覆盖（缺省：缺口=[goal] → 查决策表而非短路 Stop） */
  evidence_sufficiency?: { covered_success_conditions: string[]; critical_gaps: string[]; score: number };
}

/** 请求处理结果（决策 + 检索 + prompt + 入链事件数） */
export interface CognitiveResponse {
  decision: GovernorDecision;
  retrieval: { items: RankedMemory[]; channel_used: string };
  prompt: BuiltPrompt;
  events_appended: number;
}

/** prepareTurn 结果（T8.26.2 §3.1）：快照 + 工作状态 + 决策 + 检索 + 投影 + 入链事件数 */
export interface PreparedTurn {
  snapshot: string;
  working_state: PromptWorkingState;
  decision: GovernorDecision;
  retrieval: { items: RankedMemory[]; channel_used: string };
  projection: ContextProjection;
  events_appended: number;
}

/** prepareTurn 选项：上下文注入接收器（T8.26.3：DSH systemPrompt.context 钩子；提供 → 注入并记 context/injected） */
export interface PrepareTurnOptions {
  inject?: (projection: ContextProjection) => void | Promise<void>;
}

/** observeEvent 结果（T8.26.2 §3.2）：事件 + 追加状态 + 归约 State/投影 + 降级原因 */
export interface ObserveEventResult {
  event: Event;
  appended: boolean;
  state: ReducedState | null;
  projections: Projections | null;
  degraded: string | null;
}

/** finalizeTurn 输入（T8.26.2 §3.3） */
export interface FinalizeTurnInput {
  session_id: string;
  decision: GovernorDecision;
  working_state: PromptWorkingState;
  /** 供 checkpoint 保存的 schema 合规 State（T1.5 契约；缺省不保存） */
  state?: State;
}

/** finalizeTurn 结果（T8.26.2 §3.3）：decision/made + Experience 候选 + 信号 + checkpoint + maintenance */
export interface FinalizeTurnResult {
  decision_event_id: string;
  experience: Experience | null;
  /** R4（P0）：Experience Admission 结果（experience → staging；准入规则/量级守卫的逐条裁决） */
  experience_admission: { staged: number; skipped: { id: string; reason: string }[] };
  signals: UtilityCounts;
  signals_degraded: string | null;
  /** P1c：演化信号落盘结果（.evolution/signals/<yyyy-mm-dd>.jsonl；尽力而为——失败降级不阻塞收尾） */
  signals_log: { files: string[]; appended: number; degraded: string | null };
  maintenance: { enqueued: boolean; debt: MaintenanceDebt[] };
  checkpoint: Checkpoint | null;
  events_appended: number;
}

/** P1d：晋升摘要（首个通过者晋升；object/commit 供 /evolve 文本与事件引用） */
export interface PromotedInfo {
  candidate_id: string;
  object_id: string;
  commit_hash: string;
}

/** P1e：晋升检查结果（promotion_check 维护任务与 /evolve 共用；stable ← trusted-latest 显式门禁） */
export interface PromotionCheckInfo {
  /** 是否执行了检查（false = 跳过——旧布局/线指针不可用/stable 已最新） */
  checked: boolean;
  /** 跳过原因（checked=false 时非空；记录——生产降级可审计） */
  skipped_reason: string | null;
  /** 门禁判定结果（kernel 纯函数 shouldPromoteToStable） */
  gate_ok: boolean;
  /** 三层信号 reasons（L1 硬门/L2 统计/L3 旁证占位；可审计） */
  reasons: string[];
  /** 是否已执行 promoteToStable 并成功推进 stable */
  promoted: boolean;
  /** 激活幂等键（promoted=true 时提供） */
  activation_id?: string;
  /** 切换后 stable commit（promoted=true 时提供） */
  stable_commit?: string;
  /** 失败/异常（门禁通过但执行失败；可读） */
  error?: string;
  /** 非致命告警（如事件入链失败——stable 切换与契约已生效） */
  warning?: string;
  /** 本次检查入链事件数（activation/committed + evolution/promoted；promoted=true 时 = 2） */
  events_appended: number;
}

/** P1c/P1d：/evolve now 与空闲期演化判定的摘要（判定结果/候选管线/入队任务/debt 快照/quantum 执行） */
export interface EvolutionNowResult {
  decision: EvolutionDecision;
  /** 判定后入队的维护任务 id（应演化 → candidate_validation） */
  enqueued: string[];
  /** P1d：本次候选管线产物（生成 → 验证 → 晋升逐候选 outcome；应演化且新布局时非空） */
  candidates: CandidateOutcome[];
  /** P1d：首个通过并晋升的候选（无晋升 → null） */
  promoted: PromotedInfo | null;
  /** P1e：晋升检查结果（stable ← trusted-latest 显式门禁；独立于演化判定——待晋升即判） */
  promotion: PromotionCheckInfo;
  /** 本次执行的维护量子报告 */
  quantum: QuantumReport;
  /** debt 快照（quantum 执行后） */
  debt: MaintenanceDebt[];
  /** 判定/执行降级原因（无 → null） */
  degraded: string | null;
  /** 入链事件数（evolution/candidate 判定+生成 + evolution/promoted + activation/committed + maintenance/quantum） */
  events_appended: number;
}

/** R8：/evolve share / /evolve absorb 结果（发布/吸收机制级 Evolution Object；ok:false = 明确 error 文本，不崩） */
export interface ShareCommandResult {
  ok: boolean;
  /** 用户可见文本（成功摘要或明确 error 文本） */
  text: string;
  /** 发布/吸收的 Evolution Object id（无对象/失败 → undefined） */
  object_id?: string;
  /** 本地 registry 目录（实际生效路径） */
  registry_dir?: string;
  /** 本次入链事件数（evolution/shared 或 evolution/absorbed；失败 → 0） */
  events_appended: number;
}

/** P1a：已注入的线快照信息（lines 物化快照；未注入 → null） */
export interface LineSnapshotInfo {
  line: VersionLine;
  commit: string;
  dir: string;
}

/** R5：repair 任务结果（受影响对象重验证审计；落盘 .evolution/repair/<ts>.json） */
export interface RepairRecord {
  /** 本次重验证时间戳（epoch ms） */
  ts: number;
  task: 'repair';
  /** 本次扫描的 decay 记录数 */
  decay_records: number;
  /** 去重后的受影响对象（全部 decay 记录合并） */
  affected_objects: ArtifactRef[];
  /** 确认存在并记录重验证的对象 */
  reverified: ArtifactRef[];
  /** 引用对象已删除（无可修，跳过留痕） */
  missing: ArtifactRef[];
}

/** 按线解析结果（policy/processes 目录 + 快照信息 + 降级原因） */
interface LineDirResolution {
  policyDir: string;
  processesDir: string;
  lineSnapshot: LineSnapshotInfo | null;
  lineDegraded: string | null;
}

/**
 * P1a：按线解析 policy/processes 目录（D1 裁决：运行时按当前版本线从 lines 物化快照加载）。
 * 最佳努力（装配失败不崩）：线快照存在 kernel/policy + kernel/processes → 注入线快照路径；
 * 缺失（旧布局种子无 policy）/ lines 不可用 → 回退仓库默认目录 + 降级原因（不抛）。
 * 显式提供 policyDir/processesDir → 显式目录优先（测试/兼容注入，不走按线加载）。
 */
function resolveLineDirs(opts: CognitiveAssemblyOptions, line: VersionLine): LineDirResolution {
  const defaultPolicyDir = join(HERE, 'kernel', 'policy');
  const defaultProcessesDir = join(HERE, 'kernel', 'processes');
  if (opts.policyDir !== undefined || opts.processesDir !== undefined) {
    return {
      policyDir: opts.policyDir ?? defaultPolicyDir,
      processesDir: opts.processesDir ?? defaultProcessesDir,
      lineSnapshot: null,
      lineDegraded: null,
    };
  }
  try {
    const snap = ensureLineSnapshot(opts.layout ?? defaultLayout(), line);
    const snapPolicyDir = join(snap.dir, 'kernel', 'policy');
    const snapProcessesDir = join(snap.dir, 'kernel', 'processes');
    if (existsSync(snapPolicyDir) && existsSync(snapProcessesDir)) {
      return {
        policyDir: snapPolicyDir,
        processesDir: snapProcessesDir,
        lineSnapshot: { line, commit: snap.commit, dir: snap.dir },
        lineDegraded: null,
      };
    }
    return {
      policyDir: defaultPolicyDir,
      processesDir: defaultProcessesDir,
      lineSnapshot: null,
      lineDegraded: `版本线 ${line} 快照缺少 kernel/policy 或 kernel/processes（${snap.dir}）——回退仓库默认策略/过程`,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      policyDir: defaultPolicyDir,
      processesDir: defaultProcessesDir,
      lineSnapshot: null,
      lineDegraded: `lines 按线加载不可用（${detail}）——回退仓库默认策略/过程`,
    };
  }
}

/** 认知运行时（装配产物；plugin.ts 的 CognitiveRuntimeLike 结构上满足） */
export class CognitiveRuntime {
  readonly eventStore: EventStore;
  readonly memory: RetrievalBackend;
  /** R4（P0）：记忆 staging 管理器（同一 memory.db；Experience Admission 与 consolidation 共用） */
  readonly staging: StagingManager;
  /**
   * P1b：当前（最新）运行时快照哈希（rs:<16hex>；opts.snapshotHash 覆盖注入；全降级 → 'rs:assembly'）。
   * getter 语义：promote（/mode 切换 / rebuildSnapshotForLine）后反映新快照——事件 provenance 用最新快照；
   * 请求级锁定见 prepareTurn（§6.5.7：请求开始解析快照，整个请求只读该快照，晋升只影响后续请求）。
   */
  get snapshotHash(): string {
    if (this.snapshotOverride !== null) {
      return this.snapshotOverride;
    }
    if (this.degraded) {
      return 'rs:assembly';
    }
    return runtimeHashOf(this.registry.currentSnapshot);
  }
  /** T8.12：注入的 ModelAdapter（无真实 DSH 会话 → null，LLM 路径缺省受限） */
  readonly modelAdapter: ModelAdapter | null;
  /** P1b：生效 policy/processes 目录（线快照注入或仓库默认）；rebuildSnapshotForLine 成功后切换（下一请求生效） */
  policyDir: string;
  processesDir: string;
  /** P1b：已注入的线快照（按线加载成功 → 快照信息；否则 null）；rebuildSnapshotForLine 成功后切换 */
  lineSnapshot: LineSnapshotInfo | null;
  /** P1b：lines 按线加载降级原因（线快照缺 policy / lines 不可用 → 回退仓库默认；无降级 → null） */
  lineDegraded: string | null;
  private readonly checkpointDir: string | undefined;
  /** 维护调度器（生产装配注入；插件经此在请求间隙驱动 requestQuantum/停表——公开面） */
  readonly maintenance: MaintenanceScheduler | null;
  /** P1c：演化信号落盘目录（<root>/.evolution/signals；finalizeTurn 写入 / 演化判定读取） */
  readonly signalsDir: string;
  /** P1d：演化工作区根（CandidatePool 信任池 <root>/.evolution；候选管线注册/晋升/拒绝） */
  readonly evolutionRoot: string;
  private policyPromise: Promise<PolicyBundle> | null = null;
  private processesPromise: Promise<readonly ProcessDef[]> | null = null;
  /** P1b：请求级快照注册表（装配期创建；prepareTurn 绑定 / finalizeTurn 释放 / promote 切换，§6.5.7） */
  private readonly registry: SnapshotRegistry;
  /** P1b：装配选项（rebuildSnapshotForLine 重新解析新线目录用） */
  private readonly assemblyOpts: CognitiveAssemblyOptions;
  /** P1b：snapshotHash 覆盖注入（opts.snapshotHash；兼容既有注入面——provenance 常量，registry 结构照常） */
  private readonly snapshotOverride: string | null;
  /** P1b：快照身份构建全降级（既有契约 'rs:assembly'；装配不因快照计算失败中断） */
  private degraded = false;
  private identityError: string | null = null;
  /** P2：组件注册表（装配期注册 memory-retrieval；ready()/componentsReady() 激活 + health check；close() 批量 dispose 回滚） */
  readonly components: ComponentRegistry;
  /** P2：能力注册表（组件 manifest 声明的能力登记——注册/冲突 fail-loud，capability.ts 语义复用；软接管留 Broker） */
  readonly capabilities: CapabilityRegistry;
  /** P2：组件激活幂等（首次 componentsReady() 执行，后续复用） */
  private componentsReadyPromise: Promise<void> | null = null;
  /** P2：组件装配降级原因（激活失败/健康检查异常；无 → null）——kern_status 摘要 degraded 段 */
  private componentAssemblyDegraded: string | null = null;
  /** P7：环境指纹采集器（environment_check 任务；测试注入可变序列） */
  private readonly fingerprintCollector: () => Fingerprint;
  /** P7：最近一次环境指纹（Predictive Invalidation 基线；进程内缓存，跨重启由 decay 落盘接续） */
  private lastEnvironmentFingerprint: Fingerprint | null = null;
  /** P7：能力衰减记录落盘目录（<evolutionRoot>/decay；<ts>.json） */
  private readonly decayDir: string;
  /** R5：repair 重验证记录落盘目录（<evolutionRoot>/repair；<ts>.json——受影响对象重验证审计） */
  private readonly repairDir: string;
  /** S1：World/Self 模型缓存（视图 + 模型——首次访问装配，promote/rebuildSnapshotForLine 后重置；
   *  同 runtime 状态 → 同视图 → 同模型内容（确定性）；装配为纯读取无副作用） */
  private modelCache: { view: RuntimeView; world: WorldModel; self: SelfModel } | null = null;

  constructor(opts: CognitiveAssemblyOptions = {}) {
    // R6：宿主版本唯一来源注入（装配期；提供 → setHostVersion 覆写——运行时指纹采集与事件
    // provenance 的 dsh_version 全部经 hostVersion() 读取同一值；缺省 DSH_HOST_VERSION）
    if (opts.hostVersion !== undefined) {
      setHostVersion(opts.hostVersion);
    }
    const root = opts.root ?? join(HERE, 'workspace', '.omb');
    this.eventStore = new EventStore(opts.eventDb ?? join(root, 'events.db'));
    this.memory = new RetrievalBackend(opts.memoryDb ?? join(root, 'memory.db'));
    // R4（P0）：staging 与 memory 同库（单写者语义：stage/admit/consolidate 各自事务内顺序写；
    // WAL + busy_timeout 兜底并发）。close() 幂等收尾先关。
    this.staging = new StagingManager(opts.memoryDb ?? join(root, 'memory.db'));
    // P2：组件注册表装配——注册首个机制组件 memory-retrieval（manifest/inject/effect/disposer/health 契约，
    // ABI 出口 components/registry.ts，实现 supervisor/component-registry.ts）→ 组件能力登记进能力注册表
    //（冲突 fail-loud——同层同名注册是真实装配冲突，最早点报错（平台约束 fails loud））。
    this.components = new ComponentRegistry();
    this.components.register(memoryRetrievalComponent, { memory: this.memory });
    this.capabilities = new CapabilityRegistry();
    for (const m of this.components.manifests()) {
      registerComponentCapabilities(this.capabilities, m);
    }
    const line = isVersionLine(opts.line) ? opts.line : 'stable';
    const dirs = resolveLineDirs(opts, line);
    this.policyDir = dirs.policyDir;
    this.processesDir = dirs.processesDir;
    this.lineSnapshot = dirs.lineSnapshot;
    this.lineDegraded = dirs.lineDegraded;
    // P1b：装配期初始快照 = 当前版本线 commit + 实际生效目录内容 + 组件哈希（lines 不可用 → 回退既有实现）；
    // 快照计算失败 → 全降级 'rs:assembly'（registry 以确定性占位快照构造，结构完整不炸）
    this.assemblyOpts = opts;
    this.snapshotOverride = opts.snapshotHash ?? null;
    try {
      const identity = buildSnapshotIdentity(dirs, HERE);
      this.registry = new SnapshotRegistry(identity);
      this.degraded = false;
    } catch (err) {
      this.registry = new SnapshotRegistry(
        createSnapshot({ components: DEGRADED_COMPONENTS, gitRevision: 'degraded' }),
      );
      this.degraded = true;
      this.identityError = errorDetail(err);
    }
    this.modelAdapter = opts.modelAdapter ?? null;
    this.checkpointDir = opts.checkpointDir;
    this.maintenance = opts.maintenance ?? null;
    this.signalsDir = opts.signalsDir ?? signalsDirOf(root);
    this.evolutionRoot = opts.evolutionRoot ?? join(root, '.evolution');
    // P7：环境指纹（Predictive Invalidation）装配——采集器注入（缺省运行时采集）+ 衰减记录落盘目录
    this.fingerprintCollector = opts.environmentFingerprint ?? (() => collectEnvironmentFingerprint());
    this.decayDir = join(this.evolutionRoot, 'decay');
    // R5：repair 重验证记录落盘目录（受影响对象重验证审计；与 decay 同根）
    this.repairDir = join(this.evolutionRoot, 'repair');
  }

  /** 装配就绪（策略/过程懒加载——机制即数据，改 YAML 即生效；P2：组件激活 + health check）；幂等 */
  async ready(): Promise<{ policy: PolicyBundle; processes: readonly ProcessDef[] }> {
    this.policyPromise ??= loadPolicy(this.policyDir);
    this.processesPromise ??= loadProcesses(this.processesDir);
    await this.componentsReady(); // P2：组件激活 + 健康检查（幂等；失败降级不阻塞请求路径）
    return { policy: await this.policyPromise, processes: await this.processesPromise };
  }

  /**
   * P5：生产路径 Generator 装配（架构 §5.3 Generate 阶梯生产接线）——ProcessScheduler 经组合根注入
   * ModelAdapter（触发条件③）+ generation 预算（触发条件②，policy.budget.generation 数据化）→
   * 阶梯 Reuse→Compose→Mutate 均不满足（OOD）且预算允许且 adapter 存在时才走 LLM；缺任一 → 纯规则降级。
   * 真实会话才有模型（plugin.ts 装配 modelAdapter）；真实模型调用留宿主验证——测试用 fake adapter 验证触发逻辑。
   * 每次调用构造新调度器/生成器 → generator 的 generationUsed 计数器即单请求语义（max_generate_per_request）。
   */
  async createScheduler(processes: readonly ProcessDef[]): Promise<ProcessScheduler> {
    const { policy } = await this.ready();
    return new ProcessScheduler({
      processes,
      generation: policy.budget.generation,
      modelAdapter: this.modelAdapter ?? undefined,
    });
  }

  /**
   * P2：组件激活 + 健康检查（幂等——首次调用执行，后续复用结果）。
   * 激活失败 → registry 已批量 dispose 回滚（T8.6：不暴露任何 effect）→ 记录降级（认知运行时其余功能照常）；
   * health 失败 → registry 内打 suspicious（降级不卸载，§主14.6）。不抛。
   */
  async componentsReady(): Promise<void> {
    this.componentsReadyPromise ??= this.activateComponents();
    await this.componentsReadyPromise;
  }

  /** P2：周期心跳入口（设计 §8.2 health check 周期心跳）——返回逐组件健康报告；失败 → suspicious 降级不卸载 */
  async healthCheckComponents(): Promise<Record<string, ComponentHealthResult>> {
    await this.componentsReady();
    return this.components.healthCheck();
  }

  /**
   * P2：kern_status 数据源——认知运行时状态摘要（纯读取：从现有字段组装；任一段降级 → 降级字段非空不抛）。
   * 字段：当前版本线/快照哈希/lineSnapshot/维护债务快照/最近信号数/组件健康（design §6 kern_status）。
   */
  async status(): Promise<KernStatusSummary> {
    await this.componentsReady();
    let recent_signals = 0;
    let signals_degraded: string | null = null;
    try {
      const { records } = await readSignals(this.signalsDir);
      recent_signals = records.length;
    } catch (err) {
      signals_degraded = errorDetail(err);
    }
    const entries = this.components.list();
    return {
      line: this.lineSnapshot?.line ?? 'stable',
      snapshot_hash: this.snapshotHash,
      line_snapshot: this.lineSnapshot
        ? { line: this.lineSnapshot.line, commit: this.lineSnapshot.commit, dir: this.lineSnapshot.dir }
        : null,
      line_degraded: this.lineDegraded,
      debt: this.maintenance?.debtSnapshot() ?? [],
      recent_signals,
      signals_degraded,
      components: {
        registered: entries.map((e) => e.manifest_id),
        // suspicious 组件仍处于激活态（降级不卸载）→ 计入 active
        active: entries.filter((e) => e.status === 'active' || e.status === 'suspicious').map((e) => e.manifest_id),
        suspicious: entries.filter((e) => e.status === 'suspicious').map((e) => e.manifest_id),
        health: entries.map((e) => ({ manifest_id: e.manifest_id, ok: e.healthy === true, detail: e.health_detail ?? '' })),
      },
      degraded: this.degraded
        ? `快照机制降级（${this.identityError ?? 'rs:assembly'}）`
        : this.componentAssemblyDegraded,
    };
  }

  /**
   * S1：WorldModel（S4）——当前项目架构/依赖/运行时/外部状态（架构 §4.6.1）。
   * 装配期从 runtime 真实状态组装（纯读取、确定性：同 runtime 状态 → 同模型内容）；
   * 首次访问装配并缓存；promote/rebuildSnapshotForLine 后重置（反映新快照/新线）。
   */
  get worldModel(): WorldModel {
    return this.models().world;
  }

  /** S1：SelfModel（S4）——当前能力/已知限制/可靠策略/盲点（确定性同 worldModel） */
  get selfModel(): SelfModel {
    return this.models().self;
  }

  /**
   * S1：State.world/self 引用填充（reduce 产出 State 后 null → 模型引用——s.ts StateSchema 仅允许
   * 引用字符串，故组装模型后登记为引用 id）。StateSchema 校验：合规路径返回 parsed（fail-loud 于
   * 接线自身违规）；事件流直归约的 working 缺省字段（如 next_best_action=''——既有诚实空语义，P7）
   * 非 S1 接线缺陷 → 返回填充后的 state（checkpoint 契约层不机械校验内嵌 state，T1.5 契约）。
   */
  materializeState(reduced: ReducedState): State {
    const state: State = { ...reduced, world: this.worldModel.id, self: this.selfModel.id };
    const parsed = StateSchema.safeParse(state);
    return parsed.success ? parsed.data : state;
  }

  /** S1：模型视图/模型缓存（首次访问装配；promote/rebuild 后重置） */
  private models(): { view: RuntimeView; world: WorldModel; self: SelfModel } {
    if (this.modelCache === null) {
      const view = this.assembleModelView();
      this.modelCache = { view, world: buildWorldModel(view), self: buildSelfModel(view) };
    }
    return this.modelCache;
  }

  /**
   * S1：运行时状态视图装配（纯读取、同步、确定性：同 runtime 状态 → 同视图 → 同模型内容）。
   * 数据源全部为 runtime 现有字段/只读读取（capabilities/components/lineSnapshot/snapshotHash/
   * 降级记录/环境指纹/基准报告存在性/node:os 资源），无副作用。
   */
  private assembleModelView(): RuntimeView {
    const line = this.lineSnapshot?.line ?? 'stable';
    const layoutState = this.lineSnapshot !== null ? 'lines-injected' : 'repo-default';
    let real = 0;
    let replay = 0;
    try {
      const names = readdirSync(this.assemblyOpts.benchReportsDir ?? BENCH_REPORTS_DIR);
      real = names.filter((n) => n.startsWith('real-')).length;
      replay = names.filter((n) => n.startsWith('replay-')).length;
    } catch {
      // 目录缺失/不可读 → 0（诚实：无报告）
    }
    return {
      assembledAt: new Date().toISOString(),
      snapshotHash: this.snapshotHash,
      line,
      commit: this.lineSnapshot?.commit ?? null,
      lineSnapshot: this.lineSnapshot,
      lineDegraded: this.lineDegraded,
      snapshotDegraded: this.degraded ? (this.identityError ?? 'rs:assembly') : null,
      componentDegraded: this.componentAssemblyDegraded,
      capabilities: this.capabilities.list(),
      components: this.components.list().map((c) => ({
        manifest_id: c.manifest_id,
        status: c.status,
        healthy: c.healthy,
        health_detail: c.health_detail,
      })),
      degradations: degradationLog(),
      hostVersion: hostVersion(),
      pluginVersion: readPluginVersion(),
      environmentFingerprint: this.fingerprintCollector(),
      resources: {
        memory_mb: Math.round(totalmem() / 1024 / 1024),
        cpus: cpus().length,
        detail: '系统级实测（node:os）——运行时预算见 policy.budget（请求级）',
      },
      bench: { recent_real_reports: real, recent_replay_reports: replay },
      layoutState,
      modelAdapterAvailable: this.modelAdapter !== null,
      maintenanceAvailable: this.maintenance !== null,
      checkpointAvailable: this.checkpointDir !== undefined,
    };
  }

  /**
   * prepareTurn（§3.1）：turn 开始认知准备——快照/工作状态/Governor 决策（准备级）/（R3）Governor→Scheduler→
   * Process 调度（选定/生成过程 → decision 载荷 + Working State 过程引用 + Context Projection「认知过程」section）/
   * 分层检索/ContextCompiler 投影编译；（提供注入接收器时）注入 + context/injected 入链（Model-visible ⟺ logged）。
   */
  async prepareTurn(req: CognitiveRequest, opts: PrepareTurnOptions = {}): Promise<PreparedTurn> {
    const { policy, processes } = await this.ready();
    // P1b：请求开始解析快照（未绑定 → 绑定当前快照，整个请求锁定 §6.5.7；晋升只影响后续请求）
    const snapshot = this.resolveRuntimeSnapshot(req.session_id);
    const working_state = await this.loadWorkingState(req);
    const decision = decide(this.buildGovernorInput(req, processes, policy, snapshot), policy.governor);
    // R3（P0）：Governor → Scheduler → Process 进入请求链（架构 §5.1/§4.6.1：Fast Governor + Rare Generator）。
    // 只做决策与投影——不驱动执行：不调用 operator executor、不循环调用模型（DSH 原生 Agent Loop 是唯一执行者）。
    // 调度结果并入 decision 载荷（decision/made 事件 payload 已由 finalizeTurn 记录 chosen/reason——不新增事件类型）；
    // 失败降级（scheduler 异常/无过程可选）→ decision.process.degraded 记录，不阻塞 prepareTurn 其余流程。
    const scheduled = await this.scheduleProcess(req, processes);
    decision.process = scheduled;
    if (scheduled.kind !== 'none' && scheduled.process_id !== null) {
      // 过程引用写入 Working State（next_best_action）：DSH Loop 的下一步 = 执行认知过程
      working_state.next_best_action = `认知过程 ${scheduled.process_id}（${scheduled.method}）`;
    }
    const retrieved = await retrieve(
      this.memory,
      { scope: 'Project', text: req.goal, limit: 3, budget: 1000 },
      { episode: false },
    );
    // R7：Context 候选来源扩展——全来源收集（Memory 检索 + Evidence 会话事件 + Capability 注册表 +
    // Process 调度结果；Artifact 缺省空——CognitiveRuntime 未装配 artifact-store，装配方注入后生效）；
    // ΔInfoValue 为来源侧启发式（§17 开放项，不实现动态估计）
    const projection = await buildContextProjection(
      policy,
      req,
      working_state,
      retrieved.items,
      toProcessSection(scheduled),
      { eventStore: this.eventStore, capabilities: this.capabilities, session_id: req.session_id },
    );

    let events_appended = 0;
    if (opts.inject !== undefined) {
      await opts.inject(projection);
      await this.eventStore.append(
        makeRuntimeEvent('context/injected', req.session_id, snapshot, {
          projection_id: projection.id,
          total_tokens: projection.total_tokens,
          views: [...new Set(projection.sections.map((s) => s.view))],
        }, ['prepareTurn']),
      );
      events_appended = 1;
    }

    return {
      snapshot,
      working_state,
      decision,
      retrieval: { items: retrieved.items, channel_used: retrieved.channel_used },
      projection,
      events_appended,
    };
  }

  /**
   * observeEvent（§3.2）：运行中事实入链——EventSchema 校验 → append（幂等）→ reducer 归约（
   * Observation → State；Contradiction 检测）→ 零成本信号。守卫：非法/重复/未注册类型 → 明确降级（不抛）。
   */
  async observeEvent(event: Event): Promise<ObserveEventResult> {
    const parsed = EventSchema.safeParse(event);
    if (!parsed.success) {
      return { event, appended: false, state: null, projections: null, degraded: `EventSchema: ${parsed.error.message}` };
    }
    const ev = parsed.data;
    let appended = true;
    try {
      await this.eventStore.append(ev);
    } catch (err) {
      if (err instanceof Error && err.message.includes('重复 id')) {
        appended = false; // 幂等：同一事件重复观测 → 不重复追加（§11.3 event_id 幂等键）
      } else {
        throw err; // 非重复类存储错误 fail-loud（非接口漂移场景）
      }
    }
    try {
      const sessionEvents = (await this.eventStore.query({ session_id: ev.session_id })).events;
      const { state, projections } = reduce(sessionEvents);
      return { event: ev, appended, state, projections, degraded: null };
    } catch (err) {
      // reducer 未注册类型/负载问题 → 事件已入链（事实源），归约明确降级
      return {
        event: ev,
        appended,
        state: null,
        projections: null,
        degraded: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * finalizeTurn（§3.3）：turn 收尾——decision/made 入链（reducer 兼容 payload）→ Experience 候选（PCR）→
   * 信号聚合（零成本 utility_counts）→ maintenance 入队（注入时）→ checkpoint 保存（dir + state 齐备时）。
   */
  async finalizeTurn(input: FinalizeTurnInput): Promise<FinalizeTurnResult> {
    // P1b：请求级快照锁定——已绑定（prepareTurn）→ 返回绑定快照（进行中请求不受 promote 影响）；未绑定 → 绑定当前
    const snapshot = this.resolveRuntimeSnapshot(input.session_id);
    const made = makeRuntimeEvent('decision/made', input.session_id, snapshot, {
      decision_id: makeMutableId('decision'),
      question: input.working_state.goal,
      chosen: input.decision.decision,
      reason: input.decision.reason,
    }, ['finalizeTurn']);
    await this.eventStore.append(made);

    const experience = buildExperienceCandidate(input.session_id, input.decision, input.working_state);

    // R4（P0）：Experience Admission——候选 → staging（准入规则 + 量级守卫；不直接写 memory——
    // 长期记忆经维护期 memory_consolidation 落库：staging → admit → consolidate → memory/relation）
    const experience_admission = await this.stageExperiences(
      experience === null ? [] : [experience],
      input.session_id,
    );

    const { signals, degraded } = await this.aggregateSignals(input.session_id);

    // P1c：演化信号落盘（.evolution/signals/<yyyy-mm-dd>.jsonl 追加；信号源① = finalizeTurn 聚合的
    // utility_counts、信号源② = L1 generalization 采集器输出面；尽力而为——失败降级不阻塞收尾）
    const signals_log = await this.persistTurnSignals(signals, input.session_id);

    let maintenance: { enqueued: boolean; debt: MaintenanceDebt[] } = { enqueued: false, debt: [] };
    if (this.maintenance !== null) {
      // 既有：会话级收尾任务（事件库 GC/compact；债务语义不变——仅失败/中断/跳过累计）
      await this.maintenance.enqueue({
        id: `turn-finalize:${input.session_id}`,
        value: 1,
        estimated_cost: 1,
        run: async () => {
          await this.eventStore.compact(Date.now());
        },
      });
      // P1c §10.1：信号 → 维护债务入账（权重 memory+2/candidate+8/repair+20/GC+1，按实际信号类型累计；
      // accrueDebt → 入队即累计 + 落盘；任务完成清偿归零）
      const turnTs = Date.now();
      const summary = summarizeSignals(
        countsToSignalRecords(signals as unknown as Record<string, number>, turnTs, input.session_id),
      );
      for (const acc of debtAccrualsFromSummary(summary)) {
        await this.maintenance.enqueue(
          {
            id: acc.task_id,
            value: acc.value,
            estimated_cost: acc.estimated_cost,
            priority: acc.priority,
            urgency: acc.urgency,
            run: this.maintenanceRun(acc.task_id, input.session_id),
          },
          { accrueDebt: true },
        );
      }
      // R4（P0）：经验已入 staging → memory_consolidation 债务入账（§10.1 同形状）——保证
      // 「经验 → 长期记忆」生产闭环在无 memory 信号时也可调度（空闲期量子执行 consolidation）
      if (experience_admission.staged > 0) {
        const acc = memoryConsolidationAccrual();
        await this.maintenance.enqueue(
          {
            id: acc.task_id,
            value: acc.value,
            estimated_cost: acc.estimated_cost,
            priority: acc.priority,
            urgency: acc.urgency,
            run: this.maintenanceRun(acc.task_id, input.session_id),
          },
          { accrueDebt: true },
        );
      }
      // P1c：演化判定任务（空闲期 quantum 执行；低优先级、可中断——读 signals → evolve.policy 判定 →
      // 应演化则入队 candidate_validation + evolution/candidate 事件入链）
      await this.maintenance.enqueue({
        id: 'evolution_decision',
        value: 1,
        estimated_cost: 2,
        priority: 0,
        urgency: 'normal',
        run: async (signal) => {
          await this.runEvolutionDecision(signal, input.session_id);
        },
      });
      // P1e：晋升检查任务（低优先级：读 trusted-latest vs stable → 三层信号门禁 → 应晋升则
      // promoteToStable（activation_scope='project' 显式传入）——空闲期 quantum 与 /evolve 共用）
      await this.maintenance.enqueue({
        id: 'promotion_check',
        value: 1,
        estimated_cost: 2,
        priority: 0,
        urgency: 'normal',
        run: this.maintenanceRun('promotion_check', input.session_id),
      });
      // P7：环境指纹检查任务（§14.5 Predictive Invalidation：指纹 diff → CapabilityDecayRecord 落盘
      // .evolution/decay/<ts>.json + 受影响对象重新验证入队（repair 债务）；低优先级 ROI 0.5——
      // 与会话收尾（ROI 1）并列排序时靠后，既有调度顺序不破坏）
      await this.maintenance.enqueue({
        id: 'environment_check',
        value: 1,
        estimated_cost: 2,
        priority: 0,
        urgency: 'normal',
        run: this.maintenanceRun('environment_check', input.session_id),
      });
      maintenance = { enqueued: true, debt: this.maintenance.debtSnapshot() };
    }

    let checkpoint: Checkpoint | null = null;
    if (this.checkpointDir !== undefined && input.state !== undefined) {
      checkpoint = await saveCheckpoint(input.state, { dir: this.checkpointDir, runtime_snapshot: snapshot });
    }

    // P1b：请求结束 → 释放快照绑定（未绑定请求 end 为空操作——cleanup 路径幂等安全）
    this.registry.end(input.session_id);

    return {
      decision_event_id: made.id,
      experience,
      experience_admission,
      signals,
      signals_degraded: degraded,
      signals_log,
      maintenance,
      checkpoint,
      events_appended: 1,
    };
  }

  /**
   * R4（P0）：Experience Admission（§5.2/§7.2）——experience → staging 写入（准入规则 + 量级守卫）。
   * finalizeTurn 调用面；测试/组件可复用。逐条裁决返回（staged/skipped+reason）。
   * 准入规则（复用 memory/staging 既有语义，§7.2 纯代码）：
   *   - 来源（无来源不入）：experienceToStageEvent 无 provenance → 不入 staging（no-provenance）；
   *   - 重复去重：同内容经验 → stage no-op（幂等键 = 内容哈希，admitted:false 'duplicate'）；
   *   - TTL/priority：stage 默认 TTL（DEFAULT_TTL_MS）+ EXPERIENCE_STAGE_PRIORITY；
   *   - 稳定/新信息/scope：consolidation 的 admit 阶段执行（本步只入 staging——不直接写 memory，
   *     不把全部 Experience 永久写入）。
   * 量级守卫：每 finalizeTurn 最多 staging MAX_EXPERIENCES_STAGED_PER_TURN 条（超出 → limit）。
   */
  async stageExperiences(
    experiences: readonly Experience[],
    sessionId: string,
  ): Promise<{ staged: number; skipped: { id: string; reason: string }[] }> {
    const snapshot = this.resolveRuntimeSnapshot(sessionId);
    const skipped: { id: string; reason: string }[] = [];
    let staged = 0;
    let remaining = MAX_EXPERIENCES_STAGED_PER_TURN;
    for (const exp of experiences) {
      if (remaining <= 0) {
        skipped.push({ id: exp.id, reason: 'limit' });
        continue;
      }
      const ev = experienceToStageEvent(exp, sessionId, snapshot);
      if (ev === null) {
        skipped.push({ id: exp.id, reason: 'no-provenance' });
        continue;
      }
      const r = await this.staging.stage(ev, { priority: EXPERIENCE_STAGE_PRIORITY });
      if (r.admitted) {
        staged++;
        remaining--;
      } else {
        skipped.push({ id: exp.id, reason: r.reason });
      }
    }
    return { staged, skipped };
  }

  /**
   * 最小请求处理链（T8.3 验收核心；T8.26.2 改为三能力组合，行为不变）：
   * prepareTurn（决策/检索/投影，无注入 → 0 事件）→ observeEvent(session/start 入链 + 归约) →
   * 单轮模拟（模型可见 prompt 组装）→ finalizeTurn（decision/made 入链）。
   */
  async handleRequest(req: CognitiveRequest): Promise<CognitiveResponse> {
    const prepared = await this.prepareTurn(req);
    await this.observeEvent(
      makeRuntimeEvent('session/start', req.session_id, prepared.snapshot, { goal: req.goal }, ['handleRequest']),
    );
    const prompt = buildPrompt({
      session_id: req.session_id,
      task_contract: {
        goal: req.goal,
        constraints: req.constraints ?? [],
        success_criteria: req.success_criteria,
      },
      working_state: prepared.working_state,
    });

    const finalized = await this.finalizeTurn({
      session_id: req.session_id,
      decision: prepared.decision,
      working_state: prepared.working_state,
    });

    return {
      decision: prepared.decision,
      retrieval: prepared.retrieval,
      prompt,
      events_appended: 1 + finalized.events_appended,
    };
  }

  /** 关闭存储连接（Windows WAL 收尾先 close；幂等）。P2：先组件批量 dispose 回滚（P8 注册皆效应）再关库。 */
  async close(): Promise<void> {
    await this.components.disposeAll();
    await this.eventStore.close();
    await this.staging.close();
    await this.memory.close();
  }

  /**
   * P1b：/mode 切换后重建运行时快照（D1⑤：下一请求生效）：
   * 新线物化（ensureLineSnapshot）→ 新线 commit + 目录内容 + 组件 → registry.promote
   * （进行中请求不受影响，§6.5.7）→ 切换 policy/processes 目录（线快照注入）+ 重置懒加载缓存（下一请求从新线加载）。
   * 失败降级：物化/解析失败 → 当前快照与目录保持，返回降级原因（切换状态仍生效，快照不变）。
   */
  rebuildSnapshotForLine(line: VersionLine): { promoted: boolean; degraded: string | null } {
    if (this.snapshotOverride !== null || this.degraded) {
      return {
        promoted: false,
        degraded: this.degraded
          ? `快照机制已降级（${this.identityError ?? 'rs:assembly'}）——切换后快照未重建`
          : '快照哈希被覆盖注入（opts.snapshotHash）——切换后快照未重建',
      };
    }
    let dirs: LineDirResolution;
    try {
      dirs = resolveLineDirs(this.assemblyOpts, line);
    } catch (err) {
      return { promoted: false, degraded: `新版本线 ${line} 解析失败（${errorDetail(err)}）——当前快照保持` };
    }
    if (dirs.lineSnapshot === null) {
      return { promoted: false, degraded: dirs.lineDegraded ?? `版本线 ${line} 快照未就绪——当前快照保持` };
    }
    try {
      this.registry.promote(buildSnapshotIdentity(dirs, HERE)); // promote 校验非法快照 fail-loud（registry 状态不被污染）
      // 下一请求生效：切换 policy/processes 目录（线快照注入）+ 重置懒加载缓存（ready() 从新线重载）
      this.policyDir = dirs.policyDir;
      this.processesDir = dirs.processesDir;
      this.lineSnapshot = dirs.lineSnapshot;
      this.lineDegraded = dirs.lineDegraded;
      this.policyPromise = null;
      this.processesPromise = null;
      this.modelCache = null; // S1：World/Self 模型反映新线（下一访问按新线/新快照重建）
      return { promoted: true, degraded: null };
    } catch (err) {
      return { promoted: false, degraded: `快照重建失败（${errorDetail(err)}）——当前快照保持` };
    }
  }

  /** P1b/P1e：外部晋升接口（构建好新快照后 promote → 下一请求生效；进行中请求不受影响，§6.5.7） */
  promoteSnapshot(next: RuntimeSnapshot): void {
    this.registry.promote(next);
    this.modelCache = null; // S1：World/Self 模型反映新快照（内容寻址重建）
  }

  // ---- 内部 ----

  /** P2：组件激活 + 健康检查执行体（componentsReady 单飞；任一步失败 → 记录降级不抛——registry 已内部回滚/标记） */
  private async activateComponents(): Promise<void> {
    try {
      await this.components.activate();
    } catch (err) {
      // 激活失败 → registry 已批量 dispose 回滚（T8.6：不暴露任何 effect）；记录降级，认知运行时其余功能照常
      this.componentAssemblyDegraded = `组件激活失败（${errorDetail(err)}）`;
    }
    try {
      await this.components.healthCheck(); // health 失败 → registry 内打 suspicious（降级不卸载）
    } catch (err) {
      this.componentAssemblyDegraded = `组件健康检查异常（${errorDetail(err)}）`;
    }
  }

  /** 请求级快照解析（P1b §6.5.7）：未绑定 → 绑定当前快照并返回（整个请求锁定）；已绑定 → 原快照。
   *  全降级 / 覆盖注入 → 常量（无绑定语义，兼容既有 'rs:assembly' 契约）。 */
  private resolveRuntimeSnapshot(reqId: string): string {
    if (this.snapshotOverride !== null) {
      return this.snapshotOverride;
    }
    if (this.degraded) {
      return 'rs:assembly';
    }
    const bound = this.registry.resolveSnapshot({ id: reqId }, { current: this.registry.currentSnapshot });
    return runtimeHashOf(bound);
  }

  /** 工作状态加载（§3.1 step 2）：checkpointDir 配置且存在 checkpoint → 恢复；否则请求携带的当前状态 */
  private async loadWorkingState(req: CognitiveRequest): Promise<PromptWorkingState> {
    if (this.checkpointDir === undefined) {
      return req.working_state;
    }
    try {
      const cp = await latestCheckpoint({ dir: this.checkpointDir });
      if (cp === null) {
        return req.working_state;
      }
      const state = await restoreCheckpoint(cp.id, { dir: this.checkpointDir });
      return toPromptWorkingState(state);
    } catch {
      return req.working_state; // checkpoint 不可用 → 降级到请求态
    }
  }

  /**
   * R3：Governor→Scheduler 调度步骤（prepareTurn 内，架构 §5.1/§4.6.1）。
   * 数据流：已知过程（Strong/Partial）→ 复用（确定性零成本）；OOD → Generator 阶梯（Compose/Mutate/Generate，
   * generation 预算经 createScheduler 注入 policy.budget.generation——P5 语义）；Contradictory/Failed →
   * 不触发生成（Governor 决策域，本层只报告不执行）。
   * 边界（R3 明确）：只做决策与投影——不驱动执行（不调用 operator executor、不循环调用模型；DSH 原生
   * Agent Loop 是唯一执行者）。失败降级：scheduler 构造/调度异常 → 降级记录（degraded），不抛——
   * prepareTurn 其余流程照常（投影不含过程 section）。
   */
  private async scheduleProcess(req: CognitiveRequest, processes: readonly ProcessDef[]): Promise<ProcessDecisionInfo> {
    try {
      // 每次调用构造新调度器/生成器（P5：generationUsed 计数器即单请求语义——max_generate_per_request）
      const scheduler = await this.createScheduler(processes);
      const res = await scheduler.schedule({ goal: req.goal, state: req.working_state });
      return {
        kind: res.kind,
        process_id: res.process?.id ?? null,
        name: res.process?.id ?? null, // ProcessDef.id 即过程名（无独立 name 字段）
        steps: res.process === null ? [] : res.process.operators.map((o) => o.op),
        method: res.method,
        applicability: res.applicability ?? null,
        budget_tokens: res.process?.budget.tokens ?? null,
        degraded: res.kind === 'none' ? `process/schedule: ${res.reason}` : null,
      };
    } catch (err) {
      return {
        kind: 'none',
        process_id: null,
        name: null,
        steps: [],
        method: 'none',
        applicability: null,
        budget_tokens: null,
        degraded: `process/schedule: ${errorDetail(err)}`,
      };
    }
  }

  /** 信号聚合（零成本）：会话事件 → reducer utility_counts；归约失败 → 全零 + 降级原因 */
  private async aggregateSignals(session_id: string): Promise<{ signals: UtilityCounts; degraded: string | null }> {
    try {
      const sessionEvents = (await this.eventStore.query({ session_id })).events;
      const { projections } = reduce(sessionEvents);
      return { signals: projections.utility_counts, degraded: null };
    } catch (err) {
      return {
        signals: { tool_calls: 0, retrieval_calls: 0, memory_ops: 0, corrections: 0, reads: 0, hits: 0 },
        degraded: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // ---- P1c：演化信号落盘 + 判定（§6.5.1 触发链：信号 → signals/ JSONL → 判定 → 债务/候选） ----

  /**
   * 收尾信号落盘（尽力而为）：信号源① utility_counts（零成本聚合）→ 信号记录；信号源② L1 generalization
   * 采集器（retrieval_episode 归因，T8.21）→ 信号记录；追加写 .evolution/signals/<yyyy-mm-dd>.jsonl。
   * 失败 → 降级字段（不阻塞收尾）；oracle/contamination 采集器依赖 P1d 装配点（OracleVerdict/CandidatePool），
   * 转换面 evaluationSignalsToRecords 已就绪。
   */
  private async persistTurnSignals(
    signals: UtilityCounts,
    sessionId: string,
  ): Promise<FinalizeTurnResult['signals_log']> {
    const now = Date.now();
    const records = countsToSignalRecords(signals as unknown as Record<string, number>, now, sessionId);
    try {
      const l1 = await collectGeneralizationSignals(
        this.memory,
        `session:${sessionId}`,
        { from: 0, to: now }, // 观察窗：本次收尾前全部归因 episode（P1d 引入逐 turn 窗口）
      );
      records.push(...evaluationSignalsToRecords(l1, now, sessionId));
    } catch {
      // L1 采集降级：信号日志不含采集器输出（不阻塞收尾）
    }
    try {
      const r = await appendSignals(this.signalsDir, records);
      return { files: r.files, appended: r.appended, degraded: null };
    } catch (err) {
      return { files: [], appended: 0, degraded: err instanceof Error ? err.message : String(err) };
    }
  }

  /** 维护任务执行体（§10.1 债务任务的清偿工作；P1d：candidate_validation 接真实管线——
   *  生成 → 验证 → 晋升（runEvolutionChain）；P1e：promotion_check 接晋升检查（stable ← trusted-latest
   *  显式门禁）；R4：memory_consolidation 接真实 consolidation（runMemoryConsolidation——
   *  staging→admit→dedup/merge/relation/decay）；R5：repair 接真实重验证（runRepair——
   *  读 decay 记录 → 受影响对象重验证审计 → 成功清债）） */
  private maintenanceRun(taskId: string, sessionId?: string): (signal?: AbortSignal) => Promise<void> {
    switch (taskId) {
      case 'gc':
        return async () => {
          await this.eventStore.compact(Date.now());
        };
      case 'candidate_validation':
        return async () => {
          // 旧布局（线快照无 policy 内容）→ 候选管线不可执行（生产降级记录；不触碰真实 versions.git）——
          // R5：抛 Deferred（不再 return 假成功清债——未实现/不可执行任务 → debt 保留不清零，评估依据 §13）
          if (sessionId === undefined || this.lineSnapshot === null) {
            throw new DeferredMaintenanceError(
              'candidate_validation 旧布局（线快照无 kernel/policy）——候选管线不可执行，债务保留',
            );
          }
          await this.runEvolutionChain(sessionId);
        };
      case 'promotion_check':
        return async () => {
          // 旧布局（无线快照）→ 晋升检查跳过（生产降级记录；不触碰真实 versions.git）——
          // checked:false + skipped_reason 是真实检查结果（可审计），非空实现假成功；且该任务
          // 不 accrueDebt（无债务可清），保持既有 return 语义
          if (sessionId === undefined || this.lineSnapshot === null) {
            return;
          }
          await this.runPromotionCheck(sessionId);
        };
      case 'environment_check':
        // P7：Predictive Invalidation——指纹 diff → 衰减记录落盘 + 受影响对象降级/重新验证入队
        //（失败降级不抛：尽力而为）
        return async () => {
          await this.runEnvironmentCheck();
        };
      case 'memory_consolidation':
        // R4（P0）：经验 → 长期记忆 生产闭环（§5.2/§7.2）——执行体 runMemoryConsolidation
        //（失败 → 任务抛错 → 债务不清零——R5 清债语义）
        return async (signal) => {
          await this.runMemoryConsolidation(signal);
        };
      case 'repair':
        // R5（P0+P1）：受影响对象重验证（读 decay 记录 → 重验证审计 → 成功清债；
        // 无待 repair 对象 = 合法完成清债；幂等——重复执行同结果）
        return async () => {
          await this.runRepair();
        };
      default:
        // 未实现/不可执行任务 → Deferred（债务保留，不假成功清债——评估依据 §13）
        return async () => {
          throw new DeferredMaintenanceError(`维护任务 ${taskId} 未实现——债务保留不清零`);
        };
    }
  }

  /**
   * 一次演化判定（§6.5.1 数据化）：读 signals → evolve.policy → decideEvolution（纯函数）→
   * 应演化 → 入队 candidate_validation（accrueDebt，债务入账）+ evolution/candidate 事件入链
   * （本次 stage='decision' 判定入链，candidate_id=null——候选尚未生成；P1d 生成/晋升的真实候选 id
   * 由 runEvolutionChain 以 stage='generated' 事件与 evolution/promoted 事件携带）。
   */
  private async performEvolutionDecision(sessionId: string): Promise<{
    decision: EvolutionDecision;
    enqueued: string[];
  }> {
    const { records } = await readSignals(this.signalsDir);
    const { policy } = await this.ready();
    const summary = summarizeSignals(records);
    const debtTotal =
      this.maintenance?.debtSnapshot().reduce((acc, d) => acc + d.value, 0) ?? 0;
    const decision = decideEvolution({ summary, policy: policy.evolve, debt: debtTotal });
    const enqueued: string[] = [];
    if (decision.should_evolve && this.maintenance !== null) {
      const acc = candidateValidationAccrual();
      await this.maintenance.enqueue(
        {
          id: acc.task_id,
          value: acc.value,
          estimated_cost: acc.estimated_cost,
          priority: acc.priority,
          urgency: acc.urgency,
          run: this.maintenanceRun(acc.task_id, sessionId),
        },
        { accrueDebt: true },
      );
      enqueued.push(acc.task_id);
      await this.eventStore.append(
        makeRuntimeEvent(
          'evolution/candidate',
          sessionId,
          this.snapshotHash,
          {
            stage: 'decision',
            should_evolve: decision.should_evolve,
            strength: decision.strength,
            object_layer: decision.object_layer,
            budget_estimate: decision.budget_estimate,
            triggers: decision.triggers,
            reason: decision.reason,
            candidate_id: null, // 判定阶段候选未生成（真实 id 见 runEvolutionChain 的 stage='generated' 事件）
          },
          ['evolution_decision', 'evolution/candidate'],
        ),
      );
    }
    return { decision, enqueued };
  }

  /** 空闲期演化判定任务执行体（维护量子内；低优先级、可中断——signal.aborted → AbortError 让出留队） */
  private async runEvolutionDecision(signal: AbortSignal | undefined, sessionId: string): Promise<void> {
    if (signal?.aborted === true) {
      const err = new Error('evolution_decision aborted');
      err.name = 'AbortError';
      throw err;
    }
    await this.performEvolutionDecision(sessionId);
  }

  // ---- P7：Predictive Invalidation（设计 §14.5 + 实现规格 §15.4 最小落地） ----

  /**
   * R4（P0）：记忆整合批处理执行体（维护任务 memory_consolidation；可公开调用——测试/命令触发）。
   * 全链：staging TTL 回收（sweepExpired）→ admit（准入：重复/新信息/稳定/scope/来源，§7.2 纯代码）
   * → consolidate（dedup/merge/relation/decay，backend.transaction 独占写事务——§7.2 单写者语义）。
   * 失败语义（R5 DeferredMaintenanceError 最小版）：任一步抛错 → 任务失败 → maintenance 债务不清零
   * （不再「空实现假成功」清债）；中断（signal.aborted）→ 抛 AbortError 让出留队（可重试）。
   */
  async runMemoryConsolidation(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) {
      const err = new Error('memory_consolidation aborted');
      err.name = 'AbortError';
      throw err;
    }
    await this.staging.sweepExpired();
    await this.staging.admit();
    await consolidate(this.memory);
  }

  /**
   * P7：环境指纹检查（维护任务 environment_check 执行体，可公开调用——测试/命令触发）。
   * 指纹 diff → 有变化 → 受影响对象定位（R5：memory 环境声明索引 findAffectedObjects → 降级
   * suspicious——lifecycle 更新，检索面已按 Suspicious 扣 pollution 降权 §7.4）→ CapabilityDecayRecord
   * 落盘 .evolution/decay/<ts>.json（affected_objects 真实填充）+ 受影响对象重新验证入队
   * （repair 债务，§14.5 局部重验证）→ 更新基线；无变化 → 不动作（返回 null）。
   * 基线：进程内首次检查建立（有 decay 落盘历史 → 取最近记录指纹接续——跨重启连续性）；
   * 尽力而为：采集/落盘/索引失败降级不抛（environment_check 不阻塞维护链）。
   */
  async runEnvironmentCheck(): Promise<CapabilityDecayRecord | null> {
    try {
      const current = this.fingerprintCollector();
      let baseline = this.lastEnvironmentFingerprint;
      if (baseline === null) {
        baseline = await this.readLatestDecayFingerprint(); // 跨重启接续：最近落盘指纹
        if (baseline !== null) {
          this.lastEnvironmentFingerprint = baseline;
        }
      }
      if (baseline === null) {
        this.lastEnvironmentFingerprint = current; // 首次检查：建立基线，无历史可比 → 不动作
        return null;
      }
      const delta = diffFingerprints(baseline, current);
      if (Object.keys(delta).length === 0) {
        return null; // 无变化不动作
      }
      // R5：环境声明索引定位受影响对象（按 delta 字段匹配声明环境的 memory 记录）→ 降级 suspicious
      //（lifecycle 更新——backend.update 白名单已含 lifecycle；检索消费面见 retrieve.ts §7.4 pollution
      // 扣减）。索引失败 → 降级为无对象（记录 delta + repair 债务照常，诚实不臆造）；单对象降级失败
      // → 跳过（尽力而为，不影响其它对象）。
      let affected_objects: ArtifactRef[] = [];
      try {
        affected_objects = await this.memory.findAffectedObjects(delta);
      } catch {
        affected_objects = [];
      }
      for (const obj of affected_objects) {
        try {
          const m = await this.memory.getById(obj.id);
          if (m !== undefined && m.lifecycle !== 'Suspicious') {
            await this.memory.update(obj.id, { lifecycle: 'Suspicious' });
          }
        } catch {
          // 单对象降级失败 → 跳过（记录中仍保留该对象引用，repair 重验证可再确认）
        }
      }
      // §15.4 字段级记录：delta + 受影响对象（regression_set/attribution 由构造纯函数派生）
      const record = buildCapabilityDecayRecord({
        before: baseline,
        after: current,
        delta,
        affected_objects,
      });
      if (record === null) {
        return null;
      }
      await this.writeDecayRecord(record);
      this.lastEnvironmentFingerprint = current;
      if (this.maintenance !== null) {
        const acc = repairAccrual();
        await this.maintenance.enqueue(
          {
            id: acc.task_id,
            value: acc.value,
            estimated_cost: acc.estimated_cost,
            priority: acc.priority,
            urgency: acc.urgency,
            run: this.maintenanceRun(acc.task_id),
          },
          { accrueDebt: true },
        );
      }
      return record;
    } catch {
      // 尽力而为：采集/落盘/入队失败 → 降级不抛（environment_check 是低优先级检查，不阻塞维护链）
      return null;
    }
  }

  /**
   * R5：repair 任务执行体（维护任务 repair，可公开调用——测试/命令触发）。
   * 受影响对象重验证：读全部 decay 记录（.evolution/decay/）→ 去重合并受影响对象 → 逐个确认
   * 存在（重验证最小形式：确认降级标记在检索面生效 + 记录重验证时间戳——审计落盘
   * .evolution/repair/<ts>.json；有 verifier 的对象走真实验证留评估面接入）→ 任务成功 return
   * → 调度器清债。无待 repair 对象（decay 无记录/受影响对象为空/对象已删除）→ 同样合法完成清债。
   * 幂等：重复执行同结果（重验证时间戳刷新、不重复写入/不抛错）。
   */
  async runRepair(): Promise<RepairRecord> {
    const files = (await readdir(this.decayDir)).filter((f) => f.endsWith('.json')).sort();
    const affected = new Map<string, ArtifactRef>();
    for (const f of files) {
      try {
        const rec = JSON.parse(await readFile(join(this.decayDir, f), 'utf8')) as CapabilityDecayRecord;
        for (const obj of rec.affected_objects ?? []) {
          affected.set(obj.id, obj);
        }
      } catch {
        // 损坏 decay 记录跳过（尽力而为；不阻塞重验证）
      }
    }
    const reverified: ArtifactRef[] = [];
    const missing: ArtifactRef[] = [];
    for (const obj of affected.values()) {
      const m = await this.memory.getById(obj.id);
      if (m === undefined) {
        missing.push(obj); // 引用对象已删除 → 无可修（跳过；记录留痕）
        continue;
      }
      // 最小重验证：确认对象存在（suspicious 降级标记已由 environment_check 写入；
      // 检索面已按 Suspicious 降权 §7.4）+ 记录重验证时间戳（本记录 ts）。真实 verifier 走验证留待。
      reverified.push({ id: obj.id, kind: 'memory' });
    }
    const record: RepairRecord = {
      ts: Date.now(),
      task: 'repair',
      decay_records: files.length,
      affected_objects: [...affected.values()],
      reverified,
      missing,
    };
    await mkdir(this.repairDir, { recursive: true });
    let file = join(this.repairDir, `${record.ts}.json`);
    let n = 0;
    while (existsSync(file)) {
      n++;
      file = join(this.repairDir, `${record.ts}-${n}.json`);
    }
    await writeFile(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    return record;
  }

  /** 读最近一条 decay 记录的环境指纹（跨重启基线接续；无历史/不可读 → null） */
  private async readLatestDecayFingerprint(): Promise<Fingerprint | null> {
    try {
      const files = (await readdir(this.decayDir)).filter((f) => f.endsWith('.json')).sort().reverse();
      if (files.length === 0) {
        return null;
      }
      const raw = JSON.parse(await readFile(join(this.decayDir, files[0]!), 'utf8')) as {
        fingerprint_after?: Fingerprint;
      };
      return raw.fingerprint_after ?? null;
    } catch {
      return null; // 无历史目录/不可读 → 视作无基线（尽力而为）
    }
  }

  /** 能力衰减记录落盘（.evolution/decay/<ts>.json；同毫秒碰撞 → <ts>-<n>.json 后缀避覆写） */
  private async writeDecayRecord(record: CapabilityDecayRecord): Promise<void> {
    await mkdir(this.decayDir, { recursive: true });
    let file = join(this.decayDir, `${record.ts}.json`);
    let n = 0;
    while (existsSync(file)) {
      n++;
      file = join(this.decayDir, `${record.ts}-${n}.json`);
    }
    await writeFile(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  }

  /**
   * P1c/P1d：/evolve now 支持——立即执行一次演化判定 + 候选管线（生成→验证→晋升）+ 维护量子 + 事件入链（摘要返回）。
   * 全链（P1d）：判定应演化（且线快照为新布局——旧布局降级跳过，不触碰旧种子 versions.git）→ 信号摘要 →
   * 确定性生成器产出候选（上限 = evolve.policy.candidate_gate.max_candidates_per_run）→ 逐候选验证
   * （G1+G3；预算守卫 K 数据化）→ 首个通过者晋升（txn 提交 → trusted-latest 推进 → Evolution Object →
   * evolution/promoted 事件）→ 摘要（候选数/各门结果/晋升 id/commit）。
   * 失败不崩：任何阶段失败 → 摘要含失败原因（degraded），命令按结果返回 success/error 文本。
   */
  async runEvolutionNow(input: { session_id: string }): Promise<EvolutionNowResult> {
    const sessionId = input.session_id;
    let decision: EvolutionDecision = {
      should_evolve: false,
      strength: 0,
      object_layer: 'L0',
      budget_estimate: 0,
      triggers: [],
      reason: 'no_runtime',
    };
    let enqueued: string[] = [];
    let degraded: string | null = null;
    let events_appended = 0;
    const candidates: CandidateOutcome[] = [];
    let promoted: PromotedInfo | null = null;
    try {
      const r = await this.performEvolutionDecision(sessionId);
      decision = r.decision;
      enqueued = r.enqueued;
      if (decision.should_evolve) {
        events_appended += 1; // evolution/candidate（判定入链）
        if (this.lineSnapshot === null) {
          // 生产降级：旧种子布局（版本线无 policy 内容）→ 候选管线跳过（记录，不写真实 versions.git）
          degraded = '旧布局（版本线快照无 kernel/policy）——候选生成/验证/晋升跳过（P1d 生产降级记录）';
        } else {
          const chain = await this.runEvolutionChain(sessionId);
          candidates.push(...chain.outcomes);
          promoted = chain.promoted;
          events_appended += chain.events_appended;
        }
      }
    } catch (err) {
      degraded = err instanceof Error ? err.message : String(err);
    }
    // P1e：晋升检查（在候选管线之后执行——新晋升的 trusted-latest 在同次运行内即可门禁推进到 stable；
    // 独立于演化判定——已有 trusted-latest 待晋升也判；旧布局降级跳过记录）
    const promotion = await this.runPromotionCheck(sessionId);
    events_appended += promotion.events_appended;
    let quantum: QuantumReport = { ran: [], skipped: [] };
    if (this.maintenance !== null) {
      quantum = await this.maintenance.requestQuantum();
      await this.eventStore.append(
        makeRuntimeEvent(
          'maintenance/quantum',
          sessionId,
          this.snapshotHash,
          { trigger: '/evolve now', ran: quantum.ran, skipped: quantum.skipped },
          ['evolve-now', 'maintenance/quantum'],
        ),
      );
      events_appended += 1;
    }
    const debt = this.maintenance?.debtSnapshot() ?? [];
    return { decision, enqueued, candidates, promoted, promotion, quantum, debt, degraded, events_appended };
  }

  /**
   * R8：/evolve share——发布机制级 Evolution Object（架构 §13；生产默认不自动发布——显式命令）。
   * 流程：trusted-latest 演化链最近对象（candidate-pipeline latestObjectId + loadEvolutionObject）→
   * 机制级隐私检查（provenance.source 以 evolution/ 开头 + diff 非空——不发布私人记忆/会话内容）→
   * GitRegistry publish（本地 registry，evolve.policy share.registry_dir 配置或缺省
   * <evolutionRoot>/registry = workspace/.omb/.evolution/registry；本地签名过格式门）→
   * evolution/shared 事件入链。无对象可发布 / 布局不可用 / 任一步失败 → 明确 error 文本（不崩）。
   * 生产配置 share.publish_mechanism_objects=false 不影响本命令（配置仅控制未来自动路径）。
   */
  async shareEvolutionObject(input: { session_id: string }): Promise<ShareCommandResult> {
    const sessionId = input.session_id;
    try {
      const layout = this.assemblyOpts.layout ?? defaultLayout();
      // ① trusted-latest 演化链最近对象（无 trusted-latest / 链空 → 明确文本）
      const commit = resolveLineCommit(layout, 'latest');
      const objectId = await latestObjectId(layout, commit);
      if (objectId === null) {
        return {
          ok: false,
          text: '无演化对象可发布（trusted-latest 演化链为空——先 /evolve now 产生并晋升候选，或检查线布局 .evolution-objects/）',
          events_appended: 0,
        };
      }
      const obj = await loadEvolutionObject(layout, commit, objectId);
      if (obj === null) {
        return {
          ok: false,
          text: `演化对象读取失败（${objectId.slice(0, 16)}… 不在 trusted-latest ${commit.slice(0, 12)} 提交树）`,
          events_appended: 0,
        };
      }
      // ② 机制级隐私检查（仅发布机制数据，不发布私人记忆/会话内容）
      const origin = mechanismOrigin(obj);
      if (!origin.ok) {
        return { ok: false, text: `发布拒绝（隐私原则）：${origin.detail}`, object_id: obj.id, events_appended: 0 };
      }
      // ③ GitRegistry publish（本地 registry；registry_dir 配置或缺省 <evolutionRoot>/registry）
      const registryDir = await this.resolveShareRegistryDir();
      const registry = new GitRegistry(registryDir);
      await registry.init();
      const signature = localPublishSignature(obj.id);
      const pub = await registry.publish(obj, signature, { name: 'evolution-object', version: obj.protocol_version });
      if (!pub.ok) {
        return {
          ok: false,
          text: `发布失败：${pub.error ?? '未知原因'}`,
          object_id: obj.id,
          registry_dir: registryDir,
          events_appended: 0,
        };
      }
      // ④ evolution/shared 事件入链（尽力而为：入链失败不阻断发布结果——发布已生效）
      try {
        await this.eventStore.append(
          makeRuntimeEvent(
            'evolution/shared',
            sessionId,
            this.snapshotHash,
            { object_id: obj.id, registry_dir: registryDir, commit, parent: obj.parent ?? null },
            ['evolve-share', 'evolution/shared'],
          ),
        );
      } catch {
        // 事件为日志，失败不阻断命令结果
      }
      const verifiedBy = (await registry.list()).find((e) => e.id === obj.id)?.verified_by ?? [];
      return {
        ok: true,
        text: `已发布机制级 Evolution Object ${obj.id.slice(0, 16)}… 到本地 registry（${registryDir}；parent=${obj.parent === null || obj.parent === undefined ? 'null（链头）' : `${obj.parent.slice(0, 16)}…`}；验证门 [${(obj.verifications ?? []).join(', ')}]；共识 verified_by=${verifiedBy.length}）——` +
          '机制数据已共享，私人记忆/会话内容不含（隐私原则）',
        object_id: obj.id,
        registry_dir: registryDir,
        events_appended: 1,
      };
    } catch (err) {
      return { ok: false, text: `发布失败：${errorDetail(err)}`, events_appended: 0 };
    }
  }

  /**
   * R8：/evolve absorb <id>——显式从本地 registry 吸收（架构 §13.2 吸收管线）。
   * 流程：registry 读取对象 + manifest 签名 → 本地验证（GitRegistry.verify：签名格式/哈希/schema/CAS 绑定）→
   * 机制级隐私检查（仅接受 evolution/* 来源机制对象）→ share-pipeline 既有 absorb 管线
   * （signature_hash → schema → verify_chain → replay_bench → contract_tests → publish/去重 → consensus 回传）→
   * evolution/absorbed 事件入链。参数缺失 → 插件侧帮助文本；任一步失败 → 明确 error 文本（不崩）。
   * 注意：吸收 = 本地验证 + 入库 + 共识回传（协议层）；机制内容「应用到当前线」走候选管线（P1d），留后续。
   */
  async absorbEvolutionObject(input: { session_id: string; object_id: string }): Promise<ShareCommandResult> {
    const sessionId = input.session_id;
    const registryDir = await this.resolveShareRegistryDir();
    try {
      const registry = new GitRegistry(registryDir);
      await registry.init();
      // ① 本地验证（签名格式/内容哈希/schema/CAS 绑定；撤销/黑名单 fail-loud）
      const verify = await registry.verify(input.object_id);
      if (!verify.ok) {
        return {
          ok: false,
          text: `吸收失败（本地验证未通过）：${verify.detail}`,
          registry_dir: registryDir,
          events_appended: 0,
        };
      }
      // ② 读取对象 + manifest 签名（verify 通过 → get 非空；签名由发布时格式门保证）
      const obj = await registry.get(input.object_id);
      if (obj === null) {
        return { ok: false, text: `吸收失败：对象不可读（${input.object_id}）`, registry_dir: registryDir, events_appended: 0 };
      }
      const entry = (await registry.list()).find((e) => e.id === input.object_id);
      const signature = entry?.signature ?? '';
      // ③ 机制级隐私检查（仅吸收机制数据，不吸收私人记忆/会话内容）
      const origin = mechanismOrigin(obj);
      if (!origin.ok) {
        return {
          ok: false,
          text: `吸收拒绝（隐私原则）：${origin.detail}`,
          object_id: obj.id,
          registry_dir: registryDir,
          events_appended: 0,
        };
      }
      // ④ share-pipeline 既有 absorb 管线（注入 deps：verify_chain 复用 registry.verify；
      //    机制级对象为纯机制数据——本地回放 bench / 契约测试 N/A 直通（如实注明））
      const deps: AbsorbDeps = {
        verifyChain: async () => ({ ok: verify.ok, detail: verify.detail }),
        replayBench: async () => ({
          ok: true,
          detail: '机制级对象（纯机制数据）——本地回放 bench N/A 直通（无过程/记忆语义）',
        }),
        contractTests: async () => ({
          ok: true,
          detail: '机制级对象（纯机制数据）——契约测试 N/A 直通（签名/哈希/schema 已由吸收管线①②校验）',
        }),
        instance: `local:${hostVersion()}`,
        diversity: 1,
      };
      const report = await absorb(registry, obj, signature, deps);
      if (!report.ok) {
        return {
          ok: false,
          text: `吸收失败（管线阶段 ${report.failed_at ?? 'unknown'}）：${report.stages
            .filter((s) => !s.ok)
            .map((s) => `${s.name}: ${s.detail}`)
            .join('；')}`,
          object_id: obj.id,
          registry_dir: registryDir,
          events_appended: 0,
        };
      }
      // ⑤ evolution/absorbed 事件入链（尽力而为）
      try {
        await this.eventStore.append(
          makeRuntimeEvent(
            'evolution/absorbed',
            sessionId,
            this.snapshotHash,
            { object_id: obj.id, registry_dir: registryDir, stages: report.stages.map((s) => s.name) },
            ['evolve-absorb', 'evolution/absorbed'],
          ),
        );
      } catch {
        // 事件为日志，失败不阻断命令结果
      }
      const verifiedBy = (await registry.list()).find((e) => e.id === obj.id)?.verified_by ?? [];
      return {
        ok: true,
        text:
          `已吸收机制级 Evolution Object ${obj.id.slice(0, 16)}…（本地验证通过：${verify.detail}；管线阶段 ` +
          report.stages.map((s) => s.name).join('→') +
          `；共识 verified_by=${verifiedBy.length} 实例）——机制数据已入库并回传共识，私人记忆/会话内容不吸收（隐私原则）`,
        object_id: obj.id,
        registry_dir: registryDir,
        events_appended: 1,
      };
    } catch (err) {
      return { ok: false, text: `吸收失败：${errorDetail(err)}`, registry_dir: registryDir, events_appended: 0 };
    }
  }

  /**
   * R8：本地 registry 目录解析（evolve.policy share.registry_dir 配置优先——相对路径相对演化工作区根解析，
   * 绝对路径原样；缺省 <evolutionRoot>/registry = workspace/.omb/.evolution/registry，架构 §3 用户态约定）。
   */
  private async resolveShareRegistryDir(): Promise<string> {
    const { policy } = await this.ready();
    const configured = policy.evolve.share.registry_dir;
    if (configured !== undefined && configured.length > 0) {
      return isAbsolute(configured) ? configured : join(this.evolutionRoot, configured);
    }
    return join(this.evolutionRoot, 'registry');
  }

  /**
   * P1d：候选管线全链（空闲期量子与 /evolve 共用）——读信号 → 摘要 → 确定性生成候选（≤ K）→
   * 逐候选 evolution/candidate 事件（stage=generated，真实候选 id）→ runCandidatePipeline（验证 →
   * 注册 → 首个通过者晋升）→ 首个 promoted 即返回（后续候选不再处理）。
   * 幂等：quantum 重复执行时候选内容已在 trusted-latest → duplicate 早退（不重复验证/晋升）。
   */
  private async runEvolutionChain(
    sessionId: string,
  ): Promise<{ outcomes: CandidateOutcome[]; promoted: PromotedInfo | null; events_appended: number }> {
    const { records } = await readSignals(this.signalsDir);
    const { policy } = await this.ready();
    const summary = summarizeSignals(records);
    const drafts = generatePolicyAdjustmentCandidates(summary, policy);
    const budget = policy.evolve.candidate_gate.max_candidates_per_run;
    const outcomes: CandidateOutcome[] = [];
    let events = 0;
    for (const draft of drafts.slice(0, budget)) {
      await this.eventStore.append(
        makeRuntimeEvent(
          'evolution/candidate',
          sessionId,
          this.snapshotHash,
          {
            stage: 'generated',
            candidate_id: draft.id,
            target: draft.target,
            signal: draft.signal,
            motivation: draft.motivation,
          },
          ['evolve-now', 'evolution/candidate'],
        ),
      );
      events += 1;
      const outcome = await runCandidatePipeline(draft, {
        layout: this.assemblyOpts.layout ?? defaultLayout(),
        evolutionRoot: this.evolutionRoot,
        baselinePolicyDir: this.policyDir,
        eventStore: this.eventStore,
        sessionId,
        snapshotHash: this.snapshotHash,
        shadowLogPath: join(this.evolutionRoot, 'shadows', 'exposure.log'),
        sourceEvents: [`evolution/candidate:${draft.id}`],
      });
      outcomes.push(outcome);
      if (outcome.promoted && outcome.commit_hash !== undefined && outcome.object_id !== undefined) {
        events += 1; // evolution/promoted（pipeline 内入链）
        return {
          outcomes,
          promoted: { candidate_id: outcome.candidate_id, object_id: outcome.object_id, commit_hash: outcome.commit_hash },
          events_appended: events,
        };
      }
    }
    return { outcomes, promoted: null, events_appended: events };
  }

  /**
   * P1e：晋升检查（维护任务 promotion_check 与 /evolve 共用）——读 trusted-latest vs stable
   * （线指针 + 冻结基准回放 fitness（G3 同款：回放执行器 + 成本代理对照，策略无关回归护栏语义）+
   * L2 shadow 统计）→ 三层信号门禁判定（kernel 纯函数 shouldPromoteToStable，阈值数据化
   * resolvePromotionGate）→ 应晋升则 promoteToStable（activation_scope='project' 显式传入——D3 裁决不写死）。
   * 旧布局（无线快照）/ stable == trusted-latest / 线指针不可用 → 跳过（记录 skipped_reason）；
   * 门禁失败 → 不推进，返回 reasons（候选保持 trusted-latest，等待下次检查）；
   * 任何异常 → info.error（失败不崩，摘要可读）。
   */
  private async runPromotionCheck(sessionId: string): Promise<PromotionCheckInfo> {
    const skip = (skipped_reason: string): PromotionCheckInfo => ({
      checked: false,
      skipped_reason,
      gate_ok: false,
      reasons: [],
      promoted: false,
      events_appended: 0,
    });
    try {
      // 旧布局（线快照无 kernel/policy）→ 降级跳过（不触碰真实 versions.git）
      if (this.lineSnapshot === null) {
        return skip('旧布局（无线快照 kernel/policy）——晋升检查降级跳过（记录）');
      }
      const layout = this.assemblyOpts.layout ?? defaultLayout();
      // 旧布局检测（D1 裁决特征）：trusted-latest 分支缺失（P1d 候选晋升后才存在）→ 晋升检查降级跳过——
      // 防在无 trusted-latest 的旧种子布局上对真实 versions.git 误判/误写（R1：resolveLineCommit('latest')
      // 缺失即 fail-loud——先探测防误写；旧种子由启动 ensureThreeLineLayout 自动迁移重建）
      try {
        runGit(layout, ['show-ref', '--verify', 'refs/heads/trusted-latest']);
      } catch {
        return skip('旧布局（refs/heads/trusted-latest 缺失——D1 新布局特征未就绪）——晋升检查降级跳过（记录）');
      }
      let latest: string;
      let stable: string;
      try {
        latest = resolveLineCommit(layout, 'latest');
        stable = resolveLineCommit(layout, 'stable');
      } catch (err) {
        return skip(`线指针解析失败（${errorDetail(err)}）——晋升检查跳过`);
      }
      if (latest === stable) {
        return skip('stable 已是最新（trusted-latest == stable）——无待晋升内容，跳过');
      }

      // 冻结基准回放 fitness（与 P1d G3 同款：回放执行器 = fixture.output 直通，passed/成本对照为回归护栏语义；
      // 策略敏感度经成本代理（context_budget_tokens 投影预算）体现）
      const contracts = await loadBenchContractsV2();
      const fixtures = await loadBenchFixturesV2();
      const replay = makeReplayExecutorV2(fixtures);
      const baseline = await runBenchV2({ contracts, fixtures, line: 'stable', executor: replay, mode: 'replay' });
      const candidate = await runBenchV2({ contracts, fixtures, line: 'latest', executor: replay, mode: 'replay' });
      // 成本代理：稳定线 vs 最新线策略捆绑（materialize 线快照 → loadPolicy）
      const stableSnap = ensureLineSnapshot(layout, 'stable');
      const latestSnap = ensureLineSnapshot(layout, 'latest');
      const baseProxy = (await loadPolicy(join(stableSnap.dir, 'kernel', 'policy'))).budget.context_budget_tokens;
      const candProxy = (await loadPolicy(join(latestSnap.dir, 'kernel', 'policy'))).budget.context_budget_tokens;
      const ratio = baseProxy > 0 ? (candProxy - baseProxy) / baseProxy : 0;
      const bench = {
        baseline: { passed: baseline.passed, total: baseline.total },
        candidate: { passed: candidate.passed, total: candidate.total },
        cost_degradation_ratio: Math.round(ratio * 1000) / 1000,
      };
      // L2 统计（.evolution/shadows/exposure.log；无样本 → 记录不阻塞，以基准门禁为准）
      const shadow = await readShadowSignals(join(this.evolutionRoot, SHADOW_LOG_REL));
      // 三层信号门禁判定（kernel 纯函数；阈值数据化）
      const { policy } = await this.ready();
      const gate = shouldPromoteToStable({
        baseline: { stable_commit: stable, stable_bench: bench.baseline },
        candidate: { latest_commit: latest, latest_bench: bench.candidate },
        cost_degradation_ratio: bench.cost_degradation_ratio,
        shadow_signals: shadow,
        policy: resolvePromotionGate(policy.evolve),
      });
      if (!gate.ok) {
        return {
          checked: true,
          skipped_reason: null,
          gate_ok: false,
          reasons: gate.reasons,
          promoted: false,
          events_appended: 0,
        };
      }
      // 应晋升 → promoteToStable（activation_scope='project' 显式传入；object_id = P1d Evolution Object 链头）
      const objectId = await latestObjectId(layout, latest);
      const pr = await promoteToStable(
        {
          gate,
          candidate_commit: latest,
          stable_commit: stable,
          bench,
          object_id: objectId ?? undefined,
          activation_scope: 'project',
        },
        {
          layout,
          activationLogDir: join(this.evolutionRoot, 'activations'),
          eventStore: this.eventStore,
          sessionId,
          snapshotHash: this.snapshotHash,
        },
      );
      if (!pr.promoted) {
        return {
          checked: true,
          skipped_reason: null,
          gate_ok: true,
          reasons: gate.reasons,
          promoted: false,
          error: pr.reason ?? 'promoteToStable 未推进（未知原因）',
          events_appended: 0,
        };
      }
      return {
        checked: true,
        skipped_reason: null,
        gate_ok: true,
        reasons: gate.reasons,
        promoted: true,
        activation_id: pr.activation_id,
        stable_commit: pr.stable_commit,
        warning: pr.reason, // 事件入链失败等非致命告警
        events_appended: 2, // activation/committed + evolution/promoted
      };
    } catch (err) {
      return {
        checked: true,
        skipped_reason: null,
        gate_ok: false,
        reasons: [],
        promoted: false,
        error: `晋升检查失败（${errorDetail(err)}）`,
        events_appended: 0,
      };
    }
  }

  private buildGovernorInput(
    req: CognitiveRequest,
    processes: readonly ProcessDef[],
    policy: PolicyBundle,
    snapshot: string,
  ): GovernorInput {
    const envelope = policy.budget;
    const es = req.evidence_sufficiency ?? {
      covered_success_conditions: [],
      critical_gaps: [req.goal],
      score: 0,
    };
    return {
      task_contract: { goal: req.goal, success_criteria: req.success_criteria },
      state_snapshot: { snapshot_hash: snapshot },
      environment: req.environment ?? 'default',
      candidate_processes: processes.map((p) => p.id),
      applicability_results: processes.map((p) => ({
        process_id: p.id,
        applicability: assessApplicability(p, { goal: req.goal, state: req.working_state as WorkingState }),
      })),
      budget: {
        envelope,
        remaining: {
          depth: envelope.depth,
          breadth: envelope.breadth,
          tools: envelope.tools,
          retrieval: envelope.retrieval,
          branches: envelope.branches,
          context: envelope.context,
        },
      },
      risk: 0,
      progress_vector: {
        constraint_reduction: 0,
        hypothesis_reduction: 0,
        hypothesis_discrimination: 0,
        evidence_strengthening: 0,
        goal_completion: 0,
        reproducibility: 0,
        uncertainty_reduction: 0,
      },
      uncertainty_vector: {},
      maintenance_state: { debt: 0 },
      evidence_sufficiency: es,
    };
  }
}

/** 装配入口（组合根）：实例化认知依赖图 */
export function createCognitiveRuntime(opts: CognitiveAssemblyOptions = {}): CognitiveRuntime {
  return new CognitiveRuntime(opts);
}
