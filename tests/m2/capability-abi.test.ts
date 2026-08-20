// T2.5 行为测试：能力 ABI 接口定义（kernel/capability-abi.ts，架构 §8.1 契约匹配字段 + §4.4 Fingerprint）。
// 五类：① 契约校验（合法通过 / 缺 input / side_effect 枚举非法 / reliability 非法拒绝）
//       ② Handle 调用路径（fake provider → createHandle → execute 成功/失败结果结构）
//       ③ 无 Broker 依赖（源码不含 'broker' 字符串；import 图仅 node: / zod / kernel/schemas）
//       ④ 可选 cancel（有 cancel 的 handle 可调用；无 cancel 的类型可选）
//       ⑤ idempotency 两种值均可校验。
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  validateContract,
  type CapabilityContract,
  type CapabilityHandle,
  type CapabilityProvider,
  type CapabilityResult,
} from '../../kernel/capability-abi.js';
import { FingerprintSchema } from '../../kernel/schemas/base.js';

const ABI_SOURCE = fileURLToPath(new URL('../../kernel/capability-abi.ts', import.meta.url));

const TEST_FINGERPRINT = FingerprintSchema.parse({
  os: 'win32',
  node: 'v24.0.0',
  dsh_version: '0.1.0',
  project: 'omb-v2',
  gpu: 'none',
  cuda: 'none',
});

/** 合法 contract 构造器（overrides 覆盖单个字段，便于造非法样例） */
function validContract(overrides: Partial<CapabilityContract> = {}): CapabilityContract {
  return {
    id: 'capability:6f9619ff-8b86-d011-b42d-00cf4fc964ff',
    name: 'echo',
    input: z.object({ text: z.string() }),
    output: z.object({ text: z.string() }),
    cost: { tokens: 10, latency_ms: 5 },
    side_effect: 'read_only',
    reversibility: { declared: false },
    reliability: 'high',
    evidence_quality: 'verified',
    idempotency: 'idempotent',
    concurrency: 'safe',
    authority_scope: 'kernel',
    ...overrides,
  };
}

describe('① 契约校验（§8.1 契约匹配字段）', () => {
  it('合法 contract（全字段含环境指纹）通过', () => {
    const r = validateContract(validContract({ environment: TEST_FINGERPRINT }));
    expect(r.success).toBe(true);
  });

  it('最小合法 contract（cost 空对象、rollback_path/environment 省略）通过', () => {
    const minimal: CapabilityContract = {
      id: 'capability:6f9619ff-8b86-d011-b42d-00cf4fc964ff',
      name: 'echo',
      input: z.string(),
      output: z.string(),
      cost: {},
      side_effect: 'none',
      reversibility: { declared: true },
      reliability: 'low',
      evidence_quality: 'none',
      idempotency: 'not_idempotent',
      concurrency: 'exclusive',
      authority_scope: 'community',
    };
    expect(validateContract(minimal).success).toBe(true);
  });

  it('缺 input → 拒绝且错误路径指向 input', () => {
    const bad = { ...validContract() } as Partial<CapabilityContract>;
    delete bad.input;
    const r = validateContract(bad);
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.join('.') === 'input')).toBe(true);
    }
  });

  it('side_effect 枚举非法 → 拒绝', () => {
    const r = validateContract({ ...validContract(), side_effect: 'banana' } as unknown);
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.join('.') === 'side_effect')).toBe(true);
    }
  });

  it('reliability 枚举非法 → 拒绝', () => {
    const r = validateContract({ ...validContract(), reliability: 'super' } as unknown);
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.join('.') === 'reliability')).toBe(true);
    }
  });
});

