// P7 Predictive Invalidation 最小落地测试（设计 §14.5 环境变化主动触发器 + 实现规格 §15.4
// CapabilityDecayRecord 字段级 + kernel/environment-fingerprint.ts 指纹 diff 纯函数 +
// runtime/assembly.ts environment_check 维护任务）。
// 严格 TDD：本文件先于实现编写并确认失败（功能缺失）。
// 覆盖：
//   ① diffFingerprints 纯函数：字段变化 → delta 列表（键序确定性）；无变化 → 空；可选键 gpu/cuda
//   ② buildCapabilityDecayRecord 纯函数：diff 非空 → §15.4 字段级记录；diff 空 → null（不动作）
//   ③ environment_check：首次检查建立基线不动作；无变化不动作；环境变化 → CapabilityDecayRecord 落盘
//      .evolution/decay/<ts>.json + 受影响对象重新验证入队（repair 债务）；再变化 → 第二条记录
//   ④ 跨重启接续：新 runtime 实例读最近 decay 记录指纹为基线（有变化才记录）
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Fingerprint } from '../../kernel/schemas/base.js';
import {
  buildCapabilityDecayRecord,
  collectEnvironmentFingerprint,
  diffFingerprints,
} from '../../kernel/environment-fingerprint.js';
import { createCognitiveRuntime } from '../../runtime/assembly.js';
import { MaintenanceScheduler } from '../../supervisor/maintenance.js';

// ---- 测试工具 ----

const roots: string[] = [];
const schedulers: MaintenanceScheduler[] = [];
const runtimes: Array<{ close(): Promise<void> }> = [];

async function tmpRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'omb-p7-env-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const rt of runtimes.splice(0)) {
    await rt.close();
  }
  for (const s of schedulers.splice(0)) {
    s.stop();
  }
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

function mkScheduler(root: string): MaintenanceScheduler {
  const s = new MaintenanceScheduler({ debtFile: join(root, '.omb', '.evolution', 'debt.json') });
  schedulers.push(s);
  return s;
}

function trackRuntime(rt: ReturnType<typeof createCognitiveRuntime>): ReturnType<typeof createCognitiveRuntime> {
  runtimes.push(rt);
  return rt;
}

/** 变化指纹夹具（m8 同款 ENV 形状） */
const FP_BASE: Fingerprint = { os: 'test', node: 'v22.0.0', dsh_version: '0.8.0', project: 'omb-v2' };

// ---- ① 指纹 diff 纯函数 ----

describe('① diffFingerprints 纯函数（§4.4 Fingerprint 字段比较 → delta 列表）', () => {
  it('字段变化 → delta 列表（固定键序 os/node/dsh_version/project/gpu/cuda）；无变化 → 空对象', () => {
    const before: Fingerprint = { os: 'win32', node: 'v22.0.0', dsh_version: '0.8.0', project: 'omb-v2' };
    const after: Fingerprint = { os: 'win32', node: 'v24.0.0', dsh_version: '0.8.0', project: 'omb-v2' };
    const delta = diffFingerprints(before, after);
    expect(delta).toEqual({ node: { from: 'v22.0.0', to: 'v24.0.0' } });
    expect(Object.keys(delta)).toEqual(['node']); // 键序确定性（仅变化字段，固定字段序）
    expect(diffFingerprints(before, { ...before })).toEqual({});
  });

  it('多字段变化 + 可选键（gpu/cuda）参与 diff；undefined 侧如实记录', () => {
    const before: Fingerprint = { os: 'win32', node: 'v22', dsh_version: '0.7.0', project: 'omb-v2' };
    const after: Fingerprint = { os: 'win32', node: 'v24', dsh_version: '0.8.0', project: 'omb-v2', gpu: 'RTX' };
    const delta = diffFingerprints(before, after);
    expect(delta).toEqual({
      node: { from: 'v22', to: 'v24' },
      dsh_version: { from: '0.7.0', to: '0.8.0' },
      gpu: { from: undefined, to: 'RTX' },
    });
    expect(Object.keys(delta)).toEqual(['node', 'dsh_version', 'gpu']); // 固定字段序
  });
});

// ---- ② §15.4 记录构造纯函数 ----

describe('② buildCapabilityDecayRecord 纯函数（§15.4 字段级）', () => {
  it('diff 非空 → 字段级记录（environment_delta/affected_objects/regression_set/capability_vector/attribution）', () => {
    const before: Fingerprint = { os: 'win32', node: 'v22', dsh_version: '0.8.0', project: 'omb-v2' };
    const after: Fingerprint = { os: 'win32', node: 'v24', dsh_version: '0.8.0', project: 'omb-v2' };
    const delta = diffFingerprints(before, after);
    const rec = buildCapabilityDecayRecord({
      before,
      after,
      delta,
      affected_objects: [
        { id: 'exp:1', kind: 'experience' },
        { id: 'proc:2', kind: 'process' },
      ],
      ts: 1700000000000,
    });
    expect(rec).not.toBeNull();
    expect(rec!.ts).toBe(1700000000000);
    expect(rec!.environment_delta).toEqual({ node: { from: 'v22', to: 'v24' } });
    expect(rec!.affected_objects).toEqual([
      { id: 'exp:1', kind: 'experience' },
      { id: 'proc:2', kind: 'process' },
    ]);
    expect(rec!.regression_set).toEqual(['exp:1', 'proc:2']); // 最小回归子集 = 受影响对象 id
    expect(rec!.capability_vector_before).toEqual({ overall: 1 });
    expect(rec!.capability_vector_after.overall).toBeLessThan(1); // 能力衰减（×0.8^Δ）
    expect(rec!.capability_vector_after.overall).toBeCloseTo(0.8);
    expect(rec!.attribution['exp:1']).toEqual({ node: expect.any(Number) }); // 对象 → 维度 delta
    expect(rec!.fingerprint_before).toEqual(before);
    expect(rec!.fingerprint_after).toEqual(after);
  });

  it('diff 空 → null（不动作）', () => {
    const fp: Fingerprint = { os: 'win32', node: 'v22', dsh_version: '0.8.0', project: 'omb-v2' };
    expect(
      buildCapabilityDecayRecord({ before: fp, after: { ...fp }, delta: {}, affected_objects: [] }),
    ).toBeNull();
  });
});

