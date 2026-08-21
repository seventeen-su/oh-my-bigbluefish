// OMB v2 维护调度器完整版（架构 §12.3 Maintenance Queue/Debt/Quantum + §9.1 Predictive
// Invalidation + §9.5 ROI + §4.4 Fingerprint）：
// - 调度：统一按 ROI = value/estimated_cost（降序），priority 为 tie-break；critical 强制最前。
// - Debt：失败/未执行（中断、hard 限跳过）→ 累计（value 累加 + accumulated_at 更新）；成功 → 清除；
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
// layer 1（supervisor/）：仅 node: 内置 + kernel/schemas/（契约例外）+ supervisor/ 内文件。
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Fingerprint } from '../kernel/schemas/base.js';

// ---- 类型 ----

export type Urgency = 'normal' | 'soft' | 'hard' | 'critical';

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
export const DEFAULT_TICK_INTERVAL_MS = 60_000;
/** 每个环境字段变化的归一化能力衰减系数（能力衰减曲线，待标定） */
export const CAPABILITY_DECAY_FACTOR = 0.8;

/** §4.4 Fingerprint 参与 diff 的字段（固定顺序，保证环境_delta 键序确定性） */
const FP_FIELDS: (keyof Fingerprint)[] = ['os', 'node', 'dsh_version', 'project', 'gpu', 'cuda'];

// ---- 维护调度器 ----

export class MaintenanceScheduler {
  private readonly debtFile: string;
  private readonly softLimit: number;
  private readonly hardLimit: number;
  private readonly baseTickMs: number;
  private readonly nowFn: () => number;
  private queue: MaintenanceTask[] = [];
  private debt = new Map<string, MaintenanceDebt>();
  private critical = new Set<string>();
  private stopped = false;
  private started = false;
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private debtLoaded = false;
  private tickCountValue = 0;
  private readonly inFlight = new AbortController();

  constructor(opts: MaintenanceSchedulerOptions = {}) {
    this.debtFile = opts.debtFile ?? join(process.cwd(), 'workspace', '.omb', '.evolution', 'debt.json');
    this.softLimit = opts.softLimit ?? DEFAULT_SOFT_LIMIT;
    this.hardLimit = opts.hardLimit ?? DEFAULT_HARD_LIMIT;
    this.baseTickMs = opts.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
    this.nowFn = opts.now ?? (() => Date.now());
  }

  /** 入队（M3 兼容形状：{id, run}，其余缺省；返回 Promise<void> 与 M3 最小接口同形，调用方可 await）；
   *  同 id 重复入队 → 替换；urgency='critical' 自动强制优先 */
  async enqueue(input: MaintenanceTaskInput): Promise<void> {
    if (this.stopped) return;
    const task: MaintenanceTask = {
      id: input.id,
      value: input.value ?? 1,
      estimated_cost: input.estimated_cost ?? 1,
      priority: input.priority ?? 0,
      urgency: input.urgency ?? 'normal',
      run: input.run,
    };
    const idx = this.queue.findIndex((t) => t.id === task.id);
    if (idx >= 0) this.queue.splice(idx, 1);
    this.queue.push(task);
    if (task.urgency === 'critical') this.markCritical(task.id);
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
      this.accumulateDebt(top);
      await this.persistDebt();
      return { ran: [], skipped: [top.id] };
    }
    const report: QuantumReport = { ran: [], skipped: [] };
    for (const t of this.sortedQueue()) {
      if (this.hardBlocked(t)) {
        report.skipped.push(t.id);
        this.accumulateDebt(t);
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
          this.accumulateDebt(t);
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

  /** 执行单个任务：成功 → 出队 + 清债；失败 → 出队 + 债务累计；中断 → 留队 + 债务累计（可重试） */
  private async runOne(t: MaintenanceTask, signal?: AbortSignal): Promise<QuantumReport> {
    try {
      await t.run(signal);
    } catch (err) {
      const aborted = signal?.aborted === true || (err instanceof Error && err.name === 'AbortError');
      if (aborted) {
        this.accumulateDebt(t); // 未执行 → 债务累计
        return { ran: [], skipped: [t.id] };
      }
      this.removeFromQueue(t.id);
      this.accumulateDebt(t); // 执行失败 → 债务累计
      return { ran: [t.id], skipped: [] };
    }
    this.removeFromQueue(t.id);
    this.clearDebt(t.id);
    return { ran: [t.id], skipped: [] };
  }

  private removeFromQueue(id: string): void {
    this.queue = this.queue.filter((t) => t.id !== id);
    this.critical.delete(id);
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

  private clearDebt(taskId: string): void {
    this.ensureDebtLoaded();
    this.debt.delete(taskId);
  }

  /** 原子写：tmp + rename（.evolution/debt.json）；无债务且无文件 → 不写 */
  private async persistDebt(): Promise<void> {
    if (this.debt.size === 0 && !existsSync(this.debtFile)) return;
    await mkdir(dirname(this.debtFile), { recursive: true });
    const tmp = `${this.debtFile}.tmp`;
    await writeFile(tmp, JSON.stringify(this.debtSnapshot(), null, 2), 'utf8');
    await rename(tmp, this.debtFile);
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
