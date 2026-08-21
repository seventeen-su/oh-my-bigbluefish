// OMB v2 确定性回放执行器（架构 §9.2 G3 历史回放 / §17 Replay Fixture 开放项；施工计划 T5.2）：layer 1。
//
// 用途：验证链 G3 —— 以录制 fixture 为真相，确定性重放候选过程（ProcessDef 形状），
//       校验最终 state_hash 与事件序列是否与录制一致（同输入同输出，P7 回放语义）。
//
// Fixture 格式（tests/m5/fixtures/<name>.fixture.json）：
//   { name, input: { state_hash, task }, canned: [{ tool, input_hash, result }],
//     expected: { final_state_hash, events }, clock?: { fixed_ts } }
//   语义：录制时每次工具调用按 (tool, input_hash) 记录 → canned 项；回放时拦截工具调用查 canned map：
//   命中 → 返回录制 result（确定性）；未命中 → fail-loud（fixture 不完整，绝不回退真实执行器）。
//   非确定性段（时间）必须在 fixture 内显式声明：clock.fixed_ts → 回放执行器注入固定时钟
//   （图输入上下文 now），'$.now' 绑定即取固定值 → input_hash 确定。
//
// 回放过程执行（最小确定性解释器，layer 1 自包含，不依赖 runtime 执行器）：
//   - 按 operators 列表顺序顺序执行（无图并行——确定性优先）；
//   - 每个算子：input_binding 逐键解析（{ref[,path]} → 上游算子输出 / 图输入（state_hash/task/now）；
//     {const} → 常量；数组 → 逐元素；其他 → 裸常量）；解析失败 → fail-loud；
//   - EXECUTE 算子：input_hash = sha256(canonicalJson(解析后输入)) → 查 canned；结果 = 录制 result；
//   - 非 EXECUTE 算子（如 STOP）：无工具调用，确定性透传（结果 = 解析后输入）；
//   - 事件序列 = ['<op.id>:<input_hash>', ...]（每算子一条，含 input_hash 的确定性轨迹）。
//
// state_hash 契约（M7 Replay Fixture 录制工具按此实现）：
//   computeReplayStateHash(trace) = sha256hex(canonicalJson(trace))，
//   trace = [{ tool, input_hash, result }]（按执行序）。fixture.expected.final_state_hash 即录制时
//   计算的该值；回放重算并断言一致。
//
// 结果语义：断言不符（state_hash/events 与 expected 不一致）→ 返回 { ok: false, detail }（验证结论）；
// 基础设施错误（canned 未命中 / fixture 非法 / 绑定未解析）→ 抛 ReplayError（fail-loud，不静默）。
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '../kernel/schemas/base.js';

// ---- 常量 ----

/** canned map 键分隔符（tool 与 input_hash 均不可能含 \u0000） */
const KEY_SEP = '\u0000';

// ---- Schema（机制即数据：fixture / 回放过程均为数据，zod 校验，非法 fail-loud） ----

/** canned 项：录制时的 (tool, input_hash) → result 映射 */
export const CannedEntrySchema = z.object({
  tool: z.string().min(1),
  input_hash: z.string().min(1),
  result: z.unknown(),
});
export type ReplayCannedEntry = z.infer<typeof CannedEntrySchema>;

/** 回放轨迹条目（state_hash 契约的输入：按执行序记录每次算子执行） */
export interface ReplayTraceEntry {
  tool: string;
  input_hash: string;
  result: unknown;
}

/** Replay Fixture（tests/m5/fixtures/*.fixture.json 的形状） */
export const ReplayFixtureSchema = z.object({
  name: z.string().min(1),
  input: z.object({
    state_hash: z.string().min(1),
    task: z.record(z.string(), z.unknown()),
  }),
  canned: z.array(CannedEntrySchema),
  expected: z.object({
    final_state_hash: z.string().min(1),
    events: z.array(z.string()),
  }),
  /** 非确定性段显式声明：固定时钟（epoch ms）→ 注入图输入上下文 now */
  clock: z.object({ fixed_ts: z.number().int().nonnegative() }).optional(),
});
export type ReplayFixture = z.infer<typeof ReplayFixtureSchema>;

