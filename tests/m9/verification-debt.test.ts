// S2（2026-08-25-verification-contract 第二阶段裁决 S2）：验证债务队列测试（supervisor/verification-debt.ts）。
// 覆盖：
//   ① enqueue：建文件/status=pending/attempts=0/字段保留（kind/contract_id/object_ref/materials）
//   ② 同 key 覆写去重（最新观测胜出——单条）
//   ③ 上限淘汰：DEBT_CAP=500 超限 → 淘汰最旧（created_at 最小者出队，新记录保留）
//   ④ markResolved / markPendingManual（非 pending 不动作）/ bumpAttempts（返回新 attempts；非 pending → null）
//   ⑤ 损坏行跳过（审计日志语义——坏行不杀队列）
//   ⑥ 持久化：新实例读同一文件（构造零 I/O）
//   ⑦ 原子写：tmp+rename 后无 .tmp 残留；写失败降级记录不抛
import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEBT_CAP, VerificationDebt, type VerificationDebtRecord } from '../../supervisor/verification-debt.js';

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

function debtFile(root: string): string {
  return join(root, 'debt.jsonl');
}

/** 读 JSONL 全量记录（测试断言面） */
async function readDebt(root: string): Promise<VerificationDebtRecord[]> {
  const raw = await readFile(debtFile(root), 'utf8');
  return raw
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as VerificationDebtRecord);
}

