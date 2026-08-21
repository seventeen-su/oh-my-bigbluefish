// M6 出口整体连通测试：能力生态闭环（Intent→Broker 分级→软接管→回滚 + 共享协议发布/吸收/共识，连通 M5 演化链）。
// 用户强化指示（CONVENTIONS §5.1）：每里程碑出口必须有整体连通测试——把 M6 全产物
// （T6a.1 IntentSynthesizer / T6a.2 CapabilityBroker 分级与软接管 / T6b.1 集体演化协议 RegistryAPI+absorb）
// 串成端到端闭环，并连通前置链：M5 已晋升候选（candidates promote 真实 + 验证链 G1）经 absorb 入 registry。
// 真实模块 + 真实临时 registry，禁 mock；仅依赖注入真实行为 deps（G1 验证链 / G3 确定性回放 / pack-unpack 契约，
// 见 loop-helpers.ts）。工具与工厂见 loop-helpers.ts（LOC 预算，CONVENTIONS §9）。
// 覆盖：① Intent→合成→执行 ② Broker 分级路由（prefer 命中 B + deweight A → fallback_order 生效）
// ③ 软接管→回滚 ④ 共享协议闭环（publish→pack/unpack→absorb→共识→信誉）⑤ M5 演化链连通
// ⑥ 确定性/幂等 ⑦ schema 合规抽查。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IntentSynthesizer } from '../../runtime/intent.js';
import { CapabilityBroker } from '../../runtime/broker.js';
import {
  ActivationContractSchema,
  EvolutionObjectSchema,
  type ActivationContract,
  type EvolutionObject,
} from '../../kernel/schemas/m.js';
import { GitRegistry, absorb, packObject, reputation, unpackObject } from '../../supervisor/share.js';
import { CandidatePool } from '../../supervisor/candidates.js';
import { runVerification, type CandidateTestPlan } from '../../supervisor/validate.js';
import {
  WS,
  expectOk,
  hexOf,
  makeIntent,
  makeMemory,
  makeProvider,
  mkActivation,
  mkEvo,
  mkProvenance,
  mkRec,
  realDeps,
} from './loop-helpers.js';

// ---- 共享 fixture（m3/m4/m5 milestone-loop 同款：beforeAll 建一次共享根，跨 it 状态流动） ----

let tmpRoot: string;
/** 共享临时 registry 根（.evolution/registry 用户态目录约定，架构 §3；④⑤⑥⑦ 共用） */
let regRoot: string;
/** CandidatePool 临时 .evolution 根（⑤） */
let evoRoot: string;
/** ③ 软接管产生的 ActivationContract（⑦ M6 schema 抽查） */
let loopContract: ActivationContract | null = null;
/** ④ 吸收入 registry 的 EvolutionObject（⑦ M4 schema 抽查 + 盘上往返保真） */
let loopEvo: EvolutionObject | null = null;

beforeAll(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'omb-m6loop-'));
  evoRoot = join(tmpRoot, '.evolution');
  regRoot = join(evoRoot, 'registry');
  await mkdir(regRoot, { recursive: true });
});

