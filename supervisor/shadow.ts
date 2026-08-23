// OMB v2 影子与金丝雀通道（架构 §9.2 G4 桶分配 hash%100 + 分层 + exposure log、
// §9.4 RollbackContract、§10.3 Anytime-valid Certificate 接口先定；施工计划 T5.3）：layer 1。
//
// 职责（brief 契约）：
//   - bucketFor(seed)：确定性桶分配——sha256(seed) 前 2 字节 → % total（同 seed 同桶，可复现）。
//   - isExposed(seed, cfg)：分层曝光判定。分层配置为数据（SHADOW_LAYERS 常量表，待标定，§17）：
//       layer 'all'（全量桶 0-99）/ 'tier1'（0-4）/ 'tier2'（5-19）/ 'off'（不曝光）。
//       cfg.bucket_range 与常量表不一致 → fail-loud（配置漂移拒绝）；未知 layer → fail-loud。
//   - logExposure(logPath, entry)：独立 JSONL exposure log（.evolution/exposure.log，追加写），
//       供 M5 复盘/审计。entry 经 zod 校验（非法 fail-loud）。decision 含 'canary_rollback'
//       （回滚触发条目，可带 outcome='ok'|'restore_failed'，仅该 decision 允许——自洽性校验）。
//   - Certificate / buildCertificate / evaluateCanary：金丝雀统计判定（接口先定，§10.3）——
//       valid = n ≥ min_n && failure_rate ≤ max_failure_rate（初值 min_n=10、max_failure_rate=0.1，
//       常量标注待标定，§17）；e-process/confidence sequence 引擎后接（本任务以初值规则判定）。
//       verdict：n < min_n → hold（样本不足，优先于失败率）；failure_rate 超限 → rollback；
//       其余 → promote。cert.valid 必须与派生值一致（自洽性 fail-loud）。
//   - rollbackCanary(opts)：生成 RollbackContract { target_snapshot, scope, affected_sessions,
//       restore_plan } 并执行 restore（测试注入 fake；真实实现 = substrate rollback，T0.2 rollback.ts）。
//       affected_sessions 为空数组——Runtime Snapshot 会话注册表未接入（T5.5 前），接口先定。
//   - runCanary(opts)：自动金丝雀检查——evaluateCanary 判 rollback → 自动调用 rollbackCanary
//       （全自动回滚），全程记录 exposure log，审计先行（T5.3 评审修复）：promote/hold →
//       decision='canary'；rollback → decision='canary_rollback'（outcome 标记 restore 成败；
//       restore 失败仍 fail-loud 且审计不丢失；回滚已提交后 log 失败非致命 → warnings 显式告知，
//       防调用方重试 restore 造成双回滚）。
//
// 层规则：仅 import node: 内置 + zod（依赖）；无 kernel 运行时依赖（层 DAG，CONVENTIONS §4）。
// 模块顶层无副作用；单函数圈复杂度 ≤ 15（CONVENTIONS §9 预算）。
import { createHash } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z, type ZodIssue } from 'zod';
import { evaluateEProcess, type EProcessOptions } from './e-process.js';

// ---- 常量（待标定，§17 开放项：各层桶范围 / min_n / max_failure_rate 随冻结基准修正） ----

/** 分层常量表（机制即数据；bucket_range 为闭区间 [lo, hi]；off = 不曝光） */
export const SHADOW_LAYERS: Record<string, [number, number] | null> = {
  all: [0, 99],
  tier1: [0, 4],
  tier2: [5, 19],
  off: null,
};

/** 默认桶总数（bucketFor 缺省 total；桶 ∈ [0, total)） */
const DEFAULT_TOTAL = 100;

// ---- 错误 ----

/** 影子/金丝雀层错误（fail-loud：非法输入 / 配置漂移 / 自洽性破坏 → 抛错，不静默） */
export class ShadowError extends Error {
  constructor(message: string) {
    super(`shadow: ${message}`);
    this.name = 'ShadowError';
  }
}

function formatIssues(issues: ZodIssue[]): string {
  return issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
}

// ---- 桶分配（§9.2 G4：确定性可复现） ----

