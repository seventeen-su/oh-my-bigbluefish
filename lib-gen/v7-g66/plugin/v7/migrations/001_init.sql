-- OMB v7 initial schema.
-- 属性表是唯一事实来源；entity_view 是同事务派生的过滤视图。
create extension if not exists vector;
create extension if not exists pg_trgm;

create schema if not exists omb;

create table if not exists omb.meta (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists omb.entity (
  id text primary key,
  kind text not null check (kind in ('memory', 'state', 'chain', 'state_version')),
  revision bigint not null default 1 check (revision > 0),
  origin text not null default 'model',
  confidence double precision,
  pinned boolean not null default false,
  salience double precision not null default 0.5,
  access_count integer not null default 0 check (access_count >= 0),
  adoption_count integer not null default 0 check (adoption_count >= 0),
  last_accessed_at timestamptz,
  archived_at timestamptz,
  archive_reason text,
  version_of text references omb.entity(id) on delete restrict,
  is_current boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((kind = 'state_version') = (version_of is not null)),
  check (kind <> 'state_version' or is_current = false)
);

create index if not exists entity_kind_current on omb.entity (kind, is_current) where archived_at is null;
create index if not exists entity_version_of on omb.entity (version_of) where version_of is not null;

create table if not exists omb.attribute (
  entity_id text not null references omb.entity(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 120),
  ordinal integer not null default 0 check (ordinal >= 0),
  value_kind text not null check (value_kind in ('static', 'dynamic')),
  value jsonb,
  expr jsonb,
  cached_value jsonb,
  cached_at timestamptz,
  stale_after_ms integer check (stale_after_ms is null or stale_after_ms >= 0),
  last_error text,
  is_required boolean not null default false,
  confidence double precision,
  source text not null default 'model',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (entity_id, name, ordinal),
  check (value_kind <> 'static' or value is not null),
  check (value_kind <> 'dynamic' or expr is not null),
  check (value_kind <> 'static' or expr is null)
);

create index if not exists attribute_entity on omb.attribute (entity_id);
create index if not exists attribute_name on omb.attribute (name);
create index if not exists attribute_expr_gin on omb.attribute using gin (expr jsonb_path_ops);
create index if not exists attribute_dynamic_due
  on omb.attribute (cached_at, stale_after_ms)
  where value_kind = 'dynamic';

create table if not exists omb.entity_view (
  entity_id text primary key references omb.entity(id) on delete cascade,
  kind text not null,
  category text check (category is null or category in ('fact', 'clue', 'event')),
  scope text not null check (scope in ('global', 'project')),
  project_key text not null default '',
  title text,
  status text check (status is null or status in ('completed', 'in_progress', 'waiting', 'blocked', 'not_started', 'discarded')),
  event_time timestamptz,
  attrs jsonb not null default '{}'::jsonb,
  attr_names text[] not null default '{}',
  search_text text not null default '',
  search_tsv tsvector generated always as (to_tsvector('simple', search_text)) stored,
  triggers text[] not null default '{}',
  is_current boolean not null default true,
  archived_at timestamptz,
  revision bigint not null check (revision > 0),
  confidence double precision,
  pinned boolean not null default false,
  salience double precision not null default 0.5,
  access_count integer not null default 0,
  adoption_count integer not null default 0,
  updated_at timestamptz not null,
  check ((scope = 'global' and project_key = '') or (scope = 'project' and project_key <> '')),
  check (kind <> 'memory' or category is not null),
  check (kind <> 'state' or (status is not null and title is not null and event_time is not null)),
  check (kind <> 'chain' or title is not null),
  check (kind <> 'state_version' or (status is not null and title is not null and event_time is not null))
);

create index if not exists entity_view_active_lookup
  on omb.entity_view (scope, project_key, kind, category)
  where archived_at is null and is_current;
create index if not exists entity_view_status
  on omb.entity_view (kind, status)
  where archived_at is null and is_current;
create index if not exists entity_view_time
  on omb.entity_view (event_time desc nulls last)
  where archived_at is null and is_current;
create index if not exists entity_view_attrs_gin
  on omb.entity_view using gin (attrs jsonb_path_ops);
create index if not exists entity_view_search_trgm
  on omb.entity_view using gin (search_text gin_trgm_ops);
create index if not exists entity_view_search_tsv
  on omb.entity_view using gin (search_tsv);
create index if not exists entity_view_triggers
  on omb.entity_view using gin (triggers);

create table if not exists omb.attr_registry (
  name text primary key check (length(btrim(name)) between 1 and 120),
  description text,
  aliases text[] not null default '{}',
  value_kind text check (value_kind is null or value_kind in ('static', 'dynamic')),
  usage_count integer not null default 0 check (usage_count >= 0),
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now()
);

create index if not exists attr_registry_aliases on omb.attr_registry using gin (aliases);

create table if not exists omb.link (
  id text primary key,
  from_id text not null references omb.entity(id) on delete restrict,
  to_id text not null references omb.entity(id) on delete restrict,
  relation text not null check (length(btrim(relation)) between 1 and 64),
  directed boolean not null default true,
  strength real not null default 0.5 check (strength >= 0 and strength <= 1),
  source text not null default 'model',
  origin text not null default 'model',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  check (from_id <> to_id),
  unique (from_id, to_id, relation, directed)
);

create index if not exists link_from on omb.link (from_id, relation) where archived_at is null;
create index if not exists link_to on omb.link (to_id, relation) where archived_at is null;
create index if not exists link_relation on omb.link (relation) where archived_at is null;

create table if not exists omb.chain_member (
  chain_id text not null references omb.entity(id) on delete restrict,
  member_id text not null references omb.entity(id) on delete restrict,
  role text,
  position integer not null default 0,
  source text not null default 'model',
  added_at timestamptz not null default now(),
  primary key (chain_id, member_id),
  check (chain_id <> member_id)
);

create index if not exists chain_member_member on omb.chain_member (member_id);

create table if not exists omb.trigger_key (
  entity_id text not null references omb.entity(id) on delete cascade,
  kind text not null check (kind in ('path', 'regex', 'tool', 'error', 'entity', 'text')),
  key text not null,
  weight real not null default 1 check (weight > 0),
  primary key (entity_id, kind, key)
);

create index if not exists trigger_key_lookup on omb.trigger_key (kind, key);

create table if not exists omb.reference (
  source_entity_id text not null references omb.entity(id) on delete cascade,
  source_attr_name text not null,
  source_ordinal integer not null default 0,
  target_entity_id text not null references omb.entity(id) on delete restrict,
  target_attr_name text not null default '',
  kind text not null check (kind in ('ref', 'template', 'code')),
  created_at timestamptz not null default now(),
  primary key (source_entity_id, source_attr_name, source_ordinal, target_entity_id, target_attr_name)
);

create index if not exists reference_target on omb.reference (target_entity_id);

create table if not exists omb.embedding (
  entity_id text primary key references omb.entity(id) on delete cascade,
  model text not null,
  dims integer not null check (dims > 0),
  embedding vector(512) not null,
  updated_at timestamptz not null default now()
);

create index if not exists embedding_hnsw
  on omb.embedding using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64);

