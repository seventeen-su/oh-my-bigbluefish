// layer 2：组件↔DSH 工具注册桥（设计 §6 平台集成——ctx.tools.register 少量精炼工具，kern_* 命名，
// 工具数 <10；施工 P2：先落 kern_status 验证桥机制；S5（2026-08-24）：补齐 kern_bench/kern_evolve/
// kern_switch/kern_memory 四工具——合计 5 个；W1（2026-08-25 未接线审计修复）：新增 kern_profile
// 画像写入工具——合计 6 个，全部为认知运行时方法（benchV2/runEvolutionNow/switchLine/retrieveMemory/
// upsertProfile）的薄封装，非命令 handler 复用；守卫与降级对齐 kern_status）。
//
// 宿主契约（真实 DSH，不引包——结构最小接口 + 守卫）：
// - ToolSchema（packages/llm/llm/src/types.ts:333）：{ name, description, parameters }——模型可见面；
// - ToolDefinition（packages/core/tools/src/index.ts:222）：ToolSchema + output{schema,render,presentationMeta?}
//   + execute(args, exec)——output 缺失 → register TypeError（index.ts:1040-1044）；
// - register（packages/core/tools/src/index.ts:1037）：重复名 fail-loud（'already registered'）；返回注销 disposer；
// - restrict（packages/core/tools/src/index.ts:1071）：{ allow?, deny? } per-scope 掩码（需 scoped ctx；
//   空过滤/未知名/reserved 名 fail-loud）。kern_* 为只读状态查询/显式触发，无 scope 掩码需求——本桥不使用 restrict，
//   接口留 ToolsLike.restrict 注释供后续 kern_* 权限面参考。
// 守卫：ctx.tools 缺失 / register 缺失 → 降级不崩（对齐插件既有守卫风格，recordDegradation 由调用方记录）。
// 零依赖：本模块无 import（纯结构接口 + 纯函数）。
//
// ---- dynamicCordisRunner 留注（S9 2026-08-24 已接线；P3 沙盒联调关系） ----
// 设计 §6：ctx.dynamicCordisRunner（cordis_define/run/stop/undefine）= 候选验证骨架——define 无副作用登记 /
// run 生效 / stop 回退（dispose）/ undefine 先停后忘（+ vm 协约 + fiber 生命周期）；试验单元与稳定单元
// 同一抽象（§4.5 混合路线：候选组件验证通过 → 晋升为 agent.cordis.yml 静态条目）。
// P3 关系（2026-08-23 接线）：候选验证沙盒门禁 G3-exec（supervisor/candidate-pipeline.ts）把候选
// 附带的验证脚本（draft.verify.script → 候选验证目录 verify.cjs，白名单固定名）经 substrate/sandbox.ts
// 受限通道执行（CreateRestrictedToken + WRITE_RESTRICTED + 结果文件方案：宿主写脚本 → 受限进程执行 →
// 写结果文件 → 宿主读；受限孙进程无法用管道捕获输出，stdio:'pipe' spawn 在受限进程内 EPERM，
// research-dsh.md §3.4；通道不可用 → sandboxStatus degraded 降级 D5 不阻塞）。
// S9（2026-08-24 已接线）：dynamicCordisRunner 经 supervisor/dynamic-runner.ts（结构最小接口
// DynamicCordisRunnerLike + inspectDynamicRunner 守卫 + runCandidateViaRunner 通道）接入 G3-exec——
// 宿主面存在且守卫通过 → 候选验证脚本作为 Cordis host 半包经 define（无副作用登记）→ run（生效，host-only
// 无人工审批往返）→ invoke verify（结果读取契约：harness.handle('verify', handler)）→ stop（回退 dispose）
// → undefine（先停后忘）执行；通道失败（define/run/invoke 抛错或拒绝）→ 降级回退受限子进程路径并记录
// （runnerFallback）。宿主面缺失 → 既有受限子进程路径零变化。真实宿主契约（define/run/stop/undefine/
// invoke 签名、vm 协约、fiber 生命周期）file:line 记录在 supervisor/dynamic-runner.ts 文件头注释。

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
 * 字段：当前版本线/快照哈希/lineSnapshot/维护债务快照/维护观测摘要/最近信号数/组件健康。
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
  /** 债务来源视图（来源子系统/原因/首见时间/orphan/manual_pending；调度器缺失 → null） */
  debt_sources: Array<{
    task_id: string;
    value: number;
    subsystem: string | null;
    reason: string;
    first_seen: number;
    last_failure: number;
    orphan: boolean;
    manual_pending: boolean;
    evolution_mutating: boolean;
  }> | null;
  /** 待人工裁决债务（无主且长期未对应到修复动作；**不做自动清除**——只列出给人看） */
  debt_pending_manual: Array<{
    task_id: string;
    value: number;
    reason: string;
    manual_pending: boolean;
  }>;
  /** 债务释放审计（本次进程内已执行；跨进程历史在 .evolution/debt-releases.jsonl） */
  debt_release_audit: Array<{
    ts: number;
    task_id: string;
    value: number;
    subsystem: string | null;
    evidence: string;
    released_by: string;
    reason: string;
  }>;
  /** 生效债务阈值与档位（soft/hard/critical/total/band/batch_size；调度器缺失 → null） */
  debt_limits: {
    soft: number;
    hard: number;
    critical: number;
    total: number;
    band: 'normal' | 'soft' | 'hard' | 'critical';
    batch_size: number;
  } | null;
  /** S2：维护观测摘要（今日任务数 + 各任务平均耗时；调度器缺失/读取失败 → null + observations_degraded） */
  maintenance_observations: {
    date: string;
    total: number;
    per_task: Array<{ task_id: string; count: number; avg_duration_ms: number }>;
  } | null;
  /** S2：维护观测摘要降级原因（无观测/调度器缺失 → null） */
  observations_degraded: string | null;
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

