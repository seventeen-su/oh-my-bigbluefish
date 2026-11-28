import type { ProjectIdentity } from '../../domain/project-identity.js'
import type { PostgresDb } from './db.js'

/**
 * `omb.project_identity`（012_project_identity.sql）的读写 SQL。
 *
 * 单独成文件是为了让「身份注册表」这一职责有自己的边界：`PostgresStore` 只保留
 * 与实体/检索相关的读路径，注册表的 SQL 与并集语义不必挤进那个已经很长的类。
 *
 * 错误映射仍由调用方（`PostgresStore.run`）统一处理，这里只发查询。
 */

/**
 * 每个 workspace 一行；`legacy_keys` 取**并集**而不是覆盖：worktree 被删除/目录改名
 * 之后旧 projectKey 仍要能被新 projectId 匹配，否则历史行会再次掉出作用域。
 * 调用方（组合根）已按「进程 + 身份」去重，写频率是一次/进程，不做额外 CAS。
 */
export async function recordProjectIdentityRow(db: PostgresDb, identity: ProjectIdentity): Promise<void> {
  await db.query(
    `insert into omb.project_identity as pi
       (workspace_id, project_id, repository_id, branch_id, project_root, legacy_keys, last_seen_at)
     values ($1,$2,$3,$4,$5,$6::text[],now())
     on conflict (workspace_id) do update set
       project_id = excluded.project_id,
       repository_id = excluded.repository_id,
       branch_id = excluded.branch_id,
       project_root = excluded.project_root,
       legacy_keys = coalesce((
         select array_agg(k order by k)
         from (
           select distinct unnest(pi.legacy_keys || excluded.legacy_keys) as k
           order by k
           limit 16
         ) merged
       ), '{}'::text[]),
       last_seen_at = now()`,
    [
      identity.workspaceId,
      identity.projectId,
      identity.repositoryId ?? null,
      identity.branchId ?? null,
      identity.projectRoot,
      [...identity.legacyProjectKeys],
    ],
  )
}

/** 后台动态文件属性的 path-guard 根：取该 projectId 最近活跃的工作区路径。 */
export async function projectRootRow(db: PostgresDb, projectId: string): Promise<string | undefined> {
  const rows = await db.query<{ project_root: string }>(
    `select project_root
       from omb.project_identity
      where project_id = $1
      order by last_seen_at desc
      limit 1`,
    [projectId],
  )
  return rows.rows[0]?.project_root
}
