// W5：OMB Runtime Contract（三层结构）行为测试。
// 覆盖：
//   ① 第一层固定契约常量：非空 / ≤500 字符（硬约束①）/ 关键锚点（kern_memory、/mode、不接管——稳定性：
//      常量导出可断言，静态不随演化变）
//   ② context 注册：cognitive:contract（order 80，静态文本）+ cognitive:capabilities（order 85，同步文本）
//      + cognitive:projection（order 90）；无 context 面 → 降级记录不抛
//   ③ buildCapabilitiesLine 纯函数：capabilities 有/无、judge/runner 真假组合、全未知兜底
//   ⑤ 技能路径纯函数：OMB_SKILL_REL / skillSourcePath / skillMirrorPath
// （④ SKILL.md 仓库文件与 ⑥ 镜像三路径测试在提交 2「技能与镜像接线」中补入——见 git 历史）
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

describe('⑤ 技能路径纯函数（第三层 skill 路径基座——镜像接线在提交 2）', () => {
  it('OMB_SKILL_REL / skillSourcePath / skillMirrorPath', () => {
    expect(OMB_SKILL_REL).toBe(join('skills', 'omb-runtime', 'SKILL.md'));
    expect(skillSourcePath('/preset')).toBe(join('/preset', 'skills', 'omb-runtime', 'SKILL.md'));
    expect(skillMirrorPath('/dshhome')).toBe(join('/dshhome', 'skills', 'omb-runtime', 'SKILL.md'));
  });
});
