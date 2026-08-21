// layer 1：Activation 幂等持久化（T8.7；从 activation.ts 拆分——CONVENTIONS §9 LOC ≤ 400）。
// completed/<activation_id>.json（完成记录）+ pending/<activation_id>.json（切换前标记，
// crash-window retry hazard，T5.5 Minor 1）；全部 tmp+rename 原子写（§11.3 crash consistency 同款语义）。
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

function completedFile(logDir: string, id: string): string {
  return join(logDir, 'completed', `${id}.json`);
}

function pendingFile(logDir: string, id: string): string {
  return join(logDir, 'pending', `${id}.json`);
}

/** 原子写 JSON（tmp + rename，§11.3 crash consistency 同款语义） */
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
