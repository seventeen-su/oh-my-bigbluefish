// T2.2 行为测试：v2 契约化基准全量 20 任务（契约 + reference + fixtures + 回放；施工计划 2026-08-23-bench-v2-contract.md）。
// 与 tests/m7/bench-v2.test.ts（T2.1 框架测试）互补：本文件锁定 T2.2 交付物——
//   ① 20 契约 zod 校验 + 文件名 ↔ id 一一对应 + 类别↔verifier 映射 + generator 元数据统一；
//   ② 全部 20 reference 确定性（两次调用深相等）；
//   ③ 全部 20 自洽性：reference(input) 过 output_schema（0 错误）且 verifyV2 通过；
//   ④ 反例抽样：形状错/值错输出 → 失败且 reason 合理（覆盖全部 5 种 verifier kind）；
//   ⑤ runBenchV2 回放 20/20 + JSONL 落盘 + 两次运行确定性；
//   ⑥ 生成器重生成 == 已提交 fixtures（LF 规范化逐字节一致；CLI 路径一致）；
//   ⑦ 契约质量不变量：code 含 test-cases+language；web 谓词 path 在 output_schema 内可达；
//      research rules.rubric.required_terms == 输入 rubric；sys-04 file-list 含确定性 constraints。
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BenchContractV2Schema,
  type OutputFieldV2,
  type OutputSchemaV2,
} from '../../kernel/schemas/bench.js';
import {
  BENCH_V2_CONTRACTS_DIR,
  BENCH_V2_FIXTURES_DIR,
  loadBenchContractsV2,
  loadBenchFixturesV2,
  makeReplayExecutorV2,
  runBenchV2,
  validateOutputSchema,
  verifyV2,
} from '../../supervisor/bench-v2.js';
import { getReference, references } from '../../kernel/bench-tasks/reference/index.js';
import { generateFixtures, serializeFixtureV2 } from '../../scripts/gen-bench-fixtures-core.js';
import { main as genFixturesMain } from '../../scripts/gen-bench-fixtures.js';

/** 冻结集全量 20 任务 id（5 类 × 4；按字典序，与 Array.sort() 语义一致） */
const BENCH_V2_ALL_IDS = [
  'code-01', 'code-02', 'code-03', 'code-04',
  'data-01', 'data-02', 'data-03', 'data-04',
  'research-01', 'research-02', 'research-03', 'research-04',
  'sys-01', 'sys-02', 'sys-03', 'sys-04',
  'web-01', 'web-02', 'web-03', 'web-04',
];

/** 规范化行尾（工作区 CRLF（autocrlf）下逐字节比较仍成立） */
function normalizeEol(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

/** 临时目录工具 */
async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'omb-bench-v2-t22-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** 谓词 path 是否在 output_schema 内可达（'a.b.c'：逐段下钻 properties） */
function schemaPathExists(schema: OutputSchemaV2, path: string): boolean {
  let current: OutputFieldV2 | OutputSchemaV2 = schema;
  const segments = path.split('.');
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!;
    if (
      current.type !== 'object' ||
      current.properties === undefined ||
      !Object.prototype.hasOwnProperty.call(current.properties, segment)
    ) {
      return false;
    }
    const field = current.properties[segment]!;
    if (i === segments.length - 1) {
      return true;
    }
    current = field;
  }
  return false;
}

describe('① 全量 20 契约（zod + 文件名↔id + 类别↔verifier + generator 元数据）', () => {
  it('契约目录恰 20 个文件；全部过 zod；文件名与 id 一一对应', async () => {
    const files = (await readdir(BENCH_V2_CONTRACTS_DIR))
      .filter((f) => f.endsWith('.json'))
      .sort();
    expect(files).toHaveLength(20);
    for (const file of files) {
      const parsed = BenchContractV2Schema.safeParse(
        JSON.parse(await readFile(join(BENCH_V2_CONTRACTS_DIR, file), 'utf8')),
      );
      expect(parsed.success, file).toBe(true);
      expect(file, file).toBe(`${parsed.data!.id}.json`);
    }
    const contracts = await loadBenchContractsV2();
    expect(contracts.map((c) => c.id).sort()).toEqual(BENCH_V2_ALL_IDS);
  });

  it('fixture 目录恰 20 个文件；task_id 与文件名一一对应', async () => {
    const files = (await readdir(BENCH_V2_FIXTURES_DIR))
      .filter((f) => f.endsWith('.json'))
      .sort();
    expect(files).toHaveLength(20);
    const fixtures = await loadBenchFixturesV2();
    expect(fixtures.map((f) => f.task_id).sort()).toEqual(BENCH_V2_ALL_IDS);
    for (const f of fixtures) {
      expect(files).toContain(`${f.task_id}.fixture.json`);
    }
  });

  it('类别→verifier 映射符合 §15（code→tests / data→exact / web→predicate / sys→state_assert / research→blind_judge）', async () => {
    const contracts = await loadBenchContractsV2();
    for (const c of contracts) {
      expect(BenchContractV2Schema.safeParse(c).success, c.id).toBe(true); // refine 内含映射守卫
    }
  });

  it('所有契约 generator 元数据统一为 { name: "<id> reference", version: "1.0.0" }', async () => {
    const contracts = await loadBenchContractsV2();
    for (const c of contracts) {
      expect(c.generator.name, c.id).toBe(`${c.id} reference`);
      expect(c.generator.version, c.id).toBe('1.0.0');
    }
  });

  it('每个契约都有 reference 实现（注册表 20 项，fail-loud 取用不抛）', async () => {
    expect(references.size).toBe(20);
    const contracts = await loadBenchContractsV2();
    for (const c of contracts) {
      expect(() => getReference(c.id)).not.toThrow();
    }
  });
});