/** S5：kern_bench 结果（runtime.benchV2 返回——v2 契约基准摘要；失败 ok:false + detail） */
export interface BenchV2ToolResultLike {
  ok: boolean;
  line: string;
  mode: 'real' | 'replay';
  passed: number;
  total: number;
  judge_enabled: boolean;
  judge_run: number;
  judge_degraded: number;
  judge_rate: number;
  persisted: boolean;
  /** 失败原因（ok:false 时非空） */
  detail?: string;
  /** P4：bench 契约适配层摘要行（如「验证契约：PASS 20/20」；无 → 摘要文本不附加） */
  verification_text?: string;
}

/** S5：kern_evolve 结果（runtime.runEvolutionNow 返回——与 plugin.ts CognitiveRuntimeLike.runEvolutionNow 同构） */
export interface EvolutionNowResultLike {
  decision: {
    should_evolve: boolean;
    strength: number;
    object_layer: string;
    budget_estimate: number;
    triggers: unknown[];
    reason: string;
  };
  enqueued: string[];
  candidates?: Array<{
    candidate_id: string;
    validated: boolean;
    promoted: boolean;
    reason?: string;
  }>;
  promoted?: { candidate_id: string; object_id: string; commit_hash: string } | null;
  promotion?: {
    checked: boolean;
    skipped_reason: string | null;
    gate_ok: boolean;
    reasons: string[];
    promoted: boolean;
    stable_commit?: string;
    activation_id?: string;
    error?: string;
    warning?: string;
  };
  quantum: { ran: string[]; skipped: string[] };
  debt: unknown[];
  degraded: string | null;
  events_appended: number;
}

/** S5：kern_switch 结果（runtime.switchLine 返回——切换执行摘要） */
export interface SwitchLineToolResultLike {
  ok: boolean;
  text: string;
  previous_line: string;
  line: string;
  /** 快照是否已重建（false = 切换状态生效但快照保持——降级见 degraded） */
  rebuilt: boolean;
  degraded: string | null;
  /** 激活记录事件入链数（尽力而为） */
  events_appended: number;
}

