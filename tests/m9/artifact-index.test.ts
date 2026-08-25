// S4（2026-08-25-verification-contract 第二阶段专项 4）：Artifact Index（事件驱动制品索引）测试。
// 覆盖：
//   ① manifest schema：合法 / 非法（缺字段/空 path）fail-loud；inferArtifactType 映射矩阵；
//      artifactManifestId 确定性（sha256(path|provenance) 前缀 16）
//   ② ArtifactIndex：register（建文件/字段保留）/ 同 id 覆写 / queryRecent 排序（created_at 降序）/
//      上限淘汰（ARTIFACT_CAP=500 淘汰最旧）/ 持久化（新实例读同一文件）/ 损坏行跳过 /
//      写失败降级（degraded 记录不抛）
//   ③ discoverArtifactsFromEvents：payload 含路径 → 存在文件（tmp fixture）→ manifest 字段齐全
//      （hash 真实/restorable true/type 推断/provenance=事件 id）；幽灵路径跳过；无路径 → []；
//      root 缺省 → hash='unavailable'/restorable=false；事件类型过滤（非 tool/result 跳过）；
//      每事件上限 MAX_ARTIFACTS_PER_EVENT；对象 payload（JSON 序列化提取）
//   ④ Context 集成（参照 tests/m8/context-candidates.test.ts 构造）：sources.artifacts 注入 →
//      gather 候选（ref=制品 id、content=payload、info_value=estimateInfoValue 缺口匹配启发式）+ 投影含
//      artifact section（source_ref=制品 id、content=ref:<id>、evidence_artifact 视图）；未注入 → 无 artifact section；
//      生产路径（createCognitiveRuntime）：observeEvent(tool/result 携带仓库内真实路径）→ finalizeTurn
//      发现并注册 → prepareTurn 投影含 artifact section
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPolicy, type PolicyBundle } from '../../kernel/policy-loader.js';
import { ContextProjectionSchema } from '../../kernel/schemas/a.js';
import type { Event } from '../../kernel/schemas/m.js';
import type { CapabilityLike } from '../../supervisor/capability.js';
import {
  ARTIFACT_TYPE_BY_EXT,
  ArtifactManifestSchema,
  artifactManifestId,
  inferArtifactType,
  type ArtifactManifest,
} from '../../kernel/schemas/artifact.js';
import {
  ARTIFACT_CAP,
  ArtifactIndex,
  MAX_ARTIFACTS_PER_EVENT,
  discoverArtifactsFromEvents,
} from '../../supervisor/artifact-index.js';
import { createCognitiveRuntime } from '../../runtime/assembly.js';
import { buildContextProjection, makeRuntimeEvent } from '../../runtime/turn-helpers.js';
import {
  ARTIFACT_CANDIDATE_LIMIT,
  INFO_VALUE_BASE,
  estimateInfoValue,
  gatherContextCandidates,
} from '../../runtime/context-candidates.js';
import type { RankedMemory } from '../../memory/retrieve.js';

const POLICY_DIR = fileURLToPath(new URL('../../kernel/policy', import.meta.url));

let policy: PolicyBundle;
beforeAll(async () => {
  policy = await loadPolicy(POLICY_DIR);
});

// ---- fixture ----

const roots: string[] = [];

async function tmpRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

function indexFile(root: string): string {
  return join(root, 'index.jsonl');
}

/** 读 JSONL 全量 manifest（测试断言面） */
async function readIndex(root: string): Promise<ArtifactManifest[]> {
  const raw = await readFile(indexFile(root), 'utf8');
  return raw
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as ArtifactManifest);
}

/** 直接种子写入（上限淘汰测试用——避开逐条 register 的 O(n²) 重写） */
async function seedIndex(root: string, manifests: ArtifactManifest[]): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(indexFile(root), manifests.map((m) => JSON.stringify(m)).join('\n') + '\n', 'utf8');
}

