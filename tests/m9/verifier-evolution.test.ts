// 专项 3（2026-08-25-verification-contract 第二阶段裁决）：Verifier Evolution 第一阶段测试——
// 注册面（VerifierStore）+ 替换门禁（candidateVerifierGate）+ 落地审计（applyVerifierReplacement）。
// 覆盖：
//   ① VerifierStore：注册/覆写（同 verifier_id 最新胜出）/查询/清单/持久化（新实例读回）/原子写
//     （tmp+rename 无残留）/损坏 JSON fail-loud/写失败降级（坏路径注入）
//   ② candidateVerifierGate 矩阵：spec 非法（空 checks / 空字符串项）拒绝；版本不大于现任拒绝（防回退）；
//     known/hidden/cross/human 任一 false 拒绝（reason 列明缺失项）；全 true + 版本递增 → ok；
//     origin==verifier_id → 拒绝（非循环——含首登 fail-closed）；current undefined → 首登 ok；
//     结构检查优先（坏 spec + 低版本 → 结构 reason）；确定性（同输入同输出）
//   ③ applyVerifierReplacement：ok → 注册更新 + 审计行（old/new version + replaced/replaced_by/audit_id 12 hex）；
//     拒绝 → 不注册 + 拒绝审计行；store 抛错降级（不抛 + note）；审计写失败降级（noteDegraded 记录）；
//     审计文件损坏行跳过（readVerifierEvolutionAudit）
//   ④ 确定性：同参数两次 apply（不同 root、注入 registered_at）→ audit_id 相同 + 注册记录一致
import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  VerifierStore,
  createVerificationStores,
  type VerifierRecord,
} from '../../supervisor/verification-stores.js';
import {
  applyVerifierReplacement,
  candidateVerifierGate,
  readVerifierEvolutionAudit,
  type GateVerdict,
  type VerifierCandidate,
  type VerifierEvolutionAuditLine,
  type VerifierGateResults,
  type VerifierStoreLike,
} from '../../kernel/verifier-evolution.js';

const roots: string[] = [];

async function tmpRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

/** 最小合法候选（确定性 fixture；version '2' > 现任 '1'） */
function candidate(over: Partial<VerifierCandidate> = {}): VerifierCandidate {
  return {
    verifier_id: 'verifier:repair',
    version: '2',
    spec: { checks: ['结构合法', '可执行'], blind_spots: ['性能退化'] },
    validation_benchmark: 'bench:repair:v1',
    independent_test_set: 'its:repair:v1',
    ...over,
  };
}

/** 现任验证器（version '1'） */
const CURRENT: { verifier_id: string; version: string } = { verifier_id: 'verifier:repair', version: '1' };

/** VerifierRecord fixture（registered_at 必填——注册面直接注册用） */
function verifierRecord(over: Partial<VerifierRecord> = {}): VerifierRecord {
  return {
    verifier_id: 'verifier:repair',
    version: '2',
    spec: { checks: ['结构合法', '可执行'], blind_spots: ['性能退化'] },
    validation_benchmark: 'bench:repair:v1',
    independent_test_set: 'its:repair:v1',
    registered_at: TS_FIXED,
    ...over,
  };
}

/** 四项验证结果全 true */
const ALL_TRUE: VerifierGateResults = {
  known_set_passed: true,
  hidden_set_passed: true,
  cross_compare_consistent: true,
  human_reviewed: true,
};

/** 记录文件路径（与 supervisor/verification-stores.ts fileKey 同源：复合键 sha256 hex） */
function recordFile(compositeKey: string): string {
  return `${createHash('sha256').update(compositeKey, 'utf8').digest('hex')}.json`;
}

const TS_FIXED = 1_700_000_000_000; // 固定注册时间戳（确定性断言用）

// ---- ① 验证器注册库（VerifierStore） ----

