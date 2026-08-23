// OMB v2 基准 v2 契约化管道（架构 §15 成功标准与基准；施工计划 2026-08-23-bench-v2-contract.md T2.1）：layer 1。
// 与 v1（supervisor/bench.ts）的差异：任务定义四要素（输入工件 + requirement + output_schema + verifier rules）
// 全部收进契约（BenchContractV2），expected 由独立 reference 纯函数生成（fixture 携带 generator 元数据）——
// prompt/output_schema/verifier 共享同一契约（单一权威，防 prompt/输入/输出/verifier 漂移）。
// 本模块仅 import node: 内置 + kernel/schemas/（契约例外）+ 同层文件；零新依赖（JSON Schema 子集校验器自实现）。
import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import {
  BenchContractV2Schema,
  BenchFixtureV2Schema,
  BenchLineSchema,
  CognitiveCostSchema,
  JudgeVerdictSchema,
  type BenchContractV2,
  type BenchFixtureV2,
  type BenchLine,
  type CognitiveCost,
  type JudgeVerdict,
  type OutputFieldV2,
  type OutputSchemaV2,
} from '../kernel/schemas/bench.js';
import { zeroCost } from './bench.js';

// ---- 数据目录（相对本模块解析，与 cwd 无关；布局同 v1 bench.ts） ----
// HERE 探测以 v2 数据目录本身为准（比 bench.ts 的 kernel/bench-tasks 探测更精确）：src 布局
// supervisor/bench-v2.ts → 上一级即 preset 根；编译布局 lib/supervisor/bench-v2.js 多一层。
// ⚠️ 不能探测 kernel/bench-tasks 本身——T2.1/T2.2 把 reference/*.ts 编进 lib/kernel/bench-tasks/reference
// 后该路径恒存在，会误判 HERE=lib/（数据 JSON 不随 tsc 编译，lib/ 下无 v2/contracts）。v1 bench.ts
// 同款探测因此存在同类隐患（v1 冻结不动，记录在案）。

const HERE_CANDIDATE = fileURLToPath(new URL('..', import.meta.url));
const HERE = existsSync(join(HERE_CANDIDATE, 'kernel', 'bench-tasks', 'v2', 'contracts'))
  ? HERE_CANDIDATE
  : dirname(HERE_CANDIDATE);

export const BENCH_V2_CONTRACTS_DIR = join(HERE, 'kernel', 'bench-tasks', 'v2', 'contracts');
export const BENCH_V2_FIXTURES_DIR = join(HERE, 'kernel', 'bench-tasks', 'v2', 'fixtures');

// ---- JSON Schema 子集校验器（零新依赖；object/properties/required/items/enum/type 够用项） ----

/** 值的类型名（null 单列；数组不算 object） */
function typeName(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  return typeof value;
}

/** 校验单个字段值（field.type / items / properties / enum；错误带路径前缀追加到 errors） */
function validateFieldValue(value: unknown, field: OutputFieldV2, path: string, errors: string[]): void {
  if (field.type === 'string' && typeof value !== 'string') {
    errors.push(`${path}: 类型不符，期望 string，实际 ${typeName(value)}`);
    return;
  }
  if (field.type === 'number' && typeof value !== 'number') {
    errors.push(`${path}: 类型不符，期望 number，实际 ${typeName(value)}`);
    return;
  }
  if (field.type === 'boolean' && typeof value !== 'boolean') {
    errors.push(`${path}: 类型不符，期望 boolean，实际 ${typeName(value)}`);
    return;
  }
  if (field.type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      errors.push(`${path}: 类型不符，期望 object，实际 ${typeName(value)}`);
      return;
    }
    const properties = field.properties;
    if (properties !== undefined) {
      const obj = value as Record<string, unknown>;
      for (const [key, sub] of Object.entries(properties)) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
          validateFieldValue(obj[key], sub, `${path}.${key}`, errors);
        }
      }
    }
  }
  if (field.type === 'array') {
    if (!Array.isArray(value)) {
      errors.push(`${path}: 类型不符，期望 array，实际 ${typeName(value)}`);
      return;
    }
    const items = field.items;
    if (items !== undefined) {
      value.forEach((element, index) => {
        validateFieldValue(element, items, `${path}[${index}]`, errors);
      });
    }
  }
  const enumValues = field.enum;
  if (enumValues !== undefined && !enumValues.includes(value)) {
    errors.push(`${path}: 值不在 enum 中`);
  }
}

