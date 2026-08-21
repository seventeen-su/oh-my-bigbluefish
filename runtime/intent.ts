// OMB v2 Intent ABI 与能力合成（架构 §8.1）。
// layer 2（runtime/）：仅 import node: 内置 + kernel/（同层）+ runtime/ 内文件（CONVENTIONS §4）。
// 合成流程：Intent → CapabilityGraph（默认 fixed plan）→ 契约匹配（input/output 结构兼容 +
// side_effect 权限 + authority_scope 校验）→ Provider Selection（reliability 降序，
// policy.fallback_order 可覆盖）→ Binding（createHandle 生成 CapabilityHandle 链）→
// 执行 + Failure Fallback（降级链：同节点替代 provider；全失败 → 整链失败，Negative Pattern 占位）。
// 与 Broker 的关系：本任务 = 合成 + 降级（T6a.2 在其上加分级路由/软接管）；无循环依赖。
import { z, type ZodType } from 'zod';
import {
  validateContract,
  type CapabilityContract,
  type CapabilityHandle,
  type CapabilityProvider,
  type CapabilityResult,
} from '../kernel/capability-abi.js';

// ---- Intent ABI（P4 语义字段，zod 校验；§4.2 P4 + §8.1） ----

/** P4 Intent 运行时校验：verb/object/scope/effects 枚举 + constraints/required_verification */
export const IntentSchema = z.object({
  verb: z.string().min(1),
  object: z.string().min(1),
  scope: z.string().min(1),
  effects: z.enum(['read_only', 'mutate', 'external']),
  constraints: z.array(z.string()).default([]),
  required_verification: z.string().default(''),
});
export type Intent = z.infer<typeof IntentSchema>;

// ---- CapabilityGraph（fixed plan / DAG） ----

export interface CapabilityGraph {
  nodes: string[];
  edges: [string, string][];
  entry: string;
  exit: string;
}

/** 默认 fixed plan：单节点（verb-object 直连匹配），无自定义 graphPlan 时使用 */
export function defaultGraphPlan(intent: Intent): CapabilityGraph {
  const node = `${intent.verb}-${intent.object}`;
  return { nodes: [node], edges: [], entry: node, exit: node };
}

// ---- 契约匹配辅助（§8.1 契约匹配字段子集） ----

/** side_effect 严重度：provider 的效果等级 ≤ intent 声明的效果等级才放行 */
const SIDE_EFFECT_SEVERITY: Record<string, number> = { none: 0, read_only: 1, mutate: 2, external: 3 };

/** authority_scope 权威映射表（§8.1「映射表记录」）：kernel > system > user > community；未知作用域默认 user 级（不越权） */
const AUTHORITY_RANK: Record<string, number> = { kernel: 3, system: 2, user: 1, community: 0 };
const DEFAULT_AUTHORITY_RANK = AUTHORITY_RANK.user ?? 1;

const RELIABILITY_RANK: Record<string, number> = { high: 3, medium: 2, low: 1 };

/** 绑定 createHandle 的默认预算 */
const DEFAULT_BUDGET = 1000;

/** 提取 zod schema 的对象键（v4：_def.type === 'object' 时取 _def.shape 键；非对象 → 空） */
function schemaObjectKeys(schema: ZodType): string[] {
  const def = (schema as unknown as { _def?: { type?: string; shape?: Record<string, unknown> } })._def;
  if (def?.type === 'object' && def.shape) {
    return Object.keys(def.shape);
  }
  return [];
}

/**
 * 链边 input/output 结构兼容：后节点 input 要求的键 ⊆ 前节点 output 提供的键。
 * 非对象 input（如 z.string()）结构兼容性未知 → 宽松放行（M6 简化）。
 */
function inputCompatibleWith(prevOutput: ZodType, input: ZodType): boolean {
  const outKeys = schemaObjectKeys(prevOutput);
  const inKeys = schemaObjectKeys(input);
  if (inKeys.length === 0) {
    return true;
  }
  return inKeys.every((k) => outKeys.includes(k));
}

/** 契约匹配：side_effect 权限 + authority_scope + 链边 input/output 结构兼容 */
function contractMatches(c: CapabilityContract, intent: Intent, prevOutput?: ZodType): boolean {
  const se = SIDE_EFFECT_SEVERITY[c.side_effect] ?? 0;
  const ie = SIDE_EFFECT_SEVERITY[intent.effects] ?? 0;
  if (se > ie) {
    return false;
  }
  const providerRank = AUTHORITY_RANK[c.authority_scope] ?? DEFAULT_AUTHORITY_RANK;
  const intentRank = AUTHORITY_RANK[intent.scope] ?? DEFAULT_AUTHORITY_RANK;
  if (providerRank > intentRank) {
    return false; // user intent 不能调 kernel 能力（不越权）
  }
  if (prevOutput && !inputCompatibleWith(prevOutput, c.input)) {
    return false;
  }
  return true;
}

