// T8.15 e-process 引擎接入测试（supervisor/e-process.ts + supervisor/shadow.ts runCanaryEProcess；
// 架构 §10.3 Anytime-valid Certificate——初值公式 → e-process/confidence sequence 引擎）。
// 选型记录：自实现最小 e-process（Bernoulli 似然比超鞅：e_n = ∏(p1/p0)^X·((1-p1)/(1-p0))^(1-X)，
// 零假设 H0: 失败率 ≤ p0 下 E_P[e_n] ≤ 1 → Ville 不等式给出 anytime-valid 拒绝规则 e_n ≥ 1/α）；
// 不引入新依赖（jieba 类新依赖需报告主会话——e-process 现成库同理，自实现为 brief 认可的备选）。
// 严格 TDD：本文件先于实现编写并确认失败（功能缺失）。
// 覆盖：
//   ① 连续监测统计保障：种子确定性"纯随机"合成序列（失败率 5% < p0=10%）→ 全程 e < 阈值 → 不误判
//      （verdict promote，绝无 rollback）
//   ② 持续失败 → 快速判定 rollback（e 指数增长，n=2 即达阈值；e ≥ 1/α）
//   ③ e-process 值：失败↑e、成功↓e（乘积性质）；阈值边界 e == 1/α → rollback（≥）
//   ④ 高失败率（30% > p0）合成序列 → 有限样本内拒绝（统计保障的另一侧）
//   ⑤ runCanaryEProcess：rollback → 自动回滚（restore 被调）+ exposure log 记录
//   ⑥ 参数校验：p0/p1/alpha 非法 → fail-loud；e-process 值上限防溢出（clamp）
//   ⑦ 与初值规则并存：同一 stat 两套判定（naive 初值公式 vs e-process）可对照
//   P7 ⑧ 主判开关（evolve.policy e_process 数据化）：mode 切换生效（rule → 初值规则 / e-process → 超鞅）；
//      fallback 路径（e-process 异常 → 回退初值规则 / 不上抛）；对照记录（两判定不一致 reason 附 rule 对照）
import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  E_PROCESS_ALPHA,
  eProcessSeries,
  eProcessValue,
  evaluateEProcess,
  type EProcessOptions,
} from '../../supervisor/e-process.js';
import {
  buildCanaryEvaluator,
  buildCertificate,
  bucketFor,
  runCanaryConfigured,
  runCanaryEProcess,
  type EProcessPolicyConfig,
} from '../../supervisor/shadow.js';

// ---- 测试工具 ----

/** mulberry32 种子 PRNG（确定性合成序列，测试无 flake） */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 确定性合成序列：N 次试验，每次失败概率 failP（种子固定 → 序列固定） */
function synthSequence(n: number, failP: number, seed = 12345): boolean[] {
  const rand = mulberry32(seed);
  const out: boolean[] = [];
  for (let i = 0; i < n; i++) {
    out.push(rand() < failP);
  }
  return out;
}

const BASE_OPTS: EProcessOptions = { nullFailureRate: 0.1, alternativeFailureRate: 0.5, alpha: E_PROCESS_ALPHA };

// ---- 主测试 ----

describe('① 连续监测统计保障：纯随机（失败率 5% < p0=10%）→ 不误判', () => {
  it('500 次种子确定性试验 → e 全程 < 1/α → verdict promote（绝无 rollback）', () => {
    const seq = synthSequence(500, 0.05);
    const series = eProcessSeries(seq, BASE_OPTS);
    const threshold = 1 / BASE_OPTS.alpha!;
    // 连续监测：任意时刻都不达阈值（不误判）
    expect(Math.max(...series)).toBeLessThan(threshold);
    const n = seq.length;
    const failures = seq.filter(Boolean).length;
    const verdict = evaluateEProcess({ n, failures, min_n: 10, max_failure_rate: 0.1 }, BASE_OPTS);
    expect(verdict.verdict).toBe('promote');
    expect(verdict.e).toBeLessThan(threshold);
  });
});

describe('② 持续失败 → 快速判定 rollback（e 指数增长）', () => {
  it('全失败序列 → e 达 1/α 于 n=2（(0.5/0.1)^2=25 ≥ 20）→ verdict rollback', () => {
    const seq = [true, true, true, true, true];
    const series = eProcessSeries(seq, BASE_OPTS);
    const threshold = 1 / BASE_OPTS.alpha!;
    // 快速判定：样本极少（n=2）即达阈值（anytime-valid：小样本证据足够即拒绝）
    expect(series[0]!).toBeGreaterThan(1); // (0.5/0.1)=5
    expect(series[1]!).toBeGreaterThanOrEqual(threshold); // 25 ≥ 20
    const verdict = evaluateEProcess({ n: 5, failures: 5, min_n: 10, max_failure_rate: 0.1 }, BASE_OPTS);
    expect(verdict.verdict).toBe('rollback');
    expect(verdict.reason).toMatch(/e-process|拒绝/);
  });

  it('快速判定不因 min_n 阻塞（anytime-valid 语义：e 达阈值即回滚，n=2 < min_n=10 也判）', () => {
    const verdict = evaluateEProcess({ n: 2, failures: 2, min_n: 10, max_failure_rate: 0.1 }, BASE_OPTS);
    expect(verdict.verdict).toBe('rollback');
  });
});

