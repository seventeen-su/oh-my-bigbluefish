// OMB v2 维护调度器完整版（架构 §12.3 Maintenance Queue/Debt/Quantum + §9.1 Predictive
// Invalidation + §9.5 ROI + §4.4 Fingerprint）：
// - 调度：统一按 ROI = value/estimated_cost（降序），priority 为 tie-break；critical 强制最前。
// - Debt：失败/未执行（中断、hard 限跳过）→ 累计（value 累加 + accumulated_at 更新）；成功 → 清除；
//   R5：DeferredMaintenanceError（未实现/不可执行）→ 出队但债务保留（不清债）+ deferredEvents 记录
//   （不视为失败崩溃——队列继续；「未实现/未完成 → debt 保留」不再空实现假成功清债）。
//   持久化 .evolution/debt.json（原子写 tmp+rename）。soft 限 → quantum 频率提升（tick 间隔减半）；
//   hard 限 → 非必要（normal）任务跳过；critical → 下一 quantum/tick 优先。
//   加载剪除（2026-08-25）：加载时剪除不可再服务的历史僵尸（turn-finalize:* 与 gc）——调度只执行
//   enqueue 队列，恢复的债务永不清偿（gc 债务已随 7701fde 移除入账；turn-finalize 为会话级收尾，
//   重启后属主会话已不存在）。
// - Quantum：requestQuantum 每次执行 1 个任务（可中断：外部 AbortSignal 与 stop() 的 inFlight
//   signal 经 AbortSignal.any 合并后传入 run——abort 抛 AbortError 即让出，任务留队可重试）；
//   tick 批量（定时器驱动，start() 启动）。
// - Predictive Invalidation：Fingerprint diff → 受影响对象 markSuspicious（deps 注入）+ 最小回归
//   子集 → CapabilityDecayRecord（能力衰减 = 每变化字段 × CAPABILITY_DECAY_FACTOR，待标定 §17）。
// - 退出即停：stop() 清定时器/队列并中断在飞任务；stop 后 tick/requestQuantum 无动作。
// - M3 兼容：enqueue 接受 {id, run} 形状（缺省 value=1/cost=1/priority=0/urgency='normal'）且返回
//   Promise<void> 与 M3 最小接口同形；注意完整版 enqueue = 入队（M3 最小实现为直接执行），执行异步。
// - P1c §10.1 债务语义：enqueue(input, { accrueDebt: true }) → 入队同时累计债务（事件入队累加 value，
//   立即持久化）；任务成功 → 清偿（归零）；失败/中断/hard 跳过 → 已入账债务不再重复累计（防双计）。
//   既有默认（accrueDebt: false）行为不变（仅失败/跳过/中断累计）。
// - S2 维护观测：每任务执行后追加写 .evolution/maintenance-observations/<yyyy-mm-dd>.jsonl
//   （{ts, task_id, duration_ms, result: success|deferred|failed|interrupted, debt_before, debt_after}；
//   幂等建目录、失败降级不阻塞调度）；observationsSummary() 摘要（今日任务数 + 各任务平均耗时）供 kern_status；
//   成本注入面 maintenanceCosts/setMaintenanceCosts（装配时传 policy.evolve.maintenance_costs——§10.1
//   estimated_cost 数据化；enqueue 未给 cost 且 id 命中 → 用 policy 成本，未列出 id 仍 M3 缺省 1）。
// layer 1（supervisor/）：仅 node: 内置 + kernel/schemas/（契约例外）+ supervisor/ 内文件。
import { existsSync, readFileSync, statSync } from 'node:fs';
import { appendFile, mkdir, readFile as readFileAsync, rename, rm, stat as statFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Fingerprint } from '../kernel/schemas/base.js';
import type { MaintenanceUrgency } from '../kernel/schemas/evolution.js';

// ---- 类型 ----

export type Urgency = MaintenanceUrgency;

/**
 * R5：维护任务 Deferred（未实现/不可执行）语义——任务抛出本错误 → 调度器**出队但不清债**
 * （债务保留）+ 记录 deferred 事件 + 不视为失败崩溃（队列继续）。
 * 与真实失败（普通 Error）的差异仅在可观测性（deferredEvents 记录）——两者债务语义一致：
 * 「未实现/未完成任务 → debt 保留不清零」（不再空实现假成功清债，评估依据 §13）。
 */
export class DeferredMaintenanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeferredMaintenanceError';
  }
}

/** 待执行队列的盘上形状（只落元数据：执行体是函数，由 opts.restoreTask 按 id 重建） */
export interface PendingQueueEntry {
  id: string;
  value: number;
  estimated_cost: number;
  priority: number;
  urgency: string;
  /** 债务来源子系统（重建后仍可对账；缺失 → 无主） */
  subsystem?: string;
  reason?: string;
  /** 该任务债务是否"入队即累计"（重建后恢复防双计标记） */
  accrued_at_enqueue?: boolean;
  /** 入队时间（审计：重启后能看出这条任务等了多久） */
  enqueued_at?: number;
  /** critical 标记（重建后仍按请求边界强制优先） */
  critical?: boolean;
}

/** urgency 形状校验（损坏条目回退 'normal'——不因单个坏字段丢弃整条任务） */
function isUrgency(v: unknown): v is Urgency {
  return v === 'normal' || v === 'soft' || v === 'hard' || v === 'critical';
}

/** Deferred 事件记录（未实现/不可执行任务：task_id + 时间 + 原因；仅可观测，不参与调度） */
export interface DeferredEvent {
  task_id: string;
  at: number;
  reason: string;
}

export interface MaintenanceTask {
  id: string;
  value: number;
  estimated_cost: number;
  priority: number;
  urgency: Urgency;
  /** 债务来源子系统（债务来源记录；入队方标注——见 DebtSourceView） */
  subsystem?: string;
  /** 债务原因（可读；入队方标注） */
  reason?: string;
  run: (signal?: AbortSignal) => Promise<void>;
}

/** M3 最小接口形状兼容：{id, run} 必需，其余缺省（value=1/estimated_cost=1/priority=0/urgency='normal'） */
export type MaintenanceTaskInput = Pick<MaintenanceTask, 'id' | 'run'> &
  Partial<Pick<MaintenanceTask, 'value' | 'estimated_cost' | 'priority' | 'urgency' | 'subsystem' | 'reason'>>;

export interface MaintenanceDebt {
  task_id: string;
  value: number;
  accumulated_at: number;
  priority: number;
  estimated_cost: number;
  urgency: string;
  /**
   * 债务来源子系统（已知问题「债务是保护性自锁，需要修复后释放」修复）——哪一次失败/跳过/异常、
   * 涉及哪个子系统；由入队方（kernel/evolve-decision.ts 的入账函数）标注，缺省 undefined = 无主债务
   * （历史条目 / 未知来源），进人工裁定清单而**不做自动清除**。
   */
  subsystem?: string;
  /** 债务原因（可读，来自入账方；如 '信号 corrections/oracle_fail → 受影响对象需重验证'） */
  reason?: string;
  /** 该债务首次累计时间（跨多次累计保持不变——用于「长期无主」判定） */
  first_seen?: number;
  /** 该债务最近一次累计时间（失败/跳过/异常的发生时间） */
  last_failure?: number;
}

/** 债务来源快照（状态面/释放流程可读——回答「这条债是哪来的、现在能不能放」） */
export interface DebtSourceView {
  task_id: string;
  value: number;
  subsystem: string | null;
  reason: string;
  first_seen: number;
  last_failure: number;
  /** 无来源子系统（历史条目/未知来源）→ 只能进人工裁定，不自动释放 */
  orphan: boolean;
  /** 无主且已超过人工裁定阈值时长 → 进待人工裁决清单 */
  manual_pending: boolean;
  /** 是否为「改动类」演化任务债务（受硬限约束者）——保护语义的直接观测面 */
  evolution_mutating: boolean;
}

/** 一次债务释放审计记录（`.evolution/debt-releases.jsonl` 每行一条；可回溯依据/触发者/时间） */
export interface DebtReleaseRecord {
  ts: number;
  task_id: string;
  /** 释放前该条债务累计值 */
  value: number;
  subsystem: string | null;
  /** 释放依据：子系统自检结果（如检查项名/结论） */
  evidence: string;
  /** 触发者（谁能证明修好了：如 maintenance:runRepair / evolve:promotion_check） */
  released_by: string;
  reason: string;
}

/** 无法对应到任何修复动作的条目 → 待人工裁决清单条目（不做自动清除） */
export interface DebtManualPendingRecord {
  ts: number;
  task_id: string;
  value: number;
  reason: string;
  /** 触发复核者（构造该清单的调用方） */
  reviewed_by: string;
}

/** 债务释放结果（releaseDebt 返回；released=false 时 reason 说明为何不释放） */
export interface DebtReleaseResult {
  released: boolean;
  task_id: string;
  value: number;
  reason: string;
}

// ---- S2：维护观测（§10.1 estimated_cost 标定数据源——真实执行耗时/结果落盘，供观测积累后标定） ----

/** 维护任务执行结果（S2 观测：success 成功清偿 / deferred 未实现（R5）/ failed 真实失败 / interrupted 中断让出） */
export type MaintenanceObservationResult = 'success' | 'deferred' | 'failed' | 'interrupted';