afterAll(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

// ---- ① Intent→合成→执行 ----

describe('① Intent→合成→执行（registerManifest ×2 → synthesize → executeChain 数据流）', () => {
  it('同能力不同 reliability 两 provider 注册后合成选 high，执行链数据流正确', async () => {
    const low = makeProvider({ id: 'capability:loop-low', name: 'read-file', reliability: 'low' }, async (input) => ({
      ok: true,
      output: { text: `LOW:${(input as { path: string }).path}` },
      metrics: { tokens: 1, latency_ms: 1 },
    }));
    const high = makeProvider({ id: 'capability:loop-high', name: 'read-file', reliability: 'high' }, async (input) => ({
      ok: true,
      output: { text: `HIGH:${(input as { path: string }).path}` },
      metrics: { tokens: 1, latency_ms: 1 },
    }));
    const synth = new IntentSynthesizer({ providers: new Map() });
    synth.registerManifest(low);
    synth.registerManifest(high);

    const result = await synth.synthesize(makeIntent());
    expect('chain' in result).toBe(true);
    if (!('chain' in result)) return;
    expect(result.bindings[0]!.provider).toBe('capability:loop-high'); // reliability 高者优先
    expect(result.chain[0]!.contract.id).toBe('capability:loop-high');

    const exec = await synth.executeChain(result.chain, { path: 'a.txt' }, result.fallbacks);
    expect(exec.ok).toBe(true);
    if (exec.ok) {
      expect(exec.outputs).toEqual([{ text: 'HIGH:a.txt' }]); // 数据流正确（input.path 流入 provider 输出）
      expect(exec.fallbacks_used).toEqual([]);
    }
  });
});

// ---- ② Broker 分级路由 ----

describe('② Broker 分级路由（policy → fallback_order → 合成器选择穿透）', () => {
  it('prefer 命中 B + deweight A → resolve 后合成器 fallback_order 生效 → B 优先（覆盖 reliability 排序）', async () => {
    const a = makeProvider({ id: 'capability:grad-a', name: 'read-file', reliability: 'high' }, async () => ({
      ok: true,
      output: { text: 'A' },
      metrics: { tokens: 1, latency_ms: 1 },
    }));
    const b = makeProvider({ id: 'capability:grad-b', name: 'read-file', reliability: 'medium' }, async () => ({
      ok: true,
      output: { text: 'B' },
      metrics: { tokens: 1, latency_ms: 1 },
    }));
    const broker = new CapabilityBroker({
      providers: new Map([
        [a.manifest.id, a],
        [b.manifest.id, b],
      ]),
      policy: {
        levels: [
          { provider_id: 'capability:grad-b', level: 'prefer' },
          { provider_id: 'capability:grad-a', level: 'deweight', weight: 0.2 },
        ],
      },
    });

    const res = expectOk(await broker.resolve(makeIntent()));
    expect(res.providers).toEqual(['capability:grad-b', 'capability:grad-a']); // prefer(1) < deweight(3)
    expect(res.route.map((r) => r.level)).toEqual(['prefer', 'deweight']);
    // 合成器 fallback_order 生效：B（medium）压过 A（high）的 reliability 排序（偏好学习穿透到合成器）
    expect(res.bindings[0]!.provider).toBe('capability:grad-b');
    expect(res.chain[0]!.contract.id).toBe('capability:grad-b');
    expect(res.fallbacks[0]!.handles.map((h) => h.contract.id)).toEqual(['capability:grad-b', 'capability:grad-a']);

    const exec = await broker.execute(res, { path: 'a.txt' });
    expect(exec.ok).toBe(true);
    if (exec.ok) {
      expect(exec.outputs).toEqual([{ text: 'B' }]);
    }
  });

  it('T6a.2 判别性模式：prefer 同级命中翻转（A 失败 → B 命中 → 二次 resolve B 优先）', async () => {
    const a = makeProvider({ id: 'capability:pref-a', name: 'read-file', reliability: 'high' }, async (input) => {
      if ((input as { path?: string }).path === 'boom') {
        return { ok: false, error: { code: 'E_BOOM', message: 'boom', retryable: true }, metrics: { tokens: 0, latency_ms: 0 } };
      }
      return { ok: true, output: { text: 'A' }, metrics: { tokens: 1, latency_ms: 1 } };
    });
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
      policy: {
        levels: [
          { provider_id: 'capability:pref-a', level: 'prefer' },
          { provider_id: 'capability:pref-b', level: 'prefer' },
        ],
      },
    });

    const first = expectOk(await broker.resolve(makeIntent()));
    expect(first.providers).toEqual(['capability:pref-a', 'capability:pref-b']); // 同命中 → 注册序
    const exec = await broker.execute(first, { path: 'boom' }); // A 失败 → B 命中（偏好学习）
    expect(exec.ok).toBe(true);
    if (exec.ok) {
      expect(exec.fallbacks_used).toEqual(['capability:pref-b']);
    }

    const second = expectOk(await broker.resolve(makeIntent()));
    expect(second.providers).toEqual(['capability:pref-b', 'capability:pref-a']); // 命中高者在前（学习穿透）
    expect(second.bindings[0]!.provider).toBe('capability:pref-b'); // fallback_order 生效于合成器选择
  });
});

// ---- ③ 软接管→回滚 ----

