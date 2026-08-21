// T5.3 影子与金丝雀通道测试（supervisor/shadow.ts，架构 §9.2 G4 桶分配+分层+exposure log、
// §9.4 RollbackContract、§10.3 Anytime-valid Certificate 接口先定）。
// 严格 TDD：本文件先于实现编写并确认失败（功能缺失）。
// 覆盖（brief 测试清单 1-7 + 契约扩展）：
//   ① 桶分配可复现（同 seed 同值）+ 分布（50 seed 覆盖 >1 桶值）+ total 参数与非法校验
//   ② isExposed 分层：off 全 false / tier1 桶范围正确（属性断言）/ all 全 true / 同配置可复现；
//      扩展：未知层 / 配置漂移（bucket_range 与常量表 SHADOW_LAYERS 不一致）→ fail-loud
//   ③ exposure log：JSONL 追加写 + 重读内容一致；扩展：非法 entry fail-loud；父目录自动创建
//   ④ evaluateCanary 三态：n<min_n → hold（优先于失败率）；失败率超限 → rollback；达标 → promote；
//      边界 rate == max → promote；buildCertificate 派生 valid
//   ⑤ 触发自动回滚：超限证书 → evaluateCanary rollback → runCanary 自动调 rollbackCanary
//      （restore fake 被调）+ RollbackContract 结构完整 + exposure log 有记录（decision='canary_rollback'、
//      outcome='ok'——T5.3 评审契约修订：回滚触发为独立审计条目，审计先行）；restore 抛错 → 拒绝
//   ⑤c 修复回归（评审 Important）：restore 抛错 → runCanary 拒绝（fail-loud 保持）且 exposure log
//      仍有 canary 决策条目（decision='canary_rollback', outcome='restore_failed'）——回滚触发审计不丢失
//   ⑤d 修复回归（评审 Important）：restore 成功 + exposure log 写入失败（坏 logPath）→ 调用方得到
//      明确信号（result.warnings，非可重试 restore 形态）且 restore 不重复执行（无双回滚）
//   ⑥ 未触发：达标证书 → 无回滚调用（restore 未被调、contract === null）
//   ⑦ Certificate 结构：stat 非法（n 负数 / failures 负数 / 统计不自洽）→ 校验拒绝；阈值非法 → 拒绝；
//      扩展：cert.valid 与派生值不一致 → evaluateCanary fail-loud
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CertificateSchema,
  buildCertificate,
  bucketFor,
  evaluateCanary,
  isExposed,
  logExposure,
  rollbackCanary,
  runCanary,
  type ExposureEntry,
} from '../../supervisor/shadow.js';

// ---- 测试工具 ----

/** 分层配置（与常量表 SHADOW_LAYERS.tier1 = [0,4] 一致；待标定项随表校准） */
const TIER1: { bucket_range: [number, number]; layer: string } = { bucket_range: [0, 4], layer: 'tier1' };

/** 找桶值满足谓词的 seed（bucketFor 确定性 → 无 flake） */
function seedWithBucket(pred: (b: number) => boolean): string {
  for (let i = 0; i < 10_000; i++) {
    const s = `find-${i}`;
    if (pred(bucketFor(s))) {
      return s;
    }
  }
  throw new Error('未找到满足桶条件的 seed（分布异常）');
}

let base: string;
let evo: string; // 临时 .evolution 根（exposure log 位置 .evolution/exposure.log 的测试 fixture）

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'omb-shadow-'));
  evo = join(base, '.evolution');
  await mkdir(evo, { recursive: true });
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

// ---- 主测试 ----

describe('① 桶分配 bucketFor（确定性可复现 + 分布）', () => {
  it('①a 可复现：同一 seed 多次 bucketFor 同值；total 默认 100 → 桶 ∈ [0,100)', () => {
    expect(bucketFor('alpha')).toBe(bucketFor('alpha'));
    expect(bucketFor('alpha')).toBe(bucketFor('alpha'));
    expect(bucketFor('')).toBe(bucketFor(''));
    for (const seed of ['alpha', '', 'seed-x', '种子']) {
      const b = bucketFor(seed);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(100);
    }
  });

  it('①b 分布：抽样 50 个 seed 覆盖 >1 个桶值', () => {
    const buckets = new Set<number>();
    for (let i = 0; i < 50; i++) {
      buckets.add(bucketFor(`seed-${i}`));
    }
    expect(buckets.size).toBeGreaterThan(1);
  });

  it('①c total 参数：bucketFor(seed, total) → [0,total)；total 非法 → fail-loud', () => {
    const b = bucketFor('alpha', 10);
    expect(b).toBeGreaterThanOrEqual(0);
    expect(b).toBeLessThan(10);
    expect(() => bucketFor('alpha', 0)).toThrow();
    expect(() => bucketFor('alpha', -5)).toThrow();
    expect(() => bucketFor('alpha', 1.5)).toThrow();
  });
});

