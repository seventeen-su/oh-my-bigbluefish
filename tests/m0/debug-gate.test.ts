// 诊断输出闸门（`substrate/debug.ts`）测试。
//
// 为什么需要它：布局初始化/修复、启动回退时 worktree 同步失败这类诊断行此前**直写 console**，
// 其中"worktree 同步失败"在当前设计下是**预期**结果（正式 worktree 只读、回退只切 ref），
// 每次回退都往宿主终端打一遍会被误读成故障。闸门默认关闭，且**只**影响 console 行——
// 状态面与降级记录不受影响（日志可静音，状态不可静音）。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { diag, diagWarn, diagnosticsEnabled, setDiagnostics } from '../../substrate/debug.js';

afterEach(() => {
  setDiagnostics(false);
  vi.restoreAllMocks();
});

describe('诊断闸门：默认静默，显式开启才输出', () => {
  it('默认关闭 → diag/diagWarn 都不产生任何 console 输出', () => {
    setDiagnostics(false);
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    diag('[omb-v2] 这行不该出现');
    diagWarn('[rollback] 这行也不该出现');
    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('开启后 → diag 走 info、diagWarn 走 warn（分级不被抹平）', () => {
    setDiagnostics(true);
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    diag('普通诊断');
    diagWarn('告警诊断');
    expect(info).toHaveBeenCalledWith('普通诊断');
    expect(warn).toHaveBeenCalledWith('告警诊断');
  });

  it('开→关可逆（幂等设置，不残留状态）', () => {
    setDiagnostics(true);
    expect(diagnosticsEnabled()).toBe(true);
    setDiagnostics(false);
    expect(diagnosticsEnabled()).toBe(false);
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    diag('关掉之后不该再输出');
    expect(info).not.toHaveBeenCalled();
  });

  it('环境变量 OMB_DEBUG=1 可作为初始值（不经插件也能排障）', async () => {
    // 模块级初始值在 import 时求值：用 resetModules 重新加载一份干净的模块来看初始判定。
    const prev = process.env.OMB_DEBUG;
    try {
      process.env.OMB_DEBUG = '1';
      vi.resetModules();
      const fresh = await import('../../substrate/debug.js');
      expect(fresh.diagnosticsEnabled()).toBe(true);
    } finally {
      if (prev === undefined) {
        delete process.env.OMB_DEBUG;
      } else {
        process.env.OMB_DEBUG = prev;
      }
      vi.resetModules();
    }
  });
});
