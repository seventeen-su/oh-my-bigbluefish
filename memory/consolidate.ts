// OMB v2 记忆整合批处理（架构 §7.2 空闲期 consolidation / §7.4 八算子规则版 / §7.1 更新局部化）：
// dedup（Condense：同内容保留最新、其余 Frozen）→ merge（Condense：包含关系文本合并为新记忆、
// payload 拼接 + relation Link，旧项 Frozen）→ relation（Associate：scope+kind 邻接表建边）→
// decay（Decay=Forget 数值机制：Active 超 DORMANT_AFTER_MS → Dormant、超 FROZEN_AFTER_MS → Frozen）。
// 全部规则化、无 LLM。幂等（中断重跑收敛一致）：各步仅处理前态记忆（非 Frozen/Retired 候选）；
// 合并新记忆 event_id 由源 id 确定性派生（ingest ON CONFLICT(event_id) no-op）；relation 建边先
// 查重——重跑无新增变更。
// 影响域：每步按 scope+kind 记录受影响查询路由（更新局部化 Contract 四问，§7.1；
// 隔离单位 = 作用域 + 检索路由，T3.4 路由未实现前以 `${scope}/${kind}` 近似）。
// 调度：仅依赖 MaintenanceScheduler 最小接口（enqueue——consolidate 只入队，不请求 quantum）；
// createDirectScheduler() = M3 最小实现（enqueue 直接执行 run），完整 Queue+Debt+Priority+ROI+
// Critical 由 M5 升级（无循环依赖）。接口收窄为实际使用形状：完整调度器无需 cast 即可直传。
// layer 2（memory/）：仅 node: 内置 + kernel/schemas/（同层契约）+ memory/ 内文件。
import { createHash } from 'node:crypto';
import { makeMutableId, type Scope } from '../kernel/schemas/base.js';
import type { Memory, MemoryKind, MemoryLifecycle } from '../kernel/schemas/m.js';
import type { SqliteMemoryBackend } from './backend.js';
import { contentHash, normalizeText } from './staging-policy.js';

// ---- 最小 MaintenanceScheduler 接口（M5 升级完整实现；收窄为 consolidate 实际使用的形状） ----

export interface MaintenanceScheduler {
  enqueue(task: { id: string; run: () => Promise<void> }): Promise<void>;
}

/** M3 最小实现：enqueue 直接执行 run（M5 替换为完整 Queue+Debt 调度） */
export function createDirectScheduler(): MaintenanceScheduler {
  return {
    async enqueue(task) {
      await task.run();
    },
  };
}

// ---- 报告类型 ----

/** 更新局部化 Contract 四问记录（§7.1）：改了哪些模块 / 哪些查询受影响 / 影响范围 / 是否需回归 */
export interface ImpactRecord {
  /** 受影响查询路由（按 scope+kind 推断：`${scope}/${kind}`，待 T3.4 路由细化） */
  query_affected: string[];
  /** 受影响模块（本阶段 = 被改动的表：memory / memory_relation） */
  modules_affected: string[];
  scope: string;
  /** 记忆/关系被改动 → 检索结果可能变化 → 需要回归（保守恒 true，待 T3.4 精确化） */
  regression_needed: boolean;
  note: string;
}

export interface ConsolidationReport {
  /** 被 dedup 冻结（Frozen）的重复项数 */
  deduped: number;
  /** 被 merge 并入（Frozen）的源记忆数（每次合并 = 2） */
  merged: number;
  /** 新建 memory_relation 边数 */
  related: number;
  /** 衰减迁移（→Dormant/Frozen）的记忆数 */
  decayed: number;
  /** 有变更的作用域 */
  affected_scopes: string[];
  /** 更新局部化记录（每 步骤×作用域 一条） */
  impact: ImpactRecord[];
}

// ---- 初始常量表（待标定，§17） ----

/** Active 超过该时长（默认 90 天）→ Dormant */
export const DORMANT_AFTER_MS = 90 * 24 * 60 * 60 * 1000;

/** Active/Dormant 超过该时长（默认 365 天）→ Frozen */
export const FROZEN_AFTER_MS = 365 * 24 * 60 * 60 * 1000;

/** merge 生成的 relation 边类型（merged → 被合并项） */
export const MERGE_LINK_TYPE = 'merged';

