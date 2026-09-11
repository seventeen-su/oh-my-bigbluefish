// 通知面**接线**验证（不是桥的单测——桥自身的语义在 notify.test.ts）。
//
// 为什么需要这层测试：通知的触发点散布在事件钩子与命令里，桥的 19 个单测只能证明"桥做对了语义"，
// 证明不了"生产路径真的调了桥"。本文件从**装配结果**往外看：`ApplyResult.notifyAudit()` 暴露实时
// 通知审计，于是每条接线都能断言——触发条件 → 桥收到对应 kind → 未发原因可读。
//
// 驱动方式：不用 mock 认知运行时，而是走两条真实入口——
//   ① 命令面：`/mode` 切换（快照重建失败 → line-switch-degraded）；
//   ② 钩子面：`systemPrompt.context` 的投影求值（内部 kick 共享预热链 prepareForTurn，
//      维护状态检查就挂在这条链上 → maintenance-scheduler-error / verification-debt-manual）。
//
// 覆盖：版本线切换降级 / 调度器故障 / 待人工裁决债务（基线不误报 + 增量才报）/ 两条"不该发"的边界。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apply, type ApplyResult, type ContextLike } from '../../runtime/plugin.js';
import { MaintenanceScheduler } from '../../supervisor/maintenance.js';
import type { NotifyAttempt, NotifyItem } from '../../runtime/notify.js';
import { clearDegradations } from '../../runtime/loop-hooks.js';

const SESSION = 'sess-notify-wiring';

/** 捕获宿主推送面的调用（模拟 dsh-desktop-notify 服务） */
interface FakeNotifyService {
  push(item: NotifyItem): boolean;
  pushAlways(item: NotifyItem): boolean;
  pushed: NotifyItem[];
  always: NotifyItem[];
}

function makeNotifyService(): FakeNotifyService {
  const svc: FakeNotifyService = {
    pushed: [],
    always: [],
    push(item) {
      svc.pushed.push(item);
      return true;
    },
    pushAlways(item) {
      svc.always.push(item);
      return true;
    },
  };
  return svc;
}

/** systemPrompt.context 注册项（我们需要拿到求值函数并真的调它，才能驱动钩子链） */
interface ContextProvider {
  name: string;
  order?: number;
  text: string | ((ctx: unknown) => string);
}

/** apply 结果里的认知运行时（类型面只声明插件用到的那部分，这里按需取维护面） */
interface RuntimeHandle {
  close?(): Promise<void>;
  maintenance?: { requestQuantum(): Promise<unknown>; enqueue(input: Record<string, unknown>, opts?: { accrueDebt?: boolean }): Promise<void> };
}

interface FakeCtxParts {
  ctx: ContextLike;
  commands: Array<{ name: string; handler: (inv: unknown) => Promise<{ kind: string; text: string }> }>;
  providers: ContextProvider[];
}

function makeFakeCtx(opts: { notify?: FakeNotifyService | null } = {}): FakeCtxParts {
  const commands: FakeCtxParts['commands'] = [];
  const providers: ContextProvider[] = [];
  const notify = opts.notify === undefined ? makeNotifyService() : opts.notify;
  // 服务面按**属性**提供（不是 ctx.get）：plugin 的 readService 只在无 ctx.get 时读属性
  //（反之优先 get）——fakeCtx 声明了 get 就会把属性面挡掉，正是此前"通知面没接上"的原因。
  const ctx = {
    commands: {
      register: (def: unknown) => {
        const d = def as { name: string; handler: (inv: unknown) => Promise<{ kind: string; text: string }> };
        commands.push({ name: d.name, handler: d.handler });
      },
    },
    systemPrompt: { context: (p: unknown) => providers.push(p as ContextProvider) },
    desktopNotify: notify,
  } as unknown as ContextLike;
  return { ctx, commands, providers };
}

function attemptsOf(handle: ApplyResult, kind: NotifyAttempt['kind']): NotifyAttempt[] {
  return (handle.notifyAudit?.() ?? []).filter((a) => a.kind === kind);
}

function sentOf(handle: ApplyResult, kind: NotifyAttempt['kind']): NotifyAttempt[] {
  return attemptsOf(handle, kind).filter((a) => a.sent);
}

/** 触发一次投影求值（= 内部 kick 预热链 prepareForTurn，维护状态检查挂在链上） */
function kickProjection(parts: FakeCtxParts): void {
  const p = parts.providers.find((x) => x.name === 'cognitive:projection');
  expect(p).toBeDefined();
  const text = p!.text;
  if (typeof text === 'function') {
    text({ agent: { session: { id: SESSION, events: [] } } });
  }
}

let base: string;
let cognitiveRoot: string;
/** 本用例装配出的运行时（afterEach 必须 close——SQLite 连接占着临时目录会让 rm 报 EBUSY） */
let handles: ApplyResult[];

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'omb-notify-wiring-'));
  cognitiveRoot = join(base, '.omb');
  await mkdir(cognitiveRoot, { recursive: true });
  handles = [];
  clearDegradations();
});

