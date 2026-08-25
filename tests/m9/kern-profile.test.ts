// W1（未接线审计修复 2026-08-25）行为测试：kern_profile 画像写入工具 + runtime.upsertProfile。
// 背景：MemoryKindEnum 含 'Profile'、kern_memory 支持 kind=Profile 过滤，但全库无任何 Profile 记忆
// 写入点——画像读取面全通、写入面缺失。本测试钉住写入面：画像 = 单条 Profile 记忆（确定性 id
// 'profile:user'，Global 作用域跨项目可检索）；已存在 → 更新 payload（replace=true 覆写 / 缺省合并
// 追加去重）；不存在 → 新建；失败 → degraded（不抛）。工具总数 6（<10 纪律）。
// 覆盖：注册（fake tools 面捕获 kern_profile + 工具总数 6）、upsertProfile 各路径（首建/更新/合并/
// 确定性 id）、端到端（upsertProfile → kern_memory kind=Profile scope=Global 真实检索命中）、守卫
// （runtime 缺失降级 / 空 profile degraded / 参数非法）。
// fixture：mkdtemp 临时 db（真实 memory 后端——端到端检索）；afterEach 先 close 再 rm（Windows WAL 锁）。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCognitiveRuntime, type CognitiveRuntime } from '../../runtime/assembly.js';
import { apply, type ContextLike } from '../../runtime/plugin.js';
import {
  kernMemoryTool,
  kernProfileTool,
  registerKernTools,
  type ToolDefinitionLike,
} from '../../runtime/kern-tools.js';
import { clearDegradations } from '../../runtime/loop-hooks.js';

let base: string;
let root: string;
let runtime: CognitiveRuntime;
const runtimes: CognitiveRuntime[] = [];

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'omb-w1-'));
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

describe('W1 kern_profile 工具注册（工具总数 6 <10）', () => {
  it('apply 注册 6 个工具：含 kern_profile（名称/描述/parameters/execute 齐备；工具数 <10 纪律）', async () => {
    runtime = track(createCognitiveRuntime({ root }));
    const { ctx, tools } = makeFakeCtx({ runtime });
    expect(() => apply(ctx, { bootstrap: false })).not.toThrow();
    const names = tools.map((t) => t.name).sort();
    expect(names).toContain('kern_profile');
    expect(names).toHaveLength(6); // 5 既有 kern 工具 + kern_profile
    expect(tools.length).toBeLessThan(10);
    const def = tools.find((t) => t.name === 'kern_profile')!;
    expect(def.description.length).toBeGreaterThan(0);
    expect(def.description).toContain('Global'); // 画像 Global 作用域在描述中声明（跨项目可检索）
    expect(def.parameters).toBeDefined();
    const props = (def.parameters as { properties?: Record<string, unknown> }).properties ?? {};
    expect(props.profile).toBeDefined();
    expect((props.profile as { type?: string }).type).toBe('string');
    expect(props.replace).toBeDefined();
    expect((props.replace as { type?: string }).type).toBe('boolean');
    expect(typeof def.execute).toBe('function');
  });

  it('registerKernTools 直接注册：registered 含 kern_profile（6 名）、disposers 收集、degraded null', () => {
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
    expect(r.registered).toContain('kern_profile');
    expect(r.registered).toHaveLength(6);
    expect(r.disposers).toHaveLength(6);
    r.disposers.forEach((d) => d());
    expect(invoked).toContain('kern_profile');
  });
});