let seq = 0;
/** 最小合法 manifest（id 经 artifactManifestId 派生——同 path+provenance 确定性） */
function manifest(over: Partial<ArtifactManifest> = {}): ArtifactManifest {
  seq += 1;
  const path = `out/file-${seq}.json`;
  const prov = `evt:${seq}`;
  return {
    id: artifactManifestId(path, prov),
    type: inferArtifactType(path),
    path,
    hash: 'unavailable',
    provenance: prov,
    producing_event: prov,
    environment: { os: 'win32', node: 'v24' },
    restorable: false,
    created_at: seq,
    ...over,
  };
}

/** 最小工作状态（PromptWorkingState 结构面；estimateInfoValue 缺口子集同 m8） */
const ws = {
  goal: 'S4 测试目标',
  confirmed_facts: [] as string[],
  active_hypotheses: [] as string[],
  contradictions: [] as string[],
  open_questions: [] as string[],
  evidence_gaps: [] as string[],
  next_best_action: '',
  environment: 'test',
};

/** fake 事件库（gather 侧封顶为权威） */
function fakeEventStore(events: Event[] = []): { query: () => Promise<{ events: Event[] }> } {
  return { query: async () => ({ events }) };
}

/** fake 能力注册表 */
function fakeCapabilities(caps: CapabilityLike[] = []): { list: () => CapabilityLike[] } {
  return { list: () => caps };
}

/** artifact 来源函数 fake（捕获 limit——断言 gather 传 ARTIFACT_CANDIDATE_LIMIT） */
function fakeArtifacts(items: Array<{ id: string; payload: string }>, captured?: { limit?: number }) {
  return async (goal: string, limit: number) => {
    captured!.limit = limit;
    return items.slice(0, limit);
  };
}

/** gather 输入工厂（缺省：空来源 + 空记忆） */
function gatherInput(
  over: Partial<Parameters<typeof gatherContextCandidates>[0]> = {},
): Parameters<typeof gatherContextCandidates>[0] {
  return {
    working_state: ws,
    goal: ws.goal,
    memory_items: [] as RankedMemory[],
    runtime: { eventStore: fakeEventStore(), capabilities: fakeCapabilities() },
    ...over,
  };
}

// ---- ① manifest schema + 类型推断 ----

