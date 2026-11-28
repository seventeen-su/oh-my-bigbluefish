-- 任务最终失败写 audit_log；状态查询按 action + 时间倒序取最近失败。
create index if not exists audit_log_job_failure
  on omb.audit_log (created_at desc)
  where action = 'job-final-failure';
