// layer 2：首个机制组件——记忆检索组件（施工计划 T8.19 组件化闭环；P2 装配进认知运行时）。
//
// 选型（主会话 brief 建议 + 实现者按既有架构落实）：
// - 组件 = 遵循 T8.6 组件注册事务（manifest_id/disposer 注册集）的可挂载单元；
// - 首组件选高内聚低耦合机制模块：**记忆检索**——manifest 声明 inject=memory backend、
//   effect=检索能力（§7.3 六阶段分层路由，复用 memory/retrieve.ts）、disposer=关闭检索句柄、
//   health=依赖 backend 健康（§8.1 lifecycle.onHealthCheck——失败 → 注册表打 suspicious 降级不卸载）；
// - 装配：supervisor/component-registry.ts ComponentRegistry（register → activate → get）；注入的 backend
//   由装配者持有（组件不持有 backend 所有权——disposer 只关闭组件自身句柄，不关闭注入依赖，避免双释）。
// 层落位说明（P2）：runtime 装配（层 2）需 import 组件定义，而层 DAG 禁 runtime → components
// （tests/m0/dag-lint.test.ts 钉住）→ 组件定义落 memory/（层 2：记忆检索机制归属记忆层；注入/效果/
// 健康契约不变）；components/memory-retrieval.ts 保留 ABI 出口（既有调用方导入路径不变）。
// layer 2（memory/）：import 目标层 ≤ 2（memory(2)/supervisor(1) 放行，CONVENTIONS §4）。
import type { RetrievalBackend } from './backend-retrieval.js';
import { retrieve, type RetrieveQuery, type RetrievalResult } from './retrieve.js';
import type { ComponentDefinition } from '../supervisor/component-registry.js';

/** 注入依赖：memory backend（§4.3 A4 MemoryBackend / §7.5 SQLite+FTS5 实现） */
export interface MemoryRetrievalDeps {
  memory: RetrievalBackend;
}

/** 组件效果（激活后可调用）：分层路由检索 + 激活状态查询 */
export interface MemoryRetrievalEffect {
  /** §7.3 六阶段检索（Scope→Kind→Channel→Expansion→Rank）；未激活调用 → fail-loud */
  retrieve(query: RetrieveQuery, opts?: { episode?: boolean }): Promise<RetrievalResult>;
  /** 组件激活状态（dispose 后 false） */
  isActive(): boolean;
}

/** 记忆检索组件（首个机制组件：manifest/inject/effect/disposer/health 闭环） */
export const memoryRetrievalComponent: ComponentDefinition<MemoryRetrievalDeps, MemoryRetrievalEffect> = {
  manifest: {
    manifest_id: 'component:memory-retrieval',
    name: 'memory-retrieval',
    version: '1.0.0',
    description:
      '记忆检索机制组件（架构 §7.3 六阶段读取 / §7.4 Memory Value）：注入 memory backend，激活后提供分层路由检索能力；disposer 关闭检索句柄（注入依赖所有权归装配者，不双释）；health 依赖 backend 健康（失败 → 打 suspicious 降级不卸载）',
    inject: ['memory'],
    provides: ['memory.retrieve'],
    // §8.1 events 契约：组件无事件订阅/发布（检索经 effect 调用，事件面留空显式声明）
    events: { subscribe: [], publish: [] },
    // §8.1 capabilities：装配期登记进能力注册表（supervisor/capability.ts，authority_scope=kernel）
    capabilities: ['memory.retrieve'],
  },
  create(deps: MemoryRetrievalDeps) {
    let active = false;
    return {
      activate: () => {
        active = true;
      },
      effect: {
        retrieve: async (query, opts) => {
          if (!active) {
            throw new Error('memory-retrieval: 组件未激活（effect 仅在 activate 后可调用）');
          }
          return retrieve(deps.memory, query, opts);
        },
        isActive: () => active,
      },
      disposer: () => {
        active = false;
      },
      // §8.1 lifecycle.onHealthCheck：依赖 backend 健康（连接可读）；失败 → registry 打 suspicious（降级不卸载）
      health: async () => deps.memory.health(),
    };
  },
};
