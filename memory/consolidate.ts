// OMB v2 记忆整合批处理（架构 §7.2 空闲期 consolidation / §7.4 八算子规则版 / §7.1 更新局部化）：
// dedup（Condense：同内容保留最新、其余 Frozen）→ merge（Condense：包含关系文本合并为新记忆、
// payload 拼接 + relation Link，旧项 Frozen）→ relation（Associate：scope+kind 邻接表建边 +
// 词法/向量相似度驱动建边——已知问题《关系图为空图》）→
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
import { asRelationBackend } from './backend-relation.js';
import type { SqliteMemoryBackend } from './backend.js';
import { applySimilarityEdges, asVectorSource, planSimilarityEdges } from './relations.js';
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
  /** 下次调用的 scope 轮转起点（预算/中断导致提前结束时的推进） */
  nextScopeOffset?: number;
  /** 本次是否因预算耗尽提前结束 */
  budgetExhausted?: boolean;
  /** 本次读取/处理的记忆条数（"跑了多少"；与四个变更计数（"改了什么"）语义分离） */
  processed: number;
  /** 本次是否有真实改动（收敛判据：false → 本次无事可做） */
  dirty: boolean;
}

function emptyTrack(): StepTrack {
  return { count: new Map(), kinds: new Map() };
}

function emptyState(): RunState {
  return {
    dedup: emptyTrack(),
    merge: emptyTrack(),
    relation: emptyTrack(),
    decay: emptyTrack(),
    processed: 0,
    dirty: false,
  };
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

/**
 * 单次整合的**处理预算**（已知问题《记忆整合没有真实批次上限》修复）。
 *
 * 此前：事务内 `limit: 1_000_000` 全表读取 + `merge` 平方级双循环 + 事务体内零中断检查 →
 * 库大时 CPU/内存双爆、长时间持有写事务（同进程其它写入撞 busy_timeout）、进程被杀留下超长 WAL。
 *
 * 取向选择（"保持原子但限流" vs "分批但允许部分完成"）：**两者都要，但边界划清**：
 *   - 事务边界 = **单个 scope**（2026-09 修订：原为一个调用一个事务；二义"半个 merge"仍不可能出现，
 *     但跨 scope 的"全或无"已放弃——理由与代价见 `consolidate()` 的"事务边界"段）；
 *   - 但单次调用**只处理预算内的记忆**（默认 2000 条/次，per scope 轮转），超出部分留给下一次量子/
 *     下一次收尾。事务因此有界（内存驻留、锁持有时长、WAL 体积都随预算封顶），而多次调用之间
 *     自然形成"分批推进"——每次调用返回的 report 都自洽（它只描述本次真实改了什么）。
 *   - 幂等性不受影响：各步只处理前态记忆，重跑收敛一致（原始设计不变量），故"上次没轮到的记忆"
 *     下次照常处理，不需要跨调用的游标（轮转起点见 ConsolidationBudget.scopeOffset）。
 */
export interface ConsolidationBudget {
  /** 单次调用最多读取/处理的记忆条数（≤0 或未给 → 缺省 DEFAULT_CONSOLIDATION_BUDGET） */
  maxMemoriesPerRun?: number;
  /** 本次从哪个 scope 起（轮转起点，0..2；用于避免库大时后面的 scope 永远轮不到） */
  scopeOffset?: number;
  /** 中断信号（收尾/让出：每个处理单元之间检查一次——见 assertNotAborted） */
  signal?: AbortSignal;
}

/** 单次整合缺省预算（2000 条：事务时延与单量子余量同量级；库大时多跑几次而非一次爆） */
export const DEFAULT_CONSOLIDATION_BUDGET = 2000;

/** 中断检查（每个处理单元之前——已知问题《12 个维护任务里只有 1 个真正可被中断》修复面之一） */
function assertNotAborted(signal: AbortSignal | undefined, phase: string): void {
  if (signal?.aborted === true) {
    const err = new Error(`memory_consolidation 中断于 ${phase}`);
    err.name = 'AbortError';
    throw err;
  }
}

/**
 * dedup：同 scope+kind 规范化内容哈希相同的非终态记忆 → 保留最新（updated），其余 Frozen。
 *
 * 数据面（已知问题《记忆整合没有真实批次上限》修复的性能面）：先取**轻量键列**
 * （`dedupKeyRows`：id/payload/updated/lifecycle/kind，不读完整 body、不逐行 JSON.parse）在应用层
 * 按 `contentHash` 分组（规范化语义只能在应用层表达——SQL 分组会漏掉"空白折叠后相同"的重复），
 * 再**只对确认重复的项**取完整记录并冻结。语义与"全表读取后在内存分组"完全等价，
 * 但内存驻留与解析代价是原来的 O(键列/全记录) 比例。
 */
async function dedupStep(
  b: SqliteMemoryBackend,
  state: RunState,
  scope: Scope,
  signal?: AbortSignal,
): Promise<number> {
  const rows = b.dedupKeyRows(scope);
  const groups = new Map<string, Array<{ id: string; kind: MemoryKind; updated: number; payload: string }>>();
  for (const r of rows) {
    if (r.lifecycle === 'Frozen' || r.lifecycle === 'Retired') continue;
    const key = contentHash(scope, r.kind as MemoryKind, r.payload);
    const g = groups.get(key);
    const entry = { id: r.id, kind: r.kind as MemoryKind, updated: r.updated, payload: r.payload };
    if (g) {
      g.push(entry);
    } else {
      groups.set(key, [entry]);
    }
  }
  let frozen = 0;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    // 保留最新（updated epoch ms 降序，id 兜底确定性）→ 其余为重复项
    group.sort((a, b) => {
      const u = b.updated - a.updated;
      return u !== 0 ? u : b.id.localeCompare(a.id);
    });
    const dupIds = group.slice(1).map((e) => e.id);
    // 只取重复项的完整记录（非重复项从不进入内存 body 面）
    for (const m of b.getMany(dupIds)) {
      assertNotAborted(signal, `dedup/${scope}`);
      await freeze(b, state.dedup, scope, m);
      frozen++;
    }
  }
  return frozen;
}

