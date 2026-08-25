// P3.6（2026-08-25-verification-contract 第二阶段裁决 S1）：验证数据面三库测试（supervisor/verification-stores.ts）。
// 覆盖：
//   ① 事实库：注册/覆写（同 id 最新胜出）/ provenanceContains 查询 / 全量 / 空目录 → []
//   ② 基线库：注册/取回/覆写/清单（kind 过滤）；版本化字段全量保留（input/environment_fingerprint/
//     runtime_snapshot/expected_result/verifier_version——未来演化对比"与哪个历史状态比较"）；
//     同 id 不同 kind 独立共存
//   ③ 任务库：注册/取回/覆写/清单
//   ④ 原子写：tmp+rename 后原文件存在且无 .tmp 残留；同键覆写 = 单文件重写
//   ⑤ 损坏 JSON → fail-loud 抛错（facts/baselines/tasks 三库各验）
//   ⑥ 写失败降级：注入坏路径（子目录为文件）→ 注册不抛 + degraded 记录（尽力而为——注册面缺失不阻塞验证主链）
//   ⑦ 确定性：同注册序列 → 同读取结果
import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BaselineStore,
  FactStore,
  TaskStore,
  VerifierStore,
  createVerificationStores,
  type BaselineRecord,
  type FactRecord,
  type TaskRecord,
} from '../../supervisor/verification-stores.js';

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

// ---- ① 事实库 ----

describe('① 事实库（FactStore）', () => {
  it('空目录 → all()/factsFor() 为空；注册后可查', async () => {
    const store = new FactStore({ root: await tmpRoot('omb-facts-1-') });
    expect(await store.all()).toEqual([]);
    expect(await store.factsFor({ provenanceContains: 'obj' })).toEqual([]);
    await store.registerFact({ id: 'claim:1', text: '事实一', provenance: 'obj-a', valid: true });
    expect(await store.all()).toHaveLength(1);
    expect((await store.all())[0]!.id).toBe('claim:1');
  });

  it('factsFor({provenanceContains}) 按 provenance 子串过滤；空过滤 → 全量', async () => {
    const store = new FactStore({ root: await tmpRoot('omb-facts-2-') });
    await store.registerFact({ id: 'claim:a', text: 't-a', provenance: 'obj-a', valid: true });
    await store.registerFact({ id: 'claim:b', text: 't-b', provenance: 'obj-b', valid: false });
    const forA = await store.factsFor({ provenanceContains: 'obj-a' });
    expect(forA).toHaveLength(1);
    expect(forA[0]!.id).toBe('claim:a');
    expect(await store.factsFor({})).toHaveLength(2);
    expect(await store.factsFor({ provenanceContains: 'nope' })).toEqual([]);
  });

  it('同 id 覆写：最新观测胜出（单文件重写）', async () => {
    const store = new FactStore({ root: await tmpRoot('omb-facts-3-') });
    await store.registerFact({ id: 'claim:x', text: 'v1', provenance: 'p', valid: true });
    await store.registerFact({ id: 'claim:x', text: 'v2', provenance: 'p', valid: false });
    const all = await store.all();
    expect(all).toHaveLength(1);
    expect(all[0]!.text).toBe('v2');
    expect(all[0]!.valid).toBe(false);
  });

  it('原子写：tmp+rename 后原文件存在且无 .tmp 残留', async () => {
    const root = await tmpRoot('omb-facts-atomic-');
    const store = new FactStore({ root });
    await store.registerFact({ id: 'claim:atomic', text: 't', provenance: 'p', valid: true });
    const files = await readdir(join(root, 'facts'));
    expect(files.filter((f) => f.endsWith('.json'))).toHaveLength(1);
    expect(files.filter((f) => f.endsWith('.tmp'))).toHaveLength(0);
    expect((await store.all())[0]!.id).toBe('claim:atomic');
  });
});

// ---- ② 基线库 ----

