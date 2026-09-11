// 宿主契约哨兵与配置面收敛测试（已知问题《非阻塞设计不足：插件**注册期**仍可能阻塞宿主》）：
//   ① 哨兵探测：逐项列出宿主面、方法缺失只降级该项、结论永不抛
//   ② 边界诚实：结论里必须写明"覆盖不了插件行解析失败"（那一层不归本仓库）
//   ③ 配置面宽进：未知键忽略并上报（不硬失败）、非对象 config 不炸、缺省键照常
//   ④ 插件入口永不抛：ctx 形状恶劣/服务读取抛错 → apply 返回降级句柄而不是异常
import { describe, expect, it } from 'vitest';
import {
  auditPluginConfig,
  HOST_CONTRACT,
  KNOWN_PLUGIN_CONFIG_KEYS,
  probeHostContract,
} from '../../runtime/host-contract.js';
import { apply, type ContextLike } from '../../runtime/plugin.js';

describe('① 宿主契约哨兵：逐项探测、只降级缺项', () => {
  it('清单本身自洽：每项都写清用途与缺失后果（不允许"说不清丢了会怎样"的依赖）', () => {
    expect(HOST_CONTRACT.length).toBeGreaterThan(0);
    for (const e of HOST_CONTRACT) {
      expect(e.service.length).toBeGreaterThan(0);
      expect(e.purpose.length).toBeGreaterThan(0);
      expect(e.onMissing.length).toBeGreaterThan(0);
      expect(e.via === 'get' || e.via === 'ctx').toBe(true);
    }
    // commands 是唯一必需项（其余缺失都能降级到"功能少一点但照常跑"）
    expect(HOST_CONTRACT.filter((e) => e.required).map((e) => e.service)).toEqual(['commands']);
  });

  it('全部就绪 → degraded 为空、required_ok=true', () => {
    const ctx: ContextLike = {
      get: ((name: string) =>
        name === 'commands'
          ? { register: () => {} }
          : name === 'tools'
            ? { register: () => {} }
            : name === 'systemPrompt'
              ? { context: () => {} }
              : name === 'llm'
                ? { stream: () => {} }
                : name === 'subagents'
                  ? { start: () => {} }
                  : name === 'dynamicCordisRunner'
                    ? {}
                    : name === 'desktopNotify'
                      ? { push: () => true }
                      : undefined) as ContextLike['get'],
      on: () => {},
      effect: () => {},
    };
    const r = probeHostContract(ctx);
    expect(r.degraded).toEqual([]);
    expect(r.required_ok).toBe(true);
  });

  it('方法形状变化（服务在但方法没了）→ 只降级该项，其余照常', () => {
    const ctx: ContextLike = {
      get: ((name: string) => (name === 'commands' ? { register: () => {} } : { present: true })) as ContextLike['get'],
      on: () => {},
      effect: () => {},
    };
    const r = probeHostContract(ctx);
    // systemPrompt 存在但没有 context → 该面降级（投影注入不可用），其余面不受影响
    const sp = r.probes.find((p) => p.service === 'systemPrompt')!;
    expect(sp.present).toBe(true);
    expect(sp.missing_methods).toEqual(['context']);
    expect(sp.degraded).toBe(true);
    expect(r.required_ok).toBe(true); // 必需项（commands）仍就绪
  });

  it('必需项缺失 → required_ok=false，但探测本身不抛（插件仍能加载）', () => {
    const ctx: ContextLike = { get: (() => undefined) as ContextLike['get'] };
    const r = probeHostContract(ctx);
    expect(r.required_ok).toBe(false);
    expect(r.degraded).toContain('commands');
    // 缺失后果可读（回答"少了它到底影响什么"）
    expect(r.probes.find((p) => p.service === 'commands')!.onMissing).toMatch(/命令面不可用/);
  });

  it('服务读取抛错（Guard 契约下未 inject 的属性读取会抛）→ 记为 read_error，不抛穿', () => {
    const ctx: ContextLike = {
      get: ((name: string) => {
        if (name === 'tools') {
          throw new Error('cannot get property "tools" without inject');
        }
        return name === 'commands' ? { register: () => {} } : undefined;
      }) as ContextLike['get'],
    };
    const r = probeHostContract(ctx);
    const tools = r.probes.find((p) => p.service === 'tools')!;
    expect(tools.present).toBe(false);
    expect(tools.read_error).toContain('without inject');
  });
});