describe('③ e-process 值性质与阈值边界', () => {
  it('失败使 e 上升、成功使 e 下降（乘积：失败 ×5、成功 ×5/9）', () => {
    const base = { nullFailureRate: 0.1, alternativeFailureRate: 0.5 };
    expect(eProcessValue({ n: 1, failures: 1 }, base)).toBeCloseTo(5);
    // 一败一成：5 × (0.5/0.9) ≈ 2.778
    expect(eProcessValue({ n: 2, failures: 1 }, base)).toBeCloseTo(5 * (0.5 / 0.9));
  });

  it('边界 e == 1/α → rollback（≥ 语义）', () => {
    // p1=0.2, p0=0.1：单次失败 e = 2；1/α 取 2 → 恰好达阈值
    const opts: EProcessOptions = { nullFailureRate: 0.1, alternativeFailureRate: 0.2, alpha: 0.5 };
    const verdict = evaluateEProcess({ n: 1, failures: 1, min_n: 10, max_failure_rate: 0.1 }, opts);
    expect(verdict.verdict).toBe('rollback');
    expect(verdict.e).toBeCloseTo(2);
    expect(verdict.threshold).toBeCloseTo(2);
  });
});

describe('④ 高失败率（30% > p0）→ 有限样本内拒绝', () => {
  it('300 次种子确定性试验（失败率 30%）→ 最终 e ≥ 1/α → rollback', () => {
    const seq = synthSequence(300, 0.3, 777);
    const series = eProcessSeries(seq, BASE_OPTS);
    const finalE = series[series.length - 1]!;
    const threshold = 1 / BASE_OPTS.alpha!;
    expect(finalE).toBeGreaterThanOrEqual(threshold);
    const n = seq.length;
    const failures = seq.filter(Boolean).length;
    const verdict = evaluateEProcess({ n, failures, min_n: 10, max_failure_rate: 0.1 }, BASE_OPTS);
    expect(verdict.verdict).toBe('rollback');
  });
});

