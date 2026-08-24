// R8 行为测试：共享配置（evolve.policy share 段）+ /evolve share | /evolve absorb 显式命令
// （runtime/plugin.ts + runtime/assembly.ts；架构 §13 共享与集体演化——生产默认不自动发布/吸收，隐私原则）。
// 覆盖：
//   ① share 配置 schema：缺省（旧形状向后兼容）→ share 默认 {false,false}；显式合法值解析；非法值 fail-loud；
//      真实 evolve.yaml 过 schema（生产默认不自动发布/吸收）
//   ② /evolve share：注册面（hint/description）；无演化对象（链空）→ 明确文本；trusted-latest 缺失 → 明确文本；
//      有演化对象（fixture 推进 trusted-latest + .evolution-objects/，取链头最近对象）→ 发布成功（本地 registry
//      fixture）→ 返回对象 id；非机制来源对象 → 发布拒绝（隐私原则）
//   ③ /evolve absorb：参数缺失 → 帮助文本；registry 有对象 → 吸收成功（本地验证 + absorb 管线 + 共识回传）；
//      不存在 id → 吸收失败文本；registry_dir 配置解析（相对演化工作区根）
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GIT, buildLayoutFixture, runGit, teardownLayoutFixture, type LayoutFixture } from '../helpers/git.js';
import { canonicalJson, makeImmutableId } from '../../kernel/schemas/base.js';
import { DEFAULT_SHARE_POLICY, EvolvePolicySchema, loadPolicy, SharePolicySchema } from '../../kernel/policy-loader.js';
import type { EvolutionObject } from '../../kernel/schemas/m.js';
import { GitRegistry } from '../../supervisor/share.js';
import { apply, type ContextLike } from '../../runtime/plugin.js';
import { createCognitiveRuntime, type CognitiveRuntime } from '../../runtime/assembly.js';

const REPO_POLICY_DIR = fileURLToPath(new URL('../../kernel/policy', import.meta.url));
const REPO_PROCESSES_DIR = fileURLToPath(new URL('../../kernel/processes', import.meta.url));
const SESSION = 'sess-share-1';

/** EvolutionObject id 的 64hex 部分（registry objects/<hex>.json / .evolution-objects/<hex>.json 文件名） */
const hexOf = (id: string): string => id.slice('sha256:'.length);

/** 合法格式签名工厂（git:<signer>:<keyid-hex>:<base64>） */
function mkSig(seed: string): string {
  const keyid = seed.replace(/[^0-9a-f]/gi, '').padEnd(16, '0').slice(0, 16);
  return `git:omb:${keyid}:${Buffer.from(seed, 'utf8').toString('base64')}`;
}

let seq = 0;

/** 确定性机制级 EvolutionObject 工厂（provenance.source='evolution/generator'——机制来源，隐私原则放行） */
function mkEvo(over: Partial<Omit<EvolutionObject, 'id'>> = {}): EvolutionObject {
  const ts = '2026-08-24T00:00:00.000Z';
  const body: Omit<EvolutionObject, 'id'> = {
    ir_version: '2.0',
    schema: 'omb/M4',
    scope: 'Project',
    lifecycle: 'active',
    immutable: true,
    owner: 'kernel',
    created: ts,
    updated: ts,
    provenance: {
      source: 'evolution/generator',
      event: `evolution/r8-${seq}`,
      actor: 'omb-v2',
      environment: { os: 'win32', node: 'v24', dsh_version: '0.1.1-rc.1', project: 'omb-v2' },
      runtime_snapshot: 'rs:snapshot-001',
      timestamp: ts,
      transformation_chain: ['evolution/generator', 'candidate-validation', 'promote'],
      verification: 'G1+G3',
    },
    refs: [],
    protocol_version: 'omb/M4',
    parent: null,
    diff: `diff --git a/kernel/policy/evolve.yaml b/kernel/policy/evolve.yaml\n+signal_triggers.corrections.strength: 0.91 # r8-${seq}`,
    compat: 'policy/v1',
    bench: 'bench/frozen-001',
    spdx: 'MIT',
    verifications: ['G1', 'G3'],
    ...over,
  };
  seq += 1;
  return { ...body, id: makeImmutableId(canonicalJson(body)) };
}

