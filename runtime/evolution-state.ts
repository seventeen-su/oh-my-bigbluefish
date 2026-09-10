// layer 2（runtime/）：自迭代状态落盘与读取（已知问题《需要"查看自迭代状态"的快速工具》的数据面）。
//
// 目的：回答「为什么没有演化」——最近一次演化判定的结论与原因、信号计数、债务快照与档位、
// 各道门禁是否拦下（债务硬限 / 日预算 / 无触发 / 后台模型调用许可 / 链路总开关 / 旧布局）。
// 设计边界：
//   - 纯数据面（JSON 单文件，原子写 tmp+rename），不参与判定逻辑——判定仍是 kernel/evolve-decision.ts
//     的纯函数；本文件只负责把「刚刚判了什么、为什么」留下来给状态面读；
//   - 尽力而为：读写失败降级（状态面标注缺失），绝不阻塞演化链路与请求路径；
//   - 单一事实源：调用方（runtime/assembly.ts performEvolutionDecision）在每次判定后写入一条。
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** 门禁判定结果（每一步「有没有被拦下、为什么」） */
export interface EvolutionGateView {
  /** 门禁名（链路总开关/触发门槛/债务硬限/日预算/后台模型调用许可/线布局…） */
  gate: string;
  /** 是否放行 */
  passed: boolean;
  /** 未放行的原因（passed=true → null） */
  reason: string | null;
}

/** 自迭代状态快照（每次演化判定后覆写；状态工具读取） */
export interface EvolutionStateRecord {
  /** 本次判定时间（epoch ms） */
  ts: number;
  /** 触发判定的来源（maintenance:evolution_decision | /evolve now） */
  trigger: string;
  /** 判定结论 */
  decision: {
    should_evolve: boolean;
    strength: number;
    object_layer: string;
    budget_estimate: number;
    triggers: string[];
    /** 判定原因（无触发 → 'no_trigger'；债务门禁 → 'debt_over_hard:x>=y'；预算 → 'daily_budget_exhausted'…） */
    reason: string;
  };
  /** 信号计数（按 kind；本快照写入时刻的窗口统计） */
  signals: Record<string, number>;
  /** 信号总数（窗口内） */
  signals_total: number;
  /** 债务快照：合计 + 档位 + 阈值 */
  debt: { total: number; band: string; soft: number; hard: number; critical: number };
  /** 门禁逐项结果（含被拒原因——回答「被哪道门禁拦下」） */
  gates: EvolutionGateView[];
  /** 当前生效版本线 */
  line: string;
}

/** 自迭代状态文件路径（<evolutionRoot>/evolve-state.json） */
export function evolutionStateFile(evolutionRoot: string): string {
  return join(evolutionRoot, 'evolve-state.json');
}

/** 原子写自迭代状态（tmp + rename）；失败 → 抛（调用方降级记录，不吞错） */
export async function writeEvolutionState(file: string, rec: EvolutionStateRecord): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify(rec, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
}

/** 读自迭代状态（不存在 → null；损坏 → null——状态面诚实呈现缺失，不抛穿请求路径） */
export async function readEvolutionState(file: string): Promise<EvolutionStateRecord | null> {
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(await readFile(file, 'utf8')) as EvolutionStateRecord;
    if (typeof raw?.ts !== 'number' || typeof raw?.decision?.reason !== 'string') return null;
    return raw;
  } catch {
    return null;
  }
}
