// layer 2（runtime/）：宿主契约哨兵 + 插件配置面收敛（已知问题《非阻塞设计不足：插件**注册期**仍可能阻塞宿主》）。
//
// 问题（用户指出，成立）：此前的非阻塞只覆盖「内核装配期」与「外核安全状态」，两者都发生在
// **插件自己的代码开始执行之后**。真正的失败点可能在更前面——**宿主解析这一行插件的时候**：
// `agent.cordis.yml` 里插件行的 `config` 由宿主校验，若新版 harness 改了要求（配置键改名/新增必填项、
// `inject` 校验变严、入口解析规则变化），失败会在插件代码运行之前发生，插件内的 try/catch 没有机会生效。
//
// 本模块能做的（插件自身层，不发散到 preset/宿主层）：
//   ① **配置面收敛**：插件只读它真正需要的键，未知键**忽略并记降级**（不是硬失败）；
//      新旧键双读（新键优先、旧键兜底、两者都缺则缺省），使"宿主侧多传/改名"不致命。
//   ② **契约哨兵**：把依赖的宿主面列成清单（服务名 / 方法形状 / 事件名），逐项探测、
//      只对缺失项降级——覆盖"服务改名/缺失/形状变化"这一类兼容性故障，并把结论交给状态面。
//   ③ 明确的边界结论：哨兵**覆盖不了「插件行解析失败」**（那发生在插件代码之前）。
//      该层的兜底只能来自 preset 组合（可选包含）或宿主（插件加载失败不阻断启动），不在本仓库实现范围内。
//
// layer 2：仅 node: 内置（本模块零依赖，纯数据 + 纯判定，方便测试锚定）。
import type { ContextLike } from './plugin.js';

/** 宿主面依赖条目（服务名 + 必需方法 + 用途说明 + 缺失后果） */
export interface HostContractEntry {
  /**
   * 读取面：
   *   - `get`：宿主**服务**（经 `ctx.get(name)` 免 inject 读取——DSH Guard 契约下直接读未 inject
   *     的属性会抛 `cannot get property "x" without inject`）；
   *   - `ctx`：上下文**自身属性/accessor**（如 Cordis 的 `ctx.on` / `ctx.effect` mixin——它们不是
   *     provide 的服务，`ctx.get` 取不到，直接属性读取才是正确面）。
   */
  via: 'get' | 'ctx';
  /** 宿主面名（服务名或属性名） */
  service: string;
  /** 依赖的方法名（缺失 → 该条目降级；空数组 = 只依赖该面存在） */
  methods: string[];
  /** 用途（排障可读：这个面是干什么用的） */
  purpose: string;
  /** 缺失后果（降级到什么程度）——**必填**，避免出现"说不清丢了会怎样"的依赖 */
  onMissing: string;
  /** 是否必需（必需项缺失 → 该能力面整体不可用；非必需 → 只降级对应子能力） */
  required: boolean;
}

/**
 * 宿主面清单（**唯一来源**：本模块声明什么就探测什么——不再散落在各处 try/catch 里）。
 * 纪律：只列真实依赖，且写清缺失后果；不列"未来可能用"的面（无谓的探测也是噪声）。
 */