/** 回放过程（ProcessDef 的结构兼容子集：kernel/policy-loader ProcessDef 可赋值给本形状；
 *  entry/exit 约束由 ProcessDefSchema 上游保证，回放执行器按 operators 列表序执行） */
export const ReplayProcessSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  entry: z.string().min(1),
  exit: z.string().min(1),
  operators: z
    .array(
      z.object({
        id: z.string().min(1),
        op: z.string().min(1),
        input_binding: z.record(z.string(), z.unknown()),
        output: z.string().min(1),
      }),
    )
    .min(1),
});
export type ReplayOpDef = z.infer<typeof ReplayProcessSchema>['operators'][number];
export type ReplayProcessDef = z.infer<typeof ReplayProcessSchema>;

/** 回放结果（brief 契约：{ ok, state_hash, detail? }） */
export interface ReplayResult {
  ok: boolean;
  state_hash: string;
  detail?: string;
}

/** 回放失败（fail-loud：canned 未命中 / fixture 非法 / 绑定未解析 / 图上下文缺失） */
export class ReplayError extends Error {
  constructor(message: string) {
    super(`replay: ${message}`);
    this.name = 'ReplayError';
  }
}

// ---- 确定性工具 ----

function sha256hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/**
 * state_hash 契约（M7 录制工具按此实现）：sha256hex(canonicalJson(trace))。
 * 同 trace 同 hash；trace 任何字段（tool/input_hash/result/顺序）变化 → hash 变化。
 */
export function computeReplayStateHash(trace: ReplayTraceEntry[]): string {
  return sha256hex(canonicalJson(trace));
}

