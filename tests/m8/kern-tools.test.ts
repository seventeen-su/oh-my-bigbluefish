// S5 行为测试：kern_* 工具补齐（TDD——先于实现编写）。kern_bench/kern_evolve/kern_switch/kern_memory
// 四工具 + kern_status 合计 5；W1（2026-08-25 未接线审计修复）新增 kern_profile 画像写入——合计 6
// （工具数 <10 纪律）；全部复用认知运行时方法（benchV2/runEvolutionNow/switchLine/retrieveMemory/
// upsertProfile——薄封装，非命令 handler）；守卫与降级对齐 kern_status（缺失 → 降级不抛）。
// 覆盖：注册（名称/描述/parameters/execute + 工具数 <10）、execute 各路径（成功/参数非法/方法缺失降级）、
// registerKernTools 统一注册与 disposers、注册失败降级；既有 kern_status 测试（component-assembly.test.ts）不破坏。
// fixture：mkdtemp 临时 db + 临时 bench 明细目录（不动真实 workspace/.omb，CONVENTIONS §6）；
// afterEach 先 close 再 rm（Windows WAL 锁）。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCognitiveRuntime, type CognitiveRuntime } from '../../runtime/assembly.js';
import { apply, type ContextLike } from '../../runtime/plugin.js';
import {
  kernBenchTool,
  kernEvolveTool,
  kernMemoryTool,
  kernSwitchTool,
  registerKernTools,
  type ToolDefinitionLike,
} from '../../runtime/kern-tools.js';
import { clearDegradations } from '../../runtime/loop-hooks.js';
import { makeMutableId } from '../../kernel/schemas/base.js';
import type { Memory } from '../../kernel/schemas/m.js';

let base: string;
let root: string;
let runtime: CognitiveRuntime;
const runtimes: CognitiveRuntime[] = [];

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'omb-s5-'));
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

/** 捕获 ctx.tools.register 的 fake ctx（register 返回 disposer——disposers 收集路径） */
function makeFakeCtx(opts: { runtime?: CognitiveRuntime }): { ctx: ContextLike; tools: ToolDefinitionLike[] } {
  const tools: ToolDefinitionLike[] = [];
  const ctx: ContextLike = {
    commands: { register: () => undefined },
    cognitive: opts.runtime,
    tools: {
      register: (def: unknown) => {
        tools.push(def as ToolDefinitionLike);
        return () => undefined; // 真实 DSH register 返回注销 disposer
      },
    },
    effect: () => () => undefined,
  };
  return { ctx, tools };
}

/** M1 Memory 工厂（kern_memory 检索 fixture；provenance.event 每次唯一——幂等键） */
function makeMemory(payload: string, over: Record<string, unknown> = {}): Memory {
  const ts = '2026-08-24T00:00:00.000Z';
  return {
    ir_version: '2.0',
    id: makeMutableId('memory'),
    schema: 'omb/M1',
    scope: 'Project',
    lifecycle: 'Active',
    immutable: false,
    owner: 'kernel',
    created: ts,
    updated: ts,
    provenance: {
      source: 'test',
      event: makeMutableId('evt'),
      actor: 's5',
      environment: { os: 'win32', node: process.version, dsh_version: '0.8.0', project: 'omb-v2' },
      runtime_snapshot: 'rs:test',
      timestamp: ts,
      transformation_chain: [],
      verification: 'test',
    },
    refs: [],
    kind: 'Semantic',
    prov_class: 'Observation',
    payload,
    value_score: 0.5,
    utility_counts: { retrieval: 0, hit: 0, miss: 0, inject: 0, decay: 0, promote: 0 },
    ...over,
  } as unknown as Memory;
}

describe('S5/W1 kern_* 工具注册（registerKernTools 统一；工具数 <10）', () => {
  it('apply 注册全部 6 个工具：kern_status/kern_bench/kern_evolve/kern_switch/kern_memory/kern_profile（名称/描述/parameters/output/execute 齐备）', async () => {
    runtime = track(createCognitiveRuntime({ root }));
    const { ctx, tools } = makeFakeCtx({ runtime });
    expect(() => apply(ctx, { bootstrap: false })).not.toThrow();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'kern_bench',
      'kern_evolve',
      'kern_memory',
      'kern_profile',
      'kern_status',
      'kern_switch',
    ]);
    expect(tools.length).toBeLessThan(10); // 工具数 <10 纪律（设计 §6）
    for (const def of tools) {
      expect(def.description.length).toBeGreaterThan(0);
      expect(def.parameters).toBeDefined();
      expect(typeof def.execute).toBe('function');
      expect(def.output).toBeDefined();
      expect(typeof def.output.render).toBe('function');
    }
  });

  it('registerKernTools 直接注册：registered 含 6 名（注册序）、disposers 收集（register 返回函数）、degraded null', () => {
    const invoked: string[] = [];
    const r = registerKernTools(
      {
        register: (def: ToolDefinitionLike) => {
          return () => {
            invoked.push(def.name);
          };
        },
      },
      { status: undefined },
    );
    expect(r.degraded).toBeNull();
    expect(r.registered).toEqual(['kern_status', 'kern_bench', 'kern_evolve', 'kern_switch', 'kern_memory', 'kern_profile']);
    expect(r.disposers).toHaveLength(6);
    r.disposers.forEach((d) => d());
    expect(invoked).toEqual(['kern_status', 'kern_bench', 'kern_evolve', 'kern_switch', 'kern_memory', 'kern_profile']);
  });

  it('registerKernTools 守卫：tools.register 缺失 → 降级不崩（registered 空 + degraded 非空）', () => {
    const r = registerKernTools({ register: undefined as unknown as (def: ToolDefinitionLike) => unknown }, { status: undefined });
    expect(r.registered).toEqual([]);
    expect(r.degraded).not.toBeNull();
  });

  it('注册失败（register 抛错）→ 降级不崩（已注册名保留 + degraded 非空）', () => {
    let calls = 0;
    const r = registerKernTools(
      {
        register: () => {
          calls++;
          if (calls > 1) {
            throw new Error('duplicate name');
          }
          return undefined;
        },
      },
      { status: undefined },
    );
    expect(r.registered).toEqual(['kern_status']);
    expect(r.degraded).toContain('kern_bench');
  });
});

