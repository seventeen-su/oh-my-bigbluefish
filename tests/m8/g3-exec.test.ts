// P3 候选验证沙盒门禁（WRITE_RESTRICTED）接 G 链测试：G3-exec 执行型验证门
// （supervisor/candidate-pipeline.ts，设计 §3.4 验证层 + 实现规格 §5.2/§5.3 + D5 降级裁决）。
// 真实 Windows 受限执行（禁 mock）：受限通道（substrate/sandbox.ts runRestricted）+ 结果文件方案
// （受限进程不能管道捕获孙进程输出 → 脚本写结果文件，宿主读）+ 候选验证环境标准化
// （createCandidateDir 临时目录，candidateRoot 注入 fixture 根）+ 沙盒语义写拒绝断言。
// 覆盖：
//   ① G3-exec N/A：L0 数据候选无验证脚本 → kind='na'，不阻塞 G1/G3-replay
//   ② G3-exec 通过：附脚本候选（脚本写结果文件 JSON ok + 尝试写候选目录被拒 → 沙盒语义验证）→ kind='exec'
//   ③ G3-exec 拒绝：脚本报告 ok=false → kind='exec' ok=false → validateDataCandidate passed=false
//   ④ G3-exec 拒绝：脚本未写结果文件（结果文件方案失败）→ ok=false
//   ⑤ 降级（D5）：sandboxStatus 注入不可用 → G3-exec kind='degraded' 跳过 + degraded 记录，G1/G3-replay 照常
//   ⑥ 临时目录清理：G3-exec / G3-replay 验证后候选验证目录零残留（candidateRoot fixture）
//   ⑦ 并列记录：gates 同时含 g3（mode='replay'）与 g3Exec
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { dump as dumpYaml } from 'js-yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadPolicy } from '../../kernel/policy-loader.js';
import { ensureLineSnapshot } from '../../substrate/lines.js';
import type { VersionLayout } from '../../substrate/snapshot.js';
import { validateDataCandidate } from '../../supervisor/candidate-pipeline.js';
import type { CandidateDraft } from '../../kernel/schemas/evolution.js';
import { buildLayoutFixture, teardownLayoutFixture, type LayoutFixture } from '../helpers/git.js';

/** 单 fixture 共享（本文件测试只读 fixture 的线 policy 快照；候选验证写入独立 candidateRoot）——
 *  全量套件并行 git/icacls 饱和已知 flake 类（rollback/boot/txn-capability/line-snapshot 同款）→
 *  共享一个 fixture 减少并行负载，另放宽超时防环境超时 */
const FIXTURE_TIMEOUT = 30000;
const fixtureIt = (name: string, fn: (() => void) | (() => Promise<void>)) => it(name, fn, FIXTURE_TIMEOUT);

let fx: LayoutFixture | null = null;
let baselinePolicyDir = '';

beforeAll(async () => {
  fx = buildLayoutFixture();
  const layout: VersionLayout = { bareRepo: fx.bare, stableWorktree: fx.stable, latestWorktree: fx.latest };
  const snap = ensureLineSnapshot(layout, 'latest');
  baselinePolicyDir = path.join(snap.dir, 'kernel', 'policy');
});

afterAll(() => {
  if (fx) {
    teardownLayoutFixture(fx);
  }
  fx = null;
});

/** 候选验证临时目录根（createCandidateDir 注入：独立 mkdtemp fixture，验证后零残留断言） */
function buildCandidateRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'omb-g3exec-root-'));
}

function draft(
  target: string,
  content: string,
  opts: { signal?: string; verify?: string } = {},
): CandidateDraft {
  return {
    id: `sha256:${createHash('sha256').update(`${target}\u0000${content}`).digest('hex').slice(0, 12)}`,
    seq: 0,
    kind: 'policy',
    target,
    content,
    diff: `${target}: 测试变更`,
    motivation: `signal ${opts.signal ?? 'corrections'} 测试`,
    signal: opts.signal ?? 'corrections',
    change: { path: 'test.path', old: 0, new: 1 },
    ...(opts.verify !== undefined ? { verify: { script: opts.verify } } : {}),
  };
}