/**
 * 桶分配：sha256(seed) 前 2 字节（big-endian uint16）→ % total。
 * 同 seed 同 total → 同桶（确定性）；sha256 前两字节近似均匀 → 分布良好。
 */
export function bucketFor(seed: string, total = DEFAULT_TOTAL): number {
  if (!Number.isInteger(total) || total < 1) {
    throw new ShadowError(`bucketFor: total 必须为正整数（got ${total}）`);
  }
  const hash = createHash('sha256').update(seed, 'utf8').digest();
  const u16 = hash[0]! * 256 + hash[1]!;
  return u16 % total;
}

// ---- 分层曝光判定 ----

/**
 * 分层曝光：layer='off' → 恒 false；否则按 cfg.bucket_range 判定 bucketFor(seed) ∈ [lo, hi]。
 * 配置为数据：cfg.bucket_range 必须与 SHADOW_LAYERS[layer] 一致（漂移 → fail-loud）；
 * 未知 layer → fail-loud。
 */
export function isExposed(seed: string, cfg: { bucket_range: [number, number]; layer: string }): boolean {
  if (cfg.layer === 'off') {
    return false;
  }
  const table = SHADOW_LAYERS[cfg.layer];
  if (table === undefined || table === null) {
    throw new ShadowError(`isExposed: 未知分层 "${cfg.layer}"（可用: ${Object.keys(SHADOW_LAYERS).join('/')}）`);
  }
  const [lo, hi] = cfg.bucket_range;
  if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < 0 || hi < lo) {
    throw new ShadowError(`isExposed: bucket_range 非法 [${lo}, ${hi}]（应为 lo ≤ hi 的非负整数）`);
  }
  if (lo !== table[0] || hi !== table[1]) {
    throw new ShadowError(
      `isExposed: 分层 "${cfg.layer}" 桶范围与常量表不一致 [${lo}, ${hi}] ≠ [${table[0]}, ${table[1]}]（配置漂移，SHADOW_LAYERS 待标定）`,
    );
  }
  const bucket = bucketFor(seed);
  return bucket >= lo && bucket <= hi;
}

// ---- Exposure log（§9.2 G4：独立 JSONL，.evolution/exposure.log，追加写） ----

/** exposure entry（brief 契约：{ ts, candidate_id, seed, bucket, layer, decision }；T5.3 评审修订：
 *  decision 增 'canary_rollback'（回滚触发条目，审计先行）；可选 outcome 标记回滚尝试结果
 *  （'ok' / 'restore_failed'），仅 canary_rollback 条目允许携带（自洽性 refine）） */
export const ExposureEntrySchema = z
  .object({
    ts: z.number().int().nonnegative(),
    candidate_id: z.string().min(1),
    seed: z.string().min(1),
    bucket: z.number().int().min(0),
    layer: z.string().min(1),
    decision: z.enum(['shadow', 'canary', 'control', 'skip', 'canary_rollback']),
    outcome: z.enum(['ok', 'restore_failed']).optional(),
  })
  .refine((e) => e.decision === 'canary_rollback' || e.outcome === undefined, {
    message: 'outcome 仅用于 canary_rollback 条目',
    path: ['outcome'],
  });
export type ExposureEntry = z.infer<typeof ExposureEntrySchema>;

/**
 * 追加写一条 exposure 记录（JSONL：一行一个 entry）。父目录不存在 → 自动创建。
 * entry 非法（zod 校验失败）→ fail-loud（审计日志不静默吞非法记录）。
 */
export async function logExposure(logPath: string, entry: ExposureEntry): Promise<void> {
  const parsed = ExposureEntrySchema.safeParse(entry);
  if (!parsed.success) {
    throw new ShadowError(`logExposure: 非法 exposure entry——${formatIssues(parsed.error.issues)}`);
  }
  await mkdir(dirname(logPath), { recursive: true });
  await appendFile(logPath, `${JSON.stringify(parsed.data)}\n`, 'utf8');
}

// ---- Anytime-valid Certificate（§10.3：接口先定，e-process 引擎后接） ----