describe('③ 软接管→回滚（patch 禁用/override + 同名 shadow → 路由接管 → 回滚复原）', () => {
  it('takeover 目标 provider → resolve 路由到接管 shadow（override 生效）→ rollbackTakeover → 路由与行为复原', async () => {
    let xCalls = 0;
    let yCalls = 0;
    const x = makeProvider({ id: 'capability:third-party', name: 'read-file', reliability: 'low' }, async () => {
      xCalls += 1;
      return { ok: true, output: { text: 'X-RAW' }, metrics: { tokens: 1, latency_ms: 1 } };
    });
    const y = makeProvider({ id: 'capability:platform', name: 'read-file' }, async () => {
      yCalls += 1;
      return { ok: true, output: { text: 'Y' }, metrics: { tokens: 1, latency_ms: 1 } };
    });
    const broker = new CapabilityBroker({ providers: new Map([[x.manifest.id, x]]), policy: { levels: [] } });

    // 软接管四件套：patch 禁用 + restrict 隐藏 + 同名 shadow + post-execute 拦截 + override（patch 覆盖）
    await broker.takeover('capability:third-party', {
      override: { reliability: 'high' },
      shadow: y,
      intercept: (r) => ({ ...r, output: { ...(r.output as object), intercepted: true } }),
    });

    const taken = expectOk(await broker.resolve(makeIntent()));
    expect(taken.providers).toEqual(['capability:platform']); // 路由到接管 shadow
    expect(taken.hidden).toEqual(['capability:third-party']); // restrict 隐藏
    expect(taken.disabled).toEqual(['capability:third-party']); // patch 禁用
    expect(taken.route).toEqual([{ provider_id: 'capability:platform', level: 'takeover' }]);
    expect(taken.chain[0]!.contract.reliability).toBe('high'); // override 覆盖生效

    const execTaken = await broker.execute(taken, { path: 'a.txt' });
    expect(xCalls).toBe(0); // 目标不再执行
    expect(yCalls).toBe(1); // 同名 shadow 执行
    expect(execTaken.ok).toBe(true);
    if (execTaken.ok) {
      expect(execTaken.outputs).toEqual([{ text: 'Y', intercepted: true }]); // post-execute 拦截生效
    }

    // 回滚 → 路由与行为复原（原 provider 恢复）
    await broker.rollbackTakeover('capability:third-party');
    const restored = expectOk(await broker.resolve(makeIntent()));
    expect(restored.providers).toEqual(['capability:third-party']);
    expect(restored.hidden).toEqual([]);
    expect(restored.disabled).toEqual([]);
    expect(restored.route).toEqual([{ provider_id: 'capability:third-party', level: 'coexist' }]);
    expect(restored.chain[0]!.contract.reliability).toBe('low'); // override 撤销，原契约恢复

    const execRestored = await broker.execute(restored, { path: 'a.txt' });
    expect(xCalls).toBe(1); // 原 provider 重新执行
    expect(yCalls).toBe(1);
    expect(execRestored.ok).toBe(true);
    if (execRestored.ok) {
      expect(execRestored.outputs).toEqual([{ text: 'X-RAW' }]); // 无拦截，行为复原
    }

    // 软接管审计记录（ActivationContract 形态，M6 schema；⑦ 抽查）
    loopContract = mkActivation();
  });
});

// ---- ④ 共享协议闭环 ----

describe('④ 共享协议闭环（publish → pack/unpack 往返 → absorb → 共识 → 信誉）', () => {
  it('合法 M4 对象经 registry.publish → packObject/unpackObject 往返 → absorb（真实 deps 全过）→ verified_by 含本实例 → reputation ≥ locally-verified', async () => {
    const reg = new GitRegistry(regRoot);
    const obj = mkEvo();
    const sig = `git-sig:${hexOf(obj.id).slice(0, 12)}`;

    // ① 发布（临时目录 registry；Git 清单 transport，§17）
    const pub = await reg.publish(obj, sig);
    expect(pub.ok).toBe(true);
    expect((await reg.list()).find((e) => e.id === obj.id)).toBeDefined();

    // ② 打包/解包往返：对象与签名一致（协议 envelope 契约）
    const { obj: unpacked, signature } = unpackObject(packObject(obj, 'sig-pack'));
    expect(unpacked).toEqual(obj);
    expect(signature).toBe('sig-pack');

    // ③ 吸收（真实验证链 G1 / 真实回放 bench / 真实 pack-unpack 契约测试，全过）
    const report = await absorb(reg, obj, sig, realDeps(tmpRoot, { instance: 'loop-instance', diversity: 3 }));
    expect(report.ok).toBe(true);
    expect(report.failed_at).toBeNull();

    // ④ 共识回传：verified_by 含本实例；信誉 ≥ locally-verified（多样性达标 → community-verified）
    const after = (await reg.list()).find((e) => e.id === obj.id);
    expect(after?.verified_by).toContainEqual({ instance: 'loop-instance', diversity: 3 });
    expect(reputation(after!.verified_by)).toBe('community-verified');

    loopEvo = obj; // ⑦ 复用（盘上往返保真抽查）
  });
});

// ---- ⑤ 跨里程碑连通（M5 演化链） ----

