// T6a.2 行为测试：Capability Broker 分级与软接管（runtime/broker.ts，架构 §8.2）。
// 严格 TDD：本文件先于实现编写并确认失败（模块缺失）。
// 覆盖（brief 测试清单 1-9 + 补充 ⑩ discovery）：
//   ① 共存路由：两 provider 无 policy → 注册序执行
//   ② 优先路由：prefer 级 provider 命中次数高 → 排序在前（隐式偏好学习）
//   ③ 包装增强：wrap 级 → AdapterAPI 前置/后置转换生效（input/output 被包装）
//   ④ 降权：deweight → 同能力但权重低者排后（coexist 优先于 deweight；deweight 内权重大者在前）
//   ⑤ shadow：shadow 级 → 执行但结果不入主链 + exposure log 记录（复用 T5.3 logExposure）
//   ⑥ 软接管：takeover → patch 禁用目标 + restrict 隐藏 + 同名 shadow + post-execute 拦截全部生效
//   ⑦ 软接管回滚：rollbackTakeover → 原 provider 恢复（行为复原）
//   ⑧ 硬边界断言：pre-execute 参数改写 / 同层同名注册 / restrict 越界 / patch 改名 /
//      root realm 服务 → 违规清单含全部项；良性操作不误报
//   ⑨ 降级链衔接：首选 provider 失败 → 分级内 fallback（T6a.1 语义）
//   ⑩ CapabilityDiscovery（补充）：discovery 只返回某 provider → 仅其可路由
//   ⑥+ 软接管同名校验拒绝（fail-loud）；⑫ execute ok:false resolution → no_resolution（评审补分支覆盖）
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  CapabilityBroker,
  BrokerError,
  type BrokerPolicy,
  type Resolution,
} from '../../runtime/broker.js';
import { logExposure as t53logExposure, type ExposureEntry } from '../../supervisor/shadow.js';
import type { CapabilityContract, CapabilityProvider, CapabilityResult } from '../../kernel/capability-abi.js';
import type { Intent } from '../../runtime/intent.js';

// ---- 测试工具（同 intent.test.ts 形态） ----

function makeContract(overrides: Partial<CapabilityContract> = {}): CapabilityContract {
  return {
    id: `capability:${crypto.randomUUID()}`,
    name: 'read-file',
    input: z.object({ path: z.string() }),
    output: z.object({ text: z.string() }),
    cost: { tokens: 10, latency_ms: 5 },
    side_effect: 'read_only',
    reversibility: { declared: false },
    reliability: 'high',
    evidence_quality: 'verified',
    idempotency: 'idempotent',
    concurrency: 'safe',
    authority_scope: 'user',
    ...overrides,
  };
}

type ExecuteFn = (input: unknown) => Promise<CapabilityResult>;

function makeProvider(overrides: Partial<CapabilityContract> = {}, execute?: ExecuteFn): CapabilityProvider {
  const manifest = makeContract(overrides);
  const fn: ExecuteFn =
    execute ??
    (async (input) => ({
      ok: true,
      output: { text: `ok:${JSON.stringify(input)}` },
      metrics: { tokens: 1, latency_ms: 1 },
    }));
  return {
    manifest,
    async createHandle() {
      return { contract: manifest, execute: fn };
    },
  };
}

function makeIntent(overrides: Partial<Intent> = {}): Intent {
  return {
    verb: 'read',
    object: 'file',
    scope: 'user',
    effects: 'read_only',
    constraints: [],
    required_verification: 'v:1',
    ...overrides,
  };
}

function expectOk(res: Resolution): Extract<Resolution, { ok: true }> {
  if (!res.ok) {
    throw new Error(`resolve 失败: ${res.error.code} ${res.error.reason}`);
  }
  return res;
}

function policy(levels: BrokerPolicy['levels']): BrokerPolicy {
  return { levels };
}

// ---- ① 共存路由 ----