describe('② Handle 调用路径（Provider → createHandle → execute）', () => {
  const echoContract = validContract();

  const provider: CapabilityProvider = {
    manifest: echoContract,
    async createHandle() {
      return {
        contract: echoContract,
        async execute(input: unknown): Promise<CapabilityResult> {
          if (input === 'fail') {
            return {
              ok: false,
              error: { code: 'E_ECHO', message: 'boom', retryable: true },
              metrics: { tokens: 0, latency_ms: 1 },
            };
          }
          return {
            ok: true,
            output: { echo: input },
            observation_ref: 'observation:123e4567-e89b-12d3-a456-426614174000',
            metrics: { tokens: 10, latency_ms: 2 },
          };
        },
      };
    },
  };

  it('createHandle 接收 {scope, budget} 上下文并返回绑定契约的 handle', async () => {
    let sawCtx: { scope: string; budget: number } | undefined;
    const p: CapabilityProvider = {
      manifest: echoContract,
      async createHandle(ctx) {
        sawCtx = ctx;
        return {
          contract: echoContract,
          async execute() {
            return { ok: true, metrics: { tokens: 0, latency_ms: 0 } };
          },
        };
      },
    };
    const handle = await p.createHandle({ scope: 'session-1', budget: 100 });
    expect(sawCtx).toEqual({ scope: 'session-1', budget: 100 });
    expect(handle.contract).toBe(echoContract);
  });

  it('execute 成功：ok:true、output/observation_ref 就位、metrics 为数值、无 error', async () => {
    const handle = await provider.createHandle({ scope: 'session-1', budget: 100 });
    const result: CapabilityResult = await handle.execute({ text: 'hi' });
    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ echo: { text: 'hi' } });
    expect(result.observation_ref).toMatch(/^observation:/);
    expect(typeof result.metrics.tokens).toBe('number');
    expect(typeof result.metrics.latency_ms).toBe('number');
    expect(result.error).toBeUndefined();
  });

  it('execute 失败：ok:false、error{code,message,retryable} 就位、无 output', async () => {
    const handle = await provider.createHandle({ scope: 'session-1', budget: 100 });
    const result: CapabilityResult = await handle.execute('fail');
    expect(result.ok).toBe(false);
    expect(result.error).toEqual({ code: 'E_ECHO', message: 'boom', retryable: true });
    expect(result.output).toBeUndefined();
    expect(typeof result.metrics.tokens).toBe('number');
    expect(typeof result.metrics.latency_ms).toBe('number');
  });
});

describe('③ 无 Broker 依赖（防漂移静态断言）', () => {
  it('capability-abi.ts 源码不含 "broker" 字符串', async () => {
    const source = await readFile(ABI_SOURCE, 'utf8');
    expect(source).not.toContain('broker');
  });

  it('import 图仅 node: 内置 / zod / kernel/schemas（同层）', async () => {
    const source = await readFile(ABI_SOURCE, 'utf8');
    const fromMatches = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    const bareMatches = [...source.matchAll(/^import\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    const dynamicMatches = [...source.matchAll(/import\s*\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
    const specifiers = [
      ...new Set([...fromMatches, ...bareMatches, ...dynamicMatches].filter((s): s is string => s !== undefined)),
    ];
    expect(specifiers.length).toBeGreaterThan(0);
    for (const spec of specifiers) {
      const ok = spec.startsWith('node:') || spec === 'zod' || spec.startsWith('./schemas/');
      expect(ok, `非法 import: ${spec}`).toBe(true);
    }
  });
});

describe('④ 可选 cancel（执行边界）', () => {
  it('带 cancel 的 handle：cancel 可调用且生效', async () => {
    let cancelled = false;
    const handle: CapabilityHandle = {
      contract: validContract(),
      async execute() {
        return { ok: true, metrics: { tokens: 0, latency_ms: 0 } };
      },
      async cancel() {
        cancelled = true;
      },
    };
    await handle.cancel?.();
    expect(cancelled).toBe(true);
  });

  it('无 cancel 的 handle 类型合法（cancel 可选），运行时为 undefined', async () => {
    const handle: CapabilityHandle = {
      contract: validContract(),
      async execute() {
        return { ok: true, metrics: { tokens: 0, latency_ms: 0 } };
      },
    };
    expect(handle.cancel).toBeUndefined();
  });
});

describe('⑤ idempotency 两值均可校验', () => {
  it("'idempotent' 通过", () => {
    expect(validateContract(validContract({ idempotency: 'idempotent' })).success).toBe(true);
  });

  it("'not_idempotent' 通过", () => {
    expect(validateContract(validContract({ idempotency: 'not_idempotent' })).success).toBe(true);
  });
});