/** 可加载微调候选（G1+G3-replay 通过路径） */
async function evolveTweakContent(): Promise<string> {
  const p = await loadPolicy();
  const evolve = {
    ...p.evolve,
    signal_triggers: {
      ...p.evolve.signal_triggers,
      corrections: { ...p.evolve.signal_triggers.corrections!, strength: 0.95 },
    },
  };
  return dumpYaml(evolve);
}

/**
 * 合法执行型验证脚本（沙盒语义验证）：尝试写候选目录（不在 writableDirs）→ 必须被拒（EPERM/EACCES）；
 * 拒绝成立才报告 ok=true；结果经 OMB_SANDBOX_RESULT_FILE（结果文件方案）JSON 回传。
 */
const SCRIPT_VERIFY_OK = `const fs = require('node:fs');
const path = require('node:path');
const resultFile = process.env.OMB_SANDBOX_RESULT_FILE;
const candDir = process.argv[2];
let probe = null;
try {
  fs.writeFileSync(path.join(candDir, 'write-probe.txt'), 'x');
  probe = 'LEAK';
} catch (e) {
  probe = e && e.code ? e.code : String(e);
}
const ok = probe === 'EPERM' || probe === 'EACCES';
fs.writeFileSync(resultFile, JSON.stringify({ ok, detail: 'verify ok; write-denied=' + probe }));
`;

/** 脚本报告失败（ok=false） */
const SCRIPT_VERIFY_FAIL = `const fs = require('node:fs');
fs.writeFileSync(process.env.OMB_SANDBOX_RESULT_FILE, JSON.stringify({ ok: false, detail: 'verification failed' }));
`;

/** 脚本不写结果文件（结果文件方案失败路径） */
const SCRIPT_NO_RESULT = `// 不写结果文件（宿主应判定结果文件方案失败）\n`;