/** 输出 schema 校验：符合 → []；不符 → 错误列表（required 缺失 / 类型错 / items / enum 违例） */
export function validateOutputSchema(output: unknown, schema: OutputSchemaV2): string[] {
  const errors: string[] = [];
  if (output === null || typeof output !== 'object' || Array.isArray(output)) {
    errors.push(`(root): 期望 object，实际 ${typeName(output)}`);
    return errors;
  }
  const obj = output as Record<string, unknown>;
  for (const key of schema.required) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) {
      errors.push(`(root): 缺少 required 字段 ${key}`);
    }
  }
  for (const [key, field] of Object.entries(schema.properties)) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      validateFieldValue(obj[key], field, `(root).${key}`, errors);
    }
  }
  return errors;
}

// ---- 谓词求值（web：rules.predicates；语义与 v1 satisfiesPredicates 对齐） ----

/** 点路径取值（'a.b.c'；任意段缺失 → undefined） */
function getPathV2(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const segment of path.split('.')) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** 目标谓词求值：所有谓词满足 → true（equals 深度相等 / matches 正则 / contains 数组元素或子串） */
function satisfiesPredicatesV2(output: unknown, predicates: unknown): boolean {
  if (!Array.isArray(predicates) || predicates.length === 0) {
    return false;
  }
  for (const predicate of predicates) {
    if (predicate === null || typeof predicate !== 'object') {
      return false;
    }
    const spec = predicate as Record<string, unknown>;
    if (typeof spec.path !== 'string') {
      return false;
    }
    const value = getPathV2(output, spec.path);
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
        if (!value.some((element) => isDeepStrictEqual(element, spec.contains))) {
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
      return false;
    }
  }
  return true;
}

/** blind_judge 规则化占位：输出文本含 rubric 全部必需术语（大小写不敏感；无 LLM 依赖） */
function containsRequiredTerms(output: unknown, terms: readonly string[]): boolean {
  let text: string;
  if (typeof output === 'string') {
    text = output;
  } else if (output === null || output === undefined) {
    text = '';
  } else {
    text = JSON.stringify(output);
  }
  const normalized = text.toLowerCase();
  return terms.every((term) => normalized.includes(term.toLowerCase()));
}

// ---- v2 verifier（流程：output_schema 校验 → kind 规则；与 v1 判定语义对齐，但共享契约 schema） ----

/**
 * v2 判定：先 output_schema 校验（契约单一权威），再按 verifier.kind 应用规则——
 * exact/tests/state_assert：与 fixture.expected 深度比较；predicate：rules.predicates 谓词求值；
 * blind_judge：rules.rubric.required_terms 术语包含。reason 供明细落盘（失败归因）。
 */
export function verifyV2(
  task: BenchContractV2,
  fixture: BenchFixtureV2,
  output: unknown,
): { passed: boolean; reason: string } {
  const schemaErrors = validateOutputSchema(output, task.output_schema);
  if (schemaErrors.length > 0) {
    return { passed: false, reason: `schema: ${schemaErrors.join('; ')}` };
  }
  switch (task.verifier.kind) {
    case 'exact':
    case 'tests':
    case 'state_assert':
      return isDeepStrictEqual(output, fixture.expected)
        ? { passed: true, reason: `${task.verifier.kind}: 输出与 expected 深度一致` }
        : { passed: false, reason: `${task.verifier.kind}: 输出与 expected 不一致` };
    case 'predicate': {
      const predicates = task.verifier.rules?.predicates;
      if (!Array.isArray(predicates) || predicates.length === 0) {
        return { passed: false, reason: 'predicate: rules.predicates 缺失或为空' };
      }
      return satisfiesPredicatesV2(output, predicates)
        ? { passed: true, reason: 'predicate: 全部谓词满足' }
        : { passed: false, reason: 'predicate: 谓词未满足' };
    }
    case 'blind_judge': {
      const rubric = task.verifier.rules?.rubric;
      const terms =
        rubric !== null && typeof rubric === 'object'
          ? (rubric as Record<string, unknown>).required_terms
          : undefined;
      if (!Array.isArray(terms) || terms.length === 0) {
        return { passed: false, reason: 'blind_judge: rules.rubric.required_terms 缺失或为空' };
      }
      return containsRequiredTerms(output, terms as string[])
        ? { passed: true, reason: 'blind_judge: 全部必需术语出现' }
        : { passed: false, reason: 'blind_judge: 缺少必需术语' };
    }
  }
}

// ---- 模型输出解析（v2；T2.3 接线：runBenchV2 与 real-executor 共用） ----

/** 解析失败时错误消息里携带的原始文本片段上限（截断防爆长；确定性） */
const PARSE_SNIPPET_MAX = 120;