/** 金丝雀统计（n = 总样本；successes + failures === n 由 schema 强制） */
export interface CanaryStat {
  n: number;
  successes: number;
  failures: number;
}

/** 判定阈值（初值 min_n=10、max_failure_rate=0.1，待标定 §17） */
export interface CanaryThreshold {
  min_n: number;
  max_failure_rate: number;
}

/** Certificate（brief 契约）：valid = n ≥ min_n && failure_rate ≤ max_failure_rate（由 buildCertificate 派生） */
export interface Certificate {
  candidate_id: string;
  stat: CanaryStat;
  threshold: CanaryThreshold;
  valid: boolean;
}

export const CertificateSchema = z
  .object({
    candidate_id: z.string().min(1),
    stat: z.object({
      n: z.number().int().nonnegative(),
      successes: z.number().int().nonnegative(),
      failures: z.number().int().nonnegative(),
    }),
    threshold: z.object({
      min_n: z.number().int().positive(),
      max_failure_rate: z.number().min(0).max(1),
    }),
    valid: z.boolean(),
  })
  .refine((c) => c.stat.successes + c.stat.failures === c.stat.n, {
    message: '统计不自洽: successes + failures 必须等于 n',
    path: ['stat'],
  });
/** 由 stat/threshold 派生 valid（接口先定公式；e-process 引擎后接替换本公式） */
export function buildCertificate(candidate_id: string, stat: CanaryStat, threshold: CanaryThreshold): Certificate {
  const failureRate = stat.n > 0 ? stat.failures / stat.n : 0;
  const cert: Certificate = {
    candidate_id,
    stat,
    threshold,
    valid: stat.n >= threshold.min_n && failureRate <= threshold.max_failure_rate,
  };
  const parsed = CertificateSchema.safeParse(cert);
  if (!parsed.success) {
    throw new ShadowError(`buildCertificate: 非法 Certificate——${formatIssues(parsed.error.issues)}`);
  }
  return cert;
}

export type CanaryVerdict = 'promote' | 'hold' | 'rollback';

/**
 * 金丝雀判定（brief 契约）：
 *   - hold：n < min_n（样本不足，优先于失败率——少量样本的失败率不构成回滚证据）；
 *   - rollback：n ≥ min_n 且 failure_rate > max_failure_rate；
 *   - promote：其余（达标）。
 * cert.valid 必须与由 stat/threshold 派生的值一致，否则 fail-loud（自洽性校验）。
 */
export function evaluateCanary(cert: Certificate): { verdict: CanaryVerdict; reason: string } {
  const parsed = CertificateSchema.safeParse(cert);
  if (!parsed.success) {
    throw new ShadowError(`evaluateCanary: 非法 Certificate——${formatIssues(parsed.error.issues)}`);
  }
  const c = parsed.data;
  const failureRate = c.stat.n > 0 ? c.stat.failures / c.stat.n : 0;
  const derivedValid = c.stat.n >= c.threshold.min_n && failureRate <= c.threshold.max_failure_rate;
  if (derivedValid !== c.valid) {
    throw new ShadowError(
      `evaluateCanary: Certificate 自洽性校验失败——派生 valid=${derivedValid} ≠ 声明 valid=${c.valid}（valid 应由 buildCertificate 派生）`,
    );
  }
  if (c.stat.n < c.threshold.min_n) {
    return { verdict: 'hold', reason: `样本不足: n=${c.stat.n} < min_n=${c.threshold.min_n}（待标定 §17）` };
  }
  if (failureRate > c.threshold.max_failure_rate) {
    return {
      verdict: 'rollback',
      reason: `失败率超限: ${failureRate.toFixed(3)} > ${c.threshold.max_failure_rate}（n=${c.stat.n}, failures=${c.stat.failures}）`,
    };
  }
  return {
    verdict: 'promote',
    reason: `达标: n=${c.stat.n} ≥ min_n=${c.threshold.min_n}, failure_rate=${failureRate.toFixed(3)} ≤ ${c.threshold.max_failure_rate}`,
  };
}

// ---- 金丝雀回滚（§9.4 RollbackContract） ----

