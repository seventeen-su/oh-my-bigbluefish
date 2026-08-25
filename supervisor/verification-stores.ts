// layer 1（supervisor/）：验证数据面三库（P3.6——用户 2026-08-25 第二阶段裁决 S1）。
// 事实库 FactStore + 基线库 BaselineStore + 任务库 TaskStore：JSON 文件注册面（目录
// .evolution/verification/{facts,baselines,tasks}，根由构造参数注入，缺省
// <cwd>/workspace/.omb/.evolution/verification——与 debt.json 同根系）。
//
// 记录存储：每库目录下每记录一个 JSON 文件（文件名 = 复合键 sha256 hex——Windows 文件名安全，
// 任意 id（含 ':' 等非法字符）均可注册；同键覆写 = 同文件原子重写 tmp+rename）。
// 原子写：writeFile(<file>.tmp) → rename(tmp, file)——进程内读永远看不到半截文件（与
// maintenance debt.json 同款 tmp+rename 语义）。
//
// 语义（与 debt.json 同风格）：
//   · 文件不存在 → 空（null/[]——首写建目录）；
//   · 损坏 JSON → fail-loud 抛错（读侧不静默吞错——注册面损坏是真实数据问题）；
//   · 写失败 → 降级记录不抛（尽力而为——注册面缺失/不可写不阻塞验证主链，degraded 可审计）。
//
// 版本化（用户裁决 S1 关键）：基线对象 = {输入 + 环境指纹 + 运行时快照 + 期望结果 + 验证器版本}——
// 未来演化后才能知道"究竟和哪个历史状态比较"：verifier_version 变化 / 环境指纹漂移 / 运行时快照
// 不同 → 版本化对比 unknown（基线过期需重放确认），而不是拿新状态硬比旧基线。
//
// 层 DAG：layer 1（supervisor/）仅 import node: 内置（不 import kernel 逻辑——IR 契约例外仅
// kernel/schemas，本文件不需要）；消费方 = runtime(2)（assembly/repair-executors）与 tests（豁免）。
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// ---- 记录类型（版本化字段全量保留） ----

/** 事实记录（已确认 Claim 的当前有效性；valid=false = 已推翻/矛盾） */
export interface FactRecord {
  /** Claim id（claim:<uuid>） */
  id: string;
  /** Claim 文本（可读摘要） */
  text: string;
  /** Claim 来源锚点 id（provenance 子串查询面——无矛盾检查按对象 id 关联事实） */
  provenance: string;
  /** 当前有效性（false = 已推翻/矛盾——矛盾检查命中即 fail） */
  valid: boolean;
}

/** 基线 kind 枚举（用户裁决 S1：Process 首次成功快照 / Skill 代表任务 / Policy 冻结回归集 / Projection 重建输入） */
export const BASELINE_KINDS = ['process', 'skill-task', 'policy-regression', 'projection-rebuild'] as const;
export type BaselineKind = (typeof BASELINE_KINDS)[number];

/**
 * 版本化基线记录（用户裁决 S1）：{输入 + 环境指纹 + 运行时快照 + 期望结果 + 验证器版本}——
 * 未来演化后与"哪个历史状态比较"由这组字段定位：input=当时验证的输入；environment_fingerprint=
 * 当时环境（os/node/dsh_version/project）；runtime_snapshot=当时运行时快照（rs:<16hex>）；
 * expected_result=当时判定摘要（verdict/evidence_quality/disposition）；verifier_version=验证器
 * 版本（'1' 起；Verifier Evolution 后递增——版本不等 → 基线过期需重放确认，不得直接对比）。
 */
export interface BaselineRecord {
  /** 对象 id（与 repair 受影响对象 id 一致） */
  id: string;
  /** 基线 kind（BASELINE_KINDS 枚举） */
  kind: BaselineKind;
  /** 验证输入（对象 payload / 契约摘要；policy-regression 为 {policy, cases[]}，projection-rebuild 为 {rebuild_input}） */
  input: unknown;
  /** 注册时环境指纹（collectEnvironmentFingerprint 采集面） */
  environment_fingerprint: Record<string, unknown>;
  /** 注册时运行时快照哈希（assembly snapshotHash） */
  runtime_snapshot: string;
  /** 注册时判定摘要（verdict/evidence_quality/disposition——重放对比的期望结果） */
  expected_result: unknown;
  /** 验证器版本（与当前验证器版本比对——不等 → 基线过期需重放确认） */
  verifier_version: string;
}

/** 任务记录（Task Contract / Success Criteria / Verifier——任务库注册面） */
export interface TaskRecord {
  task_id: string;
  /** 任务契约引用（验证契约 id 或任务规格 id） */
  contract_ref: string;
  /** 成功条件清单 */
  success_criteria: string[];
  /** 验证器引用清单（验证任务判定的 verifier id 集） */
  verifier_refs: string[];
}

// ---- 小工具（确定性、中文可审计） ----

/** 复合键 → 文件名（sha256 hex——Windows 文件名安全，任意 id 可注册；同键同文件 → 覆写语义） */
function fileKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

/** 错误信息提取（确定性；非 Error → String） */
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 单记录读取：文件不存在 → null；损坏 JSON / 非对象 → fail-loud 抛错（与 debt.json 同风格） */
async function readRecord<T>(dir: string, key: string, label: string): Promise<T | null> {
  const file = join(dir, `${fileKey(key)}.json`);
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null; // 文件不存在 → 空（无记录）
    }
    throw new Error(`${label} read failed: ${file}: ${errorText(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${label} file corrupt: ${file}: ${errorText(err)}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} file invalid: ${file}: 记录非对象`);
  }
  return parsed as T;
}

