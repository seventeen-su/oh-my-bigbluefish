// OMB v2 记忆策略面（T3.3 前置拆分，自 staging.ts 迁出）：常量表（TTL/priority/来源信任序/
// 稳定门槛，初始值标注待标定 §17）与纯函数（规范化/内容哈希/Event→Memory 候选提取/构建）。
// 本模块无 DB 副作用、无 import 时 I/O——供 staging.ts（准入）与 consolidate.ts（dedup/merge
// 复用同一 contentHash 语义）共享；staging.ts 再导出公共常量保持既有调用方兼容。
// layer 2（memory/）：仅 node: 内置 + kernel/schemas/（同层契约）。
import { createHash } from 'node:crypto';
import { makeMutableId, ScopeEnum, type Scope } from '../kernel/schemas/base.js';
import {
  MemoryKindEnum,
  MemoryLifecycleEnum,
  MemoryProvClassEnum,
  type MemoryKind,
  type MemoryLifecycle,
  type MemoryProvClass,
  type Event,
  type Memory,
} from '../kernel/schemas/m.js';

// ---- 初始常量表（待标定，§17） ----

/** 默认 TTL（stage 未指定 ttlMs 时）：7 天 */
export const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 事件类型 → 默认 priority（初始映射：session/* 低、contradiction/found 高） */
export const DEFAULT_PRIORITY_BY_TYPE: Record<string, number> = {
  'session/start': 1,
  'session/end': 1,
  'tool/call': 2,
  'tool/result': 3,
  'claim/update': 5,
  'hypothesis/transition': 6,
  'decision/made': 7,
  'contradiction/found': 9,
  'observation/contradictory': 9,
  'memory/admitted': 4,
  'memory/consolidated': 4,
  'checkpoint/saved': 2,
  'activation/committed': 5,
  'maintenance/quantum': 1,
};

/** 类型映射未命中（通配段等）时的默认 priority */
export const DEFAULT_PRIORITY = 3;

/** 来源最低要求默认值（最低档，默认不拦截；待标定） */
export const DEFAULT_MIN_PROV_CLASS: MemoryProvClass = 'Model-inferred';

/** prov_class 信任序（stage 来源最低要求比较；值越大越可信；待标定） */
export const PROV_CLASS_TRUST: Record<MemoryProvClass, number> = {
  'Model-inferred': 0,
  'System-derived': 1,
  'Tool-derived': 2,
  'Observation': 3,
  'User-declared': 4,
  'Externally-attested': 5,
};

/** admission 稳定门槛：prov_class → 所需最低 priority（Observation/User-declared/Externally-attested 直接过；待标定） */
export const STABILITY_MIN_PRIORITY: Record<MemoryProvClass, number> = {
  Observation: 0,
  'User-declared': 0,
  'Externally-attested': 0,
  'Tool-derived': 1,
  'System-derived': 2,
  'Model-inferred': 5,
};

/** provenance.source → prov_class 映射（stage/admit 的来源最低要求与稳定判定共用） */
export const SOURCE_TO_PROV_CLASS: Record<string, MemoryProvClass> = {
  user: 'User-declared',
  observation: 'Observation',
  tool: 'Tool-derived',
  model: 'Model-inferred',
  external: 'Externally-attested',
  system: 'System-derived',
};

// ---- 纯函数 ----

/** 规范化文本：trim + 折叠连续空白（新信息判定，§7.2 简化：规范化哈希相同即视为重复） */
export function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

/** scope+kind+规范化文本 → sha256（重复/新信息判定键；dedup/merge 与 admit 共用同一语义） */
export function contentHash(scope: Scope, kind: MemoryKind, payload: string): string {
  return createHash('sha256').update(`${scope}\u0000${kind}\u0000${normalizeText(payload)}`, 'utf8').digest('hex');
}

export function parseScope(v: unknown): Scope | null {
  if (typeof v !== 'string') return null;
  const p = ScopeEnum.safeParse(v);
  return p.success ? p.data : null;
}

