// OMB v2 冻结基准集运行器（架构 §15 成功标准与基准 / §17 参数标定；施工计划 T7.1）：layer 1。
// 解释器角色（P3 机制即数据）：
//   - 数据：kernel/bench-tasks/（tasks/*.json 20 任务 + fixtures/*.json）——本文件仅 import
//     node: 内置 + kernel/schemas/（契约例外，CONVENTIONS §4）+ 同层文件；
//   - verifier 接入：tests/exact/predicate/state_assert 真实实现；blind_judge 离线规则化占位
//     （LLM judge 记录为后续——§10.1 L3 语义信号）；
//   - runBench：三线（initial/stable/latest）+ baseline 对照，CognitiveCost 八字段度量记录；
//   - executor 注入：M7 无真实 DSH 时用回放执行器——复用 T5.2 ReplayRunner 的 canned 确定性模式
//     （fixture 内录制 output/cost，无真实 I/O）→ 同 fixture 同 executor → 同 passed + 同 cost（数字可复现）。
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import {
  BenchFixtureSchema,
  BenchLineSchema,
  BenchTaskSchema,
  CognitiveCostSchema,
  FROZEN_BENCH_COUNTS,
  type BenchCategory,
  type BenchFixture,
  type BenchLine,
  type BenchReport,
  type BenchResult,
  type BenchTask,
  type CognitiveCost,
} from '../kernel/schemas/bench.js';

// ---- 数据目录（相对本模块解析，与 cwd 无关） ----

const HERE = fileURLToPath(new URL('..', import.meta.url)); // preset/omb-v2/

export const BENCH_TASKS_DIR = join(HERE, 'kernel', 'bench-tasks', 'tasks');
export const BENCH_FIXTURES_DIR = join(HERE, 'kernel', 'bench-tasks', 'fixtures');

// ---- executor 注入（M7 离线用回放 executor；真实 DSH 运行留用户裁定后接真实 executor） ----

export type BenchExecutor = (task: BenchTask) => Promise<{ passed: boolean; cost: CognitiveCost }>;

// ---- CognitiveCost 八字段（§15：最低 token ≠ 最低成本；全零 = 无信号合法） ----

export function zeroCost(): CognitiveCost {
  return {
    model_tokens: 0,
    tool_calls: 0,
    retrieval_calls: 0,
    reacquisition: 0,
    latency_ms: 0,
    branch_count: 0,
    memory_pollution: 0,
    corrections: 0,
  };
}

// ---- verifier 接入（纯函数：fixture 载荷 + 候选输出 → 判定；载荷缺失 → false，不误判通过） ----

