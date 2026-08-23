// T2.1 行为测试：基准 v2 契约化框架（kernel/schemas/bench.ts v2 类型 + supervisor/bench-v2.ts +
// kernel/bench-tasks/reference/ + scripts/gen-bench-fixtures-*；施工计划 2026-08-23-bench-v2-contract.md）。
// 严格 TDD：本文件先于实现编写并确认失败（功能缺失）。
// 覆盖：
//   ① 契约 schema 校验：合法契约过；缺 output_schema 拒；类别→verifier 映射不符拒；
//      file-list 输入缺确定性 constraints（path/sorted/recursive）拒——ChatGPT 意见 4；
//   ② output_schema 校验器：合法输出 0 错；缺 required 字段 / 类型错 / items 类型错 / enum 违例有错；
//   ③ reference 确定性：同 input 两次调用深相等；data-01/sys-01 expected 形状与语义断言；
//   ④ 生成器确定性：两次生成逐字节一致；与已提交 fixture 一致（行尾规范化后逐字节）；CLI 生成到临时目录一致；
//   ⑤ verifyV2：reference 输出 → 通过；形状错（缺字段）→ 失败且 reason 含 schema 错误；值错 → 失败；
//      predicate / blind_judge 规则各对/错一例；
//   ⑥ runBenchV2 回放：2 任务全过、JSONL 落盘字段齐全、两次运行结果一致（确定性）；
//   ⑦ fail-loud：坏契约 / 坏 fixture 文件、契约缺 fixture、回放执行器缺 fixture 均抛错。
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BenchContractV2Schema,
  BenchFixtureV2Schema,
  InputArtifactV2Schema,
  type BenchContractV2,
  type BenchFixtureV2,
  type InputArtifactV2,
  type OutputSchemaV2,
} from '../../kernel/schemas/bench.js';
import {
  BENCH_V2_FIXTURES_DIR,
  loadBenchContractsV2,
  loadBenchFixturesV2,
  makeReplayExecutorV2,
  runBenchV2,
  validateOutputSchema,
  verifyV2,
} from '../../supervisor/bench-v2.js';
import { reference as referenceData01 } from '../../kernel/bench-tasks/reference/data-01.js';
import { reference as referenceSys01 } from '../../kernel/bench-tasks/reference/sys-01.js';
import { getReference, references } from '../../kernel/bench-tasks/reference/index.js';
import { generateFixtures, serializeFixtureV2 } from '../../scripts/gen-bench-fixtures-core.js';
import { main as genFixturesMain } from '../../scripts/gen-bench-fixtures.js';

// ---- 测试工具 ----

/** 输入工件工厂 */
function artifact(overrides: Partial<InputArtifactV2> = {}): InputArtifactV2 {
  return { name: 'a', description: 'd', kind: 'json', content: 1, ...overrides };
}

/** v2 契约工厂（category 默认 data，与 verifier exact 匹配） */
function contract(overrides: Partial<BenchContractV2> = {}): BenchContractV2 {
  return {
    id: 'test-01',
    category: 'data',
    requirement: '测试契约',
    input_artifacts: [artifact({ name: 'users', content: [] })],
    output_schema: {
      type: 'object',
      properties: { users: { type: 'array', items: { type: 'object' } } },
      required: ['users'],
    },
    verifier: { kind: 'exact' },
    generator: { name: 'gen-bench-fixtures', version: '0.1.0' },
    ...overrides,
  };
}

/** v2 夹具工厂 */
function fixture(overrides: Partial<BenchFixtureV2> = {}): BenchFixtureV2 {
  return {
    task_id: 'test-01',
    generated_by: { name: 'gen-bench-fixtures', version: '0.1.0' },
    input: [],
    expected: { ok: true },
    output: { ok: true },
    ...overrides,
  };
}

