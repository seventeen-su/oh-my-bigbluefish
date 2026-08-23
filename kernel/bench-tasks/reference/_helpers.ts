// kernel/bench-tasks/reference/_helpers.ts —— v2 reference 共用纯函数辅助（施工计划 2026-08-23-bench-v2-contract.md T2.2）。
// 纯函数：JSON 深拷贝 / 深比较 / 输入工件查找 / 对象守卫 / 测试用例执行器 / research rubric 自检；无 I/O、无随机。
import type { InputArtifactV2 } from '../../schemas/bench.js';

/** JSON 兼容值深拷贝（数组/嵌套对象/基本类型；null 原样；契约输入为 JSON 数据，不含循环引用） */
export function deepClone<T>(value: T): T {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((element) => deepClone(element)) as unknown as T;
  }
  const result: Record<string, unknown> = {};
  for (const [key, element] of Object.entries(value as Record<string, unknown>)) {
    result[key] = deepClone(element);
  }
  return result as T;
}

/** JSON 兼容值深比较（数组有序；对象键无序；基本类型按 ===） */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return false;
  }
  if (Array.isArray(a) !== Array.isArray(b)) {
    return false;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((element, index) => deepEqual(element, b[index]));
  }
  const aRecord = a as Record<string, unknown>;
  const bRecord = b as Record<string, unknown>;
  const aKeys = Object.keys(aRecord);
  return (
    aKeys.length === Object.keys(bRecord).length &&
    aKeys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(bRecord, key) && deepEqual(aRecord[key], bRecord[key]),
    )
  );
}

/** 按名取输入工件；缺失 → fail-loud（契约与 reference 数据完整性守卫） */
export function findArtifact(input: InputArtifactV2[], name: string): InputArtifactV2 {
  const artifact = input.find((a) => a.name === name);
  if (artifact === undefined) {
    throw new Error(`reference: 缺少输入工件 ${name}`);
  }
  return artifact;
}

/** 值必须是纯对象（非 null / 非数组），否则 fail-loud；返回可下标访问的记录视图 */
export function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(message);
  }
  return value as Record<string, unknown>;
}

/** 测试用例执行器（code-* 共用）：{name,input,expected}[] × 判定函数 → {passed,failed,total}（静态推演摘要） */
export function runTestCases(
  cases: unknown,
  run: (input: unknown) => unknown,
): { passed: number; failed: number; total: number } {
  if (!Array.isArray(cases)) {
    throw new Error('reference: test-cases 输入工件 content 必须为数组');
  }
  let passed = 0;
  let failed = 0;
  for (const testCase of cases) {
    if (testCase === null || typeof testCase !== 'object' || Array.isArray(testCase)) {
      throw new Error('reference: test-cases 元素必须为对象 { name, input, expected }');
    }
    const record = testCase as Record<string, unknown>;
    const actual = run(record.input);
    if (deepEqual(actual, record.expected)) {
      passed++;
    } else {
      failed++;
    }
  }
  return { passed, failed, total: cases.length };
}

/** research-* 自检：规范答案必须覆盖 task.rubric.required_terms 全部术语（防 input 与 answer 漂移） */
export function assertRubricCovered(
  task: Record<string, unknown>,
  answer: string,
  taskId: string,
): void {
  const rubric = task.rubric;
  if (rubric === null || typeof rubric !== 'object' || Array.isArray(rubric)) {
    throw new Error(`${taskId} reference: task.rubric 必须为对象`);
  }
  const terms = (rubric as Record<string, unknown>).required_terms;
  if (!Array.isArray(terms) || terms.length === 0 || !terms.every((t) => typeof t === 'string')) {
    throw new Error(`${taskId} reference: task.rubric.required_terms 必须为非空 string[]`);
  }
  const normalized = answer.toLowerCase();
  for (const term of terms) {
    if (!normalized.includes((term as string).toLowerCase())) {
      throw new Error(`${taskId} reference: 规范答案未覆盖必需术语 ${String(term)}`);
    }
  }
}
