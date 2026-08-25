// P2 行为测试：组件注册表装配（runtime/assembly.ts，TDD——先于实现编写）+
// 能力注册表衔接（supervisor/capability.ts）+ DSH 工具注册桥（runtime/kern-tools.ts → runtime/plugin.ts）。
// 覆盖（总计划 P2）：
//   组件装配：装配期注册表含 memory-retrieval（inject=memory）；ready() 激活 → effect 可检索；close() 批量 dispose 回滚
//   health：onHealthCheck 失败 → 组件打 suspicious 降级（不卸载，get 仍可取）；成功 → 无 suspicious
//   能力登记：组件 manifest 声明的能力 → 能力注册表可查（authority_scope=kernel）；同层同名冲突 fail-loud
//   kern_status：fake ctx tools 面捕获注册（name/description/output/execute）；execute 返回状态摘要
//                （版本线/快照哈希/lineSnapshot/debt/信号数/组件健康）；无 tools 面 → 降级不崩
// fixture：mkdtemp 临时 db（不动真实 workspace/.omb，CONVENTIONS §6）；afterEach 先 close 再 rm（Windows WAL 锁）。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createCognitiveRuntime,
  registerComponentCapabilities,
  type CognitiveRuntime,
} from '../../runtime/assembly.js';
import { apply, type ContextLike } from '../../runtime/plugin.js';
import { ComponentRegistry, type ComponentHealthResult } from '../../supervisor/component-registry.js';
import { CapabilityRegistry } from '../../supervisor/capability.js';
import {
  kernStatusTool,
  registerKernTools,
  type KernStatusSummary,
  type ToolDefinitionLike,
  type ToolsLike,
} from '../../runtime/kern-tools.js';
import { clearDegradations, degradationLog } from '../../runtime/loop-hooks.js';
import { memoryRetrievalComponent, type MemoryRetrievalEffect } from '../../memory/memory-retrieval.js';
import { buildLayoutFixture, teardownLayoutFixture } from '../helpers/git.js';

/** fixture 构建/真实 git 超时（buildLayoutFixture：2 提交 + 3 worktree + 2 icacls；全量套件并行时
 *  git/icacls 饱和（已知 flake 类）→ 放宽防环境超时） */
const FIXTURE_TIMEOUT = 30000;

let base: string;
let root: string;
let runtime: CognitiveRuntime;
const runtimes: CognitiveRuntime[] = [];

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'omb-p2-'));
  root = join(base, '.omb');
  runtimes.length = 0;
  clearDegradations();
});

afterEach(async () => {
  for (const rt of runtimes) {
    await rt.close();
  }
  runtimes.length = 0;
  await rm(base, { recursive: true, force: true });
});

function track(rt: CognitiveRuntime): CognitiveRuntime {
  runtime = rt;
  runtimes.push(rt);
  return rt;
}

/** 捕获 ctx.tools.register 的 fake ctx（含 effect 捕获——验证插件关闭 → 批量 dispose 回滚） */
function makeFakeCtx(opts: {
  runtime?: CognitiveRuntime;
  tools?: boolean;
}): { ctx: ContextLike; tools: ToolDefinitionLike[]; effects: Array<() => unknown> } {
  const tools: ToolDefinitionLike[] = [];
  const effects: Array<() => unknown> = [];
  const ctx: ContextLike = {
    commands: { register: () => undefined },
    cognitive: opts.runtime,
    tools:
      opts.tools === false
        ? undefined
        : {
            register: (def: unknown) => {
              tools.push(def as ToolDefinitionLike);
              return undefined; // 真实 DSH 返回注销 disposer；fake 返回 undefined（无 disposer 场景）
            },
          },
    effect: (cb: () => unknown) => {
      effects.push(cb);
      return () => undefined;
    },
  };
  return { ctx, tools, effects };
}