/** RollbackContract（§9.4 契约：{ target_snapshot, scope, affected_sessions, restore_plan }） */
export interface RollbackContract {
  target_snapshot: string;
  scope: string;
  affected_sessions: string[];
  restore_plan: string[];
}

/**
 * 执行金丝雀回滚：生成 RollbackContract 并执行 restore（测试注入 fake；真实实现 =
 * substrate rollback，T0.2 rollback.ts——shadow 层自动回滚不涉及 stable_head 切换，§11.3）。
 * restore 抛错 → 本函数拒绝（回滚失败不静默）。
 * affected_sessions（P1b 接入）：受影响会话集——与 SnapshotRegistry（supervisor/versioning.ts）的关系：
 * registry 的活跃请求绑定（请求级 session_id → 快照，§6.5.7）即「被回滚快照」的受影响会话；回滚方应收集
 * 绑定到 target_snapshot 的 session_id 传入（shadow 层不感知 registry 内部——接口先定，最小实现记录集合）。
 * 未提供（调用方未接入收集面）→ 空数组（既有语义，接口兼容）。
 */
export async function rollbackCanary(opts: {
  candidate_id: string;
  snapshot: string;
  scope: string;
  restore: () => Promise<void>;
  /** P1b：受影响会话（RollbackContract.affected_sessions；缺省 []）——见上方与快照 registry 的关系说明 */
  affectedSessions?: string[];
}): Promise<RollbackContract> {
  if (typeof opts.candidate_id !== 'string' || opts.candidate_id.length === 0) {
    throw new ShadowError('rollbackCanary: candidate_id 必填');
  }
  if (typeof opts.snapshot !== 'string' || opts.snapshot.length === 0) {
    throw new ShadowError('rollbackCanary: snapshot 必填');
  }
  if (typeof opts.scope !== 'string' || opts.scope.length === 0) {
    throw new ShadowError('rollbackCanary: scope 必填');
  }
  if (typeof opts.restore !== 'function') {
    throw new ShadowError('rollbackCanary: restore 必须为函数');
  }
  const contract: RollbackContract = {
    target_snapshot: opts.snapshot,
    scope: opts.scope,
    // P1b：受影响会话接口接入（最小实现：记录 session_id 集合；收集面 = 快照 registry 的活跃请求绑定，
    // shadow 层不感知 registry 内部——由调用方收集传入，缺省 [] 保持既有语义）
    affected_sessions: opts.affectedSessions ?? [],
    restore_plan: [`deactivate:${opts.candidate_id}`, `restore:${opts.snapshot}`],
  };
  await opts.restore();
  return contract;
}

// ---- 自动金丝雀检查（触发条件 → 自动回滚，§9.2 G4） ----

/** runCanary 上下文（certificate + 曝光审计信息 + 回滚参数） */
export interface CanaryRunOptions {
  certificate: Certificate;
  /** 曝光审计信息（来自 isExposed 调用方的 seed/bucket/layer） */
  exposure: { seed: string; bucket: number; layer: string };
  /** exposure log 文件路径（.evolution/exposure.log） */
  logPath: string;
  /** 回滚目标快照（RollbackContract.target_snapshot） */
  snapshot: string;
  scope: string;
  restore: () => Promise<void>;
  /** P1b：受影响会话（透传 rollbackCanary；缺省 []——收集面 = 快照 registry 活跃请求绑定，见 rollbackCanary） */
  affectedSessions?: string[];
}

export interface CanaryRunResult {
  verdict: CanaryVerdict;
  reason: string;
  /** rollback 时 = 执行后的 RollbackContract；否则 null */
  contract: RollbackContract | null;
  /** 非致命警告（空数组 = 无）。如"回滚已执行但 exposure log 写入失败"——调用方不得据此重试 restore（双回滚风险） */
  warnings: string[];
}

/** 金丝雀判定器注入（缺省 evaluateCanary 初值规则；T8.15 可注入 e-process 判定 evaluateEProcess） */
export type CanaryEvaluator = (cert: Certificate) => { verdict: CanaryVerdict; reason: string };

