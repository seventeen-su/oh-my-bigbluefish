// T1.5 行为测试：Working Memory Checkpoint（架构 §4.2 M7 / §5.2 / §11.3 事务模型）。
// 覆盖（brief 7 项 + 补充）：save/restore 往返、latest/list 时间倒序、损坏拒绝（篡改 state 内容 hash 不匹配 /
//   删 hash 结构损坏 / 篡改 working_state 引用自洽失败）、半写恢复（tmp 残留不影响 list/restore，只认正式文件）、
//   重复 save 同状态不同 id、restore 不存在 fail-loud、list 跳过损坏文件（§11.3 恢复 = 上次完好 checkpoint）。
// fixture：mkdtemp 临时 dir（不动真实 workspace，CONVENTIONS §6）。
// 契约（主会话裁决）：保存的 state 来自带 initial 的完整回放（schema 合规）；checkpoint 自身 hash 与 state 自洽即可。
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Event } from '../../kernel/schemas/m.js';
import type { State } from '../../kernel/schemas/s.js';
import { makeMutableId } from '../../kernel/schemas/base.js';
import { reduce } from '../../supervisor/state-reducer.js';
import { latest, list, restore, save } from '../../supervisor/checkpoint.js';
import { PROV, S2_VALID, TS } from './ir-samples.js';

const dirs: string[] = [];

async function tmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'omb-checkpoint-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** M3 Event 工厂（checkpoint 测试最小集：claim/update 驱动一次 reduce） */
function evt(type: string, payload: Record<string, unknown> = {}): Event {
  return {
    ir_version: '2.0',
    id: makeMutableId('evt'),
    schema: 'omb/M3',
    scope: 'Project',
    lifecycle: 'active',
    immutable: false,
    owner: 'kernel',
    created: TS,
    updated: TS,
    provenance: PROV,
    refs: [],
    type: type as Event['type'],
    session_id: 'sess-1',
    runtime_snapshot: 'rs:1',
    parent_event: null,
    causality: undefined,
    payload,
    timestamp: TS,
  };
}

/** schema 合规 State：带 initial 的完整回放（契约提示；reduce 输出 world/self 由 initial 提供，非 null） */
function makeState(): State {
  const { state } = reduce(
    [{ ...evt('claim/update', { claim_id: 'c:1', text: 'IR 定义完整', epistemic: 'supported', confidence: 0.8 }) }],
    { initial: S2_VALID as unknown as State },
  );
  return state as unknown as State;
}

/** checkpoint 落盘文件名（uuid 尾段 + .json；Windows 文件名不允许 ':'，checkpoint: 前缀剥离） */
function fileOf(dir: string, cpId: string): string {
  return join(dir, `${cpId.slice('checkpoint:'.length)}.json`);
}

