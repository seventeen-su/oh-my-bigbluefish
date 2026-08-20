// OMB v2 Artifact Store kernel（架构 §4.3 A1）：内容寻址纯函数，无 I/O。
// 不可变对象 id = sha256(content)（改内容 = 新 id）；hash 字段与 id 同语义（64hex 无前缀）。
// layer 2（kernel/）：仅 import node: 内置与同层 schemas（CONVENTIONS §4）。
import { createHash } from 'node:crypto';
import type { Artifact } from './schemas/a.js';

const SHA_PREFIX = 'sha256:';

/** 内容 sha256 的 64hex（无前缀）；string 按 utf8 编码 */
export function computeContentHash(content: Uint8Array | string): string {
  const data = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  return createHash('sha256').update(data).digest('hex');
}

/** 内容寻址 id：`sha256:<hex>`（同内容同 id，异内容异 id） */
export function computeContentId(content: Uint8Array | string): string {
  return `${SHA_PREFIX}${computeContentHash(content)}`;
}

/** deriveArtifact 输入（compressed_views 由调用方提供——改它不改 id，id 只由 content 决定） */
export interface ArtifactInput {
  type: string;
  content: string;
  scope: Artifact['scope'];
  provenance: Artifact['provenance'];
  parent?: string[];
  derived_from?: string[];
  restore_policy?: string;
}

/** 由内容派生不可变 Artifact：id=sha256(content)、hash 同 id 语义、version 初值 1.0.0 */
export function deriveArtifact(input: ArtifactInput): Artifact {
  const id = computeContentId(input.content);
  const ts = new Date().toISOString();
  return {
    id,
    ir_version: '2.0',
    schema: 'omb/A1',
    scope: input.scope,
    lifecycle: 'active',
    immutable: true,
    owner: 'kernel',
    created: ts,
    updated: ts,
    provenance: input.provenance,
    refs: [],
    type: input.type,
    content: input.content,
    hash: id.slice(SHA_PREFIX.length),
    version: '1.0.0',
    parent: input.parent ?? [],
    derived_from: input.derived_from ?? [],
    restore_policy: input.restore_policy ?? 'keep',
    compressed_views: [],
  };
}

/** 压缩视图输入（视图自身 type/content/scope/provenance；derived_from 自动指向原 artifact） */
export interface CompressedViewInput {
  type: string;
  content: string;
  scope: Artifact['scope'];
  provenance: Artifact['provenance'];
}

/** 派生压缩视图：新 Artifact，derived_from=[原 id]，与原始引用关联 */
export function deriveCompressedView(artifact: Artifact, view: CompressedViewInput): Artifact {
  return deriveArtifact({
    type: view.type,
    content: view.content,
    scope: view.scope,
    provenance: view.provenance,
    derived_from: [artifact.id],
  });
}

/** 内容是否相同（id 比较） */
export function sameContent(a: Artifact, b: Artifact): boolean {
  return a.id === b.id;
}
