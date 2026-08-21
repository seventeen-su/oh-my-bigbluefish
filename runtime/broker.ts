// OMB v2 Capability Broker：第三方兼容分级与软接管（架构 §8.2）。
// layer 2（runtime/）：仅 import node: 内置 + kernel/（同层）+ runtime/ 内文件（CONVENTIONS §4）。
//
// 分级阶梯（§8.2）：共存 → 优先路由（隐式偏好学习）→ 包装增强 → 降权 → shadow → 软接管（末级）。
//   coexist  ：多 provider 共存，注册序执行（默认级）。
//   prefer   ：命中次数计数（隐式偏好学习）→ 排序提升；学习数据 = 内存偏好表（M6a 最小，可扩展 retrieval_episode）。
//   wrap     ：AdapterAPI 包装（before 前置 / after 后置转换）。
//   deweight ：权重降低 → 同能力权重低者排后。
//   shadow   ：执行但结果不入主链（exposure log——复用 T5.3 logExposure，经构造注入避免跨层 import）。
//   takeover ：末级软接管四件套——patch 禁用/覆盖 + restrict 隐藏 + 同名 shadow + post-execute 拦截；可回滚。
//
// 平台硬边界（契约测试 assertHardBoundaries，违反即记录/拒绝）：pre-execute 参数改写、
//   同层同名注册、restrict 全局化/own 层外/run_code、patch 改名/删行、preset root realm 服务。
//
// 复用 T6a.1 IntentSynthesizer（契约匹配 + Provider Selection + 降级链）；分级路由通过
// fallback_order 数据驱动注入合成器，分级语义在 broker 层实现（无循环依赖）。
import {
  defaultGraphPlan,
  executeChain,
  IntentSchema,
  IntentSynthesizer,
  type CapabilityGraph,
  type Intent,
  type NodeBinding,
  type NodeFallback,
} from './intent.js';
import type {
  CapabilityContract,
  CapabilityHandle,
  CapabilityProvider,
  CapabilityResult,
} from '../kernel/capability-abi.js';

// ---- 分级类型与策略（机制即数据） ----

export type TakeoverLevel = 'coexist' | 'prefer' | 'wrap' | 'deweight' | 'shadow' | 'takeover';

/** AdapterAPI（§8.2）：wrap 级前置/后置转换 */
export interface AdapterAPI {
  before?: (input: unknown) => unknown;
  after?: (result: CapabilityResult) => CapabilityResult;
}

export interface BrokerPolicyLevel {
  provider_id: string;
  level: TakeoverLevel;
  /** deweight：权重（低者排后）；默认 1 */
  weight?: number;
  /** shadow：被 shadow 的目标 provider_id（M6a 最小：登记元数据，行为同普通 shadow 级） */
  shadow_of?: string;
  /** wrap：AdapterAPI 包装 */
  adapter?: AdapterAPI;
  /** patch：数据驱动禁用/覆盖（软接管同款机制，策略级复用） */
  patch?: { disable?: string[]; override?: Record<string, unknown> };
}

export interface BrokerPolicy {
  levels: BrokerPolicyLevel[];
}

/** CapabilityDiscovery（§8.2）：按 intent 发现可用 provider（缺省 = 全注册表） */
export interface CapabilityDiscovery {
  discover(intent: Intent): Promise<CapabilityProvider[]>;
}

export interface TakeoverOpts {
  /** patch 覆盖：合并进 shadow 的 manifest/contract（如强制 reliability） */
  override?: Record<string, unknown>;
  /** 同名 shadow：接管后路由到该 provider（要求 manifest.name 与目标一致——patch 改名禁止） */
  shadow?: CapabilityProvider;
  /** post-execute 拦截：shadow 执行结果的后置变换 */
  intercept?: (result: CapabilityResult) => CapabilityResult;
}

/** exposure entry 结构（与 supervisor/shadow.ts 的 ExposureEntry 兼容；注入式复用 T5.3 logExposure） */
export interface ExposureEntryLike {
  ts: number;
  candidate_id: string;
  seed: string;
  bucket: number;
  layer: string;
  decision: string;
}

