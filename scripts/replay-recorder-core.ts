// OMB v2 Replay Fixture 录制工具——核心纯逻辑（developer tooling；架构 §14.6 开放项
// 「Replay Fixture 录制工具」/ §5.2 replay_fixture {event_id → canned_result}；清扫计划
// 2026-08-24-completion-sweep S4）。纯函数（无 I/O）：事件流 → ReplayFixtureFile（canned 库）。
// CLI 薄壳在 scripts/replay-recorder.ts。
//
// 配对语义（canned 键与 supervisor/replay.ts 字节级对齐——CannedEntrySchema 同构复用）：
//   - 按 (session_id, call_id) 配对 tool/call → tool/result（call_id 以 payload.call_id 优先、
//     tool_id 兜底，与 DSH mapper / state-reducer 兼容）；同 (session, call_id) 多次 → 以最后
//     call/result 为准（修正/重试语义：最新结果才是当前事实，历史事件保留在事件库不删除）。
//   - canned 条目 = { tool, input_hash, result }：
//       tool = call payload.name（缺省 call_id；回放过程 EXECUTE 算子 id 须与其一致）；
//       input_hash = sha256(canonicalJson(解析后 arguments))——与 ReplayRunner 的算子输入哈希同契约
//       （回放算子的 input_binding 解析出的 inputs 对象须与录制 arguments 等价）；arguments 为 JSON
//       字符串 → parse（失败 → 原样字符串），对象/数组 → 原样，空/缺 → {}；
//       result = tool/result payload.result 原样（含非确定性内容如时间戳——回放语义由
//       ReplayRunner / fixture.clock.fixed_ts 决定，录制端不归一化）。
//   - fixture 映射键 = tool/result 事件 id（跨会话唯一且确定性；§5.2 event_id → canned_result）。
//   - 不可录制（non_replayable，含 stub 偏差说明）：
//       ① call 无配对 result；② 孤儿 result（无 call，缺输入参数无法算 input_hash）；
//       ③ result 缺 result 内容（payload 仅签名——DSH mapper 现状，stub 偏差）；
//       ④ 非确定性源冲突（同 tool+input_hash 多次不同结果 → 保留首次，后续 non-replayable）。
//   - 确定性：同输入同输出（fixture 键排序 + non_replayable 排序 + ts/name/version/source 由
//     opts 显式传入时固定）。
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '../kernel/schemas/base.js';
import type { Event } from '../kernel/schemas/m.js';
import { CannedEntrySchema, type ReplayCannedEntry } from '../supervisor/replay.js';

// ---- 常量 ----

/** 录制文件格式版本（generated.version） */
export const RECORDER_VERSION = '1.0.0';
/** 缺省 fixture 名（generated.name + 产物文件前缀） */
export const DEFAULT_NAME = 'replay-fixture';

// ---- 不可录制 reason（稳定字符串，测试断言锚点） ----

export const REASON_MISSING_RESULT = '无 tool/result 配对（call 缺结果，不可录制）';
export const REASON_ORPHAN_RESULT = '无 tool/call 配对（孤儿 result，缺输入参数）';
export const REASON_MISSING_CONTENT = 'tool/result 缺 result 内容（payload 仅签名/无内容——stub 偏差）';
export const REASON_ND_CONFLICT = '非确定性源：同 tool+input_hash 多次不同结果（冲突，保留首次）';

// ---- Schema（机制即数据：录制产物为数据，zod 校验，非法 fail-loud） ----

/** 不可录制条目（stub 偏差记录：缺结果 / 孤儿 / 缺内容 / 非确定性源冲突） */
export const NonReplayableEntrySchema = z.object({
  call_id: z.string().min(1),
  session_id: z.string().min(1),
  tool: z.string().min(1),
  reason: z.string().min(1),
});
export type NonReplayableEntry = z.infer<typeof NonReplayableEntrySchema>;

/** 生成元数据（录制来源与时间；CLI 传入真实值，测试固定 → 确定性） */
export const GeneratedInfoSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  source: z.string().min(1),
  ts: z.string().min(1),
});
export type GeneratedInfo = z.infer<typeof GeneratedInfoSchema>;

