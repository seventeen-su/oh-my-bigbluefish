// layer 0（substrate/）：外核安全状态（已知问题《内核加载失败不得阻塞宿主》/《外核自身也要非阻塞》）。
//
// 外核（恢复根）只做「识别与守卫」，不做重活。本模块是守卫面：
//   - `evaluateSafeState()`：在拉起内核**之前**做一次极轻量的自检（平台、宿主版本契约、恢复根可读性）；
//   - 不通过 → **安全状态**：不拉起内核、不改动运行数据、不执行演化与维护，只记录原因与时间；
//   - 任何异常都转成"安全状态"结果，**绝不抛穿到宿主**——宿主启动与运行完全正常
//     （插件表现为"存在但不介入"）；
//   - 可恢复：宿主修复或适配完成后重新评估即恢复（`evaluateSafeState` 每次调用都重新探测，
//     不在进程内缓存结论）。
//
// 与既有降级机制的关系（三层保护，known-issues《与既有降级机制的关系》）：
//   ① 本模块：装配期与平台探测期的异常不外溢（不阻塞宿主）→ ② boot gate：boot 未通过则仅命令模式
//   （既有）→ ③ 运行期各接口缺失逐项降级（既有）。
//
// 层纪律：substrate(0) 只依赖 node: 内置与 substrate 内文件。
import fs from 'node:fs';
import path from 'node:path';
import { platformProvider } from './platform.js';

/** 安全状态原因类别（机器可读；便于状态面与日志归类） */
export type SafeStateReasonKind =
  | 'ok'
  | 'platform_probe_failed'
  | 'host_version_missing'
  | 'host_version_malformed'
  | 'host_version_changed'
  | 'layout_unreadable'
  | 'probe_exception';

/** 安全状态评估结果（ok=false → 不拉起内核；degraded 为可读说明） */
export interface SafeStateResult {
  ok: boolean;
  /** 原因（ok=false 时非空；可读） */
  reason: string | null;
  kind: SafeStateReasonKind;
  /** 评估时间（epoch ms；状态面可读） */
  at: number;
  /** 平台标识（排障用） */
  platform: string;
  /** 平台能力降级说明（能力缺失时非空；与安全状态相互独立——能力缺失不一定阻断拉起） */
  platform_degraded: string | null;
  /** 探测详情（键值对；登记进状态面，可读） */
  details: Record<string, string>;
}

/** 宿主版本号形态（semver 三段 + 可选预发布/构建段；本插件只按此形态做契约校验） */
const HOST_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export interface EvaluateSafeStateOptions {
  /** 配置面声明的宿主版本（agent.cordis.yml config.hostVersion） */
  configuredHostVersion?: string;
  /** 出厂缺省宿主版本（`DSH_HOST_VERSION`）——配置面未声明时使用；两者皆空 → host_version_missing */
  defaultHostVersion?: string;
  /** 实际观测到的宿主版本（宿主暴露时传入；缺省不比较） */
  observedHostVersion?: string;
  /** 恢复根目录（存在性自检；缺省跳过） */
  substrateRoot?: string;
  /** 时钟注入（测试） */
  now?: () => number;
}

/** 返回安全状态结果（永不抛） */
function fail(
  kind: SafeStateReasonKind,
  reason: string,
  base: { at: number; platform: string; platform_degraded: string | null; details: Record<string, string> },
): SafeStateResult {
  return { ok: false, kind, reason, ...base };
}

/**
 * 安全状态评估（**永不抛**）。检查顺序（先廉价、先关键）：
 *   ① 平台探测（异常 → platform_probe_failed）；
 *   ② 宿主版本契约：配置了就必须形态合法（缺失/畸形 → 安全状态，避免用错版本的契约去装配内核）；
 *      配置值与观测值不一致 → host_version_changed（宿主升级后未同步配置，指纹与事件来源会失真）；
 *   ③ 恢复根可读性（substrate 目录存在且可读；不可读 → layout_unreadable）。
 * 平台能力缺失（如无受限执行通道）**不**单独构成安全状态——它是能力降级，由状态面标注，
 * 不影响内核拉起（候选执行自有 G3-exec 降级路径）。
 */
