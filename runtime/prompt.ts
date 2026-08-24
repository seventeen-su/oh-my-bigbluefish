// OMB v2 systemPrompt 集成（架构 §6.2 语义体系 / §14.1）：模型可见渲染文本的组装器。
// 原则：宪法与内部机制不进入 prompt——哲学直接作用于 Semantic IR（§14.1），prompt 只含
//   模型完成任务真正需要的最小契约说明（任务语义/必要约定/输出预期）+ 动态尾部
//   （working_state 渲染，紧凑中文键值；goal 在静态区，尾部不再重复）。
// Model-visible ⟺ logged：buildPrompt 一次调用即代表一次"模型可见"；调用方注入 onVisible 钩子
//   （brief 决策：不新增事件类型——在 session/start 事件 payload 带 prompt_tokens 统计；
//   makePromptVisibilityEvent 提供事件构造，EventStore 接线由调用方注入，本模块保持纯函数）。
// token 估算（近似公式，M7 基准校准）：中文（含全角标点）≈ 1 token/字符，其余 ≈ 4 字符/token。
// layer 2（runtime/）：仅 import node: 内置与同层 kernel/schemas（CONVENTIONS §4）；纯函数、无副作用。
import { makeMutableId } from '../kernel/schemas/base.js';
import type { ContextProjection } from '../kernel/schemas/a.js';
import type { Event } from '../kernel/schemas/m.js';
// R6：dsh_version 唯一宿主版本来源（kernel/schemas IR 契约层，runtime(2) → kernel/schemas(2) ✓）
import { hostVersion } from '../kernel/schemas/host-version.js';

// ---- 视图类型（S1/S3 最小视图：prompt 只消费语义字段，不依赖完整 IR 对象） ----

/** TaskContract 最小视图（S1 字段级子集：goal + constraints + success_criteria） */
export interface PromptTaskContract {
  goal: string;
  constraints: string[];
  success_criteria: string[];
}

/** WorkingState 最小视图（S3 字段级子集：8 字段；environment 为字符串渲染值） */
export interface PromptWorkingState {
  goal: string;
  confirmed_facts: string[];
  active_hypotheses: string[];
  contradictions: string[];
  open_questions: string[];
  evidence_gaps: string[];
  next_best_action: string;
  environment: string;
}

/** prompt section（name/order 与 DSH systemPrompt.section 对齐，便于 M2 后真实集成） */
export interface PromptSection {
  name: string;
  order: number;
  text: string;
  tokens: number;
}

/** buildPrompt 输出：system = 全部 section 按 order 拼接的模型可见文本 */
export interface BuiltPrompt {
  system: string;
  sections: PromptSection[];
  total_tokens: number;
}

/** buildPrompt 输入（session_id 供 logged 钩子） */
export interface PromptInput {
  session_id: string;
  task_contract: PromptTaskContract;
  working_state: PromptWorkingState;
  /** Context Compiler 输出（可选）：planning/evidence_artifact 视图作为上下文 section 进入 prompt */
  projection?: ContextProjection;
}

// ---- logged 钩子（注入回调，本模块不直接碰 EventStore） ----

/** Model-visible ⟺ logged：prompt 建成（模型可见）时调用一次（session_id, prompt_tokens） */
export type PromptVisibilityHook = (session_id: string, prompt_tokens: number) => void;

// ---- 内部机制词黑名单（测试与实现共享，防漂移） ----

/** prompt 严禁出现的内部机制词（宪法/不变量/IR/schema 等；测试黑名单断言共用） */
export const INTERNAL_MECHANISM_WORDS = [
  '宪法',
  '不变量',
  'IR',
  'schema',
  'Governor',
  'ContextCompiler',
  'ContextProjection',
  'EventStore',
  'working_state',
  'IRBase',
] as const;

// ---- buildPrompt：静态区 + 动态尾部 + 上下文投影 ----

/**
 * 组装模型可见 prompt（确定性纯函数：同输入同输出，无随机/无时间依赖）。
 * 静态区：任务语义（task_contract.goal 一行）、必要约定（constraints 摘要，有则渲染）、
 *   输出预期（success_criteria 摘要，有则渲染）——不注入宪法/机制/内部对象结构；
 * 动态尾部：working_state 紧凑渲染（goal 已在静态区）；
 * 上下文：projection 的 planning/evidence_artifact 视图 section（execution_scratch 默认隔离，§6.1）。
 * Model-visible ⟺ logged：构建完成后调用 onVisible(input.session_id, total_tokens) 一次。
 */