/**
 * 模型输出解析（容错）：剥 ```json / ```js / ``` 等任意代码围栏 + 首尾空白 → JSON.parse。
 * 成功 → { ok: true, value }；失败 → { ok: false, error }（错误含 JSON 解析详情 + 片段截断的原文）。
 * v2 契约输出形状一律为 output_schema 的 JSON 对象——解析失败即不可用（passed=false 且 reason 含 parse 错误），
 * 与 v1 parseExecOutput 的「失败回退原样文本」不同（v1 blind_judge 接受字符串；v2 无此场景）。
 */
export function parseModelOutputV2(
  rawText: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = rawText.trim();
  const cleaned = /^```/i.test(trimmed)
    ? trimmed.replace(/^```[a-zA-Z0-9_-]*\s*/i, '').replace(/```\s*$/i, '')
    : trimmed;
  try {
    return { ok: true, value: JSON.parse(cleaned) as unknown };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const snippet =
      cleaned.length > PARSE_SNIPPET_MAX ? `${cleaned.slice(0, PARSE_SNIPPET_MAX)}…（截断）` : cleaned;
    return { ok: false, error: `模型输出解析失败（${detail}）：${snippet}` };
  }
}

// ---- 执行器注入与运行（回放执行器按 fixture.output 直通；真实执行器 T2.3 接线） ----

/** v2 执行器：契约 → 执行产物 + 成本（判定由 runBenchV2 统一经 verifyV2 完成） */
export type BenchExecutorV2 = (task: BenchContractV2) => Promise<{
  output: unknown;
  cost: CognitiveCost;
  rawText?: string;
}>;

/** 回放执行器：按 task_id 返回 fixture.output（生成时 = expected → 回放必然通过）；cost 全零（fixture 无录制成本） */
export function makeReplayExecutorV2(fixtures: readonly BenchFixtureV2[]): BenchExecutorV2 {
  const byId = new Map(fixtures.map((fixture): [string, BenchFixtureV2] => [fixture.task_id, fixture]));
  return async (task: BenchContractV2) => {
    const fixture = byId.get(task.id);
    if (fixture === undefined) {
      throw new Error(`回放执行器 v2: 缺契约 ${task.id} 的 fixture（数据完整性）`);
    }
    return { output: fixture.output, cost: zeroCost() };
  };
}

/** 单任务 v2 结果（task_id/line/passed/cost 与 v1 BenchResult 同构；P4 增 judge 判词并存） */
export interface BenchV2Result {
  task_id: string;
  line: BenchLine;
  passed: boolean;
  cost: CognitiveCost;
  /** P4：LLM judge 判词（D6 双判；未注入/回放模式/失败降级 → null） */
  judge: JudgeVerdict | null;
}

/**
 * P4：v2 双判汇总（D6 全任务双判；judge 仅旁证不作晋升硬信号——架构 §7.1 / P1e 门禁）。
 * - enabled：judge 注入且 real 模式（本运行执行双判）；
 * - run/degraded：有判词（非 null）任务数 / judge 降级（异常/超时/非法判词 → null）任务数；
 * - pass/fail/unknown：判词分布（unknown = 模型无法判定，合法判词非降级）；
 * - agree/rate：双判一致（规则 passed ↔ judge pass；规则失败 ↔ judge fail；unknown 不计）与一致率；
 * - cost_mean：judge 成本均值（model_tokens/latency_ms 单列；无 cost 判词 → null）。
 */
export interface BenchV2JudgeSummary {
  enabled: boolean;
  run: number;
  degraded: number;
  pass: number;
  fail: number;
  unknown: number;
  agree: number;
  rate: number;
  cost_mean: { model_tokens: number; latency_ms: number } | null;
}

/** v2 运行汇总（{line, results, total/passed, judge}） */
export interface BenchV2Report {
  line: BenchLine;
  results: BenchV2Result[];
  total: number;
  passed: number;
  judge: BenchV2JudgeSummary;
}

/** P4：judge 注入面（D6 全任务双判）——每任务规则判定（verifyV2）后调用；null = 无 judge/失败降级 */
export type JudgeFnV2 = (
  task: BenchContractV2,
  fixture: BenchFixtureV2,
  output: unknown,
  rawText?: string,
) => Promise<JudgeVerdict | null>;

/** 单任务 judge 执行（防御）：judge 抛错 / 返回非法判词 → null（降级；规则判定不受影响） */
async function runJudgeForTask(
  judge: JudgeFnV2,
  contract: BenchContractV2,
  fixture: BenchFixtureV2,
  output: unknown,
  rawText: string | undefined,
): Promise<JudgeVerdict | null> {
  try {
    const verdict = await judge(contract, fixture, output, rawText);
    return JudgeVerdictSchema.safeParse(verdict).success ? verdict : null;
  } catch {
    return null;
  }
}

/** 双判汇总（纯函数：由逐任务 judge 结果聚合；judge 未启用 → 全零 + enabled=false） */
function summarizeJudge(judgeEnabled: boolean, results: readonly BenchV2Result[]): BenchV2JudgeSummary {
  const summary: BenchV2JudgeSummary = {
    enabled: judgeEnabled,
    run: 0,
    degraded: 0,
    pass: 0,
    fail: 0,
    unknown: 0,
    agree: 0,
    rate: 0,
    cost_mean: null,
  };
  let tokens = 0;
  let latency = 0;
  let costCount = 0;
  for (const r of results) {
    const judge = r.judge;
    if (judge === null) {
      if (judgeEnabled) {
        summary.degraded++;
      }
      continue;
    }
    summary.run++;
    if (judge.verdict === 'pass') {
      summary.pass++;
      if (r.passed) {
        summary.agree++;
      }
    } else if (judge.verdict === 'fail') {
      summary.fail++;
      if (!r.passed) {
        summary.agree++;
      }
    } else {
      summary.unknown++;
    }
    if (judge.cost !== undefined) {
      tokens += judge.cost.model_tokens;
      latency += judge.cost.latency_ms;
      costCount++;
    }
  }
  const decisive = summary.pass + summary.fail;
  summary.rate = decisive === 0 ? 0 : summary.agree / decisive;
  summary.cost_mean = costCount === 0 ? null : { model_tokens: tokens / costCount, latency_ms: latency / costCount };
  return summary;
}

/**
 * v2 基准运行（单线）：契约逐个过 schema（fail-loud）→ executor 逐任务执行 → verifyV2 判定 →
 * CognitiveCost 记录 → 汇总 {line, results, total/passed, judge}；persistDir 时逐任务 JSONL 落盘
 * （文件名 replay-v2-<line>-<ts>.jsonl / real-v2-<line>-<ts>.jsonl，同 v1 风格）。
 * P4（D6 全任务双判）：judge 注入且 mode='real' → 每任务规则判定（verifyV2）+ judge 判定并存
 * （20 任务全部 judge——exact/tests/state_assert 与 predicate/blind_judge 的判据构造见
 * supervisor/judge.ts buildJudgePromptV2）；judge 失败/超时/无模型 → 该任务 judge=null（规则判定
 * 照常，report.judge.degraded 计数）；回放模式（mode='replay'）无 judge（回放产物无评判意义）。
 */
export async function runBenchV2(opts: {
  contracts: readonly BenchContractV2[];
  fixtures: readonly BenchFixtureV2[];
  line: BenchLine;
  executor: BenchExecutorV2;
  /** 执行模式标记：'real' / 'replay'；仅记录与落盘文件名，不影响判定 */
  mode?: 'real' | 'replay';
  /** 明细落盘目录（可选）；缺省不落盘 */
  persistDir?: string;
  /** P4：LLM judge 注入面（D6 全任务双判）——仅 mode='real' 时逐任务调用；null=无 judge/失败降级 */
  judge?: JudgeFnV2;
}): Promise<BenchV2Report> {
  const line = BenchLineSchema.parse(opts.line);
  const contracts = opts.contracts.map((contract) => BenchContractV2Schema.parse(contract));
  const fixtures = opts.fixtures.map((fixture) => BenchFixtureV2Schema.parse(fixture));
  const contractIds = new Set(contracts.map((contract) => contract.id));
  if (contractIds.size !== contracts.length) {
    throw new Error('runBenchV2: contracts id 重复');
  }
  const fixtureById = new Map(fixtures.map((fixture): [string, BenchFixtureV2] => [fixture.task_id, fixture]));
  const mode = opts.mode ?? 'replay';
  // P4：judge 双判仅真实执行路径启用（回放产物无评判意义；回放模式无 judge——D6）
  const judgeEnabled = opts.judge !== undefined && mode === 'real';
  const persistFile = opts.persistDir === undefined
    ? undefined
    : join(opts.persistDir, `${mode}-v2-${line}-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
  if (persistFile !== undefined) {
    await mkdir(opts.persistDir!, { recursive: true });
  }
  const results: BenchV2Result[] = [];
  for (const contract of contracts) {
    const fixture = fixtureById.get(contract.id);
    if (fixture === undefined) {
      throw new Error(`runBenchV2: 契约 ${contract.id} 缺 fixture（数据完整性）`);
    }
    const executed = await opts.executor(contract);
    const cost = CognitiveCostSchema.parse(executed.cost);
    // 模型输出解析兜底（真实执行路径）：executor 输出解析失败（output=undefined）且带回 rawText 时，
    // 复用 parseModelOutputV2 取 parse 错误归因（passed=false 且 reason 含 parse 错误）；rawText 缺失时
    // 走 verifyV2 常规 schema 判定（回放 executor 恒有 output，不经此分支——行为与 T2.1/T2.2 一致）。
    let output = executed.output;
    let parseError: string | undefined;
    if (output === undefined && executed.rawText !== undefined) {
      const parsed = parseModelOutputV2(executed.rawText);
      if (parsed.ok) {
        output = parsed.value;
      } else {
        parseError = parsed.error;
      }
    }
    const verdict =
      parseError === undefined ? verifyV2(contract, fixture, output) : { passed: false, reason: `parse: ${parseError}` };
    // P4：judge 双判（仅 real 模式；失败/非法判词 → null 降级，规则判定照常）
    const judge: JudgeVerdict | null = judgeEnabled
      ? await runJudgeForTask(opts.judge!, contract, fixture, output, executed.rawText)
      : null;
    results.push({ task_id: contract.id, line, passed: verdict.passed, cost, judge });
    if (persistFile !== undefined) {
      const record = {
        ts: Date.now(),
        task_id: contract.id,
        mode,
        line,
        passed: verdict.passed,
        verifier_kind: contract.verifier.kind,
        failure_reason: verdict.passed ? null : verdict.reason,
        output: executed.output,
        raw_text: executed.rawText,
        cost,
        // P4：judge 段单列（判词 + 可选原因 + 成本；无 judge/降级 → null）
        judge,
      };
      await appendFile(persistFile, `${JSON.stringify(record)}\n`, 'utf8');
    }
  }
  const passed = results.filter((result) => result.passed).length;
  return { line, results, total: results.length, passed, judge: summarizeJudge(judgeEnabled, results) };
}