describe('① 共存路由（无 policy → 注册序）', () => {
  it('两 provider 无 policy → 注册序执行：primary 为先注册者，execute 走 primary', async () => {
    const calls: string[] = [];
    const a = makeProvider({ id: 'capability:co-a', name: 'read-file' }, async () => {
      calls.push('a');
      return { ok: true, output: { text: 'A' }, metrics: { tokens: 1, latency_ms: 1 } };
    });
    const b = makeProvider({ id: 'capability:co-b', name: 'read-file' }, async () => {
      calls.push('b');
      return { ok: true, output: { text: 'B' }, metrics: { tokens: 1, latency_ms: 1 } };
    });
    const broker = new CapabilityBroker({
      providers: new Map([
        [a.manifest.id, a],
        [b.manifest.id, b],
      ]),
      policy: policy([]),
    });

    const res = expectOk(await broker.resolve(makeIntent()));

    expect(res.providers).toEqual(['capability:co-a', 'capability:co-b']);
    expect(res.route.map((r) => r.level)).toEqual(['coexist', 'coexist']);
    const exec = await broker.execute(res, { path: 'a.txt' });
    expect(exec.ok).toBe(true);
    if (exec.ok) {
      expect(exec.outputs).toEqual([{ text: 'A' }]);
    }
    expect(calls).toEqual(['a']);
  });
});

// ---- ② 优先路由（隐式偏好学习） ----

describe('② 优先路由（prefer 隐式偏好学习）', () => {
  it('prefer 级：命中次数高者排序在前（B 被降级使用成功后提升为 primary）', async () => {
    const a = makeProvider(
      { id: 'capability:pref-a', name: 'read-file', reliability: 'high' },
      async (input) => {
        if ((input as { path?: string }).path === 'boom') {
          return { ok: false, error: { code: 'E_BOOM', message: 'boom', retryable: true }, metrics: { tokens: 0, latency_ms: 0 } };
        }
        return { ok: true, output: { text: 'A' }, metrics: { tokens: 1, latency_ms: 1 } };
      },
    );
    const b = makeProvider({ id: 'capability:pref-b', name: 'read-file', reliability: 'medium' }, async () => ({
      ok: true,
      output: { text: 'B' },
      metrics: { tokens: 1, latency_ms: 1 },
    }));
    const broker = new CapabilityBroker({
      providers: new Map([
        [a.manifest.id, a],
        [b.manifest.id, b],
      ]),
      policy: policy([
        { provider_id: 'capability:pref-a', level: 'prefer' },
        { provider_id: 'capability:pref-b', level: 'prefer' },
      ]),
    });

    const first = expectOk(await broker.resolve(makeIntent()));
    expect(first.providers).toEqual(['capability:pref-a', 'capability:pref-b']); // 同命中 → 注册序

    const exec = await broker.execute(first, { path: 'boom' }); // A 失败 → B 命中
    expect(exec.ok).toBe(true);
    if (exec.ok) {
      expect(exec.fallbacks_used).toEqual(['capability:pref-b']);
    }

    const second = expectOk(await broker.resolve(makeIntent()));
    expect(second.providers).toEqual(['capability:pref-b', 'capability:pref-a']); // 命中高者在前
  });
});

// ---- ③ 包装增强 ----

describe('③ 包装增强（wrap / AdapterAPI）', () => {
  it('wrap 级：before 前置转换 input、after 后置转换 output 生效', async () => {
    let seen: unknown;
    const w = makeProvider({ id: 'capability:wrap-1', name: 'read-file' }, async (input) => {
      seen = input;
      return { ok: true, output: { text: 'raw' }, metrics: { tokens: 1, latency_ms: 1 } };
    });
    const broker = new CapabilityBroker({
      providers: new Map([[w.manifest.id, w]]),
      policy: policy([
        {
          provider_id: 'capability:wrap-1',
          level: 'wrap',
          adapter: {
            before: (input) => ({ ...(input as object), wrapped: true }),
            after: (r) => ({ ...r, output: { ...(r.output as object), decorated: true } }),
          },
        },
      ]),
    });

    const res = expectOk(await broker.resolve(makeIntent()));
    expect(res.route).toEqual([{ provider_id: 'capability:wrap-1', level: 'wrap' }]);

    const exec = await broker.execute(res, { path: 'a.txt' });
    expect(seen).toEqual({ path: 'a.txt', wrapped: true }); // before 已包装 input
    expect(exec.ok).toBe(true);
    if (exec.ok) {
      expect(exec.outputs).toEqual([{ text: 'raw', decorated: true }]); // after 已包装 output
    }
  });
});

