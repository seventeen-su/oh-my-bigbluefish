// OMB v2 Runtime Snapshot（架构 §11.2 请求级一致性原语 / §4.2 M5 / 施工计划 T1.6）：layer 1。
// RuntimeSnapshotHash = sha256(组件 sha256 清单 + git_revision)（≠ M0 的 git_revision 本身，T1.6 明示）。
// 请求开始解析 snapshot hash，整个请求只读该快照；promote（晋升）只影响后续请求（请求 A 全程 v7）。
//
// 设计决策（brief 已定 + 实现选择）：
// - versioning.ts 只做哈希计算与注册表，不感知组件内部（解释器不拥有领域知识）；组件 sha256 清单
//   由调用方提供（M1 阶段组件未全部实现——占位常量/文件内容哈希；M2+ 接入真实组件 hash）。
// - 规范化：组件清单按固定键序 JSON.stringify 拼接 gitRevision 再 sha256（输入键序无关，确定性）。
// - createSnapshot 输入校验：六键必须齐全且均为 64-hex sha256（架构 §11.2 components 各 sha256；
//   比 T1.1 的 M5 schema 更严——schema 仅 philosophy 强制 64-hex，其余五键 min(1)）。
// - createSnapshot 产出 immutable 对象：id = `sha256:<hash>`，改组件/git_revision = 新 id（§4.1）。
// - task_contract_ref / activation_contract_ref：未提供时用占位符 'unbound'（M1 阶段契约引用未绑定；
//   M2+ 接入真实 TaskContract / ActivationContract ref；schema 要求 min(1)，不允许空串）。
// - SnapshotRegistry：begin(requestId) 幂等绑定当前快照；get(requestId) 未绑定 → fail-loud；
//   end(requestId) 释放（未绑定 end 为空操作，cleanup 路径安全）；promote(next) 校验 M5 schema 后切换
//   （非法快照 fail-loud，registry 状态不被污染）；已绑定请求不受 promote 影响。
// - resolveSnapshot(request, {current})：请求级解析入口——已绑定 → 返回原快照（全程锁定）；
//   未绑定 → 绑定调用方提供的 current（生产中 = registry.currentSnapshot）。
// layer 1（supervisor/）：仅 import node: 内置 + kernel/schemas/（IR 契约例外，CONVENTIONS §4）。
import { createHash } from 'node:crypto';
import { RuntimeSnapshotSchema, type RuntimeSnapshot } from '../kernel/schemas/m.js';

/** 组件 sha256 清单（架构 §11.2 runtime 六键；值 = 组件内容 sha256，由调用方提供） */
export interface ComponentHashes {
  scheduler: string;
  memory: string;
  verifier: string;
  renderer: string;
  capability: string;
  philosophy: string;
}

/** 固定键序（哈希规范化基准；ComponentHashes 声明序） */
const COMPONENT_KEYS = ['scheduler', 'memory', 'verifier', 'renderer', 'capability', 'philosophy'] as const;

const SHA256_RE = /^[0-9a-f]{64}$/i;
const UNBOUND_REF = 'unbound';

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** 组件清单校验：缺键 / 非 64-hex sha256 → fail-loud（消息含键名） */
function assertComponentHashes(components: ComponentHashes): void {
  if (components === null || typeof components !== 'object') {
    throw new Error('versioning: components 必须为组件 sha256 清单对象');
  }
  for (const key of COMPONENT_KEYS) {
    const value = components[key];
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`versioning: components.${key} 缺失或为空`);
    }
    if (!SHA256_RE.test(value)) {
      throw new Error(`versioning: components.${key} 非法 sha256 格式: ${value}`);
    }
  }
}

function assertGitRevision(gitRevision: string): void {
  if (typeof gitRevision !== 'string' || gitRevision.length === 0) {
    throw new Error('versioning: gitRevision 缺失或为空');
  }
}

/** 规范化：组件清单按固定键序 JSON.stringify（输入键序无关） */
function canonicalComponents(components: ComponentHashes): string {
  return JSON.stringify({
    scheduler: components.scheduler,
    memory: components.memory,
    verifier: components.verifier,
    renderer: components.renderer,
    capability: components.capability,
    philosophy: components.philosophy,
  });
}

