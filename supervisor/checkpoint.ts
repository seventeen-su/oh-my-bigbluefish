// OMB v2 Working Memory Checkpoint（架构 §4.2 M7 / §5.2 / §11.3 事务模型）：layer 1 单文件快照存储。
// save(state, opts) → Checkpoint：M7 对象 + 内嵌完整 state 落盘为单文件 JSON <dir>/<uuid>.json。
// checkpoint_id = `checkpoint:<uuid>`；文件名用 uuid 尾段——Windows 文件名不允许 ':'，checkpoint: 前缀剥离
//   （与 ArtifactStore 目录命名同风格，§4.3 已注）。
// 完整性（§11.3 Checkpoint 事务 = 单文件写 + hash）：hash = sha256(canonical JSON of
//   {working_state: 完整 state, timestamp, runtime_snapshot})——覆盖全部可变内容；restore 重算比对，
//   不一致 → 拒绝（损坏检测）。hash 输入为 round-trip 后的 state（JSON.parse(JSON.stringify())），
//   与 restore 从落盘 JSON 重算的 canonical 形式恒一致——显式 undefined 可选键（如 Fingerprint gpu/cuda）
//   在落盘时被 stringify 丢弃，live 对象直接哈希会与 parsed 对象不一致（T1.5 评审缺陷 1）。
//   working_state 引用（= state.id）与 state 自洽校验兜底引用篡改。
// restore 额外校验内容 id 与请求 id 绑定（hash 不含 id/文件名，改名/复制文件不得静默恢复，T1.5 评审缺陷 2）。
// 原子写：先写 <uuid>.json.tmp 再 rename（防半写）+ 单文件 fsync。
// list/latest：只认正式文件（uuid 形状的 *.json，忽略 .tmp 残留与无关文件）；损坏文件跳过
//   （§11.3 恢复 = 上次完好 checkpoint）；按 timestamp 倒序。
// 契约（主会话裁决 2026-08-21）：save 的 state 必须来自带 initial 的完整回放或既有 checkpoint 恢复
//   （保证 schema 合规）；checkpoint 自身 hash 与 state 自洽即可，M1 不要求重放校验。
// layer 1（supervisor/）：仅 import node: 内置 + kernel/schemas/（IR 契约例外，CONVENTIONS §4）。
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalJson, isValidId, makeMutableId, type Provenance } from '../kernel/schemas/base.js';
import { CheckpointSchema, type Checkpoint } from '../kernel/schemas/m.js';
import type { State } from '../kernel/schemas/s.js';

/** 正式 checkpoint 文件名的 uuid 段形状（tmp 残留 <uuid>.json.tmp 不匹配，天然被忽略） */
const FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/i;
const CHECKPOINT_PREFIX = 'checkpoint:';
/** 轮转：每会话保留最近 N 个（缺省 3；§17 可标定） */
export const CHECKPOINT_PER_SESSION_KEEP = 3;
/** 轮转：全局保留上限（缺省 200 个文件——观测面 4636 文件/34MB 的直接治理目标；§17 可标定） */
export const CHECKPOINT_MAX_FILES = 200;
/** 轮转：时间上限（缺省 30 天；超龄且不在会话保留位 → 删除；§17 可标定） */
export const CHECKPOINT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** 落盘 Checkpoint：M7 字段 + 内嵌完整 state（文件内容 = 完整 Checkpoint 对象 JSON，含 state 与 hash） */
export interface StoredCheckpoint extends Checkpoint {
  state: State;
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** hash 输入 = {working_state: 完整 state, timestamp, runtime_snapshot}（brief 语义：working_state 内容即状态） */
function contentHash(state: State, timestamp: string, runtimeSnapshot: string): string {
  return sha256Hex(canonicalJson({ working_state: state, timestamp, runtime_snapshot: runtimeSnapshot }));
}

/** 落盘路径：uuid 尾段 + .json（'checkpoint:' 在 Windows 文件名中非法，剥离前缀） */
function fileFor(dir: string, id: string): string {
  return join(dir, `${id.slice(CHECKPOINT_PREFIX.length)}.json`);
}

/** M7 视图：剥离内嵌 state（list 返回 Checkpoint 本体，完整 state 经 restore 取回） */
function checkpointView(stored: StoredCheckpoint): Checkpoint {
  const cp = { ...stored } as Partial<StoredCheckpoint>;
  delete cp.state;
  return cp as Checkpoint;
}

/** 解析落盘 JSON 并校验必需字段；缺字段/JSON 损坏 → fail-loud */
function parseStored(raw: string, id: string): StoredCheckpoint {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    throw new Error(`checkpoint: checkpoint 文件损坏（JSON 解析失败）: ${id}`);
  }
  const s = (obj ?? {}) as Partial<StoredCheckpoint> & Record<string, unknown>;
  if (
    typeof s.hash !== 'string' ||
    s.hash.length === 0 ||
    typeof s.timestamp !== 'string' ||
    s.timestamp.length === 0 ||
    typeof s.runtime_snapshot !== 'string' ||
    s.runtime_snapshot.length === 0 ||
    typeof s.working_state !== 'string' ||
    s.working_state.length === 0 ||
    typeof s.state !== 'object' ||
    s.state === null
  ) {
    throw new Error(`checkpoint: checkpoint 结构损坏（缺 hash/timestamp/runtime_snapshot/working_state/state）: ${id}`);
  }
  return s as StoredCheckpoint;
}

