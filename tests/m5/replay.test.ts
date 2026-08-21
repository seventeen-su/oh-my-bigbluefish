// T5.2 G3 单元测试：确定性回放执行器（supervisor/replay.ts，架构 §9.2 / §17 Replay Fixture 开放项）。
// 严格 TDD：本文件先于实现编写并确认失败（功能缺失）。
// 覆盖（brief 测试清单 4-6 + 契约扩展）：
//   ④ G3 回放确定性：同一 fixture 跑 3 次 → 同 ok/state_hash（确定性）；canned 命中 → 结果一致
//   ⑤ G3 未命中：fixture 缺 canned 项 → fail-loud（不静默；deps.execute 真实执行器不被调用）
//   ⑥ 回放状态断言：最终 state_hash 与 expected 一致 → ok；不一致 → 拒（ok:false + detail 说明）
//   附加：
//     - 事件序列断言：events 与 expected 不一致 → 拒
//     - canned 结果经 ref 传导下游算子（结果一致性闭环：结果错 → 下游 input_hash 变 → 拒/未命中）
//     - 非确定性段显式声明：clock.fixed_ts 应用（'$.now' 绑定 → 固定时间戳，input_hash 确定）
//     - 非法 fixture（缺 name / canned 项缺 input_hash）→ 构造抛错（fail-loud）
//     - computeReplayStateHash 确定性 + 敏感性（M7 录制工具契约）
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { canonicalJson } from '../../kernel/schemas/base.js';
import {
  computeReplayStateHash,
  ReplayRunner,
  type ReplayFixture,
  type ReplayProcessDef,
  type ReplayTraceEntry,
} from '../../supervisor/replay.js';

// ---- 契约复算工具（独立于实现：同算法在测试侧重算 expected，防实现自证） ----

const sha256hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
/** 输入哈希：sha256(canonicalJson(解析后输入)) —— 与回放执行器同契约 */
const inputHash = (input: unknown): string => sha256hex(canonicalJson(input));
/** 状态哈希：sha256(canonicalJson(trace)) —— 与 computeReplayStateHash 同契约 */
const stateHash = (trace: unknown[]): string => sha256hex(canonicalJson(trace));

/** 固定时钟（非确定性段显式声明：epoch ms） */
const FIXED_TS = 1_752_000_000_000;

// ---- 测试过程与 fixture 工厂 ----

/** 单 EXECUTE 算子过程：常量输入 { q: 'hello' } */
function execProcess(): ReplayProcessDef {
  return {
    id: 'p:replay-exec',
    version: '1.0.0',
    entry: 'EXECUTE',
    exit: 'EXECUTE',
    operators: [{ id: 'EXECUTE', op: 'EXECUTE', input_binding: { q: 'hello' }, output: 'result' }],
  };
}

/** 单 EXECUTE 过程 + 完整 canned 的 fixture（expected 由契约复算） */
function execFixture(): ReplayFixture {
  const ih = inputHash({ q: 'hello' });
  const result = { ok: true, answer: 'hello world' };
  const trace: ReplayTraceEntry[] = [{ tool: 'EXECUTE', input_hash: ih, result }];
  return {
    name: 'replay-exec',
    input: { state_hash: 'input-state', task: { q: 'hello' } },
    canned: [{ tool: 'EXECUTE', input_hash: ih, result }],
    expected: { final_state_hash: stateHash(trace), events: [`EXECUTE:${ih}`] },
  };
}

/** 永不触达的真实执行器（canned 未命中应在拦截层 fail-loud，回放绝不走真实 I/O） */
function noRealExecute(): { execute: (tool: string, input: unknown) => Promise<unknown>; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    execute: async (tool: string) => {
      calls.push(tool);
      throw new Error(`真实执行器不应在回放中被调用: ${tool}`);
    },
  };
}

