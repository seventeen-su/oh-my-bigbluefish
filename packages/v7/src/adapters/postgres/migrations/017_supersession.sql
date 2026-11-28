-- 017：`supersedes` 从普通链接升级为一等生命周期语义。
--
-- 背景：v7 之前 `supersedes` 只是 `omb.link` 的任意 relation，旧条目照常参与普通召回、
-- 图扩展与采用率重排，等于把“旧事实”继续当作当前知识。本迁移把生命周期落到
-- `omb.entity`（真值状态 + 有效期），`omb.entity_view` 派生同名过滤列，供检索同事务可见。
--
-- 语义（与 SPEC §5.3/§5.5 一致）：
--   active      当前有效：默认召回/图扩展/重排只看它；
--   superseded  已被新事实取代：`superseded_by/superseded_at/valid_to` 必填，退出当前召回；
--   retracted   已被证伪：`retracted_at/valid_to` 必填，与取代区分（不是“有更新的说法”）；
--   archived    归档：人工/系统保留策略，与 `archived_at` 并存但不互相覆盖：
--               已取代条目之后被归档时 lifecycle 仍是 superseded，只补 archived_at。
--
-- 回填策略（旧数据默认 active）：
--   * `valid_from` 回填为 `created_at`（真实生效时间，不臆造）；
--   * 已归档行回填 `lifecycle='archived'`，与旧 `archived_at` 对齐，unarchive 时还原 active；
--   * **不**从历史 `relation='supersedes'` 链接反推 superseded：无法证明那些边是否真的
--     完成了取代（skill 过去把它当普通标记），按“旧数据默认 active”保留原状，
--     由显式 supersede 迁移；这也避免迁移把仍在使用的当前事实误标成历史。
--
-- 索引：只加一条有真实查询消费者的部分索引（普通召回的默认谓词 `lifecycle='active'`）。
-- 不建 `superseded_by` / `valid_to` 索引：当前没有按它们过滤/排序的 SQL，零查询索引会被
-- 009 contract 的同一标准删除。
--
-- 幂等：只新增列/约束/索引与可重复执行的数据回填，可在已迁移库上重复执行。
-- 回滚（runner 无 down migration，仅在注释里保留）：本迁移只加列/约束/索引，
-- 代码回退到旧版本后新列保持默认值即可；不可逆的是已写入的 lifecycle 值（需业务回滚）。

set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- 1. 生命周期与有效期列（entity 是唯一真源；entity_view 是同事务派生） ----------------
alter table omb.entity add column if not exists lifecycle text not null default 'active';
alter table omb.entity add column if not exists superseded_by text references omb.entity(id) on delete restrict;
alter table omb.entity add column if not exists superseded_at timestamptz;
alter table omb.entity add column if not exists supersede_reason text;
alter table omb.entity add column if not exists retracted_at timestamptz;
alter table omb.entity add column if not exists retracted_reason text;
alter table omb.entity add column if not exists valid_from timestamptz;
alter table omb.entity add column if not exists valid_to timestamptz;

alter table omb.entity_view add column if not exists lifecycle text not null default 'active';

-- 2. 回填：旧数据默认 active；archived_at 与 lifecycle='archived' 对齐 ------------------
-- `entity_touch_updated_at` 会把任何 UPDATE 的 updated_at 刷成 now()；而 updated_at 是召回
-- 新近度、看板水位与基准夹具的证据。回填只搬生命周期列，必须在回填期间关掉该触发器，
-- 否则迁移会把全部旧数据的“最近更新时间”改成迁移时刻（事务内 DDL，失败一起回滚）。
alter table omb.entity disable trigger entity_touch_updated_at;
update omb.entity set valid_from = created_at where valid_from is null;
update omb.entity set lifecycle = 'archived' where archived_at is not null and lifecycle = 'active';
alter table omb.entity enable trigger entity_touch_updated_at;

update omb.entity_view v
   set lifecycle = e.lifecycle
  from omb.entity e
 where e.id = v.entity_id
   and v.lifecycle is distinct from e.lifecycle;

-- 3. 约束（PG 没有 add constraint if not exists，用 DO 块保持幂等） ---------------------
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'entity_lifecycle_check') then
    alter table omb.entity
      add constraint entity_lifecycle_check
      check (lifecycle in ('active', 'superseded', 'retracted', 'archived'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'entity_superseded_fields_check') then
    alter table omb.entity
      add constraint entity_superseded_fields_check
      check (lifecycle <> 'superseded'
             or (superseded_by is not null and superseded_at is not null and valid_to is not null));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'entity_retracted_fields_check') then
    alter table omb.entity
      add constraint entity_retracted_fields_check
      check (lifecycle <> 'retracted' or (retracted_at is not null and valid_to is not null));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'entity_supersede_link_check') then
    -- 一个旧实体只能有一个当前 succeeded-by：superseded_by 非空当且仅当 lifecycle='superseded'。
    alter table omb.entity
      add constraint entity_supersede_link_check
      check ((superseded_by is null) = (lifecycle <> 'superseded'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'entity_supersede_not_self_check') then
    alter table omb.entity
      add constraint entity_supersede_not_self_check
      check (superseded_by is null or superseded_by <> id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'entity_valid_range_check') then
    alter table omb.entity
      add constraint entity_valid_range_check
      check (valid_to is null or valid_from is null or valid_to >= valid_from);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'entity_view_lifecycle_check') then
    alter table omb.entity_view
      add constraint entity_view_lifecycle_check
      check (lifecycle in ('active', 'superseded', 'retracted', 'archived'));
  end if;
end
$$;

-- 4. 索引：普通召回的默认谓词（六通道 scopeClause 都会拼 `v.lifecycle = 'active'`） ------
-- 历史检索（includeSuperseded）仍可用 001 的 entity_view_active_lookup；这里只把
-- “当前有效”编码进部分谓词，避免规划器对每个候选再过滤一次。
create index if not exists entity_view_active_current
  on omb.entity_view (scope, project_key, kind, category)
  where archived_at is null and is_current and lifecycle = 'active';