export interface BrokerOpts {
  providers: Map<string, CapabilityProvider>;
  policy: BrokerPolicy;
  discovery?: CapabilityDiscovery;
  exposureLogPath?: string;
  /** T5.3 logExposure 注入（层 DAG：runtime 不 import supervisor，由宿主注入） */
  logExposure?: (logPath: string, entry: ExposureEntryLike) => Promise<void>;
}

export class BrokerError extends Error {
  constructor(message: string) {
    super(`broker: ${message}`);
    this.name = 'BrokerError';
  }
}

// ---- 解析结果类型 ----

export interface RouteEntry {
  provider_id: string;
  level: TakeoverLevel;
}

export interface ShadowSpec {
  provider_id: string;
  provider: CapabilityProvider;
}

export type Resolution =
  | {
      ok: true;
      intent: Intent;
      /** 主链候选（分级排序后的 provider id） */
      providers: string[];
      /** 每候选的生效分级（与 providers 同序） */
      route: RouteEntry[];
      chain: CapabilityHandle[];
      graph: CapabilityGraph;
      bindings: NodeBinding[];
      fallbacks: NodeFallback[];
      /** restrict 隐藏（软接管目标） */
      hidden: string[];
      /** patch 禁用（软接管目标 + 策略级 patch.disable） */
      disabled: string[];
      /** shadow 级（不入主链） */
      shadow: ShadowSpec[];
    }
  | { ok: false; error: { code: string; reason: string } };

export interface ShadowRun {
  provider_id: string;
  ok: boolean;
}

export type BrokerExecutionResult =
  | { ok: true; outputs: unknown[]; fallbacks_used: string[]; shadow: ShadowRun[] }
  | {
      ok: false;
      error: { code: string; node: string; reason: string; negative_pattern: string };
      shadow: ShadowRun[];
    };

// ---- 分级路由优先级（机制即数据；同级稳定排序保注册序） ----

const LEVEL_PRIORITY: Record<TakeoverLevel, number> = {
  takeover: 0, // 软接管替代者最优先
  prefer: 1, // 优先路由
  wrap: 2, // 包装增强
  coexist: 2, // 共存（与 wrap 同级，注册序）
  deweight: 3, // 降权
  shadow: 4, // shadow 不入主链
};

const DEFAULT_BUDGET = 1000;

interface TakeoverState {
  target: string;
  override?: Record<string, unknown>;
  shadow?: CapabilityProvider;
  intercept?: (result: CapabilityResult) => CapabilityResult;
}

// ---- provider 包装（manifest 覆盖 / adapter / intercept） ----

/** 合并 override 进 manifest 与 createHandle 返回的 contract（patch 覆盖生效于契约面） */
function withManifest(p: CapabilityProvider, override: Record<string, unknown>): CapabilityProvider {
  const manifest = { ...p.manifest, ...override } as CapabilityContract;
  const inner = p;
  return {
    manifest,
    async createHandle(ctx) {
      const h = await inner.createHandle(ctx);
      return { ...h, contract: { ...h.contract, ...override } as CapabilityContract };
    },
  };
}

/** AdapterAPI 包装：before 前置转换 input，after 后置转换 result */
function withAdapter(p: CapabilityProvider, adapter: AdapterAPI): CapabilityProvider {
  const inner = p;
  return {
    manifest: p.manifest,
    async createHandle(ctx) {
      const h = await inner.createHandle(ctx);
      return {
        ...h,
        execute: async (input: unknown) => {
          const pre = adapter.before ? adapter.before(input) : input;
          const r = await h.execute(pre);
          return adapter.after ? adapter.after(r) : r;
        },
      };
    },
  };
}

/** post-execute 拦截：执行结果后置变换 */
function withIntercept(p: CapabilityProvider, intercept: (result: CapabilityResult) => CapabilityResult): CapabilityProvider {
  const inner = p;
  return {
    manifest: p.manifest,
    async createHandle(ctx) {
      const h = await inner.createHandle(ctx);
      return { ...h, execute: async (input: unknown) => intercept(await h.execute(input)) };
    },
  };
}

/** 软接管 shadow 生效形态：override（patch 覆盖）→ intercept（post-execute 拦截） */
function takeoverShadowProvider(st: TakeoverState): CapabilityProvider {
  let p = st.shadow!;
  if (st.override) {
    p = withManifest(p, st.override);
  }
  if (st.intercept) {
    p = withIntercept(p, st.intercept);
  }
  return p;
}

