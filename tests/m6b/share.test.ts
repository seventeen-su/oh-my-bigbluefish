// T6b.1 行为测试：集体演化协议（supervisor/share.ts，架构 §13 共享与集体演化 / §10.2 验证多样性）。
// 严格 TDD：本文件先于实现编写并确认失败（模块缺失）。
// 覆盖（brief 测试清单 1-10）：
//   ① protocol.json：默认协议文件存在且 schema 校验通过（版本号一致）
//   ② publish：对象发布 → manifest 有记录 + objects/<id>.json 落盘；重复发布（同内容哈希）→ 拒绝（去重）
//   ③ 打包/解包往返：packObject → unpackObject → 对象与签名一致；篡改内容 → unpack 校验失败 fail-loud
//   ④ verify：签名/哈希非法 → 校验失败
//   ⑤ 吸收管线：合法对象 → 吸收成功（verifyChain/replayBench/contractTests 依序被调）；任一步失败 → 短路 + AbsorbReport 记录失败步
//   ⑥ 共识回传：吸收成功后 registry 中该对象 verified_by 含本实例（全纯代码——无网络）
//   ⑦ effective_diversity：同实例 3 条 → 1；异模型家族 3 条 → ≥2（加权正确）
//   ⑧ 信誉等级：0 验证 → unverified；1 → locally-verified；多样性达标 → community-verified；跨环境多实例 → high-trust
//   ⑨ revoke：撤销后 get 返回标记 + 本地黑名单生效（fail-loud）
//   ⑩ Registry transport 实测（§17 开放项）：Git 清单 transport（本地目录 registry）全链路闭环可用
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJson, makeImmutableId, type Fingerprint } from '../../kernel/schemas/base.js';
import { EvolutionObjectSchema, type EvolutionObject } from '../../kernel/schemas/m.js';
import {
  GitRegistry,
  PROTOCOL,
  ProtocolSchema,
  absorb,
  computeEffectiveDiversity,
  packObject,
  reputation,
  unpackObject,
  validateProtocol,
  type AbsorbDeps,
} from '../../supervisor/share.js';

// ---- 测试工具 ----

/** 测试环境指纹（§4.4） */
const ENV: Fingerprint = { os: 'win32', node: 'v24', dsh_version: '0.6.0', project: 'omb-v2' };

/** EvolutionObject id 的 64hex 部分（registry objects/<hex>.json 文件名；'sha256:' 前缀在 Windows 目录名非法） */
const hexOf = (id: string): string => id.slice('sha256:'.length);

let seq = 0;

/** 确定性 EvolutionObject 工厂：id = sha256(canonical(body))——内容寻址（M4，同 activation.ts 语义） */
function mkEvo(over: Partial<Omit<EvolutionObject, 'id'>> = {}): EvolutionObject {
  const ts = '2026-08-21T00:00:00.000Z';
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
      source: 'test/fixture',
      event: `evolution/t6b-${seq}`,
      actor: 't6b-test',
      environment: ENV,
      runtime_snapshot: 'rs:snapshot-001',
      timestamp: ts,
      transformation_chain: [],
      verification: 'v:fixture',
    },
    refs: [],
    protocol_version: '2.0',
    parent: null,
    diff: `diff --git a/kernel/x.ts b/kernel/x.ts\n+line-${seq}`,
    compat: 'omb/2.0',
    bench: 'bench/frozen-001',
    spdx: 'MIT',
    verifications: ['cert/t6b-1'],
    ...over,
  };
  seq += 1;
  return { ...body, id: makeImmutableId(canonicalJson(body)) };
}

/** 吸收管线依赖工厂（缺省全部成功） */
function okDeps(over: Partial<AbsorbDeps> = {}): AbsorbDeps {
  return {
    verifyChain: async () => ({ ok: true, detail: 'chain ok' }),
    replayBench: async () => ({ ok: true, detail: 'replay ok' }),
    contractTests: async () => ({ ok: true, detail: 'contract ok' }),
    ...over,
  };
}

// ---- 测试主体 ----