/** scope+kind 邻接表（Associate 初始规则：from kind → to kind；type 为边语义；待标定）。
 *  brief 示例 "Decision→Experience" 按 MemoryKindEnum 落地为 Decision→Episodic（经验记忆维度）。 */
export const KIND_LINK_RULES: { from: MemoryKind; to: MemoryKind; type: string }[] = [
  { from: 'Decision', to: 'Episodic', type: 'informs' },
  { from: 'Constraint', to: 'Semantic', type: 'constrains' },
  { from: 'Episodic', to: 'Procedural', type: 'exemplifies' },
];

/** consolidate 任务 id（scheduler.enqueue 的 task.id） */
export const CONSOLIDATION_TASK_ID = 'memory-consolidation';

// ---- 纯函数 ----

/** merge 判定：规范化后文本互为前缀/包含（内容相同属 dedup 不在此列；待标定） */
function mergeable(a: Memory, b: Memory): boolean {
  const na = normalizeText(a.payload);
  const nb = normalizeText(b.payload);
  if (na === nb) return false;
  return na.includes(nb) || nb.includes(na);
}

/** merge 新记忆 event_id：源 id 排序后哈希（确定性）→ ingest 幂等键（中断重跑 no-op 收敛） */
function mergedEventId(a: Memory, b: Memory): string {
  const key = [a.id, b.id].sort().join('\u0000');
  return `consolidated:${createHash('sha256').update(key, 'utf8').digest('hex')}`;
}

/** 合并新记忆构造：payload 拼接（旧→新序）；provenance 派生（transformation_chain 记源 id） */
function buildMergedMemory(a: Memory, b: Memory, now: number): Memory {
  const ts = new Date(now).toISOString();
  return {
    ir_version: '2.0',
    id: makeMutableId('memory'),
    schema: 'omb/M1',
    scope: a.scope,
    lifecycle: 'Active',
    immutable: false,
    owner: 'kernel',
    created: ts,
    updated: ts,
    provenance: {
      source: 'system',
      event: mergedEventId(a, b),
      actor: 'kernel',
      environment: a.provenance.environment,
      runtime_snapshot: a.provenance.runtime_snapshot,
      timestamp: ts,
      transformation_chain: [a.id, b.id],
      verification: 'v:rule',
    },
    refs: [],
    kind: a.kind,
    prov_class: a.prov_class,
    payload: `${a.payload}\n${b.payload}`,
    value_score: Math.max(a.value_score, b.value_score),
    utility_counts: sumCounts(a.utility_counts, b.utility_counts),
  };
}

function sumCounts(x: Record<string, number>, y: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = { ...x };
  for (const [k, v] of Object.entries(y)) {
    out[k] = (out[k] ?? 0) + v;
  }
  return out;
}

/** (updated, id) 复合降序（最新优先；ISO 字符串可比，id 兜底确定性） */
function cmpNewestFirst(a: Memory, b: Memory): number {
  const u = b.updated.localeCompare(a.updated);
  return u !== 0 ? u : b.id.localeCompare(a.id);
}

/** (updated, id) 复合升序（最旧优先） */
function cmpOldestFirst(a: Memory, b: Memory): number {
  return -cmpNewestFirst(a, b);
}

// ---- 步骤状态（影响域跟踪） ----

interface StepTrack {
  count: Map<Scope, number>;
  kinds: Map<Scope, Set<MemoryKind>>;
}

interface RunState {
  dedup: StepTrack;
  merge: StepTrack;
  relation: StepTrack;
  decay: StepTrack;
}

function emptyTrack(): StepTrack {
  return { count: new Map(), kinds: new Map() };
}

function emptyState(): RunState {
  return { dedup: emptyTrack(), merge: emptyTrack(), relation: emptyTrack(), decay: emptyTrack() };
}

function bumpCount(track: StepTrack, scope: Scope, n: number): void {
  track.count.set(scope, (track.count.get(scope) ?? 0) + n);
}

function noteKind(track: StepTrack, scope: Scope, kind: MemoryKind): void {
  let ks = track.kinds.get(scope);
  if (!ks) {
    ks = new Set();
    track.kinds.set(scope, ks);
  }
  ks.add(kind);
}