describe('① 验证器注册库（VerifierStore）', () => {
  it('空目录 → getVerifier null / listVerifiers []；注册后全字段保留', async () => {
    const store = new VerifierStore({ root: await tmpRoot('omb-ver-1-') });
    expect(await store.getVerifier('verifier:repair')).toBeNull();
    expect(await store.listVerifiers()).toEqual([]);
    const rec: VerifierRecord = {
      verifier_id: 'verifier:repair',
      spec: { checks: ['结构合法'], blind_spots: ['性能退化'] },
      validation_benchmark: 'bench:repair:v1',
      independent_test_set: 'its:repair:v1',
      version: '1',
      registered_at: TS_FIXED,
    };
    await store.registerVerifier(rec);
    expect(await store.getVerifier('verifier:repair')).toEqual(rec);
    expect(await store.listVerifiers()).toHaveLength(1);
  });

  it('同 verifier_id 覆写：最新注册胜出（单文件重写，list 不新增）', async () => {
    const store = new VerifierStore({ root: await tmpRoot('omb-ver-2-') });
    await store.registerVerifier(verifierRecord({ version: '1' }));
    await store.registerVerifier(verifierRecord({ version: '2' }));
    const all = await store.listVerifiers();
    expect(all).toHaveLength(1);
    expect(all[0]!.version).toBe('2');
    expect((await store.getVerifier('verifier:repair'))!.version).toBe('2');
  });

  it('持久化：同 root 新实例读回（注册面落盘）', async () => {
    const root = await tmpRoot('omb-ver-persist-');
    await new VerifierStore({ root }).registerVerifier(verifierRecord({ version: '1' }));
    const reloaded = new VerifierStore({ root });
    expect((await reloaded.getVerifier('verifier:repair'))!.version).toBe('1');
    expect(await reloaded.listVerifiers()).toHaveLength(1);
  });

  it('原子写：tmp+rename 后原文件存在且无 .tmp 残留', async () => {
    const root = await tmpRoot('omb-ver-atomic-');
    const store = new VerifierStore({ root });
    await store.registerVerifier(verifierRecord());
    const files = await readdir(join(root, 'verifiers'));
    expect(files.filter((f) => f.endsWith('.json'))).toHaveLength(1);
    expect(files.filter((f) => f.endsWith('.tmp'))).toHaveLength(0);
  });

  it('损坏 JSON → getVerifier/listVerifiers fail-loud 抛错（message 含 corrupt）', async () => {
    const root = await tmpRoot('omb-ver-corrupt-');
    const store = new VerifierStore({ root });
    await mkdir(join(root, 'verifiers'), { recursive: true });
    await writeFile(join(root, 'verifiers', recordFile('verifier:dead')), '{"broken":', 'utf8');
    await expect(store.getVerifier('verifier:dead')).rejects.toThrow(/corrupt/);
    await expect(store.listVerifiers()).rejects.toThrow(/corrupt/);
    expect(await store.getVerifier('verifier:other')).toBeNull(); // 无关键不读坏文件 → null
  });

  it('写失败降级：verifiers 子目录被文件占用 → registerVerifier 不抛 + degraded 记录', async () => {
    const root = await tmpRoot('omb-ver-badpath-');
    await writeFile(join(root, 'verifiers'), 'not a dir', 'utf8'); // 占位文件 → mkdir 失败
    const store = new VerifierStore({ root });
    await expect(store.registerVerifier(verifierRecord())).resolves.toBeUndefined();
    expect(store.degraded).toContain('写入失败');
  });

  it('createVerificationStores 聚合返回 verifiers（四库工厂集成）', async () => {
    const stores = createVerificationStores(await tmpRoot('omb-ver-factory-'));
    expect(stores.verifiers).toBeInstanceOf(VerifierStore);
    expect(await stores.verifiers.listVerifiers()).toEqual([]);
    await stores.verifiers.registerVerifier(verifierRecord());
    expect((await stores.verifiers.getVerifier('verifier:repair'))!.version).toBe('2');
  });
});

// ---- ② 替换门禁矩阵（candidateVerifierGate） ----

