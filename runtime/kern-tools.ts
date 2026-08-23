// layer 2：组件↔DSH 工具注册桥（设计 §6 平台集成——ctx.tools.register 少量精炼工具，kern_* 命名，
// 工具数 <10；施工 P2：先落 kern_status 验证桥机制；kern_bench/kern_evolve/kern_switch/kern_memory
// 留清单按需注册，命名纪律见 registerKernTools）。
//
// 宿主契约（真实 DSH，不引包——结构最小接口 + 守卫）：
// - ToolSchema（packages/llm/llm/src/types.ts:333）：{ name, description, parameters }——模型可见面；
// - ToolDefinition（packages/core/tools/src/index.ts:222）：ToolSchema + output{schema,render,presentationMeta?}
//   + execute(args, exec)——output 缺失 → register TypeError（index.ts:1040-1044）；
// - register（packages/core/tools/src/index.ts:1037）：重复名 fail-loud（'already registered'）；返回注销 disposer；
// - restrict（packages/core/tools/src/index.ts:1071）：{ allow?, deny? } per-scope 掩码（需 scoped ctx；
//   空过滤/未知名/reserved 名 fail-loud）。kern_* 为只读状态查询，无 scope 掩码需求——本桥不使用 restrict，
//   接口留 ToolsLike.restrict 注释供后续 kern_* 权限面参考。
// 守卫：ctx.tools 缺失 / register 缺失 → 降级不崩（对齐插件既有守卫风格，recordDegradation 由调用方记录）。
// 零依赖：本模块无 import（纯结构接口 + 纯函数）。
//
// ---- dynamicCordisRunner 留注（P2 不实现；P3 沙盒联调关系已接线说明） ----
// 设计 §6：ctx.dynamicCordisRunner（cordis_define/run/stop/undefine）= 候选验证骨架——define 无副作用登记 /
// run 生效 / stop 回退（dispose）/ undefine 先停后忘（+ vm 协约 + fiber 生命周期）；试验单元与稳定单元
// 同一抽象（§4.5 混合路线：候选组件验证通过 → 晋升为 agent.cordis.yml 静态条目）。
// P3 关系（2026-08-23 已接线）：候选验证沙盒门禁 G3-exec（supervisor/candidate-pipeline.ts）把候选
// 附带的验证脚本（draft.verify.script → 候选验证目录 verify.cjs，白名单固定名）经 substrate/sandbox.ts
// 受限通道执行（CreateRestrictedToken + WRITE_RESTRICTED + 结果文件方案：宿主写脚本 → 受限进程执行 →
// 写结果文件 → 宿主读；受限孙进程无法用管道捕获输出，stdio:'pipe' spawn 在受限进程内 EPERM，
// research-dsh.md §3.4；通道不可用 → sandboxStatus degraded 降级 D5 不阻塞）。dynamicCordisRunner
// 提供「验证脚本内动态定义/运行/回退候选组件」的执行通道——仍不实现（留 P3 联调面：验证脚本经受限
// 通道运行时经本桥 define/run/stop/undefine 候选组件并回退）。本桥先以 kern_status 验证
// ctx.tools.register 契约（P2），dynamicCordisRunner 面待后续联调接入。

/** DSH 工具定义最小结构（真实类型 @deepseek-ai/dsh-tools ToolDefinition；宿主契约证据见文件头） */
export interface ToolDefinitionLike {
  name: string;
  description: string;
  /** JSON Schema 对象（参数面；模型可见） */
  parameters?: Record<string, unknown>;
  /** 规范输出契约（真实 register 强制 output.schema/render 存在——缺失 TypeError，index.ts:1040-1044） */
  output: {
    schema: Record<string, unknown>;
    render(args: unknown, value: unknown): unknown;
    presentationMeta?(args: unknown, value: unknown): unknown;
  };
  /** 执行体：返回 canonical JSON 值（output.schema 校验）；async 工作须观察/转发 exec.signal */
  execute(args: unknown, exec: unknown): Promise<unknown>;
}