/** 单次维护任务执行观测（追加写 .evolution/maintenance-observations/<yyyy-mm-dd>.jsonl，每行一条） */
export interface MaintenanceObservation {
  /** 任务开始时间（epoch ms；观测按日分文件用） */
  ts: number;
  task_id: string;
  duration_ms: number;
  result: MaintenanceObservationResult;
  /** 执行前该任务已累计债务（accrueDebt 入队即累计；未入账 → 0） */
  debt_before: number;
  /** 执行后该任务债务（success 清偿 → 0；deferred/failed/interrupted 保留/累计 → 非零） */
  debt_after: number;
}

/** S2：观测摘要（kern_status 可读入口——今日任务数 + 各任务平均耗时；per_task 按 task_id 排序，确定性） */
export interface MaintenanceObservationSummary {
  date: string;
  total: number;
  per_task: Array<{ task_id: string; count: number; avg_duration_ms: number }>;
}

/** 观测按日分文件（<yyyy-mm-dd>.jsonl；UTC 日期——与 signals 同约定，跨时区一致） */
function utcDay(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/** 观测文件身份（缓存键：日期 + mtime + 大小——任一变化即重新读取，保证摘要不陈旧） */
interface ObservationCacheIdentity {
  date: string;
  mtimeMs: number;
  size: number;
}

/** 文件身份比对（无 stat 信息时（-1/-1）视为不一致 → 重新读取，宁可多读也不错报） */
function sameIdentity(a: ObservationCacheIdentity, b: { mtimeMs: number; size: number }): boolean {
  return a.mtimeMs >= 0 && a.size >= 0 && a.mtimeMs === b.mtimeMs && a.size === b.size;
}

/**
 * 当日观测 JSONL → 摘要（纯函数：损坏行跳过、按 task_id 聚合、确定性排序）。
 * 抽成纯函数后同步/异步两条路径共用同一口径（避免"缓存命中与未命中给不同结果"这类隐蔽分叉）。
 */
function summarizeObservations(raw: string, date: string): MaintenanceObservationSummary {
  const perTask = new Map<string, { count: number; totalMs: number }>();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const obs = JSON.parse(trimmed) as MaintenanceObservation;
      if (typeof obs.task_id !== 'string') continue;
      const agg = perTask.get(obs.task_id) ?? { count: 0, totalMs: 0 };
      agg.count++;
      agg.totalMs += typeof obs.duration_ms === 'number' ? obs.duration_ms : 0;
      perTask.set(obs.task_id, agg);
    } catch {
      // 损坏观测行跳过（观测为审计日志——不因坏行崩摘要）
    }
  }
  const per_task = [...perTask.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([task_id, agg]) => ({
      task_id,
      count: agg.count,
      avg_duration_ms: agg.count > 0 ? Math.round(agg.totalMs / agg.count) : 0,
    }));
  const total = per_task.reduce((acc, p) => acc + p.count, 0);
  return { date, total, per_task };
}

export interface QuantumReport {
  ran: string[];
  skipped: string[];
}

export interface AffectedObject {
  id: string;
  kind: string;
}

/** 能力衰减曲线记录（§9.1）：一次 fingerprint 失效 = 曲线上一个点 */
export interface CapabilityDecayRecord {
  /** 变化的环境字段（§4.4：os/node/dsh_version/project/gpu/cuda） */
  environment_delta: Record<string, { from: string | undefined; to: string | undefined }>;
  /** 受影响对象（经验/过程/技能） */
  affected_objects: AffectedObject[];
  /** 最小回归子集：受影响对象 id 列表（只跑受影响切片） */
  regression_set: string[];
  capability_before: number;
  capability_after: number;
  attribution: string;
}

export interface PredictiveInvalidationDeps {
  /** 声明了旧指纹的受影响对象（调用方按指纹索引解析） */
  affectedObjects: AffectedObject[];
  /** 注入的降级动作：把受影响对象标记为 suspicious */
  markSuspicious: (obj: AffectedObject) => void;
}

export interface MaintenanceSchedulerOptions {
  /** 债务持久化文件（缺省 workspace/.omb/.evolution/debt.json；根 .gitignore 已覆盖该目录） */
  debtFile?: string;
  /** S2：维护观测落盘目录（缺省 <debtFile 同目录>/maintenance-observations =
   *  .evolution/maintenance-observations；按日分文件 <yyyy-mm-dd>.jsonl） */
  observationsDir?: string;
  /** S2：维护任务成本注入面（装配时传 policy.evolve.maintenance_costs；enqueue 未给 estimated_cost
   *  且任务 id 命中 → 用 policy 成本，未列出 id 仍 M3 缺省 1；setMaintenanceCosts 可后续覆写） */
  maintenanceCosts?: Readonly<Partial<Record<string, number>>>;
  /** soft 阈值：债务合计 ≥ → quantum 频率提升（tick 间隔减半） */
  softLimit?: number;
  /** hard 阈值：债务合计 ≥ → 非必要（urgency='normal'）任务跳过 */
  hardLimit?: number;
  /** critical 阈值：债务合计 ≥ → 状态面报告 critical 档（§6.5.7；展示与判定用，不改变跳过语义） */
  criticalLimit?: number;
  /** tick 基准间隔（ms）；start() 启动定时器 */
  tickIntervalMs?: number;
  /**
   * 单次调用的任务批量上限（tick/requestQuantum）。
   * 缺省 1 = 每次最多执行 1 个任务（既有单量子语义不变）。
   * 生产装配传 >1 → 一次 tick 批量消费多个任务，解决「单量子名额导致 ROI 饥饿」：队列里高位任务
   * （如会话收尾 ROI 1.0）清空后，同一批内继续消费演化判定/晋升检查（ROI 0.5），不必等下一轮请求。
   * 上限受 MAINTENANCE_BATCH_MAX 约束（防单次调用长时间占用）。
   */
  batchSize?: number;
  /** 时钟注入（测试）；缺省 Date.now */
  now?: () => number;
  /**
   * 任务重建面（已知问题《债务与"还债的人"不同源》修复）：`id → 执行体工厂`。
   * 队列**跨重启持久化**（`<debtFile 同目录>/queue.json`）；加载时按此面重建可重建的任务，
   * 使"盘上还有债务"与"负责还债的任务仍在队列里"同源——否则重启后债务只增不减，
   * 累积到硬限后反而把该修的改动类任务一起锁住。
   *
   * 未注册工厂的任务 id（如会话级收尾 `turn-finalize:*`——属主会话重启后已不存在）
   * → 队列项剪除，对应债务转为**无主债务**（进人工裁定清单，不自动清除）。
   */
  restoreTask?: (id: string) => ((signal?: AbortSignal) => Promise<void>) | null;
}

// ---- 常量（阈值/系数待标定，§17） ----

export const DEFAULT_SOFT_LIMIT = 10;
export const DEFAULT_HARD_LIMIT = 50;
/** critical 阈值缺省（§6.5.7 critical → 请求边界强制插入 quantum；与 evolve.yaml debt_thresholds.critical 对齐） */
export const DEFAULT_CRITICAL_LIMIT = 100;
/** 单次调用（tick/requestQuantum）的任务批量硬上限——防 batchSize 配置过大导致单次调用长时间占用 */
export const MAINTENANCE_BATCH_MAX = 16;
/**
 * 关停排空超时缺省（ms）：`stop()` 已中断在飞 signal（可中断任务会立刻让出），此上限只兜住
 * "任务体不检查 signal"的少数情况——够长以覆盖正常长任务（记忆整合/事件库 VACUUM），
 * 又不至于让宿主退出长时间挂住。超时 → drain 返回 drained=false 由调用方如实记录。
 */
export const DEFAULT_DRAIN_TIMEOUT_MS = 10_000;
/** 静默点轮询间隔（ms；只在非静默时轮询，静默时零开销） */
const IDLE_POLL_MS = 25;
/** 批量缺省值：1 = 既有单量子语义（每次最多执行 1 个任务）；生产装配显式调高以消除 ROI 饥饿 */
export const DEFAULT_BATCH_SIZE = 1;
/**
 * 生产装配的批量缺省（插件装配传入）：一次 tick 在请求间隙最多消费 4 个维护任务。
 * 取值依据（已知问题「单量子名额导致 ROI 饥饿」）：队列每轮固定入队「会话收尾 ROI 1.0 +
 * 演化判定/晋升检查/环境检查 ROI 0.5」→ 单名额时收尾任务恒胜，判定类任务永无名额；批量 4
 * 使同一批内先清收尾、再依次消费判定/检查类任务，同时受 §9.4「维护量子 ≥ 典型任务耗时」
 * 约束（真实基准 latency P90 ≈ 2.1s，tick 间隔 60s 余量约 29× → 4 个任务仍远小于间隔）。
 */
export const DEFAULT_MAINTENANCE_BATCH = 4;
/** tick 基准间隔（ms）；start() 启动定时器。§17 标定验证（T8.20，2026-08-21，主会话裁决「仅记录不写回」）：
 *  约束「维护量子 ≥ 典型任务耗时」由 latency_ms 均值 3973ms（workspace/.omb/bench/bench-*.json，数据来源标注
 *  于 task-m8d-report.md）验证：60000 ≥ 3973 满足 → 数值保持初值。
 *  §17 标定复核（2026-08-23，P6 真实数据）：real-v2-stable JSONL（real-v2-stable-2026-08-23T14-21-35-583Z.jsonl）
 *  latency_ms 均值 1445.65ms / P90 ≈ 2072ms → 60000 ≥ 2072 仍满足（余量 ~29×）→ 数值保持。 */
export const DEFAULT_TICK_INTERVAL_MS = 60_000;
/** 每个环境字段变化的归一化能力衰减系数（能力衰减曲线，待标定） */
export const CAPABILITY_DECAY_FACTOR = 0.8;

