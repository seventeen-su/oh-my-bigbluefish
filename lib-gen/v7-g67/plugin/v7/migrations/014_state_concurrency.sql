-- OMB v7.1.x 状态并发：审计记录执行者类别、来源与条件更新两侧版本。
--
-- 背景：状态更新不只发生在两个 AI 之间——AI 读到 rev N、用户手改产生 rev N+1、
-- AI 再用旧 rev 覆盖用户。CAS 已在写路径强制（patch.expectedRevision 必填），但
-- 「谁写的、以什么版本为基线、为什么跳过」必须可查询，否则冲突只剩一句“版本已变化”。
--
-- 约束：
-- * 只新增列/索引，不改 001–013；全部语句幂等，可在已迁移库上重复执行。
-- * 三列**不进入** auditChainPayload（见 writer-audit.ts）：014 之前的历史行没有它们，
--   加进哈希载荷会让历史行无法重新验链；它们仍是同一事务写入的审计事实。
-- * source 与 entity.origin 分开：自动刷新 actor=system:refresh、source=system:refresh，
--   而实体 origin 仍保留 job，检索先验（rerank）据此继续降权后台写。

alter table omb.audit_log add column if not exists source text;
alter table omb.audit_log add column if not exists expected_revision bigint;
alter table omb.audit_log add column if not exists current_revision bigint;

-- 运维审计按来源回看（谁触发的自动刷新/遗忘）。
create index if not exists audit_log_source_created
  on omb.audit_log (source, created_at desc)
  where source is not null;

-- 自动任务跳过/冲突的审计行：按 action 回看，不扫全表。
create index if not exists audit_log_concurrency_skipped
  on omb.audit_log (action, created_at desc)
  where action in ('auto-status-skipped', 'auto-forget-skipped', 'auto-archive-skipped');
