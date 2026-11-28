import type { PoolClient } from 'pg'
import { adoptionReceiptHits } from '../../app/adoption.js'
import { OmbFailure, internal } from '../../domain/errors.js'
import type { JsonValue } from '../../domain/json.js'
import type {
  AdoptionReceiptDisposition,
  AdoptionReceiptHit,
  AdoptionReceiptInput,
  UsageEvidenceInput,
  UsageEvidenceLevel,
  UsageExposureInput,
} from '../../ports/observability.js'
import type { PostgresDb } from './db.js'

/**
 * 采用证据的 PostgreSQL 适配器（019 adoption_receipts.sql）。
 *
 * 唯一来源是真实注入的 receipt：
 * - `recordAdoptionReceipt` 落 receipt + 逐实体处置；只有 disposition='kept' 才增加
 *   `adoption_metric.retrieved_count`；
 * - `recordExposure` / `recordUsage` 在写任何机会/证据前先验证“该实体在本 session
 *   有 kept receipt”；没有 receipt 的调用直接忽略，因此伪造 recall_event 或直接调
 *   store API 都不会增加采用；
 * - `markRecallInjected` 只做事件级审计（recall_event.injected），完全不影响指标。
 *
 * 机会仍按 `(entity_id, session_id, task_id)` 折叠；同一 receipt 对同一实体只登记
 * 一次 exposure（adoption_exposure 主键），不同 receipt 只增加 exposures 计数。
 */

/** `omb.usage_opportunity` 的一行（snake_case 与 SQL 对齐）。 */
interface UsageOpportunityRow {
  entity_id: string
  session_id: string
  task_id: string
  exposures: number
  exposed_at: Date | string
  referenced_at: Date | string | null
  reference_kind: string | null
  reference_source: string | null
  utilized_at: Date | string | null
  utilization_kind: string | null
  utilization_source: string | null
  validated_at: Date | string | null
  validation_kind: string | null
  validation_source: string | null
  validation_evidence: JsonValue
  refuted_at: Date | string | null
  refutation_kind: string | null
  refutation_source: string | null
  refutation_evidence: JsonValue
  last_trace_id: string | null
  updated_at: Date | string
}

const RECEIPT_KINDS = new Set(['t0', 't1', 't2'])
const EVIDENCE_LEVELS = new Set<UsageEvidenceLevel>(['reference', 'utilization', 'validation', 'refutation'])

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.max(0, Math.trunc(value))
}

function trimOrUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed
}

/** 同一 trace 多写者合并处置：quarantined 永远粘住，其余保持首次结论（少算不多算）。 */
function mergeDisposition(
  previous: AdoptionReceiptDisposition | undefined,
  candidate: AdoptionReceiptDisposition,
): AdoptionReceiptDisposition {
  if (previous === undefined) return candidate
  if (previous === 'quarantined' || candidate === 'quarantined') return 'quarantined'
  return previous
}

async function bumpRetrieved(
  client: Pick<PoolClient, 'query'>,
  entityId: string,
  delta: 1 | -1,
): Promise<void> {
  await client.query(
    `insert into omb.adoption_metric as metric (entity_id, retrieved_count, last_retrieved_at, updated_at)
     values ($1, $2::bigint, case when $2::bigint > 0 then now() end, now())
     on conflict (entity_id) do update
       set retrieved_count = greatest(metric.retrieved_count + $2::bigint, 0),
           last_retrieved_at = case when $2::bigint > 0 then now() else metric.last_retrieved_at end,
           updated_at = now()`,
    [entityId, delta],
  )
}

/**
 * 在调用方事务内写一次 receipt 的 receipt 行与逐实体处置，返回本次输入的 kept 命中。
 *
 * 幂等：同 trace_id 重复写入只合并 session/turn/task/预算/文本等元数据；逐实体行按
 * 主键合并，retrieved_count 只在 kept 行首次出现（或从其它处置升为 kept）时加一。
 */