/** 临时目录工具（坏数据文件 fail-loud 测试用） */
async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'omb-bench-v2-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** 规范化行尾（工作区 CRLF（autocrlf）下逐字节比较仍成立） */
function normalizeEol(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

describe('① 契约 schema 校验（BenchContractV2Schema）', () => {
  it('合法契约通过（含最小 output_schema / verifier / generator）', () => {
    expect(BenchContractV2Schema.safeParse(contract()).success).toBe(true);
  });

  it('缺 output_schema → 拒绝（四要素契约缺一不可）', () => {
    const c = contract() as Partial<BenchContractV2>;
    delete c.output_schema;
    expect(BenchContractV2Schema.safeParse(c).success).toBe(false);
  });

  it('缺 requirement / input_artifacts / verifier / generator → 拒绝', () => {
    const missingRequirement = contract() as Partial<BenchContractV2>;
    delete missingRequirement.requirement;
    expect(BenchContractV2Schema.safeParse(missingRequirement).success).toBe(false);
    const missingInput = contract() as Partial<BenchContractV2>;
    delete missingInput.input_artifacts;
    expect(BenchContractV2Schema.safeParse(missingInput).success).toBe(false);
    const missingVerifier = contract() as Partial<BenchContractV2>;
    delete missingVerifier.verifier;
    expect(BenchContractV2Schema.safeParse(missingVerifier).success).toBe(false);
    const missingGenerator = contract() as Partial<BenchContractV2>;
    delete missingGenerator.generator;
    expect(BenchContractV2Schema.safeParse(missingGenerator).success).toBe(false);
  });

  it('类别→verifier 映射不符拒绝（data 配 tests，§15 映射为数据完整性规则）', () => {
    expect(
      BenchContractV2Schema.safeParse(contract({ verifier: { kind: 'tests' } })).success,
    ).toBe(false);
  });

  it('file-list 输入缺确定性 constraints（path/sorted/recursive）拒绝；齐备通过（ChatGPT 意见 4）', () => {
    const fileList = artifact({ kind: 'file-list', content: [], constraints: undefined });
    expect(InputArtifactV2Schema.safeParse(fileList).success).toBe(false);
    const complete = artifact({
      kind: 'file-list',
      content: [],
      constraints: { path: 'src', sorted: true, recursive: false },
    });
    expect(InputArtifactV2Schema.safeParse(complete).success).toBe(true);
  });

  it('实际契约目录：全部文件加载且过 schema（加载器 + 文件名=id 守卫）', async () => {
    const contracts = await loadBenchContractsV2();
    expect(contracts.length).toBeGreaterThanOrEqual(2);
    for (const c of contracts) {
      expect(BenchContractV2Schema.safeParse(c).success, c.id).toBe(true);
    }
    expect(contracts.map((c) => c.id).sort()).toEqual(['data-01', 'sys-01']);
  });
});

describe('② output_schema 校验器（validateOutputSchema）', () => {
  const schema: OutputSchemaV2 = {
    type: 'object',
    properties: {
      users: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            email: { type: 'string' },
          },
        },
      },
      version: { type: 'number', enum: [1, 2] },
    },
    required: ['users'],
  };

  it('合法输出 → 0 错误', () => {
    expect(
      validateOutputSchema(
        { users: [{ id: 'u1', name: 'Alice', email: 'a@b.c' }], version: 1 },
        schema,
      ),
    ).toEqual([]);
  });

  it('缺 required 字段 → 错误（含字段名）', () => {
    const errors = validateOutputSchema({ version: 1 }, schema);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('users');
  });

  it('顶层类型错（非对象）→ 错误', () => {
    expect(validateOutputSchema('nope', schema).length).toBeGreaterThan(0);
    expect(validateOutputSchema([1], schema).length).toBeGreaterThan(0);
    expect(validateOutputSchema(null, schema).length).toBeGreaterThan(0);
  });

  it('属性类型错（users 应为数组，实为字符串）→ 错误', () => {
    expect(validateOutputSchema({ users: 'oops' }, schema).length).toBeGreaterThan(0);
  });

  it('数组 items 类型错（行应为对象，实为字符串）→ 错误', () => {
    expect(validateOutputSchema({ users: ['oops'] }, schema).length).toBeGreaterThan(0);
  });

  it('enum 违例（version=3 不在 [1,2]）→ 错误', () => {
    const errors = validateOutputSchema({ users: [], version: 3 }, schema);
    expect(errors.some((e) => e.includes('enum'))).toBe(true);
  });
});