// ---- 数据加载（kernel/bench-tasks/v2/；非法契约/夹具 fail-loud） ----

/** 加载 v2 契约（contracts/*.json，文件名排序保证确定性）；文件名须与契约 id 一致（fail-loud） */
export async function loadBenchContractsV2(dir: string = BENCH_V2_CONTRACTS_DIR): Promise<BenchContractV2[]> {
  const files = (await readdir(dir)).filter((file) => file.endsWith('.json')).sort();
  const contracts: BenchContractV2[] = [];
  for (const file of files) {
    const parsed = BenchContractV2Schema.safeParse(JSON.parse(await readFile(join(dir, file), 'utf8')));
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
      throw new Error(`bench v2 契约校验失败 ${join(dir, file)}: ${detail}`);
    }
    if (file !== `${parsed.data.id}.json`) {
      throw new Error(`bench v2 契约文件名与 id 不一致: ${join(dir, file)}（期望 ${parsed.data.id}.json）`);
    }
    contracts.push(parsed.data);
  }
  const ids = new Set(contracts.map((contract) => contract.id));
  if (ids.size !== contracts.length) {
    throw new Error('bench v2 契约 id 重复');
  }
  return contracts;
}

/** 加载 v2 夹具（fixtures/<id>.fixture.json，文件名排序保证确定性）；文件名须与 task_id 一致（fail-loud） */
export async function loadBenchFixturesV2(dir: string = BENCH_V2_FIXTURES_DIR): Promise<BenchFixtureV2[]> {
  const files = (await readdir(dir)).filter((file) => file.endsWith('.json')).sort();
  const fixtures: BenchFixtureV2[] = [];
  for (const file of files) {
    const parsed = BenchFixtureV2Schema.safeParse(JSON.parse(await readFile(join(dir, file), 'utf8')));
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
      throw new Error(`bench v2 fixture 校验失败 ${join(dir, file)}: ${detail}`);
    }
    if (file !== `${parsed.data.task_id}.fixture.json`) {
      throw new Error(`bench v2 fixture 文件名与 task_id 不一致: ${join(dir, file)}（期望 ${parsed.data.task_id}.fixture.json）`);
    }
    fixtures.push(parsed.data);
  }
  const ids = new Set(fixtures.map((fixture) => fixture.task_id));
  if (ids.size !== fixtures.length) {
    throw new Error('bench v2 fixture task_id 重复');
  }
  return fixtures;
}
