// layer 2（kernel/）：Verifier Evolution 第一阶段——替换门禁 + 审计落地（第二阶段专项 3，用户 2026-08-25 裁决）。
// 范围（裁决：第一阶段只做注册面 + 门禁，不做自动进化）：
//   ① candidateVerifierGate（纯函数，零 I/O、零墙钟、确定性）：Verifier Candidate → 结构检查 → 非循环自证 →
//      无现任首登 → 版本严格递增 → 已知验证集 → 隐藏验证集 → 与当前 Verifier 交叉比较 → 人工/高可信 Judge
//      低频复核 → 才允许替代（known/hidden/cross/human 四项全 true 才 ok，reason 中文可审计）；
//   ② applyVerifierReplacement（落地面）：门禁通过 → store.registerVerifier（成为现任）+ 审计 JSONL 落盘
//      <store.root>/verifier-evolution.jsonl（append；写失败降级记录不抛；损坏行跳过——审计日志语义）。
// 宪法原则（Verifier Evolution 属最高风险演化对象）：新验证器不能决定自己的验证标准——reward hacking /
//   verifier gaming 是 Agent 系统最高风险攻击面（SpecBench 实证：coding agent 针对可见测试投机）；因此
//   origin 等于候选自身的验证器一律拒绝（nonCircularityCheck，先于首登判定——fail-closed），且已知/隐藏/
//   交叉/人工复核四项全 true 才允许替换。
// 层 DAG：kernel 不 import supervisor——store 以最小形状 VerifierStoreLike 注入（supervisor.VerifierStore
//   结构兼容）；本文件仅 import node: 内置 + kernel/schemas/verification.js + kernel/verification.js 的
//   nonCircularityCheck（函数与类型）。trustGate 不在本阶段门禁消费（四个布尔结果即「人工/高可信 Judge 复核」
//   语义面；trustGate 由既有 P4 stablePromotionTrustGate 晋升链路消费）——不引入未使用符号（lint 纪律）。
// 确定性：candidateVerifierGate 同输入 → 同输出；audit_id = 确定性字段（trigger/old/new/replaced）sha256
//   前缀 12——同参数同 id；审计 ts 为落地事件墙钟（I/O 副作用成分，非纯函数字段，测试锚定非时间字段）。
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Verifier } from './schemas/verification.js';
import { nonCircularityCheck, type NonCircularityVerdict } from './verification.js';

// ---- 类型（门禁面） ----

/**
 * 替换候选（门禁消费子集 verifier_id/version/spec/origin；validation_benchmark / independent_test_set /
 * registered_at 为落地注册全量字段——applyVerifierReplacement 消费）。
 */
export interface VerifierCandidate {
  /** 候选验证器 id */
  verifier_id: string;
  /** 候选版本号（非负整数字符串约定——替换须严格大于现任；防回退） */
  version: string;
  /** 固定规范（对齐契约层 Verifier 覆盖声明：能证明什么 checks / 证明不了什么 blind_spots） */
  spec: Pick<Verifier, 'checks' | 'blind_spots'>;
  /** 固定验证基准引用（VerifierRecord 注册字段——已知验证集基准） */
  validation_benchmark: string;
  /** 独立测试集引用（VerifierRecord 注册字段——隐藏验证集基准） */
  independent_test_set: string;
  /** 来源标识（可选；非循环检查用——origin === verifier_id → 拒绝） */
  origin?: string;
  /** 注册时间戳（可选；缺省由 applyVerifierReplacement 以落地墙钟填充） */
  registered_at?: number;
}

/** 现任验证器（替换对照：版本递增基准） */
export interface CurrentVerifier {
  verifier_id: string;
  version: string;
}

/** 门禁结果（已知验证集 / 隐藏验证集 / 交叉比较 / 人工复核——四项全 true 才允许替换；本阶段布尔由调用方注入） */
export interface VerifierGateResults {
  known_set_passed: boolean;
  hidden_set_passed: boolean;
  cross_compare_consistent: boolean;
  human_reviewed: boolean;
}

/** 门禁判定（ok=false = 拒绝；reason 中文可审计） */
export interface GateVerdict {
  ok: boolean;
  reason: string;
}

// ---- 类型（落地面：最小形状注入——层 DAG 合规，kernel 不 import supervisor） ----

/** 注册记录形状（与 supervisor.VerifierRecord 结构一致——本地定义避免 kernel → supervisor import） */
export interface VerifierRecordLike {
  verifier_id: string;
  spec: { checks: string[]; blind_spots: string[] };
  validation_benchmark: string;
  independent_test_set: string;
  version: string;
  origin?: string;
  registered_at: number;
}

/** 门禁落地面最小存储形状（supervisor.VerifierStore 结构兼容——含公开 root 与 noteDegraded） */
export interface VerifierStoreLike {
  /** 注册面根目录（.evolution/verification——审计 JSONL 落盘 <root>/verifier-evolution.jsonl） */
  root: string;
  /** 注册/覆写验证器（同 verifier_id 覆写；写失败降级记录不抛） */
  registerVerifier(rec: VerifierRecordLike): Promise<void>;
  /** 降级记录（可选面：审计写失败等落地侧降级——尽力而为记录不抛） */
  noteDegraded?(reason: string): void;
}