/** 录制产物文件（§5.2 replay_fixture {event_id → canned_result}）：fixture 键 = tool/result 事件 id；
 *  值 = 与 ReplayRunner 消费的 CannedEntrySchema 同构（可直接组装进 ReplayFixture.canned） */
export const ReplayFixtureFileSchema = z.object({
  fixture: z.record(z.string(), CannedEntrySchema),
  non_replayable: z.array(NonReplayableEntrySchema),
  generated: GeneratedInfoSchema,
});
export type ReplayFixtureFile = z.infer<typeof ReplayFixtureFileSchema>;

/** 录制选项（缺省值确定性；source/ts 缺省时依赖输入/时钟——CLI 与测试均显式传入） */
export interface RecordOptions {
  name?: string;
  version?: string;
  source?: string;
  ts?: string;
}

// ---- 确定性工具 ----

function sha256hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

function asString(v: unknown): string {
  return typeof v === 'string' && v.length > 0 ? v : '';
}

/** call/result payload 的调用标识（DSH mapper 用 call_id；state-reducer 兼容 tool_id） */
function callIdOf(payload: Record<string, unknown>): string {
  return asString(payload.call_id) || asString(payload.tool_id);
}

/** 工具名（canned.tool；回放过程 EXECUTE 算子 id 须与其一致） */
function toolNameOf(payload: Record<string, unknown>, fallback: string): string {
  return asString(payload.name) || fallback;
}

/** 解析 arguments → 录制输入（input_hash 的输入对象，与 ReplayRunner 算子输入哈希同契约） */
function parseArguments(raw: unknown): unknown {
  if (raw === undefined || raw === null) {
    return {};
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      return {};
    }
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return raw; // 非 JSON 字符串（如文件路径）→ 原样（确定性输入）
    }
  }
  return raw;
}

/** 可录制结果内容：payload 显式带 result 键（含 null 值）且非 undefined；否则无内容（stub） */
function resultContentOf(payload: Record<string, unknown>): { present: boolean; value: unknown } {
  if (Object.prototype.hasOwnProperty.call(payload, 'result') && payload.result !== undefined) {
    return { present: true, value: payload.result };
  }
  return { present: false, value: undefined };
}