// ---- ④ 降权 ----

describe('④ 降权（deweight）', () => {
  it('同能力：coexist 优先于 deweight；deweight 内权重大者在前', async () => {
    const co = makeProvider({ id: 'capability:dw-co', name: 'read-file' });
    const hi = makeProvider({ id: 'capability:dw-hi', name: 'read-file' });
    const lo = makeProvider({ id: 'capability:dw-lo', name: 'read-file' });
    const broker = new CapabilityBroker({
      providers: new Map([
        [co.manifest.id, co],
        [hi.manifest.id, hi],
        [lo.manifest.id, lo],
      ]),
      policy: policy([
        { provider_id: 'capability:dw-lo', level: 'deweight', weight: 0.3 },
        { provider_id: 'capability:dw-hi', level: 'deweight', weight: 0.8 },
      ]),
    });

    const res = expectOk(await broker.resolve(makeIntent()));

    expect(res.providers).toEqual(['capability:dw-co', 'capability:dw-hi', 'capability:dw-lo']);
  });
});

// ---- ⑤ shadow ----

describe('⑤ shadow（结果不入主链 + exposure log）', () => {
  let base: string;
  let logPath: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'omb-broker-'));
    logPath = join(base, 'exposure.log');
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('shadow 级 provider 执行但结果不入主链，exposure log 记录（复用 T5.3 logExposure）', async () => {
    let shadowCalls = 0;
    const main = makeProvider({ id: 'capability:sh-main', name: 'read-file' }, async () => ({
      ok: true,
      output: { text: 'MAIN' },
      metrics: { tokens: 1, latency_ms: 1 },
    }));
    const sh = makeProvider({ id: 'capability:sh-shadow', name: 'read-file' }, async () => {
      shadowCalls += 1;
      return { ok: true, output: { text: 'SHADOW' }, metrics: { tokens: 1, latency_ms: 1 } };
    });
    const broker = new CapabilityBroker({
      providers: new Map([
        [main.manifest.id, main],
        [sh.manifest.id, sh],
      ]),
      policy: policy([{ provider_id: 'capability:sh-shadow', level: 'shadow' }]),
      exposureLogPath: logPath,
      logExposure: (p, e) => t53logExposure(p, e as ExposureEntry),
    });

    const res = expectOk(await broker.resolve(makeIntent()));
    expect(res.providers).toEqual(['capability:sh-main']); // shadow 不入主链候选
    expect(res.shadow.map((s) => s.provider_id)).toEqual(['capability:sh-shadow']);

    const exec = await broker.execute(res, { path: 'a.txt' });
    expect(shadowCalls).toBe(1); // shadow 仍执行
    expect(exec.ok).toBe(true);
    if (exec.ok) {
      expect(exec.outputs).toEqual([{ text: 'MAIN' }]); // 结果不入主链
      expect(exec.shadow).toEqual([{ provider_id: 'capability:sh-shadow', ok: true }]);
    }
    const log = await readFile(logPath, 'utf8');
    const entries = log
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as ExposureEntry);
    expect(entries.map((e) => e.candidate_id)).toContain('capability:sh-shadow');
    expect(entries.every((e) => e.decision === 'shadow')).toBe(true);
  });
});

// ---- ⑥ 软接管 ----

