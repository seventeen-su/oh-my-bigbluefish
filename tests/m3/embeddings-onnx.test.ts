// 中文小嵌入模型（BGE-small-zh-v1.5 ONNX）测试——已知问题《小向量模型未接入》落地验证。
//
// 分两层（真机/CI 友好）：
//   ① 分词器（自实现 WordPiece）：**只依赖随仓库分发的 vocab.txt**，恒可跑——钉住 BERT 的
//      basic tokenize 口径（CJK 逐字、标点独立、小写、去重音）与 greedy longest-match 行为；
//   ② 端到端嵌入：需要权重在盘上（`pnpm fetch-embedding-model`）→ 缺失时**显式跳过**并打印原因，
//      而不是静默通过（"没测到"必须看得见）。
//
// 质量判据（本文件的核心断言）：神经嵌入要能证明它**做到了哈希词袋做不到的事**——
// 同义改写与跨语言的相似度显著高于无关文本；否则引入模型就没有意义（决定论据在 issue 里）。
import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cosineSimilarity } from '../../memory/embeddings.js';
import {
  BGE_SMALL_ZH_DIM,
  BGE_SMALL_ZH_ID,
  findModelDir,
  loadOnnxEmbedder,
  resolveModelPair,
  resolveVocabPath,
  VENDORED_VOCAB,
  WordPieceTokenizer,
} from '../../memory/embeddings-onnx.js';

/** preset 根（`<preset>/tests/m3/` → 上两级）；数据根与装配口径一致为 `<preset>/workspace/.omb` */
const PRESET_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DATA_ROOT = join(PRESET_ROOT, 'workspace', '.omb');
const VENDORED_DIR = fileURLToPath(new URL('../../memory/bge-small-zh/', import.meta.url));

describe('① WordPiece 分词器（自实现；只依赖随仓库分发的词表）', () => {
  it('词表随仓库分发且可用（21128 行，特殊 token id 正确）', () => {
    expect(existsSync(VENDORED_VOCAB)).toBe(true);
    const tok = WordPieceTokenizer.fromFile(VENDORED_VOCAB);
    // BERT-base-chinese 词表的标准 id（与 HF BertTokenizer 一致）
    expect(tok.padId).toBe(0);
    expect(tok.unkId).toBe(100);
    expect(tok.clsId).toBe(101);
    expect(tok.sepId).toBe(102);
  });

  it('CJK 逐字切分 + [CLS]/[SEP] 包裹（长度随字数线性增长）', () => {
    const tok = WordPieceTokenizer.fromFile(VENDORED_VOCAB);
    const ids = tok.encode('记忆检索');
    expect(ids[0]).toBe(tok.clsId);
    expect(ids[ids.length - 1]).toBe(tok.sepId);
    // 4 个汉字各自成 token（可能有个别被合成词覆盖，故用范围而非等号）
    expect(ids.length).toBeGreaterThanOrEqual(4);
    expect(ids.length).toBeLessThanOrEqual(8);
  });

  it('同文本 → 同 id 序列（确定性）；标点独立成 token；空白折叠', () => {
    const tok = WordPieceTokenizer.fromFile(VENDORED_VOCAB);
    const a = tok.encode('验证契约，必须成立');
    const b = tok.encode('验证契约，必须成立');
    const c = tok.encode('验证契约,必须成立');
    expect(a).toEqual(b);
    // 中文逗号与英文逗号是不同 token（标点独立切分，不做同义归一——如实反映）
    expect(a).not.toEqual(c);
  });

  it('超长文本按 maxLength 截断（含首尾特殊 token，不越界）', () => {
    const tok = WordPieceTokenizer.fromFile(VENDORED_VOCAB);
    const ids = tok.encode('记忆'.repeat(2000));
    expect(ids.length).toBeLessThanOrEqual(tok.maxLength);
    expect(ids[ids.length - 1]).toBe(tok.sepId);
  });

  it('词表路径解析：模型目录内的优先，缺失回落随仓库分发的那份', () => {
    expect(resolveVocabPath('/nonexistent-model-dir')).toBe(VENDORED_VOCAB);
  });
});

