-- 013_adoption_metrics.sql
--
-- 采用证据四态：Exposure（只进入上下文，不加分）→ Reference（明确引用，弱证据）
-- → Utilization（实际参与工具参数/决策/代码修改，按 session+task 可追溯）
-- → Validation（用户确认、测试通过、任务完成等强证据）；另有 Refutation 负向证据。
--
-- 关键约束：
-- 1. 同一 (entity_id, session_id, task_id) 只算一个独立使用机会；重复召回只增加
--    exposures，不重复累计成功次数。
-- 2. access_count/retrieved_count 只是“看见”的审计，不参与显著度/遗忘；
--    Reference/Utilization/Validation 才按受控权重进入 utility_confidence。
-- 3. 旧 adopted_at/adoption_kind/adoption_count 保留兼容读；旧字符串命中最多回填为
--    Referenced 候选（legacy_adopted_count），绝不回填成 Validated。
--
-- 编号按任务约定使用 013；迁移执行器按文件名排序、只应用未记录的文件，
-- 因此不依赖 012 是否存在，也不改动 001–012 的内容。

alter table omb.recall_event
  -- 内部幂等标记：一条 trace 的 Retrieved 只计一次。
  add column if not exists retrieved_counted boolean not null default false,
  -- 事件级证据（按 trace 审计；指标按 usage_opportunity 聚合）。
  add column if not exists referenced_at timestamptz,
  add column if not exists reference_kind text,
  add column if not exists reference_source text,
  add column if not exists utilized_at timestamptz,
  add column if not exists utilization_kind text,
  add column if not exists utilization_source text,
  add column if not exists validated_at timestamptz,
  add column if not exists validation_kind text,
  add column if not exists validation_source text,
  add column if not exists validation_evidence jsonb,
  add column if not exists refuted_at timestamptz,
  add column if not exists refutation_kind text,
  add column if not exists refutation_source text,
  add column if not exists refutation_evidence jsonb;

create index if not exists recall_event_validated
  on omb.recall_event (entity_id, validated_at desc)
  where validated_at is not null;

-- 一次“使用机会”：同一实体在同一 session 的同一 task 里被注入/引用/使用/验证，
-- 全部折叠到一行；任务边界来自 goal/team-task 事件，没有任务时用 'session'。
create table if not exists omb.usage_opportunity (
  entity_id text not null references omb.entity(id) on delete cascade,
  session_id text not null,
  task_id text not null,
  -- 重复召回次数：只做审计/去重证据，不进入 utility_confidence 的分子。
  exposures integer not null default 0 check (exposures >= 0),
  exposed_at timestamptz not null default now(),
  referenced_at timestamptz,
  reference_kind text,
  reference_source text,
  utilized_at timestamptz,
  utilization_kind text,
  utilization_source text,
  validated_at timestamptz,
  validation_kind text,
  validation_source text,
  validation_evidence jsonb,
  refuted_at timestamptz,
  refutation_kind text,
  refutation_source text,
  refutation_evidence jsonb,
  last_trace_id text,
  updated_at timestamptz not null default now(),
  primary key (entity_id, session_id, task_id)
);

create index if not exists usage_opportunity_session
  on omb.usage_opportunity (session_id, entity_id);

-- 每条实体的聚合计数；由 store 在同事务内增量维护，读取是 O(1) 查一行。
-- utility/refutation 的置信度由读取方按计数即时计算，不把“点估计”伪装成概率。
create table if not exists omb.adoption_metric (
  entity_id text primary key references omb.entity(id) on delete cascade,
  -- 旧口径：真正注入过的 distinct trace 数，仅观测。
  retrieved_count bigint not null default 0 check (retrieved_count >= 0),
  -- 独立使用机会：distinct (session_id, task_id)。
  opportunities bigint not null default 0 check (opportunities >= 0),
  referenced_count bigint not null default 0 check (referenced_count >= 0),
  utilized_count bigint not null default 0 check (utilized_count >= 0),
  validated_count bigint not null default 0 check (validated_count >= 0),
  refuted_count bigint not null default 0 check (refuted_count >= 0),
  -- 旧字符串命中回填，永远不进入 utility_confidence/重排/遗忘。
  legacy_adopted_count bigint not null default 0 check (legacy_adopted_count >= 0),
  last_retrieved_at timestamptz,
  last_referenced_at timestamptz,
  last_utilized_at timestamptz,
  last_validated_at timestamptz,
  last_refuted_at timestamptz,
  updated_at timestamptz not null default now()
);

-- 保守回填（一次性）：
-- - 旧 adopted_at 来自“标题或 ID 出现在文本里”，最多只是 Reference 候选；
--   降级到 referenced_*，validated_* 留空；
-- - legacy_adopted_count 单独保存旧口径供兼容审计，新逻辑不读；
-- - 不从旧数据虚构 usage_opportunity（旧事件没有 task 边界），新机会从新证据开始。
update omb.recall_event
set retrieved_counted = injected,
    referenced_at = case
      when injected and adopted_at is not null then adopted_at
      else referenced_at
    end,
    reference_kind = case
      when injected and adopted_at is not null and referenced_at is null
        then coalesce(adoption_kind, 'legacy')
      else reference_kind
    end,
    reference_source = case
      when injected and adopted_at is not null and referenced_at is null
        then 'legacy-adoption'
      else reference_source
    end
where (injected and not retrieved_counted)
   or (injected and adopted_at is not null and referenced_at is null);

insert into omb.adoption_metric (
  entity_id, retrieved_count, legacy_adopted_count,
  last_retrieved_at, updated_at
)
select entity_id,
       count(distinct trace_id) filter (where injected)::bigint as retrieved_count,
       count(distinct trace_id) filter (where injected and adopted_at is not null)::bigint as legacy_adopted_count,
       max(injected_at) filter (where injected) as last_retrieved_at,
       max(created_at) as updated_at
from omb.recall_event
group by entity_id
on conflict (entity_id) do nothing;
