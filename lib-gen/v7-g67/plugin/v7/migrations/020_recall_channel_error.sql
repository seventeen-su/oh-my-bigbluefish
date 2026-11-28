-- 通道失败/deadline 审计（RET-08）。
--
-- recall_event.entity_id 非空且外键到 entity，失败时没有命中实体，无法复用；
-- 单开一张 append-only 审计表，让“这次召回为什么空/哪个通道挂了”在进程退出后仍可查。
-- 只写不更新；trace_id 索引用于和 recall_event / resident_trace 对齐。

create table if not exists omb.recall_channel_error (
  id bigserial primary key,
  trace_id text not null,
  session_id text,
  query text,
  channel text not null,
  code text not null,
  message text not null,
  retryable boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists recall_channel_error_trace
  on omb.recall_channel_error (trace_id);

create index if not exists recall_channel_error_created
  on omb.recall_channel_error (created_at desc);