/** S5：kern_memory 单条检索摘要（id/kind/scope/value/snippet） */
export interface MemoryEntryLike {
  id: string;
  kind: string;
  scope: string;
  prov_class: string;
  updated: string;
  value: number;
  snippet: string;
}

/** S5：kern_memory 结果（runtime.retrieveMemory 返回——retrieve 路由摘要；失败 ok:false + degraded） */
export interface MemoryRetrievalToolResultLike {
  ok: boolean;
  items: MemoryEntryLike[];
  channel_used: string;
  scope_chain: string[];
  degraded: string | null;
}

/** W1：kern_profile 结果（runtime.upsertProfile 返回——画像写入摘要；失败 → degraded 非空不抛） */
export interface ProfileUpsertToolResultLike {
  id: string;
  kind: 'Profile';
  scope: string;
  created: boolean;
  updated: boolean;
  degraded: string | null;
}

/** kern_* 数据源（认知运行时最小结构面——仅方法签名；结构最小接口，不引 runtime/assembly） */
export interface KernRuntimeLike {
  status?(): Promise<KernStatusSummary>;
  /** S5：kern_bench 数据源——v2 契约基准（复用 /bench v2 分支同款 runBenchV2 接线；input 可选——运行时缺省当前线） */
  benchV2?(input?: { line?: string; persist?: boolean }): Promise<BenchV2ToolResultLike>;
  /** S5：kern_evolve 数据源——演化全链（判定+候选管线+晋升检查+维护量子） */
  runEvolutionNow?(input: { session_id: string }): Promise<EvolutionNowResultLike>;
  /** S5：kern_switch 数据源——版本线切换（校验+快照重建+激活记录；无 /mode 空白会话守卫） */
  switchLine?(input: { line: string; session_id?: string }): Promise<SwitchLineToolResultLike>;
  /** S5：kern_memory 数据源——记忆检索查询（retrieve 路由；只读；input 可选——缺省 Project/5 条） */
  retrieveMemory?(input?: {
    text?: string;
    scope?: string;
    kind?: string;
    limit?: number;
    relation?: string;
  }): Promise<MemoryRetrievalToolResultLike>;
  /** W1：kern_profile 数据源——画像写入（Profile 记忆 Global 作用域；upsert 语义——存在更新/缺省合并） */
  upsertProfile?(input: { profile: string; replace?: boolean }): Promise<ProfileUpsertToolResultLike>;
}

/** 从 DSH execute exec 上下文读取会话 id（结构最小面；缺失 → undefined） */
function sessionIdFromExec(exec: unknown): string | undefined {
  const session = (exec as { agent?: { session?: { id?: unknown } } } | undefined)?.agent?.session;
  return typeof session?.id === 'string' ? session.id : undefined;
}

