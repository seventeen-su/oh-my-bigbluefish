// layer 2：OMB Runtime Contract（W5 三层结构）——第一层固定契约 + 第二层动态能力行 + 第三层
//（DSH 原生 skill 渐进层）路径纯函数。
// 宿主架构研究结论（W5 前置，直接使用）：DSH systemPrompt.context 支持多 section 注册（order 小者在前，
// 既有 'cognitive:projection' order 90 先例）；DSH skill 系统 = ctx.skills 注册表 + dsh-skill-filesystem
// provider（默认扫描 <dshHome>/skills 下 SKILL.md，frontmatter 含 name/description 进目录）+ dsh-tool-skill
// 消费者（模型面 skill 工具：目录可见、按需加载、零固定 token 成本）→ 第三层渐进专项指导用 DSH 原生 skill
// 承载（仓库内版本化 + 挂载时镜像到 <dshHome>/skills——比「全部塞进固定上下文」严格更优）。
// 本模块职责：
//   - OMB_RUNTIME_CONTRACT：第一层固定契约文本（静态常量、不随演化变；≤500 字符硬约束①——极小固定成本）；
//   - buildCapabilitiesLine：第二层动态能力行（纯函数——capabilities 名称 + 语义裁判可用性 + 候选验证通道）；
//   - OMB_SKILL_REL / skillSourcePath / skillMirrorPath：第三层技能路径纯函数（仓库内源 + 镜像目标）。
// 层 DAG 合规（CONVENTIONS §4）：runtime(2) 只依赖 node:path 与自身类型——零运行时状态、无副作用。
import { join } from 'node:path';

/**
 * 第一层固定契约文本（认知层使用方式——静态常量，不随演化变；每次请求注入的极小固定上下文）。
 * 硬约束①：总长 ≤ 500 字符（中文，约 ≤300 token）——tests/m9/runtime-contract.test.ts 钉住。
 * 措辞纪律：标题不强调版本、不用晦涩术语；每一条都必须是「模型据此能做出正确动作」的信息，
 * 否则删除（已知问题《每轮注入的构成与浪费点》：契约标题与措辞精简）。
 * 主动性（已知问题《"AI 从未尝试自迭代"与提示词主动性》）：补一条**按需许可**——涉及自迭代/版本线/
 * 验证/修复的任务可先看状态、条件满足再触发；同时保留「不主动加载内部机制、不无由触发改动」的边界。
 */
export const OMB_RUNTIME_CONTRACT =
  'OMB认知层使用方式：\n' +
  '可用面：命令 /mode（切版本线）、/bench（基准）、/evolve now|share|absorb；' +
  '工具 kern_status、kern_memory、kern_profile、kern_bench、kern_evolve、kern_switch；' +
  '每轮注入的认知投影含工作状态/记忆候选/认知过程。\n' +
  '使用时机：需历史或画像 → kern_memory；登记偏好 → kern_profile；需验证 → /bench；' +
  '切版本线 → /mode；涉及自迭代、版本线、验证或修复的任务，可先 kern_status 看状态与被拦原因，' +
  '条件满足再 /evolve 或 kern_evolve 触发。\n' +
  '边界：正常任务优先直接完成，不主动加载内部机制、不无由触发改动；未验证候选不视为可信能力；' +
  '认知层仅观察与注入，不接管 Agent Loop。详细说明：技能 omb-runtime（按需加载）。';

/** 第二层动态能力行输入视图（plugin 装配面从认知运行时实例同步提取；全部字段可选——缺省 = 该维度未知） */
export interface CapabilitiesViewLike {
  /** 可用能力名（capabilities/components 名称，如 'memory.retrieve'；空/缺省 = 无能力可报） */
  capabilities?: string[];
  /** 语义裁判是否可用（缺省 = 未知，不报） */
  judgeAvailable?: boolean;
  /** 候选验证增强通道是否注入（缺省 = 未知，不报） */
  runnerAvailable?: boolean;
}

/**
 * 第二层动态能力行（纯函数、确定性）：capabilities 非空 → 报能力清单；judge/runner 布尔 → 报裁判/通道；
 * 全部未知 → 兜底「当前无额外能力面」。示例：
 * 「当前可用能力：memory-retrieval（记忆检索）；语义裁判：可用/不可用；候选验证通道：runner/受限子进程」
 */
export function buildCapabilitiesLine(runtimeView: CapabilitiesViewLike = {}): string {
  const caps = (runtimeView.capabilities ?? []).filter((c) => typeof c === 'string' && c.length > 0);
  const hasJudge = typeof runtimeView.judgeAvailable === 'boolean';
  const hasRunner = typeof runtimeView.runnerAvailable === 'boolean';
  if (caps.length === 0 && !hasJudge && !hasRunner) {
    return '当前无额外能力面';
  }
  const parts: string[] = [];
  if (caps.length > 0) {
    parts.push(`当前可用能力：${caps.join('、')}`);
  }
  if (hasJudge) {
    parts.push(`语义裁判：${runtimeView.judgeAvailable ? '可用' : '不可用'}`);
  }
  if (hasRunner) {
    parts.push(`候选验证通道：${runtimeView.runnerAvailable ? 'runner' : '受限子进程'}`);
  }
  return parts.join('；');
}

/** 第三层（DSH 原生 skill 渐进层）：仓库内技能相对路径（相对 preset 根；提交即版本化） */
export const OMB_SKILL_REL = join('skills', 'omb-runtime', 'SKILL.md');

/** 仓库内技能源文件绝对路径（presetRoot = 插件 preset 根——plugin.ts PLUGIN_ROOT） */
export function skillSourcePath(presetRoot: string): string {
  return join(presetRoot, OMB_SKILL_REL);
}

/** 镜像目标绝对路径（dshHome = $DSH_HOME 或 ~/.dsh；skill-filesystem 默认扫描 <dshHome>/skills） */
export function skillMirrorPath(dshHome: string): string {
  return join(dshHome, 'skills', 'omb-runtime', 'SKILL.md');
}