// ---- CapabilityBroker ----

export class CapabilityBroker {
  private readonly providers: Map<string, CapabilityProvider>;
  private readonly policy: BrokerPolicy;
  private readonly discovery?: CapabilityDiscovery;
  private readonly exposureLogPath?: string;
  private readonly logExposure?: (logPath: string, entry: ExposureEntryLike) => Promise<void>;
  /** 隐式偏好表（provider_id → 命中次数；M6a 最小：内存表） */
  private readonly hits = new Map<string, number>();
  /** 软接管状态（target → 接管配置）；rollbackTakeover 恢复 */
  private readonly takeovers = new Map<string, TakeoverState>();
  /** 接管 shadow 的 provider id（路由级 'takeover' + exposure 记录用） */
  private readonly takeoverShadowIds = new Set<string>();

  constructor(opts: BrokerOpts) {
    this.providers = new Map(opts.providers);
    this.policy = opts.policy;
    this.discovery = opts.discovery;
    this.exposureLogPath = opts.exposureLogPath;
    this.logExposure = opts.logExposure;
  }

  // ---- 分级路由（resolve） ----

  /**
   * 分级路由：候选收集（排除隐藏/禁用 + 并入接管 shadow）→ discovery 过滤 →
   * shadow 级分离 → 分级排序（fallback_order 注入合成器）→ T6a.1 合成（契约匹配 + 绑定 + 降级候选）。
   */
  async resolve(intent: unknown): Promise<Resolution> {
    const parsed = IntentSchema.safeParse(intent);
    if (!parsed.success) {
      return { ok: false, error: { code: 'invalid_intent', reason: 'intent 校验失败' } };
    }
    const it = parsed.data;
    const node = defaultGraphPlan(it).entry;

    const hidden = new Set<string>();
    const disabled = new Set<string>();
    for (const l of this.policy.levels) {
      for (const id of l.patch?.disable ?? []) {
        disabled.add(id);
      }
    }
    for (const id of this.takeovers.keys()) {
      hidden.add(id); // restrict 隐藏
      disabled.add(id); // patch 禁用
    }

    // 候选池：注册表内 name 匹配且未被隐藏/禁用 + 接管 shadow（同名）
    let candidates: CapabilityProvider[] = [];
    for (const p of this.providers.values()) {
      if (p.manifest.name !== node) {
        continue;
      }
      if (hidden.has(p.manifest.id) || disabled.has(p.manifest.id)) {
        continue;
      }
      candidates.push(this.applyPolicyTransforms(p));
    }
    for (const st of this.takeovers.values()) {
      if (!st.shadow) {
        continue;
      }
      const eff = takeoverShadowProvider(st);
      if (eff.manifest.name !== node) {
        continue;
      }
      candidates.push(eff);
    }

    if (this.discovery) {
      const discovered = new Set((await this.discovery.discover(it)).map((p) => p.manifest.id));
      candidates = candidates.filter((c) => discovered.has(c.manifest.id));
    }

    const shadowProviders = candidates.filter((c) => this.levelOf(c.manifest.id) === 'shadow');
    const mainCandidates = candidates.filter((c) => this.levelOf(c.manifest.id) !== 'shadow');

    if (mainCandidates.length === 0) {
      return { ok: false, error: { code: 'no_capability', reason: `节点 ${node}: 无可用 provider（全为 shadow/隐藏/禁用）` } };
    }

    const ordered = this.rankCandidates(mainCandidates);
    const synth = new IntentSynthesizer({
      providers: new Map(ordered.map((p) => [p.manifest.id, p])),
      policy: { fallback_order: ordered.map((p) => p.manifest.id) },
    });
    const result = await synth.synthesize(it);
    if ('error' in result) {
      return { ok: false, error: result.error };
    }

    return {
      ok: true,
      intent: it,
      providers: ordered.map((p) => p.manifest.id),
      route: ordered.map((p) => ({ provider_id: p.manifest.id, level: this.levelOf(p.manifest.id) })),
      chain: result.chain,
      graph: result.graph,
      bindings: result.bindings,
      fallbacks: result.fallbacks,
      hidden: [...this.takeovers.keys()],
      disabled: [...disabled],
      shadow: shadowProviders.map((p) => ({ provider_id: p.manifest.id, provider: p })),
    };
  }

