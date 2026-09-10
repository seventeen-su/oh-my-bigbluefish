// layer 2（memory/）：记忆写入面与管理面（已知问题《缺少写入面与记忆管理面》/《记忆类型空转、生命周期
// 不流转、作用域失衡》修复判定）。
//
// 写入流水（与 known-issues 思维导图 ② 一致）：**去重检查 → 污染标记 → 落库 → 同步编码**；
// 管理面（⑥）：列出 / 查看 / 编辑 / 删除 / 合并 / 手动改生命周期。
//
// 设计边界：
//   - 记忆对象（M1）本身不可变（immutable:false 指可变对象，id 为内容无关的 mutable id）；
//     写入面只生成**合规** M1 对象（schema 校验由 backend.ingest 兜底 fail-loud），不绕过校验；
//   - 去重按「同 scope + 同 kind + 同 payload」判定（内容级近重复由整合链的 similarity 合并处理，
//     见 consolidate.ts）——命中 → 返回既有 id 并标注 deduplicated（不产生重复行）；
//   - 污染标记：写入方显式声明污染（如来源不可信）→ lifecycle='Suspicious'（检索侧按 pollution 扣权）；
//   - 同步编码：落库后立即 `encodeOne`（向量通道即时可用），失败不阻塞写入（诚实降级，
//     缺口由空闲期 memory_vector_encode 任务补齐）。
import { makeMutableId } from '../kernel/schemas/base.js';
import type { Memory, MemoryKind, MemoryLifecycle, MemoryProvClass } from '../kernel/schemas/m.js';
import type { Scope } from '../kernel/schemas/base.js';
import type { RetrievalBackend } from './backend-retrieval.js';

/** 合法的记忆类型/生命周期/作用域/来源类别（写入面白名单——非法值 fail-loud，不静默纠正） */
export const WRITABLE_KINDS: readonly MemoryKind[] = [
  'Episodic',
  'Semantic',
  'Procedural',
  'Profile',
  'Constraint',
  'Decision',
];
export const WRITABLE_LIFECYCLES: readonly MemoryLifecycle[] = [
  'Active',
  'Dormant',
  'Suspicious',
  'Frozen',
  'Retired',
];
export const WRITABLE_SCOPES: readonly Scope[] = ['Session', 'Project', 'Global'];
export const WRITABLE_PROV_CLASSES: readonly MemoryProvClass[] = [
  'User-declared',
  'Externally-attested',
  'Observation',
  'Tool-derived',
  'System-derived',
  'Model-inferred',
];

/** 写入输入（管理面工具/装配面共用） */
export interface MemoryWriteInput {
  /** 正文（非空；写入面不做内容改写） */
  text: string;
  kind?: MemoryKind;
  scope?: Scope;
  lifecycle?: MemoryLifecycle;
  prov_class?: MemoryProvClass;
  /** 来源标记（写入来源审计；缺省 'manual-write'） */
  source?: string;
  /** 污染标记（true → lifecycle 强制 Suspicious；检索侧按 pollution 扣权） */
  polluted?: boolean;
  /** 标签（写入 refs 之外的检索辅助；当前落到 payload 前缀，保留结构化扩展位） */
  tags?: string[];
}

/** 写入结果 */
export interface MemoryWriteResult {
  ok: boolean;
  id: string | null;
  /** true = 命中同 scope+kind+payload 的既有记录（未新增行） */
  deduplicated: boolean;
  /** 是否已同步编码（写入流水末段；false = 待空闲期补齐） */
  encoded: boolean;
  degraded: string | null;
}

/** 列表/查看输入 */
export interface MemoryListInput {
  scope?: Scope;
  kind?: MemoryKind;
  lifecycle?: MemoryLifecycle;
  /** 文本过滤（词法口径：FTS 检索；缺省 → 按 updated 降序） */
  text?: string;
  limit?: number;
}

/** 管理面条目（列表/查看用；正文按需截断——工具面输出控制） */
export interface MemoryManageEntry {
  id: string;
  kind: string;
  scope: string;
  lifecycle: string;
  prov_class: string;
  updated: string;
  payload: string;
}