describe('P2 组件注册表装配（runtime/assembly.ts）', () => {
  it('装配：注册表含 memory-retrieval（inject=memory）；ready() 激活 → effect 可检索', async () => {
    runtime = track(createCognitiveRuntime({ root }));
    expect(runtime.components).toBeDefined();
    expect(runtime.components.size).toBe(1);
    expect(runtime.components.statusOf('component:memory-retrieval')).toBe('registered'); // 装配期注册、未激活

    await runtime.ready(); // 激活 + health check（幂等）
    expect(runtime.components.statusOf('component:memory-retrieval')).toBe('active');
    const effect = runtime.components.get<MemoryRetrievalEffect>('component:memory-retrieval');
    expect(effect).not.toBeNull();
    expect(effect!.isActive()).toBe(true);
    expect(runtime.components.suspicious()).toEqual([]); // backend 健康 → 无 suspicious
  });

  it('组件激活顺序：注册序（inject 为装配者提供依赖的契约面，无自动依赖图解析）——memory-retrieval 注册先于激活', async () => {
    runtime = track(createCognitiveRuntime({ root }));
    // registry 公开面：注册序 = 激活序；manifests() 暴露已注册组件的 manifest（能力登记遍历用）
    expect(runtime.components.manifests().map((m) => m.manifest_id)).toEqual(['component:memory-retrieval']);
    expect(runtime.components.manifests()[0]!.inject).toEqual(['memory']);
    expect(runtime.components.manifests()[0]!.provides).toEqual(['memory.retrieve']);
  });

  it('ctx.effect 接线：插件关闭（effect 清理）→ 组件批量 dispose 回滚（P8 注册皆效应）', async () => {
    runtime = track(createCognitiveRuntime({ root }));
    await runtime.ready();
    expect(runtime.components.statusOf('component:memory-retrieval')).toBe('active');

    const { ctx, effects } = makeFakeCtx({ runtime, tools: false });
    apply(ctx, { bootstrap: false });
    // apply 注册的关闭 effect：回调立即执行 → 返回清理函数（关闭运行时 → 组件 disposeAll 回滚）
    expect(effects.length).toBeGreaterThan(0);
    const cleanup = effects[0]!();
    expect(typeof cleanup).toBe('function');
    await (cleanup as () => Promise<void>)();

    expect(runtime.components.statusOf('component:memory-retrieval')).toBe('disposed');
    expect(runtime.components.get('component:memory-retrieval')).toBeNull(); // 释放后不可再取
  });

  it('health 失败 → 组件打 suspicious 降级（不卸载：get 仍可取；disposeAll 后可释放）', async () => {
    const registry = new ComponentRegistry();
    registry.register(
      {
        manifest: { manifest_id: 'comp:unhealthy', name: 'unhealthy', version: '1.0.0', inject: [], provides: [] },
        create: () => ({
          effect: { id: 'unhealthy' },
          health: () => false, // onHealthCheck 失败（如 backend 关闭）
        }),
      },
      {},
    );
    await registry.activate();
    expect(registry.suspicious()).toEqual([]);

    const report = await registry.healthCheck();
    expect(report['comp:unhealthy']!.ok).toBe(false);
    expect(registry.suspicious()).toEqual(['comp:unhealthy']); // 打 suspicious
    expect(registry.statusOf('comp:unhealthy')).toBe('suspicious'); // 状态标记
    expect(registry.get('comp:unhealthy')).not.toBeNull(); // 降级不卸载——effect 仍可取

    // health 恢复 → 清除 suspicious（周期心跳语义）
    const okRegistry = new ComponentRegistry();
    let healthy = false;
    okRegistry.register(
      {
        manifest: { manifest_id: 'comp:recover', name: 'recover', version: '1.0.0', inject: [], provides: [] },
        create: () => ({ effect: { id: 'recover' }, health: () => healthy }),
      },
      {},
    );
    await okRegistry.activate();
    await okRegistry.healthCheck();
    expect(okRegistry.suspicious()).toEqual(['comp:recover']);
    healthy = true;
    await okRegistry.healthCheck();
    expect(okRegistry.suspicious()).toEqual([]);

    await registry.disposeAll();
    expect(registry.statusOf('comp:unhealthy')).toBe('disposed');
    expect(registry.suspicious()).toEqual([]); // 释放后状态清零
  });

  it('运行时周期心跳入口：healthCheckComponents() 返回逐组件健康报告（memory-retrieval backend 健康）', async () => {
    runtime = track(createCognitiveRuntime({ root }));
    const report = await runtime.healthCheckComponents();
    expect(report['component:memory-retrieval']).toBeDefined();
    expect(report['component:memory-retrieval']!.ok).toBe(true);
    expect(typeof (report['component:memory-retrieval']! as ComponentHealthResult).checked_at).toBe('number');
  });
});