/** 审计行（verifier-evolution.jsonl；审计日志语义：损坏行跳过） */
export interface VerifierEvolutionAuditLine {
  /** 审计 id（sha256 前缀 12；确定性——由 trigger/old/new/replaced 派生，不含墙钟） */
  audit_id: string;
  /** 落地事件时间戳（epoch ms；apply 注入——审计为 I/O 副作用，非纯函数字段） */
  ts: number;
  /** 被替换验证器 id（无现任 → null） */
  old_verifier_id: string | null;
  /** 被替换验证器版本（无现任 → null） */
  old_version: string | null;
  /** 新任验证器 id */
  new_verifier_id: string;
  /** 新任验证器版本 */
  new_version: string;
  /** 门禁判定 reason（含通过/拒绝原因——可审计） */
  gate_reason: string;
  /** 触发上下文（调用方注入：如 'manual:verifier-review' / 'bench:regression'） */
  trigger: string;
  /** 是否实际完成替换（门禁 ok 且注册成功 → true） */
  replaced: boolean;
  /** 替换主体（门禁通过 → 'gate'；未替换 → null） */
  replaced_by: 'gate' | null;
  /** 降级附注（注册抛错降级等） */
  note?: string;
}

// ---- 小工具（确定性） ----

/** 错误信息提取（确定性；非 Error → String） */
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 版本递增判定（防回退）：两者须为非负整数字符串（与 P3.6 verifier_version '1' 约定一致）；
 * 任一非整数 → false（fail-closed——无法判定严格递增即拒绝，不静默放行）。
 */
function versionGreater(a: string, b: string): boolean {
  const na = /^\d+$/.test(a) ? Number(a) : NaN;
  const nb = /^\d+$/.test(b) ? Number(b) : NaN;
  if (Number.isNaN(na) || Number.isNaN(nb)) {
    return false;
  }
  return na > nb;
}

/** 审计 id：确定性字段（trigger/old_version/new_id/new_version/replaced）sha256 前缀 12——同参数同 id */
function deriveAuditId(opts: {
  trigger: string;
  oldVersion: string | null;
  newVerifierId: string;
  newVersion: string;
  replaced: boolean;
}): string {
  const payload = [
    opts.trigger,
    opts.oldVersion ?? 'none',
    opts.newVerifierId,
    opts.newVersion,
    opts.replaced ? 'ok' : 'refused',
  ].join('\u0000');
  return createHash('sha256').update(payload, 'utf8').digest('hex').slice(0, 12);
}

// ---- ① 替换门禁（纯函数：零 I/O、零墙钟、确定性） ----

/**
 * Verifier Candidate 替换门禁（第一阶段——只做门禁，不做自动进化）：
 *   ① 结构检查：spec.checks 非空数组且全部为非空字符串（spec 形状合法）——不满足 → 拒绝；
 *   ② 非循环自证（最高风险攻击面）：candidate.origin === candidate.verifier_id → 拒绝——新验证器不能
 *      决定自己的验证标准（先于首登判定——fail-closed：自证候选连首登都不允许）；
 *   ③ current 为 undefined（无现任）→ 允许注册（首登引导路径），reason 注明「无现任验证器——首登」；
 *   ④ candidate.version 必须严格大于 current.version（版本递增；防回退）——否则拒绝；
 *   ⑤ known/hidden/cross/human 全 true → ok；任一 false → 拒绝（reason 列明缺失项）。
 * 确定性：同输入 → 同输出（测试锚定）。
 */
export function candidateVerifierGate(
  candidate: VerifierCandidate,
  current: CurrentVerifier | undefined,
  results: VerifierGateResults,
): GateVerdict {
  // ① 结构检查
  if (!Array.isArray(candidate.spec.checks) || candidate.spec.checks.length === 0) {
    return { ok: false, reason: `结构检查拒绝：spec.checks 必须为非空数组（候选 ${candidate.verifier_id}）` };
  }
  for (const check of candidate.spec.checks) {
    if (typeof check !== 'string' || check.trim().length === 0) {
      return {
        ok: false,
        reason: `结构检查拒绝：spec.checks 全部必须为非空字符串（候选 ${candidate.verifier_id} 存在空项）`,
      };
    }
  }
  // ② 非循环自证（新验证器不能决定自己的验证标准——宪法原则落实为门禁规则）
  const circ: NonCircularityVerdict = nonCircularityCheck({ origin: candidate.origin }, candidate.verifier_id);
  if (!circ.ok) {
    return { ok: false, reason: circ.reason };
  }
  // ③ 首登（无现任——引导路径；不要求版本递增/验证集结果——没有可对照的现任）
  if (current === undefined) {
    return {
      ok: true,
      reason: `无现任验证器——首登（候选 ${candidate.verifier_id} v${candidate.version}；结构合法 + 非循环通过）`,
    };
  }
  // ④ 版本递增（防回退）
  if (!versionGreater(candidate.version, current.version)) {
    return {
      ok: false,
      reason: `版本递增拒绝：候选版本（${candidate.version}）必须严格大于现任版本（${current.version}）——防回退`,
    };
  }
  // ⑤ 已知/隐藏验证集 + 交叉比较 + 人工复核（全 true → ok；任一 false → 拒绝并列明缺失项）
  const missing: string[] = [];
  if (!results.known_set_passed) {
    missing.push('known_set_passed');
  }
  if (!results.hidden_set_passed) {
    missing.push('hidden_set_passed');
  }
  if (!results.cross_compare_consistent) {
    missing.push('cross_compare_consistent');
  }
  if (!results.human_reviewed) {
    missing.push('human_reviewed');
  }
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `验证结果拒绝——缺失：${missing.join('、')}（候选 ${candidate.verifier_id} v${candidate.version}）`,
    };
  }
  return {
    ok: true,
    reason:
      `替换门禁通过：结构合法 + 非循环 + 版本递增（${current.version} → ${candidate.version}）` +
      `+ 已知/隐藏验证集 + 交叉比较 + 人工复核全过（候选 ${candidate.verifier_id}）`,
  };
}

