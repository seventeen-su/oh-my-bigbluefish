-- OMB v7.x：引用依赖失效传播（SPEC §5.2 动态属性、§5.3 引用）。
--
-- 两张表分工：
--   * dynamic_dependency：source 依赖 target 的边（reference 由动态 spec 派生，
--     link 由显式链接维护）；只在 target 列建索引，失效传播按入边收敛，不扫全库。
--   * dynamic_stale：写事务内落下的待刷新标记（按实体+属性去重）；读取时消费，
--     事件驱动的 omb.refresh 按 root 读取，不依赖周期扫描。
--
-- 依赖边不物理删除业务实体：归档 source 时删出边；unlink 时删 link 边；
-- 实体物理删除由外键级联清理（生产路径只有 truncate/回滚测试）。

create table if not exists omb.dynamic_dependency (
  source_entity_id text not null references omb.entity(id) on delete cascade,
  source_attr_name text not null default '',
  source_ordinal integer not null default 0 check (source_ordinal >= 0),
  target_entity_id text not null references omb.entity(id) on delete cascade,
  target_attr_name text not null default '',
  origin text not null check (origin in ('reference', 'link')),
  relation text not null default '',
  created_at timestamptz not null default now(),
  primary key (
    source_entity_id, source_attr_name, source_ordinal,
    target_entity_id, target_attr_name, origin, relation
  ),
  check (source_entity_id <> target_entity_id),
  check (origin <> 'reference' or source_attr_name <> ''),
  check (origin <> 'link' or (source_attr_name = '' and source_ordinal = 0))
);

-- 入边索引是失效传播的唯一热路径：where target_entity_id = any($1)。
create index if not exists dynamic_dependency_target
  on omb.dynamic_dependency (target_entity_id);
-- 写事务整体替换 source 的边、归档清理都按 source 定位。
create index if not exists dynamic_dependency_source
  on omb.dynamic_dependency (source_entity_id);

create table if not exists omb.dynamic_stale (
  entity_id text not null references omb.entity(id) on delete cascade,
  attr_name text not null,
  ordinal integer not null default 0 check (ordinal >= 0),
  root_entity_id text not null references omb.entity(id) on delete cascade,
  operation text not null check (operation in ('patch', 'archive', 'unarchive')),
  depth integer not null default 0 check (depth >= 0),
  reason text not null,
  marked_at timestamptz not null default now(),
  primary key (entity_id, attr_name, ordinal)
);

-- 事件驱动的 refresh 按 root 取一页，深度/陈旧时间排序（直接依赖优先）。
create index if not exists dynamic_stale_root
  on omb.dynamic_stale (root_entity_id, depth, marked_at);
-- 运维/对账只读入口：不做全表扫描，按优先级取最旧标记。
create index if not exists dynamic_stale_priority
  on omb.dynamic_stale (depth, marked_at);

-- 回填已有 reference 派生边：与 012 之前的写入保持等价；状态历史是不可变快照，不建边。
insert into omb.dynamic_dependency (
  source_entity_id, source_attr_name, source_ordinal,
  target_entity_id, target_attr_name, origin, relation
)
select r.source_entity_id, r.source_attr_name, r.source_ordinal,
       r.target_entity_id, r.target_attr_name, 'reference', ''
from omb.reference r
join omb.entity e on e.id = r.source_entity_id
where e.kind <> 'state_version'
on conflict do nothing;

-- 回填 link 边：有向 = 一条（from 依赖 to）；无向 = 双向依赖。
insert into omb.dynamic_dependency (
  source_entity_id, source_attr_name, source_ordinal,
  target_entity_id, target_attr_name, origin, relation
)
select l.from_id, '', 0, l.to_id, '', 'link', l.relation
from omb.link l
where l.archived_at is null and l.from_id <> l.to_id
on conflict do nothing;

insert into omb.dynamic_dependency (
  source_entity_id, source_attr_name, source_ordinal,
  target_entity_id, target_attr_name, origin, relation
)
select l.to_id, '', 0, l.from_id, '', 'link', l.relation
from omb.link l
where l.archived_at is null and l.directed = false and l.from_id <> l.to_id
on conflict do nothing;