/** 点路径取值（'a.b.c'；任意段缺失 → undefined） */
function getPath(value: unknown, path: string): unknown {
  let cur: unknown = value;
  for (const seg of path.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') {
      return undefined;
    }
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** 目标谓词求值（web）：所有谓词满足 → true。equals 深度相等 / matches 正则 / contains 数组元素或子串 */
function satisfiesPredicates(output: unknown, predicates: unknown): boolean {
  if (!Array.isArray(predicates) || predicates.length === 0) {
    return false;
  }
  for (const p of predicates) {
    if (p === null || typeof p !== 'object') {
      return false;
    }
    const spec = p as Record<string, unknown>;
    if (typeof spec.path !== 'string') {
      return false;
    }
    const value = getPath(output, spec.path);
    if (Object.prototype.hasOwnProperty.call(spec, 'equals')) {
      if (!isDeepStrictEqual(value, spec.equals)) {
        return false;
      }
    } else if (typeof spec.matches === 'string') {
      if (typeof value !== 'string' || !new RegExp(spec.matches).test(value)) {
        return false;
      }
    } else if (Object.prototype.hasOwnProperty.call(spec, 'contains')) {
      if (Array.isArray(value)) {
        if (!value.some((e) => isDeepStrictEqual(e, spec.contains))) {
          return false;
        }
      } else if (typeof value === 'string') {
        if (!value.includes(String(spec.contains))) {
          return false;
        }
      } else {
        return false;
      }
    } else {
      return false; // 谓词缺操作符（schema 应已拦截，防御）
    }
  }
  return true;
}

/** tests verifier：候选测试摘要 { passed, failed, total } —— 总数与 fixture 一致、零失败、通过数 ≥ expected_pass */
function verifyTests(
  output: unknown,
  fixture: BenchFixture,
  expectedPass: number | undefined,
): boolean {
  if (fixture.total === undefined) {
    return false;
  }
  if (output === null || typeof output !== 'object') {
    return false;
  }
  const o = output as Record<string, unknown>;
  if (typeof o.passed !== 'number' || typeof o.failed !== 'number' || typeof o.total !== 'number') {
    return false;
  }
  if (o.total !== fixture.total) {
    return false;
  }
  if (o.failed !== 0) {
    return false;
  }
  return o.passed >= (expectedPass ?? o.total);
}

/** blind_judge 离线规则化占位：输出文本必须含 rubric 全部必需术语（大小写不敏感；无 LLM 依赖） */
function verifyBlindJudge(output: unknown, fixture: BenchFixture): boolean {
  const terms = fixture.rubric?.required_terms;
  if (!terms || terms.length === 0) {
    return false;
  }
  let text: string;
  if (typeof output === 'string') {
    text = output;
  } else if (output === null || output === undefined) {
    text = '';
  } else {
    text = JSON.stringify(output);
  }
  const norm = text.toLowerCase();
  return terms.every((t) => norm.includes(t.toLowerCase()));
}

/**
 * verifier 接入：按 task.verifier.kind 对候选输出判定（fixture = verifier.ref 载荷）。
 * 纯函数（无 I/O）；kind 载荷缺失/非法 → false（不过，不误判通过）。
 */
export function runVerifier(task: BenchTask, output: unknown, fixture: BenchFixture): boolean {
  switch (task.verifier.kind) {
    case 'tests':
      return verifyTests(output, fixture, task.verifier.expected_pass);
    case 'exact': {
      if (!Object.prototype.hasOwnProperty.call(fixture, 'expected')) {
        return false;
      }
      return isDeepStrictEqual(output, fixture.expected);
    }
    case 'predicate':
      return satisfiesPredicates(output, fixture.predicates);
    case 'state_assert': {
      if (output === null || typeof output !== 'object') {
        return false;
      }
      const o = output as Record<string, unknown>;
      const hasBefore = Object.prototype.hasOwnProperty.call(fixture, 'before');
      const hasAfter = Object.prototype.hasOwnProperty.call(fixture, 'after');
      if (!hasBefore || !hasAfter) {
        return false;
      }
      return isDeepStrictEqual(o.before, fixture.before) && isDeepStrictEqual(o.after, fixture.after);
    }
    case 'blind_judge':
      return verifyBlindJudge(output, fixture);
  }
}

/** 数据完整性守卫：fixture 载荷与 task.verifier.kind 匹配（冻结集守卫；不匹配 → fail-loud） */
export function assertFixtureMatchesVerifier(task: BenchTask, fixture: BenchFixture): void {
  const missing: string[] = [];
  switch (task.verifier.kind) {
    case 'tests':
      if (fixture.total === undefined) {
        missing.push('total');
      }
      break;
    case 'exact':
      if (!Object.prototype.hasOwnProperty.call(fixture, 'expected')) {
        missing.push('expected');
      }
      break;
    case 'predicate':
      if (!Array.isArray(fixture.predicates) || fixture.predicates.length === 0) {
        missing.push('predicates');
      }
      break;
    case 'state_assert':
      if (!Object.prototype.hasOwnProperty.call(fixture, 'before')) {
        missing.push('before');
      }
      if (!Object.prototype.hasOwnProperty.call(fixture, 'after')) {
        missing.push('after');
      }
      break;
    case 'blind_judge':
      if (!fixture.rubric || fixture.rubric.required_terms.length === 0) {
        missing.push('rubric.required_terms');
      }
      break;
  }
  if (missing.length > 0) {
    throw new Error(
      `bench fixture 与 verifier 不匹配: task=${task.id} kind=${task.verifier.kind} 缺载荷 [${missing.join(', ')}] (ref=${task.verifier.ref})`,
    );
  }
}

// ---- 数据加载（kernel/bench-tasks/，机制即数据；非法 fail-loud） ----

/** 加载 fixture 文件（fixtures/<ref>）→ BenchFixtureSchema 校验（非法 → fail-loud） */
export async function loadBenchFixture(ref: string, dir: string = BENCH_FIXTURES_DIR): Promise<BenchFixture> {
  const file = join(dir, ref);
  const raw = await readFile(file, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  const result = BenchFixtureSchema.safeParse(parsed);
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new Error(`bench fixture 校验失败 ${file}: ${detail}`);
  }
  return result.data;
}

/** 加载 tasks/*.json（文件名排序保证确定性）→ 逐任务 schema 校验 + id 唯一性（fail-loud） */
export async function loadBenchTasks(dir: string = BENCH_TASKS_DIR): Promise<BenchTask[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  const tasks: BenchTask[] = [];
  for (const f of files) {
    const file = join(dir, f);
    const raw = await readFile(file, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    const result = BenchTaskSchema.safeParse(parsed);
    if (!result.success) {
      const detail = result.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      throw new Error(`bench task 校验失败 ${file}: ${detail}`);
    }
    tasks.push(result.data);
  }
  const ids = new Set(tasks.map((t) => t.id));
  if (ids.size !== tasks.length) {
    throw new Error('bench task id 重复（冻结基准集 id 必须唯一）');
  }
  return tasks;
}

/** 冻结集完整性守卫：恰好 5 类 × 4（FROZEN_BENCH_COUNTS）+ id 唯一；不满足 → fail-loud */
export function assertFrozenSetComplete(tasks: readonly BenchTask[]): void {
  const byCategory = new Map<BenchCategory, number>();
  for (const t of tasks) {
    byCategory.set(t.category, (byCategory.get(t.category) ?? 0) + 1);
  }
  for (const category of Object.keys(FROZEN_BENCH_COUNTS) as BenchCategory[]) {
    const expected = FROZEN_BENCH_COUNTS[category];
    const actual = byCategory.get(category) ?? 0;
    if (actual !== expected) {
      throw new Error(`冻结基准集不完整: category=${category} 实际 ${actual} ≠ 期望 ${expected}`);
    }
  }
  const ids = new Set(tasks.map((t) => t.id));
  if (ids.size !== tasks.length) {
    throw new Error('冻结基准集 id 重复');
  }
}

// ---- 回放执行器（M7 离线；复用 T5.2 ReplayRunner 的 canned 确定性模式） ----

/**
 * 回放执行器：读取 task.verifier.ref fixture → 先过 assertFixtureMatchesVerifier（fixture 载荷与
 * verifier kind 不匹配 → fail-loud，冻结集数据完整性守卫）→ canned output 过 verifier → passed；
 * cost 从 fixture 统计采集（录制成本）。无真实 I/O、无随机 → 同 fixture 同 executor → 同 passed + 同 cost
 * （数字可复现）。三线对照用同一 executor（M7 无真实插件变体）；真实 DSH 运行由用户裁定后接真实 executor。
 */
export function makeReplayExecutor(opts: { fixturesDir?: string } = {}): BenchExecutor {
  const dir = opts.fixturesDir ?? BENCH_FIXTURES_DIR;
  return async (task: BenchTask) => {
    const fixture = await loadBenchFixture(task.verifier.ref, dir);
    assertFixtureMatchesVerifier(task, fixture);
    const passed = runVerifier(task, fixture.output, fixture);
    return { passed, cost: fixture.cost };
  };
}

// ---- 运行（三线 + 基线：调用方以不同 line/executor 各跑一次） ----

/**
 * 冻结基准运行（单线）：tasks 逐个过 schema（fail-loud）→ executor 逐任务执行 → 结果按任务序记录
 * （CognitiveCost 八字段校验）→ BenchReport（线 + N 结果）。
 * 三线对照 + baseline：initial/stable/latest 各跑一次 + baseline（无插件基线 executor）→ 4 × N 结果。
 */
export async function runBench(opts: {
  tasks: readonly BenchTask[];
  line: BenchLine;
  executor: BenchExecutor;
}): Promise<BenchReport> {
  const line = BenchLineSchema.parse(opts.line);
  const tasks = opts.tasks.map((t) => BenchTaskSchema.parse(t));
  const ids = new Set(tasks.map((t) => t.id));
  if (ids.size !== tasks.length) {
    throw new Error('runBench: tasks id 重复');
  }
  const results: BenchResult[] = [];
  for (const task of tasks) {
    const { passed, cost } = await opts.executor(task);
    const parsedCost = CognitiveCostSchema.parse(cost);
    results.push({ task_id: task.id, line, passed, cost: parsedCost });
  }
  return { line, results };
}
