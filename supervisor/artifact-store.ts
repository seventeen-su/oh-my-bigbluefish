// OMB v2 Artifact Store（架构 §4.3 A1）：layer 1 I/O。
// 内容寻址持久化：<root>/<hash>/payload.bin（内容字节）+ <root>/<hash>/meta.json（Artifact 除 content）；
//   （目录名用 id 的 64hex 部分——Windows 目录名不允许 ':'，sha256: 前缀剥离，与 git 对象目录同风格）
// 索引：内存 Map + <root>/index.json（tmp+rename 原子写防半写，put/delete 时更新，启动时懒加载）。
// put 门禁：A1 schema 校验（缺 provenance / 非法 id 均拒绝）→ id 必须等于内容哈希（内容寻址）→
//   同 id 重复 put：内容相同 no-op 成功（幂等），内容不同拒绝。
// restore 范围越界抛错；get 幂等（重复调用结果一致）。
// layer 1（supervisor/）：可 import kernel/（CONVENTIONS §4）。
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ArtifactSchema, type Artifact } from '../kernel/schemas/a.js';
import { isValidId } from '../kernel/schemas/base.js';
import { computeContentId } from '../kernel/artifact.js';

/** 索引条目：id → {type, scope, size, created}（size = 内容字节数） */
export interface ArtifactMeta {
  type: string;
  scope: Artifact['scope'];
  size: number;
  created: string;
}

/** restore 范围：offset 默认 0，length 默认到末尾；越界抛错 */
export interface RestoreRange {
  offset?: number;
  length?: number;
}

export class ArtifactStore {
  private readonly root: string;
  private readonly indexFile: string;
  private readonly meta = new Map<string, ArtifactMeta>();
  private loaded = false;

  constructor(root: string) {
    this.root = root;
    this.indexFile = join(root, 'index.json');
  }

  /** put：schema 校验 → 内容寻址校验 → 按 id 落盘 + 更新索引。同 id 同内容幂等 no-op */
  async put(artifact: Artifact): Promise<void> {
    await this.ensureLoaded();
    const parsed = ArtifactSchema.safeParse(artifact);
    if (!parsed.success) {
      throw new Error(`ArtifactStore.put: A1 schema 校验失败 — ${parsed.error.message}`);
    }
    const a = parsed.data;
    if (a.id !== computeContentId(a.content)) {
      throw new Error(`ArtifactStore.put: id 与内容哈希不一致（内容寻址）: ${a.id}`);
    }
    if (this.meta.has(a.id)) {
      const existing = await this.get(a.id);
      if (existing !== null && existing.content === a.content) {
        return; // 幂等：同 id 同内容 → no-op 成功
      }
      throw new Error(`ArtifactStore.put: 同 id 内容不同（哈希冲突或篡改）: ${a.id}`);
    }
    const dir = this.artifactDir(a.id);
    await mkdir(dir, { recursive: true });
    const { content, ...metaOnly } = a;
    await writeFile(join(dir, 'payload.bin'), Buffer.from(content, 'utf8'));
    await this.atomicWriteJson(join(dir, 'meta.json'), metaOnly);
    this.meta.set(a.id, {
      type: a.type,
      scope: a.scope,
      size: Buffer.byteLength(content, 'utf8'),
      created: a.created,
    });
    await this.writeIndex();
  }

  /** get：恢复 Artifact（meta.json + payload.bin 重组）；不存在/非法 id → null */
  async get(id: string): Promise<Artifact | null> {
    await this.ensureLoaded();
    if (!isValidId(id) || !this.meta.has(id)) {
      return null;
    }
    const dir = this.artifactDir(id);
    try {
      const metaRaw = await readFile(join(dir, 'meta.json'), 'utf8');
      const payload = await readFile(join(dir, 'payload.bin'));
      const metaOnly = JSON.parse(metaRaw) as Omit<Artifact, 'content'>;
      return { ...metaOnly, content: payload.toString('utf8') };
    } catch {
      return null;
    }
  }

  /** restore：内容范围读取；缺省返回全文；offset/length 越界或非法抛错 */
  async restore(id: string, range?: RestoreRange): Promise<Uint8Array> {
    await this.ensureLoaded();
    if (!isValidId(id)) {
      throw new Error(`ArtifactStore.restore: 非法 id: ${id}`);
    }
    let data: Uint8Array;
    try {
      data = await readFile(join(this.artifactDir(id), 'payload.bin'));
    } catch {
      throw new Error(`ArtifactStore.restore: artifact 不存在: ${id}`);
    }
    const size = data.length;
    const offset = range?.offset ?? 0;
    if (!Number.isInteger(offset) || offset < 0) {
      throw new Error(`ArtifactStore.restore: 非法 offset: ${offset}`);
    }
    if (offset > size) {
      throw new Error(`ArtifactStore.restore: offset 越界（${offset} > ${size}）`);
    }
    const length = range?.length ?? size - offset;
    if (!Number.isInteger(length) || length < 0) {
      throw new Error(`ArtifactStore.restore: 非法 length: ${length}`);
    }
    if (offset + length > size) {
      throw new Error(`ArtifactStore.restore: 范围越界（${offset}+${length} > ${size}）`);
    }
    return data.subarray(offset, offset + length);
  }

  /** has：id 是否在索引中 */
  async has(id: string): Promise<boolean> {
    await this.ensureLoaded();
    return isValidId(id) && this.meta.has(id);
  }

  /** index：id → ArtifactMeta（快照副本） */
  async index(): Promise<Map<string, ArtifactMeta>> {
    await this.ensureLoaded();
    return new Map(this.meta);
  }

  /** delete：删除落盘目录 + 索引更新；不存在/非法 id 幂等 no-op */
  async delete(id: string): Promise<void> {
    await this.ensureLoaded();
    if (!isValidId(id) || !this.meta.has(id)) {
      return;
    }
    await rm(this.artifactDir(id), { recursive: true, force: true });
    this.meta.delete(id);
    await this.writeIndex();
  }

  /** 落盘目录：id 的 64hex 部分（'sha256:' 在 Windows 目录名中非法） */
  private artifactDir(id: string): string {
    return join(this.root, id.slice('sha256:'.length));
  }

  /** 启动时加载磁盘索引（index.json 缺失 → 空索引） */
  private async ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    await mkdir(this.root, { recursive: true });
    try {
      const raw = await readFile(this.indexFile, 'utf8');
      const data = JSON.parse(raw) as Record<string, ArtifactMeta>;
      for (const [id, m] of Object.entries(data)) {
        this.meta.set(id, m);
      }
    } catch {
      /* 无索引文件或损坏 → 空索引，后续 put 重建 */
    }
  }

  /** 写索引：先写同目录临时文件再 rename，防半写 */
  private async writeIndex(): Promise<void> {
    await this.atomicWriteJson(this.indexFile, Object.fromEntries(this.meta));
  }

  private async atomicWriteJson(file: string, value: unknown): Promise<void> {
    const tmp = `${file}.tmp-${randomUUID()}`;
    await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
    await rename(tmp, file);
  }
}
