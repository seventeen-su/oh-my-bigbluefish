-- OMB v7.x 证据账本 + 内容幂等键（review Task 16/17 的剩余项）。
--
-- 约束：
-- * 只新增表/列/索引，不改 001-015；全部语句幂等，可在已迁移库上重复执行。
-- * `evidence` 是线索晋升的唯一证据来源：sourceType 固定 user/tool/file/session/verification，
--   `subjectKey` 表达“同一主题（文件/URL/工单）的多个来源只算一份独立验证”。
--   （两个 session 引用同一文件 → 同一 subjectKey，独立来源计数只 +1，不再只数 session:<id>。）
-- * `entity.content_key` 是记忆内容指纹的 sha256：同一作用域/分类/关键属性/时间完全相同的事实
--   复用原实体（新证据并入 evidence 集），不同项目/不同时间/不同内容的相似事实照常并存。
--   只有 memory 行写 content_key；状态机/思维链走各自收敛键（goalId/autoGroupKey）。
--   唯一性由写事务内的 advisory lock + 活跃行查询保证，不用全表唯一索引，因为归档后
--   同一内容应当可以重新成为新实体（遗忘之后重新记住不能被旧行挡住）。

-- 1. 证据账本 -------------------------------------------------------------------------
create table if not exists omb.evidence (
  id text primary key,
  entity_id text not null references omb.entity(id) on delete cascade,
  source_type text not null check (source_type in ('user', 'tool', 'file', 'session', 'verification')),
  source_id text not null check (length(btrim(source_id)) > 0),
  observed_at timestamptz not null,
  -- 被验证内容的指纹（与 entity.content_key 同一个 sha256 口径）。
  content_hash text not null check (length(content_hash) > 0),
  confidence double precision not null default 0.5 check (confidence >= 0 and confidence <= 1),
  verification_status text not null default 'unverified'
    check (verification_status in ('unverified', 'verified', 'refuted')),
  -- 同一主题的多个来源只算一份独立证据；空串表示按 source_type:source_id 计。
  subject_key text not null default '',
  detail text,
  created_at timestamptz not null default now(),
  -- 同一实体、同一来源、同一内容只留一行：重试/重复写入不会膨胀证据集。
  unique (entity_id, source_type, source_id, content_hash)
);

-- 线索晋升按实体读全部证据；按时间倒序便于审计。
create index if not exists evidence_entity
  on omb.evidence (entity_id, observed_at desc);

-- 系统验证/巡检按内容找证据。
create index if not exists evidence_content
  on omb.evidence (content_hash);

-- 按来源主题聚合独立证据（文件路径等）。
create index if not exists evidence_subject
  on omb.evidence (subject_key)
  where subject_key <> '';

-- 2. 内容幂等键 -----------------------------------------------------------------------
-- 只对记忆写；sha256(canonical content fingerprint)，口径见 domain/content-key.ts。
alter table omb.entity add column if not exists content_key text;

-- 活跃同内容行查询（写事务内 content-dedupe 的定位索引）；归档行不在索引里，
-- 遗忘之后同一内容可以重新写入为独立实体。
create index if not exists entity_content_key
  on omb.entity (content_key)
  where content_key is not null and archived_at is null;