export async function writeAdoptionReceipt(
  client: Pick<PoolClient, 'query'>,
  input: AdoptionReceiptInput,
): Promise<readonly AdoptionReceiptHit[]> {
  const traceId = input.traceId.trim()
  if (traceId.length === 0 || !RECEIPT_KINDS.has(input.kind)) return []

  const usedTokens = nonNegativeInteger(input.usedTokens, 0)
  const budgetTokens = input.budgetTokens === undefined ? null : nonNegativeInteger(input.budgetTokens, 0)
  const resolvedHits = adoptionReceiptHits({ ...input, traceId })
  // resident_trace 没有实体外键；派生的命中可能来自已删除实体。逐实体行仍保留外键，
  // 因此只落当前存在的实体（删除后没有可采用的记忆，审计行不必制造孤儿）。
  const entityIds = [...new Set(resolvedHits.map(hit => hit.entityId))]
  const present = new Set<string>()
  if (entityIds.length > 0) {
    const rows = await client.query<{ id: string }>(
      'select id from omb.entity where id = any($1::text[])',
      [entityIds],
    )
    for (const row of rows.rows) present.add(row.id)
  }
  const hits = resolvedHits.filter(hit => present.has(hit.entityId))

  await client.query(
    `insert into omb.adoption_receipt (
       trace_id, receipt_id, kind, session_id, turn_id, task_id, scenario, source,
       budget_tokens, used_tokens, injected, text_hash, text
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     on conflict (trace_id) do update
       set session_id = coalesce(adoption_receipt.session_id, excluded.session_id),
           turn_id = coalesce(adoption_receipt.turn_id, excluded.turn_id),
           task_id = coalesce(adoption_receipt.task_id, excluded.task_id),
           scenario = coalesce(adoption_receipt.scenario, excluded.scenario),
           source = coalesce(adoption_receipt.source, excluded.source),
           budget_tokens = coalesce(adoption_receipt.budget_tokens, excluded.budget_tokens),
           used_tokens = greatest(adoption_receipt.used_tokens, excluded.used_tokens),
           injected = adoption_receipt.injected or excluded.injected,
           text_hash = coalesce(adoption_receipt.text_hash, excluded.text_hash),
           text = case when excluded.text <> '' then excluded.text else adoption_receipt.text end,
           updated_at = now()`,
    [
      traceId,
      trimOrUndefined(input.receiptId) ?? null,
      input.kind,
      trimOrUndefined(input.sessionId) ?? null,
      trimOrUndefined(input.turnId) ?? null,
      trimOrUndefined(input.taskId) ?? null,
      trimOrUndefined(input.scenario) ?? null,
      trimOrUndefined(input.source) ?? null,
      budgetTokens,
      usedTokens,
      input.injected,
      trimOrUndefined(input.textHash) ?? null,
      input.text ?? '',
    ],
  )

  const existing = await client.query<{ entity_id: string; disposition: AdoptionReceiptDisposition }>(
    'select entity_id, disposition from omb.adoption_receipt_hit where trace_id = $1',
    [traceId],
  )
  const current = new Map(existing.rows.map(row => [row.entity_id, row.disposition]))
  const kept: AdoptionReceiptHit[] = []
  for (const hit of hits) {
    const previous = current.get(hit.entityId)
    const resolved = mergeDisposition(previous, hit.disposition)
    const metadata = [hit.title ?? null, hit.updatedAt ?? null, hit.rank ?? null]
    if (previous === undefined) {
      const inserted = await client.query(
        `insert into omb.adoption_receipt_hit (
           trace_id, entity_id, disposition, title, updated_at, rank, source
         ) values ($1,$2,$3,$4,$5,$6,$7)
         on conflict (trace_id, entity_id) do nothing
         returning entity_id`,
        [traceId, hit.entityId, resolved, ...metadata, input.source ?? 'receipt'],
      )
      if ((inserted.rowCount ?? 0) > 0 && resolved === 'kept') await bumpRetrieved(client, hit.entityId, 1)
    } else if (previous === resolved) {
      await client.query(
        `update omb.adoption_receipt_hit
            set title = coalesce(title, $3),
                updated_at = coalesce(updated_at, $4),
                rank = coalesce(rank, $5)
          where trace_id = $1 and entity_id = $2`,
        [traceId, hit.entityId, ...metadata],
      )
    } else {
      await client.query(
        `update omb.adoption_receipt_hit
            set disposition = $3,
                title = coalesce(title, $4),
                updated_at = coalesce(updated_at, $5),
                rank = coalesce(rank, $6)
          where trace_id = $1 and entity_id = $2`,
        [traceId, hit.entityId, resolved, ...metadata],
      )
      if (previous === 'kept' && resolved !== 'kept') await bumpRetrieved(client, hit.entityId, -1)
      if (previous !== 'kept' && resolved === 'kept') await bumpRetrieved(client, hit.entityId, 1)
    }
    if (resolved === 'kept') kept.push({ ...hit, disposition: 'kept' })
  }
  return kept
}