describe('③ reference 确定性（同 input 两次调用深相等；v2 ground truth 权威）', () => {
  it('data-01：同 input 两次 → 深相等', async () => {
    const c = (await loadBenchContractsV2()).find((x) => x.id === 'data-01');
    expect(c).toBeDefined();
    const input = c!.input_artifacts;
    expect(referenceData01(input)).toEqual(referenceData01(input));
  });

  it('sys-01：同 input 两次 → 深相等', async () => {
    const c = (await loadBenchContractsV2()).find((x) => x.id === 'sys-01');
    expect(c).toBeDefined();
    const input = c!.input_artifacts;
    expect(referenceSys01(input)).toEqual(referenceSys01(input));
  });

  it('data-01 expected 语义：去除缺 email 的无效行，字段顺序固定 id/name/email', async () => {
    const c = (await loadBenchContractsV2()).find((x) => x.id === 'data-01');
    const expected = referenceData01(c!.input_artifacts) as { users: unknown[] };
    expect(expected.users).toHaveLength(3);
    expect(expected.users).toEqual([
      { id: 'u1', name: 'Alice', email: 'alice@example.com' },
      { id: 'u2', name: 'Bob', email: 'bob@example.com' },
      { id: 'u3', name: 'Carol', email: 'carol@example.com' },
    ]);
  });

  it('sys-01 expected 语义：create → before 文件缺席（null）+ after 内容写入', async () => {
    const c = (await loadBenchContractsV2()).find((x) => x.id === 'sys-01');
    const expected = referenceSys01(c!.input_artifacts) as {
      before: Record<string, unknown>;
      after: Record<string, unknown>;
    };
    expect(expected.before).toEqual({ 'config.ini': null });
    expect(expected.after).toEqual({ 'config.ini': '[settings]\nenabled=true' });
  });

  it('reference 输出过各自契约 output_schema（0 错误）', async () => {
    const contracts = await loadBenchContractsV2();
    for (const c of contracts) {
      const expected = getReference(c.id)(c.input_artifacts);
      expect(validateOutputSchema(expected, c.output_schema), c.id).toEqual([]);
    }
  });
});

describe('④ 生成器确定性（generateFixtures + serializeFixtureV2）', () => {
  it('两次生成 → 序列化文本逐字节一致', async () => {
    const contracts = await loadBenchContractsV2();
    const a = generateFixtures(contracts, references).map(serializeFixtureV2).join('');
    const b = generateFixtures(contracts, references).map(serializeFixtureV2).join('');
    expect(b).toBe(a);
  });

  it('生成结果与已提交 fixture 一致（行尾规范化后逐字节 + 深相等）', async () => {
    const contracts = await loadBenchContractsV2();
    const generated = generateFixtures(contracts, references);
    for (const g of generated) {
      const file = join(BENCH_V2_FIXTURES_DIR, `${g.task_id}.fixture.json`);
      const committedText = normalizeEol(await readFile(file, 'utf8'));
      expect(serializeFixtureV2(g), g.task_id).toBe(committedText);
      expect(JSON.parse(committedText)).toEqual(g);
    }
  });

  it('CLI 生成到临时目录 → 与已提交 fixture 逐字节一致（main 薄壳路径）', async () => {
    await withTempDir(async (dir) => {
      await genFixturesMain(['--fixtures', dir]);
      for (const id of ['data-01', 'sys-01']) {
        const generated = normalizeEol(await readFile(join(dir, `${id}.fixture.json`), 'utf8'));
        const committed = normalizeEol(
          await readFile(join(BENCH_V2_FIXTURES_DIR, `${id}.fixture.json`), 'utf8'),
        );
        expect(generated, id).toBe(committed);
      }
    });
  });

  it('夹具结构：task_id/generated_by/input/expected/output 齐全且 output === expected', async () => {
    const contracts = await loadBenchContractsV2();
    for (const g of generateFixtures(contracts, references)) {
      expect(BenchFixtureV2Schema.safeParse(g).success, g.task_id).toBe(true);
      expect(g.output).toEqual(g.expected);
      expect(g.task_id).toBe(contracts.find((c) => c.id === g.task_id)?.id);
      expect(g.generated_by.name.length).toBeGreaterThan(0);
      expect(g.generated_by.version.length).toBeGreaterThan(0);
    }
  });
});