/** merge：同 scope+kind+prov_class 且规范化文本包含关系 → 合并为新记忆（payload 拼接 + Link），旧项 Frozen */
async function mergeStep(
  b: SqliteMemoryBackend,
  state: RunState,
  work: Memory[],
  scope: Scope,
  now: number,
  signal?: AbortSignal,
): Promise<void> {
  let pool = work.filter((m) => m.lifecycle === 'Active').sort(cmpOldestFirst);
  let i = 0;
  while (i < pool.length - 1) {
    assertNotAborted(signal, `merge/${scope}`);
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
      await freeze(b, state.merge, scope, a);
      await freeze(b, state.merge, scope, other);
      noteKind(state.merge, scope, a.kind);
      work.push(merged);
      // 重扫只针对**仍为 Active** 的候选（Frozen 项不再可能参与合并）——原实现每次合并后
      // 全量重排 work（含已 Frozen 的历史项），合并次数一多即退化为 O(n² log n)（已知问题
      // 《记忆整合没有真实批次上限》的性能面）。此处保持语义等价（同样的候选集合与顺序）。
      pool = work.filter((m) => m.lifecycle === 'Active').sort(cmpOldestFirst);
      mergedAny = true;
      break;
    }
    if (!mergedAny) i++;
  }
}

/** relation（Associate）：① kind 邻接规则建边（既有路径，权重 1）；② 词法 + 向量相似度建边
 *  （已知问题《关系图为空图》——规则依赖生产中不存在的记忆类型，故必须补上内容驱动的建边路径）。
 *  两者都幂等（已存在边跳过 / 相似边按权重 upsert），重跑不放大。 */