describe('② 基线库（BaselineStore）', () => {
  const BASELINE: BaselineRecord = {
    id: 'proc-1',
    kind: 'process',
    input: { rebuild: true, payload: 'x' },
    environment_fingerprint: { os: 'win32', node: 'v22.0.0', dsh_version: '0.1.0', project: 'omb-v2' },
    runtime_snapshot: 'rs:abc123',
    expected_result: { verdict: 'PASS', evidence_quality: 1, disposition: 'clear_suspicious' },
    verifier_version: '1',
  };

  it('注册/取回：版本化字段全量保留（未来演化对比"与哪个历史状态比较"）', async () => {
    const store = new BaselineStore({ root: await tmpRoot('omb-base-1-') });
    expect(await store.getBaseline('proc-1', 'process')).toBeNull(); // 文件不存在 → 空
    await store.registerBaseline(BASELINE);
    const got = await store.getBaseline('proc-1', 'process');
    expect(got).toEqual(BASELINE); // input/environment_fingerprint/runtime_snapshot/expected_result/verifier_version 全量保留
  });

  it('同 id+kind 覆写（最新胜出）；同 id 不同 kind 独立共存', async () => {
    const store = new BaselineStore({ root: await tmpRoot('omb-base-2-') });
    await store.registerBaseline({ ...BASELINE, expected_result: { verdict: 'UNKNOWN' } });
    await store.registerBaseline({ ...BASELINE, expected_result: { verdict: 'PASS' } });
    expect((await store.getBaseline('proc-1', 'process'))!.expected_result).toEqual({ verdict: 'PASS' });
    await store.registerBaseline({ ...BASELINE, id: 'proc-1', kind: 'skill-task', input: '代表任务' });
    expect((await store.getBaseline('proc-1', 'skill-task'))!.kind).toBe('skill-task');
    expect((await store.getBaseline('proc-1', 'process'))!.kind).toBe('process'); // 互不覆盖
  });

  it('list() 全量 + list(kind) 过滤', async () => {
    const store = new BaselineStore({ root: await tmpRoot('omb-base-3-') });
    await store.registerBaseline({ ...BASELINE, kind: 'process' });
    await store.registerBaseline({ ...BASELINE, id: 'sk-1', kind: 'skill-task' });
    await store.registerBaseline({ ...BASELINE, id: 'pol-1', kind: 'policy-regression' });
    expect(await store.list()).toHaveLength(3);
    expect((await store.list('skill-task')).map((b) => b.id)).toEqual(['sk-1']);
    expect((await store.list('projection-rebuild'))).toEqual([]);
  });

  it('原子写：tmp+rename 后原文件存在且无 .tmp 残留', async () => {
    const root = await tmpRoot('omb-base-atomic-');
    const store = new BaselineStore({ root });
    await store.registerBaseline(BASELINE);
    const files = await readdir(join(root, 'baselines'));
    expect(files.filter((f) => f.endsWith('.json'))).toHaveLength(1);
    expect(files.filter((f) => f.endsWith('.tmp'))).toHaveLength(0);
  });
});

// ---- ③ 任务库 ----

describe('③ 任务库（TaskStore）', () => {
  it('注册/取回/覆写/清单；文件不存在 → null', async () => {
    const store = new TaskStore({ root: await tmpRoot('omb-task-1-') });
    expect(await store.getTask('task:1')).toBeNull();
    const task: TaskRecord = {
      task_id: 'task:1',
      contract_ref: 'contract:repair',
      success_criteria: ['结构合法', '可执行'],
      verifier_refs: ['repair:skill:deterministic'],
    };
    await store.registerTask(task);
    expect(await store.getTask('task:1')).toEqual(task);
    expect(await store.list()).toHaveLength(1);
    await store.registerTask({ ...task, success_criteria: ['新标准'] });
    expect((await store.getTask('task:1'))!.success_criteria).toEqual(['新标准']);
    expect(await store.list()).toHaveLength(1); // 覆写不新增
  });

  it('原子写：tmp+rename 后原文件存在且无 .tmp 残留', async () => {
    const root = await tmpRoot('omb-task-atomic-');
    const store = new TaskStore({ root });
    await store.registerTask({ task_id: 'task:a', contract_ref: 'c', success_criteria: [], verifier_refs: [] });
    const files = await readdir(join(root, 'tasks'));
    expect(files.filter((f) => f.endsWith('.json'))).toHaveLength(1);
    expect(files.filter((f) => f.endsWith('.tmp'))).toHaveLength(0);
  });
});

