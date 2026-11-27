-- OMB v7.x Phase 5 contract：删除 expand 之后已确认零查询的索引与列。
--
-- 约束（ARCHITECTURE-PLAN §4.1 expand–contract、LEGACY §3.1、PLAN Task 20）：
-- * 只删除全仓没有任何 SQL 使用、也没有代码读取的对象（逐个理由见下方“删除清单”）。
-- * 不删仍被写入/映射的列：它们留一个观测窗口，等下一轮证据再 cut（见“留观测窗口”）。
-- * 全部语句幂等（drop ... if exists），可在已迁移库上重复执行；不改任何数据行。
-- * 不触碰 008 创建的 outbox/投影/workflow/timer/boards 等对象（本文件对它们 zero-diff）。
-- * 迁移 runner 在单事务内执行；DROP INDEX 会对表短暂加锁，建议低峰执行。
-- * 不新增/不迁移数据；004/005/006/007 的索引与表都保留。
--
-- 删除清单（零查询 / 零读）：
--   attribute_expr_gin       没有任何 SQL 按 omb.attribute.expr 过滤；expr 列本身保留（动态属性仍写入）。
--   entity_view_search_trgm  全文走 search_tsv @@ + chars GIN；pg_trgm 只用于 snippet/属性名的
--                            similarity()（similar.ts、maintenance.ts），不用于 search_text。
--   entity_view_triggers     触发通道查 omb.trigger_key；entity_view.triggers 列只写不读，列保留。
--   attr_registry_aliases    aliases 只在 renameAttribute 时 array_append，没有任何查询读它；列保留。
--   audit_log.rollback_of    001 建列后从未写入、从未读取；rollback() 只写 rolled_back_at + 新审计行。
--
-- 留观测窗口（本文件不删；仍被写入或映射，删除需要新证据 + 另一次 contract）：
--   entity_view.{revision, confidence, pinned, salience, access_count, adoption_count, triggers}
--     —— upsertView 每次写入（writer.ts）；这些列是 entity 的派生冗余，读取面走 omb.entity。
--   attr_registry.{description, aliases} —— description 当前没有写者；aliases 由 rename 追加。
--   attribute.{expr, confidence, source} —— expr 是动态值真源；confidence/source 由 rows.ts 映射进
--     Attribute，属于对外可观察字段。
--   entity.{last_accessed_at, archive_reason} —— 仍由 archive/读路径映射。
--   include_history —— `SearchBase` 的六通道查询已按它过滤 `is_current`（store.ts scopeClause）；
--     `ReadOptions.includeHistory`（store.get）仍只处理 includeArchived，同名不同义，待收窄类型。
--
-- 不在本轮清单、但值得下一次单独评估（本文件不动，避免扩大 blast radius）：
--   entity_view_snippet_trgm（002）—— `similar.ts` 只对 snippet 做 similarity() 排序，没有 `%`
--     或 LIKE 过滤，索引是否有查询计划收益需要 EXPLAIN 证据；本轮不删。
--   entity_view_attrs_gin —— 过滤面以 scope/kind/status 为主，attrs GIN 是否有消费者同样待证。
--
-- 回滚（runner 没有 down migration，本段只在注释里给出恢复 SQL；不会被执行）：
--   begin;
--     create index if not exists attribute_expr_gin
--       on omb.attribute using gin (expr jsonb_path_ops);
--     create index if not exists entity_view_search_trgm
--       on omb.entity_view using gin (search_text gin_trgm_ops);
--     create index if not exists entity_view_triggers
--       on omb.entity_view using gin (triggers);
--     create index if not exists attr_registry_aliases
--       on omb.attr_registry using gin (aliases);
--     alter table omb.audit_log add column if not exists rollback_of bigint references omb.audit_log(id);
--     delete from omb.schema_migrations where name = '009_contract.sql';
--   commit;
--   注意：schema_migrations.checksum 校验的是本文件内容，回滚后重跑需保持文件不变；
--   反向恢复的是**空** rollback_of 列（001 起本就恒 NULL，无历史数据可丢）。

drop index if exists omb.attribute_expr_gin;
drop index if exists omb.entity_view_search_trgm;
drop index if exists omb.entity_view_triggers;
drop index if exists omb.attr_registry_aliases;

alter table if exists omb.audit_log drop column if exists rollback_of;