/** kern_status 工具定义（无参数；execute 返回状态摘要——纯读取，不触发演化/写入） */
export function kernStatusTool(runtime: KernRuntimeLike): ToolDefinitionLike {
  return {
    name: 'kern_status',
    description: '认知运行时状态摘要（当前版本线/快照哈希/lineSnapshot/维护债务/维护观测摘要/最近信号数/组件健康）',
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
 * S5：kern_bench 工具定义——执行 v2 契约基准（回放或真实，复用 /bench v2 分支的 runBenchV2 接线：
 * 无 modelAdapter → 回放执行器；有 → 真实执行 + LLM judge 对照）。参数 line 缺省当前线；
 * 返回摘要文本（通过数/模式/judge 对照）。execute 返回 {ok, text} 风格（对齐 kern_status 降级语义）。
 */
export function kernBenchTool(runtime: KernRuntimeLike): ToolDefinitionLike {
  return {
    name: 'kern_bench',
    description: '运行 v2 契约基准（回放或真实——复用 /bench 的 runBenchV2 接线：无 DSH 会话 → 回放，有 → 真实执行+LLM judge 对照）',
    parameters: {
      type: 'object',
      properties: {
        line: { type: 'string', description: '目标版本线（缺省当前线；initial|stable|latest）' },
        persist: { type: 'boolean', description: '是否落盘基准明细 JSONL（缺省 true）' },
      },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      presentationMeta: (_args, value) => value as Record<string, unknown>,
    },
    execute: async (args) => {
      if (typeof runtime.benchV2 !== 'function') {
        return { ok: false, text: '认知运行时未提供 benchV2()（kern_bench 数据源缺失）' };
      }
      const a = (args ?? {}) as { line?: unknown; persist?: unknown };
      // 参数守卫（工具面）：类型/取值非法 → 明确文本，不触发基准
      if (a.line !== undefined && typeof a.line !== 'string') {
        return { ok: false, text: 'kern_bench 参数非法：line 必须为字符串（initial|stable|latest）' };
      }
      if (typeof a.line === 'string' && a.line.length > 0 && !['initial', 'stable', 'latest'].includes(a.line)) {
        // 合法值列表与 substrate/snapshot.ts VALID_LINES 同源（本模块零依赖——不 import，注释对齐）
        return { ok: false, text: `kern_bench 参数非法：未知版本线 "${a.line}"（合法值 initial | stable | latest）` };
      }
      const r = await runtime.benchV2({ line: a.line as string | undefined, persist: a.persist !== false });
      if (!r.ok) {
        return { ok: false, text: r.detail ?? '基准运行失败（未知原因）' };
      }
      const mode = r.mode === 'real' ? '真实执行（LLM judge 对照）' : '回放执行（无 DSH 会话，降级）';
      const judgeText = r.judge_enabled
        ? `；judge 对照（D6 全任务双判，仅旁证）：${r.judge_run}/${r.judge_run + r.judge_degraded} 判词（降级 ${r.judge_degraded}，双判一致率 ${(r.judge_rate * 100).toFixed(1)}%）`
        : '；judge 对照：未启用（回放模式无 LLM judge）';
      // P4：bench 契约适配层摘要行（同一套验证契约语义覆盖 bench；无 → 不附加）
      const verificationText = r.verification_text !== undefined ? `；${r.verification_text}` : '';
      return {
        ok: true,
        line: r.line,
        mode: r.mode,
        passed: r.passed,
        total: r.total,
        verification_text: r.verification_text,
        text: `v2 契约基准完成：${r.line} ${r.passed}/${r.total} 通过（${r.total} 任务，${mode}${judgeText}${verificationText}${r.persisted ? '；明细已落盘 workspace/.omb/bench' : ''}）`,
      };
    },
  };
}

/**
 * S5：kern_evolve 工具定义——触发演化全链（runtime.runEvolutionNow：信号判定 → 候选生成/验证/晋升 →
 * 晋升检查 → 维护量子），返回摘要文本（判定/入队/候选/晋升/quantum/debt）。模型显式调用 = 显式意图
 * （与 /evolve now 命令同运行时方法，非命令 handler 复用）。execute 返回 {ok, text} 风格。
 */
export function kernEvolveTool(runtime: KernRuntimeLike): ToolDefinitionLike {
  return {
    name: 'kern_evolve',
    description: '触发演化全链（runEvolutionNow：信号判定 → 候选生成/验证/晋升 → 晋升检查 → 维护量子）——返回判定/候选/晋升/quantum 摘要',
    parameters: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: '事件归属会话 id（缺省从执行上下文读取，再缺省 anon）' },
      },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      presentationMeta: (_args, value) => value as Record<string, unknown>,
    },
    execute: async (args, exec) => {
      if (typeof runtime.runEvolutionNow !== 'function') {
        return { ok: false, text: '认知运行时未提供 runEvolutionNow()（kern_evolve 数据源缺失）' };
      }
      const a = (args ?? {}) as { session_id?: unknown };
      if (a.session_id !== undefined && typeof a.session_id !== 'string') {
        return { ok: false, text: 'kern_evolve 参数非法：session_id 必须为字符串' };
      }
      const sessionId = a.session_id ?? sessionIdFromExec(exec) ?? 'anon';
      const r = await runtime.runEvolutionNow({ session_id: sessionId });
      const debtText =
        (r.debt as Array<{ task_id?: string; value?: unknown }>)
          .map((x) => `${String(x?.task_id ?? '?')}=${String(x?.value ?? '?')}`)
          .join(', ') || '（空）';
      const lines = [
        `演化判定：should_evolve=${String(r.decision.should_evolve)}（strength ${r.decision.strength}，object_layer ${String(r.decision.object_layer)}，budget_estimate ${r.decision.budget_estimate}，${r.decision.reason}）`,
        `入队维护任务：[${r.enqueued.join(', ') || '无'}]`,
        `quantum 执行：ran=[${r.quantum.ran.join(', ') || '无'}]，skipped=[${r.quantum.skipped.join(', ') || '无'}]`,
        `维护债务快照：${debtText}`,
        `事件入链：${r.events_appended}（evolution/candidate + evolution/promoted + activation/committed + maintenance/quantum）`,
      ];
      const candidates = r.candidates ?? [];
      if (candidates.length > 0) {
        lines.push(
          `候选管线：生成 ${candidates.length} 个候选 → ${candidates
            .map((c) => {
              const verdict = c.validated === true ? 'G1+G3 通过' : c.reason !== undefined ? c.reason : '未验证';
              return `${String(c.candidate_id).slice(0, 16)}…(${verdict})${c.promoted === true ? '→晋升' : ''}`;
            })
            .join('，')}`,
        );
      }
      if (r.promoted !== null && r.promoted !== undefined) {
        lines.push(
          `晋升：candidate=${String(r.promoted.candidate_id).slice(0, 16)}… object=${String(r.promoted.object_id).slice(0, 16)}… commit=${String(r.promoted.commit_hash).slice(0, 12)}…`,
        );
      }
      const promo = r.promotion;
      if (promo !== undefined) {
        if (!promo.checked) {
          lines.push(`晋升检查：跳过（${promo.skipped_reason ?? '未知原因'}）`);
        } else if (promo.promoted) {
          lines.push(
            `晋升检查：门禁通过（${promo.reasons.length} 条信号）→ 已晋升 stable=${String(promo.stable_commit ?? '').slice(0, 12)}…（activation=${String(promo.activation_id ?? '').slice(0, 20)}…${promo.warning !== undefined ? `；告警：${promo.warning}` : ''}）`,
          );
        } else if (!promo.gate_ok) {
          lines.push(`晋升检查：门禁未通过——候选保持 trusted-latest（${(promo.reasons ?? []).slice(0, 3).join('；')}）`);
        } else if (promo.error !== undefined) {
          lines.push(`晋升检查：失败（${promo.error}）`);
        }
      }
      if (r.degraded !== null && r.degraded !== undefined) {
        lines.push(`降级：${r.degraded}`);
      }
      return { ok: true, text: lines.join('\n') };
    },
  };
}