describe('② reference 确定性（同 input 两次调用深相等；v2 ground truth 权威）', () => {
  it('全部 20 个 reference 两次调用 → 深相等', async () => {
    const contracts = await loadBenchContractsV2();
    for (const c of contracts) {
      const fn = getReference(c.id);
      expect(fn(c.input_artifacts), c.id).toEqual(fn(c.input_artifacts));
    }
  });

  it('生成器两次运行 → 序列化逐字节一致（确定性）', async () => {
    const contracts = await loadBenchContractsV2();
    const a = generateFixtures(contracts, references).map(serializeFixtureV2).join('');
    const b = generateFixtures(contracts, references).map(serializeFixtureV2).join('');
    expect(b).toBe(a);
  });
});

describe('③ 全量 20 自洽性（reference 输出过 schema + verifyV2 全通过）', () => {
  it('reference(input) 过各自契约 output_schema（0 错误）', async () => {
    const contracts = await loadBenchContractsV2();
    for (const c of contracts) {
      const expected = getReference(c.id)(c.input_artifacts);
      expect(validateOutputSchema(expected, c.output_schema), c.id).toEqual([]);
    }
  });

  it('verifyV2(contract, fixture, reference(input)) 全部通过（schema + verifier 双通过）', async () => {
    const contracts = await loadBenchContractsV2();
    const fixtures = await loadBenchFixturesV2();
    for (const c of contracts) {
      const f = fixtures.find((x) => x.task_id === c.id)!;
      const expected = getReference(c.id)(c.input_artifacts);
      const verdict = verifyV2(c, f, expected);
      expect(verdict.passed, `${c.id}: ${verdict.reason}`).toBe(true);
    }
  });

  it('已提交 fixture.expected 与 reference(input) 深相等（重生成完整性）', async () => {
    const contracts = await loadBenchContractsV2();
    const fixtures = await loadBenchFixturesV2();
    for (const c of contracts) {
      const f = fixtures.find((x) => x.task_id === c.id)!;
      expect(f.expected, c.id).toEqual(getReference(c.id)(c.input_artifacts));
      expect(f.output, c.id).toEqual(f.expected);
    }
  });
});

