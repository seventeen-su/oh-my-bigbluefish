-- 010：outbox dead-letter replay 的查找索引。
-- 008 的 outbox_due 只覆盖 pending/claimed；replay/status 按 status='dead' 过滤，
-- 历史表变大后会退化为顺序扫描。只索引 dead 行，不增加热写路径的索引维护成本。
create index if not exists outbox_dead_lookup
  on omb.outbox (topic, id)
  where status = 'dead';