export function parseKind(v: unknown): MemoryKind | null {
  if (typeof v !== 'string') return null;
  const p = MemoryKindEnum.safeParse(v);
  return p.success ? p.data : null;
}

export function parseLifecycle(v: unknown): MemoryLifecycle | null {
  if (typeof v !== 'string') return null;
  const p = MemoryLifecycleEnum.safeParse(v);
  return p.success ? p.data : null;
}

export function parseProvClass(v: unknown): MemoryProvClass | null {
  if (typeof v !== 'string') return null;
  const p = MemoryProvClassEnum.safeParse(v);
  return p.success ? p.data : null;
}

/** stage 门槛用 prov_class（宽容：声明合法 → 用之；否则 source 映射 → Model-inferred） */
export function stageProvClass(event: Event): MemoryProvClass {
  const mem = (event.payload as { memory?: { prov_class?: unknown } }).memory;
  const declared = typeof mem === 'object' && mem !== null ? parseProvClass(mem.prov_class) : null;
  if (declared) return declared;
  return SOURCE_TO_PROV_CLASS[event.provenance.source] ?? 'Model-inferred';
}

/** Event → Memory 候选（payload.memory 提取后的定型结构；Event→Memory 映射契约见 CONVENTIONS） */
export interface MemoryCandidate {
  scope: Scope;
  kind: MemoryKind;
  lifecycle: MemoryLifecycle;
  prov_class: MemoryProvClass;
  payload: string;
  value_score: number;
  utility_counts: Record<string, number>;
  belief_ref?: string;
  lineage_ref?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** payload.memory 提取；缺失/内容空/显式声明非法 → null（admit 拒绝 invalid） */
export function memoryCandidate(event: Event): MemoryCandidate | null {
  const raw = (event.payload as { memory?: unknown }).memory;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.payload !== 'string' || m.payload.trim().length === 0) return null;
  const scope = m.scope === undefined ? (event.scope ?? 'Project') : parseScope(m.scope);
  if (!scope) return null;
  const kind = m.kind === undefined ? 'Semantic' : parseKind(m.kind);
  if (!kind) return null;
  const lifecycle = m.lifecycle === undefined ? 'Active' : parseLifecycle(m.lifecycle);
  if (!lifecycle) return null;
  const provClass = m.prov_class === undefined
    ? (SOURCE_TO_PROV_CLASS[event.provenance.source] ?? 'Model-inferred')
    : parseProvClass(m.prov_class);
  if (!provClass) return null;
  return {
    scope,
    kind,
    lifecycle,
    prov_class: provClass,
    payload: m.payload as string,
    value_score: typeof m.value_score === 'number' ? (m.value_score as number) : 0.5,
    utility_counts: isRecord(m.utility_counts)
      ? (m.utility_counts as Record<string, number>)
      : { retrieval: 0, hit: 0, miss: 0, inject: 0, decay: 0, promote: 0 }, // 记忆级默认 = T3.4 定型六反馈键全 0
    belief_ref: typeof m.belief_ref === 'string' ? (m.belief_ref as string) : undefined,
    lineage_ref: typeof m.lineage_ref === 'string' ? (m.lineage_ref as string) : undefined,
  };
}

/** Event → Memory（候选 + event.provenance 直接复用，provenance.event 即幂等键） */
export function buildMemory(event: Event, cand: MemoryCandidate): Memory {
  const ts = Number.isNaN(Date.parse(event.timestamp)) ? new Date().toISOString() : event.timestamp;
  return {
    ir_version: '2.0',
    id: makeMutableId('memory'),
    schema: 'omb/M1',
    scope: cand.scope,
    lifecycle: cand.lifecycle,
    immutable: false,
    owner: 'kernel',
    created: ts,
    updated: ts,
    provenance: event.provenance,
    refs: [],
    kind: cand.kind,
    prov_class: cand.prov_class,
    payload: cand.payload,
    value_score: cand.value_score,
    utility_counts: cand.utility_counts,
    ...(cand.belief_ref ? { belief_ref: cand.belief_ref } : {}),
    ...(cand.lineage_ref ? { lineage_ref: cand.lineage_ref } : {}),
  };
}