/** 独立事务写 receipt；T0/T1/T2 注入点都走这里。 */
export async function recordAdoptionReceipt(
  db: PostgresDb,
  input: AdoptionReceiptInput,
): Promise<readonly AdoptionReceiptHit[]> {
  return db.transaction(client => writeAdoptionReceipt(client, input))
}

/**
 * 该实体在本 session 是否有 kept receipt（可选限定 trace）。
 *
 * 这是所有 Exposure/采用证据的门：伪造 recall_event 只有事件行，没有 receipt，
 * 因此永远不会创建机会或增加引用/使用/验证计数。
 */
async function hasKeptReceipt(
  client: Pick<PoolClient, 'query'>,
  entityId: string,
  sessionId: string,
  traceId: string | undefined,
  taskId: string | undefined,
): Promise<boolean> {
  const result = await client.query(
    `select 1
       from omb.adoption_receipt_hit h
       join omb.adoption_receipt r on r.trace_id = h.trace_id
      where h.entity_id = $1
        and h.disposition = 'kept'
        and (r.session_id = $2 or (r.session_id is null and $3::text is not null and h.trace_id = $3))
        and ($3::text is null or h.trace_id = $3)
        and ($4::text is null or r.task_id is null or r.task_id = $4)
      limit 1`,
    [entityId, sessionId, traceId ?? null, taskId ?? null],
  )
  return (result.rowCount ?? 0) > 0
}

/**
 * 记录一次曝光：先验证 kept receipt，再按 (entity, session, task) 折叠机会。
 * 同一 receipt 对同一实体只登记一次（adoption_exposure 主键），重复调用无操作。
 */
export async function recordReceiptExposure(db: PostgresDb, input: UsageExposureInput): Promise<void> {
  const entityId = input.entityId.trim()
  const sessionId = input.sessionId.trim()
  const taskId = trimOrUndefined(input.taskId) ?? 'session'
  if (entityId.length === 0 || sessionId.length === 0) return
  const traceId = trimOrUndefined(input.traceId)
  await db.transaction(async client => {
    if (!(await hasKeptReceipt(client, entityId, sessionId, traceId, taskId))) return
    if (traceId !== undefined) {
      const seen = await client.query(
        `insert into omb.adoption_exposure (trace_id, entity_id, session_id, task_id)
         values ($1,$2,$3,$4)
         on conflict (trace_id, entity_id) do nothing
         returning trace_id`,
        [traceId, entityId, sessionId, taskId],
      )
      // 同一 receipt 重复登记：机会/exposures 都不再变化。
      if ((seen.rowCount ?? 0) === 0) return
    }
    const opportunity = await client.query(
      `insert into omb.usage_opportunity (
         entity_id, session_id, task_id, exposures, exposed_at, last_trace_id, updated_at
       ) values ($1, $2, $3, 1, now(), $4, now())
       on conflict (entity_id, session_id, task_id) do nothing
       returning entity_id`,
      [entityId, sessionId, taskId, traceId ?? null],
    )
    if ((opportunity.rowCount ?? 0) > 0) {
      await client.query(
        `insert into omb.adoption_metric as metric (entity_id, opportunities, updated_at)
         values ($1, 1, now())
         on conflict (entity_id) do update
           set opportunities = metric.opportunities + 1,
               updated_at = now()`,
        [entityId],
      )
      return
    }
    await client.query(
      `update omb.usage_opportunity
          set exposures = exposures + 1,
              last_trace_id = coalesce($4, last_trace_id),
              updated_at = now()
        where entity_id = $1 and session_id = $2 and task_id = $3`,
      [entityId, sessionId, taskId, traceId ?? null],
    )
  })
}

/** 事件级审计：T1 真正投递后置 injected=true；不写 adoption_metric。 */
export async function markRecallInjectedAudit(db: PostgresDb, traceId: string): Promise<void> {
  const id = traceId.trim()
  if (id.length === 0) return
  await db.query(
    `update omb.recall_event
        set injected = true,
            injected_at = coalesce(injected_at, now())
      where trace_id = $1 and not injected`,
    [id],
  )
}

