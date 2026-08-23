// kernel/bench-tasks/reference/web-02.ts —— v2 基准 ground truth 权威（施工计划 2026-08-23-bench-v2-contract.md T2.2）。
// 纯函数：固定 input（契约 input_artifacts）→ expected（确定性计算，无 I/O、无随机，只 import 类型与 _helpers）。
// web-02：表单规格（fields 含 required/format 校验规则）→ 空提交页面模型 { errors, submitted: false }。
import type { InputArtifactV2 } from '../../schemas/bench.js';
import { findArtifact, requireRecord } from './_helpers.js';

export function reference(input: InputArtifactV2[]): unknown {
  const spec = requireRecord(
    findArtifact(input, 'page_spec').content,
    'web-02 reference: page_spec 输入工件 content 必须为对象',
  );
  if (spec.action !== 'submit_empty') {
    throw new Error(`web-02 reference: 不支持的 action ${String(spec.action)}（仅 submit_empty）`);
  }
  const form = requireRecord(spec.form, 'web-02 reference: page_spec.form 必须为对象');
  const fields = form.fields;
  if (!Array.isArray(fields)) {
    throw new Error('web-02 reference: page_spec.form.fields 必须为数组');
  }
  const errors: string[] = [];
  for (const field of fields) {
    if (field === null || typeof field !== 'object' || Array.isArray(field)) {
      throw new Error('web-02 reference: 表单字段必须为对象');
    }
    const f = field as Record<string, unknown>;
    // 空提交：必填字段触发 required 错误；带格式校验的字段触发格式错误
    if (f.required === true && typeof f.error_required === 'string') {
      errors.push(f.error_required);
    }
    if (f.format === 'email' && typeof f.error_format === 'string') {
      errors.push(f.error_format);
    }
  }
  return { errors, submitted: false };
}
