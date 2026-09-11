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
import { describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
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
  vocabCandidates,
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

  it('词表候选覆盖两种布局（编译产物 lib/ 下也能定位到词表）', () => {
    // 真实事故回归：插件入口是 `lib/runtime/plugin.js`，而 tsc 不搬 .txt —— 只按
    // `new URL('./bge-small-zh/vocab.txt', import.meta.url)` 定位时，编译布局下的路径是
    // `<preset>/lib/memory/bge-small-zh/vocab.txt`（**不存在**）→ 神经嵌入在生产永久回落哈希词袋。
    // 候选表靠 `../../memory/...` 从 lib/ 退回 preset 根再进 memory，本用例钉住这条回退路径。
    const cands = vocabCandidates();
    expect(cands.length).toBeGreaterThanOrEqual(2);
    const presetMemoryDir = join(PRESET_ROOT, 'memory');
    expect(cands.some((p) => p.startsWith(presetMemoryDir))).toBe(true);
    // 回退候选指向的词表必须真实存在（这才是"编译布局可用"的实质）
    const fallback = cands.find((p) => p.startsWith(presetMemoryDir));
    expect(fallback !== undefined && existsSync(fallback)).toBe(true);
    // VENDORED_VOCAB 取第一个存在的候选（本机两种布局都在时取源码布局那份，内容同一份）
    expect(VENDORED_VOCAB).toBe(cands.find((p) => existsSync(p)));
  });

  it('超长 token 短路判 [UNK]（贪心匹配对长 token 是 O(n²)）', () => {
    // 实测缺陷：8KB 无空白文本单次 encode 阻塞事件循环 40 秒（`mergeMemories` 还在写事务内编码）。
    // 与 HF 的 max_input_chars_per_word=100 同口径 → 超限整词判 [UNK]。
    const tok = WordPieceTokenizer.fromFile(VENDORED_VOCAB);
    const long = 'a'.repeat(8000);
    const t0 = Date.now();
    const ids = tok.encode(long);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(1000); // 短路后是常数级；不短路则是几十秒
    // 整词不可分 → [UNK]（长度 = CLS + UNK + SEP）
    expect(ids).toEqual([tok.clsId, tok.unkId, tok.sepId]);
  });

  it('换行/制表符折叠为空格而不是被丢弃（避免跨行 token 粘连）', () => {
    // 实测缺陷：`\t \n \r` 曾被当控制符直接删除 → "a\nb" 变成单词 "ab"，与模型训练口径不一致。
    // 本仓记忆正文大量是多行文本，影响面广且不可观测。
    const tok = WordPieceTokenizer.fromFile(VENDORED_VOCAB);
    const joined = tok.encode('a\nb');
    expect(joined).not.toEqual(tok.encode('ab'));
    // 以空格分隔的两段各自成 token（若被丢弃则会粘成一个词）
    expect(joined.length).toBe(tok.encode('a b').length);
    expect(tok.encode('contract\r\nboundary')).toEqual(tok.encode('contract boundary'));
  });
});

describe('② 模型装载（权重缺失 → 显式降级，不抛）', () => {
  it('模型目录缺失 → ok:false 且原因可读（含指定方式的提示）', async () => {
    // 必须隔离环境变量：README 指导用户设 OMB_EMBEDDING_MODEL，若本机设了，
    // 显式传入的不存在目录会被 env 兜底悄悄"救活"→ 用例失去意义。
    vi.stubEnv('OMB_EMBEDDING_MODEL', '');
    try {
      const r = await loadOnnxEmbedder({ modelDir: '/nonexistent-bge-dir-xyz' });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toMatch(/未找到模型目录/);
        expect(r.reason).toMatch(/EMBEDDING_MODEL|models/);
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('findModelDir：目录不完整（缺权重）→ null（不假装可用）', () => {
    vi.stubEnv('OMB_EMBEDDING_MODEL', '');
    try {
      // 随仓库分发的是词表，不是完整模型目录 → 必须判为不可用
      expect(findModelDir({ explicit: VENDORED_DIR })).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('外部权重文件名必须与 ONNX 图内记录的一致（真判据：读图，不是读常量表）', () => {
    // 回归护栏：曾经把 `model_quantized.onnx(_data)` 重命名成 `model.onnx(_data)`，
    // ONNX Runtime 找不到图里写死的外部数据文件名 → 会话创建失败。
    //
    // **真判据**：外部数据文件名被记录在图的 initializer.external_data 里（protobuf），
    // 所以必须**从图里读出来**再与盘上文件比对。此前写的是
    // `pair.data.startsWith(pair.graph.replace(/\.onnx$/,''))`——两边都来自代码里的常量表，
    // 任何实现下恒真（把 data 名改成 weights.bin 也照样绿），且权重缺失时直接 return 静默通过。
    const dir = join(DATA_ROOT, 'models', 'bge-small-zh-v1.5');
    const pair = resolveModelPair(dir);
    if (pair === null) return; // 权重未下载 → 无从校验（端到端用例同理会跳过）

    const recorded = externalDataPathsIn(dir, pair.graph);
    expect(recorded.length).toBeGreaterThan(0); // 图确实用了外部权重（不是自带权重的单文件图）
    for (const rel of recorded) {
      // 图内记录的是**相对图文件的路径**；盘上必须存在同名文件
      expect(existsSync(join(dir, rel))).toBe(true);
      expect(rel).toBe(pair.data);
    }
  });
});

/**
 * 从 ONNX 图里读出 `initializer.external_data` 记录的 `location`（外部权重文件名）。
 *
 * 为什么要读 protobuf 而不是用常量表比：常量表比常量表恒真，测不出"盘上文件名与图内记录不一致"
 * 这个真实事故。图内的 ExternalDataEntry 是固定线格式：
 *   field 1 (key)   → tag 0x0a + len + "location"
 *   field 2 (value) → tag 0x12 + len + <文件名>
 * 故按字节扫这个三元组即可，无需引入 protobuf 依赖。
 */
function externalDataPathsIn(dir: string, graphFile: string): string[] {
  const buf = readFileSync(join(dir, graphFile));
  const out = new Set<string>();
  for (let i = 0; i + 2 < buf.length; i++) {
    if (buf[i] !== 0x0a) continue;
    const keyLen = buf[i + 1] ?? 0;
    if (keyLen !== 8) continue;
    if (buf.subarray(i + 2, i + 10).toString('latin1') !== 'location') continue;
    const tagIdx = i + 10;
    if (buf[tagIdx] !== 0x12) continue;
    const valLen = buf[tagIdx + 1] ?? 0;
    if (valLen === 0 || tagIdx + 2 + valLen > buf.length) continue;
    out.add(buf.subarray(tagIdx + 2, tagIdx + 2 + valLen).toString('utf8'));
  }
  return [...out];
}

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
