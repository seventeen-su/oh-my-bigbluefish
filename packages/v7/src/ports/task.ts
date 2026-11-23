import type { JsonValue } from '../domain/json.js'

export interface TaskReader {
  /**
   * 读取 DSH 任务；`caller` 是发起读取的会话 id。
   *
   * DSH 的 `jobs.read(id, caller?)` 对 owner 有围栏：省略 caller 只能读 unowned job，
   * 读当前会话自己的 job 会抛 unknown/foreign。动态属性刷新必须把会话传下来。
   */
  read(source: 'subagent' | 'team' | 'job', id: string, field?: string, caller?: string): Promise<JsonValue | undefined>
}