create table if not exists omb.recall_event (
  id bigserial primary key,
  trace_id text not null,
  session_id text,
  turn_id text,
  query text,
  trigger text,
  entity_id text not null references omb.entity(id) on delete cascade,
  channel text not null,
  rank integer not null,
  raw_score real,
  fused_score real,
  injected boolean not null default false,
  injected_at timestamptz,
  adopted_at timestamptz,
  adoption_kind text,
  created_at timestamptz not null default now()
);

create index if not exists recall_event_trace on omb.recall_event (trace_id);
create index if not exists recall_event_entity on omb.recall_event (entity_id, created_at desc);
create index if not exists recall_event_adoption on omb.recall_event (adopted_at) where adopted_at is not null;

create table if not exists omb.audit_log (
  id bigserial primary key,
  actor text not null,
  action text not null,
  target_ids text[] not null default '{}',
  before jsonb,
  after jsonb,
  inverse jsonb,
  job_id text,
  created_at timestamptz not null default now(),
  rolled_back_at timestamptz,
  rollback_of bigint references omb.audit_log(id)
);

create index if not exists audit_log_target on omb.audit_log using gin (target_ids);
create index if not exists audit_log_created on omb.audit_log (created_at desc);

create table if not exists omb.artifact (
  id text primary key,
  session_id text,
  kind text not null,
  source text not null default 'dsh',
  content text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  processed_at timestamptz
);

create index if not exists artifact_unprocessed on omb.artifact (created_at) where processed_at is null;

create table if not exists omb.conflict_suppression (
  pair_key text primary key,
  reason text,
  created_at timestamptz not null default now()
);

create or replace function omb.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists entity_touch_updated_at on omb.entity;
create trigger entity_touch_updated_at
before update on omb.entity
for each row execute function omb.touch_updated_at();

drop trigger if exists attribute_touch_updated_at on omb.attribute;
create trigger attribute_touch_updated_at
before update on omb.attribute
for each row execute function omb.touch_updated_at();

drop trigger if exists link_touch_updated_at on omb.link;
create trigger link_touch_updated_at
before update on omb.link
for each row execute function omb.touch_updated_at();

insert into omb.meta (key, value)
values
  ('schema_version', '{"version":1}'::jsonb),
  ('embedding', '{"model":"bge-small-zh-v1.5","dims":512}'::jsonb)
on conflict (key) do nothing;