/** RuntimeSnapshotHash = sha256(规范化组件清单 JSON + gitRevision) */
export function computeRuntimeSnapshotHash(components: ComponentHashes, gitRevision: string): string {
  assertComponentHashes(components);
  assertGitRevision(gitRevision);
  return sha256Hex(`${canonicalComponents(components)}${gitRevision}`);
}

/** 创建 RuntimeSnapshot：M5 schema 校验产出（id = sha256:<hash>，immutable，内容寻址） */
export function createSnapshot(input: {
  components: ComponentHashes;
  gitRevision: string;
  taskContractRef?: string;
}): RuntimeSnapshot {
  assertComponentHashes(input.components);
  assertGitRevision(input.gitRevision);
  const hash = computeRuntimeSnapshotHash(input.components, input.gitRevision);
  const ts = new Date().toISOString();
  const snapshot: RuntimeSnapshot = {
    id: `sha256:${hash}`,
    ir_version: '2.0',
    schema: 'omb/M5',
    scope: 'Project',
    lifecycle: 'active',
    immutable: true,
    owner: 'kernel',
    created: ts,
    updated: ts,
    provenance: {
      source: 'system',
      event: 'snapshot/created',
      actor: 'kernel',
      environment: { os: process.platform, node: process.version, dsh_version: '0.1.0', project: 'omb-v2' },
      runtime_snapshot: `sha256:${hash}`,
      timestamp: ts,
      transformation_chain: [],
      verification: 'schema',
    },
    refs: [],
    components: { ...input.components },
    task_contract_ref: input.taskContractRef ?? UNBOUND_REF,
    activation_contract_ref: UNBOUND_REF,
  };
  const parsed = RuntimeSnapshotSchema.safeParse(snapshot);
  if (!parsed.success) {
    throw new Error(`versioning.createSnapshot: M5 schema 校验失败 — ${parsed.error.message}`);
  }
  return snapshot;
}

/** 快照对象校验（constructor / promote 共用；非法对象 → fail-loud） */
function assertSnapshot(snapshot: RuntimeSnapshot): void {
  const parsed = RuntimeSnapshotSchema.safeParse(snapshot);
  if (!parsed.success) {
    throw new Error(`versioning: 非法 RuntimeSnapshot（M5 schema 校验失败）— ${parsed.error.message}`);
  }
}

/**
 * SnapshotRegistry（§11.2 请求级锁定）：begin 绑定当前快照，get 全程返回同一快照，end 释放；
 * promote 切换"当前快照"，已绑定请求不受影响（继续持有旧快照）。
 */
export class SnapshotRegistry {
  private current: RuntimeSnapshot;
  private readonly bindings = new Map<string, RuntimeSnapshot>();

  constructor(initial: RuntimeSnapshot) {
    assertSnapshot(initial);
    this.current = initial;
  }

  /** 当前（最新）快照 */
  get currentSnapshot(): RuntimeSnapshot {
    return this.current;
  }

  /** 请求开始：绑定当前快照并返回；重复 begin 幂等（返回已绑定快照） */
  begin(requestId: string): RuntimeSnapshot {
    const existing = this.bindings.get(requestId);
    if (existing) {
      return existing;
    }
    this.bindings.set(requestId, this.current);
    return this.current;
  }

  /** 请求全程读取：未绑定 → fail-loud */
  get(requestId: string): RuntimeSnapshot {
    const bound = this.bindings.get(requestId);
    if (!bound) {
      throw new Error(`versioning: 请求未绑定快照（先 begin/resolveSnapshot）: ${requestId}`);
    }
    return bound;
  }

  /** 请求结束：释放绑定（未绑定请求 end 为空操作——cleanup 路径幂等安全） */
  end(requestId: string): void {
    this.bindings.delete(requestId);
  }

  /** 晋升：当前快照切换到 next；已绑定请求不受影响；非法快照 → fail-loud（状态不被污染） */
  promote(next: RuntimeSnapshot): void {
    assertSnapshot(next);
    this.current = next;
  }

  /** 请求级解析（brief 签名）：已绑定 → 原快照（全程锁定）；未绑定 → 绑定 opts.current 并返回 */
  resolveSnapshot(request: { id: string }, opts: { current: RuntimeSnapshot }): RuntimeSnapshot {
    const existing = this.bindings.get(request.id);
    if (existing) {
      return existing;
    }
    this.bindings.set(request.id, opts.current);
    return opts.current;
  }

  /** 当前活跃请求绑定数（测试/诊断） */
  activeCount(): number {
    return this.bindings.size;
  }
}