/** 把 Evolution Object 提交进 fixture 的 trusted-latest（临时 worktree + update-ref；仅测试临时 fixture 写）。
 *  git 命令以 cwd=tmp 运行（走 worktree 自身 .git 链接——HEAD/index 属于该 worktree；对齐
 *  promoteDataCandidate 的 worktree 提交流程；禁止 --git-dir 覆写——会指向 bare 的 HEAD/index 造成串树） */
async function commitEvolutionObject(fx: LayoutFixture, obj: EvolutionObject, baseCommit: string): Promise<string> {
  const tmp = join(fx.root, `_tmp-commit-${hexOf(obj.id).slice(0, 8)}`);
  runGit(['worktree', 'add', '--detach', tmp, baseCommit], { cwd: fx.bare });
  const rel = join(tmp, '.evolution-objects', `${hexOf(obj.id)}.json`);
  await mkdir(join(tmp, '.evolution-objects'), { recursive: true });
  await writeFile(rel, JSON.stringify(obj, null, 2), 'utf8');
  runGit(['add', '.'], { cwd: tmp });
  runGit(['-c', 'user.name=OMB', '-c', 'user.email=omb@local', 'commit', '-m', `test: evolution object ${obj.id.slice(0, 8)}`], { cwd: tmp });
  const hash = runGit(['rev-parse', 'HEAD'], { cwd: tmp });
  runGit(['update-ref', 'refs/heads/trusted-latest', hash], { cwd: fx.bare });
  runGit(['worktree', 'remove', '--force', tmp], { cwd: fx.bare });
  return hash;
}

interface CapturedCommand {
  name: string;
  description: string;
  input?: { hint?: string };
  recordInput?: boolean;
  handler: (invocation: {
    commandId: unknown;
    agent: { session?: { id?: string; events?: ReadonlyArray<{ type?: string }> } };
    rawInput: string;
    signal: unknown;
  }) => Promise<{ kind: 'success' | 'error'; text: string }>;
}

function makeInvocation(rawInput: string, sessionId?: string): Parameters<CapturedCommand['handler']>[0] {
  return { commandId: 'test-cmd', agent: { session: { id: sessionId, events: [] } }, rawInput, signal: undefined };
}

function makeFakeCtx(opts: { runtime?: CognitiveRuntime }): { captured: CapturedCommand[]; ctx: ContextLike } {
  const captured: CapturedCommand[] = [];
  const ctx: ContextLike = {
    commands: {
      register: (def: unknown) => {
        captured.push(def as CapturedCommand);
      },
    },
    cognitive: opts.runtime,
  };
  return { captured, ctx };
}

let base: string;
let runtimes: CognitiveRuntime[];
let fixtures: LayoutFixture[];

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'omb-share-'));
  seq = 0;
  runtimes = [];
  fixtures = [];
});

afterEach(async () => {
  for (const rt of runtimes) {
    await rt.close();
  }
  runtimes = [];
  for (const fx of fixtures) {
    teardownLayoutFixture(fx);
  }
  fixtures = [];
  await rm(base, { recursive: true, force: true });
});

function track(rt: CognitiveRuntime): CognitiveRuntime {
  runtimes.push(rt);
  return rt;
}

/** 布局 fixture + 认知运行时（注入 fixture 布局——独立于真实仓库；显式 policy/processes 目录跳过 lines 物化） */
function makeRuntime(fx: LayoutFixture, opts: { policyDir?: string } = {}): CognitiveRuntime {
  const rt = createCognitiveRuntime({
    root: join(fx.root, 'workspace', '.omb'),
    layout: { bareRepo: fx.bare, stableWorktree: fx.stable, latestWorktree: fx.latest, gitBin: GIT },
    policyDir: opts.policyDir ?? REPO_POLICY_DIR,
    processesDir: REPO_PROCESSES_DIR,
  });
  return track(rt);
}

/** 运行时解析出的 registry 目录（缺省 <evolutionRoot>/registry = workspace/.omb/.evolution/registry） */
function registryDirOf(fx: LayoutFixture, sub?: string): string {
  return join(fx.root, 'workspace', '.omb', '.evolution', sub ?? 'registry');
}

// ---- ① share 配置 schema（缺省/显式/非法；生产默认不自动发布/吸收） ----

