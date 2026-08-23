// layer 1：Activation 幂等持久化（T8.7；从 activation.ts 拆分——CONVENTIONS §9 LOC ≤ 400）。
// completed/<activation_id>.json（完成记录）+ pending/<activation_id>.json（切换前标记，
// crash-window retry hazard，T5.5 Minor 1）+ rolled_back/<activation_id>.json（P1e 回滚记录，
// rollbackPromotion 落盘：from=晋升后 commit → to=回退目标，含 reason/候选与对象 id——error 池溯源）。
// 全部 tmp+rename 原子写（§11.3 crash consistency 同款语义）。
// 本模块自包含（无 activation.ts 依赖）：完成记录 = ActivationContract（kernel/schemas 契约例外）。
// layer 1：仅 import node: 内置 + kernel/schemas/（IR 契约例外）。
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ActivationContract } from '../kernel/schemas/m.js';

/** pending 标记（切换前落盘；重试时判定切换是否已发生） */
export interface PendingMarker {
  activation_id: string;
  candidate: string;
  predecessor: string;
  rollback_snapshot: string;
  started_at: number;
}

/** 文件名字符安全化（Windows 非法字符 \ / : * ? " < > | 与控制字符；激活 id 形如 dsh:evt:<sha256>）。
 *  读/写经同一变换 → 对称；跨平台一致。 */
function safeId(id: string): string {
  return id.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_');
}

function completedFile(logDir: string, id: string): string {
  return join(logDir, 'completed', `${safeId(id)}.json`);
}

function pendingFile(logDir: string, id: string): string {
  return join(logDir, 'pending', `${safeId(id)}.json`);
}

function rolledBackFile(logDir: string, id: string): string {
  return join(logDir, 'rolled_back', `${safeId(id)}.json`);
}

/** 原子写 JSON（tmp + rename，§11.3 crash consistency 同款语义）；目录不存在时递归创建
 *  （completed/ 与 pending/ 首次写入即成功——logDir 无需预先 mkdir）。 */
function atomicWriteJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  renameSync(tmp, file);
}

/** 读完成记录（缺失/损坏 → null；损坏即视为未完成——幂等重跑可覆盖） */
export function loadCompleted(logDir: string, id: string): ActivationContract | null {
  try {
    const raw = readFileSync(completedFile(logDir, id), 'utf8');
    return JSON.parse(raw) as ActivationContract;
  } catch {
    return null;
  }
}

/** 写完成记录（原子写） */
export function writeCompleted(logDir: string, id: string, contract: ActivationContract): void {
  atomicWriteJson(completedFile(logDir, id), contract);
}

/** 读 pending 标记（缺失 → null） */
export function loadPending(logDir: string, id: string): PendingMarker | null {
  try {
    const raw = readFileSync(pendingFile(logDir, id), 'utf8');
    return JSON.parse(raw) as PendingMarker;
  } catch {
    return null;
  }
}

/** 写 pending 标记（原子写；切换前调用） */
export function writePending(logDir: string, marker: PendingMarker): void {
  atomicWriteJson(pendingFile(logDir, marker.activation_id), marker);
}

/** 清理 pending 标记（完成/重跑路径） */
export function clearPending(logDir: string, id: string): void {
  rmSync(pendingFile(logDir, id), { force: true });
}

// ---- P1e：回滚记录（rolled_back/<activation_id>.json；rollbackPromotion 落盘） ----

/** 回滚记录（P1e）：一次晋升回退的事实档案（error 池溯源的激活侧引线） */
export interface RolledBackRecord {
  activation_id: string;
  /** 晋升后的 commit（ActivationContract.candidate） */
  from: string;
  /** 回退目标 commit（ActivationContract.rollback_snapshot = 旧 stable） */
  to: string;
  reason: string;
  /** 候选 id（error 池键；可选——调用方提供时落盘） */
  candidate_id?: string;
  /** Evolution Object id（P1d 链头；可选） */
  object_id?: string;
  ts: number;
}

/** 写回滚记录（原子写；幂等——同 activation_id 覆盖） */
export function writeRolledBack(logDir: string, record: RolledBackRecord): void {
  atomicWriteJson(rolledBackFile(logDir, record.activation_id), record);
}

/** 读回滚记录（缺失/损坏 → null） */
export function loadRolledBack(logDir: string, id: string): RolledBackRecord | null {
  try {
    const raw = readFileSync(rolledBackFile(logDir, id), 'utf8');
    return JSON.parse(raw) as RolledBackRecord;
  } catch {
    return null;
  }
}
