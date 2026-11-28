-- OMB v7.x contract：删除已确认零运行时读取的旧列/派生冗余列。
--
-- 依据：历史旧字段审计与用户 2026-11-28 的直接删除授权。
-- 约束：
-- * 本迁移与代码同批发布：`entity_view` 的 8 个派生列已从 writer/rows 停写，
--   `chain_member.source` 已从写路径移除；旧进程（g55 之前）不能与 011 同时运行。
-- * 不删除任何仍被运行时读取、公共 API 返回或审计哈希链依赖的列（见 P0 清单）。
-- * 表很小（entity_view 67 行、chain_member 144 行、attr_registry 42 行、audit_log 297 行），
--   但仍设置 lock_timeout，避免 DDL 排队拖死写入。
-- * 回滚：仅结构可逆；被删列数据需从备份恢复（默认全为 NULL/派生冗余）。
--
-- P3（零写零读）：
--   attr_registry.description、chain_member.role、audit_log.idempotency_key
-- P1（停写后删除）：
--   entity_view.{revision,confidence,pinned,salience,access_count,adoption_count,triggers,attr_names}
--   chain_member.source
--
-- P2 决策（本迁移不删）：
--   attr_registry.aliases 保留并接入 similarAttributes（改名学习）；
--   chain_member.position 保留并作为 expand 的 chainPosition 暴露；
--   entity.last_accessed_at、attribute.confidence 保留为公共 API 字段；
--   omb.meta 保留并接入 omb_status；
--   attr_registry.{value_kind,first_seen,last_seen} 保留为注册表诊断元数据。

set local lock_timeout = '5s';
set local statement_timeout = '120s';

alter table omb.attr_registry drop column if exists description;
alter table omb.chain_member drop column if exists role;
alter table omb.audit_log drop column if exists idempotency_key;

alter table omb.entity_view
  drop column if exists revision,
  drop column if exists confidence,
  drop column if exists pinned,
  drop column if exists salience,
  drop column if exists access_count,
  drop column if exists adoption_count,
  drop column if exists triggers,
  drop column if exists attr_names;

alter table omb.chain_member drop column if exists source;