/** Windows 瞬态锁重试次数与可重试错误码（与 substrate/lines.ts 的 writeFileRetry 同口径）——
 *  多个调度器实例并发落盘时，后到的 rename 可能撞上目标正被另一个 rename 持有（EPERM）。 */
const WRITE_LOCK_RETRY_COUNT = 5;
const WRITE_LOCK_RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);

/** §4.4 Fingerprint 参与 diff 的字段（固定顺序，保证环境_delta 键序确定性） */
const FP_FIELDS: (keyof Fingerprint)[] = ['os', 'node', 'dsh_version', 'project', 'gpu', 'cuda'];

/**
 * 硬限豁免清单（债务合计 ≥ hardLimit 时仍照常执行的任务；其余 urgency='normal' 任务照旧被跳过）：
 *   - 廉价必要维护（2026-08-25 死亡螺旋修复）：gc / 会话收尾 / 记忆整合 / 环境检查——
 *     被硬限阻塞则其债务永不清偿、债务合计永不回落，硬限成为永久冻结（实测 turn-finalize 债务
 *     1163 = 被硬跳过 1163 次）；
 *   - 检查与判定类（已知问题「债务把检查/判定类任务自身锁死」修复）：evolution_decision /
 *     promotion_check / verification_review——它们是「债从哪来、能不能释放」的唯一观测与裁决入口，
 *     把它们一起锁住会让债务永远无法被诊断与清偿。三者都不改版本线：
 *     evolution_decision 只判定并记录原因（债务门禁仍在 decideEvolution 内独立把关）、
 *     promotion_check 有独立的三层门禁 + 验证契约 fail-closed、verification_review 只读债 + 复核。
 * 保护语义不变：**改动类**演化任务（candidate_validation 生成候选、repair 改对象）仍受硬限约束——
 * 债务高企时不在带病状态下改版本线/改对象。
 */
const HARD_LIMIT_EXEMPT = new Set([
  'gc',
  'memory_consolidation',
  'environment_check',
  'evolution_decision',
  'promotion_check',
  'verification_review',
]);

/** 是否豁免硬限（会话级收尾任务按前缀识别） */
function isHardLimitExempt(taskId: string): boolean {
  return HARD_LIMIT_EXEMPT.has(taskId) || taskId.startsWith('turn-finalize:');
}

/**
 * 「改动类」演化任务（真正可能改版本线/改对象者）——受硬限约束的集合，与 HARD_LIMIT_EXEMPT 互补。
 * 保护语义的观测面：债务锁住的正是这一类；检查/判定类不在其中（不被自身存量债务锁死）。
 */
const EVOLUTION_MUTATING = new Set(['candidate_validation', 'repair']);

/**
 * 无主债务进入人工裁定的时长阈值（已知问题「债务是保护性自锁」第 4 条）：
 * 超过此时长仍无法对应到任何来源子系统的条目 → 进「待人工裁决」清单，**不做自动清除**。
 * 一周为观测数据下的初值（一次真实修复周期远短于此）；非「到期清零」，只是「转人工」。
 */
export const DEBT_MANUAL_REVIEW_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

// ---- 维护调度器 ----

export class MaintenanceScheduler {
  private readonly debtFile: string;
  /** 待执行队列的持久化文件（<debtFile 同目录>/queue.json；跨重启重建——见 restoreTask） */
  private readonly queueFile: string;
  /** 任务重建面（opts.restoreTask；未提供 → 持久化队列在重启后不可重建，记降级而非静默丢失） */
  private readonly restoreTask: ((id: string) => ((signal?: AbortSignal) => Promise<void>) | null) | null;
  /** S2：维护观测落盘目录（缺省 <debtFile 同目录>/maintenance-observations） */
  private readonly observationsDir: string;
  /** S2：维护任务成本注入面（policy.evolve.maintenance_costs；enqueue 缺省成本按 id 查找） */
  private maintenanceCosts: Readonly<Partial<Record<string, number>>>;
  private softLimit: number;
  private hardLimit: number;
  private criticalLimit: number;
  private readonly baseTickMs: number;
  private readonly batchSize: number;
  private readonly nowFn: () => number;
  private queue: MaintenanceTask[] = [];
  private debt = new Map<string, MaintenanceDebt>();
  private critical = new Set<string>();
  /** P1c §10.1：入队即累计债务的任务 id（事件入队累加 value；防失败/跳过路径重复累计） */
  private accruedAtEnqueue = new Set<string>();
  private stopped = false;
  private started = false;
  private running = false;
  /**
   * 已发出但尚未落完的落盘写入计数（已知问题《关停不是真正排空》修复）：
   * `drain()` 的静默点判据之一——只等 running 标志回落会漏掉"任务函数已返回、写入还在飞"的窗口，
   * 关库后这些写入抛 `database is not open` 并被记成任务失败（假债务）。
   */
  private pendingWrites = 0;
  /** 在飞任务体计数（任务函数真正执行中；与 running 分开——批量循环退出后任务体可能仍在跑） */
  private inflight = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** 最近一次调度器自身故障（定时器路径兜底：如 debt.json 损坏）；状态面可读，不再静默吞错 */
  private lastSchedulerError: string | null = null;
  /** 原子写临时名的单调序号（保证同毫秒内多次写也不撞名——时钟可能被冻结） */
  private writeSeq = 0;
  private debtLoaded = false;
  /** 队列懒加载标记（restoreQueueIfNeeded 只做一次） */
  private queueLoaded = false;
  private tickCountValue = 0;
  private readonly inFlight = new AbortController();
  /** R5：Deferred 事件记录（未实现/不可执行任务；见 DeferredMaintenanceError） */
  private deferredLog: DeferredEvent[] = [];
  /** 债务释放审计落盘文件（<debtFile 同目录>/debt-releases.jsonl——释放依据可回溯） */
  private readonly releaseLogFile: string;
  /** 本次进程内已执行的释放记录（审计内存面；权威历史在 JSONL 文件） */
  private releaseLog: DebtReleaseRecord[] = [];
  /**
   * 观测摘要缓存（已知问题《观测摘要同步读当日日志》修复）：键 = 当日文件身份（mtime+size）。
   * kern_status 可被模型随时调用——此前每次都同步读全文件并逐行解析，一天几千条维护任务时阻塞事件循环；
   * 现在文件未变的重复调用零读盘、零解析（返回同一摘要对象）。
   */
  private observationCache: { identity: ObservationCacheIdentity; summary: MaintenanceObservationSummary } | null = null;
  /** 因缓存命中而省掉的读盘次数（状态面可读；证明重复调用不再同步读全文件） */
  private observationReadsAvoided = 0;

  constructor(opts: MaintenanceSchedulerOptions = {}) {
    this.debtFile = opts.debtFile ?? join(process.cwd(), 'workspace', '.omb', '.evolution', 'debt.json');
    this.queueFile = join(dirname(this.debtFile), 'queue.json');
    this.restoreTask = opts.restoreTask ?? null;
    this.observationsDir =
      opts.observationsDir ?? join(dirname(this.debtFile), 'maintenance-observations');
    this.releaseLogFile = join(dirname(this.debtFile), 'debt-releases.jsonl');
    this.maintenanceCosts = opts.maintenanceCosts ?? {};
    this.softLimit = opts.softLimit ?? DEFAULT_SOFT_LIMIT;
    this.hardLimit = opts.hardLimit ?? DEFAULT_HARD_LIMIT;
    this.criticalLimit = opts.criticalLimit ?? DEFAULT_CRITICAL_LIMIT;
    this.baseTickMs = opts.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
    // 批量上限：缺省 1（既有单量子语义）；<1 视为 1；> MAINTENANCE_BATCH_MAX 截断（防单次调用过长占用）
    const batch = Math.floor(opts.batchSize ?? DEFAULT_BATCH_SIZE);
    this.batchSize = Math.min(
      Math.max(Number.isFinite(batch) ? batch : DEFAULT_BATCH_SIZE, 1),
      MAINTENANCE_BATCH_MAX,
    );
    this.nowFn = opts.now ?? (() => Date.now());
  }

  /**
   * 入队（M3 兼容形状：{id, run}，其余缺省；返回 Promise<void> 与 M3 最小接口同形，调用方可 await）；
   * 同 id 重复入队 → 替换；urgency='critical' 自动强制优先。
   * P1c §10.1：opts.accrueDebt=true → 入队同时累计债务（value 累加 + 立即持久化）——事件入队累加语义；
   * 任务成功清偿（归零）；失败/中断/跳过路径对已入账任务不再重复累计（防双计）。
   */
  async enqueue(input: MaintenanceTaskInput, opts: { accrueDebt?: boolean } = {}): Promise<void> {
    if (this.stopped) return;
    this.restoreQueueIfNeeded(); // 首次入队前先把盘上未完成的队列重建回来（不丢还债的人）
    const task: MaintenanceTask = {
      id: input.id,
      value: input.value ?? 1,
      // S2：成本注入面——未给 estimated_cost 且任务 id 命中注入表 → 用 policy 成本（未列出 id 仍 M3 缺省 1）
      estimated_cost: input.estimated_cost ?? this.maintenanceCosts[input.id] ?? 1,
      priority: input.priority ?? 0,
      urgency: input.urgency ?? 'normal',
      subsystem: input.subsystem,
      reason: input.reason,
      run: input.run,
    };
    const idx = this.queue.findIndex((t) => t.id === task.id);
    if (idx >= 0) this.queue.splice(idx, 1);
    this.queue.push(task);
    if (task.urgency === 'critical') this.markCritical(task.id);
    if (opts.accrueDebt === true) {
      this.accruedAtEnqueue.add(task.id);
      this.accumulateDebt(task);
      await this.persistDebt();
    }
    await this.persistQueue(); // 队列本身也落盘（跨重启重建——见 restoreTask）
    this.resetTimer(); // 紧急任务挂起可能改变 tick 频率
  }