/** 使用机会的指标计数与事件级证据（与旧实现一致，只是入口先验证 receipt）。 */
export async function recordUsageEvidence(
  db: PostgresDb,
  level: UsageEvidenceLevel,
  input: UsageEvidenceInput,
): Promise<void> {
  const sessionId = input.sessionId.trim()
  const entityId = input.entityId.trim()
  if (sessionId.length === 0 || entityId.length === 0 || !EVIDENCE_LEVELS.has(level)) return
  const requestedTaskId = trimOrUndefined(input.taskId)
  const traceId = trimOrUndefined(input.traceId)
  await db.transaction(async client => {
    if (!(await hasKeptReceipt(client, entityId, sessionId, traceId, requestedTaskId))) return
    let opportunity = await selectOpportunity(client, entityId, sessionId, requestedTaskId)
    let opportunitiesBump = 0
    if (opportunity === undefined) {
      const taskId = requestedTaskId ?? 'session'
      const inserted = await client.query<UsageOpportunityRow>(
        `insert into omb.usage_opportunity (
           entity_id, session_id, task_id, exposures, exposed_at, updated_at
         ) values ($1, $2, $3, 0, now(), now())
         on conflict (entity_id, session_id, task_id) do nothing
         returning *`,
        [entityId, sessionId, taskId],
      )
      opportunity = inserted.rows[0] ?? await selectOpportunity(client, entityId, sessionId, taskId)
      if (opportunity === undefined) throw new OmbFailure(internal('使用机会写入后读不到'))
      // 并发下 on conflict do nothing 可能由另一个事务先建机会：只有真正插入才计机会数。
      opportunitiesBump = inserted.rows[0] === undefined ? 0 : 1
    }

    const referenceTransition = level !== 'refutation' && opportunity.referenced_at === null
    const utilizationTransition = level === 'utilization' && opportunity.utilized_at === null
    const validationTransition = level === 'validation' && opportunity.validated_at === null
    const refutationTransition = level === 'refutation' && opportunity.refuted_at === null
    const candidateKind = level === 'utilization' ? 'entity-id' : input.kind
    const referenceKind = opportunity.reference_kind === 'entity-id' || candidateKind === 'entity-id'
      ? 'entity-id'
      : opportunity.reference_kind ?? candidateKind

    // 一条件更新所有机会证据列：布尔参数决定本次是否迁移，避免动态拼 SQL。
    await client.query(
      `update omb.usage_opportunity
          set updated_at = now(),
              last_trace_id = coalesce($4, last_trace_id),
              referenced_at = coalesce(referenced_at, case when $5 then now() end),
              reference_kind = case when $5 then coalesce($6, reference_kind) else reference_kind end,
              reference_source = coalesce(reference_source, case when $5 then $9 end),
              utilized_at = coalesce(utilized_at, case when $8 then now() end),
              utilization_kind = coalesce(utilization_kind, case when $8 then $7 end),
              utilization_source = coalesce(utilization_source, case when $8 then $9 end),
              validated_at = coalesce(validated_at, case when $10 then now() end),
              validation_kind = coalesce(validation_kind, case when $10 then $7 end),
              validation_source = coalesce(validation_source, case when $10 then $9 end),
              validation_evidence = coalesce(validation_evidence, case when $10 then $11::jsonb end),
              refuted_at = coalesce(refuted_at, case when $12 then now() end),
              refutation_kind = coalesce(refutation_kind, case when $12 then $7 end),
              refutation_source = coalesce(refutation_source, case when $12 then $9 end),
              refutation_evidence = coalesce(refutation_evidence, case when $12 then $11::jsonb end)
        where entity_id = $1 and session_id = $2 and task_id = $3`,
      [
        entityId,
        sessionId,
        opportunity.task_id,
        traceId ?? null,
        referenceTransition,
        referenceKind,
        input.kind,
        utilizationTransition,
        input.source,
        validationTransition,
        input.evidence === undefined ? null : JSON.stringify(input.evidence),
        refutationTransition,
      ],
    )

    if (traceId !== undefined) {
      await writeRecallEvidence(client, level, { ...input, traceId })
    }

    const referencedBump = referenceTransition ? 1 : 0
    const utilizedBump = utilizationTransition ? 1 : 0
    const validatedBump = validationTransition ? 1 : 0
    const refutedBump = refutationTransition ? 1 : 0
    if (opportunitiesBump + referencedBump + utilizedBump + validatedBump + refutedBump === 0) return
    await client.query(
      `insert into omb.adoption_metric as metric (
         entity_id, opportunities, referenced_count, utilized_count, validated_count, refuted_count,
         last_referenced_at, last_utilized_at, last_validated_at, last_refuted_at, updated_at
       ) values (
         $1, $2::bigint, $3::bigint, $4::bigint, $5::bigint, $6::bigint,
         case when $3 > 0 then now() end,
         case when $4 > 0 then now() end,
         case when $5 > 0 then now() end,
         case when $6 > 0 then now() end,
         now()
       )
       on conflict (entity_id) do update
         set opportunities = metric.opportunities + excluded.opportunities,
             referenced_count = metric.referenced_count + excluded.referenced_count,
             utilized_count = metric.utilized_count + excluded.utilized_count,
             validated_count = metric.validated_count + excluded.validated_count,
             refuted_count = metric.refuted_count + excluded.refuted_count,
             last_referenced_at = coalesce(excluded.last_referenced_at, metric.last_referenced_at),
             last_utilized_at = coalesce(excluded.last_utilized_at, metric.last_utilized_at),
             last_validated_at = coalesce(excluded.last_validated_at, metric.last_validated_at),
             last_refuted_at = coalesce(excluded.last_refuted_at, metric.last_refuted_at),
             updated_at = now()`,
      [
        entityId,
        opportunitiesBump,
        referencedBump,
        utilizedBump,
        validatedBump,
        refutedBump,
      ],
    )
    // 旧口径兼容读：只有 Validation 才增 entity.adoption_count。
    if (validatedBump > 0) {
      await client.query('update omb.entity set adoption_count = adoption_count + 1 where id = $1', [entityId])
    }
  })
}

