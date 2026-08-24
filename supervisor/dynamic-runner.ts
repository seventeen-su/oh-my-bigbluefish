// layer 1（S9，2026-08-24）：dynamicCordisRunner 结构最小接口 + 守卫 + 候选验证 runner 通道。
// 设计（微内核 §4.5 混合路线试验形态 + §3.4 验证层受限子进程关系 + kern-tools.ts 留注）：
//   - 试验形态：同一组件经 define（无副作用登记）→ run（生效）→ stop（回退并 dispose）→ undefine（先停后忘）
//     动态定义/运行/回退；候选验证通过后晋升为静态条目。本模块是候选验证的 runner 执行通道：
//     G3-exec（supervisor/candidate-pipeline.ts）在宿主面存在时经此通道动态定义/运行候选验证脚本并回滚；
//     宿主面缺失/通道失败 → 降级回退受限子进程路径（substrate/sandbox.ts runRestricted），既有行为不变。
//
// 宿主契约（真实 DSH，不引包——结构最小接口 + 守卫；来源 D:\Program\deepseek-harness\packages\
// extensions\cordis-host-runner\src\，动态插件宿主半 = 候选验证执行通道）：
//   - 服务键 ctx.dynamicCordisRunner = DynamicCordisRunnerService（index.ts:83 类型声明 / index.ts:124 类；
//     inject: ['tools'] index.ts:125；服务包缺省导出，define/undefine 形状不跨 wire——本接口结构最小化）。
//   - define(request): DynamicCordisDefineReceipt（index.ts:151）——**同步**、无副作用登记：语法预检
//     host/client 两半（index.ts:159-160）→ 新插件铸 pluginId（idPrefix 须 ^[a-z]{3,6}$，index.ts:165）
//     → registry 内存登记（registry.ts:176 add / :193 packages.set）→ 返回回执；不运行任何代码。
//     request { sessionId, plugin: {kind:'new', idPrefix}|{kind:'existing', pluginId}, name, purpose,
//     code: {host?, client?} }（registry.ts:85-98）；receipt { pluginId, packageId, name, purpose,
//     hasHostHalf, hasClientHalf }（registry.ts:101-108）。
//   - run(agent, pluginId, packageId, mode, signal?): Promise<DynamicCordisRunResponse>（index.ts:248）——
//     agent.id 必须等于插件 sessionId（owned 校验 index.ts:775）；mode 'run'|'update'（types.ts:91）；
//     **host-only 包（无 clientCode）直接激活、无人工审批往返**（审批仅面向 clientCode 包，
//     index.ts:270-275 直接 activate）；响应 {ok, status:'running'|'awaiting-approval'|'starting',
//     pluginId, packageId, pluginRunId, waitingFor, ...}（types.ts:267-301）。
//   - stop(agent, pluginId): Promise<{ok:true}|{ok:false,reason,message}>（index.ts:456）——回退一次
//     存活下发：handler 丢弃 + host 半 fiber dispose（retract，index.ts:1219-1230）→ 定义保持可运行
//     （README：'leaves the definition runnable'）。
//   - undefine(agent, pluginId): Promise<{ok:true,wasRunning}|{ok:false,reason,message}>（index.ts:210）——
//     先停（cancelPending + retract，index.ts:213-215）后忘（registry.delete index.ts:216）。
//   - invoke(pluginId, pluginRunId, method, args): Promise<DynamicCordisInvokeResult>（index.ts:740-766）
//     ——结果读取通道：host 半经 harness.handle(method, handler) 注册（sandbox.ts:33 HOST_BUILTIN_INSPECTION
//     harness.handle 签名）；未注册 → {ok:false, code:'method-not-found'}。
//   - vm 协约（sandbox.ts:1-12）：host 半在 node:vm 新 realm 求值，vmTimeoutMs 缺省 5000
//     （index.ts:127-129 static Config）；globals = ctx（受限 get/on/provide/effect）、
//     harness（handle/defineTool/registerTool）、console（tagged 写穿）、btoa/atob/TextEncoder/TextDecoder；
//     require/timers/fetch 陷阱抛重定向错误、process undefined（sandbox.ts:96-108）；协作式沙箱非隔离
//     （sandbox.ts:6 'is not containment'）。
//   - fiber 生命周期（lifecycle.ts:22-45）：host 半在 cordis-dynamic 组 fiber 下作为子 fiber 启动
//     （await group.await() → plugin → fiber.await() 失败即 dispose，失败 fiber 不留挂载）；stop =
//     awaited fiber.dispose()——插件注册的一切都是 fiber 上的效应，dispose 全量回退。
//
// 通道契约（候选验证脚本 = host 半）：
//   - 结果读取契约：脚本必须经 harness.handle('verify', (args) => ({ok, detail})) 注册裁决——invoke 读取。
//   - host-only（不写 code.client）→ run 无人工审批往返（审批仅面向 clientCode 包），候选验证可无人值守。
//   - 通道失败（define/run/invoke 抛错或拒绝、守卫不可用）→ 调用方（G3-exec）降级回退受限子进程路径并记录；
//     verdict.ok=false（脚本报告失败）≠ 通道失败——脚本已执行并给出裁决，按受限路径同语义拒绝候选。
//   - 真实宿主面缺失 → 测试全部走 fake runner 注入（本模块零依赖、纯结构接口 + 纯函数）。
//
// 零依赖：无 import（不引包——结构最小接口 + 守卫；宿主类型以注释 file:line 为准）。

