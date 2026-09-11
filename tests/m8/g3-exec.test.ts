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
//   ⑤ 降级（D5）取舍两态：通道不可用 → 缺省（require_execution_verification 未声明，fail-closed）
//      `passed=false` + kind='degraded'（**没跑过 ≠ 验过了**——已知问题《Linux 适配不完整》派生条），
//      显式 requireExecutionVerification=false 时回到"降级跳过不阻塞"语义
//   ⑤b 降级候选不得跨到晋升侧：promotion gate 读候选留痕 → degraded 记录拒绝晋升
//   ⑥ 临时目录清理：G3-exec / G3-replay 验证后候选验证目录零残留（candidateRoot fixture）
//   ⑦ 并列记录：gates 同时含 g3（mode='replay'）与 g3Exec
//   ⑧ 受限通道可用性判定必经真实自检（sandboxStatusAsync：授权目录写成功 + 非授权目录写被拒）
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
import { sandboxStatusAsync, resetSandboxChannelCache } from '../../substrate/sandbox.js';
import { validateDataCandidate, executionVerificationGateNote } from '../../supervisor/candidate-pipeline.js';
import { executionEvidenceFromVerifications, shouldPromoteToStable } from '../../kernel/promotion-gate.js';
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

  fixtureIt('⑤ 降级（D5）fail-closed 缺省：通道不可用 → 附脚本候选 passed=false + kind=degraded（没跑过 ≠ 验过了）', async () => {
    const candidateRoot = buildCandidateRoot();
    try {
      const r = await validateDataCandidate(
        draft('kernel/policy/evolve.yaml', await evolveTweakContent(), { verify: SCRIPT_VERIFY_OK }),
        {
          baselinePolicyDir,
          candidateRoot,
          sandboxStatus: async () => ({ available: false, reason: 'koffi 缺失（模拟）' }),
        },
      );
      // 已知问题《Linux 适配不完整》派生条：旧实现此处 passed=true 且晋升门禁不读降级位 →
      // 无沙盒机器上候选可能一次真实执行都没跑就晋级。现在缺省 fail-closed。
      expect(r.passed).toBe(false);
      expect(r.execution_verification).toBe('degraded');
      expect(r.gates.g3Exec?.kind).toBe('degraded');
      expect(r.gates.g3Exec?.ok).toBe(false);
      expect(r.gates.g3Exec?.strict).toBe(false);
      expect(r.gates.g3Exec?.degraded).toMatch(/koffi/);
      expect(r.gates.g3Exec?.detail).toMatch(/require_execution_verification|没有真实执行过/);
      // G1/G3-replay 本身照常通过（失败点只在执行型验证门）
      expect(r.gates.g1?.ok).toBe(true);
      expect(r.gates.g3?.ok).toBe(true);
    } finally {
      fs.rmSync(candidateRoot, { recursive: true, force: true });
    }
  });

  fixtureIt('⑤ 降级（D5）显式接受：requireExecutionVerification=false → kind=degraded 跳过，G1/G3-replay 照常', async () => {
    const candidateRoot = buildCandidateRoot();
    try {
      const r = await validateDataCandidate(
        draft('kernel/policy/evolve.yaml', await evolveTweakContent(), { verify: SCRIPT_VERIFY_OK }),
        {
          baselinePolicyDir,
          candidateRoot,
          sandboxStatus: async () => ({ available: false, reason: 'koffi 缺失（模拟）' }),
          requireExecutionVerification: false,
        },
      );
      expect(r.passed).toBe(true); // 部署方显式接受降级
      expect(r.execution_verification).toBe('degraded');
      expect(r.gates.g3Exec?.kind).toBe('degraded');
      expect(r.gates.g3Exec?.ok).toBe(true);
      expect(r.gates.g3Exec?.strict).toBe(false); // 未真实执行——留痕不撒谎
      expect(r.gates.g3Exec?.degraded).toMatch(/koffi/);
      expect(r.gates.g1?.ok).toBe(true);
      expect(r.gates.g3?.ok).toBe(true);
    } finally {
      fs.rmSync(candidateRoot, { recursive: true, force: true });
    }
  });

  fixtureIt('⑤b 降级候选不得跨到晋升侧：候选留痕 → promotion gate 拒绝晋升（degraded 不再当通过）', async () => {
    const candidateRoot = buildCandidateRoot();
    try {
      const r = await validateDataCandidate(
        draft('kernel/policy/evolve.yaml', await evolveTweakContent(), { verify: SCRIPT_VERIFY_OK }),
        {
          baselinePolicyDir,
          candidateRoot,
          sandboxStatus: async () => ({ available: false, reason: '平台无受限通道（模拟 Linux 无 bwrap）' }),
          requireExecutionVerification: false, // 候选侧放行（部署方接受降级）
        },
      );
      expect(r.passed).toBe(true);
      // 但晋升侧默认要求"真实跑过"：候选留痕 degraded → 拒绝（同一取证链，不得自相矛盾）
      const note = executionVerificationGateNote(r);
      expect(note).toBe('G3-exec:degraded(no-channel)');
      const evidence = executionEvidenceFromVerifications(['G1', 'G3', note]);
      expect(evidence?.kind).toBe('degraded');
      const verdict = shouldPromoteToStable({
        baseline: { stable_commit: 'a'.repeat(40), stable_bench: { passed: 20, total: 20 } },
        candidate: { latest_commit: 'b'.repeat(40), latest_bench: { passed: 20, total: 20 } },
        cost_degradation_ratio: 0,
        shadow_signals: { n: 0, failures: 0 },
        policy: {
          min_shadow_samples: 0,
          max_shadow_failure_rate: 0.1,
          cost_degradation_tolerance: 0.1,
          require_execution_verification: true,
        },
        verify_evidence: evidence,
      });
      expect(verdict.ok).toBe(false);
      expect(verdict.reasons.some((x) => /执行型验证未真实发生/.test(x))).toBe(true);
    } finally {
      fs.rmSync(candidateRoot, { recursive: true, force: true });
    }
  });

  fixtureIt('⑧ 受限通道可用性判定必经真实自检：sandboxStatusAsync 报自检结论（授权写成功 + 非授权写被拒）', async () => {
    const st = await sandboxStatusAsync();
    if (st.available) {
      expect(st.verified).toBe(true);
      expect(st.mechanism).toBeDefined();
      expect(st.isolation).toBe('write-restricted');
      expect(st.self_test_note ?? '').toMatch(/自检通过/);
      expect(st.self_test_note ?? '').toMatch(/写成功|ALLOW/);
    } else {
      // 无通道环境（无沙盒的 CI）→ 必须给出可读原因且不谎称可用
      expect(typeof st.reason).toBe('string');
      expect((st.reason ?? '').length).toBeGreaterThan(0);
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