describe('② 替换门禁矩阵（candidateVerifierGate）', () => {
  it('spec.checks 空数组 → 拒绝（reason 含 结构检查）', () => {
    const g = candidateVerifierGate(candidate({ spec: { checks: [], blind_spots: [] } }), CURRENT, ALL_TRUE);
    expect(g.ok).toBe(false);
    expect(g.reason).toContain('结构检查');
    expect(g.reason).toContain('非空数组');
  });

  it('spec.checks 含空字符串/空白项 → 拒绝（reason 含 结构检查）', () => {
    const g = candidateVerifierGate(candidate({ spec: { checks: ['结构合法', '  '], blind_spots: [] } }), CURRENT, ALL_TRUE);
    expect(g.ok).toBe(false);
    expect(g.reason).toContain('结构检查');
    expect(g.reason).toContain('非空字符串');
  });

  it('结构检查优先：坏 spec + 版本不增 → 拒绝 reason 为结构（不混版本）', () => {
    const g = candidateVerifierGate(candidate({ version: '1', spec: { checks: [], blind_spots: [] } }), CURRENT, ALL_TRUE);
    expect(g.ok).toBe(false);
    expect(g.reason).toContain('结构检查');
    expect(g.reason).not.toContain('版本递增');
  });

  it('version 等于现任（2 vs 2）→ 拒绝（防回退；reason 含 版本递增）', () => {
    const g = candidateVerifierGate(
      candidate({ version: '2' }),
      { verifier_id: 'verifier:repair', version: '2' },
      ALL_TRUE,
    );
    expect(g.ok).toBe(false);
    expect(g.reason).toContain('版本递增');
  });

  it('version 小于现任（1 vs 2）→ 拒绝（防回退）', () => {
    const g = candidateVerifierGate(candidate({ version: '1' }), CURRENT, ALL_TRUE);
    expect(g.ok).toBe(false);
    expect(g.reason).toContain('版本递增');
  });

  it('非整数字符串版本无法判定递增 → 拒绝（fail-closed）', () => {
    const g = candidateVerifierGate(candidate({ version: '1.0.1' }), CURRENT, ALL_TRUE);
    expect(g.ok).toBe(false);
    expect(g.reason).toContain('版本递增');
  });

  it.each([
    ['known_set_passed', { ...ALL_TRUE, known_set_passed: false }],
    ['hidden_set_passed', { ...ALL_TRUE, hidden_set_passed: false }],
    ['cross_compare_consistent', { ...ALL_TRUE, cross_compare_consistent: false }],
    ['human_reviewed', { ...ALL_TRUE, human_reviewed: false }],
  ] as const)('验证结果 %s=false → 拒绝（reason 列明缺失项）', (_name, results) => {
    const g = candidateVerifierGate(candidate(), CURRENT, results);
    expect(g.ok).toBe(false);
    expect(g.reason).toContain('验证结果拒绝');
    expect(g.reason).toContain(_name);
  });

  it('全 true + 版本递增 → ok（reason 含 通过 与版本箭头）', () => {
    const g = candidateVerifierGate(candidate(), CURRENT, ALL_TRUE);
    expect(g.ok).toBe(true);
    expect(g.reason).toContain('替换门禁通过');
    expect(g.reason).toContain('1 → 2');
  });

  it('origin === verifier_id（有现任）→ 拒绝（循环自证；reason 含 循环自证）', () => {
    const g = candidateVerifierGate(candidate({ origin: 'verifier:repair' }), CURRENT, ALL_TRUE);
    expect(g.ok).toBe(false);
    expect(g.reason).toContain('循环自证');
  });

  it('origin === verifier_id（无现任）→ 首登也拒绝（fail-closed——自证候选连首登都不允许）', () => {
    const g = candidateVerifierGate(candidate({ origin: 'verifier:repair' }), undefined, ALL_TRUE);
    expect(g.ok).toBe(false);
    expect(g.reason).toContain('循环自证');
  });

  it('origin 为独立来源（非自身）→ 不误拒', () => {
    const g = candidateVerifierGate(candidate({ origin: 'kernel:gates' }), CURRENT, ALL_TRUE);
    expect(g.ok).toBe(true);
  });

  it('current undefined（无现任）→ 首登 ok（reason 注明 首登；不要求版本/验证集）', () => {
    const g = candidateVerifierGate(candidate({ version: '0' }), undefined, {
      known_set_passed: false,
      hidden_set_passed: false,
      cross_compare_consistent: false,
      human_reviewed: false,
    });
    expect(g.ok).toBe(true);
    expect(g.reason).toContain('无现任验证器——首登');
  });

  it('确定性：同输入两次调用 → deep equal', () => {
    const inputs = [
      [candidate(), CURRENT, ALL_TRUE],
      [candidate({ version: '1' }), CURRENT, ALL_TRUE],
      [candidate({ origin: 'verifier:repair' }), undefined, ALL_TRUE],
      [candidate({ spec: { checks: [], blind_spots: [] } }), undefined, ALL_TRUE],
    ] as const;
    for (const args of inputs) {
      const a = candidateVerifierGate(args[0], args[1], args[2]);
      const b = candidateVerifierGate(args[0], args[1], args[2]);
      expect(a).toEqual(b);
    }
  });
});

// ---- ③ 替换落地（applyVerifierReplacement） ----

