// R6：dsh_version 唯一宿主版本来源（防漂移）测试。
// 背景（评估第十六节）：多个 Event/Experience provenance 硬编码 dsh_version（'0.8.0'/'0.1.0'/
// '0.1.1-rc.1' 混用）而正式环境已 0.1.1-rc.1——污染 Provenance/Environment Fingerprint/
// Capability Decay/Evolution comparison。修复：唯一来源 kernel/schemas/host-version.ts
//（DSH_HOST_VERSION='0.1.0-rc.7' 缺省 + hostVersion()/setHostVersion() 注入）+ 装配注入面
//（PluginConfig.hostVersion → createCognitiveRuntime({ hostVersion })）。
// 覆盖：
//   ① 唯一来源语义：缺省 = DSH_HOST_VERSION；setHostVersion 覆写；非法值 fail-loud；复位
//   ② 防漂移 grep：生产代码（kernel/supervisor/runtime/memory/substrate）无旧 dsh_version 字面量
//   ③ 运行时指纹与事件 provenance 恒等于 hostVersion()（装配注入后）：createCognitiveRuntime({hostVersion})
//     → collectEnvironmentFingerprint / 运行时事件（session/start、decision/made）/ makeDshEvent /
//     makePromptVisibilityEvent / createSnapshot 全部同一值
//   ④ plugin.ts 装配注入面：apply({ hostVersion }) → 装配运行时事件 provenance 使用注入值
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DSH_HOST_VERSION, hostVersion, setHostVersion } from '../../kernel/schemas/host-version.js';
import { collectEnvironmentFingerprint } from '../../kernel/environment-fingerprint.js';
import { createCognitiveRuntime } from '../../runtime/assembly.js';
import { makeDshEvent } from '../../runtime/loop-hooks.js';
import { makePromptVisibilityEvent } from '../../runtime/prompt.js';
import { createSnapshot, type ComponentHashes } from '../../supervisor/versioning.js';
import { apply, type ContextLike } from '../../runtime/plugin.js';

// ---- ① 唯一来源语义 ----

describe('R6 ① 唯一宿主版本来源（kernel/schemas/host-version.ts）', () => {
  afterEach(() => {
    setHostVersion(DSH_HOST_VERSION); // 复位（模块级状态；避免文件内测试互相污染）
  });

  it('DSH_HOST_VERSION = 当前宿主默认 0.1.0-rc.7；hostVersion() 缺省 = DSH_HOST_VERSION', () => {
    expect(DSH_HOST_VERSION).toBe('0.1.0-rc.7'); // 当前宿主（research-dsh 实测；README 前置 >=0.1.0-rc.7）
    expect(hostVersion()).toBe(DSH_HOST_VERSION);
  });

  it('setHostVersion 覆写 → hostVersion() 返回注入值；复位后回到默认', () => {
    setHostVersion('9.9.9-test');
    expect(hostVersion()).toBe('9.9.9-test');
    setHostVersion(DSH_HOST_VERSION);
    expect(hostVersion()).toBe(DSH_HOST_VERSION);
  });

  it('非法值 fail-loud（FingerprintSchema dsh_version 亦要求非空字符串）', () => {
    expect(() => setHostVersion('')).toThrow(/非法版本|invalid/i);
    expect(() => setHostVersion(undefined as unknown as string)).toThrow();
  });
});

// ---- ② 防漂移 grep ----

