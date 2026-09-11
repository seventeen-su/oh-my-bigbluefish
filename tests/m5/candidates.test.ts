// T5.1 行为测试：候选信任池与污染隔离（supervisor/candidates.ts，架构 §9.3 / P11）。
// 严格 TDD：本文件先于实现编写并确认失败（功能缺失）。
// 覆盖（brief 测试清单 1-8）：
//   ① registerCandidate 默认 untrusted 落 untrusted/ 区（含 payload 物化）
//   ② 谱系检查：parent 链含 untrusted 祖先 → 拒绝；全链 trusted → 通过；祖先缺失 → 拒绝
//   ③ promote 未过谱系 → 拒绝（不落 trusted/）
//   ④ 消费方守卫三路径（Generator 检索 / Consolidator 输入 / Skill 生成参考）拒绝 untrusted（验收核心）
//   ⑤ trusted 候选被消费 → 放行
//   ⑥ 新候选父版本检查：以 untrusted 候选为 parent 注册 → 拒绝（G1 强制）
//   ⑦ 撤销：promote 后 revoke → 状态回 untrusted + 后代 re-suspect（后代 assertTrusted 抛错）
//   ⑧ 目录契约：rejected/ 留痕（含 reason）；trusted/ 消费方只读（OS 只读属性写被拒 + 守卫层读路径零写入）
// 另附：真实 .evolution 布局只读冒烟（可选；布局未落地时自动 skip——真实布局被 gitignore，CI 可能缺失）。
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CandidatePool, candidateDirName, type CandidateRecord } from '../../supervisor/candidates.js';
// 只读机制是否真约束本进程（root + 权限位时不约束 → 相关断言跳过而非误判失败）
import { readOnlyEnforced } from '../helpers/sandbox-scripts.js';

// ---- 测试工具 ----

let seq = 0;
/** 确定性候选 id（sha256:<64hex>，与 M5 Evolution Object id 同风格） */
function nextId(): string {
  return `sha256:${String(seq++).padStart(64, '0')}`;
}

/** CandidateRecord 工厂（缺省：process / untrusted / 无父 / 空谱系） */
function mkRec(over: Partial<CandidateRecord> = {}): CandidateRecord {
  return {
    id: nextId(),
    kind: 'process',
    status: 'untrusted',
    parent: null,
    lineage: [],
    gates_passed: [],
    created: Date.now(),
    provenance: 'test/fixture',
    ...over,
  };
}

/** 消费方路径仿真（§9.3：未可信候选绝对不能成为 ① 记忆整理输入 ② 过程生成参考 ③ Skill 生成参考）。
 *  三类消费方共享统一守卫入口 assertTrusted——untrusted → fail-loud。 */
function generatorRetrieval(pool: CandidatePool, rec: CandidateRecord): void {
  // ② 过程生成参考：Generator 检索候选作为生成参考
  pool.assertTrusted(rec);
}
function consolidatorInput(pool: CandidatePool, rec: CandidateRecord): void {
  // ① 记忆整理输入：Consolidator 把候选作为整理输入
  pool.assertTrusted(rec);
}
function skillReference(pool: CandidatePool, rec: CandidateRecord): void {
  // ③ Skill 生成参考：Skill 生成器引用候选
  pool.assertTrusted(rec);
}

/** 目录树快照（相对路径 + 完整内容，排序）；用于"消费方读路径零写入"断言 */
async function snapshotTree(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(p);
      } else {
        out.push(`${p}:${await readFile(p, 'utf8')}`);
      }
    }
  }
  await walk(root);
  return out.sort();
}

// ---- 真实 .evolution 只读冒烟（可选：布局存在才跑） ----

const REAL_EVO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'workspace', '.omb', '.evolution');

describe.skipIf(!existsSync(REAL_EVO))('真实 .evolution 布局只读冒烟（T0.2 产物）', () => {
  it('candidates/ 工作树区存在且 README 可读', async () => {
    expect(existsSync(join(REAL_EVO, 'candidates'))).toBe(true);
    const readme = await readFile(join(REAL_EVO, 'README.md'), 'utf8');
    expect(readme).toContain('candidates');
  });
});