describe('③ 替换落地（applyVerifierReplacement）', () => {
  it('门禁 ok + 有现任 → 注册更新（成为现任）+ 审计行全字段', async () => {
    const root = await tmpRoot('omb-apply-ok-');
    const store = new VerifierStore({ root });
    await store.registerVerifier(verifierRecord({ version: '1' }));
    const gate: GateVerdict = { ok: true, reason: '替换门禁通过：全过' };
    const out = await applyVerifierReplacement(store, candidate({ registered_at: TS_FIXED }), CURRENT, gate, 'manual:verifier-review');

    expect(out.replaced).toBe(true);
    expect(out.audit_id).toMatch(/^[0-9a-f]{12}$/);
    const updated = await store.getVerifier('verifier:repair');
    expect(updated).toEqual({
      verifier_id: 'verifier:repair',
      version: '2',
      spec: { checks: ['结构合法', '可执行'], blind_spots: ['性能退化'] },
      validation_benchmark: 'bench:repair:v1',
      independent_test_set: 'its:repair:v1',
      registered_at: TS_FIXED,
    });

    const lines = await readVerifierEvolutionAudit(join(root, 'verifier-evolution.jsonl'));
    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    expect(line.audit_id).toBe(out.audit_id);
    expect(line.ts).toBeTypeOf('number');
    expect(line.old_verifier_id).toBe('verifier:repair');
    expect(line.old_version).toBe('1');
    expect(line.new_verifier_id).toBe('verifier:repair');
    expect(line.new_version).toBe('2');
    expect(line.gate_reason).toBe('替换门禁通过：全过');
    expect(line.trigger).toBe('manual:verifier-review');
    expect(line.replaced).toBe(true);
    expect(line.replaced_by).toBe('gate');
  });

  it('门禁 ok + 无现任（首登）→ 注册成功 + old 字段为 null', async () => {
    const root = await tmpRoot('omb-apply-first-');
    const store = new VerifierStore({ root });
    const gate: GateVerdict = { ok: true, reason: '无现任验证器——首登' };
    const out = await applyVerifierReplacement(store, candidate({ registered_at: TS_FIXED }), undefined, gate, 'bootstrap');
    expect(out.replaced).toBe(true);
    expect((await store.getVerifier('verifier:repair'))!.version).toBe('2');
    const line = (await readVerifierEvolutionAudit(join(root, 'verifier-evolution.jsonl')))[0]!;
    expect(line.old_verifier_id).toBeNull();
    expect(line.old_version).toBeNull();
    expect(line.replaced).toBe(true);
    expect(line.replaced_by).toBe('gate');
  });

  it('门禁拒绝 → 不注册 + 拒绝审计行（replaced=false；reason 落 gate_reason）', async () => {
    const root = await tmpRoot('omb-apply-refused-');
    const store = new VerifierStore({ root });
    await store.registerVerifier(verifierRecord({ version: '1' }));
    const gate: GateVerdict = { ok: false, reason: '版本递增拒绝：防回退' };
    const out = await applyVerifierReplacement(store, candidate({ version: '1', registered_at: TS_FIXED }), CURRENT, gate, 'manual:verifier-review');

    expect(out.replaced).toBe(false);
    expect((await store.getVerifier('verifier:repair'))!.version).toBe('1'); // 未被替换
    const line = (await readVerifierEvolutionAudit(join(root, 'verifier-evolution.jsonl')))[0]!;
    expect(line.replaced).toBe(false);
    expect(line.replaced_by).toBeNull();
    expect(line.gate_reason).toBe('版本递增拒绝：防回退');
    expect(line.old_version).toBe('1');
    expect(line.new_version).toBe('1');
  });

  it('store.registerVerifier 抛错 → 降级：不抛 + replaced=false + 审计行 note 记录降级原因', async () => {
    const root = await tmpRoot('omb-apply-throw-');
    const throwing: VerifierStoreLike = {
      root,
      registerVerifier: async () => {
        throw new Error('injected store failure');
      },
    };
    const gate: GateVerdict = { ok: true, reason: '替换门禁通过：全过' };
    const out = await applyVerifierReplacement(
      throwing,
      candidate({ registered_at: TS_FIXED }),
      CURRENT,
      gate,
      'manual:verifier-review',
    );
    expect(out.replaced).toBe(false);
    expect(out.audit_id).toMatch(/^[0-9a-f]{12}$/);
    const line = (await readVerifierEvolutionAudit(join(root, 'verifier-evolution.jsonl')))[0]!;
    expect(line.replaced).toBe(false);
    expect(line.replaced_by).toBeNull();
    expect(line.note).toContain('registerVerifier 抛错降级');
    expect(line.note).toContain('injected store failure');
  });

  it('审计写失败 → 降级记录（noteDegraded/degraded）不抛；注册本身成功', async () => {
    const root = await tmpRoot('omb-apply-auditfail-');
    const store = new VerifierStore({ root });
    await mkdir(join(root, 'verifier-evolution.jsonl'), { recursive: true }); // 目录占位 → appendFile 失败
    const gate: GateVerdict = { ok: true, reason: '替换门禁通过：全过' };
    const out = await applyVerifierReplacement(store, candidate({ registered_at: TS_FIXED }), undefined, gate, 'bootstrap');
    expect(out.replaced).toBe(true); // 注册成功（verifiers/ 子目录不受影响）
    expect((await store.getVerifier('verifier:repair'))!.version).toBe('2');
    expect(store.degraded).toContain('审计写入失败');
  });

  it('审计文件损坏行跳过（readVerifierEvolutionAudit）；apply 追加行仍可读', async () => {
    const root = await tmpRoot('omb-apply-corrupt-');
    const store = new VerifierStore({ root });
    const auditFile = join(root, 'verifier-evolution.jsonl');
    await writeFile(auditFile, 'not json{\n', 'utf8'); // 预写损坏行
    expect(await readVerifierEvolutionAudit(auditFile)).toEqual([]); // 损坏行跳过

    const gate: GateVerdict = { ok: true, reason: '无现任验证器——首登' };
    const out = await applyVerifierReplacement(store, candidate({ registered_at: TS_FIXED }), undefined, gate, 'bootstrap');
    expect(out.replaced).toBe(true);
    const lines = await readVerifierEvolutionAudit(auditFile);
    expect(lines).toHaveLength(1); // 坏行跳过、新行保留
    expect(lines[0]!.new_version).toBe('2');
  });

  it('registered_at 缺省 → apply 以落地墙钟填充（数字时间戳）', async () => {
    const root = await tmpRoot('omb-apply-ts-');
    const store = new VerifierStore({ root });
    await applyVerifierReplacement(
      store,
      candidate({ registered_at: undefined }),
      undefined,
      { ok: true, reason: '无现任验证器——首登' },
      'bootstrap',
    );
    const rec = await store.getVerifier('verifier:repair');
    expect(typeof rec!.registered_at).toBe('number');
    expect(rec!.registered_at).toBeGreaterThan(0);
  });
});

