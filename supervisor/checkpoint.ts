// OMB v2 Working Memory Checkpoint（架构 §4.2 M7 / §5.2 / §11.3 事务模型）：layer 1 单文件快照存储。
// save(state, opts) → Checkpoint：M7 对象 + 内嵌完整 state 落盘为单文件 JSON <dir>/<uuid>.json。
// checkpoint_id = `checkpoint:<uuid>`；文件名用 uuid 尾段——Windows 文件名不允许 ':'，checkpoint: 前缀剥离
//   （与 ArtifactStore 目录命名同风格，§4.3 已注）。
// 完整性（§11.3 Checkpoint 事务 = 单文件写 + hash）：hash = sha256(canonical JSON of
//   {working_state: 完整 state, timestamp, runtime_snapshot})——覆盖全部可变内容；restore 重算比对，
//   不一致 → 拒绝（损坏检测）。working_state 引用（= state.id）与 state 自洽校验兜底引用篡改。
// 原子写：先写 <uuid>.json.tmp 再 rename（防半写）+ 单文件 fsync。
// list/latest：只认正式文件（uuid 形状的 *.json，忽略 .tmp 残留与无关文件）；损坏文件跳过
//   （§11.3 恢复 = 上次完好 checkpoint）；按 timestamp 倒序。
// 契约（主会话裁决 2026-08-21）：save 的 state 必须来自带 initial 的完整回放或既有 checkpoint 恢复
//   （保证 schema 合规）；checkpoint 自身 hash 与 state 自洽即可，M1 不要求重放校验。
// layer 1（supervisor/）：仅 import node: 内置 + kernel/schemas/（IR 契约例外，CONVENTIONS §4）。
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalJson, isValidId, makeMutableId, type Provenance } from '../kernel/schemas/base.js';
import { CheckpointSchema, type Checkpoint } from '../kernel/schemas/m.js';
import type { State } from '../kernel/schemas/s.js';

/** 正式 checkpoint 文件名的 uuid 段形状（tmp 残留 <uuid>.json.tmp 不匹配，天然被忽略） */
const FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/i;
const CHECKPOINT_PREFIX = 'checkpoint:';

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

/** 保存：M7 对象 + 内嵌 state → <dir>/<uuid>.json（tmp + rename + fsync 原子写） */
export async function save(
  state: State,
  opts: { dir: string; runtime_snapshot?: string; provenance?: Provenance },
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
    hash: contentHash(state, ts, runtimeSnapshot),
    timestamp: ts,
    runtime_snapshot: runtimeSnapshot,
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
