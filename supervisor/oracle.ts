// OMB v2 Verification Synthesis —— reproduction oracle（架构 §9.2：生成 → 沙箱验证 → anti-circularity：
// independent anchor + adversarial validation + non-circularity 防自证；施工计划 T8.14）。
// 语义（§9.2：AI 生成的 verifier 只能是 candidate verifier，防自证）：
//   - independent anchor：oracle 的判定锚必须是独立于被验证对象的来源（fixture/spec/external 等
//     独立事实），绝不允许引用被验证对象自身输出——引用自身输出 = 自证回路 → 拒绝（non-circularity）；
//   - 沙箱验证：可执行复现脚本在沙箱（受限执行）内跑通（exit 0）→ 复现成功；
//   - adversarial validation：对抗样本须如预期失败（oracle 能拒绝已知坏输入 → 可信）；
//     对抗样本未如预期 → oracle 不可信 → 拒绝。
// 生成侧：scriptBuilder 注入（生产：LLM/规则生成复现脚本；测试：确定性 builder）——
// 本模块实现 oracle 执行机制（锚独立性检查 + 沙箱运行 + 对抗验证），不持有具体生成器。
// layer 1（supervisor/）：仅 import node: 内置 + kernel/schemas/（契约例外）+ 同层文件。

// ---- 类型 ----

/** 被验证任务（无现成 verifier 的任务：仅任务事实 + 候选输出） */
export interface OracleTask {
  task_id: string;
  goal: string;
  /** 被验证对象自身输出（防自证：不得作为 oracle 锚） */
  candidate_output: unknown;
}

/** 独立锚（oracle 判定依据：独立事实来源，如 fixture 文件 / 规范文档 / 外部事实） */
export interface OracleAnchor {
  /** 锚来源（'fixture'/'spec'/'external' 等独立来源；'candidate'/任务 id = 自证 → 拒绝） */
  source: string;
  /** 锚引用（如 fixture 文件名 / 规范段落 id；'output'/'candidate_output' = 自证 → 拒绝） */
  ref: string;
}

/** Oracle 规格：可执行复现脚本 + 独立锚 + 对抗样本（生成产物，供沙箱验证） */
export interface OracleSpec {
  /** 可执行复现脚本（node 脚本源码；沙箱受限执行） */
  script: string;
  anchor: OracleAnchor;
  /** 对抗样本：oracle 必须按 expect_fail 拒绝（证明 oracle 能区分好坏，非空洞通过） */
  adversarial: { input: unknown; expect_fail: boolean };
}

/** 沙箱接口（受限执行）：脚本 + 输入 → 退出码 + 输出（测试用 node spawn 真执行；生产接 T0.5 sandbox） */
export interface SandboxRunInput {
  script: string;
  input: unknown;
  workdir: string;
}

export interface SandboxRunResult {
  /** 退出码（0 = 脚本判定通过） */
  code: number;
  output: unknown;
  stderr?: string;
}

export interface SandboxLike {
  run(input: SandboxRunInput): Promise<SandboxRunResult>;
}

/** Oracle 判定结果 */
export interface OracleVerdict {
  ok: boolean;
  detail: string;
  anchor: OracleAnchor;
  /** 沙箱内复现是否跑通（exit 0） */
  verified: boolean;
  /** 对抗样本是否如预期被拒（oracle 可信性） */
  adversarial_validated: boolean;
}

// ---- anti-circularity：锚独立性检查（纯函数） ----

/**
 * 自证回路检测（§9.2 non-circularity）：锚 source 指向被验证对象自身（'candidate'/任务 id）
 * 或 ref 指向自身输出（'output'/'candidate_output'）→ 拒绝；独立来源 → 通过。
 */
export function checkAnchorIndependence(anchor: OracleAnchor, task: OracleTask): { ok: boolean; detail: string } {
  if (anchor.source === 'candidate' || anchor.source === task.task_id) {
    return {
      ok: false,
      detail: `自证回路被拒：oracle 锚 source=${anchor.source} 引用被验证对象自身（independent anchor 必须独立于候选输出，§9.2）`,
    };
  }
  if (anchor.ref === 'output' || anchor.ref === 'candidate_output') {
    return {
      ok: false,
      detail: '自证回路被拒：oracle 锚 ref 指向被验证对象自身输出（non-circularity，§9.2）',
    };
  }
  return { ok: true, detail: `锚独立通过：source=${anchor.source} ref=${anchor.ref}` };
}

// ---- 执行 ----

/** 失败 verdict 构造（detail 前缀统一） */
function failVerdict(anchor: OracleAnchor, detail: string): OracleVerdict {
  return { ok: false, detail, anchor, verified: false, adversarial_validated: false };
}

/**
 * 执行 reproduction oracle（生成 → 沙箱验证 → anti-circularity）：
 * ① 锚独立性检查（自证 → 拒绝，不执行脚本）→ ② 沙箱运行复现脚本（exit 0 = 复现成功）→
 * ③ adversarial validation（对抗样本按 expect_fail 被拒 = oracle 可信）。
 */
export async function runReproductionOracle(opts: {
  task: OracleTask;
  spec: OracleSpec;
  sandbox: SandboxLike;
}): Promise<OracleVerdict> {
  const independence = checkAnchorIndependence(opts.spec.anchor, opts.task);
  if (!independence.ok) {
    return failVerdict(opts.spec.anchor, independence.detail);
  }

  const run = await opts.sandbox.run({
    script: opts.spec.script,
    input: opts.task.candidate_output,
    workdir: '.',
  });
  const verified = run.code === 0;
  if (!verified) {
    const stderr = run.stderr === undefined || run.stderr.length === 0 ? '' : `（${run.stderr.trim()}）`;
    return failVerdict(opts.spec.anchor, `复现失败：沙箱内 exit=${run.code}${stderr}`);
  }

  const adv = await opts.sandbox.run({
    script: opts.spec.script,
    input: opts.spec.adversarial.input,
    workdir: '.',
  });
  const advFailed = adv.code !== 0;
  const adversarialValidated = advFailed === opts.spec.adversarial.expect_fail;
  if (!adversarialValidated) {
    return failVerdict(
      opts.spec.anchor,
      `adversarial validation 失败：对抗样本 expect_fail=${opts.spec.adversarial.expect_fail} 但实际 ${
        advFailed ? '被拒' : '通过'
      }——oracle 不可信（无法区分好坏输入），拒绝`,
    );
  }
  return {
    ok: true,
    detail: '复现通过（沙箱 exit 0）+ adversarial validation 通过——oracle 可信（independent anchor，§9.2）',
    anchor: opts.spec.anchor,
    verified: true,
    adversarial_validated: true,
  };
}

/**
 * 合成 + 执行 reproduction oracle（无现成 verifier 任务 → 生成可执行复现脚本 → 沙箱验证）。
 * scriptBuilder 为生成侧注入（生产：LLM/规则生成复现脚本；测试：确定性 builder）。
 */
export async function synthesizeReproductionOracle(opts: {
  task: OracleTask;
  scriptBuilder: (task: OracleTask) => OracleSpec;
  sandbox: SandboxLike;
}): Promise<OracleVerdict> {
  const spec = opts.scriptBuilder(opts.task);
  return runReproductionOracle({ task: opts.task, spec, sandbox: opts.sandbox });
}