describe('⑤ verifyV2（schema 校验 → kind 规则）', () => {
  it('reference 输出 → 通过（data-01/sys-01 全链一致）', async () => {
    const contracts = await loadBenchContractsV2();
    const fixtures = await loadBenchFixturesV2();
    for (const c of contracts) {
      const f = fixtures.find((x) => x.task_id === c.id)!;
      expect(verifyV2(c, f, f.output).passed, c.id).toBe(true);
    }
  });

  it('形状错（缺 required 字段）→ 失败且 reason 含 schema 错误', async () => {
    const contracts = await loadBenchContractsV2();
    const fixtures = await loadBenchFixturesV2();
    const c = contracts.find((x) => x.id === 'data-01')!;
    const f = fixtures.find((x) => x.task_id === 'data-01')!;
    const verdict = verifyV2(c, f, {});
    expect(verdict.passed).toBe(false);
    expect(verdict.reason).toContain('schema');
    expect(verdict.reason).toContain('users');
  });

  it('值错（通过 schema 但 ≠ expected）→ 失败', async () => {
    const contracts = await loadBenchContractsV2();
    const fixtures = await loadBenchFixturesV2();
    const c = contracts.find((x) => x.id === 'data-01')!;
    const f = fixtures.find((x) => x.task_id === 'data-01')!;
    const verdict = verifyV2(c, f, { users: [{ id: 'u1', name: 'Alice', email: 'wrong@x.y' }] });
    expect(verdict.passed).toBe(false);
    expect(verdict.reason).toContain('exact');
  });

  it('predicate：rules.predicates 全部满足 → 通过；任一不满足 → 失败', () => {
    const c = contract({
      category: 'web',
      output_schema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          nav: { type: 'object', properties: { items: { type: 'array', items: { type: 'string' } } } },
        },
        required: ['title', 'nav'],
      },
      verifier: {
        kind: 'predicate',
        rules: {
          predicates: [
            { path: 'title', matches: 'OMB' },
            { path: 'nav.items', contains: '文档' },
          ],
        },
      },
    });
    const f = fixture({ expected: { title: 'OMB 文档中心', nav: { items: ['首页', '文档'] } } });
    expect(verifyV2(c, f, { title: 'OMB 文档中心', nav: { items: ['首页', '文档'] } }).passed).toBe(true);
    expect(verifyV2(c, f, { title: '别的', nav: { items: ['首页', '文档'] } }).passed).toBe(false);
  });

  it('blind_judge：rules.rubric.required_terms 全部出现（大小写不敏感）→ 通过；缺一 → 失败', () => {
    // OutputSchemaV2 顶层为 object（契约规范形状）；文本输出以 { answer } 承载，术语检查对 stringify 后文本进行
    const c = contract({
      category: 'research',
      output_schema: {
        type: 'object',
        properties: { answer: { type: 'string' } },
        required: ['answer'],
      },
      verifier: { kind: 'blind_judge', rules: { rubric: { required_terms: ['SQLite', 'FTS5'] } } },
    });
    const f = fixture({ expected: { answer: '采用 SQLite 与 FTS5' } });
    expect(verifyV2(c, f, { answer: '采用 SQLite 与 FTS5' }).passed).toBe(true);
    expect(verifyV2(c, f, { answer: '采用 sqlite 和 fts5 存储' }).passed).toBe(true);
    expect(verifyV2(c, f, { answer: '采用 SQLite' }).passed).toBe(false);
    expect(verifyV2(c, f, { answer: '' }).passed).toBe(false);
  });
});

