// layer 3：首个机制组件——记忆检索组件 ABI 出口（施工计划 T8.19 + P2）。
//
// 实现落位说明（P2 层 DAG 合规）：runtime 装配（层 2）需 import 组件定义，而层 DAG 禁
// runtime → components（tests/m0/dag-lint.test.ts 钉住）→ 组件定义移入 memory/memory-retrieval.ts
// （层 2：记忆检索机制归属记忆层；manifest/inject/effect/disposer/health 契约不变）；
// 本文件保留 ABI 出口——既有调用方（tests/m8/component-first.test.ts）导入路径不变。
// layer 3（components/）：import 目标层 ≤ 3（memory(2) 经 DAG 放行，CONVENTIONS §4）。
export {
  memoryRetrievalComponent,
  type MemoryRetrievalDeps,
  type MemoryRetrievalEffect,
} from '../memory/memory-retrieval.js';
