// layer 2：World/Self 模型运行组装（架构 §4.6.1 微内核：World Model = 项目架构/依赖/运行时/外部状态；
// Self Model = 当前能力/已知限制/可靠策略/易失败工具/版本/资源/epistemic blind spots）。
// S1（2026-08-24-completion-sweep）：装配期从 runtime 真实状态组装 S4 模型（纯读取、确定性、无副作用）。
//
// 确定性契约：buildWorldModel/buildSelfModel 是 RuntimeView 的纯函数——同 view → 同内容同 id
// （id = 内容寻址派生 uuid，同 state-reducer detUuid 同款语义；created/updated 取 view.assembledAt——
// 视图装配时刻，进程内稳定）。无 I/O、无随机、无时间依赖（时间戳为入参）。
// 诚实未知：无硬数据/未装配面 → 缺省字段或"未知/未验证"标记，不臆造。
// 层 DAG（CONVENTIONS §4）：runtime(2) → supervisor(1)（CapabilityLike 类型）/kernel(2) 满足
// "import 目标层 ≤ 源层"。
import { createHash } from 'node:crypto';
import { canonicalJson, type Fingerprint, type Provenance } from '../kernel/schemas/base.js';
import type { SelfModel, WorldModel } from '../kernel/schemas/s.js';
import type { CapabilityLike } from '../supervisor/capability.js';
import type { DegradationRecord } from './loop-hooks.js';

/** 组件清单项（ComponentRegistry.list() 视图；结构最小化，不引 supervisor 实现） */
export interface ComponentViewEntry {
  manifest_id: string;
  status: string;
  healthy: boolean | null;
  health_detail: string | null;
}

/** 基准报告存在性（<persistDir> 下 <mode>-*.jsonl 文件计数；目录不可读 → 0） */
export interface BenchPresence {
  recent_real_reports: number;
  recent_replay_reports: number;
}

/** 资源视图（无硬数据源 → memory_mb/cpus = null + detail 说明——诚实未知） */
export interface ResourceView {
  memory_mb: number | null;
  cpus: number | null;
  detail: string;
}

/**
 * 运行时状态视图（模型组装的唯一输入；CognitiveRuntime.assembleModelView 装配——纯读取）。
 * 同 runtime 状态 → 同视图 → 同模型内容（确定性）。
 */
export interface RuntimeView {
  /** 视图装配时刻（ISO；进程内稳定——模型 created/updated 取此值，保证同 view 确定性） */
  assembledAt: string;
  /** 运行时快照哈希（rs:<16hex>；全降级 'rs:assembly'） */
  snapshotHash: string;
  /** 当前版本线（lineSnapshot?.line；缺省 stable） */
  line: string;
  /** 当前版本线 commit（lines 未注入 → null，模型缺省该字段） */
  commit: string | null;
  /** 已注入的线快照（lines 物化；未注入 → null） */
  lineSnapshot: { line: string; commit: string; dir: string } | null;
  /** lines 按线加载降级原因（无 → null） */
  lineDegraded: string | null;
  /** 快照机制降级（全降级 rs:assembly；无 → null） */
  snapshotDegraded: string | null;
  /** 组件装配/健康降级（无 → null） */
  componentDegraded: string | null;
  /** 已注册能力（CapabilityRegistry.list()） */
  capabilities: CapabilityLike[];
  /** 组件清单（ComponentRegistry.list()） */
  components: ComponentViewEntry[];
  /** 守卫降级记录（loop-hooks degradationLog；测试可清空） */
  degradations: readonly DegradationRecord[];
  /** R6 宿主 DSH 版本（hostVersion() 唯一来源） */
  hostVersion: string;
  /** 插件（preset）版本（package.json；不可读 → 'unknown'） */
  pluginVersion: string;
  /** 环境指纹（collectEnvironmentFingerprint()） */
  environmentFingerprint: Fingerprint;
  /** 资源（node:os 系统级实测；无硬数据 → null + detail） */
  resources: ResourceView;
  /** 基准报告存在性（最近 real/replay 报告数） */
  bench: BenchPresence;
  /** 布局状态（lines 物化注入 vs 回退仓库默认） */
  layoutState: 'lines-injected' | 'repo-default';
  /** 真实 DSH 模型路径是否装配（ModelAdapter） */
  modelAdapterAvailable: boolean;
  /** 维护调度器是否装配 */
  maintenanceAvailable: boolean;
  /** checkpoint 持久化是否装配 */
  checkpointAvailable: boolean;
}