describe('⑥ 软接管（takeover 四件套）', () => {
  let base: string;
  let logPath: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'omb-broker-'));
    logPath = join(base, 'exposure.log');
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('takeover → patch 禁用目标 + restrict 隐藏 + 同名 shadow + post-execute 拦截全部生效', async () => {
    let xCalls = 0;
    let yCalls = 0;
    const x = makeProvider({ id: 'capability:third-party', name: 'read-file' }, async () => {
      xCalls += 1;
      return { ok: true, output: { text: 'X' }, metrics: { tokens: 1, latency_ms: 1 } };
    });
    const y = makeProvider({ id: 'capability:platform', name: 'read-file', reliability: 'low' }, async () => {
      yCalls += 1;
      return { ok: true, output: { text: 'Y' }, metrics: { tokens: 1, latency_ms: 1 } };
    });
    const broker = new CapabilityBroker({
      providers: new Map([[x.manifest.id, x]]),
      policy: policy([]),
      exposureLogPath: logPath,
      logExposure: (p, e) => t53logExposure(p, e as ExposureEntry),
    });

    await broker.takeover('capability:third-party', {
      override: { reliability: 'high' }, // patch 覆盖（shadow manifest 生效）
      shadow: y, // 同名 shadow
      intercept: (r) => ({ ...r, output: { ...(r.output as object), intercepted: true } }), // post-execute 拦截
    });

    const res = expectOk(await broker.resolve(makeIntent()));
    expect(res.providers).toEqual(['capability:platform']); // 目标被禁用/隐藏 → shadow 接管
    expect(res.hidden).toEqual(['capability:third-party']); // restrict 隐藏
    expect(res.disabled).toEqual(['capability:third-party']); // patch 禁用
    expect(res.route).toEqual([{ provider_id: 'capability:platform', level: 'takeover' }]);
    expect(res.chain[0]!.contract.reliability).toBe('high'); // override 覆盖生效

    const exec = await broker.execute(res, { path: 'a.txt' });
    expect(xCalls).toBe(0); // 目标不再执行
    expect(yCalls).toBe(1); // 同名 shadow 执行
    expect(exec.ok).toBe(true);
    if (exec.ok) {
      expect(exec.outputs).toEqual([{ text: 'Y', intercepted: true }]); // post-execute 拦截生效
    }
    const log = await readFile(logPath, 'utf8');
    expect(log).toContain('capability:platform'); // shadow 执行有 exposure 记录
  });

  it('takeover 未知 provider → 拒绝（fail-loud）', async () => {
    const broker = new CapabilityBroker({ providers: new Map(), policy: policy([]) });
    await expect(broker.takeover('capability:missing', {})).rejects.toThrow(BrokerError);
  });

  it('takeover shadow 不同名 → 拒绝（fail-loud，patch 改名禁止）', async () => {
    const x = makeProvider({ id: 'capability:third-party', name: 'read-file' });
    const y = makeProvider({ id: 'capability:platform', name: 'write-file' }); // 不同名 → 同名校验拒绝
    const broker = new CapabilityBroker({ providers: new Map([[x.manifest.id, x]]), policy: policy([]) });
    await expect(broker.takeover('capability:third-party', { shadow: y })).rejects.toThrow(BrokerError);
  });
});

// ---- ⑦ 软接管回滚 ----

describe('⑦ 软接管回滚', () => {
  it('rollbackTakeover → 原 provider 恢复（行为复原：无拦截、目标重新路由）', async () => {
    let xCalls = 0;
    let yCalls = 0;
    const x = makeProvider({ id: 'capability:third-party', name: 'read-file' }, async () => {
      xCalls += 1;
      return { ok: true, output: { text: 'X-RAW' }, metrics: { tokens: 1, latency_ms: 1 } };
    });
    const y = makeProvider({ id: 'capability:platform', name: 'read-file' }, async () => {
      yCalls += 1;
      return { ok: true, output: { text: 'Y' }, metrics: { tokens: 1, latency_ms: 1 } };
    });
    const broker = new CapabilityBroker({
      providers: new Map([[x.manifest.id, x]]),
      policy: policy([]),
    });

    await broker.takeover('capability:third-party', {
      shadow: y,
      intercept: (r) => ({ ...r, output: { ...(r.output as object), intercepted: true } }),
    });
    const before = expectOk(await broker.resolve(makeIntent()));
    expect(before.providers).toEqual(['capability:platform']);

    await broker.rollbackTakeover('capability:third-party');

    const after = expectOk(await broker.resolve(makeIntent()));
    expect(after.providers).toEqual(['capability:third-party']); // 原 provider 恢复路由
    expect(after.hidden).toEqual([]);
    expect(after.disabled).toEqual([]);
    expect(after.route).toEqual([{ provider_id: 'capability:third-party', level: 'coexist' }]);

    const exec = await broker.execute(after, { path: 'a.txt' });
    expect(xCalls).toBe(1); // 原 provider 重新执行
    expect(yCalls).toBe(0);
    expect(exec.ok).toBe(true);
    if (exec.ok) {
      expect(exec.outputs).toEqual([{ text: 'X-RAW' }]); // 行为复原（无拦截）
    }
  });
});