afterEach(async () => {
  for (const h of handles.splice(0)) {
    await (h.cognitive as unknown as RuntimeHandle | undefined)?.close?.();
  }
  await rm(base, { recursive: true, force: true });
});

/** 装配并把句柄登记进用例清理清单。
 *  `bootStableOverride` 是必需的：真实 bootStable 需要三线布局，而本文件刻意用临时数据根
 *  （才能制造"调度器故障/无主债务"这类数据面条件）。R2 boot gate 只关心"启动校验是否可用"，
 *  这里如实声明"可用"——替换的是与断言无关的布局依赖，不是绕过被测逻辑。 */
function applyTracked(ctx: ContextLike, config: Record<string, unknown>): ApplyResult {
  const handle = apply(ctx, {
    bootstrap: false,
    bootStableOverride: async () => ({ ok: true, line: 'stable', warnings: [] }),
    ...config,
  } as never);
  handles.push(handle);
  return handle;
}

describe('① 接线：触发条件真的到达桥', () => {
  it('维护队列文件损坏 → maintenance-scheduler-error（urgency=critical，说清去哪儿核对）', async () => {
    const svc = makeNotifyService();
    const { ctx, providers } = makeFakeCtx({ notify: svc });
    // queue.json 写成非法 JSON：调度器加载队列时必然记 scheduler_error（"债务视图不可信"的典型场景）
    await mkdir(join(cognitiveRoot, '.evolution'), { recursive: true });
    await writeFile(join(cognitiveRoot, '.evolution', 'queue.json'), '{ 这不是 JSON', 'utf8');

    const handle = applyTracked(ctx, { cognitiveRoot });
    expect(handle.safeState?.ok).toBe(true); // 调度器故障是降级而非崩溃
    expect(providers.some((p) => p.name === 'cognitive:projection')).toBe(true);

    // 维护状态检查挂在预热链上 → 触发一次投影求值，等异步检查跑完
    kickProjection({ ctx, commands: [], providers });
    await vi.waitFor(() => expect(sentOf(handle, 'maintenance-scheduler-error').length).toBeGreaterThanOrEqual(1), {
      timeout: 5000,
      interval: 10,
    });

    const sent = sentOf(handle, 'maintenance-scheduler-error')[0]!;
    expect(sent.always).toBe(false); // 不是 pushAlways：紧急但不需绕过聚焦门控
    const item = svc.pushed.at(-1)!;
    expect(item.urgency).toBe('critical');
  }, 20_000);

  it('版本线切换但快照未重建 → line-switch-degraded（pushAlways，点明"仍在旧线跑"）', async () => {
    // 边界（诚实说明为什么这条**不**做端到端）：`/mode` 的 `loadVersion(line)` 内建走
    // `<preset>/versions.git`（真实运行环境），装配根参数改不了它。要在集成层制造"切换成功但
    // 物化失败"，只能破坏真实仓库的线引用——测试不该这么干。故这里退一步：
    //   - 触发条件与降级结论的端到端已由 `line-snapshot.test.ts`（/mode 切换但物化失败 → degraded）
    //     覆盖（用的是隔离 fixture 的 runtime）；
    //   - 通知**文案与门控**由 `notify.test.ts` 覆盖；
    //   - 本用例只钉住"这两个面之间确实接上了"——即生产代码里该降级分支确实调了桥。
    // 这样写比一条依赖环境的红色/静默通过都更可信：它断言的是接线事实，不是环境事实。
    const src = readFileSync(fileURLToPath(new URL('../../runtime/plugin.ts', import.meta.url)), 'utf8');
    const onSwitch = src.slice(src.indexOf("name: 'mode'"));
    expect(onSwitch).toMatch(/notifyLineSwitchDegraded\(line, r\.degraded/);
    expect(onSwitch).toMatch(/notifyLineSwitchDegraded\(line, `快照重建异常/);
  }, 20_000);

  it('待人工裁决债务：首读只做基线不误报，数量增长才提醒', async () => {
    const svc = makeNotifyService();
    const { ctx, providers } = makeFakeCtx({ notify: svc });
    // 可控时钟注入调度器：`manual_pending` 的判据含"无主满一周"的老化语义，
    // 用真实时钟无法在测试里制造 → 注入 nowFn 让条目"当场变老"。
    // 这是本用例唯一被替换的量；通知链本身（钩子 → 桥）走的是生产代码。
    let clock = Date.now();
    const scheduler = new MaintenanceScheduler({
      debtFile: join(cognitiveRoot, '.evolution', 'debt.json'),
      now: () => clock,
    });

    const handle = applyTracked(ctx, { cognitiveRoot, maintenance: scheduler });
    const parts: FakeCtxParts = { ctx, commands: [], providers };
    const rt = handle.cognitive as unknown as RuntimeHandle;

    // 先入一条无主债务并让它"老过一周"→ 成为待人工裁决条目
    await rt.maintenance!.enqueue(
      { id: 'orphan_task_without_owner', value: 9, urgency: 'soft', reason: '长年无来源的债务' },
      { accrueDebt: true },
    );
    clock += 8 * 24 * 60 * 60 * 1000; // 推进 8 天

    // 第一次求值：首读即基线——启动时把历史遗留当成"刚发生"是误报，故不发
    kickProjection(parts);
    await new Promise((r) => setTimeout(r, 200));
    expect(sentOf(handle, 'verification-debt-manual')).toEqual([]);

    // 再入一条无主债务并同样老化 → 待裁决数量增长 → 该提醒（"有结论需要人来下"）
    await rt.maintenance!.enqueue(
      { id: 'second_orphan_without_owner', value: 3, urgency: 'soft', reason: '又一条无来源债务' },
      { accrueDebt: true },
    );
    clock += 8 * 24 * 60 * 60 * 1000;

    kickProjection(parts);
    await vi.waitFor(() => expect(sentOf(handle, 'verification-debt-manual').length).toBeGreaterThanOrEqual(1), {
      timeout: 5000,
      interval: 10,
    });
    const item = svc.pushed.at(-1)!;
    expect(`${item.title}${item.message}`).toMatch(/裁决|人工|UNKNOWN/);
  }, 30_000);
});

describe('② 不该发的边界：默认沉默', () => {
  it('宿主未装通知服务 → 不存在"已发送"记录，且不崩', async () => {
    const { ctx } = makeFakeCtx({ notify: null });
    await mkdir(join(cognitiveRoot, '.evolution'), { recursive: true });
    await writeFile(join(cognitiveRoot, '.evolution', 'queue.json'), 'broken json', 'utf8');
    const handle = applyTracked(ctx, { cognitiveRoot });
    const all = handle.notifyAudit?.() ?? [];
    expect(all.every((a) => !a.sent)).toBe(true);
    // 未装服务是"没装插件"，不是故障——审计里应为 no-service 而不是记成错误
    expect(all.every((a) => a.skipped === undefined || a.skipped === 'no-service')).toBe(true);
  }, 20_000);

  it('config.desktopNotify=false → 一条都不发（显式全关）', async () => {
    const svc = makeNotifyService();
    const { ctx, providers } = makeFakeCtx({ notify: svc });
    await mkdir(join(cognitiveRoot, '.evolution'), { recursive: true });
    await writeFile(join(cognitiveRoot, '.evolution', 'queue.json'), 'broken json', 'utf8');
    const handle = applyTracked(ctx, { cognitiveRoot, desktopNotify: false });

    kickProjection({ ctx, commands: [], providers });
    await new Promise((r) => setTimeout(r, 200)); // 给异步检查足够时间尝试发送

    for (const a of handle.notifyAudit?.() ?? []) {
      expect(a.sent).toBe(false);
      // desktopNotify:false 在构造期就返回 null 服务 → 桥看到的是 no-service（等价于显式全关）
      if (a.skipped !== undefined) expect(['disabled', 'no-service']).toContain(a.skipped);
    }
    expect(svc.pushed).toEqual([]);
    expect(svc.always).toEqual([]);
  }, 20_000);
});

describe('③ 白名单每一档都必须真的会响（防"登记了却永远不发"）', () => {
  it('宿主面缺项 → capability-degraded（能力面变少，与组件健康是两个不同的面）', async () => {
    // 这条用例的由来：`capability-degraded` 曾在白名单与方法表里都有、单测也覆盖，
    // 但**生产代码零调用点**——一个永远不会响的通知档。此类"登记了却永远不发"只能靠
    // "从装配结果往外看"的接线测试发现（桥自身的单测证明不了谁调了它）。
    const svc = makeNotifyService();
    // fakeCtx 只提供 commands/systemPrompt/desktopNotify → 其余宿主面必然缺项
    const { ctx } = makeFakeCtx({ notify: svc });
    const handle = applyTracked(ctx, { cognitiveRoot });

    const sent = sentOf(handle, 'capability-degraded');
    expect(sent.length).toBeGreaterThanOrEqual(1);
    expect(sent[0]!.always).toBe(false); // 普通通知：不绕过宿主聚焦门控
    const item = svc.pushed.find((p) => p.title.includes('能力'))!;
    expect(item).toBeDefined();
    // 文案要说清"少了什么"（服务名 + 缺它的后果），而不是笼统一句"出错"
    expect(item.message).toMatch(/宿主面缺项/);
    expect(item.message).toMatch(/tools|llm|subagents|systemPrompt/);
  }, 20_000);

  it('宿主面全部就绪 → 不发 capability-degraded（不误报）', async () => {
    const svc = makeNotifyService();
    const providers: ContextProvider[] = [];
    // 提供一个"九面齐全"的 ctx（方法形状与 HOST_CONTRACT 的最低要求一致）
    const full = {
      commands: { register: () => undefined },
      tools: { register: () => undefined },
      systemPrompt: { context: (p: unknown) => providers.push(p as ContextProvider) },
      on: () => undefined,
      effect: () => undefined,
      llm: { stream: () => undefined },
      subagents: { start: () => undefined },
      dynamicCordisRunner: {},
      desktopNotify: svc,
    } as unknown as ContextLike;
    const handle = applyTracked(full, { cognitiveRoot });
    expect(sentOf(handle, 'capability-degraded')).toEqual([]);
  }, 20_000);
});