export const HOST_CONTRACT: HostContractEntry[] = [
  {
    via: 'get',
    service: 'commands',
    methods: ['register'],
    purpose: '注册 /mode、/bench、/evolve 命令面',
    onMissing: '命令面不可用（OMB 只能被动观察与注入，无法手动切换版本线/触发演化）',
    required: true,
  },
  {
    via: 'get',
    service: 'tools',
    methods: ['register'],
    purpose: '注册 kern_* 工具（状态/基准/演化/记忆/画像）',
    onMissing: '模型侧工具面不可用（认知层仍工作，但模型无法主动查询状态或触发演化）',
    required: false,
  },
  {
    via: 'get',
    service: 'systemPrompt',
    methods: ['context'],
    purpose: '注入每轮认知投影（工作状态/记忆候选/认知过程）',
    onMissing: '投影不在系统提示中注入（认知层内部仍运行，但模型看不到投影）',
    required: false,
  },
  {
    via: 'ctx',
    service: 'on',
    methods: [],
    purpose: '订阅 session/event、session/flush、tools/result',
    onMissing: '事件采集与收尾触发不可用（无事件入链、无 turn 收尾）',
    required: false,
  },
  {
    via: 'ctx',
    service: 'effect',
    methods: [],
    purpose: '注册生命周期清理（工具注销/运行时关闭）',
    onMissing: '缺少清理钩子（进程退出时资源回收退化为进程级兜底）',
    required: false,
  },
  {
    via: 'get',
    service: 'llm',
    methods: [],
    purpose: '装配 ModelAdapter（供 /bench 真实模式）',
    onMissing: '基准退回回放模式（不消耗模型调用，功能降级但可用）',
    required: false,
  },
  {
    via: 'get',
    service: 'subagents',
    methods: ['start'],
    purpose: '空白子代理单次裁判（验证债务复核）',
    onMissing: '语义裁判不可用 → 验证债务转人工复核（既有诚实降级路径）',
    required: false,
  },
  {
    via: 'get',
    service: 'dynamicCordisRunner',
    methods: [],
    purpose: '候选验证脚本的 runner 通道（G3-exec 增强通道）',
    onMissing: '候选验证回退受限子进程路径（既有降级路径）',
    required: false,
  },
  {
    via: 'get',
    service: 'desktopNotify',
    methods: [],
    purpose: '桌面通知推送（dsh-desktop-notify 兼容）',
    onMissing: '通知面静默（不打扰主人，其余功能不受影响）',
    required: false,
  },
];

/** 单条契约探测结果 */
export interface HostContractProbe {
  service: string;
  via: 'get' | 'ctx';
  /** 该面是否可读且非空 */
  present: boolean;
  /** 缺失的方法名（present=true 时才有意义） */
  missing_methods: string[];
  /** 该条目是否降级（面缺失 或 任一方法缺失） */
  degraded: boolean;
  purpose: string;
  onMissing: string;
  required: boolean;
  /** 不可读原因（读取抛错时；Guard 契约下未 inject 的属性读取会抛） */
  read_error?: string;
}

/** 哨兵结论（状态面可读：宿主面缺了什么、各自影响什么） */
export interface HostContractReport {
  probes: HostContractProbe[];
  /** 降级的条目（服务名列表；空数组 = 全部就绪） */
  degraded: string[];
  /** 必需项是否全部就绪（false → 该能力面整体不可用，但**插件照常加载**） */
  required_ok: boolean;
  /** 边界声明（诚实：哨兵覆盖范围到此为止） */
  scope_note: string;
}

/**
 * 探测宿主面（逐项守卫式读取——**永不抛**）。
 * 读取纪律与 plugin.ts 的 readService 一致：`via='get'` 的面经 `ctx.get(name)` 免 inject 读取
 * （Guard 契约：未 inject 的属性直接读会抛），`via='ctx'` 的面直接读上下文自身属性（如 `ctx.on`）。
 * 测试 fakeCtx 无 get 时退化到普通属性读取（与 readService 同款兼容）。
 */
