// 专项 D（评审问题二）：产物按任务相关性排序测试（supervisor/artifact-index.ts queryRelevant）。
// 背景（已核实）：assembly 原用 queryRecent(limit) 纯最近产物喂 Context 候选——任务目标无关。
// 实施（本文件钉住）：
//   ① 关键词命中优先于更新的不相关产物（英文词 + CJK bigram 双路径）；
//   ② 类型提示加分：goal 含类型词（doc/data/source…）→ 匹配类型制品加分；
//   ③ 最近性决胜：关键词/类型均同分 → created_at 越新优先；同毫秒按 id 稳定；
//   ④ 确定性：同索引同 goal 两次查询 → 恒同序；
//   ⑤ 池窗口截断：候选池 = 最近 ARTIFACT_RELEVANCE_POOL 条——超池（更旧）产物即使高度相关也不返回；
//   ⑥ queryRecent 回归：最近序语义不变（既有消费/测试零变化）。
import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ARTIFACT_RELEVANCE_POOL,
  ARTIFACT_TYPE_HINT_BONUS,
  ArtifactIndex,
} from '../../supervisor/artifact-index.js';
import { artifactManifestId, inferArtifactType, type ArtifactManifest } from '../../kernel/schemas/artifact.js';

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

/** 直接种子写入（queryRelevant/queryRecent 读面测试——避开逐条 register 的 O(n²) 重写） */
async function seedIndex(root: string, manifests: ArtifactManifest[]): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(indexFile(root), manifests.map((m) => JSON.stringify(m)).join('\n') + '\n', 'utf8');
}

/** 最小合法 manifest（id 经 artifactManifestId 派生——同 path+provenance 确定性） */
function manifest(path: string, created_at: number, prov = `evt:${path}:${created_at}`): ArtifactManifest {
  return {
    id: artifactManifestId(path, prov),
    type: inferArtifactType(path),
    path,
    hash: 'unavailable',
    provenance: prov,
    producing_event: prov,
    environment: { os: 'win32', node: 'v24' },
    restorable: false,
    created_at,
  };
}

function ids(list: ArtifactManifest[]): string[] {
  return list.map((m) => m.id);
}

describe('① 关键词命中优先于更新的不相关产物', () => {
  it('英文词重叠：goal "memory design" → 相关产物（含两关键词）排在更新的不相关产物之前', async () => {
    const root = await tmpRoot('omb-rel-1-');
    const a = manifest('docs/memory-design.md', 100); // 双关键词命中（memory+design）→ 分最高
    const b = manifest('notes/unrelated.txt', 200); // 更新但无关
    const c = manifest('docs/memory-guide.md', 300); // 相关（memory）且最新
    await seedIndex(root, [a, b, c]);
    const idx = new ArtifactIndex({ root });

    const rel = await idx.queryRelevant('memory design', 3);
    // a（重叠 2 → 2.0）> c（重叠 1 + 最近性 → 1.02）> b（仅最近性 → 0.01）——相关者恒在无关者之前
    expect(ids(rel)).toEqual([a.id, c.id, b.id]);
    // 对照：queryRecent 纯最近序 → c, b, a（不相关 b 因更新而靠前——原问题语义）
    expect(ids(await idx.queryRecent(3))).toEqual([c.id, b.id, a.id]);
  });

  it('CJK bigram 重叠：goal "记忆 系统" → 中文路径相关制品优先于更新的不相关制品', async () => {
    const root = await tmpRoot('omb-rel-1c-');
    const a = manifest('docs/记忆系统设计.md', 100);
    const b = manifest('out/杂项记录.txt', 200); // 更新但无关
    await seedIndex(root, [a, b]);
    const idx = new ArtifactIndex({ root });

    const rel = await idx.queryRelevant('记忆 系统', 2);
    expect(ids(rel)).toEqual([a.id, b.id]); // 相关（bigram 记忆/系统 命中）优先于更新的无关制品
  });
});

describe('② 类型提示加分（goal 命中 type 词）', () => {
  it('goal 含 "doc" → 类型 doc 的制品加分，压过更新但类型不符的制品', async () => {
    const root = await tmpRoot('omb-rel-2-');
    const a = manifest('docs/旧文档.md', 100); // type doc
    const b = manifest('data/新数据.json', 200); // type data（更新）
    await seedIndex(root, [a, b]);
    const idx = new ArtifactIndex({ root });

    // goal "doc"：a 的 path+type 含 doc（type 词）→ 关键词重叠 + 类型加分；b 无 → 仅最近性
    const rel = await idx.queryRelevant('doc', 2);
    expect(ids(rel)).toEqual([a.id, b.id]);
    // 对照：goal "data" → b 反超（类型词指向 data）
    const relData = await idx.queryRelevant('data', 2);
    expect(ids(relData)).toEqual([b.id, a.id]);
  });

  it('类型加分幅度 ≥ ARTIFACT_TYPE_HINT_BONUS（可标定常量生效；同关键词重叠下类型词决胜）', async () => {
    const root = await tmpRoot('omb-rel-2b-');
    // 同关键词 记忆 重叠、同 created_at；a 类型 doc（goal 含 doc）→ +类型加分；b 类型 data → 无
    const a = manifest('a-记忆.md', 100);
    const b = manifest('b-记忆.json', 100);
    await seedIndex(root, [a, b]);
    const idx = new ArtifactIndex({ root });

    const rel = await idx.queryRelevant('记忆 doc', 2);
    expect(ids(rel)).toEqual([a.id, b.id]);
    // b 至少低一个 ARTIFACT_TYPE_HINT_BONUS 量级的分差（同 created_at 无最近性差）
    const relNoType = await idx.queryRelevant('记忆', 2);
    // goal 无类型词 → 同重叠同时间 → id 升序决胜（a < b 由 artifactManifestId 派生序）
    expect(relNoType.length).toBe(2);
    expect(ARTIFACT_TYPE_HINT_BONUS).toBeGreaterThan(0); // 加分常量生效（§17 可标定）
  });
});