describe('P2 能力注册表衔接（supervisor/capability.ts + components manifest）', () => {
  it('组件 manifest 声明的能力 → 能力注册表可查（authority_scope=kernel；确定性 id）', async () => {
    runtime = track(createCognitiveRuntime({ root }));
    const caps = runtime.capabilities.discover({ name: 'memory.retrieve' });
    expect(caps).toHaveLength(1);
    expect(caps[0]!.authority_scope).toBe('kernel');
    expect(caps[0]!.reliability).toBe('high');
    expect(caps[0]!.id).toContain('component:memory-retrieval');
    expect(runtime.capabilities.discover({ name: 'memory.retrieve', scope: 'kernel' })).toHaveLength(1);
  });

  it('能力冲突 fail-loud：同层（kernel）同名注册 → 抛错（capability.ts 语义复用）', async () => {
    runtime = track(createCognitiveRuntime({ root }));
    // 另一个组件声明同名能力（同 authority_scope）→ 冲突 fail-loud
    expect(() =>
      registerComponentCapabilities(runtime.capabilities, {
        manifest_id: 'component:other',
        capabilities: ['memory.retrieve'],
      }),
    ).toThrow(/冲突|同名|kernel/);
    // 异层同名 → 允许（分级基础，capability.ts 语义）
    runtime.capabilities.register({
      id: 'capability:user-level:memory.retrieve',
      name: 'memory.retrieve',
      authority_scope: 'user',
      reliability: 'low',
    });
    expect(runtime.capabilities.discover({ name: 'memory.retrieve' })).toHaveLength(2);
  });

  it('CapabilityRegistry 独立语义不变（register/discover/unregister）', () => {
    const reg = new CapabilityRegistry();
    reg.register({ id: 'capability:x', name: 'x', authority_scope: 'kernel' });
    expect(reg.discover({ name: 'x' })).toHaveLength(1);
    expect(() =>
      reg.register({ id: 'capability:y', name: 'x', authority_scope: 'kernel' }),
    ).toThrow(/冲突|同名|kernel/);
    reg.unregister('capability:x');
    expect(reg.count()).toBe(0);
  });
});