/** 直接种子写入（超限淘汰测试用——避开逐条 enqueue 的 O(n²) 重写） */
async function seedDebt(root: string, records: VerificationDebtRecord[]): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(debtFile(root), records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

function rec(over: Partial<VerificationDebtRecord> = {}): VerificationDebtRecord {
  return {
    key: `shadow:s-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'shadow',
    contract_id: 'shadow:s-1',
    materials: { goal: 'g' },
    created_at: Date.now(),
    attempts: 0,
    status: 'pending',
    ...over,
  };
}

describe('① enqueue（建队列/字段保留）', () => {
  it('空目录 → enqueue 建 debt.jsonl；status=pending/attempts=0/字段全保留', async () => {
    const root = await tmpRoot('omb-debt-1-');
    const debt = new VerificationDebt({ root });
    await debt.enqueue({
      key: 'shadow:s-1',
      kind: 'shadow',
      contract_id: 'shadow:s-1',
      object_ref: 'obj-1',
      materials: { goal: '目标', success_criteria: ['标准'] },
    });
    const all = await readDebt(root);
    expect(all).toHaveLength(1);
    expect(all[0]!.key).toBe('shadow:s-1');
    expect(all[0]!.kind).toBe('shadow');
    expect(all[0]!.contract_id).toBe('shadow:s-1');
    expect(all[0]!.object_ref).toBe('obj-1');
    expect(all[0]!.status).toBe('pending');
    expect(all[0]!.attempts).toBe(0);
    expect(all[0]!.materials).toEqual({ goal: '目标', success_criteria: ['标准'] });
    expect(typeof all[0]!.created_at).toBe('number');
  });
});

describe('② 同 key 覆写去重', () => {
  it('同 key 二次 enqueue → 单条，最新 materials 胜出', async () => {
    const root = await tmpRoot('omb-debt-2-');
    const debt = new VerificationDebt({ root });
    await debt.enqueue({ key: 'shadow:s-1', kind: 'shadow', contract_id: 'c1', materials: { v: 1 } });
    await debt.enqueue({ key: 'shadow:s-1', kind: 'shadow', contract_id: 'c1', materials: { v: 2 } });
    const all = await readDebt(root);
    expect(all).toHaveLength(1);
    expect(all[0]!.materials).toEqual({ v: 2 });
  });

  it('不同 key 共存（shadow/repair 独立条目）', async () => {
    const root = await tmpRoot('omb-debt-2b-');
    const debt = new VerificationDebt({ root });
    await debt.enqueue({ key: 'shadow:s-1', kind: 'shadow', contract_id: 'c1', materials: {} });
    await debt.enqueue({ key: 'repair:o-1', kind: 'repair', contract_id: 'c2', object_ref: 'o-1', materials: {} });
    expect(await readDebt(root)).toHaveLength(2);
    expect(await debt.listPending()).toHaveLength(2);
  });

  it('listPending 最老优先（created_at 升序——确定性：同毫秒按 key 稳定排序）', async () => {
    const root = await tmpRoot('omb-debt-2c-');
    await seedDebt(root, [
      rec({ key: 'shadow:c', created_at: 3 }),
      rec({ key: 'shadow:a', created_at: 1 }),
      rec({ key: 'shadow:b', created_at: 2 }),
      rec({ key: 'shadow:a-dup', created_at: 1 }), // 同毫秒 → key 字典序（a < a-dup < b < c）
    ]);
    const debt = new VerificationDebt({ root });
    expect((await debt.listPending()).map((r) => r.key)).toEqual(['shadow:a', 'shadow:a-dup', 'shadow:b', 'shadow:c']);
    expect((await debt.listPending(2)).map((r) => r.key)).toEqual(['shadow:a', 'shadow:a-dup']); // limit 截断
  });
});

describe('③ 上限淘汰（DEBT_CAP=500 超限淘汰最旧）', () => {
  it('种子 500 条 + enqueue 1 条 → 淘汰 created_at 最小者，新记录保留', async () => {
    const root = await tmpRoot('omb-debt-3-');
    const seeded: VerificationDebtRecord[] = [];
    for (let i = 1; i <= DEBT_CAP; i++) {
      seeded.push(rec({ key: `shadow:seed-${i}`, created_at: i }));
    }
    await seedDebt(root, seeded);
    const debt = new VerificationDebt({ root });
    await debt.enqueue({ key: 'shadow:newest', kind: 'shadow', contract_id: 'c-new', materials: {} });
    const all = await readDebt(root);
    expect(all).toHaveLength(DEBT_CAP); // 500 条上限
    expect(all.some((r) => r.key === 'shadow:seed-1')).toBe(false); // 最旧被淘汰
    expect(all.some((r) => r.key === 'shadow:newest')).toBe(true); // 新记录保留
    expect(all.some((r) => r.key === 'shadow:seed-500')).toBe(true); // 较新种子保留
  });
});

describe('④ 状态流转：markResolved / markPendingManual / bumpAttempts', () => {
  it('markResolved：resolution 落盘（verdict/judge_used/ts）；不存在 key → false 不动作', async () => {
    const root = await tmpRoot('omb-debt-4-');
    const debt = new VerificationDebt({ root });
    await debt.enqueue({ key: 'shadow:s-1', kind: 'shadow', contract_id: 'c1', materials: {} });
    const ok = await debt.markResolved('shadow:s-1', { verdict: 'PASS', judge_used: true, ts: 123 });
    expect(ok).toBe(true);
    const all = await readDebt(root);
    expect(all[0]!.status).toBe('resolved');
    expect(all[0]!.resolution).toEqual({ verdict: 'PASS', judge_used: true, ts: 123 });
    expect(await debt.listPending()).toHaveLength(0);
    expect(await debt.markResolved('no-such', { verdict: 'PASS' })).toBe(false);
  });

  it('markPendingManual：pending → pending_manual（resolution.detail 审计）；非 pending 不动作', async () => {
    const root = await tmpRoot('omb-debt-4b-');
    const debt = new VerificationDebt({ root });
    await debt.enqueue({ key: 'shadow:s-1', kind: 'shadow', contract_id: 'c1', materials: {} });
    expect(await debt.markPendingManual('shadow:s-1', 'judge 不可用')).toBe(true);
    const all = await readDebt(root);
    expect(all[0]!.status).toBe('pending_manual');
    expect(all[0]!.resolution!.detail).toBe('judge 不可用');
    // 已转人工 → 再次标记不动作（false）
    expect(await debt.markPendingManual('shadow:s-1', 'again')).toBe(false);
    expect((await readDebt(root))[0]!.resolution!.detail).toBe('judge 不可用');
    expect(await debt.markPendingManual('no-such', 'x')).toBe(false);
  });

  it('bumpAttempts：pending 递增并返回新 attempts（last_attempt_at 更新）；非 pending/不存在 → null', async () => {
    const root = await tmpRoot('omb-debt-4c-');
    const debt = new VerificationDebt({ root });
    await debt.enqueue({ key: 'shadow:s-1', kind: 'shadow', contract_id: 'c1', materials: {} });
    expect(await debt.bumpAttempts('shadow:s-1')).toBe(1);
    expect(await debt.bumpAttempts('shadow:s-1')).toBe(2);
    const all = await readDebt(root);
    expect(all[0]!.attempts).toBe(2);
    expect(typeof all[0]!.last_attempt_at).toBe('number');
    await debt.markResolved('shadow:s-1', { verdict: 'PASS' });
    expect(await debt.bumpAttempts('shadow:s-1')).toBeNull(); // 已 resolved → 不递增
    expect(await debt.bumpAttempts('no-such')).toBeNull();
  });
});

describe('⑤ 损坏行跳过（审计日志语义）', () => {
  it('坏 JSON/形状不合规行跳过——listPending 只返回合法记录；enqueue 重写后坏行清除', async () => {
    const root = await tmpRoot('omb-debt-5-');
    const good = rec({ key: 'shadow:good', created_at: 1 });
    await seedDebt(root, [
      { ...rec({ key: 'shadow:bad-json' }), created_at: 0 } as unknown as VerificationDebtRecord,
    ]);
    await writeFile(debtFile(root), 'not-json-line\n{"key": "x", "status": "pending"}\n' + JSON.stringify(good) + '\n', 'utf8');
    const debt = new VerificationDebt({ root });
    const pending = await debt.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.key).toBe('shadow:good');
    // enqueue 全量重写 → 损坏行被清除（审计：坏行留给运维，队列不因此死亡）
    await debt.enqueue({ key: 'shadow:new', kind: 'shadow', contract_id: 'c', materials: {} });
    const all = await readDebt(root);
    expect(all).toHaveLength(2);
    expect(all.map((r) => r.key).sort()).toEqual(['shadow:good', 'shadow:new']);
  });
});

describe('⑥ 持久化', () => {
  it('新实例读同一文件（构造零 I/O；跨实例状态一致）', async () => {
    const root = await tmpRoot('omb-debt-6-');
    const a = new VerificationDebt({ root });
    await a.enqueue({ key: 'shadow:s-1', kind: 'shadow', contract_id: 'c1', materials: { goal: 'g' } });
    await a.markResolved('shadow:s-1', { verdict: 'FAIL', judge_used: true, ts: 9 });
    const b = new VerificationDebt({ root });
    expect(await b.listPending()).toHaveLength(0);
    const all = await readDebt(root);
    expect(all[0]!.status).toBe('resolved');
    expect(all[0]!.resolution!.verdict).toBe('FAIL');
  });
});

describe('⑦ 原子写与写失败降级', () => {
  it('enqueue 后无 .tmp 残留（tmp+rename 原子写）', async () => {
    const root = await tmpRoot('omb-debt-7-');
    const debt = new VerificationDebt({ root });
    await debt.enqueue({ key: 'shadow:s-1', kind: 'shadow', contract_id: 'c1', materials: {} });
    const files = await readdir(root);
    expect(files.filter((f) => f.endsWith('.tmp'))).toHaveLength(0);
    expect(files).toContain('debt.jsonl');
  });

  it('写失败降级记录不抛（坏路径：debt.jsonl 被目录占用 → degraded 非空，enqueue 不崩）', async () => {
    const root = await tmpRoot('omb-debt-7b-');
    // 占位：让 debt.jsonl 路径成为一个目录 → rename(tmp, dir) 失败
    await mkdir(debtFile(root), { recursive: true });
    const debt = new VerificationDebt({ root });
    await expect(debt.enqueue({ key: 'shadow:s-1', kind: 'shadow', contract_id: 'c1', materials: {} })).resolves.toBeUndefined();
    expect(debt.degraded).not.toBeNull();
  });
});
