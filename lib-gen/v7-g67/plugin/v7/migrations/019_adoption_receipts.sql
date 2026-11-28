-- 019_adoption_receipts.sql
--
-- 采用证据的唯一来源：真实注入的 receipt（T0 常驻 / T1 事件召回 / T2 工具检索）。
-- `omb.recall_event` 从此只做事件级审计：伪造 recall_event 或 markRecallInjected
-- 不再增加 Retrieved、使用机会、Referenced/Utilized/Validated。
--
-- 结构：
--   adoption_receipt       一次注入（trace_id 主键）：kind/session/task/预算/textHash；
--   adoption_receipt_hit   逐实体处置：kept / quarantined / dropped，主键 (trace_id, entity_id)；
--   adoption_exposure      (trace_id, entity_id) 级曝光去重：同一次注入重复登记只算一次 exposures。
--
-- 约束：
--   1. Retrieval 只按 disposition='kept' 的 distinct receipt 计数；quarantined（原文未注入）
--      与 dropped（预算/去重未展示）只留审计，**不能**升采用；
--   2. 使用机会仍是 (entity_id, session_id, task_id) 主键；重复 receipt 只增加 exposures；
--   3. 不虚构 usage_opportunity / Referenced / Utilized / Validated，旧数据只做保守回填。
--
-- 回填：
--   - 从 `resident_trace`（006 起就是 T0/T1 注入证据）重建 receipt/hit；
--   - 新 receipt 的 `injection-receipt` JSON 带逐实体 `entities`（state=kept/quarantined）：
--     只按它记账，没有条目的实体就是未展示，**不写** dropped；
--   - 旧 T1 receipt 没有 entities 时按其 keptIds/quarantinedIds、旧 T0 按
--     sections[].entityIds + kept/quarantined 判定；
--   - 没有 receipt 的旧 recall_event 计数被清零（它可被伪造，不能作为采用依据）。
--
-- 注意：019 在本分支尚未发布/合并；逐实体 contract 合入后可直接修改本文件并重置测试库
-- checksum。已发布的 001–018 仍不可修改。