/** 构造 runCanary 的 exposure 条目（rollback 触发 = decision 'canary_rollback'，可带 outcome 标记 restore 结果） */
function canaryEntry(opts: CanaryRunOptions, decision: ExposureEntry['decision'], outcome?: ExposureEntry['outcome']): ExposureEntry {
  return {
    ts: Date.now(),
    candidate_id: opts.certificate.candidate_id,
    seed: opts.exposure.seed,
    bucket: opts.exposure.bucket,
    layer: opts.exposure.layer,
    decision,
    ...(outcome === undefined ? {} : { outcome }),
  };
}

/**
 * 自动金丝雀检查（全自动，brief 验收核心）：
 * evaluateCanary 判 rollback → 自动调用 rollbackCanary（执行 restore）。审计先行（T5.3 评审修复）：
 *   - promote/hold → exposure log 记 decision='canary'；
 *   - rollback → exposure log 记 decision='canary_rollback'（回滚触发条目必被记录）：
 *       restore 成功 → outcome='ok'；restore 抛错 → 先落盘 outcome='restore_failed' 再 fail-loud
 *       （restore 自身失败仍拒绝，审计不丢失）；
 *   - restore 已提交后 exposure log 写入失败 → 非致命（回滚不可重试）：resolve 并在 warnings
 *       显式给出"回滚已执行、日志未写入"，防止调用方重试 restore 造成双回滚。
 */
export async function runCanary(opts: CanaryRunOptions & { evaluator?: CanaryEvaluator }): Promise<CanaryRunResult> {
  // T8.15：判定器可注入（缺省 evaluateCanary 初值公式；e-process 引擎经 evaluateEProcess 注入——
  // runCanaryEProcess 便捷入口见下）。判定 → rollback 触发全自动回滚 + 审计（与初值路径同语义）。
  const evaluate = opts.evaluator ?? evaluateCanary;
  const { verdict, reason } = evaluate(opts.certificate);
  const warnings: string[] = [];
  let contract: RollbackContract | null = null;
  if (verdict === 'rollback') {
    try {
      contract = await rollbackCanary({
        candidate_id: opts.certificate.candidate_id,
        snapshot: opts.snapshot,
        scope: opts.scope,
        restore: opts.restore,
        affectedSessions: opts.affectedSessions,
      });
    } catch (err) {
      // 审计先行：restore 失败也先落盘回滚触发条目（outcome='restore_failed'），再 fail-loud
      try {
        await logExposure(opts.logPath, canaryEntry(opts, 'canary_rollback', 'restore_failed'));
      } catch {
        // 审计写入亦失败：不掩盖 restore 原始错误（fail-loud 优先级：restore 错误优先）
      }
      throw err;
    }
    // restore 已成功提交 → 记 outcome='ok'；log 失败非致命（回滚已执行，不得让调用方重试 restore）
    try {
      await logExposure(opts.logPath, canaryEntry(opts, 'canary_rollback', 'ok'));
    } catch (err) {
      warnings.push(
        `回滚已执行（target_snapshot=${opts.snapshot}）但 exposure log 写入失败：${
          err instanceof Error ? err.message : String(err)
        }——日志未写入，禁止重试 restore（双回滚风险）`,
      );
    }
  } else {
    await logExposure(opts.logPath, canaryEntry(opts, 'canary'));
  }
  return { verdict, reason, contract, warnings };
}

// ---- e-process 金丝雀（T8.15：初值公式 → anytime-valid 引擎；判定经 evaluateEProcess 注入） ----

/**
 * e-process 主判开关（P7 数据化；结构与 kernel/schemas/policy.ts EProcessPolicy 一致——shadow 层不
 * import 契约层（层声明仅 node: 内置 + zod），消费方直接传 policy.evolve.e_process（结构兼容）。
 * 缺省 'e-process' 主判（架构 §10.3 anytime-valid 为主判），初值规则保留为降级/对照。
 */