/** 保存：M7 对象 + 内嵌 state → <dir>/<uuid>.json（tmp + rename + fsync 原子写）。
 *  opts.session_id（已知问题《工作状态未按会话隔离》修复）：写入会话维度，供读取时按会话取最新；
 *  hash 仍只覆盖 {state, timestamp, runtime_snapshot}（会话归属不是内容完整性的一部分）。 */
export async function save(
  state: State,
  opts: { dir: string; runtime_snapshot?: string; provenance?: Provenance; session_id?: string },
): Promise<Checkpoint> {
  const ts = new Date().toISOString();
  const runtimeSnapshot = opts.runtime_snapshot ?? state.provenance.runtime_snapshot;
  const provenance: Provenance = opts.provenance ?? {
    source: 'system',
    event: state.provenance.event,
    actor: 'kernel',
    environment: state.provenance.environment,
    runtime_snapshot: runtimeSnapshot,
    timestamp: ts,
    transformation_chain: [],
    verification: 'checkpoint',
  };
  const checkpoint: Checkpoint = {
    id: makeMutableId('checkpoint'),
    ir_version: state.ir_version,
    schema: 'omb/M7',
    scope: state.scope,
    lifecycle: 'active',
    immutable: false,
    owner: 'kernel',
    created: ts,
    updated: ts,
    provenance,
    refs: [],
    working_state: state.id,
    // 缺陷 1 修复：hash 对象必须是 round-trip 后的 state——落盘 JSON.stringify 会丢弃显式 undefined
    // 可选键，live 对象哈希与 restore 对 parsed 对象重算的 canonical 形式不一致 → 合法保存 restore 抛错
    hash: contentHash(JSON.parse(JSON.stringify(state)) as State, ts, runtimeSnapshot),
    timestamp: ts,
    runtime_snapshot: runtimeSnapshot,
    ...(opts.session_id !== undefined && opts.session_id.length > 0 ? { session_id: opts.session_id } : {}),
  };
  const parsed = CheckpointSchema.safeParse(checkpoint);
  if (!parsed.success) {
    throw new Error(`checkpoint.save: M7 schema 校验失败 — ${parsed.error.message}`);
  }
  await mkdir(opts.dir, { recursive: true });
  const file = fileFor(opts.dir, checkpoint.id);
  const tmp = `${file}.tmp`;
  const handle = await open(tmp, 'w');
  try {
    await handle.writeFile(JSON.stringify({ ...checkpoint, state }, null, 2), 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, file);
  return checkpoint;
}

/** 恢复：重算 hash 比对 + working_state 与 state.id 自洽；损坏/篡改/不存在 → fail-loud */
export async function restore(id: string, opts: { dir: string }): Promise<State> {
  if (!isValidId(id, 'checkpoint')) {
    throw new Error(`checkpoint.restore: 非法 checkpoint id: ${id}`);
  }
  let raw: string;
  try {
    raw = await readFile(fileFor(opts.dir, id), 'utf8');
  } catch {
    throw new Error(`checkpoint.restore: checkpoint 不存在: ${id}`);
  }
  const stored = parseStored(raw, id);
  // 缺陷 2 修复：hash 不含 id 与文件名，内容 id 必须与请求 id（= 文件名 uuid 派生）绑定，
  // 否则改名/复制文件（内容 id B 存为 <A-uuid>.json，或无 id）会被静默恢复，与 list 按内容 id 返回不一致
  if (stored.id !== id) {
    throw new Error(`checkpoint.restore: checkpoint 内容 id 缺失或与请求 id 不一致（文件被改名/复制）: ${id}`);
  }
  if (stored.working_state !== stored.state.id) {
    throw new Error(`checkpoint.restore: checkpoint 自洽失败（working_state 与 state.id 不一致）: ${id}`);
  }
  if (contentHash(stored.state, stored.timestamp, stored.runtime_snapshot) !== stored.hash) {
    throw new Error(`checkpoint.restore: hash 校验失败（checkpoint 损坏或篡改）: ${id}`);
  }
  return stored.state;
}

/** 列出全部完好 checkpoint，按 timestamp 倒序；只认正式文件，跳过 tmp 残留/无关文件/损坏文件 */
export async function list(opts: { dir: string }): Promise<Checkpoint[]> {
  let entries: string[];
  try {
    entries = await readdir(opts.dir);
  } catch {
    return []; // dir 不存在 → 空列表
  }
  const out: Checkpoint[] = [];
  for (const name of entries) {
    if (!FILE_RE.test(name)) {
      continue;
    }
    try {
      const raw = await readFile(join(opts.dir, name), 'utf8');
      const stored = parseStored(raw, name);
      if (stored.working_state !== stored.state.id) {
        continue;
      }
      if (contentHash(stored.state, stored.timestamp, stored.runtime_snapshot) !== stored.hash) {
        continue;
      }
      out.push(checkpointView(stored));
    } catch {
      /* 跳过不可读/损坏文件（§11.3 恢复 = 上次完好 checkpoint） */
    }
  }
  return out.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
}

/** 最新（时间倒序第一个）完好 checkpoint；无 → null */
export async function latest(opts: { dir: string }): Promise<Checkpoint | null> {
  const all = await list(opts);
  return all[0] ?? null;
}

/**
 * 按会话取最新检查点（已知问题《工作状态未按会话隔离》修复）：只认 `session_id` 与请求一致的
 * 检查点——**不再**返回"目录内最新检查点"（那可能属于别的会话，导致投影显示别的会话的目标/状态）。
 * 无会话标识的旧检查点（本修复前写入）视为"无归属" → 不被任何会话命中（不误恢复）。
 */
export async function latestForSession(sessionId: string, opts: { dir: string }): Promise<Checkpoint | null> {
  const all = await list(opts);
  return all.find((cp) => cp.session_id === sessionId) ?? null;
}

/** 轮转结果（检查点轮转与清理的可观测面） */
export interface PruneResult {
  /** 删除的检查点文件数 */
  removed: number;
  /** 保留的检查点文件数 */
  kept: number;
  /** 删除原因（可读，供观测/审计） */
  reasons: string[];
}

/**
 * 检查点轮转与清理（已知问题《检查点无轮转且自 09-09 起停写》修复判定：保留上限 + 会话维度清理）。
 * 规则（确定性，先按 timestamp 倒序取全部完好检查点）：
 *   ① **按会话保留最近 N 个**（`perSessionKeep`，缺省 3）——每个会话的最近状态不受影响；
 *   ② **全局保留上限**（`maxFiles`，缺省 200）——超出部分按"非各会话最近 N 个"优先删除；
 *   ③ **时间上限**（`maxAgeMs`，缺省 30 天）——超龄且不属于任何会话保留位的检查点删除；
 *   ④ 无会话归属的旧检查点（本修复前写入、或确实无从归属）→ 只在超出全局上限时按最旧优先删除
 *      （不做"无主即删"——它们仍可能是有价值的最后状态）。
 * 只删除 `.json` 正式文件（tmp 残留与无关文件不碰）；删除失败 → 计入 reasons 不抛（尽力而为）。
 */
export async function prune(
  opts: {
    dir: string;
    perSessionKeep?: number;
    maxFiles?: number;
    maxAgeMs?: number;
    now?: () => number;
  },
): Promise<PruneResult> {
  const perSessionKeep = Math.max(1, Math.floor(opts.perSessionKeep ?? CHECKPOINT_PER_SESSION_KEEP));
  const maxFiles = Math.max(1, Math.floor(opts.maxFiles ?? CHECKPOINT_MAX_FILES));
  const maxAgeMs = opts.maxAgeMs ?? CHECKPOINT_MAX_AGE_MS;
  const now = (opts.now ?? (() => Date.now()))();
  const all = await list({ dir: opts.dir }); // 已按 timestamp 倒序
  const reasons: string[] = [];
  // 保留规则（按优先级）：
  //   ① 每会话最新 perSessionKeep 条保留位（保证每个活跃会话都能恢复最近状态）；
  //   ② 其余按"最新优先"填满全局名额 maxFiles。
  // 关键：② 的名额是 **net 保留总量**——扣除已被 ① 占用的名额，否则每会话保留位会额外叠加，
  // 使实际文件数超过 maxFiles（全局上限形同虚设）。
  const keep = new Set<string>();
  const perSession = new Map<string, number>();
  for (const cp of all) {
    const sid = cp.session_id;
    if (sid === undefined) continue;
    const n = perSession.get(sid) ?? 0;
    if (n < perSessionKeep) {
      keep.add(cp.id);
      perSession.set(sid, n + 1);
    }
  }
  const remainingSlots = Math.max(0, maxFiles - keep.size);
  let filled = 0;
  for (const cp of all) {
    if (filled >= remainingSlots) break;
    if (keep.has(cp.id)) continue;
    keep.add(cp.id);
    filled++;
  }
  // 逐个判定删除（在 keep 之外的才可能删；超龄与超限都删，但 keep 内的不动）
  const toRemove: Checkpoint[] = [];
  for (const cp of all) {
    if (keep.has(cp.id)) continue;
    const ts = Date.parse(cp.timestamp);
    const aged = Number.isFinite(ts) && now - ts > maxAgeMs;
    toRemove.push(cp);
    if (aged) {
      reasons.push(`超龄删除 ${cp.id.slice(0, 20)}…（timestamp ${cp.timestamp}）`);
    } else {
      reasons.push(`超限删除 ${cp.id.slice(0, 20)}…（超出全局保留上限 ${maxFiles}）`);
    }
  }
  let removed = 0;
  for (const cp of toRemove) {
    try {
      await rm(fileFor(opts.dir, cp.id));
      removed++;
    } catch (err) {
      reasons.push(`删除失败 ${cp.id.slice(0, 20)}…：${(err as Error).message}`);
    }
  }
  return { removed, kept: all.length - removed, reasons };
}