// ---- 批处理步骤（全部规则化，无 LLM） ----

const SCOPES: Scope[] = ['Session', 'Project', 'Global'];
const MAX_QUERY_LIMIT = 1_000_000;

/** dedup：同 scope+kind 规范化内容哈希相同的非终态记忆 → 保留最新（updated），其余 Frozen */
async function dedupStep(b: SqliteMemoryBackend, state: RunState, work: Memory[], scope: Scope): Promise<void> {
  const groups = new Map<string, Memory[]>();
  for (const m of work) {
    if (m.lifecycle === 'Frozen' || m.lifecycle === 'Retired') continue;
    const key = contentHash(m.scope, m.kind, m.payload);
    const g = groups.get(key);
    if (g) {
      g.push(m);
    } else {
      groups.set(key, [m]);
    }
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    group.sort(cmpNewestFirst);
    for (const dup of group.slice(1)) {
      await freeze(b, state.dedup, work, scope, dup);
    }
  }
}

/** merge：同 scope+kind+prov_class 且规范化文本包含关系 → 合并为新记忆（payload 拼接 + Link），旧项 Frozen */
async function mergeStep(b: SqliteMemoryBackend, state: RunState, work: Memory[], scope: Scope, now: number): Promise<void> {
  let pool = work.filter((m) => m.lifecycle === 'Active').sort(cmpOldestFirst);
  let i = 0;
  while (i < pool.length - 1) {
    const a = pool[i]!;
    let mergedAny = false;
    for (let j = i + 1; j < pool.length; j++) {
      const other = pool[j]!;
      if (other.lifecycle !== 'Active') continue; // 已被本轮合并（Frozen）
      if (other.kind !== a.kind || other.prov_class !== a.prov_class) continue;
      if (!mergeable(a, other)) continue;
      const merged = buildMergedMemory(a, other, now);
      const mergedId = await b.ingest(merged);
      merged.id = mergedId; // 幂等 no-op 时返回既有 id
      await b.link(mergedId, a.id, MERGE_LINK_TYPE);
      await b.link(mergedId, other.id, MERGE_LINK_TYPE);
      await freeze(b, state.merge, work, scope, a);
      await freeze(b, state.merge, work, scope, other);
      noteKind(state.merge, scope, a.kind);
      work.push(merged);
      pool = work.filter((m) => m.lifecycle === 'Active').sort(cmpOldestFirst); // 含新 merged，重扫
      mergedAny = true;
      break;
    }
    if (!mergedAny) i++;
  }
}

/** relation（Associate）：同 scope 内按邻接表为（Active/Dormant）记忆建边；已存在边跳过（幂等） */
async function relationStep(b: SqliteMemoryBackend, state: RunState, work: Memory[], scope: Scope): Promise<void> {
  const cands = work.filter((m) => m.lifecycle === 'Active' || m.lifecycle === 'Dormant');
  for (const rule of KIND_LINK_RULES) {
    const froms = cands.filter((m) => m.kind === rule.from);
    const tos = cands.filter((m) => m.kind === rule.to);
    for (const f of froms) {
      for (const t of tos) {
        if (f.id === t.id) continue;
        if (await hasRelation(b, f.id, t.id, rule.type)) continue;
        await b.link(f.id, t.id, rule.type);
        bumpCount(state.relation, scope, 1);
        noteKind(state.relation, scope, rule.from);
        noteKind(state.relation, scope, rule.to);
      }
    }
  }
}

/** decay（Decay=Forget 数值机制）：Active 超 90 天 → Dormant；Active/Dormant 超 365 天 → Frozen */
async function decayStep(b: SqliteMemoryBackend, state: RunState, work: Memory[], scope: Scope, now: number): Promise<void> {
  for (const m of work) {
    if (m.lifecycle !== 'Active' && m.lifecycle !== 'Dormant') continue;
    const age = now - Date.parse(m.updated);
    if (age < 0) continue; // 未来时间戳（时钟偏移）不动
    let next: MemoryLifecycle | null = null;
    if (age >= FROZEN_AFTER_MS) {
      next = 'Frozen';
    } else if (m.lifecycle === 'Active' && age >= DORMANT_AFTER_MS) {
      next = 'Dormant';
    }
    if (next === null) continue;
    await b.update(m.id, { lifecycle: next });
    m.lifecycle = next;
    bumpCount(state.decay, scope, 1);
    noteKind(state.decay, scope, m.kind);
  }
}