  /** 标记任务为 critical：request boundary 强制插入（下一 quantum/tick 优先执行） */
  markCritical(taskId: string): void {
    this.critical.add(taskId);
    this.resetTimer();
  }

  /** 请求间隙小量子：执行至多 batchSize 个可执行任务（缺省 1 = 既有单量子语义；可中断：调用方
   *  signal ∪ stop() 的 inFlight）；hard 限跳过者记录 skipped + 不累计债务（硬跳过 = 调度延迟非失败） */
  async requestQuantum(opts: { signal?: AbortSignal } = {}): Promise<QuantumReport> {
    this.restoreQueueIfNeeded(); // 重启后队列在盘上 → 先重建再调度（债与还债的人同源）
    if (this.stopped || this.running || this.queue.length === 0) return { ran: [], skipped: [] };
    // 重入守卫（审查修复）：此前 requestQuantum 不检查也不置位 running，可与定时器 tick 同时在飞 →
    // 两次 sortedQueue() 快照含同一 task id → 同一任务并发执行（如 memory_consolidation 双跑，
    // 第二次的 transaction 会被 beginIfNeeded 识别为"已在事务中"而并入前一次的事务边界）。
    this.running = true;
    try {
      return await this.requestQuantumInner(opts);
    } finally {
      this.running = false;
    }
  }

  /** requestQuantum 主体（running 守卫由外层持有） */
  private async requestQuantumInner(opts: { signal?: AbortSignal } = {}): Promise<QuantumReport> {
    if (this.stopped || this.queue.length === 0) return { ran: [], skipped: [] };
    const signal = this.execSignal(opts.signal);
    if (signal.aborted) {
      // 中断（**未执行**）→ 不累计债务：与硬跳过同一条原则（调度延迟 ≠ 失败）。
      // 审查修复：此前此处 accrueOnNonRun(top)，使"一次都没被 run 过"的队首任务 +value；
      // 若该任务此后不再被调度，债务既不清偿也不再执行 → 保护性自锁失控（本文件 409-411 所述死亡螺旋）。
      // 执行中被中断（runOne 内）仍按失败累计——那是真实执行失败，语义不变。
      return { ran: [], skipped: this.queue.length > 0 ? [this.sortedQueue()[0]!.id] : [] };
    }
    const report: QuantumReport = { ran: [], skipped: [] };
    for (const t of this.sortedQueue()) {
      if (report.ran.length >= this.batchSize) break; // 批量上限：本次调用已消费足够的任务
      if (this.hardBlocked(t)) {
        // 硬跳过 = 调度延迟而非失败（2026-08-25 死亡螺旋修复）：不累计债务——
        // 否则债务合计 ≥ 硬限后每次跳过都 +value，债务永不回落（实测 gc/turn-finalize
        // 债务上千的根因）。跳过仅记录（skipped），债务由任务真实执行/失败决定。
        report.skipped.push(t.id);
        continue;
      }
      const r = await this.runOne(t, signal);
      report.ran.push(...r.ran);
      report.skipped.push(...r.skipped);
      await this.persistDebt();
      this.resetTimer(); // 债务变化可能改变 tick 频率
      if (signal.aborted) break; // 中断（调用方 abort / stop）→ 让出，不再取新任务
      if (report.ran.length >= this.batchSize) break;
    }
    await this.persistDebt(); // 全部被 hard 跳过 / 批量已满
    return report;
  }

  /** tick：批量处理队列（进程内定时器驱动；可手动调用）；执行 signal（调用方 ∪ inFlight）中断时停止取新任务 */
  async tick(opts: { signal?: AbortSignal } = {}): Promise<QuantumReport> {
    this.tickCountValue++;
    this.restoreQueueIfNeeded(); // 同上：定时器路径也要先重建盘上队列
    if (this.stopped || this.running || this.queue.length === 0) return { ran: [], skipped: [] };
    this.running = true;
    try {
      const signal = this.execSignal(opts.signal);
      const report: QuantumReport = { ran: [], skipped: [] };
      for (const t of this.sortedQueue()) {
        if (signal.aborted) break;
        if (report.ran.length >= this.batchSize) break; // 批量上限
        if (this.hardBlocked(t)) {
          report.skipped.push(t.id);
          continue; // 硬跳过不累计债务（死亡螺旋修复，见 hardBlocked/requestQuantum 注释）
        }
        const r = await this.runOne(t, signal);
        report.ran.push(...r.ran);
        report.skipped.push(...r.skipped);
        if (signal.aborted) break;
      }
      await this.persistDebt();
      return report;
    } finally {
      this.running = false;
      this.resetTimer();
    }
  }

  /**
   * 排空：等在飞量子/tick 落地**且已发出的落盘写入完成**（关闭前调用——见 assembly.close）。
   *
   * 已知问题《关停不是真正排空》修复：此前只轮询 `running` 标志（上限 1 秒），既不等待
   * runOne 内部仍在跑的长任务（单个整合任务在数据量大时远超 1 秒），也不等待已发出的
   * 落盘写入（观测 JSONL / 债务快照 / 释放审计）——关库后这些写入会撞 `database is not open`，
   * 被记成"任务失败"并产生**假债务**（测试侧表现为临时目录清理竞态 ENOTEMPTY）。
   *
   * 现在：
   *   ① `idle()` 的判据 = 无在飞任务（running=false 且无在飞派发）**且**待落盘写入集合已清空；
   *   ② 等待有界（`drainTimeoutMs`，缺省 10s——覆盖正常长任务；`stop()` 已中断在飞 signal，
   *      可中断任务会很快让出）；③ 超时→返回 `{ drained:false, reason }`，由调用方如实记录降级
   *      （不静默假称已排空）。
   */
  async drain(opts: { timeoutMs?: number } = {}): Promise<{ drained: boolean; waited_ms: number; reason?: string }> {
    const timeout = opts.timeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
    const started = this.nowFn();
    const settled = await this.waitIdle(timeout);
    const waited = this.nowFn() - started;
    if (settled) {
      return { drained: true, waited_ms: waited };
    }
    return {
      drained: false,
      waited_ms: waited,
      reason:
        `排空超时（${waited}ms ≥ ${timeout}ms）：` +
        // 判据必须与 isIdle 的静默点定义一致：`running=false` 只说明"批量循环已退出"，
        // 任务体（inflight）与已发出的写入（pendingWrites）都可能还在跑。此前只看 running，
        // 会在 `running=false, inflight=1` 时打印"无在飞任务但仍有待落盘写入（pending_writes=0）"
        // ——一句自相矛盾的话，而排空失败的唯一诚实出口就是这句 reason。
        `${this.running || this.inflight > 0 ? `仍有在飞任务（inflight=${this.inflight}）` : '无在飞任务但仍有待落盘写入'}` +
        `（pending_writes=${this.pendingWrites}）——库将以"可能仍在写入"的状态关闭`,
    };
  }

  /**
   * 静默点（idle）：无在飞任务且无待落盘写入时立即 resolve；否则等下一次状态变化（有界轮询）。
   * 供 drain 与测试使用（`maintenanceIdle()` 是"能不能安全关库"的唯一判据）。
   */
  async idle(): Promise<void> {
    await this.waitIdle(Number.POSITIVE_INFINITY);
  }

  /**
   * 当前是否处于静默点（无在飞任务 + 无在飞任务体 + 无待落盘写入）。
   * 三个条件缺一不可：running=false 只说明"批量循环已退出"，任务体（inflight）与已发出的写入
   * （pendingWrites）都可能还在跑——这正是旧实现关库撞 `database is not open` 的窗口。
   */
  get isIdle(): boolean {
    return !this.running && this.inflight === 0 && this.pendingWrites === 0;
  }

  /** 在飞任务体数（状态面/测试可读） */
  get inflightTaskCount(): number {
    return this.inflight;
  }

  /** 待落盘写入数（状态面/测试可读；>0 表示"现在关库会丢/报错"） */
  get pendingWriteCount(): number {
    return this.pendingWrites;
  }

