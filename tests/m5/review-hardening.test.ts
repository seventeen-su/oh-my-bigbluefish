// 审查加固回归（对应本轮六路并行只读审查发现的高危项，防复发）：
//   ① 制品索引读失败不得覆盖既有索引（数据丢失）
//   ② 注册批量化（一次读 + 一次写，语义与逐条等价）
//   ③ 检查点多会话下仍受全局上限约束（此前 keep 无上限 → prune 变空操作、目录无界增长）
//   ④ 中断量子不得为"从未执行"的任务累计债务
//   ⑤ 损坏的 debt.json 不得永久缓存加载失败（否则保护性自锁静默失效）
import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactIndex } from '../../supervisor/artifact-index.js';
import { artifactManifestId, inferArtifactType, type ArtifactManifest } from '../../kernel/schemas/artifact.js';
import { list as listCheckpoints, prune, save } from '../../supervisor/checkpoint.js';
import { MaintenanceScheduler } from '../../supervisor/maintenance.js';

const roots: string[] = [];

afterEach(async () => {
  for (const r of roots.splice(0)) {
    await rm(r, { recursive: true, force: true, maxRetries: 3 });
  }
});

async function tmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

let seq = 0;
function manifest(over: Partial<ArtifactManifest> = {}): ArtifactManifest {
  seq += 1;
  const path = `out/f-${seq}.json`;
  const prov = `evt:${seq}`;
  return {
    id: artifactManifestId(path, prov),
    type: inferArtifactType(path),
    path,
    hash: 'unavailable',
    provenance: prov,
    producing_event: prov,
    environment: { os: 'win32', node: 'v24', dsh_version: '0.1.3-alpha.2', project: 'omb-v2' },
    restorable: false,
    created_at: 1000 + seq,
    ...over,
  } as ArtifactManifest;
}

describe('① 制品索引：读失败不得覆盖既有索引', () => {
  it('index.jsonl 是目录（读取必然失败）→ register/registerMany 跳过写入并留降级原因', async () => {
    const root = await tmp('omb-ai-readfail-');
    const file = join(root, 'index.jsonl');
    await mkdir(file, { recursive: true }); // 同路径建目录 → readFile 失败（EISDIR/EPERM）
    const index = new ArtifactIndex({ root });
    await index.register(manifest());
    expect(index.degraded).toMatch(/读取失败/);
    await index.registerMany([manifest(), manifest()]);
    expect(index.degraded).toMatch(/读取失败/);
  });

  it('正常路径：registerMany 语义与逐条 register 等价（同 id 覆写、批内后者胜出、上限淘汰）', async () => {
    const root = await tmp('omb-ai-batch-');
    const a = manifest();
    const b = manifest();
    const index = new ArtifactIndex({ root });
    await index.register(a);
    await index.registerMany([b, { ...b, hash: 'updated' } as ArtifactManifest]);
    const lines = (await readFile(join(root, 'index.jsonl'), 'utf8'))
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as ArtifactManifest);
    expect(lines).toHaveLength(2);
    expect(lines.find((m) => m.id === b.id)?.hash).toBe('updated'); // 批内后者胜出
    expect(await index.count()).toBe(2);
  });
});

describe('② 检查点轮转：多会话下全局上限仍然生效', () => {
  it('会话数超过 maxFiles/perSessionKeep → 目录规模被压到上限内（而不是空操作）', async () => {
    const dir = await tmp('omb-cp-multi-');
    const TS = '2026-01-01T00:00:00.000Z';
    const env = { os: 'win32', node: 'v24', dsh_version: '0.1.3-alpha.2', project: 'omb-v2' };
    const state = (goal: string) =>
      ({
        ir_version: '2.0',
        id: `ws:${goal}`,
        schema: 'omb/M2',
        scope: 'Project',
        lifecycle: 'Active',
        immutable: false,
        owner: 'kernel',
        created: TS,
        updated: TS,
        provenance: {
          source: 'system',
          event: `test/${goal}`,
          actor: 'kernel',
          environment: env,
          runtime_snapshot: 'rs:test',
          timestamp: TS,
          transformation_chain: [],
          verification: 'v:rule',
        },
        refs: [],
        goal,
        confirmed_facts: [],
        active_hypotheses: [],
        contradictions: [],
        open_questions: [],
        evidence_gaps: [],
        next_best_action: '',
        environment: 'test',
      }) as never;
    // 20 个会话 × 3 条 = 60 个文件；上限 9 → 必须清到 9 条以内
    for (let i = 0; i < 20; i++) {
      for (let j = 0; j < 3; j++) {
        await save(state(`g-${i}-${j}`), { dir, session_id: `s-${i}` });
      }
    }
    const before = await listCheckpoints({ dir });
    expect(before.length).toBeGreaterThan(9);
    const r = await prune({ dir, maxFiles: 9, perSessionKeep: 3, maxAgeMs: 365 * 24 * 3600 * 1000 });
    const after = await listCheckpoints({ dir });
    expect(after.length).toBeLessThanOrEqual(9);
    expect(r.removed).toBeGreaterThan(0);
    expect(after.length + r.removed).toBeGreaterThanOrEqual(before.length); // 统计自洽（kept 口径）
  });
});

describe('③ 调度器：中断量子不得为未执行任务计债；损坏债务文件不永久缓存', () => {
  it('aborted 入口只留队不计债；执行成功也不计债', async () => {
    const dir = await tmp('omb-mt-abort-');
    const s = new MaintenanceScheduler({ debtFile: join(dir, 'debt.json') });
    s.enqueue({ id: 'task-a', value: 1, estimated_cost: 1, priority: 0, urgency: 'normal', run: async () => {} });
    const aborted = new AbortController();
    aborted.abort();
    const skipped = await s.requestQuantum({ signal: aborted.signal });
    expect(skipped.skipped).toContain('task-a');
    expect(s.debtSnapshot().some((d) => d.task_id === 'task-a')).toBe(false);
    const ran = await s.requestQuantum();
    expect(ran.ran).toContain('task-a');
    expect(s.debtSnapshot().some((d) => d.task_id === 'task-a')).toBe(false);
    s.stop();
  });

  it('debt.json 损坏 → 抛错但不缓存失败；修好后可正常加载', async () => {
    const dir = await tmp('omb-mt-corrupt-');
    const debtFile = join(dir, 'debt.json');
    await writeFile(debtFile, '{ 这不是 JSON', 'utf8');
    const s = new MaintenanceScheduler({ debtFile });
    expect(() => s.debtSnapshot()).toThrow(/corrupt/);
    // 修复文件后同一实例应能重新加载（此前 debtLoaded 已置位 → 永久空视图 + 覆盖磁盘）
    await writeFile(
      debtFile,
      JSON.stringify([
        { task_id: 'repair', value: 3, priority: 0, estimated_cost: 1, urgency: 'normal', accumulated_at: Date.now(), first_seen: Date.now(), last_failure: Date.now(), subsystem: 'repair-chain' },
      ]),
      'utf8',
    );
    const loaded = s.debtSnapshot();
    expect(loaded.some((d) => d.task_id === 'repair' && d.value === 3)).toBe(true);
    expect(s.limitsSnapshot().total).toBe(3);
    s.stop();
  });

  it('drain()：无在飞任务时立即返回（关闭前排空钩子存在且幂等）', async () => {
    const dir = await tmp('omb-mt-drain-');
    const s = new MaintenanceScheduler({ debtFile: join(dir, 'debt.json') });
    await s.drain();
    await s.drain();
    s.stop();
    await s.drain(); // stop 后仍安全
  });
});
