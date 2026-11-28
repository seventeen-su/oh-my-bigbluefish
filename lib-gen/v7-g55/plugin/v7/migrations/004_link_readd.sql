-- 解链只置 archived_at；旧的全表唯一约束会让同 relation 重链触发 23505。
-- 唯一性只应约束“活跃链接”，归档历史行必须允许保留。
alter table omb.link drop constraint if exists link_from_id_to_id_relation_directed_key;

create unique index if not exists link_active_unique
  on omb.link (from_id, to_id, relation, directed)
  where archived_at is null;
