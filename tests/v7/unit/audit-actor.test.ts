import { describe, expect, it } from 'vitest'
import {
  AUDIT_ACTOR_KINDS,
  auditActorKindOf,
  auditTenantOf,
  entityAccessDecision,
  entityScopeFact,
  rollbackAccessDecision,
  sanitizeActorId,
  scopeAccessOf,
  type AuditRollbackFacts,
} from '../../../packages/v7/src/domain/audit.js'
import type { Entity } from '../../../packages/v7/src/domain/entity.js'
import {
  DEFAULT_TRUST_LEVELS,
  actorKindOfOrigin,
  createTrustPolicy,
} from '../../../packages/v7/src/security/trust.js'
import { deriveToolPrincipal, forgedActorFieldsIn } from '../../../packages/v7/src/security/audit.js'

const PROJECT_A = 'git-remote:github.com/example/omb'
const LEGACY_A = 'D:/Program/old-omb'

function entityOf(scope: 'global' | { kind: 'project'; projectKey: string }): Entity {
  return {
    id: 'mem_11111111-1111-4111-8111-111111111111',
    kind: 'memory',
    revision: 1,
    origin: 'model',
    pinned: false,
    salience: 0.5,
    accessCount: 0,
    adoptionCount: 0,
    isCurrent: true,
    lifecycle: 'active',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    attributes: [
      { name: 'title', ordinal: 0, value: { kind: 'static', value: '构建命令' }, required: true, source: 'model' },
      { name: 'scope', ordinal: 0, value: { kind: 'static', value: scope }, required: true, source: 'model' },
    ],
  }
}

const TENANT_A = auditTenantOf({
  projectKey: PROJECT_A,
  projectIdentity: { projectId: PROJECT_A, legacyProjectKeys: [LEGACY_A] },
})

const TENANT_B = auditTenantOf({ projectKey: 'git-remote:github.com/example/other' })

const FACTS: AuditRollbackFacts = {
  id: 7,
  action: 'patch',
  actor: 'assistant:session-a',
  actorKind: 'assistant',
  source: 'tool:omb_update',
  targetIds: ['mem_11111111-1111-4111-8111-111111111111'],
}

describe('审计 actor/source 规范模型', () => {
  it('给定 actor 字符串当推导 kind 则 assistant/tool/历史别名都可识别且未知不冒充 system', () => {
    expect(AUDIT_ACTOR_KINDS).toEqual(expect.arrayContaining(['user', 'assistant', 'tool', 'system', 'job']))
    expect(auditActorKindOf('assistant:session-1')).toBe('assistant')
    expect(auditActorKindOf('assistant')).toBe('assistant')
    expect(auditActorKindOf('tool:omb_admin')).toBe('tool')
    expect(auditActorKindOf('user:u1')).toBe('user')
    expect(auditActorKindOf('job:forget')).toBe('job')
    expect(auditActorKindOf('system:refresh')).toBe('system')
    expect(auditActorKindOf('model')).toBe('model')
    expect(auditActorKindOf('whatever')).toBe('model')
    expect(auditActorKindOf(undefined)).toBe('model')
  })

  it('给定会话 id 当派生工具身份则 actor/source/tenant 都由上下文给出且伪造字段不能改变它', () => {
    const principal = deriveToolPrincipal({
      sessionId: 'session-a',
      projectKey: PROJECT_A,
      projectIdentity: { projectId: PROJECT_A, legacyProjectKeys: [LEGACY_A] },
    }, 'omb_admin')
    expect(principal.actor).toEqual({ id: 'assistant:session-a', kind: 'assistant' })
    expect(principal.source).toBe('tool:omb_admin')
    expect(principal.tenant).toEqual({ projectKey: PROJECT_A, aliases: [LEGACY_A, PROJECT_A].sort() })
    // 工具参数里自称的 actor/source 只能被识别为“越权尝试”，不进入派生结果。
    expect(forgedActorFieldsIn({ origin: 'user', actor: 'system', source: 'system:root' }))
      .toEqual(['origin', 'actor', 'source'])
    expect(forgedActorFieldsIn({ title: '普通标题', origin: '   ' })).toEqual([])
  })

  it('给定 session 含空格/控制字符当规范化 actor 则写出有界且无控制字符的 id', () => {
    expect(sanitizeActorId('  session with space  ')).toBe('session-with-space')
    expect(sanitizeActorId('bad\u0000session')).toBe('bad-session')
    expect(sanitizeActorId('')).toBe('unknown')
    expect(sanitizeActorId('x'.repeat(500)).length).toBeLessThanOrEqual(160)
  })
})