/**
 * S5：kern_switch 工具定义——切换版本线（initial|stable|latest）。与 /mode 同语义（校验 + 快照重建 +
 * 激活记录）但**无空白会话守卫**：/mode 由用户在会话开始前手动执行（空白会话才允许切换——mode-command.ts
 * isBlankSession），而工具由模型在运行中显式调用 = 显式意图，DSH 会话必然非空白 → 不适用该守卫
 * （差异在 execute 文本与返回结构注明）。execute 返回 {ok, text} 风格。
 */
export function kernSwitchTool(runtime: KernRuntimeLike): ToolDefinitionLike {
  return {
    name: 'kern_switch',
    description: '切换版本线（initial|stable|latest）——与 /mode 同语义（校验+快照重建+激活记录）但无空白会话守卫（工具由模型显式调用=显式意图）',
    parameters: {
      type: 'object',
      properties: {
        line: { type: 'string', description: '目标版本线（必填：initial|stable|latest）' },
        session_id: { type: 'string', description: '激活记录归属会话 id（缺省从执行上下文读取，再缺省 anon）' },
      },
      required: ['line'],
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      presentationMeta: (_args, value) => value as Record<string, unknown>,
    },
    execute: async (args, exec) => {
      if (typeof runtime.switchLine !== 'function') {
        return { ok: false, text: '认知运行时未提供 switchLine()（kern_switch 数据源缺失）' };
      }
      const a = (args ?? {}) as { line?: unknown; session_id?: unknown };
      if (typeof a.line !== 'string' || a.line.length === 0) {
        return { ok: false, text: 'kern_switch 参数非法：line 必填（initial|stable|latest）' };
      }
      const sessionId = typeof a.session_id === 'string' ? a.session_id : sessionIdFromExec(exec);
      const r = await runtime.switchLine({ line: a.line, session_id: sessionId });
      return {
        ok: r.ok,
        text: r.text,
        line: r.line,
        previous_line: r.previous_line,
        rebuilt: r.rebuilt,
        degraded: r.degraded,
        events_appended: r.events_appended,
      };
    },
  };
}

