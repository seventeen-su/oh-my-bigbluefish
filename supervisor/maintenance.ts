// OMB v2 维护调度器完整版（架构 §12.3 Maintenance Queue/Debt/Quantum + §9.1 Predictive
// Invalidation + §9.5 ROI + §4.4 Fingerprint）：
// - 调度：统一按 ROI = value/estimated_cost（降序），priority 为 tie-break；critical 强制最前。
// - Debt：失败/未执行（中断、hard 限跳过）→ 累计（value 累加 + accumulated_at 更新）；成功 → 清除；
//   R5：DeferredMaintenanceError（未实现/不可执行）→ 出队但债务保留（不清债）+ deferredEvents 记录
//   （不视为失败崩溃——队列继续；「未实现/未完成 → debt 保留」不再空实现假成功清债）。
//   持久化 .evolution/debt.json（原子写 tmp+rename）。soft 限 → quantum 频率提升（tick 间隔减半）；
//   hard 限 → 非必要（normal）任务跳过；critical → 下一 quantum/tick 优先。
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
import { existsSync, readFileSync } from 'node:fs';
import { appendFile, mkdir, rename, writeFile } from 'node:fs/promises';
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
  run: (signal?: AbortSignal) => Promise<void>;
}

/** M3 最小接口形状兼容：{id, run} 必需，其余缺省（value=1/estimated_cost=1/priority=0/urgency='normal'） */
export type MaintenanceTaskInput = Pick<MaintenanceTask, 'id' | 'run'> &
  Partial<Pick<MaintenanceTask, 'value' | 'estimated_cost' | 'priority' | 'urgency'>>;

export interface MaintenanceDebt {
  task_id: string;
  value: number;
  accumulated_at: number;
  priority: number;
  estimated_cost: number;
  urgency: string;
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
  /** tick 基准间隔（ms）；start() 启动定时器 */
  tickIntervalMs?: number;
  /** 时钟注入（测试）；缺省 Date.now */
  now?: () => number;
}

// ---- 常量（阈值/系数待标定，§17） ----

export const DEFAULT_SOFT_LIMIT = 10;
export const DEFAULT_HARD_LIMIT = 50;
/** tick 基准间隔（ms）；start() 启动定时器。§17 标定验证（T8.20，2026-08-21，主会话裁决「仅记录不写回」）：
 *  约束「维护量子 ≥ 典型任务耗时」由 latency_ms 均值 3973ms（workspace/.omb/bench/bench-*.json，数据来源标注
 *  于 task-m8d-report.md）验证：60000 ≥ 3973 满足 → 数值保持初值。
 *  §17 标定复核（2026-08-23，P6 真实数据）：real-v2-stable JSONL（real-v2-stable-2026-08-23T14-21-35-583Z.jsonl）
 *  latency_ms 均值 1445.65ms / P90 ≈ 2072ms → 60000 ≥ 2072 仍满足（余量 ~29×）→ 数值保持。 */
export const DEFAULT_TICK_INTERVAL_MS = 60_000;
/** 每个环境字段变化的归一化能力衰减系数（能力衰减曲线，待标定） */
export const CAPABILITY_DECAY_FACTOR = 0.8;

/** §4.4 Fingerprint 参与 diff 的字段（固定顺序，保证环境_delta 键序确定性） */
const FP_FIELDS: (keyof Fingerprint)[] = ['os', 'node', 'dsh_version', 'project', 'gpu', 'cuda'];

// ---- 维护调度器 ----

export class MaintenanceScheduler {
  private readonly debtFile: string;
  /** S2：维护观测落盘目录（缺省 <debtFile 同目录>/maintenance-observations） */
  private readonly observationsDir: string;
  /** S2：维护任务成本注入面（policy.evolve.maintenance_costs；enqueue 缺省成本按 id 查找） */
  private maintenanceCosts: Readonly<Partial<Record<string, number>>>;
  private readonly softLimit: number;
  private readonly hardLimit: number;
  private readonly baseTickMs: number;
  private readonly nowFn: () => number;
  private queue: MaintenanceTask[] = [];
  private debt = new Map<string, MaintenanceDebt>();
  private critical = new Set<string>();
  /** P1c §10.1：入队即累计债务的任务 id（事件入队累加 value；防失败/跳过路径重复累计） */
  private accruedAtEnqueue = new Set<string>();
  private stopped = false;
  private started = false;
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private debtLoaded = false;
  private tickCountValue = 0;
  private readonly inFlight = new AbortController();
  /** R5：Deferred 事件记录（未实现/不可执行任务；见 DeferredMaintenanceError） */
  private deferredLog: DeferredEvent[] = [];

