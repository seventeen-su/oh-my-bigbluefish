/**
 * 投影模块的运行时公共面：组合根只从这里取 worker/read API 与看板名映射。
 *
 * 类型契约按职责放在各自的文件里，直接 import 更窄：
 * - `types.ts`：任务、水位、看板行/快照；
 * - `contracts.ts`：运行期观测与依赖注入形状（stats/logger/wake/tx）；
 * - `tasks.ts`：队列 + 水位存储端口；
 * - `read.ts`：看板读 API；
 * - `worker.ts`：投影 worker。
 *
 * 不收窄成一个「全部再导出」的 barrel：那会让每个调用方都依赖整个模块的宽度，
 * 新增内部类型也会意外变成公共契约。
 */
export { PROJECTION_NAMES, projectionOfBoard } from './types.js'
export { ProjectionReadApi } from './read.js'
export { ProjectionWorker } from './worker.js'