// ---- ⑧ 硬边界断言 ----

describe('⑧ 平台硬边界断言（assertHardBoundaries）', () => {
  it('五类违规全部被断言函数检出（违规清单含全部项）', () => {
    const existing = makeProvider({ id: 'capability:hb-existing', name: 'read-file', authority_scope: 'user' });
    const broker = new CapabilityBroker({
      providers: new Map([[existing.manifest.id, existing]]),
      policy: policy([]),
    });

    const violations = broker.assertHardBoundaries({
      pre_execute: (run) => run((input) => ({ ...(input as object), tampered: true })), // 参数改写
      register_same_layer: (run) => run(makeProvider({ id: 'capability:hb-dup', name: 'read-file', authority_scope: 'user' })), // 同层同名
      restrict: (run) => run({ scope: 'global' }), // restrict 全局化
      patch: (run) => run({ kind: 'rename', target: 'read-file' }), // patch 改名
      publish_root_service: (run) => run(), // root realm 服务
    });

    expect(violations).toEqual(
      expect.arrayContaining(['pre_execute 参数改写', '同层同名注册', 'restrict 越界', 'patch 改名/删行', 'preset root realm 服务']),
    );
    expect(violations.length).toBe(5);
  });

  it('良性操作不误报（恒等 hook / 不同名 / own 层 restrict / override patch / 不发布 root）', () => {
    const broker = new CapabilityBroker({ providers: new Map(), policy: policy([]) });

    const violations = broker.assertHardBoundaries({
      pre_execute: (run) => run((input) => input), // 恒等，不改写
      register_same_layer: (run) => run(makeProvider({ id: 'capability:hb-uniq', name: 'unique-name' })), // 不同名
      restrict: (run) => run({ scope: 'own', layer: 'own' }), // own 层内
      patch: (run) => run({ kind: 'override', target: 'read-file' }), // override 合法
      publish_root_service: () => {
        /* 不发布 root realm 服务 */
      },
    });

    expect(violations).toEqual([]);
  });

  it('restrict 越界变体：run_code / own 层之外也检出', () => {
    const broker = new CapabilityBroker({ providers: new Map(), policy: policy([]) });
    const v1 = broker.assertHardBoundaries({
      pre_execute: (run) => run((input) => input),
      register_same_layer: (run) => run(makeProvider({ id: 'capability:hb-u1', name: 'u1' })),
      restrict: (run) => run({ scope: 'own', layer: 'run_code' }),
      patch: (run) => run({ kind: 'override' }),
      publish_root_service: () => {
        /* noop */
      },
    });
    const v2 = broker.assertHardBoundaries({
      pre_execute: (run) => run((input) => input),
      register_same_layer: (run) => run(makeProvider({ id: 'capability:hb-u2', name: 'u2' })),
      restrict: (run) => run({ scope: 'own', layer: 'sibling' }),
      patch: (run) => run({ kind: 'override' }),
      publish_root_service: () => {
        /* noop */
      },
    });
    expect(v1).toEqual(['restrict 越界']);
    expect(v2).toEqual(['restrict 越界']);
  });
});

// ---- ⑨ 降级链衔接 ----

