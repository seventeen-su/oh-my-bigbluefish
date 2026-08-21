// T6a.1 行为测试：Intent ABI 与能力合成（runtime/intent.ts，架构 §8.1）。
// 八类（brief）+ 补充：① 合法 intent 合成（默认 fixed plan 单节点链 + graph 结构）
// ② 非法 intent（effects 枚举非法 / 缺 verb）→ error.invalid_intent
// ③ 契约匹配过滤（authority_scope 不兼容不选；链边 input/output 结构兼容不兼容不选）
// ④ Provider Selection（reliability 高者优先；policy.fallback_order 覆盖）
// ⑤ 降级链（首选失败 → fallback 被调 + fallbacks_used 记录；全部失败 → 整链 error + negative_pattern 占位）
// ⑥ 多节点图（分解 intent：链顺序执行、数据传递）
// ⑦ fixed plan 默认（无自定义 graphPlan → 默认单节点匹配）
// ⑧ 执行成功（outputs 正确返回）＋ ⑨ registerManifest。
// 评审修复（T6a.1 review，2 项 Important）：⑩ createHandle 部分失败 → bindings/selectedByNode
// 与实际绑定 provider 一致（首位抛错、次位成功；下节点兼容基于实际绑定 output）；
// ② 补充 required_verification:'' / 缺 constraints → invalid_intent（与 canonical P4 一致）。
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  IntentSynthesizer,
  defaultGraphPlan,
  type CapabilityGraph,
  type Intent,
  type SynthesisResult,
} from '../../runtime/intent.js';
import type { CapabilityContract, CapabilityProvider, CapabilityResult } from '../../kernel/capability-abi.js';

// ---- 测试工具 ----

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

function expectSuccess(result: SynthesisResult) {
  expect('chain' in result).toBe(true);
  return result as Extract<SynthesisResult, { chain: unknown }>;
}

// ---- ① 合法 intent 合成 ----

describe('① 合法 intent 合成（默认 fixed plan）', () => {
  it('verb=read object=file → 单节点链 + graph 结构正确', async () => {
    const provider = makeProvider({ id: 'capability:read-1', name: 'read-file' });
    const synth = new IntentSynthesizer({ providers: new Map([[provider.manifest.id, provider]]) });

    const result = await synth.synthesize(makeIntent());

    const ok = expectSuccess(result);
    expect(ok.chain).toHaveLength(1);
    expect(ok.chain[0]!.contract.name).toBe('read-file');
    expect(ok.graph).toEqual({ nodes: ['read-file'], edges: [], entry: 'read-file', exit: 'read-file' });
    expect(ok.bindings).toEqual([{ node: 'read-file', provider: 'capability:read-1' }]);
    expect(ok.fallbacks).toHaveLength(1);
  });
});

// ---- ② 非法 intent ----

describe('② 非法 intent → error.invalid_intent', () => {
  it('effects 枚举非法', async () => {
    const synth = new IntentSynthesizer({ providers: new Map() });
    const result = await synth.synthesize({ ...makeIntent(), effects: 'write' });

    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error.code).toBe('invalid_intent');
    }
  });

  it('缺 verb', async () => {
    const synth = new IntentSynthesizer({ providers: new Map() });
    const bad = { object: 'file', scope: 'user', effects: 'read_only', constraints: [], required_verification: 'v:1' };
    const result = await synth.synthesize(bad);

    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error.code).toBe('invalid_intent');
    }
  });

  // 评审修复（Important）：runtime IntentSchema 不得放宽 canonical P4（kernel/schemas/p.ts）——
  // required_verification 为 min(1) 必填、constraints 必填，与 IR 层一致。
  it('required_verification 为空字符串 → invalid_intent（与 canonical P4 一致）', async () => {
    const provider = makeProvider({ id: 'capability:rv-1', name: 'read-file' });
    const synth = new IntentSynthesizer({ providers: new Map([[provider.manifest.id, provider]]) });

    const result = await synth.synthesize({ ...makeIntent(), required_verification: '' });

    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error.code).toBe('invalid_intent');
    }
  });

  it('缺 constraints → invalid_intent（与 canonical P4 一致）', async () => {
    const provider = makeProvider({ id: 'capability:ct-1', name: 'read-file' });
    const synth = new IntentSynthesizer({ providers: new Map([[provider.manifest.id, provider]]) });

    const bad = { verb: 'read', object: 'file', scope: 'user', effects: 'read_only', required_verification: 'v:1' };
    const result = await synth.synthesize(bad);

    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error.code).toBe('invalid_intent');
    }
  });
});

// ---- ③ 契约匹配过滤 ----