/** fallback_order 定位：优先 manifest.id，其次 manifest.name（同能力多 provider 时按 id 区分） */
function fallbackIndex(order: string[], m: CapabilityContract): number {
  const byId = order.indexOf(m.id);
  return byId !== -1 ? byId : order.indexOf(m.name);
}

/** Provider Selection：policy.fallback_order 数据驱动覆盖；否则 reliability 降序（稳定排序保注册序） */
function orderProviders(candidates: CapabilityProvider[], fallbackOrder?: string[]): CapabilityProvider[] {
  return [...candidates].sort((a, b) => {
    if (fallbackOrder && fallbackOrder.length > 0) {
      const ia = fallbackIndex(fallbackOrder, a.manifest);
      const ib = fallbackIndex(fallbackOrder, b.manifest);
      if (ia !== ib) {
        return (ia === -1 ? Number.MAX_SAFE_INTEGER : ia) - (ib === -1 ? Number.MAX_SAFE_INTEGER : ib);
      }
    }
    return (RELIABILITY_RANK[b.manifest.reliability] ?? 0) - (RELIABILITY_RANK[a.manifest.reliability] ?? 0);
  });
}

// ---- 合成结果类型 ----

export interface NodeBinding {
  node: string;
  provider: string; // provider manifest.id
}

/** 每节点降级候选（handles 已按选择顺序排列，首个为 primary） */
export interface NodeFallback {
  node: string;
  handles: CapabilityHandle[];
}

export type SynthesisErrorCode = 'invalid_intent' | 'invalid_graph' | 'no_capability' | 'contract_mismatch' | 'binding_failed';

export type SynthesisResult =
  | { chain: CapabilityHandle[]; graph: CapabilityGraph; bindings: NodeBinding[]; fallbacks: NodeFallback[] }
  | { error: { code: SynthesisErrorCode; reason: string } };

// ---- 执行结果类型 ----

export type ChainResult =
  | { ok: true; outputs: unknown[]; fallbacks_used: string[] }
  | { ok: false; error: { code: string; node: string; reason: string; negative_pattern: string } };

// ---- 执行 + Failure Fallback（降级链） ----

/**
 * 顺序执行链：节点失败 → 同节点替代 provider（fallbacks 数据驱动）→ 全部失败 → 整链失败。
 * 失败时记录 Negative Pattern 占位（M5 演化引擎的挂载点，本任务只占位记录）。
 */
export async function executeChain(
  chain: CapabilityHandle[],
  input: unknown,
  fallbacks: NodeFallback[] = [],
): Promise<ChainResult> {
  const fallbackByNode = new Map(fallbacks.map((f) => [f.node, f.handles]));
  const outputs: unknown[] = [];
  const fallbacks_used: string[] = [];
  let current = input;

  for (const handle of chain) {
    const node = handle.contract.name;
    const candidates = fallbackByNode.get(node) ?? [handle];
    let result: CapabilityResult | undefined;
    let usedHandle: CapabilityHandle | undefined;
    let lastCode = 'E_UNKNOWN';

    for (const cand of candidates) {
      let r: CapabilityResult;
      try {
        r = await cand.execute(current);
      } catch (err) {
        r = {
          ok: false,
          error: { code: 'E_EXECUTE', message: err instanceof Error ? err.message : String(err), retryable: false },
          metrics: { tokens: 0, latency_ms: 0 },
        };
      }
      if (r.ok) {
        result = r;
        usedHandle = cand;
        break;
      }
      lastCode = r.error?.code ?? 'E_UNKNOWN';
    }

    if (!result || !usedHandle) {
      return {
        ok: false,
        error: {
          code: 'chain_failed',
          node,
          reason: `节点 ${node} 全部候选失败: ${lastCode}`,
          negative_pattern: `negative-pattern:node=${node};code=${lastCode}`,
        },
      };
    }
    if (usedHandle !== handle) {
      fallbacks_used.push(usedHandle.contract.id);
    }
    outputs.push(result.output);
    current = result.output;
  }
  return { ok: true, outputs, fallbacks_used };
}

// ---- IntentSynthesizer ----

export interface SynthesizerPolicy {
  fallback_order?: string[];
  budget?: number;
}

export interface IntentSynthesizerOpts {
  providers: Map<string, CapabilityProvider>;
  graphPlan?: (intent: Intent) => CapabilityGraph;
  policy?: SynthesizerPolicy;
}

