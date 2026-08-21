// T8.14 Verification Synthesis 测试（supervisor/oracle.ts，validate.ts 统一出口；架构 §9.2 防自证）。
// 严格 TDD：本文件先于实现编写并确认失败（功能缺失）。
// 覆盖：
//   ① 无现成 verifier 任务可生成 oracle：scriptBuilder 生成可执行复现脚本 → 沙箱跑通（exit 0）→
//      verdict ok（verified + adversarial validated）
//   ② 自证回路被拒：oracle 锚引用被验证对象自身输出（source=candidate / ref=output）→ 拒绝
//      （non-circularity，§9.2：AI 生成 verifier 只能是 candidate verifier）
//   ③ 独立锚通过：source=fixture/spec（独立事实来源）→ 接受
//   ④ 复现失败（脚本 exit≠0）→ verdict ok:false（沙箱验证拒绝）
//   ⑤ adversarial validation：对抗样本未如预期失败 → oracle 不可信拒绝
//   ⑥ checkAnchorIndependence 纯函数边界
import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkAnchorIndependence,
  runReproductionOracle,
  synthesizeReproductionOracle,
  type OracleSpec,
  type OracleTask,
  type SandboxLike,
} from '../../supervisor/oracle.js';

// ---- 测试工具 ----

/** 无现成 verifier 的任务（仅任务事实 + 候选输出；oracle 从零生成） */
const task: OracleTask = {
  task_id: 'bench:no-verifier',
  goal: '计算 6×7',
  candidate_output: { answer: 42 },
};

/** 确定性 scriptBuilder：生成可执行复现脚本（校验候选输出对锚的忠实度；锚 = 独立规范事实 spec-42） */
function buildScript(): string {
  return [
    `const input = JSON.parse(process.argv[2] ?? 'null');`,
    `if (input && typeof input === 'object' && input.answer === 42) {`,
    `  process.exit(0);`,
    `} else {`,
    `  console.error('MISMATCH');`,
    `  process.exit(1);`,
    `}`,
  ].join('\n');
}

function spec(over: Partial<OracleSpec> = {}): OracleSpec {
  return {
    script: buildScript(),
    anchor: { source: 'spec', ref: 'spec-42' },
    adversarial: { input: { answer: 41 }, expect_fail: true },
    ...over,
  };
}

/** 真实沙箱：脚本写入临时目录 → node spawn 执行（可执行复现脚本真实跑通） */
function makeNodeSandbox(): SandboxLike {
  return {
    async run(input) {
      const dir = await mkdtemp(join(tmpdir(), 'omb-oracle-'));
      try {
        const scriptPath = join(dir, 'oracle-script.cjs');
        await writeFile(scriptPath, input.script, 'utf8');
        const result = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
          const child = spawn(process.execPath, [scriptPath, JSON.stringify(input.input)], {
            cwd: dir,
            windowsHide: true,
          });
          let stderr = '';
          child.stderr.on('data', (d: Buffer) => {
            stderr += d.toString('utf8');
          });
          child.on('error', reject);
          child.on('close', (code) => resolve({ code, stderr }));
        });
        return { code: result.code ?? 1, output: '', stderr: result.stderr };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}

// ---- 主测试 ----

describe('① 无现成 verifier 任务可生成 oracle（生成可执行复现脚本 → 沙箱跑通）', () => {
  it('synthesizeReproductionOracle：scriptBuilder 生成脚本 → 沙箱 exit 0 → verdict ok（verified + adversarial validated）', async () => {
    const verdict = await synthesizeReproductionOracle({
      task,
      scriptBuilder: (t) => spec({ anchor: { source: 'spec', ref: `spec-${JSON.stringify(t.candidate_output)}` } }),
      sandbox: makeNodeSandbox(),
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.verified).toBe(true);
    expect(verdict.adversarial_validated).toBe(true);
    expect(verdict.anchor.source).toBe('spec');
    expect(verdict.detail).toMatch(/复现通过|adversarial/);
  });
});

describe('② 自证回路被拒（non-circularity，§9.2 防自证）', () => {
  it('锚 source 指向被验证对象自身（source=candidate）→ 拒绝', async () => {
    const verdict = await runReproductionOracle({
      task,
      spec: spec({ anchor: { source: 'candidate', ref: 'spec-42' } }),
      sandbox: makeNodeSandbox(),
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toMatch(/自证|独立/);
  });

  it('锚 ref 指向被验证对象自身输出（ref=output）→ 拒绝', async () => {
    const verdict = await runReproductionOracle({
      task,
      spec: spec({ anchor: { source: 'spec', ref: 'output' } }),
      sandbox: makeNodeSandbox(),
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toMatch(/自证|独立/);
  });

  it('锚 source = 任务自身 id → 拒绝（oracle 不得以被验证对象为锚）', async () => {
    const verdict = await runReproductionOracle({
      task,
      spec: spec({ anchor: { source: task.task_id, ref: 'x' } }),
      sandbox: makeNodeSandbox(),
    });
    expect(verdict.ok).toBe(false);
  });
});

describe('③ 独立锚通过（source=fixture/spec 等独立事实来源）', () => {
  it('source=fixture ref=fixture.json（独立 fixture 事实）→ 接受', async () => {
    const verdict = await runReproductionOracle({
      task,
      spec: spec({ anchor: { source: 'fixture', ref: 'fixture.json' } }),
      sandbox: makeNodeSandbox(),
    });
    expect(verdict.ok).toBe(true);
  });
});

describe('④ 复现失败（沙箱内 exit≠0）→ 拒绝', () => {
  it('脚本对候选输出判失败 → verdict ok:false + 复现失败 detail', async () => {
    const badScript = [
      `const input = JSON.parse(process.argv[2] ?? 'null');`,
      `if (input && input.answer === 999) process.exit(0);`,
      `console.error('MISMATCH');`,
      `process.exit(1);`,
    ].join('\n');
    const verdict = await runReproductionOracle({
      task,
      spec: spec({ script: badScript }),
      sandbox: makeNodeSandbox(),
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.verified).toBe(false);
    expect(verdict.detail).toMatch(/复现失败|exit/);
  });
});

describe('⑤ adversarial validation：对抗样本未如预期失败 → oracle 不可信拒绝', () => {
  it('对抗样本本应失败却通过（expect_fail=true 但脚本 exit 0）→ 拒绝', async () => {
    // 脚本永远 exit 0（对抗样本也通过）→ adversarial validation 失败
    const alwaysPass = [`process.exit(0);`].join('\n');
    const verdict = await runReproductionOracle({
      task,
      spec: spec({ script: alwaysPass }),
      sandbox: makeNodeSandbox(),
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.adversarial_validated).toBe(false);
    expect(verdict.detail).toMatch(/adversarial|对抗/);
  });
});

describe('⑥ checkAnchorIndependence 纯函数边界', () => {
  it('独立锚 → ok；candidate/output 锚 → 拒绝', () => {
    expect(checkAnchorIndependence({ source: 'spec', ref: 'spec-1' }, task).ok).toBe(true);
    expect(checkAnchorIndependence({ source: 'fixture', ref: 'f.json' }, task).ok).toBe(true);
    expect(checkAnchorIndependence({ source: 'candidate', ref: 'f.json' }, task).ok).toBe(false);
    expect(checkAnchorIndependence({ source: 'spec', ref: 'candidate_output' }, task).ok).toBe(false);
    expect(checkAnchorIndependence({ source: task.task_id, ref: 'output' }, task).ok).toBe(false);
  });
});
