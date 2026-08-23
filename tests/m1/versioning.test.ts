// T1.6 行为测试：Runtime Snapshot（请求级锁定，架构 §11.2 / §4.2 M5 / 施工计划 T1.6）。
// 覆盖：哈希确定性（同输入同输出 / 不同 gitRevision、组件值 → 不同哈希）、
// createSnapshot 产出 M5 schema 合规（components 六键、id=sha256、immutable、created 时间戳）、
// SnapshotRegistry 请求级锁定（请求 A 全程 v7 / promote v8 / 请求 B 从 v8 / end 后新请求 v8）、
// 未绑定 get fail-loud、重复 begin 幂等、promote 后旧请求全部结束 registry 状态一致、
// resolveSnapshot（未绑定 → 绑定 current；已绑定 → 全程同一快照）、输入校验 fail-loud。
import { describe, expect, it } from 'vitest';
import { RuntimeSnapshotSchema, type RuntimeSnapshot } from '../../kernel/schemas/m.js';
import {
  computeRuntimeSnapshotHash,
  createSnapshot,
  SnapshotRegistry,
  type ComponentHashes,
} from '../../supervisor/versioning.js';

/** 合法组件 sha256 清单（六键 64-hex）；over 覆盖单个键（非法值用于输入校验测试） */
function hashes(over: Partial<ComponentHashes> = {}): ComponentHashes {
  return {
    scheduler: '11'.repeat(32),
    memory: '22'.repeat(32),
    verifier: '33'.repeat(32),
    renderer: '44'.repeat(32),
    capability: '55'.repeat(32),
    philosophy: '66'.repeat(32),
    ...over,
  };
}

/** git_revision（M0 loader：40 位 commit hash 语义，T0.3） */
const REV7 = '7'.repeat(40);
const REV8 = '8'.repeat(40);
const v7 = () => createSnapshot({ components: hashes(), gitRevision: REV7 });
const v8 = () => createSnapshot({ components: hashes(), gitRevision: REV8 });

describe('哈希确定性（§11.2 RuntimeSnapshotHash = sha256(组件 sha256 清单 + git_revision)）', () => {
  it('同输入同输出；不同 gitRevision / 组件值 → 不同哈希', () => {
    const h1 = computeRuntimeSnapshotHash(hashes(), REV7);
    expect(computeRuntimeSnapshotHash(hashes(), REV7)).toBe(h1);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(computeRuntimeSnapshotHash(hashes(), REV8)).not.toBe(h1);
    expect(computeRuntimeSnapshotHash(hashes({ scheduler: 'aa'.repeat(32) }), REV7)).not.toBe(h1);
  });
});

describe('createSnapshot（M5 schema 合规，§4.2）', () => {
  it('产出符合 M5 schema：components 六键齐全、id=sha256、immutable、created 时间戳', () => {
    const snap = createSnapshot({ components: hashes(), gitRevision: REV7 });
    const parsed = RuntimeSnapshotSchema.safeParse(snap);
    expect(parsed.success).toBe(true);
    expect(snap.components).toEqual(hashes());
    expect(snap.id).toBe(`sha256:${computeRuntimeSnapshotHash(hashes(), REV7)}`);
    expect(snap.immutable).toBe(true);
    expect(Number.isNaN(Date.parse(snap.created))).toBe(false);
    expect(snap.created).toBe(snap.updated);
    // 内容寻址：改组件值 → 新 id（§4.1 不可变对象 改 = 新 id）
    expect(createSnapshot({ components: hashes({ memory: 'bb'.repeat(32) }), gitRevision: REV7 }).id).not.toBe(snap.id);
  });

  it('taskContractRef 提供时写入 task_contract_ref', () => {
    const snap = createSnapshot({ components: hashes(), gitRevision: REV7, taskContractRef: 'tc:1' });
    expect(snap.task_contract_ref).toBe('tc:1');
  });
});

describe('SnapshotRegistry 请求级锁定（§11.2：请求开始解析快照，整个请求只读该快照，晋升只影响后续请求）', () => {
  it('请求 A 全程 v7；promote(v8) 后请求 B 从 v8；A end 后再 begin → v8', () => {
    const registry = new SnapshotRegistry(v7());
    const a = registry.begin('req-A');
    expect(a.id).toBe(v7().id);

    registry.promote(v8());
    // 中途晋升不影响进行中请求 A
    expect(registry.get('req-A').id).toBe(v7().id);

    // 新请求 B 从最新快照 v8
    const b = registry.begin('req-B');
    expect(b.id).toBe(v8().id);

    // A end 后新请求 → v8
    registry.end('req-A');
    expect(registry.begin('req-A').id).toBe(v8().id);
  });

  it('未绑定请求 get → fail-loud', () => {
    const registry = new SnapshotRegistry(v7());
    expect(() => registry.get('req-ghost')).toThrow(/未绑定/);
  });

  it('重复 begin 同请求幂等：返回同一快照对象', () => {
    const registry = new SnapshotRegistry(v7());
    const first = registry.begin('req-A');
    expect(registry.begin('req-A')).toBe(first);
  });

  it('promote 后旧请求全部结束 → registry 状态一致（无活跃绑定，新请求从 v8）', () => {
    const registry = new SnapshotRegistry(v7());
    registry.begin('req-A');
    registry.begin('req-B');
    registry.promote(v8());
    registry.end('req-A');
    registry.end('req-B');
    expect(registry.activeCount()).toBe(0);
    expect(registry.begin('req-C').id).toBe(v8().id);
  });

  it('resolveSnapshot：未绑定 → 绑定 current；已绑定 → 全程同一快照', () => {
    const registry = new SnapshotRegistry(v7());
    expect(registry.resolveSnapshot({ id: 'req-X' }, { current: v7() }).id).toBe(v7().id);
    registry.promote(v8());
    // 中途晋升：已绑定请求 resolve 仍为 v7（请求级锁定）
    expect(registry.resolveSnapshot({ id: 'req-X' }, { current: v8() }).id).toBe(v7().id);
    // 新请求 resolve → v8
    expect(registry.resolveSnapshot({ id: 'req-Y' }, { current: v8() }).id).toBe(v8().id);
  });

  it('promote 非法快照 → fail-loud（registry 状态不被污染）', () => {
    const registry = new SnapshotRegistry(v7());
    expect(() => registry.promote({} as RuntimeSnapshot)).toThrow();
    // 晋升失败后 registry 仍可用且未切换
    expect(registry.begin('req-A').id).toBe(v7().id);
  });
});