describe('② isExposed 分层（off / tier1 / all + 可复现）', () => {
  it('②a layer=off → 全 false（忽略桶范围）', () => {
    for (const seed of ['a', 'b', 'c', 'seed-x']) {
      expect(isExposed(seed, { bucket_range: [0, 99], layer: 'off' })).toBe(false);
    }
  });

  it('②b tier1 桶范围正确：isExposed ⇔ bucketFor(seed) ∈ [0,4]（属性断言 50 seed）', () => {
    const inRange = seedWithBucket((b) => b <= 4);
    const outRange = seedWithBucket((b) => b > 4);
    expect(isExposed(inRange, TIER1)).toBe(true);
    expect(isExposed(outRange, TIER1)).toBe(false);
    for (let i = 0; i < 50; i++) {
      const s = `t-${i}`;
      expect(isExposed(s, TIER1)).toBe(bucketFor(s) >= 0 && bucketFor(s) <= 4);
    }
  });

  it('②c layer=all（全量桶）→ 任意 seed true；同 seed 同配置 → 同结果（可复现）', () => {
    expect(isExposed('anything', { bucket_range: [0, 99], layer: 'all' })).toBe(true);
    expect(isExposed('x', { bucket_range: [0, 99], layer: 'all' })).toBe(true);
    const a = isExposed('repeat-me', TIER1);
    expect(isExposed('repeat-me', TIER1)).toBe(a);
  });

  it('②d 扩展：未知分层 / 配置漂移（bucket_range 与常量表不一致）→ fail-loud', () => {
    expect(() => isExposed('a', { bucket_range: [0, 4], layer: 'nope' })).toThrow(/未知|分层/);
    expect(() => isExposed('a', { bucket_range: [0, 9], layer: 'tier1' })).toThrow(/不一致|常量表|漂移/);
  });
});

describe('③ exposure log（JSONL 追加写）', () => {
  const mk = (over: Partial<ExposureEntry> = {}): ExposureEntry => ({
    ts: 1000,
    candidate_id: 'c:1',
    seed: 'seed-a',
    bucket: 3,
    layer: 'tier1',
    decision: 'canary',
    ...over,
  });

  it('③ logExposure 追加 JSONL：逐条追加、重读内容一致', async () => {
    const logPath = join(evo, 'exposure.log');
    const e1 = mk();
    const e2 = mk({ ts: 2000, candidate_id: 'c:2', seed: 'seed-b', bucket: 42, layer: 'tier2', decision: 'control' });
    await logExposure(logPath, e1);
    await logExposure(logPath, e2);
    const lines = (await readFile(logPath, 'utf8')).split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!) as ExposureEntry).toEqual(e1);
    expect(JSON.parse(lines[1]!) as ExposureEntry).toEqual(e2);
    // 追加写：第三条 → 3 行（不覆盖既有记录）
    await logExposure(logPath, mk({ ts: 3000, candidate_id: 'c:3', seed: 'seed-c', bucket: 77, layer: 'off', decision: 'skip' }));
    const lines2 = (await readFile(logPath, 'utf8')).split('\n').filter((l) => l.length > 0);
    expect(lines2).toHaveLength(3);
  });

  it('③b 扩展：非法 entry（decision 不在枚举）→ fail-loud；父目录不存在 → 自动创建', async () => {
    const logPath = join(evo, 'exposure.log');
    await expect(
      logExposure(logPath, { ts: 0, candidate_id: 'c', seed: 's', bucket: 0, layer: 'tier1', decision: 'bogus' } as unknown as ExposureEntry),
    ).rejects.toThrow();
    const nested = join(evo, 'sub', 'deep', 'exposure.log');
    await logExposure(nested, mk());
    expect(existsSync(nested)).toBe(true);
  });
});

