// OMB v2 验证链执行器（架构 §9.2：G1 静态 → G2 单元/属性测试 → G3 历史回放（确定性 fixture）→ 门禁短路；
// 施工计划 T5.2）：layer 1。
//
// CandidateTestPlan（机制即数据，zod 校验）：
//   { candidate_id, gates: [{ gate: 'G1'|'G2'|'G3', checks: string[], fixtures?: string[] }] }
//   - G1.checks：schema 校验项 'schema:<对象编号>'（T1.1 OMB_OBJECTS，校验 candidateDir/object.json）；
//     'tsc'（L1 代码候选：node <workspace>/node_modules/typescript/bin/tsc --noEmit -p
//     <candidateDir>/tsconfig.json，子进程 60s 超时）；
//     未知检查项 → fail-loud（不静默跳过；命名规则类检查为后续扩展点）。
//   - G2.checks：单元测试项 '<测试文件>:<期望通过数>'（文件相对 candidateDir）；
//     vitest 子进程（node <workspace>/node_modules/vitest/vitest.mjs run --root <candidateDir>
//     --reporter=basic --no-cache）解析每文件通过数。
//   - G3.fixtures：回放 fixture 文件（tests/m5/fixtures/ 下，相对 workspace 解析）；候选过程取
//     candidateDir/process.json（ReplayProcessSchema 校验）→ ReplayRunner 确定性回放。
//
// 门禁语义：按 plan.gates 顺序执行；任一 gate 失败 → 短路（后续 gate 不跑，含 G1 失败不跑 G2/G3）；
// 返回链结果 [{ gate, ok, detail }]（供 T5.5 晋升：全链 ok 才可 promote）。
//
// Verification Synthesis（§9.2：AI 生成的 verifier 只能是 candidate verifier，防自证）：
// 本模块实现验证链执行接口；合成 verifier 的 independent anchor / adversarial validation /
// non-circularity 机制留 M7 或后续（brief 注明）。
// T8.14：Verification Synthesis 落地——reproduction oracle（生成 → 沙箱验证 → anti-circularity）
// 在 ./oracle.ts（LOC ≤ 400 拆分，validate.ts 统一出口 re-export，同 generator.ts 拆 generator-ops 先例）。
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z, type ZodIssue } from 'zod';
import { OMB_OBJECTS, type ObjectNumber } from '../kernel/schemas/index.js';
import { ReplayProcessSchema, ReplayRunner, type ReplayFixture } from './replay.js';

// ---- Verification Synthesis 出口（T8.14：reproduction oracle，§9.2 防自证） ----

export * from './oracle.js';

// ---- 常量 ----

/** G1 tsc / G2 vitest 子进程超时（brief：spawn 超时 60s） */
const SUBPROCESS_TIMEOUT_MS = 60_000;
/** G3 fixture 目录（相对 workspace） */
const FIXTURES_REL = join('tests', 'm5', 'fixtures');

// ---- CandidateTestPlan schema（机制即数据） ----

const GateNameSchema = z.enum(['G1', 'G2', 'G3']);
export type GateName = z.infer<typeof GateNameSchema>;

const CandidateGateSchema = z.object({
  gate: GateNameSchema,
  checks: z.array(z.string()),
  fixtures: z.array(z.string()).optional(),
});

/** CandidateTestPlan（brief 契约：gate 枚举 G1|G2|G3；G1/G2 用 checks，G3 用 fixtures） */
export const CandidateTestPlanSchema = z.object({
  candidate_id: z.string().min(1),
  gates: z.array(CandidateGateSchema),
});
export type CandidateTestPlan = z.infer<typeof CandidateTestPlanSchema>;

/** 单 gate 验证结果（brief 契约：{ gate, ok, detail }） */
export interface GateResult {
  gate: GateName;
  ok: boolean;
  detail: string;
}

// ---- 子进程工具（Windows：直接 spawn node + workspace 本地 bin，免 cmd/pnpm 中间层——
//   每子进程少两层进程树，降低并行负载；工具版本 = workspace node_modules 解析，与 pnpm exec 同源） ----

