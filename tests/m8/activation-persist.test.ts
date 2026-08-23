// T8.7 行为测试：Activation 幂等持久化 + 事件入链（supervisor/activation.ts）。
// 进程内 Map → 文件持久化（tmp+rename：completed/ 完成记录 + pending/ 切换前标记）；
// activation/committed 事件写入 Event Store（修复 P7 事实源断链）；
// T5.5 评审 Minor 1（crash-window retry hazard）：pending 标记 + rollback 断言 current head == contract.candidate。
// 验收（brief）：重复 activation_id 幂等（重启后仍幂等）；重启可恢复（新实例加载持久化日志）；
// 事件可重建激活历史（EventStore 重读 → 激活序列一致）。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type EvolutionObject, type RuntimeSnapshot } from '../../kernel/schemas/m.js';
import type { Fingerprint } from '../../kernel/schemas/base.js';
import type { CapabilityVector } from '../../runtime/evaluator.js';
import { activate, resetActivationLog, rollback, type ActivationDeps } from '../../supervisor/activation.js';
import { loadCompleted } from '../../supervisor/activation-log.js';
import type { CandidateRecord } from '../../supervisor/candidates.js';
import { SnapshotRegistry, createSnapshot, type ComponentHashes } from '../../supervisor/versioning.js';

const ENV: Fingerprint = { os: 'test', node: 'v24', dsh_version: '0.8.0', project: 'omb-v2' };
const COMPONENTS: ComponentHashes = {
  scheduler: 'a'.repeat(64), memory: 'b'.repeat(64), verifier: 'c'.repeat(64),
  renderer: 'd'.repeat(64), capability: 'e'.repeat(64), philosophy: 'f'.repeat(64),
};

let seq = 0;
function nextId(): string {
  return `sha256:${String(seq++).padStart(64, '0')}`;
}

function mkRec(over: Partial<CandidateRecord> = {}): CandidateRecord {
  return {
    id: nextId(), kind: 'process', status: 'untrusted', parent: null, lineage: [],
    gates_passed: ['G1', 'G2'], created: Date.now(), provenance: 'test/t8.7', ...over,
  };
}

function mkSnapshot(gitRevision: string): RuntimeSnapshot {
  return createSnapshot({ components: COMPONENTS, gitRevision });
}

const OK_VECTOR: CapabilityVector = {
  id: 'vector:00000000-0000-4000-8000-000000000001',
  target: 'sha256:t',
  facts: [{ dimension: 'correctness', value: 0.9, signal_sources: ['L2_statistical'], evidence_refs: [], sample_size: 30 }],
  classification: 'Stable',
  classification_confidence: 0,
  environment: ENV,
  created: 0,
  provenance: { source: 'test', events: [] },
};

interface Harness {
  deps: ActivationDeps;
  switched: string[];
  written: EvolutionObject[];
  events: unknown[];
  currentHead: string;
}

function mkDeps(over: Partial<ActivationDeps> = {}): Harness {
  const h: Harness = { deps: {} as ActivationDeps, switched: [], written: [], events: [], currentHead: 'head-A' };
  h.deps = {
    switchStableHead: async (candidateHash: string) => {
      h.switched.push(candidateHash);
      const previous = h.currentHead;
      h.currentHead = candidateHash;
      return { previous, new: candidateHash };
    },
    writeEvolutionObject: async (o: EvolutionObject) => {
      h.written.push(o);
    },
    snapshotRegistry: new SnapshotRegistry(mkSnapshot('rev-initial')),
    nextSnapshot: () => mkSnapshot('rev-activated'),
    evaluate: () => OK_VECTOR,
    classify: (v: CapabilityVector) => v.classification,
    checkLineage: () => ({ ok: true }),
    currentStableHead: () => h.currentHead,
    eventStore: {
      append: async (e: unknown) => {
        h.events.push(e);
      },
    },
    ...over,
  };
  return h;
}

function activateInput(activation_id: string, logDir: string | undefined, h: Harness) {
  return {
    activation_id,
    candidate: mkRec(),
    evidence_certificate: `cert/${activation_id}`,
    activation_scope: 'Project',
    compatible_schema: 'omb/2.0',
    baseline: OK_VECTOR,
    deps: h.deps,
    ...(logDir !== undefined ? { logDir } : {}),
  };
}