/** 默认写入作用域（已知问题《记忆类型空转、生命周期不流转、作用域失衡》：Project 为缺省——
 *  既不是"会话内瞬态"也不是"跨项目污染"，与整合链的 scope 判定一致） */
export const DEFAULT_WRITE_SCOPE: Scope = 'Project';
/** 默认写入类型（Semantic = 事实性知识；情景类由收尾自动产生，无需人工默认） */
export const DEFAULT_WRITE_KIND: MemoryKind = 'Semantic';
/** 列表默认条数 */
export const DEFAULT_LIST_LIMIT = 20;
/** 列表正文截断长度（工具面输出控制；完整内容用 view） */
export const LIST_PAYLOAD_LIMIT = 200;

/** 校验写入输入（非法 → 抛错；写入面 fail-loud，不静默纠正用户输入） */
function validateWriteInput(input: MemoryWriteInput): Required<Pick<MemoryWriteInput, 'text' | 'kind' | 'scope' | 'lifecycle' | 'prov_class' | 'source'>> {
  const text = typeof input.text === 'string' ? input.text.trim() : '';
  if (text.length === 0) {
    throw new Error('memory write: text 不能为空');
  }
  const kind = input.kind ?? DEFAULT_WRITE_KIND;
  if (!WRITABLE_KINDS.includes(kind)) {
    throw new Error(`memory write: 非法 kind "${String(kind)}"（合法值：${WRITABLE_KINDS.join(' | ')}）`);
  }
  const scope = input.scope ?? DEFAULT_WRITE_SCOPE;
  if (!WRITABLE_SCOPES.includes(scope)) {
    throw new Error(`memory write: 非法 scope "${String(scope)}"（合法值：${WRITABLE_SCOPES.join(' | ')}）`);
  }
  // 污染标记优先于显式 lifecycle（写入方声明"不可信"时应压过其它设定）
  const lifecycle: MemoryLifecycle = input.polluted === true ? 'Suspicious' : (input.lifecycle ?? 'Active');
  if (!WRITABLE_LIFECYCLES.includes(lifecycle)) {
    throw new Error(`memory write: 非法 lifecycle "${String(lifecycle)}"（合法值：${WRITABLE_LIFECYCLES.join(' | ')}）`);
  }
  const prov_class = input.prov_class ?? 'User-declared';
  if (!WRITABLE_PROV_CLASSES.includes(prov_class)) {
    throw new Error(`memory write: 非法 prov_class "${String(prov_class)}"（合法值：${WRITABLE_PROV_CLASSES.join(' | ')}）`);
  }
  const source = typeof input.source === 'string' && input.source.length > 0 ? input.source : 'manual-write';
  return { text, kind, scope, lifecycle, prov_class, source };
}

/**
 * 写入一条记忆（写入流水：去重检查 → 污染标记 → 落库 → 同步编码）。
 * - 去重：同 scope + kind + payload 已存在 → 返回既有 id（deduplicated=true，不新增行）；
 * - 时间戳：created/updated 取写入时刻（ISO）；provenance.event 唯一（幂等键）；
 * - 编码：`encodeOne` 同步编码；异常 → encoded=false + degraded 说明（不阻塞写入）。
 */