/** 深拷贝（结果内容来自 JSON 数据；防输出别名输入） */
function deepCopy(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

// ---- 配对结构（跨会话隔离：按 session 分组，session 间永不串） ----

interface CallInfo {
  payload: Record<string, unknown>;
  callId: string;
  tool: string;
  inputs: unknown;
}

interface ResultInfo {
  event: Event;
  payload: Record<string, unknown>;
  callId: string;
}

/** canned 候选（key = tool/result 事件 id；携带会话信息供冲突 non-replayable 记录） */
interface CannedCandidate {
  key: string;
  entry: ReplayCannedEntry;
  callId: string;
  sessionId: string;
}

/**
 * 录制核心：事件流 → ReplayFixtureFile。
 * 事件顺序 = 流序（events.db 按 seq / JSONL 按行）；同 (session, call_id) 后者覆盖前者（最新为准）。
 */
export function recordFixtures(events: readonly Event[], opts: RecordOptions = {}): ReplayFixtureFile {
  // 1) 按会话收集 call/result
  const calls = new Map<string, Map<string, CallInfo>>();
  const results = new Map<string, Map<string, ResultInfo>>();
  const sessions = new Set<string>();
  for (const e of events) {
    if (e.type !== 'tool/call' && e.type !== 'tool/result') {
      continue;
    }
    sessions.add(e.session_id);
    const payload = e.payload as Record<string, unknown>;
    const callId = callIdOf(payload);
    if (callId.length === 0) {
      continue; // 缺标识的工具事件 → 不采集（同 mapper 诚实边界）
    }
    if (e.type === 'tool/call') {
      let m = calls.get(e.session_id);
      if (m === undefined) {
        m = new Map();
        calls.set(e.session_id, m);
      }
      m.set(callId, {
        payload,
        callId,
        tool: toolNameOf(payload, callId),
        inputs: parseArguments(payload.arguments),
      });
    } else {
      let m = results.get(e.session_id);
      if (m === undefined) {
        m = new Map();
        results.set(e.session_id, m);
      }
      m.set(callId, { event: e, payload, callId });
    }
  }

  // 2) 配对 → canned 候选 + 不可录制
  const canned: CannedCandidate[] = [];
  const nonReplayable: NonReplayableEntry[] = [];
  for (const [sessionId, sessionCalls] of calls) {
    const sessionResults = results.get(sessionId);
    for (const [callId, call] of sessionCalls) {
      const result = sessionResults?.get(callId);
      if (result === undefined) {
        nonReplayable.push({ call_id: callId, session_id: sessionId, tool: call.tool, reason: REASON_MISSING_RESULT });
        continue;
      }
      const content = resultContentOf(result.payload);
      if (!content.present) {
        nonReplayable.push({ call_id: callId, session_id: sessionId, tool: call.tool, reason: REASON_MISSING_CONTENT });
        continue;
      }
      const input_hash = sha256hex(canonicalJson(call.inputs));
      canned.push({
        key: result.event.id,
        entry: { tool: call.tool, input_hash, result: deepCopy(content.value) },
        callId,
        sessionId,
      });
    }
  }
  for (const [sessionId, sessionResults] of results) {
    const sessionCalls = calls.get(sessionId);
    for (const [callId, result] of sessionResults) {
      if (sessionCalls?.has(callId) === true) {
        continue; // 已配对
      }
      nonReplayable.push({
        call_id: callId,
        session_id: sessionId,
        tool: toolNameOf(result.payload, callId),
        reason: REASON_ORPHAN_RESULT,
      });
    }
  }

  // 3) 非确定性源冲突去重：同 (tool, input_hash) 首次保留；同结果精确重复 → 静默去重；不同结果 → non-replayable
  const fixture: Record<string, ReplayCannedEntry> = {};
  const seen = new Map<string, { result: unknown; callId: string; sessionId: string }>();
  for (const c of canned) {
    const key = `${c.entry.tool}\u0000${c.entry.input_hash}`;
    const prev = seen.get(key);
    if (prev === undefined) {
      seen.set(key, { result: c.entry.result, callId: c.callId, sessionId: c.sessionId });
      fixture[c.key] = c.entry;
      continue;
    }
    if (JSON.stringify(prev.result) !== JSON.stringify(c.entry.result)) {
      nonReplayable.push({
        call_id: c.callId,
        session_id: c.sessionId,
        tool: c.entry.tool,
        reason: REASON_ND_CONFLICT,
      });
    }
    // 同结果（同 call 幂等重录）→ 静默去重
  }

  // 4) 确定性组装：fixture 键排序 + non_replayable 排序 + generated
  const sortedFixture: Record<string, ReplayCannedEntry> = {};
  for (const k of Object.keys(fixture).sort()) {
    sortedFixture[k] = fixture[k]!;
  }
  nonReplayable.sort((a, b) => {
    const sa = `${a.session_id}\u0000${a.call_id}\u0000${a.reason}`;
    const sb = `${b.session_id}\u0000${b.call_id}\u0000${b.reason}`;
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  });
  const file: ReplayFixtureFile = {
    fixture: sortedFixture,
    non_replayable: nonReplayable,
    generated: {
      name: opts.name ?? DEFAULT_NAME,
      version: opts.version ?? RECORDER_VERSION,
      source: opts.source ?? `${events.length} events / ${sessions.size} sessions`,
      ts: opts.ts ?? new Date().toISOString(),
    },
  };
  const parsed = ReplayFixtureFileSchema.safeParse(file);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new Error(`recordFixtures: 录制产物自校验失败——${detail}`);
  }
  return parsed.data;
}

/** 产物文件名（<name>.replay-fixture.json；与 G3 的 <name>.fixture.json 区分——本文件为 canned 库） */
export function replayFixtureFileName(name: string): string {
  return `${name}.replay-fixture.json`;
}

/** 确定性序列化：固定键序（构造序）+ 2 空格缩进 + 末尾换行（与仓库 JSON 文件约定一致） */
export function serializeReplayFixtureFile(file: ReplayFixtureFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}