describe('④ 反例抽样（形状错/值错输出 → 失败且 reason 合理；覆盖全部 5 种 verifier kind）', () => {
  it('code-01 形状错（缺 required failed 字段）→ schema 失败且 reason 含字段名', async () => {
    const c = (await loadBenchContractsV2()).find((x) => x.id === 'code-01')!;
    const f = (await loadBenchFixturesV2()).find((x) => x.task_id === 'code-01')!;
    const verdict = verifyV2(c, f, { passed: 5, total: 5 });
    expect(verdict.passed).toBe(false);
    expect(verdict.reason).toContain('schema');
    expect(verdict.reason).toContain('failed');
  });

  it('code-01 值错（通过 schema 但 ≠ expected）→ tests 失败且 reason 含不一致', async () => {
    const c = (await loadBenchContractsV2()).find((x) => x.id === 'code-01')!;
    const f = (await loadBenchFixturesV2()).find((x) => x.task_id === 'code-01')!;
    const verdict = verifyV2(c, f, { passed: 4, failed: 1, total: 5 });
    expect(verdict.passed).toBe(false);
    expect(verdict.reason).toContain('tests');
    expect(verdict.reason).toContain('不一致');
  });

  it('data-02 形状错（rows 元素 id 为 number 而非 string）→ schema 失败', async () => {
    const c = (await loadBenchContractsV2()).find((x) => x.id === 'data-02')!;
    const f = (await loadBenchFixturesV2()).find((x) => x.task_id === 'data-02')!;
    const verdict = verifyV2(c, f, { rows: [{ id: 1, name: 'A', price: '9.9' }] });
    expect(verdict.passed).toBe(false);
    expect(verdict.reason).toContain('schema');
  });

  it('web-01 值错（title 不匹配谓词）→ predicate 失败', async () => {
    const c = (await loadBenchContractsV2()).find((x) => x.id === 'web-01')!;
    const f = (await loadBenchFixturesV2()).find((x) => x.task_id === 'web-01')!;
    const verdict = verifyV2(c, f, { title: '别的', nav: { items: ['首页', '文档', '关于'] }, count: 3 });
    expect(verdict.passed).toBe(false);
    expect(verdict.reason).toContain('predicate');
  });

  it('research-01 值错（answer 缺必需术语）→ blind_judge 失败', async () => {
    const c = (await loadBenchContractsV2()).find((x) => x.id === 'research-01')!;
    const f = (await loadBenchFixturesV2()).find((x) => x.task_id === 'research-01')!;
    const verdict = verifyV2(c, f, { answer: '缺少必需术语的回答' });
    expect(verdict.passed).toBe(false);
    expect(verdict.reason).toContain('blind_judge');
    expect(verdict.reason).toContain('缺少必需术语');
  });

  it('sys-02 值错（after 状态 ≠ expected）→ state_assert 失败', async () => {
    const c = (await loadBenchContractsV2()).find((x) => x.id === 'sys-02')!;
    const f = (await loadBenchFixturesV2()).find((x) => x.task_id === 'sys-02')!;
    const verdict = verifyV2(c, f, {
      before: { 'svc.status': 'stopped' },
      after: { 'svc.status': 'paused' },
    });
    expect(verdict.passed).toBe(false);
    expect(verdict.reason).toContain('state_assert');
    expect(verdict.reason).toContain('不一致');
  });
});

describe('⑤ runBenchV2 回放（20/20 + JSONL 落盘 + 确定性）', () => {
  it('回放：全部契约全过，total/passed = 20', async () => {
    const contracts = await loadBenchContractsV2();
    const fixtures = await loadBenchFixturesV2();
    const report = await runBenchV2({
      contracts,
      fixtures,
      line: 'stable',
      executor: makeReplayExecutorV2(fixtures),
    });
    expect(report.total).toBe(20);
    expect(report.passed).toBe(20);
    expect(report.results.every((r) => r.passed)).toBe(true);
  });

  it('JSONL 落盘：20 条记录，全部 passed=true 且 failure_reason=null', async () => {
    await withTempDir(async (dir) => {
      const contracts = await loadBenchContractsV2();
      const fixtures = await loadBenchFixturesV2();
      await runBenchV2({
        contracts,
        fixtures,
        line: 'stable',
        executor: makeReplayExecutorV2(fixtures),
        mode: 'replay',
        persistDir: dir,
      });
      const files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl'));
      expect(files).toHaveLength(1);
      const lines = (await readFile(join(dir, files[0]!), 'utf8')).trim().split('\n');
      expect(lines).toHaveLength(20);
      const taskIds = lines.map((line) => (JSON.parse(line) as { task_id: string }).task_id).sort();
      expect(taskIds).toEqual(BENCH_V2_ALL_IDS);
      for (const line of lines) {
        const record = JSON.parse(line) as {
          passed: boolean;
          failure_reason: unknown;
          verifier_kind: string;
        };
        expect(record.passed).toBe(true);
        expect(record.failure_reason).toBeNull();
        expect(record.verifier_kind).toEqual(expect.any(String));
      }
    });
  });

  it('确定性：同输入跑两次 → 报告逐位一致', async () => {
    const contracts = await loadBenchContractsV2();
    const fixtures = await loadBenchFixturesV2();
    const executor = makeReplayExecutorV2(fixtures);
    const r1 = await runBenchV2({ contracts, fixtures, line: 'initial', executor });
    const r2 = await runBenchV2({ contracts, fixtures, line: 'initial', executor });
    expect(r2).toEqual(r1);
  });
});

describe('⑥ 生成器重生成 == 已提交 fixtures（LF 规范化逐字节一致）', () => {
  it('generateFixtures 序列化 == 已提交文件（逐契约逐字节）', async () => {
    const contracts = await loadBenchContractsV2();
    const generated = generateFixtures(contracts, references);
    for (const g of generated) {
      const committed = normalizeEol(
        await readFile(join(BENCH_V2_FIXTURES_DIR, `${g.task_id}.fixture.json`), 'utf8'),
      );
      expect(serializeFixtureV2(g), g.task_id).toBe(committed);
    }
  });

  it('CLI 生成到临时目录 → 与已提交 fixtures 逐字节一致（main 薄壳路径）', async () => {
    await withTempDir(async (dir) => {
      await genFixturesMain(['--fixtures', dir]);
      for (const id of BENCH_V2_ALL_IDS) {
        const generated = normalizeEol(await readFile(join(dir, `${id}.fixture.json`), 'utf8'));
        const committed = normalizeEol(
          await readFile(join(BENCH_V2_FIXTURES_DIR, `${id}.fixture.json`), 'utf8'),
        );
        expect(generated, id).toBe(committed);
      }
    });
  });
});