describe('③ 契约匹配过滤', () => {
  it('authority_scope 不兼容（user intent 不能调 kernel 能力）→ 不选', async () => {
    const kernelP = makeProvider({ id: 'capability:kernel-1', name: 'read-file', authority_scope: 'kernel' });
    const userP = makeProvider({ id: 'capability:user-1', name: 'read-file', authority_scope: 'user' });
    const synth = new IntentSynthesizer({
      providers: new Map([
        [kernelP.manifest.id, kernelP],
        [userP.manifest.id, userP],
      ]),
    });

    const result = await synth.synthesize(makeIntent({ scope: 'user' }));

    const ok = expectSuccess(result);
    expect(ok.chain).toHaveLength(1);
    expect(ok.bindings[0]!.provider).toBe('capability:user-1');
  });

  it('input 不兼容的 provider 不被选（链边 output→input 结构兼容）', async () => {
    const graphPlan = (): CapabilityGraph => ({
      nodes: ['read', 'summarize'],
      edges: [['read', 'summarize']],
      entry: 'read',
      exit: 'summarize',
    });
    const readP = makeProvider({
      id: 'capability:read',
      name: 'read',
      input: z.object({ path: z.string() }),
      output: z.object({ text: z.string() }),
    });
    const sumOk = makeProvider({
      id: 'capability:sum-ok',
      name: 'summarize',
      input: z.object({ text: z.string() }),
      output: z.object({ summary: z.string() }),
    });
    const sumBad = makeProvider({
      id: 'capability:sum-bad',
      name: 'summarize',
      input: z.object({ content: z.string() }),
      output: z.object({ summary: z.string() }),
    });
    const synth = new IntentSynthesizer({
      providers: new Map([
        [readP.manifest.id, readP],
        [sumOk.manifest.id, sumOk],
        [sumBad.manifest.id, sumBad],
      ]),
      graphPlan,
    });

    const result = await synth.synthesize(makeIntent({ verb: 'analyze', object: 'doc' }));

    const ok = expectSuccess(result);
    expect(ok.bindings).toEqual([
      { node: 'read', provider: 'capability:read' },
      { node: 'summarize', provider: 'capability:sum-ok' },
    ]);
  });
});

// ---- ④ Provider Selection ----

describe('④ Provider Selection', () => {
  it('reliability 高者优先（两个 provider 同能力）', async () => {
    const lowP = makeProvider({ id: 'capability:low-1', name: 'read-file', reliability: 'low' });
    const highP = makeProvider({ id: 'capability:high-1', name: 'read-file', reliability: 'high' });
    const synth = new IntentSynthesizer({
      providers: new Map([
        [lowP.manifest.id, lowP],
        [highP.manifest.id, highP],
      ]),
    });

    const result = await synth.synthesize(makeIntent());

    const ok = expectSuccess(result);
    expect(ok.bindings[0]!.provider).toBe('capability:high-1');
    expect(ok.fallbacks[0]!.handles.map((h) => h.contract.id)).toEqual(['capability:high-1', 'capability:low-1']);
  });

  it('policy.fallback_order 覆盖 reliability 排序', async () => {
    const lowP = makeProvider({ id: 'capability:low-2', name: 'read-file', reliability: 'low' });
    const highP = makeProvider({ id: 'capability:high-2', name: 'read-file', reliability: 'high' });
    const synth = new IntentSynthesizer({
      providers: new Map([
        [lowP.manifest.id, lowP],
        [highP.manifest.id, highP],
      ]),
      policy: { fallback_order: ['capability:low-2'] },
    });

    const result = await synth.synthesize(makeIntent());

    const ok = expectSuccess(result);
    expect(ok.bindings[0]!.provider).toBe('capability:low-2');
  });
});

// ---- ⑤ 降级链 ----