async function selectOpportunity(
  client: Pick<PoolClient, 'query'>,
  entityId: string,
  sessionId: string,
  taskId: string | undefined,
): Promise<UsageOpportunityRow | undefined> {
  const result = await client.query<UsageOpportunityRow>(
    `select *
       from omb.usage_opportunity
      where entity_id = $1 and session_id = $2
        and ($3::text is null or task_id = $3)
      order by updated_at desc
      limit 1
      for update`,
    [entityId, sessionId, taskId ?? null],
  )
  return result.rows[0]
}

/** 事件级证据列只写第一次；与机会级指标分开，便于按 trace 审计。 */
async function writeRecallEvidence(
  client: Pick<PoolClient, 'query'>,
  level: UsageEvidenceLevel,
  input: UsageEvidenceInput,
): Promise<void> {
  const traceId = input.traceId as string
  const evidence = input.evidence === undefined ? null : JSON.stringify(input.evidence)
  if (level === 'reference') {
    await client.query(
      `update omb.recall_event
          set referenced_at = coalesce(referenced_at, now()),
              reference_kind = coalesce(reference_kind, $3),
              reference_source = coalesce(reference_source, $4)
        where trace_id = $1 and entity_id = $2`,
      [traceId, input.entityId, input.kind, input.source],
    )
    return
  }
  if (level === 'utilization') {
    // Utilization 必然隐含一次显式引用：事件级审计也补上弱/强引用列。
    await client.query(
      `update omb.recall_event
          set referenced_at = coalesce(referenced_at, now()),
              reference_kind = coalesce(reference_kind, 'entity-id'),
              reference_source = coalesce(reference_source, $4),
              utilized_at = coalesce(utilized_at, now()),
              utilization_kind = coalesce(utilization_kind, $3),
              utilization_source = coalesce(utilization_source, $4)
        where trace_id = $1 and entity_id = $2`,
      [traceId, input.entityId, input.kind, input.source],
    )
    return
  }
  if (level === 'validation') {
    await client.query(
      `update omb.recall_event
          set referenced_at = coalesce(referenced_at, now()),
              reference_kind = coalesce(reference_kind, $3),
              reference_source = coalesce(reference_source, $4),
              validated_at = coalesce(validated_at, now()),
              validation_kind = coalesce(validation_kind, $3),
              validation_source = coalesce(validation_source, $4),
              validation_evidence = coalesce(validation_evidence, $5::jsonb),
              adopted_at = coalesce(adopted_at, now()),
              adoption_kind = coalesce(adoption_kind, 'validated:' || $3)
        where trace_id = $1 and entity_id = $2`,
      [traceId, input.entityId, input.kind, input.source, evidence],
    )
    return
  }
  await client.query(
    `update omb.recall_event
        set referenced_at = coalesce(referenced_at, now()),
            reference_kind = coalesce(reference_kind, $3),
            reference_source = coalesce(reference_source, $4),
            refuted_at = coalesce(refuted_at, now()),
            refutation_kind = coalesce(refutation_kind, $3),
            refutation_source = coalesce(refutation_source, $4),
            refutation_evidence = coalesce(refutation_evidence, $5::jsonb)
      where trace_id = $1 and entity_id = $2`,
    [traceId, input.entityId, input.kind, input.source, evidence],
  )
}
