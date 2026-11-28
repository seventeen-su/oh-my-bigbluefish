-- OMB v7.x 项目身份 expand：workspace → project 的稳定映射 + 旧 projectKey 别名。
--
-- 背景：旧实现把 git root 路径直接写进 `scope.projectKey`，移动磁盘/worktree/复制/
-- 改名都会把同一逻辑项目拆成多个 scope；子模块还可能被外层 root 吞并。新解析器把
-- 「逻辑项目 projectId」与「具体工作区 workspaceId / 仓库 repositoryId / 分支 branchId」
-- 拆开，`scope.projectKey` 继续作为 projectId 的兼容别名。
--
-- 本迁移只做 expand（不改已有 001–011、不改写历史行）：
--   1. 新表 `omb.project_identity`：每个工作区一行，记录身份与旧键别名；
--   2. 从现有 project scope 回填：旧数据没有 remote 信息，只能把旧 projectKey（路径）
--      当作 project_id / project_root / 单一 legacy key 登记，保证旧行仍能按旧键命中；
--   3. `project_id` 索引：检索时按 projectId 展开 legacy_keys（见 store/projection）。
--
-- 运行时消费者（不是死数据）：
--   * 检索/看板读：`project_key = $projectId or project_key in (legacy_keys of $projectId)`；
--   * 后台动态文件属性：按 projectId 取最近工作区根作为 path-guard 的 projectRoot；
--   * 事件 artifact.metadata 记录 projectId/workspaceId/repositoryId/branchId 供排查。
--
-- 回滚：仅新增对象，可安全 `drop table omb.project_identity`（代码随后回滚）。
-- 重跑：所有语句幂等（if not exists / on conflict do nothing）。

set local lock_timeout = '5s';
set local statement_timeout = '120s';

create table if not exists omb.project_identity (
  -- 工作区身份：git worktree 根 / 非 git 目录的 realpath 指纹（或迁移回填的 legacy:md5）。
  workspace_id text primary key,
  -- 逻辑项目身份：git-remote:<规范化 remote> / git-common:<指纹> / workspace:<指纹>。
  project_id text not null,
  -- 仓库身份：有 remote 时与 project_id 相同；非 git 为空。
  repository_id text,
  -- 最近一次解析到的分支名；detached HEAD 为 detached:<commit>。
  branch_id text,
  -- 路径锚点：动态文件属性 path-guard 的根；旧数据回填为旧 projectKey（路径）。
  project_root text not null,
  -- 旧解析器写过的 projectKey（git root 路径 / 非 git cwd 的原始写法），用于兼容旧行。
  legacy_keys text[] not null default '{}',
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

comment on table omb.project_identity is
  '项目身份注册表：workspace → project 的稳定映射与旧 projectKey 别名；每工作区一行。';
comment on column omb.project_identity.legacy_keys is
  '旧 resolver 可能写进 scope.projectKey 的键；检索按 project_id 展开这些别名匹配旧行。';
comment on column omb.project_identity.project_root is
  '动态文件属性的 path-guard 根；project_id 本身不是路径，不能当 projectRoot 用。';

-- 检索按 project_id 查 legacy_keys 是热路径（每条 project scope 查询都会走到）。
create index if not exists project_identity_project
  on omb.project_identity (project_id);

-- 回填策略：旧数据没有 remote 可推断，只能把旧 projectKey 当作它自己的 project_id；
-- 之后同一个磁盘路径上的新解析会把真实身份写成新行（workspace:<指纹>），并把旧路径
-- 记进 legacy_keys，于是「新 projectId 查得到旧行」。
insert into omb.project_identity (workspace_id, project_id, project_root, legacy_keys)
select distinct
       'legacy:' || md5(v.project_key) as workspace_id,
       v.project_key as project_id,
       v.project_key as project_root,
       array[v.project_key] as legacy_keys
  from omb.entity_view v
 where v.scope = 'project'
   and v.project_key <> ''
on conflict (workspace_id) do nothing;