interface SubprocessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** 解析 workspace node_modules/<pkg> 的 bin 入口（package.json bin 字段；bin 名为 toolName，
 *  缺省取包名；bin 为对象时 toolName 未命中 → 取首个入口；缺失 fail-loud） */
async function resolveBin(workspace: string, pkg: string, toolName = pkg): Promise<string> {
  const raw = await readFile(join(workspace, 'node_modules', pkg, 'package.json'), 'utf8');
  const pkgJson = JSON.parse(raw) as { bin?: string | Record<string, string> };
  const bin = pkgJson.bin;
  let binPath: string | undefined;
  if (typeof bin === 'string') {
    binPath = bin;
  } else if (bin !== null && typeof bin === 'object') {
    binPath = bin[toolName] ?? Object.values(bin)[0];
  }
  if (typeof binPath !== 'string' || binPath.length === 0) {
    throw new Error(`resolveBin: 包 ${pkg} 无 bin 入口（tool=${toolName}）`);
  }
  return join(workspace, 'node_modules', pkg, binPath);
}

/** 运行子进程（node 直接执行 bin；超时 → 树级终止，防 node→子进程孤儿子进程） */
function runSubprocess(cmd: string, args: string[], opts: { cwd: string; timeoutMs: number }): Promise<SubprocessResult> {
  return new Promise<SubprocessResult>((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32') {
        // 树级终止（node → vitest worker/tsc）
        try {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        } catch {
          /* 进程可能已退出，忽略 */
        }
      } else {
        child.kill('SIGTERM');
      }
    }, opts.timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

// ---- G1 静态门 ----

/** 对象 schema 校验（duck-typed safeParse：OMB_OBJECTS 值含接口描述，须带 safeParse 才可校验） */
interface SchemaLike {
  safeParse(input: unknown): {
    success: boolean;
    error?: { issues: ZodIssue[] };
  };
}

function formatIssues(issues: ZodIssue[]): string {
  return issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
}

async function runG1(plan: CandidateTestPlan, deps: { candidateDir: string; workspace: string }): Promise<GateResult> {
  const gate = plan.gates.find((g) => g.gate === 'G1');
  const checks = gate?.checks ?? [];
  const failures: string[] = [];
  const passed: string[] = [];

  for (const check of checks) {
    const schemaMatch = /^schema:([A-Za-z0-9]+)$/.exec(check);
    if (schemaMatch !== null) {
      const key = schemaMatch[1] as ObjectNumber;
      const schema = OMB_OBJECTS[key] as SchemaLike | undefined;
      if (schema === undefined || typeof schema.safeParse !== 'function') {
        failures.push(`G1 检查项 ${check}: 未注册/不可校验的对象 schema`);
        continue;
      }
      let obj: unknown;
      try {
        obj = JSON.parse(await readFile(join(deps.candidateDir, 'object.json'), 'utf8')) as unknown;
      } catch (err) {
        failures.push(`G1 检查项 ${check}: 读取候选对象失败: ${(err as Error).message}`);
        continue;
      }
      const result = schema.safeParse(obj);
      if (!result.success) {
        failures.push(`G1 检查项 ${check}: schema 校验失败: ${formatIssues(result.error?.issues ?? [])}`);
      } else {
        passed.push(check);
      }
      continue;
    }
    if (check === 'tsc') {
      const tsconfig = join(deps.candidateDir, 'tsconfig.json');
      let tscBin: string;
      try {
        tscBin = await resolveBin(deps.workspace, 'typescript', 'tsc');
      } catch (err) {
        failures.push(`G1 检查项 tsc: ${(err as Error).message}`);
        continue;
      }
      const sub = await runSubprocess(
        process.execPath,
        [tscBin, '--noEmit', '-p', tsconfig],
        { cwd: deps.workspace, timeoutMs: SUBPROCESS_TIMEOUT_MS },
      );
      if (sub.timedOut) {
        failures.push('G1 检查项 tsc: 子进程超时（60s）');
      } else if (sub.code !== 0) {
        const firstError =
          `${sub.stdout}\n${sub.stderr}`
            .split('\n')
            .find((line) => /error TS\d+/i.test(line))
            ?.trim() ?? `tsc 非零退出（exit=${sub.code}）`;
        failures.push(`G1 检查项 tsc: 失败: ${firstError}`);
      } else {
        passed.push(check);
      }
      continue;
    }
    failures.push(`G1 未知检查项: ${check}（命名规则等检查为后续扩展点）`);
  }

  if (failures.length > 0) {
    return { gate: 'G1', ok: false, detail: `G1 拒绝: ${failures.join('; ')}` };
  }
  return { gate: 'G1', ok: true, detail: `G1 通过: ${passed.length > 0 ? passed.join('; ') : '（无检查项）'}` };
}

// ---- G2 单元测试门 ----

interface G2Check {
  file: string; // 相对 candidateDir（如 tests/add.test.ts）
  expected: number;
}

/** 解析 G2 检查项 '<文件>:<期望通过数>'；非法 → 抛错（fail-loud） */
function parseG2Check(check: string): G2Check {
  const idx = check.lastIndexOf(':');
  if (idx <= 0) {
    throw new Error(`G2 检查项格式非法（应为 <测试文件>:<期望通过数>）: ${check}`);
  }
  const expected = Number(check.slice(idx + 1));
  if (!Number.isInteger(expected) || expected < 1) {
    throw new Error(`G2 检查项期望通过数非法（应为正整数）: ${check}`);
  }
  return { file: check.slice(0, idx), expected };
}

const norm = (p: string): string => p.split('\\').join('/');

/** 解析 vitest basic reporter 每文件行：' ✓ tests/a.test.ts (2 tests) 5ms' / ' ❯ tests/b.test.ts (1 test | 1 failed)' */
function parseVitestCounts(output: string): Map<string, number> {
  const counts = new Map<string, number>();
  const ansi = output.replace(/\u001b\[[0-9;]*m/g, '');
  const re = /^\s*[✓✗❯×]\s+(\S+)\s+\((\d+)\s+tests?/;
  for (const line of ansi.split('\n')) {
    const m = re.exec(line);
    if (m !== null) {
      const file = norm(m[1]!);
      if (!counts.has(file)) {
        counts.set(file, Number(m[2]));
      }
    }
  }
  return counts;
}

async function runG2(plan: CandidateTestPlan, deps: { candidateDir: string; workspace: string }): Promise<GateResult> {
  const gate = plan.gates.find((g) => g.gate === 'G2');
  const checks = gate?.checks ?? [];
  let parsed: G2Check[];
  try {
    parsed = checks.map(parseG2Check);
  } catch (err) {
    return { gate: 'G2', ok: false, detail: `G2 拒绝: ${(err as Error).message}` };
  }
  let vitestBin: string;
  try {
    vitestBin = await resolveBin(deps.workspace, 'vitest');
  } catch (err) {
    return { gate: 'G2', ok: false, detail: `G2 拒绝: ${(err as Error).message}` };
  }
  const sub = await runSubprocess(
    process.execPath,
    [vitestBin, 'run', '--root', deps.candidateDir, '--reporter=basic', '--no-cache'],
    { cwd: deps.workspace, timeoutMs: SUBPROCESS_TIMEOUT_MS },
  );
  if (sub.timedOut) {
    return { gate: 'G2', ok: false, detail: 'G2 拒绝: vitest 子进程超时（60s）' };
  }
  const counts = parseVitestCounts(`${sub.stdout}\n${sub.stderr}`);
  const failures: string[] = [];
  for (const c of parsed) {
    let actual: number | undefined;
    for (const [file, count] of counts) {
      if (file === norm(c.file) || file.endsWith(`/${norm(c.file)}`)) {
        actual = count;
        break;
      }
    }
    if (actual === undefined) {
      failures.push(`G2 检查项 ${c.file}: 未找到测试文件输出（vitest 未执行该文件）`);
    } else if (actual < c.expected) {
      failures.push(`G2 检查项 ${c.file}: 期望 ${c.expected} 通过，实际 ${actual}`);
    }
  }
  if (sub.code !== 0) {
    failures.push(`vitest 非零退出（exit=${sub.code}，存在失败/错误用例）`);
  }
  if (failures.length > 0) {
    return { gate: 'G2', ok: false, detail: `G2 拒绝: ${failures.join('; ')}` };
  }
  return { gate: 'G2', ok: true, detail: `G2 通过: ${parsed.map((c) => `${c.file} ${c.expected}/${c.expected} 通过`).join('; ')}` };
}

// ---- G3 回放门 ----

/** 真实执行器占位：回放拦截层永不调用（canned 未命中已在 ReplayRunner 内 fail-loud） */
const NO_REAL_EXECUTE: { execute: (tool: string, input: unknown) => Promise<unknown> } = {
  execute: async (tool: string) => {
    throw new Error(`真实执行器不参与回放（canned 未命中已在拦截层 fail-loud）: ${tool}`);
  },
};

async function runG3(plan: CandidateTestPlan, deps: { candidateDir: string; workspace: string }): Promise<GateResult> {
  const gate = plan.gates.find((g) => g.gate === 'G3');
  const fixtures = gate?.fixtures ?? [];
  let processRaw: string;
  try {
    processRaw = await readFile(join(deps.candidateDir, 'process.json'), 'utf8');
  } catch {
    return { gate: 'G3', ok: false, detail: 'G3 拒绝: 候选缺少 process.json（回放过程未物化）' };
  }
  const passed: string[] = [];
  for (const name of fixtures) {
    const fixturePath = join(deps.workspace, FIXTURES_REL, name);
    try {
      const process = ReplayProcessSchema.parse(JSON.parse(processRaw) as unknown);
      const fixture = JSON.parse(await readFile(fixturePath, 'utf8')) as ReplayFixture;
      const runner = new ReplayRunner(fixture);
      const result = await runner.run(process, NO_REAL_EXECUTE);
      if (!result.ok) {
        return { gate: 'G3', ok: false, detail: `G3 拒绝: ${name} 回放失败: ${result.detail ?? '未知原因'}` };
      }
      passed.push(`${name}（state_hash=${result.state_hash.slice(0, 12)}…）`);
    } catch (err) {
      return { gate: 'G3', ok: false, detail: `G3 拒绝: ${name} 回放异常: ${(err as Error).message}` };
    }
  }
  return { gate: 'G3', ok: true, detail: `G3 通过: ${passed.length > 0 ? passed.join('; ') : '（无 fixture）'}` };
}

// ---- 验证链入口 ----

/**
 * 执行验证链（brief 契约）：按 plan.gates 顺序执行；任一 gate 失败 → 短路（后续 gate 不跑）；
 * 返回链结果数组。非法 plan → 抛错（fail-loud）。
 */
export async function runVerification(
  plan: CandidateTestPlan,
  deps: { candidateDir: string; workspace: string },
): Promise<GateResult[]> {
  const parsed = CandidateTestPlanSchema.safeParse(plan);
  if (!parsed.success) {
    throw new Error(`runVerification: 非法 CandidateTestPlan——${formatIssues(parsed.error.issues)}`);
  }
  const results: GateResult[] = [];
  for (const gate of parsed.data.gates) {
    const result =
      gate.gate === 'G1'
        ? await runG1(parsed.data, deps)
        : gate.gate === 'G2'
          ? await runG2(parsed.data, deps)
          : await runG3(parsed.data, deps);
    results.push(result);
    if (!result.ok) {
      break; // 门禁短路：G1 失败不跑 G2/G3；后续 gate 同理
    }
  }
  return results;
}