describe('S4 ① ArtifactManifest schema 与类型推断（kernel/schemas/artifact.ts）', () => {
  it('合法 manifest → safeParse 通过；字段全量保留', () => {
    const m = manifest();
    const r = ArtifactManifestSchema.safeParse(m);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.id).toBe(m.id);
      expect(r.data.path).toBe(m.path);
      expect(r.data.environment).toEqual({ os: 'win32', node: 'v24' });
    }
  });

  it('缺字段 fail-loud：缺 path / 缺 producing_event → 解析失败', () => {
    const full = manifest();
    expect(ArtifactManifestSchema.safeParse({ ...full, path: undefined }).success).toBe(false);
    expect(ArtifactManifestSchema.safeParse({ ...full, producing_event: undefined }).success).toBe(false);
  });

  it('空 path / 空 id / 非法 created_at → fail-loud', () => {
    expect(ArtifactManifestSchema.safeParse({ ...manifest(), path: '' }).success).toBe(false);
    expect(ArtifactManifestSchema.safeParse({ ...manifest(), id: '' }).success).toBe(false);
    expect(ArtifactManifestSchema.safeParse({ ...manifest(), created_at: -1 }).success).toBe(false);
    expect(ArtifactManifestSchema.safeParse({ ...manifest(), created_at: 1.5 }).success).toBe(false);
  });

  it('inferArtifactType 映射矩阵（ARTIFACT_TYPE_BY_EXT）', () => {
    expect(ARTIFACT_TYPE_BY_EXT['.ts']).toBe('source');
    expect(ARTIFACT_TYPE_BY_EXT['.js']).toBe('source');
    expect(ARTIFACT_TYPE_BY_EXT['.tsx']).toBe('source');
    expect(ARTIFACT_TYPE_BY_EXT['.jsx']).toBe('source');
    expect(ARTIFACT_TYPE_BY_EXT['.md']).toBe('doc');
    expect(ARTIFACT_TYPE_BY_EXT['.txt']).toBe('doc');
    expect(ARTIFACT_TYPE_BY_EXT['.yaml']).toBe('data');
    expect(ARTIFACT_TYPE_BY_EXT['.yml']).toBe('data');
    expect(ARTIFACT_TYPE_BY_EXT['.json']).toBe('data');
    expect(inferArtifactType('src/app.ts')).toBe('source');
    expect(inferArtifactType('build/bundle.js')).toBe('source');
    expect(inferArtifactType('views/Page.tsx')).toBe('source');
    expect(inferArtifactType('hooks/useX.jsx')).toBe('source');
    expect(inferArtifactType('README.md')).toBe('doc');
    expect(inferArtifactType('notes.txt')).toBe('doc');
    expect(inferArtifactType('config.yaml')).toBe('data');
    expect(inferArtifactType('config.yml')).toBe('data');
    // .json 缺省 data；路径含 'test'/'report'（小写匹配）→ report
    expect(inferArtifactType('data/plain.json')).toBe('data');
    expect(inferArtifactType('config.json')).toBe('data');
    expect(inferArtifactType('report-2026.json')).toBe('report');
    expect(inferArtifactType('test/result.json')).toBe('report');
    expect(inferArtifactType('artifacts/Report.json')).toBe('report');
    // 其它扩展名 → other；无扩展名 → other
    expect(inferArtifactType('binary.bin')).toBe('other');
    expect(inferArtifactType('noext')).toBe('other');
  });

  it('artifactManifestId 确定性：同 path+provenance → 同 16hex id；任一不同 → 不同 id', () => {
    const a = artifactManifestId('a.json', 'evt:1');
    const b = artifactManifestId('a.json', 'evt:1');
    expect(b).toBe(a);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(artifactManifestId('b.json', 'evt:1')).not.toBe(a);
    expect(artifactManifestId('a.json', 'evt:2')).not.toBe(a);
  });
});

// ---- ② ArtifactIndex（layer 1 JSONL） ----

