// T5.2 验证链测试（supervisor/validate.ts，架构 §9.2：G1 静态 → G2 单元 → G3 回放 → 门禁短路）。
// 严格 TDD：本文件先于实现编写并确认失败（功能缺失）。
// 覆盖（brief 测试清单 1-3、7-8 + 契约扩展）：
//   ① G1 拒错：候选对象缺字段（schema 失败）→ G1 拒 + 短路（G2/G3 不跑）
//   ② G1 tsc：kind=code 候选含语法错误文件 → G1 拒（tsc 子进程失败）
//   ③ G2：候选附带测试全过 → ok；含失败用例 → 拒（vitest 子进程）
//   ⑦ CandidateTestPlan schema：gate 枚举非法 / checks 缺失 → 校验拒绝；runVerification 非法 plan fail-loud
//   ⑧ 门禁链：G1 过 + G2 过 + G3 过 → 全链 ok（供 T5.5 晋升）
//   扩展：未知 G1 检查项 → 拒（fail-loud）；G3 fixture 文件缺失 → 拒；G2 期望通过数不足 → 拒；
//        G2 检查项文件不存在（vitest 输出无该文件）→ 拒
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CandidateTestPlanSchema, runVerification, type CandidateTestPlan, type GateResult } from '../../supervisor/validate.js';
import { S2_VALID } from '../m1/ir-samples.js';

// ---- 常量 ----

/** 预设根（= deps.workspace：fixture 解析基准 tests/m5/fixtures/；子进程 cwd 需含 node_modules 以解析工具 bin） */
const WS = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 候选测试文件（真实 vitest 用例，供 G2 子进程执行；2 个通过用例） */
const PASSING_TEST = `import { describe, expect, it } from 'vitest';
describe('candidate add', () => {
  it('adds', () => { expect(1 + 1).toBe(2); });
  it('multiplies', () => { expect(2 * 3).toBe(6); });
});
`;

/** 候选测试文件（1 个失败用例 → G2 拒） */
const FAILING_TEST = `import { expect, it } from 'vitest';
it('fails', () => { expect(1).toBe(2); });
`;

/** kind=code 候选 tsconfig（自包含：noEmit + strict，供 G1 tsc 子进程） */
const CODE_TSCONFIG = JSON.stringify(
  {
    compilerOptions: {
      noEmit: true,
      strict: true,
      target: 'ES2023',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      skipLibCheck: true,
    },
    include: ['**/*.ts'],
  },
  null,
  2,
);

/** 门禁链候选过程（与 tests/m5/fixtures/chain.fixture.json 对应：单 EXECUTE，常量输入 { q: 'hello' }） */
const CHAIN_PROCESS = JSON.stringify(
  {
    id: 'p:chain',
    version: '1.0.0',
    entry: 'EXECUTE',
    exit: 'EXECUTE',
    operators: [{ id: 'EXECUTE', op: 'EXECUTE', input_binding: { q: 'hello' }, output: 'result' }],
  },
  null,
  2,
);

// ---- 测试工具 ----

const dirs: string[] = [];

/** 临时候选目录（mkdtemp；afterEach 清理） */
async function tmpCandidate(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'omb-cand-'));
  dirs.push(dir);
  return dir;
}

beforeEach(() => {
  dirs.length = 0;
});

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const DEPS = (candidateDir: string): { candidateDir: string; workspace: string } => ({ candidateDir, workspace: WS });

// ---- 主测试：验证链（G1 → G2 → G3，门禁短路） ----