async function relationStep(
  b: SqliteMemoryBackend,
  state: RunState,
  work: Memory[],
  scope: Scope,
  now: number,
  signal?: AbortSignal,
): Promise<void> {
  const cands = work.filter((m) => m.lifecycle === 'Active' || m.lifecycle === 'Dormant');
  for (const rule of KIND_LINK_RULES) {
    const froms = cands.filter((m) => m.kind === rule.from);
    const tos = cands.filter((m) => m.kind === rule.to);
    for (const f of froms) {
      assertNotAborted(signal, `relation/${scope}`);
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
  // 相似度驱动（词法 + 向量同口径）：无向量面（纯词法后端）→ 只用词法证据，不假装有向量
  const rb = asRelationBackend(b);
  if (rb === null) return; // 后端无属性建边能力（纯 SqliteMemoryBackend）→ 仅规则边
  const vecSrc = asVectorSource(rb);
  const vectors = vecSrc === null ? new Map<string, Float32Array>() : vecSrc.vectorsFor(cands.map((m) => m.id));
  const planned = planSimilarityEdges(cands, vectors);
  const applied = await applySimilarityEdges(rb, planned, now);
  if (applied.created > 0) {
    bumpCount(state.relation, scope, applied.created);
    // 影响域类型标注（审查修复 M3）：按**实际参与建边的记忆类型**逐个 noteKind——
    // 此前硬编码 'Semantic'，而生产记忆以 Episodic 为主 → 真正受影响的 Project/Episodic 路由没被标注，
    // "更新局部化 Contract 四问"的 query_affected 与现实不符。
    const kindOf = new Map(cands.map((m) => [m.id, m.kind]));
    const touched = new Set<MemoryKind>();
    for (const e of planned) {
      const a = kindOf.get(e.from_id);
      const b = kindOf.get(e.to_id);
      if (a !== undefined) touched.add(a);
      if (b !== undefined) touched.add(b);
    }
    for (const k of [...touched].sort()) {
      noteKind(state.relation, scope, k);
    }
  }
}

/** decay（Decay=Forget 数值机制）：Active 超 90 天 → Dormant；Active/Dormant 超 365 天 → Frozen */
async function decayStep(
  b: SqliteMemoryBackend,
  state: RunState,
  work: Memory[],
  scope: Scope,
  now: number,
  signal?: AbortSignal,
): Promise<void> {
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
    assertNotAborted(signal, `decay/${scope}`);
    await b.update(m.id, { lifecycle: next });
    m.lifecycle = next;
    bumpCount(state.decay, scope, 1);
    noteKind(state.decay, scope, m.kind);
  }
}

// ---- 内部工具 ----

/** 冻结一条记忆（Frozen）并同步内存副本；Frozen 不删（P8 可逆：保谱系，可经 Promote 恢复） */
async function freeze(b: SqliteMemoryBackend, track: StepTrack, scope: Scope, m: Memory): Promise<void> {
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
 * 空闲期记忆整合批处理（§7.2）：dedup/merge/relation/decay **按 scope 分事务**执行
 * （中断/失败只回滚当前 scope → 幂等重跑收敛）；经 opts.scheduler.enqueue({id:'memory-consolidation', run}) 入队执行。
 *
 * 预算与中断（已知问题《记忆整合没有真实批次上限》/《12 个维护任务里只有 1 个真正可被中断》）：
 * `opts.budget.maxMemoriesPerRun` 限制单次读取/处理的记忆条数（缺省 2000），`budget.scopeOffset`
 * 决定本次从哪个 scope 起（轮转，避免库大时后面的 scope 永远轮不到），`budget.signal` 在每个处理
 * 单元之间被检查（abort → AbortError → 当前 scope 回滚 → 任务留队可重试）。
 *
 * **事务边界（2026-09 修订，取代原"单次原子"取向）**：原实现把三个 scope 包在一个事务里，
 * 追求"整次全或无"。但单个事务跨度越长，写锁与 WAL 的持有时间越长（同进程其它写入只会撞
 * busy_timeout，进程被杀则留超长 WAL），而这个跨越本身**不带来语义收益**——各步只处理前态记忆、
 * 重跑收敛一致，部分完成同样是合法状态。故改为**每个 scope 一个事务**：
 *   - scope 内部仍然原子（不会出现"半个 merge"）；
 *   - scope 之间提交并让出事件循环（锁不跨段持有）；
 *   - 代价（诚实）：跨 scope 的"全或无"不再成立——先前 scope 的改动会在后续 scope 失败时保留。
 *     失败**如实登记**在 `outcome.failed_scopes` 并停止推进（同一故障大概率在后续 scope 复现），
 *     调用方因此能区分"什么都没做"与"做了前几个 scope 后失败"，而不是误读成全无。
 *
 * 返回值：**报告 = "改了什么"**（四个稳定计数 + 受影响作用域/影响域记录）——不掺入"跑了多少"
 * 那类元数据（严格相等断言的外部消费方不受影响）；有界执行的元数据经 `opts.onOutcome` 单独给出
 *（**保证**：只要 runConsolidation 产出了结论就回调，含"部分 scope 失败"的情形）。
 */
export async function consolidate(
  backend: SqliteMemoryBackend,
  opts: {
    now?: number;
    scheduler?: MaintenanceScheduler;
    budget?: ConsolidationBudget;
    /** 有界执行元数据回调（调用方据此推进轮转并观测"本次跑了多少"；可选） */
    onOutcome?: (outcome: ConsolidationOutcome) => void;
  } = {},
): Promise<ConsolidationReport> {
  const now = opts.now ?? Date.now();
  let report: ConsolidationReport | null = null;
  let outcome: ConsolidationOutcome | null = null;
  const run = async (): Promise<void> => {
    outcome = await runConsolidation(backend, now, opts.budget ?? {});
    report = outcome.report;
  };
  if (opts.scheduler) {
    await opts.scheduler.enqueue({ id: CONSOLIDATION_TASK_ID, run });
  } else {
    await run();
  }
  if (outcome !== null) {
    opts.onOutcome?.(outcome);
  }
  return report ?? emptyReport();
}

/** 整合结果（runConsolidation 产物）：报告（"改了什么"）+ 有界执行元数据（"跑了多少"）+ 轮转状态。
 *  分开返回的理由：报告的四个计数是稳定契约（既有消费方做严格比较），元数据属于调用方观测面。 */
export interface ConsolidationOutcome {
  report: ConsolidationReport;
  /** 本次读取/处理的记忆条数（"整条载入"的那部分——批预算约束的对象） */
  processed: number;
  /** 本次是否因预算耗尽提前结束（true → 下次量子/收尾继续处理剩余部分） */
  budget_exhausted: boolean;
  /** 下次调用的 scope 轮转起点（调用方据此推进，避免后续 scope 饥饿） */
  next_scope_offset: number;
  /** 本次是否有真实改动（供调用方判断"还要不要再跑一次"——收敛判据） */
  dirty: boolean;
  /**
   * 本次失败的 scope（`"<scope>（<原因>）"`；空/缺省 = 全部成功）。
   *
   * 为什么必须有这个字段：事务改为**按 scope 切分**后，"整次全或无"不再成立——某一 scope 失败时
   * 先前 scope 的改动**已经提交**。调用方（与状态面）必须能区分"什么都没做"与"做了前几个 scope 后失败"，
   * 否则会把部分完成误读成全无，进而做出错误的重试/收敛判断。
   */
  failed_scopes?: string[];
}

async function runConsolidation(
  b: SqliteMemoryBackend,
  now: number,
  budget: ConsolidationBudget,
): Promise<ConsolidationOutcome> {
  const state = emptyState();
  const limit =
    budget.maxMemoriesPerRun !== undefined && Number.isFinite(budget.maxMemoriesPerRun)
      ? Math.max(0, Math.floor(budget.maxMemoriesPerRun))
      : DEFAULT_CONSOLIDATION_BUDGET;
  const offset = ((budget.scopeOffset ?? 0) % SCOPES.length + SCOPES.length) % SCOPES.length;
  const order = [...SCOPES.slice(offset), ...SCOPES.slice(0, offset)];
  // 轮转（每次调用把起点推进一步）：库大时后续 scope 不会因预算耗尽永远轮不到
  state.nextScopeOffset = (offset + 1) % SCOPES.length;
  const failedScopes: string[] = [];
  for (const scope of order) {
    assertNotAborted(budget.signal, 'scope');
    if (state.processed >= limit) {
      state.budgetExhausted = true;
      break; // 预算耗尽 → 本次到此（单次调用有界；下次调用接着处理）
    }
    // ---- 每个 scope 一个事务（审查修复：此前三 scope 共用一个事务）----
    // 为什么按 scope 切分（取向下修订，见文件头"事务边界"说明）：单个事务跨度越长，
    // 写锁与 WAL 的持有时间越长——同进程其它写入者只会撞 busy_timeout，而进程被杀会留下超长 WAL。
    // 切分后每个事务只覆盖一个 scope 的处理单元，**scope 内部仍然原子**（不会出现"半个 merge"）。
    // 代价（诚实）：跨 scope 的"整次全或无"不再成立——某一 scope 失败时，先前 scope 的改动已提交。
    // 这是可接受的，因为各步只处理前态记忆、重跑收敛一致（本文件既有不变量），部分完成仍是合法状态；
    // 且失败会被如实记进 outcome.failed_scopes，调用方据此推进而不是误以为"什么都没发生"。
    try {
      await b.transaction(async () => {
        // ---- ① dedup（有界读取：只读键列，成本正比于"轻量键行数"而非完整记录体积）----
        // 收敛性要求：跨调用的重复必须能被发现，故 dedup **不占用批预算**——
        // 它的内存驻留已被键列投影压到很低（不读 body、不解析 JSON），冻结动作只发生在确认重复的
        // 条目上（代价正比于重复数，不是全库数）。批预算约束的是下文"必须整条载入"的
        // merge / relation / decay（那才是内存与平方级代价的来源）。
        const frozen = await dedupStep(b, state, scope, budget.signal);
        if (frozen > 0) {
          state.dirty = true;
        }
        // ---- ② merge / relation / decay（单次事务**有界**：只处理本次额度内的记忆）----
        // merge 必须拿到一批记忆做包含关系比对——旧实现全表读取（`limit: 1_000_000`）。
        // 现在只读本次额度内的一批（超出部分留给下一次调用；scope 轮转 + 冻结收敛保证推进）。
        const remaining = Math.max(1, limit - state.processed);
        const page = await b.query({
          scope,
          limit: Math.min(remaining, MAX_QUERY_LIMIT),
          budget: Number.MAX_SAFE_INTEGER,
        });
        const work = page.items.map((m) => ({ ...m }));
        state.processed += work.length;
        await mergeStep(b, state, work, scope, now, budget.signal);
        await relationStep(b, state, work, scope, now, budget.signal);
        await decayStep(b, state, work, scope, now, budget.signal);
      });
    } catch (err) {
      // 中断不是失败：让 AbortError 继续冒泡（调度器据此留队可重试，语义不变）
      if (err instanceof Error && err.name === 'AbortError') throw err;
      // 真失败：本 scope 已回滚（事务原子），先前 scope 的改动保留 → 如实登记并**停止推进**
      //（同一故障很可能在后续 scope 复现，继续跑只是把同一个错误写三遍）
      failedScopes.push(`${scope}（${err instanceof Error ? err.message : String(err)}）`);
      break;
    }
    // 让出事件循环：三个 scope 之间给宿主一个调度窗口（每段事务已各自提交，锁不跨段持有）
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (state.processed >= limit) {
      state.budgetExhausted = true;
      break;
    }
  }
  const report = buildReport(state);
  return {
    report,
    processed: state.processed,
    budget_exhausted: state.budgetExhausted === true,
    next_scope_offset: state.nextScopeOffset ?? 0,
    dirty:
      state.dirty ||
      report.deduped > 0 ||
      report.merged > 0 ||
      report.related > 0 ||
      report.decayed > 0,
    ...(failedScopes.length > 0 ? { failed_scopes: failedScopes } : {}),
  };
}

function emptyReport(): ConsolidationReport {
  return { deduped: 0, merged: 0, related: 0, decayed: 0, affected_scopes: [], impact: [] };
}