  /** 策略级 transform：patch.override（覆盖）+ adapter（wrap 包装） */
  private applyPolicyTransforms(p: CapabilityProvider): CapabilityProvider {
    const lvl = this.policy.levels.find((l) => l.provider_id === p.manifest.id);
    let out = p;
    if (lvl?.patch?.override) {
      out = withManifest(out, lvl.patch.override);
    }
    if (lvl?.adapter) {
      out = withAdapter(out, lvl.adapter);
    }
    return out;
  }

  /** 生效分级：接管 shadow → 'takeover'；策略声明 → 该级；缺省 → coexist */
  private levelOf(providerId: string): TakeoverLevel {
    if (this.takeoverShadowIds.has(providerId)) {
      return 'takeover';
    }
    return this.policy.levels.find((l) => l.provider_id === providerId)?.level ?? 'coexist';
  }

  private weightOf(providerId: string): number {
    return this.policy.levels.find((l) => l.provider_id === providerId)?.weight ?? 1;
  }

  /** 分级排序：优先级升序；prefer 内命中降序；deweight 内权重降序；同级稳定（注册序） */
  private rankCandidates(cands: CapabilityProvider[]): CapabilityProvider[] {
    return [...cands].sort((a, b) => {
      const la = this.levelOf(a.manifest.id);
      const lb = this.levelOf(b.manifest.id);
      const pa = LEVEL_PRIORITY[la]!;
      const pb = LEVEL_PRIORITY[lb]!;
      if (pa !== pb) {
        return pa - pb;
      }
      if (la === 'prefer') {
        return (this.hits.get(b.manifest.id) ?? 0) - (this.hits.get(a.manifest.id) ?? 0);
      }
      if (la === 'deweight') {
        return this.weightOf(b.manifest.id) - this.weightOf(a.manifest.id);
      }
      return 0; // 稳定排序 → 注册序
    });
  }

  // ---- 执行 + 降级链 + shadow + 偏好学习 ----

  /**
   * 执行：① shadow 级 provider 执行（结果不入主链）+ exposure log（T5.3 复用）；
   * ② 主链执行（T6a.1 降级链）；③ 接管 shadow 的 exposure 记录；④ prefer 命中学习。
   */
  async execute(resolution: Resolution, input: unknown): Promise<BrokerExecutionResult> {
    if (!resolution.ok) {
      return {
        ok: false,
        error: { code: 'no_resolution', node: '', reason: 'resolution 无效', negative_pattern: '' },
        shadow: [],
      };
    }

    const shadowRuns: ShadowRun[] = [];
    for (const s of resolution.shadow) {
      let ok = false;
      try {
        const h = await s.provider.createHandle({ scope: resolution.intent.scope, budget: DEFAULT_BUDGET });
        const r = await h.execute(input);
        ok = r.ok;
      } catch {
        ok = false;
      }
      shadowRuns.push({ provider_id: s.provider_id, ok });
      await this.emitExposure(s.provider_id, resolution.intent);
    }

    const chainResult = await executeChain(resolution.chain, input, resolution.fallbacks);

    if (!chainResult.ok) {
      return { ok: false, error: chainResult.error, shadow: shadowRuns };
    }

    for (const h of resolution.chain) {
      if (this.takeoverShadowIds.has(h.contract.id)) {
        await this.emitExposure(h.contract.id, resolution.intent);
      }
    }

    this.learnPreference(resolution, chainResult.fallbacks_used);

    return { ok: true, outputs: chainResult.outputs, fallbacks_used: chainResult.fallbacks_used, shadow: shadowRuns };
  }

  /** exposure log（T5.3 logExposure 注入；未配置则跳过——shadow 结果仍记录于执行结果） */
  private async emitExposure(providerId: string, intent: Intent): Promise<void> {
    if (!this.logExposure || !this.exposureLogPath) {
      return;
    }
    await this.logExposure(this.exposureLogPath, {
      ts: Date.now(),
      candidate_id: providerId,
      seed: `${intent.verb}:${intent.object}`,
      bucket: 0,
      layer: 'shadow',
      decision: 'shadow',
    });
  }