export function buildPrompt(input: PromptInput, onVisible?: PromptVisibilityHook): BuiltPrompt {
  const tc = input.task_contract;
  const sections: PromptSection[] = [section('任务', 10, `任务：${tc.goal}`)];
  if (tc.constraints.length > 0) {
    sections.push(section('约定', 20, `约定：${tc.constraints.join('；')}`));
  }
  if (tc.success_criteria.length > 0) {
    sections.push(section('输出预期', 30, `输出预期：${tc.success_criteria.join('；')}`));
  }
  sections.push(section('工作状态', 40, renderWorkingState(input.working_state)));
  appendProjectionSections(sections, input.projection);

  const ordered = [...sections].sort((a, b) => a.order - b.order);
  const system = ordered.map((s) => s.text).join('\n');
  const total_tokens = countTokens(system);

  if (onVisible !== undefined) {
    onVisible(input.session_id, total_tokens);
  }
  return { system, sections: ordered, total_tokens };
}

/** 动态尾部：working_state 紧凑中文键值渲染（7 字段；goal 已在静态区，不重复） */
export function renderWorkingState(ws: PromptWorkingState): string {
  return [
    `已确认事实：${renderList(ws.confirmed_facts)}`,
    `活跃假设：${renderList(ws.active_hypotheses)}`,
    `矛盾：${renderList(ws.contradictions)}`,
    `开放问题：${renderList(ws.open_questions)}`,
    `证据缺口：${renderList(ws.evidence_gaps)}`,
    `下一步行动：${ws.next_best_action}`,
    `环境：${ws.environment}`,
  ].join('\n');
}

/**
 * token 近似估算（公式标注，M7 基准校准）：中文（含全角标点/扩展A）≈ 1 token/字符，
 * 其余（ASCII/数字/空白）≈ 4 字符/token；空串 0。单调：文本更长 → token 不降。
 */
export function countTokens(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (CJK_RE.test(ch)) {
      cjk += 1;
    } else {
      other += 1;
    }
  }
  return cjk + Math.ceil(other / 4);
}

/**
 * logged 事件构造（brief 决策：不新增事件类型）：session/start 事件 payload 带 prompt_tokens 统计。
 * id 为可变对象 uuid（Event 非 immutable，irBase refine 禁止 sha256 id）；时间戳为固定纪元值
 * （确定性；真实时间由调用层注入）。EventStore 接线在调用方：hook = (sid, tokens) =>
 * store.append(makePromptVisibilityEvent(sid, tokens))。
 */
export function makePromptVisibilityEvent(session_id: string, prompt_tokens: number): Event {
  return {
    ir_version: '2.0',
    id: makeMutableId('evt'),
    schema: 'omb/M3',
    scope: 'Session',
    lifecycle: 'active',
    immutable: false,
    owner: 'kernel',
    created: FIXED_TS,
    updated: FIXED_TS,
    provenance: fixedProvenance(),
    refs: [],
    type: 'session/start',
    session_id,
    runtime_snapshot: 'rs:prompt',
    parent_event: null,
    payload: { prompt_tokens },
    timestamp: FIXED_TS,
  };
}

// ---- 内部辅助（纯函数） ----

/** section 工厂：tokens 用同一 countTokens 公式（与 total_tokens 一致口径） */
function section(name: string, order: number, text: string): PromptSection {
  return { name, order, text, tokens: countTokens(text) };
}

/** 数组紧凑渲染：';' 连接；空数组 → 无 */
function renderList(items: readonly string[]): string {
  return items.length > 0 ? items.join('；') : '无';
}

/** 上下文投影追加：execution_scratch 默认隔离（架构 §6.1：仅摘要或指针回流）→ 不进 prompt */
function appendProjectionSections(sections: PromptSection[], projection: ContextProjection | undefined): void {
  if (projection === undefined) {
    return;
  }
  projection.sections
    .filter((s) => s.view === 'planning' || s.view === 'evidence_artifact')
    .forEach((s, i) => {
      sections.push(section('上下文', 50 + i, s.content));
    });
}

// ---- 常量 ----

/** CJK 统一表意区 + 扩展A + 中文全角标点区（近似中文 token 计量面） */
const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\uff00-\uffef]/;

/** 固定纪元时间戳（确定性纯函数不读时钟；真实时间由调用层注入） */
const FIXED_TS = '2026-08-21T00:00:00.000Z';

/** 固定 Provenance（确定性占位；时间戳/环境固定——R6：dsh_version 经 hostVersion() 取唯一宿主版本来源，
 *  运行时求值：装配注入后 = 注入值（函数而非常量——常量会在注入前固化默认值造成漂移）；
 *  跨环境迁移语义由调用层负责） */
function fixedProvenance() {
  return {
    source: 'prompt',
    event: 'session/start',
    actor: 'kernel',
    environment: { os: 'win32', node: '24.12.0', dsh_version: hostVersion(), project: 'omb-v2' },
    runtime_snapshot: 'rs:prompt',
    timestamp: FIXED_TS,
    transformation_chain: ['buildPrompt', 'logPromptVisibility'],
    verification: 'deterministic-pure',
  };
}