export function evaluateSafeState(opts: EvaluateSafeStateOptions = {}): SafeStateResult {
  const now = opts.now ?? (() => Date.now());
  const details: Record<string, string> = {};
  let platform = 'unknown';
  let platformDegraded: string | null = null;
  const at = now();
  try {
    const provider = platformProvider();
    platform = provider.caps.raw;
    platformDegraded = provider.caps.degraded;
    details.platform_read_only = provider.caps.read_only;
    details.platform_sandbox = provider.caps.sandbox;
  } catch (err) {
    return {
      ok: false,
      kind: 'platform_probe_failed',
      reason: `平台探测失败（${(err as Error).message}）——外核不拉起内核（不介入）`,
      at,
      platform,
      platform_degraded: null,
      details,
    };
  }
  const base = { at, platform, platform_degraded: platformDegraded, details };

  const configured = opts.configuredHostVersion;
  // 缺省语义：配置面未声明 → 使用出厂缺省（`DSH_HOST_VERSION`，由调用方经 defaultHostVersion 传入）。
  // 理由：插件既有语义就是「config.hostVersion 覆写缺省」（kernel/schemas/host-version.ts），
  // 把"未声明"直接判成安全状态会与既有行为冲突（既有装配正是靠这个缺省工作）；
  // 真正需要安全状态的是**形态非法**与**声明值 ≠ 观测值**（契约可能不匹配）。
  const declared = configured !== undefined && configured.length > 0 ? configured : opts.defaultHostVersion;
  if (declared === undefined || declared.length === 0) {
    return fail(
      'host_version_missing',
      '既未声明宿主版本（config.hostVersion）也无出厂缺省（DSH_HOST_VERSION）——契约无法校验，外核不拉起内核（不介入）',
      base,
    );
  }
  details.host_version = declared;
  if (configured !== undefined && configured.length > 0) {
    details.host_version_source = 'config';
  } else {
    details.host_version_source = 'default';
  }
  if (!HOST_VERSION_RE.test(declared)) {
    return fail(
      'host_version_malformed',
      `宿主版本 "${declared}" 形态非法（应为 semver，如 0.1.3-alpha.2）——外核不拉起内核（不介入）`,
      base,
    );
  }
  if (opts.observedHostVersion !== undefined && opts.observedHostVersion.length > 0) {
    details.host_version_observed = opts.observedHostVersion;
    if (opts.observedHostVersion !== declared) {
      return fail(
        'host_version_changed',
        `宿主版本变化（契约声明 ${declared} ≠ 观测 ${opts.observedHostVersion}）——契约可能不匹配，` +
          '外核不拉起内核（不介入）；同步 agent.cordis.yml 的 hostVersion 后自动恢复',
        base,
      );
    }
  }

  if (opts.substrateRoot !== undefined && opts.substrateRoot.length > 0) {
    try {
      const st = fs.statSync(opts.substrateRoot);
      if (!st.isDirectory()) {
        return fail('layout_unreadable', `恢复根不是目录（${opts.substrateRoot}）——外核不拉起内核（不介入）`, base);
      }
      fs.readdirSync(opts.substrateRoot);
      details.substrate_root = opts.substrateRoot;
    } catch (err) {
      return fail(
        'layout_unreadable',
        `恢复根不可读（${(err as Error).message}）——外核不拉起内核（不介入）`,
        base,
      );
    }
  }

  return { ok: true, kind: 'ok', reason: null, ...base };
}

/** 安全状态下的恢复根自检路径（preset 根下的 substrate/；供装配面注入） */
export function substrateRootOf(presetRoot: string): string {
  return path.join(presetRoot, 'substrate');
}