  /** prefer 隐式偏好学习：实际执行成功的 prefer 级 provider 命中 +1（primary 或 fallback） */
  private learnPreference(resolution: Extract<Resolution, { ok: true }>, fallbacksUsed: string[]): void {
    const preferIds = new Set(resolution.route.filter((r) => r.level === 'prefer').map((r) => r.provider_id));
    if (fallbacksUsed.length === 0) {
      const primary = resolution.chain[0]?.contract.id;
      if (primary && preferIds.has(primary)) {
        this.hits.set(primary, (this.hits.get(primary) ?? 0) + 1);
      }
    } else {
      for (const id of fallbacksUsed) {
        if (preferIds.has(id)) {
          this.hits.set(id, (this.hits.get(id) ?? 0) + 1);
        }
      }
    }
  }

  // ---- 软接管（末级）与回滚 ----

  /**
   * 软接管四件套：patch 禁用目标 + restrict 隐藏 + 同名 shadow（接管路由）+ post-execute 拦截。
   * 目标 provider 被隐藏/禁用；同名 shadow 成为该能力的主链路由。
   * 可回滚：rollbackTakeover 恢复原注册与行为。
   */
  async takeover(provider_id: string, opts: TakeoverOpts = {}): Promise<void> {
    const target = this.providers.get(provider_id);
    if (!target) {
      throw new BrokerError(`takeover: 未知 provider ${provider_id}`);
    }
    if (opts.shadow && opts.shadow.manifest.name !== target.manifest.name) {
      throw new BrokerError(`takeover: shadow 必须同名（patch 改名禁止）: ${opts.shadow.manifest.name} ≠ ${target.manifest.name}`);
    }
    this.takeovers.set(provider_id, {
      target: provider_id,
      override: opts.override,
      shadow: opts.shadow,
      intercept: opts.intercept,
    });
    if (opts.shadow) {
      this.takeoverShadowIds.add(opts.shadow.manifest.id);
    }
  }

  /** 软接管回滚：移除接管状态 → 原 provider 恢复路由与行为（shadow/拦截随之失效） */
  async rollbackTakeover(provider_id: string): Promise<void> {
    const st = this.takeovers.get(provider_id);
    if (st?.shadow) {
      this.takeoverShadowIds.delete(st.shadow.manifest.id);
    }
    this.takeovers.delete(provider_id);
  }

  // ---- 平台硬边界断言（契约测试） ----

  /**
   * 平台硬边界断言：每个断言函数对注入的违规动作做检测 → 记录违规项。
   * 检测项：pre-execute 参数改写（hook 改变 input 结构）、同层同名注册、
   * restrict 全局化/own 层外/run_code、patch 改名/删行、preset root realm 服务。
   */
  assertHardBoundaries(ctx: HardBoundaryCtx): string[] {
    const violations: string[] = [];

    ctx.pre_execute((fn) => {
      const sample = { path: '/tmp/a' };
      const before = JSON.stringify(sample);
      const out = fn(sample);
      if (JSON.stringify(out) !== before) {
        violations.push('pre_execute 参数改写');
      }
    });

    ctx.register_same_layer((p) => {
      const dup = [...this.providers.values()].some(
        (x) => x.manifest.name === p.manifest.name && x.manifest.authority_scope === p.manifest.authority_scope,
      );
      if (dup) {
        violations.push('同层同名注册');
      }
    });

    ctx.restrict((opts) => {
      const outOfOwn = opts.scope === 'global' || opts.layer === 'run_code' || (opts.layer !== undefined && opts.layer !== 'own');
      if (outOfOwn) {
        violations.push('restrict 越界');
      }
    });

    ctx.patch((op) => {
      if (op.kind === 'rename' || op.kind === 'delete') {
        violations.push('patch 改名/删行');
      }
    });

    ctx.publish_root_service(() => {
      violations.push('preset root realm 服务');
    });

    return violations;
  }
}

export interface HardBoundaryCtx {
  pre_execute: (run: (fn: (input: unknown) => unknown) => void) => void;
  register_same_layer: (run: (p: CapabilityProvider) => void) => void;
  restrict: (run: (opts: { scope: string; layer?: string }) => void) => void;
  patch: (run: (op: { kind: string; target?: string }) => void) => void;
  publish_root_service: (run: () => void) => void;
}