describe('租户作用域与回滚权限', () => {
  it('给定稳定 projectId/旧路径别名当判定 scope 则同项目与 global 允许、外项目拒绝、缺租户只允许 global', () => {
    expect(scopeAccessOf({ kind: 'global' }, TENANT_A)).toBe('global')
    expect(scopeAccessOf({ kind: 'project', projectKey: PROJECT_A }, TENANT_A)).toBe('tenant')
    expect(scopeAccessOf({ kind: 'project', projectKey: LEGACY_A }, TENANT_A)).toBe('tenant')
    expect(scopeAccessOf({ kind: 'project', projectKey: TENANT_B?.projectKey ?? '' }, TENANT_A)).toBe('foreign')
    expect(scopeAccessOf({ kind: 'project', projectKey: PROJECT_A }, undefined)).toBe('foreign')
    expect(auditTenantOf({ projectKey: '   ' })).toBeUndefined()
  })

  it('给定实体作用域集合当判定访问则任意外项目实体都拒绝且错误不泄露外项目键', () => {
    const owned = entityScopeFact(entityOf({ kind: 'project', projectKey: PROJECT_A }))
    const legacy = entityScopeFact(entityOf({ kind: 'project', projectKey: LEGACY_A }))
    const global = entityScopeFact(entityOf('global'))
    expect(entityAccessDecision(TENANT_A, [owned, legacy, global])).toEqual({ allowed: true })
    const mixed = entityAccessDecision(TENANT_A, [owned, { id: 'mem_foreign', scope: { kind: 'project', projectKey: 'foreign-key' } }])
    expect(mixed.allowed).toBe(false)
    if (mixed.allowed) return
    expect(mixed.reason).toBe('cross-project')
    expect(mixed.targetIds).toEqual(['mem_foreign'])
    expect(mixed.message).not.toContain('foreign-key')
    const unknownTarget = entityAccessDecision(TENANT_A, [{ id: 'mem_missing' }])
    expect(unknownTarget.allowed).toBe(false)
    if (!unknownTarget.allowed) expect(unknownTarget.reason).toBe('unknown-target')
  })

  it('给定回滚事实当判定则外项目/无目标/拒绝记录不可回滚，目标都在租户内才放行', () => {
    const owned = entityScopeFact(entityOf({ kind: 'project', projectKey: PROJECT_A }))
    expect(rollbackAccessDecision({ facts: FACTS, targets: [owned], tenant: TENANT_A })).toEqual({ allowed: true })
    expect(rollbackAccessDecision({
      facts: { ...FACTS, action: 'denied' },
      targets: [owned],
      tenant: TENANT_A,
    })).toMatchObject({ allowed: false, reason: 'denied-audit' })
    expect(rollbackAccessDecision({ facts: { ...FACTS, targetIds: [] }, targets: [], tenant: TENANT_A }))
      .toMatchObject({ allowed: false, reason: 'unverifiable-target' })
    const foreign = entityAccessDecision(TENANT_B, [owned])
    expect(foreign.allowed).toBe(false)
    expect(rollbackAccessDecision({ facts: FACTS, targets: [owned], tenant: TENANT_B }))
      .toMatchObject({ allowed: false, reason: 'cross-project' })
    // 缺 tenant 时项目实体 fail-closed；global 仍允许（共享语义）。
    expect(rollbackAccessDecision({ facts: FACTS, targets: [owned], tenant: undefined }))
      .toMatchObject({ allowed: false, reason: 'unknown-tenant' })
    const global = entityScopeFact(entityOf('global'))
    expect(rollbackAccessDecision({ facts: FACTS, targets: [global], tenant: undefined })).toEqual({ allowed: true })
  })

  it('给定 assistant/tool 来源当信任分层则 assistant 等同 model、tool 不高于工具来源上限', () => {
    expect(actorKindOfOrigin('assistant:session')).toBe('assistant')
    expect(actorKindOfOrigin('tool:omb_admin')).toBe('tool')
    expect(DEFAULT_TRUST_LEVELS.assistant).toBe(DEFAULT_TRUST_LEVELS.model)
    expect(DEFAULT_TRUST_LEVELS.tool).toBe(0.4)
    const policy = createTrustPolicy()
    expect(policy.classify({ text: 'x', source: 'memory', origin: 'assistant:session' }).trust).toBe(0.8)
    expect(policy.classify({ text: 'x', source: 'tool', origin: 'tool:read_file' }).trust).toBe(0.4)
  })
})
