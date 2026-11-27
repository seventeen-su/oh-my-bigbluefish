/**
 * 嵌入适配器的生产出口：组合根只需要 `OnnxEmbedder`。
 *
 * HashEmbedder/分词/池化/批处理是可替换的内部实现与单测替身，直接按文件引入
 * （`hash.ts`/`tokenizer.ts`/…），避免 barrel 把内部实现意外固化成公共契约。
 */
export { OnnxEmbedder } from './onnx.js'