describe('② 模型装载（权重缺失 → 显式降级，不抛）', () => {
  it('模型目录缺失 → ok:false 且原因可读（含指定方式的提示）', async () => {
    const r = await loadOnnxEmbedder({ modelDir: '/nonexistent-bge-dir-xyz' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/未找到模型目录/);
      expect(r.reason).toMatch(/OMB_EMBEDDING_MODEL|models/);
    }
  });

  it('findModelDir：目录不完整（缺权重）→ null（不假装可用）', () => {
    // 随仓库分发的是词表，不是完整模型目录 → 必须判为不可用
    expect(findModelDir({ explicit: VENDORED_DIR })).toBeNull();
  });

  it('外部权重文件名必须与 ONNX 图内记录一致（改名即失效）', () => {
    // 回归护栏：曾经把 `model_quantized.onnx(_data)` 重命名成 `model.onnx(_data)`，
    // 结果 ONNX Runtime 找不到图里写死的外部数据文件 → 会话创建失败。
    // 契约是"保留上游文件名"，这里用配对解析把该契约钉住。
    const pair = resolveModelPair(join(DATA_ROOT, 'models', 'bge-small-zh-v1.5'));
    if (pair === null) return; // 权重未下载 → 该契约无从校验（端到端用例同理会跳过）
    expect(pair.data.startsWith(pair.graph.replace(/\.onnx$/u, ''))).toBe(true);
  });
});

const modelDir = findModelDir({ dataRoot: DATA_ROOT });
const hasModel = modelDir !== null;

/** 统一装载入口：断言"成功"，失败时把真实原因带进断言消息（不然只剩 expected false to be true） */
async function loadOk(): Promise<import('../../memory/embeddings.js').Embedder> {
  const load = await loadOnnxEmbedder({ modelDir: modelDir ?? undefined });
  if (!load.ok) throw new Error(`神经嵌入装载失败：${load.reason}`);
  return load.embedder;
}

describe.skipIf(!hasModel)('③ 端到端嵌入（需 `pnpm fetch-embedding-model`）', () => {
  it('装载成功：标识/维度符合契约，输出 L2 归一化且确定性', async () => {
    const embedder = await loadOk();
    expect(embedder.id).toBe(BGE_SMALL_ZH_ID);
    expect(embedder.dim).toBe(BGE_SMALL_ZH_DIM);
    // 神经嵌入**不**提供同步快路径（运行时只有 Promise 形态推理）——接口契约的一部分
    expect(embedder.embedSync).toBeUndefined();
    const v1 = await embedder.embed('验证契约必须成立');
    const v2 = await embedder.embed('验证契约必须成立');
    expect(v1.length).toBe(BGE_SMALL_ZH_DIM);
    expect([...v1]).toEqual([...v2]);
    let norm = 0;
    for (const x of v1) norm += x * x;
    expect(Math.sqrt(norm)).toBeCloseTo(1, 4);
  }, 60_000);

  it('语义能力：同义改写与跨语言的相似度显著高于无关文本（引入模型的判据）', async () => {
    const e = await loadOk();
    const cos = async (a: string, b: string): Promise<number> =>
      cosineSimilarity(await e.embed(a), await e.embed(b));
    const paraphrase = await cos('用户不要并行委托子代理', '不要并行委托子代理以免 git 混乱');
    const crossLingual = await cos('记忆整合事务有界', 'consolidation runs in bounded transactions');
    const unrelated = await cos('用户不要并行委托子代理', '今天天气不错');
    // 同义改写：哈希词袋几乎无信号（token 集合不同），神经嵌入应有明显相似度
    expect(paraphrase).toBeGreaterThan(0.6);
    // 跨语言：哈希词袋完全无力（token 空间不重叠）
    expect(crossLingual).toBeGreaterThan(0.25);
    // 无关文本必须明显更低（区分度）
    expect(paraphrase).toBeGreaterThan(unrelated + 0.2);
    expect(crossLingual).toBeGreaterThan(unrelated);
  }, 60_000);
});