describe('T8.7 Activation 幂等持久化 + 事件入链', () => {
  let base: string;
  let logDir: string;

  beforeEach(async () => {
    seq = 0;
    resetActivationLog();
    base = await mkdtemp(join(tmpdir(), 'omb-t87-'));
    logDir = join(base, 'activations');
    await mkdir(logDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('重复 activation_id 幂等（重启后仍幂等）：同 id 二次 activate → no-op（switch 不被再调），契约一致', async () => {
    const h = mkDeps();
    const input = activateInput('idem-persist', logDir, h);
    const c1 = await activate(input);
    expect(h.switched).toHaveLength(1);

    // 模拟重启：清空进程内幂等注册表 → 持久化日志是唯一权威
    resetActivationLog();
    const c2 = await activate(input);
    expect(c2).toEqual(c1); // 契约一致（磁盘恢复）
    expect(h.switched).toHaveLength(1); // switch 未被再调（幂等）
    expect(h.written).toHaveLength(1); // evo 未重复写
  });

  it('重启可恢复：新实例（全新 deps + 磁盘日志）加载完成记录 → 返回同一契约且不重放 switch', async () => {
    const h1 = mkDeps();
    const input = activateInput('restart-recover', logDir, h1);
    const c1 = await activate(input);

    // "新进程"：全新 harness（switch 记录独立）+ 同 logDir（完成记录从磁盘恢复）
    const h2 = mkDeps();
    resetActivationLog();
    const c2 = await activate(activateInput('restart-recover', logDir, h2));
    expect(c2.id).toBe(c1.id);
    expect(h2.switched).toHaveLength(0); // 新实例未重放 switch
    expect(h2.written).toHaveLength(0);
  });

  it('事件入链：activation/committed 写入 Event Store（payload 含 activation_id/candidate/predecessor/rollback_snapshot）', async () => {
    const h = mkDeps();
    const input = activateInput('event-chain', logDir, h);
    const contract = await activate(input);

    expect(h.events).toHaveLength(1);
    const evt = h.events[0] as { type: string; payload: Record<string, unknown> };
    expect(evt.type).toBe('activation/committed');
    expect(evt.payload).toMatchObject({
      activation_id: 'event-chain',
      candidate: input.candidate.id,
      predecessor: 'head-A',
      rollback_snapshot: contract.rollback_snapshot,
    });
  });

  it('事件可重建激活历史：两次激活（不同 id）→ 事件序列与激活顺序一致', async () => {
    const h = mkDeps();
    await activate(activateInput('hist-1', logDir, h));
    await activate(activateInput('hist-2', logDir, h));

    const types = h.events.map((e) => (e as { type: string }).type);
    expect(types).toEqual(['activation/committed', 'activation/committed']);
    const ids = h.events.map((e) => (e as { payload: { activation_id: string } }).payload.activation_id);
    expect(ids).toEqual(['hist-1', 'hist-2']);
  });

  it('crash-window retry（T5.5 Minor 1）：pending 标记 + current head == candidate → 恢复完成（switch 不再执行，剩余步骤补齐）', async () => {
    // 模拟上次尝试：pending 已写、切换已完成（head == candidate）、完成记录缺失（崩溃窗口）
    const h = mkDeps();
    const cand = 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
    h.currentHead = cand; // 崩溃后 head 停在候选
    await mkdir(join(logDir, 'pending'), { recursive: true });
    await writeFile(
      join(logDir, 'pending', 'crash-1.json'),
      JSON.stringify({ activation_id: 'crash-1', candidate: cand, predecessor: 'head-A', rollback_snapshot: 'rs:prev', started_at: Date.now() }),
      'utf8',
    );

    const contract = await activate({
      ...activateInput('crash-1', logDir, h),
      candidate: mkRec({ id: cand }),
    });

    // 不重复 switch（切换已在崩溃前完成）
    expect(h.switched).toHaveLength(0);
    // 完成记录补齐：evo 写入 + 事件入链 + predecessor 为崩溃前 head
    expect(h.written).toHaveLength(1);
    expect(h.events).toHaveLength(1);
    expect(contract.predecessor).toBe('head-A');
    expect(existsSync(join(logDir, 'completed', 'crash-1.json'))).toBe(true);
  });

  it('crash-window retry：pending 存在但 current head != candidate（未切换）→ 清理 pending 从头执行（switch 正常执行）', async () => {
    const h = mkDeps();
    const cand = 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';
    h.currentHead = 'head-other'; // 未切换
    await mkdir(join(logDir, 'pending'), { recursive: true });
    await writeFile(
      join(logDir, 'pending', 'crash-2.json'),
      JSON.stringify({ activation_id: 'crash-2', candidate: cand, predecessor: 'head-A', rollback_snapshot: 'rs:prev', started_at: Date.now() }),
      'utf8',
    );

    const contract = await activate({ ...activateInput('crash-2', logDir, h), candidate: mkRec({ id: cand }) });

    expect(h.switched).toEqual([cand]); // 重新执行完整流程（switch 被调）
    expect(contract.predecessor).toBe('head-other'); // 切换前 head（当前实际）
    expect(existsSync(join(logDir, 'pending', 'crash-2.json'))).toBe(false); // pending 已清理
    expect(existsSync(join(logDir, 'completed', 'crash-2.json'))).toBe(true);
  });

  it('rollback 断言（T5.5 Minor 1）：current head != contract.candidate → fail-loud（不盲目回退）', async () => {
    const h = mkDeps();
    const contract = await activate(activateInput('rb-assert', logDir, h));
    h.currentHead = 'diverged-head'; // 已分叉（如已被其它激活覆盖）

    await expect(
      rollback(contract, { switchStableHead: h.deps.switchStableHead, currentStableHead: () => h.currentHead }),
    ).rejects.toThrow(/head|候选|断言|不一致/);
    expect(h.switched).toHaveLength(1); // 未发生回退切换
  });

  it('rollback 断言通过：current head == contract.candidate → 切回 predecessor', async () => {
    const h = mkDeps();
    const contract = await activate(activateInput('rb-ok', logDir, h));
    // head 仍在 candidate（切换后未变）
    const res = await rollback(contract, { switchStableHead: h.deps.switchStableHead, currentStableHead: () => h.currentHead });
    expect(res.new).toBe(contract.predecessor);
    expect(h.switched.at(-1)).toBe(contract.predecessor);
  });

  it('无 logDir（纯内存）行为保持：幂等仍生效（进程内 Map，m5 语义）', async () => {
    const h = mkDeps();
    const input = activateInput('mem-only', undefined, h);
    const c1 = await activate(input);
    const c2 = await activate(input);
    expect(c2).toEqual(c1);
    expect(h.switched).toHaveLength(1);
  });

  it('logDir 不存在 → 首次写入成功（目录递归自动创建：completed/ 与 pending/）', async () => {
    // 本用例不用 describe 级 logDir（beforeEach 已预先 mkdir）——新建独立临时根，logDir 不预创建
    const freshBase = await mkdtemp(join(tmpdir(), 'omb-t87-fresh-'));
    try {
      const freshLogDir = join(freshBase, 'nested', 'activations'); // 深层路径整体不存在
      expect(existsSync(freshLogDir)).toBe(false);

      const h = mkDeps();
      const contract = await activate(activateInput('fresh-dir-1', freshLogDir, h));

      // 完成记录落盘成功（目录被原子写递归创建）+ pending 已清空（完成路径）
      expect(existsSync(join(freshLogDir, 'completed', 'fresh-dir-1.json'))).toBe(true);
      expect(existsSync(join(freshLogDir, 'pending', 'fresh-dir-1.json'))).toBe(false);
      // 磁盘恢复一致：重新加载返回同一契约（目录创建后的幂等权威）
      expect(loadCompleted(freshLogDir, 'fresh-dir-1')?.id).toBe(contract.id);
    } finally {
      await rm(freshBase, { recursive: true, force: true });
    }
  });
});