describe('G1 静态门（schema / tsc）', () => {
  it('① G1 拒错：候选对象缺字段（schema 失败）→ G1 拒 + 短路（G2/G3 不跑）', async () => {
    const cand = await tmpCandidate();
    await writeFile(join(cand, 'object.json'), JSON.stringify({ id: 'state:broken' }), 'utf8'); // 缺 S2 必填字段
    const plan: CandidateTestPlan = {
      candidate_id: 'c:bad-schema',
      gates: [
        { gate: 'G1', checks: ['schema:S2'] },
        { gate: 'G2', checks: ['tests/never-run.test.ts:1'] }, // 若被跑 → 文件不存在必失败
        { gate: 'G3', checks: [], fixtures: ['never-run.fixture.json'] }, // 若被跑 → 文件不存在必失败
      ],
    };
    const results = await runVerification(plan, DEPS(cand));
    expect(results.length).toBe(1); // 短路：链只含 G1
    expect(results[0]!.gate).toBe('G1');
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.detail).toMatch(/schema|S2|校验|缺/i);
  });

  it('② G1 tsc：kind=code 候选含语法错误文件 → G1 拒（tsc 子进程失败，detail 含错误）', async () => {
    const cand = await tmpCandidate();
    await writeFile(join(cand, 'tsconfig.json'), CODE_TSCONFIG, 'utf8');
    await writeFile(join(cand, 'broken.ts'), 'export function f(x: number): number { return x + ; }', 'utf8');
    const plan: CandidateTestPlan = { candidate_id: 'c:code-bad', gates: [{ gate: 'G1', checks: ['tsc'] }] };
    const results = await runVerification(plan, DEPS(cand));
    expect(results[0]!.gate).toBe('G1');
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.detail).toMatch(/tsc|TS\d{3,}|error/i);
  });

  it('G1 未知检查项 → 拒（fail-loud，不静默跳过）', async () => {
    const cand = await tmpCandidate();
    const plan: CandidateTestPlan = { candidate_id: 'c:unknown-check', gates: [{ gate: 'G1', checks: ['schema:ZZZ'] }] };
    const results = await runVerification(plan, DEPS(cand));
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.detail).toMatch(/未知|未注册|检查项/i);
  });

  it('G1 tsc 缺 tsconfig.json → 拒（fail-loud）', async () => {
    const cand = await tmpCandidate();
    const plan: CandidateTestPlan = { candidate_id: 'c:no-tsconfig', gates: [{ gate: 'G1', checks: ['tsc'] }] };
    const results = await runVerification(plan, DEPS(cand));
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.detail).toMatch(/tsconfig/i);
  });
});

describe('G2 单元测试门（vitest 子进程）', () => {
  it('③a G2：候选附带测试全过 → ok', async () => {
    const cand = await tmpCandidate();
    await mkdir(join(cand, 'tests'));
    await writeFile(join(cand, 'tests', 'add.test.ts'), PASSING_TEST, 'utf8');
    const plan: CandidateTestPlan = {
      candidate_id: 'c:g2-ok',
      gates: [{ gate: 'G2', checks: ['tests/add.test.ts:2'] }],
    };
    const results = await runVerification(plan, DEPS(cand));
    expect(results[0]!.gate).toBe('G2');
    expect(results[0]!.ok).toBe(true);
    expect(results[0]!.detail).toMatch(/G2|通过|add\.test\.ts/i);
  });

  it('③b G2：含失败用例 → 拒（ok:false，detail 含失败信息）', async () => {
    const cand = await tmpCandidate();
    await mkdir(join(cand, 'tests'));
    await writeFile(join(cand, 'tests', 'bad.test.ts'), FAILING_TEST, 'utf8');
    const plan: CandidateTestPlan = {
      candidate_id: 'c:g2-bad',
      gates: [{ gate: 'G2', checks: ['tests/bad.test.ts:1'] }],
    };
    const results = await runVerification(plan, DEPS(cand));
    expect(results[0]!.gate).toBe('G2');
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.detail).toMatch(/G2|失败|failed|exit/i);
  });

  it('G2 期望通过数不足（文件 1 个通过用例，期望 2）→ 拒', async () => {
    const cand = await tmpCandidate();
    await mkdir(join(cand, 'tests'));
    await writeFile(join(cand, 'tests', 'one.test.ts'), `import { expect, it } from 'vitest';\nit('one', () => { expect(1).toBe(1); });\n`, 'utf8');
    const plan: CandidateTestPlan = {
      candidate_id: 'c:g2-undercount',
      gates: [{ gate: 'G2', checks: ['tests/one.test.ts:2'] }],
    };
    const results = await runVerification(plan, DEPS(cand));
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.detail).toMatch(/通过数|期望|不足/i);
  });

  it('G2 检查项文件不存在（vitest 输出无该文件）→ 拒（fail-loud，不静默）', async () => {
    // 候选有真实通过测试（vitest exit 0），但 plan 检查项指向不存在的文件 → 输出解析未命中 → 拒
    const cand = await tmpCandidate();
    await mkdir(join(cand, 'tests'));
    await writeFile(join(cand, 'tests', 'add.test.ts'), PASSING_TEST, 'utf8');
    const plan: CandidateTestPlan = {
      candidate_id: 'c:g2-missing',
      gates: [{ gate: 'G2', checks: ['tests/ghost.test.ts:1'] }],
    };
    const results = await runVerification(plan, DEPS(cand));
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.detail).toMatch(/未找到|ghost/i);
  });
});

