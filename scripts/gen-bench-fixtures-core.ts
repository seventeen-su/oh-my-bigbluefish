// OMB v2 基准 v2 fixture 生成器——核心纯逻辑（施工计划 2026-08-23-bench-v2-contract.md T2.1）。
// 纯函数（无 I/O）：契约数组 + reference 映射 → BenchFixtureV2[]；确定性序列化（固定键序 + 2 空格缩进）。
// CLI 薄壳在 scripts/gen-bench-fixtures.ts（读 contracts → 写 fixtures）。
import type { BenchContractV2, BenchFixtureV2 } from '../kernel/schemas/bench.js';
import type { ReferenceFn } from '../kernel/bench-tasks/reference/index.js';

/** fixture 文件名（<id>.fixture.json；与加载器守卫一致） */
export function fixtureFileName(id: string): string {
  return `${id}.fixture.json`;
}

/** 计算契约的 expected（reference(input) —— v2 ground truth 权威，禁止从 expected 反推 input） */
export function computeExpected(reference: ReferenceFn, contract: BenchContractV2): unknown {
  return reference(contract.input_artifacts);
}

/** 组装 BenchFixtureV2（output = expected，供回放执行器直通；generated_by 复制契约 generator 元数据） */
export function buildFixture(contract: BenchContractV2, expected: unknown): BenchFixtureV2 {
  return {
    task_id: contract.id,
    generated_by: contract.generator,
    input: contract.input_artifacts,
    expected,
    output: expected,
  };
}

/** 确定性序列化：固定键序（构造序）+ 2 空格缩进 + 末尾换行（与仓库 JSON 文件约定一致） */
export function serializeFixtureV2(fixture: BenchFixtureV2): string {
  return `${JSON.stringify(fixture, null, 2)}\n`;
}

/** 逐契约生成夹具（缺 reference → fail-loud；按契约输入顺序，确定性） */
export function generateFixtures(
  contracts: readonly BenchContractV2[],
  references: ReadonlyMap<string, ReferenceFn>,
): BenchFixtureV2[] {
  return contracts.map((contract) => {
    const reference = references.get(contract.id);
    if (reference === undefined) {
      throw new Error(`gen-bench-fixtures: 缺少契约 ${contract.id} 的 reference 实现`);
    }
    return buildFixture(contract, computeExpected(reference, contract));
  });
}