describe('① evolve.policy share 段 schema（R8 共享配置）', () => {
  it('缺省（旧形状仅 §9.5 三字段向后兼容）→ share 默认 publish_mechanism_objects=false / auto_discover=false', () => {
    const r = EvolvePolicySchema.safeParse({ daily_evolution_cost: 100, roi_min: 1.0, maintenance_rate: 0.5 });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.share).toEqual({ publish_mechanism_objects: false, auto_discover: false });
    }
  });

  it('share 段显式合法值解析（registry_dir 可选；布尔开关可显式开启——未来自动路径）', () => {
    const r = EvolvePolicySchema.safeParse({
      daily_evolution_cost: 100,
      roi_min: 1.0,
      maintenance_rate: 0.5,
      share: { publish_mechanism_objects: true, auto_discover: true, registry_dir: '.evolution/registry' },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.share).toEqual({
        publish_mechanism_objects: true,
        auto_discover: true,
        registry_dir: '.evolution/registry',
      });
    }
  });

  it('share 段非法值 fail-loud：publish_mechanism_objects 非布尔 / auto_discover 非布尔 / registry_dir 空串', () => {
    expect(
      EvolvePolicySchema.safeParse({
        daily_evolution_cost: 100,
        roi_min: 1.0,
        maintenance_rate: 0.5,
        share: { publish_mechanism_objects: 'yes' },
      }).success,
    ).toBe(false);
    expect(
      EvolvePolicySchema.safeParse({
        daily_evolution_cost: 100,
        roi_min: 1.0,
        maintenance_rate: 0.5,
        share: { auto_discover: 1 },
      }).success,
    ).toBe(false);
    expect(
      EvolvePolicySchema.safeParse({
        daily_evolution_cost: 100,
        roi_min: 1.0,
        maintenance_rate: 0.5,
        share: { registry_dir: '' },
      }).success,
    ).toBe(false);
    // 合法布尔组合放行
    expect(
      EvolvePolicySchema.safeParse({
        daily_evolution_cost: 100,
        roi_min: 1.0,
        maintenance_rate: 0.5,
        share: { publish_mechanism_objects: true, auto_discover: false },
      }).success,
    ).toBe(true);
  });

  it('真实 evolve.yaml 过 schema：policy.evolve.share 默认 { false, false }（生产不自动发布/吸收）；DEFAULT_SHARE_POLICY 同源', async () => {
    const p = await loadPolicy(REPO_POLICY_DIR);
    expect(p.evolve.share).toEqual({ publish_mechanism_objects: false, auto_discover: false });
    expect(DEFAULT_SHARE_POLICY).toEqual({ publish_mechanism_objects: false, auto_discover: false });
    expect(SharePolicySchema.safeParse({ publish_mechanism_objects: false, auto_discover: false }).success).toBe(true);
  });
});

// ---- ② /evolve share（发布机制级 Evolution Object） ----