describe('save 落盘', () => {
  it('返回 Checkpoint（hash 64hex、timestamp 可解析、working_state 引用 state.id）且文件落盘含完整 state', async () => {
    const dir = await tmpDir();
    const state = makeState();
    const cp = await save(state, { dir });

    expect(cp.id).toMatch(/^checkpoint:[0-9a-f-]{36}$/);
    expect(cp.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(Number.isNaN(Date.parse(cp.timestamp))).toBe(false);
    expect(Math.abs(Date.now() - Date.parse(cp.timestamp))).toBeLessThan(60_000);
    expect(cp.working_state).toBe(state.id);
    expect(cp.runtime_snapshot).toBe('rs:1');
    expect(cp.schema).toBe('omb/M7');

    // 文件落盘：<dir>/<uuid>.json；tmp 已 rename 不残留
    const file = fileOf(dir, cp.id);
    expect(existsSync(file)).toBe(true);
    expect(existsSync(`${file}.tmp`)).toBe(false);
    const onDisk = JSON.parse(readFileSync(file, 'utf8')) as {
      hash: string;
      state: State;
      working_state: string;
    };
    expect(onDisk.state).toEqual(state);
    expect(onDisk.hash).toBe(cp.hash);
    expect(onDisk.working_state).toBe(state.id);
  });

  it('dir 不存在时自动创建（mkdtemp 语义之外）', async () => {
    const dir = await tmpDir();
    const nested = join(dir, 'a', 'b');
    const cp = await save(makeState(), { dir: nested });
    expect(existsSync(fileOf(nested, cp.id))).toBe(true);
  });
});

describe('save + restore 往返', () => {
  it('restore(id) → 与 save 前 State 深度一致（JSON 相等）', async () => {
    const dir = await tmpDir();
    const state = makeState();
    const cp = await save(state, { dir });

    const restored = await restore(cp.id, { dir });
    expect(restored).toEqual(state);
    expect(restored.working.confirmed_facts).toEqual(['f:1', 'c:1']);
  });

  it('restore 幂等：重复调用结果一致', async () => {
    const dir = await tmpDir();
    const state = makeState();
    const cp = await save(state, { dir });

    const a = await restore(cp.id, { dir });
    const b = await restore(cp.id, { dir });
    expect(a).toEqual(b);
  });
});

describe('latest / list（按时间倒序）', () => {
  it('多 checkpoint 按时间倒序；latest 返回最后保存的', async () => {
    const dir = await tmpDir();
    const c1 = await save(makeState(), { dir });
    await new Promise((r) => setTimeout(r, 15));
    const c2 = await save(makeState(), { dir });
    await new Promise((r) => setTimeout(r, 15));
    const c3 = await save(makeState(), { dir });

    const all = await list({ dir });
    expect(all.map((c) => c.id)).toEqual([c3.id, c2.id, c1.id]);
    const times = all.map((c) => Date.parse(c.timestamp));
    expect(times[0]).toBeGreaterThan(times[1] as number);
    expect(times[1]).toBeGreaterThan(times[2] as number);

    const last = await latest({ dir });
    expect(last).not.toBeNull();
    expect(last!.id).toBe(c3.id);
    expect(last!.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('空 dir → list 为空、latest 为 null', async () => {
    const dir = await tmpDir();
    expect(await list({ dir })).toEqual([]);
    expect(await latest({ dir })).toBeNull();
  });
});

describe('损坏拒绝（§11.3）', () => {
  it('篡改落盘 state 内容 → restore 抛错（hash 不匹配）', async () => {
    const dir = await tmpDir();
    const state = makeState();
    const cp = await save(state, { dir });

    const file = fileOf(dir, cp.id);
    const obj = JSON.parse(readFileSync(file, 'utf8')) as { state: State };
    obj.state.working.confirmed_facts = ['tampered'];
    writeFileSync(file, JSON.stringify(obj), 'utf8');

    await expect(restore(cp.id, { dir })).rejects.toThrow(/hash 校验失败|损坏|篡改/);
  });

  it('删除 hash 字段 → restore 抛错（结构损坏）', async () => {
    const dir = await tmpDir();
    const cp = await save(makeState(), { dir });

    const file = fileOf(dir, cp.id);
    const obj = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    delete obj.hash;
    writeFileSync(file, JSON.stringify(obj), 'utf8');

    await expect(restore(cp.id, { dir })).rejects.toThrow(/结构损坏|缺失|损坏/);
  });

  it('篡改 working_state 引用（与 state.id 不一致）→ restore 抛错（自洽失败）', async () => {
    const dir = await tmpDir();
    const state = makeState();
    const cp = await save(state, { dir });

    const file = fileOf(dir, cp.id);
    const obj = JSON.parse(readFileSync(file, 'utf8')) as { working_state: string };
    obj.working_state = 'state:00000000-0000-4000-8000-000000000000';
    writeFileSync(file, JSON.stringify(obj), 'utf8');

    await expect(restore(cp.id, { dir })).rejects.toThrow(/自洽|不一致/);
  });

  it('list 跳过损坏文件，latest 返回上次完好 checkpoint（§11.3 恢复语义）', async () => {
    const dir = await tmpDir();
    const c1 = await save(makeState(), { dir });
    await new Promise((r) => setTimeout(r, 15));
    const c2 = await save(makeState(), { dir });

    const file = fileOf(dir, c2.id);
    const obj = JSON.parse(readFileSync(file, 'utf8')) as { state: State };
    obj.state.working.goal = 'tampered-goal';
    writeFileSync(file, JSON.stringify(obj), 'utf8');

    const all = await list({ dir });
    expect(all.map((c) => c.id)).toEqual([c1.id]);
    const last = await latest({ dir });
    expect(last!.id).toBe(c1.id);
    await expect(restore(c2.id, { dir })).rejects.toThrow();
  });
});

describe('半写恢复（tmp 残留，防半写）', () => {
  it('残留 <uuid>.json.tmp 不影响 list/restore（只认正式文件）', async () => {
    const dir = await tmpDir();
    const state = makeState();
    const cp = await save(state, { dir });

    // 模拟崩溃残留：<id>.tmp 写一半未 rename
    await writeFile(`${fileOf(dir, cp.id)}.tmp`, '{"hash":"partial', 'utf8');

    const all = await list({ dir });
    expect(all).toHaveLength(1);
    expect(all[0]!.id).toBe(cp.id);
    expect(await restore(cp.id, { dir })).toEqual(state);
  });

  it('只有 tmp 残留的 dir → list 空、latest null、restore 报不存在', async () => {
    const dir = await tmpDir();
    await writeFile(join(dir, '11111111-1111-4111-8111-111111111111.json.tmp'), 'partial', 'utf8');
    await writeFile(join(dir, 'random-file.txt'), 'x', 'utf8');

    expect(await list({ dir })).toEqual([]);
    expect(await latest({ dir })).toBeNull();
    await expect(
      restore('checkpoint:11111111-1111-4111-8111-111111111111', { dir }),
    ).rejects.toThrow(/不存在/);
  });
});

describe('重复 save 与 fail-loud', () => {
  it('同状态重复 save → 不同 checkpoint id（uuid 语义）', async () => {
    const dir = await tmpDir();
    const state = makeState();
    const c1 = await save(state, { dir });
    const c2 = await save(state, { dir });

    expect(c1.id).not.toBe(c2.id);
    expect((await list({ dir })).map((c) => c.id)).toEqual([c2.id, c1.id]);
    expect(await restore(c2.id, { dir })).toEqual(state);
  });

  it('restore 不存在的 id → fail-loud 抛错', async () => {
    const dir = await tmpDir();
    await expect(
      restore('checkpoint:11111111-1111-4111-8111-111111111111', { dir }),
    ).rejects.toThrow(/不存在/);
  });

  it('restore 非法 id 格式 → fail-loud 抛错', async () => {
    const dir = await tmpDir();
    await expect(restore('bogus', { dir })).rejects.toThrow(/非法/);
    await expect(restore('state:11111111-1111-4111-8111-111111111111', { dir })).rejects.toThrow(/非法/);
  });
});