/** 可靠策略（SelfModel.reliable_strategies——项目级实证策略；初值固定，观测积累后标定 §17） */
const RELIABLE_STRATEGIES = [
  '确定性重放：State 仅由事件流重建（P7 模型可见 ⟺ 可重建）',
  'schema 校验 fail-loud（IR 契约层防漂移）',
  '守卫式接入：接口缺失/运行时缺失 → 记录降级不崩',
  '机制即数据：策略/过程改 YAML 即生效（懒加载）',
];

/** 确定性 uuid 形状 id（内容寻址：同内容同 id，改内容 = 新 id；state-reducer detUuid 同款） */
function modelId(prefix: 'wm' | 'sm', seed: string): string {
  const h = createHash('sha256').update(seed, 'utf8').digest('hex');
  const u = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
  return `${prefix}:${u}`;
}

/** S4 IRBase 包络（created/updated/provenance 取自 view——确定性；scope=Project 与 ir-samples 同款） */
function modelEnvelope(prefix: 'wm' | 'sm', seed: string, view: RuntimeView) {
  return {
    id: modelId(prefix, seed),
    ir_version: '2.0',
    schema: 'omb/S4',
    scope: 'Project' as const,
    lifecycle: 'active' as const,
    immutable: false as const,
    owner: 'kernel' as const,
    created: view.assembledAt,
    updated: view.assembledAt,
    provenance: {
      source: 'runtime/models',
      event: 'assembly/models',
      actor: 'kernel',
      environment: view.environmentFingerprint,
      runtime_snapshot: view.snapshotHash,
      timestamp: view.assembledAt,
      transformation_chain: [],
      verification: 's4-schema',
    } satisfies Provenance,
    refs: [],
  };
}

/** 已知限制收集（WorldModel.limitations——降级/未知面如实记录，不假装正常） */
function collectLimitations(view: RuntimeView): string[] {
  const out: string[] = [];
  if (view.lineDegraded !== null) out.push(`版本线加载降级：${view.lineDegraded}`);
  if (view.snapshotDegraded !== null) out.push(`快照机制降级：${view.snapshotDegraded}`);
  if (view.componentDegraded !== null) out.push(`组件装配降级：${view.componentDegraded}`);
  if (view.commit === null) out.push('当前版本线 commit 未知（lines 未注入）——运行于仓库默认策略/过程');
  if (view.bench.recent_real_reports === 0) out.push('无真实执行基准报告（仅回放/无记录）——真实 DSH 会话路径未验证');
  for (const d of view.degradations) {
    out.push(`守卫降级 [${d.hook}]: ${d.reason}`);
  }
  return out;
}

/** 盲点收集（SelfModel.blind_spots——未装配面/无硬数据如实标记，诚实未知） */
function collectBlindSpots(view: RuntimeView): string[] {
  const out: string[] = [];
  if (!view.modelAdapterAvailable) {
    out.push('真实 DSH 模型路径未装配（modelAdapter 缺失）——LLM 生成/真实执行未验证');
  }
  if (!view.maintenanceAvailable) out.push('维护调度器未装配——维护任务/债务不落盘');
  if (!view.checkpointAvailable) out.push('checkpoint 持久化未装配——重启后工作状态不恢复');
  if (view.resources.memory_mb === null || view.resources.cpus === null) {
    out.push('资源数据无硬数据源（内存/CPU 未探测）——诚实未知');
  }
  if (view.degradations.length > 0) out.push(`已记录守卫降级 ${view.degradations.length} 条（见世界模型 limitations）`);
  return out;
}

