-- T0 常驻注入的独立 trace：预算、段落、裁剪证据，不能只靠 recall_event 反推。
create table if not exists omb.resident_trace (
  id bigserial primary key,
  trace_id text not null unique,
  session_id text,
  turn_id text,
  budget_tokens integer not null check (budget_tokens > 0),
  used_tokens integer not null check (used_tokens >= 0 and used_tokens <= budget_tokens),
  text text not null default '',
  sections jsonb not null default '[]'::jsonb,
  dropped_sections text[] not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists resident_trace_session
  on omb.resident_trace (session_id, created_at desc);