describe('⑤ 降级链（Failure Fallback）', () => {
  it('首选 provider 失败 → fallback provider 被调（fallbacks_used 记录）', async () => {
    let fallbackCalls = 0;
    const primary = makeProvider(
      { id: 'capability:primary-1', name: 'read-file', reliability: 'high' },
      async (input) => {
        if ((input as { path?: string }).path === 'boom') {
          return { ok: false, error: { code: 'E_READ', message: 'boom', retryable: true }, metrics: { tokens: 0, latency_ms: 0 } };
        }
        return { ok: true, output: { text: 'primary' }, metrics: { tokens: 1, latency_ms: 1 } };
      },
    );
    const fallback = makeProvider(
      { id: 'capability:fallback-1', name: 'read-file', reliability: 'medium' },
      async () => {
        fallbackCalls += 1;
        return { ok: true, output: { text: 'fallback' }, metrics: { tokens: 1, latency_ms: 1 } };
      },
    );
    const synth = new IntentSynthesizer({
      providers: new Map([
        [primary.manifest.id, primary],
        [fallback.manifest.id, fallback],
      ]),
    });

    const result = await synth.synthesize(makeIntent());
    const ok = expectSuccess(result);
    const exec = await synth.executeChain(ok.chain, { path: 'boom' }, ok.fallbacks);

    expect(exec.ok).toBe(true);
    if (exec.ok) {
      expect(exec.outputs).toEqual([{ text: 'fallback' }]);
      expect(exec.fallbacks_used).toEqual(['capability:fallback-1']);
    }
    expect(fallbackCalls).toBe(1);
  });

  it('全部失败 → 整链 error（negative_pattern 占位）', async () => {
    const failP = (id: string) =>
      makeProvider({ id, name: 'read-file', reliability: 'medium' }, async () => ({
        ok: false,
        error: { code: 'E_READ', message: 'boom', retryable: false },
        metrics: { tokens: 0, latency_ms: 0 },
      }));
    const p1 = failP('capability:fail-1');
    const p2 = failP('capability:fail-2');
    const synth = new IntentSynthesizer({
      providers: new Map([
        [p1.manifest.id, p1],
        [p2.manifest.id, p2],
      ]),
    });

    const result = await synth.synthesize(makeIntent());
    const ok = expectSuccess(result);
    const exec = await synth.executeChain(ok.chain, { path: 'x' }, ok.fallbacks);

    expect(exec.ok).toBe(false);
    if (!exec.ok) {
      expect(exec.error.code).toBe('chain_failed');
      expect(exec.error.node).toBe('read-file');
      expect(exec.error.negative_pattern).toMatch(/^negative-pattern:/);
    }
  });
});

// ---- ⑥ 多节点图（分解 intent） ----

describe('⑥ 多节点图（分解 intent）', () => {
  it('链顺序执行 + 数据传递（前节点输出 → 后节点输入）', async () => {
    const graphPlan = (): CapabilityGraph => ({
      nodes: ['read', 'summarize'],
      edges: [['read', 'summarize']],
      entry: 'read',
      exit: 'summarize',
    });
    let summarizeInput: unknown;
    const readP = makeProvider(
      {
        id: 'capability:read',
        name: 'read',
        input: z.object({ path: z.string() }),
        output: z.object({ text: z.string() }),
      },
      async (input) => ({
        ok: true,
        output: { text: `content:${(input as { path: string }).path}` },
        metrics: { tokens: 1, latency_ms: 1 },
      }),
    );
    const sumP = makeProvider(
      {
        id: 'capability:sum',
        name: 'summarize',
        input: z.object({ text: z.string() }),
        output: z.object({ summary: z.string() }),
      },
      async (input) => {
        summarizeInput = input;
        return { ok: true, output: { summary: `sum:${(input as { text: string }).text}` }, metrics: { tokens: 1, latency_ms: 1 } };
      },
    );
    const synth = new IntentSynthesizer({
      providers: new Map([
        [readP.manifest.id, readP],
        [sumP.manifest.id, sumP],
      ]),
      graphPlan,
    });

    const result = await synth.synthesize(makeIntent({ verb: 'analyze', object: 'doc' }));
    const ok = expectSuccess(result);
    expect(ok.graph).toEqual({ nodes: ['read', 'summarize'], edges: [['read', 'summarize']], entry: 'read', exit: 'summarize' });

    const exec = await synth.executeChain(ok.chain, { path: 'a.md' }, ok.fallbacks);

    expect(exec.ok).toBe(true);
    if (exec.ok) {
      expect(exec.outputs).toEqual([{ text: 'content:a.md' }, { summary: 'sum:content:a.md' }]);
    }
    expect(summarizeInput).toEqual({ text: 'content:a.md' });
  });
});

// ---- ⑦ fixed plan 默认 ----

describe('⑦ fixed plan 默认', () => {
  it('无自定义 graphPlan → 默认单节点匹配', async () => {
    const provider = makeProvider({ id: 'capability:read-7', name: 'read-file' });
    const synth = new IntentSynthesizer({ providers: new Map([[provider.manifest.id, provider]]) });

    const result = await synth.synthesize(makeIntent());

    const ok = expectSuccess(result);
    expect(ok.graph).toEqual({ nodes: ['read-file'], edges: [], entry: 'read-file', exit: 'read-file' });
    expect(ok.chain).toHaveLength(1);
    expect(defaultGraphPlan(makeIntent())).toEqual({ nodes: ['read-file'], edges: [], entry: 'read-file', exit: 'read-file' });
  });
});

// ---- ⑧ 执行成功 ----