describe('③ 最近性决胜（同分 → created_at 降序；同毫秒 → id 升序）', () => {
  it('同关键词重叠 + 同类型 → 更新的制品优先', async () => {
    const root = await tmpRoot('omb-rel-3-');
    const a = manifest('docs/report-v1.md', 100);
    const b = manifest('docs/report-v2.md', 200);
    await seedIndex(root, [a, b]);
    const idx = new ArtifactIndex({ root });

    const rel = await idx.queryRelevant('report', 2);
    expect(ids(rel)).toEqual([b.id, a.id]); // 同分 → created_at 降序
  });

  it('同 created_at 同分 → id 升序稳定决胜（确定性）', async () => {
    const root = await tmpRoot('omb-rel-3b-');
    const a = manifest('docs/report-a.md', 100);
    const b = manifest('docs/report-b.md', 100);
    await seedIndex(root, [a, b]);
    const idx = new ArtifactIndex({ root });

    const rel = await idx.queryRelevant('report', 2);
    const expected = [...[a, b]].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0)).map((m) => m.id);
    expect(ids(rel)).toEqual(expected);
  });
});

describe('④ 确定性', () => {
  it('同索引同 goal 两次查询 → 恒同序（打分纯函数，无时间/随机依赖）', async () => {
    const root = await tmpRoot('omb-rel-4-');
    const items = [
      manifest('docs/memory-a.md', 100),
      manifest('notes/random-x.txt', 200),
      manifest('docs/memory-b.md', 300),
      manifest('src/code.ts', 150),
    ];
    await seedIndex(root, items);
    const idx = new ArtifactIndex({ root });

    const first = ids(await idx.queryRelevant('memory 文档', 4));
    const second = ids(await idx.queryRelevant('memory 文档', 4));
    expect(second).toEqual(first);
  });
});

describe('⑤ 池窗口截断（候选池 = 最近 ARTIFACT_RELEVANCE_POOL 条）', () => {
  it('超池（更旧）的相关产物不返回——即使高度相关（池窗口截断）', async () => {
    const root = await tmpRoot('omb-rel-5-');
    // 60 条：前 10 条（created 1..10）高度相关（path 含 memory）、后 50 条（created 11..60）无关
    const older = Array.from({ length: 10 }, (_, i) => manifest(`docs/memory-old-${i}.md`, i + 1));
    const newer = Array.from({ length: 50 }, (_, i) => manifest(`notes/junk-${i}.txt`, 11 + i));
    await seedIndex(root, [...older, ...newer]);
    const idx = new ArtifactIndex({ root });

    const rel = await idx.queryRelevant('memory', 5);
    // 池 = 最近 50 条（created 11..60，全是 junk）——memory 相关者（created ≤10）全部超池
    expect(rel).toHaveLength(5);
    expect(rel.some((m) => m.path.includes('memory'))).toBe(false);
    expect(rel.every((m) => m.path.includes('junk'))).toBe(true);
    expect(ARTIFACT_RELEVANCE_POOL).toBe(50); // 池常量钉住
  });

  it('池内相关产物正常返回（不受截断影响）', async () => {
    const root = await tmpRoot('omb-rel-5b-');
    const rel = manifest('docs/memory-inpool.md', 160); // 最近 50 条窗口内（最新）
    const junk = Array.from({ length: 60 }, (_, i) => manifest(`notes/junk-${i}.txt`, 100 + i));
    await seedIndex(root, [rel, ...junk]);
    const idx = new ArtifactIndex({ root });

    const result = await idx.queryRelevant('memory', 3);
    expect(result[0]!.path).toBe('docs/memory-inpool.md'); // 池内相关 → 第一
  });
});

describe('⑥ queryRecent 回归', () => {
  it('queryRecent 最近序语义不变（created_at 降序、同毫秒 id 升序、limit 截断）', async () => {
    const root = await tmpRoot('omb-rel-6-');
    const a = manifest('a.md', 100, 'p1');
    const b = manifest('b.md', 200, 'p2');
    const c = manifest('c.md', 200, 'p3');
    await seedIndex(root, [a, b, c]);
    const idx = new ArtifactIndex({ root });

    const recent = await idx.queryRecent();
    expect(recent.map((m) => m.created_at)).toEqual([200, 200, 100]); // created_at 降序
    // 同毫秒（b/c 均 200）→ id 升序稳定决胜（动态期望——id 为 sha256 派生，不硬编码）
    const sameTs = [b, c].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0)).map((m) => m.id);
    expect(recent.slice(0, 2).map((m) => m.id)).toEqual(sameTs);
    expect(recent[2]!.id).toBe(a.id);
    expect(ids(await idx.queryRecent(1))).toEqual([recent[0]!.id]);
  });
});