describe('G3 回放门（ReplayRunner + fixture 文件）', () => {
  it('G3 fixture 文件缺失 → 拒（fail-loud）', async () => {
    const cand = await tmpCandidate();
    await writeFile(join(cand, 'process.json'), CHAIN_PROCESS, 'utf8');
    const plan: CandidateTestPlan = {
      candidate_id: 'c:g3-missing-fixture',
      gates: [{ gate: 'G3', checks: [], fixtures: ['missing.fixture.json'] }],
    };
    const results = await runVerification(plan, DEPS(cand));
    expect(results[0]!.gate).toBe('G3');
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.detail).toMatch(/fixture|未找到|不存在/i);
  });

  it('G3 候选缺 process.json → 拒（fail-loud）', async () => {
    const cand = await tmpCandidate();
    const plan: CandidateTestPlan = {
      candidate_id: 'c:g3-no-process',
      gates: [{ gate: 'G3', checks: [], fixtures: ['chain.fixture.json'] }],
    };
    const results = await runVerification(plan, DEPS(cand));
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.detail).toMatch(/process/i);
  });
});

describe('CandidateTestPlan schema 与门禁链', () => {
  it('⑦ CandidateTestPlan schema：gate 枚举非法 / checks 缺失 → 校验拒绝', async () => {
    // gate 枚举非法（G4 不存在）
    const badGate = CandidateTestPlanSchema.safeParse({ candidate_id: 'c:1', gates: [{ gate: 'G4', checks: [] }] });
    expect(badGate.success).toBe(false);
    // checks 缺失（必填）
    const noChecks = CandidateTestPlanSchema.safeParse({ candidate_id: 'c:1', gates: [{ gate: 'G1' }] });
    expect(noChecks.success).toBe(false);
    // 合法 plan → 通过
    const ok = CandidateTestPlanSchema.safeParse({
      candidate_id: 'c:1',
      gates: [
        { gate: 'G1', checks: ['schema:S2', 'tsc'] },
        { gate: 'G2', checks: ['tests/a.test.ts:2'] },
        { gate: 'G3', checks: [], fixtures: ['a.fixture.json'] },
      ],
    });
    expect(ok.success).toBe(true);
    // runVerification 非法 plan → fail-loud（rejects）
    const cand = await tmpCandidate();
    await expect(
      runVerification({ candidate_id: 'c:1', gates: [{ gate: 'G4', checks: [] }] } as unknown as CandidateTestPlan, DEPS(cand)),
    ).rejects.toThrow();
  });

  it('⑧ 门禁链：G1 过 + G2 过 + G3 过 → 全链 ok（供 T5.5 晋升）', async () => {
    const cand = await tmpCandidate();
    await writeFile(join(cand, 'object.json'), JSON.stringify(S2_VALID), 'utf8'); // S2 schema 合法对象
    await mkdir(join(cand, 'tests'));
    await writeFile(join(cand, 'tests', 'add.test.ts'), PASSING_TEST, 'utf8');
    await writeFile(join(cand, 'process.json'), CHAIN_PROCESS, 'utf8');
    const plan: CandidateTestPlan = {
      candidate_id: 'c:chain',
      gates: [
        { gate: 'G1', checks: ['schema:S2'] },
        { gate: 'G2', checks: ['tests/add.test.ts:2'] },
        { gate: 'G3', checks: [], fixtures: ['chain.fixture.json'] },
      ],
    };
    const results = await runVerification(plan, DEPS(cand));
    expect(results).toHaveLength(3);
    expect(results[0]).toMatchObject({ gate: 'G1', ok: true });
    expect(results[1]).toMatchObject({ gate: 'G2', ok: true });
    expect(results[2]).toMatchObject({ gate: 'G3', ok: true });
    expect(results.every((r: GateResult) => r.ok)).toBe(true); // 全链 ok（晋升前置）
  });
});