describe('S5 kern_bench（v2 契约基准：回放/真实；复用 runBenchV2 接线）', () => {
  it('execute 回放模式：无 modelAdapter → 回放执行，摘要文本含通过数/模式（明细落盘临时目录）', async () => {
    runtime = track(createCognitiveRuntime({ root, benchReportsDir: join(base, 'bench') }));
    const def = kernBenchTool(runtime);
    const r = (await def.execute({}, {})) as {
      ok: boolean;
      text: string;
      mode: string;
      passed: number;
      total: number;
    };
    expect(r.ok).toBe(true);
    expect(r.mode).toBe('replay');
    expect(r.total).toBeGreaterThan(0);
    expect(r.passed).toBe(r.total); // 回放 fixture.output = expected → 必然通过（bench-v2.ts makeReplayExecutorV2 语义）
    expect(r.text).toContain('v2 契约基准完成');
    expect(r.text).toContain('回放执行');
  });

  it('line 参数：显式版本线生效（文本含目标线）；缺省当前线 stable', async () => {
    runtime = track(createCognitiveRuntime({ root, benchReportsDir: join(base, 'bench') }));
    const def = kernBenchTool(runtime);
    const r = (await def.execute({ line: 'latest' }, {})) as { ok: boolean; text: string };
    expect(r.ok).toBe(true);
    expect(r.text).toContain('latest');
  });

  it('参数非法：line 非字符串 / 未知版本线值 → ok=false + 明确文本（不触发基准）', async () => {
    runtime = track(createCognitiveRuntime({ root }));
    const def = kernBenchTool(runtime);
    const r1 = (await def.execute({ line: 42 }, {})) as { ok: boolean; text: string };
    expect(r1.ok).toBe(false);
    expect(r1.text).toContain('参数非法');
    const r2 = (await def.execute({ line: 'bogus' }, {})) as { ok: boolean; text: string };
    expect(r2.ok).toBe(false);
    expect(r2.text).toContain('bogus');
  });

  it('降级：运行时未提供 benchV2() → ok=false + 数据源缺失（不抛）', async () => {
    const def = kernBenchTool({ status: undefined });
    const r = (await def.execute({}, {})) as { ok: boolean; text: string };
    expect(r.ok).toBe(false);
    expect(r.text).toContain('benchV2');
  });
});

describe('S5 kern_evolve（演化全链 runEvolutionNow）', () => {
  it('execute 返回演化摘要（判定/入队/quantum/debt/晋升检查）', async () => {
    runtime = track(createCognitiveRuntime({ root }));
    const def = kernEvolveTool(runtime);
    const r = (await def.execute({}, {})) as { ok: boolean; text: string };
    expect(r.ok).toBe(true);
    expect(r.text).toContain('演化判定');
    expect(r.text).toContain('should_evolve');
    expect(r.text).toContain('quantum 执行');
    expect(r.text).toContain('维护债务快照');
    expect(r.text).toContain('事件入链');
  });

  it('参数非法：session_id 非字符串 → ok=false + 明确文本', async () => {
    runtime = track(createCognitiveRuntime({ root }));
    const def = kernEvolveTool(runtime);
    const r = (await def.execute({ session_id: 7 }, {})) as { ok: boolean; text: string };
    expect(r.ok).toBe(false);
    expect(r.text).toContain('参数非法');
  });

  it('降级：运行时未提供 runEvolutionNow() → ok=false + 数据源缺失（不抛）', async () => {
    const def = kernEvolveTool({ status: undefined });
    const r = (await def.execute({}, {})) as { ok: boolean; text: string };
    expect(r.ok).toBe(false);
    expect(r.text).toContain('runEvolutionNow');
  });
});

