// T8.16 中文分词接入测试（memory/cjk-ngram.ts + memory/backend.ts + memory/sql.ts；
// 架构 §7.5 存储 FTS5——unicode61 中文子串不命中的修复）。
// 选型记录（实测约束：node:sqlite 内置 SQLite 无法注册自定义 FTS5 tokenizer → 双侧分词方案——
// ingest 时中文分词（ngram 自实现，bigram）空格连接写入 FTS 列；查询同分词再 MATCH）。
// jieba 类新依赖需报告主会话确认（用户边界④）→ 优先 ngram 自实现（无新依赖，brief 认可备选），记录实测。
// 严格 TDD：本文件先于实现编写并确认失败（功能缺失）。
// 覆盖：
//   ① tokenizeForFts 纯函数：CJK 串 → bigram 序列；单字 CJK → 单字；中英混合；英文单词原样
//   ② e2e：'记忆' 命中 '长期记忆系统'（中文子串命中——验收核心）；'记忆系统'/'长期' 亦命中
//   ③ 单字查询 '系'（bigram 索引限制，单字不单独入索引）→ 不命中（文档化限制）
//   ④ update 后 FTS 索引同步（新子串命中、旧子串失效）
//   ⑤ retrieve() e2e：lexical 通道中文子串命中
//   ⑥ 确定性：同输入两次 tokenize 相同
import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tokenizeForFts } from '../../memory/cjk-ngram.js';
import { RetrievalBackend } from '../../memory/backend-retrieval.js';
import { retrieve } from '../../memory/retrieve.js';
import type { Memory } from '../../kernel/schemas/m.js';

// ---- 测试工具 ----

/** 清理临时目录（Windows WAL 侧车文件在 close 后可能延迟解锁 → 有界重试） */
async function rmRetry(dir: string): Promise<void> {
  for (let i = 0; i < 20; i++) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EBUSY' && (err as NodeJS.ErrnoException).code !== 'EPERM') {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  await rm(dir, { recursive: true, force: true });
}

/** 最小 Memory 工厂（payload/event_id 覆盖；id 自动生成） */
let seq = 0;
function makeMemory(payload: string, over: Partial<Memory> = {}): Memory {
  seq++;
  const ts = '2026-08-21T00:00:00.000Z';
  const id = `mem:t816-${String(seq).padStart(4, '0')}`;
  return {
    ir_version: '2.0',
    id,
    schema: 'omb/M1',
    scope: 'Project',
    kind: 'Semantic',
    lifecycle: 'Active',
    prov_class: 'Observation',
    immutable: false,
    owner: 'kernel',
    created: ts,
    updated: ts,
    provenance: {
      source: 'test',
      event: `test/ingest-${seq}`,
      actor: 't8.16',
      environment: { os: 'win32', node: 'v24', dsh_version: '0.8.0', project: 'omb-v2' },
      runtime_snapshot: 'rs:test',
      timestamp: ts,
      transformation_chain: [],
      verification: 'test',
    },
    refs: [],
    payload,
    value_score: 0.5,
    utility_counts: {},
    ...over,
  };
}

async function openBackend(dir: string): Promise<RetrievalBackend> {
  return new RetrievalBackend(join(dir, 'memory.db'));
}

// ---- 主测试 ----

describe('① tokenizeForFts 纯函数（CJK → bigram；单字；混合；英文原样）', () => {
  it('纯中文串 → 滑动 bigram 空格连接', () => {
    expect(tokenizeForFts('长期记忆系统')).toBe('长期 期记 记忆 忆系 系统');
    expect(tokenizeForFts('记忆')).toBe('记忆');
    expect(tokenizeForFts('系统')).toBe('系统');
  });

  it('单字中文（长度 1 的 CJK 段）→ 单字 token', () => {
    expect(tokenizeForFts('系')).toBe('系');
    expect(tokenizeForFts('A系')).toBe('A 系');
  });

  it('中英混合 → CJK 段 bigram + 英文单词独立', () => {
    expect(tokenizeForFts('使用SQLite与FTS5')).toBe('使用 SQLite 与 FTS5');
    expect(tokenizeForFts('记忆后端采用SQLite进行存储')).toBe(
      '记忆 忆后 后端 端采 采用 SQLite 进行 行存 存储',
    );
  });

  it('英文/空格文本 → 单词原样（空格分隔）', () => {
    expect(tokenizeForFts('memory backend design')).toBe('memory backend design');
    expect(tokenizeForFts('SQLite FTS5 全文检索')).toBe('SQLite FTS5 全文 文检 检索');
  });

  it('空串/空白 → 空串', () => {
    expect(tokenizeForFts('')).toBe('');
    expect(tokenizeForFts('   ')).toBe('');
  });

  it('⑥ 确定性：同输入两次 → 相同输出', () => {
    expect(tokenizeForFts('长期记忆系统设计')).toBe(tokenizeForFts('长期记忆系统设计'));
  });
});

