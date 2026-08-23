// kernel/bench-tasks/reference/web-04.ts —— v2 基准 ground truth 权威（施工计划 2026-08-23-bench-v2-contract.md T2.2）。
// 纯函数：固定 input（契约 input_artifacts）→ expected（确定性计算，无 I/O、无随机，只 import 类型与 _helpers）。
// web-04：登录规格（credentials/valid_account/跳转目标）→ 登录结果页面模型 { redirect, session }。
import type { InputArtifactV2 } from '../../schemas/bench.js';
import { deepEqual, findArtifact, requireRecord } from './_helpers.js';

export function reference(input: InputArtifactV2[]): unknown {
  const spec = requireRecord(
    findArtifact(input, 'page_spec').content,
    'web-04 reference: page_spec 输入工件 content 必须为对象',
  );
  const credentials = requireRecord(spec.credentials, 'web-04 reference: page_spec.credentials 必须为对象');
  const validAccount = requireRecord(spec.valid_account, 'web-04 reference: page_spec.valid_account 必须为对象');
  const success = spec.success_redirect;
  const failure = spec.failure_redirect;
  if (typeof success !== 'string' || typeof failure !== 'string') {
    throw new Error('web-04 reference: page_spec 缺 success_redirect/failure_redirect（string）');
  }
  return deepEqual(credentials, validAccount)
    ? { redirect: success, session: 'ok' }
    : { redirect: failure, session: 'invalid' };
}