export async function writeMemory(
  backend: RetrievalBackend,
  input: MemoryWriteInput,
): Promise<MemoryWriteResult> {
  let v: ReturnType<typeof validateWriteInput>;
  try {
    v = validateWriteInput(input);
  } catch (err) {
    return { ok: false, id: null, deduplicated: false, encoded: false, degraded: (err as Error).message };
  }
  const now = new Date().toISOString();
  // ① 去重检查（同 scope + kind + payload）
  const existing = await backend.query({ scope: v.scope, kind: v.kind, limit: 200, budget: 1000 });
  const dup = existing.items.find((m) => m.payload === v.text);
  if (dup !== undefined) {
    return { ok: true, id: dup.id, deduplicated: true, encoded: false, degraded: null };
  }
  // ② 污染标记 + ③ 落库
  const memory = {
    ir_version: '2.0',
    id: makeMutableId('memory'),
    schema: 'omb/M1',
    scope: v.scope,
    kind: v.kind,
    lifecycle: v.lifecycle,
    prov_class: v.prov_class,
    immutable: false,
    owner: 'user',
    created: now,
    updated: now,
    provenance: {
      source: v.source,
      event: makeMutableId('evt'),
      actor: 'memory-write',
      environment: { os: process.platform, node: process.version, dsh_version: 'unknown', project: 'omb-v2' },
      runtime_snapshot: 'rs:memory-write',
      timestamp: now,
      transformation_chain: ['memory/manage:write'],
      verification: 'schema',
    },
    refs: [],
    payload: v.text,
    value_score: 0.5,
    utility_counts: {},
  } as unknown as Memory;
  const id = await backend.ingest(memory);
  // ④ 同步编码（向量通道即时可用；失败降级不阻塞写入——缺口由空闲期任务补齐）
  let encoded = false;
  let degraded: string | null = null;
  try {
    encoded = backend.encodeOne(id);
  } catch (err) {
    degraded = `写入成功但同步编码失败（${(err as Error).message}）——待空闲期 memory_vector_encode 补齐`;
  }
  return { ok: true, id, deduplicated: false, encoded, degraded };
}

/** 列出记忆（管理面：scope/kind/lifecycle 过滤 + 文本过滤 + 条数上限；正文截断） */
export async function listMemories(
  backend: RetrievalBackend,
  input: MemoryListInput = {},
): Promise<{ ok: boolean; items: MemoryManageEntry[]; total: number; degraded: string | null }> {
  const limit = Math.max(1, Math.floor(input.limit ?? DEFAULT_LIST_LIMIT));
  try {
    const page = await backend.query({
      scope: input.scope ?? DEFAULT_WRITE_SCOPE,
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...(input.lifecycle !== undefined ? { lifecycle: input.lifecycle } : {}),
      ...(input.text !== undefined && input.text.trim().length > 0 ? { text: input.text } : {}),
      limit,
      budget: 1000,
    });
    return {
      ok: true,
      items: page.items.map((m) => ({
        id: m.id,
        kind: m.kind,
        scope: m.scope,
        lifecycle: m.lifecycle,
        prov_class: m.prov_class,
        updated: m.updated,
        payload: m.payload.length <= LIST_PAYLOAD_LIMIT ? m.payload : `${m.payload.slice(0, LIST_PAYLOAD_LIMIT)}…`,
      })),
      total: page.total ?? page.items.length,
      degraded: null,
    };
  } catch (err) {
    return { ok: false, items: [], total: 0, degraded: (err as Error).message };
  }
}

/** 查看单条记忆（完整正文；未知 id → ok:false + degraded 说明，不抛） */
export async function viewMemory(
  backend: RetrievalBackend,
  id: string,
): Promise<{ ok: boolean; item: MemoryManageEntry | null; degraded: string | null }> {
  const m = await backend.getById(id);
  if (m === undefined) {
    return { ok: false, item: null, degraded: `记忆不存在: ${id}` };
  }
  return {
    ok: true,
    item: {
      id: m.id,
      kind: m.kind,
      scope: m.scope,
      lifecycle: m.lifecycle,
      prov_class: m.prov_class,
      updated: m.updated,
      payload: m.payload,
    },
    degraded: null,
  };
}