export interface EProcessPolicyConfig {
  /** 主判模式：'e-process'（Bernoulli 超鞅 anytime-valid 主判）/ 'rule'（初值规则主判，降级/对照） */
  mode: 'e-process' | 'rule';
  /** e-process 判定异常（统计/参数非法）→ 回退初值规则（fail-safe 不静默吞错；false → 异常上抛） */
  fallback_to_rule: boolean;
}

/** 缺省主判开关（anytime-valid 主判 + fallback 开；对齐 policy 缺省 DEFAULT_E_PROCESS_POLICY） */
export const DEFAULT_E_PROCESS_POLICY_CONFIG: EProcessPolicyConfig = { mode: 'e-process', fallback_to_rule: true };

/**
 * P7：数据化金丝雀判定器（主判开关）：
 *   - mode 'rule' → 初值规则 evaluateCanary（主判 = 规则，对照语义由调用方选择）；
 *   - mode 'e-process' → evaluateEProcess 主判 + 初值规则对照记录（两判定不一致时 reason 附 rule 对照）；
 *     判定异常（统计/参数非法）→ fallback_to_rule 时回退初值规则（reason 标注 fallback），否则上抛。
 * 测试/标定可注入 EProcessOptions（p0/p1/α）——结构保持 CanaryEvaluator 契约（可经 runCanary 注入）。
 */
export function buildCanaryEvaluator(cfg: EProcessPolicyConfig, opts: EProcessOptions = {}): CanaryEvaluator {
  return (cert) => {
    if (cfg.mode === 'rule') {
      return evaluateCanary(cert);
    }
    // 对照记录：e-process 主判 + 初值规则旁证（判定不一致时附注，审计可见；一致时 reason 保持 e-process 纯文案）
    const ruleVerdict = evaluateCanary(cert);
    try {
      const ep = evaluateEProcess(
        {
          n: cert.stat.n,
          failures: cert.stat.failures,
          min_n: cert.threshold.min_n,
          max_failure_rate: cert.threshold.max_failure_rate,
        },
        opts,
      );
      if (ep.verdict !== ruleVerdict.verdict) {
        return { verdict: ep.verdict, reason: `${ep.reason}（rule 对照: ${ruleVerdict.verdict}——${ruleVerdict.reason}）` };
      }
      return { verdict: ep.verdict, reason: ep.reason };
    } catch (err) {
      if (!cfg.fallback_to_rule) {
        throw err;
      }
      const detail = err instanceof Error ? err.message : String(err);
      return { verdict: ruleVerdict.verdict, reason: `${ruleVerdict.reason}（e-process fallback: ${detail}）` };
    }
  };
}

/**
 * P7：按主判开关运行金丝雀自动检查（数据化主判：cfg 缺省 = e-process 主判 + fallback 开；
 * 判定 → rollback 全自动回滚 + exposure log 审计，与 runCanary 语义一致）。
 */
export function runCanaryConfigured(
  opts: CanaryRunOptions,
  cfg: EProcessPolicyConfig = DEFAULT_E_PROCESS_POLICY_CONFIG,
): Promise<CanaryRunResult> {
  return runCanary({ ...opts, evaluator: buildCanaryEvaluator(cfg) });
}

/**
 * e-process 金丝雀自动检查：evaluateEProcess 判定（e ≥ 1/α → rollback，任意时刻拒绝零假设）→
 * 自动回滚 + exposure log 审计（与 runCanary 全自动语义一致）。判定器注入保持 runCanary 契约，
 * 本入口为 e-process 引擎的便捷接线（选型记录见 supervisor/e-process.ts）；
 * P7 定案：经主判开关接线（缺省 e-process 主判 + fallback，行为不变——判定不一致仅 reason 附对照注）。
 */
export function runCanaryEProcess(opts: CanaryRunOptions): Promise<CanaryRunResult> {
  return runCanaryConfigured(opts, DEFAULT_E_PROCESS_POLICY_CONFIG);
}

// ---- 便捷常量（日志路径约定：workspace/.omb/.evolution/exposure.log） ----

/** exposure log 相对 .omb 的路径（架构 §11.1：.evolution/ 为 AI 演化工作区） */
export const EXPOSURE_LOG_REL = join('.evolution', 'exposure.log');