create table if not exists omb.adoption_receipt (
  trace_id text primary key,
  receipt_id text,
  kind text not null check (kind in ('t0', 't1', 't2')),
  session_id text,
  turn_id text,
  task_id text,
  scenario text,
  source text,
  budget_tokens integer check (budget_tokens is null or budget_tokens >= 0),
  used_tokens integer not null default 0 check (used_tokens >= 0),
  injected boolean not null default false,
  text_hash text,
  text text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists adoption_receipt_session
  on omb.adoption_receipt (session_id, created_at desc);

create table if not exists omb.adoption_receipt_hit (
  trace_id text not null references omb.adoption_receipt(trace_id) on delete cascade,
  entity_id text not null references omb.entity(id) on delete cascade,
  disposition text not null check (disposition in ('kept', 'quarantined', 'dropped')),
  title text,
  updated_at timestamptz,
  -- 注入文本中的展示顺序；用于回放/审计，不参与门控。
  rank integer,
  source text not null default 'receipt',
  created_at timestamptz not null default now(),
  primary key (trace_id, entity_id)
);

create index if not exists adoption_receipt_hit_entity
  on omb.adoption_receipt_hit (entity_id, disposition);

-- 曝光去重：同一 receipt 对同一实体只登记一次；重复调用不重复累计 exposures。
-- 不同 receipt（换一次注入）才增加 exposures，但仍折叠到同一个 (entity, session, task) 机会。
create table if not exists omb.adoption_exposure (
  trace_id text not null,
  entity_id text not null references omb.entity(id) on delete cascade,
  session_id text not null,
  task_id text not null,
  created_at timestamptz not null default now(),
  primary key (trace_id, entity_id)
);

create index if not exists adoption_exposure_entity
  on omb.adoption_exposure (entity_id, session_id);

-- --- 回填 1/3：resident_trace → adoption_receipt ---------------------------
insert into omb.adoption_receipt (
  trace_id, kind, session_id, turn_id, budget_tokens, used_tokens, injected, text, source, created_at
)
select
  t.trace_id,
  case
    when jsonb_array_length(t.sections) = 1
     and t.sections->0->>'name' = 'injection-receipt' then 't1'
    else 't0'
  end,
  t.session_id,
  t.turn_id,
  t.budget_tokens,
  t.used_tokens,
  coalesce(
    (select (s->>'kept')::boolean
       from jsonb_array_elements(t.sections) s
      where s->>'name' = 'injection-receipt'
      limit 1),
    t.used_tokens > 0
  ),
  t.text,
  'resident-trace-backfill',
  t.created_at
from omb.resident_trace t
on conflict (trace_id) do nothing;

-- --- 回填 2/3a：逐实体 entities（T0/T1 新 receipt）优先 ----------------------
-- 新 receipt 的 injection-receipt JSON 带 entities：只记 kept/quarantined，
-- 未展示实体没有条目（不写 dropped）。这是 adoption 的唯一权威来源。
with trace_entities as (
  select
    t.trace_id,
    t.created_at,
    item.entity_json->>'entityId' as entity_id,
    item.entity_json->>'state' as state,
    nullif(item.entity_json->>'title', '') as title,
    nullif(item.entity_json->>'updatedAt', '') as updated_at,
    item.ordinality
  from omb.resident_trace t
  cross join lateral (
    select section_value as section
      from jsonb_array_elements(t.sections) as rs(section_value)
     where section_value->>'name' = 'injection-receipt'
     limit 1
  ) receipt_section
  cross join lateral jsonb_array_elements(
    case
      when (receipt_section.section->>'text') ~ '^\s*\{'
       and jsonb_typeof((receipt_section.section->>'text')::jsonb->'entities') = 'array'
      then (receipt_section.section->>'text')::jsonb->'entities'
      else '[]'::jsonb
    end
  ) with ordinality as item(entity_json, ordinality)
  where jsonb_typeof(
    case when (receipt_section.section->>'text') ~ '^\s*\{'
         then (receipt_section.section->>'text')::jsonb->'entities'
         else null end
  ) = 'array'
    and item.entity_json->>'state' in ('kept', 'quarantined')
    and nullif(item.entity_json->>'entityId', '') is not null
)
insert into omb.adoption_receipt_hit (
  trace_id, entity_id, disposition, title, updated_at, rank, source, created_at
)
select
  trace_entities.trace_id,
  trace_entities.entity_id,
  trace_entities.state,
  case when trace_entities.state = 'kept' then trace_entities.title end,
  case
    when trace_entities.state = 'kept'
     and trace_entities.updated_at ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
    then trace_entities.updated_at::timestamptz
  end,
  trace_entities.ordinality::int,
  'resident-trace-entities-backfill',
  trace_entities.created_at
from trace_entities
join omb.entity en on en.id = trace_entities.entity_id
on conflict (trace_id, entity_id) do nothing;

-- --- 回填 2/3b：旧 T0（无 entities）退回 sections ---------------------------
insert into omb.adoption_receipt_hit (trace_id, entity_id, disposition, source, created_at)
select
  t.trace_id,
  e.entity_id,
  case
    when coalesce((s->>'quarantined')::boolean, false) then 'quarantined'
    when coalesce((s->>'kept')::boolean, false) then 'kept'
    else 'dropped'
  end,
  'resident-trace-backfill',
  t.created_at
from omb.resident_trace t
cross join lateral jsonb_array_elements(t.sections) s
cross join lateral jsonb_array_elements_text(coalesce(s->'entityIds', '[]'::jsonb)) as e(entity_id)
join omb.entity en on en.id = e.entity_id
where not (jsonb_array_length(t.sections) = 1 and t.sections->0->>'name' = 'injection-receipt')
  and coalesce(s->>'name', '') <> 'injection-receipt'
  and jsonb_array_length(coalesce(s->'entityIds', '[]'::jsonb)) > 0
  and not coalesce((
    select jsonb_typeof(
      case when (rs->>'text') ~ '^\s*\{'
           then (rs->>'text')::jsonb->'entities'
           else null end
    ) = 'array'
    from jsonb_array_elements(t.sections) rs
    where rs->>'name' = 'injection-receipt'
    limit 1
  ), false)
on conflict (trace_id, entity_id) do nothing;

-- --- 回填 2/3c：旧 T1（无 entities）按 keptIds/quarantinedIds 判定 ----------
insert into omb.adoption_receipt_hit (trace_id, entity_id, disposition, source, created_at)
select
  t.trace_id,
  e.entity_id,
  case
    when e.entity_id = any(array(
      select jsonb_array_elements_text(
        case when (t.sections->0->>'text') ~ '^\s*\{'
             then (t.sections->0->>'text')::jsonb->'quarantinedIds'
             else '[]'::jsonb end
      )
    )) then 'quarantined'
    when e.entity_id = any(array(
      select jsonb_array_elements_text(
        case when (t.sections->0->>'text') ~ '^\s*\{'
             then (t.sections->0->>'text')::jsonb->'keptIds'
             else '[]'::jsonb end
      )
    )) then 'kept'
    else 'dropped'
  end,
  'resident-trace-backfill',
  t.created_at
from omb.resident_trace t
cross join lateral jsonb_array_elements_text(
  case when (t.sections->0->>'text') ~ '^\s*\{'
       then coalesce((t.sections->0->>'text')::jsonb->'keptIds', '[]'::jsonb)
       else '[]'::jsonb end
) as e(entity_id)
join omb.entity en on en.id = e.entity_id
where jsonb_array_length(t.sections) = 1
  and t.sections->0->>'name' = 'injection-receipt'
  and coalesce(jsonb_typeof(
    case when (t.sections->0->>'text') ~ '^\s*\{'
         then (t.sections->0->>'text')::jsonb->'entities'
         else null end
  ) = 'array', false) = false
on conflict (trace_id, entity_id) do nothing;

-- --- 回填 3/3：retrieved_count 只按 receipt 的 kept 重算 --------------------
insert into omb.adoption_metric (entity_id, retrieved_count, last_retrieved_at, updated_at)
select
  entity_id,
  count(distinct trace_id)::bigint,
  max(created_at),
  now()
from omb.adoption_receipt_hit
where disposition = 'kept'
group by entity_id
on conflict (entity_id) do update
  set retrieved_count = excluded.retrieved_count,
      last_retrieved_at = excluded.last_retrieved_at,
      updated_at = now();

-- 没有任何 kept receipt 的旧计数清零：旧 recall_event 口径可被伪造，不再是采用依据。
update omb.adoption_metric m
   set retrieved_count = 0,
       last_retrieved_at = null,
       updated_at = now()
 where not exists (
   select 1
     from omb.adoption_receipt_hit h
    where h.entity_id = m.entity_id
      and h.disposition = 'kept'
 );
