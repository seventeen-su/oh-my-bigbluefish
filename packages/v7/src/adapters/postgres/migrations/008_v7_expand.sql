-- OMB v7.x Phase 1 expand：事件账本/outbox、投影、持久工作流、timer、异步读模型。
--
-- 约束（对应 ARCHITECTURE-PLAN §4.2/§4.3/§4.4/§5.2/§5.3、ADR-0007/0008/0011）：
-- * 只新增表/列/索引；旧列语义不变；全部语句幂等，可在已迁移库上重复执行。
-- * audit_log 只追加可空事件列；旧行、旧写入（不填新列）保持有效。
--   audit_log.id 即 DomainEvent.id：outbox.event_id 直接引用它，不再加一份冗余的 text event_id。
-- * 状态值用 check 约束固定；时间一律 timestamptz；payload/state/input/output 一律 jsonb。
-- * 租约约定：worker claim 时置 status='claimed' 并把 available_at 设为“现在 + 租约”，
--   进程崩溃后 available_at 到期即可重领；due 索引同时覆盖 pending/claimed。
-- * 命令幂等由 audit_log.command_id 唯一索引保证（CONCURRENCY §4.2）；工作流幂等由
--   workflow_run.idempotency_key 唯一约束保证；重复投递由 outbox.event_id 唯一索引吸收。

-- 1. audit_log：append-only 事件账本列（全部可空，旧写入无需改动） --------------------
alter table omb.audit_log add column if not exists command_id text;
alter table omb.audit_log add column if not exists idempotency_key text;
alter table omb.audit_log add column if not exists stream_id text;
alter table omb.audit_log add column if not exists stream_version bigint;
alter table omb.audit_log add column if not exists event_type text;
alter table omb.audit_log add column if not exists revision bigint;
alter table omb.audit_log add column if not exists correlation_id text;
alter table omb.audit_log add column if not exists causation_id text;
alter table omb.audit_log add column if not exists actor_kind text;
alter table omb.audit_log add column if not exists prev_hash text;
alter table omb.audit_log add column if not exists hash text;

-- 同一 commandId 只允许一行：重复提交返回首次结果，不产生重复事件（CONCURRENCY §4.2）。
create unique index if not exists audit_log_command_unique
  on omb.audit_log (command_id)
  where command_id is not null;

-- 同一 stream 的版本唯一：并发 CAS 竞争时撞唯一约束，不会静默写出两个同一版本。
create unique index if not exists audit_log_stream_version_unique
  on omb.audit_log (stream_id, stream_version)
  where stream_id is not null and stream_version is not null;

-- 按事件类型看最近事件（outbox 对账/审计查询）。
create index if not exists audit_log_event_type
  on omb.audit_log (event_type, created_at desc)
  where event_type is not null;

-- 2. outbox：事务内追加的可靠发布 -----------------------------------------------------
create table if not exists omb.outbox (
  id bigserial primary key,
  event_id bigint not null references omb.audit_log(id),
  topic text not null,
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'claimed', 'done', 'dead')),
  attempts integer not null default 0 check (attempts >= 0),
  available_at timestamptz not null default now(),
  claimed_at timestamptz,
  last_error text,
  created_at timestamptz not null default now()
);

-- 一个事件只入队一次：reconciliation 重复扫描不会产生第二行。
create unique index if not exists outbox_event_unique on omb.outbox (event_id);

create index if not exists outbox_due
  on omb.outbox (status, available_at)
  where status in ('pending', 'claimed');

-- 3. 投影：任务队列 + 水位 ------------------------------------------------------------
create table if not exists omb.projection_task (
  entity_id text not null references omb.entity(id) on delete cascade,
  projection text not null,
  revision bigint not null check (revision > 0),
  status text not null default 'pending' check (status in ('pending', 'claimed', 'done', 'dead')),
  attempts integer not null default 0 check (attempts >= 0),
  available_at timestamptz not null default now(),
  claimed_at timestamptz,
  last_error text,
  primary key (entity_id, projection)
);

-- worker 按 projection 批量 claim 到期任务；done 行不在索引里，避免读模型膨胀后拖慢队列。
create index if not exists projection_task_due
  on omb.projection_task (projection, status, available_at)
  where status in ('pending', 'claimed');

create table if not exists omb.projection_watermark (
  projection text primary key,
  watermark text not null,
  updated_at timestamptz not null default now()
);