export function probeHostContract(ctx: ContextLike): HostContractReport {
  const probes: HostContractProbe[] = [];
  for (const entry of HOST_CONTRACT) {
    let value: unknown;
    let readError: string | undefined;
    try {
      if (entry.via === 'get' && typeof ctx.get === 'function') {
        value = ctx.get(entry.service);
      } else {
        value = (ctx as unknown as Record<string, unknown>)[entry.service];
      }
    } catch (err) {
      readError = err instanceof Error ? err.message : String(err);
      value = undefined;
    }
    const present = value !== null && value !== undefined;
    const missingMethods: string[] = [];
    if (present && entry.methods.length > 0) {
      for (const m of entry.methods) {
        const fn = (value as Record<string, unknown>)[m];
        // 方法可以是函数，也可以是 Cordis 的 accessor/mixin（真实 context.on 是 mixin accessor）
        if (typeof fn !== 'function') {
          missingMethods.push(m);
        }
      }
    }
    probes.push({
      service: entry.service,
      via: entry.via,
      present,
      missing_methods: missingMethods,
      degraded: !present || missingMethods.length > 0,
      purpose: entry.purpose,
      onMissing: entry.onMissing,
      required: entry.required,
      ...(readError !== undefined ? { read_error: readError } : {}),
    });
  }
  const degraded = probes.filter((p) => p.degraded).map((p) => p.service);
  return {
    probes,
    degraded,
    required_ok: probes.every((p) => !p.required || !p.degraded),
    scope_note:
      '哨兵覆盖：宿主服务/方法形状缺失与改名（插件代码运行之后的兼容性故障）。' +
      '不覆盖：插件行本身被宿主解析失败（配置键校验/入口解析——发生在插件代码之前），' +
      '那一层的兜底需要 preset 组合或宿主策略，不在本仓库范围内。',
  };
}

/** 配置面声明（哪些键是本插件认识的；未知键忽略并记降级——防"宿主侧多传/改名"变成硬失败） */
export const KNOWN_PLUGIN_CONFIG_KEYS: readonly string[] = [
  'cognitiveRoot',
  'model',
  'benchPersistDir',
  'benchVersion',
  'activationLogDir',
  'bootstrap',
  'line',
  'bootStableOverride',
  'hostVersion',
  'dshHome',
  'observedHostVersion',
  'episodeSampleRate',
  'selfIteration',
  'concurrency',
  'desktopNotify',
  'embeddingModelDir',
  'embeddingThreads',
  'maintenance',
];

/** 新旧键双读别名表（新键优先 → 旧键兜底 → 缺省）。表为空 = 当前无历史键。 */
export const PLUGIN_CONFIG_ALIASES: Readonly<Record<string, string>> = {};

/** 配置面收敛结论（状态面可读：哪些键被忽略、哪些历史键兜底生效） */
export interface PluginConfigReport {
  /** 未知键（被忽略 + 已记降级；不是硬失败） */
  unknown_keys: string[];
  /** 通过别名兜底命中的键（新键缺失、旧键提供） */
  legacy_keys_used: string[];
  /** 认识的键里实际出现了哪些（配置面收缩的观测面） */
  known_keys_present: string[];
  note: string;
}

/**
 * 校验插件配置形状（**只读、永不抛**）：未知键忽略并上报，不因"宿主多传一个键"导致插件加载失败。
 * 这是"收敛配置面（插件自身能做的）"的实现：插件对 config 的容忍度必须是**宽进**的——
 * 宿主侧 schema 收紧/增删字段时，插件不应因此挂掉。
 */
export function auditPluginConfig(config: unknown): PluginConfigReport {
  if (config === null || config === undefined || typeof config !== 'object' || Array.isArray(config)) {
    return {
      unknown_keys: [],
      legacy_keys_used: [],
      known_keys_present: [],
      note: '配置为空/非对象 → 全部按缺省（插件对 config 形状宽进：不因宿主侧形态变化而失败）',
    };
  }
  const known = new Set(KNOWN_PLUGIN_CONFIG_KEYS);
  const present = Object.keys(config as Record<string, unknown>);
  const unknownKeys = present.filter((k) => !known.has(k));
  const legacyUsed: string[] = [];
  for (const [newKey, oldKey] of Object.entries(PLUGIN_CONFIG_ALIASES)) {
    const obj = config as Record<string, unknown>;
    if ((obj[newKey] === undefined || obj[newKey] === null) && obj[oldKey] !== undefined) {
      legacyUsed.push(`${newKey}←${oldKey}`);
    }
  }
  return {
    unknown_keys: unknownKeys,
    legacy_keys_used: legacyUsed,
    known_keys_present: present.filter((k) => known.has(k)),
    note:
      '未知键被忽略（记降级而非硬失败）：宿主侧多传/改名不应导致插件加载失败；' +
      '新键优先、旧键兜底（别名表为空 = 当前无历史键）。',
  };
}
