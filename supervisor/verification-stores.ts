// layer 1（supervisor/）：验证数据面三库 + 验证器注册库（P3.6 三库 + 专项 3 Verifier Evolution 注册面）。
// 事实库 FactStore + 基线库 BaselineStore + 任务库 TaskStore + 验证器库 VerifierStore：JSON 文件注册面（目录
// .evolution/verification/{facts,baselines,tasks,verifiers}，根由构造参数注入，缺省
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
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
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

// ---- 分片存储（已知问题《事实库小文件》修复：一键一文件 → 分片，键仍可寻址） ----
//
// 动机：事实库观测到 2,482 个 JSON 小文件（一键一文件）；目录规模随运行增长，读取与备份成本上升。
// 方案（保持键可寻址 + 向后兼容 + 无新依赖）：
//   - 分片文件 `<dir>/shard-<NNNNNN>.json`，内容是 `{ "records": { "<fileKey>": <record>, ... } }`；
//   - 分片归属 = 键的哈希低位（确定性：同键恒落同一分片，**单键寻址仍是一次文件读**）；
//   - 读取：先查分片（一次读，命中即返回），未命中再查单文件（未合并的写入）；
//   - 列全量：分片记录 + 单文件记录合并（同键以分片为准——合并时单文件已删，无重复）；
//   - 合并（compact）：把现有单文件按分片归属并入分片，成功后删单文件；幂等（重复调用无残留）。
// 与既有语义的关系：对外接口（registerFact/factsFor/all）完全不变；损坏仍 fail-loud。

/** 分片文件名（6 位零填充序号；与 64 位 hex 单文件名不冲突） */
const SHARD_FILE_RE = /^shard-(\d{6})\.json$/u;
/** 分片数（256：单文件数降到 1/256；§17 可标定） */
export const STORE_SHARD_COUNT = 256;

/** 分片序号（键哈希低位；确定性——同键恒同分片） */
function shardIndex(key: string, shards: number = STORE_SHARD_COUNT): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % shards;
}

/** 分片文件路径 */
function shardFile(dir: string, index: number): string {
  return join(dir, `shard-${String(index).padStart(6, '0')}.json`);
}

/** 分片内容形态（版本化：格式升级可识别） */
interface ShardFile {
  format: 'omb-store-shard/1';
  records: Record<string, unknown>;
}

/** 读单个分片（不存在 → null；损坏 → fail-loud） */
async function readShard(dir: string, index: number, label: string): Promise<ShardFile | null> {
  const file = shardFile(dir, index);
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`${label} shard read failed: ${file}: ${errorText(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${label} shard corrupt: ${file}: ${errorText(err)}`);
  }
  const obj = parsed as Partial<ShardFile> | null;
  if (obj === null || typeof obj !== 'object' || obj.records === null || typeof obj.records !== 'object') {
    throw new Error(`${label} shard invalid: ${file}: 结构非 {records}`);
  }
  return { format: 'omb-store-shard/1', records: obj.records as Record<string, unknown> };
}

/** 读单键（分片优先 → 单文件兜底）：分片归属与分片内键**同一口径**（都用 fileKey——写入侧即如此） */
async function readRecordSharded<T>(dir: string, key: string, label: string): Promise<T | null> {
  const shard = await readShard(dir, shardIndex(fileKey(key)), label);
  const fromShard = shard?.records[fileKey(key)];
  if (fromShard !== undefined) return fromShard as T;
  return readRecord<T>(dir, key, label);
}

/** 列全量（分片 + 单文件；同键以分片为准） */
async function listRecordsSharded<T>(dir: string, label: string): Promise<T[]> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out = new Map<string, T>();
  const singles: string[] = [];
  for (const f of files.sort()) {
    const m = SHARD_FILE_RE.exec(f);
    if (m !== null) {
      const shard = await readShard(dir, Number.parseInt(m[1]!, 10), label);
      for (const [k, v] of Object.entries(shard?.records ?? {})) {
        out.set(k, v as T);
      }
    } else if (f.endsWith('.json')) {
      singles.push(f);
    }
  }
  for (const f of singles) {
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
    const key = f.slice(0, -'.json'.length);
    if (!out.has(key)) {
      out.set(key, parsed as T);
    }
  }
  return [...out.values()];
}

/** 分片合并结果（可观测面） */
export interface ShardCompactResult {
  /** 写出的分片数 */
  shards: number;
  /** 合并进分片的记录数 */
  records: number;
  /** 删除的单文件数 */
  removedFiles: number;
}

/**
 * 分片合并（**幂等**）：把目录下的单文件按分片归属并入分片，成功后删单文件。
 * 失败语义：单文件删除失败 → 保留该文件（下次重试；读路径以分片为准，不产生重复语义）。
 */
