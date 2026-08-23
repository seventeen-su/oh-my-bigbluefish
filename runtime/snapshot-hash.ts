// layer 2：快照哈希输入收集（P1b 提交级运行时快照，D1⑤：请求运行于「线 stable + commit a81f + 快照 rs:7c91」）。
// 与 supervisor/versioning.ts 分工：versioning 负责哈希计算与注册表（不感知组件内部，组件清单由调用方提供）；
// 本文件负责"运行时身份"的输入收集——实际生效 policy/processes 目录内容哈希 + 六组件内容哈希
// （组件注册表 components/registry.ts（P2）接入前的最佳努力映射：真实组件实现文件内容寻址）。
// 纯函数（同步 fs 读取）：确定性（同文件内容同哈希）；缺失文件 → 跳过（空贡献，仍 64-hex）——
// 装配/重建不因组件文件缺失中断（降级不崩，D5 风格）。
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ComponentHashes } from '../supervisor/versioning.js';

/** policy 固定文件集（与 kernel/policy-loader.ts 加载面一致；既有 computeSnapshotHash 同款） */
const POLICY_FILES = ['governor.yaml', 'budget.yaml', 'context.yaml'] as const;

/**
 * 六组件 → 组件实现源文件映射（P1b 文档化契约；P2 组件注册表接入后可由注册组件 manifest 派生替换）。
 * 语义：组件实现内容改动 → 组件哈希变化 → 快照变化（运行时身份真实敏感）。
 * 缺失文件 → 跳过贡献（部署形态差异（src/lib）或文件未落地 → 该组件退化为确定性空贡献，不崩）。
 */
export const COMPONENT_SOURCE_MAP: Record<keyof ComponentHashes, readonly string[]> = {
  scheduler: ['runtime/governor.ts', 'runtime/scheduler.ts'],
  memory: ['memory/backend-retrieval.ts', 'memory/retrieve.ts'],
  verifier: ['supervisor/validate.ts'],
  renderer: ['runtime/renderer.ts', 'runtime/prompt.ts'],
  capability: ['supervisor/capability.ts'],
  philosophy: ['kernel/policy/governor.yaml', 'kernel/policy/budget.yaml', 'kernel/policy/context.yaml'],
};

/**
 * 目录内容哈希：policy 固定文件集 + processes YAML（排序）的字节原样 sha256（64-hex，确定性）。
 * 任一步读取失败 → 抛错（fail-loud——由调用方决定降级；与既有 computeSnapshotHash 语义一致）。
 */
export function computeDirContentHash(policyDir: string, processesDir: string): string {
  const h = createHash('sha256');
  for (const name of POLICY_FILES) {
    h.update(readFileSync(join(policyDir, name)));
  }
  const processes = readdirSync(processesDir)
    .filter((f) => f.endsWith('.yaml'))
    .sort();
  for (const f of processes) {
    h.update(readFileSync(join(processesDir, f)));
  }
  return h.digest('hex');
}

/** 单组件内容哈希：映射文件字节原样拼接（缺失 → 跳过）；组件无任何文件 → 确定性空贡献哈希 */
function componentContentHash(presetRoot: string, files: readonly string[]): string {
  const h = createHash('sha256');
  for (const rel of files) {
    try {
      h.update(readFileSync(join(presetRoot, rel)));
    } catch {
      // 缺失/不可读 → 跳过（不中断；部署形态差异容忍）
    }
  }
  return h.digest('hex');
}

/** 六组件内容哈希（真实组件实现文件；presetRoot = 仓库根，含 kernel/runtime/supervisor/memory） */
export function computeComponentHashes(presetRoot: string): ComponentHashes {
  return {
    scheduler: componentContentHash(presetRoot, COMPONENT_SOURCE_MAP.scheduler),
    memory: componentContentHash(presetRoot, COMPONENT_SOURCE_MAP.memory),
    verifier: componentContentHash(presetRoot, COMPONENT_SOURCE_MAP.verifier),
    renderer: componentContentHash(presetRoot, COMPONENT_SOURCE_MAP.renderer),
    capability: componentContentHash(presetRoot, COMPONENT_SOURCE_MAP.capability),
    philosophy: componentContentHash(presetRoot, COMPONENT_SOURCE_MAP.philosophy),
  };
}
