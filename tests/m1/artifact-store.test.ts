// T1.2 行为测试：Artifact Store（内容寻址，架构 §4.3 A1）。
// 覆盖：put/get 往返、内容寻址（同内容同 id）、索引（写盘 + 启动加载 + delete）、
// restore 范围读取（越界抛错）、压缩视图关联（compressed_views ↔ derived_from）、
// restore 幂等、缺 provenance 拒绝、非法 id 拒绝、同 id 重复 put（同内容 no-op / 异内容拒绝）。
// fixture：mkdtemp 临时 root（不动真实 workspace/.omb/artifacts/，CONVENTIONS §6）。
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Artifact } from '../../kernel/schemas/a.js';
import {
  computeContentId,
  deriveArtifact,
  deriveCompressedView,
  sameContent,
  type ArtifactInput,
} from '../../kernel/artifact.js';
import { ArtifactStore } from '../../supervisor/artifact-store.js';
import { PROV, UUID } from './ir-samples.js';

const roots: string[] = [];

async function tmpRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'omb-artifact-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

/** deriveArtifact 输入工厂（over 覆盖任意字段） */
function makeInput(over: Partial<ArtifactInput> = {}): ArtifactInput {
  return { type: 'text', content: 'hello world', scope: 'Project', provenance: PROV, ...over };
}

describe('put + get 往返', () => {
  it('put 后 get 返回相同内容与字段，payload.bin / meta.json 落盘', async () => {
    const root = await tmpRoot();
    const store = new ArtifactStore(root);
    const a = deriveArtifact(makeInput());
    await store.put(a);

    const got = await store.get(a.id);
    expect(got).not.toBeNull();
    expect(got).toEqual(a);
    expect(got!.hash).toBe(a.id.slice('sha256:'.length));

    // 落盘目录用 id 的 64hex 部分（Windows 目录名不允许 ':'，sha256: 前缀剥离）
    const dir = join(root, a.hash);
    expect(existsSync(join(dir, 'payload.bin'))).toBe(true);
    expect(existsSync(join(dir, 'meta.json'))).toBe(true);
    expect(readFileSync(join(dir, 'payload.bin'), 'utf8')).toBe(a.content);
  });

  it('get 不存在的 id 返回 null，has 返回 false', async () => {
    const store = new ArtifactStore(await tmpRoot());
    const a = deriveArtifact(makeInput());
    expect(await store.get(a.id)).toBeNull();
    expect(await store.has(a.id)).toBe(false);
  });
});