export class IntentSynthesizer {
  private readonly providers: Map<string, CapabilityProvider>;
  private readonly graphPlan?: (intent: Intent) => CapabilityGraph;
  private readonly policy?: SynthesizerPolicy;

  constructor(opts: IntentSynthesizerOpts) {
    this.providers = new Map(opts.providers);
    this.graphPlan = opts.graphPlan;
    this.policy = opts.policy;
  }

  /** manifest 注册（T2.5 provider 形态直接复用；契约非法 → throw） */
  registerManifest(provider: CapabilityProvider): void {
    const check = validateContract(provider.manifest);
    if (!check.success) {
      throw new Error(`registerManifest: 非法契约 ${provider.manifest.id}`);
    }
    this.providers.set(provider.manifest.id, provider);
  }

  /**
   * 合成：1. zod 校验 intent（非法 → error.invalid_intent）
   * 2. graphPlan(intent) → CapabilityGraph（默认 fixed plan 单节点）
   * 3. 逐节点契约匹配（名称 + side_effect 权限 + authority_scope + 链边 input/output 结构兼容）
   * 4. Provider Selection（reliability 降序，policy.fallback_order 可覆盖）
   * 5. Binding：createHandle 生成 CapabilityHandle 链（含每节点降级候选）
   */
  async synthesize(intent: unknown): Promise<SynthesisResult> {
    const parsed = IntentSchema.safeParse(intent);
    if (!parsed.success) {
      return { error: { code: 'invalid_intent', reason: 'intent 校验失败' } };
    }
    const it = parsed.data;
    const graph = this.graphPlan ? this.graphPlan(it) : defaultGraphPlan(it);
    const graphProblem = validateGraph(graph);
    if (graphProblem) {
      return { error: { code: 'invalid_graph', reason: graphProblem } };
    }

    const chain: CapabilityHandle[] = [];
    const bindings: NodeBinding[] = [];
    const fallbacks: NodeFallback[] = [];
    const selectedByNode = new Map<string, CapabilityProvider>();

    for (const node of graph.nodes) {
      // 链边前驱：edges [from, to]，to === node 的 from 为前驱（线性链假设；多前驱取首个）
      const prevNode = graph.edges.find(([, to]) => to === node)?.[0];
      const prevOutput = prevNode ? selectedByNode.get(prevNode)?.manifest.output : undefined;

      const nameMatched = [...this.providers.values()].filter((p) => p.manifest.name === node);
      const candidates = nameMatched.filter((p) => contractMatches(p.manifest, it, prevOutput));
      if (nameMatched.length === 0) {
        return { error: { code: 'no_capability', reason: `节点 ${node}: 无名称匹配 provider` } };
      }
      if (candidates.length === 0) {
        return { error: { code: 'contract_mismatch', reason: `节点 ${node}: 全部候选被契约过滤` } };
      }

      const ordered = orderProviders(candidates, this.policy?.fallback_order);
      const handles: CapabilityHandle[] = [];
      for (const p of ordered) {
        try {
          handles.push(await p.createHandle({ scope: it.scope, budget: this.policy?.budget ?? DEFAULT_BUDGET }));
        } catch {
          // 绑定失败候选跳过（binding_failed 兜底在下方）
        }
      }
      if (handles.length === 0) {
        return { error: { code: 'binding_failed', reason: `节点 ${node}: createHandle 全部失败` } };
      }

      chain.push(handles[0]!);
      bindings.push({ node, provider: ordered[0]!.manifest.id });
      fallbacks.push({ node, handles });
      selectedByNode.set(node, ordered[0]!);
    }

    return { chain, graph, bindings, fallbacks };
  }

  /** 执行 + 降级链（委托 executeChain） */
  executeChain(chain: CapabilityHandle[], input: unknown, fallbacks: NodeFallback[] = []): Promise<ChainResult> {
    return executeChain(chain, input, fallbacks);
  }
}

/** 图结构校验：nodes 非空、entry/exit 在 nodes 内、edge 端点合法 */
function validateGraph(graph: CapabilityGraph): string | null {
  if (!Array.isArray(graph.nodes) || graph.nodes.length === 0) {
    return 'nodes 为空';
  }
  if (!graph.nodes.includes(graph.entry)) {
    return `entry ${graph.entry} 不在 nodes`;
  }
  if (!graph.nodes.includes(graph.exit)) {
    return `exit ${graph.exit} 不在 nodes`;
  }
  for (const [from, to] of graph.edges) {
    if (!graph.nodes.includes(from) || !graph.nodes.includes(to)) {
      return `edge ${from}→${to} 端点不在 nodes`;
    }
  }
  return null;
}