describe('⑤ runCanaryEProcess：rollback → 自动回滚（restore 被调）+ exposure log 记录', () => {
  it('e-process 判 rollback → runCanaryEProcess 自动调 restore + 审计条目', async () => {
    const base = await mkdtemp(join(tmpdir(), 'omb-ep-canary-'));
    try {
      const evo = join(base, '.evolution');
      await mkdir(evo, { recursive: true });
      const logPath = join(evo, 'exposure.log');
      const cert = buildCertificate('c:ep', { n: 2, successes: 0, failures: 2 }, { min_n: 10, max_failure_rate: 0.1 });
      let restored = 0;
      const result = await runCanaryEProcess({
        certificate: cert,
        exposure: { seed: 'seed-ep', bucket: bucketFor('seed-ep'), layer: 'tier1' },
        logPath,
        snapshot: 'sha256:ep',
        scope: 'Project',
        restore: async () => {
          restored++;
        },
      });
      expect(result.verdict).toBe('rollback');
      expect(restored).toBe(1);
      expect(result.contract).not.toBeNull();
      const lines = (await readFile(logPath, 'utf8')).split('\n').filter((l) => l.length > 0);
      const rec = JSON.parse(lines[0]!) as { decision: string; outcome: string };
      expect(rec.decision).toBe('canary_rollback');
      expect(rec.outcome).toBe('ok');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe('⑥ 参数校验', () => {
  it('p0/p1/alpha 非法 → fail-loud', () => {
    expect(() => eProcessValue({ n: 1, failures: 1 }, { nullFailureRate: 0, alternativeFailureRate: 0.5 })).toThrow();
    expect(() => eProcessValue({ n: 1, failures: 1 }, { nullFailureRate: 0.1, alternativeFailureRate: 1 })).toThrow();
    expect(() => eProcessValue({ n: 1, failures: 1 }, { nullFailureRate: 0.3, alternativeFailureRate: 0.2 })).toThrow();
    expect(() => evaluateEProcess({ n: 1, failures: 1, min_n: 1, max_failure_rate: 0.1 }, { alpha: 0 })).toThrow();
  });
});

describe('⑦ 与初值规则并存（同 stat 两套判定可对照）', () => {
  it('n=10, 2 失败：初值规则（失败率 0.2 > 0.1）→ rollback；e-process（e≈0.24 < 20）→ promote（更保守）', () => {
    // naive：evaluateCanary（shadow.ts 初值公式）判 rollback——沿用既有测试语义
    // e-process：小样本下 e 未达阈值 → promote（anytime-valid 保守性，文档化）
    const verdict = evaluateEProcess({ n: 10, failures: 2, min_n: 10, max_failure_rate: 0.1 }, BASE_OPTS);
    expect(verdict.verdict).toBe('promote');
    expect(verdict.e).toBeLessThan(1 / BASE_OPTS.alpha!);
  });
});

// ---- P7 ⑧ 主判开关（evolve.policy e_process 数据化：anytime-valid 为主判，初值规则为降级/对照） ----

describe('P7 ⑧ e-process 主判开关（buildCanaryEvaluator / runCanaryConfigured）', () => {
  /** 判别性证书：n=2 全失败 → e-process（e=25 ≥ 20）判 rollback；初值规则（n < min_n=10）判 hold */
  const DIVERGENT_CERT = buildCertificate('c:div', { n: 2, successes: 0, failures: 2 }, { min_n: 10, max_failure_rate: 0.1 });

  it('开关切换生效：mode=rule → 初值规则主判（hold）；mode=e-process → 超鞅主判（rollback）', () => {
    const rule = buildCanaryEvaluator({ mode: 'rule', fallback_to_rule: true });
    expect(rule(DIVERGENT_CERT).verdict).toBe('hold'); // n < min_n → 初值规则 hold
    const ep = buildCanaryEvaluator({ mode: 'e-process', fallback_to_rule: true });
    expect(ep(DIVERGENT_CERT).verdict).toBe('rollback'); // e ≥ 1/α → anytime-valid 拒绝（不受 min_n 阻塞）
  });

  it('对照记录：e-process 主判与初值规则不一致 → reason 附 rule 对照（审计可见）', () => {
    const ep = buildCanaryEvaluator({ mode: 'e-process', fallback_to_rule: true });
    const r = ep(DIVERGENT_CERT);
    expect(r.verdict).toBe('rollback');
    expect(r.reason).toMatch(/rule 对照: hold/);
    // 判定一致时不附对照注（reason 保持 e-process 纯文案）：达标证书两套都 promote
    const okCert = buildCertificate('c:ok', { n: 10, successes: 10, failures: 0 }, { min_n: 10, max_failure_rate: 0.1 });
    const r2 = ep(okCert);
    expect(r2.verdict).toBe('promote');
    expect(r2.reason).not.toContain('rule 对照');
  });

  it('fallback 路径：e-process 判定异常（alpha=0 非法）→ fallback_to_rule=true 回退初值规则（reason 标注）', () => {
    const withFallback = buildCanaryEvaluator({ mode: 'e-process', fallback_to_rule: true }, { alpha: 0 });
    const r = withFallback(DIVERGENT_CERT);
    expect(r.verdict).toBe('hold'); // 回退初值规则（n < min_n）
    expect(r.reason).toMatch(/e-process fallback/);
    // fallback_to_rule=false → 异常上抛（fail-loud，不静默吞错）
    const strict = buildCanaryEvaluator({ mode: 'e-process', fallback_to_rule: false }, { alpha: 0 });
    expect(() => strict(DIVERGENT_CERT)).toThrow(/alpha/);
  });

  it('runCanaryConfigured：mode=rule → 初值规则 hold → 无回滚（restore 未被调、无 canary_rollback 审计）', async () => {
    const base = await mkdtemp(join(tmpdir(), 'omb-ep-cfg-'));
    try {
      const evo = join(base, '.evolution');
      await mkdir(evo, { recursive: true });
      const logPath = join(evo, 'exposure.log');
      let restored = 0;
      const cfg: EProcessPolicyConfig = { mode: 'rule', fallback_to_rule: true };
      const result = await runCanaryConfigured(
        {
          certificate: DIVERGENT_CERT,
          exposure: { seed: 'seed-rule', bucket: bucketFor('seed-rule'), layer: 'tier1' },
          logPath,
          snapshot: 'sha256:rule',
          scope: 'Project',
          restore: async () => {
            restored++;
          },
        },
        cfg,
      );
      expect(result.verdict).toBe('hold');
      expect(restored).toBe(0);
      expect(result.contract).toBeNull();
      const lines = (await readFile(logPath, 'utf8')).split('\n').filter((l) => l.length > 0);
      expect(JSON.parse(lines[0]!).decision).toBe('canary'); // 无回滚 → 普通 canary 审计
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('runCanaryConfigured：mode=e-process（缺省）→ 与 runCanaryEProcess 等价（判定一致）', async () => {
    const base = await mkdtemp(join(tmpdir(), 'omb-ep-cfg2-'));
    try {
      const evo = join(base, '.evolution');
      await mkdir(evo, { recursive: true });
      const logPath = join(evo, 'exposure.log');
      let restored = 0;
      // 缺省 cfg（e-process 主判）经 runCanaryConfigured —— 判别性证书 → rollback + 自动回滚
      const result = await runCanaryConfigured({
        certificate: DIVERGENT_CERT,
        exposure: { seed: 'seed-cfg', bucket: bucketFor('seed-cfg'), layer: 'tier1' },
        logPath,
        snapshot: 'sha256:cfg',
        scope: 'Project',
        restore: async () => {
          restored++;
        },
      });
      expect(result.verdict).toBe('rollback');
      expect(restored).toBe(1);
      expect(result.contract).not.toBeNull();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