describe('内容寻址', () => {
  it('同内容两次 derive 同 id；异内容异 id；hash 与 id 语义一致', () => {
    const a1 = deriveArtifact(makeInput({ content: 'x' }));
    const a2 = deriveArtifact(makeInput({ content: 'x' }));
    const b = deriveArtifact(makeInput({ content: 'y' }));
    expect(a1.id).toBe(a2.id);
    expect(a1.id).not.toBe(b.id);
    expect(a1.id).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(a1.hash).toBe(a1.id.slice('sha256:'.length));
    expect(a1.immutable).toBe(true);
  });

  it('computeContentId 对 string 与 Uint8Array 输出一致', () => {
    const bytes = new TextEncoder().encode('x');
    expect(computeContentId('x')).toBe(computeContentId(bytes));
    expect(computeContentId('x')).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('sameContent 按 id 比较', () => {
    const a1 = deriveArtifact(makeInput({ content: 'same' }));
    const a2 = deriveArtifact(makeInput({ content: 'same' }));
    const b = deriveArtifact(makeInput({ content: 'other' }));
    expect(sameContent(a1, a2)).toBe(true);
    expect(sameContent(a1, b)).toBe(false);
  });
});

describe('索引', () => {
  it('put 多个 → index() 含全部（type/scope/size/created）；delete 后移除且幂等', async () => {
    const root = await tmpRoot();
    const store = new ArtifactStore(root);
    const a = deriveArtifact(makeInput({ content: 'aaa' }));
    const b = deriveArtifact(makeInput({ content: 'bb', type: 'summary' }));
    const c = deriveArtifact(makeInput({ content: 'c', scope: 'Global' }));
    await store.put(a);
    await store.put(b);
    await store.put(c);

    const idx = await store.index();
    expect(idx.size).toBe(3);
    expect(idx.get(a.id)).toEqual({ type: 'text', scope: 'Project', size: 3, created: a.created });
    expect(idx.get(b.id)).toEqual({ type: 'summary', scope: 'Project', size: 2, created: b.created });
    expect(idx.get(c.id)).toEqual({ type: 'text', scope: 'Global', size: 1, created: c.created });

    await store.delete(a.id);
    expect((await store.index()).has(a.id)).toBe(false);
    expect(await store.has(a.id)).toBe(false);
    await expect(store.delete(a.id)).resolves.toBeUndefined(); // 幂等
  });

  it('索引写盘 index.json，新 store 启动时加载', async () => {
    const root = await tmpRoot();
    const store = new ArtifactStore(root);
    const a = deriveArtifact(makeInput({ content: 'persisted' }));
    const b = deriveArtifact(makeInput({ content: 'also' }));
    await store.put(a);
    await store.put(b);
    expect(existsSync(join(root, 'index.json'))).toBe(true);

    const reloaded = new ArtifactStore(root);
    const idx = await reloaded.index();
    expect(idx.has(a.id)).toBe(true);
    expect(idx.has(b.id)).toBe(true);
  });
});

describe('restore 范围读取', () => {
  it('restore 无 range 返回全文；offset/length 正确切片', async () => {
    const store = new ArtifactStore(await tmpRoot());
    const a = deriveArtifact(makeInput({ content: 'hello world' }));
    await store.put(a);
    const text = (u: Uint8Array) => Buffer.from(u).toString('utf8');
    expect(text(await store.restore(a.id))).toBe('hello world');
    expect(text(await store.restore(a.id, { offset: 6 }))).toBe('world');
    expect(text(await store.restore(a.id, { offset: 0, length: 5 }))).toBe('hello');
    expect(text(await store.restore(a.id, { offset: 6, length: 5 }))).toBe('world');
  });

  it('restore 范围越界抛错', async () => {
    const store = new ArtifactStore(await tmpRoot());
    const a = deriveArtifact(makeInput({ content: 'hello world' }));
    await store.put(a);
    await expect(store.restore(a.id, { offset: 100 })).rejects.toThrow();
    await expect(store.restore(a.id, { offset: 0, length: 100 })).rejects.toThrow();
    await expect(store.restore(a.id, { offset: -1 })).rejects.toThrow();
    await expect(store.restore(a.id, { offset: 11, length: 1 })).rejects.toThrow();
  });
});

describe('压缩视图关联', () => {
  it('deriveCompressedView → 视图 derived_from=[原 id]，原 compressed_views 关联视图 id', async () => {
    const store = new ArtifactStore(await tmpRoot());
    const original = deriveArtifact(makeInput({ content: 'full text' }));
    const view = deriveCompressedView(original, {
      type: 'summary',
      content: 'sum',
      scope: original.scope,
      provenance: original.provenance,
    });
    expect(view.id).not.toBe(original.id);
    expect(view.derived_from).toEqual([original.id]);
    expect(view.hash).toMatch(/^[0-9a-f]{64}$/);

    // 原 artifact 关联视图（id 只由 content 决定，改 compressed_views 不改 id）
    const linked: Artifact = { ...original, compressed_views: [view.id] };
    expect(linked.id).toBe(original.id);

    await store.put(linked);
    await store.put(view);

    const gotOriginal = await store.get(original.id);
    const gotView = await store.get(view.id);
    expect(gotOriginal!.compressed_views).toEqual([view.id]);
    expect(gotView!.derived_from).toEqual([original.id]);
  });
});

describe('restore 幂等', () => {
  it('连续 get / restore 结果一致（字节级），重复 put 同内容 no-op 成功', async () => {
    const store = new ArtifactStore(await tmpRoot());
    const a = deriveArtifact(makeInput({ content: 'idem' }));
    await store.put(a);

    const g1 = await store.get(a.id);
    const g2 = await store.get(a.id);
    expect(g1).toEqual(g2);
    const r1 = await store.restore(a.id);
    const r2 = await store.restore(a.id);
    expect(Buffer.compare(Buffer.from(r1), Buffer.from(r2))).toBe(0);

    await expect(store.put(a)).resolves.toBeUndefined();
    expect((await store.index()).size).toBe(1);
  });
});

describe('put 校验拒绝', () => {
  it('缺 provenance 的 artifact → put 拒绝', async () => {
    const store = new ArtifactStore(await tmpRoot());
    const a = deriveArtifact(makeInput());
    const bad = { ...a } as Partial<Artifact>;
    delete bad.provenance;
    await expect(store.put(bad as unknown as Artifact)).rejects.toThrow();
  });

  it('非法 id（type:uuid / 非 sha256 格式）→ put 拒绝', async () => {
    const store = new ArtifactStore(await tmpRoot());
    const a = deriveArtifact(makeInput());
    await expect(store.put({ ...a, id: `note:${UUID}` })).rejects.toThrow();
    await expect(store.put({ ...a, id: 'sha256:zzzz' })).rejects.toThrow();
  });

  it('id 与内容哈希不一致（篡改内容）→ put 拒绝', async () => {
    const store = new ArtifactStore(await tmpRoot());
    const a = deriveArtifact(makeInput({ content: 'same' }));
    await store.put(a);
    const tampered: Artifact = { ...a, content: 'different' };
    await expect(store.put(tampered)).rejects.toThrow();
    const got = await store.get(a.id);
    expect(got!.content).toBe('same');
  });
});