describe('S4 ② ArtifactIndex：register/覆写/排序/淘汰/持久化/损坏行/写失败降级', () => {
  it('register：建 index.jsonl；count/queryRecent/list 可见；字段全保留', async () => {
    const root = await tmpRoot('omb-art-2a-');
    const idx = new ArtifactIndex({ root });
    const m = manifest({ hash: 'abc123', restorable: true, type: 'report' });
    await idx.register(m);
    expect(await idx.count()).toBe(1);
    expect(await idx.list()).toEqual([m]);
    const recent = await idx.queryRecent();
    expect(recent).toEqual([m]);
    const files = await readdir(root);
    expect(files).toContain('index.jsonl');
    expect(files.filter((f) => f.endsWith('.tmp'))).toHaveLength(0); // tmp+rename 原子写
    const persisted = await readIndex(root);
    expect(persisted[0]!.id).toBe(m.id);
    expect(persisted[0]!.type).toBe('report');
    expect(persisted[0]!.restorable).toBe(true);
  });

  it('同 id 覆写：最新 manifest 胜出（单条，path/hash 更新）', async () => {
    const root = await tmpRoot('omb-art-2b-');
    const idx = new ArtifactIndex({ root });
    const id = artifactManifestId('a.json', 'evt:1');
    await idx.register(manifest({ id, path: 'a.json', hash: 'h1' }));
    await idx.register(manifest({ id, path: 'a.json', hash: 'h2', created_at: 99 }));
    expect(await idx.count()).toBe(1);
    const all = await idx.list();
    expect(all[0]!.hash).toBe('h2');
    expect(all[0]!.created_at).toBe(99);
  });

  it('register schema 非法 → fail-loud（抛错）', async () => {
    const root = await tmpRoot('omb-art-2c-');
    const idx = new ArtifactIndex({ root });
    await expect(idx.register({ ...manifest(), path: '' })).rejects.toThrow(/schema 校验失败/);
  });

  it('queryRecent：created_at 降序（最新优先）；同毫秒按 id 稳定排序；limit 截断', async () => {
    const root = await tmpRoot('omb-art-2d-');
    await seedIndex(root, [
      manifest({ id: 'a1', created_at: 1 }),
      manifest({ id: 'a3', created_at: 3 }),
      manifest({ id: 'a2', created_at: 2 }),
      manifest({ id: 'a1-dup', created_at: 1 }), // 同毫秒 → id 字典序（a1 < a1-dup < a2 < a3）
    ]);
    const idx = new ArtifactIndex({ root });
    expect((await idx.queryRecent()).map((m) => m.id)).toEqual(['a3', 'a2', 'a1', 'a1-dup']);
    expect((await idx.queryRecent(2)).map((m) => m.id)).toEqual(['a3', 'a2']);
  });

  it('上限淘汰：种子 ARTIFACT_CAP 条 + register 1 条 → 仍 500 条，最旧被淘汰、新记录保留', async () => {
    const root = await tmpRoot('omb-art-2e-');
    const seeded: ArtifactManifest[] = [];
    for (let i = 1; i <= ARTIFACT_CAP; i++) {
      seeded.push(manifest({ id: `seed-${i}`, created_at: i }));
    }
    await seedIndex(root, seeded);
    const idx = new ArtifactIndex({ root });
    await idx.register(manifest({ id: 'newest', created_at: ARTIFACT_CAP + 1 }));
    const all = await readIndex(root);
    expect(all).toHaveLength(ARTIFACT_CAP);
    expect(all.some((m) => m.id === 'seed-1')).toBe(false); // 最旧被淘汰
    expect(all.some((m) => m.id === 'newest')).toBe(true); // 新记录保留
    expect(all.some((m) => m.id === `seed-${ARTIFACT_CAP}`)).toBe(true); // 较新种子保留
  });

  it('持久化：新实例读同一文件（构造零 I/O；跨实例状态一致）', async () => {
    const root = await tmpRoot('omb-art-2f-');
    const a = new ArtifactIndex({ root });
    await a.register(manifest({ hash: 'persist-hash' }));
    const b = new ArtifactIndex({ root });
    expect(await b.count()).toBe(1);
    const all = await b.list();
    expect(all[0]!.hash).toBe('persist-hash');
  });

  it('损坏行跳过（审计日志语义）：坏 JSON/形状不合规行跳过，register 重写后清除', async () => {
    const root = await tmpRoot('omb-art-2g-');
    const good = manifest({ id: 'good', created_at: 1 });
    await seedIndex(root, [good]);
    await writeFile(indexFile(root), 'not-json-line\n{"id": 5, "path": "x"}\n' + JSON.stringify(good) + '\n', 'utf8');
    const idx = new ArtifactIndex({ root });
    expect((await idx.queryRecent()).map((m) => m.id)).toEqual(['good']);
    await idx.register(manifest({ id: 'new', created_at: 2 }));
    const all = await readIndex(root);
    expect(all.map((m) => m.id).sort()).toEqual(['good', 'new']); // 坏行被清除，队列不因此死亡
  });

  it('写失败降级记录不抛（坏路径：index.jsonl 被目录占用 → degraded 非空，register 不崩）', async () => {
    const root = await tmpRoot('omb-art-2h-');
    await mkdir(indexFile(root), { recursive: true }); // 占位：index.jsonl 路径成为目录 → rename(tmp, dir) 失败
    const idx = new ArtifactIndex({ root });
    await expect(idx.register(manifest())).resolves.toBeUndefined();
    expect(idx.degraded).not.toBeNull();
  });
});

// ---- ③ 事件驱动发现 ----