function getPath(value: unknown, path: string): unknown {
  let cur = value;
  for (const seg of path.split('.')) {
    if (cur === null || cur === undefined) {
      return undefined;
    }
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** input_binding 单键解析：'$.x[.seg]' 与 {ref[,path]} → 上游输出/图输入；{const} → 常量；数组逐元素；其他裸常量 */
function resolveBinding(
  binding: unknown,
  outputs: Map<string, unknown>,
  ctxInputs: Record<string, unknown>,
  opId: string,
): unknown {
  if (Array.isArray(binding)) {
    return binding.map((b) => resolveBinding(b, outputs, ctxInputs, opId));
  }
  if (typeof binding === 'string' && binding.startsWith('$.')) {
    // ProcessDef 图输入引用语法（'$.name[.seg…]'）：name 命中上游输出 → 输出引用；否则图上下文输入
    const segs = binding.slice(2).split('.');
    const target = segs[0];
    if (target === undefined || target.length === 0) {
      throw new ReplayError(`算子 ${opId}: 空引用 "$."（引用目标缺失）`);
    }
    const path = segs.length > 1 ? segs.slice(1).join('.') : undefined;
    if (outputs.has(target)) {
      const out = outputs.get(target);
      return path !== undefined ? getPath(out, path) : out;
    }
    if (Object.prototype.hasOwnProperty.call(ctxInputs, target)) {
      const out = ctxInputs[target];
      return path !== undefined ? getPath(out, path) : out;
    }
    throw new ReplayError(`算子 ${opId} 的 input_binding 引用未完成输出/图输入: ${target}`);
  }
  if (binding !== null && typeof binding === 'object') {
    const obj = binding as Record<string, unknown>;
    if (typeof obj.ref === 'string') {
      if (outputs.has(obj.ref)) {
        const out = outputs.get(obj.ref);
        return typeof obj.path === 'string' ? getPath(out, obj.path) : out;
      }
      if (Object.prototype.hasOwnProperty.call(ctxInputs, obj.ref)) {
        const out = ctxInputs[obj.ref];
        return typeof obj.path === 'string' ? getPath(out, obj.path) : out;
      }
      throw new ReplayError(`算子 ${opId} 的 input_binding 引用未完成输出/图输入: ${obj.ref}`);
    }
    if ('const' in obj) {
      return obj.const;
    }
  }
  return binding;
}

function cannedKey(tool: string, input_hash: string): string {
  return `${tool}${KEY_SEP}${input_hash}`;
}

/** 事件序列逐项相等（确定性断言） */
function eventsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

// ---- 回放执行器 ----

export class ReplayRunner {
  private readonly fixture: ReplayFixture;
  /** (tool, input_hash) → 录制 result（命中即确定性返回；未命中 → fail-loud） */
  private readonly canned: Map<string, unknown>;

  /** 构造即校验 fixture（非法 → ReplayError fail-loud）；重复 canned 键 → 拒绝（歧义） */
  constructor(fixture: ReplayFixture) {
    const parsed = ReplayFixtureSchema.safeParse(fixture);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      throw new ReplayError(`非法 fixture（${detail}）`);
    }
    this.fixture = parsed.data;
    this.canned = new Map();
    for (const entry of this.fixture.canned) {
      const key = cannedKey(entry.tool, entry.input_hash);
      if (this.canned.has(key)) {
        throw new ReplayError(`非法 fixture——canned 重复项 (tool=${entry.tool}, input_hash=${entry.input_hash})`);
      }
      this.canned.set(key, entry.result);
    }
  }

  /**
   * 确定性重放候选过程：
   * - 图输入上下文 = { state_hash: fixture.input.state_hash, task: fixture.input.task, now }，
   *   now = clock.fixed_ts（显式声明）否则 Date.now()（未声明的 fixture 不得绑定 '$.now'）；
   * - 拦截工具调用：canned 命中 → 录制 result；未命中 → ReplayError fail-loud；
   *   deps.execute（真实执行器）仅作签名契约保留——回放拦截层永不调用（防回放期间真实 I/O）。
   * - 断言：最终 state_hash == expected.final_state_hash 且事件序列 == expected.events；
   *   不符 → { ok: false, detail }（验证结论）；基础设施错误 → 抛 ReplayError。
   */
  async run(
    process: ReplayProcessDef,
    deps: { execute: (tool: string, input: unknown) => Promise<unknown> },
  ): Promise<ReplayResult> {
    void deps.execute; // 真实执行器句柄（契约保留）：回放拦截层永不调用，canned 未命中即 fail-loud
    const parsedProcess = ReplayProcessSchema.safeParse(process);
    if (!parsedProcess.success) {
      const detail = parsedProcess.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      throw new ReplayError(`非法回放过程（${detail}）`);
    }
    const now = this.fixture.clock?.fixed_ts ?? Date.now();
    const ctxInputs: Record<string, unknown> = {
      state_hash: this.fixture.input.state_hash,
      task: this.fixture.input.task,
      now,
    };
    const trace: ReplayTraceEntry[] = [];
    const events: string[] = [];
    const outputs = new Map<string, unknown>();

    for (const op of parsedProcess.data.operators) {
      const inputs: Record<string, unknown> = {};
      for (const [name, binding] of Object.entries(op.input_binding)) {
        inputs[name] = resolveBinding(binding, outputs, ctxInputs, op.id);
      }
      const input_hash = sha256hex(canonicalJson(inputs));
      let result: unknown;
      if (op.op === 'EXECUTE') {
        const canned = this.canned.get(cannedKey(op.id, input_hash));
        if (canned === undefined) {
          throw new ReplayError(
            `fixture 不完整——未命中 canned (tool=${op.id}, input_hash=${input_hash})；` +
              `真实执行器不参与回放（未命中即 fail-loud，请补录 canned 项）`,
          );
        }
        result = canned;
      } else {
        result = inputs; // 非工具算子确定性透传（结果 = 解析后输入）
      }
      outputs.set(op.id, result);
      trace.push({ tool: op.id, input_hash, result });
      events.push(`${op.id}:${input_hash}`);
    }

    const state_hash = computeReplayStateHash(trace);

    // 断言 1：最终 state_hash 与录制一致（P7 回放语义）
    if (state_hash !== this.fixture.expected.final_state_hash) {
      return {
        ok: false,
        state_hash,
        detail: `state_hash 断言失败: 实际 ${state_hash} ≠ 期望 ${this.fixture.expected.final_state_hash}（录制不一致或过程/输入已漂移）`,
      };
    }
    // 断言 2：事件序列与录制一致
    if (!eventsEqual(events, this.fixture.expected.events)) {
      return {
        ok: false,
        state_hash,
        detail: `事件序列断言失败: 实际 [${events.join(', ')}] ≠ 期望 [${this.fixture.expected.events.join(', ')}]`,
      };
    }
    return { ok: true, state_hash };
  }
}
