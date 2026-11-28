-- 视图需要一段人类可读摘要（search_text 是 bigram token，不适合直接展示）。
alter table omb.entity_view add column if not exists snippet text not null default '';

create index if not exists entity_view_snippet_trgm
  on omb.entity_view using gin (snippet gin_trgm_ops);
