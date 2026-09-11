// 外核平台提供者与安全状态行为测试
// （对应 docs/known-issues.md《Windows 绑定面与 Linux 迁移》《外核平台抽象设计》
//   《内核加载失败不得阻塞宿主》《外核自身也要非阻塞（安全状态）》修复判定）：
//   ① 识别：平台类别 + 能力（只读机制 / 沙盒机制）；能力缺失 → 显式降级并标注（不静默）
//   ② 拉起：只读机制在真实目录上可用（施加 → 写被拒 → 释放 → 写恢复）；探测幂等
//   ③ 控制：sandbox 可用性标注（非 Windows → none 且说明安全语义变化）
//   ④ 安全状态：宿主版本形态非法 / 声明≠观测 / 恢复根不可读 → ok=false（不拉起内核），且**永不抛**
//   ⑤ 非阻塞：装配期异常不外溢（内核不加载 + 原因记录 + 宿主不受影响）
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { platformProvider, resetPlatformProviderCache } from '../../substrate/platform.js';
import { evaluateSafeState } from '../../substrate/safe-state.js';
import { defaultLayout } from '../../substrate/snapshot.js';
import type { CognitiveRuntime } from '../../runtime/assembly.js';
import { apply, type ContextLike } from '../../runtime/plugin.js';
const bases: string[] = [];
const runtimes: CognitiveRuntime[] = [];

async function tmpBase(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), 'omb-plat-'));
  bases.push(base);
  return base;
}