describe('② /evolve share（trusted-latest 演化链头 → 本地 registry；隐私原则）', () => {
  it('注册面：name=evolve；hint 含 share；description 含共享', () => {
    const fx = buildLayoutFixture();
    fixtures.push(fx);
    const { captured, ctx } = makeFakeCtx({});
    apply(ctx, { bootstrap: false });
    const cmd = captured.find((c) => c.name === 'evolve')!;
    expect(cmd).toBeDefined();
    expect(cmd.input?.hint).toContain('share');
    expect(cmd.description).toMatch(/共享|share/i);
  }, 30000);

  it('无演化对象（trusted-latest 演化链空）→ 明确文本（不崩）', async () => {
    const fx = buildLayoutFixture();
    fixtures.push(fx);
    const runtime = makeRuntime(fx);
    const { captured, ctx } = makeFakeCtx({ runtime });
    apply(ctx, { bootstrap: false });
    const r = await captured.find((c) => c.name === 'evolve')!.handler(makeInvocation('share', SESSION));
    expect(r.kind).toBe('error');
    expect(r.text).toContain('无演化对象可发布');
  }, 30000);

  it('trusted-latest 缺失（旧布局）→ 明确 error 文本（不崩）', async () => {
    const fx = buildLayoutFixture();
    fixtures.push(fx);
    runGit(['branch', '-D', 'trusted-latest'], { cwd: fx.bare });
    const runtime = makeRuntime(fx);
    const { captured, ctx } = makeFakeCtx({ runtime });
    apply(ctx, { bootstrap: false });
    const r = await captured.find((c) => c.name === 'evolve')!.handler(makeInvocation('share', SESSION));
    expect(r.kind).toBe('error');
    expect(r.text).toMatch(/发布失败|trusted-latest/);
  }, 30000);

  it('有演化对象（fixture 推进 trusted-latest + .evolution-objects/）→ 发布成功（本地 registry fixture）→ 返回对象 id；取演化链最近对象（链头）', async () => {
    const fx = buildLayoutFixture();
    fixtures.push(fx);
    // 链：obj1（parent=null）→ obj2（parent=obj1.id）；链头 = obj2（最近对象）
    const obj1 = mkEvo();
    const c1 = await commitEvolutionObject(fx, obj1, fx.latestHash);
    const obj2 = mkEvo({ parent: obj1.id });
    await commitEvolutionObject(fx, obj2, c1);

    const runtime = makeRuntime(fx);
    const { captured, ctx } = makeFakeCtx({ runtime });
    apply(ctx, { bootstrap: false });
    const r = await captured.find((c) => c.name === 'evolve')!.handler(makeInvocation('share', SESSION));
    expect(r.kind).toBe('success');
    expect(r.text).toContain(obj2.id.slice(0, 16)); // 返回对象 id（链头 = 最近对象）
    expect(r.text).toContain('机制数据已共享');
    // registry 落盘：manifest 有记录 + objects/<hex>.json 存在（内容寻址）
    const reg = new GitRegistry(registryDirOf(fx));
    await reg.init();
    const entries = await reg.list();
    expect(entries.map((e) => e.id)).toContain(obj2.id);
    expect(entries.find((e) => e.id === obj2.id)?.parent).toBe(obj1.id);
    const onDisk = JSON.parse(await readFile(join(registryDirOf(fx), 'objects', `${hexOf(obj2.id)}.json`), 'utf8'));
    expect((onDisk as EvolutionObject).id).toBe(obj2.id);
    // 事件入链：evolution/shared（通配段，EventSchema 合法）
    const { events } = await runtime.eventStore.query({ session_id: SESSION });
    const shared = events.find((e) => e.type === 'evolution/shared');
    expect(shared).toBeDefined();
    expect((shared!.payload as Record<string, unknown>).object_id).toBe(obj2.id);
  }, 30000);

  it('非机制来源对象（memory/session 等）→ 发布拒绝（隐私原则：不发布私人记忆/会话内容）', async () => {
    const fx = buildLayoutFixture();
    fixtures.push(fx);
    const obj = mkEvo({
      provenance: {
        source: 'memory/session',
        event: 'memory/admitted',
        actor: 'memory',
        environment: { os: 'win32', node: 'v24', dsh_version: '0.1.1-rc.1', project: 'omb-v2' },
        runtime_snapshot: 'rs:snapshot',
        timestamp: '2026-08-24T00:00:00.000Z',
        transformation_chain: ['memory/admission'],
        verification: 'v',
      },
    });
    await commitEvolutionObject(fx, obj, fx.latestHash);

    const runtime = makeRuntime(fx);
    const { captured, ctx } = makeFakeCtx({ runtime });
    apply(ctx, { bootstrap: false });
    const r = await captured.find((c) => c.name === 'evolve')!.handler(makeInvocation('share', SESSION));
    expect(r.kind).toBe('error');
    expect(r.text).toContain('隐私原则');
    // registry 未被写入（拒绝发布）
    const reg = new GitRegistry(registryDirOf(fx));
    await reg.init();
    expect((await reg.list()).map((e) => e.id)).not.toContain(obj.id);
  }, 30000);
});

// ---- ③ /evolve absorb（显式吸收：本地验证 + absorb 管线 + 共识回传） ----