describe('⑧ 执行成功', () => {
  it('outputs 正确返回、fallbacks_used 为空', async () => {
    const provider = makeProvider({ id: 'capability:read-8', name: 'read-file' }, async () => ({
      ok: true,
      output: { text: 'hello' },
      metrics: { tokens: 2, latency_ms: 3 },
    }));
    const synth = new IntentSynthesizer({ providers: new Map([[provider.manifest.id, provider]]) });

    const result = await synth.synthesize(makeIntent());
    const ok = expectSuccess(result);
    const exec = await synth.executeChain(ok.chain, { path: 'a.txt' });

    expect(exec.ok).toBe(true);
    if (exec.ok) {
      expect(exec.outputs).toEqual([{ text: 'hello' }]);
      expect(exec.fallbacks_used).toEqual([]);
    }
  });
});

// ---- ⑨ manifest 注册 ----

describe('⑨ manifest 注册（registerManifest）', () => {
  it('注册后可被合成匹配', async () => {
    const synth = new IntentSynthesizer({ providers: new Map() });
    synth.registerManifest(makeProvider({ id: 'capability:reg-1', name: 'read-file' }));

    const result = await synth.synthesize(makeIntent());

    const ok = expectSuccess(result);
    expect(ok.bindings[0]!.provider).toBe('capability:reg-1');
  });

  it('非法 manifest 拒绝注册', () => {
    const synth = new IntentSynthesizer({ providers: new Map() });
    const bad = makeProvider({ id: 'capability:bad-1', name: 'read-file' });
    delete (bad.manifest as Partial<CapabilityContract>).input;

    expect(() => synth.registerManifest(bad)).toThrow();
  });
});

// ---- ⑩ createHandle 部分失败：bindings/selectedByNode 与实际绑定 provider 一致 ----

describe('⑩ createHandle 部分失败 → bindings/selectedByNode 与实际绑定 provider 一致', () => {
  it('首位 provider createHandle 抛错、次位成功 → 合成成功且 bindings[0].provider 为次位 id', async () => {
    const failing = makeProvider({ id: 'capability:bind-fail', name: 'read-file', reliability: 'high' });
    failing.createHandle = async () => {
      throw new Error('createHandle failed');
    };
    const okP = makeProvider({ id: 'capability:bind-ok', name: 'read-file', reliability: 'medium' });
    const synth = new IntentSynthesizer({
      providers: new Map([
        [failing.manifest.id, failing],
        [okP.manifest.id, okP],
      ]),
    });

    const result = await synth.synthesize(makeIntent());

    const ok = expectSuccess(result);
    expect(ok.chain).toHaveLength(1);
    expect(ok.chain[0]!.contract.id).toBe('capability:bind-ok');
    expect(ok.bindings).toEqual([{ node: 'read-file', provider: 'capability:bind-ok' }]);
    expect(ok.fallbacks[0]!.handles.map((h) => h.contract.id)).toEqual(['capability:bind-ok']);
  });

  it('createHandle 部分失败 → 下节点兼容检查基于实际绑定 provider 的 output', async () => {
    const graphPlan = (): CapabilityGraph => ({
      nodes: ['read', 'summarize'],
      edges: [['read', 'summarize']],
      entry: 'read',
      exit: 'summarize',
    });
    // 'read' 节点：首位（high）createHandle 抛错且 output 与 summarize 不兼容；次位（medium）成功且 output {text}
    const readFail = makeProvider({
      id: 'capability:read-fail',
      name: 'read',
      reliability: 'high',
      input: z.object({ path: z.string() }),
      output: z.object({ raw: z.string() }),
    });
    readFail.createHandle = async () => {
      throw new Error('createHandle failed');
    };
    const readOk = makeProvider({
      id: 'capability:read-ok',
      name: 'read',
      reliability: 'medium',
      input: z.object({ path: z.string() }),
      output: z.object({ text: z.string() }),
    });
    const sumP = makeProvider({
      id: 'capability:sum',
      name: 'summarize',
      input: z.object({ text: z.string() }),
      output: z.object({ summary: z.string() }),
    });
    const synth = new IntentSynthesizer({
      providers: new Map([
        [readFail.manifest.id, readFail],
        [readOk.manifest.id, readOk],
        [sumP.manifest.id, sumP],
      ]),
      graphPlan,
    });

    const result = await synth.synthesize(makeIntent({ verb: 'analyze', object: 'doc' }));

    const ok = expectSuccess(result);
    expect(ok.bindings).toEqual([
      { node: 'read', provider: 'capability:read-ok' },
      { node: 'summarize', provider: 'capability:sum' },
    ]);
  });
});