/**
 * WorldModel 组装（S4 纯函数）：项目架构事实（版本线/commit/lines 快照/布局状态/基准报告存在性）+
 * 环境指纹 + 能力面 + 已知限制。同 view → 同模型（内容/id 确定性）；纯读取无副作用。
 */
export function buildWorldModel(view: RuntimeView): WorldModel {
  const capabilities = [...new Set(view.capabilities.map((c) => c.name))].sort();
  const limitations = collectLimitations(view);
  const line = view.line;
  const commit = view.commit ?? undefined;
  const lineSnapshot = view.lineSnapshot ?? undefined;
  const layoutState = view.layoutState;
  const bench = view.bench;
  const seed = canonicalJson({
    kind: 'world_model',
    line,
    commit,
    lineSnapshot,
    layoutState,
    bench,
    capabilities,
    limitations,
    environment: view.environmentFingerprint,
    snapshotHash: view.snapshotHash,
  });
  return {
    ...modelEnvelope('wm', seed, view),
    kind: 'world_model',
    capabilities,
    limitations,
    environment: view.environmentFingerprint,
    ...(line !== undefined ? { line } : {}),
    ...(commit !== undefined ? { commit } : {}),
    ...(lineSnapshot !== undefined ? { line_snapshot: lineSnapshot } : {}),
    ...(layoutState !== undefined ? { layout_state: layoutState } : {}),
    ...(bench !== undefined ? { bench } : {}),
  };
}

/**
 * SelfModel 组装（S4 纯函数）：当前能力面/组件状态 + 版本（R6 hostVersion/插件版本）+ 资源 +
 * 可靠策略 + 盲点 + 当前状态摘要。同 view → 同模型；纯读取无副作用。
 */
export function buildSelfModel(view: RuntimeView): SelfModel {
  const capabilityNames = [...new Set(view.capabilities.map((c) => c.name))].sort();
  const componentState = view.components.map((c) => `${c.manifest_id}:${c.status}`).join(',');
  const degraded: string[] = [];
  if (view.snapshotDegraded !== null) degraded.push(`快照机制：${view.snapshotDegraded}`);
  if (view.componentDegraded !== null) degraded.push(`组件装配：${view.componentDegraded}`);
  if (view.lineDegraded !== null) degraded.push(`版本线：${view.lineDegraded}`);
  if (view.degradations.length > 0) degraded.push(`守卫降级 ${view.degradations.length} 条`);
  const blind_spots = collectBlindSpots(view);
  const current_state =
    `装配${degraded.length > 0 ? '降级' : '正常'}：能力 ${capabilityNames.length} 项（${capabilityNames.join('/') || '无'}）；` +
    `组件 ${view.components.length} 个（${componentState || '无'}）；` +
    `hostVersion=${view.hostVersion}；插件版本=${view.pluginVersion}；` +
    `${degraded.length > 0 ? `降级：${degraded.join('；')}；` : '无降级；'}` +
    `资源=${view.resources.detail}`;
  const seed = canonicalJson({
    kind: 'self_model',
    hostVersion: view.hostVersion,
    pluginVersion: view.pluginVersion,
    resources: view.resources,
    capabilityNames,
    componentState,
    blind_spots,
    current_state,
    reliable_strategies: RELIABLE_STRATEGIES,
    environment: view.environmentFingerprint,
    snapshotHash: view.snapshotHash,
  });
  return {
    ...modelEnvelope('sm', seed, view),
    kind: 'self_model',
    reliable_strategies: RELIABLE_STRATEGIES,
    blind_spots,
    current_state,
    environment: view.environmentFingerprint,
    host_version: view.hostVersion,
    plugin_version: view.pluginVersion,
    resources: view.resources,
  };
}