describe('R6 ② 生产代码无旧 dsh_version 字面量（防漂移 grep）', () => {
  /** 生产层目录（src 布局；不含 tests/——测试夹具字面量豁免） */
  const PROD_DIRS = ['kernel', 'supervisor', 'runtime', 'memory', 'substrate'];
  /** 旧值漂移模式：dsh_version: '<0.x.y[-...]>'（'0.8.0'/'0.1.0'/'0.1.1-rc.1'/'0.7.0'/'0.2.0'/'0.4.0'/'0.5.0'/'0.6.0'）。
   *  注意：唯一来源默认 '0.1.0-rc.7' 也只允许经 DSH_HOST_VERSION/hostVersion() 引用——任何
   *  形如 `dsh_version: '<字面量>'` 的出现都算漂移（即使等于默认值）。 */
  const OLD_LITERAL_RE = /dsh_version:\s*['"](?:0\.8\.0|0\.1\.0|0\.1\.1|0\.7\.0|0\.2\.0|0\.4\.0|0\.5\.0|0\.6\.0)[-'0-9A-Za-z.]*['"]/;

  function collectTsFiles(dir: string, out: string[]): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        collectTsFiles(p, out);
      } else if (entry.name.endsWith('.ts')) {
        out.push(p);
      }
    }
  }

  it('kernel/supervisor/runtime/memory/substrate 下无 `dsh_version: \'<旧值>\'` 字面量', () => {
    const offenders: string[] = [];
    for (const d of PROD_DIRS) {
      const files: string[] = [];
      collectTsFiles(join(process.cwd(), d), files);
      for (const f of files) {
        const content = readFileSync(f, 'utf8');
        content.split(/\r?\n/).forEach((line, i) => {
          if (OLD_LITERAL_RE.test(line)) {
            offenders.push(`${f.replace(process.cwd(), '.')}:${i + 1}: ${line.trim()}`);
          }
        });
      }
    }
    expect(offenders).toEqual([]);
  });
});

// ---- ③ 运行时指纹与事件 provenance 恒等于 hostVersion()（装配注入后） ----

const COMPONENTS: ComponentHashes = {
  scheduler: 'a'.repeat(64), memory: 'b'.repeat(64), verifier: 'c'.repeat(64),
  renderer: 'd'.repeat(64), capability: 'e'.repeat(64), philosophy: 'f'.repeat(64),
};

describe('R6 ③ 运行时指纹与事件 provenance 恒等于 hostVersion()（装配注入后）', () => {
  const roots: string[] = [];
  const runtimes: Array<{ close(): Promise<void> }> = [];

  async function tmpRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'omb-r6-'));
    roots.push(root);
    return root;
  }

  function track(rt: ReturnType<typeof createCognitiveRuntime>): ReturnType<typeof createCognitiveRuntime> {
    runtimes.push(rt);
    return rt;
  }

  afterEach(async () => {
    for (const rt of runtimes.splice(0)) {
      await rt.close();
    }
    for (const root of roots.splice(0)) {
      await rm(root, { recursive: true, force: true });
    }
    setHostVersion(DSH_HOST_VERSION); // 复位（runtime 构造器/工厂会写模块级注入态）
  });

  it('createCognitiveRuntime({ hostVersion }) → 指纹采集与运行时事件 provenance 同一注入值', async () => {
    const INJECTED = '9.9.9-rt';
    const root = await tmpRoot();
    const rt = track(createCognitiveRuntime({ root, hostVersion: INJECTED }));

    // 运行时指纹采集（P7 environment_check 同款默认采集器）
    expect(collectEnvironmentFingerprint().dsh_version).toBe(INJECTED);
    expect(collectEnvironmentFingerprint({ dsh_version: 'override' }).dsh_version).toBe('override'); // 显式覆盖仍优先

    // 运行时事件链：handleRequest → session/start + decision/made（makeRuntimeEvent 工厂）
    const res = await rt.handleRequest({
      session_id: 'r6-s1',
      goal: '目标',
      success_criteria: ['c1'],
      constraints: [],
      working_state: { goal: '目标', confirmed_facts: [], active_hypotheses: [], contradictions: [], open_questions: [], evidence_gaps: [], next_best_action: '', environment: 'test' },
    });
    expect(res.events_appended).toBeGreaterThan(0);
    const { events } = await rt.eventStore.query({ session_id: 'r6-s1' });
    expect(events.length).toBeGreaterThan(0);
    for (const ev of events) {
      expect(ev.provenance.environment.dsh_version).toBe(INJECTED);
    }
  });

  it('事件工厂同一值：makeDshEvent / makePromptVisibilityEvent / createSnapshot（provenance 全部 hostVersion()）', () => {
    const INJECTED = '9.9.9-factory';
    setHostVersion(INJECTED);
    const dsh = makeDshEvent('session/start', 's1', 'rs:x', {}, 'user/message', undefined, 'evt:1');
    expect(dsh.provenance.environment.dsh_version).toBe(INJECTED);
    const pv = makePromptVisibilityEvent('s1', 10);
    expect(pv.provenance.environment.dsh_version).toBe(INJECTED);
    const snap = createSnapshot({ components: COMPONENTS, gitRevision: 'rev-r6' });
    expect(snap.provenance.environment.dsh_version).toBe(INJECTED);
  });

  it('缺省（不注入）→ 指纹与事件 provenance = DSH_HOST_VERSION（唯一来源默认）', async () => {
    const root = await tmpRoot();
    const rt = track(createCognitiveRuntime({ root }));
    expect(hostVersion()).toBe(DSH_HOST_VERSION);
    expect(collectEnvironmentFingerprint().dsh_version).toBe(DSH_HOST_VERSION);
    await rt.handleRequest({
      session_id: 'r6-s2',
      goal: '目标',
      success_criteria: ['c1'],
      constraints: [],
      working_state: { goal: '目标', confirmed_facts: [], active_hypotheses: [], contradictions: [], open_questions: [], evidence_gaps: [], next_best_action: '', environment: 'test' },
    });
    const { events } = await rt.eventStore.query({ session_id: 'r6-s2' });
    for (const ev of events) {
      expect(ev.provenance.environment.dsh_version).toBe(DSH_HOST_VERSION);
    }
  });
});