/** 候选验证结果读取契约方法名（host 半须 harness.handle('verify', handler) 注册裁决） */
export const RUNNER_VERIFY_METHOD = 'verify';

/** 候选验证插件 idPrefix（宿主约束 ^[a-z]{3,6}$，index.ts:165；registry mint 唯一后缀） */
export const RUNNER_PLUGIN_ID_PREFIX = 'ombvfy';

/** define 请求最小结构（宿主 DynamicCordisDefineRequest，registry.ts:85-98） */
export interface DynamicCordisDefineLike {
  /** 会话归属（插件 owner；run/stop/undefine 的 agent.id 必须等于它） */
  sessionId: string;
  /** 新插件（铸 pluginId）或附加到既有插件 */
  plugin:
    | { kind: 'new'; idPrefix: string }
    | { kind: 'existing'; pluginId: string };
  /** 包标签（非空） */
  name: string;
  /** 面向使用者的用途说明（非空） */
  purpose: string;
  /** 至少一个代码半；host-only（无 client）→ run 无人工审批往返 */
  code: { host?: string; client?: string };
}

/** define 回执最小结构（宿主 DynamicCordisDefineReceipt，registry.ts:101-108；define 为同步） */
export interface DynamicCordisDefineReceiptLike {
  pluginId: string;
  packageId: string;
  name: string;
  purpose: string;
  hasHostHalf: boolean;
  hasClientHalf: boolean;
}

/** run 响应最小结构（宿主 DynamicCordisRunResponse，types.ts:267-301；host-only 成功 → status 'running'） */
export type DynamicCordisRunResponseLike =
  | {
    ok: true;
    status: string;
    pluginId: string;
    packageId: string;
    pluginRunId: string;
    waitingFor?: readonly string[];
    currentPackageId?: string;
    nextPackageId?: string;
    mode?: string;
  }
  | { ok: false; reason?: string; message?: string };

/** stop 响应最小结构（宿主 DynamicCordisStopResponse，types.ts:304-306） */
export type DynamicCordisStopResponseLike =
  | { ok: true }
  | { ok: false; reason?: 'plugin-missing' | 'not-running' | string; message?: string };

/** undefine 响应最小结构（宿主 DynamicCordisUndefineReceipt，types.ts:250-252） */
export type DynamicCordisUndefineReceiptLike =
  | { ok: true; wasRunning: boolean }
  | { ok: false; reason?: string; message?: string };

/** invoke 响应最小结构（宿主 DynamicCordisInvokeResult，types.ts:356-358；结果读取通道） */
export type DynamicCordisInvokeResultLike =
  | { ok: true; value: unknown }
  | { ok: false; code?: string; message?: string };

/**
 * ctx.dynamicCordisRunner 结构最小面（宿主 DynamicCordisRunnerService，index.ts:124）。
 * 全部方法可选——守卫（inspectDynamicRunner）对缺失/部分缺失判通道不可用 → 调用方降级。
 * run/stop/undefine 的 agent 参数最小为 { id }（宿主 owned 校验 = plugin.sessionId === agent.id）。
 */