describe('③ /evolve absorb <id>（registry 显式吸收）', () => {
  it('参数缺失 → 帮助文本（不崩）', async () => {
    const fx = buildLayoutFixture();
    fixtures.push(fx);
    const runtime = makeRuntime(fx);
    const { captured, ctx } = makeFakeCtx({ runtime });
    apply(ctx, { bootstrap: false });
    const r = await captured.find((c) => c.name === 'evolve')!.handler(makeInvocation('absorb', SESSION));
    expect(r.kind).toBe('error');
    expect(r.text).toContain('需要对象 id');
  }, 30000);

  it('registry 有对象（机制来源）→ 吸收成功：本地验证 + absorb 管线（signature_hash→schema→verify_chain→replay_bench→contract_tests→publish→consensus）', async () => {
    const fx = buildLayoutFixture();
    fixtures.push(fx);
    const obj = mkEvo();
    // registry fixture 预发布（本地 registry 写）
    const reg = new GitRegistry(registryDirOf(fx));
    await reg.init();
    const pub = await reg.publish(obj, mkSig(`pub-${hexOf(obj.id).slice(0, 12)}`));
    expect(pub.ok).toBe(true);

    const runtime = makeRuntime(fx);
    const { captured, ctx } = makeFakeCtx({ runtime });
    apply(ctx, { bootstrap: false });
    const r = await captured.find((c) => c.name === 'evolve')!.handler(makeInvocation(`absorb ${obj.id}`, SESSION));
    expect(r.kind).toBe('success');
    expect(r.text).toContain('已吸收');
    expect(r.text).toContain(obj.id.slice(0, 16));
    // 共识回传：新实例重读磁盘（本实例 registry 内存清单在吸收前已加载——disk 为权威）
    const reg2 = new GitRegistry(registryDirOf(fx));
    await reg2.init();
    const entry = (await reg2.list()).find((e) => e.id === obj.id)!;
    expect(entry.verified_by.length).toBeGreaterThan(0);
    expect(entry.verified_by[0]!.instance).toMatch(/^local:/);
    // 事件入链：evolution/absorbed
    const { events } = await runtime.eventStore.query({ session_id: SESSION });
    expect(events.some((e) => e.type === 'evolution/absorbed')).toBe(true);
  }, 30000);

  it('registry 无该 id → 吸收失败明确文本（不崩）', async () => {
    const fx = buildLayoutFixture();
    fixtures.push(fx);
    const runtime = makeRuntime(fx);
    const { captured, ctx } = makeFakeCtx({ runtime });
    apply(ctx, { bootstrap: false });
    const missing = `sha256:${'0'.repeat(64)}`;
    const r = await captured.find((c) => c.name === 'evolve')!.handler(makeInvocation(`absorb ${missing}`, SESSION));
    expect(r.kind).toBe('error');
    expect(r.text).toMatch(/吸收失败|对象不存在/);
  }, 30000);

  it('registry_dir 配置（相对演化工作区根解析）→ 发布/吸收落到配置目录', async () => {
    const fx = buildLayoutFixture();
    fixtures.push(fx);
    // 自定义策略目录：copy 三策略 + 最小 evolve.yaml（share.registry_dir 相对路径）
    const policyDir = join(base, 'policy-reg');
    await mkdir(policyDir, { recursive: true });
    for (const f of ['governor.yaml', 'budget.yaml', 'context.yaml']) {
      await copyFile(join(REPO_POLICY_DIR, f), join(policyDir, f));
    }
    await writeFile(
      join(policyDir, 'evolve.yaml'),
      [
        'daily_evolution_cost: 100',
        'roi_min: 1.0',
        'maintenance_rate: 0.5',
        'share:',
        '  registry_dir: my-registry',
        '',
      ].join('\n'),
      'utf8',
    );
    // 对象推进 trusted-latest
    const obj = mkEvo();
    await commitEvolutionObject(fx, obj, fx.latestHash);

    const runtime = makeRuntime(fx, { policyDir });
    const { captured, ctx } = makeFakeCtx({ runtime });
    apply(ctx, { bootstrap: false });
    const r = await captured.find((c) => c.name === 'evolve')!.handler(makeInvocation('share', SESSION));
    expect(r.kind).toBe('success');
    expect(r.text).toContain('my-registry');
    // 配置目录生效：<evolutionRoot>/my-registry（相对演化工作区根）
    const reg = new GitRegistry(registryDirOf(fx, 'my-registry'));
    await reg.init();
    expect((await reg.list()).map((e) => e.id)).toContain(obj.id);
    // 缺省目录未被写入
    const defReg = new GitRegistry(registryDirOf(fx));
    await defReg.init();
    expect((await defReg.list())).toHaveLength(0);
  }, 30000);
});