// ---- 主测试：候选信任池与污染隔离 ----

describe('候选信任池与污染隔离（§9.3 / P11，supervisor/candidates.ts）', () => {
  let evo: string; // 临时 .evolution 根
  let pool: CandidatePool;

  /** 记录区文件路径（目录名经 Windows 安全映射 candidateDirName） */
  const zoneFile = (zone: string, id: string, file = ''): string =>
    join(evo, zone, candidateDirName(id), file);

  beforeEach(async () => {
    const base = await mkdtemp(join(tmpdir(), 'omb-candidates-'));
    evo = join(base, '.evolution');
    await mkdir(evo, { recursive: true });
    pool = new CandidatePool(evo);
    seq = 0;
  });

  afterEach(async () => {
    await rm(dirname(evo), { recursive: true, force: true });
  });

  it('① registerCandidate 默认 untrusted 落 untrusted/ 区（调用方自称更高状态也强制）', async () => {
    const r = mkRec({ id: nextId(), kind: 'skill', status: 'semantic' }); // 调用方自称 semantic
    await pool.registerCandidate(r, 'skill 内容物化 payload');
    // 落 untrusted/ 区，status 被强制为 untrusted
    const onDisk = JSON.parse(await readFile(zoneFile('untrusted', r.id, 'record.json'), 'utf8')) as CandidateRecord;
    expect(onDisk.status).toBe('untrusted');
    expect(onDisk.kind).toBe('skill');
    expect(onDisk.provenance).toBe('test/fixture');
    // payload 物化
    expect(await readFile(zoneFile('untrusted', r.id, 'payload.txt'), 'utf8')).toBe('skill 内容物化 payload');
    // 未落 trusted/ 或 rejected/
    expect(existsSync(zoneFile('trusted', r.id))).toBe(false);
    expect(existsSync(zoneFile('rejected', r.id))).toBe(false);
  });

  it('② 谱系检查：parent 链含 untrusted 祖先 → 拒绝；全链 trusted → 通过；祖先缺失 → 拒绝', async () => {
    const A = mkRec();
    await pool.registerCandidate(A);
    // A 未可信：以 A 为父的候选谱系不通过
    const bad = await pool.checkLineage(mkRec({ parent: A.id }));
    expect(bad.ok).toBe(false);
    expect(bad.reason).toContain(A.id);

    await pool.promote(mkRec({ id: A.id }));
    // A 已 trusted：直接父通过
    const good = await pool.checkLineage(mkRec({ parent: A.id }));
    expect(good.ok).toBe(true);

    // 深链：B 以 A 为父（A trusted）→ B 的谱系也通过
    const B = mkRec({ parent: A.id, lineage: [A.id] });
    await pool.registerCandidate(B);
    await pool.promote(mkRec({ id: B.id }));
    const deep = await pool.checkLineage(mkRec({ parent: B.id, lineage: [A.id, B.id] }));
    expect(deep.ok).toBe(true);

    // 祖先缺失：父候选不存在 → 拒绝（G1）
    const missing = await pool.checkLineage(mkRec({ parent: 'sha256:deadbeef'.padEnd(72, '0') }));
    expect(missing.ok).toBe(false);
    expect(missing.reason).toContain('不存在');

    // 撤销 A → B 谱系不再通过（祖先回 untrusted）
    await pool.revoke(A.id);
    const afterRevoke = await pool.checkLineage(mkRec({ parent: A.id, lineage: [A.id] }));
    expect(afterRevoke.ok).toBe(false);
    expect(afterRevoke.reason).toContain(A.id);
  });

  it('③ promote 未过谱系 → 拒绝（不落 trusted/，原候选保持 untrusted）', async () => {
    // 现实路径：父先 trusted，子注册后父被撤销 → 子 promote 时谱系已失效
    const A = mkRec();
    await pool.registerCandidate(A);
    await pool.promote(mkRec({ id: A.id }));
    const B = mkRec({ parent: A.id, lineage: [A.id] });
    await pool.registerCandidate(B); // 注册时父 trusted → 通过
    await pool.revoke(A.id); // 父被撤销 → B re-suspect

    await expect(pool.promote(mkRec({ id: B.id }))).rejects.toThrow(/谱系|untrusted|G1/);
    expect(existsSync(zoneFile('trusted', B.id))).toBe(false);
    // 原候选仍在 untrusted/ 且状态未被污染为 trusted
    const bDisk = JSON.parse(await readFile(zoneFile('untrusted', B.id, 'record.json'), 'utf8')) as CandidateRecord;
    expect(bDisk.status).toBe('untrusted');

    // 未注册候选 promote → fail-loud
    await expect(pool.promote(mkRec({ id: nextId() }))).rejects.toThrow(/未注册|不存在/);
  });

  it('④ 消费方守卫：Generator 检索 / Consolidator 输入 / Skill 生成参考引用 untrusted → 全部拒绝（验收核心）', async () => {
    const U = mkRec({ id: nextId(), kind: 'memory' });
    await pool.registerCandidate(U);
    const recU = await pool.load(U.id); // 消费方从池取记录
    expect(recU.status).toBe('untrusted');

    const consumers: Array<[string, (p: CandidatePool, r: CandidateRecord) => void]> = [
      ['Generator 检索（过程生成参考）', generatorRetrieval],
      ['Consolidator 输入（记忆整理输入）', consolidatorInput],
      ['Skill 生成参考', skillReference],
    ];
    for (const [name, consume] of consumers) {
      expect(() => consume(pool, recU), `${name} 应拒绝 untrusted 候选`).toThrow(/assertTrusted|untrusted|未可信/);
    }
  });

  it('⑤ trusted 候选被消费 → 三消费方均放行（不抛错）', async () => {
    const T = mkRec();
    await pool.registerCandidate(T, 'trusted payload');
    await pool.promote(mkRec({ id: T.id }));
    const recT = await pool.load(T.id);
    expect(recT.status).toBe('trusted');
    // payload 随晋升物化到 trusted/
    expect(await readFile(zoneFile('trusted', T.id, 'payload.txt'), 'utf8')).toBe('trusted payload');
    // 未落 untrusted/
    expect(existsSync(zoneFile('untrusted', T.id))).toBe(false);

    expect(() => generatorRetrieval(pool, recT)).not.toThrow();
    expect(() => consolidatorInput(pool, recT)).not.toThrow();
    expect(() => skillReference(pool, recT)).not.toThrow();
  });

  it('⑥ 新候选父版本检查：以 untrusted 候选为 parent 注册 → 拒绝（G1 强制，不落盘）', async () => {
    const U = mkRec();
    await pool.registerCandidate(U); // untrusted 根候选
    const child = mkRec({ parent: U.id });
    await expect(pool.registerCandidate(child)).rejects.toThrow(/谱系|untrusted|G1/);
    expect(existsSync(zoneFile('untrusted', child.id))).toBe(false);
    expect(existsSync(zoneFile('trusted', child.id))).toBe(false);

    // 对照：父已 trusted → 注册放行，谱系自动记录
    const T = mkRec();
    await pool.registerCandidate(T);
    await pool.promote(mkRec({ id: T.id }));
    const okChild = mkRec({ parent: T.id });
    await pool.registerCandidate(okChild);
    const onDisk = JSON.parse(await readFile(zoneFile('untrusted', okChild.id, 'record.json'), 'utf8')) as CandidateRecord;
    expect(onDisk.parent).toBe(T.id);
    expect(onDisk.lineage).toEqual([T.id, okChild.id]); // 谱系自动派生 root..self
  });

  it('⑦ 撤销：promote 后 revoke → 状态回 untrusted + 后代 re-suspect（后代 assertTrusted 抛错）', async () => {
    // 链：A(根) → B → C，全部晋升
    const A = mkRec();
    await pool.registerCandidate(A);
    await pool.promote(mkRec({ id: A.id }));
    const B = mkRec({ parent: A.id, lineage: [A.id] });
    await pool.registerCandidate(B);
    await pool.promote(mkRec({ id: B.id }));
    const C = mkRec({ parent: B.id, lineage: [A.id, B.id] });
    await pool.registerCandidate(C);
    await pool.promote(mkRec({ id: C.id }));

    const { affected } = await pool.revoke(A.id);
    expect(affected).toContain(A.id);
    expect(affected).toContain(B.id);
    expect(affected).toContain(C.id);

    // 三代全部回 untrusted 并移出 trusted/
    for (const id of [A.id, B.id, C.id]) {
      const rec = await pool.load(id);
      expect(rec.status).toBe('untrusted');
      expect(existsSync(zoneFile('trusted', id))).toBe(false);
      expect(existsSync(zoneFile('untrusted', id))).toBe(true);
    }
    // 后代 re-suspect：消费方守卫抛错
    const b = await pool.load(B.id);
    const c = await pool.load(C.id);
    expect(() => pool.assertTrusted(b)).toThrow(/assertTrusted|untrusted|未可信/);
    expect(() => pool.assertTrusted(c)).toThrow(/assertTrusted|untrusted|未可信/);
    // 被撤销对象本身也不再可被消费
    const a = await pool.load(A.id);
    expect(() => pool.assertTrusted(a)).toThrow();

    // 撤销未晋升对象 → fail-loud（不静默）
    await expect(pool.revoke(A.id)).rejects.toThrow(/未晋升|untrusted/);
  });

  it('⑧ 目录契约：rejected/ 留痕（含 reason）；trusted/ 消费方只读', async () => {
    // —— rejected/ 留痕 ——
    const R = mkRec();
    await pool.registerCandidate(R);
    await pool.reject(mkRec({ id: R.id }), '谱系验证失败：父候选未可信');
    const rejectedRec = JSON.parse(await readFile(zoneFile('rejected', R.id, 'record.json'), 'utf8')) as CandidateRecord;
    expect(rejectedRec.status).toBe('rejected');
    expect(await readFile(zoneFile('rejected', R.id, 'reason.txt'), 'utf8')).toContain('谱系验证失败');
    expect(existsSync(zoneFile('untrusted', R.id))).toBe(false); // 已移出 untrusted/

    // 已晋升对象走 reject → fail-loud（撤销必须走 revoke，防止静默绕过 trust 语义）
    const T = mkRec();
    await pool.registerCandidate(T);
    await pool.promote(mkRec({ id: T.id }));
    await expect(pool.reject(mkRec({ id: T.id }), 'x')).rejects.toThrow(/revoke/);

    // —— trusted/ 消费方只读 ——
    // OS 级只读（模拟 T0.2 正式 worktree 的 OS 只读语义）：trusted 记录置只读属性后写入被拒。
    // 环境差异（真机暴露，非缺陷）：`0o444` 对 **root 无效**（CAP_DAC_OVERRIDE，Linux 容器常以 root 跑）
    // → 此时"写被拒"这一断言不适用：跳过它，但**先还原文件内容**，否则后面的目录树快照断言会被污染。
    const recFile = zoneFile('trusted', T.id, 'record.json');
    const originalRecord = await readFile(recFile, 'utf8');
    const enforced = readOnlyEnforced(dirname(recFile));
    await chmod(recFile, 0o444);
    if (enforced) {
      await expect(writeFile(recFile, '{"polluted":true}')).rejects.toThrow();
    } else {
      // 只读不约束本进程 → 显式还原（不把"能写"当成通过，也不留下被改写的记录）
      await chmod(recFile, 0o644);
      await writeFile(recFile, originalRecord);
    }
    await chmod(recFile, 0o644); // 还原以便清理
    // 守卫层只读：消费方读路径（load + assertTrusted）零写入（目录树快照前后一致）
    const before = await snapshotTree(evo);
    const fresh = await pool.load(T.id);
    pool.assertTrusted(fresh);
    const after = await snapshotTree(evo);
    expect(after).toEqual(before);
  });
});
