// 记忆写入面与管理面行为测试（对应《缺少写入面与记忆管理面》/
// 《记忆类型空转、生命周期不流转、作用域失衡》修复判定）：
//   ① 写入流水：去重检查 → 污染标记 → 落库 → 同步编码（四段齐备）
//   ② 类型/生命周期/作用域不再空转：六类型可写、五生命周期可改、三作用域可控（白名单 fail-loud）
//   ③ 管理面：列出 / 查看 / 编辑 / 删除 / 合并（含关系迁移）
//   ④ 工具面：kern_memory 统一入口（op 缺省 retrieve 行为不变；write/list/view/edit/delete/merge）
//   ⑤ 装配面：manageMemory 委托 + 状态面可读
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Memory } from '../../kernel/schemas/m.js';
import { makeMutableId } from '../../kernel/schemas/base.js';
import { RetrievalBackend } from '../../memory/backend-retrieval.js';
import {
  WRITABLE_KINDS,
  WRITABLE_LIFECYCLES,
  WRITABLE_SCOPES,
  deleteMemory,
  editMemory,
  listMemories,
  mergeMemories,
  viewMemory,
  writeMemory,
} from '../../memory/manage.js';
import { createCognitiveRuntime, type CognitiveRuntime } from '../../runtime/assembly.js';
import { kernMemoryTool } from '../../runtime/kern-tools.js';
import { PROV, TS } from '../m1/ir-samples.js';

const dbPaths: string[] = [];
const backends: RetrievalBackend[] = [];
const bases: string[] = [];
const runtimes: CognitiveRuntime[] = [];

async function tmpDb(): Promise<string> {
  const db = join(await mkdtemp(join(tmpdir(), 'omb-manage-')), 'memory.db');
  dbPaths.push(db);
  return db;
}

function openBackend(dbPath: string): RetrievalBackend {
  const b = new RetrievalBackend(dbPath);
  backends.push(b);
  return b;
}

async function tmpRoot(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), 'omb-manage-asm-'));
  bases.push(base);
  return join(base, '.omb');
}