describe('S4 ③ discoverArtifactsFromEvents：事件 → Manifest（尽力而为）', () => {
  it('payload 含路径且文件存在（tmp fixture）→ manifest 字段齐全（hash 真实/restorable true/type 推断/provenance=事件 id）', async () => {
    const root = await tmpRoot('omb-art-3a-');
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'app.ts'), 'hello', 'utf8');
    await writeFile(join(root, 'report.json'), '{}', 'utf8');
    const env = { os: 'win32', node: 'v24' };
    const manifests = await discoverArtifactsFromEvents(
      [{ id: 'evt:1', type: 'tool/result', payload: 'wrote src/app.ts and report.json' }],
      { root, environment: env, now: 42 },
    );
    expect(manifests).toHaveLength(2);
    const app = manifests.find((m) => m.path === 'src/app.ts')!;
    expect(app).toBeDefined();
    expect(app.hash).toBe(createHash('sha256').update('hello', 'utf8').digest('hex'));
    expect(app.restorable).toBe(true);
    expect(app.type).toBe('source');
    expect(app.id).toBe(artifactManifestId('src/app.ts', 'evt:1'));
    expect(app.provenance).toBe('evt:1');
    expect(app.producing_event).toBe('evt:1');
    expect(app.environment).toEqual(env);
    expect(app.created_at).toBe(42);
    const rep = manifests.find((m) => m.path === 'report.json')!;
    expect(rep.type).toBe('report'); // 路径含 'report' → report
    expect(rep.hash).toBe(createHash('sha256').update('{}', 'utf8').digest('hex'));
    expect(rep.restorable).toBe(true);
  });

  it('幽灵路径跳过（root 下不存在/目录）——不索引；越界路径（.. 逃逸）跳过', async () => {
    const root = await tmpRoot('omb-art-3b-');
    await writeFile(join(root, 'real.txt'), 'x', 'utf8');
    const manifests = await discoverArtifactsFromEvents(
      [{ id: 'evt:1', type: 'tool/result', payload: 'real.txt ghost.json sub/../../outside.txt' }],
      { root, environment: {} },
    );
    expect(manifests).toHaveLength(1);
    expect(manifests[0]!.path).toBe('real.txt');
  });

  it('无路径（payload 无扩展名白名单 token）→ []', async () => {
    const root = await tmpRoot('omb-art-3c-');
    const manifests = await discoverArtifactsFromEvents(
      [{ id: 'evt:1', type: 'tool/result', payload: 'done, no files here' }],
      { root, environment: {} },
    );
    expect(manifests).toHaveLength(0);
  });

  it('root 缺省 → 仍索引（hash=unavailable/restorable=false 诚实缺省；path/type/provenance 保留）', async () => {
    const manifests = await discoverArtifactsFromEvents(
      [{ id: 'evt:1', type: 'tool/result', payload: 'wrote src/app.ts' }],
      { environment: { os: 'win32' }, now: 7 },
    );
    expect(manifests).toHaveLength(1);
    expect(manifests[0]!.path).toBe('src/app.ts');
    expect(manifests[0]!.type).toBe('source');
    expect(manifests[0]!.hash).toBe('unavailable');
    expect(manifests[0]!.restorable).toBe(false);
    expect(manifests[0]!.provenance).toBe('evt:1');
    expect(manifests[0]!.created_at).toBe(7);
  });

  it('事件类型过滤：非 tool/result 跳过（即使 payload 含路径）', async () => {
    const root = await tmpRoot('omb-art-3e-');
    await writeFile(join(root, 'a.ts'), 'x', 'utf8');
    const manifests = await discoverArtifactsFromEvents(
      [
        { id: 'evt:1', type: 'tool/call', payload: 'a.ts' },
        { id: 'evt:2', type: 'session/start', payload: 'a.ts' },
        { id: 'evt:3', type: 'decision/made', payload: 'a.ts' },
      ],
      { root, environment: {} },
    );
    expect(manifests).toHaveLength(0);
  });

  it('每事件最多 MAX_ARTIFACTS_PER_EVENT 个（7 路径 → 前 5；去重）', async () => {
    const root = await tmpRoot('omb-art-3f-');
    for (let i = 1; i <= 7; i++) {
      await writeFile(join(root, `f${i}.md`), 'x', 'utf8');
    }
    const manifests = await discoverArtifactsFromEvents(
      [{ id: 'evt:1', type: 'tool/result', payload: 'f1.md f2.md f3.md f4.md f5.md f6.md f7.md f1.md' }],
      { root, environment: {} },
    );
    expect(manifests).toHaveLength(MAX_ARTIFACTS_PER_EVENT); // 去重后 7 个 → 取前 5
    expect(manifests.map((m) => m.path)).toEqual(['f1.md', 'f2.md', 'f3.md', 'f4.md', 'f5.md']);
  });

  it('对象 payload：JSON 序列化提取路径 token', async () => {
    const root = await tmpRoot('omb-art-3g-');
    await writeFile(join(root, 'out.ts'), 'x', 'utf8');
    await writeFile(join(root, 'notes.md'), 'x', 'utf8');
    const manifests = await discoverArtifactsFromEvents(
      [{ id: 'evt:1', type: 'tool/result', payload: { file: 'out.ts', note: 'see notes.md', tool_id: 't:1' } }],
      { root, environment: {} },
    );
    expect(manifests.map((m) => m.path).sort()).toEqual(['notes.md', 'out.ts']);
  });

  it('尽力而为：根不存在/读取异常 → 返回 []（不抛）', async () => {
    const root = await tmpRoot('omb-art-3h-');
    const manifests = await discoverArtifactsFromEvents(
      [{ id: 'evt:1', type: 'tool/result', payload: 'gone.ts' }],
      { root: join(root, 'no-such-dir'), environment: {} },
    );
    expect(manifests).toHaveLength(0);
  });
});

