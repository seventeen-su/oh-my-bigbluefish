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
import { appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { cpus, totalmem } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { GIT_BIN, VALID_LINES, defaultLayout, runGit } from '../substrate/snapshot.js';
import { ensureLineSnapshot, isVersionLine, resolveLineCommit, type VersionLine, type VersionLayout } from '../substrate/lines.js';
import {
  createSnapshot,
  SnapshotRegistry,
  type ComponentHashes,
  type LineHashInput,
} from '../supervisor/versioning.js';
import { computeComponentHashes, computeDirContentHash } from './snapshot-hash.js';
import { makeMutableId } from '../kernel/schemas/base.js';
import type { Fingerprint, Scope } from '../kernel/schemas/base.js';
// R6：宿主版本唯一来源注入面（kernel/schemas IR 契约层，runtime(2) → kernel/schemas(2) ✓）
import { hostVersion, setHostVersion } from '../kernel/schemas/host-version.js';
import type { ContextProjection } from '../kernel/schemas/a.js';
import { EventSchema, type Event, type Checkpoint, type RuntimeSnapshot, type Memory, type MemoryKind, type MemoryLifecycle, type MemoryProvClass } from '../kernel/schemas/m.js';
import { StateSchema, type State, type SelfModel, type WorldModel } from '../kernel/schemas/s.js';
import type { ModelAdapter } from '../kernel/schemas/model-adapter.js';
import { loadPolicy, loadProcesses, type PolicyBundle, type ProcessDef, type ShadowPolicy } from '../kernel/policy-loader.js';
// S7：per-session shadow 路由纯函数（kernel 层 2；桶分配 + 路由判定——实现规格 §5.3）
import { shouldRouteShadow } from '../kernel/shadow-route.js';
// P2：Shadow 真实判定——验证契约种子/证据构造/判定映射（kernel 层 2；runtime(2) → kernel(2) ✓）
// W2：SHADOW_PROXY_VERIFIER_ID / SHADOW_JUDGE_VERIFIER_ID——任务库登记的两枚 verifier 引用（同一来源，不复制常量）
import {
  SHADOW_JUDGE_VERIFIER_ID,
  SHADOW_PROXY_VERIFIER_ID,
  buildShadowEvidence,
  seedShadowContract,
  shadowOutcomeFromResult,
} from '../kernel/shadow-contract.js';
// P3：Repair 升级——损坏类型分类/对象验证契约种子/最小验证计划/处置语义（kernel 层 2；runtime(2) → kernel(2) ✓）
import {
  applyRepairDisposition,
  classifyRepairDamage,
  seedRepairContract,
  type RepairDisposition,
} from '../kernel/repair-contract.js';
import { decideVerdict, trustGate } from '../kernel/verification.js';
// P3.5：Repair 真实验证执行器（七类对象——对象契约应查检查的确定性执行面；runtime(2) → runtime(2) ✓）
import { createRepairExecutors, type RepairExecutors, VERIFIER_VERSION } from './repair-executors.js';
// P4：Evolution 收敛——候选晋升验证契约门禁 + stable 晋升信任门禁（kernel 层 2；runtime(2) → kernel(2) ✓；
// supervisor 侧经 deps 注入回调消费——本文件为 kernel 逻辑唯一消费方）
import { runCandidateGate, stablePromotionTrustGate } from '../kernel/candidate-contract.js';
// P4：Benchmark 收敛——bench v2 适配层（结果 → 验证契约语义纯映射；kernel 层 2）
import { benchContractFromTask, benchEvidenceFromResult } from '../kernel/bench-contract.js';
import type { Verdict, VerificationEvidence } from '../kernel/schemas/verification.js';
import { EventStore } from '../supervisor/event-store.js';
// P3.6：验证数据面三库（事实库/基线库/任务库——layer 1 JSON 注册面；runtime(2) → supervisor(1) ✓）
import {
  createVerificationStores,
  type BaselineKind,
  type BaselineStore,
  type FactStore,
  type TaskStore,
} from '../supervisor/verification-stores.js';
// S2：验证债务队列（layer 1 JSONL——shadow/repair 未决验证统一复核面；runtime(2) → supervisor(1) ✓）
import { VerificationDebt } from '../supervisor/verification-debt.js';
// S4：Artifact Index（layer 1 JSONL——事件驱动制品索引；装配/发现/查询；runtime(2) → supervisor(1) ✓）
import {
  ARTIFACT_DISCOVERY_EVENT_LIMIT,
  ARTIFACT_DISCOVERY_FETCH_LIMIT,
  ArtifactIndex,
  discoverArtifactsFromEvents,
} from '../supervisor/artifact-index.js';
// S2：机械评分器（过程质量向量 + 可控性分类——kernel 层 2 纯函数；runtime(2) → kernel(2) ✓）
import { normalizeProcessQuality, qualityVectorFromSignals } from '../kernel/process-quality.js';
import { classifyFromText } from '../kernel/controllability.js';
// S2：单次结构化 Judge 执行器（空白子代理同模型裁判——layer 2；装配面注入 spawnJudge）
import type { JudgeExecutor } from './judge-executor.js';
import { latestForSession as latestCheckpointForSession, prune as pruneCheckpoints, restore as restoreCheckpoint, save as saveCheckpoint } from '../supervisor/checkpoint.js';
import { MaintenanceScheduler, DeferredMaintenanceError, type MaintenanceDebt, type QuantumReport, type DebtSourceView, type DebtReleaseRecord, type DebtReleaseResult } from '../supervisor/maintenance.js';
import { reduce, type ClaimView, type Projections, type ReducedState, type UtilityCounts } from '../supervisor/state-reducer.js';
import { RetrievalBackend } from '../memory/backend-retrieval.js';
import type { RelationStats } from '../memory/backend-relation.js';
import { applySimilarityEdges, planSimilarityEdges, relationNeedsBuild, RELATION_BUILD_BATCH, type RelationBuildOutcome } from '../memory/relations.js';
import { retrieve, type RankedMemory, type RetrieveQuery } from '../memory/retrieve.js';
import { assessApplicability, type WorkingState } from './generator-ops.js';
import { decide, type GovernorDecision, type GovernorInput, type ProcessDecisionInfo } from './governor.js';
import { buildPrompt, type BuiltPrompt, type PromptWorkingState } from './prompt.js';
import { buildContextProjection, buildExperienceCandidate, experienceToStageEvent, EXPERIENCE_STAGE_PRIORITY, makeRuntimeEvent, MAX_EXPERIENCES_STAGED_PER_TURN, shouldSampleEpisode, toPromptWorkingState, toProcessSection } from './turn-helpers.js';
import { ProcessScheduler } from './scheduler.js';
import type { Experience } from '../kernel/schemas/c.js';
// R4（P0）：Experience → Memory 长期学习闭环——staging（准入）+ consolidate（dedup/merge/relation/decay）
import { StagingManager } from '../memory/staging.js';
import { consolidate } from '../memory/consolidate.js';
// 归因观测面（已知问题《效用反馈为空》）：不伪造命中/未命中的引用证据归因
import { attributeEpisode } from '../memory/attribution.js';
// 记忆写入面与管理面（已知问题《缺少写入面与记忆管理面》）：写入流水 + 列出/查看/编辑/删除/合并
// + 关系边治理面（已知问题《关系图为空图》：列举 / 单条删除）
import {
  deleteMemory,
  editMemory,
  listMemories,
  listRelations,
  mergeMemories,
  unlinkRelation,
  viewMemory,
  writeMemory,
  type MemoryManageEntry,
  type MemoryRelationEntry,
} from '../memory/manage.js';
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
  type DebtAccrual,
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
// W3（未接线审计修复 2026-08-25）：dynamicCordisRunner 结构最小面（S9 增强通道——候选验证脚本经动态
// 插件半执行；supervisor 层 1——runtime(2) → supervisor(1) ✓）
import type { DynamicCordisRunnerLike } from '../supervisor/dynamic-runner.js';
// R8：集体共享显式命令（架构 §13——/evolve share 发布 / /evolve absorb 吸收；GitRegistry 本地 registry +
// share-pipeline 既有 absorb 管线；layer 2 → supervisor(1) ✓）
import { absorb, GitRegistry, type AbsorbDeps } from '../supervisor/share.js';
// P1e：晋升门禁判定（kernel 纯函数，layer 2 → 2 ✓）+ 晋升执行/回滚契约（supervisor 层 1）+ 基准回放对照
import { resolvePromotionGate, shouldPromoteToStable } from '../kernel/promotion-gate.js';
import {
  promoteToStable,
  readShadowSignals,
} from '../supervisor/promotion.js';
import {
  loadBenchContractsV2,
  loadBenchFixturesV2,
  makeReplayExecutorV2,
  runBenchV2,
  type BenchExecutorV2,
} from '../supervisor/bench-v2.js';
import { makeRealExecutorV2 } from '../supervisor/real-executor.js';
import { makeJudgeV2 } from '../supervisor/judge.js';
import type { BenchContractV2, BenchFixtureV2, BenchLine } from '../kernel/schemas/bench.js';
// S1：基准明细目录（WorldModel bench 状态查询——最近 real/replay 报告存在性）
import { BENCH_REPORTS_DIR } from '../supervisor/bench.js';
// P2：组件注册表装配（实现落 supervisor 层 1——runtime(2) 持有注册表，层 DAG 禁 runtime → components，
// tests/m0/dag-lint.test.ts 钉住；components/registry.ts 为 ABI 出口）+ 能力注册表衔接 + kern_status 数据源
import { ComponentRegistry, type ComponentHealthResult, type ComponentManifest } from '../supervisor/component-registry.js';
import { CapabilityRegistry } from '../supervisor/capability.js';
import { memoryRetrievalComponent } from '../memory/memory-retrieval.js';
import type { KernStatusSummary } from './kern-tools.js';
// S1：World/Self 模型运行接线——运行时状态视图 → 模型组装（纯读取、确定性）
import { degradationLog, recordDegradation } from './loop-hooks.js';
import { buildSelfModel, buildWorldModel, type RuntimeView } from './models.js';
// 自迭代状态落盘/读取（已知问题《需要"查看自迭代状态"的快速工具》数据面；runtime(2) → runtime(2) ✓）
import {
  evolutionStateFile,
  readEvolutionState,
  writeEvolutionState,
  type EvolutionGateView,
} from './evolution-state.js';

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
 * P3.6：Repair 对象 kind → 基线 kind 映射（用户裁决 S1 基线面：Process 首次成功快照/Skill 代表任务/
 * Policy 冻结回归集/Projection 重建输入；memory→无（事实面覆盖）；capability/version/未列 kind → 无——
 * 仅四类对象结构类检查全 pass 时自动注册版本化基线）。
 */
const REPAIR_KIND_TO_BASELINE: Partial<Record<string, BaselineKind>> = {
  process: 'process',
  skill: 'skill-task',
  policy: 'policy-regression',
  projection: 'projection-rebuild',
};

/** P3.6：基线 input = 对象 payload（非空字符串/对象）或契约摘要（payload 缺失/空 → {kind, object_id, contract_id}） */
function baselineInputOf(
  m: { payload?: unknown },
  summary: { kind: string; id: string; contract_id: string },
): unknown {
  const p = m.payload;
  if (typeof p === 'string' && p.length > 0) {
    return p;
  }
  if (p !== null && typeof p === 'object') {
    return p;
  }
  return { kind: summary.kind, object_id: summary.id, contract_id: summary.contract_id };
}

/** S5：记忆 payload 摘要（JSON 对象取常见文本字段；否则原样截断——kern_memory 条目 snippet） */
function memorySnippet(payload: string, max = 120): string {
  try {
    const obj = JSON.parse(payload) as unknown;
    if (obj !== null && typeof obj === 'object') {
      const rec = obj as Record<string, unknown>;
      for (const key of ['content', 'text', 'summary', 'goal', 'question', 'detail', 'note']) {
        const v = rec[key];
        if (typeof v === 'string' && v.length > 0) {
          return v.length > max ? `${v.slice(0, max)}…` : v;
        }
      }
    }
  } catch {
    // payload 非 JSON → 原样截断
  }
  return payload.length > max ? `${payload.slice(0, max)}…` : payload;
}

/**
 * W1（未接线审计修复 2026-08-25）：画像记录确定性 id（单条 Profile 记忆——跨会话稳定，
 * kern_profile 写入 / kern_memory kind=Profile scope=Global 读取共用）。可变对象 id（非 sha256）：
 * `profile:<用户标识>` 命名空间，当前用户画像固定 'profile:user'（多用户场景按用户标识扩展）。
 */
const PROFILE_MEMORY_ID = 'profile:user';

// ---- 专项 D：记忆检索 Episode 采样（评审问题一——采样开关/高价值提升/归因代理） ----

/** 采样率缺省（2%——低成本语义：prepareTurn 检索缺省几乎不记录 episode，既有零记录行为量级不变） */
export const EPISODE_SAMPLE_RATE_DEFAULT = 0.02;
/** 高价值提升采样率（working_state.open_questions 或 evidence_gaps 非空 → 生效采样率 ≥ 此值——
 *  高不确定/缺口任务检索更有学习价值；待标定 §17） */
export const EPISODE_SAMPLE_RATE_HIGH_VALUE = 0.1;

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
  /** P3.6：验证数据面根目录（事实库/基线库/任务库；缺省 <root>/.evolution/verification——与
   *  signals/decay/repair 同 .evolution 根系；测试注入临时目录隔离真实 workspace） */
  verificationRoot?: string;
  /** S4：制品索引根目录（缺省 <evolutionRoot>/artifacts = <root>/.evolution/artifacts；测试注入临时目录隔离） */
  artifactIndexRoot?: string;
  /** S2：验证债务队列（shadow/repair 未决验证；缺省 <verificationRoot>/debt.jsonl 内部构造——
   *  测试注入隔离队列；消费：writeShadowOutcome/runRepair 入队 + verification_review 复核） */
  verificationDebt?: VerificationDebt;
  /** S2：单次结构化 Judge 执行器（空白子代理同模型裁判——装配面经 plugin.ts 注入 spawnJudge；
   *  未注入 → judge 不可用（诚实降级——仅验证债务路径触发、正常任务 0 额外成本）） */
  judgeExecutor?: JudgeExecutor;
  /** W3（未接线审计修复 2026-08-25）：dynamicCordisRunner 增强通道（宿主 ctx.dynamicCordisRunner 结构
   *  最小面——plugin.ts 装配面经 readService 读取注入；候选验证脚本经 runner 通道执行（G3-exec 优先，
   *  define→run→invoke→stop→undefine）；未注入/部分缺失 → 管线守卫自动降级受限子进程路径——既有行为
   *  不变，诚实降级） */
  dynamicRunner?: DynamicCordisRunnerLike;
  /** 专项 D：prepareTurn 检索的 Retrieval Episode 采样率（0~1；缺省 0.02 = 2%——确定性哈希采样，
   *  见 shouldSampleEpisode；working_state 高价值（open_questions/evidence_gaps 非空）→ 提升到
   *  EPISODE_SAMPLE_RATE_HIGH_VALUE；kern_memory 显式记忆工具恒记录不受此限；非法值 → fail-loud） */
  episodeSampleRate?: number;
  /**
   * 外核安全状态快照注入（已知问题《内核加载失败不得阻塞宿主》：状态面可查看"内核未加载的原因"）。
   * 装配面（plugin.ts）提供 → `status()` 附带 `safe_state` 段；缺省 → 段缺省（测试装配不计）。
   */
  safeStateView?: () => KernStatusSummary['safe_state'];
  /**
   * 制品发现根集合（已知问题《制品索引未建立》修复）：除仓库根外的真实工作根（如会话工作目录）。
   * 逐根尝试解析；全部未命中 → 记为不可恢复制品（不再直接丢弃）。缺省只有仓库根。
   */
  artifactRoots?: readonly string[];
  /** 会话工作目录（DSH 装配面注入；优先于 artifactRoots——最常见的真实制品所在） */
  workspaceRoot?: string;
  /**
   * 自迭代开关面（已知问题《开关落在宿主插件配置，不引入界面》——落 agent.cordis.yml 插件配置，
   * 由 plugin.ts 解析后注入；缺省全部启用 = 既有行为不变）。
   */
  selfIteration?: {
    /** 链路总开关：是否允许演化与晋升（false → 判定不触发候选管线/晋升，仅记账并说明原因） */
    enabled?: boolean;
    /** 触发门槛：低于该强度的触发信号不演化（0 = 不设门槛） */
    minStrength?: number;
    /** 后台模型调用许可（候选生成/语义裁判等后台路径；false → 后台适配器拒绝调用，降级记录） */
    backgroundModelCalls?: boolean;
    /** 演化节律：是否随维护定时器运行（false → 仅显式 /evolve now 触发） */
    schedule?: boolean;
  };
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
  /** P2：会话任务契约（goal + success_criteria）——shadow outcome 验证契约种子；缺省仅取
   *  working_state.goal（PromptWorkingState 无 success_criteria 字段——handleRequest 经此传递请求契约） */
  task?: { goal: string; success_criteria: string[] };
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
  /** 专项 D：记忆检索 Episode 归因代理审计计数（本会话已记录 episode：attributed=外部已归因 /
   *  pending=outcome 仍 null 保持待归因——不伪造 hit/miss；归因观测面留待） */
  episode_attribution: { attributed: number; pending: number };
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

/** P3：逐对象契约化重验证结果（RepairRecord.objects 条目——verdict/disposition/score_eligible/reason 可审计） */
export interface RepairObjectOutcome {
  /** 受影响对象 id */
  id: string;
  /** 契约化 kind（ArtifactRef 'experience' → 'memory'；其余原样） */
  kind: string;
  /** 验证契约 id（repair:<objectId>） */
  contract_id: string;
  /** 三态判定（PASS/FAIL/UNKNOWN） */
  verdict: Verdict;
  /** 证据质量（0~1；decideVerdict 纯函数计算） */
  evidence_quality: number;
  /** 处置动作（clear_suspicious 由 runRepair 执行生命周期恢复；其余仅记录留后续语义） */
  disposition: RepairDisposition;
  /** 是否计入能力评分（false = 验证器不可信/外部不可控失败——不污染评分） */
  score_eligible: boolean;
  /** 中文可审计理由（损坏类型 + kind + objectId） */
  reason: string;
  /** P3.5：逐检查结果聚合（检查名=result；'；' 分隔——审计可回溯；执行器不可用 → 缺省） */
  detail?: string;
}

/** R5+P3：repair 任务结果（契约化重验证审计；落盘 .evolution/repair/<ts>.json） */
export interface RepairRecord {
  /** 本次重验证时间戳（epoch ms） */
  ts: number;
  task: 'repair';
  /** 本次扫描的 decay 记录数 */
  decay_records: number;
  /** 去重后的受影响对象（全部 decay 记录合并） */
  affected_objects: ArtifactRef[];
  /** 契约化重验证通过（verdict=PASS）的对象（P3：原「确认存在并记录重验证」语义升级为 PASS 语义） */
  reverified: ArtifactRef[];
  /** 引用对象已删除（无可修，跳过留痕） */
  missing: ArtifactRef[];
  /** P3：逐对象契约化验证结果（id/kind/contract_id/verdict/evidence_quality/disposition/score_eligible/reason） */
  objects: RepairObjectOutcome[];
}

/** 事件库整理阈值（已知问题《事件库体积增长》修复：超此体积才触发 VACUUM——避免频繁重写整库；§17 可标定） */
export const EVENT_STORE_VACUUM_THRESHOLD_BYTES = 64 * 1024 * 1024;
/** 数据清理任务入队间隔（已知问题《数据体积与清理》：轮转/整理/合并按此节流，不每轮重复入队；§17 可标定） */
export const HYGIENE_ENQUEUE_INTERVAL_MS = 60 * 60 * 1000;

/** 按线解析结果（policy/processes 目录 + 快照信息 + 降级原因） */
interface LineDirResolution {
  policyDir: string;
  processesDir: string;
  lineSnapshot: LineSnapshotInfo | null;
  lineDegraded: string | null;
}

/**
 * S7：per-session shadow 路由结果（prepareTurn 内部；route=true → 会话按 latest 线运行）。
 * exposure/outcome 落盘共用（candidate_id/bucket/task_domain——与 readShadowSignals 计数键对齐）。
 */
interface ShadowRoute {
  route: boolean;
  bucket: number;
  /** exposure 条目 candidate_id（缺省 'latest' 标记——无演化对象时；有 → latest 线最近演化对象 id） */
  candidate_id: string;
  /** 判定原因（可审计；非路由路径 = 不路由原因） */
  reason: string;
  /** 任务域（缺省 'general'；真实任务域判定留待语义扩展——注释见 recordShadowExposure） */
  task_domain: string;
}

/** S5：kern_bench 数据源结果（v2 契约基准摘要；失败 ok:false + detail——kern-tools.ts 桥消费） */
export interface BenchV2ToolResult {
  ok: boolean;
  line: BenchLine;
  mode: 'real' | 'replay';
  passed: number;
  total: number;
  judge_enabled: boolean;
  judge_run: number;
  judge_degraded: number;
  judge_rate: number;
  persisted: boolean;
  detail?: string;
  /** P4：bench 契约适配层摘要行（逐任务经 bench-contract 映射为验证契约判定；如「验证契约：PASS 20/20」） */
  verification_text?: string;
}

/** S5：kern_switch 数据源结果（版本线切换执行摘要；无 /mode 空白会话守卫——见 switchLine 方法注释） */
export interface SwitchLineToolResult {
  ok: boolean;
  text: string;
  previous_line: string;
  line: string;
  /** 快照是否已重建（false = 切换状态生效但快照保持——降级见 degraded） */
  rebuilt: boolean;
  degraded: string | null;
  /** 激活记录事件入链数（尽力而为） */
  events_appended: number;
}

/** S5：kern_memory 单条检索摘要（id/kind/scope/value/snippet） */
export interface MemoryRetrievalEntry {
  id: string;
  kind: string;
  scope: string;
  prov_class: string;
  updated: string;
  value: number;
  snippet: string;
}

/** S5：kern_memory 数据源结果（retrieve 路由摘要；失败 ok:false + degraded——kern-tools.ts 桥消费） */
export interface MemoryRetrievalToolResult {
  ok: boolean;
  items: MemoryRetrievalEntry[];
  channel_used: string;
  /** 实际参与召回的通道（双通道融合可观测面：如 ['lexical','vector']；时序组为 ['episode']） */
  channels_used: string[];
  scope_chain: string[];
  degraded: string | null;
}

/** W1（未接线审计修复 2026-08-25）：画像写入数据源结果（kern_profile——Profile 记忆 Global 作用域；
 *  created=true 新建 / updated=true 更新 / 失败 → degraded 非空（不抛）） */
export interface ProfileUpsertResult {
  id: string;
  kind: 'Profile';
  scope: string;
  created: boolean;
  updated: boolean;
  degraded: string | null;
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
  /** P3.6：验证数据面根目录（<root>/.evolution/verification——事实库/基线库/任务库 JSON 注册面） */
  readonly verificationRoot: string;
  /** P3.6：事实库（已确认 Claim 的当前有效性——finalizeTurn 自动填充 / 无矛盾检查只读） */
  readonly factStore: FactStore;
  /** P3.6：基线库（版本化基线 {输入+环境指纹+运行时快照+期望结果+验证器版本}——runRepair 首次验证
   *  通过自动注册 / 版本化对比检查只读） */
  readonly baselineStore: BaselineStore;
  /** P3.6：任务库（Task Contract/Success Criteria/Verifier 注册面；当前无执行器消费——留后续） */
  readonly taskStore: TaskStore;
  /** S2：验证债务队列（shadow/repair 未决验证——writeShadowOutcome/runRepair 入队；维护期
   *  verification_review 复核（空白子代理单次裁判）；恒构造（缺省 <verificationRoot>/debt.jsonl）） */
  readonly verificationDebt: VerificationDebt;
  /** S2：单次结构化 Judge 执行器（装配面注入 spawnJudge；null = 未注入 → judge 不可用，
   *  复核按不可用转人工（诚实降级——不假装判定）） */
  readonly judgeExecutor: JudgeExecutor | null;
  /** W3：dynamicCordisRunner 增强通道（候选验证脚本经动态插件半执行；未注入 → undefined——管线守卫
   *  降级受限子进程路径，既有行为不变） */
  readonly dynamicRunner: DynamicCordisRunnerLike | undefined;
  /** S4：事件驱动制品索引（.evolution/artifacts/index.jsonl——最近产物查询面；装配即用，构造零 I/O） */
  readonly artifactIndex: ArtifactIndex;
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
  /** P3.5：Repair 真实验证执行器（实例缓存——重复执行幂等；rebuildSnapshotForLine 线切换后重建） */
  private repairExecutors: RepairExecutors | null = null;
  /** P3.5：执行器构造失败降级原因（无 → null；构造失败 → repair 全检查 unknown 降级记录不抛） */
  private repairExecutorsDegraded: string | null = null;
  /** S1：World/Self 模型缓存（视图 + 模型——首次访问装配，promote/rebuildSnapshotForLine 后重置；
   *  同 runtime 状态 → 同视图 → 同模型内容（确定性）；装配为纯读取无副作用） */
  private modelCache: { view: RuntimeView; world: WorldModel; self: SelfModel } | null = null;
  // ---- S7：per-session shadow 路由（实现规格 §5.3 + G4 真实放量）----
  /** S7：trusted-latest commit 记忆化（undefined=未解析；string=commit；null=缺失/不可解析——
   *  失败缓存防每请求 git 探测；rebuild/promote/候选晋升后失效重建） */
  private trustedLatestCommit: string | null | undefined;
  /** S7：candidate_id 记忆化（{commit, id}——trusted-latest commit 变化时重解析（git ls-tree）） */
  private shadowCandidateCache: { commit: string; id: string } | null = null;
  /** S7：latest 线策略/过程 bundle（per-line 记忆化——首次 shadow 请求加载后缓存；
   *  与 ready() 协调：ready 仍加载装配线，shadow 请求用 per-line bundle；加载失败 → 降级回退装配线 + 记录） */
  private shadowBundle: Promise<{ policy: PolicyBundle; processes: readonly ProcessDef[] }> | null = null;
  /** S7：latest 线 bundle 加载失败标记（记忆化失败——不重复尝试；rebuild/promote 后重置可重试） */
  private shadowBundleFailed = false;
  /** S7：per-line 运行时快照身份（line → RuntimeSnapshot；内容寻址——线 commit/内容变化时失效重建） */
  private readonly shadowSnapshots = new Map<string, RuntimeSnapshot>();
  /** S7：shadow 会话 → 路由信息（exposure 已落盘；finalizeTurn 据此回写 outcome——(session,candidate) 键对齐 L2） */
  private readonly shadowSessions = new Map<string, ShadowRoute>();
  /** S7：per-line WorldModel 视图（worldModelFor——同线同状态 → 同模型；runtime 级 modelCache 不含 shadow 线） */
  private readonly perLineWorldModels = new Map<string, WorldModel>();
  // ---- 专项 D：记忆检索 Episode 采样与归因（评审问题一） ----
  /** prepareTurn 检索采样率（opts.episodeSampleRate；缺省 0.02 = 2%；kern_memory 恒记录不受此限） */
  private readonly episodeSampleRate: number;
  /** per-session 单调 turn 计数（确定性采样 token——同会话同序 → 同判定；重启后重置可接受，采样非契约） */
  private readonly sessionTurnCounters = new Map<string, number>();
  /** 会话 → prepareTurn 采样记录的 episode id 集（finalizeTurn 归因代理的归属面；retrieval_episode 表
   *  无 session 列，会话归属只能在记录点（prepareTurn）捕获；kern_memory 无会话上下文不入此面） */
  private readonly sessionEpisodes = new Map<string, Set<string>>();
  /** 来源子系统最近一次「执行体成功跑完」时间（债务释放的确认依据；本进程内真实观测，不跨进程推断） */
  private readonly lastSubsystemOk = new Map<string, number>();
  /** 归因观测面：会话 → 上一轮待归因的 episode 与注入集（下一次 prepareTurn 用新人类消息归因） */
  private readonly sessionAttribution = new Map<string, { episode_id: string; injected_ids: string[] }>();
  /** 归因观测面：会话 → 已给出结论（hit/miss）的记忆 id（会话内不重复计数） */
  private readonly attributedMemories = new Map<string, Set<string>>();
  /** 归因观测计数（状态面可读：本次进程内累计 已归因 / 证据不足） */
  private readonly attributionCounts = { attributed: 0, skipped: 0 };
  /** 数据清理任务节流：上次入队时间（避免每轮重复入队；缺省每小时一次） */
  private lastHygieneEnqueueAt = 0;
  /** 外核安全状态视图注入（装配面提供；缺省 → 状态面不带 safe_state 段） */
  private readonly safeStateViewFn: (() => KernStatusSummary['safe_state']) | undefined;
  /**
   * 制品发现根集合（已知问题《制品索引未建立》修复：发现根不再只有仓库根）。
   * 缺省 = [仓库根 HERE]；装配面可注入会话工作目录等真实工作根（逐根尝试解析，全部未命中 →
   * 记为不可恢复制品而非丢弃）。去重保序。
   */
  readonly artifactRoots: string[];
  /** 自迭代开关面（opts.selfIteration；缺省全启用 = 既有行为不变） */
  private readonly selfIteration: {
    enabled: boolean;
    minStrength: number;
    backgroundModelCalls: boolean;
    schedule: boolean;
  };
  /** 最近一次演化判定的触发来源（写入自迭代状态，便于区分维护定时器与 /evolve now） */
  private evolutionStateTrigger = 'maintenance:evolution_decision';

  constructor(opts: CognitiveAssemblyOptions = {}) {
    // R6：宿主版本唯一来源注入（装配期；提供 → setHostVersion 覆写——运行时指纹采集与事件
    // provenance 的 dsh_version 全部经 hostVersion() 读取同一值；缺省 DSH_HOST_VERSION）
    if (opts.hostVersion !== undefined) {
      setHostVersion(opts.hostVersion);
    }
    // 专项 D：记忆检索 Episode 采样率（缺省 0.02；非法值 fail-loud——显式配置契约违反应显式暴露；
    // 校验置于构造最前：在任何 db/存储打开之前抛错——不留半构造泄漏的句柄）
    if (opts.episodeSampleRate !== undefined) {
      const r = opts.episodeSampleRate;
      if (!Number.isFinite(r) || r < 0 || r > 1) {
        throw new Error(`CognitiveRuntime: episodeSampleRate 非法 ${String(r)}（应为 [0,1]）`);
      }
      this.episodeSampleRate = r;
    } else {
      this.episodeSampleRate = EPISODE_SAMPLE_RATE_DEFAULT;
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
    // 自迭代开关（agent.cordis.yml 插件配置面；缺省全启用 = 既有行为不变）
    const si = opts.selfIteration ?? {};
    this.selfIteration = {
      enabled: si.enabled !== false,
      minStrength: typeof si.minStrength === 'number' && Number.isFinite(si.minStrength) && si.minStrength >= 0
        ? si.minStrength
        : 0,
      backgroundModelCalls: si.backgroundModelCalls !== false,
      schedule: si.schedule !== false,
    };
    this.checkpointDir = opts.checkpointDir;
    this.maintenance = opts.maintenance ?? null;
    this.safeStateViewFn = opts.safeStateView;
    // 制品发现根集合（会话工作目录优先，仓库根兜底；去重保序）
    const roots = [opts.workspaceRoot, ...(opts.artifactRoots ?? []), HERE].filter(
      (r): r is string => typeof r === 'string' && r.length > 0,
    );
    this.artifactRoots = [...new Set(roots)];
    this.signalsDir = opts.signalsDir ?? signalsDirOf(root);
    this.evolutionRoot = opts.evolutionRoot ?? join(root, '.evolution');
    // P3.6：验证数据面三库装配（JSON 文件注册面；构造不触 I/O——首写建目录；缺省
    // <root>/.evolution/verification——与 signals/decay/repair 同 .evolution 根系；测试注入临时目录隔离）
    this.verificationRoot = opts.verificationRoot ?? join(root, '.evolution', 'verification');
    const verificationStores = createVerificationStores(this.verificationRoot);
    this.factStore = verificationStores.facts;
    this.baselineStore = verificationStores.baselines;
    this.taskStore = verificationStores.tasks;
    // S2：验证债务队列装配（缺省 <verificationRoot>/debt.jsonl 内部构造——构造零 I/O 首写建目录；
    // 测试注入隔离队列；judgeExecutor 未注入 → null = judge 不可用，诚实降级）
    this.verificationDebt = opts.verificationDebt ?? new VerificationDebt({ root: this.verificationRoot });
    this.judgeExecutor = opts.judgeExecutor ?? null;
    // W3：dynamicCordisRunner 增强通道（plugin.ts 装配面注入；未注入 → undefined——管线守卫降级受限子进程路径）
    this.dynamicRunner = opts.dynamicRunner;
    // S4：制品索引装配（缺省 <evolutionRoot>/artifacts = <root>/.evolution/artifacts——与 signals/
    // decay/repair/verification 同 .evolution 根系；构造零 I/O 首写建目录；测试注入临时目录隔离）
    this.artifactIndex = new ArtifactIndex({
      root: opts.artifactIndexRoot ?? join(this.evolutionRoot, 'artifacts'),
    });
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
    const policy = await this.policyPromise;
    // S2：维护成本数据化——装配读取 policy.evolve.maintenance_costs → 注入维护调度器
    //（缺省成本面：enqueue 未给 estimated_cost 且任务 id 命中 → policy 成本；改 evolve.yaml 即生效）
    this.maintenance?.setMaintenanceCosts(policy.evolve.maintenance_costs);
    // 债务阈值接线（已知问题「债务阈值未与策略接线」）：policy.evolve.debt_thresholds（soft/hard/critical）
    // → 维护调度器；与 kernel/evolve-decision.ts decideEvolution 的「债务 ≥ hard → 不演化」同源，
    // 改 evolve.yaml 即同时改变调度器硬限行为与判定门禁（两处不再各持一套缺省值）。
    // 非法项由调度器丢弃并返回说明 → 记录降级（不静默采用错值）。
    if (this.maintenance !== null) {
      const bad = this.maintenance.setLimits({
        soft: policy.evolve.debt_thresholds.soft,
        hard: policy.evolve.debt_thresholds.hard,
        critical: policy.evolve.debt_thresholds.critical,
      });
      if (bad.length > 0) {
        recordDegradation('maintenance/limits', `债务阈值非法项已忽略：${bad.join(', ')}`);
      }
    }
    return { policy, processes: await this.processesPromise };
  }

  /**
   * P5：生产路径 Generator 装配（架构 §5.3 Generate 阶梯生产接线）——ProcessScheduler 经组合根注入
   * ModelAdapter（触发条件③）+ generation 预算（触发条件②，policy.budget.generation 数据化）→
   * 阶梯 Reuse→Compose→Mutate 均不满足（OOD）且预算允许且 adapter 存在时才走 LLM；缺任一 → 纯规则降级。
   * 真实会话才有模型（plugin.ts 装配 modelAdapter）；真实模型调用留宿主验证——测试用 fake adapter 验证触发逻辑。
   * 每次调用构造新调度器/生成器 → generator 的 generationUsed 计数器即单请求语义（max_generate_per_request）。
   * S7：可注入生效线 policy（shadow 会话 = latest 线 bundle——generation 预算按线加载；缺省 → 装配线 ready()）。
   */
  async createScheduler(processes: readonly ProcessDef[], policy?: PolicyBundle): Promise<ProcessScheduler> {
    const effective = policy ?? (await this.ready()).policy;
    return new ProcessScheduler({
      processes,
      generation: effective.budget.generation,
      // 后台模型调用许可（并发受限环境：并发 1 时禁止后台模型调用——已知问题《并发能力未知》）。
      // 不允许时传 undefined：生成阶梯自动降级为纯规则（不发模型调用），不抛错、不阻塞请求路径。
      modelAdapter: this.selfIteration.backgroundModelCalls ? (this.modelAdapter ?? undefined) : undefined,
    });
  }

  /** 后台模型调用是否许可（候选生成/语义裁判等后台路径；状态面与装配面共用） */
  backgroundModelCallsAllowed(): boolean {
    return this.selfIteration.backgroundModelCalls && this.modelAdapter !== null;
  }

  /** 自迭代开关面快照（状态面可读——回答「为什么没有演化」时先看开关） */
  selfIterationConfig(): { enabled: boolean; min_strength: number; background_model_calls: boolean; schedule: boolean } {
    return {
      enabled: this.selfIteration.enabled,
      min_strength: this.selfIteration.minStrength,
      background_model_calls: this.selfIteration.backgroundModelCalls,
      schedule: this.selfIteration.schedule,
    };
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
    return this.statusFor();
  }

  /**
   * 带可选线参数的状态摘要（已知问题《需要"查看自迭代状态"的快速工具》：扩展现有状态工具，
   * 不新增工具）——`line` 给出时附带该线状态（提交、与其它线的领先/落后关系）；
   * `evolution: true`（缺省）附带自迭代状态段：最近判定结论与原因、信号计数、债务快照、
   * 门禁逐项与开关面（回答"为什么没有演化"）。
   */
  async statusFor(input: { line?: VersionLine; evolution?: boolean } = {}): Promise<KernStatusSummary> {
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
    // S2：维护观测摘要（今日任务数 + 各任务平均耗时；调度器缺失/读取失败 → null + 降级字段，不抛）
    let maintenance_observations: KernStatusSummary['maintenance_observations'] = null;
    let observations_degraded: string | null = null;
    // 债务来源与释放面（已知问题《债务是保护性自锁》：状态面要能回答「这条债是哪来的、
    // 为什么没放、哪些进了人工裁定」——纯读取，调度器缺失 → null，不抛）
    let debt_sources: DebtSourceView[] | null = null;
    let debt_pending_manual: DebtSourceView[] = [];
    let debt_release_audit: DebtReleaseRecord[] = [];
    let debt_limits: ReturnType<MaintenanceScheduler['limitsSnapshot']> | null = null;
    if (this.maintenance !== null) {
      try {
        debt_sources = this.maintenance.debtSourceView();
        debt_pending_manual = this.maintenance.manualPendingDebt();
        debt_release_audit = this.maintenance.debtReleaseAudit();
        debt_limits = this.maintenance.limitsSnapshot();
      } catch (err) {
        observations_degraded = observations_degraded ?? errorDetail(err);
      }
      try {
        maintenance_observations = this.maintenance.observationsSummary();
      } catch (err) {
        observations_degraded = errorDetail(err);
      }
    }
    // 自迭代状态段（缺省附带；读取失败 → null + 降级说明，不抛）
    let evolution: KernStatusSummary['evolution'] = null;
    if (input.evolution !== false) {
      try {
        evolution = await this.evolutionStateView(input.line);
      } catch (err) {
        evolution = { degraded: errorDetail(err) } as KernStatusSummary['evolution'];
      }
    }
    return {
      line: this.lineSnapshot?.line ?? 'stable',
      snapshot_hash: this.snapshotHash,
      line_snapshot: this.lineSnapshot
        ? { line: this.lineSnapshot.line, commit: this.lineSnapshot.commit, dir: this.lineSnapshot.dir }
        : null,
      line_degraded: this.lineDegraded,
      debt: this.maintenance?.debtSnapshot() ?? [],
      debt_sources,
      debt_pending_manual,
      debt_release_audit,
      debt_limits,
      evolution,
      safe_state: this.safeStateViewFn === undefined ? undefined : this.safeStateViewFn(),
      memory_vector: this.memory.vectorStats(),
      relations: this.relationStats(),
      maintenance_observations,
      observations_degraded,
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

  // ---- S5：kern_* 工具数据源（kern-tools.ts 桥的运行时方法——复用既有能力薄封装，非命令 handler） ----

  /**
   * S5：kern_bench 数据源——v2 契约基准（与 /bench v2 分支同款 runBenchV2 接线：无 modelAdapter → 回放
   * 执行器；有 → 真实执行 + LLM judge 对照；persist 缺省落盘明细到 benchReportsDir/BENCH_REPORTS_DIR）。
   * 参数 line 缺省当前线（非法值 → 当前线）；任一步失败 → ok:false + detail（不崩）。
   * 注：/bench 命令 handler（plugin.ts）保持独立接线（benchPersistDir 为插件配置面）——本方法供 kern_bench
   * 复用同一 runBenchV2 契约与执行器选择逻辑，两处语义一致。
   */
  async benchV2(input: { line?: VersionLine; persist?: boolean } = {}): Promise<BenchV2ToolResult> {
    const line: BenchLine = isVersionLine(input.line) ? input.line : (this.lineSnapshot?.line ?? 'stable');
    // modelAdapter 缺省为 null（未注入）——null/undefined 均视作无适配器（回放路径）；与 assembleModelView
    // 的 modelAdapterAvailable 同语义
    const hasAdapter = this.modelAdapter !== null && this.modelAdapter !== undefined;
    const mode: 'real' | 'replay' = hasAdapter ? 'real' : 'replay';
    const disabled = { judge_enabled: false, judge_run: 0, judge_degraded: 0, judge_rate: 0 };
    try {
      const contracts = await loadBenchContractsV2();
      const fixtures = await loadBenchFixturesV2();
      const fixtureById = new Map(fixtures.map((f): [string, BenchFixtureV2] => [f.task_id, f]));
      const realV2 = hasAdapter ? makeRealExecutorV2(this.modelAdapter!) : undefined;
      const executor: BenchExecutorV2 =
        realV2 !== undefined ? (task) => realV2(task, fixtureById.get(task.id)!) : makeReplayExecutorV2(fixtures);
      const judge = hasAdapter ? makeJudgeV2(this.modelAdapter!) : undefined;
      const persist = input.persist !== false;
      const report = await runBenchV2({
        contracts,
        fixtures,
        line,
        executor,
        mode,
        persistDir: persist ? (this.assemblyOpts.benchReportsDir ?? BENCH_REPORTS_DIR) : undefined,
        judge,
      });
      // P4 加性：bench 契约适配层（逐任务经 bench-contract 映射为验证契约判定——同一套
      // Contract/Evidence/Result 语义覆盖 bench；不修改 runBenchV2 逻辑/输出结构——冻结基准零风险；
      // 适配层失败 → verification_text 缺省（加性降级，不阻断基准结果））
      let verification_text: string | undefined;
      try {
        const counts = { PASS: 0, FAIL: 0, UNKNOWN: 0 };
        const contractById = new Map(contracts.map((c): [string, BenchContractV2] => [c.id, c]));
        for (const r of report.results) {
          const task = contractById.get(r.task_id);
          if (task === undefined) {
            continue;
          }
          const contract = benchContractFromTask({ id: task.id, prompt: task.requirement });
          // parse_ok 以 passed 为代理（report 仅携带 passed；passed ⇒ 输出可解析且过 schema）
          const evidence = benchEvidenceFromResult(contract, { passed: r.passed, parse_ok: r.passed });
          counts[decideVerdict(contract, [evidence]).verdict]++;
        }
        verification_text =
          `验证契约：PASS ${counts.PASS}/${report.total}（FAIL ${counts.FAIL}；UNKNOWN ${counts.UNKNOWN}）`;
      } catch {
        verification_text = undefined; // 加性降级：适配层异常不阻断基准摘要
      }
      return {
        ok: true,
        line: report.line,
        mode,
        passed: report.passed,
        total: report.total,
        judge_enabled: report.judge.enabled,
        judge_run: report.judge.run,
        judge_degraded: report.judge.degraded,
        judge_rate: report.judge.rate,
        persisted: persist,
        verification_text,
      };
    } catch (err) {
      return { ok: false, line, mode, passed: 0, total: 0, ...disabled, persisted: false, detail: errorDetail(err) };
    }
  }

  /**
   * S5：kern_switch 数据源——版本线切换（与 /mode onSwitch 同语义：校验（isVersionLine）+ 快照重建
   * （rebuildSnapshotForLine）+ 激活记录（activation/committed 事件入链，尽力而为））。
   * **与 /mode 的差异**：/mode 命令有空白会话守卫（mode-command.ts isBlankSession——用户在会话开始前
   * 切换才允许）；本方法由模型在运行中显式调用（= 显式意图，DSH 会话必然非空白）→ 无空白守卫，
   * 差异在返回文本注明。同当前线 → 无副作用早退。M6 激活契约落盘（activationLogDir，插件配置面）不适用
   * 工具路径——激活记录以事件入链承载（诚实差异，/mode recordLineActivation 仍完整保留）。
   */
  async switchLine(input: { line: string; session_id?: string }): Promise<SwitchLineToolResult> {
    const previous = this.lineSnapshot?.line ?? 'stable';
    if (!isVersionLine(input.line)) {
      return {
        ok: false,
        text: `未知版本线 "${input.line}"（合法值 ${VALID_LINES.join(' | ')}）`,
        previous_line: previous,
        line: input.line,
        rebuilt: false,
        degraded: null,
        events_appended: 0,
      };
    }
    if (previous === input.line) {
      return {
        ok: true,
        text: `已是当前版本线 ${input.line}（无需切换）`,
        previous_line: previous,
        line: input.line,
        rebuilt: false,
        degraded: null,
        events_appended: 0,
      };
    }
    const r = this.rebuildSnapshotForLine(input.line);
    // 激活记录（事件入链；尽力而为——失败不阻断切换结果，对齐 /mode recordLineActivation 降级记录语义）
    let events_appended = 0;
    try {
      await this.eventStore.append(
        makeRuntimeEvent(
          'activation/committed',
          input.session_id ?? 'anon',
          this.snapshotHash,
          { line: input.line, previous_line: previous, trigger: 'kern_switch' },
          ['kern-switch'],
        ),
      );
      events_appended = 1;
    } catch {
      // 事件为日志，失败不阻断切换结果
    }
    const guardNote = '；kern_switch 由模型显式调用（=显式意图），无 /mode 空白会话守卫';
    if (r.promoted) {
      return {
        ok: true,
        text: `已切换到版本线 ${input.line}（快照已重建——下一请求生效${guardNote}）`,
        previous_line: previous,
        line: input.line,
        rebuilt: true,
        degraded: null,
        events_appended,
      };
    }
    return {
      ok: true,
      text: `已切换到版本线 ${input.line}（快照重建降级：${r.degraded}——切换状态生效，快照保持${guardNote}）`,
      previous_line: previous,
      line: input.line,
      rebuilt: false,
      degraded: r.degraded,
      events_appended,
    };
  }

  /**
   * S5：kern_memory 数据源——记忆检索查询（复用 memory/retrieve 六阶段路由：scope 覆盖链/kind 过滤/
   * 通道选择/价值排序；专项 D：显式记忆工具、低频高价值 → **恒记录 Retrieval Episode**
   * （opts.episode=true，不受 episodeSampleRate 采样限制——每次显式检索都是归因数据；outcome 留待
   * 归因观测面，见 finalizeTurn 归因代理与 signal-collectors scope_recorded））。
   * scope/kind/limit 非法 → MemoryQuerySchema fail-loud → ok:false + degraded（不抛）；无匹配 → 空
   * items（ok:true）。
   */
  async retrieveMemory(input: {
    text?: string;
    scope?: string;
    kind?: string;
    limit?: number;
    relation?: string;
  } = {}): Promise<MemoryRetrievalToolResult> {
    try {
      const q: RetrieveQuery = {
        scope: (input.scope ?? 'Project') as Scope,
        limit: input.limit ?? 5,
        budget: 1000,
      };
      if (input.text !== undefined && input.text.length > 0) {
        q.text = input.text;
      }
      if (input.relation !== undefined && input.relation.length > 0) {
        q.relation = input.relation;
      }
      if (input.kind !== undefined && input.kind.length > 0) {
        q.kind = input.kind as MemoryKind;
      }
      const r = await retrieve(this.memory, q, { episode: true });
      return {
        ok: true,
        items: r.items.map((it) => ({
          id: it.memory.id,
          kind: it.memory.kind,
          scope: it.memory.scope,
          prov_class: it.memory.prov_class,
          updated: it.memory.updated,
          value: it.value,
          snippet: memorySnippet(it.memory.payload),
        })),
        channel_used: r.channel_used,
        channels_used: r.channels_used,
        scope_chain: r.scope_chain,
        degraded: null,
      };
    } catch (err) {
      return { ok: false, items: [], channel_used: 'lexical', channels_used: [], scope_chain: [], degraded: errorDetail(err) };
    }
  }

  /**
   * 记忆管理面数据源（已知问题《缺少写入面与记忆管理面》修复）：写入 / 列出 / 查看 / 编辑 / 删除 / 合并。
   * 全部薄封装 `memory/manage.ts`（写入流水：去重 → 污染标记 → 落库 → 同步编码）；
   * 失败 → ok:false + degraded（不抛——工具面降级语义对齐 kern_*）。
   */
  async manageMemory(input: {
    op: 'write' | 'list' | 'view' | 'edit' | 'delete' | 'merge' | 'relations' | 'unlink';
    text?: string;
    id?: string;
    target_id?: string;
    kind?: string;
    scope?: string;
    lifecycle?: string;
    prov_class?: string;
    polluted?: boolean;
    limit?: number;
    type?: string;
  }): Promise<{
    ok: boolean;
    op: string;
    id: string | null;
    deduplicated: boolean;
    encoded: boolean;
    items: MemoryManageEntry[];
    total: number;
    item: MemoryManageEntry | null;
    relations: MemoryRelationEntry[];
    degraded: string | null;
  }> {
    const empty = {
      ok: false,
      op: input.op,
      id: null,
      deduplicated: false,
      encoded: false,
      items: [] as MemoryManageEntry[],
      total: 0,
      item: null as MemoryManageEntry | null,
      relations: [] as MemoryRelationEntry[],
      degraded: null as string | null,
    };
    try {
      switch (input.op) {
        case 'write': {
          const r = await writeMemory(this.memory, {
            text: input.text ?? '',
            ...(input.kind !== undefined ? { kind: input.kind as MemoryKind } : {}),
            ...(input.scope !== undefined ? { scope: input.scope as Scope } : {}),
            ...(input.lifecycle !== undefined ? { lifecycle: input.lifecycle as MemoryLifecycle } : {}),
            ...(input.prov_class !== undefined ? { prov_class: input.prov_class as MemoryProvClass } : {}),
            ...(input.polluted !== undefined ? { polluted: input.polluted } : {}),
          });
          return { ...empty, ok: r.ok, id: r.id, deduplicated: r.deduplicated, encoded: r.encoded, degraded: r.degraded };
        }
        case 'list': {
          const r = await listMemories(this.memory, {
            ...(input.scope !== undefined ? { scope: input.scope as Scope } : {}),
            ...(input.kind !== undefined ? { kind: input.kind as MemoryKind } : {}),
            ...(input.lifecycle !== undefined ? { lifecycle: input.lifecycle as MemoryLifecycle } : {}),
            ...(input.text !== undefined ? { text: input.text } : {}),
            ...(input.limit !== undefined ? { limit: input.limit } : {}),
          });
          return { ...empty, ok: r.ok, items: r.items, total: r.total, degraded: r.degraded };
        }
        case 'view': {
          const r = await viewMemory(this.memory, input.id ?? '');
          return { ...empty, ok: r.ok, id: input.id ?? null, item: r.item, degraded: r.degraded };
        }
        case 'edit': {
          const r = await editMemory(this.memory, input.id ?? '', {
            ...(input.text !== undefined ? { text: input.text } : {}),
            ...(input.lifecycle !== undefined ? { lifecycle: input.lifecycle as MemoryLifecycle } : {}),
            ...(input.kind !== undefined ? { kind: input.kind as MemoryKind } : {}),
            ...(input.scope !== undefined ? { scope: input.scope as Scope } : {}),
          });
          return { ...empty, ok: r.ok, id: r.id, encoded: r.encoded, degraded: r.degraded };
        }
        case 'delete': {
          const r = await deleteMemory(this.memory, input.id ?? '');
          return { ...empty, ok: r.ok, id: input.id ?? null, degraded: r.degraded };
        }
        case 'merge': {
          const r = await mergeMemories(this.memory, input.id ?? '', input.target_id ?? '');
          return { ...empty, ok: r.ok, id: r.target_id, degraded: r.degraded };
        }
        case 'relations': {
          // 关系边治理面（已知问题《关系图为空图》）：列出与某条记忆相连的边（含权重/来源/方向）
          const r = listRelations(this.memory, {
            ...(input.id !== undefined ? { id: input.id } : {}),
            ...(input.type !== undefined ? { type: input.type } : {}),
            ...(input.limit !== undefined ? { limit: input.limit } : {}),
          });
          return { ...empty, ok: r.ok, id: input.id ?? null, relations: r.items, total: r.items.length, degraded: r.degraded };
        }
        case 'unlink': {
          // 单条边删除（from=input.id、to=input.target_id、type=input.type）
          const r = unlinkRelation(this.memory, { from: input.id ?? '', to: input.target_id ?? '', type: input.type ?? '' });
          return { ...empty, ok: r.ok, id: input.id ?? null, degraded: r.degraded };
        }
        default:
          return { ...empty, degraded: `未知 op: ${String(input.op)}（合法值：write|list|view|edit|delete|merge|relations|unlink）` };
      }
    } catch (err) {
      return { ...empty, degraded: errorDetail(err) };
    }
  }

  /**
   * W1（未接线审计修复 2026-08-25）：画像写入数据源——用户画像 = 单条 Profile 记忆（确定性 id
   * 'profile:user'，Global 作用域——跨项目可检索）。不存在 → 新建（kind='Profile'，prov_class=
   * 'User-declared'，scope='Global'）；已存在 → 更新 payload：replace=true 覆写 / 缺省（false/未提供）
   * 合并追加（新文本未包含于既有 payload 时以换行追加，已包含 → payload 不变仅刷新 updated——去重）。
   * 校验：profile 非空字符串（空 → degraded 非法输入）；失败 → degraded 字段（不抛，工具面降级语义
   * 对齐 kern_*）；尽力而为（单条记录 upsert，不触碰其它记忆/事件面）。
   */
  async upsertProfile(input: { profile: string; replace?: boolean }): Promise<ProfileUpsertResult> {
    const profile = typeof input?.profile === 'string' ? input.profile : '';
    if (profile.trim().length === 0) {
      return {
        id: PROFILE_MEMORY_ID,
        kind: 'Profile',
        scope: 'Global',
        created: false,
        updated: false,
        degraded: '非法输入：profile 必须为非空字符串',
      };
    }
    try {
      const existing = await this.memory.getById(PROFILE_MEMORY_ID);
      if (existing === undefined) {
        // 不存在 → 新建（单条画像记录；provenance.event = 确定性 id——幂等键防重复 ingest）
        const now = new Date().toISOString();
        const record: Memory = {
          ir_version: '2.0',
          id: PROFILE_MEMORY_ID,
          schema: 'omb/M1',
          scope: 'Global',
          lifecycle: 'Active',
          immutable: false,
          owner: 'kernel',
          created: now,
          updated: now,
          provenance: {
            source: 'kern_profile',
            event: PROFILE_MEMORY_ID,
            actor: 'user',
            environment: this.fingerprintCollector(),
            runtime_snapshot: this.snapshotHash,
            timestamp: now,
            transformation_chain: [],
            verification: 'kern_profile',
          },
          refs: [],
          kind: 'Profile',
          prov_class: 'User-declared',
          payload: profile,
          value_score: 0.9, // 用户声明画像高价值（初值占位，§17 标定）
          utility_counts: { retrieval: 0, hit: 0, miss: 0, inject: 0, decay: 0, promote: 0 },
        };
        const id = await this.memory.ingest(record);
        return { id, kind: 'Profile', scope: 'Global', created: true, updated: false, degraded: null };
      }
      // 已存在 → 更新 payload（replace=true 覆写 / 缺省合并追加去重；updated 由 backend.update 刷新）
      const merged =
        input.replace === true
          ? profile
          : existing.payload.includes(profile)
            ? existing.payload
            : `${existing.payload}\n${profile}`;
      await this.memory.update(PROFILE_MEMORY_ID, { payload: merged });
      return { id: PROFILE_MEMORY_ID, kind: 'Profile', scope: 'Global', created: false, updated: true, degraded: null };
    } catch (err) {
      return {
        id: PROFILE_MEMORY_ID,
        kind: 'Profile',
        scope: 'Global',
        created: false,
        updated: false,
        degraded: errorDetail(err),
      };
    }
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

  /**
   * S7：per-session 生效版本线（实现规格 §5.3 真实放量路由）——shadow 桶会话 → 'latest'
   * （trusted-latest 存在且与当前线分叉时），否则当前（装配）线。判定为纯函数 shouldRouteShadow
   * 的运行时装配（commit/candidate_id 记忆化解析；无 trusted-latest 差异/未启用 → 当前线，零开销）。
   * async 原因：shadow 配置源 = 装配线策略（ready() 懒加载——机制即数据，改 YAML 即生效）。
   */
  async effectiveLineFor(sessionId: string): Promise<VersionLine> {
    const { policy } = await this.ready();
    const route = await this.computeShadowRoute(sessionId, policy.evolve.shadow);
    if (route.route) {
      return 'latest';
    }
    return this.lineSnapshot?.line ?? 'stable';
  }

  /**
   * S7：per-request WorldModel——按会话生效线组装（S1 的 assembleModelView 用 effectiveLine）。
   * 同线同状态 → 同模型（内容寻址确定性）；生效线 = 当前线 → 复用运行时级 worldModel（既有缓存，零开销）；
   * 其它线（shadow latest）→ per-line 缓存（rebuild/promote 后失效）。纯读取无副作用。
   */
  async worldModelFor(sessionId: string): Promise<WorldModel> {
    const effLine = await this.effectiveLineFor(sessionId);
    const current = this.lineSnapshot?.line ?? 'stable';
    if (effLine === current) {
      return this.worldModel; // 运行时级模型（既有缓存）
    }
    let cached = this.perLineWorldModels.get(effLine);
    if (cached === undefined) {
      cached = buildWorldModel(this.assembleModelView(effLine));
      this.perLineWorldModels.set(effLine, cached);
    }
    return cached;
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
   * S7：可选 effectiveLine（per-request 视图——shadow 会话按生效线组装：line/commit/lineSnapshot/
   * layoutState 取自该线解析；缺省 → 当前（装配）线视图）。解析失败 → 保持当前线视图（尽力而为）。
   */
  private assembleModelView(effectiveLine?: VersionLine): RuntimeView {
    let line = this.lineSnapshot?.line ?? 'stable';
    let commit = this.lineSnapshot?.commit ?? null;
    let lineSnapshot = this.lineSnapshot;
    let lineDegraded = this.lineDegraded;
    let layoutState: 'lines-injected' | 'repo-default' =
      this.lineSnapshot !== null ? 'lines-injected' : 'repo-default';
    if (effectiveLine !== undefined && effectiveLine !== line) {
      try {
        const dirs = resolveLineDirs(this.assemblyOpts, effectiveLine);
        if (dirs.lineSnapshot !== null) {
          line = dirs.lineSnapshot.line;
          commit = dirs.lineSnapshot.commit;
          lineSnapshot = dirs.lineSnapshot;
          lineDegraded = dirs.lineDegraded;
          layoutState = 'lines-injected';
        }
      } catch {
        // 解析失败 → 保持当前线视图（尽力而为，不臆造）
      }
    }
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
      commit,
      lineSnapshot,
      lineDegraded,
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

  // ---- S7：per-session shadow 路由（实现规格 §5.3 + G4 真实放量；快路径零开销，慢路径记忆化） ----

  /**
   * S7：shadow 路由判定（配置源 = 装配线策略 shadow 段）。快路径（零开销默认路径）：
   * 未启用 / 旧布局（无线快照）/ 当前线已是 latest / trusted-latest 缺失 / 两线未分叉 → 不路由
   * （无 candidate_id 解析 I/O——bucket 仅在两线分叉后计算）；分叉 → candidate_id 记忆化解析
   * （latestObjectId → 'latest' 标记）→ shouldRouteShadow 纯函数判定（桶 < exposure_rate）。
   * trusted-latest commit 记忆化（resolveTrustedLatestCommit——失败缓存，防每请求 git 探测）。
   */
  private async computeShadowRoute(sessionId: string, shadow: ShadowPolicy): Promise<ShadowRoute> {
    const noRoute = (reason: string, bucket = 0, candidateId = 'latest'): ShadowRoute => ({
      route: false,
      bucket,
      candidate_id: candidateId,
      reason,
      task_domain: 'general',
    });
    // 快路径（零 I/O）：未启用 / 旧布局 / 已在 latest 线
    if (!shadow.enabled) {
      return noRoute('shadow 未启用（evolve.policy.shadow.enabled=false）——默认路径');
    }
    if (this.lineSnapshot === null) {
      return noRoute('旧布局（无线快照 kernel/policy）——shadow 路由不可用');
    }
    if (this.lineSnapshot.line === 'latest') {
      return noRoute('当前线已是 latest——无分流语义（会话已运行最新线）');
    }
    // trusted-latest 存在且与当前线分叉（commit 记忆化；缺失/不可解析 → 无候选线）
    const layout = this.assemblyOpts.layout ?? defaultLayout();
    const latestCommit = this.resolveTrustedLatestCommit(layout);
    if (latestCommit === null) {
      return noRoute('trusted-latest 缺失/不可解析——无候选线可路由（零开销）');
    }
    if (latestCommit === this.lineSnapshot.commit) {
      return noRoute('trusted-latest == 当前线 commit——无分叉，零开销');
    }
    // 分叉 → candidate_id（记忆化；latest 线最近演化对象 id 或 'latest' 标记）→ 桶判定（纯函数）
    const candidateId = await this.resolveShadowCandidateId(layout, latestCommit);
    const verdict = shouldRouteShadow({
      session_id: sessionId,
      candidate_id: candidateId,
      trusted_latest_commit: latestCommit,
      stable_commit: this.lineSnapshot.commit,
      policy: shadow,
    });
    return {
      route: verdict.route,
      bucket: verdict.bucket,
      candidate_id: candidateId,
      reason: verdict.reason,
      task_domain: 'general',
    };
  }

  /** S7：trusted-latest commit 记忆化解析（resolveLineCommit；缺失/失败 → null 缓存——防每请求 git 探测；
   *   rebuild/promote/switchLine/候选晋升后 invalidateShadowCaches 失效重建；外部进程推进 ref 的陈旧窗口
   *   可接受——路由仅决策分流，实际物化 ensureLineSnapshot 恒读当前 ref） */
  private resolveTrustedLatestCommit(layout: VersionLayout): string | null {
    if (this.trustedLatestCommit !== undefined) {
      return this.trustedLatestCommit;
    }
    try {
      this.trustedLatestCommit = resolveLineCommit(layout, 'latest');
    } catch {
      this.trustedLatestCommit = null; // 缺失/不可解析（含旧种子布局）——记忆化失败
    }
    return this.trustedLatestCommit;
  }

  /** S7：exposure candidate_id 记忆化（latest 线最近演化对象 id；无对象/读取失败 → 'latest' 标记——
   *   readShadowSignals 计数键 (session,candidate) 与该值对齐；trusted-latest commit 变化时重解析） */
  private async resolveShadowCandidateId(layout: VersionLayout, latestCommit: string): Promise<string> {
    if (this.shadowCandidateCache !== null && this.shadowCandidateCache.commit === latestCommit) {
      return this.shadowCandidateCache.id;
    }
    let id = 'latest';
    try {
      const objectId = await latestObjectId(layout, latestCommit);
      if (objectId !== null) {
        id = objectId;
      }
    } catch {
      // 读取失败 → 'latest' 标记（尽力而为）
    }
    this.shadowCandidateCache = { commit: latestCommit, id };
    return id;
  }

  /**
   * S7：latest 线 policy/processes 加载（per-line 记忆化：首次 shadow 请求加载后缓存——与 ready() 的一次性
   * 加载协调：ready 仍加载装配线，shadow 请求用 per-line bundle；加载失败 → 降级回退装配线 + 降级记录
   *（shadowBundleFailed 记忆化失败——不重复尝试；rebuild/promote 后重置可重试））。
   */
  private async loadShadowBundle(): Promise<{ policy: PolicyBundle; processes: readonly ProcessDef[] } | null> {
    if (this.shadowBundleFailed) {
      return null;
    }
    if (this.shadowBundle === null) {
      const line: VersionLine = 'latest';
      this.shadowBundle = (async () => {
        const dirs = resolveLineDirs(this.assemblyOpts, line);
        if (dirs.lineSnapshot === null) {
          throw new Error(dirs.lineDegraded ?? `版本线 ${line} 快照未就绪——shadow 策略/过程不可加载`);
        }
        const [policy, processes] = await Promise.all([
          loadPolicy(dirs.policyDir),
          loadProcesses(dirs.processesDir),
        ]);
        return { policy, processes };
      })();
    }
    try {
      return await this.shadowBundle;
    } catch (err) {
      this.shadowBundleFailed = true;
      recordDegradation(
        'shadow/route',
        `latest 线策略/过程加载失败（${errorDetail(err)}）——shadow 会话降级回退装配线（策略/过程按装配线加载）`,
      );
      return null;
    }
  }

  /** S7：per-line 运行时快照身份（latest 线 commit + 目录内容 + 组件 → M5 快照；内容寻址记忆化；
   *   构建失败 → null——调用方降级回退当前线快照） */
  private resolveLineSnapshotIdentity(line: VersionLine): RuntimeSnapshot | null {
    const cached = this.shadowSnapshots.get(line);
    if (cached !== undefined) {
      return cached;
    }
    let dirs: LineDirResolution;
    try {
      dirs = resolveLineDirs(this.assemblyOpts, line);
    } catch {
      return null;
    }
    if (dirs.lineSnapshot === null) {
      return null;
    }
    try {
      const snap = buildSnapshotIdentity(dirs, HERE);
      this.shadowSnapshots.set(line, snap);
      return snap;
    } catch {
      return null;
    }
  }

  /**
   * S7：shadow 会话快照解析——绑定 latest 线快照身份（请求级锁定同一原语 §6.5.7；finalizeTurn 的
   * decision/made provenance 用绑定快照）；latest 线身份构建失败 → 降级回退当前线快照 + 记录。
   */
  private resolveShadowSnapshot(reqId: string): string {
    if (this.snapshotOverride !== null) {
      return this.snapshotOverride;
    }
    if (this.degraded) {
      return 'rs:assembly';
    }
    const lineSnap = this.resolveLineSnapshotIdentity('latest');
    if (lineSnap === null) {
      recordDegradation('shadow/route', 'latest 线快照身份构建失败——shadow 会话快照回退当前线');
      return this.resolveRuntimeSnapshot(reqId);
    }
    this.registry.bind(reqId, lineSnap);
    return runtimeHashOf(lineSnap);
  }

  /**
   * S7：shadow 会话首请求 exposure 落盘（.evolution/shadows/exposure-<date>.jsonl，JSONL 追加）。
   * 格式对齐 readShadowSignals（supervisor/promotion.ts）：{candidate_id, bucket, session_id,
   * task_domain, exposure_ts, outcome}——outcome='pending' 占位，finalizeTurn 以真实 outcome 回写
   *（同 (session,candidate) 键最后一条胜出，L2 不重复计数）。task_domain 缺省 'general'
   *（真实任务域判定留待语义扩展）。尽力而为：失败 → 降级记录（会话继续，不追踪 outcome）。
   */
  private async recordShadowExposure(req: CognitiveRequest, route: ShadowRoute): Promise<void> {
    if (this.shadowSessions.has(req.session_id)) {
      return; // 首请求只写一次（进程内记忆化）
    }
    const shadowsDir = join(this.evolutionRoot, 'shadows');
    const file = join(shadowsDir, `exposure-${new Date().toISOString().slice(0, 10)}.jsonl`);
    try {
      await mkdir(shadowsDir, { recursive: true });
      await appendFile(
        file,
        `${JSON.stringify({
          candidate_id: route.candidate_id,
          bucket: route.bucket,
          session_id: req.session_id,
          task_domain: route.task_domain,
          exposure_ts: Date.now(),
          outcome: 'pending', // 占位——finalizeTurn 回写真实 outcome
        })}\n`,
        'utf8',
      );
      this.shadowSessions.set(req.session_id, route);
    } catch (err) {
      recordDegradation(
        'shadow/route',
        `exposure 落盘失败（${errorDetail(err)}）——shadow 会话继续（尽力而为，不追踪 outcome）`,
      );
    }
  }

  /**
   * S7：shadow 会话收尾 outcome 回写（exposure-<date>.jsonl 追加同键条目——(session,candidate) 最后一条
   * 胜出）。P2：判定从代理升级为**验证契约判定**（用户裁决 2026-08-25）——
   *   seedShadowContract（task_contract：goal + success_criteria + 默认硬约束）→ buildShadowEvidence
   *   （确定性一级：过程无降级 + 决策已产生；LLM judge 注入面本阶段不调用——成功条件无确定性证据时
   *   诚实 UNKNOWN）→ decideVerdict（三态）→ shadowOutcomeFromResult（success/degraded/unknown，
   *   success/degraded 语义与既有代理判定一致，unknown 为 UNKNOWN 独立档——L2 不计失败不污染评分）。
   * S2：落盘记录扩展 {process_quality, process_quality_vector, controllability}（机械评分器——
   *   用户裁决 S2/S7：可解释机械向量先保留原始向量再综合分，不做黑盒）：
   *   process_quality = normalizeProcessQuality(qualityVectorFromSignals({decision_made: true,
   *   claims_count（归约投影可得则取，否则 0）, tool_calls/memory_ops/corrections（signals.utility_counts）,
   *   degradations（degradationLog().length——无恢复计数面，以降级数近似"成功恢复"）}))；
   *   controllability = classifyFromText(decision.process?.degraded ?? '')（机械关键词规则表）。
   * 验证债务（裁决 S2）：outcome=UNKNOWN 且 success_criteria 非空 → verificationDebt.enqueue
   *   {key: `shadow:${sessionId}`, kind:'shadow', ...}——未决验证入队维护期复核（不污染普通请求）；
   *   尽力而为（失败降级记录不抛）。阶梯式验证注记：机械 → 外部 → 历史/回归 → 单次结构化裁判 →
   *   UNKNOWN 合法终态（债务保留待复核，不强迫猜）。真实 LLM judge 生产调用由 verification_review
   *   维护任务经空白子代理单次裁判执行（P2.5 搁置解除——用户 2026-08-25 裁决）。
   * W2（未接线审计修复 2026-08-25）：任务库登记——契约种子后 registerTask（会话任务契约登记，见内联注释）；
   *   尽力而为（失败降级记录不抛，不阻塞 outcome 落盘；任务库未装配 → 跳过）。
   */
  private async writeShadowOutcome(
    sessionId: string,
    decision: GovernorDecision,
    task?: { goal: string; success_criteria: string[] },
    processContext?: { signals: UtilityCounts; claims_count: number },
  ): Promise<void> {
    const route = this.shadowSessions.get(sessionId);
    if (route === undefined) {
      return; // 非 shadow 会话（或 exposure 未落盘）→ 不回写
    }
    const contract = seedShadowContract(sessionId, task ?? { goal: '', success_criteria: [] });
    // W2（未接线审计修复 2026-08-25）：任务库登记——会话任务契约登记（Task Contract / Success Criteria /
    // Verifier 引用——S1 任务库语义落地）。task_id = 契约键 `shadow:<sessionId>`（同键覆写不重复）；
    // contract_ref = 本次验证契约 id（seedShadowContract 产物——契约判定可回溯）；success_criteria 透传
    // 会话任务契约；verifier_refs 恒两枚（deterministic 权威 + structured_llm 补充，与契约声明一致）。
    // 尽力而为：写失败/任务库未装配 → 降级记录不抛（不阻塞 outcome 落盘、不污染 shadow 收尾）。
    try {
      await this.taskStore.registerTask({
        task_id: `shadow:${sessionId}`,
        contract_ref: contract.id,
        success_criteria: task?.success_criteria ?? [],
        verifier_refs: [SHADOW_PROXY_VERIFIER_ID, SHADOW_JUDGE_VERIFIER_ID],
      });
    } catch (err) {
      recordDegradation('verification/tasks', `任务库登记失败（${errorDetail(err)}）——尽力而为`);
    }
    // 确定性一级证据：degraded = decision.process.degraded 非空；decision_made 恒 true——finalize 路径必有 decision
    const evidence = buildShadowEvidence(contract, {
      degraded: decision.process?.degraded !== null && decision.process?.degraded !== undefined,
      decision_made: true,
    });
    const result = decideVerdict(contract, evidence);
    const outcome = shadowOutcomeFromResult(result);
    // S2：机械过程质量向量（保留原始向量 + 综合分）——signals.utility_counts（tool_calls/memory_ops/
    // corrections）+ 归约投影 claims_count（无归约 → 0）+ 模块级降级日志数（无恢复计数面，近似"成功恢复"）
    const vector = qualityVectorFromSignals({
      decision_made: true,
      claims_count: processContext?.claims_count ?? 0,
      tool_calls: processContext?.signals.tool_calls ?? 0,
      corrections: processContext?.signals.corrections ?? 0,
      degradations: degradationLog().length,
    });
    const processQuality = normalizeProcessQuality(vector);
    // S2：可控性机械分类（degraded 文本关键词规则表——网络/权限/验证码 → external；工具/代码 → controllable）
    const controllability = classifyFromText(decision.process?.degraded ?? '');
    const shadowsDir = join(this.evolutionRoot, 'shadows');
    const file = join(shadowsDir, `exposure-${new Date().toISOString().slice(0, 10)}.jsonl`);
    try {
      await mkdir(shadowsDir, { recursive: true });
      await appendFile(
        file,
        `${JSON.stringify({
          candidate_id: route.candidate_id,
          bucket: route.bucket,
          session_id: sessionId,
          task_domain: route.task_domain,
          exposure_ts: Date.now(),
          outcome,
          verdict: result.verdict,
          contract_id: result.contract_id,
          evidence_quality: result.evidence_quality,
          reason: result.reason,
          // S2：机械评分器落盘（原始向量保留 + 综合分；controllability 分类 + cause）
          process_quality: processQuality,
          process_quality_vector: vector,
          controllability: { controllability: controllability.controllability, cause: controllability.cause },
        })}\n`,
        'utf8',
      );
    } catch (err) {
      recordDegradation('shadow/route', `outcome 回写失败（${errorDetail(err)}）——尽力而为`);
    }
    // S2：验证债务入队（outcome=UNKNOWN 且成功标准非空 → 未决验证维护期复核；同 key 覆写去重；
    // 尽力而为——失败降级记录不抛，不污染 shadow 收尾）
    if (result.verdict === 'UNKNOWN' && (task?.success_criteria ?? []).length > 0) {
      try {
        await this.verificationDebt.enqueue({
          key: `shadow:${sessionId}`,
          kind: 'shadow',
          contract_id: result.contract_id,
          materials: {
            goal: task?.goal ?? '',
            success_criteria: task?.success_criteria ?? [],
            degraded: decision.process?.degraded ?? null,
            decision_made: true,
          },
        });
      } catch (err) {
        recordDegradation('verification/debt', `shadow 验证债务入队失败（${errorDetail(err)}）——尽力而为`);
      }
    }
  }

  /** S7：shadow 路由缓存失效（线/快照/内容变化点调用——/mode 切换、promote、候选晋升 trusted-latest 推进） */
  private invalidateShadowCaches(): void {
    this.trustedLatestCommit = undefined;
    this.shadowCandidateCache = null;
    this.shadowBundle = null;
    this.shadowBundleFailed = false;
    this.shadowSnapshots.clear();
    this.perLineWorldModels.clear();
  }

  /**
   * prepareTurn（§3.1）：turn 开始认知准备——快照/工作状态/Governor 决策（准备级）/（R3）Governor→Scheduler→
   * Process 调度（选定/生成过程 → decision 载荷 + Working State 过程引用 + Context Projection「认知过程」section）/
   * 分层检索/ContextCompiler 投影编译；（提供注入接收器时）注入 + context/injected 入链（Model-visible ⟺ logged）。
   * S7：per-session shadow 路由——先加载装配线策略（配置源），再按 shadow 桶判定生效线：桶会话 →
   * latest 线快照运行（快照身份/线状态真实变化 + policy/processes 按线加载）+ exposure 落盘（首请求）；
   * 无 trusted-latest 差异/未启用 → 零开销（默认路径不变）。
   */
  async prepareTurn(req: CognitiveRequest, opts: PrepareTurnOptions = {}): Promise<PreparedTurn> {
    const ready = await this.ready();
    let policy = ready.policy;
    let processes = ready.processes;
    // S7：shadow 路由判定（配置源 = 装配线策略；只判不 I/O——commit/candidate 记忆化解析）
    const route = await this.computeShadowRoute(req.session_id, ready.policy.evolve.shadow);
    let shadowRouted = false;
    if (route.route) {
      // shadow 桶会话：latest 线 policy/processes（per-line 记忆化；加载失败 → 降级回退装配线 + 记录）
      const latestBundle = await this.loadShadowBundle();
      if (latestBundle !== null) {
        policy = latestBundle.policy;
        processes = latestBundle.processes;
        shadowRouted = true;
      }
    }
    // P1b：请求开始解析快照（未绑定 → 绑定当前快照，整个请求锁定 §6.5.7；晋升只影响后续请求）。
    // S7：shadow 桶会话 → 绑定 latest 线快照身份（rs:<latest commit 哈希>——快照真实不同）
    const snapshot = shadowRouted
      ? this.resolveShadowSnapshot(req.session_id)
      : this.resolveRuntimeSnapshot(req.session_id);
    const working_state = await this.loadWorkingState(req);
    const decision = decide(this.buildGovernorInput(req, processes, policy, snapshot), policy.governor);
    // R3（P0）：Governor → Scheduler → Process 进入请求链（架构 §5.1/§4.6.1：Fast Governor + Rare Generator）。
    // 只做决策与投影——不驱动执行：不调用 operator executor、不循环调用模型（DSH 原生 Agent Loop 是唯一执行者）。
    // 调度结果并入 decision 载荷（decision/made 事件 payload 已由 finalizeTurn 记录 chosen/reason——不新增事件类型）；
    // 失败降级（scheduler 异常/无过程可选）→ decision.process.degraded 记录，不阻塞 prepareTurn 其余流程。
    const scheduled = await this.scheduleProcess(req, processes, policy);
    decision.process = scheduled;
    if (scheduled.kind !== 'none' && scheduled.process_id !== null) {
      // 过程引用写入 Working State（next_best_action）：DSH Loop 的下一步 = 执行认知过程
      working_state.next_best_action = `认知过程 ${scheduled.process_id}（${scheduled.method}）`;
    }
    // 专项 D：记忆检索 Episode 采样（评审问题一）——确定性哈希（session_id + per-session turn 计数，
    // shouldSampleEpisode 可测）+ 高价值提升（open_questions/evidence_gaps 非空 → 生效采样率提升）；
    // 命中 → { episode: true } 记录并登记会话归属（finalizeTurn 归因代理面），未命中 → false（缺省
    // 低成本语义不变——零记录行为与既有 episode:false 完全一致）
    const sampleEpisode = shouldSampleEpisode(
      req.session_id,
      String(this.nextTurnToken(req.session_id)),
      this.effectiveEpisodeSampleRate(working_state),
    );
    const retrieved = await retrieve(
      this.memory,
      { scope: 'Project', text: req.goal, limit: 3, budget: 1000 },
      { episode: sampleEpisode },
    );
    // 归因观测面（已知问题《效用反馈为空》修复）：用**本轮人类消息**归因上一轮注入的记忆
    //（引用证据 = 注入内容的独占特征词是否出现在后续人类消息中；证据不足 → 不归因，保持诚实空缺）。
    // 放在检索之后、记录本轮 episode 之前：此时 req.goal 即本轮人类消息，可作上一轮的引用观测窗口。
    await this.attributeInjectedMemories(req.session_id, req.goal);
    if (sampleEpisode && retrieved.episode !== undefined) {
      this.recordSessionEpisode(req.session_id, retrieved.episode.id);
      const injected = (
        await this.memory.getEpisode(retrieved.episode.id).catch(() => undefined)
      )?.injected_ids;
      if (injected !== undefined && injected.length > 0) {
        this.sessionAttribution.set(req.session_id, {
          episode_id: retrieved.episode.id,
          injected_ids: injected,
        });
      }
    }
    // R7：Context 候选来源扩展——全来源收集（Memory 检索 + Evidence 会话事件 + Capability 注册表 +
    // Process 调度结果 + Artifact 制品索引（专项 D：queryRelevant 按任务目标相关性排序最近产物
    // → {id, payload} 最小形状；替代纯 queryRecent 最近序））；
    // ΔInfoValue（S3）：WorkingState 缺口匹配启发式动态估计（estimateInfoValue）——五来源统一；空闲期反馈修正留待 §17
    const projection = await buildContextProjection(
      policy,
      req,
      working_state,
      retrieved.items,
      toProcessSection(scheduled),
      {
        eventStore: this.eventStore,
        capabilities: this.capabilities,
        artifacts: (goal, limit) =>
          this.artifactIndex.queryRelevant(goal, limit).then((list) =>
            list.map((a) => ({ id: a.id, payload: `制品 ${a.type}: ${a.path}` })),
          ),
        session_id: req.session_id,
      },
    );

    // S7：shadow 会话首请求 exposure 落盘（尽力而为——失败降级记录不阻塞请求）
    if (shadowRouted) {
      await this.recordShadowExposure(req, route);
    }

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

    // S4：事件驱动制品索引——收尾从最近会话 tool/result 事件发现新制品 → 逐条注册（尽力而为：
    // 失败降级记录不抛——制品索引缺失/不可写不阻塞收尾；无 tool/result → 无发现）
    await this.discoverAndIndexArtifacts(input.session_id);

    const experience = buildExperienceCandidate(input.session_id, input.decision, input.working_state);

    // R4（P0）：Experience Admission——候选 → staging（准入规则 + 量级守卫；不直接写 memory——
    // 长期记忆经维护期 memory_consolidation 落库：staging → admit → consolidate → memory/relation）
    const experience_admission = await this.stageExperiences(
      experience === null ? [] : [experience],
      input.session_id,
    );

    const { signals, projections, degraded } = await this.aggregateSignals(input.session_id);

    // P3.6：事实库自动填充（归约投影 claims → FactStore；尽力而为——失败降级记录不抛；无 claims/无归约 → 跳过）
    await this.persistTurnFacts(projections?.claims ?? null);

    // P1c：演化信号落盘（.evolution/signals/<yyyy-mm-dd>.jsonl 追加；信号源① = finalizeTurn 聚合的
    // utility_counts、信号源② = L1 generalization 采集器输出面；尽力而为——失败降级不阻塞收尾）
    const signals_log = await this.persistTurnSignals(signals, input.session_id);

    let maintenance: { enqueued: boolean; debt: MaintenanceDebt[] } = { enqueued: false, debt: [] };
    if (this.maintenance !== null) {
      // S2：维护任务成本数据化——estimated_cost 从 policy.evolve.maintenance_costs 读取（改 evolve.yaml 即生效）
      const { policy } = await this.ready();
      const maintenanceCosts = policy.evolve.maintenance_costs;
      // 既有：会话级收尾任务（事件库 GC/compact；债务语义不变——仅失败/中断/跳过累计）
      await this.maintenance.enqueue({
        id: `turn-finalize:${input.session_id}`,
        value: 1,
        estimated_cost: 1, // 会话级收尾：固定成本 1（非维护任务表；ROI 1 优先语义不变）
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
      for (const acc of debtAccrualsFromSummary(summary, maintenanceCosts)) {
        await this.enqueueAccrual(acc, this.maintenanceRun(acc.task_id, input.session_id));
      }
      // R4（P0）：经验已入 staging → memory_consolidation 债务入账（§10.1 同形状）——保证
      // 「经验 → 长期记忆」生产闭环在无 memory 信号时也可调度（空闲期量子执行 consolidation）
      if (experience_admission.staged > 0) {
        const acc = memoryConsolidationAccrual(maintenanceCosts);
        await this.enqueueAccrual(acc, this.maintenanceRun(acc.task_id, input.session_id));
      }
      // 向量编码（已知问题《新增向量检索》：编码放空闲期批量执行，不入主对话路径）：
      // 有未编码记忆时入队 memory_vector_encode（纯 CPU、无模型调用、可中断；成功清偿自身债务）。
      // 只在确有缺口时入队（队列空时不产生任何开销）。
      if (this.memory.pendingEncodeCount() > 0) {
        await this.maintenance.enqueue({
          id: 'memory_vector_encode',
          value: 1,
          estimated_cost: 2, // 与检查类同档（纯 CPU 批量编码；§17 可标定）
          priority: 0,
          urgency: 'normal',
          subsystem: 'memory-vector',
          reason: '存在未编码记忆——向量通道待补齐（空闲期批量编码）',
          run: async (signal) => {
            await this.runVectorEncode(signal);
          },
        });
      }
      // 关系建图（已知问题《关系图为空图》：规则边依赖生产中不存在的记忆类型 → 关系表恒 0 行）。
      // 图稀疏（edges < memories/2）才入队 memory_relation_build——纯 CPU、无模型调用、可中断；
      // 图稠密后不再入队（不空转）；失败 → 任务失败并留痕（不吞错）。
      if (relationNeedsBuild(this.memory.edgeCount(), this.memory.memoryCount())) {
        await this.maintenance.enqueue({
          id: 'memory_relation_build',
          value: 1,
          estimated_cost: 2, // 与检查类同档（纯 CPU 单批建图；§17 可标定）
          priority: 0,
          urgency: 'normal',
          subsystem: 'memory-relation',
          reason: '关系图稀疏——词法/向量相似边待建立（空闲期批量建图）',
          run: async (signal) => {
            await this.runRelationBuild(signal);
          },
        });
      }
      // P1c：演化判定任务（空闲期 quantum 执行；低优先级、可中断——读 signals → evolve.policy 判定 →
      // 应演化则入队 candidate_validation + evolution/candidate 事件入链）。
      // 演化节律开关（config.selfIteration.schedule=false）→ 不入队（仅显式 /evolve now 触发演化判定）；
      // 其余维护任务（环境检查/晋升检查/记忆整合）不受此开关影响。
      if (this.selfIteration.schedule) {
        await this.maintenance.enqueue({
          id: 'evolution_decision',
          value: 1,
          estimated_cost: maintenanceCosts.evolution_decision,
          priority: 0,
          urgency: 'normal',
          subsystem: 'evolution-decision',
          reason: '演化判定待执行',
          run: async (signal) => {
            await this.runEvolutionDecision(signal, input.session_id);
          },
        });
      }
      // P1e：晋升检查任务（低优先级：读 trusted-latest vs stable → 三层信号门禁 → 应晋升则
      // promoteToStable（activation_scope='project' 显式传入）——空闲期 quantum 与 /evolve 共用）
      await this.maintenance.enqueue({
        id: 'promotion_check',
        value: 1,
        estimated_cost: maintenanceCosts.promotion_check,
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
        estimated_cost: maintenanceCosts.environment_check,
        priority: 0,
        urgency: 'normal',
        run: this.maintenanceRun('environment_check', input.session_id),
      });
      // 数据体积与清理（已知问题《数据体积与清理》三条）：
      //   ① 检查点轮转与清理（checkpoint_prune）——按「每会话保留最近 N + 全局上限 + 时间上限」；
      //   ② 事件库整理（event_store_vacuum）——按体积阈值触发（低于阈值零开销）；
      //   ③ 事实库分片合并（fact_store_compact）——小文件 → 分片（键仍可寻址）。
      // 三者都是"维护收益型"任务（纯本地 I/O、无模型调用、可中断），按节流窗口入队（默认每小时一次），
      // 避免每轮重复入队；harvest 在维护量子里批量消费。
      if (this.shouldEnqueueHygiene()) {
        await this.maintenance.enqueue({
          id: 'checkpoint_prune',
          value: 1,
          estimated_cost: 2,
          priority: 0,
          urgency: 'normal',
          subsystem: 'checkpoint-rotation',
          reason: '检查点目录轮转与清理（保留上限 + 会话维度）',
          run: async () => {
            await this.runCheckpointPrune();
          },
        });
        await this.maintenance.enqueue({
          id: 'event_store_vacuum',
          value: 1,
          estimated_cost: 4,
          priority: 0,
          urgency: 'normal',
          subsystem: 'event-store',
          reason: '事件库按体积阈值整理（回收文件页）',
          run: async () => {
            await this.runEventStoreVacuum();
          },
        });
        await this.maintenance.enqueue({
          id: 'fact_store_compact',
          value: 1,
          estimated_cost: 4,
          priority: 0,
          urgency: 'normal',
          subsystem: 'verification-stores',
          reason: '事实库小文件分片合并（键仍可寻址）',
          run: async () => {
            await this.runFactStoreCompact();
          },
        });
      }
      maintenance = { enqueued: true, debt: this.maintenance.debtSnapshot() };
    }

    let checkpoint: Checkpoint | null = null;
    if (this.checkpointDir !== undefined && input.state !== undefined) {
      // 会话维度（已知问题《工作状态未按会话隔离》）：写入 session_id，读取时按会话取最新
      checkpoint = await saveCheckpoint(input.state, {
        dir: this.checkpointDir,
        runtime_snapshot: snapshot,
        session_id: input.session_id,
      });
    }

    // S7：shadow 会话收尾回写 outcome（P2 验证契约判定：success/degraded/unknown——契约种子 = 会话
    // task_contract（goal + success_criteria，经 FinalizeTurnInput.task 传递；缺省仅 working_state.goal，
    // criteria 空 → 无语义应查）；成功条件无确定性证据时诚实 UNKNOWN；S2：机械评分器落盘
    // process_quality/controllability（信号源：本收尾聚合的 signals/归约投影 claims/降级日志）+
    // 验证债务接线（S2 第二阶段）；注释见 writeShadowOutcome；尽力而为——失败降级记录不阻塞收尾）
    await this.writeShadowOutcome(
      input.session_id,
      input.decision,
      {
        goal: input.working_state.goal,
        success_criteria: input.task?.success_criteria ?? [],
      },
      {
        signals,
        claims_count: projections?.claims.size ?? 0,
      },
    );

    // 专项 D：记忆检索 Episode 归因代理（诚实性约束——绝不伪造 hit/miss）：本会话已记录且 outcome
    // 为 null 的 episode → 检查诚实可观测代理信号（signal-collectors/utility 语义）——本版本
    // finalizeTurn 无检索有用性的可观测面 → 保持 null（「已记录待归因」）；检索数据量照常入 L1
    // 信号（collectGeneralizationSignals 扩展的 scope_recorded 类），归因观测面留待（见方法注释）
    const episode_attribution = await this.attributePendingEpisodes(input.session_id);

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
      episode_attribution,
    };
  }

  /**
   * 专项 D：记忆检索 Episode 归因代理（finalizeTurn 调用）——统计本会话采样 episode 的归因状态。
   *
   * 归因本身已接线（已知问题《效用反馈为空》修复）：`attributeInjectedMemories` 在**下一次
   * prepareTurn** 用新的人类消息作引用观测窗口，对上一轮注入的记忆给出 hit/miss 或"证据不足"，
   * 结论经 `reportEpisodeOutcome` 回灌六计数器与 utility_score。本方法只做**审计统计**：
   *   - attributed：outcome 已落（命中/否证，或外部显式归因）；
   *   - pending：outcome 仍 null（"已记录待归因"——证据不足时保持诚实空缺，绝不硬造结论）；
   *   - skipped：本进程内因证据不足而未归因的条数（`attributionSummary`）。
   */
  async attributePendingEpisodes(sessionId: string): Promise<{ attributed: number; pending: number; skipped: number }> {
    const ids = this.sessionEpisodes.get(sessionId);
    if (ids === undefined || ids.size === 0) {
      return { attributed: 0, pending: 0, skipped: 0 };
    }
    let attributed = 0;
    let pending = 0;
    for (const id of ids) {
      const ep = await this.memory.getEpisode(id);
      if (ep === undefined) {
        continue; // 已清理/未知 → 跳过（不臆造）
      }
      if (ep.outcome !== null) {
        attributed++; // 已归因（引用观测面或外部 reportEpisodeOutcome）
      } else {
        pending++; // 证据不足 → 保持 null（已记录待归因）
      }
    }
    return { attributed, pending, skipped: this.attributionCounts.skipped };
  }

  // ---- 专项 D：采样辅助（确定性 turn token / 高价值提升 / 会话归属登记） ----

  /** per-session 单调 turn 计数（确定性采样 token——同会话同序 → 同判定；重启后重置可接受，采样非契约） */
  private nextTurnToken(sessionId: string): number {
    const n = (this.sessionTurnCounters.get(sessionId) ?? 0) + 1;
    this.sessionTurnCounters.set(sessionId, n);
    return n;
  }

  /** 生效采样率 = 高价值提升（open_questions/evidence_gaps 非空 → max(配置率, 高价值率)；否则配置率） */  private effectiveEpisodeSampleRate(workingState: PromptWorkingState): number {
    const highValue = workingState.open_questions.length > 0 || workingState.evidence_gaps.length > 0;
    return highValue ? Math.max(this.episodeSampleRate, EPISODE_SAMPLE_RATE_HIGH_VALUE) : this.episodeSampleRate;
  }

  /** 会话 → 采样记录的 episode id 集（retrieval_episode 表无 session 列——会话归属只能在记录点捕获） */
  private recordSessionEpisode(sessionId: string, episodeId: string): void {
    let set = this.sessionEpisodes.get(sessionId);
    if (set === undefined) {
      set = new Set();
      this.sessionEpisodes.set(sessionId, set);
    }
    set.add(episodeId);
  }

  /**
   * 归因观测面（已知问题《效用反馈为空》修复）：用后续人类消息归因上一轮注入的记忆。
   * 证据 = 注入内容的**独占特征词**是否出现在后续人类消息中（见 memory/attribution.ts 的诚实性说明）；
   * 证据不足（无对照消息 / 特征词不足）→ **不归因**，episode.outcome 保持 null（诚实空缺）。
   * 会话内每条记忆只归因一次（避免重复计数把 utility 灌水）；episode 级结论经 reportEpisodeOutcome
   * 回灌六计数器与 utility_score（价值排序 ④ 的闭环）。
   * 尽力而为：任一步失败 → 记录降级不进结果（不影响 prepareTurn 主链）。
   */
  private async attributeInjectedMemories(sessionId: string, humanText: string): Promise<void> {
    const pending = this.sessionAttribution.get(sessionId);
    if (pending === undefined) return;
    this.sessionAttribution.delete(sessionId); // 每轮只归因一次（本轮已消费）
    if (humanText.trim().length === 0) return; // 无对照文本 → 保持待归因
    const decided = this.attributedMemories.get(sessionId) ?? new Set<string>();
    this.attributedMemories.set(sessionId, decided);
    try {
      const r = await attributeEpisode(this.memory, pending.episode_id, humanText, { skip_ids: decided });
      for (const o of r.outcomes) {
        if (o.verdict !== 'skipped') {
          decided.add(o.memory_id);
        }
      }
      this.attributionCounts.attributed += r.attributed;
      this.attributionCounts.skipped += r.skipped;
    } catch (err) {
      recordDegradation('memory/attribution', `归因失败（${errorDetail(err)}）——保持待归因，不伪造结论`);
    }
  }

  /** 归因观测摘要（状态面可读：本次进程内累计归因条数 / 证据不足条数） */
  attributionSummary(): { attributed: number; skipped: number } {
    return { ...this.attributionCounts };
  }

  /** 数据清理任务节流判定（每小时一次；§17 可标定）——避免每轮重复入队同一批清理任务 */
  private shouldEnqueueHygiene(): boolean {
    const now = Date.now();
    if (now - this.lastHygieneEnqueueAt < HYGIENE_ENQUEUE_INTERVAL_MS) {
      return false;
    }
    this.lastHygieneEnqueueAt = now;
    return true;
  }

  /** 数据体积与清理（已知问题《数据体积与清理》三条：检查点轮转 / 事件库整理 / 事实库合并） ---- */

  /**
   * 检查点轮转与清理（维护任务 checkpoint_prune）：按"每会话保留最近 N 个 + 全局上限 + 时间上限"
   * 清理（见 supervisor/checkpoint.ts `prune` 的规则与理由）。无 checkpointDir → 空结果（不动作）。
   * 失败降级不抛（清理是维护收益，不是关键路径）。
   */
  async runCheckpointPrune(): Promise<{ removed: number; kept: number; reasons: string[] }> {
    if (this.checkpointDir === undefined) {
      return { removed: 0, kept: 0, reasons: [] };
    }
    try {
      return await pruneCheckpoints({ dir: this.checkpointDir });
    } catch (err) {
      recordDegradation('checkpoint/prune', `检查点轮转失败（${errorDetail(err)}）——本轮跳过`);
      return { removed: 0, kept: 0, reasons: [`失败：${errorDetail(err)}`] };
    }
  }

  /**
   * 事件库整理（维护任务 event_store_vacuum）：按体积阈值触发 VACUUM 回收文件页
   *（已知问题《事件库体积增长》：压缩只删记录不回收文件页）。低于阈值 → 不动作（零开销）。
   */
  async runEventStoreVacuum(): Promise<{ vacuumed: boolean; sizeBytes: number; reclaimedBytes: number }> {
    try {
      const before = this.eventStore.sizeBytes();
      if (before < EVENT_STORE_VACUUM_THRESHOLD_BYTES) {
        return { vacuumed: false, sizeBytes: before, reclaimedBytes: 0 };
      }
      this.eventStore.vacuum();
      const after = this.eventStore.sizeBytes();
      return { vacuumed: true, sizeBytes: after, reclaimedBytes: Math.max(0, before - after) };
    } catch (err) {
      recordDegradation('event-store/vacuum', `事件库整理失败（${errorDetail(err)}）——本轮跳过`);
      return { vacuumed: false, sizeBytes: 0, reclaimedBytes: 0 };
    }
  }

  /** 事实库分片合并（维护任务 fact_store_compact）：一键一文件 → 分片文件，键仍可寻址 */
  async runFactStoreCompact(): Promise<{ shards: number; records: number; removedFiles: number }> {
    try {
      return await this.factStore.compact();
    } catch (err) {
      recordDegradation('fact-store/compact', `事实库分片合并失败（${errorDetail(err)}）——本轮跳过`);
      return { shards: 0, records: 0, removedFiles: 0 };
    }
  }

  /**
   * S4：制品发现与索引（finalizeTurn 收尾调用；尽力而为——失败降级记录不抛，不阻塞收尾）。   * 从最近会话事件（拉取窗口 ARTIFACT_DISCOVERY_FETCH_LIMIT、取窗口尾最近 ARTIFACT_DISCOVERY_EVENT_LIMIT 条）
   * 提取 tool/result 事件 → discoverArtifactsFromEvents（root=仓库根 HERE：路径解析到 root 下且文件存在 →
   * 读内容 sha256 → manifest restorable:true；幽灵路径跳过；root 下的环境指纹 = 采集器注入面
   * （缺省 collectEnvironmentFingerprint）→ 逐条 index.register（同 id 覆写）。
   */
  private async discoverAndIndexArtifacts(sessionId: string): Promise<void> {
    try {
      const { events } = await this.eventStore.query({
        session_id: sessionId,
        limit: ARTIFACT_DISCOVERY_FETCH_LIMIT,
      });
      // event-store 为 seq ASC 分页——取窗口尾（最近）的 ARTIFACT_DISCOVERY_EVENT_LIMIT 条会话事件
      const recent = events.slice(-ARTIFACT_DISCOVERY_EVENT_LIMIT);
      const fingerprint = this.fingerprintCollector();
      const environment: Record<string, string> = {};
      for (const [k, v] of Object.entries(fingerprint)) {
        if (typeof v === 'string') {
          environment[k] = v; // Fingerprint 可选键（gpu/cuda）缺省 → 过滤非字符串
        }
      }
      const manifests = await discoverArtifactsFromEvents(recent, {
        // 发现根集合（已知问题《制品索引未建立》修复）：仓库根 + 会话工作目录（DSH 注入时有值）；
        // 逐根尝试，全部未命中 → 记为不可恢复制品（不再直接丢弃——真实工作文件多在用户项目目录下）
        roots: this.artifactRoots,
        environment,
      });
      for (const m of manifests) {
        await this.artifactIndex.register(m);
      }
    } catch (err) {
      // 制品发现/索引失败 → 降级记录不抛（尽力而为——制品索引缺失不阻塞事件主链）
      recordDegradation('artifact/index', `制品发现/索引失败（${errorDetail(err)}）——尽力而为`);
    }
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
      // P2：会话任务契约随收尾传递——shadow outcome 验证契约种子（goal + success_criteria）
      task: { goal: req.goal, success_criteria: req.success_criteria },
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
      this.repairExecutors = null; // P3.5：线切换 → 执行器按新线目录重建（下一 runRepair 懒构造）
      this.modelCache = null; // S1：World/Self 模型反映新线（下一访问按新线/新快照重建）
      this.invalidateShadowCaches(); // S7：线切换 → shadow 路由缓存失效（trusted-latest/线 bundle/快照身份）
      return { promoted: true, degraded: null };
    } catch (err) {
      return { promoted: false, degraded: `快照重建失败（${errorDetail(err)}）——当前快照保持` };
    }
  }

  /** P1b/P1e：外部晋升接口（构建好新快照后 promote → 下一请求生效；进行中请求不受影响，§6.5.7） */
  promoteSnapshot(next: RuntimeSnapshot): void {
    this.registry.promote(next);
    this.modelCache = null; // S1：World/Self 模型反映新快照（内容寻址重建）
    this.invalidateShadowCaches(); // S7：快照切换 → shadow 路由缓存失效（线状态可能已变）
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
      // 按会话取最新（已知问题《工作状态未按会话隔离》修复：不再取"目录内最新检查点"——
      // 那可能属于别的会话，会把别的会话的目标/事实/缺口注入本会话投影）
      const cp = await latestCheckpointForSession(req.session_id, { dir: this.checkpointDir });
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
  private async scheduleProcess(
    req: CognitiveRequest,
    processes: readonly ProcessDef[],
    policy?: PolicyBundle,
  ): Promise<ProcessDecisionInfo> {
    try {
      // 每次调用构造新调度器/生成器（P5：generationUsed 计数器即单请求语义——max_generate_per_request）
      const scheduler = await this.createScheduler(processes, policy);
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

  /**
   * 信号聚合（零成本）：会话事件 → reducer utility_counts；归约失败 → 全零 + 降级原因。
   * P3.6：同时返回归约投影（claims——事实库自动填充数据源；归约失败 → null → 跳过填充）。
   */
  private async aggregateSignals(session_id: string): Promise<{
    signals: UtilityCounts;
    projections: Projections | null;
    degraded: string | null;
  }> {
    try {
      const sessionEvents = (await this.eventStore.query({ session_id })).events;
      const { projections } = reduce(sessionEvents);
      return { signals: projections.utility_counts, projections, degraded: null };
    } catch (err) {
      return {
        signals: { tool_calls: 0, retrieval_calls: 0, memory_ops: 0, corrections: 0, reads: 0, hits: 0 },
        projections: null,
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

  /**
   * P3.6：事实库自动填充（尽力而为——失败降级记录不抛；无 claims/无归约 → 跳过）——遍历归约投影
   * claims（如可得）→ FactStore.registerFact({ id: claim_id, text, provenance: claim 来源锚点,
   * valid: 非已推翻/矛盾 })：valid=false = 已推翻（evidence_status revoked）或矛盾（epistemic
   * contradicted）——语义「valid=false = 已推翻/矛盾」；归约投影未保留来源事件 id → provenance 以
   * claim id 作来源锚点（无矛盾检查按 provenanceContains 关联对象事实）。
   */
  private async persistTurnFacts(claims: ReadonlyMap<string, ClaimView> | null): Promise<void> {
    if (claims === null || claims.size === 0) {
      return; // 无 claims/无归约 → 跳过
    }
    for (const [claimId, view] of claims) {
      try {
        await this.factStore.registerFact({
          id: claimId,
          text: view.text,
          provenance: claimId,
          valid: view.evidence_status !== 'revoked' && view.epistemic !== 'contradicted',
        });
      } catch {
        // 单条事实注册失败降级记录不抛（尽力而为——注册面缺失不阻塞 turn 收尾）
      }
    }
  }

  /**
   * 债务入账入队（统一入口——债务来源记录随任务一起注入，见 kernel/evolve-decision.ts DEBT_SUBSYSTEM）：
   * 入队 + accrueDebt（入账即累计并落盘）+ subsystem/reason 写入债务来源记录，供「修复 → 确认 → 释放」
   * 按条核对（释放时 expectedSubsystem 必须与记录一致）。
   */
  private async enqueueAccrual(
    acc: DebtAccrual,
    run: (signal?: AbortSignal) => Promise<void>,
  ): Promise<void> {
    await this.maintenance?.enqueue(
      {
        id: acc.task_id,
        value: acc.value,
        estimated_cost: acc.estimated_cost,
        priority: acc.priority,
        urgency: acc.urgency,
        subsystem: acc.subsystem,
        reason: acc.reason,
        run,
      },
      { accrueDebt: true },
    );
  }

  // ---- 债务「修复 → 确认 → 释放」（已知问题《债务是保护性自锁，需要修复后释放而不是定时清除》） ----

  /**
   * 债务释放流程（**不做任何周期性/到期式清除**——只有修复完成并经自检确认后才按条释放）。
   *
   * 确认依据 = 各来源子系统现存的自检结果（全部可从已落盘数据读出，不伪造）：
   *   - `repair-chain`：`.evolution/repair/<ts>.json` 最近记录判定全为 PASS 且该记录晚于债务首见时间
   *     （即「修复之后」的确认，而非修复前的陈旧结论）——repair 与 candidate_validation 共用该自检面；
   *   - `environment-check`：`.evolution/decay/` 无晚于债务首见时间的新衰减记录 → 环境侧已核对稳定；
   *   - `memory-consolidation`：staging 无过期未整合条目（`sweepExpired` 语义面的可读代理 = admit 后
   *     无 pending）；
   *   - `evolution-decision` / `promotion-check`：其判定在硬限下已不再被阻塞（本轮调度已执行该任务
   *     且无失败记录）——它们自身不锁死即视为该子系统健康。
   *
   * 未通过自检的条目**保留**（保护语义不变）；无来源子系统的条目不在本路径（走 manualPendingDebt
   * 人工裁定清单）。每次释放落审计（`debt-releases.jsonl`：依据/触发者/时间/释放前累计值）。
   * 返回逐条结果，供状态面与 /evolve 摘要展示。
   */
  async runDebtRelease(input: { session_id?: string; reviewed_by?: string } = {}): Promise<{
    released: DebtReleaseRecord[];
    kept: DebtReleaseResult[];
    manual_pending: DebtSourceView[];
  }> {
    const scheduler = this.maintenance;
    if (scheduler === null) {
      return { released: [], kept: [], manual_pending: [] };
    }
    const reviewedBy = input.reviewed_by ?? 'maintenance:debt_release';
    const now = Date.now();
    const repairs = await this.readRepairRecords();
    const latestRepairPass = [...repairs]
      .filter((r) => r.objects.length > 0 && r.objects.every((o) => o.verdict === 'PASS'))
      .map((r) => r.ts)
      .filter((t) => Number.isFinite(t))
      .sort((a, b) => b - a)[0];
    const latestDecayTs = await this.readLatestDecayTs();
    const released: DebtReleaseRecord[] = [];
    const kept: DebtReleaseResult[] = [];
    for (const view of scheduler.debtSourceView()) {      if (view.orphan) continue; // 无主债务 → 人工裁定清单，不自动释放
      const evidence = this.debtSelfCheckEvidence(view, { latestRepairPass, latestDecayTs, now });
      if (evidence === null) {
        kept.push({ released: false, task_id: view.task_id, value: view.value, reason: 'selfcheck_not_passed' });
        continue;
      }
      const r = await scheduler.releaseDebt({
        taskId: view.task_id,
        expectedSubsystem: view.subsystem!,
        evidence,
        releasedBy: reviewedBy,
        reason: view.reason,
      });
      if (r.released) {
        released.push({
          ts: now,
          task_id: r.task_id,
          value: r.value,
          subsystem: view.subsystem,
          evidence,
          released_by: reviewedBy,
          reason: view.reason,
        });
      } else {
        kept.push(r);
      }
    }
    return { released, kept, manual_pending: scheduler.manualPendingDebt() };
  }

  /** 子系统自检证据（通过 → 证据文本；未通过 → null 表示保留该条债务）。
   *  依据 = 该来源子系统的执行体在本进程内**成功跑完**（真实观测，非推断）+ 已落盘审计面佐证。 */
  private debtSelfCheckEvidence(
    view: DebtSourceView,
    ctx: { latestRepairPass: number | undefined; latestDecayTs: number | undefined; now: number },
  ): string | null {
    const last = this.lastSubsystemOk.get(view.subsystem ?? '');
    const ranAfterFirstSeen = last !== undefined && last >= view.first_seen;
    switch (view.subsystem) {
      case 'repair-chain':
      case 'candidate-pipeline': {
        const viaRepair = ranAfterFirstSeen
          ? `repair 自检执行体成功跑完（ts=${new Date(last!).toISOString()}）`
          : null;
        const viaRecord =
          ctx.latestRepairPass !== undefined && ctx.latestRepairPass >= view.first_seen
            ? `repair 审计记录全部 PASS（ts=${new Date(ctx.latestRepairPass).toISOString()}）`
            : null;
        const evidence = viaRepair ?? viaRecord;
        if (evidence === null) return null;
        // 有衰减记录晚于自检/修复 → 环境侧仍有待核对项，暂不释放（保守）
        if (ctx.latestDecayTs !== undefined && ctx.latestDecayTs > view.first_seen && last === undefined) return null;
        return evidence;
      }
      case 'environment-check': {
        if (ranAfterFirstSeen) {
          return `环境检查执行体成功跑完（ts=${new Date(last!).toISOString()}，无新增待核对衰减）`;
        }
        if (ctx.latestDecayTs === undefined) return '无衰减记录（环境侧无变化待核对）';
        return null;
      }
      case 'memory-consolidation':
        return ranAfterFirstSeen
          ? `记忆整合执行体成功跑完（ts=${new Date(last!).toISOString()}：staging 准入 + dedup/merge/relation/decay 完成）`
          : null;
      case 'evolution-decision':
      case 'promotion-check':
        return ranAfterFirstSeen
          ? `检查/判定任务成功跑完（ts=${new Date(last!).toISOString()}）——不锁死自身即视为该子系统健康`
          : null;
      default:
        return null; // 未知来源子系统 → 不释放（保守）
    }
  }

  /** 读取 repair 审计记录（`.evolution/repair/<ts>.json`；损坏/缺失 → 跳过，不抛） */
  private async readRepairRecords(): Promise<RepairRecord[]> {
    const out: RepairRecord[] = [];
    let names: string[];
    try {
      names = await readdir(this.repairDir);
    } catch {
      return out;
    }
    for (const name of names.filter((n) => n.endsWith('.json')).sort().slice(-20)) {
      try {
        out.push(JSON.parse(await readFile(join(this.repairDir, name), 'utf8')) as RepairRecord);
      } catch {
        // 损坏记录跳过（审计日志语义——不因坏行中断释放流程）
      }
    }
    return out;
  }

  /** 最近 decay 记录时间（无记录 → undefined） */
  private async readLatestDecayTs(): Promise<number | undefined> {
    try {
      const names = (await readdir(this.decayDir)).filter((n) => n.endsWith('.json')).sort();
      const last = names[names.length - 1];
      if (last === undefined) return undefined;
      const rec = JSON.parse(await readFile(join(this.decayDir, last), 'utf8')) as { ts?: unknown };
      return typeof rec.ts === 'number' ? rec.ts : undefined;
    } catch {
      return undefined;
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
          this.markSubsystemOk('environment-check');
        };
      case 'memory_consolidation':
        // R4（P0）：经验 → 长期记忆 生产闭环（§5.2/§7.2）——执行体 runMemoryConsolidation
        //（失败 → 任务抛错 → 债务不清零——R5 清债语义）
        return async (signal) => {
          await this.runMemoryConsolidation(signal);
        };
      case 'memory_vector_encode':
        // 向量编码（已知问题《新增向量检索》：空闲期批量编码；纯 CPU、不占显卡、无模型调用）
        return async (signal) => {
          await this.runVectorEncode(signal);
        };
      case 'memory_relation_build':
        // 关系建图（已知问题《关系图为空图》：词法 + 向量相似边；纯 CPU、无模型调用、幂等）
        return async (signal) => {
          await this.runRelationBuild(signal);
        };
      case 'checkpoint_prune':
        // 检查点轮转与清理（已知问题《检查点无轮转且自 09-09 起停写》：保留上限 + 会话维度清理）
        return async () => {
          await this.runCheckpointPrune();
        };
      case 'event_store_vacuum':
        // 事件库整理（已知问题《事件库体积增长》：按体积阈值触发 VACUUM 回收文件页）
        return async () => {
          await this.runEventStoreVacuum();
        };
      case 'fact_store_compact':
        // 事实库分片合并（已知问题《事实库小文件》：一键一文件 → 分片存储，键仍可寻址）
        return async () => {
          await this.runFactStoreCompact();
        };
      case 'repair':
        // R5（P0+P1）+P3：受影响对象契约化重验证（读 decay 记录 → 对象契约 → 最小验证计划 →
        // 执行验证器 → 损坏分类 → 处置语义 → 成功清债；无待 repair 对象 = 合法完成清债；
        // 幂等——重复执行同结果）
        return async () => {
          await this.runRepair();
          // 修复完成 → 借同一次调度做一次「确认 → 释放」（已知问题《债务是保护性自锁》：
          // 修复动作完成后经自检确认，按条释放与该子系统相关的债务；未通过自检的条目保留）
          await this.runDebtRelease({ reviewed_by: 'maintenance:runRepair' });
        };
      case 'verification_review':
        // S2：验证债务复核（阶梯式验证——机械 → 外部 → 历史/回归 → 单次结构化裁判 → UNKNOWN 合法终态；
        // 空白子代理同模型单次裁判（P2.5 搁置解除，用户 2026-08-25 裁决）——仅债务路径触发、
        // 正常任务 0 额外成本；失败/中断 → 债务保留不清零（R5 清债语义））
        return async (signal) => {
          await this.runVerificationReview(signal);
        };
      default:
        // 未实现/不可执行任务 → Deferred（债务保留，不假成功清债——评估依据 §13）
        return async () => {
          throw new DeferredMaintenanceError(`维护任务 ${taskId} 未实现——债务保留不清零`);
        };
    }
  }

  // ---- 自迭代状态（已知问题《需要"查看自迭代状态"的快速工具》的数据面） ----

  /**
   * 自迭代状态视图：最近一次判定结论与原因、信号计数、债务快照、门禁逐项、开关面，
   * 并在给定 `line` 时附带该线状态与三线相互领先/落后关系（多线自迭代状态）。
   * 纯读取：无记录 → null 段（诚实缺失），不触发任何演化动作。
   */
  private async evolutionStateView(line?: VersionLine): Promise<KernStatusSummary['evolution']> {
    const rec = await readEvolutionState(evolutionStateFile(this.evolutionRoot));
    const lines = await this.lineRelations();
    const target = isVersionLine(line) ? line : undefined;
    return {
      enabled: this.selfIteration.enabled,
      min_strength: this.selfIteration.minStrength,
      background_model_calls: this.selfIteration.backgroundModelCalls,
      schedule: this.selfIteration.schedule,
      last_decision: rec === null ? null : rec.decision,
      last_decision_ts: rec?.ts ?? null,
      last_decision_trigger: rec?.trigger ?? null,
      signals: rec?.signals ?? {},
      signals_total: rec?.signals_total ?? 0,
      debt: rec?.debt ?? (this.maintenance?.limitsSnapshot() ?? null),
      gates: rec?.gates ?? [],
      lines,
      line: target === undefined ? null : (lines.find((l) => l.line === target) ?? null),
      degraded: rec === null ? '尚无演化判定记录（.evolution/evolve-state.json 不存在）' : null,
    };
  }

  /** 三线状态与相互领先/落后关系（提交 + ahead/behind 计数；git 不可用 → 空数组诚实缺失） */
  private async lineRelations(): Promise<
    Array<{ line: string; commit: string | null; ahead: number; behind: number }>
  > {
    const layout = this.assemblyOpts.layout ?? defaultLayout();
    const commits = new Map<string, string | null>();
    for (const l of VALID_LINES) {
      try {
        commits.set(l, resolveLineCommit(layout, l));
      } catch {
        commits.set(l, null);
      }
    }
    const out: Array<{ line: string; commit: string | null; ahead: number; behind: number }> = [];
    for (const l of VALID_LINES) {
      const own = commits.get(l) ?? null;
      let ahead = 0;
      let behind = 0;
      for (const other of VALID_LINES) {
        if (other === l) continue;
        const theirs = commits.get(other) ?? null;
        if (own === null || theirs === null) continue;
        try {
          const counts = runGit(layout, ['rev-list', '--left-right', '--count', `${own}...${theirs}`]);
          const [a = 0, b = 0] = counts
            .trim()
            .split(/\s+/)
            .map((n) => Number.parseInt(n, 10) || 0);
          ahead += a;
          behind += b;
        } catch {
          // 单对比较失败 → 跳过（关系缺失优于错误数字）
        }
      }
      out.push({ line: l, commit: own, ahead, behind });
    }
    return out;
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
    // 自迭代开关门禁（配置面；缺省全启用 → 判定结果不变）：
    //   ① 总开关关闭 → 不演化（不生成候选、不推进版本线；仍记账 + 状态面说明）
    //   ② 触发门槛：最高触发强度低于配置门槛 → 不演化（触发条件本身较少满足时的显式调节面）
    const strongest = decision.triggers.reduce((m, t) => Math.max(m, t.strength), 0);
    const gated: EvolutionDecision =
      !decision.should_evolve
        ? decision
        : !this.selfIteration.enabled
          ? { ...decision, should_evolve: false, reason: 'disabled_by_config（selfIteration.enabled=false）' }
          : strongest < this.selfIteration.minStrength
            ? {
                ...decision,
                should_evolve: false,
                reason: `strength_below_min:${strongest}<${this.selfIteration.minStrength}`,
              }
            : decision;
    // 自迭代状态落盘（已知问题《需要"查看自迭代状态"的快速工具》）：把「刚判了什么、为什么」留给
    // 状态面——门禁逐项列出（链路总开关/触发门槛/债务硬限/日预算/后台模型调用许可/线布局）。
    // 尽力而为：写失败只记录降级，绝不影响判定结果与请求路径。
    try {
      const limits = this.maintenance?.limitsSnapshot() ?? null;
      const debtBand = limits?.band ?? 'unknown';
      const gates: EvolutionGateView[] = [
        {
          gate: '链路总开关',
          passed: this.selfIteration.enabled,
          reason: this.selfIteration.enabled ? null : 'config.selfIteration.enabled=false（配置面关闭演化与晋升）',
        },
        {
          gate: '触发门槛',
          passed: gated.triggers.length > 0,
          reason: gated.triggers.length > 0 ? null : 'no_trigger（窗口内无 evolve=true 的触发信号）',
        },
        {
          gate: '触发强度门槛',
          passed: strongest >= this.selfIteration.minStrength,
          reason:
            strongest >= this.selfIteration.minStrength
              ? null
              : `strength_below_min（最高 ${strongest} < config.selfIteration.minStrength=${this.selfIteration.minStrength}）`,
        },
        {
          gate: '债务硬限',
          passed: debtTotal < policy.evolve.debt_thresholds.hard,
          reason:
            debtTotal < policy.evolve.debt_thresholds.hard
              ? null
              : `debt_over_hard:${debtTotal}>=${policy.evolve.debt_thresholds.hard}`,
        },
        {
          gate: '后台模型调用许可',
          passed: this.selfIteration.backgroundModelCalls,
          reason: this.selfIteration.backgroundModelCalls
            ? null
            : 'background_model_calls_disabled（候选生成/语义裁判不发模型调用）',
        },
        {
          gate: '演化节律',
          passed: this.selfIteration.schedule,
          reason: this.selfIteration.schedule ? null : 'schedule_disabled（不随维护定时器运行，仅显式 /evolve now）',
        },
        {
          gate: '线布局',
          passed: this.lineSnapshot !== null,
          reason: this.lineSnapshot === null ? '旧布局（版本线快照无 kernel/policy）——候选管线不可执行' : null,
        },
      ];
      await writeEvolutionState(evolutionStateFile(this.evolutionRoot), {
        ts: Date.now(),
        trigger: this.evolutionStateTrigger,
        decision: {
          should_evolve: gated.should_evolve,
          strength: gated.strength,
          object_layer: gated.object_layer,
          budget_estimate: gated.budget_estimate,
          triggers: gated.triggers.map((t) => t.kind),
          reason: gated.reason,
        },
        signals: summary.counts,
        signals_total: Object.values(summary.counts).reduce((a, b) => a + b, 0),
        debt: {
          total: debtTotal,
          band: debtBand,
          soft: limits?.soft ?? policy.evolve.debt_thresholds.soft,
          hard: limits?.hard ?? policy.evolve.debt_thresholds.hard,
          critical: limits?.critical ?? policy.evolve.debt_thresholds.critical,
        },
        gates,
        line: this.lineSnapshot?.line ?? 'stable',
      });
    } catch (err) {
      recordDegradation('evolution/state', `自迭代状态落盘失败（${errorDetail(err)}）——状态段将缺失`);
    }
    const enqueued: string[] = [];
    if (gated.should_evolve && this.maintenance !== null) {
      // S2：债务成本从 policy.evolve.maintenance_costs 读取（装配注入——改 evolve.yaml 即生效）
      const acc = candidateValidationAccrual(policy.evolve.maintenance_costs);
      await this.enqueueAccrual(acc, this.maintenanceRun(acc.task_id, sessionId));
      enqueued.push(acc.task_id);
      await this.eventStore.append(
        makeRuntimeEvent(
          'evolution/candidate',
          sessionId,
          this.snapshotHash,
          {
            stage: 'decision',
            should_evolve: gated.should_evolve,
            strength: gated.strength,
            object_layer: gated.object_layer,
            budget_estimate: gated.budget_estimate,
            triggers: gated.triggers,
            reason: gated.reason,
            candidate_id: null, // 判定阶段候选未生成（真实 id 见 runEvolutionChain 的 stage='generated' 事件）
          },
          ['evolution_decision', 'evolution/candidate'],
        ),
      );
    }
    return { decision: gated, enqueued };
  }

  /** 空闲期演化判定任务执行体（维护量子内；低优先级、可中断——signal.aborted → AbortError 让出留队） */
  private async runEvolutionDecision(signal: AbortSignal | undefined, sessionId: string): Promise<void> {
    if (signal?.aborted === true) {
      const err = new Error('evolution_decision aborted');
      err.name = 'AbortError';
      throw err;
    }
    this.evolutionStateTrigger = 'maintenance:evolution_decision';
    await this.performEvolutionDecision(sessionId);
    this.markSubsystemOk('evolution-decision');
  }

  /** 标记来源子系统「执行体成功跑完」（债务释放的确认依据；成功路径才调用） */
  private markSubsystemOk(subsystem: string): void {
    this.lastSubsystemOk.set(subsystem, Date.now());
  }

  /**
   * 向量编码执行体（维护任务 memory_vector_encode；已知问题《新增向量检索》）。
   * 批量编码未编码记忆（`RetrievalBackend.encodePendingBatch` 继承自 VectorBackend）——
   * **纯 CPU、不占显卡、无模型调用**，可中断（signal.aborted → 让出留队）。
   * @returns 编码结果 { encoded, remaining }（供摘要与测试断言）
   */
  async runVectorEncode(signal?: AbortSignal): Promise<{ encoded: number; remaining: number }> {
    if (signal?.aborted === true) {
      const err = new Error('memory_vector_encode aborted');
      err.name = 'AbortError';
      throw err;
    }
    const r = await this.memory.encodePendingBatch();
    this.markSubsystemOk('memory-vector');
    return r;
  }

  /**
   * 关系建图执行体（维护任务 memory_relation_build；已知问题《关系图为空图》）。
   * 取一批记忆（Active/Dormant，Project 优先）→ 词法（FTS 同口径 token 的 Jaccard）+ 向量（库内余弦）
   * 合成强度 → 幂等 upsert `similar` 边（权重 = 强度，来源 = lexical/vector/both）。
   * **纯 CPU、无模型调用**、可中断（signal.aborted → 让出留队，重跑幂等）；返回本轮统计。
   */
  async runRelationBuild(signal?: AbortSignal): Promise<RelationBuildOutcome> {
    if (signal?.aborted === true) {
      const err = new Error('memory_relation_build aborted');
      err.name = 'AbortError';
      throw err;
    }
    const page = await this.memory.query({ scope: 'Project', limit: RELATION_BUILD_BATCH, budget: Number.MAX_SAFE_INTEGER });
    const memories = page.items;
    const vectors = this.memory.vectorsFor(memories.map((m) => m.id));
    const planned = planSimilarityEdges(memories, vectors);
    const applied = await applySimilarityEdges(this.memory, planned, Date.now());
    const stats = this.memory.relationStats();
    this.markSubsystemOk('memory-relation');
    return { ...applied, planned: planned.length, scanned: memories.length, edges: stats.edges };
  }

  /** 关系图观测面（状态工具/测试用：边统计 + 是否还需要建图） */
  relationStats(): RelationStats & { memories: number; needs_build: boolean } {
    const stats = this.memory.relationStats();
    const memories = this.memory.memoryCount();
    return { ...stats, memories, needs_build: relationNeedsBuild(stats.edges, memories) };
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
    // 子系统自检面：整合链成功跑完 → 标记健康（债务释放的确认依据；供维护任务与直接调用两条路径共用）
    this.markSubsystemOk('memory-consolidation');
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
        this.markSubsystemOk('environment-check'); // 核对已执行（建立基线即完成本轮检查）
        return null;
      }
      const delta = diffFingerprints(baseline, current);
      if (Object.keys(delta).length === 0) {
        this.markSubsystemOk('environment-check'); // 无变化 = 本轮核对完成
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
        // S2：repair 债务成本从 policy.evolve.maintenance_costs 读取（装配注入——改 evolve.yaml 即生效）
        const { policy } = await this.ready();
        const acc = repairAccrual(policy.evolve.maintenance_costs);
        await this.enqueueAccrual(acc, this.maintenanceRun(acc.task_id));
      }
      this.markSubsystemOk('environment-check'); // 本次环境核对完成（有衰减记录也是完成）
      return record;
    } catch {
      // 尽力而为：采集/落盘/入队失败 → 降级不抛（environment_check 是低优先级检查，不阻塞维护链）
      return null;
    }
  }

  /**
   * R5+P3/P3.5：repair 任务执行体（维护任务 repair，可公开调用——测试/命令触发）。
   * 受影响对象契约化重验证：读全部 decay 记录（.evolution/decay/）→ 去重合并受影响对象（逐对象携带
   * 所属 decay 记录的环境变化标志——environment_delta 非空 → environment_changed=true）→ 逐个
   * seedRepairContract（对象验证契约）→ 遍历契约应查检查（hard ∪ outcome 去重）→ 真实验证执行器
   * （runtime/repair-executors.ts，P3.5）逐项执行（source='runRepair:executors'；仍无法真实执行的面
   * ——无矛盾/重放一致/代表任务/冻结回归集/可恢复 → 执行器诚实 unknown，detail 注明需基线/数据面
   * （P3.6）或 judge（P2.5 搁置））→ decideVerdict（诚实三态）→ classifyRepairDamage（损坏类型分类）
   * → applyRepairDisposition（处置语义）→ 逐对象记录 {id, kind, contract_id, verdict, evidence_quality,
   * disposition, score_eligible, reason, detail?} 落盘 .evolution/repair/<ts>.json；clear_suspicious 且
   * memory 对象 → lifecycle 恢复 Active（清除存疑）。
   * judgeChecks 为 P3 语义补充验证器证据注入面（与 P2 shadow judgeChecks 同模式；真实 LLM judge 生产
   * 调用搁置（P2.5——用户 2026-08-25 裁决：多数用户负担不起第二模型成本，注入面保留）——不提供 →
   * 不产补充证据 → 诚实 UNKNOWN）。任务成功 return → 调度器清债。无待 repair 对象
   * （decay 无记录/受影响对象为空/对象已删除）→ 同样合法完成清债。
   * 幂等：重复执行同结果（判定确定性——同证据同输入 → 同输出；审计记录追加、不抛错）。
   */
  async runRepair(
    judgeChecks?: Array<{ name: string; result: 'pass' | 'fail' | 'unknown'; detail?: string }>,
  ): Promise<RepairRecord> {
    // P3.5：真实验证执行器懒构造（实例字段缓存——重复执行幂等；构造失败降级记录不抛——
    // 执行器不可用 → 全检查 unknown → 诚实 UNKNOWN，不阻塞 repair）。检索以 episode=false 只读语义注入。
    // P3.6：验证数据面（事实库/基线库）注入——六个缺数据面检查（无矛盾/重放一致/代表任务/冻结回归集/
    // 可恢复）只读数据面执行（stores duck-typed 最小形状；真实 store 经此注入）。
    if (this.repairExecutors === null) {
      try {
        this.repairExecutors = createRepairExecutors({
          memory: {
            getById: (id) => this.memory.getById(id),
            retrieve: (q) => retrieve(this.memory, q as RetrieveQuery, { episode: false }),
          },
          components: this.components,
          lineSnapshot: this.lineSnapshot,
          policyDir: this.policyDir,
          processesDir: this.processesDir,
          loadPolicy,
          loadProcesses,
          stores: { facts: this.factStore, baselines: this.baselineStore },
        });
        this.repairExecutorsDegraded = null;
      } catch (err) {
        this.repairExecutors = null;
        this.repairExecutorsDegraded = errorDetail(err); // 构造失败降级记录（不抛）
      }
    }
    // decay 目录不存在 = 从未有环境变化记录（首次运行/无衰减）→ 无待修复对象，合法完成（不抛）
    const files = (await readdir(this.decayDir).catch(() => [] as string[]))
      .filter((f) => f.endsWith('.json'))
      .sort();
    // 受影响对象合并（逐对象携带环境变化标志：所属任一 decay 记录 environment_delta 非空 → true）
    const affected = new Map<string, { ref: ArtifactRef; environment_changed: boolean }>();
    for (const f of files) {
      try {
        const rec = JSON.parse(await readFile(join(this.decayDir, f), 'utf8')) as CapabilityDecayRecord;
        const envChanged =
          rec.environment_delta !== undefined && Object.keys(rec.environment_delta).length > 0;
        for (const obj of rec.affected_objects ?? []) {
          const prev = affected.get(obj.id);
          affected.set(obj.id, {
            ref: obj,
            environment_changed: (prev?.environment_changed ?? false) || envChanged,
          });
        }
      } catch {
        // 损坏 decay 记录跳过（尽力而为；不阻塞重验证）
      }
    }
    const objects: RepairObjectOutcome[] = [];
    const missing: ArtifactRef[] = [];
    for (const [id, entry] of affected) {
      // kind 映射：ArtifactRef 'experience' → 'memory'；其余原样传入（seedRepairContract generic 兜底）
      const kind = entry.ref.kind === 'experience' ? 'memory' : entry.ref.kind;
      const m = await this.memory.getById(id);
      if (m === undefined) {
        missing.push(entry.ref); // 引用对象已删除 → 无可修（missing 语义不变：跳过留痕）
        continue;
      }
      // 对象验证契约 → 应查检查（hard ∪ outcome，去重保序）→ 真实验证执行器逐项执行（P3.5）：
      // source='runRepair:executors'；仍未决的检查（无矛盾/重放一致/代表任务/冻结回归集/可恢复）由执行器
      // 诚实 unknown（detail 注明需基线/数据面（P3.6）或 judge（P2.5 搁置））——不臆造证据。
      const contract = seedRepairContract(kind, id);
      const detVerifier = contract.verifiers.find((v) => v.kind === 'deterministic')!;
      const evidence: VerificationEvidence[] = [];
      const detailParts: string[] = [];
      // P3.6：逐检查执行结果（基线注册判定用——对象结构类检查全 pass 才注册；执行器不可用 → 空 → 不注册）
      const checks: Array<{ name: string; result: 'pass' | 'fail' | 'unknown'; detail?: string }> = [];
      if (this.repairExecutors !== null) {
        const expected: string[] = [];
        const seenCheck = new Set<string>();
        for (const name of [...contract.hard_constraints, ...contract.outcome_conditions]) {
          if (!seenCheck.has(name)) {
            seenCheck.add(name);
            expected.push(name);
          }
        }
        // P3.6：版本化对比当前态注入（环境指纹/运行时快照/验证器版本——与基线全匹配判定；
        // 与首次基线注册同源：注册时存的就是同一组当前态，第二次起可版本化对比）
        const current = {
          environment_fingerprint: this.fingerprintCollector(),
          runtime_snapshot: this.snapshotHash,
          verifier_version: VERIFIER_VERSION,
        };
        for (const name of expected) {
          const outcome = await this.repairExecutors.executeCheck(name, { objectId: id, kind, payload: m, current });
          checks.push({ name, result: outcome.result, ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}) });
          detailParts.push(`${name}=${outcome.result}`);
        }
        if (checks.length > 0) {
          evidence.push({
            verifier_id: `repair:${kind}:deterministic`,
            contract_id: contract.id,
            checks,
            ts: Date.now(),
            source: 'runRepair:executors',
          });
        }
      } else if (this.repairExecutorsDegraded !== null) {
        // 执行器构造失败降级：不产确定性证据（全检查 unknown → 诚实 UNKNOWN）；记录降级原因
        detailParts.push(`执行器不可用（${this.repairExecutorsDegraded}）`);
      }
      // 语义补充一级：judgeChecks 注入面（P3 与 P2 shadow 同模式；真实 LLM judge 生产调用搁置
      //（P2.5——用户 2026-08-25 裁决：多数用户负担不起第二模型成本，注入面保留）——不提供 → 不产补充
      // 证据 → 诚实 UNKNOWN）
      if (judgeChecks !== undefined && judgeChecks.length > 0) {
        evidence.push({
          verifier_id: `repair:${kind}:judge`,
          contract_id: contract.id,
          checks: judgeChecks.map((c) => ({ name: c.name, result: c.result, detail: c.detail })),
          ts: Date.now(),
          source: 'runRepair:judge',
        });
      }
      const result = decideVerdict(contract, evidence);
      // 损坏类型分类（优先级不可协商）：内部确定性验证器 L1 ≥ trust_required L1（trustGate 校验）→
      // verifier_trusted=true；uncontrollable 恒 false（环境/外部不可控面后续经契约 controllability 注入）；
      // structural_checks = 契约 hard_constraints（FAIL 时命中任一 → 结构损坏）
      const damage = classifyRepairDamage(result, {
        environment_changed: entry.environment_changed,
        verifier_trusted: trustGate(detVerifier.trust, contract.trust_required),
        uncontrollable: false,
        structural_checks: contract.hard_constraints,
      });
      const disp = applyRepairDisposition(kind, id, damage);
      // P3.6：首次基线注册（判定后执行——不改变本次 verdict）——对象结构类检查（hard 约束）全 pass
      // 且该 kind 映射的基线不存在 → 自动注册版本化基线（kind 映射：memory→无；process→'process'；
      // skill→'skill-task'；policy→'policy-regression'；projection→'projection-rebuild'；input = 对象
      // payload/契约摘要；environment_fingerprint = 当前环境指纹（采集器注入面，缺省 collectEnvironmentFingerprint）；
      // runtime_snapshot = 当前快照哈希；expected_result = 本次判定摘要；verifier_version = '1'）→
      // detail 注明「基线已注册，下次可版本化对比」；注册失败降级记录不抛（尽力而为——注册面缺失不阻塞验证主链）
      const baselineKind = REPAIR_KIND_TO_BASELINE[kind];
      const hardPass =
        baselineKind !== undefined &&
        contract.hard_constraints.every((h) => checks.some((c) => c.name === h && c.result === 'pass'));
      if (hardPass) {
        try {
          if ((await this.baselineStore.getBaseline(id, baselineKind)) === null) {
            await this.baselineStore.registerBaseline({
              id,
              kind: baselineKind,
              input: baselineInputOf(m, { kind, id, contract_id: contract.id }),
              environment_fingerprint: this.fingerprintCollector(),
              runtime_snapshot: this.snapshotHash,
              expected_result: {
                verdict: result.verdict,
                evidence_quality: result.evidence_quality,
                disposition: disp.disposition,
              },
              verifier_version: VERIFIER_VERSION,
            });
            detailParts.push('基线已注册，下次可版本化对比');
          }
        } catch {
          // 基线注册失败降级记录不抛（尽力而为——数据面损坏/不可写不阻塞验证主链）
        }
      }
      objects.push({
        id,
        kind,
        contract_id: contract.id,
        verdict: result.verdict,
        evidence_quality: result.evidence_quality,
        disposition: disp.disposition,
        score_eligible: disp.score_eligible,
        reason: disp.reason,
        // P3.5：逐检查结果聚合（检查名=result；'；' 分隔——审计可回溯；执行器不可用 → 降级原因）
        ...(detailParts.length > 0 ? { detail: detailParts.join('；') } : {}),
      });
      // S2：验证债务入队（per-object verdict=UNKNOWN 且 evidence_quality < 1 → 未决验证维护期复核；
      // key=`repair:${objectId}` 同键覆写去重；尽力而为——失败降级记录不抛，不阻塞 repair 主链）
      if (result.verdict === 'UNKNOWN' && result.evidence_quality < 1) {
        try {
          await this.verificationDebt.enqueue({
            key: `repair:${id}`,
            kind: 'repair',
            contract_id: contract.id,
            object_ref: id,
            materials: {
              kind,
              verdict: result.verdict,
              evidence_quality: result.evidence_quality,
              disposition: disp.disposition,
            },
          });
        } catch (err) {
          recordDegradation('verification/debt', `repair 验证债务入队失败（${errorDetail(err)}）——尽力而为`);
        }
      }
      // 处置执行：仅 memory 对象且 clear_suspicious → 清除存疑（lifecycle 恢复 Active——检索面恢复
      // 正常权重）；失败降级记录不抛。degrade_or_rollback（降级/回滚）与 quarantine（隔离标记）的
      // 落地动作属后续语义（P4 注记）——其余处置仅记录（保持 suspicious/不动）。
      if (disp.disposition === 'clear_suspicious' && kind === 'memory') {
        try {
          await this.memory.update(id, { lifecycle: 'Active' });
        } catch {
          // 单对象清除失败 → 跳过（objects 记录仍留痕；不阻塞 repair）
        }
      }
    }
    // reverified 语义（P3）：verdict=PASS 的对象（契约化重验证通过）
    const reverified: ArtifactRef[] = objects
      .filter((o) => o.verdict === 'PASS')
      .map((o) => ({ id: o.id, kind: o.kind }));
    const record: RepairRecord = {
      ts: Date.now(),
      task: 'repair',
      decay_records: files.length,
      affected_objects: [...affected.values()].map((e) => e.ref),
      reverified,
      missing,
      objects,
    };
    await mkdir(this.repairDir, { recursive: true });
    let file = join(this.repairDir, `${record.ts}.json`);
    let n = 0;
    while (existsSync(file)) {
      n++;
      file = join(this.repairDir, `${record.ts}-${n}.json`);
    }
    await writeFile(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    // 子系统自检面：修复链本次执行完成（对象级判定见 record.objects）→ 标记健康（债务释放的确认依据）
    this.markSubsystemOk('repair-chain');
    return record;
  }

  /**
   * S2：验证债务复核执行体（维护任务 verification_review，可公开调用——测试/命令触发）。
   * 阶梯式验证注记（用户裁决 S6）：机械 → 外部 → 历史/回归 → 单次结构化裁判 → UNKNOWN 合法终态——
   * 债务复核 = 阶梯末级「单次结构化裁判」：空白子代理同模型单次判定（P2.5 搁置解除，用户
   * 2026-08-25 裁决——同模型不增加第二个订阅成本、spawn 全新会话、toolFilter:[] 纯文本），
   * 仅验证债务路径触发、正常任务 0 额外成本；不污染普通请求。
   * 逐条处理（debt.listPending(3)——每次最多 3 条，最老优先）：
   *   judgeExecutor.available → judge(materials, signal)：
   *     PASS/FAIL → markResolved（resolution {verdict, judge_used:true, ts}——债务清偿）；
   *     UNKNOWN → bumpAttempts，attempts>=2 → markPendingManual（低频人工复核——不无限重试）；
   *     judge 返回 null（输出不可解析/spawn 抛错）→ 视同 UNKNOWN（bumpAttempts 重试——债务保留）；
   *   judge 不可用（未装配）→ markPendingManual（resolution.detail 记「judge 不可用」——诚实降级）。
   * signal.aborted → 让出（不标记——债务保留，下次量子继续）。
   * 全部尽力而为：单条抛错 → 降级记录不抛（债务保留）；队列空 → 正常完成（无事可做即成功）。
   */
  async runVerificationReview(signal?: AbortSignal): Promise<void> {
    let pending: Array<{ key: string; attempts: number; materials: unknown }> = [];
    try {
      pending = await this.verificationDebt.listPending(3);
    } catch (err) {
      recordDegradation('verification/review', `债务读取失败（${errorDetail(err)}）——复核跳过（债务保留）`);
      return;
    }
    for (const rec of pending) {
      if (signal?.aborted === true) {
        return; // 让出（不标记）——债务保留，下次量子继续
      }
      try {
        if (this.judgeExecutor === null || !this.judgeExecutor.available) {
          // judge 不可用（未装配）→ 转人工复核（低频人工复核标记——不假装判定）
          await this.verificationDebt.markPendingManual(rec.key, 'judge 不可用——空白子代理未装配（诚实降级）');
          continue;
        }
        const m = (rec.materials ?? {}) as { goal?: unknown; success_criteria?: unknown };
        const goal =
          typeof m.goal === 'string' && m.goal.length > 0 ? m.goal : `验证债务 ${rec.key}`;
        const success_criteria = Array.isArray(m.success_criteria)
          ? m.success_criteria.filter((c): c is string => typeof c === 'string')
          : [];
        const materials =
          typeof rec.materials === 'string' ? rec.materials : JSON.stringify(rec.materials ?? {});
        const verdict = await this.judgeExecutor.judge({ goal, success_criteria, materials }, signal);
        if (verdict === null) {
          // judge 未产出判定（输出不可解析/spawn 抛错）→ 视同 UNKNOWN（重试；债务保留）
          const attempts = await this.verificationDebt.bumpAttempts(rec.key);
          if (attempts !== null && attempts >= 2) {
            await this.verificationDebt.markPendingManual(rec.key, 'UNKNOWN 两次未决——转低频人工复核');
          }
          continue;
        }
        if (verdict.verdict === 'PASS' || verdict.verdict === 'FAIL') {
          // 高置信裁决 → 债务清偿（resolution 落盘可审计）
          await this.verificationDebt.markResolved(rec.key, {
            verdict: verdict.verdict,
            judge_used: true,
            ts: Date.now(),
          });
          continue;
        }
        // UNKNOWN（合法终态——不强迫猜）→ 重试计数；>=2 → 转人工复核
        const attempts = await this.verificationDebt.bumpAttempts(rec.key);
        if (attempts !== null && attempts >= 2) {
          await this.verificationDebt.markPendingManual(rec.key, 'UNKNOWN 两次未决——转低频人工复核');
        }
      } catch (err) {
        // 单条复核失败 → 降级记录不抛（债务保留——不清偿不标记，下次量子重试）
        recordDegradation('verification/review', `复核失败（${rec.key}）：${errorDetail(err)}——债务保留`);
      }
    }
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
      this.evolutionStateTrigger = 'evolve-command:now';
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
        // W3（未接线审计修复 2026-08-25）：候选验证增强通道注入——生产宿主面存在（plugin.ts readService
        // ctx.dynamicCordisRunner）→ 候选验证脚本经 runner 通道（G3-exec 优先：define→run→invoke→
        // stop→undefine）；undefined → 管线守卫自动降级受限子进程路径（既有行为不变，诚实降级）
        dynamicRunner: this.dynamicRunner,
        snapshotHash: this.snapshotHash,
        shadowLogPath: join(this.evolutionRoot, 'shadows', 'exposure.log'),
        sourceEvents: [`evolution/candidate:${draft.id}`],
        // P4：候选验证契约门禁（kernel 纯函数注入——seed → evidence → decideVerdict + trust + 非循环；
        // DAG：runtime(2) → kernel(2) ✓；supervisor 不 import kernel 逻辑）
        verificationGate: async (ctx) => {
          const g = runCandidateGate(ctx.draft, {
            g1: ctx.validation.gates.g1?.ok === true,
            g3: ctx.validation.gates.g3?.ok === true,
            g4: ctx.validation.gates.g4?.ok === true,
          });
          return {
            ok: g.ok,
            reason: g.reason,
            verification: g.ok
              ? { verdict: g.result.verdict, verifier_trust: 'L2', contract_id: g.result.contract_id }
              : undefined,
          };
        },
      });
      outcomes.push(outcome);
      if (outcome.promoted && outcome.commit_hash !== undefined && outcome.object_id !== undefined) {
        events += 1; // evolution/promoted（pipeline 内入链）
        this.invalidateShadowCaches(); // S7：候选晋升 → trusted-latest 推进/线内容变化 → shadow 路由缓存失效
        return {
          outcomes,
          promoted: { candidate_id: outcome.candidate_id, object_id: outcome.object_id, commit_hash: outcome.commit_hash },
          events_appended: events,
        };
      }
    }
    this.invalidateShadowCaches(); // S7：候选管线跑完（trusted-latest 可能已推进）→ shadow 路由缓存失效
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
      // L2 统计（.evolution/shadows/——S7 exposure-<date>.jsonl + 既有 exposure.log 一并纳入；
      // 无样本 → 记录不阻塞，以基准门禁为准）
      const shadow = await readShadowSignals(join(this.evolutionRoot, 'shadows'));
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
      // P4：验证契约信任门禁需读取的 Evolution Object（loadEvolutionObject 结果传入 promoteToStable；
      // 无对象（旧布局/首个候选前）→ 门禁跳过——既有行为不变）
      const object = objectId !== null ? await loadEvolutionObject(layout, latest, objectId) : null;
      const pr = await promoteToStable(
        {
          gate,
          candidate_commit: latest,
          stable_commit: stable,
          bench,
          object_id: objectId ?? undefined,
          object: object ?? undefined,
          activation_scope: 'project',
        },
        {
          layout,
          activationLogDir: join(this.evolutionRoot, 'activations'),
          eventStore: this.eventStore,
          sessionId,
          snapshotHash: this.snapshotHash,
          // P4：stable 晋升信任门禁（kernel 纯函数注入——VerifierTrust < required 拒绝 / 非循环检查 /
          // 无验证记录 fail-closed；DAG：runtime(2) → kernel(2) ✓；supervisor 不 import kernel 逻辑；
          // verification 载荷窄化为门禁最小视图）
          verificationGate: async (obj) =>
            stablePromotionTrustGate({
              id: obj.id,
              verification:
                obj.verification !== null && typeof obj.verification === 'object'
                  ? (obj.verification as { verdict?: string; verifier_trust?: string })
                  : undefined,
            }),
        },
      );
      if (!pr.promoted) {
        this.markSubsystemOk('promotion-check'); // 门禁判定完成（未推进也是真实检查结果）
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
      this.markSubsystemOk('promotion-check');
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