-- 4. 持久工作流 ----------------------------------------------------------------------
create table if not exists omb.workflow_run (
  id text primary key,
  name text not null,
  version integer not null,
  state jsonb not null,
  step text,
  status text not null default 'pending'
    check (status in ('pending', 'running', 'waiting', 'completed', 'failed', 'dead', 'cancelled')),
  attempts integer not null default 0 check (attempts >= 0),
  next_run_at timestamptz,
  idempotency_key text not null unique,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 启动恢复扫 pending/running；waiting 的 next_run_at 到期由 timer/relay 唤醒。
create index if not exists workflow_run_due
  on omb.workflow_run (status, next_run_at)
  where status in ('pending', 'running', 'waiting');

create table if not exists omb.workflow_step (
  run_id text not null references omb.workflow_run(id) on delete cascade,
  step text not null,
  attempt integer not null,
  status text not null default 'running'
    check (status in ('running', 'completed', 'failed', 'compensated')),
  input jsonb,
  output jsonb,
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  compensated_at timestamptz,
  primary key (run_id, step, attempt)
);

-- 重启时找出被中断（running 但没 finished_at）的步骤，用于重放/补偿审计。
create index if not exists workflow_step_running
  on omb.workflow_step (status, started_at)
  where status = 'running';

-- 5. timer：只服务真正需要时间的到期动作 ----------------------------------------------
create table if not exists omb.timer (
  id bigserial primary key,
  topic text not null,
  payload jsonb not null,
  due_at timestamptz not null,
  status text not null default 'pending' check (status in ('pending', 'claimed', 'done', 'dead', 'cancelled')),
  attempts integer not null default 0 check (attempts >= 0),
  claimed_at timestamptz,
  last_error text,
  -- 实体级/业务级去重键：同一 dedupe_key 的定时器改为重置 due_at 而不是再插一行。
  dedupe_key text,
  created_at timestamptz not null default now()
);

create index if not exists timer_due
  on omb.timer (status, due_at)
  where status in ('pending', 'claimed');

-- ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL 可用于幂等重排期。
create unique index if not exists timer_dedupe_unique
  on omb.timer (dedupe_key)
  where dedupe_key is not null;

-- 6. 异步读模型（不是第二真源；由投影 worker 从属性行/事件派生） ----------------------
create table if not exists omb.preference_board (
  entity_id text primary key references omb.entity(id) on delete cascade,
  scope text not null check (scope in ('global', 'project')),
  title text,
  summary text,
  salience real not null,
  -- read-your-writes：与 entity_view.revision 对齐，读模型 revision < token 时等待/回退。
  revision bigint not null check (revision > 0),
  updated_at timestamptz not null
);

-- T0 读“全局偏好按显著度”：scoped 索引避免物化后排序全表。
create index if not exists preference_board_scope
  on omb.preference_board (scope, salience desc);

create table if not exists omb.state_board (
  entity_id text primary key references omb.entity(id) on delete cascade,
  project_key text not null check (project_key <> ''),
  title text,
  status text not null check (status in ('in_progress', 'blocked', 'waiting')),
  event_time timestamptz,
  revision bigint not null check (revision > 0),
  updated_at timestamptz not null
);

-- T0 读“当前项目进行中/阻塞”：project_key 前导列 + 状态 + 时间。
create index if not exists state_board_project
  on omb.state_board (project_key, status, event_time desc nulls last);

create table if not exists omb.adoption_stat (
  entity_id text primary key references omb.entity(id) on delete cascade,
  injected integer not null default 0 check (injected >= 0),
  adopted integer not null default 0 check (adopted >= 0),
  last_adopted_at timestamptz,
  updated_at timestamptz not null
);

create table if not exists omb.co_recall_pair (
  left_id text not null references omb.entity(id) on delete cascade,
  right_id text not null references omb.entity(id) on delete cascade,
  traces integer not null default 0 check (traces >= 0),
  last_seen_at timestamptz not null,
  primary key (left_id, right_id),
  check (left_id < right_id)
);

-- 反向查询“与某条记忆共同召回过的实体”（PK 只覆盖 left_id 前导）。
create index if not exists co_recall_pair_right
  on omb.co_recall_pair (right_id, last_seen_at desc);

create table if not exists omb.similar_cache (
  entity_id text not null references omb.entity(id) on delete cascade,
  candidate_id text not null references omb.entity(id) on delete cascade,
  score real not null,
  reason text not null,
  computed_at timestamptz not null default now(),
  primary key (entity_id, candidate_id),
  check (entity_id <> candidate_id)
);

-- 写后异步相似建议的顶部 K：按 entity 取 score 前 N，不需要排序整表。
create index if not exists similar_cache_lookup
  on omb.similar_cache (entity_id, score desc);
