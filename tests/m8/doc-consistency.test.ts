// T8.22 行为测试：架构文档 ↔ 实现 OMB_OBJECTS 编号一致性（防漂移锚）。
// 背景：架构 §4.2 曾写"22 核心对象"，但枚举清单实为 S4+C11+P5+M8 = 28 核心 + A1-A4 = 4 一等
// （合计 32 编号）；实现 kernel/schemas/index.ts OMB_OBJECTS 按 32 编号，无漂移——漂移在文档自身。
// 本测试从架构文档 §4.2/§4.3 文本中提取对象编号与实现 OBJECT_NUMBERS 逐一对齐，
// 并钉住"合计"行 = 28 核心 + 4 一等（防止旧数字残留复活）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { OBJECT_NUMBERS } from '../../kernel/schemas/index.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const ARCH_DOC = path.join(REPO_ROOT, '.omb', 'plans', '2026-08-21-omb-v2-architecture.md');

/** 提取 §4.2 至 §5 之间所有对象编号（S1. / C1. / P1. / M1. / A1. 行内标记） */
function extractDocObjectNumbers(doc: string): string[] {
  const section = doc.slice(doc.indexOf('### 4.2'), doc.indexOf('## 5.'));
  const nums = [...section.matchAll(/([SCPMA]\d+)\./g)].map((m) => m[1]!);
  return [...new Set(nums)].sort();
}

describe('架构文档 ↔ OMB_OBJECTS 编号一致（T8.22 防漂移）', () => {
  const doc = fs.readFileSync(ARCH_DOC, 'utf8');

  it('文档枚举对象编号 = 实现 OBJECT_NUMBERS（32 编号全量对齐）', () => {
    const docNums = extractDocObjectNumbers(doc);
    const implNums = [...OBJECT_NUMBERS].sort();
    expect(docNums).toEqual(implNums);
  });

  it('文档枚举核心 28 + 一等 4（S4+C11+P5+M8，非 22）', () => {
    const core = extractDocObjectNumbers(doc).filter((n) => n.startsWith('S') || n.startsWith('C') || n.startsWith('P') || n.startsWith('M'));
    const firstClass = extractDocObjectNumbers(doc).filter((n) => n.startsWith('A'));
    expect(core).toHaveLength(28);
    expect(firstClass).toHaveLength(4);
  });

  it('合计行 = 28 核心对象 + 4 一等对象', () => {
    const line = doc.split('\n').find((l) => l.includes('合计'));
    expect(line).toBeDefined();
    expect(line).toMatch(/28 核心对象/);
    expect(line).toMatch(/4 一等对象/);
  });

  it('全文无 "22 核心" 残留', () => {
    expect(doc).not.toMatch(/22 核心/);
  });
});