describe('④ 金丝雀判定 evaluateCanary（三态）', () => {
  it('④a n < min_n → hold（即使失败率已超限——样本不足优先）', () => {
    const cert = { candidate_id: 'c:h', stat: { n: 5, successes: 4, failures: 1 }, threshold: { min_n: 10, max_failure_rate: 0.1 }, valid: false };
    const r = evaluateCanary(cert);
    expect(r.verdict).toBe('hold');
    expect(r.reason).toMatch(/样本不足|n=5/);
  });

  it('④b failure_rate 超限（n ≥ min_n）→ rollback', () => {
    const cert = { candidate_id: 'c:r', stat: { n: 10, successes: 8, failures: 2 }, threshold: { min_n: 10, max_failure_rate: 0.1 }, valid: false };
    const r = evaluateCanary(cert);
    expect(r.verdict).toBe('rollback');
    expect(r.reason).toMatch(/失败率|超限/);
  });

  it('④c 达标（n ≥ min_n 且 failure_rate ≤ max）→ promote；边界 rate == max → promote', () => {
    const ok = { candidate_id: 'c:p', stat: { n: 20, successes: 19, failures: 1 }, threshold: { min_n: 10, max_failure_rate: 0.1 }, valid: true };
    expect(evaluateCanary(ok).verdict).toBe('promote');
    const edge = { candidate_id: 'c:e', stat: { n: 10, successes: 9, failures: 1 }, threshold: { min_n: 10, max_failure_rate: 0.1 }, valid: true };
    expect(evaluateCanary(edge).verdict).toBe('promote');
  });

  it('④d buildCertificate 派生 valid：达标 → true，样本不足 → false', () => {
    expect(
      buildCertificate('c', { n: 10, successes: 9, failures: 1 }, { min_n: 10, max_failure_rate: 0.1 }).valid,
    ).toBe(true);
    expect(
      buildCertificate('c', { n: 5, successes: 4, failures: 1 }, { min_n: 10, max_failure_rate: 0.1 }).valid,
    ).toBe(false);
    expect(
      buildCertificate('c', { n: 10, successes: 8, failures: 2 }, { min_n: 10, max_failure_rate: 0.1 }).valid,
    ).toBe(false);
  });
});

describe('⑤ 触发自动回滚（evaluateCanary rollback → runCanary 自动 rollbackCanary）', () => {
  it('⑤ 超限证书 → 自动回滚：restore 被调 + RollbackContract 结构完整 + exposure log 有记录', async () => {
    const cert = buildCertificate('c:bad', { n: 10, successes: 8, failures: 2 }, { min_n: 10, max_failure_rate: 0.1 });
    expect(evaluateCanary(cert).verdict).toBe('rollback'); // 前置：判定为 rollback
    const logPath = join(evo, 'exposure.log');
    let restored = 0;
    const result = await runCanary({
      certificate: cert,
      exposure: { seed: 'seed-x', bucket: bucketFor('seed-x'), layer: 'tier1' },
      logPath,
      snapshot: 'sha256:abcdef',
      scope: 'Project',
      restore: async () => {
        restored++;
      },
    });
    expect(result.verdict).toBe('rollback');
    expect(restored).toBe(1); // restore fake 被调（自动回滚执行）
    // RollbackContract 结构完整
    expect(result.contract).not.toBeNull();
    const contract = result.contract!;
    expect(contract.target_snapshot).toBe('sha256:abcdef');
    expect(contract.scope).toBe('Project');
    expect(Array.isArray(contract.affected_sessions)).toBe(true);
    expect(contract.restore_plan.length).toBeGreaterThan(0);
    expect(contract.restore_plan.join(' ')).toContain('c:bad');
    // exposure log 有记录（审计先行：回滚触发条目 decision='canary_rollback', outcome='ok'）
    const lines = (await readFile(logPath, 'utf8')).split('\n').filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const rec = JSON.parse(lines[0]!) as ExposureEntry;
    expect(rec.candidate_id).toBe('c:bad');
    expect(rec.decision).toBe('canary_rollback');
    expect(rec.outcome).toBe('ok');
    expect(rec.layer).toBe('tier1');
    expect(rec.seed).toBe('seed-x');
  });

  it('⑤b 扩展：restore 抛错 → rollbackCanary 拒绝（回滚失败不静默）', async () => {
    await expect(
      rollbackCanary({
        candidate_id: 'c:bad',
        snapshot: 'sha256:abcdef',
        scope: 'Project',
        restore: async () => {
          throw new Error('restore failed');
        },
      }),
    ).rejects.toThrow(/restore failed/);
  });

  it('⑤c 修复回归：restore 抛错 → runCanary 拒绝（fail-loud 保持）且 exposure log 仍有 canary 决策条目（outcome=restore_failed）', async () => {
    const cert = buildCertificate('c:bad', { n: 10, successes: 8, failures: 2 }, { min_n: 10, max_failure_rate: 0.1 });
    const logPath = join(evo, 'exposure.log');
    await expect(
      runCanary({
        certificate: cert,
        exposure: { seed: 'seed-z', bucket: bucketFor('seed-z'), layer: 'tier1' },
        logPath,
        snapshot: 'sha256:abc',
        scope: 'Project',
        restore: async () => {
          throw new Error('restore failed');
        },
      }),
    ).rejects.toThrow(/restore failed/);
    // 审计先行：回滚触发条目已落盘（outcome 标注 restore 失败）
    const lines = (await readFile(logPath, 'utf8')).split('\n').filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const rec = JSON.parse(lines[0]!) as ExposureEntry;
    expect(rec.candidate_id).toBe('c:bad');
    expect(rec.decision).toBe('canary_rollback');
    expect(rec.outcome).toBe('restore_failed');
  });

  it('⑤d 修复回归：restore 成功 + exposure log 写入失败 → 明确信号（warnings 含"回滚已执行、日志未写入"）且 restore 不重复执行', async () => {
    const cert = buildCertificate('c:bad', { n: 10, successes: 8, failures: 2 }, { min_n: 10, max_failure_rate: 0.1 });
    // 坏 logPath：父路径位置被普通文件占据 → logExposure 的 mkdir 必然失败
    const blocker = join(evo, 'blocked');
    await writeFile(blocker, 'not a directory');
    const logPath = join(blocker, 'exposure.log');
    let restored = 0;
    const result = await runCanary({
      certificate: cert,
      exposure: { seed: 'seed-w', bucket: bucketFor('seed-w'), layer: 'tier1' },
      logPath,
      snapshot: 'sha256:xyz',
      scope: 'Project',
      restore: async () => {
        restored++;
      },
    });
    // 回滚已提交（contract 非空）→ 调用方拿到的是"已执行"形态，非可重试 restore 的拒绝形态
    expect(result.verdict).toBe('rollback');
    expect(result.contract).not.toBeNull();
    expect(result.contract!.target_snapshot).toBe('sha256:xyz');
    // 明确信号：warnings 非空且言明回滚已执行、日志未写入
    expect(result.warnings.length).toBeGreaterThanOrEqual(1);
    expect(result.warnings.join(' ')).toMatch(/回滚已执行/);
    expect(result.warnings.join(' ')).toMatch(/日志未写入|exposure log/);
    // restore 仅执行一次（调用方不会因 reject 而重试 → 无二次 restore）
    expect(restored).toBe(1);
  });
});