  /**
   * 轮询等待静默点（无界或带超时）；返回是否达成静默。
   * 定时器无关：等待用 `setTimeout` 让出事件循环，但**超时判定用真实时钟**（`Date.now`）并在两次
   * 让出之间做最后判断——这样既不依赖 `nowFn` 注入，也不会在假定时器（测试）下退化成死等。
   */
  private async waitIdle(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.isIdle) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, IDLE_POLL_MS));
    }
  }

  /**
   * 登记一次"已发出的落盘写入"：返回结算函数（幂等）。所有 async 落盘（债务快照/观测 JSONL/
   * 释放审计）都经此登记，使 drain 能等到它们真正落完，而不是等到任务函数返回就走。
   */
  private trackWrite(): () => void {
    this.pendingWrites += 1;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.pendingWrites -= 1;
    };
  }

  /** 当前债务快照（深拷贝；task_id 排序，确定性） */
  debtSnapshot(): MaintenanceDebt[] {    this.ensureDebtLoaded();    return [...this.debt.values()]
      .sort((a, b) => a.task_id.localeCompare(b.task_id))
      .map((d) => ({ ...d }));
  }

  /**
   * 债务来源视图（已知问题「债务是保护性自锁」第 1/4 条）——回答「这条债是哪来的、现在能不能放」：
   * 逐条给出来源子系统、原因、首见/最近失败时间，并标出 orphan（无主）与 manual_pending
   * （无主且超过 DEBT_MANUAL_REVIEW_AFTER_MS → 待人工裁决，不自动清除）。
   */
  debtSourceView(): DebtSourceView[] {
    this.ensureDebtLoaded();
    const now = this.nowFn();
    return [...this.debt.values()]
      .map((d): DebtSourceView => {
        const first = d.first_seen ?? d.accumulated_at;
        const orphan = d.subsystem === undefined || d.subsystem.length === 0;
        return {
          task_id: d.task_id,
          value: d.value,
          subsystem: orphan ? null : d.subsystem!,
          reason: d.reason ?? '未记录原因（历史条目）',
          first_seen: first,
          last_failure: d.last_failure ?? d.accumulated_at,
          orphan,
          manual_pending: orphan && now - first >= DEBT_MANUAL_REVIEW_AFTER_MS,
          evolution_mutating: EVOLUTION_MUTATING.has(d.task_id),
        };
      })
      .sort((a, b) => a.task_id.localeCompare(b.task_id));
  }

  /** 待人工裁决清单（无主且长期未对应到修复动作的债务；**不做自动清除**——只列出来给人看） */
  manualPendingDebt(): DebtSourceView[] {
    return this.debtSourceView().filter((d) => d.manual_pending);
  }

  /**
   * **按条释放**债务（已知问题「债务是保护性自锁」第 2/3 条）：修复 → 确认 → 释放。
   * 只有带来源子系统的条目可释放（`expectedSubsystem` 必须与该条记录的 subsystem 一致——
   * 防「修了 A 顺手清掉 B 的债」）；无主债务不在此路径，走 manualPendingDebt 人工裁定。
   * 释放即落审计（`<debtFile 同目录>/debt-releases.jsonl`）：依据（evidence）/触发者（released_by）/
   * 时间/释放前累计值，可回溯。
   * 语义边界：**本方法不做任何周期性或到期式清除**——调用方必须先完成修复并给出自检依据。
   */
  async releaseDebt(input: {
    taskId: string;
    expectedSubsystem: string;
    evidence: string;
    releasedBy: string;
    reason?: string;
  }): Promise<DebtReleaseResult> {
    this.ensureDebtLoaded();
    const rec = this.debt.get(input.taskId);
    if (rec === undefined) {
      return { released: false, task_id: input.taskId, value: 0, reason: 'no_debt' };
    }
    if (rec.subsystem !== input.expectedSubsystem) {
      return {
        released: false,
        task_id: input.taskId,
        value: rec.value,
        reason: `subsystem_mismatch:${rec.subsystem ?? 'none'}!=${input.expectedSubsystem}`,
      };
    }
    const audit: DebtReleaseRecord = {
      ts: this.nowFn(),
      task_id: input.taskId,
      value: rec.value,
      subsystem: rec.subsystem ?? null,
      evidence: input.evidence,
      released_by: input.releasedBy,
      reason: input.reason ?? rec.reason ?? '',
    };
    this.debt.delete(input.taskId);
    this.accruedAtEnqueue.delete(input.taskId);
    await this.persistDebt();
    await this.appendReleaseAudit(audit);
    this.resetTimer(); // 债务变化可能改变 tick 频率
    return { released: true, task_id: input.taskId, value: audit.value, reason: 'released' };
  }

  /** 释放审计快照（本次进程内已执行的释放；跨进程历史读 debt-releases.jsonl） */
  debtReleaseAudit(): DebtReleaseRecord[] {
    return [...this.releaseLog];
  }

  /** 释放审计文件路径（状态面展示 / 外部读取；与 debt.json 同目录） */
  get debtReleaseLogFile(): string {
    return this.releaseLogFile;
  }

  /** R5：Deferred 事件记录快照（未实现/不可执行任务的出队但债务保留事件；task_id 排序，确定性） */
  deferredEvents(): DeferredEvent[] {
    return [...this.deferredLog].sort((a, b) => a.task_id.localeCompare(b.task_id));
  }

  /**
   * S2：维护任务成本注入（装配时传 policy.evolve.maintenance_costs——数据即机制，改 evolve.yaml 即生效）。
   * 幂等：每次调用以最新注入值整体替换（调度器缺省成本面 = 当前 policy 值）。
   */
  setMaintenanceCosts(costs: Readonly<Partial<Record<string, number>>>): void {
    this.maintenanceCosts = { ...costs };
  }

  /**
   * 债务阈值注入（装配时传 policy.evolve.debt_thresholds——数据即机制：改 evolve.yaml 即生效，
   * 与 kernel/evolve-decision.ts decideEvolution 的「债务 ≥ hard → 不演化」同源，两处不再各持一套缺省值）。
   * 幂等：整体替换；非法（非有限数 / 负数 / soft > hard / hard > critical）→ 丢弃该项并返回说明，
   * 其余照常生效（不静默采用错值；调用方记录降级）。
   * @returns 被丢弃/异常的项说明（空数组 = 全部合法）
   */
  setLimits(limits: { soft?: number; hard?: number; critical?: number }): string[] {
    const bad: string[] = [];
    const pick = (v: number | undefined, fallback: number, name: string): number => {
      if (v === undefined) return fallback;
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
        bad.push(`${name}=${String(v)}`);
        return fallback;
      }
      return v;
    };
    const soft = pick(limits.soft, this.softLimit, 'soft');
    const hard = pick(limits.hard, this.hardLimit, 'hard');
    const critical = pick(limits.critical, this.criticalLimit, 'critical');
    if (soft > hard) bad.push(`soft(${soft})>hard(${hard})`);
    if (hard > critical) bad.push(`hard(${hard})>critical(${critical})`);
    this.softLimit = soft;
    this.hardLimit = hard;
    this.criticalLimit = critical;
    this.resetTimer(); // soft 变化影响 tick 频率
    return bad;
  }

  /** 当前生效阈值 + 债务档位 + 批量（状态面可读——观测「为什么停下来了」） */
  limitsSnapshot(): {
    soft: number;
    hard: number;
    critical: number;
    total: number;
    band: 'normal' | 'soft' | 'hard' | 'critical';
    batch_size: number;
    /** 调度器自身故障（如债务文件损坏导致加载失败）——非 null 时债务视图不可信，须人工核对 */
    scheduler_error?: string | null;
  } {
    const total = this.debtTotal();
    const band: 'normal' | 'soft' | 'hard' | 'critical' =
      total >= this.criticalLimit
        ? 'critical'
        : total >= this.hardLimit
          ? 'hard'
          : total >= this.softLimit
            ? 'soft'
            : 'normal';
    return {
      soft: this.softLimit,
      hard: this.hardLimit,
      critical: this.criticalLimit,
      total,
      band,
      batch_size: this.batchSize,
      scheduler_error: this.lastSchedulerError,
    };
  }

  /**
   * S2：观测摘要（kern_status 可读入口）——今日（UTC）任务数 + 各任务平均耗时（per_task 按 task_id 排序，确定性）。
   * 无观测目录/文件 → 全零（安全降级）；文件不可读 → 抛错（调用方降级字段记录，不静默吞错）。
   *
   * 同步版（保留给既有调用方/测试）：已知问题《观测摘要同步读当日日志》——`kern_status`（模型可随时调用的
   * 工具）走这条路径，每次调用都 readFileSync 当日 JSONL 并逐行 JSON.parse，一天几千条维护任务时
   * **同步阻塞事件循环**。现在走 `observationCache`（文件身份未变的重复调用零读盘、零解析）；
   * 异步入口请用 `observationsSummaryAsync()`（同样的缓存，但不阻塞事件循环）。
   */
  observationsSummary(): MaintenanceObservationSummary {
    const date = utcDay(this.nowFn());
    const cached = this.cachedObservationSummary(date);
    if (cached !== null) {
      return cached;
    }
    return this.observationsSummaryBlocking(date);
  }

  /** 异步观测摘要（kern_status 首选入口：不阻塞事件循环；失败 → 抛错由调用方降级） */
  async observationsSummaryAsync(): Promise<MaintenanceObservationSummary> {
    const date = utcDay(this.nowFn());
    const cached = this.cachedObservationSummary(date);
    if (cached !== null) {
      return cached;
    }
    const file = join(this.observationsDir, `${date}.jsonl`);
    let stat: { mtimeMs: number; size: number } | null = null;
    try {
      const s = await statFile(file);
      stat = { mtimeMs: s.mtimeMs, size: s.size };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return this.storeObservationSummary(date, { date, total: 0, per_task: [] }, null);
      }
      throw new Error(`maintenance observations unreadable: ${file}: ${(err as Error).message}`);
    }
    if (this.observationCache?.identity.date === date && sameIdentity(this.observationCache.identity, stat)) {
      this.observationReadsAvoided += 1;
      return this.observationCache.summary;
    }
    let raw: string;
    try {
      raw = await readFileAsync(file, 'utf8');
    } catch (err) {
      throw new Error(`maintenance observations unreadable: ${file}: ${(err as Error).message}`);
    }
    return this.storeObservationSummary(date, summarizeObservations(raw, date), stat);
  }

  /** 观测缓存命中判定（文件身份未变 → 直接返回；null = 需要重新读取） */
  private cachedObservationSummary(date: string): MaintenanceObservationSummary | null {
    const c = this.observationCache;
    if (c === null || c.identity.date !== date) {
      return null;
    }
    // 文件身份比对需要 stat——同步路径下同样只做一次 stat（远廉于读全文件 + 逐行解析）
    try {
      const s = statSync(this.observationsFileFor(date));
      if (sameIdentity(c.identity, { mtimeMs: s.mtimeMs, size: s.size })) {
        this.observationReadsAvoided += 1;
        return c.summary;
      }
    } catch {
      // stat 失败 → 回落到重新读取（行为与旧实现一致）
    }
    return null;
  }

  /** 同步读取（缓存未命中的回落路径；语义与旧实现逐字一致——损坏行跳过、读取失败抛错） */
  private observationsSummaryBlocking(date: string): MaintenanceObservationSummary {
    const file = this.observationsFileFor(date);
    if (!existsSync(file)) {
      return this.storeObservationSummary(date, { date, total: 0, per_task: [] }, null);
    }
    let raw: string;
    let identity: ObservationCacheIdentity;
    try {
      const s = statSync(file);
      identity = { date, mtimeMs: s.mtimeMs, size: s.size };
      raw = readFileSync(file, 'utf8');
    } catch (err) {
      throw new Error(`maintenance observations unreadable: ${file}: ${(err as Error).message}`);
    }
    return this.storeObservationSummary(date, summarizeObservations(raw, date), identity);
  }

  private observationsFileFor(date: string): string {
    return join(this.observationsDir, `${date}.jsonl`);
  }

  /** 写入缓存并返回摘要（缓存是纯优化：任何身份变化都会导致重新读取，不影响正确性） */
  private storeObservationSummary(
    date: string,
    summary: MaintenanceObservationSummary,
    stat: { mtimeMs: number; size: number } | null,
  ): MaintenanceObservationSummary {
    this.observationCache = {
      identity: { date, mtimeMs: stat?.mtimeMs ?? -1, size: stat?.size ?? -1 },
      summary,
    };
    return summary;
  }

  /** 观测摘要缓存观测面（状态面/测试可读：省掉的读盘次数——证明"重复调用不再同步读全文件"） */
  observationCacheStats(): { reads_avoided: number; cached: boolean } {
    return { reads_avoided: this.observationReadsAvoided, cached: this.observationCache !== null };
  }

  /** Predictive Invalidation（§9.1）：Fingerprint diff → markSuspicious + 最小回归子集 + 衰减记录 */
  predictiveInvalidate(
    fingerprint: Fingerprint,
    old: Fingerprint,
    deps: PredictiveInvalidationDeps,
  ): CapabilityDecayRecord[] {
    const delta: Record<string, { from: string | undefined; to: string | undefined }> = {};
    for (const f of FP_FIELDS) {
      const from = old[f];
      const to = fingerprint[f];
      if (from !== to) delta[f] = { from, to };
    }
    if (Object.keys(delta).length === 0) return [];
    for (const obj of deps.affectedObjects) deps.markSuspicious(obj);
    const before = 1;
    const after = before * Math.pow(CAPABILITY_DECAY_FACTOR, Object.keys(delta).length);
    const attribution = Object.entries(delta)
      .map(([f, v]) => `fingerprint:${f} ${v.from ?? '(none)'} → ${v.to ?? '(none)'}`)
      .join('; ');
    return [
      {
        environment_delta: delta,
        affected_objects: deps.affectedObjects,
        regression_set: deps.affectedObjects.map((o) => o.id),
        capability_before: before,
        capability_after: after,
        attribution,
      },
    ];
  }

  /** 启动进程内空闲期定时器（tick 驱动）；start() 前 enqueue/markCritical 不产生定时器 */
  start(): void {
    if (this.stopped || this.started) return;
    this.started = true;
    this.resetTimer();
  }

  /** 退出即停：清定时器/队列并中断在飞任务；stop 后 tick/requestQuantum 无动作；幂等 */
  stop(): void {
    this.stopped = true;
    this.started = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.queue = [];
    this.critical.clear();
    this.inFlight.abort();
  }

  /** tick 调用次数（soft 限频率断言用） */
  get tickCount(): number {
    return this.tickCountValue;
  }

  // ---- 内部 ----

  /** 排序键：critical 最前 → ROI 降序 → priority 降序 → id（确定性兜底） */
  private rank(t: MaintenanceTask): [number, number, number, string] {
    const roi = t.estimated_cost > 0 ? t.value / t.estimated_cost : Number.POSITIVE_INFINITY;
    return [this.critical.has(t.id) ? 0 : 1, -roi, -t.priority, t.id];
  }

  private sortedQueue(): MaintenanceTask[] {
    return [...this.queue].sort((a, b) => {
      const ra = this.rank(a);
      const rb = this.rank(b);
      for (let i = 0; i < ra.length; i++) {
        if (ra[i]! < rb[i]!) return -1;
        if (ra[i]! > rb[i]!) return 1;
      }
      return 0;
    });
  }

  /** hard 限：债务合计 ≥ hardLimit 时非必要（normal）任务跳过（限制非必要演化）。
   *  豁免清单见 HARD_LIMIT_EXEMPT：廉价必要维护（避免债务永不清偿的死亡螺旋）+ 检查与判定类任务
   *  （避免「债务把检查/判定类任务自身锁死」——否则债务永远无法被诊断与清偿）。
   *  保护语义保留：改动类演化任务（candidate_validation/repair）仍受硬限约束。 */
  private hardBlocked(t: MaintenanceTask): boolean {
    return this.debtTotal() >= this.hardLimit && t.urgency === 'normal' && !isHardLimitExempt(t.id);
  }

  /** 任务执行 signal：stop() 的 inFlight 与调用方 signal 合并（stop 中断在飞任务） */
  private execSignal(optsSignal?: AbortSignal): AbortSignal {
    if (!optsSignal) return this.inFlight.signal;
    return AbortSignal.any([this.inFlight.signal, optsSignal]);
  }

  /**
   * 执行单个任务（R5 清债语义）：
   * - 成功 → 出队 + 清债（清偿归零）；
   * - DeferredMaintenanceError（未实现/不可执行）→ 出队但债务保留（accrueDebt 任务债务已在入队时
   *   入账，保留不清零）+ deferredEvents 记录 + 不视为失败崩溃（队列继续）；
   * - 真实失败（普通 Error）→ 出队 + 债务保留（既有失败语义，评估依据 §13）；
   * - 中断 → 留队 + 债务累计（可重试）。
   * 防双计（P1c §10.1）：accrueDebt 任务的债务在入队时已累计——出队前记录是否已入账，避免
   * removeFromQueue 清除 accruedAtEnqueue 标记后 accrueOnNonRun 重复累计（失败/Deferred 均只保留
   * 入账值，不翻倍）。
   */
  private async runOne(t: MaintenanceTask, signal?: AbortSignal): Promise<QuantumReport> {
    // S2 观测：任务开始时间 + 执行前债务（accrueDebt 任务入队即累计；未入账 → 0）
    const started = this.nowFn();
    const debtBefore = this.debt.get(t.id)?.value ?? 0;
    this.inflight += 1;
    try {
      return await this.runOneBody(t, signal, started, debtBefore);
    } finally {
      // 任务体退场（含抛错/中断路径）：关停排空的静默点判据据此收敛（见 isIdle/drain）
      this.inflight -= 1;
    }
  }

  /** runOne 主体（执行 + 结果结算；在飞计数由 runOne 的 try/finally 持有） */
  private async runOneBody(
    t: MaintenanceTask,
    signal: AbortSignal | undefined,
    started: number,
    debtBefore: number,
  ): Promise<QuantumReport> {
    try {
      await t.run(signal);
    } catch (err) {
      const aborted = signal?.aborted === true || (err instanceof Error && err.name === 'AbortError');
      if (aborted) {
        this.accrueOnNonRun(t); // 未执行 → 债务累计（留队可重试）
        await this.appendObservation({
          ts: started,
          task_id: t.id,
          duration_ms: this.nowFn() - started,
          result: 'interrupted',
          debt_before: debtBefore,
          debt_after: this.debt.get(t.id)?.value ?? 0,
        });
        return { ran: [], skipped: [t.id] };
      }
      // 出队前记录入账标记（防双计：removeFromQueue 会清除 accruedAtEnqueue）
      const wasAccrued = this.accruedAtEnqueue.has(t.id);
      await this.removeFromQueue(t.id);
      if (err instanceof DeferredMaintenanceError) {
        // R5：未实现/不可执行 → 出队但债务保留（不清债）+ 记录 deferred；不视为失败崩溃
        this.deferredLog.push({ task_id: t.id, at: this.nowFn(), reason: err.message });
        if (!wasAccrued) {
          this.accrueOnNonRun(t); // 未入账任务 → 债务累计（未完成 → debt 保留）
        }
        await this.persistDebt();
        await this.appendObservation({
          ts: started,
          task_id: t.id,
          duration_ms: this.nowFn() - started,
          result: 'deferred',
          debt_before: debtBefore,
          debt_after: this.debt.get(t.id)?.value ?? 0,
        });
        return { ran: [t.id], skipped: [] };
      }
      if (!wasAccrued) {
        this.accrueOnNonRun(t); // 执行失败 → 债务累计（保留；已入账任务保留入账值防双计）
      }
      await this.persistDebt();
      await this.appendObservation({
        ts: started,
        task_id: t.id,
        duration_ms: this.nowFn() - started,
        result: 'failed',
        debt_before: debtBefore,
        debt_after: this.debt.get(t.id)?.value ?? 0,
      });
      return { ran: [t.id], skipped: [] };
    }
    await this.removeFromQueue(t.id);
    this.clearDebt(t.id);
    await this.persistDebt();
    await this.appendObservation({
      ts: started,
      task_id: t.id,
      duration_ms: this.nowFn() - started,
      result: 'success',
      debt_before: debtBefore,
      debt_after: 0, // 成功清偿归零
    });
    return { ran: [t.id], skipped: [] };
  }

  private async removeFromQueue(id: string): Promise<void> {
    this.queue = this.queue.filter((t) => t.id !== id);
    this.critical.delete(id);
    this.accruedAtEnqueue.delete(id);
    await this.persistQueue();
  }

  // ---- 队列持久化与跨重启重建（已知问题《债务与"还债的人"不同源》） ----

  /**
   * 原子写的临时文件名（**每次写唯一**）。
   *
   * 为什么必须唯一（真机实测缺陷）：此前用固定名 `` `${目标}.tmp` ``。同进程里多个调度器实例
   * （多会话/多子代理并行时各自装配一套认知层，共用同一个 `.evolution` 数据根）会并发落盘：
   * A 写完 rename 走了临时文件，B 随后 rename 自己的临时文件时**源已不存在** →
   * `ENOENT: rename '<file>.tmp' -> '<file>'`，落盘静默失败、内存账本与盘面分叉。
   * 真机上确实观测到这条报错（`scheduler_error` 里可见）。
   *
   * 唯一性靠**单调计数器**而非仅靠时间戳：时钟不保证前进（测试里的假时钟会冻结在同一毫秒，
   * 同毫秒内两次写就会撞名——实测被既有用例 `soft 限` 抓到：撞名后重试在假时钟下永不结算）。
   * pid/时间戳只用于排障辨认来源（与 `substrate/lines.ts` 的 `.<pid>-<ts>-<rand>.tmp` 同惯例）。
   */
  private tempWritePath(target: string): string {
    this.writeSeq += 1;
    const rand = Math.random().toString(36).slice(2, 8);
    return `${target}.${process.pid}-${Date.now().toString(36)}-${this.writeSeq}-${rand}.tmp`;
  }

  /**
   * 落盘（唯一临时名 + 带重试的 rename）。
   *
   * 重试的必要性（并发测试实测）：唯一临时名解决了"源被竞争者 rename 走"的 ENOENT，但 Windows 上
   * **两个 rename 同时指向同一目标**时后到者会拿到 `EPERM`（目标正被另一个 rename 持有）。这类
   * 瞬态锁与 `substrate/lines.ts` 的 writeFileRetry / git 锁重试是同一类问题，故沿用同一处理：
   * 短退避重试，超过次数才抛。失败方最终仍会以 `lastSchedulerError` 如实上报（不静默）。
   */
  private async atomicWriteJson(target: string, payload: string): Promise<void> {
    await mkdir(dirname(target), { recursive: true });
    const tmp = this.tempWritePath(target);
    await writeFile(tmp, payload, 'utf8');
    let last: unknown;
    for (let attempt = 0; attempt < WRITE_LOCK_RETRY_COUNT; attempt++) {
      try {
        await rename(tmp, target);
        return;
      } catch (err) {
        last = err;
        const code = (err as NodeJS.ErrnoException).code;
        if (code === undefined || !WRITE_LOCK_RETRYABLE.has(code)) {
          break;
        }
        if (attempt < WRITE_LOCK_RETRY_COUNT - 1) {
          await new Promise<void>((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
        }
      }
    }
    // 重试耗尽：清理自己的临时文件（不留垃圾），并把原因交回调用方记 scheduler_error
    try {
      await rm(tmp, { force: true });
    } catch {
      // 清理失败 → 残留随机名临时文件，无害（下次写用新随机名）
    }
    throw last instanceof Error ? last : new Error(String(last));
  }

  /**
   * 队列落盘（`<debtDir>/queue.json`，原子写 tmp+rename）。
   * 只落**元数据**（id/value/cost/priority/urgency/subsystem/reason/enqueued_at）——执行体是函数，
   * 不能序列化，由 `opts.restoreTask` 在加载时按 id 重建（见 restoreQueueIfNeeded）。
   * 尽力而为：写失败 → 记降级不抛（队列仍在内存里，本进程照常调度）。
   */
  private async persistQueue(): Promise<void> {
    const settle = this.trackWrite();
    try {
      const entries: PendingQueueEntry[] = this.queue.map((t) => ({
        id: t.id,
        value: t.value,
        estimated_cost: t.estimated_cost,
        priority: t.priority,
        urgency: t.urgency,
        ...(t.subsystem !== undefined ? { subsystem: t.subsystem } : {}),
        ...(t.reason !== undefined ? { reason: t.reason } : {}),
        accrued_at_enqueue: this.accruedAtEnqueue.has(t.id),
        enqueued_at: this.nowFn(),
        critical: this.critical.has(t.id),
      }));
      await this.atomicWriteJson(this.queueFile, JSON.stringify(entries, null, 2));
    } catch (err) {
      this.lastSchedulerError = `维护队列落盘失败：${(err as Error).message}`;
    } finally {
      settle();
    }
  }

  /**
   * 队列懒加载 + 跨重启重建（只做一次；由 enqueue/requestQuantum/tick/debtSnapshot 触发）。
   *
   * 已知问题《债务与"还债的人"不同源》的核心修复：`debt.json` 落盘、队列不落盘且 `stop()` 清空 →
   * 重启后债务还在盘上，但负责还债的任务不再被调度（`repair` 的唯一入队条件是"环境指纹再次变化"，
   * 指纹稳定后永不成立）→ 债务只增不减，累积到硬限后把该修的改动类任务一起锁住。
   * 现在：队列随元数据落盘，加载时按 `restoreTask` 重建 → **债务与执行体同源**。
   *
   * 重建规则：
   *   - `restoreTask(id)` 返回执行体 → 重建任务（元数据取盘上值；critical 标记一并恢复）；
   *   - 未注册工厂/工厂返回 null（如 `turn-finalize:*`——属主会话重启后已不存在）→ **剪除队列项**，
   *     对应债务保留为**无主债务**（`subsystem` 缺失 → 进人工裁定清单，不自动清除、也不假装已还）；
   *   - 队列文件缺失/损坏 → 空队列 + 记调度器错误（不静默吞掉；下一次入队会重建文件）。
   */
  private restoreQueueIfNeeded(): void {
    if (this.queueLoaded) return;
    // 重建面尚未就绪（如装配顺序：调度器先于认知运行时构造）→ **不改动队列、不置位标记**，
    // 下次调度时自然重试。语义边界：只有"重建面已就绪但该 id 不在其中"才判定为不可重建
    // （否则会把"还债的人"静默丢掉——正是本修复要消除的那种失真）。
    if (this.restoreTask === null) {
      return;
    }
    this.queueLoaded = true;
    if (!existsSync(this.queueFile)) {
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.queueFile, 'utf8'));
    } catch (err) {
      this.lastSchedulerError = `维护队列文件损坏（${this.queueFile}）：${(err as Error).message}——本次按空队列继续`;
      return;
    }
    if (!Array.isArray(raw)) {
      this.lastSchedulerError = `维护队列文件形状非法（${this.queueFile}）——本次按空队列继续`;
      return;
    }
    const restored: MaintenanceTask[] = [];
    const pruned: string[] = [];
    for (const item of raw as PendingQueueEntry[]) {
      if (item === null || typeof item !== 'object' || typeof item.id !== 'string' || item.id.length === 0) {
        continue;
      }
      const run = this.restoreTask(item.id);
      if (run === null) {
        pruned.push(item.id);
        continue;
      }
      restored.push({
        id: item.id,
        value: typeof item.value === 'number' && Number.isFinite(item.value) ? item.value : 1,
        estimated_cost:
          typeof item.estimated_cost === 'number' && Number.isFinite(item.estimated_cost) ? item.estimated_cost : 1,
        priority: typeof item.priority === 'number' && Number.isFinite(item.priority) ? item.priority : 0,
        urgency: isUrgency(item.urgency) ? item.urgency : 'normal',
        ...(typeof item.subsystem === 'string' ? { subsystem: item.subsystem } : {}),
        ...(typeof item.reason === 'string' ? { reason: item.reason } : {}),
        run,
      });
      if (item.accrued_at_enqueue === true) {
        this.accruedAtEnqueue.add(item.id);
      }
      if (item.critical === true) {
        this.critical.add(item.id);
      }
    }
    for (const t of restored) {
      const idx = this.queue.findIndex((q) => q.id === t.id);
      if (idx >= 0) this.queue.splice(idx, 1);
      this.queue.push(t);
    }
    if (pruned.length > 0) {
      // 剪除项不静默：恢复出的队列里没有它们 → 其债务成为无主债务（manualPendingDebt 可见）
      this.deferredLog.push({
        task_id: pruned.join(','),
        at: this.nowFn(),
        reason: `重启后无法重建执行体（未注册 restoreTask）——队列项剪除，对应债务转为无主债务：${pruned.join(', ')}`,
      });
      // 剪除必须**落盘**（审查修复）：此前只写内存日志，于是 queue.json 永远停留在陈旧盘面
      //（外部读盘仍看到"有还债的人"，而那些项每次启动都被剪一遍），留痕也随重启丢失。
      // 本方法是同步的（调用点遍布同步路径），故不 await——persistQueue 自带错误处理（记
      // lastSchedulerError），且关停排空经 trackWrite 会等它落地（见 drain/idle）。
      void this.persistQueue();
    }
  }

  /** 队列持久化文件路径（状态面/测试可读） */
  get pendingQueueFile(): string {
    return this.queueFile;
  }

  /** 盘上待重建的队列项数（状态面：重启后"债与还债的人"是否同源的可观测面） */
  restoredQueueSize(): number {
    this.restoreQueueIfNeeded();
    return this.queue.length;
  }

  // ---- 债务 ----

  private ensureDebtLoaded(): void {
    if (this.debtLoaded) return;
    // debtLoaded 必须在**解析成功之后**才置位（审查修复）：此前先置位再抛错，损坏的 debt.json 会让
    // 本进程余下生命周期"债务视图恒空"——debtTotal()=0 → hardBlocked 永假 → 保护性自锁静默失效，
    // 且下一次 persistDebt 会用空 Map 覆盖掉磁盘上的债务。保持 false 使下次访问重试（可自愈）。
    if (!existsSync(this.debtFile)) {
      this.debtLoaded = true;
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.debtFile, 'utf8'));
    } catch (e) {
      throw new Error(`maintenance debt file corrupt: ${this.debtFile}: ${(e as Error).message}`);
    }
    if (!Array.isArray(raw)) throw new Error(`maintenance debt file invalid: ${this.debtFile}`);
    this.debt = new Map();
    for (const rec of raw as MaintenanceDebt[]) {
      // 已知问题《债务与"还债的人"不同源》修复后的加载口径：**不再按任务名硬编码剪除**僵尸债务
      //（旧实现在此处丢弃 `gc` 与 `turn-finalize:*`——理由是"调度只执行 enqueue 队列，恢复的债务
      // 永不清偿"）。现在队列随 `queue.json` 落盘、加载时按 `restoreTask` 重建，"还债的人"与债务
      // 同源：可重建的任务照常被调度并清偿；不可重建的（如属主会话已消失的会话级收尾）由队列重建
      // 路径剪除并如实留痕，其债务保留为**无主债务**（`subsystem` 缺失 → 进人工裁定清单），
      // 而不是在这里静默丢掉——静默丢弃正是"债务只增不减却查不出来源"的另一面。
      if (rec && typeof rec.task_id === 'string' && rec.task_id.length > 0) {
        // 历史条目（无来源记录）→ 补齐时间字段（来源留空 = 无主债务，进人工裁定清单，不自动清除）
        const at = typeof rec.accumulated_at === 'number' ? rec.accumulated_at : this.nowFn();
        this.debt.set(rec.task_id, {
          ...rec,
          first_seen: typeof rec.first_seen === 'number' ? rec.first_seen : at,
          last_failure: typeof rec.last_failure === 'number' ? rec.last_failure : at,
        });
      }
    }
    this.debtLoaded = true; // 解析成功 → 标记已加载（失败路径保持 false，允许下次重试）
  }

  private debtTotal(): number {
    this.ensureDebtLoaded();
    let total = 0;
    for (const d of this.debt.values()) total += d.value;
    return total;
  }

  /** 债务累计：value 累加 + accumulated_at 更新（priority/estimated_cost/urgency 取最新任务值）；
   *  来源记录（已知问题「债务是保护性自锁」第 1 条）：subsystem/reason 来自入队方，first_seen 只在
   *  首次累计时写入（跨多次累计保持不变，供「长期无主」判定）、last_failure 每次更新。 */
  private accumulateDebt(t: MaintenanceTask): void {
    this.ensureDebtLoaded();
    const prev = this.debt.get(t.id);
    const now = this.nowFn();
    this.debt.set(t.id, {
      task_id: t.id,
      value: (prev?.value ?? 0) + t.value,
      accumulated_at: now,
      priority: t.priority,
      estimated_cost: t.estimated_cost,
      urgency: t.urgency,
      subsystem: t.subsystem ?? prev?.subsystem,
      reason: t.reason ?? prev?.reason,
      first_seen: prev?.first_seen ?? now,
      last_failure: now,
    });
  }

  /**
   * 非执行路径（中断/hard 跳过/失败）的债务累计（P1c §10.1）：
   * 已入队即累计（accrueDebt）的任务 → 债务已在入队时入账，不重复累计（防双计）；
   * 未入账任务（既有默认语义）→ 照常累计（失败/跳过惩罚）。
   */
  private accrueOnNonRun(t: MaintenanceTask): void {
    if (this.accruedAtEnqueue.has(t.id)) {
      return;
    }
    this.accumulateDebt(t);
  }

  private clearDebt(taskId: string): void {
    this.ensureDebtLoaded();
    this.debt.delete(taskId);
    this.accruedAtEnqueue.delete(taskId);
  }

  /**
   * 原子写：tmp + rename（.evolution/debt.json）；无债务且无文件 → 不写。
   *
   * 落盘失败**不向上抛**（审查修复）：本方法被"任务成功 → 清偿 → 落盘"路径直接 await，
   * 抛出去会让整条维护调用链 reject（定时器路径只记 lastSchedulerError，任务实际已成功执行
   * 却被算成失败；请求间隙路径还会 reject 到 prepareForTurn 的 catch）——而同一个文件里的
   * `persistQueue` 早已是"记 lastSchedulerError 后继续"的口径。统一到这个口径：内存账本不回滚
   *（与队列同纪律：账本已改就是已改，落盘失败只影响"跨重启可见性"，由 scheduler_error 如实暴露）。
   */
  private async persistDebt(): Promise<void> {
    if (this.debt.size === 0 && !existsSync(this.debtFile)) return;
    const settle = this.trackWrite(); // 关停排空据此等待（见 drain/idle）
    try {
      await this.atomicWriteJson(this.debtFile, JSON.stringify(this.debtSnapshot(), null, 2));
    } catch (err) {
      this.lastSchedulerError = `债务落盘失败（${this.debtFile}）：${(err as Error).message}——内存账本保留，下次落盘重试`;
    } finally {
      settle();
    }
  }

  /**
   * 债务释放审计落盘（追加写 <debtDir>/debt-releases.jsonl；幂等建目录）。
   * 尽力而为：写入失败 → 释放已生效、审计缺失（内存面仍可读 debtReleaseAudit()）——不因审计写失败
   * 回滚已确认的修复结果（回滚会让系统停在「已修好但债还在」的矛盾态）。
   */
  private async appendReleaseAudit(rec: DebtReleaseRecord): Promise<void> {
    this.releaseLog.push(rec);
    const settle = this.trackWrite();
    try {
      await mkdir(dirname(this.releaseLogFile), { recursive: true });
      await appendFile(this.releaseLogFile, `${JSON.stringify(rec)}\n`, 'utf8');
    } catch {
      // 审计写入失败 → 降级（内存面保留；调用方可从 debtReleaseAudit() 读回）
    } finally {
      settle();
    }
  }

  /**
   * S2：维护观测落盘（追加写 .evolution/maintenance-observations/<yyyy-mm-dd>.jsonl；幂等建目录）。
   * 尽力而为：写入失败 → 降级不阻塞调度（观测为审计日志——缺观测不中断维护链）。
   */
  private async appendObservation(obs: MaintenanceObservation): Promise<void> {
    const settle = this.trackWrite();
    try {
      await mkdir(this.observationsDir, { recursive: true });
      await appendFile(join(this.observationsDir, `${utcDay(obs.ts)}.jsonl`), `${JSON.stringify(obs)}\n`, 'utf8');
    } catch {
      // 观测写入失败 → 降级（不抛：调度照常；观测缺失由摘要面诚实呈现）
    } finally {
      settle();
    }
  }

  // ---- 定时器 ----

  /** 有效 tick 间隔：债务合计 ≥ soft 或队列含 soft/critical 任务 → 基准减半（提高 quantum 频率） */
  private effectiveTickMs(): number {
    const urgent =
      this.critical.size > 0 || this.queue.some((t) => t.urgency === 'soft' || t.urgency === 'critical');
    if (this.debtTotal() >= this.softLimit || urgent) {
      return Math.max(1, Math.floor(this.baseTickMs / 2));
    }
    return this.baseTickMs;
  }

  private resetTimer(): void {
    if (!this.started) return;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.baseTickMs <= 0) return;
    this.timer = setInterval(() => {
      void this.tick().catch((err: unknown) => {
        // 定时器驱动路径：任务级错误已由 tick 内部转为债务；此处只兜住**调度器自身**的异常
        // （例如 debt.json 损坏 → ensureDebtLoaded 抛错）。审查修复：此前空 catch 会把这类故障
        // 完全吞掉，使"债务视图恒空 → 硬限失效"不可观测；现在记入 lastSchedulerError 供状态面读取。
        this.lastSchedulerError = `维护 tick 失败：${err instanceof Error ? err.message : String(err)}`;
      });
    }, this.effectiveTickMs());
    // unref：维护定时器不得阻止宿主进程退出（Node 事件循环语义）。同时这是测试隔离的必要条件——
    // 未 unref 的 interval 会在测试结束、临时目录删除之后继续触发 tick（写入 debt.json/观测文件），
    // 与 rm 竞态产生 ENOTEMPTY 抖动（并在被 kill 时打断收尾）。unref 后定时器仍照常在宿主运行期触发，
    // 只是不再单独撑住进程。
    this.timer.unref?.();
  }
}