describe('S5 kern_switch（版本线切换：校验+快照重建+激活记录；无 /mode 空白会话守卫）', () => {
  it('参数非法：line 缺失 → ok=false + 必填提示', async () => {
    runtime = track(createCognitiveRuntime({ root }));
    const def = kernSwitchTool(runtime);
    const r = (await def.execute({}, {})) as { ok: boolean; text: string };
    expect(r.ok).toBe(false);
    expect(r.text).toContain('line 必填');
  });

  it('未知版本线值 → ok=false + 合法值提示', async () => {
    runtime = track(createCognitiveRuntime({ root }));
    const def = kernSwitchTool(runtime);
    const r = (await def.execute({ line: 'bogus' }, {})) as { ok: boolean; text: string };
    expect(r.ok).toBe(false);
    expect(r.text).toContain('合法值');
  });

  it('切换同当前线 → ok=true + 已是当前版本线（无副作用：rebuilt=false）', async () => {
    runtime = track(createCognitiveRuntime({ root }));
    const def = kernSwitchTool(runtime);
    const r = (await def.execute({ line: 'stable' }, {})) as { ok: boolean; text: string; rebuilt: boolean };
    expect(r.ok).toBe(true);
    expect(r.text).toContain('已是当前版本线 stable');
    expect(r.rebuilt).toBe(false);
  });

  it('切换其它线：校验+快照重建+激活记录（ok=true；重建按环境成功或降级说明——不钉死分支）', async () => {
    runtime = track(createCognitiveRuntime({ root }));
    const def = kernSwitchTool(runtime);
    const r = (await def.execute({ line: 'latest' }, {})) as {
      ok: boolean;
      text: string;
      line: string;
      previous_line: string;
      rebuilt: boolean;
      degraded: string | null;
    };
    expect(r.ok).toBe(true);
    expect(r.line).toBe('latest');
    expect(r.previous_line).toBe('stable');
    expect(r.text).toContain('latest');
    // 环境无关断言：快照重建成功（rebuilt）或降级说明（degraded 非空）——切换状态均生效
    expect(r.rebuilt === true || r.degraded !== null).toBe(true);
  });

  it('降级：运行时未提供 switchLine() → ok=false + 数据源缺失（不抛）', async () => {
    const def = kernSwitchTool({ status: undefined });
    const r = (await def.execute({ line: 'latest' }, {})) as { ok: boolean; text: string };
    expect(r.ok).toBe(false);
    expect(r.text).toContain('switchLine');
  });
});

describe('S5 kern_memory（记忆检索查询：retrieve 路由）', () => {
  it('execute 命中：query 匹配 → 条目摘要（kind/scope/value/snippet）', async () => {
    runtime = track(createCognitiveRuntime({ root }));
    await runtime.memory.ingest(makeMemory('kernprobe alpha blueprint'));
    await runtime.memory.ingest(makeMemory('gamma delta unrelated'));
    const def = kernMemoryTool(runtime);
    const r = (await def.execute({ query: 'kernprobe' }, {})) as { ok: boolean; text: string };
    expect(r.ok).toBe(true);
    expect(r.text).toContain('记忆检索');
    expect(r.text).toContain('kernprobe alpha blueprint'); // snippet 含命中内容
    expect(r.text).toContain('Semantic');
  });

  it('execute 无匹配：query 未命中 → ok=true + 0 条/无匹配（不抛）', async () => {
    runtime = track(createCognitiveRuntime({ root }));
    const def = kernMemoryTool(runtime);
    const r = (await def.execute({ query: 'zzz-no-such-token-99' }, {})) as { ok: boolean; text: string };
    expect(r.ok).toBe(true);
    expect(r.text).toContain('0 条');
    expect(r.text).toContain('无匹配记忆');
  });

  it('参数非法：query 非字符串 / limit 负数 → ok=false + 明确文本', async () => {
    runtime = track(createCognitiveRuntime({ root }));
    const def = kernMemoryTool(runtime);
    const r1 = (await def.execute({ query: 42 }, {})) as { ok: boolean; text: string };
    expect(r1.ok).toBe(false);
    expect(r1.text).toContain('参数非法');
    const r2 = (await def.execute({ limit: -1 }, {})) as { ok: boolean; text: string };
    expect(r2.ok).toBe(false);
    expect(r2.text).toContain('检索失败'); // limit 负数 → MemoryQuerySchema 校验失败 → 降级（不抛）
  });

  it('非法 scope/kind 枚举 → ok=false（schema fail-loud 降级，不抛）', async () => {
    runtime = track(createCognitiveRuntime({ root }));
    const def = kernMemoryTool(runtime);
    const r = (await def.execute({ scope: 'Bogus' }, {})) as { ok: boolean; text: string };
    expect(r.ok).toBe(false);
    expect(r.text).toContain('检索失败');
  });

  it('降级：运行时未提供 retrieveMemory() → ok=false + 数据源缺失（不抛）', async () => {
    const def = kernMemoryTool({ status: undefined });
    const r = (await def.execute({}, {})) as { ok: boolean; text: string };
    expect(r.ok).toBe(false);
    expect(r.text).toContain('retrieveMemory');
  });
});