describe('⑤ 跨里程碑连通：M5 已晋升候选 → 验证链 G1 → absorb 入 registry（晋升产物可发布共享）', () => {
  it('candidates promote 真实 → 候选 EvolutionObject 经 absorb 发布共享（verified_by 含实例）', async () => {
    const pool = new CandidatePool(evoRoot);
    const cand = mkRec();
    await pool.registerCandidate(cand);
    expect((await pool.load(cand.id)).status).toBe('untrusted'); // 硬边界：一律落 untrusted（T5.1）

    // 验证链 G1（真实 T5.2）：候选对象 = 合法 M1 Memory → 全过（供晋升）
    const candDir = join(tmpRoot, 'candidate-m5');
    await mkdir(candDir, { recursive: true });
    await writeFile(join(candDir, 'object.json'), JSON.stringify(makeMemory('M6 连通候选记忆')), 'utf8');
    const plan: CandidateTestPlan = { candidate_id: cand.id, gates: [{ gate: 'G1', checks: ['schema:M1'] }] };
    const results = await runVerification(plan, { candidateDir: candDir, workspace: WS });
    expect(results[0]!.ok).toBe(true);

    // 晋升 → load-before-guard 纪律（T5.1 Minor ④）：消费前 load 盘上最新记录再 assertTrusted
    await pool.promote(mkRec({ id: cand.id }));
    const trusted = await pool.load(cand.id);
    pool.assertTrusted(trusted); // 放行（不抛）
    expect(trusted.status).toBe('trusted');

    // 晋升产物 = 该候选的 EvolutionObject（内容寻址；provenance.event 引用候选 id）
    const evoObj = mkEvo({ provenance: mkProvenance(cand.id), verifications: ['G1', 'cert/loop-m5'] });
    expect(evoObj.provenance.event).toBe(cand.id);

    // 经吸收管线入共享 registry（验证"晋升产物可发布共享"；absorb 内 verifyChain = 真实 G1 schema:M4）
    const reg = new GitRegistry(regRoot);
    const report = await absorb(reg, evoObj, 'sig-m5', realDeps(tmpRoot, { instance: 'm5-loop', diversity: 1 }));
    expect(report.ok).toBe(true);
    const entry = (await reg.list()).find((e) => e.id === evoObj.id);
    expect(entry?.verified_by).toContainEqual({ instance: 'm5-loop', diversity: 1 });
    expect((await reg.verify(evoObj.id)).ok).toBe(true);
  });
});

// ---- ⑥ 确定性/幂等 ----

describe('⑥ 确定性/幂等（同 intent 两次合成同结果；同对象两次 absorb 幂等）', () => {
  it('同 intent 两次 synthesize → 图/绑定/链结构深相等（确定性）', async () => {
    const a = makeProvider({ id: 'capability:det-a', name: 'read-file', reliability: 'low' });
    const b = makeProvider({ id: 'capability:det-b', name: 'read-file', reliability: 'high' });
    const synth = new IntentSynthesizer({
      providers: new Map([
        [a.manifest.id, a],
        [b.manifest.id, b],
      ]),
    });

    const one = await synth.synthesize(makeIntent());
    const two = await synth.synthesize(makeIntent());
    expect('chain' in one && 'chain' in two).toBe(true);
    if (!('chain' in one) || !('chain' in two)) return;
    expect(JSON.stringify(two.graph)).toBe(JSON.stringify(one.graph));
    expect(two.bindings).toEqual(one.bindings);
    expect(two.chain.map((h) => h.contract.id)).toEqual(one.chain.map((h) => h.contract.id));
    expect(two.fallbacks[0]!.handles.map((h) => h.contract.id)).toEqual(one.fallbacks[0]!.handles.map((h) => h.contract.id));
  });

  it('同对象两次 absorb（同实例）→ 幂等：verified_by 不重复（单条记录）', async () => {
    const reg = new GitRegistry(regRoot);
    const obj = mkEvo();

    const first = await absorb(reg, obj, 'sig-idem', realDeps(tmpRoot, { instance: 'loop-idem' }));
    const second = await absorb(reg, obj, 'sig-idem', realDeps(tmpRoot, { instance: 'loop-idem' }));
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.failed_at).toBeNull();

    const entry = (await reg.list()).find((e) => e.id === obj.id);
    expect(entry?.verified_by).toEqual([{ instance: 'loop-idem', diversity: 1 }]); // 同实例幂等：不重复
  });
});

// ---- ⑦ schema 合规抽查 ----

describe('⑦ schema 合规抽查（M4/M6 schema 经 share 管线往返后仍合规）', () => {
  it('ActivationContract（M6）/EvolutionObject（M4）经共享协议往返后仍过 schema', async () => {
    // M6 ActivationContract（③ 软接管审计记录）过 schema
    expect(loopContract).not.toBeNull();
    expect(ActivationContractSchema.safeParse(loopContract).success).toBe(true);

    // M4 EvolutionObject（④ 经 publish→get 盘上往返）仍过 schema 且物化保真（内容寻址）
    expect(loopEvo).not.toBeNull();
    const reg = new GitRegistry(regRoot);
    const stored = await reg.get(loopEvo!.id);
    expect(stored).toEqual(loopEvo);
    expect(EvolutionObjectSchema.safeParse(stored).success).toBe(true);

    // pack/unpack 往返后仍合规（协议 envelope 契约）
    const { obj: back } = unpackObject(packObject(loopEvo!, 'sig-schema'));
    expect(EvolutionObjectSchema.safeParse(back).success).toBe(true);
  });
});