/** 编辑记忆（payload / lifecycle / kind / scope 白名单字段；backend.update 兜底校验） */
export async function editMemory(
  backend: RetrievalBackend,
  id: string,
  patch: { text?: string; lifecycle?: MemoryLifecycle; kind?: MemoryKind; scope?: Scope },
): Promise<{ ok: boolean; id: string; encoded: boolean; degraded: string | null }> {
  const clean: Record<string, unknown> = {};
  if (patch.text !== undefined) {
    if (patch.text.trim().length === 0) {
      return { ok: false, id, encoded: false, degraded: '编辑失败：text 不能为空' };
    }
    clean.payload = patch.text;
  }
  if (patch.lifecycle !== undefined) {
    if (!WRITABLE_LIFECYCLES.includes(patch.lifecycle)) {
      return { ok: false, id, encoded: false, degraded: `编辑失败：非法 lifecycle "${String(patch.lifecycle)}"` };
    }
    clean.lifecycle = patch.lifecycle;
  }
  if (patch.kind !== undefined) {
    if (!WRITABLE_KINDS.includes(patch.kind)) {
      return { ok: false, id, encoded: false, degraded: `编辑失败：非法 kind "${String(patch.kind)}"` };
    }
    clean.kind = patch.kind;
  }
  if (patch.scope !== undefined) {
    if (!WRITABLE_SCOPES.includes(patch.scope)) {
      return { ok: false, id, encoded: false, degraded: `编辑失败：非法 scope "${String(patch.scope)}"` };
    }
    clean.scope = patch.scope;
  }
  if (Object.keys(clean).length === 0) {
    return { ok: false, id, encoded: false, degraded: '编辑失败：未提供任何可更新字段' };
  }
  try {
    await backend.update(id, clean as Partial<Memory>);
  } catch (err) {
    return { ok: false, id, encoded: false, degraded: `编辑失败：${(err as Error).message}` };
  }
  // payload 变化 → 向量清空；此处同步补齐（失败降级不阻塞编辑结果）
  let encoded = false;
  if (clean.payload !== undefined) {
    try {
      encoded = backend.encodeOne(id);
    } catch {
      encoded = false;
    }
  }
  return { ok: true, id, encoded, degraded: null };
}

/** 删除记忆（级联清关系与统计，backend.delete 语义；未知 id → ok:false） */
export async function deleteMemory(
  backend: RetrievalBackend,
  id: string,
): Promise<{ ok: boolean; degraded: string | null }> {
  try {
    await backend.delete(id);
    return { ok: true, degraded: null };
  } catch (err) {
    return { ok: false, degraded: `删除失败：${(err as Error).message}` };
  }
}

/**
 * 合并两条记忆（管理面「合并」）：source 正文并入 target（去重后换行拼接）→ 顺序保留 source 的入边 →
 * 删除 source。语义：target 是保留者（id/kind/scope/lifecycle 不变），source 的内容与关系被吸收。
 * 任一 id 不存在 → ok:false（不产生半成品：先取两条 → 校验 → 更新 target → 迁移边 → 删 source）。
 */
export async function mergeMemories(
  backend: RetrievalBackend,
  sourceId: string,
  targetId: string,
): Promise<{ ok: boolean; target_id: string; merged_text: boolean; degraded: string | null }> {
  if (sourceId === targetId) {
    return { ok: false, target_id: targetId, merged_text: false, degraded: '合并失败：source 与 target 相同' };
  }
  const source = await backend.getById(sourceId);
  const target = await backend.getById(targetId);
  if (source === undefined || target === undefined) {
    return {
      ok: false,
      target_id: targetId,
      merged_text: false,
      degraded: `合并失败：${source === undefined ? `source 不存在 (${sourceId})` : `target 不存在 (${targetId})`}`,
    };
  }
  const mergedText = target.payload.includes(source.payload)
    ? target.payload
    : `${target.payload}\n${source.payload}`;
  try {
    if (mergedText !== target.payload) {
      await backend.update(targetId, { payload: mergedText });
      backend.encodeOne(targetId);
    }
    // 关系迁移：source 的入边改指 target（保留"谁指向这条知识"的结构信息）。
    // 入边查询走 memory_relation 的 to_id 索引（relationTraverse 是出边 BFS，取不到入边）。
    const inbound = backend.inboundRelationIds(sourceId);
    for (const edge of inbound) {
      try {
        await backend.link(edge.from_id, targetId, edge.type);
      } catch {
        // 重复边（UNIQUE 冲突）→ 跳过（目标语义已满足：入边指向保留者）
      }
    }
    await backend.delete(sourceId);
  } catch (err) {
    return { ok: false, target_id: targetId, merged_text: false, degraded: `合并失败：${(err as Error).message}` };
  }
  return { ok: true, target_id: targetId, merged_text: mergedText !== target.payload, degraded: null };
}