export interface DynamicCordisRunnerLike {
  /** 无副作用登记（同步或 async 均可——宿主为同步，index.ts:151；通道 await 兼容两者） */
  define?(def: DynamicCordisDefineLike): DynamicCordisDefineReceiptLike | Promise<DynamicCordisDefineReceiptLike>;
  /** 生效（host-only 包直接激活；signal 可选——取消激活请求创建） */
  run?(
    agent: { id: string },
    pluginId: string,
    packageId: string,
    mode: 'run' | 'update',
    signal?: AbortSignal,
  ): Promise<DynamicCordisRunResponseLike>;
  /** 回退（stop 回退 dispose，定义保持可运行） */
  stop?(agent: { id: string }, pluginId: string): Promise<DynamicCordisStopResponseLike>;
  /** 先停后忘（移除插件与全部包；running 时先 retract） */
  undefine?(agent: { id: string }, pluginId: string): Promise<DynamicCordisUndefineReceiptLike>;
  /** 结果读取（host 半 harness.handle('verify') 注册的裁决） */
  invoke?(pluginId: string, pluginRunId: string, method: string, args: unknown): Promise<DynamicCordisInvokeResultLike>;
}

/** 守卫结果（available=false → 调用方降级回退受限子进程路径） */
export interface DynamicRunnerGuard {
  available: boolean;
  /** 不可用原因（机器可读；点名缺失的方法） */
  reason?: string;
}

/**
 * 守卫：dynamicCordisRunner 缺失 / 部分缺失（define/run/stop/undefine 任一非函数）→ 通道不可用；
 * invoke（结果读取通道）缺失 → 通道不可用（候选验证需要读取裁决）。绝不抛。
 */
export function inspectDynamicRunner(runner: DynamicCordisRunnerLike | undefined | null): DynamicRunnerGuard {
  if (runner === undefined || runner === null) {
    return { available: false, reason: 'dynamicCordisRunner 缺失（宿主未提供）' };
  }
  const required = ['define', 'run', 'stop', 'undefine'] as const;
  const missing = required.filter((m) => typeof runner[m] !== 'function');
  if (missing.length > 0) {
    return { available: false, reason: `dynamicCordisRunner 部分缺失（${missing.join(', ')} 非函数）——降级受限子进程路径` };
  }
  if (typeof runner.invoke !== 'function') {
    return { available: false, reason: 'dynamicCordisRunner 缺少 invoke（结果读取通道缺失）——降级受限子进程路径' };
  }
  return { available: true };
}

/** 候选验证 runner 通道选项 */
export interface RunnerChannelOptions {
  /** 注入的宿主面（已通过守卫） */
  runner: DynamicCordisRunnerLike;
  /** 会话归属（define.sessionId = agent.id 契约） */
  sessionId: string;
  /** 包标签（非空） */
  name: string;
  /** 面向使用者的用途说明（非空） */
  purpose: string;
  /** 候选验证脚本（host 半 body；须 harness.handle('verify', handler) 注册裁决） */
  script: string;
  /** 可选取消信号（宿主 run 的 signal 参数：取消激活请求创建） */
  signal?: AbortSignal;
}

/** 候选验证 runner 通道结果 */
export interface RunnerChannelOutcome {
  /** 通道是否完整执行（define→run→invoke→stop→undefine 无通道失败）；
   *  true 时 verdict 为脚本裁决（ok=false = 脚本报告失败，非通道失败） */
  ok: boolean;
  /** 脚本裁决（invoke 读取；通道失败 → undefined） */
  verdict?: { ok: boolean; detail: string };
  pluginId?: string;
  packageId?: string;
  pluginRunId?: string;
  /** 回滚记录：stop 是否成功（{ok:true} 或 'not-running' 幂等视为已停；抛错 → false） */
  stopped: boolean;
  /** 回滚记录：undefine 是否成功（{ok:true} 或 'plugin-missing' 幂等视为已忘；抛错 → false） */
  undefined: boolean;
  /** 通道失败原因（ok=false 时非空；机器可读） */
  reason?: string;
}

