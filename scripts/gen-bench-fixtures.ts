// OMB v2 基准 v2 fixture 生成器——CLI 薄壳（developer tooling；施工计划 2026-08-23-bench-v2-contract.md T2.1）。
// 用法：pnpm exec tsx scripts/gen-bench-fixtures.ts [--contracts <dir>] [--fixtures <dir>]
// 读 v2 契约（fail-loud schema 校验）→ 调 reference 计算 expected → 写 kernel/bench-tasks/v2/fixtures/<id>.fixture.json。
// 确定性：同契约同 reference → 同文本（重生成与已提交 fixture 逐字节一致）。
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BenchFixtureV2Schema } from '../kernel/schemas/bench.js';
import { references } from '../kernel/bench-tasks/reference/index.js';
import { BENCH_V2_CONTRACTS_DIR, BENCH_V2_FIXTURES_DIR, loadBenchContractsV2 } from '../supervisor/bench-v2.js';
import { fixtureFileName, generateFixtures, serializeFixtureV2 } from './gen-bench-fixtures-core.js';

const USAGE = `用法：pnpm exec tsx scripts/gen-bench-fixtures.ts [--contracts <dir>] [--fixtures <dir>]
  默认：contracts = kernel/bench-tasks/v2/contracts；fixtures = kernel/bench-tasks/v2/fixtures
  确定性：同契约同 reference → 同文本（重生成与已提交 fixture 逐字节一致）`;

/** CLI 主逻辑（仅直接运行时执行；返回退出码，调用方设置 process.exitCode） */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let contractsDir = BENCH_V2_CONTRACTS_DIR;
  let fixturesDir = BENCH_V2_FIXTURES_DIR;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--contracts' && argv[i + 1] !== undefined) {
      contractsDir = argv[i + 1]!;
      i++;
    } else if (arg === '--fixtures' && argv[i + 1] !== undefined) {
      fixturesDir = argv[i + 1]!;
      i++;
    } else if (arg === '--help' || arg === '-h') {
      console.log(USAGE);
      return 0;
    }
  }
  const contracts = await loadBenchContractsV2(contractsDir);
  const fixtures = generateFixtures(contracts, references);
  await mkdir(fixturesDir, { recursive: true });
  for (const fixture of fixtures) {
    const parsed = BenchFixtureV2Schema.safeParse(fixture);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
      throw new Error(`gen-bench-fixtures: 生成的 fixture 校验失败 ${fixture.task_id}: ${detail}`);
    }
    const file = join(fixturesDir, fixtureFileName(fixture.task_id));
    await writeFile(file, serializeFixtureV2(fixture), 'utf8');
    console.log(`generated ${fixture.task_id} → ${file}`);
  }
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    });
}
