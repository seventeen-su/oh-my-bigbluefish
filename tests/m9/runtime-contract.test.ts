// W5：OMB Runtime Contract（三层结构）行为测试。
// 覆盖：
//   ① 第一层固定契约常量：非空 / ≤500 字符（硬约束①）/ 关键锚点（kern_memory、/mode、不接管——稳定性：
//      常量导出可断言，静态不随演化变）
//   ② context 注册：cognitive:contract（order 80，静态文本）+ cognitive:capabilities（order 85，同步文本）
//      + cognitive:projection（order 90）；无 context 面 → 降级记录不抛
//   ③ buildCapabilitiesLine 纯函数：capabilities 有/无、judge/runner 真假组合、全未知兜底
//   ④ SKILL.md：仓库文件存在、frontmatter name/description 非空、正文含命令/工具/过程/债务锚点
//   ⑤ 技能路径纯函数：OMB_SKILL_REL / skillSourcePath / skillMirrorPath
//   ⑥ 镜像：fake dshHome → 首次写入成功（文件内容 = 仓库源）、再次 apply 幂等（内容一致不重写——mtime 不变）、
//      写失败 → 降级记录不抛（注入坏路径：dshHome 指向文件）
// 约束：镜像目标一律注入 fake dshHome（mkdtemp）——禁止写真实 ~/.dsh（vitest 环境下未注入 dshHome 时
// plugin 侧守卫跳过镜像）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCognitiveRuntime, type CognitiveRuntime } from '../../runtime/assembly.js';
import { apply, type ContextLike } from '../../runtime/plugin.js';
import { clearDegradations, degradationLog } from '../../runtime/loop-hooks.js';
import {
  buildCapabilitiesLine,
  OMB_RUNTIME_CONTRACT,
  OMB_SKILL_REL,
  skillMirrorPath,
  skillSourcePath,
} from '../../runtime/runtime-contract.js';

/** preset 根（tests/m9/ → ../..）——仓库内技能源文件的解析基座 */
const PRESET_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKILL_SOURCE = join(PRESET_ROOT, 'skills', 'omb-runtime', 'SKILL.md');

/** 捕获 systemPrompt.context 注册的 fake ctx（与 hook-context 同款） */
function makeFakeCtx(opts: {
  runtime?: CognitiveRuntime;
  withSystemPrompt?: boolean;
}): { ctx: ContextLike; contexts: Array<{ name: string; order: number; text: unknown }> } {
  const contexts: Array<{ name: string; order: number; text: unknown }> = [];
  const ctx: ContextLike = {
    commands: { register: () => undefined },
    cognitive: opts.runtime,
    systemPrompt:
      opts.withSystemPrompt === false
        ? undefined
        : {
            context: (def: unknown) => {
              contexts.push(def as { name: string; order: number; text: unknown });
            },
          },
  };
  return { ctx, contexts };
}

let base: string;
let runtimes: CognitiveRuntime[];

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'omb-runtime-contract-'));
  runtimes = [];
  clearDegradations();
});

afterEach(async () => {
  for (const rt of runtimes) {
    await rt.close();
  }
  runtimes = [];
  await rm(base, { recursive: true, force: true });
});

function makeRuntime(): CognitiveRuntime {
  const rt = createCognitiveRuntime({ root: join(base, `omb-${runtimes.length}`) });
  runtimes.push(rt);
  return rt;
}

describe('① 第一层固定契约常量（OMB_RUNTIME_CONTRACT）', () => {
  it('非空、长度 ≤500 字符（硬约束①——极小固定上下文成本）、含 kern_memory//mode/不接管 关键锚点', () => {
    expect(OMB_RUNTIME_CONTRACT.length).toBeGreaterThan(0);
    expect(OMB_RUNTIME_CONTRACT.length).toBeLessThanOrEqual(500);
    expect(OMB_RUNTIME_CONTRACT).toContain('kern_memory');
    expect(OMB_RUNTIME_CONTRACT).toContain('/mode');
    expect(OMB_RUNTIME_CONTRACT).toContain('不接管');
  });
});

describe('② context 注册（plugin.ts apply → systemPrompt.context）', () => {
  it('注册顺序与 order：cognitive:contract（order 80，静态文本 = 常量）、cognitive:capabilities（order 85，同步文本）、cognitive:projection（order 90，函数）', () => {
    const { ctx, contexts } = makeFakeCtx({ runtime: makeRuntime() });
    apply(ctx, { bootstrap: false });
    expect(contexts.map((c) => c.name)).toEqual(['cognitive:contract', 'cognitive:capabilities', 'cognitive:projection']);
    const contract = contexts.find((c) => c.name === 'cognitive:contract')!;
    expect(contract.order).toBe(80);
    expect(typeof contract.text).toBe('string');
    expect(contract.text).toBe(OMB_RUNTIME_CONTRACT);
    const caps = contexts.find((c) => c.name === 'cognitive:capabilities')!;
    expect(caps.order).toBe(85);
    expect(typeof caps.text).toBe('string');
    // 第二层动态能力行同步求值自真实运行时：memory-retrieval 组件能力名可见
    expect(caps.text as string).toContain('memory.retrieve');
    const proj = contexts.find((c) => c.name === 'cognitive:projection')!;
    expect(proj.order).toBe(90);
    expect(typeof proj.text).toBe('function');
  });

  it('守卫：无 context 面（systemPrompt 缺失）→ 不注册 + 降级记录不抛', () => {
    const { ctx, contexts } = makeFakeCtx({ runtime: makeRuntime(), withSystemPrompt: false });
    expect(() => apply(ctx, { bootstrap: false })).not.toThrow();
    expect(contexts).toHaveLength(0);
    expect(degradationLog().some((r) => r.hook === 'systemPrompt.context')).toBe(true);
  });
});