describe('P3 G3-exec 执行型验证门（WRITE_RESTRICTED 受限通道 + 结果文件方案）', () => {
  fixtureIt('① G3-exec N/A：L0 数据候选无验证脚本 → kind=na + ok=true，不阻塞 G1/G3-replay（passed=true）', async () => {
    const candidateRoot = buildCandidateRoot();
    try {
      const r = await validateDataCandidate(draft('kernel/policy/evolve.yaml', await evolveTweakContent()), {
        baselinePolicyDir,
        candidateRoot,
      });
      expect(r.passed).toBe(true);
      expect(r.gates.g3Exec?.kind).toBe('na');
      expect(r.gates.g3Exec?.ok).toBe(true);
      expect(r.gates.g3Exec?.detail).toMatch(/N\/A|无执行型验证|无.*脚本/i);
      expect(r.gates.g3?.ok).toBe(true); // G3-replay 照常
    } finally {
      fs.rmSync(candidateRoot, { recursive: true, force: true });
    }
  });

  fixtureIt('② G3-exec 通过：附脚本候选 → 受限通道执行 + 结果文件回传 JSON ok + 沙盒语义验证（脚本写候选目录被拒）', async () => {
    const candidateRoot = buildCandidateRoot();
    try {
      const r = await validateDataCandidate(
        draft('kernel/policy/evolve.yaml', await evolveTweakContent(), { verify: SCRIPT_VERIFY_OK }),
        { baselinePolicyDir, candidateRoot },
      );
      expect(r.passed).toBe(true);
      expect(r.gates.g3Exec?.kind).toBe('exec');
      expect(r.gates.g3Exec?.ok).toBe(true);
      // 结果文件回传内容（脚本报告写拒绝码 → 沙盒语义验证成立）
      expect(r.gates.g3Exec?.detail).toMatch(/EPERM|EACCES/);
      expect(r.gates.g3Exec?.exec?.code).toBe(0);
      expect(r.gates.g3Exec?.exec?.timedOut).toBe(false);
    } finally {
      fs.rmSync(candidateRoot, { recursive: true, force: true });
    }
  });

  fixtureIt('③ G3-exec 拒绝：脚本报告 ok=false → kind=exec ok=false → validateDataCandidate passed=false', async () => {
    const candidateRoot = buildCandidateRoot();
    try {
      const r = await validateDataCandidate(
        draft('kernel/policy/evolve.yaml', await evolveTweakContent(), { verify: SCRIPT_VERIFY_FAIL }),
        { baselinePolicyDir, candidateRoot },
      );
      expect(r.gates.g3Exec?.kind).toBe('exec');
      expect(r.gates.g3Exec?.ok).toBe(false);
      expect(r.gates.g3Exec?.detail).toMatch(/报告失败|verification failed/);
      expect(r.passed).toBe(false);
      expect(r.reason).toContain('验证失败');
    } finally {
      fs.rmSync(candidateRoot, { recursive: true, force: true });
    }
  });

  fixtureIt('④ G3-exec 拒绝：脚本未写结果文件（结果文件方案失败）→ ok=false', async () => {
    const candidateRoot = buildCandidateRoot();
    try {
      const r = await validateDataCandidate(
        draft('kernel/policy/evolve.yaml', await evolveTweakContent(), { verify: SCRIPT_NO_RESULT }),
        { baselinePolicyDir, candidateRoot },
      );
      expect(r.gates.g3Exec?.kind).toBe('exec');
      expect(r.gates.g3Exec?.ok).toBe(false);
      expect(r.gates.g3Exec?.detail).toMatch(/结果文件/);
      expect(r.passed).toBe(false);
    } finally {
      fs.rmSync(candidateRoot, { recursive: true, force: true });
    }
  });

  fixtureIt('⑤ 降级（D5）：sandboxStatus 注入不可用（koffi 缺失模拟）→ G3-exec kind=degraded 跳过 + degraded 记录，G1/G3-replay 照常', async () => {
    const candidateRoot = buildCandidateRoot();
    try {
      const r = await validateDataCandidate(
        draft('kernel/policy/evolve.yaml', await evolveTweakContent(), { verify: SCRIPT_VERIFY_OK }),
        {
          baselinePolicyDir,
          candidateRoot,
          sandboxStatus: () => ({ available: false, reason: 'koffi 缺失（模拟）' }),
        },
      );
      expect(r.passed).toBe(true); // 降级不阻塞门禁语义
      expect(r.gates.g3Exec?.kind).toBe('degraded');
      expect(r.gates.g3Exec?.ok).toBe(true);
      expect(r.gates.g3Exec?.degraded).toMatch(/koffi/);
      expect(r.gates.g3Exec?.detail).toMatch(/降级|跳过/);
      expect(r.gates.g1?.ok).toBe(true);
      expect(r.gates.g3?.ok).toBe(true);
    } finally {
      fs.rmSync(candidateRoot, { recursive: true, force: true });
    }
  });

  fixtureIt('⑥ 临时目录清理：G3-exec 执行 / N-A 验证后候选验证目录零残留（candidateRoot fixture）', async () => {
    const candidateRoot = buildCandidateRoot();
    try {
      // 执行路径
      await validateDataCandidate(
        draft('kernel/policy/evolve.yaml', await evolveTweakContent(), { verify: SCRIPT_VERIFY_OK }),
        { baselinePolicyDir, candidateRoot },
      );
      expect(await readdir(candidateRoot)).toHaveLength(0);
      // N/A 路径（G3-replay 标准化目录同样用后即清）
      await validateDataCandidate(draft('kernel/policy/evolve.yaml', await evolveTweakContent()), {
        baselinePolicyDir,
        candidateRoot,
      });
      expect(await readdir(candidateRoot)).toHaveLength(0);
    } finally {
      fs.rmSync(candidateRoot, { recursive: true, force: true });
    }
  });

  fixtureIt('⑦ 并列记录：gates 同时含 g3（mode=replay，冻结基准回放）与 g3Exec（执行型验证）', async () => {
    const candidateRoot = buildCandidateRoot();
    try {
      const r = await validateDataCandidate(
        draft('kernel/policy/evolve.yaml', await evolveTweakContent(), { verify: SCRIPT_VERIFY_OK }),
        { baselinePolicyDir, candidateRoot },
      );
      expect(r.gates.g3?.mode).toBe('replay');
      expect(r.gates.g3Exec).toBeDefined();
      expect(r.reason).toMatch(/G1\+G3-replay/);
    } finally {
      fs.rmSync(candidateRoot, { recursive: true, force: true });
    }
  });
});