describe('G3 回放确定性（§9.2 / supervisor/replay.ts）', () => {
  it('④ 同一 fixture 跑 3 次 → 同 ok/state_hash（确定性）；canned 命中 → 结果一致（deps.execute 零调用）', async () => {
    const fixture = execFixture();
    const results: Array<{ ok: boolean; state_hash: string }> = [];
    for (let i = 0; i < 3; i++) {
      const runner = new ReplayRunner(fixture);
      const real = noRealExecute();
      const r = await runner.run(execProcess(), real);
      expect(r.ok).toBe(true);
      results.push({ ok: r.ok, state_hash: r.state_hash });
      expect(r.state_hash).toBe(fixture.expected.final_state_hash); // canned 命中 → 结果与录制一致
      expect(real.calls).toEqual([]); // 回放未触达真实执行器（canned 完全拦截）
    }
    // 确定性：三次运行输出逐位一致
    expect(results[0]).toEqual(results[1]);
    expect(results[1]).toEqual(results[2]);
  });

  it('④b 非确定性段显式声明：clock.fixed_ts 应用于 $.now 绑定 → 三次运行 input_hash 一致（确定性）', async () => {
    const ih = inputHash({ ts: FIXED_TS });
    const result = { done: true };
    const trace: ReplayTraceEntry[] = [{ tool: 'EXECUTE', input_hash: ih, result }];
    const fixture: ReplayFixture = {
      name: 'replay-now',
      input: { state_hash: 'input-state', task: {} },
      clock: { fixed_ts: FIXED_TS }, // 非确定性段（时间）显式声明
      canned: [{ tool: 'EXECUTE', input_hash: ih, result }],
      expected: { final_state_hash: stateHash(trace), events: [`EXECUTE:${ih}`] },
    };
    const process: ReplayProcessDef = {
      id: 'p:replay-now',
      version: '1.0.0',
      entry: 'EXECUTE',
      exit: 'EXECUTE',
      operators: [{ id: 'EXECUTE', op: 'EXECUTE', input_binding: { ts: '$.now' }, output: 'result' }],
    };
    const hashes = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const r = await new ReplayRunner(fixture).run(process, noRealExecute());
      expect(r.ok).toBe(true);
      hashes.add(r.state_hash);
    }
    expect(hashes.size).toBe(1); // 三次运行同一 state_hash（固定时钟消除时间不确定性）
  });

  it('⑤ G3 未命中：fixture 缺 canned 项 → fail-loud（rejects，不静默）', async () => {
    const missing = { ...execFixture(), canned: [] }; // 录制不完整：无任何 canned 项
    const runner = new ReplayRunner(missing);
    const real = noRealExecute();
    await expect(runner.run(execProcess(), real)).rejects.toThrow(/未命中|fixture|canned/i);
    expect(real.calls).toEqual([]); // 未命中绝不回退真实执行器
  });

  it('⑥ 回放状态断言：最终 state_hash 与 expected 一致 → ok；不一致 → 拒（ok:false + detail）', async () => {
    // 一致 → ok
    const ok = await new ReplayRunner(execFixture()).run(execProcess(), noRealExecute());
    expect(ok.ok).toBe(true);
    expect(ok.state_hash).toBe(execFixture().expected.final_state_hash);

    // 不一致（篡改 expected.final_state_hash）→ 拒：ok:false，detail 指明 state_hash 不符，state_hash 返回实际值
    const tampered = { ...execFixture(), expected: { ...execFixture().expected, final_state_hash: 'tampered-hash' } };
    const bad = await new ReplayRunner(tampered).run(execProcess(), noRealExecute());
    expect(bad.ok).toBe(false);
    expect(bad.state_hash).toBe(execFixture().expected.final_state_hash); // 实际回放 state_hash 如实返回
    expect(bad.detail).toMatch(/state_hash/);
  });

  it('事件序列断言：events 与 expected 不一致 → 拒（ok:false + detail）', async () => {
    const badEvents = { ...execFixture(), expected: { ...execFixture().expected, events: ['WRONG:deadbeef'] } };
    const r = await new ReplayRunner(badEvents).run(execProcess(), noRealExecute());
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/events|事件/);
  });

  it('canned 结果经 ref 传导下游算子：结果一致 → ok；结果篡改 → 下游 input_hash 变化 → 未命中 fail-loud', async () => {
    // 两算子链：EXECUTE 产出 r1 → EXECUTE-1 绑定 { prev: { ref: 'EXECUTE' } } 消费 r1
    const r1 = { ok: true, answer: 'hello world' };
    const ih1 = inputHash({ q: 'hello' });
    const ih2 = inputHash({ prev: r1 }); // 依赖 r1 内容（结果传导）
    const trace: ReplayTraceEntry[] = [
      { tool: 'EXECUTE', input_hash: ih1, result: r1 },
      { tool: 'EXECUTE-1', input_hash: ih2, result: 'final' },
    ];
    const fixture: ReplayFixture = {
      name: 'replay-chain2',
      input: { state_hash: 'input-state', task: { q: 'hello' } },
      canned: [
        { tool: 'EXECUTE', input_hash: ih1, result: r1 },
        { tool: 'EXECUTE-1', input_hash: ih2, result: 'final' },
      ],
      expected: { final_state_hash: stateHash(trace), events: [`EXECUTE:${ih1}`, `EXECUTE-1:${ih2}`] },
    };
    const process: ReplayProcessDef = {
      id: 'p:replay-chain2',
      version: '1.0.0',
      entry: 'EXECUTE',
      exit: 'EXECUTE',
      operators: [
        { id: 'EXECUTE', op: 'EXECUTE', input_binding: { q: 'hello' }, output: 'step1' },
        { id: 'EXECUTE-1', op: 'EXECUTE', input_binding: { prev: { ref: 'EXECUTE' } }, output: 'step2' },
      ],
    };
    const ok = await new ReplayRunner(fixture).run(process, noRealExecute());
    expect(ok.ok).toBe(true);

    // 结果篡改：录制端 r1 是正确值（canned 的 ih2 按正确 r1 计算）；回放 canned 把 r1 篡改为 wrongR1 →
    // 下游 EXECUTE-1 实际 input_hash = wrongIh2 ≠ 录制 ih2 → 未命中 fail-loud（结果一致性闭环）
    const wrongR1 = { ok: true, answer: 'WRONG' };
    const wrongIh2 = inputHash({ prev: wrongR1 });
    const corruptFixture: ReplayFixture = {
      ...fixture,
      canned: [
        { tool: 'EXECUTE', input_hash: ih1, result: wrongR1 },
        { tool: 'EXECUTE-1', input_hash: ih2, result: 'final' }, // 录制端的 ih2（按正确 r1）；回放算得 wrongIh2 → 必未命中
      ],
    };
    expect(wrongIh2).not.toBe(ih2); // 前提自检：篡改结果确实改变下游 input_hash
    await expect(new ReplayRunner(corruptFixture).run(process, noRealExecute())).rejects.toThrow(/未命中|fixture|canned/i);
  });

  it('非 EXECUTE 算子确定性透传：STOP 无工具调用，事件含透传条目，最终仍 ok', async () => {
    const ih1 = inputHash({ q: 'hello' });
    const r1 = { ok: true };
    const ihStop = inputHash({});
    const trace: ReplayTraceEntry[] = [
      { tool: 'EXECUTE', input_hash: ih1, result: r1 },
      { tool: 'STOP', input_hash: ihStop, result: {} },
    ];
    const fixture: ReplayFixture = {
      name: 'replay-stop',
      input: { state_hash: 'input-state', task: {} },
      canned: [{ tool: 'EXECUTE', input_hash: ih1, result: r1 }],
      expected: { final_state_hash: stateHash(trace), events: [`EXECUTE:${ih1}`, `STOP:${ihStop}`] },
    };
    const process: ReplayProcessDef = {
      id: 'p:replay-stop',
      version: '1.0.0',
      entry: 'EXECUTE',
      exit: 'STOP',
      operators: [
        { id: 'EXECUTE', op: 'EXECUTE', input_binding: { q: 'hello' }, output: 'step1' },
        { id: 'STOP', op: 'STOP', input_binding: {}, output: 'done' },
      ],
    };
    const r = await new ReplayRunner(fixture).run(process, noRealExecute());
    expect(r.ok).toBe(true);
  });

  it('非法 fixture（缺 name / canned 项缺 input_hash）→ 构造抛错（fail-loud）', () => {
    expect(() => new ReplayRunner({ ...execFixture(), name: '' })).toThrow();
    const badCanned = { ...execFixture(), canned: [{ tool: 'EXECUTE', input_hash: '', result: 1 }] };
    expect(() => new ReplayRunner(badCanned)).toThrow();
  });

  it('computeReplayStateHash：同 trace 同 hash；不同 trace 不同 hash（M7 录制工具契约）', () => {
    const a: ReplayTraceEntry[] = [{ tool: 'T', input_hash: 'h1', result: 1 }];
    const a2: ReplayTraceEntry[] = [{ tool: 'T', input_hash: 'h1', result: 1 }];
    const b: ReplayTraceEntry[] = [{ tool: 'T', input_hash: 'h1', result: 2 }];
    expect(computeReplayStateHash(a)).toBe(computeReplayStateHash(a2));
    expect(computeReplayStateHash(a)).not.toBe(computeReplayStateHash(b));
  });
});