afterEach(async () => {
  for (const rt of runtimes.splice(0)) {
    await rt.close();
  }
  await Promise.all(backends.splice(0).map((b) => b.close()));
  await Promise.all(dbPaths.splice(0).map((p) => rm(join(p, '..'), { recursive: true, force: true })));
  await Promise.all(bases.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

function makeMemory(over: Record<string, unknown> = {}): Memory {
  return {
    ir_version: '2.0',
    id: makeMutableId('memory'),
    schema: 'omb/M1',
    scope: 'Project',
    lifecycle: 'Active',
    immutable: false,
    owner: 'kernel',
    created: TS,
    updated: TS,
    provenance: { ...PROV, event: makeMutableId('evt') },
    refs: [],
    kind: 'Semantic',
    prov_class: 'Observation',
    payload: '默认记忆内容',
    value_score: 0.5,
    utility_counts: { retrieval: 0, hit: 0, miss: 0, inject: 0, decay: 0, promote: 0 },
    ...over,
  } as unknown as Memory;
}

describe('① 写入流水（去重 → 污染标记 → 落库 → 同步编码）', () => {
  it('首次写入：落库 + 立即同步编码；重复写入同内容 → 命中既有 id（不新增行）', async () => {
    const b = openBackend(await tmpDb());
    const w1 = await writeMemory(b, { text: '项目使用 FTS5 做词法检索' });
    expect(w1).toMatchObject({ ok: true, deduplicated: false, encoded: true, degraded: null });
    expect(w1.id).not.toBeNull();
    expect(b.vectorStats()).toMatchObject({ encoded: 1, pending: 0 }); // 同步编码生效
    // 去重：同 scope + kind + payload → 返回既有 id
    const w2 = await writeMemory(b, { text: '项目使用 FTS5 做词法检索' });
    expect(w2).toMatchObject({ ok: true, deduplicated: true, id: w1.id });
    const listed = await listMemories(b, {});
    expect(listed.items).toHaveLength(1);
  });

  it('污染标记：polluted=true → lifecycle 强制 Suspicious（检索侧按 pollution 扣权）', async () => {
    const b = openBackend(await tmpDb());
    const r = await writeMemory(b, { text: '来源不可信的结论', polluted: true, lifecycle: 'Active' });
    expect(r.ok).toBe(true);
    const v = await viewMemory(b, r.id!);
    expect(v.item?.lifecycle).toBe('Suspicious');
  });

  it('非法输入 fail-loud（text 空 / 非法 kind / 非法 scope / 非法 lifecycle）', async () => {
    const b = openBackend(await tmpDb());
    expect((await writeMemory(b, { text: '   ' })).ok).toBe(false);
    expect((await writeMemory(b, { text: 'x', kind: 'Bogus' as never })).degraded).toContain('非法 kind');
    expect((await writeMemory(b, { text: 'x', scope: 'Galaxy' as never })).degraded).toContain('非法 scope');
    expect((await writeMemory(b, { text: 'x', lifecycle: 'Gone' as never })).degraded).toContain('非法 lifecycle');
  });
});

describe('② 类型/生命周期/作用域不再空转', () => {
  it('六种类型均可写入（不再只有 Episodic 一种在生产里出现）', async () => {
    const b = openBackend(await tmpDb());
    for (const [i, kind] of WRITABLE_KINDS.entries()) {
      const r = await writeMemory(b, { text: `类型样本 ${kind}`, kind });
      expect(r.ok).toBe(true);
      expect((await viewMemory(b, r.id!)).item?.kind).toBe(kind);
      void i;
    }
    const all = await listMemories(b, { limit: 20 });
    expect(new Set(all.items.map((m) => m.kind)).size).toBe(WRITABLE_KINDS.length);
  });

  it('五种生命周期均可设置（编辑面显式流转）', async () => {
    const b = openBackend(await tmpDb());
    const w = await writeMemory(b, { text: '生命周期流转样本' });
    for (const lifecycle of WRITABLE_LIFECYCLES) {
      const e = await editMemory(b, w.id!, { lifecycle });
      expect(e.ok).toBe(true);
      expect((await viewMemory(b, w.id!)).item?.lifecycle).toBe(lifecycle);
    }
  });

  it('三种作用域均可指定（写入面不再全部落 Project）', async () => {
    const b = openBackend(await tmpDb());
    for (const scope of WRITABLE_SCOPES) {
      const r = await writeMemory(b, { text: `作用域样本 ${scope}`, scope });
      expect(r.ok).toBe(true);
      expect((await viewMemory(b, r.id!)).item?.scope).toBe(scope);
    }
  });
});

describe('③ 管理面（列出/查看/编辑/删除/合并）', () => {
  it('列出：过滤 + 条数上限 + 正文截断', async () => {
    const b = openBackend(await tmpDb());
    await writeMemory(b, { text: '短内容' });
    await writeMemory(b, { text: '长内容'.repeat(200) });
    expect((await listMemories(b, { limit: 1 })).items).toHaveLength(1);
    const long = (await listMemories(b, {})).items.find((m) => m.payload.includes('长内容'));
    expect(long?.payload.endsWith('…')).toBe(true);
  });

  it('查看/编辑/删除：未知 id → ok:false + 明确说明（不抛）', async () => {
    const b = openBackend(await tmpDb());
    expect((await viewMemory(b, 'nope')).ok).toBe(false);
    expect((await editMemory(b, 'nope', { text: 'x' })).degraded).toContain('编辑失败');
    expect((await deleteMemory(b, 'nope')).degraded).toContain('删除失败');
  });

  it('编辑 payload → 同步重新编码（向量与内容保持一致）', async () => {
    const b = openBackend(await tmpDb());
    const w = await writeMemory(b, { text: '原始内容：词法检索' });
    const e = await editMemory(b, w.id!, { text: '改写内容：双通道检索' });
    expect(e).toMatchObject({ ok: true, encoded: true });
    const near = await b.vectorSearch('改写内容 双通道检索', { topK: 1 });
    expect(near[0]?.memory.id).toBe(w.id);
  });

  it('合并：source 正文并入 target、入边改指 target、source 删除', async () => {
    const b = openBackend(await tmpDb());
    const target = await writeMemory(b, { text: '合并目标：检索架构' });
    const source = await writeMemory(b, { text: '合并来源：融合排序细节' });
    const inbound = makeMemory({ payload: '指向来源的记忆' });
    await b.ingest(inbound);
    await b.link(inbound.id, source.id!, 'related');
    const r = await mergeMemories(b, source.id!, target.id!);
    expect(r).toMatchObject({ ok: true, target_id: target.id, merged_text: true });
    const merged = await viewMemory(b, target.id!);
    expect(merged.item?.payload).toContain('检索架构');
    expect(merged.item?.payload).toContain('融合排序细节');
    expect((await viewMemory(b, source.id!)).ok).toBe(false); // source 已删除
    expect(b.inboundRelationIds(target.id!)).toEqual([{ from_id: inbound.id, type: 'related' }]); // 入边迁移
  });

  it('合并同 id / 未知 id → ok:false（不产生半成品）', async () => {
    const b = openBackend(await tmpDb());
    const w = await writeMemory(b, { text: '自合并样本' });
    expect((await mergeMemories(b, w.id!, w.id!)).ok).toBe(false);
    expect((await mergeMemories(b, 'nope', w.id!)).degraded).toContain('source 不存在');
    expect((await mergeMemories(b, w.id!, 'nope')).degraded).toContain('target 不存在');
  });
});

describe('④ 工具面：kern_memory 统一入口（扩展而非新增工具）', () => {
  it('op 缺省 → 检索行为不变；op=write/list/view/edit/delete/merge → 管理面', async () => {
    const root = await tmpRoot();
    const rt = createCognitiveRuntime({ root });
    runtimes.push(rt);
    const tool = kernMemoryTool(rt);
    expect(tool.name).toBe('kern_memory');

    // write
    const w = (await tool.execute?.({ op: 'write', text: '工具写入的记忆：双通道检索' }, {})) as { ok: boolean; text: string };
    expect(w.ok).toBe(true);
    expect(w.text).toContain('已写入记忆');
    // 缺省 op（retrieve）：不带 op 亦可检索（向后兼容）
    const r = (await tool.execute?.({ query: '双通道检索' }, {})) as { ok: boolean; text: string };
    expect(r.ok).toBe(true);
    expect(r.text).toContain('记忆检索');
    expect(r.text).toContain('双通道检索');
    // list
    const l = (await tool.execute?.({ op: 'list' }, {})) as { ok: boolean; text: string };
    expect(l.ok).toBe(true);
    expect(l.text).toContain('记忆列表');
    // 重复写入 → 去重说明
    const dup = (await tool.execute?.({ op: 'write', text: '工具写入的记忆：双通道检索' }, {})) as { ok: boolean; text: string };
    expect(dup.text).toContain('未新增');
    // 参数类型非法 → 明确文本（不抛）
    const bad = (await tool.execute?.({ op: 'write', text: 42 }, {})) as { ok: boolean; text: string };
    expect(bad.ok).toBe(false);
    expect(bad.text).toContain('必须为字符串');
  });

  it('管理面数据源缺失 → 降级文本（不抛）', async () => {
    const tool = kernMemoryTool({});
    const r = (await tool.execute?.({ op: 'list' }, {})) as { ok: boolean; text: string };
    expect(r.ok).toBe(false);
    expect(r.text).toContain('manageMemory');
  });
});

describe('⑤ 装配面：manageMemory 委托', () => {
  it('write → list → view → edit → delete 全链经运行时可用；未装配时 op 非法 → 明确说明', async () => {
    const root = await tmpRoot();
    const rt = createCognitiveRuntime({ root });
    runtimes.push(rt);
    const w = await rt.manageMemory({ op: 'write', text: '装配面写入样本' });
    expect(w.ok).toBe(true);
    const l = await rt.manageMemory({ op: 'list' });
    expect(l.items.length).toBeGreaterThan(0);
    const v = await rt.manageMemory({ op: 'view', id: w.id! });
    expect(v.item?.payload).toBe('装配面写入样本');
    const e = await rt.manageMemory({ op: 'edit', id: w.id!, text: '装配面改写' });
    expect(e.ok).toBe(true);
    const d = await rt.manageMemory({ op: 'delete', id: w.id! });
    expect(d.ok).toBe(true);
    const bogus = await rt.manageMemory({ op: 'bogus' as never });
    expect(bogus.ok).toBe(false);
    expect(bogus.degraded).toContain('未知 op');
  });
});
