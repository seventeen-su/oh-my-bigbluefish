// T0.3 行为测试：/mode 命令 handler 纯逻辑（modeCommandHandler，不依赖 DSH）。
// 用注入式 fake deps 断言解析/校验/切换流程（真实行为断言，不 mock 生产模块）。
import { describe, expect, it } from 'vitest';
import { modeCommandHandler, type LoadedVersion } from '../../substrate/mode-command.js';
import type { VersionLine } from '../../substrate/snapshot.js';

const FULL_HASH = 'a'.repeat(40);

interface FakeDeps {
  load: (line: VersionLine) => Promise<LoadedVersion>;
  currentLine: () => string;
  isBlankSession?: () => Promise<boolean>;
  onSwitch?: (line: VersionLine) => Promise<void>;
  calls: { loaded: string[]; switched: string[] };
}

function makeDeps(overrides: Partial<FakeDeps> = {}): FakeDeps {
  const calls = { loaded: [] as string[], switched: [] as string[] };
  const deps: FakeDeps = {
    load: async (line: VersionLine) => {
      calls.loaded.push(line);
      return { tree_root: 'R', git_revision: FULL_HASH };
    },
    currentLine: () => 'stable',
    isBlankSession: async () => true,
    onSwitch: async (line: VersionLine) => {
      calls.switched.push(line);
    },
    calls,
    ...overrides,
  };
  return deps;
}

describe('modeCommandHandler', () => {
  it('无参数：返回当前模式（currentLine）+ 帮助，不触发 load/onSwitch', async () => {
    const deps = makeDeps();
    const result = await modeCommandHandler('', deps);
    expect(result.kind).toBe('success');
    expect(result.text).toContain('stable');
    expect(result.text).toContain('initial | stable | latest');
    expect(deps.calls.loaded).toEqual([]);
    expect(deps.calls.switched).toEqual([]);
  });

  it('空白输入（仅空白字符）也按无参数处理', async () => {
    const deps = makeDeps();
    const result = await modeCommandHandler('   ', deps);
    expect(result.kind).toBe('success');
    expect(result.text).toContain('stable');
  });

  it('切换成功：trim 解析 → load 校验 → 空白会话检查 → onSwitch，成功文本含新模式/git_revision 前 8 位/tree_root', async () => {
    const deps = makeDeps();
    const result = await modeCommandHandler('  latest  ', deps);
    expect(result.kind).toBe('success');
    expect(result.text).toContain('latest');
    expect(result.text).toContain(FULL_HASH.slice(0, 8));
    expect(result.text).toContain('R');
    expect(deps.calls.loaded).toEqual(['latest']);
    expect(deps.calls.switched).toEqual(['latest']);
  });

  it('未知模式 fail-loud：返回 error 文本，含非法值与合法值，不触发 load', async () => {
    const deps = makeDeps();
    const result = await modeCommandHandler('gamma', deps);
    expect(result.kind).toBe('error');
    expect(result.text).toContain('gamma');
    expect(result.text).toContain('initial | stable | latest');
    expect(deps.calls.loaded).toEqual([]);
    expect(deps.calls.switched).toEqual([]);
  });

  it('load 校验失败 fail-loud：返回 error 文本（含失败原因），不触发 onSwitch', async () => {
    const deps = makeDeps({
      load: async () => {
        throw new Error('版本线 "latest" 引用缺失或不可解析（refs/heads/main）');
      },
    });
    const result = await modeCommandHandler('latest', deps);
    expect(result.kind).toBe('error');
    expect(result.text).toContain('切换到 latest 失败');
    expect(result.text).toContain('refs/heads/main');
    expect(deps.calls.switched).toEqual([]);
  });

  it('非空白会话拒绝切换：返回 error 文本说明需空白会话，不触发 onSwitch', async () => {
    const deps = makeDeps({ isBlankSession: async () => false });
    const result = await modeCommandHandler('latest', deps);
    expect(result.kind).toBe('error');
    expect(result.text).toContain('空白会话');
    expect(deps.calls.switched).toEqual([]);
  });

  it('未提供 isBlankSession/onSwitch（M0 无真实 DSH 接线）：切换仍成功（守卫生效）', async () => {
    const deps = makeDeps({ isBlankSession: undefined, onSwitch: undefined });
    const result = await modeCommandHandler('stable', deps);
    expect(result.kind).toBe('success');
    expect(result.text).toContain('stable');
    expect(deps.calls.loaded).toEqual(['stable']);
  });
});