describe('W1 upsertProfile（runtime 方法——Profile 记忆 Global 作用域）', () => {
  it('首次 → created=true：memory 可查（kind=Profile/scope=Global/prov_class=User-declared/payload 正确）', async () => {
    runtime = track(createCognitiveRuntime({ root }));
    const r = await runtime.upsertProfile({ profile: '用户画像：专注认知系统架构，偏好 TypeScript' });
    expect(r.created).toBe(true);
    expect(r.updated).toBe(false);
    expect(r.degraded).toBeNull();
    expect(r.id).toBe('profile:user');
    expect(r.kind).toBe('Profile');
    expect(r.scope).toBe('Global');
    const m = await runtime.memory.getById(r.id);
    expect(m).toBeDefined();
    expect(m!.kind).toBe('Profile');
    expect(m!.scope).toBe('Global');
    expect(m!.prov_class).toBe('User-declared');
    expect(m!.payload).toBe('用户画像：专注认知系统架构，偏好 TypeScript');
  });

  it('再次 → updated=true：确定性 id 跨调用稳定；replace=true 完全覆写 payload', async () => {
    runtime = track(createCognitiveRuntime({ root }));
    const first = await runtime.upsertProfile({ profile: '画像 A' });
    const second = await runtime.upsertProfile({ profile: '画像 B（全新覆写内容）', replace: true });
    expect(first.id).toBe('profile:user');
    expect(second.id).toBe('profile:user'); // 确定性 id 跨调用稳定
    expect(second.created).toBe(false);
    expect(second.updated).toBe(true);
    const m = await runtime.memory.getById('profile:user');
    expect(m!.payload).toBe('画像 B（全新覆写内容）');
  });

  it('缺省（无 replace）→ 合并追加：新内容追加；已包含 → payload 不变（去重）', async () => {
    runtime = track(createCognitiveRuntime({ root }));
    await runtime.upsertProfile({ profile: '画像 A' });
    await runtime.upsertProfile({ profile: '画像 B' });
    const m = await runtime.memory.getById('profile:user');
    expect(m!.payload).toBe('画像 A\n画像 B');
    // 重复追加（新文本已包含于既有 payload）→ payload 不变（合并去重；updated 仍刷新）
    const dup = await runtime.upsertProfile({ profile: '画像 B' });
    expect(dup.updated).toBe(true);
    const m2 = await runtime.memory.getById('profile:user');
    expect(m2!.payload).toBe('画像 A\n画像 B');
  });

  it('空 profile → degraded 非法输入（不抛、不写库）', async () => {
    runtime = track(createCognitiveRuntime({ root }));
    const r = await runtime.upsertProfile({ profile: '   ' });
    expect(r.degraded).not.toBeNull();
    expect(r.degraded).toContain('非法输入');
    expect(r.created).toBe(false);
    expect(r.updated).toBe(false);
    const m = await runtime.memory.getById('profile:user');
    expect(m).toBeUndefined();
  });
});

describe('W1 端到端：upsertProfile → kern_memory 可检索（真实 memory 后端）', () => {
  it('画像写入后 kern_memory({kind: Profile, scope: Global, query: 画像关键词}) 命中（读写面闭合）', async () => {
    runtime = track(createCognitiveRuntime({ root }));
    await runtime.upsertProfile({ profile: '用户偏好：终端配色深色，常用 PowerShell 与 Git 工作流' });
    const def = kernMemoryTool(runtime);
    const r = (await def.execute({ kind: 'Profile', scope: 'Global', query: '深色' }, {})) as {
      ok: boolean;
      text: string;
    };
    expect(r.ok).toBe(true);
    expect(r.text).toContain('Profile'); // kind 过滤命中画像记录
    expect(r.text).toContain('深色'); // snippet 含画像关键词
  });
});

describe('W1 kern_profile 工具面守卫', () => {
  it('runtime 缺失 upsertProfile() → 降级不抛（ok=false + 数据源缺失）', async () => {
    const def = kernProfileTool({ status: undefined });
    const r = (await def.execute({ profile: 'x' }, {})) as { ok: boolean; text: string };
    expect(r.ok).toBe(false);
    expect(r.text).toContain('upsertProfile');
  });

  it('参数非法：profile 缺失/非字符串 → ok=false + 明确文本（不触发写入）', async () => {
    runtime = track(createCognitiveRuntime({ root }));
    const def = kernProfileTool(runtime);
    const r1 = (await def.execute({}, {})) as { ok: boolean; text: string };
    expect(r1.ok).toBe(false);
    expect(r1.text).toContain('参数非法');
    const r2 = (await def.execute({ profile: 42 }, {})) as { ok: boolean; text: string };
    expect(r2.ok).toBe(false);
    expect(r2.text).toContain('参数非法');
  });

  it('空 profile → 运行时降级（ok=false + degraded 非法输入；不写库）', async () => {
    runtime = track(createCognitiveRuntime({ root }));
    const def = kernProfileTool(runtime);
    const r = (await def.execute({ profile: '' }, {})) as {
      ok: boolean;
      text: string;
      degraded: string | null;
    };
    expect(r.ok).toBe(false);
    expect(r.degraded).not.toBeNull();
    expect(r.text).toContain('写入失败');
  });

  it('成功路径：返回摘要文本含 id/scope/created（或 updated）', async () => {
    runtime = track(createCognitiveRuntime({ root }));
    const def = kernProfileTool(runtime);
    const r = (await def.execute({ profile: '画像摘要测试内容' }, {})) as {
      ok: boolean;
      text: string;
      id: string;
      kind: string;
      scope: string;
      created: boolean;
      degraded: string | null;
    };
    expect(r.ok).toBe(true);
    expect(r.degraded).toBeNull();
    expect(r.text).toContain('profile:user');
    expect(r.text).toContain('Global');
    expect(r.created).toBe(true);
    expect(r.kind).toBe('Profile');
  });
});