// ---- ③ environment_check 维护任务（runtime 集成） ----

describe('③ environment_check：首次建基线不动作 → 无变化不动作 → 变化触发记录 + repair 债务入队', () => {
  it('full 流程：建立基线 → 无变化不动作 → 环境变化 → 衰减记录落盘 + 重新验证入队（repair）→ 再变化第二条记录', async () => {
    const root = await tmpRoot();
    const scheduler = mkScheduler(root);
    let fp: Fingerprint = { ...FP_BASE };
    const runtime = trackRuntime(
      createCognitiveRuntime({ root, maintenance: scheduler, environmentFingerprint: () => fp }),
    );

    // 首次检查：建立基线，不动作（无历史可比）
    expect(await runtime.runEnvironmentCheck()).toBeNull();
    expect(scheduler.debtSnapshot()).toEqual([]); // 基线建立不产生债务

    // 无变化：不动作（无记录、无债务）
    expect(await runtime.runEnvironmentCheck()).toBeNull();
    expect(scheduler.debtSnapshot()).toEqual([]);

    // 环境变化（node 版本）→ 衰减记录 + 落盘 + repair 债务入队
    fp = { ...fp, node: 'v24.0.0' };
    const rec = await runtime.runEnvironmentCheck();
    expect(rec).not.toBeNull();
    expect(rec!.environment_delta).toEqual({ node: { from: 'v22.0.0', to: 'v24.0.0' } });
    // 落盘 .evolution/decay/<ts>.json
    const decayDir = join(root, '.evolution', 'decay');
    const files = await readdir(decayDir);
    expect(files).toHaveLength(1);
    const onDisk = JSON.parse(await readFile(join(decayDir, files[0]!), 'utf8')) as {
      environment_delta: Record<string, unknown>;
      affected_objects: unknown[];
    };
    expect(onDisk.environment_delta).toEqual(rec!.environment_delta);
    expect(onDisk.affected_objects).toEqual([]); // 最小实现：无环境声明索引 → 空（记录 delta + 重新验证入队）
    // 受影响对象重新验证入队（repair 债务；§14.5 局部重验证）
    const debt = scheduler.debtSnapshot();
    const repair = debt.find((d) => d.task_id === 'repair');
    expect(repair).toBeDefined();
    expect(repair!.value).toBe(20); // §10.1 repair 权重

    // 再变化 → 第二条记录（基线已推进）
    fp = { ...fp, node: 'v26.0.0' };
    const rec2 = await runtime.runEnvironmentCheck();
    expect(rec2?.environment_delta.node).toEqual({ from: 'v24.0.0', to: 'v26.0.0' });
    expect(await readdir(decayDir)).toHaveLength(2);
  });

  it('跨重启接续：新 runtime 读最近 decay 记录指纹为基线——环境未再变 → 不动作；再变 → 记录', async () => {
    const root = await tmpRoot();
    const scheduler1 = mkScheduler(root);
    let fp: Fingerprint = { ...FP_BASE };
    const rt1 = trackRuntime(
      createCognitiveRuntime({ root, maintenance: scheduler1, environmentFingerprint: () => fp }),
    );
    await rt1.runEnvironmentCheck(); // 基线（v22）
    fp = { ...fp, node: 'v24.0.0' };
    await rt1.runEnvironmentCheck(); // 变化 → 落盘（fingerprint_after = v24）
    await rt1.close();

    // 新进程（新 runtime、新 scheduler）：基线从 decay 落盘接续（v24）
    const scheduler2 = mkScheduler(root);
    const rt2 = trackRuntime(
      createCognitiveRuntime({ root, maintenance: scheduler2, environmentFingerprint: () => fp }),
    );
    expect(await rt2.runEnvironmentCheck()).toBeNull(); // 当前仍 v24 == 落盘基线 → 不动作
    const decayDir = join(root, '.evolution', 'decay');
    expect(await readdir(decayDir)).toHaveLength(1); // 无新记录
    // 环境再变 → 新记录（基线来自落盘而非空）
    fp = { ...fp, node: 'v28.0.0' };
    const rec = await rt2.runEnvironmentCheck();
    expect(rec?.environment_delta.node).toEqual({ from: 'v24.0.0', to: 'v28.0.0' });
    expect(await readdir(decayDir)).toHaveLength(2);
  });
});

// ---- ④ 采集器 ----

describe('④ collectEnvironmentFingerprint（运行时采集，缺省覆盖）', () => {
  it('返回 schema 合规指纹（os/node 来自运行时；dsh_version/project 可覆盖）', () => {
    const fp = collectEnvironmentFingerprint();
    expect(typeof fp.os).toBe('string');
    expect(fp.os.length).toBeGreaterThan(0);
    expect(fp.node).toBe(process.version);
    expect(fp.dsh_version).toBe('0.1.0'); // 缺省（与 supervisor 运行时默认指纹同源）
    expect(fp.project).toBe('omb-v2');
    const over = collectEnvironmentFingerprint({ dsh_version: '9.9.9', project: 'custom' });
    expect(over.dsh_version).toBe('9.9.9');
    expect(over.project).toBe('custom');
  });
});