// ---- ④ Context 集成（sources.artifacts → 候选 → 投影） ----

describe('S4 ④ Context 集成：artifacts 来源 → 候选/投影；未注入 → 无 artifact section', () => {
  it('gatherContextCandidates：sources.artifacts 注入 → artifact 候选（ref=制品 id、view=pointer、content=payload、info_value=estimateInfoValue）', async () => {
    const captured: { limit?: number } = {};
    const cands = await gatherContextCandidates(
      gatherInput({
        runtime: {
          eventStore: fakeEventStore(),
          capabilities: fakeCapabilities(),
          artifacts: fakeArtifacts([{ id: 'artifact:1', payload: '制品 report: report.json' }], captured),
        },
      }),
    );
    const arts = cands.filter((c) => c.kind === 'artifact');
    expect(arts).toHaveLength(1);
    expect(arts[0]!.ref).toBe('artifact:1');
    expect(arts[0]!.view).toBe('pointer');
    expect(arts[0]!.content).toBe('制品 report: report.json');
    // ΔInfoValue（S3）：缺口匹配启发式——空缺口 → 基础值；与直接 estimateInfoValue 同值（统一启发式）
    expect(arts[0]!.info_value).toBe(estimateInfoValue('制品 report: report.json', ws));
    expect(arts[0]!.info_value).toBe(INFO_VALUE_BASE);
    expect(arts[0]!.tokens_est).toBeGreaterThan(0);
    expect(captured.limit).toBe(ARTIFACT_CANDIDATE_LIMIT); // gather 传 K 封顶
  });

  it('gatherContextCandidates：artifacts 来源抛错 → 无 artifact 候选（尽力而为，不阻塞其余来源）', async () => {
    const cands = await gatherContextCandidates(
      gatherInput({
        runtime: {
          eventStore: fakeEventStore(),
          capabilities: fakeCapabilities(),
          artifacts: async () => {
            throw new Error('index broken');
          },
        },
      }),
    );
    expect(cands.some((c) => c.kind === 'artifact')).toBe(false);
  });

  it('buildContextProjection：sources.artifacts 注入 → 投影含 artifact section（source_ref=制品 id、content=ref:<id>、evidence_artifact）', async () => {
    const id = artifactManifestId('report.json', 'evt:1');
    const proj = await buildContextProjection(
      policy,
      { goal: 'g', success_criteria: ['s'] },
      ws,
      [],
      null,
      {
        eventStore: fakeEventStore(),
        capabilities: fakeCapabilities(),
        artifacts: async () => [{ id, payload: '制品 report: report.json' }],
        session_id: 'sess-s4',
      },
    );
    const section = proj.sections.find((s) => s.source_ref === id);
    expect(section).toBeDefined();
    expect(section!.content).toBe(`ref:${id}`); // pointer 投影（可 context_restore）
    expect(section!.view).toBe('evidence_artifact');
    expect(proj.original_artifact_ids).toContain(id);
    expect(proj.restore_capable).toBe(true);
    expect(ContextProjectionSchema.safeParse(proj).success).toBe(true);
  });

  it('buildContextProjection：未注入 artifacts 来源 → 无 artifact section（既有行为不破坏）', async () => {
    const proj = await buildContextProjection(
      policy,
      { goal: 'g', success_criteria: ['s'] },
      ws,
      [],
      null,
      { eventStore: fakeEventStore(), capabilities: fakeCapabilities(), session_id: 'sess-s4' },
    );
    expect(proj.sections.map((s) => s.source_ref)).toEqual(['working_state']);
    expect(proj.sections.some((s) => s.source_ref.startsWith('artifact'))).toBe(false);
  });

  it('生产路径：observeEvent(tool/result 携带仓库内真实路径) → finalizeTurn 发现并注册 → prepareTurn 投影含 artifact section', async () => {
    const base = await tmpRoot('omb-art-4e-');
    const rt = createCognitiveRuntime({ root: join(base, '.omb') });
    try {
      const SESSION = 'sess-s4-prod';
      // 工具结果携带仓库内真实路径（root=HERE 解析存在——确定性：package.json 内容已提交）
      const observed = await rt.observeEvent(
        makeRuntimeEvent('tool/result', SESSION, 'rs:test', { file: 'package.json', note: 'wrote' }, ['test']),
      );
      expect(observed.appended).toBe(true);
      const eventId = observed.event.id;

      await rt.finalizeTurn({
        session_id: SESSION,
        decision: {
          decision: 'Verify',
          reason: 's4',
          budget_allocation: { depth: 1, breadth: 1, tools: 1, retrieval: 1, branches: 1, context: 1 },
          expected_gain: 0.5,
          snapshot: 'rs:test',
        },
        working_state: { ...ws, goal: 's4 artifact' },
      });

      // 发现并注册：manifest 字段齐全（hash 真实/restorable true/provenance=事件 id）
      const all = await rt.artifactIndex.list();
      const manifestEntry = all.find((m) => m.path === 'package.json');
      expect(manifestEntry).toBeDefined();
      expect(manifestEntry!.provenance).toBe(eventId);
      expect(manifestEntry!.producing_event).toBe(eventId);
      expect(manifestEntry!.restorable).toBe(true);
      expect(manifestEntry!.type).toBe('data'); // json 无 test/report → data
      expect(manifestEntry!.id).toBe(artifactManifestId('package.json', eventId));
      const HERE = fileURLToPath(new URL('../../', import.meta.url));
      expect(manifestEntry!.hash).toBe(
        createHash('sha256').update(await readFile(join(HERE, 'package.json'))).digest('hex'),
      );

      // 索引就绪后 prepareTurn → 投影含 artifact section（source_ref=manifest id）
      const prepared = await rt.prepareTurn({
        session_id: SESSION,
        goal: 's4 artifact',
        success_criteria: ['制品索引'],
        constraints: [],
        working_state: { ...ws, goal: 's4 artifact' },
      } as never);
      const section = prepared.projection.sections.find((s) => s.source_ref === manifestEntry!.id);
      expect(section).toBeDefined();
      expect(section!.content).toBe(`ref:${manifestEntry!.id}`);
      expect(section!.view).toBe('evidence_artifact');
      expect(ContextProjectionSchema.safeParse(prepared.projection).success).toBe(true);
    } finally {
      await rt.close().catch(() => undefined);
    }
  });
});