describe('③ buildCapabilitiesLine 纯函数（第二层动态能力行）', () => {
  it('capabilities 有/无、judge/runner 真假组合', () => {
    // capabilities 非空 → 报能力清单（示例语义：memory-retrieval（记忆检索））
    expect(buildCapabilitiesLine({ capabilities: ['memory.retrieve', 'x'], judgeAvailable: true, runnerAvailable: true })).toContain('memory.retrieve');
    // judge 真假
    expect(buildCapabilitiesLine({ capabilities: ['a'], judgeAvailable: true, runnerAvailable: false })).toContain('语义裁判：可用');
    expect(buildCapabilitiesLine({ capabilities: ['a'], judgeAvailable: false, runnerAvailable: false })).toContain('语义裁判：不可用');
    // runner 真假
    expect(buildCapabilitiesLine({ capabilities: ['a'], judgeAvailable: false, runnerAvailable: true })).toContain('候选验证通道：runner');
    expect(buildCapabilitiesLine({ capabilities: ['a'], judgeAvailable: false, runnerAvailable: false })).toContain('候选验证通道：受限子进程');
  });

  it('capabilities 空 → 只报裁判/通道（不报能力清单）', () => {
    const line = buildCapabilitiesLine({ capabilities: [], judgeAvailable: true, runnerAvailable: false });
    expect(line).not.toContain('当前可用能力');
    expect(line).toContain('语义裁判：可用');
    expect(line).toContain('候选验证通道：受限子进程');
  });

  it('全部未知 → 兜底「当前无额外能力面」', () => {
    expect(buildCapabilitiesLine({})).toBe('当前无额外能力面');
    expect(buildCapabilitiesLine({ capabilities: [] })).toBe('当前无额外能力面');
    expect(buildCapabilitiesLine()).toBe('当前无额外能力面');
  });
});

describe('⑤ 技能路径纯函数（第三层 skill 路径基座）', () => {
  it('OMB_SKILL_REL / skillSourcePath / skillMirrorPath', () => {
    expect(OMB_SKILL_REL).toBe(join('skills', 'omb-runtime', 'SKILL.md'));
    expect(skillSourcePath('/preset')).toBe(join('/preset', 'skills', 'omb-runtime', 'SKILL.md'));
    expect(skillMirrorPath('/dshhome')).toBe(join('/dshhome', 'skills', 'omb-runtime', 'SKILL.md'));
  });
});

describe('④ SKILL.md（第三层渐进指导，仓库内版本化）', () => {
  it('仓库文件存在、frontmatter name/description 非空、正文含命令/工具/过程/债务锚点', async () => {
    const src = await readFile(SKILL_SOURCE, 'utf8');
    const fm = src.match(/^---\n([\s\S]*?)\n---/);
    expect(fm).not.toBeNull();
    expect(fm![1]!).toContain('name: omb-runtime');
    expect(fm![1]!).toContain('description:');
    expect(fm![1]!.trim().split('\n').filter((l) => l.startsWith('description:')).length).toBe(1);
    const body = src.replace(/^---[\s\S]*?---/, '');
    for (const anchor of ['/mode', 'kern_memory', '认知过程', '验证债务']) {
      expect(body).toContain(anchor);
    }
  });
});

describe('⑥ skill 镜像（apply 内，尽力而为，fake dshHome）', () => {
  it('首次 apply → 镜像写入成功（目标内容 = 仓库源）', async () => {
    const fakeHome = join(base, 'fake-dsh-1');
    const { ctx } = makeFakeCtx({ runtime: makeRuntime() });
    apply(ctx, { bootstrap: false, dshHome: fakeHome });
    const target = skillMirrorPath(fakeHome);
    const source = await readFile(SKILL_SOURCE, 'utf8');
    await vi.waitFor(
      async () => {
        expect(await readFile(target, 'utf8').catch(() => null)).toBe(source);
      },
      { timeout: 5000, interval: 10 },
    );
  });

  it('再次 apply 幂等：内容一致不重写（mtime 不变）', async () => {
    const fakeHome = join(base, 'fake-dsh-2');
    const target = skillMirrorPath(fakeHome);
    const source = await readFile(SKILL_SOURCE, 'utf8');
    // 第一次 apply → 等待写入完成（文件内容 = 仓库源 → 首次镜像已落地）
    const { ctx: ctx1 } = makeFakeCtx({ runtime: makeRuntime() });
    apply(ctx1, { bootstrap: false, dshHome: fakeHome });
    await vi.waitFor(
      async () => {
        expect(await readFile(target, 'utf8').catch(() => null)).toBe(source);
      },
      { timeout: 5000, interval: 10 },
    );
    const before = await stat(target);
    // 第二次 apply（新运行时实例）→ 内容一致 → 跳过（不重写）
    const { ctx: ctx2 } = makeFakeCtx({ runtime: makeRuntime() });
    apply(ctx2, { bootstrap: false, dshHome: fakeHome });
    await new Promise((r) => setTimeout(r, 100)); // 让镜像异步路径 settle
    expect(await readFile(target, 'utf8')).toBe(source);
    const after = await stat(target);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it('写失败 → 降级记录不抛（注入坏路径：dshHome 指向文件 → mkdir 失败）', async () => {
    const blocker = join(base, 'blocked');
    await writeFile(blocker, 'x', 'utf8');
    const { ctx } = makeFakeCtx({ runtime: makeRuntime() });
    expect(() => apply(ctx, { bootstrap: false, dshHome: blocker })).not.toThrow();
    await vi.waitFor(
      () => {
        expect(degradationLog().some((r) => r.hook === 'skill/mirror')).toBe(true);
      },
      { timeout: 5000, interval: 10 },
    );
  });
});