/** 回滚 best-effort：stop（回退 dispose）+ undefine（先停后忘）；幂等语义（not-running/plugin-missing = 成功） */
async function rollbackRunner(
  runner: DynamicCordisRunnerLike,
  agent: { id: string },
  pluginId: string,
): Promise<{ stopped: boolean; undefined: boolean }> {
  let stopped = false;
  try {
    const s = await runner.stop?.(agent, pluginId);
    stopped = s?.ok === true || s?.reason === 'not-running';
  } catch {
    // best-effort：stop 失败不阻断 undefine
  }
  let undef = false;
  try {
    const u = await runner.undefine?.(agent, pluginId);
    undef = u?.ok === true || u?.reason === 'plugin-missing';
  } catch {
    // best-effort：undefine 失败记录 undefined=false（调用方记入降级文本）
  }
  return { stopped, undefined: undef };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 候选验证 runner 通道（S9）：define（无副作用登记，host-only）→ run（生效，无人工审批）→
 * invoke（结果读取：host 半 harness.handle('verify') 契约）→ stop（回退 dispose）→ undefine（先停后忘）。
 * 任一步通道失败 → 回滚（best-effort stop/undefine）+ ok=false（调用方降级回退受限子进程路径并记录）。
 * verdict.ok=false（脚本报告失败）≠ 通道失败——通道已完整执行，裁决交给门禁按受限路径同语义拒绝。
 */
export async function runCandidateViaRunner(opts: RunnerChannelOptions): Promise<RunnerChannelOutcome> {
  const { runner, sessionId } = opts;
  const agent = { id: sessionId };

  // 1. define（无副作用登记；host-only——不写 client → run 无人工审批往返）
  let receipt: DynamicCordisDefineReceiptLike;
  try {
    receipt = await runner.define!({
      sessionId,
      plugin: { kind: 'new', idPrefix: RUNNER_PLUGIN_ID_PREFIX },
      name: opts.name,
      purpose: opts.purpose,
      code: { host: opts.script },
    });
  } catch (err) {
    return { ok: false, stopped: false, undefined: false, reason: `define 失败（${errorText(err)}）` };
  }
  const pluginId = receipt?.pluginId;
  const packageId = receipt?.packageId;
  if (typeof pluginId !== 'string' || typeof packageId !== 'string') {
    return { ok: false, stopped: false, undefined: false, reason: 'define 回执缺少 pluginId/packageId（宿主契约异常）' };
  }

  // 2. run（生效；host-only 直接激活）
  let runResp: DynamicCordisRunResponseLike;
  try {
    runResp = await runner.run!(agent, pluginId, packageId, 'run', opts.signal);
  } catch (err) {
    const rollback = await rollbackRunner(runner, agent, pluginId);
    return { ok: false, ...rollback, pluginId, packageId, reason: `run 抛错（${errorText(err)}）` };
  }
  if (runResp?.ok !== true) {
    const rollback = await rollbackRunner(runner, agent, pluginId);
    return {
      ok: false,
      ...rollback,
      pluginId,
      packageId,
      reason: `run 拒绝（${runResp?.reason ?? '?'}: ${runResp?.message ?? '未知'}）`,
    };
  }
  const pluginRunId = runResp.pluginRunId;
  if (typeof pluginRunId !== 'string') {
    const rollback = await rollbackRunner(runner, agent, pluginId);
    return { ok: false, ...rollback, pluginId, packageId, reason: 'run 响应缺少 pluginRunId（宿主契约异常）' };
  }

  // 3. invoke 结果读取（结果读取契约：host 半 harness.handle('verify', handler)）
  let inv: DynamicCordisInvokeResultLike;
  try {
    inv = await runner.invoke!(pluginId, pluginRunId, RUNNER_VERIFY_METHOD, null);
  } catch (err) {
    const rollback = await rollbackRunner(runner, agent, pluginId);
    return {
      ok: false,
      ...rollback,
      pluginId,
      packageId,
      pluginRunId,
      reason: `结果读取失败（invoke ${RUNNER_VERIFY_METHOD} 抛错：${errorText(err)}）`,
    };
  }
  if (inv?.ok !== true) {
    const rollback = await rollbackRunner(runner, agent, pluginId);
    return {
      ok: false,
      ...rollback,
      pluginId,
      packageId,
      pluginRunId,
      reason: `结果读取失败（invoke ${RUNNER_VERIFY_METHOD} 返回 ${inv?.code ?? '?'}：${inv?.message ?? '未知'}——验证脚本未注册 verify handler？）`,
    };
  }
  const raw = inv.value as { ok?: unknown; detail?: unknown } | null | undefined;
  const verdict = {
    ok: raw?.ok === true,
    detail: typeof raw?.detail === 'string' ? raw.detail : '',
  };

  // 4. stop（回退 dispose）+ 5. undefine（先停后忘）——通道正常收尾回滚
  const rollback = await rollbackRunner(runner, agent, pluginId);
  return { ok: true, verdict, pluginId, packageId, pluginRunId, ...rollback };
}