// ---- 内部工具 ----

/** 冻结一条记忆（Frozen）并同步工作集；Frozen 不删（P8 可逆：保谱系，可经 Promote 恢复） */
async function freeze(b: SqliteMemoryBackend, track: StepTrack, work: Memory[], scope: Scope, m: Memory): Promise<void> {
  await b.update(m.id, { lifecycle: 'Frozen' });
  m.lifecycle = 'Frozen';
  bumpCount(track, scope, 1);
  noteKind(track, scope, m.kind);
}

/** 边已存在？（backend API 只读检查，避免 link UNIQUE 冲突 fail-loud） */
async function hasRelation(b: SqliteMemoryBackend, fromId: string, toId: string, type: string): Promise<boolean> {
  const walk = await b.relationTraverse(fromId, [type], 1);
  const seed = walk.nodes.find((n) => n.id === fromId);
  return seed?.relations.some((r) => r.to_id === toId) ?? false;
}

async function readAll(b: SqliteMemoryBackend, scope: Scope): Promise<Memory[]> {
  const page = await b.query({ scope, limit: MAX_QUERY_LIMIT, budget: Number.MAX_SAFE_INTEGER });
  return page.items;
}

// ---- 报告 ----

function total(track: StepTrack): number {
  let n = 0;
  for (const v of track.count.values()) n += v;
  return n;
}

function buildReport(state: RunState): ConsolidationReport {
  const steps: { track: StepTrack; label: string; modules: string[] }[] = [
    { track: state.dedup, label: 'dedup', modules: ['memory'] },
    { track: state.merge, label: 'merge', modules: ['memory', 'memory_relation'] },
    { track: state.relation, label: 'relation', modules: ['memory_relation'] },
    { track: state.decay, label: 'decay', modules: ['memory'] },
  ];
  const impact: ImpactRecord[] = [];
  const affected = new Set<Scope>();
  for (const { track, label, modules } of steps) {
    const scopes = [...track.count.keys()].sort();
    for (const scope of scopes) {
      const kinds = [...(track.kinds.get(scope) ?? [])].sort();
      affected.add(scope);
      impact.push({
        scope,
        query_affected: kinds.map((k) => `${scope}/${k}`),
        modules_affected: [...modules],
        regression_needed: true,
        note: `${label}: ${track.count.get(scope) ?? 0}`,
      });
    }
  }
  return {
    deduped: total(state.dedup),
    merged: total(state.merge),
    related: total(state.relation),
    decayed: total(state.decay),
    affected_scopes: [...affected].sort(),
    impact,
  };
}

// ---- 入口 ----

/**
 * 空闲期记忆整合批处理（§7.2）：dedup/merge/relation/decay 全批在一个事务内执行（中断回滚 →
 * 幂等重跑收敛）；经 opts.scheduler.enqueue({id:'memory-consolidation', run}) 入队执行。
 */
export async function consolidate(
  backend: SqliteMemoryBackend,
  opts: { now?: number; scheduler?: MaintenanceScheduler } = {},
): Promise<ConsolidationReport> {
  const now = opts.now ?? Date.now();
  let report: ConsolidationReport | null = null;
  const run = async (): Promise<void> => {
    report = await runConsolidation(backend, now);
  };
  if (opts.scheduler) {
    await opts.scheduler.enqueue({ id: CONSOLIDATION_TASK_ID, run });
  } else {
    await run();
  }
  return report ?? emptyReport();
}

async function runConsolidation(b: SqliteMemoryBackend, now: number): Promise<ConsolidationReport> {
  const state = emptyState();
  await b.transaction(async () => {
    for (const scope of SCOPES) {
      const work = (await readAll(b, scope)).map((m) => ({ ...m }));
      await dedupStep(b, state, work, scope);
      await mergeStep(b, state, work, scope, now);
      await relationStep(b, state, work, scope);
      await decayStep(b, state, work, scope, now);
    }
  });
  return buildReport(state);
}

function emptyReport(): ConsolidationReport {
  return { deduped: 0, merged: 0, related: 0, decayed: 0, affected_scopes: [], impact: [] };
}