describe('⑥ runBenchV2 回放（2 任务全过 + JSONL 落盘 + 确定性）', () => {
  it('回放：contracts × replay executor → 2 任务全过，汇总 total/passed 正确', async () => {
    const contracts = await loadBenchContractsV2();
    const fixtures = await loadBenchFixturesV2();
    const report = await runBenchV2({
      contracts,
      fixtures,
      line: 'stable',
      executor: makeReplayExecutorV2(fixtures),
    });
    expect(report.line).toBe('stable');
    expect(report.total).toBe(2);
    expect(report.passed).toBe(2);
    expect(report.results).toHaveLength(2);
    expect(report.results.every((r) => r.passed)).toBe(true);
    expect(report.results.map((r) => r.task_id).sort()).toEqual(['data-01', 'sys-01']);
  });

  it('JSONL 落盘字段齐全（文件名 replay-v2-<line>-<ts>.jsonl；逐条含全字段 + cost 八字段）', async () => {
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
      expect(files[0]).toMatch(/^replay-v2-stable-.*\.jsonl$/);
      const lines = (await readFile(join(dir, files[0]!), 'utf8')).trim().split('\n');
      expect(lines).toHaveLength(2);
      for (const line of lines) {
        const record = JSON.parse(line) as Record<string, unknown>;
        expect(record.ts).toEqual(expect.any(Number));
        expect(record.task_id).toEqual(expect.any(String));
        expect(record.mode).toBe('replay');
        expect(record.line).toBe('stable');
        expect(record.passed).toBe(true);
        expect(record.verifier_kind).toEqual(expect.any(String));
        expect(record.failure_reason).toBeNull();
        expect(record.output).toBeDefined();
        expect(record.cost).toEqual(expect.any(Object));
        expect(Object.keys(record.cost as object).sort()).toEqual([
          'branch_count',
          'corrections',
          'latency_ms',
          'memory_pollution',
          'model_tokens',
          'reacquisition',
          'retrieval_calls',
          'tool_calls',
        ]);
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
    expect(r2.passed).toBe(r1.passed);
  });
});

describe('⑦ fail-loud（非法契约/夹具/缺 fixture）', () => {
  it('坏契约文件 → loadBenchContractsV2 抛错', async () => {
    await withTempDir(async (dir) => {
      await writeFile(
        join(dir, 'bad.json'),
        JSON.stringify({ id: 'bad', category: 'data', requirement: 'x', verifier: { kind: 'exact' } }),
        'utf8',
      );
      await expect(loadBenchContractsV2(dir)).rejects.toThrow(/契约校验失败/);
    });
  });

  it('坏 fixture 文件 → loadBenchFixturesV2 抛错', async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, 'bad.fixture.json'), JSON.stringify({ task_id: 'bad' }), 'utf8');
      await expect(loadBenchFixturesV2(dir)).rejects.toThrow(/fixture 校验失败/);
    });
  });

  it('契约缺对应 fixture → runBenchV2 抛错（数据完整性守卫）', async () => {
    const contracts = await loadBenchContractsV2();
    const fixtures = (await loadBenchFixturesV2()).filter((f) => f.task_id !== 'data-01');
    await expect(
      runBenchV2({ contracts, fixtures, line: 'stable', executor: makeReplayExecutorV2(fixtures) }),
    ).rejects.toThrow(/缺 fixture/);
  });

  it('回放执行器缺契约 fixture → 抛错', async () => {
    const contracts = await loadBenchContractsV2();
    const fixtures = (await loadBenchFixturesV2()).filter((f) => f.task_id !== 'sys-01');
    const executor = makeReplayExecutorV2(fixtures);
    const sys01 = contracts.find((c) => c.id === 'sys-01')!;
    await expect(executor(sys01)).rejects.toThrow(/缺契约 sys-01 的 fixture/);
  });
});