describe('⑨ 降级链衔接（T6a.1 语义）', () => {
  it('首选 provider 失败 → 分级内 fallback 被调（fallbacks_used 记录）', async () => {
    const primary = makeProvider(
      { id: 'capability:dc-primary', name: 'read-file', reliability: 'high' },
      async (input) => {
        if ((input as { path?: string }).path === 'boom') {
          return { ok: false, error: { code: 'E_BOOM', message: 'boom', retryable: true }, metrics: { tokens: 0, latency_ms: 0 } };
        }
        return { ok: true, output: { text: 'P' }, metrics: { tokens: 1, latency_ms: 1 } };
      },
    );
    let fbCalls = 0;
    const fallback = makeProvider({ id: 'capability:dc-fallback', name: 'read-file', reliability: 'medium' }, async () => {
      fbCalls += 1;
      return { ok: true, output: { text: 'F' }, metrics: { tokens: 1, latency_ms: 1 } };
    });
    const broker = new CapabilityBroker({
      providers: new Map([
        [primary.manifest.id, primary],
        [fallback.manifest.id, fallback],
      ]),
      policy: policy([]),
    });

    const res = expectOk(await broker.resolve(makeIntent()));
    expect(res.fallbacks[0]!.handles.map((h) => h.contract.id)).toEqual([
      'capability:dc-primary',
      'capability:dc-fallback',
    ]);

    const exec = await broker.execute(res, { path: 'boom' });
    expect(exec.ok).toBe(true);
    if (exec.ok) {
      expect(exec.outputs).toEqual([{ text: 'F' }]);
      expect(exec.fallbacks_used).toEqual(['capability:dc-fallback']);
    }
    expect(fbCalls).toBe(1);
  });
});

// ---- ⑩ CapabilityDiscovery（补充） ----

describe('⑩ CapabilityDiscovery（补充）', () => {
  it('discovery 只返回 B → 仅 B 可路由（覆盖注册序）', async () => {
    const a = makeProvider({ id: 'capability:disc-a', name: 'read-file' });
    const b = makeProvider({ id: 'capability:disc-b', name: 'read-file' });
    const broker = new CapabilityBroker({
      providers: new Map([
        [a.manifest.id, a],
        [b.manifest.id, b],
      ]),
      policy: policy([]),
      discovery: {
        discover: async () => [b],
      },
    });

    const res = expectOk(await broker.resolve(makeIntent()));

    expect(res.providers).toEqual(['capability:disc-b']);
  });
});

// ---- ⑪ 策略级 patch（数据驱动 disable/override） ----

describe('⑪ 策略级 patch（BrokerPolicy levels 数据驱动）', () => {
  it('policy patch.disable 禁用 provider；patch.override 覆盖 manifest 字段', async () => {
    const a = makeProvider({ id: 'capability:pp-a', name: 'read-file', reliability: 'low' });
    const b = makeProvider({ id: 'capability:pp-b', name: 'read-file' });
    const broker = new CapabilityBroker({
      providers: new Map([
        [a.manifest.id, a],
        [b.manifest.id, b],
      ]),
      policy: policy([
        {
          provider_id: 'capability:pp-a',
          level: 'coexist',
          patch: { disable: ['capability:pp-b'], override: { reliability: 'high' } },
        },
      ]),
    });

    const res = expectOk(await broker.resolve(makeIntent()));

    expect(res.providers).toEqual(['capability:pp-a']); // pp-b 被禁用
    expect(res.disabled).toEqual(['capability:pp-b']); // 禁用清单
    expect(res.chain[0]!.contract.reliability).toBe('high'); // override 生效于契约面
  });
});

// ---- ⑫ execute 拒绝路径 ----

describe('⑫ execute 对无效 resolution 的拒绝路径', () => {
  it('ok:false resolution → no_resolution 拒绝（shadow 空，不进入执行链）', async () => {
    const broker = new CapabilityBroker({ providers: new Map(), policy: policy([]) });
    const res: Resolution = { ok: false, error: { code: 'invalid_intent', reason: 'intent 校验失败' } };
    const exec = await broker.execute(res, {});
    expect(exec).toEqual({
      ok: false,
      error: { code: 'no_resolution', node: '', reason: 'resolution 无效', negative_pattern: '' },
      shadow: [],
    });
  });
});