// ---- ④ 损坏 JSON → fail-loud 抛错（与 debt.json 同风格） ----

/** 记录文件路径（与 supervisor/verification-stores.ts fileKey 同源：复合键 sha256 hex） */
function recordFile(compositeKey: string): string {
  return `${createHash('sha256').update(compositeKey, 'utf8').digest('hex')}.json`;
}

describe('④ 损坏 JSON → fail-loud 抛错', () => {
  it('facts：目录内坏文件 → all()/factsFor() 抛错（message 含 corrupt）', async () => {
    const root = await tmpRoot('omb-corrupt-facts-');
    const store = new FactStore({ root });
    await mkdir(join(root, 'facts'), { recursive: true });
    await writeFile(join(root, 'facts', recordFile('claim:dead')), 'not json{', 'utf8');
    await expect(store.all()).rejects.toThrow(/corrupt/);
    await expect(store.factsFor({})).rejects.toThrow(/corrupt/);
  });

  it('baselines：目录内坏文件 → list() 抛错；getBaseline 命中自身坏文件 → 抛错', async () => {
    const root = await tmpRoot('omb-corrupt-base-');
    const store = new BaselineStore({ root });
    await mkdir(join(root, 'baselines'), { recursive: true });
    await writeFile(join(root, 'baselines', recordFile('process\u0000x')), '{"broken":', 'utf8');
    await expect(store.list()).rejects.toThrow(/corrupt/);
    await expect(store.getBaseline('x', 'process')).rejects.toThrow(/corrupt/);
    // 无关键（文件不存在）→ null（不读坏文件）
    expect(await store.getBaseline('y', 'process')).toBeNull();
  });

  it('tasks：目录内坏文件 → list() 抛错；getTask 命中自身坏文件 → 抛错', async () => {
    const root = await tmpRoot('omb-corrupt-task-');
    const store = new TaskStore({ root });
    await mkdir(join(root, 'tasks'), { recursive: true });
    await writeFile(join(root, 'tasks', recordFile('task:dead')), '[[[', 'utf8');
    await expect(store.list()).rejects.toThrow(/corrupt/);
    await expect(store.getTask('task:dead')).rejects.toThrow(/corrupt/);
  });
});

// ---- ⑤ 写失败降级（尽力而为——注册面缺失不阻塞验证主链） ----

describe('⑤ 写失败降级记录不抛', () => {
  it('注入坏路径（facts 子目录被文件占用）→ registerFact 不抛 + degraded 记录', async () => {
    const root = await tmpRoot('omb-badpath-facts-');
    await writeFile(join(root, 'facts'), 'not a dir', 'utf8'); // 占位文件 → mkdir 失败
    const store = new FactStore({ root });
    await expect(
      store.registerFact({ id: 'claim:1', text: 't', provenance: 'p', valid: true }),
    ).resolves.toBeUndefined();
    expect(store.degraded).toContain('写入失败');
  });

  it('注入坏路径（baselines 子目录被文件占用）→ registerBaseline 不抛 + degraded 记录', async () => {
    const root = await tmpRoot('omb-badpath-base-');
    await writeFile(join(root, 'baselines'), 'not a dir', 'utf8');
    const store = new BaselineStore({ root });
    await expect(
      store.registerBaseline({
        id: 'x',
        kind: 'process',
        input: null,
        environment_fingerprint: {},
        runtime_snapshot: 'rs:x',
        expected_result: null,
        verifier_version: '1',
      }),
    ).resolves.toBeUndefined();
    expect(store.degraded).toContain('写入失败');
  });

  it('注入坏路径（tasks 子目录被文件占用）→ registerTask 不抛 + degraded 记录', async () => {
    const root = await tmpRoot('omb-badpath-task-');
    await writeFile(join(root, 'tasks'), 'not a dir', 'utf8');
    const store = new TaskStore({ root });
    await expect(
      store.registerTask({ task_id: 't', contract_ref: 'c', success_criteria: [], verifier_refs: [] }),
    ).resolves.toBeUndefined();
    expect(store.degraded).toContain('写入失败');
  });
});

