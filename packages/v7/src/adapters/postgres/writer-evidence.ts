import { createHash } from 'node:crypto'
import type { PoolClient } from 'pg'
import { contentFingerprint } from '../../domain/content-key.js'
import type { EvidenceInput } from '../../domain/evidence.js'
import { normalizeEvidence } from '../../domain/evidence.js'
import { newId } from '../../domain/ids.js'
import type { NormalizedWrite } from '../../domain/validation.js'

/**
 * 写事务内的证据账本与内容幂等键。
 *
 * 为什么放在 writer：内容去重需要「查活跃同内容行 + 插入新实体」在同一个事务里完成，
 * 证据也要与实体同事务提交；否则并发/失败会留下没有证据的实体或重复实体。
 */

/** 内容指纹的 sha256；内存/测试里的纯函数不接触 node:crypto，只有适配器算哈希。 */
export function contentHashOf(input: NormalizedWrite): string | null {
  const fingerprint = contentFingerprint(input)
  if (fingerprint === undefined) return null
  return createHash('sha256').update(fingerprint).digest('hex')
}

/**
 * 写证据：`contentHash` 由本事务按当前内容指纹补齐（调用方给的值被覆盖，防止伪造成旧内容）。
 * 唯一约束 `(entity_id, source_type, source_id, content_hash)` 吸收重复投递/重试；
 * `on conflict do nothing` 保留首次观察时间，不把重试当成新证据。
 */
export async function insertEvidence(
  client: PoolClient,
  entityId: string,
  evidence: readonly EvidenceInput[] | undefined,
  contentHash: string | null,
): Promise<void> {
  if (evidence === undefined || evidence.length === 0) return
  const hash = contentHash ?? ''
  for (const raw of evidence) {
    const normalized = normalizeEvidence(raw)
    if (normalized === undefined) continue
    if (hash.length === 0) continue
    await client.query(
      `insert into omb.evidence (
         id, entity_id, source_type, source_id, observed_at, content_hash,
         confidence, verification_status, subject_key, detail
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       on conflict (entity_id, source_type, source_id, content_hash) do nothing`,
      [
        newId('evidence'),
        entityId,
        normalized.sourceType,
        normalized.sourceId,
        normalized.observedAt,
        hash,
        normalized.confidence ?? 0.5,
        normalized.verificationStatus ?? 'unverified',
        normalized.subjectKey ?? '',
        normalized.detail ?? null,
      ],
    )
  }
}
