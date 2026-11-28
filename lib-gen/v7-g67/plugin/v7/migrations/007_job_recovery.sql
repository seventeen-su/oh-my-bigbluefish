-- 同名任务后续成功时写 job-recovered；只为恢复查询加部分索引，不建新表。
create index if not exists audit_log_job_recovered
  on omb.audit_log (created_at desc)
  where action = 'job-recovered';