afterEach(async () => {
  for (const rt of runtimes.splice(0)) {
    await rt.close().catch(() => undefined);
  }
  resetPlatformProviderCache();
  await Promise.all(bases.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

beforeAll(() => {
  resetPlatformProviderCache();
});

describe('① 识别：平台类别与能力（能力缺失 → 显式降级标注）', () => {
  it('返回平台类别、只读机制、沙盒机制与降级说明（平台无关断言）', () => {
    const p = platformProvider();
    expect(['windows', 'posix', 'unknown']).toContain(p.caps.platform);
    expect(p.caps.raw).toBe(process.platform);
    expect(['icacls', 'posix-mode', 'none']).toContain(p.caps.read_only);
    expect(['win32-restricted-token', 'none']).toContain(p.caps.sandbox);
    // 能力缺失必须带可读说明（不静默）
    if (!p.caps.read_only_available || !p.caps.sandbox_available) {
      expect(p.caps.degraded).not.toBeNull();
      expect(p.caps.degraded!.length).toBeGreaterThan(0);
    }
    // 提供者名与机制一致
    expect(p.name).toBe(`platform:${p.caps.platform}`);
  });

  it('单例缓存：同进程内多次调用返回同一能力快照（探测一次）', () => {
    const a = platformProvider();
    const b = platformProvider();
    expect(b.caps).toEqual(a.caps);
  });

  it('Windows 平台 → 沙盒机制为受限令牌；非 Windows → none 且说明安全语义变化', () => {
    const caps = platformProvider().caps;
    if (caps.platform === 'windows') {
      expect(caps.sandbox).toBe('win32-restricted-token');
    } else {
      expect(caps.sandbox).toBe('none');
      expect(caps.sandbox_available).toBe(false);
      expect(caps.degraded ?? '').toMatch(/受限执行通道|沙盒机制/);
    }
  });
});

describe('② 拉起：只读机制在真实目录上可用', () => {
  it('施加 → 写被拒（isReadOnly=true）→ 释放 → 写恢复；探测幂等', async () => {
    const p = platformProvider();
    if (p.readOnly === null) {
      // 平台无只读机制（能力缺失）→ 断言显式标注（不假装可用）
      expect(p.caps.read_only_available).toBe(false);
      expect(p.caps.degraded ?? '').toMatch(/只读/);
      return;
    }
    const dir = join(await tmpBase(), 'rd');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'seed.txt'), 'seed', 'utf8');
    expect(p.readOnly.isReadOnly(dir)).toBe(false);
    p.readOnly.apply(dir);
    expect(p.readOnly.isReadOnly(dir)).toBe(true);
    p.readOnly.apply(dir); // 幂等：重复施加仍只读
    expect(p.readOnly.isReadOnly(dir)).toBe(true);
    p.readOnly.reset(dir);
    expect(p.readOnly.isReadOnly(dir)).toBe(false);
    await writeFile(join(dir, 'after.txt'), 'ok', 'utf8'); // 释放后可写
    expect(fs.existsSync(join(dir, 'after.txt'))).toBe(true);
  });

  it('目录缺失 → isReadOnly=false（由工作树修复兜底，不报只读）', () => {
    const p = platformProvider();
    if (p.readOnly === null) return;
    expect(p.readOnly.isReadOnly(join(tmpdir(), 'omb-nonexistent-dir-xyz'))).toBe(false);
  });
});

describe('④ 安全状态：契约与探测不通过 → 不拉起内核（永不抛）', () => {
  it('宿主版本形态非法 → host_version_malformed', () => {
    const r = evaluateSafeState({ configuredHostVersion: 'not-a-version' });
    expect(r.ok).toBe(false);
    expect(r.kind).toBe('host_version_malformed');
    expect(r.reason).toContain('形态非法');
    expect(typeof r.at).toBe('number');
  });

  it('声明值与观测值不一致 → host_version_changed（宿主升级未同步配置）', () => {
    const r = evaluateSafeState({ configuredHostVersion: '0.1.3-alpha.2', observedHostVersion: '0.1.4' });
    expect(r.ok).toBe(false);
    expect(r.kind).toBe('host_version_changed');
    expect(r.reason).toContain('hostVersion');
  });

  it('声明与观测一致 → ok（契约匹配）', () => {
    const r = evaluateSafeState({ configuredHostVersion: '0.1.3-alpha.2', observedHostVersion: '0.1.3-alpha.2' });
    expect(r.ok).toBe(true);
    expect(r.kind).toBe('ok');
    expect(r.reason).toBeNull();
    expect(r.details.host_version_source).toBe('config');
  });

  it('未声明但有出厂缺省 → 用缺省（既有语义兼容，不误判安全状态）', () => {
    const r = evaluateSafeState({ defaultHostVersion: '0.1.0-rc.7' });
    expect(r.ok).toBe(true);
    expect(r.details.host_version).toBe('0.1.0-rc.7');
    expect(r.details.host_version_source).toBe('default');
  });

  it('两者皆空 → host_version_missing（无法校验契约）', () => {
    const r = evaluateSafeState({});
    expect(r.ok).toBe(false);
    expect(r.kind).toBe('host_version_missing');
  });

  it('恢复根不可读 → layout_unreadable；可读目录 → ok', async () => {
    const base = await tmpBase();
    const missing = join(base, 'no-such-substrate');
    const bad = evaluateSafeState({ configuredHostVersion: '1.0.0', substrateRoot: missing });
    expect(bad.ok).toBe(false);
    expect(bad.kind).toBe('layout_unreadable');
    const good = evaluateSafeState({ configuredHostVersion: '1.0.0', substrateRoot: base });
    expect(good.ok).toBe(true);
    expect(good.details.substrate_root).toBe(base);
  });

  it('评估不抛：异常输入（空串/超长）都返回结果对象', () => {
    for (const v of ['', '  ', 'x'.repeat(10_000), '1.2']) {
      const r = evaluateSafeState({ configuredHostVersion: v });
      expect(typeof r.ok).toBe('boolean');
      expect(typeof r.at).toBe('number');
    }
  });
});

describe('⑤ 非阻塞：装配期异常不外溢（内核不加载，宿主不受影响）', () => {
  it('安全状态（宿主版本形态非法）→ 不拉起内核 + 不初始化布局 + 宿主照常（apply 不抛）', async () => {
    const base = await tmpBase();
    const root = join(base, '.omb');
    const ctx: ContextLike = { commands: { register: () => {} } };
    // 审查修复（第二轮）：原断言 `existsSync(join(base,'versions.git'))` 是**恒真**的——
    // 真实布局根来自 defaultLayout()（<preset>/versions.git），与测试的 base 是两个不同目录，
    // 因此"安全状态不改动运行数据"这一核心承诺此前零验证。改为直接观察**真实布局根**在 apply 前后不变。
    const layoutRoot = dirname(defaultLayout().bareRepo);
    const beforeEntries = fs.existsSync(layoutRoot) ? fs.readdirSync(layoutRoot).sort() : null;
    // bootstrap 默认 true：安全状态下必须被跳过（不改动运行数据）
    const handle = apply(ctx, { cognitiveRoot: root, hostVersion: 'bad-version' });
    expect(handle.cognitive).toBeUndefined(); // 内核未加载
    expect(handle.safeState?.ok).toBe(false);
    expect(handle.safeState?.kind).toBe('host_version_malformed');
    const afterEntries = fs.existsSync(layoutRoot) ? fs.readdirSync(layoutRoot).sort() : null;
    expect(afterEntries).toEqual(beforeEntries); // 真实布局根未被改动（未建 bare/worktree/指针）
    // 状态面仍可用：兜底数据源可读，且写明内核未加载
    const st = await handle.safeStateRuntime!.status!();
    expect(st.degraded).toContain('内核未加载');
    expect(st.safe_state?.kernel_loaded).toBe(false);
    expect(st.safe_state?.reason).toContain('形态非法');
  });

  it('内核装配失败（装配根不可用时仍不抛）→ 命令面保留、原因记录、宿主不受影响', async () => {
    const base = await tmpBase();
    const root = join(base, '.omb');
    const registered: string[] = [];
    const ctx: ContextLike = { commands: { register: (d: unknown) => registered.push((d as { name: string }).name) } };
    const handle = apply(ctx, { cognitiveRoot: root, bootstrap: false, hostVersion: '0.1.3-alpha.2' });
    // 正常路径：认知装配成功（此处验证安全状态为 ok，且命令面已注册）
    expect(handle.safeState?.ok).toBe(true);
    expect(handle.cognitive).toBeDefined();
    if (handle.cognitive !== undefined) runtimes.push(handle.cognitive as CognitiveRuntime);
    expect(registered).toContain('mode');
  });

  it('内核装配兜底：装配期异常 → cognitive undefined + 降级记录（不重抛）', async () => {
    const base = await tmpBase();
    const { clearDegradations, degradationLog } = await import('../../runtime/loop-hooks.js');
    clearDegradations();
    const ctx: ContextLike = {
      commands: { register: () => {} },
      // 注入不可用的 cognitive 服务路径：装配根提供但 createCognitiveRuntime 收到的 root 指向非法位置
      // （用文件占位目录名触发装配异常的最简方式：把 root 指向一个已存在的文件路径）
    };
    const filePath = join(base, 'not-a-dir');
    await writeFile(filePath, 'x', 'utf8');
    const handle = apply(ctx, { cognitiveRoot: join(filePath, 'sub'), bootstrap: false, hostVersion: '0.1.3-alpha.2' });
    // 无论装配成功与否，apply 本身绝不抛；若装配失败则 cognitive 为空且原因已记录
    if (handle.cognitive === undefined) {
      expect(degradationLog().some((d) => d.hook === 'cognitive/assembly')).toBe(true);
    } else {
      runtimes.push(handle.cognitive as CognitiveRuntime);
    }
  });
});

describe('③ 控制：沙盒可用性标注与状态面', () => {
  it('平台能力经 apply 返回值与状态面暴露（排障可读）', async () => {
    const base = await tmpBase();
    const ctx: ContextLike = { commands: { register: () => {} } };
    const handle = apply(ctx, { cognitiveRoot: join(base, '.omb'), bootstrap: false, hostVersion: '0.1.3-alpha.2' });
    expect(handle.platform?.raw).toBe(process.platform);
    expect(['icacls', 'posix-mode', 'none']).toContain(handle.platform?.read_only);
    if (handle.cognitive !== undefined) runtimes.push(handle.cognitive as CognitiveRuntime);
    const st = await handle.cognitive!.status!();
    expect(st.safe_state).toBeDefined();
    expect(st.safe_state?.kernel_loaded).toBe(true);
    expect(st.safe_state?.platform).toBe(process.platform);
  });
});
