// layer 2（kernel/）：S2 可控性分类（用户裁决 2026-08-25 第二阶段 S2）。
// 语义（裁决 S2）：controllability 用**分类制**——controllable / partially_controllable / external /
//   unknown + cause 枚举（network / permission / captcha / tool / model / user / environment / unknown），
//   机械规则表（网络超时→external；权限拒绝→external；验证码→external；工具参数错误→controllable；
//   代码错误→controllable），不做伪精确概率。
// 零 I/O、零副作用、零随机：同输入 → 同输出（测试锚定）。
// 层 DAG：kernel 纯函数（layer 2）——零 import；消费方 = runtime/assembly.ts（writeShadowOutcome 接线）。

// ---- 枚举 ----

/** 可控性分类值（裁决 S2 分类制：不产伪精确概率，只产四档分类） */
export const CONTROLLABILITY_VALUES = ['controllable', 'partially_controllable', 'external', 'unknown'] as const;
export type Controllability = (typeof CONTROLLABILITY_VALUES)[number];

/** 原因枚举（external 的具体因：网络/权限/验证码/环境；controllable 的因：工具/模型；partial 的因：用户） */
export const CAUSE_VALUES = [
  'network',
  'permission',
  'captcha',
  'tool',
  'model',
  'user',
  'environment',
  'unknown',
] as const;
export type ControllabilityCause = (typeof CAUSE_VALUES)[number];

/** 分类结果（controllability 四档 + cause 八枚举——组合即裁决 S2 分类面） */
export interface ControllabilityClassification {
  controllability: Controllability;
  cause: ControllabilityCause;
}

// ---- 规则表（裁决 S2 机械规则表——网络/权限/验证码/环境 → external；工具/模型 → controllable；
//     用户 → partially_controllable；未知 → unknown） ----

/** cause → 分类 全映射（Record 穷举防枚举漂移；未穷举输入 → fail-safe unknown/unknown） */
const CAUSE_RULES: Record<ControllabilityCause, Controllability> = {
  network: 'external',
  permission: 'external',
  captcha: 'external',
  environment: 'external',
  tool: 'controllable',
  model: 'controllable',
  user: 'partially_controllable',
  unknown: 'unknown',
};

/**
 * cause → 分类（确定性纯函数；规则表全映射）：
 *   network/permission/captcha/environment → external（外部不可控——失败不污染能力评分，P3）；
 *   tool/model → controllable（工具参数错误/代码错误——内部可控面，可修复）；
 *   user → partially_controllable（用户输入相关——部分可控）；
 *   unknown（含未穷举输入）→ unknown（诚实缺省，不臆造）。
 */
export function classifyControllability(cause: ControllabilityCause): ControllabilityClassification {
  const controllability = CAUSE_RULES[cause];
  return {
    controllability: controllability === undefined ? 'unknown' : controllability,
    cause: controllability === undefined ? 'unknown' : cause,
  };
}

// ---- 机械关键词检测（裁决 S2 第 8 点：机械评分优先，LLM 只在无法机械化时） ----

/** 关键词 → cause 规则表（顺序即优先级——先命中先胜出；全部不区分大小写） */
const TEXT_RULES: Array<{ cause: ControllabilityCause; re: RegExp }> = [
  // 网络：超时/网络错误/连接重置（ETIMEDOUT/ECONN 为 Node 网络错误码）
  { cause: 'network', re: /超时|timeout|network|网络|ETIMEDOUT|ECONN/i },
  // 权限：权限拒绝（EACCES/EPERM 为文件/系统权限错误码）
  { cause: 'permission', re: /权限|denied|EACCES|EPERM|permission/i },
  // 验证码：人机验证（外部不可控典型）
  { cause: 'captcha', re: /验证码|captcha/i },
  // 模型：语法/代码错误（内部可控面——代码可修）
  { cause: 'model', re: /语法|syntax|代码错误|compile error/i },
  // 工具：参数/无效参数错误（内部可控面——参数可改）
  { cause: 'tool', re: /参数|argument|invalid/i },
];

/**
 * 文本 → 分类（机械关键词检测；正则表顺序优先——命中即映射，未命中 → unknown/unknown）。
 * 大小写不敏感（/i）；中文关键词与英文错误码并存（裁决 S2 第 8 点规则表）。
 * 确定性纯函数；空文本/无关键词 → unknown（诚实——不臆造可控性）。
 */
export function classifyFromText(text: string): ControllabilityClassification {
  const needle = text ?? '';
  for (const rule of TEXT_RULES) {
    if (rule.re.test(needle)) {
      return classifyControllability(rule.cause);
    }
  }
  return { controllability: 'unknown', cause: 'unknown' };
}
