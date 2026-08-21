// layer 3：首个机制组件——记忆检索组件（施工计划 T8.19；组件化闭环验证）。
//
// 选型（主会话 brief 建议 + 实现者按既有架构落实）：
// - 组件 = 遵循 T8.6 组件注册事务（manifest_id/disposer 注册集）的可挂载单元；
// - 首组件选高内聚低耦合机制模块：**记忆检索**——manifest 声明 inject=memory backend、
//   effect=检索能力（§7.3 六阶段分层路由，复用 memory/retrieve.ts）、disposer=关闭检索句柄；
// - 装配：components/registry.ts（register → activate → get）；注入的 backend 由装配者持有
//   （组件不持有 backend 所有权——disposer 只关闭组件自身句柄，不关闭注入依赖，避免双释）。
// layer 3（components/）：import 目标层 ≤ 3（memory(2)/kernel/schemas(2) 放行，CONVENTIONS §4）。
import type { RetrievalBackend } from '../memory/backend-retrieval.js';
import { retrieve, type RetrieveQuery, type RetrievalResult } from '../memory/retrieve.js';
import type { ComponentDefinition } from './registry.js';

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

/** 记忆检索组件（首个机制组件：manifest/inject/effect/disposer 闭环） */
export const memoryRetrievalComponent: ComponentDefinition<MemoryRetrievalDeps, MemoryRetrievalEffect> = {
  manifest: {
    manifest_id: 'component:memory-retrieval',
    name: 'memory-retrieval',
    version: '1.0.0',
    description:
      '记忆检索机制组件（架构 §7.3 六阶段读取 / §7.4 Memory Value）：注入 memory backend，激活后提供分层路由检索能力；disposer 关闭检索句柄（注入依赖所有权归装配者，不双释）',
    inject: ['memory'],
    provides: ['memory.retrieve'],
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
    };
  },
};