/** 目录全量读取：目录不存在 → []；任一条损坏 JSON → fail-loud 抛错 */
async function listRecords<T>(dir: string, label: string): Promise<T[]> {
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return []; // 目录不存在 → 空（首写建目录）
    }
    throw err;
  }
  const out: T[] = [];
  for (const f of files) {
    const file = join(dir, f);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(file, 'utf8'));
    } catch (err) {
      throw new Error(`${label} file corrupt: ${file}: ${errorText(err)}`);
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${label} file invalid: ${file}: 记录非对象`);
    }
    out.push(parsed as T);
  }
  return out;
}

/**
 * 原子写（tmp + rename）：建目录 → 写 <file>.tmp → rename 到 <file>——同进程内读不见半截文件。
 * 失败 → 返回降级原因（调用方记录不抛——尽力而为，注册面缺失不阻塞验证主链）。
 */
async function writeRecord(dir: string, key: string, record: unknown, label: string): Promise<string | null> {
  try {
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${fileKey(key)}.json`);
    const tmp = `${file}.tmp`;
    await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    await rename(tmp, file);
    return null; // 无降级
  } catch (err) {
    return `${label} 写入失败（尽力而为降级，不阻塞验证主链）：${errorText(err)}`;
  }
}

// ---- 事实库（FactStore） ----

/** 事实库：已确认 Claim / Provenance / 当前有效性（同 id 覆写——最新观测胜出） */
export class FactStore {
  private readonly dir: string;
  private writeError: string | null = null;

  constructor(opts: { root: string }) {
    this.dir = join(opts.root, 'facts');
  }

  /** 最近一次写降级原因（无 → null；写失败降级记录不抛——审计面） */
  get degraded(): string | null {
    return this.writeError;
  }

  /** 注册/覆写事实（同 id 覆写；写失败降级记录不抛） */
  async registerFact(fact: FactRecord): Promise<void> {
    this.writeError = await writeRecord(this.dir, fact.id, fact, 'facts');
  }

  /** 按 provenance 子串查询（缺省/空对象 → 全量）；损坏 → fail-loud 抛错 */
  async factsFor(query?: { provenanceContains?: string }): Promise<FactRecord[]> {
    const all = await listRecords<FactRecord>(this.dir, 'facts');
    const needle = query?.provenanceContains;
    if (needle === undefined || needle.length === 0) {
      return all;
    }
    return all.filter((f) => f.provenance.includes(needle));
  }

  /** 全量事实（损坏 → fail-loud 抛错） */
  async all(): Promise<FactRecord[]> {
    return listRecords<FactRecord>(this.dir, 'facts');
  }
}

// ---- 基线库（BaselineStore） ----

/** 基线库：Process 首次成功快照 / Skill 代表任务 / Policy 冻结回归集 / Projection 重建输入（同 id+kind 覆写） */
export class BaselineStore {
  private readonly dir: string;
  private writeError: string | null = null;

  constructor(opts: { root: string }) {
    this.dir = join(opts.root, 'baselines');
  }

  /** 最近一次写降级原因（无 → null） */
  get degraded(): string | null {
    return this.writeError;
  }

  /** 注册/覆写基线（同 id+kind 覆写；版本化字段全量保留；写失败降级记录不抛） */
  async registerBaseline(baseline: BaselineRecord): Promise<void> {
    this.writeError = await writeRecord(this.dir, `${baseline.kind}\u0000${baseline.id}`, baseline, 'baselines');
  }

  /** 按 id+kind 取基线（无 → null；损坏 → fail-loud 抛错） */
  async getBaseline(id: string, kind: BaselineKind): Promise<BaselineRecord | null> {
    return readRecord<BaselineRecord>(this.dir, `${kind}\u0000${id}`, 'baselines');
  }

  /** 基线清单（kind 过滤可选；损坏 → fail-loud 抛错） */
  async list(kind?: BaselineKind): Promise<BaselineRecord[]> {
    const all = await listRecords<BaselineRecord>(this.dir, 'baselines');
    return kind === undefined ? all : all.filter((b) => b.kind === kind);
  }
}

// ---- 任务库（TaskStore） ----

/** 任务库：Task Contract / Success Criteria / Verifier（同 task_id 覆写） */
export class TaskStore {
  private readonly dir: string;
  private writeError: string | null = null;

  constructor(opts: { root: string }) {
    this.dir = join(opts.root, 'tasks');
  }

  /** 最近一次写降级原因（无 → null） */
  get degraded(): string | null {
    return this.writeError;
  }

  /** 注册/覆写任务（同 task_id 覆写；写失败降级记录不抛） */
  async registerTask(task: TaskRecord): Promise<void> {
    this.writeError = await writeRecord(this.dir, task.task_id, task, 'tasks');
  }

  /** 按 task_id 取任务（无 → null；损坏 → fail-loud 抛错） */
  async getTask(task_id: string): Promise<TaskRecord | null> {
    return readRecord<TaskRecord>(this.dir, task_id, 'tasks');
  }

  /** 任务清单（损坏 → fail-loud 抛错） */
  async list(): Promise<TaskRecord[]> {
    return listRecords<TaskRecord>(this.dir, 'tasks');
  }
}

// ---- 三库装配 ----

/** 三库聚合（同一 verification 根目录；assembly 装配期构造） */
export interface VerificationStores {
  facts: FactStore;
  baselines: BaselineStore;
  tasks: TaskStore;
}

/** 三库工厂（root = .evolution/verification 根；内部建 facts/baselines/tasks 子目录） */
export function createVerificationStores(root: string): VerificationStores {
  return {
    facts: new FactStore({ root }),
    baselines: new BaselineStore({ root }),
    tasks: new TaskStore({ root }),
  };
}
