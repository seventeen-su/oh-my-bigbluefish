// layer 3：组件注册表 ABI 出口（施工计划 T8.19 + P2）。
//
// ABI：manifest（声明）/ inject（注入依赖）/ effect（激活后能力）/ disposer（清理）/ health（健康检查）。
// 实现落位说明（P2 层 DAG 合规）：runtime 装配（层 2）持有组件注册表并注册组件，而层 DAG 禁
// runtime → components（tests/m0/dag-lint.test.ts 钉住：runtime(2) 内 import components(3) → 报错）→
// 注册表实现移入 supervisor/component-registry.ts（层 1，与 T8.6 ComponentRegistrationTransaction 同文件）；
// 本文件保留 ABI 类型出口——既有调用方（components/memory-retrieval.ts 与 tests/m8/component-*.test.ts）
// 的导入路径不变，语义全部复用（T8.6 事务：幂等键唯一、批量回滚、dispose 幂等、failed 态可重试 commit）。
// layer 3（components/）：import 目标层 ≤ 3（supervisor(1) 经 DAG 放行，CONVENTIONS §4）。
export {
  ComponentRegistry,
  type ComponentManifest,
  type ComponentDefinition,
  type ComponentHealthCheck,
  type ComponentHealthResult,
  type ComponentListEntry,
  type ComponentStatus,
} from '../supervisor/component-registry.js';