describe('输入校验（fail-loud）', () => {
  it('components 缺键 → fail-loud（消息含缺失键名）', () => {
    const bad = { ...hashes() } as Partial<ComponentHashes>;
    delete bad.scheduler;
    expect(() => createSnapshot({ components: bad as ComponentHashes, gitRevision: REV7 })).toThrow(/scheduler/);
  });

  it('components 非法 hash 格式 → fail-loud', () => {
    expect(() => createSnapshot({ components: hashes({ philosophy: 'not-a-sha256' }), gitRevision: REV7 })).toThrow(
      /sha256|64/,
    );
    expect(() => computeRuntimeSnapshotHash(hashes({ memory: 'zz' }), REV7)).toThrow(/sha256|64/);
  });

  it('gitRevision 空 → fail-loud', () => {
    expect(() => createSnapshot({ components: hashes(), gitRevision: '' })).toThrow();
  });
});

describe('按线哈希（P1b：提交级运行时快照——线 commit + 目录内容哈希入哈希，§6.5.7/D1⑤）', () => {
  /** 线快照哈希输入（缺省：stable 线 + 40-hex commit + 64-hex 内容哈希） */
  function lineInput(over: Record<string, string> = {}): { line: string; commit: string; dirContentHash: string } {
    return {
      line: 'stable',
      commit: 'a'.repeat(40),
      dirContentHash: 'cc'.repeat(32),
      ...over,
    };
  }

  it('同线同 commit 同内容 → 同哈希（确定性）；不同 commit / 线名 / 目录内容 → 不同哈希', () => {
    const h1 = computeRuntimeSnapshotHash(hashes(), REV7, lineInput());
    expect(computeRuntimeSnapshotHash(hashes(), REV7, lineInput())).toBe(h1);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    // 不同线 commit → 不同哈希（D1⑤：请求运行于「线 stable + commit a81f + 快照 rs:7c91」）
    expect(computeRuntimeSnapshotHash(hashes(), REV7, lineInput({ commit: 'b'.repeat(40) }))).not.toBe(h1);
    // 不同线名 → 不同哈希
    expect(computeRuntimeSnapshotHash(hashes(), REV7, lineInput({ line: 'latest' }))).not.toBe(h1);
    // 不同目录内容哈希（policy/processes 实际文件内容）→ 不同哈希
    expect(computeRuntimeSnapshotHash(hashes(), REV7, lineInput({ dirContentHash: 'dd'.repeat(32) }))).not.toBe(h1);
    // 组件 / gitRevision 变化 → 不同哈希（既有语义保持）
    expect(computeRuntimeSnapshotHash(hashes({ memory: 'bb'.repeat(32) }), REV7, lineInput())).not.toBe(h1);
    expect(computeRuntimeSnapshotHash(hashes(), REV8, lineInput())).not.toBe(h1);
  });

  it('未提供 line → 既有实现哈希（向后兼容：组件清单 + gitRevision）', () => {
    expect(computeRuntimeSnapshotHash(hashes(), REV7)).toBe(computeRuntimeSnapshotHash(hashes(), REV7));
    // 带 line 的哈希 ≠ 不带 line（线信息确实参与哈希）
    expect(computeRuntimeSnapshotHash(hashes(), REV7)).not.toBe(computeRuntimeSnapshotHash(hashes(), REV7, lineInput()));
  });

  it('createSnapshot 带 line → id 与按线哈希一致（内容寻址纳入线 commit；改线 commit = 新 id）', () => {
    const snap = createSnapshot({ components: hashes(), gitRevision: REV7, line: lineInput() });
    expect(snap.id).toBe(`sha256:${computeRuntimeSnapshotHash(hashes(), REV7, lineInput())}`);
    const other = createSnapshot({
      components: hashes(),
      gitRevision: REV7,
      line: lineInput({ commit: 'b'.repeat(40) }),
    });
    expect(other.id).not.toBe(snap.id);
  });

  it('line 输入非法 → fail-loud（dirContentHash 非 sha256 / commit 空 / line 空）', () => {
    expect(() => computeRuntimeSnapshotHash(hashes(), REV7, lineInput({ dirContentHash: 'zz' }))).toThrow(/sha256|64/);
    expect(() => computeRuntimeSnapshotHash(hashes(), REV7, lineInput({ commit: '' }))).toThrow(/commit/);
    expect(() => createSnapshot({ components: hashes(), gitRevision: REV7, line: lineInput({ line: '' }) })).toThrow(
      /line/,
    );
  });
});
