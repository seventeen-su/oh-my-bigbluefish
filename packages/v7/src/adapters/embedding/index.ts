/**
 * 嵌入适配器出口。生产装配用 `OnnxEmbedder`；单测/无模型环境用 `HashEmbedder`。
 * 两者都实现 `ports/embedding.ts` 的 `Embedder`，装配方只依赖端口。
 */
export { DEFAULT_MAX_BATCH, embedBatched } from './batch.js'
export { HashEmbedder, HASH_DIMS, HASH_MODEL, hashEmbed } from './hash.js'
export {
  BGE_DIMS,
  BGE_MODEL,
  BGE_MODEL_DIR,
  MODEL_DIR_ENV,
  MODEL_GRAPHS,
  OnnxEmbedder,
  resolveModelDir,
  VOCAB_FILE,
} from './onnx.js'
export type {
  ModelDirResolution,
  OnnxEmbedderOptions,
  OnnxModelDirOptions,
  OnnxRuntimeLike,
  OnnxRuntimeLoader,
  OnnxSessionLike,
  OnnxTensorLike,
} from './onnx.js'
export { l2Normalize, meanPoolNormalize } from './pooling.js'
export { BERT_MAX_LENGTH, vocabularyFromLines, WordPieceTokenizer } from './tokenizer.js'
export type { Vocabulary } from './tokenizer.js'