describe('② e2e：中文子串命中（验收核心："记忆"命中"长期记忆系统"）', () => {
  it('ingest 后按子串查询命中（bigram 双侧分词）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omb-cjk-e2e-'));
    try {
      const b = await openBackend(dir);
      await b.ingest(makeMemory('长期记忆系统'));
      for (const kw of ['记忆', '记忆系统', '长期', '系统', '期记']) {
        const page = await b.query({ scope: 'Project', text: kw, limit: 10, budget: 100 });
        expect(page.total, kw).toBe(1);
        expect(page.items[0]?.payload).toBe('长期记忆系统');
      }
      await b.close();
    } finally {
      await rmRetry(dir);
    }
  });

  it('与英文混排内容：中文子串 + 内嵌英文都单独命中', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omb-cjk-mix-'));
    try {
      const b = await openBackend(dir);
      await b.ingest(makeMemory('记忆后端采用SQLite进行存储'));
      const zh = await b.query({ scope: 'Project', text: '存储', limit: 10, budget: 100 });
      expect(zh.total).toBe(1);
      const en = await b.query({ scope: 'Project', text: 'SQLite', limit: 10, budget: 100 });
      expect(en.total).toBe(1);
      await b.close();
    } finally {
      await rmRetry(dir);
    }
  });
});

describe('③ 单字查询（bigram 索引限制，文档化）', () => {
  it("'系' 不在 bigram 索引中（长度≥2 的 CJK 段只入 bigram）→ 不命中", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omb-cjk-single-'));
    try {
      const b = await openBackend(dir);
      await b.ingest(makeMemory('长期记忆系统'));
      const page = await b.query({ scope: 'Project', text: '系', limit: 10, budget: 100 });
      expect(page.total).toBe(0);
      await b.close();
    } finally {
      await rmRetry(dir);
    }
  });
});

describe('④ update 后 FTS 索引同步', () => {
  it('payload 更新 → 新子串命中、旧子串失效', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omb-cjk-upd-'));
    try {
      const b = await openBackend(dir);
      const m = makeMemory('旧内容甲');
      await b.ingest(m);
      const old = await b.query({ scope: 'Project', text: '内容', limit: 10, budget: 100 });
      expect(old.total).toBe(1);
      await b.update(m.id, { payload: '新内容乙' });
      const newHit = await b.query({ scope: 'Project', text: '内容', limit: 10, budget: 100 });
      expect(newHit.total).toBe(1);
      expect(newHit.items[0]?.payload).toBe('新内容乙');
      const oldMiss = await b.query({ scope: 'Project', text: '甲', limit: 10, budget: 100 });
      expect(oldMiss.total).toBe(0);
      await b.close();
    } finally {
      await rmRetry(dir);
    }
  });
});

describe('⑤ retrieve() e2e：lexical 通道中文子串命中', () => {
  it('retrieve(text=记忆) → 命中 payload=长期记忆系统（lexical）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omb-cjk-ret-'));
    try {
      const b = await openBackend(dir);
      await b.ingest(makeMemory('长期记忆系统'));
      const r = await retrieve(b, { scope: 'Project', text: '记忆', limit: 3, budget: 1000 });
      expect(r.channel_used).toBe('lexical');
      expect(r.items.length).toBe(1);
      expect(r.items[0]?.memory.payload).toBe('长期记忆系统');
      await b.close();
    } finally {
      await rmRetry(dir);
    }
  });
});