// ---- ④ plugin.ts 装配注入面 ----

describe('R6 ④ plugin.ts 装配注入面（PluginConfig.hostVersion → createCognitiveRuntime）', () => {
  const roots: string[] = [];

  async function tmpRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'omb-r6-plugin-'));
    roots.push(root);
    return root;
  }

  afterEach(async () => {
    for (const root of roots.splice(0)) {
      await rm(root, { recursive: true, force: true });
    }
    setHostVersion(DSH_HOST_VERSION);
  });

  it('apply({ hostVersion }) → 装配运行时的事件 provenance 使用注入值（缺省配置 → 唯一来源默认）', async () => {
    const INJECTED = '9.9.9-plugin';
    const root = await tmpRoot();
    const ctx: ContextLike = { commands: { register: () => undefined } };
    const handle = apply(ctx, {
      cognitiveRoot: root,
      hostVersion: INJECTED,
      bootstrap: false,
      bootStableOverride: () =>
        Promise.resolve({ ok: true, line: 'stable', git_revision: 'a'.repeat(40), tree_root: root, warnings: [] }),
    });
    expect(handle.cognitive).toBeDefined();
    const rt = handle.cognitive!;
    try {
      expect(collectEnvironmentFingerprint().dsh_version).toBe(INJECTED); // 装配期 setHostVersion 已生效
      await rt.handleRequest({
        session_id: 'r6-plugin',
        goal: '目标',
        success_criteria: ['c1'],
        constraints: [],
        working_state: { goal: '目标', confirmed_facts: [], active_hypotheses: [], contradictions: [], open_questions: [], evidence_gaps: [], next_best_action: '', environment: 'test' },
      });
      const { events } = await rt.eventStore.query({ session_id: 'r6-plugin' });
      expect(events.length).toBeGreaterThan(0);
      for (const ev of events) {
        expect(ev.provenance.environment.dsh_version).toBe(INJECTED);
      }
    } finally {
      await rt.close();
    }
  });
});