// ---- ② 落地（审计 JSONL append + 替换应用——I/O 副作用；失败降级记录不抛） ----

/** 审计 JSONL append（追加一行完整 JSON；失败 → 返回降级原因——调用方记录不抛，尽力而为） */
async function appendAuditLine(file: string, line: VerifierEvolutionAuditLine): Promise<string | null> {
  try {
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify(line)}\n`, 'utf8');
    return null;
  } catch (err) {
    return `verifier-evolution 审计写入失败（尽力而为降级，不抛）：${errorText(err)}`;
  }
}

/**
 * 审计 JSONL 读取（<store.root>/verifier-evolution.jsonl）：文件不存在 → []；
 * 损坏行/非对象行 → 跳过（审计日志语义——坏行留给运维，不阻塞后续读取）。
 */
export async function readVerifierEvolutionAudit(file: string): Promise<VerifierEvolutionAuditLine[]> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return []; // 文件不存在 → 空（未发生替换）
    }
    throw err;
  }
  const out: VerifierEvolutionAuditLine[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        out.push(parsed as VerifierEvolutionAuditLine);
      }
    } catch {
      // 损坏行跳过（审计日志语义）
    }
  }
  return out;
}

/**
 * 替换落地（门禁通过 → 注册为现任 + 审计 JSONL 落盘；门禁拒绝 → 不注册 + 拒绝审计行——可审计的拒绝历史）：
 *   · gateResult.ok → store.registerVerifier（candidate + registered_at）→ 审计行 replaced=true / replaced_by='gate'；
 *   · gateResult.ok=false → 不写注册 → 审计行 replaced=false / replaced_by=null（拒绝历史）；
 *   · store.registerVerifier 抛错 → 降级：不向外抛，本次替换未完成（审计行 replaced=false + note 降级原因）；
 *   · 审计写失败 → 降级记录（store.noteDegraded）不抛。
 * 返回 { replaced, audit_id }——audit_id 确定性（trigger/old/new/replaced 派生，同参数同 id）。
 */
export async function applyVerifierReplacement(
  store: VerifierStoreLike,
  candidate: VerifierCandidate,
  current: CurrentVerifier | undefined,
  gateResult: GateVerdict,
  trigger: string,
): Promise<{ replaced: boolean; audit_id: string }> {
  let replaced = gateResult.ok;
  let note: string | undefined;

  if (gateResult.ok) {
    const record: VerifierRecordLike = {
      verifier_id: candidate.verifier_id,
      version: candidate.version,
      spec: candidate.spec,
      validation_benchmark: candidate.validation_benchmark,
      independent_test_set: candidate.independent_test_set,
      ...(candidate.origin !== undefined ? { origin: candidate.origin } : {}),
      registered_at: candidate.registered_at ?? Date.now(),
    };
    try {
      await store.registerVerifier(record);
    } catch (err) {
      // 注册抛错 → 降级：不向外抛；本次替换未完成（审计行如实标记 replaced=false + note）
      replaced = false;
      note = `registerVerifier 抛错降级：${errorText(err)}`;
    }
  }

  const audit: VerifierEvolutionAuditLine = {
    audit_id: deriveAuditId({
      trigger,
      oldVersion: current?.version ?? null,
      newVerifierId: candidate.verifier_id,
      newVersion: candidate.version,
      replaced,
    }),
    ts: Date.now(),
    old_verifier_id: current?.verifier_id ?? null,
    old_version: current?.version ?? null,
    new_verifier_id: candidate.verifier_id,
    new_version: candidate.version,
    gate_reason: gateResult.reason,
    trigger,
    replaced,
    replaced_by: replaced ? 'gate' : null,
    ...(note !== undefined ? { note } : {}),
  };

  const degrade = await appendAuditLine(join(store.root, 'verifier-evolution.jsonl'), audit);
  if (degrade !== null) {
    store.noteDegraded?.(degrade);
  }
  return { replaced, audit_id: audit.audit_id };
}