  constructor(opts: MaintenanceSchedulerOptions = {}) {
    this.debtFile = opts.debtFile ?? join(process.cwd(), 'workspace', '.omb', '.evolution', 'debt.json');
    this.observationsDir =
      opts.observationsDir ?? join(dirname(this.debtFile), 'maintenance-observations');
    this.maintenanceCosts = opts.maintenanceCosts ?? {};
    this.softLimit = opts.softLimit ?? DEFAULT_SOFT_LIMIT;
    this.hardLimit = opts.hardLimit ?? DEFAULT_HARD_LIMIT;
    this.baseTickMs = opts.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
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
    const task: MaintenanceTask = {
      id: input.id,
      value: input.value ?? 1,
      // S2：成本注入面——未给 estimated_cost 且任务 id 命中注入表 → 用 policy 成本（未列出 id 仍 M3 缺省 1）
      estimated_cost: input.estimated_cost ?? this.maintenanceCosts[input.id] ?? 1,
      priority: input.priority ?? 0,
      urgency: input.urgency ?? 'normal',
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
    this.resetTimer(); // 紧急任务挂起可能改变 tick 频率
  }

  /** 标记任务为 critical：request boundary 强制插入（下一 quantum/tick 优先执行） */
  markCritical(taskId: string): void {
    this.critical.add(taskId);
    this.resetTimer();
  }

  /** 请求间隙小量子：执行 1 个可执行任务（可中断：调用方 signal ∪ stop() 的 inFlight）；
   *  hard 限跳过者记录 skipped + 债务累计 */
  async requestQuantum(opts: { signal?: AbortSignal } = {}): Promise<QuantumReport> {
    if (this.stopped || this.queue.length === 0) return { ran: [], skipped: [] };
    const signal = this.execSignal(opts.signal);
    if (signal.aborted) {
      // 中断（未执行）→ 债务累计，任务留队
      const top = this.sortedQueue()[0]!;
      this.accrueOnNonRun(top);
      await this.persistDebt();
      return { ran: [], skipped: [top.id] };
    }
    const report: QuantumReport = { ran: [], skipped: [] };
    for (const t of this.sortedQueue()) {
      if (this.hardBlocked(t)) {
        report.skipped.push(t.id);
        this.accrueOnNonRun(t);
        continue;
      }
      const r = await this.runOne(t, signal);
      report.ran.push(...r.ran);
      report.skipped.push(...r.skipped);
      await this.persistDebt();
      this.resetTimer(); // 债务变化可能改变 tick 频率
      return report;
    }
    await this.persistDebt(); // 全部被 hard 跳过
    return report;
  }

  /** tick：批量处理队列（进程内定时器驱动；可手动调用）；执行 signal（调用方 ∪ inFlight）中断时停止取新任务 */
  async tick(opts: { signal?: AbortSignal } = {}): Promise<QuantumReport> {
    this.tickCountValue++;
    if (this.stopped || this.running || this.queue.length === 0) return { ran: [], skipped: [] };
    this.running = true;
    try {
      const signal = this.execSignal(opts.signal);
      const report: QuantumReport = { ran: [], skipped: [] };
      for (const t of this.sortedQueue()) {
        if (signal.aborted) break;
        if (this.hardBlocked(t)) {
          report.skipped.push(t.id);
          this.accrueOnNonRun(t);
          continue;
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

  /** 当前债务快照（深拷贝；task_id 排序，确定性） */
  debtSnapshot(): MaintenanceDebt[] {
    this.ensureDebtLoaded();
    return [...this.debt.values()]
      .sort((a, b) => a.task_id.localeCompare(b.task_id))
      .map((d) => ({ ...d }));
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
   * S2：观测摘要（kern_status 可读入口）——今日（UTC）任务数 + 各任务平均耗时（per_task 按 task_id 排序，确定性）。
   * 无观测目录/文件 → 全零（安全降级）；文件不可读 → 抛错（调用方降级字段记录，不静默吞错）。
   */
  observationsSummary(): MaintenanceObservationSummary {
    const date = utcDay(this.nowFn());
    const file = join(this.observationsDir, `${date}.jsonl`);
    const perTask = new Map<string, { count: number; totalMs: number }>();
    if (existsSync(file)) {
      let raw: string;
      try {
        raw = readFileSync(file, 'utf8');
      } catch (err) {
        throw new Error(`maintenance observations unreadable: ${file}: ${(err as Error).message}`);
      }
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

  /** hard 限：债务合计 ≥ hardLimit 时非必要（normal）任务跳过（限制非必要演化） */
  private hardBlocked(t: MaintenanceTask): boolean {
    return this.debtTotal() >= this.hardLimit && t.urgency === 'normal';
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
      this.removeFromQueue(t.id);
      if (err instanceof DeferredMaintenanceError) {
        // R5：未实现/不可执行 → 出队但债务保留（不清债）+ 记录 deferred；不视为失败崩溃
        this.deferredLog.push({ task_id: t.id, at: this.nowFn(), reason: err.message });
        if (!wasAccrued) {
          this.accrueOnNonRun(t); // 未入账任务 → 债务累计（未完成 → debt 保留）
        }
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
    this.removeFromQueue(t.id);
    this.clearDebt(t.id);
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

  private removeFromQueue(id: string): void {
    this.queue = this.queue.filter((t) => t.id !== id);
    this.critical.delete(id);
    this.accruedAtEnqueue.delete(id);
  }

  // ---- 债务 ----

  private ensureDebtLoaded(): void {
    if (this.debtLoaded) return;
    this.debtLoaded = true;
    if (!existsSync(this.debtFile)) return;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.debtFile, 'utf8'));
    } catch (e) {
      throw new Error(`maintenance debt file corrupt: ${this.debtFile}: ${(e as Error).message}`);
    }
    if (!Array.isArray(raw)) throw new Error(`maintenance debt file invalid: ${this.debtFile}`);
    this.debt = new Map();
    for (const rec of raw as MaintenanceDebt[]) {
      if (rec && typeof rec.task_id === 'string') this.debt.set(rec.task_id, { ...rec });
    }
  }

  private debtTotal(): number {
    this.ensureDebtLoaded();
    let total = 0;
    for (const d of this.debt.values()) total += d.value;
    return total;
  }

  /** 债务累计：value 累加 + accumulated_at 更新（priority/estimated_cost/urgency 取最新任务值） */
  private accumulateDebt(t: MaintenanceTask): void {
    this.ensureDebtLoaded();
    const prev = this.debt.get(t.id);
    this.debt.set(t.id, {
      task_id: t.id,
      value: (prev?.value ?? 0) + t.value,
      accumulated_at: this.nowFn(),
      priority: t.priority,
      estimated_cost: t.estimated_cost,
      urgency: t.urgency,
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

  /** 原子写：tmp + rename（.evolution/debt.json）；无债务且无文件 → 不写 */
  private async persistDebt(): Promise<void> {
    if (this.debt.size === 0 && !existsSync(this.debtFile)) return;
    await mkdir(dirname(this.debtFile), { recursive: true });
    const tmp = `${this.debtFile}.tmp`;
    await writeFile(tmp, JSON.stringify(this.debtSnapshot(), null, 2), 'utf8');
    await rename(tmp, this.debtFile);
  }

  /**
   * S2：维护观测落盘（追加写 .evolution/maintenance-observations/<yyyy-mm-dd>.jsonl；幂等建目录）。
   * 尽力而为：写入失败 → 降级不阻塞调度（观测为审计日志——缺观测不中断维护链）。
   */
  private async appendObservation(obs: MaintenanceObservation): Promise<void> {
    try {
      await mkdir(this.observationsDir, { recursive: true });
      await appendFile(join(this.observationsDir, `${utcDay(obs.ts)}.jsonl`), `${JSON.stringify(obs)}\n`, 'utf8');
    } catch {
      // 观测写入失败 → 降级（不抛：调度照常；观测缺失由摘要面诚实呈现）
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
      void this.tick().catch(() => {
        /* 定时器驱动路径：任务级错误已由 tick 内部转为债务，不向外泄漏 */
      });
    }, this.effectiveTickMs());
  }
}
