-- 单字中文回退：pg_trgm 在 datctype=C 的库里无法为 CJK 生成 trigram。
-- 用字符集合 + GIN 数组包含做候选前过滤，再对候选行做 LIKE 复核。
alter table omb.entity_view add column if not exists chars text[] not null default '{}';

create index if not exists entity_view_chars
  on omb.entity_view using gin (chars);