async function compactShards(dir: string, label: string): Promise<ShardCompactResult> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { shards: 0, records: 0, removedFiles: 0 };
    throw err;
  }
  const singles = files.filter((f) => f.endsWith('.json') && SHARD_FILE_RE.exec(f) === null).sort();
  if (singles.length === 0) return { shards: 0, records: 0, removedFiles: 0 };
  const byShard = new Map<number, Record<string, unknown>>();
  const consumed: string[] = [];
  for (const f of singles) {
    const file = join(dir, f);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(file, 'utf8'));
    } catch {
      continue; // 损坏单文件跳过（读路径本就会 fail-loud；合并不因坏文件中断其余记录）
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      continue;
    }
    const key = f.slice(0, -'.json'.length);
    const idx = shardIndex(key);
    const recs = byShard.get(idx) ?? {};
    recs[key] = parsed;
    byShard.set(idx, recs);
    consumed.push(f);
  }
  let records = 0;
  for (const [idx, recs] of [...byShard.entries()].sort((a, b) => a[0] - b[0])) {
    const existing = (await readShard(dir, idx, label))?.records ?? {};
    const merged: Record<string, unknown> = { ...existing, ...recs };
    const file = shardFile(dir, idx);
    const tmp = `${file}.tmp`;
    await writeFile(tmp, `${JSON.stringify({ format: 'omb-store-shard/1', records: merged }, null, 2)}\n`, 'utf8');
    await rename(tmp, file);
    records += Object.keys(recs).length;
  }
  let removedFiles = 0;
  for (const f of consumed) {
    try {
      await rm(join(dir, f));
      removedFiles++;
    } catch {
      // 删除失败 → 保留（读路径以分片为准；下次 compact 重试）
    }
  }
  return { shards: byShard.size, records, removedFiles };
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
    const all = await listRecordsSharded<FactRecord>(this.dir, 'facts');
    const needle = query?.provenanceContains;
    if (needle === undefined || needle.length === 0) {
      return all;
    }
    return all.filter((f) => f.provenance.includes(needle));
  }

  /** 全量事实（损坏 → fail-loud 抛错） */
  async all(): Promise<FactRecord[]> {
    return listRecordsSharded<FactRecord>(this.dir, 'facts');
  }

  /** 按键读取（分片优先 → 单文件兜底；键仍可寻址——已知问题《事实库小文件》修复要求） */
  async get(id: string): Promise<FactRecord | null> {
    return readRecordSharded<FactRecord>(this.dir, id, 'facts');
  }

  /**
   * 分片合并（维护任务 fact_store_compact 调用；幂等）：一键一文件 → 分片，键仍可寻址。
   * 已知问题《事实库小文件》修复判定："合并或分片存储（保持键可寻址）"。
   */
  async compact(): Promise<ShardCompactResult> {
    return compactShards(this.dir, 'facts');
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

// ---- 验证器注册库（VerifierStore） ----

/**
 * 验证器注册记录（Verifier Evolution 注册面——用户裁决：固定规范 + 固定验证基准 + 独立测试集 + 自身版本号；
 * origin 为非循环检查用来源标识；registered_at 为注册时间戳）。
 * 替换语义：同 verifier_id 覆写 = 最新注册胜出（版本递增防回退由 kernel/verifier-evolution.ts 门禁保证——
 * 本库是注册面，不做门禁校验）。
 */
export interface VerifierRecord {
  /** 验证器 id */
  verifier_id: string;
  /** 固定规范：能证明什么（checks，至少一项非空）/ 证明不了什么（blind_spots，可为空 = 无声明盲区） */
  spec: { checks: string[]; blind_spots: string[] };
  /** 固定验证基准引用（validation_benchmark ref——已知验证集基准） */
  validation_benchmark: string;
  /** 独立测试集引用（independent_test_set ref——隐藏验证集基准） */
  independent_test_set: string;
  /** 自身版本号（非负整数字符串约定，与 P3.6 verifier_version '1' 一致；替换门禁消费：严格递增防回退） */
  version: string;
  /** 来源标识（可选；非循环检查用——origin === verifier_id → 拒绝） */
  origin?: string;
  /** 注册时间戳（epoch ms；调用方注入——存储层不读墙钟） */
  registered_at: number;
}

/** 验证器库：Verifier Evolution 注册面（同 verifier_id 覆写——最新注册胜出；与三库同文件/原子写/降级语义） */
export class VerifierStore {
  private readonly dir: string;
  private writeError: string | null = null;

  constructor(opts: { root: string }) {
    this.root = opts.root;
    this.dir = join(opts.root, 'verifiers');
  }

  /** 注册面根目录（审计 JSONL 落盘 <root>/verifier-evolution.jsonl 用——kernel verifier-evolution 消费） */
  readonly root: string;

  /** 最近一次写降级原因（无 → null；写失败降级记录不抛——审计面） */
  get degraded(): string | null {
    return this.writeError;
  }

  /** 落地侧降级记录（审计写失败等——kernel verifier-evolution 消费；尽力而为记录不抛） */
  noteDegraded(reason: string): void {
    this.writeError = reason;
  }

  /** 注册/覆写验证器（同 verifier_id 覆写；写失败降级记录不抛） */
  async registerVerifier(rec: VerifierRecord): Promise<void> {
    this.writeError = await writeRecord(this.dir, rec.verifier_id, rec, 'verifiers');
  }

  /** 按 verifier_id 取验证器（无 → null；损坏 → fail-loud 抛错） */
  async getVerifier(verifier_id: string): Promise<VerifierRecord | null> {
    return readRecord<VerifierRecord>(this.dir, verifier_id, 'verifiers');
  }

  /** 验证器清单（损坏 → fail-loud 抛错） */
  async listVerifiers(): Promise<VerifierRecord[]> {
    return listRecords<VerifierRecord>(this.dir, 'verifiers');
  }
}

// ---- 四库装配 ----

/** 四库聚合（facts/baselines/tasks/verifiers——同一 verification 根目录；assembly 装配期构造） */
export interface VerificationStores {
  facts: FactStore;
  baselines: BaselineStore;
  tasks: TaskStore;
  /** 验证器注册库（Verifier Evolution 注册面——替换门禁消费） */
  verifiers: VerifierStore;
}

/** 四库工厂（root = .evolution/verification 根；内部建 facts/baselines/tasks/verifiers 子目录） */
export function createVerificationStores(root: string): VerificationStores {
  return {
    facts: new FactStore({ root }),
    baselines: new BaselineStore({ root }),
    tasks: new TaskStore({ root }),
    verifiers: new VerifierStore({ root }),
  };
}