// ---- ④ 确定性 ----

describe('④ 确定性：同参数两次 apply → audit_id 相同 + 注册记录一致', () => {
  it('不同 root、注入 registered_at → audit_id 与版本字段一致（ts 为墙钟不锚定）', async () => {
    const mk = async (): Promise<VerifierStore> => new VerifierStore({ root: await tmpRoot('omb-det-apply-') });
    const run = async (store: VerifierStore) => {
      const out = await applyVerifierReplacement(
        store,
        candidate({ registered_at: TS_FIXED }),
        CURRENT,
        { ok: true, reason: '替换门禁通过：全过' },
        'manual:verifier-review',
      );
      const line = (await readVerifierEvolutionAudit(join(store.root, 'verifier-evolution.jsonl')))[0]!;
      return { out, rec: await store.getVerifier('verifier:repair'), line };
    };
    const a = await run(await mk());
    const b = await run(await mk());
    expect(a.out.audit_id).toBe(b.out.audit_id); // audit_id 与墙钟无关
    expect(a.rec).toEqual(b.rec);
    expect(a.line.old_version).toBe(b.line.old_version);
    expect(a.line.new_version).toBe(b.line.new_version);
    expect(a.line.replaced).toBe(b.line.replaced);
  });

  it('同参数门禁调用 → 同 reason（含候选 id 与版本）', () => {
    const g1 = candidateVerifierGate(candidate(), CURRENT, ALL_TRUE);
    const g2 = candidateVerifierGate(candidate(), CURRENT, ALL_TRUE);
    expect(g1).toEqual(g2);
  });
});

// ---- 类型哨兵（审计行形状完整性——避免字段漂移） ----

describe('类型哨兵：审计行字段形状', () => {
  it('构造最小审计行对象可被类型系统接受', () => {
    const line: VerifierEvolutionAuditLine = {
      audit_id: '0123456789ab',
      ts: TS_FIXED,
      old_verifier_id: 'verifier:repair',
      old_version: '1',
      new_verifier_id: 'verifier:repair',
      new_version: '2',
      gate_reason: 'ok',
      trigger: 'test',
      replaced: true,
      replaced_by: 'gate',
    };
    expect(line.audit_id).toHaveLength(12);
  });
});