// ---- ⑥ 确定性 ----

describe('⑥ 确定性：同注册序列 → 同读取结果', () => {
  it('facts 两次注册同序列 → deep equal', async () => {
    const mk = async (): Promise<FactStore> => new FactStore({ root: await tmpRoot('omb-det-facts-') });
    const seq = async (s: FactStore): Promise<FactRecord[]> => {
      await s.registerFact({ id: 'c1', text: '一', provenance: 'p1', valid: true });
      await s.registerFact({ id: 'c2', text: '二', provenance: 'p2', valid: false });
      return s.all();
    };
    expect(await seq(await mk())).toEqual(await seq(await mk()));
  });

  it('baselines 两次注册同序列 → deep equal（版本化字段全量）', async () => {
    const mk = async (): Promise<BaselineStore> => new BaselineStore({ root: await tmpRoot('omb-det-base-') });
    const seq = async (s: BaselineStore): Promise<BaselineRecord[]> => {
      await s.registerBaseline({
        id: 'b1',
        kind: 'process',
        input: { in: 1 },
        environment_fingerprint: { os: 'win32', node: 'v22' },
        runtime_snapshot: 'rs:1',
        expected_result: { verdict: 'PASS' },
        verifier_version: '1',
      });
      return s.list();
    };
    expect(await seq(await mk())).toEqual(await seq(await mk()));
  });

  it('tasks 两次注册同序列 → deep equal', async () => {
    const mk = async (): Promise<TaskStore> => new TaskStore({ root: await tmpRoot('omb-det-task-') });
    const seq = async (s: TaskStore): Promise<TaskRecord[]> => {
      await s.registerTask({ task_id: 't1', contract_ref: 'c', success_criteria: ['s'], verifier_refs: ['v'] });
      return s.list();
    };
    expect(await seq(await mk())).toEqual(await seq(await mk()));
  });
});

// ---- ⑦ 聚合工厂（createVerificationStores 返回四库——含验证器注册库；专项 3 适配） ----

describe('⑦ 聚合工厂 createVerificationStores 返回四库（含 verifiers）', () => {
  it('返回 facts/baselines/tasks/verifiers 且 verifiers 可用（注册/取回）', async () => {
    const stores = createVerificationStores(await tmpRoot('omb-aggregate-'));
    expect(stores.facts).toBeInstanceOf(FactStore);
    expect(stores.baselines).toBeInstanceOf(BaselineStore);
    expect(stores.tasks).toBeInstanceOf(TaskStore);
    expect(stores.verifiers).toBeInstanceOf(VerifierStore);
    expect(await stores.verifiers.listVerifiers()).toEqual([]);
    await stores.verifiers.registerVerifier({
      verifier_id: 'v:1',
      spec: { checks: ['结构合法'], blind_spots: [] },
      validation_benchmark: 'bench:1',
      independent_test_set: 'its:1',
      version: '1',
      registered_at: 1_700_000_000_000,
    });
    expect((await stores.verifiers.getVerifier('v:1'))!.version).toBe('1');
  });
});