describe('集体演化协议（§13 / §10.2）', () => {
  /** 临时 registry 根（.evolution/registry/ 用户态目录约定，架构 §3） */
  let root: string;
  /** 临时目录总根（afterEach 清理） */
  let base: string;

  beforeEach(async () => {
    seq = 0;
    base = await mkdtemp(join(tmpdir(), 'omb-m6b-'));
    root = join(base, '.evolution', 'registry');
    await mkdir(root, { recursive: true });
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('① protocol.json：默认协议文件存在且 schema 校验通过（版本号一致）', async () => {
    const reg = new GitRegistry(root);
    await reg.init();

    // 默认协议文件落盘
    const raw = await readFile(join(root, 'protocol.json'), 'utf8');
    const parsed = JSON.parse(raw) as unknown;

    // schema 校验通过 + 版本号与常量一致（协议层单一权威，§13.1）
    expect(ProtocolSchema.safeParse(parsed).success).toBe(true);
    expect(validateProtocol(parsed).ok).toBe(true);
    expect((parsed as { protocol_version: number }).protocol_version).toBe(PROTOCOL.protocol_version);
    expect((parsed as { objects: string[] }).objects).toContain('evolution_object');

    // 非法协议对象 → 校验失败
    expect(validateProtocol({ protocol_version: 99 }).ok).toBe(false);
  });

  it('② publish：对象发布 → manifest 有记录 + objects/<id>.json 落盘；重复发布（同内容哈希）→ 拒绝（去重）', async () => {
    const reg = new GitRegistry(root);
    const obj = mkEvo();

    const res = await reg.publish(obj, 'sig-git-001');
    expect(res.ok).toBe(true);

    // manifest 有记录（id/name/version/signature/parent/verified_by[]）
    const entry = (await reg.list()).find((e) => e.id === obj.id);
    expect(entry).toBeDefined();
    expect(entry!.id).toBe(obj.id);
    expect(entry!.signature).toBe('sig-git-001');
    expect(entry!.parent).toBe(obj.parent);
    expect(entry!.verified_by).toEqual([]);
    expect(entry!.name.length).toBeGreaterThan(0);
    expect(entry!.version.length).toBeGreaterThan(0);

    // objects/<id>.json 落盘（内容与对象一致）
    const onDisk = JSON.parse(await readFile(join(root, 'objects', `${hexOf(obj.id)}.json`), 'utf8')) as EvolutionObject;
    expect(EvolutionObjectSchema.safeParse(onDisk).success).toBe(true);
    expect(onDisk).toEqual(obj);

    // 重复发布（同内容哈希）→ 拒绝
    const dup = await reg.publish(obj, 'sig-git-002');
    expect(dup.ok).toBe(false);
    expect(dup.error).toMatch(/重复|已存在|duplicate/i);
    expect((await reg.list()).filter((e) => e.id === obj.id)).toHaveLength(1);
  });

  it('③ 打包/解包往返：packObject → unpackObject → 对象与签名一致；篡改内容 → unpack 校验失败 fail-loud', () => {
    const obj = mkEvo();

    const packed = packObject(obj, 'sig-abc');
    expect(packed).toBeInstanceOf(Buffer);
    expect(packed.length).toBeGreaterThan(0);

    // 往返一致
    const { obj: unpacked, signature } = unpackObject(packed);
    expect(unpacked).toEqual(obj);
    expect(signature).toBe('sig-abc');

    // 篡改内容 → unpack fail-loud（内容哈希不匹配；canonical JSON 转义换行，篡改字面子串）
    const tampered = Buffer.from(packed.toString('utf8').replace('kernel/x.ts', 'kernel/tampered.ts'));
    expect(() => unpackObject(tampered)).toThrow(/哈希|篡改/i);

    // 非法打包格式 → fail-loud
    expect(() => unpackObject(Buffer.from('garbage bytes'))).toThrow();
    expect(() => unpackObject(Buffer.alloc(0))).toThrow();

    // 空签名 → 打包拒绝（fail-loud）
    expect(() => packObject(obj, '')).toThrow(/签名/);
  });

  it('④ verify：签名/哈希非法 → 校验失败', async () => {
    const reg = new GitRegistry(root);
    const obj = mkEvo();
    const obj2 = mkEvo();
    await reg.publish(obj, 'sig-ok');
    await reg.publish(obj2, 'sig-ok-2');

    // 合法对象 → 校验通过
    expect((await reg.verify(obj.id)).ok).toBe(true);

    // 篡改 objects/<id>.json 内容 → 哈希校验失败
    const tampered = { ...obj, diff: 'tampered-content' };
    await writeFile(join(root, 'objects', `${hexOf(obj.id)}.json`), JSON.stringify(tampered), 'utf8');
    const v = await reg.verify(obj.id);
    expect(v.ok).toBe(false);
    expect(v.detail).toMatch(/哈希|篡改/i);

    // 签名缺失（篡改 manifest 后新实例重读）→ 校验失败
    const manifestFile = join(root, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8')) as { id: string; signature?: string }[];
    const entry2 = manifest.find((e) => e.id === obj2.id);
    delete entry2!.signature;
    await writeFile(manifestFile, JSON.stringify(manifest), 'utf8');
    const reg2 = new GitRegistry(root);
    const v2 = await reg2.verify(obj2.id);
    expect(v2.ok).toBe(false);
    expect(v2.detail).toMatch(/签名/);

    // 不存在 / 非法 id → 失败
    expect((await reg.verify(`sha256:${'0'.repeat(64)}`)).ok).toBe(false);
    expect((await reg.verify('not-an-id')).ok).toBe(false);
  });

  it('⑤ 吸收管线：合法对象 → 吸收成功（verifyChain/replayBench/contractTests 依序被调）；任一步失败 → 短路 + AbsorbReport 记录失败步', async () => {
    // 成功路径：三 deps 依序被调，对象入库 + 共识回传
    const reg = new GitRegistry(root);
    const calls: string[] = [];
    const deps = okDeps({
      verifyChain: async () => {
        calls.push('verifyChain');
        return { ok: true, detail: 'chain ok' };
      },
      replayBench: async () => {
        calls.push('replayBench');
        return { ok: true, detail: 'replay ok' };
      },
      contractTests: async () => {
        calls.push('contractTests');
        return { ok: true, detail: 'contract ok' };
      },
    });
    const obj = mkEvo();
    const report = await absorb(reg, obj, 'sig-absorb', deps);
    expect(report.ok).toBe(true);
    expect(report.failed_at).toBeNull();
    expect(calls).toEqual(['verifyChain', 'replayBench', 'contractTests']);
    expect(report.stages.every((s) => s.ok)).toBe(true);

    // 短路 1：verifyChain 失败 → replayBench/contractTests 不被调，失败步记录
    const reg2 = new GitRegistry(root);
    const calls2: string[] = [];
    const r2 = await absorb(
      reg2,
      mkEvo(),
      'sig-x',
      okDeps({
        verifyChain: async () => {
          calls2.push('verifyChain');
          return { ok: false, detail: 'chain 校验失败' };
        },
        replayBench: async () => {
          calls2.push('replayBench');
          return { ok: true, detail: 'ok' };
        },
      }),
    );
    expect(r2.ok).toBe(false);
    expect(r2.failed_at).toBe('verify_chain');
    expect(calls2).toEqual(['verifyChain']);

    // 短路 2：replayBench 失败 → contractTests 不被调（后续短路）
    const reg3 = new GitRegistry(root);
    const calls3: string[] = [];
    const r3 = await absorb(
      reg3,
      mkEvo(),
      'sig-y',
      okDeps({
        verifyChain: async () => {
          calls3.push('verifyChain');
          return { ok: true, detail: 'ok' };
        },
        replayBench: async () => {
          calls3.push('replayBench');
          return { ok: false, detail: 'replay 未通过' };
        },
        contractTests: async () => {
          calls3.push('contractTests');
          return { ok: true, detail: 'ok' };
        },
      }),
    );
    expect(r3.ok).toBe(false);
    expect(r3.failed_at).toBe('replay_bench');
    expect(calls3).toEqual(['verifyChain', 'replayBench']);

    // 短路 3：contractTests 失败 → 对象不入库（publish 不被执行）
    const reg4 = new GitRegistry(root);
    const obj4 = mkEvo();
    const r4 = await absorb(
      reg4,
      obj4,
      'sig-z',
      okDeps({ contractTests: async () => ({ ok: false, detail: '契约测试未通过' }) }),
    );
    expect(r4.ok).toBe(false);
    expect(r4.failed_at).toBe('contract_tests');
    expect(await reg4.get(obj4.id)).toBeNull();

    // 短路 4：签名/哈希失败（内容被篡改）→ 任一 dep 不被调，失败步 signature_hash
    const reg5 = new GitRegistry(root);
    const tampered = { ...mkEvo(), diff: 'tampered' }; // id 与内容不再匹配
    const calls5: string[] = [];
    const r5 = await absorb(
      reg5,
      tampered,
      'sig-t',
      okDeps({
        verifyChain: async () => {
          calls5.push('verifyChain');
          return { ok: true, detail: 'ok' };
        },
      }),
    );
    expect(r5.ok).toBe(false);
    expect(r5.failed_at).toBe('signature_hash');
    expect(calls5).toEqual([]);

    // 短路 5：schema 非法 → 任一 dep 不被调，失败步 schema（id 由含非法字段的 body 计算，哈希通过、schema 拒绝）
    const reg6 = new GitRegistry(root);
    const badSchema = mkEvo({ spdx: '' });
    const r6 = await absorb(reg6, badSchema, 'sig-u', okDeps());
    expect(r6.ok).toBe(false);
    expect(r6.failed_at).toBe('schema');
  });

  it('⑥ 共识回传：吸收成功后 registry 中该对象 verified_by 含本实例（全纯代码——无网络）', async () => {
    const reg = new GitRegistry(root);
    const obj = mkEvo();

    const report = await absorb(reg, obj, 'sig-consensus', {
      ...okDeps(),
      instance: 'instance-A',
      diversity: 2,
    });
    expect(report.ok).toBe(true);

    // 共识回传：verified_by 含本实例（instance + diversity）
    const entry = (await reg.list()).find((e) => e.id === obj.id);
    expect(entry?.verified_by).toContainEqual({ instance: 'instance-A', diversity: 2 });

    // 幂等：重复吸收（同对象已入库）→ publish 去重拒绝，失败步记录（不改动已入库状态）
    const again = await absorb(reg, obj, 'sig-consensus', okDeps());
    expect(again.ok).toBe(false);
    expect(again.failed_at).toBe('publish');
    expect((await reg.list()).find((e) => e.id === obj.id)?.verified_by).toHaveLength(1);
  });

  it('⑦ effective_diversity：同实例 3 条 → 1；异模型家族 3 条 → ≥2（加权正确）', () => {
    // 同实例（同 model_family/os/toolchain 组合）3 条 → 只算 1
    const same = [
      { model_family: 'deepseek', os: 'win32', toolchain: 'ts' },
      { model_family: 'deepseek', os: 'win32', toolchain: 'ts' },
      { model_family: 'deepseek', os: 'win32', toolchain: 'ts' },
    ];
    expect(computeEffectiveDiversity(same)).toBe(1);

    // 异模型家族 3 条 → 组合计数 ≥2（加权正确）
    const diffFamilies = [
      { model_family: 'deepseek', os: 'win32', toolchain: 'ts' },
      { model_family: 'gpt', os: 'win32', toolchain: 'ts' },
      { model_family: 'claude', os: 'win32', toolchain: 'ts' },
    ];
    expect(computeEffectiveDiversity(diffFamilies)).toBeGreaterThanOrEqual(2);

    // 组合维度：同家族不同 OS → 计 2（组合计数而非仅家族计数）
    const diffOs = [
      { model_family: 'deepseek', os: 'win32', toolchain: 'ts' },
      { model_family: 'deepseek', os: 'linux', toolchain: 'ts' },
    ];
    expect(computeEffectiveDiversity(diffOs)).toBe(2);

    // 空实例集 → 0
    expect(computeEffectiveDiversity([])).toBe(0);
  });

  it('⑧ 信誉等级：0 验证 → unverified；1 → locally-verified；多样性达标 → community-verified；跨环境多实例 → high-trust', () => {
    // 0 验证 → unverified
    expect(reputation([])).toBe('unverified');
    // ≥1 验证 → locally-verified
    expect(reputation([{ instance: 'a', diversity: 1 }])).toBe('locally-verified');
    // 有效多样性 ≥ 门槛（单实例多样性达标）→ community-verified
    expect(reputation([{ instance: 'a', diversity: 3 }])).toBe('community-verified');
    // 多实例多样性合计达标 → community-verified
    expect(
      reputation([
        { instance: 'a', diversity: 2 },
        { instance: 'b', diversity: 2 },
      ]),
    ).toBe('community-verified');
    // 跨环境多实例 → high-trust
    expect(
      reputation([
        { instance: 'a', diversity: 1 },
        { instance: 'b', diversity: 1 },
        { instance: 'c', diversity: 1 },
      ]),
    ).toBe('high-trust');
  });

  it('⑨ revoke：撤销后 get 返回标记 + 本地黑名单生效（fail-loud）', async () => {
    const reg = new GitRegistry(root);
    const obj = mkEvo();
    await reg.publish(obj, 'sig-revoke');

    await reg.revoke(obj.id, 'bench 数据污染');

    // get 返回撤销标记（撤销 → null）
    expect(await reg.get(obj.id)).toBeNull();

    // manifest 条目带撤销标记
    const entry = (await reg.list()).find((e) => e.id === obj.id);
    expect(entry?.revoked?.reason).toBe('bench 数据污染');

    // 本地黑名单落盘（新实例重读磁盘仍生效）
    const blacklist = JSON.parse(await readFile(join(root, 'blacklist.json'), 'utf8')) as Record<
      string,
      { reason: string }
    >;
    expect(blacklist[obj.id]).toBeDefined();

    // fail-loud：verify 失败（标记撤销原因）
    const v = await reg.verify(obj.id);
    expect(v.ok).toBe(false);
    expect(v.detail).toMatch(/撤销|revoked/i);

    // 新实例（重读磁盘）同样 fail-loud
    const reg2 = new GitRegistry(root);
    expect(await reg2.get(obj.id)).toBeNull();
    expect((await reg2.verify(obj.id)).ok).toBe(false);

    // 撤销对象重新发布 → 拒绝（黑名单）
    expect((await reg.publish(obj, 'sig-new')).ok).toBe(false);
  });

  it('⑩ Registry transport 实测（§17）：Git 清单 transport（本地目录 registry）发布→吸收→本地验证→共识回传 全链路闭环', async () => {
    const reg = new GitRegistry(root);
    await reg.init();

    // 协议文件 + 清单 + 对象目录结构就位
    const proto = JSON.parse(await readFile(join(root, 'protocol.json'), 'utf8')) as { protocol_version: number };
    expect(proto.protocol_version).toBe(PROTOCOL.protocol_version);

    // ① 发布（Git 清单 transport：本地目录；absorb 管线内入库即发布）
    const obj = mkEvo({ diff: 'diff --git a/supervisor/share.ts b/supervisor/share.ts\n+collective evolution protocol' });
    const sig = `git-sig:${hexOf(obj.id).slice(0, 12)}`;

    // ② 吸收（全纯代码：无网络；含发布/入库阶段）
    const report = await absorb(reg, obj, sig, {
      ...okDeps(),
      instance: 'transport-probe',
      diversity: 2,
    });
    expect(report.ok).toBe(true);
    expect(report.stages.map((s) => s.name)).toEqual([
      'signature_hash',
      'schema',
      'verify_chain',
      'replay_bench',
      'contract_tests',
      'publish',
      'consensus',
    ]);

    // ③ 本地验证
    expect((await reg.verify(obj.id)).ok).toBe(true);

    // ④ 共识回传持久化：新实例（重读磁盘）读到 verified_by
    const reg2 = new GitRegistry(root);
    const entry = (await reg2.list()).find((e) => e.id === obj.id);
    expect(entry?.verified_by).toContainEqual({ instance: 'transport-probe', diversity: 2 });
  });
});