describe('⑥ 未触发（达标 → 无回滚调用）', () => {
  it('⑥ 达标证书 → runCanary 无回滚：restore 未被调、contract === null、verdict promote', async () => {
    const cert = buildCertificate('c:good', { n: 20, successes: 19, failures: 1 }, { min_n: 10, max_failure_rate: 0.1 });
    const logPath = join(evo, 'exposure.log');
    let restored = 0;
    const result = await runCanary({
      certificate: cert,
      exposure: { seed: 'seed-y', bucket: bucketFor('seed-y'), layer: 'tier1' },
      logPath,
      snapshot: 'sha256:111',
      scope: 'Project',
      restore: async () => {
        restored++;
      },
    });
    expect(result.verdict).toBe('promote');
    expect(result.contract).toBeNull();
    expect(restored).toBe(0);
  });
});

describe('⑦ Certificate 结构校验', () => {
  const baseCert = {
    candidate_id: 'c',
    stat: { n: 10, successes: 9, failures: 1 },
    threshold: { min_n: 10, max_failure_rate: 0.1 },
    valid: true,
  };

  it('⑦a stat 非法（n 负数 / failures 负数 / 统计不自洽）→ 校验拒绝', () => {
    expect(CertificateSchema.safeParse({ ...baseCert, stat: { n: -1, successes: 0, failures: 0 } }).success).toBe(false);
    expect(CertificateSchema.safeParse({ ...baseCert, stat: { n: 10, successes: 11, failures: -1 } }).success).toBe(false);
    // successes + failures ≠ n → 自洽性拒绝
    expect(CertificateSchema.safeParse({ ...baseCert, stat: { n: 10, successes: 9, failures: 2 } }).success).toBe(false);
  });

  it('⑦b 阈值非法（max_failure_rate > 1）→ 校验拒绝；合法证书 → 通过', () => {
    expect(CertificateSchema.safeParse({ ...baseCert, threshold: { min_n: 10, max_failure_rate: 1.5 } }).success).toBe(false);
    expect(CertificateSchema.safeParse(baseCert).success).toBe(true);
  });

  it('⑦c 扩展：cert.valid 与派生值不一致 → evaluateCanary fail-loud；buildCertificate 非法输入 → 拒绝', () => {
    // 派生 valid=true 但声明 valid=false → 不一致
    const liar = { ...baseCert, valid: false };
    expect(() => evaluateCanary(liar)).toThrow(/valid|自洽/);
    // buildCertificate 非法统计 → 拒绝
    expect(() => buildCertificate('c', { n: -1, successes: 0, failures: 0 }, { min_n: 10, max_failure_rate: 0.1 })).toThrow();
  });
});