/**
 * S5：kern_memory 工具定义——记忆检索查询（复用运行时 retrieve 路由：scope 覆盖链/kind 过滤/通道选择/
 * 价值排序；只读——不记录 Retrieval Episode）。参数 query/scope/kind/limit/relation；
 * 返回条目摘要（id/kind/scope/value/snippet）。execute 返回 {ok, text} 风格。
 */
export function kernMemoryTool(runtime: KernRuntimeLike): ToolDefinitionLike {
  return {
    name: 'kern_memory',
    description: '记忆检索查询（retrieve 路由：scope 覆盖链/kind 过滤/通道选择/价值排序）——返回条目摘要（id/kind/scope/value/snippet）',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索文本（FTS 命中）' },
        scope: { type: 'string', enum: ['Session', 'Project', 'Global'], description: '检索范围（缺省 Project；覆盖链 Session→Project→Global）' },
        kind: { type: 'string', enum: ['Semantic', 'Episodic', 'Procedural', 'Profile', 'Constraint', 'Decision'], description: '记忆类型过滤（可选）' },
        limit: { type: 'integer', minimum: 0, description: '返回条数上限（缺省 5）' },
        relation: { type: 'string', description: '关系类型遍历（可选；relation 通道）' },
      },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      presentationMeta: (_args, value) => value as Record<string, unknown>,
    },
    execute: async (args) => {
      if (typeof runtime.retrieveMemory !== 'function') {
        return { ok: false, text: '认知运行时未提供 retrieveMemory()（kern_memory 数据源缺失）' };
      }
      const a = (args ?? {}) as Record<string, unknown>;
      // 参数守卫（工具面）：类型非法 → 明确文本；枚举取值由运行时 MemoryQuerySchema fail-loud 兜底
      for (const key of ['query', 'scope', 'kind', 'relation'] as const) {
        if (a[key] !== undefined && typeof a[key] !== 'string') {
          return { ok: false, text: `kern_memory 参数非法：${key} 必须为字符串` };
        }
      }
      if (a.limit !== undefined && typeof a.limit !== 'number') {
        return { ok: false, text: 'kern_memory 参数非法：limit 必须为数字' };
      }
      const query = typeof a.query === 'string' && a.query.length > 0 ? a.query : undefined;
      const r = await runtime.retrieveMemory({
        text: query,
        scope: typeof a.scope === 'string' ? a.scope : undefined,
        kind: typeof a.kind === 'string' ? a.kind : undefined,
        limit: typeof a.limit === 'number' ? a.limit : undefined,
        relation: typeof a.relation === 'string' && a.relation.length > 0 ? a.relation : undefined,
      });
      if (!r.ok) {
        return { ok: false, text: `记忆检索失败：${r.degraded ?? '未知原因'}` };
      }
      const header = `记忆检索（channel=${r.channel_used}，scope_chain=${r.scope_chain.join('→') || '（空）'}）：${r.items.length} 条`;
      const body =
        r.items.length === 0
          ? ['无匹配记忆']
          : r.items.map(
              (it, i) => `#${i + 1} [${it.kind}/${it.scope}] value=${it.value.toFixed(2)} ${it.id.slice(0, 12)}… ${it.snippet}`,
            );
      return { ok: true, text: [header, ...body].join('\n') };
    },
  };
}