describe('P2 DSH 工具注册桥（kern_status）', () => {
  it('kern_status 注册：fake ctx tools 面捕获（name=kern_status、description 非空、output/execute 齐备）', async () => {
    runtime = track(createCognitiveRuntime({ root }));
    const { ctx, tools } = makeFakeCtx({ runtime });
    expect(() => apply(ctx, { bootstrap: false })).not.toThrow();
    const def = tools.find((t) => t.name === 'kern_status');
    expect(def).toBeDefined();
    expect(def!.description.length).toBeGreaterThan(0);
    expect(typeof def!.execute).toBe('function');
    expect(def!.output).toBeDefined();
    expect(typeof def!.output.render).toBe('function');
  });

  it(
    'execute 返回状态摘要：版本线/快照哈希/lineSnapshot/debt 快照/最近信号数/组件健康（纯读取）',
    async () => {
      // 注入临时 fixture 布局（机器状态解耦——同 evolution-signals ⑥ / evolve-command ②）：
      // 不注入会解析真实机器的合法线快照（workspace/.omb/lines/stable/...），断言随机器状态漂移
      const fx = buildLayoutFixture();
      try {
        runtime = track(
          createCognitiveRuntime({
            root,
            layout: { bareRepo: fx.bare, stableWorktree: fx.stable, latestWorktree: fx.latest },
          }),
        );
        const { ctx, tools } = makeFakeCtx({ runtime });
        apply(ctx, { bootstrap: false });
        const def = tools.find((t) => t.name === 'kern_status')!;
        const summary = (await def.execute({}, {})) as KernStatusSummary;

        expect(summary.line).toBe('stable'); // 缺省版本线
        expect(summary.snapshot_hash).toMatch(/^rs:/); // 快照哈希（rs:<16hex> 或全降级 rs:assembly）
        // fixture 布局注入 → 线快照按 fixture 确定性物化（line='stable'；commit/dir 为 fixture 值，非真实机器状态）
        expect(summary.line_snapshot).toMatchObject({ line: 'stable' });
        expect(Array.isArray(summary.debt)).toBe(true); // 维护债务快照（未注入 scheduler → 空数组）
        expect(typeof summary.recent_signals).toBe('number'); // 最近信号数（无信号目录 → 0）
        expect(summary.components.registered).toContain('component:memory-retrieval');
        expect(summary.components.active).toContain('component:memory-retrieval');
        expect(summary.components.suspicious).toEqual([]);
        expect(summary.components.health[0]).toMatchObject({ manifest_id: 'component:memory-retrieval', ok: true });
      } finally {
        teardownLayoutFixture(fx);
      }
    },
    FIXTURE_TIMEOUT,
  );

  it('kern_status 独立定义：无 runtime.status() → execute 降级返回（ok=false + degraded），不抛', async () => {
    const def = kernStatusTool({ status: undefined });
    const r = (await def.execute({}, {})) as { ok: boolean; degraded: string };
    expect(r.ok).toBe(false);
    expect(typeof r.degraded).toBe('string');
  });

  it('registerKernTools 守卫：tools.register 缺失 → 降级不崩（registered 空 + degraded 非空）', () => {
    const r = registerKernTools({ register: undefined as unknown as ToolsLike['register'] }, { status: undefined });
    expect(r.registered).toEqual([]);
    expect(r.degraded).not.toBeNull();
  });

  it('无 tools 面（ctx.tools 不存在）→ apply 不抛 + 降级记录（对齐既有守卫风格）', () => {
    const { ctx } = makeFakeCtx({ runtime: track(createCognitiveRuntime({ root })), tools: false });
    expect(() => apply(ctx, { bootstrap: false })).not.toThrow();
    expect(degradationLog().some((d) => d.hook === 'ctx.tools')).toBe(true);
  });

  it('认知运行时未装配 + tools 存在 → 降级记录（kern_status 依赖运行时状态）', () => {
    const { ctx } = makeFakeCtx({ runtime: undefined });
    expect(() => apply(ctx, { bootstrap: false })).not.toThrow();
    expect(degradationLog().some((d) => d.hook === 'kern/tools')).toBe(true);
  });

  it('组件能力契约声明：memory-retrieval manifest 含 capabilities/events 契约（实现规格 §8.1 字段）', () => {
    expect(memoryRetrievalComponent.manifest.capabilities).toEqual(['memory.retrieve']);
    expect(memoryRetrievalComponent.manifest.events).toEqual({ subscribe: [], publish: [] });
    expect(memoryRetrievalComponent.manifest.inject).toEqual(['memory']);
    expect(memoryRetrievalComponent.manifest.provides).toEqual(['memory.retrieve']);
  });
});

describe('P2 Guard 契约回归（B3 教训：真实宿主对未 inject 的 ctx 属性读取抛错）', () => {
  /** 模拟 Cordis reflect Guard：未声明属性读取即抛（真实宿主行为，plugin.test B3 修复后回归防线） */
  function makeGuardCtx(overrides: Record<string, unknown>): ContextLike {
    const declared = new Set(['get', 'commands', 'effect', 'on']);
    const target: Record<string, unknown> = {
      get: (name: string) => overrides[name],
      commands: { register: () => undefined },
      effect: () => () => undefined,
      on: () => undefined,
    };
    return new Proxy(target, {
      get(t, prop, receiver) {
        if (typeof prop === 'string' && !declared.has(prop)) {
          throw new Error(`cannot get property "${prop}" without inject`);
        }
        return Reflect.get(t, prop, receiver);
      },
    }) as unknown as ContextLike;
  }

  it('tools 经 ctx.get("tools") 提供：apply 挂载成功且 kern_status 注册（不再直接读 ctx.tools）', () => {
    const tools: ToolDefinitionLike[] = [];
    const rt = track(createCognitiveRuntime({ root }));
    const guard = makeGuardCtx({
      tools: {
        register: (def: unknown) => {
          tools.push(def as ToolDefinitionLike);
          return undefined;
        },
      },
      cognitive: rt,
    });
    expect(() => apply(guard, { bootstrap: false })).not.toThrow();
    expect(tools.some((t) => t.name === 'kern_status')).toBe(true);
  });

  it('无 tools 面：apply 不抛 + ctx.tools 降级记录（Guard 下走 get 返回 undefined）', () => {
    const guard = makeGuardCtx({});
    expect(() => apply(guard, { bootstrap: false })).not.toThrow();
    expect(degradationLog().some((d) => d.hook === 'ctx.tools')).toBe(true);
  });
});
