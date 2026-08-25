// S4 Artifact Index（用户 2026-08-25 第二阶段裁决：事件驱动制品索引）契约层 schema。
// Manifest = { id, type, path/locator, hash, provenance, producing_event, environment, restorable }——
//   OMB 不做复杂 Artifact Store（制品本来就在文件系统/Git/工具结果/DSH 事件里），只做统一索引与引用。
// 语义：
//   id        确定性（sha256(path|provenance) 前缀 16）——同路径同来源 → 同 id，重复注册覆写；
//   type      按扩展名归类 source/build/report/doc/data/other（register 时推断，inferArtifactType）；
//   path      路径/locator（制品位置，原样保留提取 token）；
//   hash      文件内容 sha256；不可读 → 'unavailable'（诚实值，不臆造）；
//   provenance 来源（事件 id 或显式注册者）；producing_event 产出事件 id；
//   environment 产出环境指纹（Record<string,string>——Fingerprint 过滤非字符串键后的落盘面）；
//   restorable 是否可恢复（文件存在且可读 → true；root 未提供/不可读 → false 诚实缺省）。
// 纯 zod schema + 纯函数（契约层纪律：无 I/O、无副作用——supervisor 可经契约例外 import）。
// 消费方 = supervisor/artifact-index.ts（layer 1）与 tests/m9（豁免）。
import { createHash } from 'node:crypto';
import { z } from 'zod';

/** Artifact Manifest（事件驱动制品索引的条目；见文件头语义注记） */
export const ArtifactManifestSchema = z.object({
  /** 确定性 id：sha256(path|provenance) 前缀 16——同路径同来源 → 同 id（覆写语义） */
  id: z.string().min(1),
  /** 制品类型（按扩展名归类 source/build/report/doc/data/other——register 时经 inferArtifactType 推断） */
  type: z.string().min(1),
  /** path/locator（制品位置；原样保留提取 token，不规范化——引用语义） */
  path: z.string().min(1),
  /** 文件内容 sha256；不可读 → 'unavailable' 诚实值（root 未提供/读取失败时） */
  hash: z.string().min(1),
  /** 来源：事件 id（discoverArtifactsFromEvents）或显式注册者 */
  provenance: z.string().min(1),
  /** 产出事件 id（provenance 通常同值；显式注册者可不同） */
  producing_event: z.string().min(1),
  /** 产出环境指纹（Record<string,string>——Fingerprint 过滤非字符串键后的落盘面） */
  environment: z.record(z.string(), z.string()),
  /** 是否可恢复（文件存在且可读 → true；root 未提供 → false 诚实缺省） */
  restorable: z.boolean(),
  /** 注册时间戳（epoch ms） */
  created_at: z.number().int().nonnegative(),
});
export type ArtifactManifest = z.infer<typeof ArtifactManifestSchema>;

/** 扩展名 → 制品类型（小写扩展名含点；.json 缺省 data——含 'test'/'report' 的路径由 inferArtifactType 覆写为 report） */
export const ARTIFACT_TYPE_BY_EXT: Readonly<Record<string, string>> = {
  '.ts': 'source',
  '.js': 'source',
  '.tsx': 'source',
  '.jsx': 'source',
  '.json': 'data',
  '.md': 'doc',
  '.txt': 'doc',
  '.yaml': 'data',
  '.yml': 'data',
};

/**
 * 制品类型推断（纯函数）：按扩展名归类 source/build/report/doc/data/other。
 * 简单启发式：.json 且路径含 'test'/'report'（小写匹配）→ report（测试/报告产物），否则 data；
 * 未收录扩展名 → other；build 类无扩展名映射（显式注册者提供）。
 */
export function inferArtifactType(path: string): string {
  const lower = path.toLowerCase();
  const idx = lower.lastIndexOf('.');
  if (idx < 0) {
    return 'other';
  }
  const ext = lower.slice(idx);
  const base = ARTIFACT_TYPE_BY_EXT[ext] ?? 'other';
  if (ext === '.json' && (lower.includes('test') || lower.includes('report'))) {
    return 'report';
  }
  return base;
}

/** 确定性 manifest id：sha256(path|provenance) 前缀 16（同路径同来源 → 同 id——重复发现覆写而非膨胀） */
export function artifactManifestId(path: string, provenance: string): string {
  return createHash('sha256').update(`${path}|${provenance}`, 'utf8').digest('hex').slice(0, 16);
}