describe('⑦ 契约质量不变量（防四要素漂移）', () => {
  it('code-*：input 含 test-cases（name+input+expected）与 language（text）；output_schema 为 passed/failed/total', async () => {
    const contracts = (await loadBenchContractsV2()).filter((c) => c.category === 'code');
    expect(contracts).toHaveLength(4);
    for (const c of contracts) {
      const names = c.input_artifacts.map((a) => a.name);
      expect(names, c.id).toContain('test-cases');
      expect(names, c.id).toContain('language');
      const cases = c.input_artifacts.find((a) => a.name === 'test-cases')!;
      expect(cases.kind, c.id).toBe('test-cases');
      expect(Array.isArray(cases.content), c.id).toBe(true);
      for (const testCase of cases.content as Array<Record<string, unknown>>) {
        expect(testCase.name, c.id).toEqual(expect.any(String));
        expect(Object.prototype.hasOwnProperty.call(testCase, 'input'), c.id).toBe(true);
        expect(Object.prototype.hasOwnProperty.call(testCase, 'expected'), c.id).toBe(true);
      }
      expect(c.output_schema.required.sort(), c.id).toEqual(['failed', 'passed', 'total']);
    }
  });

  it('web-*：全部谓词 path 在 output_schema 内可达（predicate 与 schema 同源）', async () => {
    const contracts = (await loadBenchContractsV2()).filter((c) => c.category === 'web');
    expect(contracts).toHaveLength(4);
    for (const c of contracts) {
      const predicates = c.verifier.rules?.predicates as Array<{ path: string }> | undefined;
      expect(Array.isArray(predicates) && predicates.length > 0, c.id).toBe(true);
      for (const predicate of predicates!) {
        expect(schemaPathExists(c.output_schema, predicate.path), `${c.id}: ${predicate.path}`).toBe(true);
      }
    }
  });

  it('research-*：verifier rules.rubric.required_terms 与输入 rubric 一致', async () => {
    const contracts = (await loadBenchContractsV2()).filter((c) => c.category === 'research');
    expect(contracts).toHaveLength(4);
    for (const c of contracts) {
      const input = c.input_artifacts.find((a) => a.name === 'task')!;
      const inputTerms = ((input.content as { rubric: { required_terms: string[] } }).rubric)
        .required_terms;
      const ruleTerms = (c.verifier.rules?.rubric as { required_terms: string[] }).required_terms;
      expect(ruleTerms, c.id).toEqual(inputTerms);
      expect(inputTerms.length, c.id).toBeGreaterThan(0);
    }
  });

  it('sys-04：file-list 工件带确定性 constraints { path, sorted: true, recursive: false }（ChatGPT 意见 4）', async () => {
    const c = (await loadBenchContractsV2()).find((x) => x.id === 'sys-04')!;
    const fileList = c.input_artifacts.find((a) => a.name === 'src_files')!;
    expect(fileList.kind).toBe('file-list');
    expect(fileList.constraints).toEqual({ path: 'src', sorted: true, recursive: false });
  });

  it('state_assert 契约：requirement 必须显式声明状态值编码（防真实执行编码漂移，2026-08-23 sys-03/04 实测教训）', async () => {
    const contracts = (await loadBenchContractsV2()).filter((c) => c.verifier.kind === 'state_assert');
    expect(contracts.length).toBeGreaterThanOrEqual(4);
    for (const c of contracts) {
      const req = c.requirement;
      expect(req, `${c.id}: state_assert requirement 须含值域/映射声明`).toMatch(/值域|映射|null|'exists'|"exists"/);
    }
  });

  it('data-*：input 为真实数据工件且量级适中（3~8 条 / 非空文本）', async () => {
    const contracts = (await loadBenchContractsV2()).filter((c) => c.category === 'data');
    expect(contracts).toHaveLength(4);
    for (const c of contracts) {
      for (const artifact of c.input_artifacts) {
        if (artifact.kind === 'json') {
          const content = artifact.content;
          if (Array.isArray(content)) {
            expect(content.length, `${c.id}: ${artifact.name}`).toBeGreaterThanOrEqual(3);
            expect(content.length, `${c.id}: ${artifact.name}`).toBeLessThanOrEqual(8);
          }
        }
      }
    }
  });
});