/**
 * W1（未接线审计修复 2026-08-25）：kern_profile 工具定义——登记/更新用户画像。画像 = 单条 Profile
 * 记忆（确定性 id 'profile:user'，Global 作用域跨项目可检索）；存在 → 更新 payload（replace=true
 * 覆写 / 缺省合并追加去重）；不存在 → 新建。画像读取面（kern_memory kind=Profile scope=Global）与
 * 写入面（kern_profile）由此闭合。execute 返回 {ok, text} 风格（降级语义对齐 kern_*）。
 */
export function kernProfileTool(runtime: KernRuntimeLike): ToolDefinitionLike {
  return {
    name: 'kern_profile',
    description: '登记/更新用户画像（Profile 记忆，Global 作用域——跨项目可检索；kern_memory kind=Profile scope=Global 读取）',
    parameters: {
      type: 'object',
      properties: {
        profile: { type: 'string', description: '画像文本（自由格式——用户身份/偏好/背景/约束等）' },
        replace: { type: 'boolean', description: 'true=覆写既有画像；缺省 false=合并追加（新内容未包含于既有画像时追加）' },
      },
      required: ['profile'],
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      presentationMeta: (_args, value) => value as Record<string, unknown>,
    },
    execute: async (args) => {
      if (typeof runtime.upsertProfile !== 'function') {
        return { ok: false, text: '认知运行时未提供 upsertProfile()（kern_profile 数据源缺失）' };
      }
      const a = (args ?? {}) as { profile?: unknown; replace?: unknown };
      if (typeof a.profile !== 'string') {
        return { ok: false, text: 'kern_profile 参数非法：profile 必填且必须为字符串' };
      }
      if (a.replace !== undefined && typeof a.replace !== 'boolean') {
        return { ok: false, text: 'kern_profile 参数非法：replace 必须为布尔值' };
      }
      const r = await runtime.upsertProfile({ profile: a.profile, replace: a.replace === true });
      if (r.degraded !== null) {
        return {
          ok: false,
          text: `用户画像写入失败：${r.degraded}`,
          id: r.id,
          kind: r.kind,
          scope: r.scope,
          created: r.created,
          updated: r.updated,
          degraded: r.degraded,
        };
      }
      const op = r.created ? '已创建' : '已更新';
      return {
        ok: true,
        text: `用户画像${op}：id=${r.id}（kind=${r.kind}/scope=${r.scope}${r.updated ? '——payload 已写入' : ''}）`,
        id: r.id,
        kind: r.kind,
        scope: r.scope,
        created: r.created,
        updated: r.updated,
        degraded: null,
      };
    },
  };
}

/**
 * 注册 kern_* 工具集（S5：5 个——kern_status/kern_bench/kern_evolve/kern_switch/kern_memory；
 * W1（2026-08-25）：新增 kern_profile 画像写入——合计 6 个；工具数 <10 纪律，设计 §6 命名清单齐备）。
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
  const defs: ToolDefinitionLike[] = [
    kernStatusTool(runtime),
    kernBenchTool(runtime),
    kernEvolveTool(runtime),
    kernSwitchTool(runtime),
    kernMemoryTool(runtime),
    kernProfileTool(runtime),
  ];
  const registered: string[] = [];
  const disposers: Array<() => void> = [];
  for (const def of defs) {
    try {
      const disposer = tools.register(def);
      if (typeof disposer === 'function') {
        disposers.push(disposer as () => void);
      }
      registered.push(def.name);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return { registered, disposers, degraded: `${def.name} 注册失败（${detail}）` };
    }
  }
  return { registered, disposers, degraded: null };
}