describe('② 边界诚实：哨兵覆盖范围必须写明', () => {
  it('结论含 scope_note，且明确声明覆盖不了"插件行解析失败"', () => {
    const r = probeHostContract({ get: (() => undefined) as ContextLike['get'] });
    expect(r.scope_note).toMatch(/覆盖不了|不覆盖/);
    expect(r.scope_note).toMatch(/插件行|解析失败/);
  });
});

describe('③ 配置面收敛：宽进、未知键忽略并上报', () => {
  it('未知键被忽略并列出（不硬失败）', () => {
    const r = auditPluginConfig({ cognitiveRoot: 'x', brandNewHostKey: 1, anotherOne: 'y' });
    expect(r.unknown_keys).toEqual(['brandNewHostKey', 'anotherOne']);
    expect(r.known_keys_present).toEqual(['cognitiveRoot']);
    expect(r.note).toMatch(/忽略/);
  });

  it('非对象 config / 空 config → 全按缺省（不炸）', () => {
    for (const v of [undefined, null, 'string', 42, []]) {
      const r = auditPluginConfig(v);
      expect(r.unknown_keys).toEqual([]);
      expect(r.known_keys_present).toEqual([]);
      expect(r.note).toMatch(/缺省|宽进/);
    }
  });

  it('认识的键清单覆盖插件全部公开配置面（防"新增键忘了登记 → 被当成未知键"）', () => {
    // 与 PluginConfig 的公开键对齐（新增配置键时必须同步登记本清单）
    for (const key of [
      'cognitiveRoot',
      'model',
      'benchVersion',
      'selfIteration',
      'desktopNotify',
      'line',
      'episodeSampleRate',
      'concurrency',
      'embeddingModelDir',
      'embeddingThreads',
      'maintenance',
    ]) {
      expect(KNOWN_PLUGIN_CONFIG_KEYS).toContain(key);
    }
  });

  it('整份公开配置面交给审计 → 零未知键（登记与实际接线同步的可观测判据）', () => {
    // 比"清单里有没有某个键"更强的契约：清单登记了但 apply 不认识，宿主配了也白配，
    // 而且会被当成未知键记降级。这里把**全量**公开键喂给审计，未知键必须为空。
    const fullConfig = {
      cognitiveRoot: 'C:/tmp/omb',
      model: 'test-model',
      benchPersistDir: 'C:/tmp/bench',
      benchVersion: 'v2',
      activationLogDir: 'C:/tmp/act',
      bootstrap: false,
      line: 'stable',
      bootStableOverride: false,
      hostVersion: '0.0.0-test',
      dshHome: 'C:/tmp/dsh',
      observedHostVersion: '0.0.0-test',
      episodeSampleRate: 0.01,
      selfIteration: { enabled: false },
      concurrency: { maxConcurrentRequests: 1 },
      desktopNotify: false,
      embeddingModelDir: 'C:/tmp/models/bge-small-zh-v1.5',
      embeddingThreads: 1,
      maintenance: undefined,
    };
    const r = auditPluginConfig(fullConfig);
    expect(r.unknown_keys).toEqual([]);
    // 登记清单与喂进去的键一一对应（多登记 = 有键其实没人认；少登记 = 合法的键会被误报）
    expect([...r.known_keys_present].sort()).toEqual(Object.keys(fullConfig).sort());
  });
});

describe('④ 插件入口永不抛（注册期兜底）', () => {
  it('ctx 形状恶劣（get 抛错/commands 缺失）→ apply 返回降级句柄，不抛', () => {
    const ctx = {
      get: () => {
        throw new Error('host context guard exploded');
      },
    } as unknown as ContextLike;
    const handle = apply(ctx, { bootstrap: false });
    // 不抛即达标；返回句柄可用于排障（safeState 段说明原因）
    expect(handle).toBeDefined();
    expect(handle.cognitive).toBeUndefined();
  });

  it('config 形状恶劣（未知键/非预期类型）→ apply 不抛且未知键只记降级', () => {
    const registered: string[] = [];
    const ctx: ContextLike = { commands: { register: (d: unknown) => registered.push((d as { name: string }).name) } };
    const handle = apply(ctx, { bootstrap: false, someFutureKey: true } as never);
    expect(handle).toBeDefined();
    // 命令面照常注册（未知配置键不阻断加载）
    expect(registered).toContain('mode');
  });
});
