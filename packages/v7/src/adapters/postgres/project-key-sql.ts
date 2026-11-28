/**
 * 项目键的兼容匹配 SQL。
 *
 * `scope.projectKey` 现在是稳定 `projectId`（git remote 规范化 / common dir 指纹 /
 * workspace 指纹），但迁移前的行仍存旧键（git root 路径、非 git cwd）。
 * `omb.project_identity.legacy_keys` 记录同一 projectId 下出现过的旧键，所以判断
 * 「这行属于当前项目」= 等值命中 **或** 命中该 projectId 的旧键并集。
 *
 * 只拼受信片段：`column` 必须是本包内写死的列表达式，`param` 必须是 `$n` 占位符；
 * 函数不接受外部输入，也不做转义（没有需要转义的输入）。
 */
export function sameProjectClause(column: string, param: string): string {
  return `(${column} = ${param} or ${column} in (`
    + `select unnest(pi.legacy_keys) from omb.project_identity pi where pi.project_id = ${param}))`
}