/** DSH tools 服务最小结构（ctx.tools；register 真实返回注销 disposer） */
export interface ToolsLike {
  register(def: ToolDefinitionLike): unknown;
  /** restrict（index.ts:1071）：{ allow?, deny? } per-scope 掩码——kern_* 本桥不使用，留面参考 */
  restrict?(filter: { allow?: readonly string[]; deny?: readonly string[] }): unknown;
}

/**
 * kern_status 状态摘要（纯读取：从认知运行时现有字段组装；任一段降级 → 对应降级字段非空，不抛）。
 * 字段：当前版本线/快照哈希/lineSnapshot/维护债务快照/最近信号数/组件健康。
 */
export interface KernStatusSummary {
  /** 当前版本线（runtime.lineSnapshot?.line；缺省 stable） */
  line: string;
  /** 运行时快照哈希（rs:<16hex>；全降级 'rs:assembly'） */
  snapshot_hash: string;
  /** 已注入的线快照（lines 物化；未注入 → null） */
  line_snapshot: { line: string; commit: string; dir: string } | null;
  /** lines 按线加载降级原因（无 → null） */
  line_degraded: string | null;
  /** 维护债务快照（未注入 scheduler → 空数组） */
  debt: Array<{ task_id: string; value: number }>;
  /** 最近信号数（.evolution/signals 当日记录数；读取失败 → 0 + signals_degraded） */
  recent_signals: number;
  signals_degraded: string | null;
  /** 组件装配摘要（注册/激活（含 suspicious）/suspicious 清单 + 逐组件健康） */
  components: {
    registered: string[];
    active: string[];
    suspicious: string[];
    health: Array<{ manifest_id: string; ok: boolean; detail: string }>;
  };
  /** 运行时级降级（快照机制/组件装配失败；无 → null） */
  degraded: string | null;
}

/** kern_status 数据源（认知运行时最小结构面——仅 status()；结构最小接口，不引 runtime/assembly） */
export interface KernRuntimeLike {
  status?(): Promise<KernStatusSummary>;
}

/** kern_status 工具定义（无参数；execute 返回状态摘要——纯读取，不触发演化/写入） */
export function kernStatusTool(runtime: KernRuntimeLike): ToolDefinitionLike {
  return {
    name: 'kern_status',
    description: '认知运行时状态摘要（当前版本线/快照哈希/lineSnapshot/维护债务/最近信号数/组件健康）',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      presentationMeta: (_args, value) => value as Record<string, unknown>,
    },
    execute: async () => {
      if (typeof runtime.status !== 'function') {
        // 运行时未实现 status()（未装配/版本过旧）→ 降级返回（不抛——工具面保持可用）
        return { ok: false, degraded: '认知运行时未提供 status()（kern_status 数据源缺失）' };
      }
      return runtime.status();
    },
  };
}

/**
 * 注册 kern_* 工具集（P2 仅 kern_status——桥机制验证；工具数 <10 纪律）。
 * 命名清单（设计 §6，后续按需注册）：kern_status（本 P2）/ kern_bench（基准）/ kern_evolve（演化判定）/
 * kern_switch（版本线）/ kern_memory（记忆）——工具数 <10，kern_* 为领域标准词命名。
 * 守卫：tools.register 缺失/注册失败 → 降级不崩（返回 degraded 由调用方记录）。返回注册清单 + 注销 disposers
 * （真实 DSH register 返回 disposer；P8 注册皆效应——调用方把 disposers 注册进 ctx.effect，关闭时批量注销）。
 */
export function registerKernTools(tools: ToolsLike, runtime: KernRuntimeLike): {
  registered: string[];
  disposers: Array<() => void>;
  degraded: string | null;
} {
  if (typeof tools?.register !== 'function') {
    return { registered: [], disposers: [], degraded: 'ctx.tools.register 不存在——kern_* 工具未注册' };
  }
  const registered: string[] = [];
  const disposers: Array<() => void> = [];
  try {
    const disposer = tools.register(kernStatusTool(runtime));
    if (typeof disposer === 'function') {
      disposers.push(disposer as () => void);
    }
    registered.push('kern_status');
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { registered, disposers, degraded: `kern_status 注册失败（${detail}）` };
  }
  return { registered, disposers, degraded: null };
}
